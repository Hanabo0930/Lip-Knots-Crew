import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';

const require=createRequire(new URL('../package.json',import.meta.url));
const ts=require('typescript');
const source=readFileSync(new URL('../apps/admin/src/App.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const begin=source.indexOf('  useEffect(() => {\n    const activeAuth=auth;');
const end=source.indexOf('\n  }, []);',begin);
assert.ok(begin>=0&&end>begin,'actual Admin Auth effect must be present');
const effect=source.slice(begin,end+'\n  }, []);'.length);
const compiled=ts.transpileModule(effect,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function gate(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
function user(uid,{bootstrapGate=null,tokenGate=null,loadGate=null,bootstrapRole='admin',tokenRole='admin',company='fixture-company',tokenCompany=company,failBootstrap=false}={}){
  return {uid,bootstrapGate,tokenGate,loadGate,bootstrapRole,tokenRole,company,tokenCompany,failBootstrap,
    async getIdTokenResult(force){
      if(force){if(tokenGate)await tokenGate.promise;}
      else {this.checks=(this.checks??0)+1;this.onVerify?.();if(this.verificationGate)await this.verificationGate.promise;if(this.verificationFails)throw new Error('synthetic token failure');}
      return{claims:{role:this.tokenRole,companyId:this.tokenCompany}};
    },
    async getIdToken(){if(tokenGate)await tokenGate.promise;return 'synthetic-token';}};
}
function harness({demo=false}={}){
  const state={authorized:demo,retained:demo,ready:demo,checking:false,revision:0,user:null,message:'',authMessage:'',events:[],authListener:null,tokenListeners:[]};
  const auth=demo?null:{currentUser:null};
  const scope={auth,functions:{},firebaseConfigured:!demo,sessionUser:null,onAuthorizationRejected:()=>{state.rejected=true;},Error,Promise,Array,String,Symbol,
    useEffect:fn=>{state.cleanup=fn();},
    onAuthStateChanged:(_auth,fn)=>{state.authListener=fn;return()=>{state.unsubscribed=true;};},
    onIdTokenChanged:(_auth,fn)=>{state.tokenListeners.push(fn);return()=>{};},
    httpsCallable:(_functions,name)=>{assert.equal(name,'bootstrapSession');const captured=auth.currentUser;state.events.push('bootstrap:'+captured.uid);return async()=>{
      if(captured.bootstrapGate)await captured.bootstrapGate.promise;
      if(captured.failBootstrap)throw new Error('合成接続エラー');
      return{data:{role:captured.bootstrapRole,companyId:captured.company,jobs:[],staff:[]}};
    };},
    canApplyAuthResult:guard=>guard(),
    scheduleWhenIdle:()=>()=>{},
  };
  for(const m of effect.matchAll(/\b((?:set|reset|close)[A-Z][A-Za-z0-9_]*)\(/g))scope[m[1]]=()=>{};
  for(const m of effect.matchAll(/\b([A-Za-z_$][\w$]*Ref)\.current/g))scope[m[1]]={current:null};
  for(const m of effect.matchAll(/\b((?:demo|blank|default)[A-Z][A-Za-z0-9_]*)\b/g))scope[m[1]]={};
  scope.operationLocksRef={current:new Map()};scope.dashboardMonthRef={current:'2026-10'};scope.pushActionVersionRef={current:0};
  scope.setAdminAuthorized=value=>{state.authorized=value;state.events.push('authorized:'+value);};
  scope.setAdminShellRetained=value=>{state.retained=value;};
  scope.setAdminSessionReady=value=>{state.ready=value;state.events.push('ready:'+value);};
  scope.setAdminTokenChecking=value=>{state.checking=value;};
  scope.setAdminTokenRevision=value=>{state.revision=typeof value==='function'?value(state.revision):value;};
  scope.setAdminAuthorizationMessage=value=>{state.authMessage=String(value);};
  scope.setUser=value=>{state.user=value;};scope.setMessage=value=>{state.message=String(value);};
  for(const name of ['loadSheetIssues','loadDashboard','loadResubmissions'])scope[name]=async()=>{const captured=auth.currentUser;state.events.push(name+':'+captured.uid);if(captured.loadGate)await captured.loadGate.promise;};
  runInNewContext(compiled,scope,{timeout:1000});
  return{state,auth,scope,emit(value){scope.sessionUser=value;auth.currentUser=value;state.authListener(value);},unexpected(value){auth.currentUser=value;state.authListener(value);},token(value){for(const fn of state.tokenListeners)fn(value);}};
}

const h=harness();h.emit(null);await flush();assert.equal(h.state.authorized,false);assert.equal(h.state.ready,false);assert.equal(h.state.user,null);
const slow=gate();const a=user('synthetic-admin-a',{loadGate:slow});h.emit(a);await flush();
assert.equal(h.state.authorized,true,'verified Admin is visible while a separate list read is pending');assert.equal(h.state.ready,false);
slow.resolve();await flush();assert.equal(h.state.ready,true);
h.emit(null);await flush();assert.equal(h.state.authorized,false,'logout clears Admin authorization');assert.equal(h.state.ready,false);assert.equal(h.state.user,null);
const oldToken=gate(),old=user('synthetic-old-admin',{tokenGate:oldToken});h.emit(old);await flush();
const newer=user('synthetic-new-admin');h.emit(newer);await flush();assert.equal(h.state.authorized,true);assert.equal(h.state.user.uid,newer.uid);
const before=[...h.state.events];oldToken.resolve();await flush();assert.equal(h.state.user.uid,newer.uid);assert.equal(h.state.authorized,true);assert.deepEqual(h.state.events,before,'stale token result cannot overwrite the newer account');
const staff=user('synthetic-staff',{bootstrapRole:'staff',tokenRole:'staff'});h.emit(staff);await flush();assert.equal(h.state.authorized,false);assert.equal(h.state.ready,false);assert.match(h.state.message,/管理者/);
const demo=harness({demo:true});assert.equal(demo.state.authorized,true);assert.equal(demo.state.authListener,null);
const switched=harness(),knownUser=user('synthetic-known');switched.emit(knownUser);await flush();const unexpected=user('synthetic-other');switched.unexpected(unexpected);await flush();assert.equal(switched.state.authorized,false);assert.ok(!switched.state.events.includes('bootstrap:'+unexpected.uid),'the old session never bootstraps a new account before the keyed boundary replaces it');
switched.emit(knownUser);await flush();assert.equal(switched.state.events.filter(event=>event==='bootstrap:'+knownUser.uid).length,1,'an A-B-A transition cannot restart a rejected old session');

const refresh=harness();const admin=user('synthetic-admin');refresh.emit(admin);await flush();assert.equal(refresh.state.authorized,true);
const verification=gate();admin.verificationGate=verification;
const existingLock=Symbol('in-flight');refresh.scope.operationLocksRef.current.set('test',existingLock);
refresh.token(admin);assert.equal(refresh.state.checking,true);assert.equal(refresh.state.authorized,false);assert.equal(refresh.state.retained,true);
assert.equal(refresh.scope.operationLocksRef.current.get('test'),existingLock,'verification retains in-flight operation locks');
verification.resolve();await flush();assert.equal(refresh.state.checking,false);assert.equal(refresh.state.authorized,true);assert.equal(refresh.state.ready,true);
delete admin.verificationGate;
admin.tokenRole='staff';refresh.token(admin);await flush();
const afterTokenRefresh=refresh.state.authorized;
assert.equal(refresh.state.ready,false,'a role change must prevent Admin work');
assert.match(refresh.state.authMessage,/権限/);

const wrongCompany=harness(),companyAdmin=user('synthetic-company-admin');wrongCompany.emit(companyAdmin);await flush();companyAdmin.tokenCompany='other-company';wrongCompany.token(companyAdmin);await flush();assert.equal(wrongCompany.state.authorized,false);
const failedCheck=harness(),failedAdmin=user('synthetic-failed-admin');failedCheck.emit(failedAdmin);await flush();failedAdmin.verificationFails=true;failedCheck.token(failedAdmin);await flush();assert.equal(failedCheck.state.authorized,false);assert.equal(failedCheck.state.retained,true,'a transient failure preserves the existing shell');
failedAdmin.verificationFails=false;failedCheck.scope.retryAdminTokenRef.current();await flush();assert.equal(failedCheck.state.authorized,true);assert.equal(failedCheck.state.retained,true);assert.equal(failedCheck.state.events.filter(event=>event==='bootstrap:'+failedAdmin.uid).length,1,'retry only checks the token and does not repeat bootstrap');
const staleCheck=harness(),oldAdmin=user('synthetic-a');staleCheck.emit(oldAdmin);await flush();const delayed=gate();oldAdmin.verificationGate=delayed;staleCheck.token(oldAdmin);
const currentAdmin=user('synthetic-b');staleCheck.emit(currentAdmin);await flush();assert.equal(staleCheck.state.authorized,true);oldAdmin.tokenRole='staff';delayed.resolve();await flush();assert.equal(staleCheck.state.user.uid,currentAdmin.uid);assert.equal(staleCheck.state.authorized,true,'a stale token result cannot remove a new account');
const replacement=harness(),original=user('synthetic-same-id');replacement.emit(original);await flush();const otherObject=user(original.uid);replacement.auth.currentUser=otherObject;replacement.token(otherObject);await flush();assert.equal(replacement.state.authorized,false,'an unexpected same-UID object cannot inherit authorization');
for(const stage of ['bootstrap','forced-token']){
  const race=harness(),hold=gate(),oldUser=user('synthetic-race',{[stage==='bootstrap'?'bootstrapGate':'tokenGate']:hold});
  race.emit(oldUser);await flush();
  const newUser=user(oldUser.uid,{tokenRole:'staff'});race.auth.currentUser=newUser;race.token(newUser);
  hold.resolve();await flush();
  assert.equal(race.state.authorized,false,`${stage}: a replaced User object must not inherit the old response`);
  assert.equal(race.state.ready,false,`${stage}: Admin session must remain stopped`);
  assert.ok(!race.state.events.some(event=>event.startsWith('loadSheetIssues:')),`${stage}: Admin loaders must not start`);
  assert.match(race.state.authMessage,/権限/);
}
const storm=harness(),stormAdmin=user('synthetic-storm');storm.emit(stormAdmin);await flush();const previousChecks=stormAdmin.checks;stormAdmin.onVerify=()=>storm.token(stormAdmin);storm.token(stormAdmin);await flush();assert.equal(storm.state.authorized,false,'repeated token events must stop safely');assert.equal(stormAdmin.checks-previousChecks,4,'token checks are bounded');
assert.match(source,/style=\{!adminAuthorized\?\{display:"none"\}:undefined\}/,'the retained shell is hidden while unverified');

const pushHandler=source.indexOf('listenForForegroundPush(');
const pushBegin=source.lastIndexOf('  useEffect(() => {',pushHandler);
let pushEnd=source.indexOf('\n  }, [user,adminAuthorized,adminTokenChecking,adminTokenRevision]);',pushHandler);
let pushEndMarker='\n  }, [user,adminAuthorized,adminTokenChecking,adminTokenRevision]);';
if(pushEnd<0){pushEnd=source.indexOf('\n  }, [user]);',pushHandler);pushEndMarker='\n  }, [user]);';}
assert.ok(pushBegin>=0&&pushEnd>pushBegin,'actual foreground Push effect must be present');
const pushCode=ts.transpileModule(source.slice(pushBegin,pushEnd+pushEndMarker.length).replace('import("./push")','loadPushModule()'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
let received=null,listener=null;
const pushUser={uid:'synthetic-staff'};
const pushScope={user:pushUser,adminAuthorized:false,adminTokenChecking:false,adminTokenRevision:0,adminAuthEpochRef:{current:1},auth:{currentUser:pushUser},useEffect:fn=>fn(),setMessage:value=>{received=String(value);},loadPushModule:async()=>({listenForForegroundPush:async fn=>{listener=fn;return()=>{};}})};
runInNewContext(pushCode,pushScope);await flush();if(listener)listener({data:{title:'synthetic-old-admin',body:'synthetic-private'}});await flush();
console.log(JSON.stringify({logout:'PASS',uidSwitch:'PASS',staleTokenResponse:'PASS',pendingRead:'PASS',demo:'PASS',sameClaimsAndLock:'PASS',sameUidRoleChange:afterTokenRefresh?'FAIL':'PASS',companyMismatch:'PASS',tokenFailure:'PASS',staleVerification:'PASS',sameUidObjectChange:'PASS',sameUidReplacementDuringBootstrap:'PASS',sameUidReplacementDuringForcedToken:'PASS',boundedTokenEvents:'PASS',unverifiedUserReceivedPush:received!==null,realNetworkCalls:0}));
assert.equal(afterTokenRefresh,false,'same-UID token role change must remove Admin authorization');
assert.equal(received,null,'an unverified account must not receive an old Admin Push message');
