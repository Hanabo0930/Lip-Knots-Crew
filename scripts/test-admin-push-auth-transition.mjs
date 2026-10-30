import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(new URL('../package.json',import.meta.url));
const ts=require('typescript');
const source=readFileSync(new URL('../apps/admin/src/App.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const handler=source.indexOf('listenForForegroundPush('),begin=source.lastIndexOf('  useEffect(() => {',handler);
const marker='\n  }, [user,adminAuthorized,adminTokenChecking,adminTokenRevision]);',end=source.indexOf(marker,handler);
assert.ok(begin>=0&&end>begin,'the actual authenticated foreground Push effect must be present');
const compiled=ts.transpileModule(source.slice(begin,end+marker.length).replace('import("./push")','loadPushModule()'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
function setup({authorized=true,checking=false,importGate=null,subscriptionGate=null}={}){
 const user={uid:'synthetic-admin-a'},auth={currentUser:user},epoch={current:1};
 const state={subscriptions:0,unsubscriptions:0,messages:[],handler:null,cleanup:null};
 const listener=async fn=>{state.subscriptions++;state.handler=fn;if(subscriptionGate)await subscriptionGate.promise;return()=>{state.unsubscriptions++;};};
 const scope={user,auth,adminAuthorized:authorized,adminTokenChecking:checking,adminTokenRevision:0,adminAuthEpochRef:epoch,
   useEffect:fn=>{state.cleanup=fn();},setMessage:value=>state.messages.push(String(value)),
   loadPushModule:async()=>{if(importGate)await importGate.promise;return{listenForForegroundPush:listener};}};
 runInNewContext(compiled,scope);return{state,user,auth,epoch};
}
const payload={data:{title:'synthetic-admin-title',body:'synthetic-admin-body'}};
const pending=setup({authorized:false});await flush();assert.equal(pending.state.subscriptions,0,'unverified users never subscribe');assert.deepEqual(pending.state.messages,[]);
const checking=setup({checking:true});await flush();assert.equal(checking.state.subscriptions,0,'token verification must suspend foreground Push');
const normal=setup();await flush();assert.equal(normal.state.subscriptions,1);normal.state.handler(payload);assert.deepEqual(normal.state.messages,['synthetic-admin-title：synthetic-admin-body']);
normal.auth.currentUser={uid:'synthetic-admin-b'};normal.epoch.current++;normal.state.handler(payload);assert.equal(normal.state.messages.length,1,'an old callback is ignored immediately on account switch');normal.state.cleanup();assert.equal(normal.state.unsubscriptions,1);
const sameUid=setup();await flush();sameUid.epoch.current++;sameUid.state.handler(payload);assert.deepEqual(sameUid.state.messages,[],'an old callback is ignored after auth generation changes');sameUid.state.cleanup();
const importGate=deferred(),lateImport=setup({importGate});lateImport.auth.currentUser={uid:'synthetic-staff'};lateImport.epoch.current++;importGate.resolve();await flush();assert.equal(lateImport.state.subscriptions,0,'delayed module cannot subscribe after a switch');lateImport.state.cleanup();
const subscriptionGate=deferred(),lateSubscription=setup({subscriptionGate});await flush();assert.equal(lateSubscription.state.subscriptions,1);lateSubscription.state.cleanup();lateSubscription.state.handler(payload);assert.deepEqual(lateSubscription.state.messages,[]);subscriptionGate.resolve();await flush();assert.equal(lateSubscription.state.unsubscriptions,1,'late subscription is immediately removed');
console.log(JSON.stringify({status:'PASS',cases:['unverified','token-checking','current-admin','account-switch','same-uid-auth-event','delayed-import','delayed-subscription'],realNetworkOrNotifications:0,limitation:'Payloads do not establish recipient ownership; an old device registration to another authorized Admin remains unverified.'}));
