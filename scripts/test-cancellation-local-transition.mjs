// Full existing C modules, synthetic DB/Sheets boundaries, and a hash-pinned local integration patch.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import net from "node:net";
import crypto from "node:crypto";
import {createRequire} from "node:module";
import {fileURLToPath,pathToFileURL} from "node:url";
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),evidence=path.dirname(repo);
const integrated=process.argv.includes("--integrated");
const sourceRoot=process.env.LKC_CANCELLATION_SCHEMA_ROOT||(integrated?repo:undefined);
assert.ok(sourceRoot,"Existing local C source path required");
if(integrated)assert.equal(path.resolve(sourceRoot),repo,"Integrated mode must use this dedicated candidate");
const dependencyRoot=process.env.LKC_TEST_DEPENDENCY_ROOT||sourceRoot;
const require=createRequire(path.join(dependencyRoot,"package.json")),ts=require("typescript");
const overlayFile=path.join(evidence,"source-ack-history-integration-overlay.json");
const edits=integrated?{}:JSON.parse(fs.readFileSync(overlayFile,"utf8"));
const overlay=new Map();
for(const [rel,entry]of Object.entries(edits)){
  assert.ok(["functions/src/shift-import.ts","functions/src/analytics.ts","functions/src/jobs.ts"].includes(rel));
  const file=path.resolve(sourceRoot,rel),raw=fs.readFileSync(file);
  assert.equal(crypto.createHash("sha256").update(raw).digest("hex"),entry.baselineSha256,"Existing C source changed; stop");
  let text=raw.toString("utf8").replace(/\r\n/g,"\n");
  for(const change of entry.replacements){
    assert.equal(text.split(change.old).length-1,change.count,"Exact old context required");
    text=text.split(change.old).join(change.new);
  }
  overlay.set(file,text);
}
let networkAttempts=0;
const originalConnect=net.Socket.prototype.connect,originalFetch=globalThis.fetch;
net.Socket.prototype.connect=function(){networkAttempts++;throw Error("External/localhost network prohibited by memory acceptance");};
globalThis.fetch=async()=>{networkAttempts++;throw Error("External fetch prohibited");};
const cases=[],baselineFindings=[];
const matchArg=process.argv.find(v=>v.startsWith("--match="));const selected=matchArg?new RegExp(matchArg.slice(8)):null;
const {shiftFixture,row,clone,companyId,staffId,sheetId,dateKey,lockPath}=await import(pathToFileURL(path.join(sourceRoot,"scripts/test-shift-lifecycle.mjs")));
const pureCache=new Map();
function loadCandidate(name){
  if(pureCache.has(name))return pureCache.get(name);
  const file=path.join(repo,"functions/src",name.slice(2)+".ts"),exports={};
  pureCache.set(name,exports);
  const code=ts.transpileModule(fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInThisContext("(function(exports,require){"+code+"\n})",{filename:file})(exports,dep=>{
    if(dep==="node:crypto")return crypto;
    assert.ok(["./sheet-write-core","./analytics-core"].includes(dep));return loadCandidate(dep);
  });
  return exports;
}
const {SyntheticCancellationWriter}=loadCandidate("./cancellation-test-row-writer");
const pause=()=>new Promise(r=>setTimeout(r,4));
const get=(h,id)=>h.records.get("jobs/"+id);
const auth={uid:"synthetic-admin",token:{companyId,role:"admin"}};
function fixture(fixed=true,{initiallyAssigned=true}={}){
  const originalRead=fs.readFileSync;
  // Only these fixed source texts and this one new pure helper are substituted, in memory.
  if(fixed&&!integrated)fs.readFileSync=function(file,...rest){
    const full=path.resolve(file instanceof URL?fileURLToPath(file):String(file));
    if(overlay.has(full))return rest[0]==="utf8"||rest[0]?.encoding==="utf8"?overlay.get(full):Buffer.from(overlay.get(full));
    if(full===path.resolve(sourceRoot,"functions/src/cancellation-history-retention-core.ts")){
      return originalRead.call(this,path.join(repo,"functions/src/cancellation-history-retention-core.ts"),...rest);
    }
    return originalRead.call(this,file,...rest);
  };
  let h;
  try{
    h=shiftFixture([row("合成取消案件",initiallyAssigned?"合成スタッフA":""),row("合成別案件A"),row("合成別案件B")]);
    h.load("./analytics"); // Load while the tightly scoped source overlay is active.
  }finally{fs.readFileSync=originalRead;}
  h.optimistic=true;
  h.records.get("staffProfiles/"+staffId).displayName="合成スタッフA";
  const config=h.records.get("sheetImportConfigs/"+companyId);
  Object.assign(config.columns,{caseId:"BD",cancellationReason:"BE",basePayColumns:["Q"],staffPaymentTotal:"R",
    clientChargeTotal:"S",transportation:"AK",purchase8:"AL",netPrintCost:"AO"});
  config.readRangeEndColumn="BG";config.caseIdColumnsBySheet={"2099.9":"BD"};
  for(const [i,r]of h.rows.entries()){
    r[55]="synthetic-case-"+i;r[56]="";r[57]="";r[58]="";r[16]=10000;r[17]=10000;r[18]=0;
    r[36]="";r[37]=1200;r[40]="";r[19]=11200;
  }
  // Extend the existing mock's query operators only; run the actual getStaffPerformance callable.
  const db=h.load("./firebase").db,originalCollection=db.collection;
  function query(name,filters=[],limit=Infinity){
    return {...originalCollection(name),where:(field,op,value)=>{assert.ok(["==",">=", "<="].includes(op));return query(name,[...filters,[field,op,value]],limit);},
      limit:n=>query(name,filters,n),get:async()=>{
        const values=[...h.records].filter(([p,v])=>p.startsWith(name+"/")&&filters.every(([key,op,wanted])=>
          op==="=="?v[key]===wanted:op===">="?v[key]>=wanted:v[key]<=wanted)).slice(0,limit);
        return {size:values.length,docs:values.map(([p,v])=>({id:p.slice(name.length+1),data:()=>clone(v)}))};
      }};
  }
  db.collection=name=>name==="jobs"?query(name):originalCollection(name);
  h.performance=async()=>(await h.load("./analytics").getStaffPerformance({auth,data:{staffId,from:dateKey,through:dateKey}})).performance;
  h.cancelActual=id=>h.load("./analytics").adminSetJobCancellation({auth,data:{jobId:id,reasonCategory:"other",
    reasonNote:"合成依頼なし取消",financialTreatment:"pay_only",expectedRevision:get(h,id).revision}});
  h.restoreActual=id=>h.load("./analytics").adminRestoreCancelledJob({auth,data:{jobId:id,note:"合成復帰",expectedRevision:get(h,id).revision}});
  h.trace=[];
  return h;
}
function state(h,id,label){
  const job=get(h,id),lock=h.records.get(lockPath);
  h.trace.push({label,status:job.status,rawName:job.rawStaffName,logicalStaffId:job.assignedStaffId??null,
    pending:job.cancellationSheetWrite?.sourceAckPending??null,lockActive:lock?.active??null,lockJobId:lock?.jobId??null,
    storedPay:job.financials.staffPaymentTotal,basePay:job.basePay,expense:job.expenses.purchase8});
}
async function seed(h){
  await h.sync();const jobs=h.list("jobs");return {source:jobs.find(j=>j.storeName==="合成取消案件"),other:jobs.filter(j=>j.storeName!=="合成取消案件")};
}
function writerFor(h,id){
  const job={...get(h,id),id},q=h.list("sheetSyncQueue").find(q=>q.operation==="job.cancel.v2"&&q.jobId===id);
  assert.ok(q);
  const sheet=job.sheetRef;
  const cells=Object.fromEntries(h.rows[0].map((value,index)=>[columnName(index+1),{value,background:"#ffffff"}]));
  cells.T.formula="=R2+AL2";
  const sourceRow={spreadsheetId:sheetId,sheetId:sheet.sheetId,sheetName:sheet.sheetName,rowNumber:sheet.currentRow,revision:1,cells};
  const input={scope:{kind:"synthetic_only",fixtureId:"synthetic-transition-one",companyId,spreadsheetId:sheetId},
    actor:{uid:auth.uid,companyId,role:"admin"},job,queue:q,
    mapping:{spreadsheetId:sheetId,idColumn:"BD",caseIdColumnsBySheet:{"2099.9":"BD"},
      columns:{workDate:"A",staffName:"B",clientName:"J",storeName:"K",workTime:"O",cancelled:"BC",cancellationReason:"BE",
        staffBasePay:"Q",staffPayment:"R",clientCharge:"S",transportation:"AK",purchase8:"AL",netPrintCost:"AO",
        cancellationReasonCategory:"BF",cancellationFinancialTreatment:"BG",caseId:"BD"},
      operations:{"test.cancel.staff_display":{values:["staffName","cancelled","cancellationReason","cancellationReasonCategory","cancellationFinancialTreatment"]}}},
    policy:{treatment:"pay_only",expensePayer:"company",expenseReconciliation:"pending",grayStartColumn:"A",grayEndColumn:"BG"}};
  return new SyntheticCancellationWriter(input,[sourceRow]);
}
function columnName(n){let s="";while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;}
function reflect(h,writer){
  for(const [col,cell]of Object.entries(writer.rows[0].cells)){
    const index=[...col].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;h.rows[0][index]=cell.value;
  }
  assert.equal(writer.rows[0].cells.B.value,"");assert.equal(writer.rows[0].cells.B.background,"#d9d9d9");
  assert.equal(writer.rows[0].cells.R.value,10000);assert.equal(writer.rows[0].cells.T.formula,"=R2+AL2");
}
async function write(h,writer,extra={}){
  const atMs=writer.input.job.cancellationSheetWrite.sourceAckRequestedAtMs+10;
  const result=await writer.execute({dryRun:false,atMs,...extra});reflect(h,writer);return result;
}
const history=writer=>[...writer.receipts.values()][0];
async function test(name,body){if(selected&&!selected.test(name))return;const trace=await body();cases.push({name,passed:true,...(trace?{trace}:{})});}
try{
  if(!integrated)await test("unpatched full C path reproduces P1: source acknowledgment removes salary/history from staff query",async()=>{
    const h=fixture(false),{source}=await seed(h);await h.cancelActual(source.id);
    assert.equal((await h.performance()).totals.payment,10000);
    const writer=writerFor(h,source.id);await write(h,writer);await pause();await h.sync();
    assert.equal(get(h,source.id).financials.staffPaymentTotal,10000);
    assert.equal((await h.performance()).totals.payment,0);
    baselineFindings.push({severity:"P1",beforeStaffPayment:10000,afterStaffPayment:0,storedStaffPayment:10000,patched:false});
  });
  await test("cancel -> old-contact history -> blank/gray -> fresh ack -> release -> other application; pay/history survive repeat import",async()=>{
    const h=fixture(),{source,other}=await seed(h);state(h,source.id,"assigned");
    await h.cancelActual(source.id);state(h,source.id,"cancel_pending_ack");
    await assert.rejects(h.apply(other[0].id,"before-ack"),{code:"failed-precondition"});
    assert.equal(h.records.get(lockPath).active,true);
    const writer=writerFor(h,source.id);
    await write(h,writer,{beforeBatch:async()=>{
      assert.equal(history(writer).plan.contact.staffId,staffId);assert.equal(h.rows[0][1],"合成スタッフA");
    }});
    state(h,source.id,"history_then_blank_gray_lock_held");
    const beforeHistory=JSON.stringify(history(writer).plan);
    await pause();await h.sync();state(h,source.id,"fresh_ack_releases_lock");
    const job=get(h,source.id),proof=clone(job.cancellationSheetWrite.sourceAckProof),revision=job.revision;
    assert.equal(job.assignedStaffId,staffId);assert.equal(job.assignedStaffName,"合成スタッフA");assert.equal(job.rawStaffName,"");
    assert.equal(job.status,"cancelled");assert.equal(job.publishable,false);assert.equal(job.cancellationSheetWrite.sourceAckPending,false);
    assert.equal(h.records.get(lockPath).active,false);
    const performance=await h.performance();assert.equal(performance.totals.payment,10000);assert.equal(performance.totals.cancelledJobs,1);
    assert.equal(job.basePay,10000);assert.equal(job.expenses.purchase8,1200);assert.equal(job.expenses.transportation,null);
    await h.sync();assert.equal(get(h,source.id).revision,revision);
    assert.deepEqual(get(h,source.id).cancellationSheetWrite.sourceAckProof,proof);
    await assert.rejects(h.restoreActual(source.id),{code:"failed-precondition"});
    assert.equal(h.records.get(lockPath).active,false);
    await h.apply(other[0].id,"after-ack");state(h,source.id,"other_job_owns_same_day");
    const owner=clone(h.records.get(lockPath));assert.equal(owner.jobId,other[0].id);assert.equal(owner.active,true);
    await h.cancelActual(source.id);await writer.execute({dryRun:false,atMs:Date.now()+20});
    assert.equal(writer.batches,1);assert.deepEqual(h.records.get(lockPath),owner);
    h.rows[1][1]="合成スタッフA";await pause();await h.sync();
    assert.equal(h.records.get(lockPath).jobId,other[0].id);assert.equal(h.records.get(lockPath).active,true);
    assert.equal(get(h,source.id).assignedStaffId,staffId);
    assert.equal(get(h,source.id).financials.staffPaymentTotal,10000);
    assert.equal((await h.performance()).totals.cancelledJobs,1);
    assert.equal(JSON.stringify(history(writer).plan),beforeHistory);
    await assert.rejects(h.apply(source.id,"cancelled-original"),e=>["already-exists","failed-precondition"].includes(e.code));
    assert.equal(h.rows[0][1],"");assert.equal(h.rows[0][54],true);
    assert.equal(h.list("auditLogs").filter(a=>a.action==="job.cancel.source.confirm").length,1);
    return h.trace;
  });
  await test("memory transaction precommit abort: gray row may exist but job/proof/occupancy remain until retry",async()=>{
    const h=fixture(),{source}=await seed(h);await h.cancelActual(source.id);
    const writer=writerFor(h,source.id);await write(h,writer);await pause();
    const oldJob=JSON.stringify(get(h,source.id)),oldLock=JSON.stringify(h.records.get(lockPath));
    h.beforeCommit=pending=>{if(pending.some(p=>p.ref.path===lockPath&&p.data?.active===false))throw Error("synthetic_ack_abort");};
    await assert.rejects(h.sync(),/synthetic_ack_abort/);
    assert.equal(JSON.stringify(get(h,source.id)),oldJob);assert.equal(JSON.stringify(h.records.get(lockPath)),oldLock);
    assert.equal((await h.performance()).totals.payment,10000);assert.equal(h.rows[0][1],"");
    h.beforeCommit=null;await pause();await h.sync();
    assert.equal(h.records.get(lockPath).active,false);assert.equal(get(h,source.id).assignedStaffId,staffId);
  });
  await test("lost writer and ack responses recover; concurrent same-day alternatives have one winner",async()=>{
    const h=fixture(),{source,other}=await seed(h);await h.cancelActual(source.id);const writer=writerFor(h,source.id);
    await assert.rejects(write(h,writer,{failAt:"after_batch_response"}),/lost_response/);reflect(h,writer);
    assert.equal(h.records.get(lockPath).active,true);assert.equal(history(writer).stage,"unknown");
    const restored=SyntheticCancellationWriter.restore(writer.input,writer.exportCheckpoint());await write(h,restored);
    assert.equal(restored.batches,1);await pause();
    h.afterCommit=pending=>{if(pending.some(p=>p.ref.path===lockPath&&p.data?.active===false)){h.afterCommit=null;throw Error("synthetic_ack_response_lost");}};
    await assert.rejects(h.sync());assert.equal(h.records.get(lockPath).active,false);
    assert.equal(get(h,source.id).assignedStaffId,staffId);
    await h.sync();assert.equal(h.list("auditLogs").filter(a=>a.action==="job.cancel.source.confirm").length,1);
    const outcomes=await Promise.allSettled(other.map((j,i)=>h.apply(j.id,"parallel-transition-"+i)));
    assert.equal(outcomes.filter(r=>r.status==="fulfilled").length,1);
    const owner=clone(h.records.get(lockPath));await h.cancelActual(source.id);assert.deepEqual(h.records.get(lockPath),owner);
    assert.equal(get(h,source.id).financials.staffPaymentTotal,10000);assert.equal((await h.performance()).totals.cancelledJobs,1);
  });
  await test("concurrent lock replacement refuses ack and never releases different job owner",async()=>{
    const h=fixture(),{source}=await seed(h);await h.cancelActual(source.id);const writer=writerFor(h,source.id);await write(h,writer);await pause();
    const old=JSON.stringify(get(h,source.id));
    h.beforeCommit=pending=>{
      if(pending.some(p=>p.ref.path===lockPath&&p.data?.active===false)){
        h.beforeCommit=null;h.records.set(lockPath,{...h.records.get(lockPath),jobId:"synthetic-different-owner"});
      }
    };
    await assert.rejects(h.sync(),{code:"failed-precondition"});assert.ok(h.casRetries>=1);
    assert.equal(JSON.stringify(get(h,source.id)),old);assert.equal(h.records.get(lockPath).active,true);
    assert.equal(h.records.get(lockPath).jobId,"synthetic-different-owner");assert.equal(history(writer).plan.contact.staffId,staffId);
  });
  await test("v2 cancellation immediately after application explicitly closes publication",async()=>{
    const h=fixture(true,{initiallyAssigned:false}),{source}=await seed(h);await h.apply(source.id,"apply-then-cancel");
    assert.equal(get(h,source.id).publishable,true);
    await h.cancelActual(source.id);assert.equal(get(h,source.id).publishable,false);
    // Projection is already blank, so clearing a different source name is refused; day occupancy stays held.
    const writer=writerFor(h,source.id);await assert.rejects(write(h,writer),/does not match/);
    assert.equal(h.records.get(lockPath).active,true);assert.equal(get(h,source.id).financials.staffPaymentTotal,10000);
  });
  await test("corrupt saved proof refuses repeated source read without deleting staff or financial history",async()=>{
    const h=fixture(),{source}=await seed(h);await h.cancelActual(source.id);const writer=writerFor(h,source.id);await write(h,writer);await pause();await h.sync();
    get(h,source.id).cancellationSheetWrite.sourceAckProof.staffId="synthetic-other-staff";
    const before=JSON.stringify(get(h,source.id));await assert.rejects(h.sync(),{code:"failed-precondition"});
    assert.equal(JSON.stringify(get(h,source.id)),before);assert.equal(get(h,source.id).assignedStaffId,staffId);
    assert.equal((await h.performance()).totals.payment,10000);assert.equal(h.records.get(lockPath).active,false);
  });
  for(const route of ["v1","v2"])await test("changed recancel "+route+" refuses before destroying proof/history; exact replay stays idempotent",async()=>{
    const h=fixture(),{source}=await seed(h);await h.cancelActual(source.id);const writer=writerFor(h,source.id);
    await write(h,writer);await pause();await h.sync();
    const before=JSON.stringify(get(h,source.id)),queues=h.list("sheetSyncQueue").length,audits=h.list("auditLogs").length;
    const changed=route==="v1"
      ?()=>h.load("./jobs").adminCancelJob({auth,data:{jobId:source.id,reason:"合成理由変更"}})
      :()=>h.load("./analytics").adminSetJobCancellation({auth,data:{jobId:source.id,reasonCategory:"other",reasonNote:"合成理由変更",financialTreatment:"pay_only"}});
    await assert.rejects(changed(),{code:"failed-precondition"});
    assert.equal(JSON.stringify(get(h,source.id)),before);assert.equal(h.list("sheetSyncQueue").length,queues);
    assert.equal(h.list("auditLogs").length,audits);await h.cancelActual(source.id);assert.equal(JSON.stringify(get(h,source.id)),before);
    await assert.rejects(h.restoreActual(source.id),{code:"failed-precondition"});assert.equal(h.records.get(lockPath).active,false);
    await h.sync();assert.equal((await h.performance()).totals.payment,10000);assert.equal(get(h,source.id).assignedStaffId,staffId);
  });
  await test("restore guard cannot be bypassed by missing sourceAck metadata after physical name clear",async()=>{
    const h=fixture(),{source}=await seed(h);await h.cancelActual(source.id);const writer=writerFor(h,source.id);await write(h,writer);await pause();await h.sync();
    const saved=get(h,source.id).cancellationSheetWrite;
    get(h,source.id).cancellationSheetWrite={queueId:saved.queueId,operation:saved.operation,identity:saved.identity};
    const before=JSON.stringify(get(h,source.id));await assert.rejects(h.restoreActual(source.id),{code:"failed-precondition"});
    assert.equal(JSON.stringify(get(h,source.id)),before);assert.equal(h.records.get(lockPath).active,false);
    assert.equal((await h.performance()).totals.payment,10000);
  });
  await test("admin assignment editing cannot erase or reoccupy an acknowledged cancelled history",async()=>{
    const h=fixture(),{source}=await seed(h);await h.cancelActual(source.id);const writer=writerFor(h,source.id);
    await write(h,writer);await pause();await h.sync();
    const before=JSON.stringify(get(h,source.id)),lock=JSON.stringify(h.records.get(lockPath)),queues=h.list("sheetSyncQueue").length;
    for(const fields of [{assignedStaffId:null},{assignedStaffId:staffId},{assignedStaffId:"synthetic-other-staff"}]){
      await assert.rejects(h.edit(source.id,fields,get(h,source.id).revision),{code:"failed-precondition"});
      assert.equal(JSON.stringify(get(h,source.id)),before);assert.equal(JSON.stringify(h.records.get(lockPath)),lock);
      assert.equal(h.list("sheetSyncQueue").length,queues);assert.equal(h.rows[0][1],"");
      assert.equal((await h.performance()).totals.payment,10000);
    }
  });
  for(const route of ["v1","v2"])await test("reason provenance "+route+" preserves blank source and refuses conflicting fresh/saved source",async()=>{
    const h=fixture(),{source,other}=await seed(h);
    if(route==="v1")await h.cancel(source.id);else await h.cancelActual(source.id);
    const reason=get(h,source.id).cancellationReason;
    h.rows[0][1]="";h.rows[0][54]=true;h.rows[0][56]="合成の別理由";await pause();
    const pending=JSON.stringify(get(h,source.id)),oldLock=JSON.stringify(h.records.get(lockPath));
    await assert.rejects(h.sync(),{code:"failed-precondition"});
    assert.equal(JSON.stringify(get(h,source.id)),pending);assert.equal(JSON.stringify(h.records.get(lockPath)),oldLock);
    h.rows[0][56]="";await h.sync();
    assert.equal(get(h,source.id).cancellationReason,reason);assert.equal(get(h,source.id).cancellationSheetWrite.sourceAckPending,false);
    await h.apply(other[0].id,"reason-provenance-"+route);
    const acknowledged=JSON.stringify(get(h,source.id)),newLock=JSON.stringify(h.records.get(lockPath)),queues=h.list("sheetSyncQueue").length;
    if(route==="v1")await h.cancel(source.id);else await h.cancelActual(source.id);
    assert.equal(JSON.stringify(get(h,source.id)),acknowledged);assert.equal(JSON.stringify(h.records.get(lockPath)),newLock);
    assert.equal(h.list("sheetSyncQueue").length,queues);
    h.rows[0][56]="合成の別理由";await assert.rejects(h.sync(),{code:"failed-precondition"});
    assert.equal(JSON.stringify(get(h,source.id)),acknowledged);assert.equal(JSON.stringify(h.records.get(lockPath)),newLock);
    // The alternative application must also be reflected in this synthetic source before its import can confirm.
    const proof=clone(get(h,source.id).cancellationSheetWrite.sourceAckProof);
    h.rows[1][1]="合成スタッフA";h.rows[0][56]=" "+reason+" ";await pause();await h.sync();
    assert.equal(get(h,source.id).cancellationReason,reason);assert.deepEqual(get(h,source.id).cancellationSheetWrite.sourceAckProof,proof);
    assert.equal(h.records.get(lockPath).jobId,other[0].id);assert.equal(h.records.get(lockPath).active,true);
    assert.equal(get(h,source.id).assignedStaffId,staffId);assert.equal(get(h,source.id).financials.staffPaymentTotal,10000);
    assert.equal((await h.performance()).totals.cancelledJobs,1);
  });
  // Typecheck the actual integrated or overlaid C modules without emitting build artifacts.
  const configFile=path.join(sourceRoot,"functions/tsconfig.json"),config=ts.readConfigFile(configFile,ts.sys.readFile);
  assert.equal(config.error,undefined);
  const parsed=ts.parseJsonConfigFileContent({...config.config,include:[],files:[]},ts.sys,path.dirname(configFile));
  const helperTarget=path.resolve(sourceRoot,"functions/src/cancellation-history-retention-core.ts");
  const roots=integrated?["sheet-write-core","jobs","analytics","shift-import","job-management","cancellation-history-retention-core","cancellation-test-row-writer"].map(name=>path.join(repo,"functions/src",name+".ts"))
    :[...overlay.keys(),helperTarget,path.join(repo,"functions/src/cancellation-test-row-writer.ts")];
  const options={...parsed.options,noEmit:true,rootDir:undefined,types:["node"],typeRoots:[path.join(dependencyRoot,"node_modules/@types")]};
  const host=ts.createCompilerHost(options),read=host.readFile,exists=host.fileExists;
  host.readFile=file=>overlay.get(path.resolve(file))??(path.resolve(file)===helperTarget?fs.readFileSync(path.join(repo,"functions/src/cancellation-history-retention-core.ts"),"utf8"):read(file));
  host.fileExists=file=>path.resolve(file)===helperTarget||exists(file);
  const program=ts.createProgram(roots,options,host),diagnostics=ts.getPreEmitDiagnostics(program);
  if(diagnostics.length)throw Error(ts.formatDiagnostics(diagnostics,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>sourceRoot,getNewLine:()=>"\n"}));
  assert.equal(networkAttempts,0);
  assert.ok(cases.length>0,"No requested scenarios ran");
  const result={scope:integrated?"integrated_c_source_transition_memory_acceptance":"source_ack_transition_memory_acceptance",integrationMode:integrated?"actual_sources_no_overlay":"overlay",selection:matchArg??"all",passed:cases.length,cases,baselineFindings,noEmit:"PASS",sourceOverlayAppliedToRoot:false,integratedPatchAppliedToCandidate:integrated,
    stateTransitions:"actual C callable/parser/importer/analytics modules with synthetic Sheets and optimistic in-memory DB",
    firestoreSdkTransactions:false,realSheets:false,messagesSent:0,networkAttempts,existingResourcesChanged:false,
    overlaySources:Object.entries(edits).map(([file,v])=>({file,baselineSha256:v.baselineSha256})),
    sourceFileSha256:integrated?Object.fromEntries(roots.map(file=>[path.relative(repo,file).replaceAll(path.sep,"/"),crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")])):undefined,
    caveat:"Memory CAS and response-loss injection prove application state flow, not real SDK, multi-process or cross-system atomicity."};
  fs.writeFileSync(path.join(evidence,integrated?(selected?.source==="admin assignment"?"integrated-c-admin-edit-delta-results.json":selected?.source==="reason provenance"?"integrated-c-reason-delta-results.json":"integrated-c-transition-results.json"):selected?(selected.source.includes("changed recancel")?"cancellation-transition-delta-results.json":"cancellation-transition-final-regression-results.json"):"cancellation-transition-results.json"),JSON.stringify(result,null,2)+"\n","utf8");
  console.log(JSON.stringify({passed:cases.length,baselineP1Reproduced:baselineFindings.length>0,noEmit:"PASS",networkAttempts,messagesSent:0}));
}finally{net.Socket.prototype.connect=originalConnect;globalThis.fetch=originalFetch;}
