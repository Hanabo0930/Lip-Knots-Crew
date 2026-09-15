import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const dep=createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json')),ts=dep('typescript');
const push=fs.readFileSync('apps/staff/src/push.ts','utf8').replaceAll('import.meta.env.VITE_FIREBASE_VAPID_KEY','"synthetic"');
const results=[];async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});}}
for(const action of ['enable','disable','refresh'])for(const stage of ['start','permission','messaging','sdk','ready','token','unregister','delete','none']){
 if(action!=='enable'&&stage==='permission'||action==='enable'&&['unregister','delete'].includes(stage))continue;
 await test(action+' auth switch '+stage,async()=>{
  let current=stage!=='start',staleEffect=false;const events=[];
  const step=async name=>{if(!current)staleEffect=true;events.push(name);if(stage===name)current=false;};
  const scope={exports:{},Error,setTimeout,clearTimeout,Notification:{permission:'granted',requestPermission:async()=>{await step('permission');return 'granted';}},navigator:{userAgent:'synthetic',platform:'test',serviceWorker:{ready:{then:resolve=>{void step('ready').then(()=>resolve({}));}}}},
  require:name=>name==='firebase/messaging'?(void step('sdk'),{getToken:async()=>{await step('token');return 'synthetic-token';},deleteToken:async()=>{await step('delete');return true;}}):name==='firebase/functions'?{httpsCallable:(_f,fn)=>async()=>{await step(fn==='unregisterPushToken'?'unregister':'register');return {data:{}};}}:name==='./firebase'?{getClientMessaging:async()=>{await step('messaging');return {};}}:{}};
  runInNewContext(ts.transpileModule(push,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,scope);
  const f=scope.exports[action+'PushNotifications'];let failed=false;try{await(action==='disable'?f({},()=>current):f({},'device',()=>current));}catch{failed=true;}
  if(stage==='none'){assert.equal(failed,false);assert.ok(events.includes(action==='disable'?'unregister':'register'));}else{assert.equal(staleEffect,false,'No next side effect after auth change');assert.equal(failed,true);}
 });
}

function appSetup(){
 const source=fs.readFileSync('apps/staff/src/App.tsx','utf8'),state={calls:[],messages:[],enabled:false,pending:null};
 const call=name=>(...args)=>new Promise((resolve,reject)=>state.calls.push({name,args,resolve,reject}));
 const ctx={Error,Date,firebaseConfigured:true,functions:{},deviceSessionId:'synthetic',authLoadVersionRef:{current:1},pushStateVersionRef:{current:0},pushReadVersionRef:{current:0},diagnosticsVersionRef:{current:0},setPendingPushAction:v=>state.pending=v,setPushEnabled:v=>state.enabled=v,setPushStatusUncertain:v=>state.uncertain=v,setMessage:v=>state.messages.push(v),enablePushNotifications:call('enable'),disablePushNotifications:call('disable'),refreshPushNotifications:call('refresh'),requestTestPush:call('request'),loadTestPushStatus:call('status'),sleep:call('sleep')};
 const hook={exports:{},require:()=>({useCallback:f=>f,useRef:value=>({current:value}),useState:initial=>[initial(),()=>{}]})};
 runInNewContext(ts.transpileModule(fs.readFileSync('apps/staff/src/useAsyncAction.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,hook);Object.assign(ctx,hook.exports.useAsyncAction());
 runInNewContext(ts.transpileModule(source.slice(source.indexOf('  async function runPushAction('),source.indexOf('  async function apply(')),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);return{ctx,state};
}
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
for(const action of ['enable','disable'])for(const mode of ['auth-success','auth-failure','failure','success','double'])await test('app '+action+' '+mode,async()=>{
 const h=appSetup(),p=h.ctx[action+'Push']();
 if(mode==='double'){void h.ctx[action+'Push']();assert.equal(h.state.calls.length,1);}
 if(mode.startsWith('auth')){h.ctx.authLoadVersionRef.current++;h.state.pending='new';}
 if(mode.endsWith('failure'))h.state.calls[0].reject(Error('offline'));else h.state.calls[0].resolve({enabled:true,message:'success'});
 await p;
 if(mode.startsWith('auth')){assert.equal(h.state.messages.length,0);assert.equal(h.state.enabled,false);assert.equal(h.state.pending,'new');}
 else {assert.equal(h.state.pending,null);assert.ok(h.state.messages.length);}
 assert.equal(h.ctx.isPending('push-action:1'),false);
});
for(const stage of ['request','status','refresh','sleep'])await test('test notification stops at auth change '+stage,async()=>{
 const h=appSetup(),p=h.ctx.requestPushTest();
 if(stage==='request')h.ctx.authLoadVersionRef.current++;
 h.state.calls[0].resolve('queue');await settle();
 if(stage!=='request'){
  if(stage==='status')h.ctx.authLoadVersionRef.current++;
  h.state.calls[1].resolve(stage==='sleep'?{finished:false}:{finished:true,invalidTokenCount:1});await settle();
  if(stage==='refresh'||stage==='sleep'){h.ctx.authLoadVersionRef.current++;h.state.calls[2].resolve({enabled:true});}
 }
 const count=h.state.calls.length,messages=h.state.messages.length;await p;assert.equal(h.state.calls.length,count);assert.equal(h.state.messages.length,messages);assert.equal(h.ctx.isPending('push-action:1'),false);
});
await test('missing configured functions is not demo success',async()=>{const h=appSetup();h.ctx.functions=null;await h.ctx.enablePush();assert.equal(h.state.enabled,false);assert.match(h.state.messages[0],/接続できません/);});

await test('new account can operate while old permission request waits',async()=>{const h=appSetup(),a=h.ctx.enablePush();assert.equal(h.ctx.isPending('push-action:1'),true);h.ctx.authLoadVersionRef.current++;const b=h.ctx.enablePush();assert.equal(h.state.calls.length,2);h.state.calls[0].resolve({enabled:true,message:'old'});await a;assert.equal(h.ctx.isPending('push-action:2'),true);assert.equal(h.state.pending,'enable');assert.equal(h.state.messages.length,0);h.state.calls[1].resolve({enabled:true,message:'new'});await b;assert.equal(h.state.messages[0],'new');assert.equal(h.ctx.isPending('push-action:2'),false);});

function readSetup(){const h=appSetup(),source=fs.readFileSync('apps/staff/src/App.tsx','utf8');const call=name=>(...args)=>new Promise((resolve,reject)=>h.state.calls.push({name,args,resolve,reject}));Object.assign(h.ctx,{lastPushStatusRefreshAt:0,pastShiftVersionRef:{current:0},PUSH_STATUS_REFRESH_INTERVAL_MS:1000,user:{uid:'synthetic'},companyId:'company',staffId:'staff',businessDataStatus:'ready',businessDataSource:'live',businessRefreshing:false,homeDisplayMs:null,businessRefreshMs:null,homeLoadedFromCache:false,loadServerPushStatusWithRetry:call('read'),runStaffDiagnostics:call('diagnose'),setShowAccountMenu:()=>{},setShowDevices:()=>{},setShowDiagnostics:v=>h.state.showDiagnostics=v,setDiagnosticReport:v=>{h.state.report=v;h.ctx.diagnosticReport=v;}});runInNewContext(ts.transpileModule(source.slice(source.indexOf('  async function refreshPushStatus('),source.indexOf('  function navigate(')),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,h.ctx);return h;}
for(const fail of [false,true])await test('old push read after operation '+fail,async()=>{const h=readSetup(),a=h.ctx.refreshPushStatus(true),b=h.ctx.enablePush();h.state.calls[1].resolve({enabled:true,message:'enabled'});await b;const n=h.state.messages.length;if(fail)h.state.calls[0].reject(Error('old'));else h.state.calls[0].resolve(false);await a;assert.equal(h.state.enabled,true);assert.equal(h.state.messages.length,n);});
await test('push status read skipped during mutation',async()=>{const h=readSetup(),a=h.ctx.enablePush();await h.ctx.refreshPushStatus(true);assert.equal(h.state.calls.length,1);h.state.calls[0].resolve({enabled:true,message:'ok'});await a;});
await test('newest push status read wins',async()=>{const h=readSetup(),a=h.ctx.refreshPushStatus(true);h.ctx.lastPushStatusRefreshAt=0;const b=h.ctx.refreshPushStatus(true);h.state.calls[1].resolve(true);await b;h.state.calls[0].resolve(false);await a;assert.equal(h.state.enabled,true);});
for(const mode of ['auth','closed','failure','success','push-changed','double','reopen'])await test('diagnostics isolation '+mode,async()=>{
 const h=readSetup(),a=h.ctx.openQuickDiagnostics();
 if(mode==='double'){void h.ctx.openQuickDiagnostics();assert.equal(h.state.calls.length,1);}
 if(mode==='auth')h.ctx.authLoadVersionRef.current++;
 if(mode==='closed'||mode==='reopen')h.ctx.closeDiagnostics();
 let b;if(mode==='reopen'){b=h.ctx.openQuickDiagnostics();assert.equal(h.state.calls.length,2);}
 if(mode==='push-changed')h.state.enabled=true;
 if(mode==='failure')h.state.calls[0].reject(Error('diagnostic failed'));else h.state.calls[0].resolve({summary:'pass',checks:[],serverPushEnabled:false});
 await a;
 if(['closed','auth','reopen'].includes(mode)){assert.equal(h.state.report,null);assert.equal(h.state.messages.length,0);}
 else if(mode==='failure'){assert.equal(h.state.report.summary,'fail');assert.ok(h.state.messages.length);}
 else assert.equal(h.state.report.summary,'pass');
 if(mode==='push-changed')assert.equal(h.state.enabled,true);
 if(mode==='reopen'){assert.equal(h.ctx.isDiagnosticsPending(),true);h.state.calls[1].resolve({summary:'warn',checks:[],serverPushEnabled:false});await b;assert.equal(h.state.report.summary,'warn');}
});

for(const action of ['copy','share'])for(const mode of ['auth','closed','success'])await test('diagnostic '+action+' '+mode,async()=>{const h=readSetup();h.ctx.diagnosticReport={summary:'pass'};h.ctx.formatDiagnosticReport=()=> 'synthetic diagnostic';h.ctx.navigator={clipboard:{writeText:()=>new Promise((resolve,reject)=>h.state.calls.push({name:'copy',resolve,reject}))},share:()=>new Promise((resolve,reject)=>h.state.calls.push({name:'share',resolve,reject}))};const p=h.ctx[action+'Diagnostics']();if(mode==='auth')h.ctx.authLoadVersionRef.current++;if(mode==='closed')h.ctx.closeDiagnostics();if(action==='share'&&mode==='auth')h.state.calls[0].reject(Error('old'));else h.state.calls[0].resolve();await p;assert.equal(h.state.calls.length,1);assert.equal(h.state.messages.length,mode==='success'?1:0);});
for(const showFailure of [false,true])await test('push read uncertainty and recovery '+showFailure,async()=>{
 const h=readSetup();h.state.enabled=true;let task=h.ctx.refreshPushStatus(showFailure);h.state.calls[0].reject(Error('offline'));await task;assert.equal(h.state.uncertain,true);assert.equal(h.state.enabled,true);assert.equal(h.state.messages.length,showFailure?1:0);
 h.ctx.lastPushStatusRefreshAt=0;task=h.ctx.refreshPushStatus(false);h.state.calls[1].resolve(true);await task;assert.equal(h.state.uncertain,false);assert.equal(h.state.enabled,true);
});
await test('push action clears previous uncertainty',async()=>{const h=appSetup();h.state.uncertain=true;const task=h.ctx.enablePush();h.state.calls[0].resolve({enabled:true,message:'enabled'});await task;assert.equal(h.state.uncertain,false);});
for(const mode of ['success','failure-retry','auth','double'])await test('manual push status '+mode,async()=>{
 const h=readSetup();h.state.uncertain=true;h.ctx.lastPushStatusRefreshAt=Date.now();const task=h.ctx.retryPushStatus();assert.equal(h.state.calls.length,1);assert.equal(h.state.pending,'status');
 if(mode==='double'){void h.ctx.retryPushStatus();void h.ctx.enablePush();assert.equal(h.state.calls.length,1);}
 if(mode==='auth')h.ctx.authLoadVersionRef.current++;
 if(mode==='failure-retry')h.state.calls[0].reject(Error('offline'));else h.state.calls[0].resolve(true);await task;
 if(mode==='auth'){assert.equal(h.state.enabled,false);assert.equal(h.state.uncertain,true);assert.equal(h.state.messages.length,0);return;}
 assert.equal(h.state.pending,null);
 if(mode==='failure-retry'){assert.equal(h.state.uncertain,true);const retry=h.ctx.retryPushStatus();h.state.calls[1].resolve(false);await retry;assert.equal(h.state.uncertain,false);assert.equal(h.state.enabled,false);}
 else{assert.equal(h.state.enabled,true);assert.equal(h.state.uncertain,false);}
});
{
 const start=push.indexOf('export async function loadServerPushStatus('),end=push.indexOf('export async function requestTestPush(',start);assert.ok(start>=0&&end>start);const code=ts.transpileModule(push.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 for(const data of [null,{},[],{enabled:null},{enabled:'true'},{enabled:1},{enabled:false},{enabled:true}])await test('server push status shape '+JSON.stringify(data),async()=>{
  const ctx={exports:{},httpsCallable:()=>async()=>({data})};runInNewContext(code,ctx);
  if(typeof data?.enabled==='boolean')assert.equal(await ctx.exports.loadServerPushStatus({}),data.enabled);else await assert.rejects(ctx.exports.loadServerPushStatus({}),/通知状態の応答/);
 });
 for(const mode of ['permission','unavailable','null-recovery','malformed','temporary'])await test('server push status retry '+mode,async()=>{
  let calls=0;const delays=[];const ctx={exports:{},window:{setTimeout:(resolve,ms)=>{delays.push(ms);resolve()}},httpsCallable:()=>async()=>{
   calls++;if(mode==='permission')throw {code:'functions/permission-denied'};if(mode==='unavailable'||mode==='temporary'&&calls<3)throw {code:'functions/unavailable'};if(mode==='null-recovery'&&calls===1)throw null;return {data:mode==='malformed'?{}:{enabled:false}};
  }};runInNewContext(code,ctx);
  if(['permission','unavailable','malformed'].includes(mode))await assert.rejects(ctx.exports.loadServerPushStatusWithRetry({}));else assert.equal(await ctx.exports.loadServerPushStatusWithRetry({}),false);
  const expected=mode==='permission'?1:mode==='null-recovery'?2:3;assert.equal(calls,expected);assert.deepEqual(delays,expected===1?[]:expected===2?[250]:[250,500]);
 });
}
{
 const start=push.indexOf('export async function requestTestPush('),end=push.indexOf('export async function listenForForegroundPush(',start);assert.ok(start>=0&&end>start);const code=ts.transpileModule(push.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 for(const data of [null,{}, {queueId:42},{queueId:{}},{queueId:''},{queueId:'   '},{queueId:'path/id'},{queueId:'queue'}])await test('push test receipt '+JSON.stringify(data),async()=>{
  const ctx={exports:{},httpsCallable:()=>async()=>({data})};runInNewContext(code,ctx);if(data?.queueId==='queue')assert.equal(await ctx.exports.requestTestPush({}),'queue');else await assert.rejects(ctx.exports.requestTestPush({}),/受付結果/);
 });
 const valid={queueId:'queue',status:'completed',finished:true,successCount:1,failureCount:0,invalidTokenCount:0,failureReason:'none'};
 for(const override of [{queueId:'other'},{finished:'true'},{status:''},{status:'processing'},{successCount:'1'},{successCount:-1},{failureCount:NaN},{invalidTokenCount:0.5},{failureReason:'unexpected'},null])await test('push test result validation '+JSON.stringify(override),async()=>{
  const value=override===null?null:{...valid,...override},ctx={exports:{},httpsCallable:()=>async()=>({data:{test:value}})};runInNewContext(code,ctx);if(value===null)assert.equal(await ctx.exports.loadTestPushStatus({},'queue'),null);else await assert.rejects(ctx.exports.loadTestPushStatus({},'queue'),/処理結果/);
 });
 for(const status of ['completed','partial','no_tokens','error','paused_global','processing'])await test('push test valid status '+status,async()=>{
  const value={...valid,status,finished:status!=='processing'},ctx={exports:{},httpsCallable:()=>async()=>({data:{test:value}})};runInNewContext(code,ctx);assert.equal(await ctx.exports.loadTestPushStatus({},'queue'),value);
 });
}
for(const mode of ['remaining-sleep','deadline'])await test('push test polling deadline '+mode,async()=>{
 const h=appSetup();let now=0;h.ctx.Date={now:()=>now};const task=h.ctx.submitAndWaitForPushTest(()=>true);h.state.calls[0].resolve('queue');await settle();assert.equal(h.state.calls[1].args[2],15000);
 if(mode==='deadline'){h.state.calls[1].reject({code:'functions/deadline-exceeded'});assert.equal(await task,null);assert.equal(h.state.calls.length,2);}
 else{now=14800;h.state.calls[1].resolve({finished:false});await settle();assert.equal(h.state.calls[2].args[0],200);now=15000;h.state.calls[2].resolve();assert.equal(await task,null);assert.equal(h.state.calls.length,3);}
});
await test('push status SDK timeout uses remaining budget',async()=>{
 const start=push.indexOf('export async function loadTestPushStatus('),end=push.indexOf('export async function listenForForegroundPush(',start);const timeouts=[];const ctx={exports:{},httpsCallable:(_f,_name,options)=>{timeouts.push(options.timeout);return async()=>({data:{test:null}})}};runInNewContext(ts.transpileModule(push.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,ctx);
 await ctx.exports.loadTestPushStatus({},'queue');await ctx.exports.loadTestPushStatus({},'queue',200);await ctx.exports.loadTestPushStatus({},'queue',99999);assert.deepEqual(timeouts,[15000,200,15000]);
});

for(const demo of [false,true])await test('test notification missing services demo='+demo,async()=>{const h=appSetup();h.ctx.functions=null;h.ctx.firebaseConfigured=!demo;await h.ctx.requestPushTest();assert.equal(h.state.calls.length,0);assert.equal(h.state.pending,null);assert.equal(h.ctx.isPending('push-action:1'),false);assert.match(h.state.messages[0],demo?/デモ：実際のテスト通知は送信されません/:/通知設定に接続できません/);assert.equal(h.state.enabled,false);});

for(const demo of [false,true])for(const enabled of [false,true])await test('status retry missing services demo='+demo+' enabled='+enabled,async()=>{const h=appSetup();h.ctx.functions=null;h.ctx.firebaseConfigured=!demo;h.state.enabled=enabled;h.state.uncertain=true;await h.ctx.retryPushStatus();assert.equal(h.state.calls.length,0);assert.equal(h.state.pending,null);assert.equal(h.ctx.isPending('push-action:1'),false);assert.match(h.state.messages[0],demo?/実際の通知登録は確認していません/:/通知設定に接続できません/);assert.equal(h.state.enabled,enabled);assert.equal(h.state.uncertain,true);});
for(const mode of ['during','already-pending','failed-report','stale-auth'])await test('diagnostic snapshot notification operation '+mode,async()=>{
 const h=readSetup();let release;const operation=mode==='already-pending'?h.ctx.run('push-action:1',()=>new Promise(resolve=>release=resolve)):null;const pending=h.ctx.openQuickDiagnostics();if(mode!=='already-pending')h.ctx.pushStateVersionRef.current++;if(mode==='stale-auth')h.ctx.authLoadVersionRef.current++;h.state.calls[0].resolve({summary:mode==='failed-report'?'fail':'pass',serverPushEnabled:true,checks:[{id:'network',level:mode==='failed-report'?'fail':'pass',label:'通信',detail:'合成'},{id:'permission',level:'pass'},{id:'push',level:'pass'}]});await pending;if(operation){release();await operation;}if(mode==='stale-auth'){assert.equal(h.state.report,null);assert.equal(h.state.messages.length,0);return;}assert.equal(h.state.report.summary,mode==='failed-report'?'fail':'warn');assert.equal(h.state.report.serverPushEnabled,null);assert.equal(h.state.report.checks.some(c=>c.id==='permission'||c.id==='push'),false);assert.equal(h.state.report.checks[0].id,'network');assert.match(h.state.report.checks.find(c=>c.id==='push-changed').detail,/もう一度診断/);assert.equal(h.state.messages.some(m=>m.includes('すべて正常')),false);
});
for(const mode of ['during','already-refreshing','other-failure','old-business-failure','both','unchanged'])await test('diagnostic business snapshot '+mode,async()=>{
 const h=readSetup();if(mode==='already-refreshing')h.ctx.businessRefreshing=true;const pending=h.ctx.openQuickDiagnostics();if(!['already-refreshing','unchanged'].includes(mode))h.ctx.pastShiftVersionRef.current++;if(mode==='both')h.ctx.pushStateVersionRef.current++;h.state.calls[0].resolve({summary:['other-failure','old-business-failure'].includes(mode)?'fail':'pass',serverPushEnabled:true,checks:[{id:'network',level:mode==='other-failure'?'fail':'pass'},{id:'business',level:mode==='old-business-failure'?'fail':'pass'},{id:'refresh',level:'pass'},{id:'push',level:'pass'}]});await pending;if(mode==='unchanged'){assert.equal(h.state.report.summary,'pass');assert.equal(h.state.report.checks.length,4);return;}assert.equal(h.state.report.summary,mode==='other-failure'?'fail':'warn');assert.equal(h.state.report.checks.some(c=>c.id==='business'||c.id==='refresh'),false);assert.match(h.state.report.checks.find(c=>c.id==='business-changed').detail,/もう一度診断/);assert.equal(h.state.report.serverPushEnabled,mode==='both'?null:true);assert.equal(h.state.messages.some(m=>m.includes('すべて正常')),false);
});
console.log(JSON.stringify({cases:results.length,passed:results.every(r=>r.passed),results},null,2));if(results.some(r=>!r.passed))process.exitCode=1;
