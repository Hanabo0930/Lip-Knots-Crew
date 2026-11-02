import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../apps/admin/src/App.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const messageStart=source.indexOf('function adminLoginErrorMessage(');
const messageEnd=source.indexOf('\n\nexport default function App()',messageStart);
const loginStart=source.indexOf('  async function login() {');
const loginEnd=source.indexOf('\n\n  async function loadAdminDirectory(',loginStart);
assert.ok(messageStart>=0&&messageEnd>messageStart&&loginStart>=0&&loginEnd>loginStart);
// Only these parameter/return annotations are removed; the production bodies run unchanged.
const messageCode=source.slice(messageStart,messageEnd).replace('(error: unknown): string','(error)');
const loginCode=source.slice(loginStart,loginEnd);
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function harness(){
  const state={calls:0,messages:[],busy:[],next:async()=>{},providerError:false};
  const scope={auth:{currentUser:null},loginAttemptRef:{current:null},setLoginMessage:value=>state.messages.push(value),setLoginBusy:value=>state.busy.push(value),
    GoogleAuthProvider:class{constructor(){if(state.providerError)throw new Error('synthetic provider failure');}},
    signInWithPopup:async(activeAuth)=>{assert.equal(activeAuth,scope.auth);state.calls++;return state.next();}};
  runInNewContext(messageCode+'\n'+loginCode,scope);
  return{state,scope,login:()=>scope.login()};
}
const cases=[];
for(const [code,expected] of [['auth/popup-blocked',/ポップアップ/],['auth/popup-closed-by-user',/閉じられました/],['auth/unauthorized-domain',/この画面のアドレス/],['auth/network-request-failed',/通信状態/],['auth/unknown',/完了できません/]]){
  const h=harness();h.state.next=async()=>{throw {code,message:'synthetic-private-error https://example.invalid/?secret=synthetic'};};
  await assert.doesNotReject(h.login());
  assert.equal(h.state.calls,1);assert.deepEqual(h.state.busy,[true,false]);
  assert.match(h.state.messages.at(-1),expected);assert.doesNotMatch(h.state.messages.at(-1),/synthetic-private|example\.invalid|secret=/);
  assert.equal(h.scope.loginAttemptRef.current,null);cases.push(code);
}
const held=deferred(),duplicate=harness();duplicate.state.next=()=>held.promise;
const first=duplicate.login();await duplicate.login();assert.equal(duplicate.state.calls,1);assert.deepEqual(duplicate.state.busy,[true]);held.resolve();await first;
assert.deepEqual(duplicate.state.busy,[true,false]);cases.push('double-click-one-popup');
const retry=harness();retry.state.next=async()=>{throw {code:'auth/network-request-failed'};};await retry.login();
const secondGate=deferred();retry.state.next=()=>secondGate.promise;const second=retry.login();assert.equal(retry.state.messages.at(-1),'','a valid retry clears the prior error before the popup settles');secondGate.resolve();await second;assert.equal(retry.state.calls,2);cases.push('retry-clears-old-error');
const changed=harness(),changedGate=deferred();changed.state.next=()=>changedGate.promise;const changedTask=changed.login();changed.scope.auth.currentUser={uid:'synthetic-other'};changedGate.reject({code:'auth/unauthorized-domain'});await changedTask;
assert.deepEqual(changed.state.messages,['']);assert.deepEqual(changed.state.busy,[true]);cases.push('changed-account-discards-late-error');
const unmounted=harness(),unmountedGate=deferred();unmounted.state.next=()=>unmountedGate.promise;const unmountedTask=unmounted.login();
const cleanupLine=source.split('\n').find(line=>line.includes('useEffect(() => () => { loginAttemptRef.current = null; }, []);'));assert.ok(cleanupLine);
runInNewContext(cleanupLine,{loginAttemptRef:unmounted.scope.loginAttemptRef,useEffect:setup=>setup()()});unmountedGate.reject({code:'auth/popup-blocked'});await unmountedTask;
assert.deepEqual(unmounted.state.messages,['']);assert.deepEqual(unmounted.state.busy,[true]);cases.push('unmount-discards-late-error');
const noAuth=harness();noAuth.scope.auth=null;await noAuth.login();assert.equal(noAuth.state.calls,0);assert.deepEqual(noAuth.state.busy,[]);cases.push('no-auth-no-popup');
const provider=harness();provider.state.providerError=true;await assert.doesNotReject(provider.login());assert.equal(provider.state.calls,0);assert.deepEqual(provider.state.busy,[true,false]);assert.match(provider.state.messages.at(-1),/完了できません/);cases.push('synchronous-provider-error-recovered');
console.log(JSON.stringify({status:'PASS',suite:'Admin login recovery',cases,actualAppBodies:true,realAuthCalls:0}));
