import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import path from "node:path";
import {fileURLToPath} from "node:url";
import vm from "node:vm";

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const req=createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT||repo,"package.json"));
const ts=req("typescript"),z=req("zod").z,{chromium}=req("@playwright/test");
const app=readFileSync(path.join(repo,"apps/staff/src/App.tsx"),"utf8");
const server=readFileSync(path.join(repo,"functions/src/submission-files.ts"),"utf8");
const integrity=readFileSync(path.join(repo,"functions/src/submission-integrity.ts"),"utf8");
const transpile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function block(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
const poll=block(app,"  async function pollSubmissionProcessing(","  async function uploadSubmission(");
const recheck=block(app,"  async function recheckSubmissionProcessing(","  async function refreshSubmissionInformation(");
const pending=block(app,"  function isSubmissionActionPending(","\n  useEffect(");
const hook=readFileSync(path.join(repo,"apps/staff/src/useAsyncAction.ts"),"utf8").split("\nexport function sleep(")[0].replace(/^import .*?;\s*/,"").replaceAll("export ","");
const backendCode=transpile(
 block(server,"const ProcessingStatusSchema =","\ntype FileView =")+
 block(integrity,"export function assertSubmissionCounters(","\n/**").replace("export ","")+
 block(integrity,"export function assertReplacementRequest(","\n}").replace("export ","")+"\n}"+
 block(server,"export const getSubmissionProcessingStatus =","\nexport const getResubmissionComparison =").replace("export const ","var ")
);
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
const cases=[],record=(name)=>cases.push({name,passed:true});
const deferred=()=>{let yes,no;const promise=new Promise((resolve,reject)=>{yes=resolve;no=reject;});return {promise,yes,no};};
function fixture(options={}){
 const state={messages:[],refresh:[],api:[],reads:[],processing:[],queue:new Set(),now:0,mutations:0};
 const receipt={companyId:"test-company",staffId:"test-staff",jobId:"test-job",type:"report",status:"completed",totalFiles:1,completedFiles:1,jobStatusApplied:true,...options.receipt};
 const replacement={companyId:receipt.companyId,jobId:receipt.jobId,staffId:receipt.staffId,type:receipt.type,status:"submitted",replacementSubmissionId:"receipt-1",...options.replacement};
 const claims={companyId:"test-company",staffId:"test-staff",role:"staff"};
 const db={collection:name=>({doc:id=>({get:async()=>{
  state.reads.push([name,id]);
  if(name==="submissions"){if(options.gate)await options.gate.promise;return {exists:!options.missing,id,data:()=>receipt};}
  if(name==="resubmissionRequests")return {exists:true,id,data:()=>replacement};
  throw Error("Unexpected read collection "+name);
 }})})};
 const api={z,HttpsError,db,requireAuth:request=>request.auth,companyFromClaims:token=>token.companyId,
  staffFromClaimsSafe:token=>token.staffId,onCall:fn=>fn,assertJobAccess:async(job,company,role,staff)=>{
   assert.equal(job,"test-job");assert.equal(company,"test-company");assert.equal(role,"staff");assert.equal(staff,"test-staff");
  }};
 vm.runInNewContext(backendCode,api);
 let ctx;
 const context={
  functions:{},selectedAssignedJob:{id:"test-job"},submissionHistoryStatus:"ready",
  submissionHistory:[{id:"receipt-1",status:"completed",files:[{id:"file-1"}]}],
  submissionType:"report",requestId:options.resubmission?"request-1":"",
  authLoadVersionRef:{current:1},submissionContextVersionRef:{current:1},submissionProcessingVersionRef:{current:0},
  draftHydratingRef:{current:false},processingSubmission:false,
  Date:{now:()=>state.now},sleep:async ms=>{state.now+=ms;if(options.sleep)await options.sleep({receipt,replacement,ctx,state});},
  useState:initial=>[typeof initial==="function"?initial():initial,()=>{}],
  useRef:value=>({current:value}),useCallback:fn=>fn,
  showSubmissionMessage:value=>state.messages.push(value),
  setProcessingSubmission:value=>{state.processing.push(value);ctx.processingSubmission=value;},
  httpsCallable:(_,name,config)=>async input=>{
   assert.equal(name,"getSubmissionProcessingStatus","Recovery must not invoke upload or business-write APIs");
   assert.ok(config.timeout>0&&config.timeout<=15000);
   state.api.push({name,input});
   if(options.failure)throw Error("offline");
   return {data:options.response??await api.getSubmissionProcessingStatus({auth:{uid:"test-uid",token:claims},data:input})};
  },
  loadSubmissionHistory:async(...args)=>{state.refresh.push(["history",...args]);return options.refresh!==false;},
  refreshSelectedJob:async(...args)=>{state.refresh.push(["job",...args]);return true;},
  loadTasks:async()=>{state.refresh.push(["tasks"]);return true;},
  loadResubmissionDetail:async(...args)=>{state.refresh.push(["request",...args]);return true;},
 };
 ctx=vm.createContext(context);
 vm.runInContext(transpile(hook)+"\nvar actions=useAsyncAction();var run=actions.run;var isPending=actions.isPending;\n"+transpile(pending+poll+recheck),ctx);
 return {ctx,state,receipt,replacement};
}
async function verifyReviewDelta(){
 for(const change of ["auth","context"]){
  const f=fixture({receipt:{status:"processing",completedFiles:0},sleep:async({ctx})=>{
   if(change==="auth")ctx.authLoadVersionRef.current++;else ctx.submissionContextVersionRef.current++;
  }});
  await f.ctx.recheckSubmissionProcessing("receipt-1");
  assert.equal(f.state.api.length,1,"A stale backoff must not issue another status read");
  assert.equal(f.state.refresh.length,0);
  assert.equal(f.ctx.isPending("submission-refresh"),false);
  assert.deepEqual(f.state.processing,change==="context"?[true,false]:[true]);
  record("Review delta: "+change+" changes during polling backoff; no stale next API request");
 }
}
if(process.argv.includes("--review-delta-only")){
 await verifyReviewDelta();
 if(process.env.LKC_RECOVERY_TEST_EVIDENCE){
  const saved=JSON.parse(readFileSync(process.env.LKC_RECOVERY_TEST_EVIDENCE,"utf8"));
  saved.reviewDeltaCases=cases;saved.reviewDeltaOnly=true;
  writeFileSync(process.env.LKC_RECOVERY_TEST_EVIDENCE,JSON.stringify(saved,null,2)+"\n");
 }
 console.log("Review delta passed: "+cases.length+" stale-backoff cases; no unrelated suites rerun.");
 process.exit(0);
}
const browserDeltaOnly=process.argv.includes("--review-browser-delta-only");
if(!browserDeltaOnly){
await verifyReviewDelta();

{
 const f=fixture();await f.ctx.recheckSubmissionProcessing("receipt-1");
 assert.equal(f.state.api.length,1);assert.match(f.state.messages.at(-1),/保存が完了/);
 assert.deepEqual(f.state.refresh.map(v=>v[0]),["history","job","tasks"]);assert.equal(f.ctx.processingSubmission,false);
 record("Reloaded accepted receipt: actual client handler -> processing callable -> history/job/tasks refresh, no upload");
}
{
 const f=fixture({resubmission:true,receipt:{resubmissionRequestId:"request-1"},replacement:{status:"open",replacementSubmissionId:null},
  sleep:async({replacement})=>{replacement.status="submitted";replacement.replacementSubmissionId="receipt-1";}});
 await f.ctx.recheckSubmissionProcessing("receipt-1");
 assert.equal(f.state.api.length,2);assert.equal(f.state.refresh[3][0],"request");assert.deepEqual(f.state.refresh[3].slice(1),["request-1",1,"test-job","report"]);
 record("Replacement file saved before request transition: keep checking, then refresh exact resubmission request");
}
{
 const f=fixture({receipt:{jobStatusApplied:false},sleep:async({receipt})=>{receipt.jobStatusApplied=true;}});
 await f.ctx.recheckSubmissionProcessing("receipt-1");assert.equal(f.state.api.length,2);record("Saved files do not imply completed job status; wait for existing callable's jobStatusApplied");
}
for(const status of ["paused_global","error"]){
 const f=fixture({receipt:{status,completedFiles:0,errorMessage:status==="error"?"synthetic transfer error":null}});
 await f.ctx.recheckSubmissionProcessing("receipt-1");assert.equal(f.state.api.length,1);assert.equal(f.state.refresh.length,0);
 assert.match(f.state.messages.at(-1),status==="error"?/エラー/:/一時停止/);assert.equal(f.ctx.processingSubmission,false);record(status+" stays held; recovery does not retry transfer");
}
{
 const f=fixture({failure:true});await f.ctx.recheckSubmissionProcessing("receipt-1");
 assert.match(f.state.messages.at(-1),/確認できません/);assert.equal(f.ctx.isPending("submission-refresh"),false);
 f.ctx.functions=null; // No second API may be issued without a connection.
 await f.ctx.recheckSubmissionProcessing("receipt-1");assert.equal(f.state.api.length,1);record("Offline read releases lock without upload; missing connection stops");
}
{
 const gate=deferred(),f=fixture({gate});
 const first=f.ctx.recheckSubmissionProcessing("receipt-1"),second=f.ctx.recheckSubmissionProcessing("receipt-1");
 await Promise.resolve();assert.equal(f.state.api.length,1);gate.yes();await Promise.all([first,second]);record("Double click shares actual useAsyncAction lock");
}
for(const change of ["auth","context","new-poll"]){
 const gate=deferred(),f=fixture({gate});const check=f.ctx.recheckSubmissionProcessing("receipt-1");
 await Promise.resolve();
 if(change==="auth")f.ctx.authLoadVersionRef.current++;
 if(change==="context")f.ctx.submissionContextVersionRef.current++;
 if(change==="new-poll")f.ctx.submissionProcessingVersionRef.current++;
 gate.yes();await check;assert.equal(f.state.refresh.length,0);assert.equal(f.state.messages.length,0);
 assert.deepEqual(f.state.processing,change==="context"?[true,false]:[true]);
 record("Stale "+change+" response cannot refresh another scope or clear newer polling busy state");
}
for(const mode of ["missing","duplicate","unknown","no-files","too-many","loading","no-assignment","pending"]){
 const f=fixture();
 if(mode==="duplicate")f.ctx.submissionHistory.push(f.ctx.submissionHistory[0]);
 if(mode==="unknown")f.ctx.submissionHistory[0].status="constructor";
 if(mode==="no-files")f.ctx.submissionHistory[0].files=[];
 if(mode==="too-many")f.ctx.submissionHistory[0].files=Array(21).fill({});
 if(mode==="loading")f.ctx.submissionHistoryStatus="loading";
 if(mode==="no-assignment")f.ctx.selectedAssignedJob=null;
 if(mode==="pending")f.ctx.draftHydratingRef.current=true;
 await f.ctx.recheckSubmissionProcessing(mode==="missing"?"stale-receipt":"receipt-1");
 assert.equal(f.state.api.length,0);record("Unverified receipt action rejected: "+mode);
}
for(const corruption of [{companyId:"other-company"},{staffId:"other-staff"},{jobId:"other-job"},{totalFiles:0}]){
 const f=fixture({receipt:corruption});await f.ctx.recheckSubmissionProcessing("receipt-1");
 assert.equal(f.state.refresh.length,0);assert.match(f.state.messages.at(-1),/確認できません/);record("Existing callable rejects changed receipt identity/count: "+Object.keys(corruption)[0]);
}
{
 const f=fixture({receipt:{status:"processing",completedFiles:0}});await f.ctx.recheckSubmissionProcessing("receipt-1");
 assert.equal(f.state.now,60000);assert.match(f.state.messages.at(-1),/確認/);assert.equal(f.ctx.processingSubmission,false);record("Recovered polling still respects one-minute budget");
}
{
 const f=fixture({refresh:false});await f.ctx.recheckSubmissionProcessing("receipt-1");
 assert.match(f.state.messages.at(-1),/保存は完了.*更新を確認できません/);record("Successful save and failed screen refresh remain distinct");
}
const cfgPath=path.join(repo,"apps/staff/tsconfig.json"),cfg=ts.readConfigFile(cfgPath,ts.sys.readFile);
assert.equal(cfg.error,undefined);
const converted=ts.convertCompilerOptionsFromJson(cfg.config.compilerOptions,path.dirname(cfgPath));
const program=ts.createProgram([path.join(repo,"apps/staff/src/App.tsx"),path.join(repo,"apps/staff/src/vite-env.d.ts")],{...converted.options,noEmit:true,incremental:false,ignoreDeprecations:"6.0"});
const diagnostics=ts.getPreEmitDiagnostics(program);
assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:p=>p,getCurrentDirectory:()=>repo,getNewLine:()=>"\n"}));
record("Scoped Staff App and new recovery component TypeScript noEmit");

}
const modules={};
for(const [id,file]of [
 ["react","react/cjs/react.production.js"],["react-dom","react-dom/cjs/react-dom.production.js"],
 ["react-dom/client","react-dom/cjs/react-dom-client.production.js"],["scheduler","scheduler/cjs/scheduler.production.js"],
 ["react/jsx-runtime","react/cjs/react-jsx-runtime.production.js"],
]){
 const packageName=file.split("/")[0],relative=file.slice(packageName.length+1);
 const packagePath=req.resolve(packageName+"/package.json");
 modules[id]=readFileSync(path.join(path.dirname(packagePath),relative),"utf8");
}
modules.recovery=transpile(readFileSync(path.join(repo,"apps/staff/src/SubmissionProcessingRecovery.tsx"),"utf8"));
const historyStart=app.indexOf("<hr/><h3>提出履歴</h3>"),historyEnd=app.indexOf("\n    </section>}",historyStart);
assert.ok(historyStart>=0&&historyEnd>historyStart);
modules.history=transpile('import SubmissionProcessingRecovery from "recovery";export default function History(props){const {submissions:submissionHistory,disabled:submissionEditPending=false,status:submissionHistoryStatus="ready",scope:draftKey="synthetic-scope"}=props;const functions={},isPending=()=>submissionHistoryStatus==="loading",refreshSubmissionInformation=()=>{},recheckSubmissionProcessing=id=>window.checkRecovery(id),refreshFilePreview=async()=>null,SubmissionHistoryFiles=()=>null;return <>'+app.slice(historyStart,historyEnd)+'</>;}');

const bundle="const modules="+JSON.stringify(modules)+";const cache={};function require(id){if(cache[id])return cache[id].exports;if(!modules[id])throw Error('No local module '+id);const module={exports:{}};cache[id]=module;new Function('module','exports','require',modules[id])(module,module.exports,require);return module.exports;}"+
 "const React=require('react'),root=require('react-dom/client').createRoot(document.getElementById('root')),Recovery=require('recovery').default,History=require('history').default;"+
 "window.renderRecovery=(props)=>root.render(React.createElement(props.withAppHistory?History:Recovery,{...props,onCheck:id=>window.checkRecovery(id)}));";
const browser=await chromium.launch({headless:true}),external=[];
try{
 for(const width of (browserDeltaOnly?[320]:[320,390])){
  const context=await browser.newContext({viewport:{width,height:844}});
  await context.route("**/*",route=>{external.push(route.request().url().split("?")[0]);return route.abort();});
  const page=await context.newPage(),checks=[],errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  const f=fixture();f.ctx.submissionHistory.push({id:"receipt-2",status:"paused_global",files:[{id:"file-2"}]});
  await page.exposeFunction("checkRecovery",async id=>{checks.push(id);await f.ctx.recheckSubmissionProcessing(id);});
  const css=readFileSync(path.join(repo,"apps/staff/src/styles.css"),"utf8");
  await page.setContent('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><main class="app-shell"><section class="panel submission-panel report"><div id="root"></div></section></main></html>');
  await page.addScriptTag({content:bundle});
  const select=page.getByRole("combobox",{name:"状況を確認する提出"}),button=page.getByRole("button",{name:"選んだ提出の処理状況を確認"});
  if(!browserDeltaOnly){
  await page.evaluate(()=>window.renderRecovery({disabled:false,submissions:[
   {id:"receipt-1",purpose:"initial",status:"completed",createdAt:"2026-10-03T00:00:00Z",files:[{}]},
   {id:"receipt-2",purpose:"replacement",status:"paused_global",createdAt:"2026-10-03T01:00:00Z",files:[{}]}
  ]}));

  await select.selectOption("receipt-2");await button.click();await page.waitForFunction(()=>document.querySelector("select").value==="receipt-2");
  for(let i=0;i<10&&!checks.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(checks,["receipt-2"]);assert.equal(f.state.api[0].input.submissionId,"receipt-2");
  await page.evaluate(()=>{for(const element of document.querySelectorAll("button,select,small,label,span"))element.style.fontSize="1.5rem";});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1);
  assert.equal(overflow,false,"Small-screen recovery must not scroll horizontally");
  await page.evaluate(()=>window.renderRecovery({disabled:true,submissions:[{id:"receipt-2",purpose:"replacement",status:"paused_global",createdAt:null,files:[{}]}]}));
  await button.waitFor();assert.equal(await button.isDisabled(),true);assert.equal(await select.isDisabled(),true);
  await page.evaluate(()=>window.renderRecovery({disabled:false,submissions:[{id:"receipt-2",purpose:"initial",status:"constructor",createdAt:"invalid",files:[]}]}));
  await page.waitForFunction(()=>document.querySelector("select option").textContent.includes("状態確認中"));
  assert.equal(await button.isDisabled(),true);assert.equal(errors.length,0);
  record("Actual React browser -> actual recovery handler mock at "+width+"px: selection, disabled prop, unknown/missing data, enlarged text");
  }
  await page.evaluate(()=>window.renderRecovery({withAppHistory:true,status:"ready",disabled:false,submissions:[
   {id:"receipt-1",purpose:"initial",status:"processing",createdAt:"2026-10-03T00:00:00Z",files:[{}]},
   {id:"receipt-2",purpose:"replacement",status:"completed",createdAt:"2026-10-03T01:00:00Z",files:[{}]}
  ]}));
  await select.selectOption("receipt-2");
  for(const status of ["loading","ready","error","ready"]){
   await page.evaluate(status=>window.renderRecovery({withAppHistory:true,status,disabled:false,submissions:[
    {id:"receipt-1",purpose:"initial",status:"processing",createdAt:"2026-10-03T00:00:00Z",files:[{}]},
    {id:"receipt-2",purpose:"replacement",status:"completed",createdAt:"2026-10-03T01:00:00Z",files:[{}]}
   ]}),status);
   await page.waitForFunction(expected=>document.querySelector('[aria-label="状況を確認する提出"]').disabled===expected,status!=="ready");
   assert.equal(await select.inputValue(),"receipt-2","Actual App history conditional must retain selected receipt through loading/error");
   assert.equal(await button.isDisabled(),status!=="ready");
  }
  assert.equal(errors.length,0);await context.close();
  record("Review delta: actual App history JSX at "+width+"px retains receipt B and disables recheck during loading/error");
 }
}finally{await browser.close();}
assert.equal(external.length,0);
const output={scope:"Accepted Staff submission read-only recovery",cases,externalRequests:external.length,cloudCalls:0,realUpload:false,realDatabaseWrites:false,
 limitations:["Browser receipt component and actual client/callable code with mock dependencies; not a real authenticated Staff acceptance.","No Firestore emulator/cloud concurrency or deployment verification."]};
if(process.env.LKC_RECOVERY_TEST_EVIDENCE){
 if(browserDeltaOnly){
  const saved=JSON.parse(readFileSync(process.env.LKC_RECOVERY_TEST_EVIDENCE,"utf8"));
  saved.reviewBrowserDeltaCases=cases;saved.browserDeltaOnly=true;
  writeFileSync(process.env.LKC_RECOVERY_TEST_EVIDENCE,JSON.stringify(saved,null,2)+"\n");
 }else writeFileSync(process.env.LKC_RECOVERY_TEST_EVIDENCE,JSON.stringify(output,null,2)+"\n");
}
console.log(browserDeltaOnly?"Review browser delta passed: "+cases.length+" actual App history JSX case; noEmit and unrelated suites not rerun; external requests 0.":"Staff receipt recovery passed: "+cases.length+" cases; scoped noEmit; real React small-screen integration; external requests 0, upload/write APIs 0.");
