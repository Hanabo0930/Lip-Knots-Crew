import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(new URL('../package.json',import.meta.url));
const ts=require('typescript');
const source=readFileSync(new URL('../apps/admin/src/App.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const begin=source.indexOf('  useEffect(() => {\n    const activeAuth=auth;');
const end=source.indexOf('\n  }, []);',begin);
assert.ok(begin>=0&&end>begin);
const actual=source.slice(begin,end+'\n  }, []);'.length).replace('import("./push")','loadPushModule()');
const compiled=ts.transpileModule(actual,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
function harness({primaryGate=null,controlGate=null}={}){
  const state={authorized:false,loaders:[],idle:null,scheduled:0,pushReads:0,controlReads:0,controlApplied:0};
  const auth={currentUser:null},importGate=deferred();
  const scope={auth,functions:{},firebaseConfigured:true,sessionUser:null,onAuthorizationRejected:()=>{},Error,Promise,Array,String,Symbol,
    useEffect:fn=>{state.cleanup=fn();},
    onAuthStateChanged:(_auth,fn)=>{state.authListener=fn;return()=>{};},
    onIdTokenChanged:(_auth,fn)=>{state.tokenListener=fn;return()=>{};},
    httpsCallable:()=>async()=>({data:{role:'admin',companyId:'synthetic-company',jobs:[],staff:[]}}),
    canApplyAuthResult:guard=>guard(),
    scheduleWhenIdle:fn=>{state.scheduled++;state.idle=fn;return()=>{state.idle=null;};},
    loadPushModule:()=>importGate.promise,
    loadProductionControlStatus:async guard=>{state.controlReads++;if(controlGate)await controlGate.promise;if(state.failControl)throw new Error('synthetic control failure');if(guard())state.controlApplied++;},
  };
  for(const m of actual.matchAll(/\b((?:set|reset|close)[A-Z][A-Za-z0-9_]*)\(/g))scope[m[1]]=()=>{};
  for(const m of actual.matchAll(/\b([A-Za-z_$][\w$]*Ref)\.current/g))scope[m[1]]={current:0};
  for(const m of actual.matchAll(/\b((?:demo|blank|default)[A-Z][A-Za-z0-9_]*)\b/g))scope[m[1]]={};
  scope.operationLocksRef={current:new Map()};scope.dashboardMonthRef={current:'2026-10'};
  scope.setAdminAuthorized=value=>{state.authorized=value;};
  for(const name of ['loadSheetIssues','loadDashboard','loadResubmissions'])scope[name]=async()=>{state.loaders.push(name);if(name==='loadSheetIssues'&&primaryGate)await primaryGate.promise;};
  runInNewContext(compiled,scope);
  return{state,auth,scope,importGate,emit(user){scope.sessionUser=user;auth.currentUser=user;state.authListener(user);},token(user){state.tokenListener(user);},idle(){const fn=state.idle;assert.ok(fn,'deferred read must have been scheduled');state.idle=null;fn();},resolvePush(){importGate.resolve({loadServerPushStatus:async()=>{state.pushReads++;if(state.pushGate)await state.pushGate.promise;if(state.failPush)throw new Error('synthetic Push status failure');return true;}});}};
}
function user(gate=null){return{uid:'synthetic-admin',role:'admin',async getIdTokenResult(force){if(!force&&gate)await gate.promise;if(!force&&this.verificationFails)throw new Error('synthetic transient failure');return{claims:{role:this.role,companyId:'synthetic-company'}};}};}
const blocked=deferred(),initial=harness(),first=user(blocked);
initial.emit(first);await flush();
const initialPendingLoaders=initial.state.loaders.length;
first.role='staff';blocked.resolve();await flush();
const idle=harness(),second=user();idle.emit(second);await flush();
assert.ok(idle.state.idle,'mock idle callback must be scheduled');
idle.idle();await flush();
second.role='staff';idle.token(second);await flush();
assert.equal(idle.state.authorized,false,'mock changed claims must revoke authorization');
idle.resolvePush();await flush();
assert.equal(initialPendingLoaders,0,'Admin loaders must wait for token verification');
assert.equal(idle.state.pushReads,0,'a delayed module must not start a read after revocation');
const primary=deferred(),recovery=harness({primaryGate:primary}),recovering=user();recovery.emit(recovering);await flush();
recovering.verificationFails=true;recovery.token(recovering);await flush();primary.resolve();await flush();assert.equal(recovery.state.idle,null);
recovering.verificationFails=false;recovery.scope.retryAdminTokenRef.current();await flush();recovery.idle();recovery.resolvePush();await flush();
assert.equal(recovery.state.loaders.length,3);assert.equal(recovery.state.controlReads,1);assert.equal(recovery.state.pushReads,1);
const scheduled=recovery.state.scheduled;recovery.token(recovering);await flush();assert.equal(recovery.state.scheduled,scheduled,'completed deferred reads are not repeated on token refresh');
const delayed=harness(),delayedUser=user();delayed.emit(delayedUser);await flush();delayed.idle();await flush();
delayedUser.verificationFails=true;delayed.token(delayedUser);await flush();delayed.resolvePush();await flush();assert.equal(delayed.state.pushReads,0);
delayedUser.verificationFails=false;delayed.scope.retryAdminTokenRef.current();await flush();delayed.idle();await flush();
assert.equal(delayed.state.pushReads,1);assert.equal(delayed.state.controlReads,1,'completed control read is retained while only the skipped Push read resumes');
const control=deferred(),controlRecovery=harness({controlGate:control}),controlUser=user();controlRecovery.resolvePush();controlRecovery.emit(controlUser);await flush();controlRecovery.idle();await flush();
controlUser.verificationFails=true;controlRecovery.token(controlUser);await flush();control.resolve();await flush();assert.equal(controlRecovery.state.controlApplied,0);
controlUser.verificationFails=false;controlRecovery.scope.retryAdminTokenRef.current();await flush();controlRecovery.idle();await flush();
assert.equal(controlRecovery.state.controlReads,2);assert.equal(controlRecovery.state.controlApplied,1);assert.equal(controlRecovery.state.pushReads,1);
const pushFailure=harness(),pushUser=user(),pushResult=deferred();pushFailure.state.pushGate=pushResult;pushFailure.state.failPush=true;pushFailure.resolvePush();pushFailure.emit(pushUser);await flush();pushFailure.idle();await flush();
pushUser.verificationFails=true;pushFailure.token(pushUser);await flush();pushResult.resolve();await flush();pushFailure.state.failPush=false;pushUser.verificationFails=false;pushFailure.scope.retryAdminTokenRef.current();await flush();pushFailure.idle();await flush();
assert.equal(pushFailure.state.pushReads,2);assert.equal(pushFailure.state.controlReads,1,'only the failed pending Push read resumes');
const failureControl=deferred(),controlFailure=harness({controlGate:failureControl}),failedControlUser=user();controlFailure.state.failControl=true;controlFailure.resolvePush();controlFailure.emit(failedControlUser);await flush();controlFailure.idle();await flush();
failedControlUser.verificationFails=true;controlFailure.token(failedControlUser);await flush();failureControl.resolve();await flush();controlFailure.state.failControl=false;failedControlUser.verificationFails=false;controlFailure.scope.retryAdminTokenRef.current();await flush();controlFailure.idle();await flush();
assert.equal(controlFailure.state.controlReads,2);assert.equal(controlFailure.state.controlApplied,1);assert.equal(controlFailure.state.pushReads,1);
console.log(JSON.stringify({status:'PASS',cases:['initial-check','revoked-import','primary-completion-during-transient-failure','skipped-import-resume-only','discarded-control-read-resume-only','pending-push-failure-resume','pending-control-failure-resume','completed-no-repeat'],loadersWhileInitialTokenCheckPending:initialPendingLoaders,pushReadAfterRevocation:idle.state.pushReads,realNetworkCalls:0}));
