import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const dependency=createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json'));
const ts=dependency('typescript'),source=fs.readFileSync('apps/staff/src/App.tsx','utf8');
const start=source.indexOf('  async function fetchDevices('),end=source.indexOf('  async function runPushAction(',start);
assert.ok(start>=0&&end>start);
function setup(){
 const state={calls:[],messages:[],logouts:0,confirmations:0,devices:[{id:'current',active:true},{id:'other',active:true}]};
 const ctx={Error,authLoadVersionRef:{current:1},firebaseConfigured:true,functions:{},deviceSessionId:'current',devices:state.devices,isCurrentDevice:d=>d.id==='current',deviceLabel:()=> 'demo',
 setDeviceListUncertain:value=>state.uncertain=value,confirm:()=>{state.confirmations++;return true;},setPendingDeviceId:v=>state.pending=v,setDevices:v=>state.devices=typeof v==='function'?v(state.devices):v,setMessage:v=>state.messages.push(v),setShowAccountMenu:()=>{},setShowDiagnostics:()=>{},closeDiagnostics:()=>{},setShowDevices:()=>{},
 logoutCurrentUser:async()=>{state.logouts++;if(state.logoutFailure)throw Error('signout offline');},httpsCallable:(_f,name)=>input=>new Promise((resolve,reject)=>state.calls.push({name,input,resolve,reject}))};
 const hook={exports:{},require:()=>({useCallback:f=>f,useRef:value=>({current:value}),useState:initial=>[initial(),()=>{}]})};
 runInNewContext(ts.transpileModule(fs.readFileSync('apps/staff/src/useAsyncAction.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,hook);
 Object.assign(ctx,hook.exports.useAsyncAction());runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);return{ctx,state};
}
const results=[];async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});}}
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
for(const mode of ['current','current-signout-failure','other-refresh-failure','auth','double','decline','missing-functions','malformed-list','valid-list'])await test(mode,async()=>{
 const h=setup();if(mode==='decline')h.ctx.confirm=()=>false;
 if(mode==='missing-functions')h.ctx.functions=null;
 if(mode==='malformed-list'||mode==='valid-list'){
  const p=h.ctx.loadDevices();h.state.calls[0].resolve({data:mode==='valid-list'?{devices:[]}: {devices:{bad:true}}});await p;
  if(mode==='malformed-list'){assert.ok(h.state.messages.length);assert.ok(Array.isArray(h.state.devices));}else assert.equal(h.state.devices.length,0);return;
 }
 const id=mode.startsWith('current')?'current':'other',p=h.ctx.revokeDevice(id);
 if(mode==='decline'||mode==='missing-functions'){await p;assert.equal(h.state.calls.length,0);if(mode==='missing-functions'){assert.equal(h.state.devices[1].active,true);assert.ok(h.state.messages.length);}return;}
 if(mode==='double'){void h.ctx.revokeDevice(id);assert.equal(h.state.calls.length,1);assert.equal(h.state.confirmations,1);}
 if(mode==='auth')h.ctx.authLoadVersionRef.current++;
 if(mode==='current-signout-failure')h.state.logoutFailure=true;
 h.state.calls[0].resolve({data:{revoked:true}});await settle();
 if(h.state.calls[1]){if(mode==='other-refresh-failure'||mode.startsWith('current'))h.state.calls[1].reject(Error('list offline'));else h.state.calls[1].resolve({data:{devices:[]}});}
 await p;
 if(mode.startsWith('current')){assert.equal(h.state.logouts,1);assert.equal(h.state.calls.length,1);if(mode==='current-signout-failure')assert.match(h.state.messages.at(-1),/受付済み/);}
 if(mode==='other-refresh-failure')assert.match(h.state.messages.at(-1),/受付済み/);
 if(mode==='auth'){assert.equal(h.state.calls.length,1);assert.equal(h.state.logouts,0);assert.equal(h.state.messages.length,0);}
 assert.equal(h.ctx.isPending('device-action'),false);
});

for(const data of [null,{}, {devices:[null]}, {devices:[{id:2}]}])await test('reject malformed device payload '+JSON.stringify(data),async()=>{const h=setup(),p=h.ctx.loadDevices();h.state.calls[0].resolve({data});await p;assert.ok(h.state.messages.length);assert.ok(Array.isArray(h.state.devices));assert.equal(h.ctx.isPending('device-action'),false);});
await test('demo revocation stays local',async()=>{const h=setup();h.ctx.firebaseConfigured=false;await h.ctx.revokeDevice('other');assert.equal(h.state.calls.length,0);assert.equal(h.state.devices[1].active,false);});
for(const mode of ['missing','inactive','current-label','other-label','cancel'])await test('target confirmation '+mode,async()=>{
 const h=setup();h.ctx.devices[0].label='同名端末';h.ctx.devices[1].label='同名端末';h.ctx.firebaseConfigured=false;
 let prompt='';h.ctx.confirm=value=>{prompt=value;return mode!=='cancel'};
 if(mode==='inactive')h.ctx.devices[1].active=false;
 await h.ctx.revokeDevice(mode==='missing'?'missing':mode==='current-label'?'current':'other');
 assert.equal(h.state.calls.length,0);
 if(mode==='missing'||mode==='inactive'){assert.equal(prompt,'');if(mode==='missing')assert.match(h.state.messages.at(-1),/再読込/);return;}
 assert.match(prompt,mode==='current-label'?/1件目の「同名端末」/:/2件目の「同名端末」/);
 assert.equal(prompt.includes('現在使用中のこの端末'),mode==='current-label');
 if(mode==='cancel')assert.equal(h.state.devices[1].active,true);
 else assert.equal(h.state.devices[mode==='current-label'?0:1].active,false);
});
for(const data of [null,{},[],{revoked:false},{revoked:'true'},{revoked:1},'invalid'])for(const mode of ['current','other','stale-auth'])await test('unconfirmed revocation '+mode+' '+JSON.stringify(data),async()=>{
 const h=setup(),id=mode==='current'?'current':'other';const previous=h.state.devices;const pending=h.ctx.revokeDevice(id);if(mode==='stale-auth')h.ctx.authLoadVersionRef.current++;h.state.calls[0].resolve({data});await pending;assert.equal(h.state.logouts,0);assert.equal(h.state.calls.length,1);assert.equal(h.state.devices,previous);assert.equal(h.ctx.isPending('device-action'),false);if(mode==='stale-auth')assert.equal(h.state.messages.length,0);else{assert.equal(h.state.pending,'');assert.match(h.state.messages.at(-1),/受付結果を確認できません/);assert.match(h.state.messages.at(-1),/端末一覧を再読込/);assert.equal(h.state.messages.some(m=>m==='端末をログアウトしました。'),false);}
});
for(const [label,platform,expected] of [[' 端末A ',' Windows ','端末A'],['　 ',' Android ','Android'],['','　','端末'],[null,' iPhone ','iPhone'],[undefined,undefined,'端末']])for(const id of ['current','other'])await test('trim device confirmation '+id+' '+expected,async()=>{const h=setup();Object.assign(h.ctx.devices.find(d=>d.id===id),{label,platform});let prompt;h.ctx.confirm=value=>{prompt=value;return false;};await h.ctx.revokeDevice(id);assert.ok(prompt.includes('「'+expected+'」'));assert.equal(prompt.includes('現在使用中のこの端末'),id==='current');assert.equal(h.state.calls.length,0);});

for(const mode of ['offline','missing-functions','stale'])await test('persistent device freshness '+mode,async()=>{
 const h=setup(),previous=h.state.devices;if(mode==='missing-functions')h.ctx.functions=null;const pending=h.ctx.loadDevices();assert.equal(h.state.uncertain,true);
 if(mode==='stale'){h.ctx.authLoadVersionRef.current++;h.state.uncertain=false;h.state.calls[0].resolve({data:{devices:[]}});}else if(mode==='offline')h.state.calls[0].reject(Error('offline'));
 await pending;assert.equal(h.state.devices,previous);assert.equal(h.state.uncertain,mode!=='stale');assert.equal(h.ctx.isPending('device-action'),false);
 if(mode!=='stale'){h.ctx.functions={};const retry=h.ctx.loadDevices();h.state.calls.at(-1).resolve({data:{devices:[]}});await retry;assert.equal(h.state.uncertain,false);assert.equal(h.state.devices.length,0);}
});
console.log(JSON.stringify({cases:results.length,passed:results.every(r=>r.passed),results},null,2));if(results.some(r=>!r.passed))process.exitCode=1;
