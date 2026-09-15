import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import {createRequire} from 'node:module';import {resolve} from 'node:path';
const ts=createRequire(resolve(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json'))('typescript'),source=readFileSync('apps/staff/src/App.tsx','utf8');const a=source.indexOf('  async function discardFilesBeforeContextChange('),b=source.indexOf('  function removeSubmissionFile(',a);assert.ok(a>=0&&b>a);const code=ts.transpileModule(source.slice(a,b),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;let count=0;
for(const action of ['start','job','type'])for(const mode of ['success','cancel','failure','auth','context','stale-failure','empty-auth','navigation','navigation-failure']){
 let resolveClear,rejectClear;const gate=new Promise((yes,no)=>{resolveClear=yes;rejectClear=no;});const state={globalMessage:'old notice',files:['old'],clears:[],prepared:[],messages:[],writes:0};const old={id:'old'},next={id:'next'};
 const ctx={submissionMessage:'old notice',setMessage:fn=>{state.globalMessage=fn(state.globalMessage);},files:mode==='empty-auth'?[]:['old'],draftKey:'owned-old-draft',selectedAssignedJob:old,submissionType:'report',requestId:'',myJobs:[old,next],authLoadVersionRef:{current:1},navigationVersionRef:{current:0},submissionContextVersionRef:{current:1},confirm:()=>mode!=='cancel',clearDraft:key=>{state.clears.push(key);return gate;},setFiles:v=>{state.files=v;state.writes++;},setUploadState:()=>state.writes++,setSubmissionConfirmed:()=>state.writes++,setSubmissionMessage:()=>state.writes++,showSubmissionMessage:v=>state.messages.push(v),isSubmissionActionPending:()=>false,run:async(_,fn)=>fn(),navigate:()=>{},prepareSubmission:async(...args)=>state.prepared.push(args)};runInNewContext(code,ctx);
 const task=action==='start'?ctx.startSubmission('report',next,'req'):action==='job'?ctx.changeSubmissionJob('next'):ctx.changeSubmissionType('sales_floor');
 if(['auth','stale-failure','empty-auth'].includes(mode))ctx.authLoadVersionRef.current++;if(mode==='context')ctx.submissionContextVersionRef.current++;if(mode.startsWith('navigation'))ctx.navigationVersionRef.current++;
 if(mode==='auth'||mode==='context'||mode==='stale-failure'){state.files=['new-context'];}
 if(mode==='failure'||mode==='stale-failure'||mode==='navigation-failure')rejectClear(Error('disk'));else resolveClear();await task;
 assert.equal(state.prepared.length,mode==='success'?1:0);assert.equal(state.writes,mode==='success'?4:0);assert.equal(state.globalMessage,mode==='success'?'':'old notice');assert.equal(state.messages.length,mode==='failure'?1:0);if(['auth','context','stale-failure'].includes(mode))assert.deepEqual(state.files,['new-context']);if(mode==='cancel'||mode==='empty-auth')assert.equal(state.clears.length,0);else assert.deepEqual(state.clears,['owned-old-draft']);count++;
}
console.log('Submission context change passed: '+count+' cases, start/job/type, confirm cancel, disk failure, auth/context changes and empty-file microtask race.');

{
 const start=source.indexOf('  async function clearSubmissionFiles()'),end=source.indexOf('  async function chooseSubmission(',start);const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const mode of ['success','cancel','empty','failure','auth','context','auth-failure','context-failure','navigation','navigation-failure']){
  let resolve,reject;const gate=new Promise((yes,no)=>{resolve=yes;reject=no});const state={globalMessage:'old notice',files:['old'],writes:0,messages:[],clears:[]};
  const ctx={submissionMessage:'old notice',setMessage:fn=>{state.globalMessage=fn(state.globalMessage);},fileRemoveFocusRef:{current:null},files:mode==='empty'?[]:['old'],draftKey:'old-key',authLoadVersionRef:{current:1},navigationVersionRef:{current:0},submissionContextVersionRef:{current:1},isSubmissionActionPending:()=>false,confirm:()=>mode!=='cancel',clearDraft:key=>{state.clears.push(key);return gate},setFiles:v=>{state.files=v;state.writes++},setUploadState:()=>state.writes++,setSubmissionConfirmed:()=>state.writes++,setSubmissionMessage:()=>state.writes++,showSubmissionMessage:v=>state.messages.push(v),run:async(_key,fn,options)=>{try{await fn()}catch(error){options.setMessage(error.message);throw error}}};
  runInNewContext(code,ctx);const pending=ctx.clearSubmissionFiles();if(mode.startsWith('auth'))ctx.authLoadVersionRef.current++;if(mode.startsWith('context'))ctx.submissionContextVersionRef.current++;if(mode.startsWith('navigation'))ctx.navigationVersionRef.current++;if(/auth|context|navigation/.test(mode))state.files=['new selection'];if(mode.includes('failure'))reject(Error('disk failed'));else resolve();await pending;
  assert.equal(state.writes,mode==='success'?4:0);assert.equal(state.globalMessage,mode==='success'?'':'old notice');assert.equal(state.messages.length,mode==='failure'?1:0);assert.equal(state.clears.length,['cancel','empty'].includes(mode)?0:1);if(/auth|context|navigation/.test(mode))assert.deepEqual(state.files,['new selection']);assert.equal(ctx.fileRemoveFocusRef.current!==null,mode==='success');
 }
}
console.log('Clear selected files passed: 10 success/cancel/empty/error/auth/context/navigation cases; stale cleanup cannot alter new input.');

{
 const marker=source.indexOf('    const pendingFileFocus=fileRemoveFocusRef.current;'),start=source.lastIndexOf('  useEffect(()=>{',marker),end=source.indexOf('  },[files,isPending("submission-files")]);',marker)+'  },[files,isPending("submission-files")]);'.length;assert.ok(start>=0&&end>start);
 for(const mode of ['next','last','empty','auth','context','navigation','busy']){
  const focused=[],button=index=>({focus:()=>focused.push(index)});const ctx={isPending:()=>mode==='busy',files:[],useEffect:fn=>fn(),fileRemoveFocusRef:{current:{index:mode==='last'?2:0,authVersion:1,contextVersion:1,navigationVersion:1}},authLoadVersionRef:{current:mode==='auth'?2:1},submissionContextVersionRef:{current:mode==='context'?2:1},navigationVersionRef:{current:mode==='navigation'?2:1},submissionPanelRef:{current:{querySelectorAll:()=>mode==='empty'?[]:[button(0),button(1)],querySelector:()=>button('picker')}}};
  runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);if(mode==='busy'){assert.deepEqual(focused,[]);assert.ok(ctx.fileRemoveFocusRef.current);ctx.isPending=()=>false;runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);}assert.deepEqual(focused,['auth','context','navigation'].includes(mode)?[]:[mode==='empty'?'picker':mode==='last'?1:0]);assert.equal(ctx.fileRemoveFocusRef.current,null);
 }
}
console.log('File removal focus: next/previous remaining item or picker, with auth/context/navigation isolation.');

{
 const start=source.indexOf('  useEffect(()=>{const available=Boolean(selectedAssignedJob)'),end=source.indexOf(String.fromCharCode(10),start);assert.ok(start>0&&end>start);const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const before of [false,true])for(const after of [false,true])for(const view of ['submit','home'])for(const bodyActive of [false,true]){
  const body={};let focused=0;const ctx={selectedAssignedJob:after?{id:'job'}:null,previousSubmissionAvailableRef:{current:before},view,document:{body,activeElement:bodyActive?body:{}},submissionPanelRef:{current:{focus:()=>focused++}},useEffect:fn=>fn()};
  runInNewContext(code,ctx);assert.equal(focused,before!==after&&view==='submit'&&bodyActive?1:0);assert.equal(ctx.previousSubmissionAvailableRef.current,after);runInNewContext(code,ctx);assert.equal(focused,before!==after&&view==='submit'&&bodyActive?1:0);
 }
 console.log('Submission panel replacement focus: 16 availability/view/active-element combinations; restore only lost focus, preserve other controls and repeated updates.');
}

{
 const discard=source.slice(source.indexOf('  async function discardFilesBeforeContextChange('),source.indexOf('  async function startSubmission('));const clear=source.slice(source.indexOf('  async function clearSubmissionFiles('),source.indexOf('  async function chooseSubmission('));const code=ts.transpileModule(discard+clear,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const action of ['discardFilesBeforeContextChange','clearSubmissionFiles']){
  let resolve;const state={global:'old notice',inline:'old notice'};const ctx={files:[{}],draftKey:'key',submissionMessage:'old notice',authLoadVersionRef:{current:1},submissionContextVersionRef:{current:1},navigationVersionRef:{current:1},fileRemoveFocusRef:{current:null},confirm:()=>true,isSubmissionActionPending:()=>false,clearDraft:()=>new Promise(yes=>{resolve=yes}),setFiles:()=>{},setUploadState:()=>{},setSubmissionConfirmed:()=>{},setSubmissionMessage:v=>state.inline=v,setMessage:fn=>{state.global=fn(state.global)},run:async(_key,fn)=>fn()};
  runInNewContext(code,ctx);const pending=ctx[action]('confirm');state.global='new unrelated notification';resolve();await pending;assert.equal(state.inline,'');assert.equal(state.global,'new unrelated notification');
 }
 console.log('Clear/context notices: old matching global notices clear only on success; two in-flight unrelated notifications remain intact.');
}

{
 const start=source.indexOf('  function removeSubmissionFile('),end=source.indexOf('  function addSubmissionFiles(',start);assert.ok(start>0&&end>start);const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const mode of ['removed','missing','locked'])for(const global of ['old notice','unrelated notice']){
  const first={name:'first'},second={name:'second'},state={files:[first,second],upload:{first:'error',second:'ready'},confirmed:true,inline:'old notice',global};
  const ctx={files:state.files,submissionMessage:'old notice',fileStateKey:file=>file.name,isSubmissionActionPending:()=>mode==='locked',authLoadVersionRef:{current:1},submissionContextVersionRef:{current:1},navigationVersionRef:{current:1},fileRemoveFocusRef:{current:null},setFiles:fn=>{state.files=fn(state.files)},setUploadState:fn=>{state.upload=fn(state.upload)},setSubmissionConfirmed:v=>state.confirmed=v,setSubmissionMessage:v=>state.inline=v,setMessage:fn=>{state.global=fn(state.global)}};
  runInNewContext(code,ctx);ctx.removeSubmissionFile(mode==='missing'?{name:'missing'}:first);const removed=mode==='removed';assert.equal(state.files.length,removed?1:2);assert.equal(state.files.at(-1),second);assert.equal(state.confirmed,!removed);assert.equal(state.inline,removed?'':'old notice');assert.equal(state.global,removed&&global==='old notice'?'':global);assert.equal(state.upload.second,'ready');assert.equal(ctx.fileRemoveFocusRef.current!==null,removed);
 }
 console.log('Single file removal notices: 6 success/missing/locked and matching/unrelated cases retain remaining files and clear only obsolete notices.');
}

{
 const start=source.indexOf('  useEffect(()=>{const newlyBlocked='),end=source.indexOf(String.fromCharCode(10),start);assert.ok(start>0&&end>start);const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const before of [false,true])for(const blocked of [false,true])for(const view of ['submit','home'])for(const bodyActive of [false,true]){
  let focus=0;const body={},ctx={previousResubmissionBlockedRef:{current:before},resubmissionSendBlocked:blocked,view,document:{body,activeElement:bodyActive?body:{}},submissionPanelRef:{current:{focus:()=>focus++}},useEffect:fn=>fn()};
  runInNewContext(code,ctx);const expected=!before&&blocked&&view==='submit'&&bodyActive?1:0;assert.equal(focus,expected);runInNewContext(code,ctx);assert.equal(focus,expected);assert.equal(ctx.previousResubmissionBlockedRef.current,blocked);
 }
 console.log('Resubmission availability focus: 16 transitions restore lost focus only when becoming unavailable; reopening and other controls keep their position.');
}
