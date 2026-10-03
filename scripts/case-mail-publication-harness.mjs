import assert from "node:assert/strict";
import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { harness, clone, plain, companyId, Timestamp } from "./case-mail-test-harness.mjs";
const require=createRequire(import.meta.url),ts=require("typescript");
const importSource=fs.readFileSync(new URL("../functions/src/shift-import.ts",import.meta.url),"utf8");
const importCode=ts.transpileModule(importSource.slice(importSource.indexOf("async function writeJobsAndLocks("),importSource.indexOf("async function acquireSyncLock("))+"\nexports.write=writeJobsAndLocks;",{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const columns={workDate:"A",staffName:"B",temperature:"G",arrivalTime:"H",clientName:"J",storeName:"K",makerName:"L",menuName:"M",entryTime:"N",workTime:"O",caseId:"BC",cancelled:"C",cancellationReason:"D",basePayColumns:[]};
export async function setup(imported=true,beforeCreate=null){
  const h=harness(),receiptId=h.key("case-mail-receipt",companyId,"message-1");
  h.records.set("caseMailIntakeReceipts/"+receiptId,h.records.get(h.paths.receipt));h.records.delete(h.paths.receipt);h.paths.receipt="caseMailIntakeReceipts/"+receiptId;
  h.records.get(h.paths.candidate).receiptId=receiptId;h.command.mailIntake.receiptId=receiptId;
  h.records.get(h.paths.candidate).input.workDate="2099-10-10";
  if(beforeCreate)await beforeCreate(h);
  const created=await h.create(),jobId=created.jobIds[0],path="jobs/"+jobId;
  const state=h.load("./admin-edit-state-core"),exports={};
  runInNewContext(importCode,{exports,db:h.load("./firebase").db,HttpsError:h.load("firebase-functions/v2/https").HttpsError,
    Timestamp,FieldValue:h.load("firebase-admin/firestore").FieldValue,
    ...state,...h.load("./sheet-write-core"),...h.load("./cancellation-history-retention-core"),...h.load("./netprint-state-core"),...h.load("./assignment-preparation-core"),...h.load("./case-mail-publication-core"),
    normalizeName:value=>value.normalize("NFKC").replace(/[\s　]+/g,"").trim()});
  const leaseRef=h.load("./firebase").db.collection("syncLocks").doc("synthetic-lease");
  h.records.set(leaseRef.path,{companyId,token:"test-lease",leaseUntil:Timestamp.fromMillis(Date.now()+600000)});
  const row=Array(55).fill(""),job=h.records.get(path);
  row[0]=job.workDate;row[9]=job.clientName;row[10]=job.storeName;row[11]=job.makerName;row[12]=job.menuName;row[13]=job.entryTime;row[14]=job.workTime;row[54]=job.caseId;
  const importRows=async(rows,extraColumns={})=>{
    const currentColumns={...columns,...extraColumns};
    const parsed=h.load("./shift-parser").parseShiftSheet("synthetic-sheet","2099.10",[[],...rows],{companyId,headerRow:1,dataStartRow:2,columns:currentColumns});
    assert.equal(parsed.jobs.length,rows.length);if(rows.length===1&&rows[0]===row)assert.equal(parsed.jobs[0].jobId,jobId);
    for(const [index,current]of parsed.jobs.entries()){current.sheetRef.sheetId=1;current.editSourceSnapshot=state.captureEditSource(current,rows[index],currentColumns,"BC",Date.now());}
    return exports.write(parsed.jobs,new Map([["合成スタッフ","staff-1"]]),"synthetic-run",{ref:leaseRef,token:"test-lease"},Timestamp.now().toMillis());
  };
  const importRow=async(extraColumns={})=>importRows([row],extraColumns);
  Object.assign(h,{jobId,path,row,importRow,importRows,job:()=>h.records.get(path),source:()=>h.records.get("adminJobEditSources/"+jobId),
    publishNow:()=>h.publish({jobIds:[jobId],action:"publish",expectedRevisions:{[jobId]:h.job().revision}})});
  if(imported){Object.assign(job,{sourceReady:true,pendingSourceWrite:false});await importRow();}
  return h;
}
