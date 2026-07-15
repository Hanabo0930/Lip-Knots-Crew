import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { auditGasSources } from "./gas-audit-core";
import { evaluateFirstWriteGate } from "./first-write-gate-core";
import { companyFromClaims, requireAdmin, requestId } from "./utils";

export const runGasAudit=onCall({timeoutSeconds:300,memory:"1GiB"},async(request)=>{
 const session=requireAdmin(request); const companyId=companyFromClaims(session.token);
 const input=z.object({files:z.array(z.object({filename:z.string().min(1).max(200),source:z.string().min(1).max(2_000_000)})).min(1).max(100)}).parse(request.data??{});
 const report=auditGasSources(input.files); const ref=db.collection("gasAuditRuns").doc();
 await ref.set({companyId,actorUid:session.uid,report,filenames:input.files.map(f=>f.filename),createdAt:FieldValue.serverTimestamp()});
 await db.collection("auditLogs").add({companyId,actorUid:session.uid,action:"gas.audit.run",gasAuditId:ref.id,grade:report.grade,blockers:report.blockers,requestId:requestId("audit"),createdAt:FieldValue.serverTimestamp()});
 return{gasAuditId:ref.id,report};
});

export const evaluateFirstWriteSafetyGate=onCall(async(request)=>{
 const session=requireAdmin(request); const companyId=companyFromClaims(session.token);
 const input=z.object({
  targetSpreadsheetId:z.string().min(20),gasAuditId:z.string().min(10),
  formulaDifferenceCount:z.number().int().min(0),validationDifferenceCount:z.number().int().min(0),
  conditionalFormatDifferenceCount:z.number().int().min(0),protectedRangeDifferenceCount:z.number().int().min(0),
  billingDifferenceYen:z.number().int(),payrollDifferenceYen:z.number().int(),
  pdfDifferenceCount:z.number().int().min(0),mailRecipientDifferenceCount:z.number().int().min(0),
  explicitConfirmation:z.string()
 }).parse(request.data??{});
 const [audit,mapping,feature,rowManual,monthManual]=await Promise.all([
  db.collection("gasAuditRuns").doc(input.gasAuditId).get(),
  db.doc(`companies/${companyId}/sheetMappings/shift`).get(),
  db.collection("companyFeatureSettings").doc(companyId).get(),
  db.collection("sheetRowManualInterventions").where("companyId","==",companyId).where("status","==","open").limit(100).get(),
  db.collection("monthSheetManualInterventions").where("companyId","==",companyId).where("status","==","open").limit(100).get()
 ]);
 if(!audit.exists||audit.data()?.companyId!==companyId)throw new HttpsError("not-found","GAS監査結果がありません。");
 if(!mapping.exists)throw new HttpsError("failed-precondition","安全書込設定がありません。");
 const m=mapping.data()??{},f=feature.data()??{},r=audit.data()?.report??{};
 const result=evaluateFirstWriteGate({
  targetSpreadsheetId:input.targetSpreadsheetId,
  verifiedSpreadsheetId:String(m.monthCreation?.verifiedSpreadsheetId??""),
  productionSpreadsheetId:f.productionSpreadsheetId?String(f.productionSpreadsheetId):null,
  gasAuditGrade:String(r.grade??"E"),gasBlockers:Number(r.blockers??999),
  formulaDifferenceCount:input.formulaDifferenceCount,validationDifferenceCount:input.validationDifferenceCount,
  conditionalFormatDifferenceCount:input.conditionalFormatDifferenceCount,
  protectedRangeDifferenceCount:input.protectedRangeDifferenceCount,
  billingDifferenceYen:input.billingDifferenceYen,payrollDifferenceYen:input.payrollDifferenceYen,
  pdfDifferenceCount:input.pdfDifferenceCount,mailRecipientDifferenceCount:input.mailRecipientDifferenceCount,
  unresolvedManualInterventions:rowManual.size+monthManual.size,
  writeMappingEnabled:m.enabled===true,rowCreationEnabled:m.rowCreation?.enabled===true,
  monthCreationEnabled:m.monthCreation?.enabled===true&&f.monthSheetCreationReady===true,
  explicitConfirmation:input.explicitConfirmation
 });
 const gate=db.collection("firstWriteGateRuns").doc();
 await gate.set({companyId,actorUid:session.uid,gasAuditId:input.gasAuditId,targetSpreadsheetId:input.targetSpreadsheetId,result,status:result.allowed?"passed":"blocked",createdAt:FieldValue.serverTimestamp()});
 if(!result.allowed)return{...result,gateRunId:gate.id,authorizationId:null};
 const auth=db.collection("firstWriteAuthorizations").doc(),expiresAt=Timestamp.fromMillis(Date.now()+30*60*1000);
 await auth.set({companyId,actorUid:session.uid,targetSpreadsheetId:input.targetSpreadsheetId,gasAuditId:input.gasAuditId,gateRunId:gate.id,active:true,expiresAt,usedAt:null,createdAt:FieldValue.serverTimestamp()});
 return{...result,gateRunId:gate.id,authorizationId:auth.id,expiresAt:expiresAt.toDate().toISOString()};
});
