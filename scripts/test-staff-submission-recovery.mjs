import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
function moduleFrom(path) {
  const scope={exports:{}};
  runInNewContext(ts.transpileModule(readFileSync(path,"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,scope);
  return scope.exports;
}
const {runWithConcurrency}=moduleFrom("apps/staff/src/concurrency.ts");
const {submissionDraftKey}=moduleFrom("apps/staff/src/submission-draft-key.ts");
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const gates=Array.from({length:6},deferred);
const started=[];
let finished=false;
const offline=new Error("offline");
const pending=runWithConcurrency([0,1,2,3,4,5],3,async item=>{started.push(item);await gates[item].promise;});
const outcome=pending.then(()=>{finished=true;},error=>{finished=true;return error;});
assert.deepEqual(started,[0,1,2]);
gates[0].reject(offline);
await Promise.resolve();await Promise.resolve();
assert.equal(finished,false,"Active transfers must settle before the action unlocks.");
gates[1].resolve();gates[2].resolve();
assert.equal(await outcome,offline);
assert.deepEqual(started,[0,1,2],"No queued files may start after a failure.");
let active=0,max=0;
const retried=[];
await runWithConcurrency([0,1,2,3,4,5],3,async item=>{active++;max=Math.max(max,active);await Promise.resolve();retried.push(item);active--;});
assert.equal(max,3);assert.equal(retried.length,6);
const syncStarted=[];
await assert.rejects(runWithConcurrency([0,1,2],3,item=>{syncStarted.push(item);throw offline;}),error=>error===offline);
assert.deepEqual(syncStarted,[0]);
await runWithConcurrency([],3,()=>assert.fail("Empty queue must do no work."));
const ownerA=JSON.stringify(["company-a","user-a"]);
const key=submissionDraftKey(ownerA,"job","report");
assert.notEqual(key,submissionDraftKey(JSON.stringify(["company-a","user-b"]),"job","report"));
assert.notEqual(key,submissionDraftKey(JSON.stringify(["company-b","user-a"]),"job","report"));
assert.notEqual(key,submissionDraftKey(ownerA,"job","sales_floor"));
assert.notEqual(key,submissionDraftKey(ownerA,"job","report","request"));
assert.notEqual(submissionDraftKey(ownerA,"a_b","c"),submissionDraftKey(ownerA,"a","b_c"));
assert.equal(submissionDraftKey("","job","report"),"");
assert.equal(submissionDraftKey(ownerA,"","report"),"");
const app=readFileSync("apps/staff/src/App.tsx","utf8");
assert.match(app,/const draftKey=selectedAssignedJob\?submissionDraftKey\(draftOwner,selectedAssignedJob.id,submissionType,requestId\)/u);
assert.match(app,/const nextDraftKey=submissionDraftKey\(draftOwner,job.id,type,req\)/u);
console.log("Submission recovery passed: stop queued transfers, await active transfers, successful retry, concurrency limit, synchronous failure, empty queue, and draft owner/context isolation.");

// 実fetchMyJobsを合成データに対するクエリで実行し、過去件数と将来取得を分離する。
const from=app.indexOf('  async function fetchMyJobs('),to=app.indexOf('  async function fetchTasks(',from);
assert.ok(from>=0&&to>from);
const {orderAssignedJobs}=moduleFrom('apps/staff/src/job-list.ts');
const today='2026-09-05';
const jobs=[
 ...Array.from({length:1000},(_,index)=>({id:`past-${index}`,dateKey:'2025-01-01',status:'assigned',companyId:'a',assignedStaffId:'staff'})),
 {id:'today',dateKey:today,status:'assigned',companyId:'a',assignedStaffId:'staff'},
 {id:'tomorrow',dateKey:'2026-09-06',status:'assigned',companyId:'a',assignedStaffId:'staff'},
 {id:'other-company',dateKey:today,status:'assigned',companyId:'b',assignedStaffId:'staff'},
 {id:'other-staff',dateKey:today,status:'assigned',companyId:'a',assignedStaffId:'other'},
];
let requests=[],dateReads=0;
const queryScope={db:{},staffId:'staff',companyId:'a',localDateKey:()=>{dateReads++;return today;},orderAssignedJobs:items=>orderAssignedJobs(items,today),
 collection:()=>null,where:(field,op,value)=>({field,op,value}),orderBy:(field,direction)=>({sort:field,direction}),limit:value=>({limit:value}),query:(_, ...filters)=>filters,
 getDocs:async filters=>{
  requests.push(filters);
  let selected=jobs.filter(job=>filters.filter(filter=>filter.field).every(({field,op,value})=>op==='=='?job[field]===value:op==='>='?job[field]>=value:job[field]<value));
  selected.sort((a,b)=>a.dateKey.localeCompare(b.dateKey)||a.id.localeCompare(b.id));
  selected=selected.slice(0,filters.find(filter=>filter.limit).limit);
  return {docs:selected.map(job=>({id:job.id,data:()=>job}))};
 },
};
runInNewContext(ts.transpileModule(app.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,queryScope);
const loaded=await queryScope.fetchMyJobs();
assert.deepEqual(Array.from(loaded.slice(0,2),job=>job.id),['today','tomorrow']);
assert.equal(loaded.length,302);
assert.equal(new Set(loaded.map(job=>job.id)).size,loaded.length);
assert.equal(requests.length,2);assert.equal(dateReads,1);
assert.ok(requests.every(filters=>filters.some(f=>f.field==='companyId'&&f.value==='a')&&filters.some(f=>f.field==='assignedStaffId'&&f.value==='staff')));
requests=[];
assert.equal((await queryScope.fetchMyJobs('','a')).length,0);assert.equal(requests.length,0);
queryScope.getDocs=async()=>{throw new Error('offline');};
await assert.rejects(queryScope.fetchMyJobs(),/offline/);
console.log('Future shifts passed: 1000 historical jobs do not hide today/tomorrow; independent caps, date boundary, ownership and error propagation.');
