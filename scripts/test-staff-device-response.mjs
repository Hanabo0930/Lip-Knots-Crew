import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync('apps/staff/src/App.tsx','utf8');
const start=source.indexOf('  async function fetchDevices('),end=source.indexOf('  async function loadDevices(',start);
assert.ok(start>=0&&end>start);
const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
let count=0;
for(const value of [null,{},[null],[[]],[{id:''}],[{id:'  '}],[{id:'same'},{id:'same'}],...[['label',{}],['platform',42],['deviceId',[]],['uid',false],['active','false'],['active',null]].map(([key,value])=>[{id:'device',[key]:value}])]){
 let next=value;const previous=[{id:'preserved'}],state={devices:previous};const ctx={authLoadVersionRef:{current:1},firebaseConfigured:true,functions:{},httpsCallable:()=>async()=>({data:{devices:next}}),setDeviceListUncertain:value=>state.uncertain=value,setDevices:items=>state.devices=items};runInNewContext(code,ctx);
 await assert.rejects(ctx.fetchDevices(),/端末情報を確認できません/);assert.equal(state.devices,previous);assert.equal(state.uncertain,true);
 next=[{id:'valid',label:'この端末',platform:'Windows',deviceId:'local',uid:'user',active:true},{id:'inactive',active:false}];await ctx.fetchDevices();assert.equal(state.devices,next);assert.equal(state.uncertain,false);count++;
}
for(const value of [[],[{id:'legacy'}],[{id:'fallback',label:null,platform:''}]]){
 const state={devices:null};const ctx={authLoadVersionRef:{current:1},firebaseConfigured:true,functions:{},httpsCallable:()=>async()=>({data:{devices:value}}),setDeviceListUncertain:value=>state.uncertain=value,setDevices:items=>state.devices=items};runInNewContext(code,ctx);await ctx.fetchDevices();assert.equal(state.devices,value);assert.equal(state.uncertain,false);count++;
}
console.log('Device response passed: '+count+' malformed/recovery and valid empty/legacy cases; synthetic SDK only.');

{
 const start=source.indexOf('  async function registerCurrentDevice('),end=source.indexOf('  async function logoutCurrentUser()',start);assert.ok(start>=0&&end>start);
 const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 let total=0;
 for(const data of [null,{}, {sessionId:42},{sessionId:{}},{sessionId:[]},{sessionId:''},{sessionId:'   '},{sessionId:'path/id'},{sessionId:'valid-session'}])for(const stale of [false,true]){
  let resolve;const state={ids:[],calls:0};const ctx={functions:{},authLoadVersionRef:{current:1},currentDeviceId:'local-device',deviceLabel:()=> 'fixture',navigator:{platform:'fixture',userAgent:'fixture'},httpsCallable:()=>()=>{state.calls++;return new Promise(yes=>resolve=yes)},setDeviceSessionId:id=>state.ids.push(id)};
  runInNewContext(code,ctx);const pending=ctx.registerCurrentDevice();if(stale)ctx.authLoadVersionRef.current++;resolve({data});
  if(stale)assert.equal(await pending,'');else if(data?.sessionId==='valid-session')assert.equal(await pending,'valid-session');else await assert.rejects(pending,/端末登録の応答/);
  assert.deepEqual(state.ids,!stale&&data?.sessionId==='valid-session'?['valid-session']:[]);await ctx.registerCurrentDevice(0);assert.equal(state.calls,1);total++;
 }
 console.log('Device registration response passed: '+total+' current/stale cases; invalid IDs never set, stale entry makes no call.');
}

{
 const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');const start=source.indexOf('<small>{isCurrentDevice(device)?'),end=source.indexOf('</small>',start)+8;assert.ok(start>=0&&end>start);const code=ts.transpileModule('globalThis.node='+source.slice(start,end)+';',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
 for(const current of [false,true])for(const [active,expected] of [[true,'利用中'],[false,'ログアウト済み'],[undefined,'利用状況未確認']]){const ctx={React:{createElement},device:{active},isCurrentDevice:()=>current};runInNewContext(code,ctx);assert.equal(renderToStaticMarkup(ctx.node),'<small>'+(current?'この端末 / ':'')+expected+'</small>');}
 console.log('Device activity labels: 6 current/other and active/inactive/legacy-missing cases avoid treating unknown activity as active.');
}

{
 const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');const start=source.indexOf('<div className="device-row"'),end=source.indexOf('</div>)}',start)+6;assert.ok(start>=0&&end>start);const code=ts.transpileModule('globalThis.node='+source.slice(start,end)+';',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
 for(const [label,platform,expected] of [[' 端末A ',' Windows ','端末A'],['　 ',' Android ','Android'],['','　','端末'],[null,' iPhone ','iPhone'],[undefined,undefined,'端末']]){const ctx={React:{createElement},device:{id:'one',active:true,label,platform},index:0,isCurrentDevice:()=>false,deviceActionPending:false,pendingDeviceId:'',revokeDevice:()=>assert.fail('Rendering must not revoke devices')};runInNewContext(code,ctx);const html=renderToStaticMarkup(ctx.node);assert.ok(html.includes('aria-label="端末 1件目: '+expected+'"'));assert.ok(html.includes('<strong>1. '+expected+'</strong>'));}
 console.log('Device labels: 5 whitespace/null/missing names use matching visible and accessible fallback labels.');
}

{
 const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');const start=source.indexOf('{!deviceActionPending&&deviceListUncertain&&'),end=source.indexOf('</p>}',start)+5;assert.ok(start>=0&&end>start);const code=ts.transpileModule('globalThis.node=<div>'+source.slice(start,end)+'</div>;',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
 for(const pending of [false,true])for(const uncertain of [false,true])for(const populated of [false,true]){const ctx={React:{createElement},deviceActionPending:pending,deviceListUncertain:uncertain,devices:populated?[{id:'old'}]:[]};runInNewContext(code,ctx);const html=renderToStaticMarkup(ctx.node);assert.equal(html.includes('再読込'),!pending&&uncertain);if(!pending&&uncertain)assert.equal(html.includes('前回の内容'),populated);}
}
console.log('Device list freshness: malformed list preserves a persistent uncertainty flag, successful recovery clears it; 8 JSX conditions distinguish prior data from no data.');
