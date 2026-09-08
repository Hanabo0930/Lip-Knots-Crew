import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT || process.cwd(),'package.json'));
const ts=require('typescript');
const source=fs.readFileSync('apps/admin/src/App.tsx','utf8');
const start=source.indexOf('async function runAdminJobAction(');
const fallback=source.indexOf('async function createJobGroup()');
const end=source.indexOf('async function exportJobs()',fallback);
const code=ts.transpileModule(source.slice(start>=0?start:fallback,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function setup({apiFailure=false,refreshFailure=false,data={},demo=false,apiWait=async()=>{},refreshWait=async()=>{}}={}){
 const state={messages:[],calls:[],refreshes:0,revision:2,busy:false,jobs:[{id:'j',workDate:'2026-09-20'}],form:{workDate:'2026-09-20',slots:'1',basePay:'',publishAt:''}};
 const form={...state.form};
 const deps={auth:{currentUser:{}},adminJobActionRef:{current:null},firebaseConfigured:!demo,functions:{},window:{confirm:()=>true,prompt:(_label,value)=>value},
  jobForm:form,blankJobForm:{slots:'1'},jobEditId:'j',jobEditRevision:2,jobEdit:{assignedStaffId:'',clientName:'Synthetic'},invoiceLabels:[],staffPayLabels:[],staff:[],
  setMessage:m=>state.messages.push(m),setJobCreateBusy:b=>state.busy=b,setJobEditBusy:b=>state.busy=b,
  setJobForm:f=>state.form=f(state.form),setJobs:f=>state.jobs=f(state.jobs),setJobEditRevision:r=>state.revision=typeof r==='function'?r(state.revision):r,
  httpsCallable:(_functions,name)=>async()=>{state.calls.push(name);await apiWait();if(apiFailure)throw Error('API rejected');return {data:{jobIds:['new'],revision:3,...data}};},
  loadJobs:async()=>{state.refreshes++;await refreshWait();if(refreshFailure)throw Error('READ_FAILED');},
 };
 const handlers=Function(...Object.keys(deps),code+';return {createJobGroup,duplicateJob,changePublication,saveJobEdit};')(...Object.values(deps));
 return {state,handlers,deps};
}
let cases=0;
const actions=[['createJobGroup',[],/1名分の案件を作成/],['duplicateJob',[{id:'j',workDate:'2026-09-20'}],/1件を複製/],['changePublication',[{id:'j'},'publish'],/公開状態を変更/],['saveJobEdit',[],/保存しました/]];
for(const [name,args,message] of actions){
 for(const refreshFailure of [false,true]){
  const {state,handlers}=setup({refreshFailure});await handlers[name](...args);
  assert.equal(state.calls.length,1);assert.equal(state.refreshes,1);assert.match(state.messages.at(-1),message);
  assert.equal(state.busy,false);
  if(refreshFailure){assert.match(state.messages.at(-1),/一覧/);assert.doesNotMatch(state.messages.at(-1),/READ_FAILED/);}
  if(name==='saveJobEdit')assert.equal(state.revision,3);
  cases++;
 }
 const {state,handlers}=setup({apiFailure:true});await handlers[name](...args);assert.equal(state.refreshes,0);assert.equal(state.messages.at(-1),'API rejected');assert.equal(state.revision,2);assert.equal(state.busy,false);cases++;
 const demo=setup({demo:true});await demo.handlers[name](...args);assert.equal(demo.state.calls.length,0);assert.equal(demo.state.refreshes,0);assert.match(demo.state.messages.at(-1),/デモ/);cases++;
}
for(const data of [{sheetWriteQueued:true},{pendingSourceWrite:true}]){
 const {state,handlers}=setup({data,refreshFailure:true});await handlers.saveJobEdit();assert.match(state.messages.at(-1),data.sheetWriteQueued?/キュー/:/安全確認待ち/);assert.match(state.messages.at(-1),/一覧/);cases++;
}
for(const [name,args,data,pattern] of [['createJobGroup',[],{warning:'要確認の警告'},/要確認の警告/],['changePublication',[{id:'j'},'publish'],{blocked:['j']},/下書きのまま/]]){
 const {state,handlers}=setup({data,refreshFailure:true});await handlers[name](...args);assert.match(state.messages.at(-1),pattern);assert.equal(state.calls.length,1);cases++;
}
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
const resetStart=source.indexOf('      adminJobActionRef.current=null;',source.indexOf('onAuthStateChanged(activeAuth,'));
assert.ok(resetStart>=0);
const resetEnd=source.indexOf('      setAdminSessionReady(false);',resetStart);
const resetCode=source.slice(resetStart,resetEnd);
function switchAuth(test,sameUser=false){
 if(!sameUser)test.deps.auth.currentUser={};
 Function('adminJobActionRef','setJobCreateBusy','setJobEditBusy',resetCode)(test.deps.adminJobActionRef,test.deps.setJobCreateBusy,test.deps.setJobEditBusy);
 test.state.messages=[];
}
for(const [name,args] of actions){
 const gate=deferred(),test=setup({apiWait:()=>gate.promise});
 const first=test.handlers[name](...args);await test.handlers[name](...args);
 assert.equal(test.state.calls.length,1);gate.resolve();await first;assert.equal(test.deps.adminJobActionRef.current,null);cases++;
 for(const sameUser of [false,true]){
  const wait=deferred(),stale=setup({apiWait:()=>wait.promise});const pending=stale.handlers[name](...args);
  switchAuth(stale,sameUser);wait.resolve();await pending;
  assert.equal(stale.state.messages.length,0);assert.equal(stale.state.refreshes,0);assert.equal(stale.state.revision,2);assert.equal(stale.state.busy,false);cases++;
 }
 const refresh=deferred(),staleRefresh=setup({refreshWait:()=>refresh.promise,refreshFailure:true});
 const pending=staleRefresh.handlers[name](...args);while(!staleRefresh.state.refreshes)await Promise.resolve();
 switchAuth(staleRefresh);refresh.resolve();await pending;assert.equal(staleRefresh.state.messages.length,0);cases++;
}
{
 const oldGate=deferred(),newGate=deferred();let call=0;
 const test=setup({apiWait:()=>++call===1?oldGate.promise:newGate.promise});
 const old=test.handlers.saveJobEdit();switchAuth(test);
 const current=test.handlers.createJobGroup();const token=test.deps.adminJobActionRef.current;
 oldGate.resolve();await old;assert.equal(test.deps.adminJobActionRef.current,token);
 await test.handlers.duplicateJob({id:'j'});assert.equal(test.state.calls.length,2);
 newGate.resolve();await current;assert.equal(test.deps.adminJobActionRef.current,null);cases++;
}
{
 const test=setup({apiFailure:true});await test.handlers.saveJobEdit();await test.handlers.saveJobEdit();assert.equal(test.state.calls.length,2);cases++;
}
{
 const test=setup();test.deps.auth.currentUser=null;await test.handlers.saveJobEdit();assert.equal(test.state.calls.length,0);cases++;
}
{
 const test=setup();test.deps.window.confirm=()=>false;await test.handlers.createJobGroup();assert.equal(test.state.calls.length,0);assert.equal(test.deps.adminJobActionRef.current,null);cases++;
}
console.log(`Admin action confirmation: ${cases} cases passed (synthetic API; no external writes).`);
