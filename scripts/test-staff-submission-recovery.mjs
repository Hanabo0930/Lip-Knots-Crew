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
const queryScope={authLoadVersionRef:{current:0},pastShiftVersionRef:{current:0},pastShiftCursorRef:{current:null},pastShiftDateRef:{current:""},hasMorePastShifts:false,businessRefreshing:false,isPending:()=>false,run:async(key,fn)=>fn(),setPastShiftMessage:value=>{queryScope.message=value;},setHasMorePastShifts:value=>{queryScope.hasMorePastShifts=value;},setMyJobs:fn=>{queryScope.myJobs=fn(queryScope.myJobs);},db:{},staffId:'staff',companyId:'a',localDateKey:()=>{dateReads++;return today;},orderAssignedJobs:items=>orderAssignedJobs(items,today),
 collection:()=>null,where:(field,op,value)=>({field,op,value}),orderBy:(field,direction)=>({sort:field,direction}),startAfter:cursor=>({cursor}),limit:value=>({limit:value}),query:(_, ...filters)=>filters,
 getDocs:async filters=>{
  requests.push(filters);
  let selected=jobs.filter(job=>filters.filter(filter=>filter.field).every(({field,op,value})=>op==='=='?job[field]===value:op==='>='?job[field]>=value:job[field]<value));
  selected.sort((a,b)=>a.dateKey.localeCompare(b.dateKey)||a.id.localeCompare(b.id));
  const after=filters.find(filter=>filter.cursor)?.cursor;
  if(after)selected=selected.slice(selected.findIndex(job=>job.id===after.id)+1);
  selected=selected.slice(0,filters.find(filter=>filter.limit).limit);
  return {docs:selected.map(job=>({id:job.id,data:()=>job}))};
 },
};
runInNewContext(ts.transpileModule(app.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,queryScope);
const loaded=await queryScope.fetchMyJobs();
assert.deepEqual(Array.from(loaded.slice(0,2),job=>job.id),['today','tomorrow']);
assert.equal(loaded.length,52);
assert.equal(new Set(loaded.map(job=>job.id)).size,loaded.length);
assert.equal(requests.length,2);assert.equal(dateReads,1);
assert.ok(requests.every(filters=>filters.some(f=>f.field==='companyId'&&f.value==='a')&&filters.some(f=>f.field==='assignedStaffId'&&f.value==='staff')));
requests=[];
assert.equal((await queryScope.fetchMyJobs('','a')).length,0);assert.equal(requests.length,0);
queryScope.myJobs=loaded;
let pageCount=0;
while(queryScope.hasMorePastShifts){
 await queryScope.loadMorePastShifts();
 if(++pageCount>25)assert.fail('Pagination did not terminate');
}
assert.equal(pageCount,19);
assert.equal(queryScope.myJobs.length,1002);
assert.equal(new Set(queryScope.myJobs.map(job=>job.id)).size,1002,'Equal-date rows must not repeat or disappear across snapshot cursors');
assert.deepEqual(Array.from(queryScope.myJobs.slice(0,2),job=>job.id),['today','tomorrow']);
const readPage=queryScope.getDocs;
await queryScope.fetchMyJobs();
queryScope.myJobs=loaded;
const beforeCursor=queryScope.pastShiftCursorRef.current;
queryScope.getDocs=async()=>{throw new Error('offline');};
await queryScope.loadMorePastShifts();
assert.equal(queryScope.pastShiftCursorRef.current,beforeCursor);
assert.match(queryScope.message,/再試行/);
queryScope.getDocs=readPage;
await queryScope.loadMorePastShifts();
assert.equal(queryScope.myJobs.length,102,'Failed page must be retryable without skipping rows');
for(const change of ['auth','refresh']){
 const gate=deferred();
 queryScope.getDocs=()=>gate.promise;
 const before=queryScope.myJobs;
 const pending=queryScope.loadMorePastShifts();
 if(change==='auth')queryScope.authLoadVersionRef.current++;
 else queryScope.pastShiftVersionRef.current++;
 gate.resolve({docs:[]});await pending;
 assert.equal(queryScope.myJobs,before,'Stale page must not mutate the new session or refreshed list');
}
queryScope.getDocs=readPage;
// 読込中の連打を同期ロックで抑止する。
const gate=deferred();let calls=0,locked=false;
queryScope.isPending=()=>locked;
queryScope.run=async(key,fn)=>{locked=true;try{await fn();}finally{locked=false;}};
queryScope.getDocs=()=>{calls++;return gate.promise;};
const first=queryScope.loadMorePastShifts();await queryScope.loadMorePastShifts();
assert.equal(calls,1);gate.resolve({docs:[]});await first;
queryScope.isPending=()=>false;queryScope.run=async(key,fn)=>fn();
// 未読込のタスクを開くときも所属・状態を確認する。
queryScope.doc=(_,collection,id)=>({id});
for(const scenario of ['own','company','staff','cancelled','open','missing','auth']){
 const previous=queryScope.myJobs;
 queryScope.getDoc=async()=>{
  if(scenario==='auth')queryScope.authLoadVersionRef.current++;
  return {exists:()=>scenario!=='missing',id:'task-job',data:()=>({companyId:scenario==='company'?'b':'a',assignedStaffId:scenario==='staff'?'other':'staff',status:scenario==='open'?'open':'assigned',cancelled:scenario==='cancelled',dateKey:'2025-01-01'})};
 };
 const job=await queryScope.loadTaskJob('task-job');
 assert.equal(Boolean(job),scenario==='own');
 if(scenario!=='own')assert.equal(queryScope.myJobs,previous);
}
console.log('History paging passed: 1000 equal-date rows, 50-row pages, retry without skipping, auth/refresh isolation, double-click lock, and task ownership checks.');
queryScope.getDocs=async()=>{throw new Error('offline');};
await assert.rejects(queryScope.fetchMyJobs(),/offline/);
console.log('Future shifts passed: 1000 historical jobs do not hide today/tomorrow; independent caps, date boundary, ownership and error propagation.');

assert.match(app,/isPending\("task-job"\)\|\|isPending\("uploadSubmission"\)/);

// 転送が済んだ後は、端末の後片付け失敗でも完了確認を開始して再送用ファイルを残さない。
const receiptStart=app.indexOf('        const durable=markDraftSubmitted(draftKey);');
const receiptEnd=app.indexOf('      },{setMessage:value',receiptStart);
assert.ok(receiptStart>=0&&receiptEnd>receiptStart);
for(const scenario of ['success','cleanup-failure','receipt-unavailable','auth-changed']){
 const events=[];
 const state={draftKey:'owner/job',typeLabel:'報告書',jobId:'job',data:{submissionId:'sent-id'},currentType:'report',currentRequestId:'',skipNextDraftSaveRef:{current:false},
 markDraftSubmitted:()=>{events.push('receipt');return scenario!=='receipt-unavailable';},setFiles:files=>events.push(['files',files.length]),setSubmissionConfirmed:value=>events.push(['confirmed',value]),
 setDraftCleanup:value=>events.push(['cleanup',value]),showSubmissionMessage:()=>events.push('message'),pollSubmissionProcessing:(...args)=>events.push(['poll',...args]),
 clearDraft:async()=>{events.push('clear');if(scenario!=='success'&&scenario!=='auth-changed')throw new Error('disk');},isCurrentUpload:()=>scenario!=='auth-changed',
 };
 runInNewContext(ts.transpileModule(`async function finish(){${app.slice(receiptStart,receiptEnd)}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,state);
 await state.finish();
 assert.equal(state.skipNextDraftSaveRef.current,true);
 assert.ok(events.some(event=>Array.isArray(event)&&event[0]==='files'&&event[1]===0));
 assert.ok(events.some(event=>Array.isArray(event)&&event[0]==='confirmed'&&event[1]===false));
 assert.ok(events.some(event=>Array.isArray(event)&&event[0]==='poll'&&event[2]==='sent-id'));
 assert.equal(events.filter(event=>Array.isArray(event)&&event[0]==='cleanup'&&event[1]===null).length,scenario==='success'?1:0);
}
console.log('Post-transfer cleanup passed: completion polling continues after local failure; files/confirmation cleared and old auth cannot dismiss recovery.');

// 実選択ハンドラーで、再提出の無効な選び直しと通常追加の無変更を検査する。
const selectionStart=app.indexOf('  function addSubmissionFiles(');
const selectionEnd=app.indexOf('  async function clearSubmissionFiles(',selectionStart);
assert.ok(selectionStart>=0&&selectionEnd>selectionStart);
const selectionCode=ts.transpileModule(app.slice(selectionStart,selectionEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const photo=(name,size=100,type='image/png')=>({name,size,type,lastModified:1});
const original=photo('original.png'), replacement=photo('replacement.png');
function selectFiles(selected,{requestId='request',files=[original],locked=false}={}){
 const state={files,confirmed:true,uploadState:{original:'ready'},message:'existing',writes:0};
 const context={files,requestId,MAX_SUBMISSION_FILES:20,MAX_SUBMISSION_FILE_SIZE:50*1024*1024,
  isSubmissionActionPending:()=>locked,fileStateKey:file=>`${file.name}_${file.lastModified}_${file.size}`,
  setFiles:value=>{state.files=value;state.writes++;},setUploadState:value=>{state.uploadState=value;},
  setSubmissionConfirmed:value=>{state.confirmed=value;},setSubmissionMessage:value=>{state.message=value;}};
 runInNewContext(selectionCode,context);context.addSubmissionFiles(selected);return state;
}
for(const selected of [[],[photo('bad.txt',1,'text/plain')],[photo('large.png',50*1024*1024+1)]]){
 const result=selectFiles(selected);
 assert.equal(result.files[0],original);assert.equal(result.writes,0);assert.equal(result.confirmed,true);
 assert.equal(result.uploadState.original,'ready');
 if(!selected.length)assert.equal(result.message,'existing');else assert.match(result.message,/選択できません/);
}
for(const options of [{requestId:'',files:[original]},{requestId:'request',files:[original]}]){
 const result=selectFiles([original],options);assert.equal(result.writes,0);assert.equal(result.confirmed,true);
}
const full=Array.from({length:20},(_,i)=>photo(`file-${i}.png`));
assert.equal(selectFiles([replacement],{requestId:'',files:full}).writes,0);
const replaced=selectFiles([replacement]);assert.equal(replaced.files.length,1);assert.equal(replaced.files[0],replacement);assert.equal(replaced.confirmed,false);
const mixed=selectFiles([photo('bad.txt',1,'text/plain'),replacement]);assert.equal(mixed.files[0],replacement);assert.match(mixed.message,/選択できません/);
const appended=selectFiles([replacement,replacement],{requestId:''});assert.equal(appended.files.length,2);assert.equal(appended.confirmed,false);
assert.equal(selectFiles([replacement],{locked:true}).writes,0);
assert.equal(selectFiles([photo('boundary.pdf',50*1024*1024,'application/pdf')]).files[0].size,50*1024*1024);
console.log('File selection recovery passed: cancel, invalid replacement, size boundary, duplicate, full list, valid replacement, mixed input, append, and action lock.');
