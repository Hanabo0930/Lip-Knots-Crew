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
const queryScope={upcomingShiftCursorRef:{current:null},hasMoreUpcomingShifts:false,setHasMoreUpcomingShifts:value=>{queryScope.hasMoreUpcomingShifts=value;},setUpcomingShiftMessage:value=>{queryScope.upcomingMessage=value;},authLoadVersionRef:{current:0},tasksReadVersionRef:{current:0},pastShiftVersionRef:{current:0},pastShiftCursorRef:{current:null},pastShiftDateRef:{current:""},hasMorePastShifts:false,businessRefreshing:false,isPending:()=>false,run:async(key,fn)=>fn(),setPastShiftMessage:value=>{queryScope.message=value;},setHasMorePastShifts:value=>{queryScope.hasMorePastShifts=value;},setMyJobs:fn=>{queryScope.myJobs=fn(queryScope.myJobs);},db:{},staffId:'staff',companyId:'a',localDateKey:()=>{dateReads++;return today;},orderAssignedJobs:items=>orderAssignedJobs(items,today),
 collection:()=>null,where:(field,op,value)=>({field,op,value}),orderBy:(field,direction)=>({sort:field,direction}),startAfter:cursor=>({cursor}),limit:value=>({limit:value}),query:(_, ...filters)=>filters,
 getDocs:async filters=>{
  requests.push(filters);
  let selected=jobs.filter(job=>filters.filter(filter=>filter.field).every(({field,op,value})=>op==='=='?job[field]===value:op==='>='?job[field]>=value:job[field]<value));
  selected.sort((a,b)=>a.dateKey.localeCompare(b.dateKey)||a.id.localeCompare(b.id));
  const after=filters.find(filter=>filter.cursor)?.cursor;
  if(after)selected=selected.slice(selected.findIndex(job=>job.id===after.id)+1);
  selected=selected.slice(0,filters.find(filter=>filter.limit).limit);
  return {docs:selected.map(job=>({id:job.id,data:()=>({...job,id:'conflicting-stored-id'})}))};
 },
};
runInNewContext(ts.transpileModule(app.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,queryScope);
let serverReads=0;
queryScope.getDocsFromServer=async filters=>{serverReads++;return queryScope.getDocs(filters);};
const serverLoaded=await queryScope.fetchMyJobs('staff','a',true);
assert.equal(serverReads,2);assert.equal(serverLoaded.length,52);
assert.ok(requests.every(filters=>filters.some(f=>f.field==='companyId'&&f.value==='a')&&filters.some(f=>f.field==='assignedStaffId'&&f.value==='staff')));
queryScope.getDocsFromServer=async()=>{throw Error('server offline');};
await assert.rejects(queryScope.fetchMyJobs('staff','a',true),/server offline/);
requests=[];dateReads=0;

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
 queryScope.getDocFromServer=async()=>{
  if(scenario==='auth')queryScope.authLoadVersionRef.current++;
  return {exists:()=>scenario!=='missing',id:'task-job',data:()=>({companyId:scenario==='company'?'b':'a',assignedStaffId:scenario==='staff'?'other':'staff',status:scenario==='open'?'open':'assigned',cancelled:scenario==='cancelled',dateKey:'2025-01-01'})};
 };
 const job=await queryScope.loadTaskJob('task-job');
 assert.equal(Boolean(job),scenario==='own');
 if(scenario!=='own')assert.equal(queryScope.myJobs,previous);
}
{const previous=queryScope.myJobs;let cacheReads=0;queryScope.getDoc=async()=>{cacheReads++;return {exists:()=>true,id:'stale-task',data:()=>({companyId:'a',assignedStaffId:'staff',status:'assigned'})};};queryScope.getDocFromServer=async()=>{throw Error('task server offline');};await assert.rejects(queryScope.loadTaskJob('stale-task'),/task server offline/);assert.equal(cacheReads,0);assert.equal(queryScope.myJobs,previous);queryScope.getDocFromServer=async()=>({exists:()=>true,id:'recovered-task',data:()=>({id:'wrong',companyId:'a',assignedStaffId:'staff',status:'assigned',dateKey:today})});const recovered=await queryScope.loadTaskJob('recovered-task');assert.equal(recovered.id,'recovered-task');queryScope.myJobs=previous;}
console.log('History paging passed: 1000 equal-date rows, 50-row pages, retry without skipping, auth/refresh isolation, double-click lock, and task ownership checks.');
// 初回300件を超える将来シフトも、同日の文書を飛ばさず必要時だけ取得する。
queryScope.getDocs=readPage;
jobs.push(...Array.from({length:1000},(_,index)=>({id:`future-${String(index).padStart(4,'0')}`,dateKey:'2027-01-01',status:'assigned',companyId:'a',assignedStaffId:'staff'})));
queryScope.myJobs=await queryScope.fetchMyJobs();
assert.equal(queryScope.myJobs.filter(job=>job.dateKey>=today).length,300);
assert.equal(queryScope.hasMoreUpcomingShifts,true);
let futurePages=0;
while(queryScope.hasMoreUpcomingShifts){
 await queryScope.loadMoreUpcomingShifts();
 if(++futurePages>20)assert.fail('Future paging did not terminate');
}
assert.equal(futurePages,15);
assert.equal(queryScope.myJobs.filter(job=>job.dateKey>=today).length,1002);
assert.equal(new Set(queryScope.myJobs.map(job=>job.id)).size,1052);
assert.ok(requests.filter(filters=>filters.some(f=>f.cursor)).every(filters=>filters.some(f=>f.limit===51)));
for(const count of [0,299,300,301]){
 const saved=jobs.splice(0);
 jobs.push(...Array.from({length:count},(_,i)=>({id:`boundary-${i}`,dateKey:today,status:'assigned',companyId:'a',assignedStaffId:'staff'})));
 const initial=await queryScope.fetchMyJobs();
 assert.equal(initial.length,Math.min(count,300));
 assert.equal(queryScope.hasMoreUpcomingShifts,count>300);
 jobs.splice(0,jobs.length,...saved);
}
queryScope.myJobs=await queryScope.fetchMyJobs();
const futureCursor=queryScope.upcomingShiftCursorRef.current;
queryScope.getDocs=async()=>{throw new Error('offline');};
await queryScope.loadMoreUpcomingShifts();
assert.equal(queryScope.upcomingShiftCursorRef.current,futureCursor);
assert.match(queryScope.upcomingMessage,/再試行/);
queryScope.getDocs=readPage;
await queryScope.loadMoreUpcomingShifts();
assert.equal(queryScope.myJobs.length,400);
for(const change of ['auth','refresh']){
 const gate=deferred();queryScope.getDocs=()=>gate.promise;
 const before=queryScope.myJobs,cursor=queryScope.upcomingShiftCursorRef.current;
 const pending=queryScope.loadMoreUpcomingShifts();
 if(change==='auth')queryScope.authLoadVersionRef.current++;else queryScope.pastShiftVersionRef.current++;
 gate.resolve({docs:[]});await pending;
 assert.equal(queryScope.myJobs,before);assert.equal(queryScope.upcomingShiftCursorRef.current,cursor);
}
let futureLocked=false,futureCalls=0;const futureGate=deferred();
queryScope.isPending=()=>futureLocked;
queryScope.run=async(key,fn)=>{futureLocked=true;try{await fn();}finally{futureLocked=false;}};
queryScope.getDocs=()=>{futureCalls++;return futureGate.promise;};
const futurePending=queryScope.loadMoreUpcomingShifts();await queryScope.loadMoreUpcomingShifts();
assert.equal(futureCalls,1);futureGate.resolve({docs:[]});await futurePending;
queryScope.isPending=()=>false;queryScope.run=async(key,fn)=>fn();
console.log('Upcoming paging passed: 0/299/300/301 boundaries, 1002 future rows, cursor retries, auth/refresh races, and double-click lock.');
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
function selectFiles(selected,{requestId='request',files=[original],locked=false,globalMessage='existing',resubmissionSendBlocked=false}={}){
 const state={files,confirmed:true,uploadState:{original:'ready'},message:'existing',globalMessage,writes:0};
 const context={resubmissionSendBlocked,submissionMessage:state.message,setMessage:fn=>{state.globalMessage=fn(state.globalMessage);},files,requestId,MAX_SUBMISSION_FILES:20,MAX_SUBMISSION_FILE_SIZE:50*1024*1024,
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

for(const requestId of ['', 'request']){const result=selectFiles([photo('empty.pdf',0,'application/pdf')],{requestId});assert.equal(result.files[0],original);assert.equal(result.writes,0);assert.equal(result.confirmed,true);assert.match(result.message,/空のファイル/);const mixed=selectFiles([photo('empty.png',0),replacement],{requestId});assert.ok(mixed.files.includes(replacement));assert.ok(!mixed.files.some(file=>file.size===0));assert.match(mixed.message,/空のファイル/);}
{const start=app.indexOf('  async function uploadSubmission()'),end=app.indexOf('  async function retryDraftCleanup()',start);const code=ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;for(const size of [0,50*1024*1024+1]){const messages=[];const ctx={files:[photo('restored.pdf',size,'application/pdf')],submissionConfirmed:true,isSubmissionActionPending:()=>false,MAX_SUBMISSION_FILE_SIZE:50*1024*1024,showSubmissionMessage:value=>messages.push(value)};runInNewContext(code,ctx);await ctx.uploadSubmission();assert.match(messages[0],/送信できません/);}}
console.log('Empty files rejected at selection and restored-draft upload; valid existing selection preserved.');

{
 const helperStart=app.indexOf('function submissionFileContentType('),helperEnd=app.indexOf('function fileStateKey(',helperStart);const start=app.indexOf('  async function uploadSubmission()'),end=app.indexOf('  async function retryDraftCleanup()',start);const code=ts.transpileModule(app.slice(helperStart,helperEnd)+app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const [name,type,expected] of [['report.pdf','','application/pdf'],['REPORT.PDF','application/octet-stream','application/pdf'],['report.pdf','application/pdf','application/pdf'],['photo.jpg','image/jpeg','image/jpeg'],['photo.pdf','image/png','image/png']]){
  const file=photo(name,100,type),job={id:'job'};const state={requests:[],metadata:[],messages:[]};const ctx={files:[file],submissionConfirmed:true,isSubmissionActionPending:()=>false,MAX_SUBMISSION_FILE_SIZE:50*1024*1024,selectedJob:job,myJobs:[job],submissionType:'report',requestId:'',firebaseConfigured:true,functions:{},firebaseApp:{},loadUploadStorage:async()=>({getClientStorage:()=>({}),ref:(...args)=>ctx.ref(...args),uploadBytesResumable:(...args)=>ctx.uploadBytesResumable(...args)}),authLoadVersionRef:{current:1},UPLOAD_CONCURRENCY:3,setSubmissionMessage:()=>{},showSubmissionMessage:m=>state.messages.push(m),setUploadState:()=>{},fileStateKey:f=>f.name,run:async(_key,fn,options)=>{try{await fn()}catch(error){options.setMessage(error.message);throw error}},httpsCallable:()=>async payload=>{state.requests.push(payload);return {data:{submissionId:'synthetic',files:[{storagePath:'synthetic/path'}]}}},runWithConcurrency:async(items,_limit,fn)=>{for(const item of items)await fn(item)},ref:(_storage,path)=>path,uploadBytesResumable:(_target,_file,metadata)=>{state.metadata.push(metadata);return {on:(_event,_progress,reject)=>reject(Error('synthetic stop after metadata capture'))}}};runInNewContext(code,ctx);await ctx.uploadSubmission();assert.equal(state.requests[0].files[0].contentType,expected);assert.equal(state.metadata[0].contentType,expected);assert.equal(state.messages.length,1);
 }
}
console.log('Submission MIME parity: 5 PDF/image cases use identical session and Storage metadata; synthetic transport only.');

{
 const helperStart=app.indexOf('function submissionFileContentType('),helperEnd=app.indexOf('function fileStateKey(',helperStart);const start=app.indexOf('  async function uploadSubmission()'),end=app.indexOf('  async function retryDraftCleanup()',start);const code=ts.transpileModule(app.slice(helperStart,helperEnd)+app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const invalid=[null,{}, {submissionId:3,files:[]},{submissionId:' ',files:[]},{submissionId:'id'}, {submissionId:'id',files:{}},{submissionId:'id',files:[]}, {submissionId:'id',files:[null,null]}, {submissionId:'id',files:[{storagePath:''},{storagePath:'p'}]}, {submissionId:'id',files:[{storagePath:1},{storagePath:'p'}]}, {submissionId:'id',files:[{storagePath:' '},{storagePath:'p'}]}, {submissionId:'id',files:[{storagePath:'same'},{storagePath:'same'}]}];
 for(const data of invalid){const files=[photo('a.pdf'),photo('b.pdf')],job={id:'job'},messages=[];let started=0;const ctx={files,submissionConfirmed:true,isSubmissionActionPending:()=>false,MAX_SUBMISSION_FILE_SIZE:50*1024*1024,selectedJob:job,myJobs:[job],submissionType:'report',requestId:'',firebaseConfigured:true,functions:{},firebaseApp:{},loadUploadStorage:async()=>({getClientStorage:()=>({}),ref:(...args)=>ctx.ref(...args),uploadBytesResumable:(...args)=>ctx.uploadBytesResumable(...args)}),authLoadVersionRef:{current:1},setSubmissionMessage:()=>{},showSubmissionMessage:m=>messages.push(m),run:async(_key,fn,options)=>{try{await fn()}catch(error){options.setMessage(error.message);throw error}},httpsCallable:()=>async()=>({data}),setUploadState:()=>started++,runWithConcurrency:()=>started++};runInNewContext(code,ctx);await ctx.uploadSubmission();assert.equal(started,0);assert.equal(ctx.files,files);assert.equal(ctx.submissionConfirmed,true);assert.match(messages[0],/送信先を正しく準備できませんでした/);}
}
console.log('Upload preparation: 12 malformed/missing/duplicate target responses blocked before any transfer; selection retained.');

{const {localDateKey,splitAssignedJobs,availableOpenJobs}=moduleFrom('apps/staff/src/job-list.ts');for(const [iso,expected] of [['2026-09-09T14:59:59Z','2026-09-09'],['2026-09-09T15:00:00Z','2026-09-10'],['2026-12-31T15:00:00Z','2027-01-01'],['2024-02-28T15:00:00Z','2024-02-29'],['2026-02-28T15:00:00Z','2026-03-01']]){const date=new Date(iso);date.getFullYear=()=>{throw Error('must not use device-local year')};date.getMonth=()=>{throw Error('must not use device-local month')};date.getDate=()=>{throw Error('must not use device-local date')};assert.equal(localDateKey(date),expected);}const today=localDateKey(new Date('2026-09-09T16:00:00Z'));const jobs=[{id:'yesterday',dateKey:'2026-09-09',status:'assigned'},{id:'today',dateKey:'2026-09-10',status:'assigned'}];const split=splitAssignedJobs(jobs,today);assert.equal(split.upcoming[0].id,'today');assert.equal(split.past[0].id,'yesterday');assert.deepEqual(Array.from(availableOpenJobs(jobs.map(job=>({...job,status:'open'})),today),job=>job.id),['today']);}
console.log('Japan business date: midnight/year/leap boundaries and past/open shift separation are independent of device-local date.');


// 日付更新の実effectを実行し、復帰・タイマー・解除を個別に確認する。
{
 const start=app.indexOf('  useEffect(()=>{',app.indexOf('const [businessDate,'));
 const end=app.indexOf('  },[]);',start)+10;
 assert.ok(start>=0&&end>start);
 let date='2026-09-10',cleanup,timer,cleared;
 const values=[],windowEvents=new Map(),documentEvents=new Map();
 const scope={localDateKey:()=>date,setBusinessDate:value=>values.push(value),useEffect:fn=>{cleanup=fn();},
 window:{setInterval:(fn,ms)=>{assert.equal(ms,60_000);timer=fn;return 17;},clearInterval:id=>{cleared=id;},addEventListener:(key,fn)=>windowEvents.set(key,fn),removeEventListener:(key,fn)=>{assert.equal(windowEvents.get(key),fn);windowEvents.delete(key);}},
 document:{visibilityState:'hidden',addEventListener:(key,fn)=>documentEvents.set(key,fn),removeEventListener:(key,fn)=>{assert.equal(documentEvents.get(key),fn);documentEvents.delete(key);}}};
 runInNewContext(app.slice(start,end),scope);
 timer();assert.equal(values.at(-1),'2026-09-10');
 date='2026-09-11';timer();assert.equal(values.at(-1),date);
 date='2026-09-12';windowEvents.get('focus')();assert.equal(values.at(-1),date);
 documentEvents.get('visibilitychange')();assert.equal(values.at(-1),'2026-09-12');
 date='2026-09-13';scope.document.visibilityState='visible';documentEvents.get('visibilitychange')();assert.equal(values.at(-1),date);
 cleanup();assert.equal(cleared,17);assert.equal(windowEvents.size,0);assert.equal(documentEvents.size,0);
 assert.match(app,/useMemo\(\(\)=>splitAssignedJobs\(myJobs,businessDate\),\[myJobs,businessDate\]\)/u);
 assert.match(app,/useMemo\(\(\)=>availableOpenJobs\(openJobs,businessDate\),\[openJobs,businessDate\]\)/u);
 assert.ok(app.includes('visibleOpenJobs.map(job=>')&&app.includes('!visibleOpenJobs.length'));
 const {availableOpenJobs,splitAssignedJobs}=moduleFrom('apps/staff/src/job-list.ts');
 const open=[{id:'expired',dateKey:'2026-09-10',status:'open'},{id:'current',dateKey:'2026-09-11',status:'open'}];
 assert.equal(availableOpenJobs(open,'2026-09-10').length,2);
 assert.deepEqual(Array.from(availableOpenJobs(open,'2026-09-11'),job=>job.id),['current']);
 const assigned=open.map(job=>({...job,status:'assigned'}));
 assert.equal(splitAssignedJobs(assigned,'2026-09-11').past.length,1);
 assert.equal(open.length,2);assert.equal(assigned.length,2);
 console.log('Business date refresh passed: timer, focus, visible return, listener cleanup, shift and open-job reclassification without data mutation.');
}


// 全体読込の遅い応答が新一覧や個別追加を上書きしないことを実関数で検証。
{
 const primaryStart=app.indexOf('  async function loadPrimaryBusinessData('),primaryEnd=app.indexOf('  async function loadOpenJobs(',primaryStart);
 const taskStart=app.indexOf('  async function loadTaskJob('),taskEnd=app.indexOf('  async function fetchTasks(',taskStart);
 for(const mode of ['newer-list','individual','auth','normal']){
  const gate=deferred();let calls=0;
  const state={jobs:[],tasks:[],saved:0};
  const scope={authLoadVersionRef:{current:1},tasksReadVersionRef:{current:0},pastShiftVersionRef:{current:0},staffId:'staff',companyId:'a',user:{uid:'u'},db:{},isPending:()=>false,
   fetchMyJobs:()=>{scope.pastShiftVersionRef.current++;return ++calls===1?gate.promise:Promise.resolve([{id:'new-list'}]);},fetchTasks:async()=>[],
   setMyJobs:value=>state.jobs=typeof value==='function'?value(state.jobs):value,setTasks:value=>state.tasks=value,setSelectedJob:()=>{},saveBusinessSnapshot:()=>state.saved++,nextShiftJob:()=>null,
   doc:()=>({}),getDocFromServer:async()=>({exists:()=>true,id:'accepted-job',data:()=>({companyId:'a',assignedStaffId:'staff',status:'assigned'})}),run:async(key,fn)=>fn(),orderAssignedJobs:jobs=>jobs};
  runInNewContext(ts.transpileModule(app.slice(primaryStart,primaryEnd)+app.slice(taskStart,taskEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scope);
  const pending=scope.loadPrimaryBusinessData();
  if(mode==='newer-list')await scope.loadPrimaryBusinessData();
  if(mode==='individual')await scope.loadTaskJob('accepted-job');
  if(mode==='auth')scope.authLoadVersionRef.current++;
  gate.resolve([{id:'old-list'}]);const applied=await pending;
  assert.equal(applied,mode==='normal',mode);
  assert.deepEqual(Array.from(state.jobs,job=>job.id),mode==='normal'?['old-list']:mode==='newer-list'?['new-list']:mode==='individual'?['accepted-job']:[],mode);
  assert.equal(state.saved,mode==='normal'||mode==='newer-list'?1:0,mode);
 }
 console.log('Primary read races: latest list, individual assigned job, auth isolation and normal persistence.');
}

{
 const start=app.indexOf('  async function loadPrimaryBusinessData('),end=app.indexOf('  async function loadOpenJobs(',start);
 for(const stale of [false,true]){
  const gate=deferred();const scope={authLoadVersionRef:{current:1},tasksReadVersionRef:{current:0},pastShiftVersionRef:{current:0},staffId:'staff',companyId:'a',user:{uid:'u'},fetchMyJobs:()=>{scope.pastShiftVersionRef.current++;return gate.promise;},fetchTasks:async()=>[]};
  runInNewContext(ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scope);
  const pending=scope.loadPrimaryBusinessData();if(stale)scope.pastShiftVersionRef.current++;
  gate.reject(Error('read failure'));
  if(stale)assert.equal(await pending,false);else await assert.rejects(pending,/read failure/);
 }
 const taskStart=app.indexOf('  async function loadTaskJob('),taskEnd=app.indexOf('  async function fetchTasks(',taskStart);
 const gate=deferred();let writes=0;
 const scope={authLoadVersionRef:{current:1},tasksReadVersionRef:{current:0},pastShiftVersionRef:{current:1},staffId:'staff',companyId:'a',db:{},isPending:()=>false,doc:()=>({}),getDocFromServer:()=>gate.promise,run:async(key,fn)=>fn(),setMyJobs:()=>writes++,orderAssignedJobs:jobs=>jobs};
 runInNewContext(ts.transpileModule(app.slice(taskStart,taskEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scope);
 const pending=scope.loadTaskJob('older');scope.pastShiftVersionRef.current++;
 gate.resolve({exists:()=>true,id:'older',data:()=>({companyId:'a',assignedStaffId:'staff',status:'assigned'})});
 assert.equal(await pending,null);assert.equal(writes,0);
 console.log('Read race failures: current error preserved, stale error discarded, old individual result cannot replace a newer list.');
}

{
 const primaryStart=app.indexOf('  async function loadPrimaryBusinessData('),primaryEnd=app.indexOf('  async function loadOpenJobs(',primaryStart);
 const refreshStart=app.indexOf('  async function refreshSelectedJob('),refreshEnd=app.indexOf('  async function requestLogin(',refreshStart);
 for(const mode of ['updated','cancelled','missing']){
  const gate=deferred(),state={jobs:[{id:'A',storeName:'old'}],selected:{id:'A'},saved:0};
  const scope={authLoadVersionRef:{current:1},tasksReadVersionRef:{current:0},pastShiftVersionRef:{current:0},staffId:'staff',companyId:'company',user:{uid:'u'},db:{},doc:()=>({}),
   fetchMyJobs:()=>{scope.pastShiftVersionRef.current++;return gate.promise;},fetchTasks:async()=>[],
   setMyJobs:value=>state.jobs=typeof value==='function'?value(state.jobs):value,setTasks:()=>{},setSelectedJob:fn=>state.selected=fn(state.selected),saveBusinessSnapshot:()=>state.saved++,nextShiftJob:()=>null,
   getDocFromServer:async()=>({exists:()=>mode!=='missing',id:'A',data:()=>({companyId:'company',assignedStaffId:'staff',status:'assigned',cancelled:mode==='cancelled',storeName:'fresh'})})};
  runInNewContext(ts.transpileModule(app.slice(primaryStart,primaryEnd)+app.slice(refreshStart,refreshEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scope);
  const pending=scope.loadPrimaryBusinessData();await scope.refreshSelectedJob('A');gate.resolve([{id:'A',storeName:'old'}]);
  assert.equal(await pending,false,'Individual refresh must invalidate older primary response');
  assert.equal(state.jobs.length,mode==='updated'?1:0);assert.equal(state.saved,0);
  if(mode==='updated')assert.equal(state.jobs[0].storeName,'fresh');else assert.equal(state.selected,null);
 }
 console.log('Individual refresh wins over old list: updated, cancelled and missing assigned job.');
}

{
 const primaryStart=app.indexOf('  async function loadPrimaryBusinessData('),primaryEnd=app.indexOf('  async function loadOpenJobs(',primaryStart);
 const gate=deferred(),state={jobs:[{id:'old'}],saved:0};
 const oldCursor={id:'old-cursor'};
 const scope={...queryScope,user:{uid:'u'},staffId:'staff',companyId:'a',authLoadVersionRef:{current:1},tasksReadVersionRef:{current:0},pastShiftVersionRef:{current:0},upcomingShiftCursorRef:{current:oldCursor},pastShiftCursorRef:{current:oldCursor},pastShiftDateRef:{current:'old-date'},
  fetchTasks:()=>gate.promise,setHasMoreUpcomingShifts:()=>{},setHasMorePastShifts:()=>{},setUpcomingShiftMessage:()=>{},setPastShiftMessage:()=>{},
  setMyJobs:value=>state.jobs=value,setTasks:()=>{},setSelectedJob:()=>{},saveBusinessSnapshot:()=>state.saved++,
  getDocs:async()=>({docs:[{id:'new',data:()=>({dateKey:today,status:'assigned'})}]})};
 runInNewContext(ts.transpileModule(app.slice(from,to)+app.slice(primaryStart,primaryEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scope);
 const pending=scope.loadPrimaryBusinessData();
 await Promise.resolve();await Promise.resolve();await Promise.resolve();
 gate.reject(Error('tasks unavailable'));await assert.rejects(pending,/tasks unavailable/);
 assert.equal(scope.upcomingShiftCursorRef.current,oldCursor,'Failed combined load must retain upcoming cursor');
 assert.equal(scope.pastShiftCursorRef.current,oldCursor);assert.equal(scope.pastShiftDateRef.current,'old-date');assert.equal(state.jobs[0].id,'old');assert.equal(state.saved,0);
 scope.fetchTasks=async()=>[];assert.equal(await scope.loadPrimaryBusinessData(),true);
 assert.equal(scope.upcomingShiftCursorRef.current.id,'new');assert.equal(scope.pastShiftDateRef.current,today);assert.equal(state.jobs[0].id,'new');assert.equal(state.saved,1);
 console.log('Combined read failure preserves list/cursors/date; successful retry updates them together.');
}

{
 const begin=app.indexOf('  async function fetchTasks('),end=app.indexOf('  async function loadPrimaryBusinessData(',begin);
 const valid={id:'t',jobId:'j',kind:'report',title:'Report',body:'Upload report',priority:'normal'};
 const scope={functions:{},httpsCallable:()=>async()=>scope.reply};
 runInNewContext(ts.transpileModule(app.slice(begin,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scope);
 for(const data of [{},{tasks:null},{tasks:{}},{tasks:[null]},{tasks:[{...valid,title:{}}]},{tasks:[{...valid,body:5}]},{tasks:[{...valid,id:''}]},{tasks:[{...valid,jobId:''}]},{tasks:[{...valid,kind:''}]},{tasks:[{...valid,priority:'invalid'}]},{tasks:[valid,valid]},{tasks:[{...valid,metadata:[]}]}]){
  scope.reply={data};await assert.rejects(scope.fetchTasks(),/やること一覧を確認できません/);
 }
 for(const tasks of [[],[valid],[{...valid,metadata:null}],[{...valid,body:'',metadata:{requestId:'r'}}]]){
  scope.reply={data:{tasks}};assert.equal(await scope.fetchTasks(),tasks);
 }
 console.log('Task response validation: 12 malformed lists rejected, explicit empty and valid tasks accepted.');
}

{
 const stored=new Map(),scope={exports:{},localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)}};
 runInNewContext(ts.transpileModule(readFileSync('apps/staff/src/business-cache.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,scope);
 const api=scope.exports,key='lkcBusinessSnapshot:u:c:s';
 const job={id:'j',dateKey:'2026-09-10',status:'assigned',menuName:'demo'},task={id:'t',jobId:'j',kind:'report',title:'Report',body:'',priority:'normal'};
 for(const [jobs,tasks] of [[[null],[task]],[[job],[null]],[[{...job,menuName:{}}],[task]],[[job],[{...task,title:{}}]],[[job],[task,task]],[[job,job],[task]],[[{...job,netPrint:{items:{}}}],[task]],[[{...job,netPrint:{items:[null]}}],[task]],[[{...job,preContact:{arrivalTime:{}}}],[task]],[[{...job,submissionStatus:{report:{completed:'yes'}}}],[task]],[[job],[{...task,priority:'other'}]],[[job],[{...task,priority:['normal']}]]]){
  stored.set(key,JSON.stringify({version:1,savedAt:1000,jobs,tasks}));assert.equal(api.loadBusinessSnapshot('u','c','s',1001),null,'Malformed cached entries must not restore');
 }
 stored.set(key,JSON.stringify({version:1,savedAt:1000,jobs:[job],tasks:[{...task,metadata:null}]}));assert.ok(api.loadBusinessSnapshot('u','c','s',1001));assert.equal(api.loadBusinessSnapshot('other','c','s',1001),null);
 stored.set(key,JSON.stringify({version:1,savedAt:1000,jobs:[],tasks:[]}));assert.ok(api.loadBusinessSnapshot('u','c','s',1001));
 console.log('Business cache entries: 12 malformed nested/list values rejected; valid/null metadata/empty/owner separation preserved.');
}

{
 const start=app.indexOf('  async function pollSubmissionProcessing('),end=app.indexOf('  async function uploadSubmission()',start);const code=ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const invalid=[{status:'completed',completedFiles:0,totalFiles:1,errorMessage:null},{status:'completed',completedFiles:1,totalFiles:'1',errorMessage:null},{status:'completed',completedFiles:0,totalFiles:0,errorMessage:null},{status:'completed',completedFiles:1.5,totalFiles:1.5,errorMessage:null},{status:'unknown',completedFiles:0,totalFiles:1,errorMessage:null},{status:'error',completedFiles:0,totalFiles:1,errorMessage:{}}];
 for(const data of [...invalid,{status:'completed',completedFiles:1,totalFiles:1,errorMessage:null}]){let now=0;const messages=[],effects=[];const ctx={functions:{},authLoadVersionRef:{current:1},submissionProcessingVersionRef:{current:0},setProcessingSubmission:v=>effects.push(v),httpsCallable:()=>async()=>({data}),showSubmissionMessage:m=>messages.push(m),loadSubmissionHistory:async()=>effects.push('history'),refreshSelectedJob:async()=>effects.push('job'),loadTasks:async()=>effects.push('tasks'),sleep:async()=>{now+=60000;},Date:{now:()=>now}};runInNewContext(code,ctx);await ctx.pollSubmissionProcessing('job','submission','report','');const valid=!invalid.includes(data);if(valid){assert.equal(effects.includes('history'),true);assert.match(messages[0],/保存が完了/);}else{assert.equal(effects.includes('history'),false);assert.match(messages[0],/提出状況を確認できません/);}assert.equal(effects.at(-1),false);}
 console.log('Processing response validation passed: six malformed responses and valid completion.');
}

{
 const start=app.indexOf('  async function pollSubmissionProcessing('),end=app.indexOf('  async function uploadSubmission()',start);const code=ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const late of [false,true]){let now=0,calls=0;const messages=[],effects=[],timeouts=[];const ctx={functions:{},authLoadVersionRef:{current:1},submissionProcessingVersionRef:{current:0},setProcessingSubmission:v=>effects.push(v),showSubmissionMessage:m=>messages.push(m),Date:{now:()=>now},sleep:async ms=>{now+=ms;},httpsCallable:(_f,_name,options)=>async()=>{calls++;const timeout=options?.timeout??70000;timeouts.push(timeout);if(late&&calls===1){now=58000;return {data:{status:'processing',completedFiles:0,totalFiles:1,errorMessage:null}};}now+=timeout;throw Error('synthetic timeout');}};runInNewContext(code,ctx);await ctx.pollSubmissionProcessing('job','submission','report','');assert.ok(now<=60000,'Polling request must fit the overall confirmation window.');assert.ok(timeouts.every(t=>t>0&&t<=15000));assert.equal(effects.at(-1),false);assert.match(messages.at(-1),/提出状況を確認できません/);}
 console.log('Processing timeout budget passed: first and near-deadline stalled requests unlock with recovery guidance.');
}

{
 const start=app.indexOf('  async function pollSubmissionProcessing('),end=app.indexOf('  async function uploadSubmission()',start);const code=ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const failed of ['history','job','tasks','detail','none','stale','unconfirmed']){
  const gates={},messages=[],effects=[];const read=name=>()=>new Promise((resolve,reject)=>{gates[name]={resolve,reject};});
  const ctx={functions:{},authLoadVersionRef:{current:1},submissionProcessingVersionRef:{current:0},setProcessingSubmission:v=>effects.push(v),httpsCallable:()=>async()=>({data:{status:'completed',completedFiles:1,totalFiles:1,errorMessage:null}}),showSubmissionMessage:m=>messages.push(m),loadSubmissionHistory:read('history'),refreshSelectedJob:read('job'),loadTasks:read('tasks'),loadResubmissionDetail:read('detail'),Date:{now:()=>0}};
  runInNewContext(code,ctx);const pending=ctx.pollSubmissionProcessing('job','submission','report','request');for(let tick=0;tick<20;tick++)await Promise.resolve();
  assert.equal(Object.keys(gates).length,4,'All completion reads, including request detail, start independently');
  if(failed==='unconfirmed')gates.history.resolve(false);else if(!['none','stale'].includes(failed))gates[failed].reject(Error('read failed'));else gates.history.resolve(true);
  for(let tick=0;tick<20;tick++)await Promise.resolve();assert.deepEqual(effects,[true],'Keep processing lock while any completion read is outstanding');
  const previousMessages=messages.length;if(failed==='stale')ctx.authLoadVersionRef.current++;
  for(const [name,gate] of Object.entries(gates))if(name!==failed)gate.resolve(true);
  await pending;
  if(failed==='stale'){assert.deepEqual(effects,[true]);assert.equal(messages.length,previousMessages);}else{assert.equal(effects.at(-1),false);assert.match(messages.at(-1),failed==='none'?/保存が完了/:/保存は完了.*画面の更新/);}
 }
 console.log('Completed submission refresh: four independent reads, each failure holds lock until all settle; saved outcome and stale-session isolation preserved.');
}

{
 const a=app.indexOf('  async function fetchMyJobs('),b=app.indexOf('  async function loadMorePastShifts(',a),c=app.indexOf('  async function loadPrimaryBusinessData('),d=app.indexOf('  async function loadOpenJobs(',c);
 for(const failed of ['upcoming','history','tasks'])for(const stale of [false,true]){
  const reads=[deferred(),deferred()],task=deferred();let readIndex=0,writes=0,settled=false;const scopes={db:{},staffId:'s',companyId:'c',user:{uid:'u'},authLoadVersionRef:{current:1},tasksReadVersionRef:{current:0},pastShiftVersionRef:{current:0},localDateKey:()=> '2026-09-10',getDocs:()=>reads[readIndex++].promise,collection:()=>{},where:()=>{},orderBy:()=>{},limit:()=>{},query:()=>{},fetchTasks:()=>task.promise,setMyJobs:()=>writes++,setTasks:()=>writes++,setSelectedJob:()=>writes++,saveBusinessSnapshot:()=>writes++,orderAssignedJobs:jobs=>jobs};
  runInNewContext(ts.transpileModule(app.slice(a,b)+app.slice(c,d),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scopes);
  const pending=scopes.loadPrimaryBusinessData().then(value=>({value}),error=>({error})).finally(()=>{settled=true;});assert.equal(readIndex,2);
  const gates={upcoming:reads[0],history:reads[1],tasks:task};gates[failed].reject(Error('offline'));
  for(let tick=0;tick<20;tick++)await Promise.resolve();assert.equal(settled,false,'Wait for all network reads before releasing the caller');assert.equal(writes,0);
  if(stale)scopes.authLoadVersionRef.current++;
  for(const [name,gate] of Object.entries(gates))if(name!==failed)gate.resolve(name==='tasks'?[]:{docs:[]});
  const result=await pending;assert.equal(writes,0);if(stale)assert.equal(result.value,false);else assert.match(String(result.error),/offline/);
 }
 console.log('Primary business failure: all three reads settle before return; each failed read preserves previous state/cache and stale failures are discarded.');
}

{
 const invalidBatch=[photo('unsupported.txt',1,'text/plain'),photo('empty.pdf',0,'application/pdf'),photo('oversized.pdf',50*1024*1024+1,'application/pdf'),replacement,replacement];
 const fullResult=selectFiles(invalidBatch,{requestId:'',files:full});assert.equal(fullResult.writes,0);assert.equal(fullResult.confirmed,true);assert.equal(fullResult.files,full);
 for(const reason of ['画像またはPDF以外','空のファイル','50MBを超える','最大20件','重複'])assert.ok(fullResult.message.includes(reason),reason);
 const partial=selectFiles(invalidBatch,{requestId:'',files:[original]});assert.equal(partial.files.length,2);assert.equal(partial.files[0],original);assert.equal(partial.files[1],replacement);assert.equal(partial.confirmed,false);for(const reason of ['画像またはPDF以外','空のファイル','50MBを超える','重複'])assert.ok(partial.message.includes(reason));assert.equal(partial.message.includes('最大20件'),false);
 const retried=selectFiles([photo('fixed.pdf',100,'application/pdf')],{requestId:'',files:partial.files});assert.equal(retried.files.length,3);assert.equal(retried.message,'');
 console.log('Mixed selection rejection: all applicable reasons shown, full selection/confirmation preserved, valid additions retained and corrected retry clears notice.');
}

{const {availableOpenJobs,isUpcomingJob,splitAssignedJobs}=moduleFrom('apps/staff/src/job-list.ts');const today='0001-01-01';const valid=['0001-01-01','2024-02-29','2000-02-29','2026-02-28','2026-04-30','2026-12-31'];const invalid=['2026-02-29','2026-02-30','1900-02-29','2100-02-29','2026-04-31','2026-00-10','2026-13-01','2026-01-00','2026-01-32','0000-01-01','2026-2-01','2026-01-01 ',null,20260910,{}];for(const dateKey of valid){const job={id:'valid',dateKey,status:'open'};assert.equal(isUpcomingJob(job,today),true);assert.equal(availableOpenJobs([job],today).length,1);}for(const dateKey of invalid){const job={id:'invalid',dateKey,status:'open'};assert.equal(isUpcomingJob(job,today),false);assert.equal(availableOpenJobs([job],today).length,0);const split=splitAssignedJobs([{...job,status:'assigned'}],today);assert.equal(split.upcoming.length,0);assert.equal(split.past[0].id,'invalid');}}
console.log('Calendar validity: six real dates and fifteen invalid dates/types; invalid recruitment excluded, assigned records retained for review.');

{
 const start=app.indexOf('  async function uploadSubmission()'),end=app.indexOf('  async function retryDraftCleanup()',start);assert.ok(start>=0&&end>start);const code=ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const valid={id:'request',jobId:'job',type:'report',status:'open'};
 for(const request of [null,{...valid,status:'submitted'},{...valid,status:'completed'},{...valid,status:'cancelled'},{...valid,status:'unknown'},{...valid,id:'other'},{...valid,jobId:'other'},{...valid,type:'sales_floor'},valid]){
  const job={id:'job'},messages=[];let sent=0;const ctx={files:[photo('a.pdf')],submissionConfirmed:true,isSubmissionActionPending:()=>false,MAX_SUBMISSION_FILE_SIZE:50*1024*1024,selectedJob:job,myJobs:[job],requestId:'request',resubmissionDetail:request?{request}:null,submissionType:'report',showSubmissionMessage:m=>messages.push(m),firebaseConfigured:false,setSubmissionMessage:()=>{},setUploadState:()=>sent++,fileStateKey:()=> 'file',setSubmissionConfirmed:()=>{}};
  runInNewContext(code,ctx);await ctx.uploadSubmission();assert.equal(sent,request===valid?1:0);assert.equal(messages[0].includes('再提出できる依頼を確認できません'),request!==valid);assert.equal(ctx.files.length,1);
 }
 console.log('Resubmission send guard passed: 9 request identity/status cases, blocked requests retain selected files.');
}

{
 const start=app.indexOf('  async function uploadSubmission()'),end=app.indexOf('  async function retryDraftCleanup()',start);const helperStart=app.indexOf('function submissionFileContentType('),helperEnd=app.indexOf('function fileStateKey(',helperStart);const code=ts.transpileModule(app.slice(helperStart,helperEnd)+app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const missing of ['functions','storage','both']){
  const job={id:'job'},files=[photo('retained.pdf')],messages=[];let starts=0;
  const ctx={files,submissionConfirmed:true,isSubmissionActionPending:()=>false,MAX_SUBMISSION_FILE_SIZE:50*1024*1024,selectedJob:job,myJobs:[job],requestId:'',submissionType:'report',firebaseConfigured:true,functions:missing==='storage'?{}:null,firebaseApp:missing==='functions'?{}:null,loadUploadStorage:async()=>({getClientStorage:()=>({})}),setSubmissionMessage:()=>{},showSubmissionMessage:m=>messages.push(m),authLoadVersionRef:{current:1},run:async(_key,fn)=>fn(),httpsCallable:()=>async()=>{starts++;throw Error('synthetic stop before upload');}};
  runInNewContext(code,ctx);await ctx.uploadSubmission();assert.equal(starts,0);assert.equal(ctx.files,files);assert.equal(ctx.submissionConfirmed,true);assert.match(messages.at(-1),/接続準備を確認できません/);
  ctx.functions={};ctx.firebaseApp={};await ctx.uploadSubmission();assert.equal(starts,1);assert.equal(ctx.files,files);
 }
 console.log('Submission service recovery passed: 3 missing service combinations retain files and allow retry after preparation.');
}

{
 const start=app.indexOf('  async function pollSubmissionProcessing('),end=app.indexOf('  async function uploadSubmission()',start);const code=ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const errorMessage of [null,'','  ','転送先を確認してください']){
  const messages=[],effects=[];const ctx={functions:{},authLoadVersionRef:{current:1},submissionProcessingVersionRef:{current:0},setProcessingSubmission:v=>effects.push(v),httpsCallable:()=>async()=>({data:{status:'error',completedFiles:0,totalFiles:1,errorMessage}}),showSubmissionMessage:m=>messages.push(m),Date:{now:()=>0}};
  runInNewContext(code,ctx);await ctx.pollSubmissionProcessing('job','submission','report','');assert.equal(messages.length,1);assert.match(messages[0],/エラーが発生/);assert.match(messages[0],/「提出情報を再読み込み」/);if(errorMessage?.trim())assert.ok(messages[0].includes(errorMessage));assert.deepEqual(effects,[true,false]);
 }
 const messages=[];const ctx={functions:null,showSubmissionMessage:m=>messages.push(m)};runInNewContext(code,ctx);await ctx.pollSubmissionProcessing('job','submission','report','');assert.match(messages[0],/接続準備を確認できません/);assert.match(messages[0],/「提出情報を再読み込み」/);
 console.log('Processing recovery guidance passed: missing service and 4 error-detail values keep actionable guidance; error unlocks controls.');
}

{
 const start=app.indexOf('  async function pollSubmissionProcessing('),end=app.indexOf('  async function uploadSubmission()',start);const code=ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const stale of [false,true]){
  const messages=[],effects=[];let finish,reads=0;const ctx={functions:{},authLoadVersionRef:{current:1},submissionProcessingVersionRef:{current:0},setProcessingSubmission:v=>effects.push(v),httpsCallable:()=>()=>{reads++;return new Promise(resolve=>finish=resolve);},showSubmissionMessage:m=>messages.push(m),Date:{now:()=>0},sleep:()=>assert.fail('Paused transfer must release controls without polling further')};
  runInNewContext(code,ctx);const pending=ctx.pollSubmissionProcessing('job','submission','report','');if(stale)ctx.authLoadVersionRef.current++;
  finish({data:{status:'paused_global',completedFiles:0,totalFiles:1,errorMessage:null}});await pending;assert.equal(reads,1);
  if(stale){assert.deepEqual(messages,[]);assert.deepEqual(effects,[true]);}else{assert.equal(messages.length,1);assert.match(messages[0],/一時停止中/);assert.match(messages[0],/再送せず/);assert.match(messages[0],/「提出情報を再読み込み」/);assert.deepEqual(effects,[true,false]);}
 }
 const toneStart=app.indexOf('function messageTone('),toneEnd=app.indexOf(String.fromCharCode(10),toneStart);const ctx={};runInNewContext(ts.transpileModule(app.slice(toneStart,toneEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);assert.equal(ctx.messageTone('Drive転送は一時停止中です。再送せず、「提出情報を再読み込み」で状態を確認してください。'),'warning');
 console.log('Paused transfer recovery passed: immediate unlock and refresh guidance, stale response isolation and warning tone.');
}

for(const globalMessage of ['existing','unrelated notification'])for(const mode of ['valid','invalid','cancel','locked']){
 const selected=mode==='cancel'?[]:mode==='invalid'?[photo('bad.txt',1,'text/plain')]:[replacement];const result=selectFiles(selected,{globalMessage,locked:mode==='locked'});
 assert.equal(result.globalMessage,globalMessage==='existing'&&!['cancel','locked'].includes(mode)?result.message:globalMessage);if(mode==='valid')assert.equal(result.message,'');
}
console.log('File reselection notices: 8 matching/unrelated global-message conditions; corrected selection clears only its own old notice, cancellation/locks preserve notices.');

for(const selected of [[replacement],[photo('bad.txt',1,'text/plain')]]){const result=selectFiles(selected,{resubmissionSendBlocked:true});assert.equal(result.writes,0);assert.equal(result.files[0],original);assert.equal(result.confirmed,true);assert.equal(result.message,'existing');assert.equal(result.globalMessage,'existing');}
console.log('Closed resubmission selection guard: valid/invalid incoming selections cannot replace retained files or confirmation.');

{
 const a=app.indexOf('  async function loadPrimaryBusinessData('),b=app.indexOf('  async function loadOpenJobs(',a),c=app.indexOf('  async function loadTasks('),d=app.indexOf('  function showSubmissionMessage(',c);assert.ok(a>=0&&b>a&&c>=0&&d>c);const code=ts.transpileModule(app.slice(a,b)+app.slice(c,d),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const first of ['tasks','primary'])for(const second of ['tasks','primary'])for(const rejectOld of [false,true]){
  const gates=[deferred(),deferred()];let calls=0;const state={tasks:[],saved:[]};const ctx={authLoadVersionRef:{current:1},pastShiftVersionRef:{current:0},tasksReadVersionRef:{current:0},staffId:'s',companyId:'c',user:{uid:'u'},fetchTasks:()=>gates[calls++].promise,fetchMyJobs:async()=>[{id:'job'}],setTasks:t=>state.tasks=t,setMyJobs:()=>{},setSelectedJob:()=>{},saveBusinessSnapshot:(u,c,s,j,t)=>state.saved.push(t),nextShiftJob:()=>null};runInNewContext(code,ctx);const old=first==='tasks'?ctx.loadTasks():ctx.loadPrimaryBusinessData();const observed=old.then(value=>({value}),error=>({error}));const fresh=second==='tasks'?ctx.loadTasks():ctx.loadPrimaryBusinessData();const current=[{id:'fresh'}];gates[1].resolve(current);await fresh;assert.equal(state.tasks,current);rejectOld?gates[0].reject(Error('old request failed')):gates[0].resolve([{id:'obsolete'}]);const result=await observed;assert.equal(state.tasks,current);assert.ok(state.saved.every(t=>t===current));assert.equal(result.value,false);
 }
 console.log('Task read ordering: 8 standalone/primary overlapping success/failure combinations preserve the latest tasks and cached snapshot.');
}

{
 const start=app.indexOf('  async function loadTasks('),end=app.indexOf('  function showSubmissionMessage(',start),code=ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const stale of [false,true])for(const failure of [false,true]){const gate=deferred(),tasks=[{id:'task'}];let writes=0;const ctx={authLoadVersionRef:{current:1},tasksReadVersionRef:{current:0},fetchTasks:()=>gate.promise,setTasks:v=>{writes++;assert.equal(v,tasks);}};runInNewContext(code,ctx);const pending=ctx.loadTasks();const observed=pending.then(value=>({value}),error=>({error}));if(stale)ctx.authLoadVersionRef.current++;const error=Error('current task read failed');failure?gate.reject(error):gate.resolve(tasks);const result=await observed;assert.equal(writes,!stale&&!failure?1:0);if(stale)assert.equal(result.value,false);else if(failure)assert.equal(result.error,error);else assert.equal(result.value,true);}
 console.log('Task refresh result: auth-stale success/failure return false without writes; current failures remain actionable and current success returns true.');
}
