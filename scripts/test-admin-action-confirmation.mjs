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
 const deps={jobEditBaselineRef:{current:{}},jobEditContextRef:{current:0},blankJobEdit:{},setTimeout:()=>{},setJobEditId:id=>state.editId=id,setJobEdit:value=>state.edit=typeof value==="function"?value(state.edit??deps.jobEdit):value,auth:{currentUser:{}},adminJobActionRef:{current:null},firebaseConfigured:!demo,functions:{},window:{confirm:()=>true,prompt:(_label,value)=>value},
  jobForm:form,blankJobForm:{slots:'1'},jobEditId:'j',jobEditRevision:2,jobEdit:{assignedStaffId:'',clientName:'Synthetic'},invoiceLabels:[],staffPayLabels:[],staff:[],
  setMessage:m=>state.messages.push(m),setJobCreateBusy:b=>state.busy=b,setJobEditBusy:b=>state.busy=b,
  setJobForm:f=>state.form=f(state.form),setJobs:f=>state.jobs=f(state.jobs),setJobEditRevision:r=>state.revision=typeof r==='function'?r(state.revision):r,
  httpsCallable:(_functions,name)=>async(payload)=>{state.payload=payload;state.calls.push(name);await apiWait();if(apiFailure)throw Error('API rejected');return {data:{jobIds:['new'],revision:3,...data}};},
  loadJobs:async()=>{state.refreshes++;await refreshWait();if(refreshFailure)throw Error('READ_FAILED');},
 };
 const handlers=Function(...Object.keys(deps),code+';return {createJobGroup,duplicateJob,changePublication,saveJobEdit,loadJobEdit};')(...Object.values(deps));
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
 Function(...Object.keys(test.deps),resetCode)(...Object.values(test.deps));
 test.state.messages=[];
}
for(const [name,args] of actions){
 const gate=deferred(),test=setup({apiWait:()=>gate.promise});
 const first=test.handlers[name](...args);await test.handlers[name](...args);
 assert.equal(test.state.calls.length,1);gate.resolve();await first;assert.equal(test.deps.adminJobActionRef.current,null);cases++;
 for(const sameUser of [false,true]){
  const wait=deferred(),stale=setup({apiWait:()=>wait.promise});const pending=stale.handlers[name](...args);
  switchAuth(stale,sameUser);wait.resolve();await pending;
  assert.equal(stale.state.messages.length,0);assert.equal(stale.state.refreshes,0);assert.equal(stale.state.revision,0);assert.equal(stale.state.busy,false);cases++;
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
for(const id of ['other','j']){
 for(const apiFailure of [false,true]){
  const gate=deferred(),test=setup({apiWait:()=>gate.promise,apiFailure});
  const pending=test.handlers.saveJobEdit();
  test.handlers.loadJobEdit({id,revision:9,clientName:'New form'});
  const messagesBefore=[...test.state.messages];gate.resolve();await pending;
  assert.equal(test.state.revision,9);assert.equal(test.state.editId,id);assert.equal(test.state.edit.clientName,'New form');
  assert.deepEqual(test.state.messages,messagesBefore);assert.equal(test.state.refreshes,0);assert.equal(test.state.busy,false);assert.equal(test.deps.adminJobActionRef.current,null);cases++;
 }
}
{
 const gate=deferred(),test=setup({refreshWait:()=>gate.promise,refreshFailure:true});
 const pending=test.handlers.saveJobEdit();while(!test.state.refreshes)await Promise.resolve();
 test.handlers.loadJobEdit({id:'other',revision:8});gate.resolve();await pending;
 assert.equal(test.state.revision,8);assert.equal(test.state.messages.at(-1),'');assert.equal(test.state.busy,false);cases++;
}
console.log(`Admin action confirmation: ${cases} cases passed (synthetic API; no external writes).`);

for(const id of ['j','other']){
 const test=setup();const before=test.deps.jobEditBaselineRef.current;test.deps.window.confirm=()=>false;
 assert.equal(test.handlers.loadJobEdit({id,revision:9}),false);assert.equal(test.deps.jobEditContextRef.current,0);assert.equal(test.state.revision,2);assert.equal(test.state.edit,undefined);assert.equal(test.deps.jobEditBaselineRef.current,before);
 test.deps.window.confirm=()=>true;assert.equal(test.handlers.loadJobEdit({id,revision:9,clientName:'New'}),true);assert.equal(test.state.edit.clientName,'New');assert.equal(test.deps.jobEditBaselineRef.current,test.state.edit);
}
for(const options of [{},{demo:true},{refreshFailure:true},{apiFailure:true}]){
 const test=setup(options);await test.handlers.saveJobEdit();
 assert.equal(test.deps.jobEditBaselineRef.current===test.deps.jobEdit,!options.apiFailure);
 if(!options.apiFailure){test.deps.window.confirm=()=>{throw Error('unchanged form must not prompt')};test.handlers.loadJobEdit({id:'other'});}
}
{const gate=deferred(),test=setup({apiWait:()=>gate.promise});const pending=test.handlers.saveJobEdit();switchAuth(test);gate.resolve();await pending;assert.equal(test.deps.jobEditBaselineRef.current,test.deps.blankJobEdit);assert.equal(test.state.editId,'');assert.equal(test.state.edit,test.deps.blankJobEdit);}
console.log('Unsaved edit: discard/cancel, accepted/error baseline, and auth reset passed.');

{
 const gate=deferred(),test=setup({apiWait:()=>gate.promise});const submitted=test.deps.jobEdit;const pending=test.handlers.saveJobEdit();
 test.deps.jobEdit={...submitted,clientName:'Typed while saving'};
 const newerHandlers=Function(...Object.keys(test.deps),code+';return {loadJobEdit};')(...Object.values(test.deps));
 gate.resolve();await pending;assert.equal(test.deps.jobEditBaselineRef.current,submitted);
 let prompts=0;test.deps.window.confirm=()=>{prompts++;return false};assert.equal(newerHandlers.loadJobEdit({id:'other'}),false);assert.equal(prompts,1);
}
console.log('Pending-save input remains dirty after the submitted snapshot is accepted.');

for(const demo of [false,true]){
 for(const [raw,expected] of [['',null],['　 ',null],['0',0],['12,000円',12000],['￥１２，３４５',12345],['▲500',-500],['△１２',-12],['12.5',12.5],['-1000000',-1000000],['10000000',10000000]]){
  const test=setup({demo});test.deps.invoiceLabels.push(['invoiceBase','請求 基本単価']);test.deps.staffPayLabels.push(['staffBasePay','支払 基本給']);Object.assign(test.deps.jobEdit,{invoiceBase:raw,staffBasePay:raw});await test.handlers.saveJobEdit();
  const fields=demo?test.state.jobs[0]:test.state.payload.fields;assert.equal(fields.clientChargeInputs.invoiceBase,expected);assert.equal(fields.staffPaymentInputs.staffBasePay,expected);
 }
 for(const key of ['invoiceBase','staffBasePay'])for(const raw of ['abc','Infinity','NaN','1e309','10000001','-1000001']){
  const test=setup({demo});test.deps.invoiceLabels.push(['invoiceBase','請求 基本単価']);test.deps.staffPayLabels.push(['staffBasePay','支払 基本給']);Object.assign(test.deps.jobEdit,{invoiceBase:'',staffBasePay:'',[key]:raw});test.deps.window.confirm=()=>{throw Error('invalid values must fail before confirmation')};await test.handlers.saveJobEdit();
  assert.equal(test.state.calls.length,0);assert.equal(test.state.revision,2);assert.equal(test.state.jobs[0].clientChargeInputs,undefined);assert.match(test.state.messages.at(-1),key==='invoiceBase'?/請求 基本単価/:/支払 基本給/);assert.equal(test.state.busy,false);
 }
}
console.log('Money edit: 44 demo/API normalization and invalid-input cases passed.');

{
 const start=source.indexOf('  useEffect(()=>{',source.indexOf('  const jobEditDirty=')),end=source.indexOf('  },[jobEditDirty,expenseDirty]);',start)+'  },[jobEditDirty,expenseDirty]);'.length;assert.ok(start>0&&end>start);
 const effect=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const jobDirty of [false,true])for(const expenseDirty of [false,true]){const dirty=jobDirty||expenseDirty;const handlers=new Set();let cleanup;const window={addEventListener:(name,fn)=>{assert.equal(name,'beforeunload');handlers.add(fn)},removeEventListener:(name,fn)=>{assert.equal(name,'beforeunload');handlers.delete(fn)}};Function('jobEditDirty','expenseDirty','window','useEffect',effect)(jobDirty,expenseDirty,window,fn=>cleanup=fn());assert.equal(handlers.size,dirty?1:0);if(dirty){let prevented=false;const event={preventDefault:()=>prevented=true,returnValue:undefined};[...handlers][0](event);assert.equal(prevented,true);assert.equal(event.returnValue,'');cleanup();assert.equal(handlers.size,0);}}
}
console.log('Unsaved exit: dirty-only beforeunload registration, cancellation and cleanup passed.');

let changeCases=0;
for(const demo of [false,true]){
 const test=setup({demo});test.deps.jobEditBaselineRef.current={...test.deps.jobEdit};test.deps.window.confirm=()=>{throw Error('Unchanged save must not ask for confirmation');};
 await test.handlers.saveJobEdit();assert.equal(test.state.calls.length,0);assert.equal(test.state.refreshes,0);assert.equal(test.state.revision,2);assert.match(test.state.messages.at(-1),/変更はありません/);assert.deepEqual(test.state.edit,test.deps.jobEdit);assert.notEqual(test.state.edit,test.deps.jobEdit);changeCases++;
}
for(const demo of [false,true]){
 const test=setup({demo});test.deps.invoiceLabels.push(['invoiceBase','請求']);test.deps.staffPayLabels.push(['staffBasePay','支払']);
 Object.assign(test.deps.jobEdit,{clientName:' Ｓｙｎｔｈｅｔｉｃ ',invoiceBase:'￥１，０００',staffBasePay:'　'});
 test.deps.jobEditBaselineRef.current={...test.deps.jobEdit,clientName:'Synthetic',invoiceBase:'1000',staffBasePay:''};
 test.deps.window.confirm=()=>{throw Error('Equivalent values must not ask for confirmation');};
 await test.handlers.saveJobEdit();assert.equal(test.state.calls.length,0);assert.equal(test.state.revision,2);assert.match(test.state.messages.at(-1),/変更はありません/);assert.equal(test.deps.jobEditBaselineRef.current,test.deps.jobEdit);changeCases++;
}
{
 const test=setup();Object.assign(test.deps.jobEdit,{assignedStaffId:'existing-staff',storeAddress:'New address'});test.deps.jobEditBaselineRef.current={...test.deps.jobEdit,storeAddress:'Old address'};
 await test.handlers.saveJobEdit();assert.deepEqual(test.state.payload.fields,{storeAddress:'New address'});changeCases++;
}
{
 const test=setup();Object.assign(test.deps.jobEdit,{assignedStaffId:'existing-staff',clientName:'Renamed'});test.deps.jobEditBaselineRef.current={...test.deps.jobEdit,clientName:'Previous'};test.state.jobs[0].status='cancelled';
 await test.handlers.saveJobEdit();assert.deepEqual(test.state.payload.fields,{clientName:'Renamed'});changeCases++;
}
for(const [before,after,expected] of [['','0',0],['0','',null],['0','12.5',12.5],['invalid','1000',1000]]){
 const test=setup();test.deps.invoiceLabels.push(['invoiceBase','請求']);test.deps.jobEdit.invoiceBase=after;test.deps.jobEditBaselineRef.current={...test.deps.jobEdit,invoiceBase:before};
 await test.handlers.saveJobEdit();assert.deepEqual(test.state.payload.fields,{clientChargeInputs:{invoiceBase:expected}});changeCases++;
}
for(const demo of [false,true]){
 const test=setup({demo});test.deps.invoiceLabels.push(['invoiceBase','請求'],['invoiceOther','その他']);test.deps.staffPayLabels.push(['staffBasePay','支払']);
 Object.assign(test.deps.jobEdit,{invoiceBase:'2000',invoiceOther:'300',staffBasePay:'500',assignedStaffId:'existing-staff'});test.deps.jobEditBaselineRef.current={...test.deps.jobEdit,invoiceBase:'1000'};
 Object.assign(test.state.jobs[0],{assignedStaffId:'existing-staff',assignedStaffName:'Existing',clientChargeInputs:{invoiceBase:1000,invoiceOther:300},staffPaymentInputs:{staffBasePay:500}});
 await test.handlers.saveJobEdit();if(demo){assert.deepEqual(test.state.jobs[0].clientChargeInputs,{invoiceBase:2000,invoiceOther:300});assert.equal(test.state.jobs[0].assignedStaffName,'Existing');assert.deepEqual(test.state.jobs[0].staffPaymentInputs,{staffBasePay:500});}else assert.deepEqual(test.state.payload.fields,{clientChargeInputs:{invoiceBase:2000}});changeCases++;
}
{
 const test=setup({refreshFailure:true});test.deps.jobEditBaselineRef.current={...test.deps.jobEdit,clientName:'Before'};await test.handlers.saveJobEdit();await test.handlers.saveJobEdit();assert.equal(test.state.calls.length,1);assert.equal(test.state.refreshes,1);assert.match(test.state.messages.at(-1),/変更はありません/);assert.deepEqual(test.state.edit,test.deps.jobEdit);assert.notEqual(test.state.edit,test.deps.jobEdit);changeCases++;
}
{
 const gate=deferred(),test=setup({apiWait:()=>gate.promise});test.deps.jobEditBaselineRef.current={...test.deps.jobEdit,clientName:'Before',storeAddress:'Old address'};test.deps.jobEdit.storeAddress='Old address';
 const pending=test.handlers.saveJobEdit();test.deps.jobEdit={...test.deps.jobEdit,storeAddress:'Typed while saving'};const next=Function(...Object.keys(test.deps),code+';return {saveJobEdit};')(...Object.values(test.deps));gate.resolve();await pending;await next.saveJobEdit();assert.equal(test.state.calls.length,2);assert.deepEqual(test.state.payload.fields,{storeAddress:'Typed while saving'});changeCases++;
}
{
 const test=setup();test.deps.jobEditBaselineRef.current={...test.deps.jobEdit,clientName:'Before'};test.deps.jobEdit.unexpected='Do not send';await test.handlers.saveJobEdit();assert.equal(Object.hasOwn(test.state.payload.fields,'unexpected'),false);changeCases++;
}
console.log('Changed-only save: '+changeCases+' synthetic API/demo cases passed.');