import assert from 'node:assert/strict';import fs from 'node:fs';import {runInNewContext} from 'node:vm';import ts from 'typescript';
const source=fs.readFileSync('apps/staff/src/App.tsx','utf8');const marker=source.indexOf('    if(!user||!deviceSessionId||!functions||!db||!auth)return;');const start=source.lastIndexOf('  useEffect(()=>{',marker),end=source.indexOf('  },[user,deviceSessionId,companyId,staffId]);',marker)+'  },[user,deviceSessionId,companyId,staffId]);'.length;assert.ok(start>=0&&end>start);const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
let count=0;
for(const mode of ['permission','signout-failure','other-error','null-error','auth','stopped','failure-after-auth']){
 let reject,cleanup,watch,interval,signoutReject;const state={calls:0,signouts:0,messages:[],clears:0,unsubscribed:0,removed:0};
 const ctx={user:{uid:'user'},deviceSessionId:'device',functions:{},db:{},auth:{},companyId:'company',staffId:'staff',authLoadVersionRef:{current:1},DEVICE_HEARTBEAT_INTERVAL_MS:60000,useEffect:fn=>cleanup=fn(),httpsCallable:()=>()=>{state.calls++;return new Promise((_,no)=>reject=no)},setMessage:value=>state.messages.push(value),clearBusinessSnapshot:()=>state.clears++,signOut:async()=>{state.signouts++;if(mode==='signout-failure')throw Error('offline');if(mode==='failure-after-auth')await new Promise((_,no)=>signoutReject=no)},watchDeviceSession:(_id,fn)=>{watch=fn;return()=>state.unsubscribed++},window:{setInterval:fn=>{interval=fn;return 1},clearInterval:()=>{}},document:{addEventListener:()=>{},removeEventListener:()=>state.removed++},refreshPushStatus:()=>{},refreshBusinessData:()=>{}};
 runInNewContext(code,ctx);interval();interval();assert.equal(state.calls,1);if(mode==='auth')ctx.authLoadVersionRef.current++;if(mode==='stopped')cleanup();reject(mode==='null-error'?null:{code:mode==='other-error'?'unavailable':'functions/permission-denied'});await new Promise(resolve=>setImmediate(resolve));
 if(mode==='failure-after-auth'){ctx.authLoadVersionRef.current++;signoutReject(Error('late failure'));await new Promise(resolve=>setImmediate(resolve));}
 const revoked=['permission','signout-failure','failure-after-auth'].includes(mode);assert.equal(state.signouts,revoked?1:0);assert.equal(state.clears,revoked?1:0);assert.equal(state.messages.length,mode==='signout-failure'?2:revoked?1:0);
 if(mode!=='stopped')cleanup();await watch();interval();assert.equal(state.signouts,revoked?1:0);assert.equal(state.calls,1);assert.equal(state.unsubscribed,1);assert.equal(state.removed,1);count++;
}
console.log('Device watch passed: '+count+' heartbeat error/signout failure/auth switch/cleanup cases; no real session operations.');

{
 const calls=[];let cleanup,interval,visible;const ctx={user:{uid:'user'},deviceSessionId:'device',functions:{},db:{},auth:{},companyId:'company',staffId:'staff',authLoadVersionRef:{current:1},DEVICE_HEARTBEAT_INTERVAL_MS:60000,useEffect:fn=>cleanup=fn(),httpsCallable:()=>()=>new Promise((resolve,reject)=>calls.push({resolve,reject})),setMessage:()=>{},clearBusinessSnapshot:()=>{},signOut:async()=>{},watchDeviceSession:()=>()=>{},window:{setInterval:fn=>{interval=fn;return 1},clearInterval:()=>{}},document:{visibilityState:'visible',addEventListener:(_event,fn)=>visible=fn,removeEventListener:()=>{}},refreshPushStatus:()=>{},refreshBusinessData:()=>{}};
 runInNewContext(code,ctx);interval();visible();assert.equal(calls.length,1);calls[0].resolve({data:{}});await new Promise(resolve=>setImmediate(resolve));visible();interval();assert.equal(calls.length,2);calls[1].reject(Error('offline'));await new Promise(resolve=>setImmediate(resolve));interval();visible();assert.equal(calls.length,3);cleanup();calls[2].resolve({data:{}});await new Promise(resolve=>setImmediate(resolve));interval();visible();assert.equal(calls.length,3);
 console.log('Heartbeat overlap passed: timer/visibility share one pending request; success/error release lock, cleanup prevents further requests.');
}

for(const mode of ['watch-first','heartbeat-first','failure-retry','auth-before-watch']){
 let cleanup,watch,rejectHeartbeat,interval;const signouts=[],messages=[];let clears=0;const ctx={user:{uid:'user'},deviceSessionId:'device',functions:{},db:{},auth:{},companyId:'company',staffId:'staff',authLoadVersionRef:{current:1},DEVICE_HEARTBEAT_INTERVAL_MS:60000,useEffect:fn=>cleanup=fn(),httpsCallable:()=>()=>new Promise((_,reject)=>rejectHeartbeat=reject),setMessage:value=>messages.push(value),clearBusinessSnapshot:()=>clears++,signOut:()=>new Promise((resolve,reject)=>signouts.push({resolve,reject})),watchDeviceSession:(_id,fn)=>{watch=fn;return()=>{}},window:{setInterval:fn=>{interval=fn;return 1},clearInterval:()=>{}},document:{addEventListener:()=>{},removeEventListener:()=>{}},refreshPushStatus:()=>{},refreshBusinessData:()=>{}};
 runInNewContext(code,ctx);
 if(mode==='auth-before-watch'){ctx.authLoadVersionRef.current++;await watch();rejectHeartbeat({code:'permission-denied'});await new Promise(resolve=>setImmediate(resolve));assert.equal(signouts.length,0);assert.equal(messages.length,0);cleanup();continue;}
 if(mode==='heartbeat-first'){rejectHeartbeat({code:'permission-denied'});await new Promise(resolve=>setImmediate(resolve));void watch();}
 else{void watch();rejectHeartbeat({code:'permission-denied'});await new Promise(resolve=>setImmediate(resolve));}
 void watch();interval();assert.equal(signouts.length,1);assert.equal(clears,1);
 if(mode==='failure-retry'){signouts[0].reject(Error('offline'));await new Promise(resolve=>setImmediate(resolve));assert.match(messages.at(-1),/再読み込み/);void watch();assert.equal(signouts.length,2);signouts[1].resolve();}
 else signouts[0].resolve();
 await new Promise(resolve=>setImmediate(resolve));await watch();assert.equal(signouts.length,mode==='failure-retry'?2:1);cleanup();
}
console.log('Revocation overlap passed: both arrival orders deduplicate, completed signout stays latched, failure retries, stale auth stays untouched.');
