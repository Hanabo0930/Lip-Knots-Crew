import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { google } from "googleapis";
import { db } from "./firebase";
import { columnToNumber, expectedMatches, validateMutation, valuesEquivalent, ExpectedValue } from "./sheet-write-core";
import { getProductionOperationalState } from "./system-safety";
import { incrementProductionMetrics } from "./production-metrics";

type Queue={companyId:string;jobId:string;operation:string;updates?:Record<string,unknown>;styles?:Record<string,{background?:string}>;expected?:Record<string,ExpectedValue>;idempotencyKey?:string;attempts?:number;status?:string;actorUid?:string;actorStaffId?:string};
type Mapping={enabled?:boolean;spreadsheetId:string;idColumn?:string;allowVerifiedFallbackRow?:boolean;columns:Record<string,string>;identityColumns?:{workDate:string;clientName:string;storeName:string;workTime:string};operations:Record<string,{values:string[];styles?:string[]}>;valueInputOption?:"RAW"|"USER_ENTERED";maxAttempts?:number};

export const processSafeSheetWrite = onDocumentWritten("sheetSyncQueue/{queueId}",async event=>{
  const after=event.data?.after; if(!after?.exists)return; const queue=after.data() as Queue; if(queue.status!=="pending")return;
  const state=await getProductionOperationalState(queue.companyId); if(!state.operational){await after.ref.set({status:"paused_global",pauseReason:state.reason,updatedAt:FieldValue.serverTimestamp()},{merge:true});return;}
  const claimed=await claim(after.ref); if(!claimed)return;
  await incrementProductionMetrics(queue.companyId,{sheetWriteAttempts:1},"safe_sheet_write");
  try{await execute(after.ref,queue);}catch(error){await incrementProductionMetrics(queue.companyId,{sheetWriteFailures:1,...(error instanceof ConflictError?{dataMismatchCount:1}:{})},"safe_sheet_write_failed");await fail(after.ref,queue,error);}
});

export const retrySafeSheetWrites = onSchedule({schedule:"every 5 minutes",timeZone:"Asia/Tokyo",timeoutSeconds:300},async()=>{
  const now=Timestamp.now(); const snap=await db.collection("sheetSyncQueue").where("status","==","retry_wait").where("retryAt","<=",now).limit(100).get();
  const batch=db.batch(); snap.docs.forEach(doc=>batch.set(doc.ref,{status:"pending",updatedAt:now},{merge:true})); if(!snap.empty)await batch.commit();
});

async function claim(ref:FirebaseFirestore.DocumentReference){return db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists||snap.data()?.status!=="pending")return false;tx.set(ref,{status:"processing",processingStartedAt:FieldValue.serverTimestamp(),attempts:FieldValue.increment(1)},{merge:true});return true;});}
async function execute(ref:FirebaseFirestore.DocumentReference,queue:Queue){
  if (queue.idempotencyKey) {
    const dedupeRef = db.collection("sheetWriteIdempotency").doc(hashKey(queue.companyId, queue.idempotencyKey));
    const dedupe = await dedupeRef.get();
    if (dedupe.exists && dedupe.data()?.status === "completed" && dedupe.data()?.queueId !== ref.id) {
      await ref.set({ status:"completed", duplicateOf:dedupe.data()?.queueId ?? null, completedAt:FieldValue.serverTimestamp() }, { merge:true });
      return;
    }
  }
  const [jobSnap,mapSnap]=await Promise.all([db.collection("jobs").doc(queue.jobId).get(),db.doc(`companies/${queue.companyId}/sheetMappings/shift`).get()]);
  if(!jobSnap.exists||!mapSnap.exists)throw new Error("案件または列マッピングが見つかりません。"); const job=jobSnap.data()!; const mapping=mapSnap.data() as Mapping;
  if(mapping.enabled!==true)throw new BlockedError("安全書込がまだ有効化されていません。"); if(job.companyId!==queue.companyId)throw new BlockedError("会社情報が一致しません。");
  const errors=validateMutation(mapping,queue.operation,queue.updates??{},queue.styles??{}); if(errors.length)throw new BlockedError(errors.join(" / "));
  const sheetName=String(job.sheetRef?.sheetName??"");if(!sheetName)throw new BlockedError("対象月タブが不明です。");
  const auth=new google.auth.GoogleAuth({scopes:["https://www.googleapis.com/auth/spreadsheets"]}); const sheets=google.sheets({version:"v4",auth});
  const row=await locateAndVerify(sheets,mapping,job,sheetName); const keys=[...new Set([...Object.keys(queue.updates??{}),...Object.keys(queue.styles??{})])];
  const ranges=keys.map(key=>`'${sheetName.replace(/'/g,"''")}'!${mapping.columns[key]}${row}`);
  const currentResp=await sheets.spreadsheets.values.batchGet({spreadsheetId:mapping.spreadsheetId,ranges,valueRenderOption:"FORMATTED_VALUE"});
  const before:Record<string,unknown>={}; keys.forEach((key,i)=>before[key]=currentResp.data.valueRanges?.[i]?.values?.[0]?.[0]??"");
  for(const [key,expected] of Object.entries(queue.expected??{})){if(!expectedMatches(before[key],expected))throw new ConflictError(`${key}はスプシ側で変更されています。現在値: ${String(before[key]??"")}`);}
  const allAlready=Object.entries(queue.updates??{}).every(([key,value])=>valuesEquivalent(before[key],value));
  if(!allAlready){const data=Object.entries(queue.updates??{}).map(([key,value])=>({range:`'${sheetName.replace(/'/g,"''")}'!${mapping.columns[key]}${row}`,values:[[value??""]]}));if(data.length)await sheets.spreadsheets.values.batchUpdate({spreadsheetId:mapping.spreadsheetId,requestBody:{valueInputOption:mapping.valueInputOption??"USER_ENTERED",data}});}
  const styleRequests=Object.entries(queue.styles??{}).map(([key,style])=>{const column=mapping.columns[key];if(!column)throw new BlockedError(`${key}の列マッピングがありません。`);return {repeatCell:{range:{sheetId:Number(job.sheetRef?.sheetId??0),startRowIndex:row-1,endRowIndex:row,startColumnIndex:columnToNumber(column)-1,endColumnIndex:columnToNumber(column)},cell:{userEnteredFormat:{backgroundColor:hexToRgb(style.background??"#ffffff")}},fields:"userEnteredFormat.backgroundColor"}};});
  if(styleRequests.length){if(!job.sheetRef?.sheetId)throw new BlockedError("書式変更にはsheetIdが必要です。");await sheets.spreadsheets.batchUpdate({spreadsheetId:mapping.spreadsheetId,requestBody:{requests:styleRequests}});}
  const verify=Object.keys(queue.updates??{}); const afterValues:Record<string,unknown>={}; if(verify.length){const r=await sheets.spreadsheets.values.batchGet({spreadsheetId:mapping.spreadsheetId,ranges:verify.map(key=>`'${sheetName.replace(/'/g,"''")}'!${mapping.columns[key]}${row}`),valueRenderOption:"FORMATTED_VALUE"});verify.forEach((key,i)=>afterValues[key]=r.data.valueRanges?.[i]?.values?.[0]?.[0]??"");for(const [key,value] of Object.entries(queue.updates??{}))if(!valuesEquivalent(afterValues[key],value))throw new Error(`${key}の書込後検証に失敗しました。`);}
  const now=Timestamp.now(); const batch=db.batch(); batch.set(ref,{status:"completed",resolvedRow:row,beforeValues:before,afterValues,completedAt:now,updatedAt:now},{merge:true}); batch.set(db.collection("auditLogs").doc(),{companyId:queue.companyId,jobId:queue.jobId,actorUid:queue.actorUid??null,actorStaffId:queue.actorStaffId??null,action:`sheet.${queue.operation}`,queueId:ref.id,before,after:queue.updates??{},styles:queue.styles??{},sheetName,row,createdAt:now}); if(queue.idempotencyKey)batch.set(db.collection("sheetWriteIdempotency").doc(hashKey(queue.companyId,queue.idempotencyKey)),{companyId:queue.companyId,queueId:ref.id,status:"completed",completedAt:now},{merge:true}); await batch.commit();
}
async function locateAndVerify(sheets:ReturnType<typeof google.sheets>,mapping:Mapping,job:FirebaseFirestore.DocumentData,sheetName:string){
  if(mapping.idColumn&&job.caseId){const r=await sheets.spreadsheets.values.get({spreadsheetId:mapping.spreadsheetId,range:`'${sheetName.replace(/'/g,"''")}'!${mapping.idColumn}:${mapping.idColumn}`});const idx=(r.data.values??[]).findIndex(row=>String(row[0]??"")===String(job.caseId));if(idx>=0)return idx+1;}
  const row=Number(job.sheetRef?.currentRow??0); if(!mapping.allowVerifiedFallbackRow||row<=0)throw new BlockedError("案件IDで行を特定できません。安全なフォールバックも無効です。");
  const identity=mapping.identityColumns;if(!identity)throw new BlockedError("行本人確認用の列設定がありません。"); const fields:[string,string][]=[[identity.workDate,String(job.workDate??job.dateKey??"")],[identity.clientName,String(job.clientName??"")],[identity.storeName,String(job.storeName??"")],[identity.workTime,String(job.workTime??"")]];
  const r=await sheets.spreadsheets.values.batchGet({spreadsheetId:mapping.spreadsheetId,ranges:fields.map(([col])=>`'${sheetName.replace(/'/g,"''")}'!${col}${row}`),valueRenderOption:"FORMATTED_VALUE"}); const mismatches=fields.filter(([,expected],i)=>!fuzzyIdentity(r.data.valueRanges?.[i]?.values?.[0]?.[0]??"",expected));if(mismatches.length)throw new ConflictError("行番号の内容が案件情報と一致しません。書込を停止しました。"); return row;
}
async function fail(ref:FirebaseFirestore.DocumentReference,queue:Queue,error:unknown){const attempts=Number((await ref.get()).data()?.attempts??1);const max=5;const blocked=error instanceof BlockedError||error instanceof ConflictError;const retryable=!blocked&&attempts<max;await ref.set({status:blocked?"blocked":retryable?"retry_wait":"dead_letter",errorType:error instanceof ConflictError?"conflict":error instanceof BlockedError?"blocked":"system",errorMessage:error instanceof Error?error.message:String(error),retryAt:retryable?Timestamp.fromMillis(Date.now()+Math.min(30,2**attempts)*60_000):null,failedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()},{merge:true});}
function fuzzyIdentity(a:unknown,b:unknown){const n=(v:unknown)=>String(v??"").normalize("NFKC").replace(/[\s　年月日/.-]+/g,"").replace(/^0+/g,"").toLowerCase();return n(a)===n(b)||n(a).includes(n(b))||n(b).includes(n(a));}
function hexToRgb(hex:string){const m=/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);return m?{red:parseInt(m[1]!,16)/255,green:parseInt(m[2]!,16)/255,blue:parseInt(m[3]!,16)/255}:{red:1,green:1,blue:1};}
function hashKey(companyId:string,key:string){return createHash("sha256").update(`${companyId}|${key}`,"utf8").digest("hex");}
class BlockedError extends Error{} class ConflictError extends Error{}
