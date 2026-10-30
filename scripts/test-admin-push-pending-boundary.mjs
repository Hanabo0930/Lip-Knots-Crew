import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Run the actual App handler and the pinned production Push helpers with local mocks only.
const require=createRequire(new URL('../package.json',import.meta.url));
const ts=require('typescript');
const app=readFileSync(new URL('../apps/admin/src/App.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const push=readFileSync(new URL('../apps/admin/src/push.ts',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const appStart=app.indexOf('  async function runPushAction(');
const appEnd=app.indexOf('\n  async function enablePush()',appStart);
const enableStart=push.indexOf('export async function enablePushNotifications(');
const enableEnd=push.indexOf('\nexport async function disablePushNotifications(',enableStart);
const disableEnd=push.indexOf('\nexport async function loadServerPushStatus(',enableEnd);
const testStart=push.indexOf('export async function requestTestPush(');
const testEnd=push.indexOf('\nexport async function listenForForegroundPush(',testStart);
const assertStart=push.indexOf('function assertCurrentPushAction(');
const assertEnd=push.indexOf('\n\nexport async function enablePushNotifications(',assertStart);
assert.ok(appStart>=0&&appEnd>appStart&&enableStart>=0&&enableEnd>enableStart&&testStart>=0&&testEnd>testStart&&assertStart>=0&&assertEnd>assertStart);
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const appJs=compile(app.slice(appStart,appEnd).replace('import("./push")','loadPushModule()'));
const pushSource=(push.slice(assertStart,assertEnd)+'\n'+push.slice(enableStart,enableEnd).replace('export async','async')+'\n'+push.slice(enableEnd,disableEnd).replace('export async','async')+'\n'+push.slice(testStart,testEnd).replace('export async','async')).replaceAll('import.meta.env.VITE_FIREBASE_VAPID_KEY','"synthetic-vapid"');
const pushJs=compile(pushSource);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};}
function scenario({endpoint=null}={}){
  const permission=deferred(),moduleLoad=deferred(),state={registerCalls:0,testCalls:0,unregisterCalls:0,deleteCalls:0,messages:[]};
  const user={uid:'synthetic-admin'},auth={currentUser:user},authEpoch={current:1};
  const pushScope={
    Notification:{requestPermission:()=>permission.promise,permission:'granted'},
    navigator:{serviceWorker:{},userAgent:'synthetic',platform:'synthetic'},
    getClientMessaging:async()=>({}), waitForPushWorker:async()=>({}),getToken:async()=> 'synthetic-token',deleteToken:async()=>{state.deleteCalls++;},currentPushPermission:()=> 'granted',
    httpsCallable:(_functions,name)=>async()=>{if(name==='registerPushToken')state.registerCalls++;else if(name==='sendTestPush')state.testCalls++;else if(name==='unregisterPushToken')state.unregisterCalls++;else throw new Error('unexpected mock call');if(endpoint)await endpoint.promise;},
    Error,Promise,
  };
  runInNewContext(pushJs,pushScope);
  const appScope={
    auth,user,adminAuthEpochRef:authEpoch,adminAuthorizationReadyRef:{current:true},operationEpochRef:{current:1},operationLocksRef:{current:new Map()},pushActionVersionRef:{current:0},
    firebaseConfigured:true,functions:{},adminSessionReady:true,
    setOperationKeys:()=>{},setPushEnabled:()=>{},setMessage:value=>state.messages.push(String(value)),
    loadPushModule:()=>moduleLoad.promise,Error,Promise,Symbol,
  };
  runInNewContext(appJs,appScope);
  return{state,authEpoch,permission,moduleLoad,appScope,pushScope};
}
const enable=scenario();
const enabling=enable.appScope.runPushAction('enable');
enable.moduleLoad.resolve(enable.pushScope);await flush();
enable.authEpoch.current++; // Simulated same-UID token change while permission is pending.
enable.permission.resolve('granted');await enabling;
const test=scenario();
const testing=test.appScope.runPushAction('test');await flush();
test.authEpoch.current++; // Simulated same-UID token change while the module is loading.
test.moduleLoad.resolve(test.pushScope);await testing;
assert.equal(enable.state.registerCalls,0,'a token transition must prevent later registration');
assert.equal(test.state.testCalls,0,'a token transition must prevent later test notification');
const acknowledged=deferred(),known=scenario({endpoint:acknowledged});
known.moduleLoad.resolve(known.pushScope);const knownAction=known.appScope.runPushAction('test');await flush();assert.equal(known.state.testCalls,1);
known.authEpoch.current++;acknowledged.resolve();await knownAction;
assert.equal(known.appScope.operationLocksRef.current.has('push'),false,'a known successful result must release its lock');
assert.ok(known.state.messages.some(value=>value.includes('送信完了')),'a known successful result is not silently converted to a failure');
const afterReturn=scenario();
const originalTest=afterReturn.pushScope.requestTestPush;
afterReturn.pushScope.requestTestPush=async(...args)=>{await originalTest(...args);afterReturn.authEpoch.current++;};
afterReturn.moduleLoad.resolve(afterReturn.pushScope);await afterReturn.appScope.runPushAction('test');
assert.equal(afterReturn.state.testCalls,1);assert.ok(afterReturn.state.messages.some(value=>value.includes('送信完了')),'a transition after helper completion preserves its known result');
assert.equal(afterReturn.appScope.operationLocksRef.current.has('push'),false);
const lost=deferred(),unknown=scenario({endpoint:lost});
unknown.moduleLoad.resolve(unknown.pushScope);const uncertainAction=unknown.appScope.runPushAction('test');await flush();assert.equal(unknown.state.testCalls,1);
unknown.authEpoch.current++;lost.reject(new Error('synthetic response lost'));await uncertainAction;
assert.equal(unknown.appScope.operationLocksRef.current.has('push'),true,'a sent request with an unknown result must retain its lock');
await unknown.appScope.runPushAction('test');assert.equal(unknown.state.testCalls,1,'an explicit click cannot duplicate the unresolved request in this session');
assert.ok(unknown.state.messages.some(value=>value.includes('結果を確認できません')));
const unregistered=deferred(),partial=scenario({endpoint:unregistered});
partial.moduleLoad.resolve(partial.pushScope);const disabling=partial.appScope.runPushAction('disable');await flush();assert.equal(partial.state.unregisterCalls,1);
partial.authEpoch.current++;unregistered.resolve();await disabling;
assert.equal(partial.state.deleteCalls,0,'a revoked action must not continue with another side effect');
assert.equal(partial.appScope.operationLocksRef.current.has('push'),true,'partially completed disable remains unresolved');
console.log(JSON.stringify({status:'PASS',cases:['permission-pending','import-pending','sent-known-success','helper-complete-caller-pending','sent-unknown-no-repeat','partial-disable-no-further-effect'],postChangeMockRegisterCalls:enable.state.registerCalls,postChangeMockTestPushCalls:test.state.testCalls,realNetworkOrNotifications:0}));
