import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext as runFixture} from 'node:vm';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const ts=createRequire(resolve(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json'))('typescript');
const app=readFileSync('apps/staff/src/App.tsx','utf8');
const start=app.indexOf('      const bootstrap=httpsCallable(functions,"bootstrapSession");'),marker='      const result=await bootstrapPromise;',end=app.indexOf(marker,start)+marker.length;
assert.ok(start>=0&&end>start);
const code=ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
for(const mode of ['success','failure','stale-failure']){
 const fixture=
  'const assert=require("node:assert/strict");let tokenDone=false,handled=false;const functions={},current={uid:"synthetic"};let restoredCachedData=false,restoredScope=null;'+
  'const httpsCallable=()=>()=>'+(mode==='success'?'Promise.resolve({data:{ok:true}})':'Promise.reject(Error("bootstrap failed"))')+';'+
  'const loadLastBusinessScope=()=>null,restoreCachedBusinessData=()=>false,clearBusinessSnapshot=()=>{};'+
  'const getIdTokenResult=()=>new Promise(resolve=>setImmediate(()=>{tokenDone=true;resolve({claims:{}});}));'+
  'const staffScopeId=value=>typeof value==="string"?value:"";const isCurrentAuthLoad=()=>'+(mode==='stale-failure'?'false':'true')+';'+
  'async function initialize(){'+code+'return result;}'+
  'initialize().then(result=>{assert.equal(tokenDone,true);'+(mode==='success'?'assert.equal(result.data.ok,true);':mode==='stale-failure'?'assert.equal(result,undefined);':'assert.fail("Expected bootstrap failure");')+'handled=true;},error=>{'+(mode==='failure'?'assert.match(error.message,/bootstrap failed/);handled=true;':'throw error;')+'});'+
  'new Promise(resolve=>setTimeout(()=>{assert.equal(handled,true);resolve();},20));';
 await runFixture(fixture,{setTimeout,setImmediate,require:name=>{assert.equal(name,'node:assert/strict');return assert;}});
}
console.log('Startup bootstrap: early rejection observed during delayed token read; current error propagates, stale early exit stays safe, success preserved (strict unhandled-rejection mode).');

{
 const {runInNewContext}=await import('node:vm');const start=app.indexOf('function bootstrapRefreshToken('),end=app.indexOf('function readSavedEmail()',start);assert.ok(start>=0&&end>start);const ctx={};runInNewContext(ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 for(const value of [null,undefined,[],{},'false',false,{refreshToken:'false'},{refreshToken:1}])assert.throws(()=>ctx.bootstrapRefreshToken(value),/初期化の応答/);
 for(const refreshToken of [false,true])assert.equal(ctx.bootstrapRefreshToken({refreshToken}),refreshToken);
 for(const value of [null,undefined,0,true,{},[],['staff'],'','   ','a/b'])assert.equal(ctx.staffScopeId(value),'');
 for(const value of ['staff-1','company_1','日本語ID'])assert.equal(ctx.staffScopeId(value),value);
 console.log('Startup contracts: invalid refresh flags and non-string/empty/path-like scope IDs rejected; boolean flags and valid IDs preserved.');
}

{
 const start=app.indexOf('      const loaded=await loadPrimaryBusinessData(sid,cid,current.uid);');
 const source=ts.createSourceFile('App.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let startupBlock;
 function visit(node){
  if(ts.isTryStatement(node)&&node.tryBlock.getStart(source)<start&&node.tryBlock.end>start&&(!startupBlock||node.tryBlock.end-node.tryBlock.pos<startupBlock.end-startupBlock.pos))startupBlock=node.tryBlock;
  ts.forEachChild(node,visit);
 }
 visit(source);
 assert.ok(start>=0&&startupBlock,'Startup completion must remain inside its actual try block');
 const end=startupBlock.end-1;
 assert.equal(app[end],'}');
 const tail=ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const mode of ['loaded','superseded','auth-changed']){
  const changes=[],followups=[];const ctx={sid:'s',cid:'c',current:{uid:'u'},loadPrimaryBusinessData:async()=>mode!=='superseded',isCurrentAuthLoad:()=>mode!=='auth-changed',setBusinessDataStatus:v=>changes.push(['status',v]),setBusinessDataSource:v=>changes.push(['source',v]),performance:{now:()=>100},loadStarted:10,restoredCachedData:false,setHomeDisplayMs:v=>changes.push(['display',v]),setBusinessRefreshMs:v=>changes.push(['refresh',v]),lastBusinessDataRefreshAt:0,authLoadVersion:1,registerCurrentDevice:async()=>followups.push('device'),refreshOpenJobs:()=>followups.push('jobs'),refreshPushStatus:()=>followups.push('push'),setMessage:()=>assert.fail('Unexpected failure')};
  await Function(...Object.keys(ctx),'return (async()=>{'+tail+'})();')(...Object.values(ctx));
  if(mode==='loaded'){assert.deepEqual(changes,[['status','ready'],['source','live'],['display',90],['refresh',90]]);assert.deepEqual(followups,['jobs','push']);}else{assert.deepEqual(changes,[]);assert.deepEqual(followups,[]);}
 }
 console.log('Startup completion: superseded read never relabels newer/cached state as live or launches follow-up work; accepted and stale-auth outcomes preserved.');
}

{
 const {runInNewContext}=await import('node:vm');
 const parsed=ts.createSourceFile('App.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let callback;
 function inspect(node){
  if(ts.isCallExpression(node)&&node.expression.getText(parsed)==='onAuthStateChanged')callback=node.arguments[1];
  ts.forEachChild(node,inspect);
 }
 inspect(parsed);
 assert.ok(callback,'Staff session callback exists');
 const start=app.indexOf('function bootstrapRefreshToken('),end=app.indexOf('function readSavedEmail()',start);
 const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const listener=callback.getText(parsed);
 const names=Array.from(new Set(listener.match(/\bset[A-Z]\w*(?=\()/g)));
 const makeDeferred=()=>{let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no});return {promise,resolve,reject};};
 const active={role:'staff',companyId:'synthetic-company',staffId:'synthetic-staff'};
 const other={role:'staff',companyId:'other-company',staffId:'other-staff'};
 const cachedJob={id:'synthetic-job'};
 const tick=()=>new Promise(resolve=>setImmediate(resolve));

 function fixture({remembered=active,initial=active,forced=active,acceptsCache=true,primaryError,autoStart=true,priorPresentation={}}={}){
  const server=makeDeferred(),token=makeDeferred(),latest=makeDeferred();
  const changes=[],cacheReads=[],clears=[],requests=[],tokenLookups=[],scrolls=[];
  const state={companyId:'previous-company',staffId:'previous-staff',deviceSessionId:'old-device-session',...priorPresentation};
  const env={firebaseConfigured:true,performance:{now:()=>50},Date,currentUser:null,functions:{},window:{scrollTo:position=>scrolls.push({...position})},
   authLoadVersionRef:{current:0},applicationAttemptsRef:{current:new Map()},preContactDraftsRef:{current:new Map()},
   applicationResultFocusRef:{},businessRefreshInFlightRef:{},mailPanelVersion:{current:0},
   openJobsLoadVersionRef:{current:0},openJobsCursorRef:{},pastShiftVersionRef:{current:0},
   upcomingShiftCursorRef:{},submissionProcessingVersionRef:{current:0},
   lastPushStatusRefreshAt:0,lastBusinessDataRefreshAt:0,orderAssignedJobs:rows=>rows,closeDiagnostics:()=>{},
   httpsCallable:(_functions,name)=>()=>{assert.equal(name,'bootstrapSession');return server.promise;},
   getIdTokenResult:async (_user,force=false)=>{
    tokenLookups.push(force);
    if(force===true)return (await latest.promise,{claims:forced});
    return (await token.promise,{claims:initial});
   },
   loadLastBusinessScope:()=>remembered,
   loadBusinessSnapshot:(_uid,cid,sid)=>{
    cacheReads.push([cid,sid]);
    return acceptsCache?{jobs:[cachedJob],tasks:[{id:'synthetic-task'}]}:null;
   },
   clearBusinessSnapshot:(...ids)=>clears.push(ids),
   forgetInaccessibleShifts:(_job,...ids)=>clears.push(ids),
   nextShiftJob:rows=>rows[0],staffShiftVisible:()=>true,
   loadPrimaryBusinessData:(...args)=>{requests.push(args);return primaryError?Promise.reject(primaryError):Promise.resolve(true);},
   registerCurrentDevice:async()=>{},refreshOpenJobs:async()=>{},refreshPushStatus:async()=>{},
   isDeviceAccessDenied:error=>['functions/permission-denied','functions/unauthenticated'].includes(error.code),
  };
  for(const name of names)env[name]=value=>{const key=name.slice(3,4).toLowerCase()+name.slice(4);state[key]=value;changes.push([key,value]);};
  const invoke=runInNewContext(compile(app.slice(start,end)+'\nconst listener='+listener+';')+'\nlistener;',env);
  const nextUser={uid:'synthetic-staff-uid',getIdToken:async()=>({})};
  const call=autoStart?invoke(nextUser):Promise.resolve();
  const exposed=()=>changes.some(([key,value])=>key==='myJobs'&&value?.[0]===cachedJob);
  return {call,invoke,nextUser,env,server,token,latest,state,cacheReads,clears,requests,tokenLookups,exposed,scrolls};
 }

 const results=[];
 async function testCacheStartup(name,run){
  try{await run();results.push({name,passed:true});}
  catch(error){results.push({name,passed:false,error:error.message});}
 }
 await testCacheStartup('Checks permission before displaying prior shift, even if token is already cached',async()=>{
  const f=fixture();await tick();f.token.resolve();await tick();
  const before={exposed:f.exposed(),reads:f.cacheReads.length,requests:f.requests.length};
  f.server.reject({code:'functions/permission-denied'});await f.call;
  assert.deepEqual(before,{exposed:false,reads:0,requests:0});
  assert.deepEqual(f.clears,[['synthetic-staff-uid',active.companyId,active.staffId]]);
  assert.equal(f.state.businessDataStatus,'error');
 });
 await testCacheStartup('Verified matching staff scope may display saved rows while loading the live shift',async()=>{
  const f=fixture();f.token.resolve();f.server.resolve({data:{...active,refreshToken:false}});await f.call;
  assert.equal(f.exposed(),true);
  assert.deepEqual(f.cacheReads,[[active.companyId,active.staffId]]);
  assert.deepEqual(f.requests,[[active.staffId,active.companyId,'synthetic-staff-uid']]);
  assert.equal(f.state.businessDataSource,'live');
  assert.deepEqual(f.tokenLookups,[false]);
 });
 await testCacheStartup('A startup timeout keeps records recoverable and leaves the screen without private content',async()=>{
  const f=fixture();f.token.resolve();f.server.reject({code:'functions/unavailable'});await f.call;
  assert.equal(f.exposed(),false);
  assert.equal(f.cacheReads.length,0);
  assert.equal(f.clears.length,0);
  assert.equal(f.state.businessDataSource,'none');
 });
 await testCacheStartup('A transient initial business read failure retains the verified scope for device registration and reload',async()=>{
  for(const acceptsCache of [false,true]){
   const f=fixture({acceptsCache,primaryError:{code:'functions/unavailable'}});
   f.token.resolve();f.server.resolve({data:{...active,refreshToken:false}});await f.call;
   assert.equal(f.state.companyId,active.companyId);
   assert.equal(f.state.staffId,active.staffId);
   assert.equal(f.state.businessDataStatus,acceptsCache?'ready':'error');
   assert.equal(f.exposed(),acceptsCache);
  }
 });
 await testCacheStartup('A denied business read clears previously verified scope and cached shifts',async()=>{
  const f=fixture({primaryError:{code:'functions/permission-denied'}});
  f.token.resolve();f.server.resolve({data:{...active,refreshToken:false}});await f.call;
  assert.equal(f.state.companyId,'');
  assert.equal(f.state.staffId,'');
  assert.equal(f.state.businessDataStatus,'error');
  assert.equal(f.state.businessDataSource,'none');
  assert.ok(f.clears.length>0);
 });

 await testCacheStartup('Stale claims are refreshed once and cannot open mismatched data',async()=>{
  const f=fixture({initial:other,forced:other});f.token.resolve();
  f.server.resolve({data:{...active,refreshToken:false}});f.latest.resolve();await f.call;
  assert.deepEqual(f.tokenLookups,[false,true]);
  assert.equal(f.exposed(),false);
  assert.equal(f.cacheReads.length,0);
  assert.equal(f.requests.length,0);
 });
 await testCacheStartup('Old claims can be replaced by the scope confirmed by the server',async()=>{
  const f=fixture({remembered:other,initial:other});f.token.resolve();
  f.server.resolve({data:{...active,refreshToken:false}});await tick();
  const before={exposed:f.exposed(),reads:f.cacheReads.length};
  f.latest.resolve();await f.call;
  assert.deepEqual(before,{exposed:false,reads:0});
  assert.equal(f.exposed(),true);
  assert.deepEqual(f.cacheReads,[[active.companyId,active.staffId]]);
  assert.deepEqual(f.clears,[['synthetic-staff-uid',other.companyId,other.staffId]]);
  assert.deepEqual(f.tokenLookups,[false,true]);
 });
 await testCacheStartup('Admin and malformed bootstrap responses never display staff data',async()=>{
  for(const data of [{...active,role:'admin',refreshToken:false},{refreshToken:false,role:'staff'}]){
   const f=fixture();f.token.resolve();f.server.resolve({data});await f.call;
   assert.equal(f.exposed(),false);
   assert.equal(f.requests.length,0);
   assert.equal(f.state.businessDataSource,'none');
  }
 });
 await testCacheStartup('A delayed response cannot restore data after a switch, and the old device ID is cleared first',async()=>{
  const f=fixture();
  const device=f.state.deviceSessionId;
  f.token.resolve();await tick();
  f.env.authLoadVersionRef.current++;
  f.server.resolve({data:{...active,refreshToken:false}});await f.call;
  assert.equal(device,'');
  assert.equal(f.exposed(),false);
  assert.equal(f.cacheReads.length,0);
  assert.equal(f.requests.length,0);
 });
 const detailOfPreviousUser={
  request:{id:'previous-request',jobId:'previous-job',type:'sales_floor',reasons:['前の人の再提出理由'],note:'前の人の非公開メモ',status:'open'},
  source:{id:'previous-file',submissionId:'previous-submission',originalName:'prior.pdf',driveName:'prior.pdf',
   contentType:'application/pdf',purpose:'initial',status:'completed',previewUrl:'https://synthetic-preview.invalid/old'},
  replacements:[],
 };
 const previousView = {
  user:{uid:'previous-user'},view:'submit',showAccountMenu:true,message:'前の人だけに送った通知',
  loginCode:'111111',submissionType:'sales_floor',requestId:'previous-request',
  resubmissionDetail:detailOfPreviousUser,confirmedSubmissionContext:'previous-confirmation',
  submissionHistory:[{id:'previous-submission'}],files:[{name:'old-selection.pdf'}],selectedJob:{id:'previous-job'},
 };
 function assertPreviousViewCleared(state){
  assert.equal(state.resubmissionDetail,null,'Private resubmission details must be removed before another account loads');
  assert.equal(state.requestId,'');
  assert.equal(state.view,'home');
  assert.equal(state.showAccountMenu,false);
  assert.equal(state.message,'');
  assert.equal(state.loginCode,'');
  assert.equal(state.submissionType,'report');
  assert.equal(state.confirmedSubmissionContext,'');
  assert.equal(state.submissionHistory.length,0);
  assert.equal(state.files.length,0);
 }

 await testCacheStartup('Shared device / direct switch removes the prior submission screen and private notice before cached jobs can render',async()=>{
  const f=fixture({priorPresentation:previousView});
  const before={...f.state};
  f.token.resolve();f.server.resolve({data:{...active,refreshToken:false}});
  await f.call;
  assertPreviousViewCleared(before);
  assert.deepEqual(f.scrolls,[{top:0,left:0,behavior:"auto"}]);
  assert.equal(f.state.user.uid,'synthetic-staff-uid');
  assertPreviousViewCleared(f.state);
  assert.equal(f.exposed(),true,'Only the newly verified account may restore a job');
  assert.equal(f.state.selectedJob,cachedJob);
  assert.equal(f.clears.length,0,'Normal account switch must not delete persisted drafts or the previous business snapshot');
 });

 await testCacheStartup('Shared device / sign-out clears the prior account display without fetching business data',async()=>{
  const f=fixture({autoStart:false,priorPresentation:previousView});
  await f.invoke(null);
  assertPreviousViewCleared(f.state);
  assert.equal(f.state.user,null);
  assert.equal(f.state.selectedJob,null);
  assert.equal(f.cacheReads.length,0);
  assert.equal(f.requests.length,0);
  assert.equal(f.clears.length,0);
 });

 await testCacheStartup('Shared device / a previous account response arriving after the switch cannot restore private notes or the preview',async()=>{
  const f=fixture({autoStart:false,priorPresentation:previousView});
  const previousResponse=makeDeferred();
  const start=app.indexOf('  async function loadResubmissionDetail(');
  const end=app.indexOf('  async function prepareSubmission(',start);
  assert(start>=0&&end>start);
  Object.assign(f.env,{
    resubmissionDetailVersionRef:{current:0},submissionContextVersionRef:{current:0},
    selectedJob:previousView.selectedJob,submissionType:previousView.submissionType,
    setResubmissionDetail:f.env.setResubmissionDetail??(value=>{f.state.resubmissionDetail=value;}),
  });
  const bootstrap=f.env.httpsCallable;
  f.env.httpsCallable=(functions,name)=>{
   if(name==='getResubmissionComparison')return ({requestId})=>{
    assert.equal(requestId,previousView.requestId);
    return previousResponse.promise;
   };
   return bootstrap(functions,name);
  };
  const load=runInNewContext(compile(app.slice(start,end))+'\nloadResubmissionDetail;',f.env);
  const old=load(previousView.requestId);
  const current=f.invoke(f.nextUser);
  f.token.resolve();f.server.resolve({data:{...active,refreshToken:false}});
  await current;
  previousResponse.resolve({data:detailOfPreviousUser});
  assert.equal(await old,false);
  assertPreviousViewCleared(f.state);
 });

 console.log(JSON.stringify({tests:results.length,passed:results.filter(row=>row.passed).length,results}));
 if(results.some(row=>!row.passed))process.exitCode=1;
}
