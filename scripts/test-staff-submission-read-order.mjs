import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json'));
const ts=require('typescript');
const source=fs.readFileSync('apps/staff/src/App.tsx','utf8');
const start=source.indexOf('  async function loadSubmissionHistory('),end=source.indexOf('  async function discardFilesBeforeContextChange(',start);
assert.ok(start>=0&&end>start);
const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function setup(){
 const state={calls:[],history:[],detail:null,status:'',messages:[],visibleMessage:'',clears:0,jobRefreshes:0,taskRefreshes:0};
 const ctx={submissionMessage:'',setMessage:fn=>{state.visibleMessage=fn(state.visibleMessage);},refreshSelectedJob:async()=>{state.jobRefreshes++;return true;},loadTasks:async()=>{state.taskRefreshes++;return [];},firebaseConfigured:true,functions:{},resubmissionDetail:null,authLoadVersionRef:{current:1},navigationVersionRef:{current:0},submissionHistoryVersionRef:{current:0},resubmissionDetailVersionRef:{current:0},submissionContextVersionRef:{current:0},previewContextRef:{current:'A'},selectedJob:{id:'A'},submissionType:'report',draftOwner:'user',hydratedDraftKeyRef:{current:''},draftHydratingRef:{current:false},submissionDraftKey:(_owner,job,type,req)=>[job,type,req].join(':'),
 httpsCallable:(_f,name)=>input=>new Promise((resolve,reject)=>state.calls.push({name,input,resolve,reject})),
 setSubmissionHistory:v=>state.history=v,setSubmissionHistoryStatus:v=>state.status=v,setResubmissionDetail:v=>state.detail=v,showSubmissionMessage:v=>{state.visibleMessage=v;if(v)state.messages.push(v);else state.clears++;},
 setDraftHydrating:()=>{},setSelectedJob:v=>ctx.selectedJob=v,setSubmissionType:v=>ctx.submissionType=v,setRequestId:()=>{},setSubmissionConfirmed:()=>{},setSubmissionMessage:()=>{},setFiles:()=>{},navigate:()=>{}};
 const hook={exports:{},require:()=>({useCallback:f=>f,useRef:value=>({current:value}),useState:initial=>[initial(),()=>{}]})};
 runInNewContext(ts.transpileModule(fs.readFileSync('apps/staff/src/useAsyncAction.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,hook);
 Object.assign(ctx,hook.exports.useAsyncAction(),{selectedAssignedJob:{id:'A'},requestId:''});
 ctx.processingSubmission=false;const guardStart=source.indexOf('  function isSubmissionActionPending()'),guardEnd=source.indexOf('\n  }',guardStart)+4;runInNewContext(ts.transpileModule(source.slice(guardStart,guardEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 runInNewContext(code,ctx);return{ctx,state};
}
const cases=[];const test=(name,fn)=>cases.push({name,fn});
const detail=(id,jobId="A",type="report")=>({request:{id,jobId,type,reasons:[],note:"",status:"open"},source:null,replacements:[]});
for(const failOld of [false,true])test(`history reverse response ${failOld?'failure':'success'}`,async()=>{
 const {ctx,state}=setup();const old=ctx.loadSubmissionHistory('A','report');const latest=ctx.loadSubmissionHistory('B','report');
 state.calls[1].resolve({data:{submissions:[{id:'B',files:[]}]}});assert.equal(await latest,true);
 if(failOld)state.calls[0].reject(Error('offline'));else state.calls[0].resolve({data:{submissions:[{id:'A',files:[]}]}});
 assert.equal(await old,false);assert.equal(state.history[0].id,'B');assert.equal(state.status,'ready');
});
for(const failOld of [false,true])test(`detail reverse response ${failOld?'failure':'success'}`,async()=>{
 const {ctx,state}=setup();const old=ctx.loadResubmissionDetail('A');const latest=ctx.loadResubmissionDetail('B');
 state.calls[1].resolve({data:detail('B')});assert.equal(await latest,true);
 if(failOld)state.calls[0].reject(Error('offline'));else state.calls[0].resolve({data:detail('A')});
 assert.equal(await old,false);assert.equal(state.detail.request.id,'B');
});
for(const loader of ['history','detail'])test(`${loader} auth invalidation`,async()=>{
 const {ctx,state}=setup();const pending=loader==='history'?ctx.loadSubmissionHistory('A','report'):ctx.loadResubmissionDetail('A');ctx.authLoadVersionRef.current++;
 state.calls[0].resolve({data:loader==='history'?{submissions:[{id:'A',files:[]}]}:detail('A')});assert.equal(await pending,false);assert.equal(state.detail,null);assert.equal(state.history.length,0);
});
for(const failOld of [false,true])test(`prepare initial invalidates old detail ${failOld}`,async()=>{
 const {ctx,state}=setup();const old=ctx.prepareSubmission('report',{id:'A'},'request-A');const latest=ctx.prepareSubmission('sales_floor',{id:'B'});
 state.calls[2].resolve({data:{submissions:[{id:'B',files:[]}]}});await latest;
 state.calls[0].resolve({data:{submissions:[{id:'A',files:[]}]}});
 if(failOld)state.calls[1].reject(Error('offline'));else state.calls[1].resolve({data:detail('request-A')});
 await old;assert.equal(state.detail,null);assert.equal(state.history[0].id,'B');assert.equal(state.messages.length,0);
});
test('current history error remains actionable',async()=>{const {ctx,state}=setup();const task=ctx.loadSubmissionHistory('A','report');state.calls[0].reject(Error('offline'));await assert.rejects(task,/offline/);assert.equal(state.status,'error');});
test('current detail error remains actionable',async()=>{const {ctx,state}=setup();const task=ctx.loadResubmissionDetail('A');state.calls[0].reject(Error('offline'));await assert.rejects(task,/offline/);});
for(const data of [{request:{id:'B',reasons:[]},replacements:[]},{request:{id:'A'},replacements:[]},null])test(`invalid detail ${JSON.stringify(data)}`,async()=>{const {ctx,state}=setup();const task=ctx.loadResubmissionDetail('A');state.calls[0].resolve({data});await assert.rejects(task);assert.equal(state.detail,null);});
test('malformed history is not successful empty history',async()=>{const {ctx,state}=setup();const task=ctx.loadSubmissionHistory('A','report');state.calls[0].resolve({data:{}});await assert.rejects(task);assert.equal(state.status,'error');});
test('preview refresh cannot overwrite newer history',async()=>{
 const {ctx,state}=setup();const preview=ctx.refreshFilePreview({id:'file',submissionId:'old'});assert.equal(JSON.stringify(state.calls[0].input),JSON.stringify({jobId:'A',type:'report',previewFile:{submissionId:'old',fileId:'file'}}));const history=ctx.loadSubmissionHistory('A','report');assert.equal(state.calls[1].input.previewFile,undefined);
 state.calls[1].resolve({data:{submissions:[{id:'new',files:[]}]}});await history;
 state.calls[0].resolve({data:{submissions:[{id:'old',files:[{id:'file',submissionId:'old',previewUrl:'refreshed'}]}]}});
 assert.equal(await preview,'refreshed');assert.equal(state.history[0].id,'new');
});
test('preview invalidated immediately by preparing another submission',async()=>{
 const {ctx,state}=setup();const preview=ctx.refreshFilePreview({id:'file',submissionId:'old'});const next=ctx.prepareSubmission('report',{id:'B'});
 state.calls[0].resolve({data:{submissions:[{files:[{id:'file',submissionId:'old',previewUrl:'obsolete'}]}]}});assert.equal(await preview,null);
 state.calls[1].resolve({data:{submissions:[]}});await next;
});

test('manual retry removes previous notice before waiting and restores current result',async()=>{
 const {ctx,state}=setup();ctx.showSubmissionMessage('前回の読込に失敗しました。');
 let pending=ctx.refreshSubmissionInformation();assert.equal(state.visibleMessage,'');assert.equal(state.clears,1);assert.equal(ctx.isPending('submission-refresh'),true);
 await ctx.refreshSubmissionInformation();assert.equal(state.clears,1);assert.equal(state.calls.length,1);
 state.calls[0].reject(Error('再読込に失敗しました。'));await pending;assert.match(state.visibleMessage,/提出情報を再読み込み/);
 pending=ctx.refreshSubmissionInformation();assert.equal(state.visibleMessage,'');assert.equal(state.clears,2);
 state.calls[1].resolve({data:{submissions:[]}});await pending;assert.equal(state.visibleMessage,'提出情報を更新しました。');
});

for(const failed of ['history','detail'])for(const navigated of [false,true])test('prepare waits for both reads '+failed+' navigation '+navigated,async()=>{
 const {ctx,state}=setup();let finished=false;const pending=ctx.prepareSubmission('report',{id:'A'},'req').then(()=>{finished=true;});
 const bad=failed==='history'?0:1,other=1-bad;state.calls[bad].reject(Error('offline'));
 for(let tick=0;tick<20;tick++)await Promise.resolve();assert.equal(finished,false);assert.equal(state.messages.length,0);
 if(navigated)ctx.navigationVersionRef.current++;
 state.calls[other].resolve({data:other===0?{submissions:[]}:detail('req')});await pending;
 assert.equal(state.messages.length,navigated?0:1);if(!navigated)assert.match(state.messages[0],/「提出情報を再読み込み」/);
});
for(const request of ['', 'request-A'])test('manual refresh success and synchronous double click '+request,async()=>{
 const {ctx,state}=setup();ctx.requestId=request;
 const pending=ctx.refreshSubmissionInformation();await ctx.refreshSubmissionInformation();
 assert.equal(state.calls.length,request?2:1);assert.equal(ctx.isPending('submission-refresh'),true);
 state.calls[0].resolve({data:{submissions:[]}});if(request)state.calls[1].resolve({data:detail(request)});
 await pending;assert.equal(ctx.isPending('submission-refresh'),false);assert.equal(state.messages.at(-1),'提出情報を更新しました。');
});
for(const change of ['none','auth','context'])test('manual refresh failure isolation '+change,async()=>{
 const {ctx,state}=setup();const pending=ctx.refreshSubmissionInformation();
 if(change==='auth')ctx.authLoadVersionRef.current++;if(change==='context')ctx.submissionContextVersionRef.current++;
 state.calls[0].reject(Error('offline'));await pending;
 assert.equal(ctx.isPending('submission-refresh'),false);assert.equal(state.messages.length,change==='none'?1:0);
});
test('detail failure can be retried even with ready history',async()=>{
 const {ctx,state}=setup();ctx.requestId='request-A';let pending=ctx.refreshSubmissionInformation();
 state.calls[0].resolve({data:{submissions:[]}});state.calls[1].reject(Error('offline'));await pending;assert.equal(state.status,'ready');assert.equal(state.detail,null);
 pending=ctx.refreshSubmissionInformation();state.calls[2].resolve({data:{submissions:[]}});state.calls[3].resolve({data:detail('request-A')});await pending;assert.equal(state.detail.request.id,'request-A');
});

for(const mode of ['valid','cancelled','foreign-company','foreign-staff','unassigned','missing','auth-change','newer-list'])test('refresh selected job '+mode,async()=>{
 const {ctx,state}=setup();Object.assign(ctx,{pastShiftVersionRef:{current:0},db:{},companyId:'company',staffId:'staff',doc:()=>({}),setMyJobs:update=>state.jobs=update(state.jobs),setSelectedJob:update=>state.selected=update(state.selected)});state.jobs=[{id:'A'},{id:'B'}];state.selected={id:'A'};
 let resolve;ctx.getDocFromServer=()=>new Promise(done=>resolve=done);
 const from=source.indexOf('  async function refreshSelectedJob('),to=source.indexOf('  async function requestLogin(',from);runInNewContext(ts.transpileModule(source.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 const pending=ctx.refreshSelectedJob('A');if(mode==='auth-change')ctx.authLoadVersionRef.current++;if(mode==='newer-list')ctx.pastShiftVersionRef.current++;
 const data={id:'B',companyId:mode==='foreign-company'?'other':'company',assignedStaffId:mode==='foreign-staff'?'other':'staff',status:mode==='unassigned'?'open':'assigned',cancelled:mode==='cancelled',storeName:'updated'};
 resolve({exists:()=>mode!=='missing',id:'A',data:()=>data});assert.equal(await pending,mode==='valid');
 if(mode==='valid'){assert.equal(state.selected.storeName,'updated');assert.equal(state.jobs.length,2);assert.equal(state.selected.id,'A');assert.equal(state.jobs[0].id,'A');assert.equal(state.jobs[1].id,'B');assert.equal(state.jobs[1].storeName,undefined);}else if(mode==='auth-change'||mode==='newer-list'){assert.equal(state.jobs.length,2);assert.equal(state.selected.id,'A');}else{assert.equal(state.jobs.length,1);assert.equal(state.jobs[0].id,'B');assert.equal(state.selected,null);}
});

for(const [jobId,type] of [['B','report'],['A','sales_floor']])test('detail refuses mismatched job/type '+jobId+' '+type,async()=>{const {ctx,state}=setup();const task=ctx.loadResubmissionDetail('req');state.calls[0].resolve({data:detail('req',jobId,type)});await assert.rejects(task);assert.equal(state.detail,null);});
test('prepare detail uses explicit next job/type before React state commit',async()=>{const {ctx,state}=setup();ctx.setSelectedJob=()=>{};ctx.setSubmissionType=()=>{};const task=ctx.prepareSubmission('sales_floor',{id:'B'},'req');assert.equal(state.calls[1].input.requestId,'req');state.calls[0].resolve({data:{submissions:[]}});state.calls[1].resolve({data:detail('req','B','sales_floor')});await task;assert.equal(state.detail.request.jobId,'B');assert.equal(state.detail.request.type,'sales_floor');assert.equal(state.messages.length,0);});
test('manual detail refresh verifies explicit selected assigned job',async()=>{const {ctx,state}=setup();ctx.selectedAssignedJob={id:'B'};ctx.requestId='req';const task=ctx.refreshSubmissionInformation();state.calls[0].resolve({data:{submissions:[]}});state.calls[1].resolve({data:detail('req','B')});await task;assert.equal(state.detail.request.jobId,'B');assert.equal(state.messages.at(-1),'提出情報を更新しました。');});

const historyFile={id:'file',submissionId:'group',originalName:'report.png',driveName:'',contentType:'image/png',purpose:'initial',status:'completed',previewUrl:null};
for(const invalid of [null,{id:'group'},{id:'group',files:null},{id:'group',files:[null]},{id:'group',files:[{...historyFile,contentType:null}]},{id:'group',files:[{...historyFile,originalName:{}}]},{id:'group',files:[{...historyFile,previewUrl:42}]},{id:'group',files:[{...historyFile,submissionId:'other'}]}])test('malformed history group '+JSON.stringify(invalid),async()=>{const {ctx,state}=setup();state.history=[{id:'preserved',files:[]}];const pending=ctx.loadSubmissionHistory('A','report');state.calls[0].resolve({data:{submissions:[invalid]}});await assert.rejects(pending);assert.equal(state.status,'error');assert.equal(state.history[0].id,'preserved');});
for(const [name,groups] of [
 ['duplicate groups',[{id:'group',files:[]},{id:'group',files:[]}]],
 ['duplicate files',[{id:'group',files:[historyFile,{...historyFile,originalName:'different.png'}]}]],
 ['blank group',[{id:'   ',files:[]}]],
 ['blank file',[{id:'group',files:[{...historyFile,id:'   '}]}]],
])test('history identity rejects '+name,async()=>{
 const {ctx,state}=setup();state.history=[{id:'preserved',files:[]}];let pending=ctx.loadSubmissionHistory('A','report');state.calls[0].resolve({data:{submissions:groups}});await assert.rejects(pending);assert.equal(state.status,'error');assert.equal(state.history[0].id,'preserved');
 pending=ctx.loadSubmissionHistory('A','report');state.calls[1].resolve({data:{submissions:[{id:'group',files:[historyFile]}]}});assert.equal(await pending,true);assert.equal(state.status,'ready');assert.equal(state.history[0].id,'group');
});
test('same local file id in different submissions remains valid',async()=>{
 const {ctx,state}=setup();const pending=ctx.loadSubmissionHistory('A','report');state.calls[0].resolve({data:{submissions:['group','other'].map(id=>({id,files:[{...historyFile,submissionId:id}]}))}});assert.equal(await pending,true);assert.equal(state.history.length,2);
});
test('valid history nullable preview and empty name',async()=>{const {ctx,state}=setup();const pending=ctx.loadSubmissionHistory('A','report');state.calls[0].resolve({data:{submissions:[{id:'group',files:[historyFile]}]}});assert.equal(await pending,true);assert.equal(state.history[0].files[0].previewUrl,null);});
for(const mode of ['reason-object','note-object','status-object','source-missing','source-content-type','source-preview','replacement-null'])test('detail rejects invalid display data '+mode,async()=>{const {ctx,state}=setup();const value=detail('request');if(mode==='reason-object')value.request.reasons=[{}];if(mode==='note-object')value.request.note={};if(mode==='status-object')value.request.status={};if(mode==='source-missing')delete value.source;if(mode==='source-content-type')value.source={...historyFile,contentType:null};if(mode==='source-preview')value.source={...historyFile,previewUrl:{}};if(mode==='replacement-null')value.replacements=[null];const preserved={request:{id:'preserved'}};state.detail=preserved;const pending=ctx.loadResubmissionDetail('request');state.calls[0].resolve({data:value});await assert.rejects(pending);assert.equal(state.detail,preserved);});
test('detail accepts valid source and replacement',async()=>{const {ctx,state}=setup();const value=detail('request');value.source=historyFile;value.replacements=[{...historyFile,id:'replacement'}];const pending=ctx.loadResubmissionDetail('request');state.calls[0].resolve({data:value});assert.equal(await pending,true);assert.equal(state.detail.source.id,'file');});
for(const target of ['source','replacement'])for(const field of ['id','submissionId'])test('comparison rejects blank file identity '+target+' '+field,async()=>{
 const {ctx,state}=setup();const prior={request:{id:'prior'}};state.detail=prior;
 const invalid=detail('request');const file={...historyFile,[field]:' \t '};if(target==='source')invalid.source=file;else invalid.replacements=[file];
 let pending=ctx.loadResubmissionDetail('request');state.calls.at(-1).resolve({data:invalid});await assert.rejects(pending,/表示項目/);assert.equal(state.detail,prior);
 const valid=detail('request');if(target==='source')valid.source=historyFile;else valid.replacements=[historyFile];
 pending=ctx.loadResubmissionDetail('request');state.calls.at(-1).resolve({data:valid});assert.equal(await pending,true);assert.equal(state.detail,valid);
});
for(const mode of ['success','job-unavailable','tasks-failure','tasks-unconfirmed'])test('manual refresh restores business completion '+mode,async()=>{const {ctx,state}=setup();if(mode==='job-unavailable')ctx.refreshSelectedJob=async()=>{state.jobRefreshes++;return false;};if(mode==='tasks-unconfirmed')ctx.loadTasks=async()=>{state.taskRefreshes++;return false;};if(mode==='tasks-failure')ctx.loadTasks=async()=>{state.taskRefreshes++;throw Error('synthetic tasks offline');};const pending=ctx.refreshSubmissionInformation();state.calls[0].resolve({data:{submissions:[]}});await pending;assert.equal(state.jobRefreshes,1);assert.equal(state.taskRefreshes,1);assert.equal(ctx.isPending('submission-refresh'),false);if(mode==='success')assert.equal(state.messages.at(-1),'提出情報を更新しました。');else{assert.match(state.messages.at(-1),/一部を確認できません/);assert.match(state.messages.at(-1),/提出情報を再読み込み/);ctx.refreshSelectedJob=async()=>true;ctx.loadTasks=async()=>[];const retry=ctx.refreshSubmissionInformation();state.calls[1].resolve({data:{submissions:[]}});await retry;assert.equal(ctx.isPending('submission-refresh'),false);assert.equal(state.messages.at(-1),'提出情報を更新しました。');}});
test('manual refresh demo skips remote business reads',async()=>{const {ctx,state}=setup();ctx.firebaseConfigured=false;ctx.requestId='request';await ctx.refreshSubmissionInformation();assert.equal(state.jobRefreshes,0);assert.equal(state.taskRefreshes,0);assert.equal(state.messages.at(-1),'提出情報を更新しました。');});
for(const delayed of ['detail','job','tasks'])test('manual refresh keeps lock after early history failure '+delayed,async()=>{
 const {ctx,state}=setup();let release;const gate=new Promise(resolve=>release=resolve);
 if(delayed==='detail')ctx.requestId='request';if(delayed==='job')ctx.refreshSelectedJob=()=>gate;if(delayed==='tasks')ctx.loadTasks=()=>gate;
 const pending=ctx.refreshSubmissionInformation();state.calls[0].reject(Error('offline'));
 for(let tick=0;tick<20;tick++)await Promise.resolve();
 const held=ctx.isPending('submission-refresh');const messages=state.messages.length;
 if(delayed==='detail')state.calls[1].resolve({data:detail('request')});else release(true);
 await pending;assert.equal(held,true);assert.equal(messages,0);assert.equal(ctx.isPending('submission-refresh'),false);assert.equal(state.messages.length,1);assert.notEqual(state.messages[0],'提出情報を更新しました。');
});
for(const [name,data,expected] of [
 ['null',null,null],['missing',{},null],['non-array',{submissions:{}},null],
 ['null group',{submissions:[null]},null],['missing files',{submissions:[{id:'target'}]},null],
 ['wrong group',{submissions:[{id:'other',files:[{id:'file',submissionId:'target',previewUrl:'wrong'}]}]},null],
 ['duplicate groups',{submissions:[1,2].map(()=>({id:'target',files:[{id:'file',submissionId:'target',previewUrl:'wrong'}]}))},null],
 ['duplicate files',{submissions:[{id:'target',files:[1,2].map(()=>({id:'file',submissionId:'target',previewUrl:'wrong'}))}]},null],
 ...[null,42,'   ','renewed'].map(url=>['url '+JSON.stringify(url),{submissions:[{id:'target',files:[null,{id:'file',submissionId:'target',previewUrl:url}]}]},url==='renewed'?'renewed':null]),
])test('preview exact identity '+name,async()=>{
 const {ctx,state}=setup();const pending=ctx.refreshFilePreview({id:'file',submissionId:'target'});state.calls[0].resolve({data});assert.equal(await pending,expected);assert.equal(state.history.length,0);
});
for(const url of [null,42,'   '])test('source preview rejects invalid url '+JSON.stringify(url),async()=>{
 const {ctx,state}=setup();const file={id:'source',submissionId:'old'};ctx.requestId='request';ctx.resubmissionDetail={source:file};const pending=ctx.refreshFilePreview(file);state.calls[0].resolve({data:{request:{id:'request',jobId:'A',type:'report'},source:{...file,previewUrl:url}}});assert.equal(await pending,null);
});
for(const initialStatus of ['waiting_upload','processing','paused_global','error','unknown'])test('history transfer recovery preserves selected files '+initialStatus,async()=>{
 const {ctx,state}=setup();const selected=[{name:'selected.png',previewUrl:'blob:selected',file:{name:'selected.png'}}];ctx.files=selected;ctx.submissionConfirmed=true;
 ctx.setFiles=()=>assert.fail('History refresh must not change selected files');ctx.setSubmissionConfirmed=()=>assert.fail('History refresh must not change confirmation');
 const historyFile={id:'history-file',submissionId:'history',originalName:'history.png',driveName:'',contentType:'image/png',purpose:'initial',status:initialStatus,previewUrl:null};
 const historyComponent={exports:{},require:name=>name==='./SubmissionPreviewImage'?{__esModule:true,default:()=>require('react').createElement('i',{'data-preview':'ready'})}:require(name)};
 runInNewContext(ts.transpileModule(fs.readFileSync('apps/staff/src/SubmissionHistoryFiles.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,historyComponent);
 const render=()=>require('react-dom/server').renderToStaticMarkup(require('react').createElement(historyComponent.exports.default,{files:state.history.flatMap(group=>group.files),onRefreshPreview:()=>assert.fail('Rendering must not fetch')}));
 let pending=ctx.refreshSubmissionInformation();state.calls.at(-1).resolve({data:{submissions:[{id:'history',files:[historyFile]}]}});await pending;
 assert.equal(state.status,'ready');assert.match(render(),/提出情報を再読み込み/);assert.ok(!render().includes('data-preview'));
 const prior=state.history;pending=ctx.refreshSubmissionInformation();state.calls.at(-1).reject(Error('synthetic offline'));await pending;
 assert.equal(state.status,'error');assert.equal(state.history,prior);assert.equal(ctx.files,selected);assert.equal(ctx.submissionConfirmed,true);
 pending=ctx.refreshSubmissionInformation();state.calls.at(-1).resolve({data:{submissions:[{id:'history',files:[{...historyFile,status:'completed',previewUrl:'synthetic-preview'}]}]}});await pending;
 assert.equal(state.status,'ready');assert.match(render(),/Drive保存済み/);assert.match(render(),/data-preview="ready"/);assert.ok(!render().includes('状態が変わらない場合'));assert.equal(ctx.files,selected);assert.equal(ctx.submissionConfirmed,true);assert.equal(state.messages.at(-1),'提出情報を更新しました。');assert.equal(ctx.isSubmissionActionPending(),false);
});
const results=[];for(const mode of ['valid','wrong-job','wrong-request','account','context','missing'])test('source preview outside history '+mode,async()=>{const {ctx,state}=setup();const file={id:'old-file',submissionId:'old-submission',previewUrl:'old'};ctx.requestId='request';ctx.resubmissionDetail={source:file};const pending=ctx.refreshFilePreview(file);assert.equal(state.calls[0].name,'getResubmissionComparison');assert.equal(state.calls[0].input.requestId,'request');if(mode==='account')ctx.authLoadVersionRef.current++;if(mode==='context')ctx.submissionContextVersionRef.current++;state.calls[0].resolve({data:{request:{id:mode==='wrong-request'?'other':'request',jobId:mode==='wrong-job'?'other':'A',type:'report'},source:mode==='missing'?null:{...file,previewUrl:'renewed'},replacements:[]}});assert.equal(await pending,mode==='valid'?'renewed':null);assert.equal(state.history.length,0);});
for(const mode of ['current','auth-change','newer-list'])test('selected job server failure '+mode,async()=>{const {ctx,state}=setup();let reject,cacheReads=0;Object.assign(ctx,{db:{},companyId:'company',staffId:'staff',pastShiftVersionRef:{current:0},doc:()=>({}),getDoc:async()=>{cacheReads++;return {exists:()=>true,id:'A',data:()=>({status:'assigned'})};},getDocFromServer:()=>new Promise((_,fail)=>reject=fail),setMyJobs:update=>state.jobs=update(state.jobs),setSelectedJob:update=>state.selected=update(state.selected)});state.jobs=[{id:'A',storeName:'preserved'}];state.selected=state.jobs[0];const jobs=state.jobs,selected=state.selected;const from=source.indexOf('  async function refreshSelectedJob('),to=source.indexOf('  async function requestLogin(',from);runInNewContext(ts.transpileModule(source.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);const pending=ctx.refreshSelectedJob('A');if(mode==='auth-change')ctx.authLoadVersionRef.current++;if(mode==='newer-list')ctx.pastShiftVersionRef.current++;reject(Error('server offline'));if(mode==='current')await assert.rejects(pending,/server offline/);else assert.equal(await pending,false);assert.equal(cacheReads,0);assert.equal(state.jobs,jobs);assert.equal(state.selected,selected);if(mode==='current'){ctx.getDocFromServer=async()=>({exists:()=>true,id:'A',data:()=>({companyId:'company',assignedStaffId:'staff',status:'assigned',storeName:'fresh'})});assert.equal(await ctx.refreshSelectedJob('A'),true);assert.equal(state.selected.storeName,'fresh');}});

for(const key of ['shift-action','submission-context','submission-files','task-job','uploadSubmission'])test('manual refresh blocked by mutation '+key,async()=>{const {ctx,state}=setup();let release;const pending=ctx.run(key,()=>new Promise(done=>release=done));await ctx.refreshSubmissionInformation();assert.equal(state.calls.length,0);assert.equal(state.jobRefreshes,0);assert.equal(state.clears,0);release();await pending;assert.equal(ctx.isSubmissionActionPending(),false);});
for(const mode of ['hydrating','processing'])test('manual refresh blocked by '+mode,async()=>{const {ctx,state}=setup();if(mode==='hydrating')ctx.draftHydratingRef.current=true;else ctx.processingSubmission=true;await ctx.refreshSubmissionInformation();assert.equal(state.calls.length,0);assert.equal(state.clears,0);});
test('manual refresh holds shared submission guard until reads finish',async()=>{const {ctx,state}=setup();const pending=ctx.refreshSubmissionInformation();assert.equal(ctx.isSubmissionActionPending(),true);await ctx.refreshSubmissionInformation();assert.equal(state.calls.length,1);state.calls[0].resolve({data:{submissions:[]}});await pending;assert.equal(ctx.isSubmissionActionPending(),false);});

for(const previous of ['old submission notice','unrelated notice'])test('prepare clears only matching old notice '+previous,async()=>{
 const {ctx,state}=setup();ctx.submissionMessage='old submission notice';state.visibleMessage=previous;let inline='old submission notice';ctx.setSubmissionMessage=v=>inline=v;
 const pending=ctx.prepareSubmission('report',{id:'B'});assert.equal(inline,'');assert.equal(state.visibleMessage,previous==='old submission notice'?'':previous);state.visibleMessage='new notification during read';state.calls[0].resolve({data:{submissions:[]}});await pending;assert.equal(state.visibleMessage,'new notification during read');assert.equal(state.messages.length,0);
});

for(const failed of ['history','detail'])for(const change of ['none','auth','context','navigation'])test('prepare unconfirmed '+failed+' '+change,async()=>{
 const {ctx,state}=setup(),gates={};ctx.loadSubmissionHistory=()=>new Promise(resolve=>gates.history=resolve);ctx.loadResubmissionDetail=()=>new Promise(resolve=>gates.detail=resolve);let finished=false;
 const pending=ctx.prepareSubmission('report',{id:'B'},'req').then(()=>finished=true);gates[failed](false);for(let i=0;i<8;i++)await Promise.resolve();assert.equal(finished,false);assert.equal(state.messages.length,0);
 if(change==='auth')ctx.authLoadVersionRef.current++;if(change==='context')ctx.submissionContextVersionRef.current++;if(change==='navigation')ctx.navigationVersionRef.current++;gates[failed==='history'?'detail':'history'](true);await pending;
 assert.equal(state.messages.length,change==='none'?1:0);if(change==='none')assert.match(state.messages[0],/「提出情報を再読み込み」/);
});

for(const firstFinishesFirst of [false,true])for(const failOld of [false,true])test('selected job newest read wins '+firstFinishesFirst+' '+failOld,async()=>{
 const {ctx,state}=setup(),gates=[];state.jobs=[{id:'A',storeName:'initial'}];state.selected=state.jobs[0];
 Object.assign(ctx,{db:{},companyId:'company',staffId:'staff',pastShiftVersionRef:{current:0},doc:()=>({}),getDocFromServer:()=>new Promise((resolve,reject)=>gates.push({resolve,reject})),setMyJobs:update=>state.jobs=update(state.jobs),setSelectedJob:update=>state.selected=update(state.selected)});
 const from=source.indexOf('  async function refreshSelectedJob('),to=source.indexOf('  async function requestLogin(',from);runInNewContext(ts.transpileModule(source.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 const snap=name=>({exists:()=>true,id:'A',data:()=>({companyId:'company',assignedStaffId:'staff',status:'assigned',storeName:name})});
 const old=ctx.refreshSelectedJob('A'),latest=ctx.refreshSelectedJob('A');const finishOld=()=>failOld?gates[0].reject(Error('old failed')):gates[0].resolve(snap('old'));
 if(firstFinishesFirst){finishOld();assert.equal(await old,false);assert.equal(state.selected.storeName,'initial');}
 gates[1].resolve(snap('latest'));assert.equal(await latest,true);
 if(!firstFinishesFirst){finishOld();assert.equal(await old,false);}
 assert.equal(state.selected.storeName,'latest');assert.equal(state.jobs[0].storeName,'latest');
 const version=ctx.pastShiftVersionRef.current;assert.equal(await ctx.refreshSelectedJob('A',0),false);assert.equal(gates.length,2);assert.equal(ctx.pastShiftVersionRef.current,version);
});

for(const newest of ['selected','task'])for(const olderFirst of [false,true])test('task and selected read ordering '+newest+' '+olderFirst,async()=>{
 const {ctx,state}=setup(),gates=[];state.jobs=[{id:'A',storeName:'initial'}];state.selected=state.jobs[0];
 Object.assign(ctx,{db:{},companyId:'company',staffId:'staff',pastShiftVersionRef:{current:0},orderAssignedJobs:jobs=>jobs,doc:()=>({}),getDocFromServer:()=>new Promise(resolve=>gates.push(resolve)),setMyJobs:update=>state.jobs=update(state.jobs),setSelectedJob:update=>state.selected=update(state.selected)});
 for(const [fromMarker,toMarker] of [['  async function refreshSelectedJob(','  async function requestLogin('],['  async function loadTaskJob(','  async function fetchTasks(']]){const from=source.indexOf(fromMarker),to=source.indexOf(toMarker,from);runInNewContext(ts.transpileModule(source.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);}
 const snap=name=>({exists:()=>true,id:'A',data:()=>({companyId:'company',assignedStaffId:'staff',status:'assigned',storeName:name})});
 const old=newest==='selected'?ctx.loadTaskJob('A'):ctx.refreshSelectedJob('A');const latest=newest==='selected'?ctx.refreshSelectedJob('A'):ctx.loadTaskJob('A');
 if(olderFirst){gates[0](snap('old'));assert.ok(!await old);assert.equal(state.jobs[0].storeName,'initial');}
 gates[1](snap('latest'));assert.ok(await latest);
 if(!olderFirst){gates[0](snap('old'));assert.ok(!await old);}
 assert.equal(state.jobs[0].storeName,'latest');assert.equal(ctx.isPending('task-job'),false);
});

for(const mode of ['current','auth','newer-read'])test('task job delayed failure '+mode,async()=>{
 const {ctx,state}=setup();let reject;state.jobs=[{id:'A',storeName:'preserved'}];const original=state.jobs;
 Object.assign(ctx,{db:{},companyId:'company',staffId:'staff',pastShiftVersionRef:{current:0},orderAssignedJobs:jobs=>jobs,doc:()=>({}),getDocFromServer:()=>new Promise((_,fail)=>reject=fail),setMyJobs:update=>state.jobs=update(state.jobs)});
 const from=source.indexOf('  async function loadTaskJob('),to=source.indexOf('  async function fetchTasks(',from);runInNewContext(ts.transpileModule(source.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 const pending=ctx.loadTaskJob('A');if(mode==='auth')ctx.authLoadVersionRef.current++;if(mode==='newer-read')ctx.pastShiftVersionRef.current++;
 reject(Error('server failure'));if(mode==='current')await assert.rejects(pending,/server failure/);else assert.equal(await pending,null);
 assert.equal(state.jobs,original);assert.equal(ctx.isPending('task-job'),false);
 ctx.getDocFromServer=async()=>({exists:()=>true,id:'A',data:()=>({companyId:'company',assignedStaffId:'staff',status:'assigned',storeName:'recovered'})});assert.equal((await ctx.loadTaskJob('A')).storeName,'recovered');assert.equal(state.jobs[0].storeName,'recovered');
});

for(const mode of ['busy','decline','stale','accept','same-context'])test('notification submission acceptance '+mode,async()=>{
 const {ctx}=setup(),events=[],files=[{name:'unsent.jpg'}];Object.assign(ctx,{files,selectedAssignedJob:{id:mode==='same-context'?'B':'A'},submissionType:'report',requestId:'req',showSubmissionMessage:()=>{},navigate:()=>events.push('navigate'),discardFilesBeforeContextChange:async()=>{events.push('confirm');if(mode==='stale')ctx.authLoadVersionRef.current++;return mode!=='decline';},prepareSubmission:async()=>events.push('prepare')});
 const from=source.indexOf('  async function startSubmission('),to=source.indexOf('  async function changeSubmissionJob(',from);runInNewContext(ts.transpileModule(source.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);if(mode==='busy')ctx.isSubmissionActionPending=()=>true;
 const accepted=await ctx.startSubmission('report',{id:'B'},'req',()=>events.push('consume'));assert.equal(accepted,['accept','same-context'].includes(mode));assert.equal(ctx.files,files);
 assert.deepEqual(events,mode==='busy'?[]:mode==='accept'?['confirm','consume','prepare']:mode==='same-context'?['consume','navigate']:['confirm']);
});
for(const {name,fn} of cases){try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});}}
console.log(JSON.stringify({passed:results.every(r=>r.passed),count:results.length,results},null,2));process.exitCode=results.every(r=>r.passed)?0:1;
