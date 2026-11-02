import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(path.resolve(process.env.LKC_TEST_DEPENDENCY_ROOT||'.','package.json'));
const ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),modules=new Map();
function load(name){
 if(name==='react/jsx-runtime')return require(name);
 if(name==='./AutomationRegistryEntry')return {__esModule:true,default:()=>null};
 assert.ok(['./JobSafeEditPanel','./StoreLocationFields'].includes(name),'Unexpected panel dependency');
 if(modules.has(name))return modules.get(name);
 const source=fs.readFileSync('apps/admin/src/'+name.slice(2)+'.tsx','utf8'),exports={};
 runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:load});modules.set(name,exports);return exports;
}
const Panel=load('./JobSafeEditPanel').default,values=Object.fromEntries(['assignedStaffId','clientName','storeName','storeAddress','storeNearestStation','makerName','menuName','entryTime','workTime','subcontractorName'].map(k=>[k,'']));
let cases=0;
for(const dirty of [false,true])for(const busy of [false,true])for(const pendingSourceWrite of [false,true]){
 const html=renderToStaticMarkup(React.createElement(Panel,{jobs:[{id:'j',workDate:'2099-09-20',storeName:'Synthetic',pendingSourceWrite}],staff:[],jobEditId:'j',revision:3,values,busy,dirty,invoiceLabels:[],staffPayLabels:[],onSelectJob:()=>{},onUpdate:()=>{},onSave:()=>{}}));
 assert.equal(/<button[^>]*disabled/.test(html),busy||!dirty);
 assert.equal(html.includes('シフト表への反映は確認待ちです。'),pendingSourceWrite);
 assert.ok(html.includes(busy?'保存結果を確認しています。':dirty?'未保存の変更があります。':'表示中の内容に変更はありません。'));cases++;
}
console.log('Admin edit panel: '+cases+' real React render states passed; no API calls.');

let boundaryRenders=0;
for(const caseListJob of [false,true]){
 const html=renderToStaticMarkup(React.createElement(Panel,{
  jobs:[{id:'j',workDate:'2099-09-20',storeName:'Synthetic',...(caseListJob?{caseListSource:{sourceRevision:'synthetic'}}:{})}],
  staff:[],jobEditId:'j',revision:3,values:{...values,clientUnit:'9000',staffUnit:'8000'},busy:false,dirty:true,
  invoiceLabels:[['clientUnit','請求単価']],staffPayLabels:[['staffUnit','支払日給']],
  onSelectJob:()=>{},onUpdate:()=>{},onSave:()=>{},
 }));
 const control=label=>{
  const found=html.match(new RegExp('<label>'+label+'\\s*<(?:input|select)\\b[^>]*>','u'));
  assert.ok(found,'Missing edit control: '+label);return found[0];
 };
 for(const label of ['スタッフ','クライアント','店舗','メーカー','メニュー','入店時間','実施時間','外注名','請求単価','支払日給']){
  assert.equal(/\bdisabled(?:=|\s|>)/u.test(control(label)),caseListJob,label+' edit policy');
  assert.equal(control(label).includes('aria-describedby="case-list-edit-hold"'),caseListJob,label+' explanation');
 }
 for(const label of ['店舗住所','最寄駅'])assert.equal(/\bdisabled(?:=|\s|>)/u.test(control(label)),false,label+' remains editable');
 assert.equal(html.includes('id="case-list-edit-hold"'),caseListJob);
 assert.equal(/<button[^>]*disabled/u.test(html),false,'Location changes can still be saved');
 boundaryRenders++;
}
console.log('CaseList edit panel: '+boundaryRenders+' real React policy states passed.');

// Actual App save boundary: forged/stale edits must stop before confirmation or API.
const appSource=fs.readFileSync('apps/admin/src/App.tsx','utf8');
const actionStart=appSource.indexOf('async function saveJobEditAction(');
const actionEnd=appSource.indexOf('\nasync function exportJobs()',actionStart);
assert.ok(actionStart>=0&&actionEnd>actionStart);
const actionCode=ts.transpileModule(appSource.slice(actionStart,actionEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function saveHarness(fields,caseListJob=true,configured=true){
 const state={calls:[],confirmations:0,messages:[],busy:[],jobs:[{id:'j',revision:3,storeAddress:'Before',storeNearestStation:'Before station',...(caseListJob?{caseListSource:{sourceRevision:'synthetic'}}:{})}]};
 const ctx={Error,Symbol,Object,jobEditId:'j',jobEditContextRef:{current:{}},jobEditBaselineRef:{current:{}},jobEdit:{...fields},jobEditRevision:3,
  jobs:state.jobs,staff:[],firebaseConfigured:configured,functions:{},changedJobEditFields:()=>fields,
  window:{confirm:()=>{state.confirmations++;return true;}},setMessage:v=>state.messages.push(v),setJobEditBusy:v=>state.busy.push(v),
  setJobEdit:()=>{},setJobEditRevision:()=>{},setJobs:fn=>{state.jobs=fn(state.jobs);},
  httpsCallable:(_functions,name)=>async payload=>{state.calls.push({name,payload});return{data:{revision:4}};},
  refreshJobsAfterAction:async()=>{},
 };
 runInNewContext(actionCode,ctx);return {state,ctx};
}
let boundarySaves=0;
for(const configured of [false,true]){
 for(const fields of [{assignedStaffId:'other'},{clientName:'Changed'},{entryTime:'10:00'},
  {clientChargeInputs:{unit:9000}},{staffPaymentInputs:{unit:8000}},{storeAddress:'After',assignedStaffId:'other'}]){
  const h=saveHarness(fields,true,configured);await h.ctx.saveJobEditAction(()=>true);
  assert.equal(h.state.calls.length,0,'Unsupported CaseList edit must not call API');
  assert.equal(h.state.confirmations,0,'Unsupported edit must not ask to save');
  assert.equal(h.state.busy.includes(true),false);
  assert.equal(h.state.jobs[0].storeAddress,'Before','Mixed edits preserve existing values');
  assert.match(h.state.messages.at(-1),/住所と最寄駅/);boundarySaves++;
 }
 for(const fields of [{storeAddress:'After'},{storeNearestStation:'After station'},{storeAddress:'After',storeNearestStation:'After station'}]){
  const h=saveHarness(fields,true,configured);await h.ctx.saveJobEditAction(()=>true);
  assert.equal(h.state.confirmations,1);
  assert.equal(h.state.calls.length,configured?1:0);
  if(configured){assert.equal(h.state.calls[0].name,'adminEditJobInputs');assert.deepEqual(JSON.parse(JSON.stringify(h.state.calls[0].payload.fields)),fields);}
  else for(const key of Object.keys(fields))assert.equal(h.state.jobs[0][key],fields[key]);
  boundarySaves++;
 }
}
{
 const h=saveHarness({assignedStaffId:'other'},false,true);await h.ctx.saveJobEditAction(()=>true);
 assert.equal(h.state.calls.length,1,'Existing non-CaseList edit remains supported');boundarySaves++;
}
{
 const h=saveHarness({},true,true);await h.ctx.saveJobEditAction(()=>true);
 assert.equal(h.state.calls.length,0);assert.equal(h.state.confirmations,0);assert.equal(h.state.messages.at(-1),'変更はありません。');boundarySaves++;
}
console.log('CaseList actual App save boundary: '+boundarySaves+' synthetic cases passed; no real API calls.');
