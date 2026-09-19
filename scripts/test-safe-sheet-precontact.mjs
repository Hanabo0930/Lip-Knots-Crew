import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const dependency=createRequire(import.meta.url),ts=dependency("typescript");
const {Timestamp}=dependency("firebase-admin/firestore");
const {HttpsError}=dependency("firebase-functions/v2/https");
const crypto=dependency("node:crypto");
const companyId="synthetic-company",staffId="synthetic-staff",jobId="synthetic-job",queueId="synthetic-queue";
const dateKey="2099-09-20",sheetId="synthetic-sheet",sheetName="2099.9";
const pending=()=>({companyId,jobId,operation:"precontact.submit",dateKey,updates:{temperature:36.5,arrivalTime:"09:30"},expected:{temperature:{mode:"blank"},arrivalTime:{mode:"blank"}},status:"pending",attempts:0,actorStaffId:staffId,actorUid:"synthetic-user",idempotencyKey:`precontact:${jobId}:${queueId}`});
const job=()=>({companyId,caseId:"synthetic-case",dateKey,workDate:dateKey,status:"assigned",assignedStaffId:staffId,assignedStaffName:"Synthetic Staff",cancelled:false,preContactNeedsReview:false,preContactSyncPending:true,preContact:{source:"app",staffId,dateKey,operationId:queueId,temperature:36.5,arrivalTime:"09:30",submittedAt:Timestamp.now()},sheetRef:{spreadsheetId:sheetId,sheetId:1,sheetName,currentRow:2}});
function clone(v){if(v instanceof Timestamp)return v;if(Array.isArray(v))return v.map(clone);if(v&&typeof v==="object")return Object.fromEntries(Object.entries(v).map(([k,v])=>[k,clone(v)]));return v;}
function harness(){
 const records=new Map([
  [`sheetSyncQueue/${queueId}`,pending()],[`jobs/${jobId}`,job()],
  [`companies/${companyId}/sheetMappings/shift`,{enabled:true,spreadsheetId:sheetId,idColumn:"Q",columns:{temperature:"G",arrivalTime:"H",staffName:"B",workDate:"A"},operations:{"precontact.submit":{values:["temperature","arrivalTime"]}}}]
 ]);
 const h={records,reads:0,writes:[],authCalls:0,metrics:[],idRows:[["案件ID"],["synthetic-case"]],cells:new Map([["A2",dateKey],["B2","Synthetic Staff"],["G2",""],["H2",""],["Q2","synthetic-case"]]),operational:true,beforeCellRead:null,afterCellRead:null,onWrite:null,onCommit:null,failMetrics:false,failRead:false,failAfterWrite:false,failCompletion:false};
 let serial=0;
 const snapshot=ref=>{const value=clone(records.get(ref.path));return {id:ref.id,ref,exists:records.has(ref.path),data:()=>clone(value)};};
 const apply=items=>{for(const item of items){const old=records.get(item.ref.path)||{},next=item.merge?{...old}:{};
  for(const [key,value]of Object.entries(item.data)){if(value?.__delete){delete next[key];continue;}if(key.includes(".")){const parts=key.split(".");let target=next;for(const part of parts.slice(0,-1))target=target[part]={...target[part]};target[parts.at(-1)]=clone(value);}else next[key]=value?.__increment!==undefined?Number(old[key]??0)+value.__increment:clone(value);}
  records.set(item.ref.path,next);
 }};
 const ref=path=>({path,id:path.split("/").at(-1),get:async()=>snapshot(ref(path)),set:async(data,options)=>apply([{ref:ref(path),data,merge:options?.merge}])});
 const collection=(name,filters=[])=>({add:async data=>{const target=ref(name+"/synthetic-add-"+(++serial));await target.set(data);return target;},doc:(id)=>ref(name+"/"+(id||"synthetic-auto-"+(++serial))),where:(key,op,value)=>collection(name,[...filters,[key,op,value]]),orderBy:()=>collection(name,filters),limit:()=>collection(name,filters),get:async()=>{const docs=[...records].filter(([path,value])=>path.startsWith(name+"/")&&filters.every(([key,op,test])=>op==="=="?value[key]===test:op==="in"?test.includes(value[key]):value[key]?.toMillis()<=test.toMillis())).map(([path])=>snapshot(ref(path)));return {docs,size:docs.length,empty:docs.length===0};}});
 const db={collection,doc:ref,getAll:async(...refs)=>refs.map(snapshot),runTransaction:async callback=>{
  for(let attempt=0;attempt<5;attempt++){const writes=[],reads=[];const writer={get:async target=>{assert.equal(writes.length,0);const snap=snapshot(target);reads.push([target.path,JSON.stringify(snap.data())]);return snap;},set:(ref,data,options)=>writes.push({ref,data,merge:options?.merge}),update:(ref,data)=>writes.push({ref,data,merge:true}),create:(ref,data)=>{assert.ok(!records.has(ref.path));writes.push({ref,data,merge:false});}};
  const result=await callback(writer);await h.onCommit?.(writes);
  if(reads.some(([path,before])=>JSON.stringify(records.get(path))!==before))continue;
  if(h.failCompletion&&writes.some(w=>w.data.status==="completed"))throw Error("synthetic completion store failure");
  apply(writes);return result;}throw Error("Synthetic transaction contention");
 },batch:()=>{const writes=[];return {set:(ref,data,options)=>writes.push({ref,data,merge:options?.merge}),commit:async()=>{await h.onCommit?.(writes);if(h.failCompletion&&writes.some(w=>w.data.status==="completed"))throw Error("synthetic completion store failure");apply(writes);}};}};
 const rangeCell=range=>{assert.ok(range.startsWith("'"+sheetName+"'!"));return range.split("!")[1];};
 const sheets={spreadsheets:{values:{
  get:async input=>{assert.equal(input.spreadsheetId,sheetId);h.reads++;return {data:{values:h.idRows}};},
  batchGet:async input=>{assert.equal(input.spreadsheetId,sheetId);h.reads++;await h.beforeCellRead?.(input);if(h.failRead)throw Error("synthetic read failure");const out={data:{valueRanges:input.ranges.map(range=>({values:[[h.cells.get(rangeCell(range))??""]]}))}};await h.afterCellRead?.(input);return out;},
  batchUpdate:async input=>{assert.equal(input.spreadsheetId,sheetId);h.writes.push(clone(input));for(const update of input.requestBody.data){h.cells.set(rangeCell(update.range),update.values[0][0]);}await h.onWrite?.();if(h.failAfterWrite)throw Error("synthetic connection lost after applied write");return {data:{}};}
 },batchUpdate:async input=>{h.writes.push(clone(input));await h.onStyleWrite?.();if(h.failAfterStyle)throw Error("synthetic style reply lost");return {data:{}};}}};
 const modules=new Map();
 const boundaries={
  "./firebase":{db},"node:crypto":crypto,
  "firebase-admin/firestore":{Timestamp,FieldValue:{serverTimestamp:()=>Timestamp.now(),increment:n=>({__increment:n}),delete:()=>({__delete:true})}},
  "firebase-functions/v2/https":{HttpsError,onCall:handler=>handler},zod:dependency("zod"),
  "firebase-functions/v2/firestore":{onDocumentWritten:(_path,handler)=>handler},
  "firebase-functions/v2/scheduler":{onSchedule:(_config,handler)=>handler},
  "./system-safety":{assertProductionOperational:async()=>{if(!h.operational)throw new HttpsError("failed-precondition","paused");},getProductionOperationalState:async()=>({operational:h.operational,reason:"synthetic-pause"})},
  "./production-metrics":{incrementProductionMetrics:async(...args)=>{if(h.failMetrics)throw Error("synthetic metrics unavailable");h.metrics.push(args);}},
  googleapis:{google:{auth:{GoogleAuth:class{constructor(){h.authCalls++;}}},sheets:()=>sheets}}
 };
 function load(name){if(Object.hasOwn(boundaries,name))return boundaries[name];assert.ok(["./case-mail-resolution-core","./case-mail-preparation-core","./submission-status","./submission-integrity","./submission-deadline-policy","./safe-sheet-writes","./sheet-write-core","./shift-parser","./case-id","./admin-operations","./admin-operations-core","./utils","./jobs","./analytics","./analytics-core","./notification-core","./notification-time","./japan-business-day","./netprint","./netprint-state-core", "./assignment-preparation-core", "./admin-edit-state-core", "./job-management-core", "./job-management", "./automation-intake", "./automation-recruitment-core", "./automation-bridge-core", "./case-mail-publication", "./case-mail-publication-core", "./job-group-creation", "./case-mail-job-creation", "./case-mail-collision"].includes(name),"Unexpected import "+name);if(modules.has(name))return modules.get(name);const exports={};modules.set(name,exports);const source=fs.readFileSync(new URL("../functions/src/"+name.slice(2)+".ts",import.meta.url),"utf8");runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:load,Date,console:{warn(){},error(){}}});return exports;}
 const worker=load("./safe-sheet-writes"),admin=load("./admin-operations"),qref=ref(`sheetSyncQueue/${queueId}`);
 return Object.assign(h,{core:(module,name,...args)=>load(module)[name](...args),admin:(name,data={},auth={uid:"synthetic-admin",token:{companyId,role:"admin"}})=>admin[name]({auth,data}),queue:()=>records.get(qref.path),job:()=>records.get(`jobs/${jobId}`),mapping:()=>records.get(`companies/${companyId}/sheetMappings/shift`),run:async eventQueue=>worker.processSafeSheetWrite({data:{after:eventQueue?{...snapshot(qref),data:()=>clone(eventQueue)}:snapshot(qref)}}),call:(module,name,data,auth={uid:"synthetic-admin",token:{companyId,role:"admin"}})=>load(module)[name]({auth,data}),queueResult:async id=>admin.updateExpenseReviewFromQueue({data:{after:snapshot(ref(`sheetSyncQueue/${id}`))}}),runQueue:async id=>worker.processSafeSheetWrite({data:{after:snapshot(ref(`sheetSyncQueue/${id}`))}}),retry:()=>worker.retrySafeSheetWrites()});
}
const results=[];
const testPrefix=process.argv.find(arg=>arg.startsWith('--test-name-prefix='))?.slice('--test-name-prefix='.length);
const failedFrom=process.argv.find(arg=>arg.startsWith("--test-failed-from="))?.slice("--test-failed-from=".length);
const failedNames=failedFrom?new Set(JSON.parse(fs.readFileSync(failedFrom,"utf8")).results.filter(row=>!row.passed).map(row=>row.name)):null;
async function test(name,fn){if((testPrefix&&!name.startsWith(testPrefix))||(failedNames&&!failedNames.has(name)))return;try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});}}
function assertVerificationHeld(h,writeCount=0){
 assert.equal(h.queue().status,"blocked");assert.equal(h.queue().errorType,"verification_required");assert.equal(h.queue().writeVerificationRequired,true);assert.equal(h.queue().retryAt,null);
 assert.equal(h.writes.length,writeCount);assert.equal(h.job().preContactSyncPending,true);
}
await test("pending verification flag holds before source access and preserves request",async()=>{
 const h=harness();Object.assign(h.queue(),{writeVerificationRequired:true,errorType:"system",errorMessage:"original unresolved result",acknowledgedNote:"prior memo"});
 const original={updates:clone(h.queue().updates),expected:clone(h.queue().expected),attempts:h.queue().attempts};await h.run();assertVerificationHeld(h);
 assert.equal(h.reads,0);assert.equal(h.authCalls,0);assert.equal(h.metrics.length,0);assert.deepEqual(h.queue().updates,original.updates);assert.deepEqual(h.queue().expected,original.expected);assert.equal(h.queue().attempts,original.attempts);assert.equal(h.queue().errorMessage,"original unresolved result");assert.equal(h.queue().acknowledgedNote,"prior memo");
 const saved=JSON.stringify([...h.records]);await h.run(pending());await h.retry();assert.equal(JSON.stringify([...h.records]),saved);
});
for(const flag of [null,"false"])await test("malformed verification flag fails closed: "+String(flag),async()=>{const h=harness();h.queue().writeVerificationRequired=flag;await h.run();assertVerificationHeld(h);assert.equal(h.authCalls,0);});
await test("legacy verification error alone holds pending",async()=>{const h=harness();Object.assign(h.queue(),{writeVerificationRequired:false,errorType:"verification_required"});await h.run();assertVerificationHeld(h);assert.equal(h.reads,0);});
await test("due verification retry is held without rearming",async()=>{
 const h=harness();Object.assign(h.queue(),{status:"retry_wait",retryAt:Timestamp.fromMillis(0),attempts:4,writeVerificationRequired:true,errorType:"system"});await h.retry();assertVerificationHeld(h);assert.equal(h.queue().attempts,4);
 const rows=(await h.admin("getSheetWriteIssues")).issues;assert.equal(rows.length,1);assert.equal(rows[0].canRetry,false);await assert.rejects(h.admin("retrySheetWriteIssue",{queueId}),{code:"failed-precondition"});
});
await test("ordinary read failure still recovers through scheduler",async()=>{const h=harness();h.failRead=true;await h.run();assert.equal(h.queue().status,"retry_wait");assert.equal(h.queue().writeVerificationRequired,false);h.queue().retryAt=Timestamp.fromMillis(0);h.failRead=false;await h.retry();assert.equal(h.queue().status,"pending");await h.run();assert.equal(h.queue().status,"completed");assert.equal(h.writes.length,1);});
await test("claim transaction rechecks a newly added verification flag",async()=>{const h=harness();let changed=false;h.onCommit=writes=>{if(!changed&&writes.some(w=>w.data.status==="processing")){changed=true;h.queue().writeVerificationRequired=true;}};await h.run();assertVerificationHeld(h);assert.equal(h.authCalls,0);assert.equal(h.queue().attempts,0);});
await test("scheduler transaction rechecks newly added verification error",async()=>{const h=harness();Object.assign(h.queue(),{status:"retry_wait",retryAt:Timestamp.fromMillis(0)});let changed=false;h.onCommit=writes=>{if(!changed&&writes.some(w=>w.data.status==="pending")){changed=true;h.queue().errorType="verification_required";}};await h.retry();assertVerificationHeld(h);});
await test("verification added during source read prevents mutation",async()=>{const h=harness();h.afterCellRead=()=>{h.queue().writeVerificationRequired=true;};await h.run();assertVerificationHeld(h);});
await test("generic read failure cannot erase verification evidence",async()=>{const h=harness();h.beforeCellRead=()=>{h.queue().writeVerificationRequired=true;h.failRead=true;};await h.run();assertVerificationHeld(h);});
await test("failure transaction cannot clear a concurrent verification marker",async()=>{const h=harness();h.failMetrics=true;let changed=false;h.onCommit=writes=>{if(!changed&&writes.some(w=>w.data.status==="retry_wait")){changed=true;h.queue().writeVerificationRequired=true;}};await h.run();assertVerificationHeld(h);});
await test("duplicate completion cannot replace a concurrent verification hold",async()=>{
 const h=harness(),key=crypto.createHash("sha256").update(companyId+"|"+h.queue().idempotencyKey,"utf8").digest("hex");h.records.set("sheetWriteIdempotency/"+key,{companyId,queueId:"other-queue",status:"completed"});
 let changed=false;h.onCommit=writes=>{if(!changed&&writes.some(w=>w.data.status==="completed")){changed=true;h.queue().writeVerificationRequired=true;}};
 await h.run();assertVerificationHeld(h);assert.equal(h.reads,0);assert.equal(h.queue().duplicateOf,undefined);
});
await test("verification after values prevents a later style write",async()=>{const h=harness();generic(h);h.queue().styles={transportation:{background:"#ffeedd"}};h.onWrite=()=>{h.queue().writeVerificationRequired=true;};await h.run();assertVerificationHeld(h,1);});
await test("verification after mutation keeps the pending business result",async()=>{const h=harness();h.onWrite=()=>{h.queue().writeVerificationRequired=true;};await h.run();assertVerificationHeld(h,1);assert.equal([...h.records.keys()].some(k=>k.startsWith("sheetWriteIdempotency/")),false);});
await test("completion transaction cannot clear new verification evidence",async()=>{const h=harness();let changed=false;h.onCommit=writes=>{if(!changed&&writes.some(w=>w.data.status==="completed")){changed=true;h.queue().writeVerificationRequired=true;}};await h.run();assertVerificationHeld(h,1);assert.equal([...h.records.keys()].some(k=>k.startsWith("auditLogs/")),false);});
await test("old worker preserves a successor claim with verification evidence",async()=>{const h=harness();h.afterCellRead=()=>{h.queue().claimToken="successor";h.queue().writeVerificationRequired=true;};await h.run();assert.equal(h.writes.length,0);assert.equal(h.queue().status,"processing");assert.equal(h.queue().claimToken,"successor");assert.equal(h.queue().writeVerificationRequired,true);});

await test("acknowledged unknown write stays visible and is not completion",async()=>{
 const h=harness();h.failAfterWrite=true;await h.run();assert.equal(h.queue().writeVerificationRequired,true);
 assert.equal((await h.admin("getSheetWriteIssues")).issues.length,1);const beforeJob=JSON.stringify(h.job()),count=h.writes.length;
 await h.admin("acknowledgeSheetWriteIssue",{queueId,note:"合成データで原本照合待ちを確認"});
 const rows=(await h.admin("getSheetWriteIssues")).issues;assert.equal(rows.length,1);
 assert.equal(rows[0].status,"acknowledged");assert.equal(rows[0].writeVerificationRequired,true);assert.equal(rows[0].canRetry,false);assert.equal(rows[0].sourceWriteVerified,false);
 assert.equal(rows[0].acknowledgedNote,"合成データで原本照合待ちを確認");assert.equal(typeof rows[0].acknowledgedAt,"string");
 assert.equal(h.queue().acknowledgedFromStatus,"blocked");assert.equal(JSON.stringify(h.job()),beforeJob);await h.retry();assert.equal(h.writes.length,count);
});
await test("acknowledgement lost response can be repeated without replacing the note",async()=>{
 const h=harness();Object.assign(h.queue(),{status:"blocked",errorType:"conflict",updatedAt:Timestamp.now()});
 await h.admin("acknowledgeSheetWriteIssue",{queueId,note:"original"});const before=JSON.stringify([...h.records]);
 await h.admin("acknowledgeSheetWriteIssue",{queueId,note:"original"});assert.equal(JSON.stringify([...h.records]),before);
 await assert.rejects(h.admin("acknowledgeSheetWriteIssue",{queueId,note:"replacement"}),{code:"failed-precondition"});assert.equal(JSON.stringify([...h.records]),before);
});
await test("verification flag independently prevents manual retry",async()=>{
 const h=harness();Object.assign(h.queue(),{status:"dead_letter",errorType:"system",writeVerificationRequired:true,updatedAt:Timestamp.now()});
 assert.equal((await h.admin("getSheetWriteIssues")).issues[0].canRetry,false);
 const before=JSON.stringify([...h.records]);await assert.rejects(h.admin("retrySheetWriteIssue",{queueId}),{code:"failed-precondition"});assert.equal(JSON.stringify([...h.records]),before);
});
for(const status of ["error","paused_global"])await test("legacy or paused queue remains visible without retry: "+status,async()=>{
 const h=harness();Object.assign(h.queue(),{status,errorType:"system",updatedAt:Timestamp.now()});
 const rows=(await h.admin("getSheetWriteIssues")).issues;assert.equal(rows.length,1);assert.equal(rows[0].canRetry,false);assert.equal(rows[0].sourceWriteVerified,false);
 await h.admin("acknowledgeSheetWriteIssue",{queueId,note:"state checked"});
 assert.equal(h.queue().acknowledgedFromStatus,status);assert.equal((await h.admin("getSheetWriteIssues")).issues.length,1);assert.equal(h.writes.length,0);
});
await test("acknowledgement cannot race a completed write into an unresolved state",async()=>{
 const h=harness();Object.assign(h.queue(),{status:"blocked",errorType:"conflict",updatedAt:Timestamp.now()});let changed=false;
 h.onCommit=()=>{if(!changed){changed=true;h.queue().status="completed";}};
 await assert.rejects(h.admin("acknowledgeSheetWriteIssue",{queueId}),{code:"failed-precondition"});assert.equal(h.queue().status,"completed");assert.equal(h.writes.length,0);
});
await test("reviewed queue metadata is company scoped and staff cannot acknowledge",async()=>{
 const h=harness();Object.assign(h.queue(),{status:"acknowledged",acknowledgedAt:Timestamp.now(),acknowledgedNote:"private",companyId:"other",updatedAt:Timestamp.now()});
 assert.equal((await h.admin("getSheetWriteIssues")).issues.length,0);await assert.rejects(h.admin("acknowledgeSheetWriteIssue",{queueId}),{code:"not-found"});
 await assert.rejects(h.admin("acknowledgeSheetWriteIssue",{queueId},{uid:"staff-user",token:{companyId,role:"staff",staffId}}),{code:"permission-denied"});
});

await test("normal precontact writes once and marks verified",async()=>{const h=harness();await h.run();assert.equal(h.writes.length,1);assert.equal(h.queue().status,"completed");assert.equal(h.job().preContactSyncPending,false);await h.run(pending());assert.equal(h.writes.length,1);});
for(const [name,change]of [
 ["staff changed",h=>h.job().assignedStaffId="new-person"],
 ["date changed",h=>h.job().dateKey="2099-09-21"],
 ["cancelled",h=>h.job().cancelled=true],
 ["unconfirmed assignment",h=>h.job().applicationUnconfirmed=true],
 ["identity review",h=>h.job().preContactNeedsReview=true],
 ["new submission",h=>h.job().preContact.operationId="new-submission"],
 ["different values",h=>h.job().preContact.temperature=37.2],
 ["missing owner proof",h=>delete h.job().preContact.staffId],
 ["legacy queue date missing",h=>delete h.queue().dateKey],
 ["different source book",h=>h.job().sheetRef.spreadsheetId="other-book"],
 ["invalid temperature",h=>h.queue().updates.temperature=99],
 ["unexpected style",h=>{h.queue().styles={temperature:{background:"#ff0000"}};h.mapping().operations["precontact.submit"].styles=["temperature"]; }]
])await test(name+" blocks before Sheets",async()=>{const h=harness();change(h);await h.run();assert.equal(h.queue().status,"blocked");assert.equal(h.authCalls,0);assert.equal(h.writes.length,0);});
await test("claim uses current queue rather than stale event",async()=>{const h=harness(),old=clone(h.queue());h.queue().updates.temperature=37.0;h.job().preContact.temperature=37.0;await h.run(old);assert.equal(h.cells.get("G2"),37.0);});
await test("staff changes during source read",async()=>{const h=harness();h.afterCellRead=()=>{h.job().assignedStaffId="new-person";};await h.run();assert.equal(h.writes.length,0);assert.equal(h.queue().status,"blocked");});
await test("latest input changes during source read",async()=>{const h=harness();h.afterCellRead=()=>{h.job().preContact.operationId="new-operation";};await h.run();assert.equal(h.writes.length,0);assert.equal(h.queue().status,"blocked");});
await test("changed sheet staff rejected",async()=>{const h=harness();h.cells.set("B2","Another Staff");await h.run();assert.equal(h.writes.length,0);assert.equal(h.queue().status,"blocked");});
await test("duplicate case IDs rejected",async()=>{const h=harness();h.idRows.push(["synthetic-case"]);await h.run();assert.equal(h.writes.length,0);assert.equal(h.queue().status,"blocked");});
await test("already applied values verified without writing again",async()=>{const h=harness();h.cells.set("G2","36.5");h.cells.set("H2","9:30");await h.run();assert.equal(h.writes.length,0);assert.equal(h.queue().status,"completed");});
await test("uncertain write is never auto-retried",async()=>{const h=harness();h.failAfterWrite=true;await h.run();assert.equal(h.queue().status,"blocked");assert.equal(h.queue().errorType,"verification_required");assert.equal(h.queue().retryAt,null);await h.retry();assert.equal(h.queue().status,"blocked");assert.equal(h.queue().errorType,"verification_required");await h.run();assert.equal(h.writes.length,1);});
await test("read failure before write can retry",async()=>{const h=harness();h.failRead=true;await h.run();assert.equal(h.writes.length,0);assert.equal(h.queue().status,"retry_wait");h.failRead=false;h.queue().status="pending";await h.run();assert.equal(h.queue().status,"completed");});
await test("verification read failure holds after mutation",async()=>{const h=harness();h.onWrite=()=>{h.failRead=true;};await h.run();assert.equal(h.writes.length,1);assert.equal(h.queue().status,"blocked");assert.equal(h.queue().errorType,"verification_required");});
await test("completion storage failure holds after mutation",async()=>{const h=harness();h.failCompletion=true;await h.run();assert.equal(h.writes.length,1);assert.equal(h.queue().status,"blocked");assert.equal(h.queue().errorType,"verification_required");});
await test("changed owner after write never clears new pending state",async()=>{const h=harness();h.onWrite=()=>{h.job().assignedStaffId="new-person";};await h.run();assert.equal(h.job().preContactSyncPending,true);assert.equal(h.queue().status,"blocked");assert.equal(h.queue().errorType,"verification_required");});
await test("telemetry failure cannot strand processing queue",async()=>{const h=harness();h.failMetrics=true;await h.run();assert.notEqual(h.queue().status,"processing");assert.equal(h.writes.length,0);});
await test("disabled mapping remains disabled",async()=>{const h=harness();h.mapping().enabled=false;await h.run();assert.equal(h.queue().status,"blocked");assert.equal(h.writes.length,0);});
await test("operational pause stays quiet",async()=>{const h=harness();h.operational=false;await h.run();assert.equal(h.queue().status,"paused_global");assert.equal(h.writes.length,0);});
await test("parallel triggers acquire one claim",async()=>{const h=harness();await Promise.all([h.run(),h.run()]);assert.equal(h.writes.length,1);assert.equal(h.queue().status,"completed");});
for(const [name,change]of [
 ["case ID",h=>h.job().caseId="changed-case"],
 ["mapping",h=>h.mapping().enabled=false],
 ["queue payload",h=>h.queue().updates.temperature=38],
 ["global pause",h=>h.operational=false],
 ["expired claim",h=>h.queue().retryAt=Timestamp.fromMillis(0)],
])await test(name+" changes during source read",async()=>{const h=harness();h.afterCellRead=()=>change(h);await h.run();assert.equal(h.writes.length,0);assert.equal(h.queue().status,"blocked");});
await test("old worker cannot overwrite successor claim",async()=>{const h=harness();h.afterCellRead=()=>{h.queue().claimToken="successor";};await h.run();assert.equal(h.writes.length,0);assert.equal(h.queue().status,"processing");assert.equal(h.queue().claimToken,"successor");});
for(const [name,change]of [["row staff",h=>h.cells.set("B2","New Staff")],["row ID",h=>h.cells.set("Q2","other-case")],["mapping",h=>h.mapping().enabled=false]])await test(name+" changes after write requires verification",async()=>{const h=harness();h.onWrite=()=>change(h);await h.run();assert.equal(h.writes.length,1);assert.equal(h.queue().status,"blocked");assert.equal(h.queue().errorType,"verification_required");assert.equal(h.job().preContactSyncPending,true);});
await test("completion transaction rechecks changed assignment",async()=>{const h=harness();let changed=false;h.onCommit=writes=>{if(!changed&&writes.some(w=>w.data.status==="completed")){changed=true;h.job().assignedStaffId="new-person";}};await h.run();assert.equal(h.writes.length,1);assert.equal(h.queue().errorType,"verification_required");assert.equal(h.job().preContactSyncPending,true);});
await test("expired processing becomes visible confirmation work",async()=>{const h=harness();Object.assign(h.queue(),{status:"processing",claimToken:"old",retryAt:Timestamp.fromMillis(0)});await h.retry();assert.equal(h.queue().status,"blocked");assert.equal(h.queue().errorType,"verification_required");assert.equal(h.writes.length,0);});
await test("live processing lease is retained",async()=>{const h=harness();Object.assign(h.queue(),{status:"processing",claimToken:"live",retryAt:Timestamp.fromMillis(Date.now()+600000)});await h.retry();assert.equal(h.queue().status,"processing");assert.equal(h.writes.length,0);});
await test("retry scheduler does not undo acknowledgement",async()=>{const h=harness();Object.assign(h.queue(),{status:"retry_wait",retryAt:Timestamp.fromMillis(0)});let changed=false;h.onCommit=writes=>{if(!changed&&writes.some(w=>w.data.status==="pending")){changed=true;h.queue().status="acknowledged";}};await h.retry();assert.equal(h.queue().status,"acknowledged");});
await test("unknown write visible in admin and manual retry rejected",async()=>{const h=harness();h.failAfterWrite=true;await h.run();const issues=await h.admin("getSheetWriteIssues");assert.equal(issues.count,1);assert.equal(issues.issues[0].canRetry,false);assert.equal(issues.issues[0].errorType,"verification_required");await assert.rejects(h.admin("retrySheetWriteIssue",{queueId}),{code:"failed-precondition"});assert.equal(h.queue().status,"blocked");assert.equal(h.writes.length,1);});
await test("acknowledgement does not claim successful writing",async()=>{const h=harness();h.failAfterWrite=true;await h.run();await h.admin("acknowledgeSheetWriteIssue",{queueId,note:"synthetic manual review"});assert.equal(h.queue().status,"acknowledged");assert.equal(h.queue().writeVerificationRequired,true);assert.equal(h.job().preContactSyncPending,true);assert.equal(h.writes.length,1);});
await test("read-only failure can recover through actual admin retry",async()=>{const h=harness();h.failRead=true;await h.run();const issues=await h.admin("getSheetWriteIssues");assert.equal(issues.issues[0].canRetry,true);h.failRead=false;await h.admin("retrySheetWriteIssue",{queueId});await h.run();assert.equal(h.queue().status,"completed");assert.equal(h.writes.length,1);});
await test("admin issue access stays company scoped",async()=>{const h=harness();h.failAfterWrite=true;await h.run();const auth={uid:"foreign-admin",token:{companyId:"foreign",role:"admin"}};assert.equal((await h.admin("getSheetWriteIssues",{},auth)).count,0);await assert.rejects(h.admin("acknowledgeSheetWriteIssue",{queueId},auth),{code:"not-found"});await assert.rejects(h.admin("getSheetWriteIssues",{},null),{code:"unauthenticated"});});
function generic(h){h.queue().operation="synthetic.generic";h.queue().updates={transportation:120};h.queue().expected={transportation:{mode:"blank"}};h.mapping().columns.transportation="R";h.mapping().operations["synthetic.generic"]={values:["transportation"],styles:["transportation"]};}
await test("ordinary configured value still completes",async()=>{const h=harness();generic(h);await h.run();assert.equal(h.queue().status,"completed");assert.equal(h.cells.get("R2"),120);assert.equal(h.job().preContactSyncPending,true);});
await test("ordinary style supports sheetId zero",async()=>{const h=harness();generic(h);h.job().sheetRef.sheetId=0;h.queue().styles={transportation:{background:"#ffeedd"}};await h.run();assert.equal(h.queue().status,"completed");assert.equal(h.writes.length,2);});
await test("precontact day formats use existing parser",async()=>{const h=harness();h.cells.set("A2","9/20");await h.run();assert.equal(h.queue().status,"completed");});
await test("precontact expected clock accepts leading-zero formatting",async()=>{const h=harness();h.cells.set("G2","36.0");h.cells.set("H2","9:00");h.queue().expected={temperature:{mode:"exact",value:36},arrivalTime:{mode:"exact",value:"09:00"}};await h.run();assert.equal(h.queue().status,"completed");});
for(const mode of ["exact","substring","empty","bad-date"])await test("generic fallback "+mode,async()=>{const h=harness();generic(h);delete h.mapping().idColumn;h.mapping().allowVerifiedFallbackRow=true;h.mapping().identityColumns={workDate:"A",clientName:"J",storeName:"K",workTime:"O"};Object.assign(h.job(),{clientName:"Synthetic Client",storeName:"Synthetic Store",workTime:"10:00-18:00"});h.cells.set("J2","Synthetic Client");h.cells.set("K2",mode==="substring"?"Store":mode==="empty"?"":"Synthetic Store");h.cells.set("O2","10:00-18:00");if(mode==="bad-date"){h.job().workDate="invalid";h.cells.set("A2","invalid");}await h.run();assert.equal(h.queue().status,mode==="exact"?"completed":"blocked");assert.equal(h.writes.length,mode==="exact"?1:0);});
await test("malformed header row cannot enable writing",async()=>{const h=harness();h.job().sheetRef.headerRow="invalid";await h.run();assert.equal(h.queue().status,"blocked");assert.equal(h.writes.length,0);});
for(const mode of ["bad-color","missing-sheet-id","extra-style-field"])await test("invalid style blocks value mutation too: "+mode,async()=>{const h=harness();generic(h);h.queue().styles={transportation:mode==="bad-color"?{background:"bad"}:mode==="extra-style-field"?{background:"#ffeedd",other:true}:{background:"#ffeedd"}};if(mode==="missing-sheet-id")delete h.job().sheetRef.sheetId;await h.run();assert.equal(h.writes.length,0);assert.equal(h.queue().status,"blocked");});
for(const value of ["36.50","３６．５",36.5])await test("formatted identical temperature is not rewritten: "+value,async()=>{const h=harness();h.cells.set("G2",value);h.cells.set("H2","09:30");await h.run();assert.equal(h.writes.length,0);assert.equal(h.queue().status,"completed");});
await test("assignment change after values prevents further style mutation",async()=>{const h=harness();generic(h);h.queue().styles={transportation:{background:"#ffeedd"}};h.onWrite=()=>{h.job().assignedStaffId="new-person";};await h.run();assert.equal(h.writes.length,1);assert.equal(h.queue().errorType,"verification_required");});
await test("actual admin panel hides retry for unknown write",async()=>{
 const h=harness();h.failAfterWrite=true;await h.run();const issues=(await h.admin("getSheetWriteIssues")).issues;
 // 追加した読取入口の動作は専用ブラウザー検証で確認し、ここでは実パネルの再試行拒否を確認する。
 const exports={},source=fs.readFileSync(new URL("../apps/admin/src/AdminSheetIssuePanel.tsx",import.meta.url),"utf8");
 runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>{if(name==="./SheetWriteReviewEntry")return {__esModule:true,default:()=>null};assert.equal(name,"react/jsx-runtime");return dependency(name);}});
 const html=dependency("react-dom/server").renderToStaticMarkup(dependency("react").createElement(exports.default,{sheetIssues:issues,issuesBusy:false,operationKeys:[],loadSheetIssues(){},retrySheetIssue(){throw Error("must not retry");},acknowledgeSheetIssue(){}}));
 assert.ok(html.includes("自動再書込は行いません"));assert.ok(!html.includes(">再試行</button>"));assert.ok(html.includes(">確認メモを記録</button>"));
});
async function expenseHarness(){
 const h=harness();
 const keys=["transportation","purchase8","purchase10","netPrintCost","postageCost"];
 keys.forEach((key,i)=>h.mapping().columns[key]=String.fromCharCode(82+i));
 h.mapping().operations["expense.review"]={values:keys};
 h.complete=async(values={transportation:120})=>h.admin("completeExpenseReview",{jobId,values});
 h.review=()=>h.records.get(`expenseReviews/${jobId}`);
 h.expenseQueue=id=>h.records.get(`sheetSyncQueue/${id}`);
 const result=await h.complete();h.expenseId=result.queueId;
 return h;
}
await test("actual expense caller and worker complete current review",async()=>{const h=await expenseHarness();await h.runQueue(h.expenseId);assert.equal(h.expenseQueue(h.expenseId).status,"completed");assert.equal(h.cells.get("R2"),120);});
await test("newer expense review blocks old pending values",async()=>{const h=await expenseHarness();const next=await h.complete({transportation:240});await h.runQueue(h.expenseId);assert.equal(h.writes.length,0);assert.equal(h.expenseQueue(h.expenseId).status,"blocked");await h.runQueue(next.queueId);assert.equal(h.cells.get("R2"),240);assert.equal(h.expenseQueue(next.queueId).status,"completed");});
await test("new expense draft invalidates old pending completion",async()=>{const h=await expenseHarness();await h.admin("saveExpenseReviewDraft",{jobId,values:{transportation:330}});await h.runQueue(h.expenseId);assert.equal(h.writes.length,0);assert.equal(h.review().status,"draft");});
for(const [name,change]of [
 ["staff",h=>h.job().assignedStaffId="new-person"],
 ["day",h=>h.job().dateKey="2099-09-21"],
 ["sheet tab",h=>h.job().sheetRef.sheetId=7],
 ["source missing",h=>h.job().sourceMissing=true],
 ["foreign review",h=>h.review().companyId="foreign"],
 ["wrong job",h=>h.review().jobId="wrong"],
 ["missing review",h=>h.records.delete(`expenseReviews/${jobId}`)],
 ["review values",h=>h.review().values.transportation=550],
 ["queue values",h=>h.expenseQueue(h.expenseId).updates.transportation=550],
 ["revision",h=>h.review().revision+=1],
 ["completed review",h=>h.review().status="completed"],
 ["legacy proof",h=>delete h.review().writeContext],
])await test("expense blocks changed "+name,async()=>{const h=await expenseHarness();change(h);await h.runQueue(h.expenseId);assert.equal(h.writes.length,0);assert.equal(h.expenseQueue(h.expenseId).status,"blocked");});
for(const [name,change]of [
 ['unconditional expected',h=>h.expenseQueue(h.expenseId).expected.transportation={mode:'any'}],
 ['missing expected key',h=>delete h.expenseQueue(h.expenseId).expected.transportation],
 ['extra expected key',h=>h.expenseQueue(h.expenseId).expected.other={mode:'blank'}],
 ['changed expected amount',h=>h.expenseQueue(h.expenseId).expected.transportation={mode:'exact',value:99}],
 ['missing previous values',h=>delete h.review().expectedValues],
 ['malformed previous values',h=>h.review().expectedValues.transportation=''],
 ['extra previous field',h=>h.review().expectedValues.other=1],
 ['changed saved expense',h=>h.job().expenses={transportation:99}],
 ['changed original cell',h=>h.cells.set('R2',99)],
])await test('expense refuses '+name,async()=>{const h=await expenseHarness();change(h);await h.runQueue(h.expenseId);assert.equal(h.writes.length,0);assert.equal(h.expenseQueue(h.expenseId).status,'blocked');assert.equal(h.expenseQueue(h.expenseId).errorType,'conflict');});
await test('expense rechecks expected conditions after source read',async()=>{const h=await expenseHarness();h.afterCellRead=()=>{h.review().expectedValues.transportation=77;};await h.runQueue(h.expenseId);assert.equal(h.writes.length,0);assert.equal(h.expenseQueue(h.expenseId).status,'blocked');});
await test('expense refuses unrestricted API request without altering existing review',async()=>{const h=await expenseHarness();const before=JSON.stringify([...h.records]);await assert.rejects(h.admin('completeExpenseReview',{jobId,values:{transportation:99},confirmExistingValues:true}),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);});
await test("expense rechecks latest review after sheet read",async()=>{const h=await expenseHarness();let changed=false;h.afterCellRead=async()=>{if(!changed){changed=true;await h.complete({transportation:440});}};await h.runQueue(h.expenseId);assert.equal(h.writes.length,0);});
await test("expense changed after write requires verification",async()=>{const h=await expenseHarness();h.onWrite=()=>{h.review().queueId="new-queue";};await h.runQueue(h.expenseId);assert.equal(h.writes.length,1);assert.equal(h.expenseQueue(h.expenseId).errorType,"verification_required");});
await test("expense completion transaction retries changed proof",async()=>{const h=await expenseHarness();let changed=false;h.onCommit=writes=>{if(!changed&&writes.some(w=>w.data.status==="completed")){changed=true;h.review().queueId="new-queue";}};await h.runQueue(h.expenseId);assert.equal(h.expenseQueue(h.expenseId).errorType,"verification_required");});
await test("expense confirmed cancellation can retain authorized costs",async()=>{const h=await expenseHarness();h.job().cancelled=true;h.job().status="cancelled";await h.runQueue(h.expenseId);assert.equal(h.expenseQueue(h.expenseId).status,"completed");assert.equal(h.cells.get("R2"),120);});
await test("expense assigned row move resolves by stable case ID",async()=>{const h=await expenseHarness();h.job().sheetRef.currentRow=7;await h.runQueue(h.expenseId);assert.equal(h.expenseQueue(h.expenseId).resolvedRow,2);assert.equal(h.expenseQueue(h.expenseId).status,"completed");});
await test("expense duplicate event writes once",async()=>{const h=await expenseHarness();await Promise.all([h.runQueue(h.expenseId),h.runQueue(h.expenseId)]);assert.equal(h.writes.length,1);assert.equal(h.expenseQueue(h.expenseId).status,"completed");});
await test("expense caller worker and finalizer retain latest amounts",async()=>{const h=await expenseHarness();await h.runQueue(h.expenseId);await h.queueResult(h.expenseId);assert.equal(h.review().status,"completed");assert.equal(h.job().expenses.transportation,120);const next=await h.complete({transportation:250});await h.runQueue(next.queueId);await h.queueResult(next.queueId);await h.queueResult(h.expenseId);assert.equal(h.review().queueId,next.queueId);assert.equal(h.review().status,"completed");assert.equal(h.job().expenses.transportation,250);});
await test("expense interrupted write finalizer reports error not success",async()=>{const h=await expenseHarness();h.failAfterWrite=true;await h.runQueue(h.expenseId);await h.queueResult(h.expenseId);assert.equal(h.review().status,"error");assert.equal(h.review().sheetWriteStatus,"blocked");assert.equal(h.job().expenses,undefined);await assert.rejects(h.admin("retrySheetWriteIssue",{queueId:h.expenseId}),{code:"failed-precondition"});});
await test("expense read failure can retry the same current review",async()=>{const h=await expenseHarness();h.failRead=true;await h.runQueue(h.expenseId);assert.equal(h.expenseQueue(h.expenseId).status,"retry_wait");h.failRead=false;await h.admin("retrySheetWriteIssue",{queueId:h.expenseId});await h.runQueue(h.expenseId);await h.queueResult(h.expenseId);assert.equal(h.review().status,"completed");assert.equal(h.writes.length,1);});
await test("expense changed day during creation cannot enqueue stale context",async()=>{const h=await expenseHarness();let changed=false;h.onCommit=writes=>{if(!changed&&writes.some(w=>w.data.operation==="expense.review")){changed=true;h.job().dateKey="2099-09-21";}};await assert.rejects(h.complete({transportation:770}),{code:"failed-precondition"});assert.equal([...h.records.values()].filter(v=>v.operation==="expense.review").length,1);});
await test("expense zero and blank values remain distinct",async()=>{const h=await expenseHarness();const next=await h.complete({transportation:0,purchase8:null,purchase10:"0",netPrintCost:15.5});await h.runQueue(next.queueId);assert.equal(h.expenseQueue(next.queueId).status,"completed");assert.equal(h.cells.get("R2"),0);assert.equal(h.cells.get("S2"),"");assert.equal(h.cells.get("T2"),0);assert.equal(h.cells.get("U2"),15.5);});
function cancellationHarness(){
 const h=harness();h.records.set(`staffProfiles/${staffId}`,{companyId,active:true});
 const keys=["cancelled","cancellationReason","cancellationReasonCategory","cancellationFinancialTreatment"];
 keys.forEach((key,i)=>h.mapping().columns[key]=String.fromCharCode(86+i));
 h.mapping().operations["job.cancel"]={values:keys.slice(0,2)};
 h.mapping().operations["job.cancel.v2"]={values:keys};h.mapping().operations["job.restore"]={values:keys};
 h.last=operation=>[...h.records].filter(([path,q])=>path.startsWith("sheetSyncQueue/")&&q.operation===operation).at(-1)?.[0].split("/").at(-1);
 h.cancel=async(note="first")=>{await h.call("./analytics","adminSetJobCancellation",{jobId,reasonCategory:"other",reasonNote:note,financialTreatment:"neither"});return h.last("job.cancel.v2");};
 h.restore=async()=>{await h.call("./analytics","adminRestoreCancelledJob",{jobId});return h.last("job.restore");};
 h.legacyCancel=async(reason="legacy")=>{await h.call("./jobs","adminCancelJob",{jobId,reason});return h.last("job.cancel");};
 h.q=id=>h.records.get(`sheetSyncQueue/${id}`);
 return h;
}
for(const kind of ["cancel","legacyCancel"])await test("current "+kind+" reaches sheet",async()=>{const h=cancellationHarness(),id=await h[kind]();await h.runQueue(id);assert.equal(h.q(id).status,"completed");assert.equal(h.cells.get("V2"),true);});
for(const kind of ["cancel","legacyCancel"])await test("restored job rejects delayed "+kind,async()=>{const h=cancellationHarness(),old=await h[kind]();const restore=await h.restore();await h.runQueue(old);assert.equal(h.writes.length,0);assert.equal(h.q(old).status,"blocked");await h.runQueue(restore);assert.equal(h.q(restore).status,"completed");assert.equal(h.cells.get("V2"),false);});
await test("recancelled job rejects delayed restore",async()=>{const h=cancellationHarness();await h.cancel();const old=await h.restore();const next=await h.cancel("next");await h.runQueue(old);assert.equal(h.writes.length,0);await h.runQueue(next);assert.equal(h.q(next).status,"completed");assert.equal(h.cells.get("V2"),true);});
await test("new cancellation reason rejects earlier reason",async()=>{const h=cancellationHarness();const old=await h.cancel("first"),next=await h.cancel("second");await h.runQueue(old);assert.equal(h.writes.length,0);await h.runQueue(next);assert.equal(h.cells.get("W2"),h.job().cancellationReason);});
for(const [name,change]of [
 ["day",h=>h.job().dateKey="2099-09-21"],["staff",h=>h.job().assignedStaffId="new-person"],
 ["tab",h=>h.job().sheetRef.sheetId=9],["source missing",h=>h.job().sourceMissing=true],
 ["reason",h=>h.job().cancellationReason="changed"],["legacy proof",h=>delete h.job().cancellationSheetWrite],
])await test("cancellation blocks changed "+name,async()=>{const h=cancellationHarness(),id=await h.cancel();change(h);await h.runQueue(id);assert.equal(h.writes.length,0);assert.equal(h.q(id).status,"blocked");});
await test("cancellation rechecks restore during sheet read",async()=>{const h=cancellationHarness(),id=await h.cancel();let changed=false;h.afterCellRead=async()=>{if(!changed){changed=true;await h.restore();}};await h.runQueue(id);assert.equal(h.writes.length,0);});
await test("cancellation restored after write holds unknown result",async()=>{const h=cancellationHarness(),id=await h.cancel();h.onWrite=()=>h.restore();await h.runQueue(id);assert.equal(h.q(id).errorType,"verification_required");assert.equal(h.writes.length,1);});
await test("cancellation completion transaction rechecks latest intent",async()=>{const h=cancellationHarness(),id=await h.cancel();let changed=false;h.onCommit=async writes=>{if(!changed&&writes.some(w=>w.data.status==="completed")){changed=true;await h.restore();}};await h.runQueue(id);assert.equal(h.q(id).errorType,"verification_required");});
await test("cancellation proof survives consumed import override",async()=>{const h=cancellationHarness(),id=await h.cancel();delete h.job().appOverride;await h.runQueue(id);assert.equal(h.q(id).status,"completed");});
await test("restoration proof survives consumed import override",async()=>{const h=cancellationHarness();await h.cancel();const id=await h.restore();delete h.job().appOverride;await h.runQueue(id);assert.equal(h.q(id).status,"completed");});
for(const [name,change]of [
 ["financial treatment",h=>h.job().cancellationFinancialTreatment="invoice_only"],
 ["invalid reason category",h=>h.job().cancellationReasonCategory="__proto__"],
 ["queue amount policy",(h,id)=>h.q(id).updates.cancellationFinancialTreatment="changed"],
 ["extra styles",(h,id)=>h.q(id).styles={cancelled:{background:"#ffffff"}}],
 ["wrong operation proof",h=>h.job().cancellationSheetWrite.operation="job.restore"],
])await test("cancellation rejects changed "+name,async()=>{const h=cancellationHarness(),id=await h.cancel();change(h,id);await h.runQueue(id);assert.equal(h.q(id).status,"blocked");assert.equal(h.writes.length,0);});
await test("same-millisecond cancellation intents use unique keys",async()=>{const previous=Timestamp.now;Timestamp.now=()=>Timestamp.fromMillis(1789219000000);try{const h=cancellationHarness(),first=await h.cancel("first"),second=await h.cancel("second");assert.notEqual(h.q(first).idempotencyKey,h.q(second).idempotencyKey);assert.equal(h.job().cancellationSheetWrite.queueId,second);}finally{Timestamp.now=previous;}});
await test("repeated identical cancellation does not create another intent",async()=>{const h=cancellationHarness(),first=await h.cancel("same"),second=await h.cancel("same");assert.equal(second,first);assert.equal(h.job().cancellationSheetWrite.queueId,first);});
async function printedHarness(){
 const h=harness();h.job().netPrint={items:[{id:"printed-item",position:1,number:"12345678",version:1,printed:false}]};
 Object.assign(h.mapping().columns,{netPrint1:"Z",netPrint2:"AA",netPrint3:"AB"});
 h.mapping().operations["netprint.printed"]={values:[],styles:["netPrint1","netPrint2","netPrint3"]};
 h.mapping().operations["netprint.update"]={values:["netPrint1","netPrint2","netPrint3"],styles:["netPrint1","netPrint2","netPrint3"]};
 h.cells.set("Z2","12345678");
 await h.call("./netprint","markNetPrintPrinted",{jobId,itemId:"printed-item"},{uid:"synthetic-user",token:{companyId,role:"staff",staffId}});
 h.printedId=[...h.records].find(([path,q])=>path.startsWith("sheetSyncQueue/")&&q.operation==="netprint.printed")[0].split("/").at(-1);
 h.printedQueue=()=>h.records.get(`sheetSyncQueue/${h.printedId}`);
 return h;
}
await test("actual printed handler styles current number",async()=>{const h=await printedHarness();assert.equal(h.job().netPrint.items[0].printed,true);await h.runQueue(h.printedId);assert.equal(h.printedQueue().status,"completed");assert.equal(h.writes.length,1);assert.ok(h.writes[0].requestBody.requests);});
for(const [name,change]of [
 ["new number",h=>h.cells.set("Z2","99999999")],["removed number",h=>h.cells.delete("Z2")],
 ["missing expected",h=>delete h.printedQueue().expected],["unrestricted expected",h=>h.printedQueue().expected.netPrint1={mode:"any"}],
])await test("printed style rejects "+name,async()=>{const h=await printedHarness();change(h);await h.runQueue(h.printedId);assert.equal(h.writes.length,0);assert.equal(h.printedQueue().status,"blocked");});
await test("printed style rechecks number immediately before mutation",async()=>{const h=await printedHarness();let changed=false;h.afterCellRead=()=>{if(!changed){changed=true;h.cells.set("Z2","99999999");}};await h.runQueue(h.printedId);assert.equal(h.writes.length,0);assert.equal(h.printedQueue().status,"blocked");});
for(const [name,change]of [["number changed",h=>h.cells.set("Z2","99999999")],["verification unavailable",h=>h.failRead=true]])await test("printed style "+name+" after mutation requires review",async()=>{const h=await printedHarness();h.onStyleWrite=()=>change(h);await h.runQueue(h.printedId);assert.equal(h.writes.length,1);assert.equal(h.printedQueue().errorType,"verification_required");});
await test("printed style lost response never retries automatically",async()=>{const h=await printedHarness();h.failAfterStyle=true;await h.runQueue(h.printedId);assert.equal(h.printedQueue().errorType,"verification_required");await h.retry();assert.equal(h.printedQueue().status,"blocked");assert.equal(h.writes.length,1);});
await test("already applied number update can apply its matching styles",async()=>{const h=await printedHarness();await h.call("./netprint","updateNetPrintNumbers",{jobId,numbers:["87654321"]});const id=[...h.records].filter(([path,q])=>path.startsWith("sheetSyncQueue/")&&q.operation==="netprint.update").at(-1)[0].split("/").at(-1);h.cells.set("Z2","87654321");await h.runQueue(id);assert.equal(h.records.get(`sheetSyncQueue/${id}`).status,"completed");assert.equal(h.writes.length,1);assert.ok(h.writes[0].requestBody.requests);});
await test("printed style rechecks assignment after final cell read",async()=>{const h=await printedHarness();let read=0;h.afterCellRead=()=>{if(++read===2)h.job().assignedStaffId="new-person";};await h.runQueue(h.printedId);assert.equal(h.writes.length,0);assert.equal(h.printedQueue().status,"blocked");});
await test("style-only blank expectation accepts an empty target",async()=>{const h=await printedHarness();h.mapping().operations["synthetic.style"]=h.mapping().operations["netprint.printed"];h.printedQueue().operation="synthetic.style";h.cells.set("Z2","");h.printedQueue().expected.netPrint1={mode:"blank"};await h.runQueue(h.printedId);assert.equal(h.printedQueue().status,"completed");});
await test("style-only blank expectation rejects zero",async()=>{const h=await printedHarness();h.mapping().operations["synthetic.style"]=h.mapping().operations["netprint.printed"];h.printedQueue().operation="synthetic.style";h.cells.set("Z2",0);h.printedQueue().expected.netPrint1={mode:"blank"};await h.runQueue(h.printedId);assert.equal(h.printedQueue().status,"blocked");assert.equal(h.writes.length,0);});
await test("mixed already applied values still verify separate style target",async()=>{const h=harness();generic(h);Object.assign(h.mapping().columns,{netPrint1:"Z"});h.mapping().operations["synthetic.generic"].styles.push("netPrint1");h.queue().styles={netPrint1:{background:"#ffeedd"}};h.queue().expected.netPrint1={mode:"exact",value:"12345678"};h.cells.set("Z2","12345678");h.cells.set("R2",120);await h.run();assert.equal(h.queue().status,"completed");assert.equal(h.writes.length,1);assert.ok(h.writes[0].requestBody.requests);});
for(const [name,change]of [
 ["staff",h=>h.job().assignedStaffId="new-person"],["day",h=>h.job().dateKey="2099-09-21"],
 ["cancelled",h=>h.job().cancelled=true],["source missing",h=>h.job().sourceMissing=true],
 ["unconfirmed",h=>h.job().applicationUnconfirmed=true],["tab",h=>h.job().sheetRef.sheetId=9],
 ["item number",h=>h.job().netPrint.items[0].number="87654321"],
 ["item proof",h=>delete h.job().netPrint.items[0].printOperationId],
 ["duplicate target",h=>h.job().netPrint.items.push({...h.job().netPrint.items[0]})],
])await test("printed intent blocks changed "+name,async()=>{const h=await printedHarness();change(h);await h.runQueue(h.printedId);assert.equal(h.printedQueue().status,"blocked");assert.equal(h.writes.length,0);});
async function numberUpdate(h,numbers){await h.call("./netprint","updateNetPrintNumbers",{jobId,numbers});return [...h.records].filter(([path,q])=>path.startsWith("sheetSyncQueue/")&&q.operation==="netprint.update").at(-1)[0].split("/").at(-1);}
await test("latest number update supersedes old pending update",async()=>{const h=await printedHarness();const old=await numberUpdate(h,["87654321"]),next=await numberUpdate(h,["ABCDEFGH"]);await h.runQueue(old);assert.equal(h.writes.length,0);assert.equal(h.records.get(`sheetSyncQueue/${old}`).status,"blocked");await h.runQueue(next);assert.equal(h.records.get(`sheetSyncQueue/${next}`).status,"completed");assert.equal(h.cells.get("Z2"),"ABCDEFGH");});
for(const [name,change]of [
 ["staff",h=>h.job().assignedStaffId="new-person"],["day",h=>h.job().dateKey="2099-09-21"],
 ["source missing",h=>h.job().sourceMissing=true],["proof",h=>delete h.job().netPrint.writeOperationId],
 ["current value",h=>h.job().netPrint.items[0].number="changed"],
])await test("number update blocks changed "+name,async()=>{const h=await printedHarness();const id=await numberUpdate(h,["87654321"]);change(h);await h.runQueue(id);assert.equal(h.writes.length,0);assert.equal(h.records.get(`sheetSyncQueue/${id}`).status,"blocked");});
await test("number update cannot erase later printed style",async()=>{const h=await printedHarness();const id=await numberUpdate(h,["87654321"]);await h.call("./netprint","markNetPrintPrinted",{jobId,itemId:h.job().netPrint.items[0].id},{uid:"synthetic-user",token:{companyId,role:"staff",staffId}});await h.runQueue(id);assert.equal(h.writes.length,0);assert.equal(h.records.get(`sheetSyncQueue/${id}`).status,"blocked");});
await test("same-number admin update retains current printed proof",async()=>{const h=await printedHarness();const oldProof=h.job().netPrint.items[0].printOperationId;assert.equal(oldProof,h.printedId);const id=await numberUpdate(h,["12345678"]);assert.equal(h.job().netPrint.items[0].printOperationId,oldProof);await h.runQueue(h.printedId);await h.runQueue(id);assert.equal(h.printedQueue().status,"completed");assert.equal(h.records.get(`sheetSyncQueue/${id}`).status,"completed");});
await test("old owner print flag is cleared by current number registration",async()=>{const h=await printedHarness();h.job().assignedStaffId="new-person";await numberUpdate(h,["12345678"]);assert.equal(h.job().netPrint.items[0].printed,false);assert.equal(h.job().netPrint.items[0].printOperationId,undefined);});
await test("same-millisecond ABA number replacement creates a new item identity",async()=>{const previous=Timestamp.now;Timestamp.now=()=>Timestamp.fromMillis(1789219000000);try{const h=await printedHarness();await numberUpdate(h,["87654321"]);const first=h.job().netPrint.items[0].id;await numberUpdate(h,["ABCDEFGH"]);await numberUpdate(h,["87654321"]);assert.notEqual(h.job().netPrint.items[0].id,first);}finally{Timestamp.now=previous;}});
await test("confirmed number update establishes next expected baseline",async()=>{const h=await printedHarness();const first=await numberUpdate(h,["87654321"]);await h.runQueue(first);assert.equal(h.job().netPrint.syncPending,false);const next=await numberUpdate(h,["ABCDEFGH"]);assert.equal(h.records.get(`sheetSyncQueue/${next}`).expected.netPrint1.value,"87654321");await h.runQueue(next);assert.equal(h.cells.get("Z2"),"ABCDEFGH");assert.equal(h.job().netPrint.syncPending,false);});
await test("latest registration recovers print and pending number conflict",async()=>{const h=await printedHarness();const old=await numberUpdate(h,["87654321"]);await h.call("./netprint","markNetPrintPrinted",{jobId,itemId:h.job().netPrint.items[0].id},{uid:"synthetic-user",token:{companyId,role:"staff",staffId}});await h.runQueue(old);assert.equal(h.writes.length,0);const latest=await numberUpdate(h,["87654321"]);assert.equal(h.records.get(`sheetSyncQueue/${latest}`).expected.netPrint1.value,"12345678");await h.runQueue(latest);assert.equal(h.records.get(`sheetSyncQueue/${latest}`).status,"completed");assert.equal(h.cells.get("Z2"),"87654321");assert.equal(h.job().netPrint.syncPending,false);assert.equal(h.records.get(`sheetSyncQueue/${latest}`).styles.netPrint1.background,"#fff2cc");});
await test("uncertain number write does not claim confirmed baseline",async()=>{const h=await printedHarness();const old=await numberUpdate(h,["87654321"]);h.failAfterWrite=true;await h.runQueue(old);assert.equal(h.job().netPrint.syncPending,true);h.failAfterWrite=false;const next=await numberUpdate(h,["ABCDEFGH"]);await h.runQueue(next);assert.equal(h.records.get(`sheetSyncQueue/${next}`).status,"blocked");assert.equal(h.writes.length,1);assert.equal(h.cells.get("Z2"),"87654321");});
await test("caller rejects changed supplied print date",async()=>{const h=await printedHarness();await assert.rejects(h.call("./netprint","markNetPrintPrinted",{jobId,itemId:"printed-item",dateKey:"2099-09-21"},{uid:"synthetic-user",token:{companyId,role:"staff",staffId}}),{code:"failed-precondition"});});
await test("cancelled number registration does not queue a staff notification",async()=>{const h=await printedHarness();h.job().cancelled=true;h.job().status="cancelled";await numberUpdate(h,["87654321"]);assert.equal([...h.records].filter(([path])=>path.startsWith("notificationQueue/")).length,0);});
await test("number registration repairs duplicate item IDs",async()=>{const h=await printedHarness();h.job().netPrint.items.push({...h.job().netPrint.items[0],position:2,number:"ABCDEFGH"});const id=await numberUpdate(h,["12345678","ABCDEFGH"]);assert.equal(new Set(h.job().netPrint.items.map(item=>item.id)).size,2);assert.ok(h.job().netPrint.items.every(item=>item.printed===false));h.cells.set("AA2","ABCDEFGH");await h.runQueue(id);assert.equal(h.records.get(`sheetSyncQueue/${id}`).status,"completed");});
await test("number registration repairs invalid prior version",async()=>{const h=await printedHarness();h.job().netPrint.items[0].version="invalid";await numberUpdate(h,["87654321"]);assert.equal(h.job().netPrint.items[0].version,1);});
await test("number version cannot exceed safe integer",async()=>{const h=await printedHarness();h.job().netPrint.items[0].version=Number.MAX_SAFE_INTEGER;await assert.rejects(numberUpdate(h,["87654321"]),{code:"failed-precondition"});});
await test("same number with invalid printed timestamp requires reconfirmation",async()=>{const h=await printedHarness();h.job().netPrint.items[0].printedAt="invalid";await numberUpdate(h,["12345678"]);assert.equal(h.job().netPrint.items[0].printed,false);});
await test("pending baseline cannot transfer to another owner",async()=>{const h=await printedHarness();await numberUpdate(h,["87654321"]);h.job().assignedStaffId="new-person";await assert.rejects(numberUpdate(h,["ABCDEFGH"]),{code:"failed-precondition"});assert.equal(h.writes.length,0);});
await test("number clear replaces current values and rejects old print",async()=>{const h=await printedHarness();const id=await numberUpdate(h,[]);await h.runQueue(h.printedId);assert.equal(h.writes.length,0);await h.runQueue(id);assert.equal(h.records.get(`sheetSyncQueue/${id}`).status,"completed");assert.equal(h.cells.get("Z2"),"");assert.equal(h.job().netPrint.syncPending,false);});
await test("number update rechecks a newer registration during read",async()=>{const h=await printedHarness();const old=await numberUpdate(h,["87654321"]);let changed=false;h.afterCellRead=async()=>{if(!changed){changed=true;await numberUpdate(h,["ABCDEFGH"]);}};await h.runQueue(old);assert.equal(h.writes.length,0);assert.equal(h.records.get(`sheetSyncQueue/${old}`).status,"blocked");});
await test("number update after mutation preserves newer pending proof",async()=>{const h=await printedHarness();const old=await numberUpdate(h,["87654321"]);let next;h.onWrite=async()=>{next=await numberUpdate(h,["ABCDEFGH"]);};await h.runQueue(old);assert.equal(h.records.get(`sheetSyncQueue/${old}`).errorType,"verification_required");assert.equal(h.job().netPrint.writeOperationId,next);assert.equal(h.job().netPrint.syncPending,true);});
await test("reconfirmed printed item clears completed ownership review",async()=>{const h=await printedHarness();h.job().netPrint.needsPrintReview=true;h.job().netPrint.items[0].printed=false;const previous=h.job().netPrint.items[0].printOperationId;await h.call("./netprint","markNetPrintPrinted",{jobId,itemId:"printed-item",dateKey},{uid:"synthetic-user",token:{companyId,role:"staff",staffId}});assert.equal(h.job().netPrint.needsPrintReview,false);assert.notEqual(h.job().netPrint.items[0].printOperationId,previous);});
await test("partial print reconfirmation retains ownership review",async()=>{const h=await printedHarness();h.job().netPrint.needsPrintReview=true;h.job().netPrint.items[0].printed=false;h.job().netPrint.items.push({id:"next-print",number:"ABCDEFGH",position:2,printed:false});await h.call("./netprint","markNetPrintPrinted",{jobId,itemId:"printed-item",dateKey},{uid:"synthetic-user",token:{companyId,role:"staff",staffId}});assert.equal(h.job().netPrint.needsPrintReview,true);await h.call("./netprint","markNetPrintPrinted",{jobId,itemId:"next-print",dateKey},{uid:"synthetic-user",token:{companyId,role:"staff",staffId}});assert.equal(h.job().netPrint.needsPrintReview,false);});
await test("failed reconfirmation retains old pending review atomically",async()=>{const h=await printedHarness();h.job().netPrint.needsPrintReview=true;h.job().netPrint.items[0].printed=false;h.onCommit=writes=>{if(writes.some(write=>Object.hasOwn(write.data,"netPrint.items")))throw Error("synthetic print save failure");};await assert.rejects(h.call("./netprint","markNetPrintPrinted",{jobId,itemId:"printed-item",dateKey},{uid:"synthetic-user",token:{companyId,role:"staff",staffId}}));assert.equal(h.job().netPrint.needsPrintReview,true);assert.equal(h.job().netPrint.items[0].printed,false);});
async function assignmentHarness(profile={}){
 const h=harness();h.records.delete(`sheetSyncQueue/${queueId}`);Object.assign(h.job(),{status:'open',assignedStaffId:null,assignedStaffName:null,publishable:true,preContact:null});
 h.records.set(`staffProfiles/${staffId}`,{companyId,active:true,displayName:'Synthetic Staff',...profile});
 h.mapping().operations['job.assign']={values:['staffName']};h.cells.set('B2','');
 h.apply=(requestId='synthetic-request-0001')=>h.call('./jobs','applyToJob',{jobId,requestId},{uid:'synthetic-user',token:{companyId,role:'staff',staffId}});
 return h;
}
async function appliedHarness(){const h=await assignmentHarness();await h.apply();h.assignmentId=[...h.records].find(([path,value])=>path.startsWith('sheetSyncQueue/')&&value.operation==='job.assign')[0].split('/').at(-1);h.assignment=()=>h.records.get(`sheetSyncQueue/${h.assignmentId}`);h.assignmentLock=()=>h.records.get(`staffDayLocks/${companyId}_${staffId}_${dateKey}`);h.runAssignment=()=>h.runQueue(h.assignmentId);return h;}
await test('actual application writes blank staff cell once and preserves source confirmation pending',async()=>{const h=await appliedHarness();await h.runAssignment();assert.equal(h.assignment().status,'completed');assert.equal(h.cells.get('B2'),'Synthetic Staff');assert.equal(h.job().applicationUnconfirmed,true);assert.equal(h.writes.length,1);await h.runAssignment();assert.equal(h.writes.length,1);});
await test('application creates saved queue proof with displayed day',async()=>{const h=await appliedHarness();assert.equal(h.job().assignmentSheetWrite.queueId,h.assignmentId);assert.equal(h.assignment().dateKey,dateKey);assert.equal(h.assignment().idempotencyKey,`job.assign:${jobId}:${h.assignmentId}`);});
for(const [name,change]of [
 ['new owner',h=>h.job().assignedStaffId='new-person'],['new date',h=>h.job().dateKey='2099-09-21'],['new case',h=>h.job().caseId='different-case'],
 ['different tab',h=>h.job().sheetRef.sheetId=99],['cancelled',h=>{h.job().status='cancelled';h.job().cancelled=true;}],['source missing',h=>h.job().sourceMissing=true],
 ['unresolved source',h=>h.job().assignmentUnresolved=true],['new queue proof',h=>h.job().assignmentSheetWrite={queueId:'other',identity:'other'}],['legacy missing proof',h=>delete h.job().assignmentSheetWrite],
 ['wrong actor',h=>h.assignment().actorStaffId='other'],['wrong queue date',h=>h.assignment().dateKey='2099-09-21'],['modified update',h=>h.assignment().updates.staffName='Other'],
 ['unconditional expected',h=>h.assignment().expected={staffName:{mode:'any'}}],['disabled profile',h=>h.records.get(`staffProfiles/${staffId}`).active=false],
 ['foreign profile',h=>h.records.get(`staffProfiles/${staffId}`).companyId='foreign'],['renamed profile',h=>h.records.get(`staffProfiles/${staffId}`).displayName='Different Staff'],['missing profile',h=>h.records.delete(`staffProfiles/${staffId}`)],
 ['released lock',h=>h.assignmentLock().active=false],['new job lock',h=>h.assignmentLock().jobId='other-job'],['foreign lock',h=>h.assignmentLock().companyId='foreign'],['missing lock',h=>h.records.delete(`staffDayLocks/${companyId}_${staffId}_${dateKey}`)]
])await test('queued assignment rejects '+name+' before Sheets',async()=>{const h=await appliedHarness();change(h);await h.runAssignment();assert.equal(h.assignment().status,'blocked');assert.equal(h.writes.length,0);assert.equal(h.authCalls,0);});
for(const [name,change]of [['sheet date',h=>h.cells.set('A2','2099-09-21')],['row case',h=>h.cells.set('Q2','different-case')]])await test('assignment checks '+name+' even after ID lookup',async()=>{const h=await appliedHarness();change(h);await h.runAssignment();assert.equal(h.assignment().status,'blocked');assert.equal(h.writes.length,0);});
for(const [name,change]of [['profile disabled',h=>h.records.get(`staffProfiles/${staffId}`).active=false],['lock moved',h=>h.assignmentLock().jobId='other'],['new proof',h=>h.job().assignmentSheetWrite={queueId:'other',identity:'other'}]])await test('assignment rechecks '+name+' during sheet read',async()=>{const h=await appliedHarness();h.afterCellRead=()=>change(h);await h.runAssignment();assert.equal(h.assignment().status,'blocked');assert.equal(h.writes.length,0);});
await test('matching existing staff cell completes without another write',async()=>{const h=await appliedHarness();h.cells.set('B2','Synthetic Staff');await h.runAssignment();assert.equal(h.assignment().status,'completed');assert.equal(h.writes.length,0);});
await test('different existing staff cell is never overwritten',async()=>{const h=await appliedHarness();h.cells.set('B2','Other Staff');await h.runAssignment();assert.equal(h.assignment().status,'blocked');assert.equal(h.writes.length,0);});
await test('assignment lost write reply stays unknown without automatic repeat',async()=>{const h=await appliedHarness();h.failAfterWrite=true;await h.runAssignment();assert.equal(h.assignment().errorType,'verification_required');await h.retry();await h.runAssignment();assert.equal(h.writes.length,1);});
await test('assignment changed proof after write stays unknown',async()=>{const h=await appliedHarness();h.onWrite=()=>h.job().assignmentSheetWrite={queueId:'newer',identity:'newer'};await h.runAssignment();assert.equal(h.assignment().errorType,'verification_required');assert.equal(h.job().assignmentSheetWrite.queueId,'newer');});
await test('assignment completion retries against changed staff-day lock',async()=>{const h=await appliedHarness();let changed=false;h.onCommit=writes=>{if(!changed&&writes.some(write=>write.data.status==='completed')){changed=true;h.assignmentLock().jobId='other-job';}};await h.runAssignment();assert.equal(h.assignment().errorType,'verification_required');assert.equal(h.assignmentLock().jobId,'other-job');});
for(const displayName of ['', '   ', null, 123])await test('application refuses invalid staff name before saving '+displayName,async()=>{const h=await assignmentHarness({displayName});const before=JSON.stringify([...h.records]);await assert.rejects(h.apply(),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);});
for(const flag of ['sourceMissing','assignmentUnresolved'])await test('application refuses unverified source '+flag,async()=>{const h=await assignmentHarness();h.job()[flag]=true;const before=JSON.stringify([...h.records]);await assert.rejects(h.apply(),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);});
for(const mode of ['legacy','current'])await test('actual cancellation and restore do not revive queued assignment '+mode,async()=>{const h=await appliedHarness();if(mode==='legacy')await h.call('./jobs','adminCancelJob',{jobId,reason:'Synthetic cancellation'});else await h.call('./analytics','adminSetJobCancellation',{jobId,reasonCategory:'other',reasonNote:'Synthetic cancellation',financialTreatment:'neither'});assert.equal(h.job().assignmentSheetWrite,null);await h.call('./analytics','adminRestoreCancelledJob',{jobId});assert.equal(h.job().status,'assigned');assert.equal(h.assignmentLock().active,true);assert.equal(h.job().assignmentSheetWrite,null);await h.runAssignment();assert.equal(h.assignment().status,'blocked');assert.equal(h.writes.length,0);});
await test('accepted application replay creates no second queue or changed intent',async()=>{const h=await appliedHarness();const before=JSON.stringify([...h.records]);const reply=await h.apply();assert.equal(reply.ok,true);assert.equal(JSON.stringify([...h.records]),before);});
for(const flag of ['applicationUnconfirmed','publishable'])await test('application refuses pending or unpublished case '+flag,async()=>{const h=await assignmentHarness();h.job()[flag]=flag==='publishable'?false:true;const before=JSON.stringify([...h.records]);await assert.rejects(h.apply(),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);});
await test('staff cell changed on final prewrite verification is never overwritten',async()=>{const h=await appliedHarness();let count=0;h.beforeCellRead=input=>{if(input.ranges.some(range=>range.endsWith('Q2'))&&++count===2)h.cells.set('B2','Other Staff');};await h.runAssignment();assert.equal(h.assignment().status,'blocked');assert.equal(h.writes.length,0);assert.equal(h.cells.get('B2'),'Other Staff');});
await test('sheet date changed after assignment write is verification-required',async()=>{const h=await appliedHarness();h.onWrite=()=>h.cells.set('A2','2099-09-21');await h.runAssignment();assert.equal(h.assignment().errorType,'verification_required');assert.equal(h.writes.length,1);});
await test('assignment read failure retries only before any write',async()=>{const h=await appliedHarness();h.failRead=true;await h.runAssignment();assert.equal(h.assignment().status,'retry_wait');assert.equal(h.writes.length,0);h.failRead=false;h.assignment().status='pending';await h.runAssignment();assert.equal(h.assignment().status,'completed');assert.equal(h.writes.length,1);});
await test('profile revoked during application transaction prevents all acceptance writes',async()=>{const h=await assignmentHarness();let changed=false;h.onCommit=writes=>{if(!changed&&writes.some(write=>write.data.operation==='job.assign')){changed=true;h.records.get(`staffProfiles/${staffId}`).active=false;}};await assert.rejects(h.apply(),{code:'permission-denied'});assert.equal(h.job().status,'open');assert.equal([...h.records.keys()].some(path=>path.startsWith('sheetSyncQueue/')),false);assert.equal([...h.records.keys()].some(path=>path.startsWith('staffDayLocks/')),false);});
await test('assignment keeps staff name literal in Sheets',async()=>{const h=await assignmentHarness({displayName:'=SyntheticName'});await h.apply();const id=[...h.records].find(([path,value])=>path.startsWith('sheetSyncQueue/')&&value.operation==='job.assign')[0].split('/').at(-1);await h.runQueue(id);assert.equal(h.records.get(`sheetSyncQueue/${id}`).status,'completed');assert.equal(h.writes[0].requestBody.valueInputOption,'RAW');assert.equal(h.cells.get('B2'),'=SyntheticName');});
function editHarness(){
 const h=harness();Object.assign(h.job(),{revision:1,clientName:'Synthetic client',storeName:'Synthetic store',makerName:'Synthetic maker',menuName:'Synthetic menu',entryTime:'09:45',workTime:'10:00-18:00',subcontractorName:'',clientChargeInputs:{invoiceBase:1000},staffPaymentInputs:{staffBasePay:800}});
 h.records.set(`staffProfiles/${staffId}`,{companyId,active:true,displayName:'Synthetic Staff'});h.records.set(`staffDayLocks/${companyId}_${staffId}_${dateKey}`,{companyId,staffId,dateKey,jobId,active:true});
 Object.assign(h.mapping().columns,{clientName:'J',storeName:'K',makerName:'L',menuName:'M',entryTime:'N',workTime:'O',subcontractorName:'P',invoiceBase:'S',staffBasePay:'AB'});h.mapping().operations['job.admin_edit']={values:['clientName','storeName','makerName','menuName','entryTime','workTime','subcontractorName','staffName','invoiceBase','staffBasePay']};
 for(const key of h.mapping().operations['job.admin_edit'].values){const value=key==='staffName'?h.job().assignedStaffName:key==='invoiceBase'?1000:key==='staffBasePay'?800:h.job()[key];h.cells.set(h.mapping().columns[key]+'2',value);}
 h.capture=()=>{const row=Array(55).fill('');for(const [cell,value]of h.cells)if(cell.endsWith('2')){const column=cell.slice(0,-1);row[h.core('./sheet-write-core','columnToNumber',column)-1]=value;}h.records.set(`adminJobEditSources/${jobId}`,h.core('./admin-edit-state-core','captureEditSource',{...h.job(),jobId},row,h.mapping().columns,'BC'));};h.capture();
 h.edit=(fields,revision=h.job().revision)=>h.call('./job-management','adminEditJobInputs',{jobId,fields,revision});h.editQueues=()=>[...h.records].filter(([path,value])=>path.startsWith('sheetSyncQueue/')&&value.operation==='job.admin_edit').map(([path,value])=>({id:path.split('/').at(-1),...value}));h.latestEdit=()=>h.editQueues().at(-1);return h;
}
await test('actual admin edit uses canonical mapping and verified source expectations',async()=>{const h=editHarness();const result=await h.edit({storeName:'Updated store'});assert.equal(result.sheetWriteQueued,true);const q=h.latestEdit();assert.deepEqual(q.expected,{storeName:{mode:'exact',value:'Synthetic store'}});assert.equal(h.job().pendingSourceWrite,true);await h.runQueue(q.id);assert.equal(h.records.get(`sheetSyncQueue/${q.id}`).status,'completed');assert.equal(h.cells.get('K2'),'Updated store');assert.equal(h.job().pendingSourceWrite,false);assert.equal(h.records.get(`adminJobEditSources/${jobId}`).values.storeName,'Updated store');});
await test('successive different-field edits retain the first pending change',async()=>{const h=editHarness();await h.edit({storeName:'Updated store'});const old=h.latestEdit();await h.edit({workTime:'11:00-19:00'});const next=h.latestEdit();assert.deepEqual(next.updates,{storeName:'Updated store',workTime:'11:00-19:00'});await h.runQueue(old.id);assert.equal(h.records.get(`sheetSyncQueue/${old.id}`).status,'blocked');assert.equal(h.writes.length,0);await h.runQueue(next.id);assert.equal(h.records.get(`sheetSyncQueue/${next.id}`).status,'completed');assert.equal(h.cells.get('K2'),'Updated store');assert.equal(h.cells.get('O2'),'11:00-19:00');});
await test('successive same-field edits retain the physical source baseline',async()=>{const h=editHarness();await h.edit({storeName:'First'});const old=h.latestEdit();await h.edit({storeName:'Latest'});const next=h.latestEdit();assert.equal(next.expected.storeName.value,'Synthetic store');await h.runQueue(next.id);await h.runQueue(old.id);assert.equal(h.cells.get('K2'),'Latest');assert.equal(h.writes.length,1);});
await test('completed edit supplies verified baseline for the next one',async()=>{const h=editHarness();await h.edit({storeName:'First'});await h.runQueue(h.latestEdit().id);await h.edit({storeName:'Second'});const q=h.latestEdit();assert.equal(q.expected.storeName.value,'First');await h.runQueue(q.id);assert.equal(h.cells.get('K2'),'Second');});
await test('app-only address edit preserves queued source changes',async()=>{const h=editHarness();await h.edit({storeName:'Updated'});const q=h.latestEdit();await h.edit({storeAddress:'New address'});assert.equal(h.editQueues().length,1);await h.runQueue(q.id);assert.equal(h.records.get(`sheetSyncQueue/${q.id}`).status,'completed');assert.equal(h.job().storeAddress,'New address');});
await test('unknown previous write cannot start another source operation',async()=>{const h=editHarness();await h.edit({storeName:'First'});h.failAfterWrite=true;await h.runQueue(h.latestEdit().id);const before=JSON.stringify([...h.records]);await assert.rejects(h.edit({workTime:'11:00-19:00'}),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);});
for(const [name,change]of [['staff changed',h=>h.job().assignedStaffId='different'],['date changed',h=>h.job().dateKey='2099-09-21'],['new content',h=>h.job().storeName='Another'],['source changed',h=>h.cells.set('K2','External change')],['mapping changed',h=>h.mapping().columns.storeName='L']])await test('queued admin edit refuses '+name,async()=>{const h=editHarness();await h.edit({storeName:'Requested'});change(h);await h.runQueue(h.latestEdit().id);assert.equal(h.records.get(`sheetSyncQueue/${h.latestEdit().id}`).status,'blocked');assert.equal(h.writes.length,0);});
await test('missing source baseline cannot produce unconditional writes',async()=>{const h=editHarness();h.records.delete(`adminJobEditSources/${jobId}`);const before=JSON.stringify([...h.records]);await assert.rejects(h.edit({storeName:'Requested'}),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);});
await test('source baseline with wrong job identifier is rejected',async()=>{const h=editHarness();h.records.get(`adminJobEditSources/${jobId}`).jobId='other';await assert.rejects(h.edit({storeName:'Requested'}),{code:'failed-precondition'});assert.equal(h.editQueues().length,0);});
for(const revision of [-1,NaN,Number.MAX_SAFE_INTEGER,'2'])await test('malformed stored revision rejected '+revision,async()=>{const h=editHarness();h.job().revision=revision;await assert.rejects(h.edit({storeName:'Requested'},undefined));assert.equal(h.editQueues().length,0);});
await test('admin money changes use displayed currency comparison and preserve other inputs',async()=>{const h=editHarness();h.cells.set('S2','￥1,000');h.job().clientChargeInputs.invoiceOther=200;h.capture();await h.edit({clientChargeInputs:{invoiceBase:1250}});const q=h.latestEdit();assert.equal(q.expected.invoiceBase.value,'￥1,000');assert.equal(h.job().clientChargeInputs.invoiceOther,200);h.onWrite=()=>h.cells.set('S2','￥1,250');await h.runQueue(q.id);assert.equal(h.records.get(`sheetSyncQueue/${q.id}`).status,'completed');assert.equal(h.writes[0].requestBody.valueInputOption,'RAW');});
await test('admin clearing amount is distinct from zero',async()=>{const h=editHarness();await h.edit({clientChargeInputs:{invoiceBase:null}});await h.runQueue(h.latestEdit().id);assert.equal(h.cells.get('S2'),'');await h.edit({clientChargeInputs:{invoiceBase:0}});await h.runQueue(h.latestEdit().id);assert.equal(h.cells.get('S2'),0);});
await test('unchanged menu display does not erase source conditions',async()=>{const h=editHarness();h.cells.set('M2','Synthetic menu（要冷蔵）');h.capture();await h.edit({storeName:'Requested',menuName:'Synthetic menu'});assert.equal(Object.hasOwn(h.latestEdit().updates,'menuName'),false);await h.runQueue(h.latestEdit().id);assert.equal(h.cells.get('M2'),'Synthetic menu（要冷蔵）');});
await test('latest admin edit during read blocks previous update without partial fields',async()=>{const h=editHarness();await h.edit({storeName:'First'});const old=h.latestEdit();let changed=false;h.afterCellRead=async()=>{if(!changed){changed=true;await h.edit({workTime:'11:00-19:00'});}};await h.runQueue(old.id);assert.equal(h.writes.length,0);assert.equal(h.records.get(`sheetSyncQueue/${old.id}`).status,'blocked');assert.equal(h.latestEdit().updates.storeName,'First');});
await test('admin assignment writes original staff to the newly confirmed person',async()=>{const h=editHarness();h.records.set('staffProfiles/new-person',{companyId,active:true,displayName:'New Staff'});await h.edit({assignedStaffId:'new-person'});const q=h.latestEdit();assert.equal(q.expected.staffName.value,'Synthetic Staff');await h.runQueue(q.id);assert.equal(h.records.get(`sheetSyncQueue/${q.id}`).status,'completed');assert.equal(h.cells.get('B2'),'New Staff');});
await test('admin assignment revoked before worker starts is blocked',async()=>{const h=editHarness();h.records.set('staffProfiles/new-person',{companyId,active:true,displayName:'New Staff'});await h.edit({assignedStaffId:'new-person'});h.records.get('staffProfiles/new-person').active=false;await h.runQueue(h.latestEdit().id);assert.equal(h.writes.length,0);assert.equal(h.records.get(`sheetSyncQueue/${h.latestEdit().id}`).status,'blocked');});
await test('admin clearing staff verifies empty post-write cell',async()=>{const h=editHarness();await h.edit({assignedStaffId:null});await h.runQueue(h.latestEdit().id);assert.equal(h.records.get(`sheetSyncQueue/${h.latestEdit().id}`).status,'completed');assert.equal(h.cells.get('B2'),'');});
await test('unchanged full admin form creates no source queue',async()=>{const h=editHarness();await h.edit({storeName:'Synthetic store',menuName:'Synthetic menu',assignedStaffId:staffId,clientChargeInputs:{invoiceBase:'￥1,000'},staffPaymentInputs:{staffBasePay:800}});assert.equal(h.editQueues().length,0);});
await test('renaming cancelled client retains the source cancellation marker',async()=>{const h=editHarness();h.job().cancelled=true;h.job().status='cancelled';h.cells.set('J2','Synthetic client（キャンセル）');h.capture();await h.edit({clientName:'Renamed client'});assert.equal(h.latestEdit().updates.clientName,'Renamed client（キャンセル）');await h.runQueue(h.latestEdit().id);assert.equal(h.cells.get('J2'),'Renamed client（キャンセル）');assert.equal(h.records.get("sheetSyncQueue/"+h.latestEdit().id).status,'completed');});
await test('admin cannot assign a cancelled case',async()=>{const h=editHarness();h.job().cancelled=true;h.job().status='cancelled';h.records.set('staffProfiles/new-person',{companyId,active:true,displayName:'New Staff'});await assert.rejects(h.edit({assignedStaffId:'new-person'}),{code:'failed-precondition'});assert.equal(h.editQueues().length,0);});
for(const kind of ['missing','column','value','identity'])await test('source proof '+kind+' changed before execution blocks all writes',async()=>{const h=editHarness();await h.edit({storeName:'Requested'});const source=h.records.get("adminJobEditSources/"+jobId);if(kind==='missing')h.records.delete("adminJobEditSources/"+jobId);else if(kind==='column')source.columns.storeName='L';else if(kind==='value')source.values.storeName='External';else source.identity='other';await h.runQueue(h.latestEdit().id);assert.equal(h.writes.length,0);assert.equal(h.records.get("sheetSyncQueue/"+h.latestEdit().id).status,'blocked');});
await test('clearing staff cannot erase the source cancellation marker',async()=>{const h=editHarness();h.job().cancelled=true;h.job().status='cancelled';h.cells.set('B2','Synthetic Staff（キャンセル）');h.capture();await assert.rejects(h.edit({assignedStaffId:null}),{code:'failed-precondition'});assert.equal(h.editQueues().length,0);assert.equal(h.writes.length,0);});
for(const kind of ['cancel','legacyCancel','restore'])await test(kind+' clears application review and preserves audit',async()=>{const h=cancellationHarness();if(kind==='restore')await h.cancel();Object.assign(h.job(),{applicationAdminConfirmed:true,applicationAdminConfirmedBy:'old-admin',applicationAdminConfirmedAt:Timestamp.fromMillis(1),applicationAdminConfirmedRevision:3});h.records.set('auditLogs/old-review',{action:'application.confirm',jobId});await h[kind]();assert.equal(h.job().applicationAdminConfirmed,false);assert.equal(h.job().applicationAdminConfirmedBy,null);assert.equal(h.job().applicationAdminConfirmedAt,null);assert.equal(h.job().applicationAdminConfirmedRevision,null);assert.equal(h.records.has('auditLogs/old-review'),true);});
for(const [key,value]of [['workTime','11:00-19:00'],['storeName','Changed store'],['assignedStaffId','new-person']])await test('admin edit '+key+' clears application review',async()=>{const h=editHarness();h.records.set('staffProfiles/new-person',{companyId,active:true,displayName:'New Staff'});Object.assign(h.job(),{applicationAdminConfirmed:true,applicationAdminConfirmedBy:'old-admin'});await h.edit({[key]:value});assert.equal(h.job().applicationAdminConfirmed,false);assert.equal(h.job().applicationAdminConfirmedBy,null);});
await test('unchanged admin edit preserves application review',async()=>{const h=editHarness();Object.assign(h.job(),{applicationAdminConfirmed:true,applicationAdminConfirmedBy:'old-admin'});await h.edit({storeName:'Synthetic store'});assert.equal(h.job().applicationAdminConfirmed,true);});

await test('cancel restore cycle refuses stale displayed application review',async()=>{const h=cancellationHarness();await h.admin('confirmApplication',{jobId,expectedRevision:0});await h.cancel();assert.equal(h.job().revision,1);await h.restore();assert.equal(h.job().revision,2);await assert.rejects(h.admin('confirmApplication',{jobId,expectedRevision:0}),{code:'failed-precondition'});assert.equal(h.job().applicationAdminConfirmed,false);await h.admin('confirmApplication',{jobId,expectedRevision:2});assert.equal(h.job().applicationAdminConfirmedRevision,2);});
await test('base pay changes increment imported review revision',async()=>{const h=harness();const before={...h.job(),revision:3,basePay:10000};assert.equal(h.core('./admin-edit-state-core','importedEditRevision',before,{...before,basePay:11000}),4);assert.equal(h.core('./admin-edit-state-core','importedEditRevision',before,{...before,sheetRef:{...before.sheetRef,currentRow:9}}),3);});
for(const revision of [-1,'0',0.5,Number.MAX_SAFE_INTEGER])for(const action of ['cancel','legacyCancel','restore'])await test('invalid assignment revision '+revision+' prevents '+action,async()=>{const h=cancellationHarness();if(action==='restore')await h.cancel();h.job().revision=revision;const before=JSON.stringify([...h.records]);await assert.rejects(h[action](),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);});

function submissionHarness(){
 const h=harness();h.records.delete('sheetSyncQueue/'+queueId);
 Object.assign(h.mapping().columns,{reportSubmitted:'I',salesFloorSubmitted:'J'});
 Object.assign(h.mapping().operations,{'submission.report':{values:['reportSubmitted']},'submission.sales_floor':{values:['salesFloorSubmitted']}});
 h.cells.set('I2','');h.cells.set('J2','');h.job().revision=1;let receipt=0;
 h.client=async submitted=>{await h.call('./submission-status','setSalesFloorClientSubmitted',{jobId,submitted},{uid:'synthetic-user',token:{companyId,staffId,role:'staff'}});return h.job().submissionStatus.salesFloor.sheetWrite.operationId;};
 h.report=async(late=false)=>{const id='synthetic-report-'+(++receipt),completedAt=Timestamp.fromMillis(Date.parse(late?'2099-09-22T02:00:00Z':'2099-09-20T02:00:00Z'));
 h.records.set('submissions/'+id,{companyId,jobId,staffId,uid:'synthetic-user',type:'report',status:'completed',totalFiles:1,completedFiles:1,completedAt,deadlinePolicy:{ruleVersion:'synthetic-recorded-rule',calendarVersion:'synthetic-recorded-calendar',workDate:dateKey,dueAtMs:Date.parse('2099-09-21T02:00:00Z'),status:'known'}});
 await h.core('./submission-status','markSubmissionCompleted',{submissionId:id,jobId,type:'report',submittedAt:completedAt});return h.job().submissionStatus.report.sheetWrite.operationId;};
 h.queueById=id=>h.records.get('sheetSyncQueue/'+id);return h;
}
for(const kind of ['report','sales-floor'])await test('current submission sync verifies source row and completes '+kind,async()=>{const h=submissionHarness(),id=await(kind==='report'?h.report():h.client(true));await h.runQueue(id);assert.equal(h.queueById(id).status,'completed');assert.equal(h.cells.get(kind==='report'?'I2':'J2'),kind==='report'?'提出済':'直');assert.equal(h.job().submissionStatus[kind==='report'?'report':'salesFloor'].sheetWrite.pending,false);assert.equal(h.writes.length,1);await h.runQueue(id);assert.equal(h.writes.length,1);});
await test('late report sync retains recorded lateness',async()=>{const h=submissionHarness(),id=await h.report(true);await h.runQueue(id);assert.equal(h.cells.get('I2'),'遅延');assert.equal(h.queueById(id).status,'completed');});
await test('older direct-submission check never overwrites the latest unchecked value',async()=>{const h=submissionHarness(),old=await h.client(true),latest=await h.client(false);assert.notEqual(old,latest);assert.notEqual(h.queueById(old).idempotencyKey,h.queueById(latest).idempotencyKey);await h.runQueue(latest);await h.runQueue(old);assert.equal(h.cells.get('J2'),'');assert.equal(h.queueById(old).status,'blocked');assert.equal(h.queueById(latest).status,'completed');assert.equal(h.writes.length,0);});
await test('same-value recurrence still rejects the old operation',async()=>{const h=submissionHarness(),old=await h.client(true);await h.client(false);const current=await h.client(true);await h.runQueue(old);assert.equal(h.queueById(old).status,'blocked');assert.equal(h.writes.length,0);await h.runQueue(current);assert.equal(h.cells.get('J2'),'直');assert.equal(h.queueById(current).status,'completed');});
await test('report recovery replaces stale lateness operation',async()=>{const h=submissionHarness(),old=await h.report(true),current=await h.report(false);await h.runQueue(current);await h.runQueue(old);assert.equal(h.cells.get('I2'),'提出済');assert.equal(h.queueById(old).status,'blocked');assert.equal(h.writes.length,1);});
await test('direct removal preserves app-uploaded photos in source status',async()=>{const h=submissionHarness();h.job().submissionStatus={salesFloor:{lipKnotsSubmitted:true,completed:true}};const first=await h.client(true);await h.runQueue(first);assert.equal(h.cells.get('J2'),'直＋リップ');const second=await h.client(false);await h.runQueue(second);assert.equal(h.cells.get('J2'),'リップ');assert.equal(h.job().submissionStatus.salesFloor.completed,true);});
const submissionMutations=[
 ['staff',h=>h.job().assignedStaffId='other'],['date',h=>h.job().dateKey='2099-09-21'],['revision',h=>h.job().revision++],['case',h=>h.job().caseId='other'],['source',h=>h.job().sheetRef.sheetName='other'],
 ...['cancelled','sourceMissing','applicationUnconfirmed','assignmentUnresolved'].map(flag=>[flag,h=>h.job()[flag]=true]),
 ['state',h=>h.job().status='open'],['staff column F',h=>h.mapping().columns.staffName='F'],
 ['operation ID',(h,id,key)=>h.job().submissionStatus[key].sheetWrite.operationId='other'],['missing context',(h,id,key)=>delete h.job().submissionStatus[key].sheetWrite],
 ['queue value',(h,id)=>h.queueById(id).updates={reportSubmitted:'untrusted'}],['queue actor',(h,id)=>h.queueById(id).actorStaffId='other'],['queue date',(h,id)=>h.queueById(id).dateKey='2099-09-21'],
 ['queue idempotency',(h,id)=>h.queueById(id).idempotencyKey='old-timestamp-key'],['queue style',(h,id)=>h.queueById(id).styles={reportSubmitted:{background:'#ffffff'}}],
];
for(const kind of ['report','sales-floor'])for(const stage of ['before','source-read','after-write'])for(const [name,change]of submissionMutations)await test('submission sync '+kind+' '+stage+' '+name,async()=>{
 const h=submissionHarness(),key=kind==='report'?'report':'salesFloor',id=await(kind==='report'?h.report():h.client(true));let changed=false;
 const mutate=()=>{if(!changed){changed=true;change(h,id,key);}};
 if(stage==='before')mutate();else if(stage==='source-read')h.afterCellRead=mutate;else h.onWrite=mutate;
 await h.runQueue(id);assert.equal(h.queueById(id).status,'blocked');assert.equal(h.writes.length,stage==='after-write'?1:0);if(stage==='after-write')assert.equal(h.queueById(id).writeVerificationRequired,true);
});
for(const field of ['A2','B2','Q2'])await test('submission source row mismatch '+field,async()=>{const h=submissionHarness(),id=await h.report();h.cells.set(field,'other');await h.runQueue(id);assert.equal(h.queueById(id).status,'blocked');assert.equal(h.writes.length,0);});
await test('submission response loss remains held without automatic repeat',async()=>{const h=submissionHarness(),id=await h.client(true);h.failAfterWrite=true;await h.runQueue(id);assert.equal(h.queueById(id).writeVerificationRequired,true);const writes=h.writes.length;await assert.rejects(h.admin('retrySheetWriteIssue',{queueId:id}),{code:'failed-precondition'});await h.runQueue(id);assert.equal(h.writes.length,writes);});
await test('submission queued during source read invalidates the executing old request',async()=>{const h=submissionHarness(),old=await h.client(true);let next;h.afterCellRead=async()=>{h.afterCellRead=null;next=await h.client(false);};await h.runQueue(old);assert.equal(h.writes.length,0);assert.equal(h.queueById(old).status,'blocked');await h.runQueue(next);assert.equal(h.queueById(next).status,'completed');assert.equal(h.cells.get('J2'),'');});


for(const [name,change]of [
 ['amount',h=>h.job().expenses={transportation:990}],['day',h=>h.job().dateKey='2099-09-21'],['sheet',h=>h.job().sheetRef.sheetId=7],['missing source',h=>h.job().sourceMissing=true],['unresolved staff',h=>h.job().assignmentUnresolved=true],['review amount',h=>h.review().values.transportation=880],['review revision',h=>h.review().revision++],['queue amount',h=>h.expenseQueue(h.expenseId).updates.transportation=770],['expected condition',h=>h.expenseQueue(h.expenseId).expected.transportation={mode:'any'}],['missing proof',h=>delete h.review().writeContext],
])await test('expense finalizer delayed '+name,async()=>{
 const h=await expenseHarness();await h.runQueue(h.expenseId);assert.equal(h.expenseQueue(h.expenseId).status,'completed');change(h);const before=JSON.stringify(h.job());const writes=h.writes.length;await h.queueResult(h.expenseId);
 assert.equal(JSON.stringify(h.job()),before);assert.equal(h.review().status,'error');assert.match(h.review().sheetWriteError,/確認/);assert.equal(h.review().sheetWriteStatus,'completed');assert.equal(h.writes.length,writes);assert.equal(h.cells.get('R2'),120);
});
await test('expense finalizer completed replay preserves later imported amounts and timestamps',async()=>{
 const h=await expenseHarness();await h.runQueue(h.expenseId);await h.queueResult(h.expenseId);h.job().expenses.transportation=990;const before=JSON.stringify([...h.records]);await h.queueResult(h.expenseId);assert.equal(JSON.stringify([...h.records]),before);
});
await test('expense finalizer transaction preserves amount changed before commit',async()=>{
 const h=await expenseHarness();await h.runQueue(h.expenseId);let changed=false;
 h.onCommit=writes=>{if(!changed&&writes.some(w=>w.ref.path==='expenseReviews/'+jobId&&w.data.status==='completed')){changed=true;h.job().expenses={transportation:990};}};
 await h.queueResult(h.expenseId);assert.equal(changed,true);assert.equal(h.job().expenses.transportation,990);assert.equal(h.review().status,'error');assert.equal(h.writes.length,1);
});
for(const mode of ['unchanged','imported result','row moved'])await test('expense finalizer accepts current proof '+mode,async()=>{
 const h=await expenseHarness();await h.runQueue(h.expenseId);if(mode==='imported result')h.job().expenses={transportation:120};if(mode==='row moved')h.job().sheetRef.currentRow=17;await h.queueResult(h.expenseId);assert.equal(h.review().status,'completed');assert.equal(h.job().expenses.transportation,120);assert.equal(h.writes.length,1);
});


// 原本書込済み・確認保留から、管理者が最新の版を読んで再確認する往復。
async function heldExpenseHarness(){
 const h=await expenseHarness();await h.runQueue(h.expenseId);h.job().expenses={transportation:990};await h.queueResult(h.expenseId);
 assert.equal(h.review().status,'error');assert.equal(h.review().sheetWriteStatus,'completed');assert.equal(h.writes.length,1);
 h.readExpense=()=>h.admin('getExpenseReview',{jobId});
 h.reconfirm=(read,values)=>h.admin('completeExpenseReview',{jobId,values,expectedVersion:read.reviewVersion,confirmExistingValues:false,note:'原本と現在値を照合済み'});
 return h;
}
await test('expense recovery accepts already applied amount without rewriting source',async()=>{
 const h=await heldExpenseHarness(),old=JSON.stringify(h.expenseQueue(h.expenseId)),read=await h.readExpense();
 assert.equal(read.currentValues.transportation,990);assert.equal(read.draft.values.transportation,120);assert.equal(read.draft.status,'error');
 const next=await h.reconfirm(read,{transportation:120});assert.notEqual(next.queueId,h.expenseId);assert.equal(h.review().revision,2);assert.equal(h.review().status,'queued');
 const waiting=JSON.stringify([...h.records]);await h.queueResult(h.expenseId);assert.equal(JSON.stringify([...h.records]),waiting);
 await h.runQueue(next.queueId);await h.queueResult(next.queueId);assert.equal(h.writes.length,1);assert.equal(h.review().status,'completed');assert.equal(h.job().expenses.transportation,120);assert.equal(h.review().sheetWriteError,null);
 assert.equal(JSON.stringify(h.expenseQueue(h.expenseId)),old);const done=JSON.stringify([...h.records]);await h.queueResult(h.expenseId);await h.queueResult(next.queueId);assert.equal(JSON.stringify([...h.records]),done);
 const final=await h.readExpense();assert.equal(final.draft.status,'completed');assert.equal(final.currentValues.transportation,120);assert.notEqual(final.reviewVersion,read.reviewVersion);
});
await test('expense recovery corrects amount after source values are imported and reviewed',async()=>{
 const h=await heldExpenseHarness();h.job().expenses={transportation:120};const read=await h.readExpense(),next=await h.reconfirm(read,{transportation:250});
 assert.equal(h.expenseQueue(next.queueId).expected.transportation.value,120);await h.runQueue(next.queueId);await h.queueResult(next.queueId);
 assert.equal(h.writes.length,2);assert.equal(h.cells.get('R2'),250);assert.equal(h.job().expenses.transportation,250);assert.equal(h.review().status,'completed');assert.equal(h.expenseQueue(h.expenseId).status,'completed');
});
await test('expense recovery does not reopen completed source queue',async()=>{
 const h=await heldExpenseHarness(),before=JSON.stringify([...h.records]);await assert.rejects(h.admin('retrySheetWriteIssue',{queueId:h.expenseId}),{code:'failed-precondition'});
 assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.writes.length,1);
});
for(const [name,change]of [['amount',h=>h.job().expenses.transportation=880],['other administrator',h=>h.review().note='別管理者が更新'],['day',h=>h.job().dateKey='2099-09-21']])await test('expense recovery refuses stale displayed '+name,async()=>{
 const h=await heldExpenseHarness(),read=await h.readExpense();change(h);const before=JSON.stringify([...h.records]);await assert.rejects(h.reconfirm(read,{transportation:120}),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.writes.length,1);
});
await test('expense recovery detects change before reconfirmation transaction commits',async()=>{
 const h=await heldExpenseHarness(),read=await h.readExpense();let changed=false;
 h.onCommit=writes=>{if(!changed&&writes.some(w=>w.data.operation==='expense.review')){changed=true;h.job().expenses.transportation=880;}};
 await assert.rejects(h.reconfirm(read,{transportation:120}),{code:'failed-precondition'});assert.equal(changed,true);assert.equal(h.review().status,'error');assert.equal(h.review().revision,1);assert.equal(h.job().expenses.transportation,880);assert.equal([...h.records.values()].filter(q=>q.operation==='expense.review').length,1);assert.equal(h.writes.length,1);
});
await test('expense recovery refuses source mismatch and recovers after current source import',async()=>{
 const h=await heldExpenseHarness();let read=await h.readExpense(),next=await h.reconfirm(read,{transportation:250});await h.runQueue(next.queueId);await h.queueResult(next.queueId);
 assert.equal(h.review().status,'error');assert.equal(h.expenseQueue(next.queueId).status,'blocked');assert.equal(h.writes.length,1);assert.equal(h.cells.get('R2'),120);assert.equal(h.job().expenses.transportation,990);
 h.job().expenses={transportation:120};read=await h.readExpense();next=await h.reconfirm(read,{transportation:250});await h.runQueue(next.queueId);await h.queueResult(next.queueId);
 assert.equal(h.review().status,'completed');assert.equal(h.cells.get('R2'),250);assert.equal(h.writes.length,2);
});
await test('expense recovery saves draft then requires its new displayed version',async()=>{
 const h=await heldExpenseHarness();h.job().expenses={transportation:120};const read=await h.readExpense();
 await h.admin('saveExpenseReviewDraft',{jobId,expectedVersion:read.reviewVersion,values:{transportation:260},note:'再照合メモ'});
 const before=JSON.stringify([...h.records]);await h.queueResult(h.expenseId);assert.equal(JSON.stringify([...h.records]),before);await assert.rejects(h.reconfirm(read,{transportation:260}),{code:'failed-precondition'});
 const fresh=await h.readExpense();assert.equal(fresh.draft.status,'draft');assert.equal(fresh.draft.note,'再照合メモ');const next=await h.reconfirm(fresh,fresh.draft.values);await h.runQueue(next.queueId);await h.queueResult(next.queueId);assert.equal(h.review().status,'completed');assert.equal(h.cells.get('R2'),260);
});
function expenseScreen(h){
 const app=fs.readFileSync(new URL('../apps/admin/src/App.tsx',import.meta.url),'utf8'),start=app.indexOf('  async function loadExpenseReview('),end=app.indexOf('  async function openJobSheet(',start);assert.ok(start>=0&&end>start);
 const blankExpense={transportation:'',purchase8:'',purchase10:'',netPrintCost:'',postageCost:''},user={uid:'synthetic-admin'},calls=[];
 const ctx={blankExpense,expenseValues:{...blankExpense},expenseNote:'',expenseJobId:'',expenseStatus:'未読込',expenseReady:false,expenseBusy:false,expenseReadyRef:{current:null},expenseLoadRef:{current:null},expenseWriteRef:{current:null},expenseVersionRef:{current:0},firebaseConfigured:true,functions:{},auth:{currentUser:user},adminSessionReady:true,jobs:[],window:{confirm:()=>true},openWorkspace:()=>{},setExpenseFocusRequest:()=>{},setMessage:value=>ctx.message=value,loadSheetIssues:async()=>{},httpsCallable:(_functions,name)=>async data=>{calls.push({name,data:clone(data)});return {data:await h.admin(name,data)};}};
 for(const field of ['expenseValues','expenseNote','expenseJobId','expenseStatus','expenseReady','expenseBusy'])ctx['set'+field[0].toUpperCase()+field.slice(1)]=value=>ctx[field]=value;
 runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../apps/admin/src/expense-readiness.ts',import.meta.url),'utf8').replace('export function','function')+"\n"+app.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);return {ctx,calls};
}
await test('expense recovery actual admin screen reload reconfirm and completed read',async()=>{
 const h=await heldExpenseHarness(),{ctx,calls}=expenseScreen(h);await ctx.loadExpenseReview(jobId);assert.equal(ctx.expenseStatus,'error');assert.equal(ctx.expenseReady,true);assert.equal(ctx.expenseValues.transportation,'120');
 const version=ctx.expenseReadyRef.current.reviewVersion;await ctx.completeExpense();const sent=calls.find(call=>call.name==='completeExpenseReview');assert.equal(sent.data.expectedVersion,version);assert.equal(sent.data.confirmExistingValues,false);assert.equal(ctx.expenseStatus,'書込待ち');assert.equal(ctx.expenseReady,false);
 const next=h.review().queueId;await h.runQueue(next);await h.queueResult(next);await ctx.loadExpenseReview(jobId);assert.equal(ctx.expenseStatus,'completed');assert.equal(ctx.expenseValues.transportation,'120');assert.equal(h.writes.length,1);
});
await test('expense recovery actual admin screen stale result stays blocked until reload',async()=>{
 const h=await heldExpenseHarness(),{ctx,calls}=expenseScreen(h);await ctx.loadExpenseReview(jobId);h.review().note='別管理者のメモ';await ctx.completeExpense();assert.equal(ctx.expenseStatus,'結果を再確認してください');assert.equal(ctx.expenseReady,false);
 await ctx.completeExpense();assert.equal(calls.filter(call=>call.name==='completeExpenseReview').length,1);await ctx.loadExpenseReview(jobId);assert.equal(ctx.expenseStatus,'error');await ctx.completeExpense();assert.equal(calls.filter(call=>call.name==='completeExpenseReview').length,2);await h.runQueue(h.review().queueId);await h.queueResult(h.review().queueId);assert.equal(h.review().status,'completed');assert.equal(h.writes.length,1);
});

console.log(JSON.stringify({passed:results.filter(r=>r.passed).length,total:results.length,results,scope:"Actual worker and core with synthetic DB/Sheets; no network, real data or messages."},null,2));
if(results.some(r=>!r.passed))process.exitCode=1;
