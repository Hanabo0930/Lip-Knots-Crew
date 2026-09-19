import "./test-submission-attempt-store.mjs";
import "./test-staff-upload-resume.mjs";
import "./test-staff-submission-readiness.mjs";
import './test-staff-history-feedback.mjs';
import './test-staff-draft-store-order.mjs';
import './test-staff-route-target.mjs';
import './test-staff-job-kind.mjs';
import './test-staff-copy-navigation.mjs';
import './test-staff-application-focus.mjs';
import './test-staff-precontact-refresh.mjs';
import './test-staff-contact-summary.mjs';
import './test-staff-open-jobs-pages.mjs';
import './test-staff-diagnostic-read.mjs';
import './test-staff-diagnostic-export.mjs';
import './test-staff-device-watch.mjs';
import './test-staff-device-response.mjs';
import './test-staff-draft-save-races.mjs';
await import("./test-staff-shift-cards.mjs");
await import("./test-staff-startup-races.mjs");
await import("./test-staff-manual-refresh.mjs");
import "./test-staff-open-jobs-refresh.mjs";
await import('./test-staff-login-races.mjs');
await import('./test-staff-context-change.mjs');
await import('./test-staff-past-selection.mjs');
await import('./test-staff-notification-target.mjs');
await import('./test-staff-resubmission-notification.mjs');
await import('./test-staff-shift-notification.mjs');
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// No Firebase config, external accounts, mail, or cloud writes are used.
await import("./test-staff-client-submission-recovery.mjs");
assert.equal(process.exitCode??0,0,"Client submission recovery checks must pass.");
await import("./test-staff-push-recovery.mjs");
assert.equal(process.exitCode??0,0,"Push recovery checks must pass.");
await import("./test-staff-device-recovery.mjs");
assert.equal(process.exitCode??0,0,"Device recovery checks must pass.");
await import("./test-staff-submission-read-order.mjs");
assert.equal(process.exitCode??0,0,"Submission response order checks must pass.");
const app = readFileSync("apps/staff/src/App.tsx", "utf8");
function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Cannot locate ${start}`);
  return source.slice(from, to);
}

{
 const from=app.indexOf('<div className="task-clear"'),to=app.indexOf('</div></div>',from)+12;assert.ok(from>=0&&to>from);
 const jsx=app.slice(from,to),compiled=ts.transpileModule('const node='+jsx+';', {compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText;
 for(const source of ['live','cached','stale']){const ctx={React:{createElement},businessDataSource:source};runInNewContext(compiled+'globalThis.node=node;',ctx);const html=renderToStaticMarkup(ctx.node);assert.equal(html.includes('今日の対応はすべて完了'),source==='live');assert.equal(html.includes('前回確認時点'),source!=='live');if(source!=='live')assert.ok(html.includes('シフト画面で更新'));}
 console.log('Home empty tasks: real JSX distinguishes latest completion from cached/stale emptiness and points to refresh.');
}

{
 const start=app.indexOf('{(Array.isArray(selectedJob.netPrint?.items)?selectedJob.netPrint.items:[]).map('),end=app.indexOf('{(!Array.isArray(selectedJob.netPrint?.items??[])',start);assert.ok(start>=0&&end>start);
 const jsx=app.slice(start+1,end-1),helpers=section(app,'function validNetPrintItem(','function bootstrapRefreshToken(')+section(app,'function prepSummary(','function messageTone(');
 const ctx={React:{createElement},selectedJob:{netPrint:{items:[{id:'a',number:'111'},{id:'b',number:'222'},null,{id:'bad',number:''}]}},isPending:()=>false,shiftActionPending:false,pendingShiftAction:'',copyDisplayText:()=>{},markPrinted:()=>{}};
 runInNewContext(ts.transpileModule(helpers+'const rows='+jsx+';globalThis.rows=rows;',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,ctx);
 assert.equal(ctx.prepSummary(ctx.selectedJob),'準備中（0/4件印刷済み）');
 const html=renderToStaticMarkup(createElement('main',null,ctx.rows));assert.ok(html.includes('aria-label="ネットプリント 111"'));assert.ok(html.includes('aria-label="ネットプリント 222"'));assert.equal((html.match(/<button/g)||[]).length,4);assert.equal((html.match(/番号を確認できません/g)||[]).length,2);
 const duplicateCtx={...ctx,selectedJob:{netPrint:{items:[{id:'duplicate',number:'111'},{id:'duplicate',number:'222'}]}}};runInNewContext(ts.transpileModule(helpers+'const rows='+jsx+';globalThis.rows=rows;',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,duplicateCtx);
 const duplicateHtml=renderToStaticMarkup(createElement('main',null,duplicateCtx.rows));assert.equal((duplicateHtml.match(/<button/g)||[]).length,0);assert.ok(duplicateHtml.includes('更新対象を特定できない印刷情報 111'));assert.ok(duplicateHtml.includes('更新対象を特定できない印刷情報 222'));assert.ok(duplicateHtml.includes('番号の再登録を依頼'));
 for(const printed of [true,false,'true','false',1,0,null,undefined]){
  const flagCtx={...ctx,selectedJob:{netPrint:{items:[{id:'flag',number:'333',printed}]}}};runInNewContext(ts.transpileModule(helpers+'const rows='+jsx+';globalThis.rows=rows;',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,flagCtx);const flagHtml=renderToStaticMarkup(createElement('main',null,flagCtx.rows));assert.equal(flagCtx.prepSummary(flagCtx.selectedJob).startsWith('準備完了'),printed===true);assert.equal(flagHtml.includes('>印刷済み</button>'),printed===true);assert.equal(flagHtml.includes('>印刷しました</button>'),printed!==true);
 }
 for(const items of [{},'invalid',42,true]){const bad={...ctx,selectedJob:{netPrint:{items}}};runInNewContext(ts.transpileModule(helpers+'const rows='+jsx+';globalThis.rows=rows;',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,bad);assert.equal(bad.prepSummary(bad.selectedJob),'印刷情報を確認できません');assert.equal(renderToStaticMarkup(createElement('main',null,bad.rows)),'<main></main>');}
 for(const materialStatus of [{},42,true,'　 '])assert.equal(ctx.prepSummary({materialStatus,netPrint:{items:[]}}),'資料番号待ち');
 console.log('Netprint rows: distinct accessible number groups; malformed/missing numbers render recovery guidance without actions.');
}

{
 const helper=section(app,'function jobPayLabel(','function validNetPrintItem('),markup=app.match(/<strong aria-label="報酬">.*?<\/strong>/)?.[0];assert.ok(markup);
 const code=ts.transpileModule(helper+'const node='+markup+';globalThis.node=node;',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
 for(const [value,expected] of [[null,'報酬は確認中'],[undefined,'報酬は確認中'],['10000','報酬は確認中'],[NaN,'報酬は確認中'],[Infinity,'報酬は確認中'],[-1,'報酬は確認中'],[0,'0円'],[10000,'10,000円'],[1234.5,'1,234.5円'],[1234.12345,'1,234.12345円']]){const ctx={React:{createElement},job:{basePay:value}};runInNewContext(code,ctx);assert.equal(renderToStaticMarkup(ctx.node),'<strong aria-label="報酬">'+expected+'</strong>');}
 console.log('Open job pay: real label JSX distinguishes null/missing/invalid from explicit zero, positive pay and decimal values without rounding.');
}
{
 const button=app.match(/<button onClick=\{\(\)=>void apply\(job\)\}.*?<\/button>/)?.[0];const from=app.indexOf('{applicationAttemptsRef.current.has(job.id)&&'),to=app.indexOf('</p>}',from)+5;assert.ok(button&&from>=0&&to>from);
 const code=ts.transpileModule('const node=<>'+app.slice(from,to)+button+'</>;globalThis.node=node;',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
 for(const [attempt,pending,expected] of [[false,false,'この案件に応募する'],[true,false,'応募結果を再確認する'],[true,true,'応募中…']]){
  const ctx={React:{createElement,Fragment},job:{id:'one'},applicationAttemptsRef:{current:new Map(attempt?[['one',{}]]:[])},pendingApplicationJobId:pending?'one':'',applicationPending:pending,openJobsRefreshing:false,apply:()=>{}};runInNewContext(code,ctx);const html=renderToStaticMarkup(ctx.node);assert.ok(html.includes(expected));assert.equal(html.includes('この案件の応募結果は未確認です'),attempt&&!pending);
 }
 console.log('Application retry JSX: new/uncertain/pending labels and per-job status distinguish retry from new application.');
}
{
 const buttonStart=app.indexOf('<button className="secondary" onClick={()=>{if(!submissionEditPending&&!submissionReadiness)void setClientSubmitted('),buttonEnd=app.indexOf('</button>',buttonStart)+9;assert.ok(buttonStart>=0&&buttonEnd>buttonStart);const code=ts.transpileModule('globalThis.node='+app.slice(buttonStart,buttonEnd)+';',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
 for(const value of [true,false,'true','false',1,0,null,undefined]){let sent;const ctx={React:{createElement},selectedAssignedJob:{submissionStatus:{salesFloor:{clientSubmitted:value}}},submissionReadiness:null,submissionEditPending:false,shiftActionPending:false,pendingShiftAction:'',setClientSubmitted:v=>sent=v};runInNewContext(code,ctx);const html=renderToStaticMarkup(ctx.node);assert.ok(html.includes(value===true?'クライアント提出を解除':'クライアントへ提出済み'));ctx.node.props.onClick();assert.equal(sent,value!==true);}
 console.log('Client submitted flag: 8 values, true-only release label and matching boolean action; no real request.');
}
const handler = section(app, "  async function openTask(", "  async function pollSubmissionProcessing(");
const events = [];
const scope = {
  myJobs: [{ id: "assigned" }], authLoadVersionRef:{current:0}, navigationVersionRef:{current:0}, isSubmissionActionPending:()=>false, isPending:()=>false, loadTaskJob:async()=>null,
  setMessage: () => events.push("error"), navigate: value => events.push(value),
  setSelectedJob: () => events.push("selected"),
  openShiftJob: () => events.push("selected"),
  startSubmission: async (type, job, request) => events.push([type, job.id, request]),
};
runInNewContext(ts.transpileModule(handler, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, scope);
for (const type of ["report", "sales_floor"]) {
  events.length = 0;
  await scope.openTask({jobId:"assigned",kind:"resubmission",metadata:{type,requestId:"request"}});
  assert.deepEqual(events, [[type,"assigned","request"]]);
  events.length = 0;
  await scope.openTask({jobId:"assigned",kind:type});
  assert.deepEqual(events, [[type,"assigned",""]]);
}
for (const metadata of [{requestId:"request"},{type:"report"},{type:"unknown",requestId:"request"},{type:"report",requestId:42},{type:"sales_floor",requestId:"   "},{type:"report",requestId:"invalid/path"}]) {
  events.length = 0;
  await scope.openTask({jobId:"assigned",kind:"resubmission",metadata});
  assert.deepEqual(events,["error","shifts"]);
}
for(const kind of ['unknown','',null,{}]){events.length=0;await scope.openTask({jobId:'assigned',kind});assert.deepEqual(events,['error','shifts']);}
events.length = 0;
await scope.openTask({jobId:"missing",kind:"report"});
assert.deepEqual(events,["error","shifts"]);
for (const kind of ["precontact", "netprint"]) {
  events.length = 0;
  await scope.openTask({jobId:"assigned",kind});
  assert.deepEqual(events,["selected","shifts"]);
}


{
 const navigation=section(app,'  function navigate(next:View){','  function toggleAccountMenu(');
 for(const change of ['none','navigation','account'])for(const outcome of ['success','missing','failure']){
  const events=[];let finish;
  const ctx={mailOpen:true,mailPanelVersion:{current:0},setShowMailApplications:value=>ctx.mailOpen=value,myJobs:[],authLoadVersionRef:{current:1},navigationVersionRef:{current:0},isSubmissionActionPending:()=>false,isPending:()=>false,
   loadTaskJob:()=>new Promise((resolve,reject)=>{finish={resolve,reject};}),setMessage:value=>events.push(['message',value]),openShiftJob:job=>events.push(['selected',job.id]),startSubmission:async()=>{},
   shiftNotification:{cancel:()=>{}},resubmissionNotification:{cancel:()=>{}},setShowAccountMenu:()=>{},setShowDevices:()=>{},closeDiagnostics:()=>{},setView:value=>events.push(['view',value]),window:{scrollTo:()=>{}},openJobsStatus:'ready'};
  runInNewContext(ts.transpileModule(navigation+handler,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  const pending=ctx.openTask({jobId:'target',kind:'netprint'});
  if(change==='navigation'){ctx.navigate('contact');assert.equal(ctx.navigationVersionRef.current,1);assert.equal(ctx.mailPanelVersion.current,1);assert.equal(ctx.mailOpen,false);events.length=0;}if(change==='account')ctx.authLoadVersionRef.current++;
  if(outcome==='failure')finish.reject(Error('offline'));else finish.resolve(outcome==='missing'?null:{id:'target'});await pending;
  if(change!=='none')assert.deepEqual(events,[]);else if(outcome==='success')assert.deepEqual(events,[['selected','target'],['view','shifts']]);else{assert.equal(events[0][0],'message');assert.match(events[0][1],outcome==='failure'?/再試行/:/確定シフト/);}
 }
 console.log('Task navigation passed: current success/missing/failure handled; late results cannot navigate or show errors after navigation/account changes.');
}

// Exercise the real async handlers with controlled responses, including responses
// arriving after the account or submission context changes.
const refreshHandler = section(app, "  async function refreshFilePreview(", "  async function loadResubmissionDetail(");
const previewFile = {id:"file",submissionId:"submission",previewUrl:"refreshed"};
for (const change of ["none", "account", "context"]) {
  let complete;
  const history = [];
  const refreshScope = {
    selectedJob:{id:"assigned"}, functions:{}, submissionType:"sales_floor", requestId:"", resubmissionDetail:null,
    authLoadVersionRef:{current:1}, submissionContextVersionRef:{current:0}, previewContextRef:{current:"assigned_sales_floor_normal"},
    httpsCallable:()=>()=>new Promise(resolve=>{complete=resolve;}),
    setSubmissionHistory:value=>history.push(value),
  };
  runInNewContext(ts.transpileModule(refreshHandler,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,refreshScope);
  const pending = refreshScope.refreshFilePreview(previewFile);
  if(change==="account")refreshScope.authLoadVersionRef.current++;
  if(change==="context")refreshScope.previewContextRef.current="other_report_normal";
  complete({data:{submissions:[{id:"submission",files:[previewFile]}]}});
  assert.equal(await pending,change==="none"?"refreshed":null);
  assert.equal(history.length,0,"Image URL refresh must not replace the independently loaded history.");
}

const component = readFileSync("apps/staff/src/SubmissionPreviewImage.tsx","utf8");
const retryHandler = section(component,"  async function retryPreview()", "\n  if (!src)");
for (const result of ["success", "missing", "failure", "replaced", "unmounted", "object", "number", "array", "blank"]) {
  let complete, fail, calls=0;
  const state = {src:null,loadState:"error",refreshing:false};
  const retryScope = {
    document:{activeElement:null},previewContainerRef:{current:null},restorePreviewFocus:{current:false},file:previewFile, refreshPending:{current:false}, refreshVersion:{current:1},
    setRefreshing:value=>{state.refreshing=value;}, setLoadState:value=>{state.loadState=value;}, setSrc:value=>{state.src=value;},
    onRefreshPreview:()=>{calls++;return new Promise((resolve,reject)=>{complete=resolve;fail=reject;});},
  };
  runInNewContext(ts.transpileModule(retryHandler,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,retryScope);
  const pending=retryScope.retryPreview();
  await retryScope.retryPreview();
  assert.equal(calls,1,"Synchronous double clicks must issue only one request.");
  assert.equal(state.refreshing,true);
  if(result==="replaced"||result==="unmounted")retryScope.refreshVersion.current++;
  if(result==="failure")fail(new Error("offline"));
  else complete(result==="missing"?null:result==="object"?{url:"wrong"}:result==="number"?42:result==="array"?["wrong"]:result==="blank"?"   ":"refreshed");
  await pending;
  assert.equal(state.src,result==="success"?"refreshed":null);
  if(result!=="replaced"&&result!=="unmounted"){
    assert.equal(retryScope.refreshPending.current,false);
    assert.equal(state.refreshing,false);
    if(result!=="success")assert.equal(state.loadState,"error");
  }else assert.equal(state.refreshing,true,"Obsolete callbacks must not update the current component state.");
}

const viewerModule={exports:{},require:createRequire(import.meta.url)};
runInNewContext(ts.transpileModule(readFileSync('apps/staff/src/SubmissionImageViewer.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,viewerModule);
const pdfModule={exports:{},URL,require:createRequire(import.meta.url)};
runInNewContext(ts.transpileModule(readFileSync('apps/staff/src/PdfFilePreview.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,pdfModule);
const moduleScope={exports:{},require:name=>name==='./PdfFilePreview'?pdfModule.exports:name==='./SubmissionImageViewer'?viewerModule.exports:createRequire(import.meta.url)(name)};
runInNewContext(ts.transpileModule(component,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,moduleScope);
const markup=renderToStaticMarkup(createElement(moduleScope.exports.default,{
  file:{...previewFile,originalName:"photo.png",driveName:"",contentType:"image/png",previewUrl:null},
  onRefreshPreview:async()=>null,
}));
assert.match(markup,/<button[^>]*>画像を再読み込み<\/button>/u,"A missing URL must expose a recovery action.");

const historyModule={exports:{},require:name=>name==='./SubmissionPreviewImage'?moduleScope.exports:createRequire(import.meta.url)(name)};
runInNewContext(ts.transpileModule(readFileSync('apps/staff/src/SubmissionHistoryFiles.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,historyModule);
for(const [status,label] of [['waiting_upload','アップロード待ち'],['processing','Drive転送中'],['paused_global','転送一時停止'],['error','転送エラー'],['security_error','状態の確認が必要です'],['unknown','状態の確認が必要です'],['completed','Drive保存済み']]){
 const output=renderToStaticMarkup(createElement(historyModule.exports.default,{files:[{...previewFile,originalName:'synthetic.png',driveName:'',contentType:'image/png',previewUrl:null,status,purpose:'replacement'}],onRefreshPreview:async()=>null}));
 assert.ok(output.includes(label));assert.ok(output.includes('再送・'));assert.ok(!output.includes('提出済み'));
 assert.equal(output.includes('画像を再読み込み'),status==='completed');assert.equal(output.includes('管理者へ連絡'),status!=='completed');
}
for(const [driveName,originalName,expected] of [['same.pdf','original.pdf','same.pdf'],['  ','original.pdf','original.pdf'],['','','ファイル名を確認できません']]){
 const files=[1,2].map(id=>({...previewFile,id:String(id),driveName,originalName,contentType:'application/pdf',previewUrl:null,status:'completed',purpose:'initial'}));
 const output=renderToStaticMarkup(createElement(historyModule.exports.default,{files,onRefreshPreview:async()=>null}));
 for(const index of [1,2])assert.ok(output.includes('aria-label="提出履歴 '+index+'件目: '+expected+'"'));
}
{
 const start=app.indexOf('<div className="resubmission-guide">');
 const end=app.indexOf('\n      {submissionType===',start);
 assert.ok(start>=0&&end>start);
 const jsx=app.slice(start,end).trim().slice(0,-1);
 for(const singleFileResubmission of [true,false])for(const status of ['open','submitted','completed','unknown'])for(const hasSource of [false,true])for(const reasons of [["確認用の再送理由"],[],["  "],["", "  文字が読めません  ", " "]]){
  const ctx={exports:{},require:createRequire(import.meta.url),singleFileResubmission,submissionType:'report',SubmissionPreviewImage:moduleScope.exports.default,refreshFilePreview:async()=>null,resubmissionDetail:{request:{status,reasons,note:'確認用の備考'},source:hasSource?{id:'source',submissionId:'submission',originalName:'source.pdf',driveName:'',contentType:'application/pdf',previewUrl:null}:null}};
  runInNewContext(ts.transpileModule('export default function Guide(){return ('+jsx+');}',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  const output=renderToStaticMarkup(createElement(ctx.exports.default));
  assert.equal(output.includes('元画像を確認できません'),singleFileResubmission&&!hasSource);assert.equal(output.includes('管理者に対象ファイルを確認'),singleFileResubmission&&!hasSource);assert.equal(output.includes('この画像だけを撮り直し'),singleFileResubmission&&hasSource&&status==='open');assert.equal(output.includes('1ファイル選んで再送'),singleFileResubmission&&status==='open');assert.equal(output.includes('この依頼への再送は受付済み'),status==='submitted');assert.equal(output.includes('この再提出依頼は完了'),status==='completed');assert.equal(output.includes('受付状態を確認できません'),status==='unknown');assert.equal(output.includes('再送理由を確認できません'),!reasons.some(reason=>reason.trim()));assert.equal(output.includes('文字が読めません'),reasons.length===3);assert.ok(!output.includes(' /  / '));assert.equal(output.includes('最大20件、各50MB'),!singleFileResubmission&&status==='open');assert.equal(output.includes('この案件の報告書が対象'),!singleFileResubmission&&!hasSource);
 }
}
{
 const start=app.indexOf('<section className={`panel push-panel');const end=app.indexOf('</section>',start)+10;assert.ok(start>=0&&end>start);const jsx=app.slice(start,end);
 for(const permission of ['denied','unsupported','default','granted'])for(const enabled of [false,true]){
  const ctx={exports:{},require:createRequire(import.meta.url),pushEnabled:enabled,pushStatusUncertain:false,pushActionPending:false,pendingPushAction:null,showPushActions:false,currentPushPermission:()=>permission,setShowPushActions:()=>{},enablePush:async()=>{},disablePush:async()=>{},requestPushTest:async()=>{},retryPushStatus:async()=>{}};
  runInNewContext(ts.transpileModule('export default function Panel(){return ('+jsx+');}',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  const output=renderToStaticMarkup(createElement(ctx.exports.default));const expected=permission==='denied'?'端末で拒否中':permission==='unsupported'?'通知非対応':enabled&&permission==='granted'?'通知ON':'通知OFF';assert.ok(output.includes('>'+expected+'</span>'));assert.equal(output.includes('このアプリの通知を許可'),permission==='denied');assert.equal(output.includes('対応事項を確認してください'),permission==='unsupported');
  if(permission!=='granted'){assert.ok(!output.includes('通知ON'));assert.ok(!output.includes('push-status enabled'));}
 }
 console.log('Push status display: 8 permission/registration states; denied or unsupported overrides stale enabled state, recovery guidance shown.');
}
{
 const start=app.indexOf('<SubmissionHistoryFiles files='),end=app.indexOf('/>',start)+2;assert.ok(start>=0&&end>start);
 const jsx=app.slice(start,end);
 for(const submissionHistory of [[],[{files:[]}],[{files:[{...previewFile,driveName:'history.pdf',originalName:'original.pdf',contentType:'application/pdf',previewUrl:null,status:'completed',purpose:'initial'}]},{files:[]}],[{files:[{...previewFile,driveName:'history.pdf',originalName:'original.pdf',contentType:'application/pdf',previewUrl:null,status:'completed',purpose:'initial'}]}]]){
  const ctx={exports:{},require:createRequire(import.meta.url),SubmissionHistoryFiles:historyModule.exports.default,submissionHistory,refreshFilePreview:async()=>null};
  runInNewContext(ts.transpileModule('export default function History(){return ('+jsx+');}',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  const html=renderToStaticMarkup(createElement(ctx.exports.default));assert.equal(html.includes('提出履歴はありません。'),submissionHistory.length===0);assert.equal(html.includes('一部のファイル情報を確認できません'),submissionHistory.some(group=>group.files.length===0));assert.equal((html.match(/<article/g)||[]).length,submissionHistory.flatMap(group=>group.files).length);
 }
 console.log('History group rendering passed: empty, missing files, mixed and complete groups.');
}
{
 const declaration=app.slice(app.indexOf('  const resubmissionSendBlocked='),app.indexOf(';',app.indexOf('  const resubmissionSendBlocked='))+1);
 const start=app.indexOf('<p id="submission-send-help"'),end=app.indexOf('</button>',start)+9;assert.ok(start>=0&&end>start);const jsx=app.slice(start,end);
 for(const singleFileResubmission of [true,false])for(const status of [null,'open','submitted','completed','cancelled','unknown']){
  const ctx={exports:{},require:createRequire(import.meta.url),singleFileResubmission,requestId:'request',resubmissionDetail:status?{request:{id:'request',jobId:'job',type:'report',status}}:null,selectedJob:{id:'job'},submissionType:'report',files:[{}],submissionConfirmed:true,submissionReadiness:null,submissionEditPending:false,processingSubmission:false,isPending:()=>false,uploadSubmission:async()=>{}};
  runInNewContext(ts.transpileModule(declaration+' export default function Send(){return (<>'+jsx+'</>);}',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  const html=renderToStaticMarkup(createElement(ctx.exports.default));assert.equal(html.includes('disabled=""'),status!=='open');assert.equal(html.includes('「提出情報を再読み込み」'),status!=='open');assert.ok(html.includes('aria-describedby="submission-send-help"'));assert.ok(html.includes(singleFileResubmission?'この画像を再送する':'ファイルを再提出する'));
 }
 console.log('Resubmission send UI passed: 6 statuses with disabled send and linked refresh guidance.');
}
{
 const marker=app.indexOf('{view==="submit"&&!selectedAssignedJob&&'),start=app.indexOf('<section',marker),end=app.indexOf('</section>',start)+10;assert.ok(start>0&&end>start);
 for(const hasJobs of [false,true]){
  const ctx={exports:{},require:createRequire(import.meta.url),submissionPanelRef:{current:null},businessDataFallback:null,myJobs:hasJobs?[{}]:[],navigate:()=>{},EmptyAction:({title})=>createElement('h2',null,title)};
  runInNewContext(ts.transpileModule('export default function Empty(){return ('+app.slice(start,end)+');}',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  const html=renderToStaticMarkup(createElement(ctx.exports.default));assert.ok(html.includes('tabindex="-1"'));assert.ok(html.includes('aria-label="提出画面"'));assert.ok(html.includes(hasJobs?'提出するシフトを選んでください':'提出できる確定シフトはありません'));
 }
 const effectStart=app.indexOf('  useEffect(()=>{if(previousHeadingViewRef.current==='),effectEnd=app.indexOf(String.fromCharCode(10),effectStart);assert.ok(effectStart>0&&effectEnd>effectStart);let focuses=0;
 const ctx={previousHeadingViewRef:{current:'home'},view:'submit',submissionPanelRef:{current:{focus:()=>focuses++}},useEffect:fn=>fn()};const effect=ts.transpileModule(app.slice(effectStart,effectEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;runInNewContext(effect,ctx);runInNewContext(effect,ctx);assert.equal(focuses,1);
 console.log('Submission empty-state focus passed: two empty panels are focusable; view change focuses once without stealing focus on repeated effects.');
}
{
 const start=app.indexOf('{requestId&&!resubmissionDetail&&'),end=app.indexOf('</div>}',start)+6;assert.ok(start>0&&end>start);const jsx=app.slice(start+1,end);
 for(const requestId of ['', 'request'])for(const resubmissionDetail of [null,{}])for(const pending of ['', 'submission-context','submission-refresh']){
  const ctx={exports:{},require:createRequire(import.meta.url),requestId,resubmissionDetail,isPending:key=>key===pending};runInNewContext(ts.transpileModule('export default function Notice(){return ('+jsx+');}',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,ctx);const html=renderToStaticMarkup(createElement(ctx.exports.default));
  if(!requestId||resubmissionDetail)assert.equal(html,'');else{assert.ok(html.includes('role="status"'));assert.equal(html.includes('確認しています'),Boolean(pending));assert.equal(html.includes('「提出情報を再読み込み」'),!pending);}
 }
 console.log('Missing resubmission detail: 12 request/detail/loading combinations show progress or actionable target confirmation before selection.');
}
{
 const start=app.indexOf('<div className="upload-box">'),end=app.indexOf(String.fromCharCode(10)+'      {files.length>0',start);const checkStart=app.indexOf('<label className={`submission-confirmation'),checkEnd=app.indexOf('</label>',checkStart)+8;assert.ok(start>0&&end>start&&checkStart>0&&checkEnd>checkStart);
 for(const singleFileResubmission of [true,false])for(const resubmissionSendBlocked of [false,true])for(const submissionEditPending of [false,true]){
  const ctx={exports:{},require:createRequire(import.meta.url),singleFileResubmission,resubmissionSendBlocked,submissionEditPending,requestId:'request',submissionType:'report',submissionConfirmed:false,addSubmissionFiles:()=>{},setSubmissionConfirmed:()=>{}};
  runInNewContext(ts.transpileModule('export default function Inputs(){return (<>'+app.slice(start,end)+app.slice(checkStart,checkEnd)+'</>);}',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,ctx);const html=renderToStaticMarkup(createElement(ctx.exports.default));assert.equal((html.match(/disabled=""/g)||[]).length,resubmissionSendBlocked||submissionEditPending?3:0);assert.equal(html.includes('multiple=""'),!singleFileResubmission);
 }
 console.log('Resubmission input controls: camera/library/confirmation follow request availability and pending state in 4 combinations.');
}
{
 const start=app.indexOf('{submissionType==="sales_floor"&&<><p id="client-submission-help"'),end=app.indexOf('</>}',start)+3;assert.ok(start>0&&end>start);const jsx=app.slice(start+1,end);
 for(const submissionType of ['sales_floor','report']){
  const ctx={exports:{},require:createRequire(import.meta.url),submissionType,selectedAssignedJob:{submissionStatus:{salesFloor:{clientSubmitted:false}}},submissionReadiness:null,submissionEditPending:false,shiftActionPending:false,pendingShiftAction:'',setClientSubmitted:async()=>{}};
  runInNewContext(ts.transpileModule('export default function ClientStatus(){return ('+jsx+');}',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,ctx);const html=renderToStaticMarkup(createElement(ctx.exports.default));if(submissionType==='report')assert.equal(html,'');else{assert.ok(html.includes('直接提出した場合'));assert.ok(html.includes('提出済みを記録'));assert.ok(html.includes('id="client-submission-help"'));assert.ok(html.includes('aria-describedby="client-submission-help"'));}
 }
 console.log('Client submission explanation: sales-floor action describes recording direct submission; report view excludes the unrelated action.');
}
const emptyHistory=renderToStaticMarkup(createElement(historyModule.exports.default,{files:[],onRefreshPreview:async()=>null}));assert.ok(emptyHistory.includes('提出履歴はありません。'));
console.log('History state rendering passed: 7 transfer states, no preview retry before completion, replacement label and empty history.');
console.log("Staff submission flow passed: 17 routing, 3 timeline isolation, 5 retry scenarios, and missing-URL recovery rendering.");
if (!process.argv.includes("--browser")) {
  console.log("Browser checks not requested; run with --browser after installing Playwright Chromium.");
  process.exit(0);
}

const { createServer } = await import("vite");
const { chromium } = await import("@playwright/test");

const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import Preview from '/src/SubmissionPreviewImage.tsx';
import '/src/styles.css';
function Fixture(){
  const [file,setFile]=React.useState({id:'one',submissionId:'submission',originalName:'photo.png',driveName:'',contentType:'image/png',previewUrl:null});
  window.previewControl ??= {calls:0,resolvers:[]};
  window.previewControl.replace=setFile;
  return React.createElement(Preview,{file,onRefreshPreview:()=>{
    window.previewControl.calls++;
    return new Promise(resolve=>window.previewControl.resolvers.push(resolve));
  }});
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script></body></html>`;
const upcomingControls=section(app,'        <div className="past-shift-pagination">','        {(pastShifts.length>0||hasMorePastShifts)');
const upcomingFixtureCode=ts.transpileModule(`
import React from 'react';import {createRoot} from 'react-dom/client';import '/src/styles.css';
function Fixture(){
 const [hasMoreUpcomingShifts,setMore]=React.useState(true);
 const [upcomingShiftMessage,setMessage]=React.useState('');
 const [busy,setBusy]=React.useState(false);const businessRefreshing=false;
 const isPending=()=>busy;
 window.pagingControl??={calls:0};
 async function loadMoreUpcomingShifts(){
  window.pagingControl.calls++;setBusy(true);setMessage('');
  await new Promise(resolve=>{window.pagingControl.finish=(success)=>{setBusy(false);if(success)setMore(false);else setMessage('これからのシフトを読み込めませんでした。再試行できます。');resolve();};});
 }
 return <main>${upcomingControls}</main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const upcomingFixture=`<!doctype html><html><body><div id="root"></div><script type="module">${upcomingFixtureCode}</script></body></html>`;
const loginStart=app.indexOf('if(firebaseConfigured&&!user)return ');assert.ok(loginStart>=0);
const loginMarkup=app.slice(loginStart+'if(firebaseConfigured&&!user)return '.length,app.indexOf('</main>;',loginStart)+7);
const loginHandlers=app.slice(app.indexOf('  async function requestLogin()'),app.indexOf('  async function registerCurrentDevice('));
const loginFixtureCode=ts.transpileModule(`
import React from 'react';import {createRoot} from 'react-dom/client';import {useAsyncAction} from '/src/useAsyncAction.ts';import '/src/styles.css';
window.loginFixture={calls:[],pending:[],signIns:0};
const firebaseConfigured=true,functions={},auth={},authPersistenceReady=Promise.resolve();
const httpsCallable=()=>input=>new Promise((resolve,reject)=>{window.loginFixture.calls.push(input);window.loginFixture.pending.push({resolve,reject});});
const isSignInWithEmailLink=()=>true,signInWithEmailLink=async()=>{window.loginFixture.signIns++;};
${section(app,'function messageTone(','function submissionFileContentType(')}
function Fixture(){
 const [loginCode,setLoginCode]=React.useState(''),[email,setEmail]=React.useState(''),[message,setMessage]=React.useState('');
 window.loginFixture.setMessage=setMessage;
 const loginEmailRef=React.useRef(null);
 const authLoadVersionRef=React.useRef(1),{isPending,run}=useAsyncAction();
 const isLoginActionPending=()=>isPending('login')||isPending('login-code');
 const loginActionPending=isLoginActionPending(),title='合成ログイン',adminLoginUrl='';
 ${loginHandlers}
 return ${loginMarkup};
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const loginFixture=`<!doctype html><html><body><div id="root"></div><script type="module">${loginFixtureCode}</script></body></html>`;

const businessFallback=section(app,'  const businessDataFallback=','  const openJobsFallback=');
const emptyTaskStart=app.indexOf('<div className="task-clear"'),emptyTaskEnd=app.indexOf('</div></div>',emptyTaskStart)+12;
const taskListStart=app.indexOf('<div className="task-list" id="home-task-list">');
const taskListEnd=app.indexOf('</div></>:<div className="task-clear"',taskListStart)+6;
assert.ok(taskListStart>=0&&taskListEnd>taskListStart);
const taskListJsx=app.slice(taskListStart,taskListEnd);
const taskFixtureCode=ts.transpileModule(`
import React from 'react';import {createRoot} from 'react-dom/client';import '/src/styles.css';
function Fixture(){const [showAllTasks,setShowAllTasks]=React.useState(false);const tasks=Array.from({length:7},(_,index)=>({id:String(index),title:'対応事項'+(index+1),body:'確認用の内容',priority:index===0?'overdue':index===1?'urgent':'normal'}));const visibleTasks=showAllTasks?tasks:tasks.slice(0,5);const submissionEditPending=false,isPending=()=>false,openTask=task=>{window.openedTask=task.id};return (<main>${taskListJsx}</main>);}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const taskFixture=`<!doctype html><html><body><div id="root"></div><script type="module">${taskFixtureCode}</script></body></html>`;
const deviceRowsStart=app.indexOf('devices.map((device,index)=>');
const deviceRowsEnd=app.indexOf(')}{!deviceActionPending',deviceRowsStart)+1;
assert.ok(deviceRowsStart>=0&&deviceRowsEnd>deviceRowsStart);
const deviceRowsJsx=app.slice(deviceRowsStart,deviceRowsEnd);
const devicePanelJsx=app.slice(app.indexOf('{showDevices&&<section')+14,app.indexOf('</section>}',app.indexOf('{showDevices&&<section'))+10);
const deviceFocusEffect=app.split('\n').find(line=>line.includes('useEffect(()=>{if(showDevices)deviceHeadingRef'));
const deviceFixtureCode=ts.transpileModule(`
import React,{useEffect} from 'react';import {createRoot} from 'react-dom/client';import '/src/styles.css';
function Fixture(){const [showDevices,setShowDevices]=React.useState(true);const accountMenuToggleRef=React.useRef(null),deviceHeadingRef=React.useRef(null);${deviceFocusEffect}const [deviceListUncertain,setDeviceListUncertain]=React.useState(false);window.setDeviceUncertain=setDeviceListUncertain;const loadDevices=()=>setDeviceListUncertain(false),EmptyAction=()=>null;const devices=[{id:'current',label:'同名端末'+ 'long-device-name-'.repeat(20),active:true},{id:'other',label:'同名端末'+ 'long-device-name-'.repeat(20),active:true},{id:'inactive',label:'利用終了端末',active:false},{id:'blank-label',label:'　 ',platform:' Android '},{id:'unnamed',label:' ',platform:null},{id:'trimmed',label:' 仕事用端末 ',active:true}];const deviceActionPending=false,pendingDeviceId='',isCurrentDevice=device=>device.id==='current',revokeDevice=id=>{window.deviceTarget=id};return (<main><button ref={accountMenuToggleRef} onClick={()=>setShowDevices(true)}>メニュー</button>{showDevices&&${devicePanelJsx}}</main>);}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const deviceFixture=`<!doctype html><html><body><div id="root"></div><script type="module">${deviceFixtureCode}</script></body></html>`;
const pushPanelStart=app.indexOf('<section className={`panel push-panel');const pushPanelEnd=app.indexOf('</section>',pushPanelStart)+10;assert.ok(pushPanelStart>=0&&pushPanelEnd>pushPanelStart);const pushPanelJsx=app.slice(pushPanelStart,pushPanelEnd);
const pushFixtureCode=ts.transpileModule(`
import React from 'react';import {createRoot} from 'react-dom/client';import '/src/styles.css';
function Fixture(){const [state,setState]=React.useState({enabled:true,permission:'granted',pending:null});const [showPushActions,setShowPushActions]=React.useState(false);window.pushFixture={setState};const pushEnabled=state.enabled,pushStatusUncertain=!!state.uncertain,pendingPushAction=state.pending,pushActionPending=!!state.pending,currentPushPermission=()=>state.permission;const action=kind=>setState(previous=>({...previous,pending:kind}));const enablePush=()=>action('enable'),disablePush=()=>action('disable'),requestPushTest=()=>action('test'),retryPushStatus=()=>action('status');return (<main>${pushPanelJsx}</main>);}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const pushFixture=`<!doctype html><html><body><div id="root"></div><script type="module">${pushFixtureCode}</script></body></html>`;
const diagnosticStart=app.indexOf('<section className={`panel diagnostic-panel');const diagnosticEnd=app.indexOf('</section>',diagnosticStart)+10;assert.ok(diagnosticStart>=0&&diagnosticEnd>diagnosticStart);const diagnosticJsx=app.slice(diagnosticStart,diagnosticEnd);
const diagnosticFocusEffect=app.split('\n').find(line=>line.includes('useEffect(()=>{if(showDiagnostics)diagnosticHeadingRef'));
const diagnosticSummaryExpression=app.split(String.fromCharCode(10)).find(line=>line.includes("const diagnosticSummaryLabel=")).trim().slice("const diagnosticSummaryLabel=".length,-1);
const diagnosticFixtureCode=ts.transpileModule(`
import React,{useEffect} from 'react';import {formatDiagnosticReport} from '/src/diagnostics.ts';import {createRoot} from 'react-dom/client';import '/src/styles.css';
function Fixture(){const [showDiagnostics,setShowDiagnostics]=React.useState(true);const diagnosticHeadingRef=React.useRef(null),accountMenuToggleRef=React.useRef(null);${diagnosticFocusEffect}const report={checkedAt:'2026-09-11T02:00:00Z',summary:'warn',checks:['pass','warn','fail'].map((level,index)=>({id:String(index),level,label:'診断'+index+'長い説明'.repeat(20),detail:'long-diagnostic-details-'.repeat(25)}))};const [state,setState]=React.useState({pending:false,report});window.diagnosticFixture={setState,report,reportText:formatDiagnosticReport(report)};const isPending=()=>false,authLoadVersionRef={current:1};const diagnosticReport=state.report,diagnosticSummaryLabel=${diagnosticSummaryExpression},isDiagnosticsPending=()=>state.pending,openQuickDiagnostics=()=>setState({pending:true,report:null}),closeDiagnostics=()=>setShowDiagnostics(false),shareDiagnostics=()=>{},copyDiagnostics=()=>{};return (<main><button ref={accountMenuToggleRef} onClick={()=>setShowDiagnostics(true)}>メニュー</button>{showDiagnostics&&${diagnosticJsx}}</main>);}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const diagnosticFixture=`<!doctype html><html><body><div id="root"></div><script type="module">${diagnosticFixtureCode}</script></body></html>`;
const businessFixtureCode=ts.transpileModule(`
import React from 'react';import {createRoot} from 'react-dom/client';import '/src/styles.css';
function Fixture(){const [state,setState]=React.useState({status:'loading',source:'none'});window.businessFixture={setState};const businessDataStatus=state.status,businessDataSource=state.source;
${businessFallback}
return <main><section className="panel">{businessDataFallback??(${app.slice(emptyTaskStart,emptyTaskEnd)})}</section></main>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const businessFixture=`<!doctype html><html><body><div id="root"></div><script type="module">${businessFixtureCode}</script></body></html>`;
const openPageStart=app.indexOf('{openJobsStatus==="ready"&&<>'),openPageEnd=app.indexOf('</section>}',openPageStart);assert.ok(openPageStart>=0&&openPageEnd>openPageStart);
const openPageFixtureCode=ts.transpileModule(`
import React from 'react';import {createRoot} from 'react-dom/client';import '/src/styles.css';
function Fixture(){const [state,setState]=React.useState({pending:false,more:true,message:''});window.openPageFixture={setState};const openJobsStatus=state.status??'ready',openJobsPageMessage=state.message,hasMoreOpenJobs=state.more,applicationPending=false,openJobsRefreshing=state.pending,loadMoreOpenJobs=()=>setState({...state,pending:true,message:''}),isPending=()=>state.pending,refreshOpenJobs=()=>setState({...state,status:'loading',pending:true});${section(app,'  const openJobsFallback=','  const diagnosticSummaryLabel=')}return <main><section>{openJobsFallback??<>${app.slice(openPageStart,openPageEnd)}</>}</section></main>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const openPageFixture=`<!doctype html><html><body><div id="root"></div><script type="module">${openPageFixtureCode}</script></body></html>`;
const applicationCardStart=app.indexOf('<article className="job open-job"'),applicationCardEnd=app.indexOf('</article>',applicationCardStart)+10;assert.ok(applicationCardStart>=0&&applicationCardEnd>applicationCardStart);
const applicationRetryCode=ts.transpileModule(`
import React from 'react';import {shiftDateLabel,shiftTextLabel} from '/src/ShiftJobCards.tsx';import {createRoot} from 'react-dom/client';import '/src/styles.css';
${section(app,'function jobPayLabel(','function validNetPrintItem(')}
function Fixture(){const [expanded,setExpanded]=React.useState(false);const [pending,setPending]=React.useState(false);window.applicationRetryFixture={setPending,calls:window.applicationRetryFixture?.calls??[]};const job={id:'synthetic-job',workDate:'2026-09-10',dateKey:'2026-09-10',storeName:'長い店舗名'.repeat(25),makerName:{invalid:true},menuName:{invalid:true},workTime:'09:00〜17:00',basePay:10000,storeAddress:{invalid:true},clientName:[{invalid:true}]},applicationAttemptsRef={current:new Map([[job.id,{}]])},pendingApplicationJobId=pending?job.id:'',applicationPending=pending,openJobsRefreshing=false,setExpandedOpenJobId=()=>setExpanded(!expanded),apply=target=>{window.applicationRetryFixture.calls.push(target.id);setPending(true);};return <main><section>${app.slice(applicationCardStart,applicationCardEnd)}</section></main>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const applicationRetryFixture=`<!doctype html><html><body><div id="root"></div><script type="module">${applicationRetryCode}</script></body></html>`;
const server = await createServer({
  root:resolve("apps/staff"),configFile:resolve("apps/staff/vite.config.ts"),
  server:{host:"127.0.0.1",port:0},
  plugins:[{
    name:"submission-browser-fixture",
    configureServer(devServer){
      // SPAのフォールバックより先に検証用ページを配信する。
      devServer.middlewares.use(async(req,res,next)=>{
        if(!["/__application_retry_test.html","/__open_page_test.html","/__diagnostic_test.html","/__push_test.html","/__devices_test.html","/__tasks_test.html","/__preview_test.html","/__upcoming_test.html","/__login_input_test.html","/__business_state_test.html"].includes(req.url))return next();
        try{
          res.setHeader("Content-Type","text/html");
          res.end(await devServer.transformIndexHtml(req.url,req.url==="/__application_retry_test.html"?applicationRetryFixture:req.url==="/__open_page_test.html"?openPageFixture:req.url==="/__diagnostic_test.html"?diagnosticFixture:req.url==="/__push_test.html"?pushFixture:req.url==="/__devices_test.html"?deviceFixture:req.url==="/__tasks_test.html"?taskFixture:req.url==="/__business_state_test.html"?businessFixture:req.url==="/__login_input_test.html"?loginFixture:req.url==="/__upcoming_test.html"?upcomingFixture:fixture));
        }catch(error){next(error);}
      });
    },
  }],
});
let browser;
try {
  if(Object.entries(server.config.env).some(([name,value])=>name.startsWith("VITE_FIREBASE_")&&value)){
    throw new Error("Browser checks require a demo checkout without Firebase configuration.");
  }
  await server.listen();
  const port=server.httpServer.address().port;
  browser=await chromium.launch({headless:true});
  for(const operation of ['getItem','setItem']){
    const devicePage=await browser.newPage();
    await devicePage.addInitScript(operation=>{window.blockDeviceStorage=true;const original=Storage.prototype[operation];Storage.prototype[operation]=function(key,...args){if(key==='lkcDeviceId'&&window.blockDeviceStorage)throw new DOMException('denied','SecurityError');return original.call(this,key,...args);};},operation);
    await devicePage.goto(`http://127.0.0.1:${port}/`);
    await devicePage.getByRole('heading',{name:'端末情報を保存できません',exact:true}).waitFor();
    assert.equal(await devicePage.locator('.bottom-nav').count(),0);
    for(const width of [320,390,1280]){await devicePage.setViewportSize({width,height:844});assert.equal(await devicePage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
    await devicePage.evaluate(()=>window.blockDeviceStorage=false);
    await devicePage.getByRole('button',{name:'もう一度試す',exact:true}).click();await devicePage.locator('.bottom-nav').waitFor();await devicePage.close();
  }
  console.log('Device storage denial: read/write errors show recovery UI, 3 widths and permission-restored retry opens app.');
  const storagePage=await browser.newPage();const storageErrors=[];storagePage.on('pageerror',error=>storageErrors.push(error.message));
  await storagePage.addInitScript(()=>{const get=Storage.prototype.getItem,set=Storage.prototype.setItem;Storage.prototype.getItem=function(key){if(key==='lkcEmail')throw new DOMException('denied','SecurityError');return get.call(this,key);};Storage.prototype.setItem=function(key,value){if(key==='lkcEmail')throw new DOMException('denied','SecurityError');return set.call(this,key,value);};});
  await storagePage.goto(`http://127.0.0.1:${port}/`);await storagePage.locator('.bottom-nav').waitFor();assert.deepEqual(storageErrors,[]);await storagePage.close();
  const applicationBrowserContext=await browser.newContext({viewport:{width:390,height:844}});
  const page=await applicationBrowserContext.newPage();
  await page.route("**/*",route=>{
    const url=new URL(route.request().url());
    return url.hostname==="127.0.0.1"||url.protocol==="data:"?route.continue():route.abort();
  });
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));

  await page.goto(`http://127.0.0.1:${port}/__tasks_test.html`);
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});const toggle=page.locator('.task-list-toggle');
    assert.equal(await page.locator('.task-card').count(),5);assert.equal(await toggle.getAttribute('aria-controls'),'home-task-list');
    assert.match(await page.locator('.task-card').nth(0).innerText(),/期限超過/);assert.match(await page.locator('.task-card').nth(1).innerText(),/優先対応/);assert.doesNotMatch(await page.locator('.task-card').nth(2).innerText(),/期限超過|優先対応/);
    await toggle.focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.task-card').count(),7);assert.equal(await toggle.getAttribute('aria-expanded'),'true');assert.equal(await toggle.evaluate(node=>node===document.activeElement),true);
    await page.getByRole('button',{name:/対応事項7/}).focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.openedTask),'6');
    await toggle.focus();await page.keyboard.press('Space');assert.equal(await page.locator('.task-card').count(),5);assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(await toggle.evaluate(node=>node===document.activeElement),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  console.log('Task disclosure: real JSX, 5/7 items, keyboard expand/collapse and last action, focus retained, priority text and 3 widths.');
  await page.goto(`http://127.0.0.1:${port}/__application_retry_test.html`);
  await page.evaluate(async()=>{const store=await import('/src/application-attempt-store.ts');const owner=store.applicationAttemptOwner('synthetic-company','synthetic-staff','synthetic-user');store.saveApplicationAttempt(owner,'synthetic-job',{requestId:'persistent-request',startedAt:100});});
  await page.reload();
  const restoredAttempt=await page.evaluate(async()=>{const store=await import('/src/application-attempt-store.ts'),owner=store.applicationAttemptOwner('synthetic-company','synthetic-staff','synthetic-user');const attempt=store.loadSavedApplicationAttempts(owner).get('synthetic-job');const other=store.loadSavedApplicationAttempts(store.applicationAttemptOwner('synthetic-company','synthetic-staff','different-user')).size;store.removeSavedApplicationAttempt(owner,'synthetic-job','persistent-request');return {attempt,other,remaining:store.loadSavedApplicationAttempts(owner).size};});
  assert.deepEqual(restoredAttempt,{attempt:{requestId:'persistent-request',startedAt:100},other:0,remaining:0});
  console.log('Application attempt browser storage: real page reload restores the same synthetic request, isolates another user, and clears only confirmed ownership.');
  const secondApplicationPage=await page.context().newPage();
  await secondApplicationPage.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await secondApplicationPage.goto('http://127.0.0.1:'+port+'/__application_retry_test.html');
  await page.evaluate(async()=>{
    const store=await import('/src/application-attempt-store.ts');
    const owner=store.applicationAttemptOwner('lock-company','lock-staff','lock-user');
    await new Promise(resolve=>{window.applicationTestLock=navigator.locks.request('lkc.applicationAttempts.v2:'+owner+':locked-job',async()=>{resolve();await new Promise(release=>{window.releaseApplicationTestLock=release;});});});
  });
  const busyReservation=await secondApplicationPage.evaluate(async()=>{
    const store=await import('/src/application-attempt-store.ts'),owner=store.applicationAttemptOwner('lock-company','lock-staff','lock-user');let created=0;
    try{await store.reserveApplicationAttempt(owner,'locked-job',()=>{created++;return{requestId:'unexpected',startedAt:1};});return{created,error:''};}catch(error){return{created,error:error.message,records:store.loadSavedApplicationAttempts(owner).size};}
  });
  assert.equal(busyReservation.created,0);assert.equal(busyReservation.records,0);assert.match(busyReservation.error,/別の画面/);
  await page.evaluate(async()=>{window.releaseApplicationTestLock();await window.applicationTestLock;});
  const reserveFromPage=target=>target.evaluate(async()=>{const store=await import('/src/application-attempt-store.ts'),owner=store.applicationAttemptOwner('lock-company','lock-staff','lock-user');return store.reserveApplicationAttempt(owner,'locked-job',()=>({requestId:crypto.randomUUID(),startedAt:Date.now()}));});
  await secondApplicationPage.evaluate(async()=>{const store=await import('/src/application-attempt-store.ts');window.applicationObserved=[];window.stopApplicationObserver=store.observeApplicationAttempts(store.applicationAttemptOwner('lock-company','lock-staff','lock-user'),attempts=>{window.applicationObserved.push([...attempts.values()].map(row=>row.requestId));},()=>{throw Error('unexpected storage failure');});});
  const firstReservation=await reserveFromPage(page),secondReservation=await reserveFromPage(secondApplicationPage);
  await secondApplicationPage.waitForFunction(requestId=>window.applicationObserved.some(ids=>ids.includes(requestId)),firstReservation.requestId);
  await secondApplicationPage.evaluate(()=>window.stopApplicationObserver());
  console.log('Real storage events: a second same-origin page observes the first page request reservation.');
  assert.deepEqual(secondReservation,firstReservation);
  await secondApplicationPage.close();
  console.log('Real same-origin browser pages: held lock prevents request creation; later reservations reuse the persisted winner.');
  await page.goto(`http://127.0.0.1:${port}/__devices_test.html`);
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});
    assert.equal(await page.getByRole('group',{name:/端末 1件目: 同名端末/}).count(),1);assert.equal(await page.getByRole('group',{name:/端末 2件目: 同名端末/}).count(),1);
    assert.match(await page.locator('.device-row').nth(0).innerText(),/この端末/);assert.doesNotMatch(await page.locator('.device-row').nth(1).innerText(),/この端末/);
    const target=page.getByRole('button',{name:'2件目の端末をログアウト',exact:true});await target.focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.deviceTarget),'other');
    assert.equal(await page.getByRole('button',{name:'3件目の端末をログアウト',exact:true}).isDisabled(),true);
    for(const [number,label,status] of [[4,'Android','利用状況未確認'],[5,'端末','利用状況未確認'],[6,'仕事用端末','利用中']]){
      const row=page.getByRole('group',{name:'端末 '+number+'件目: '+label,exact:true});assert.equal(await row.locator('strong').innerText(),number+'. '+label);assert.equal(await row.locator('small').innerText(),status);assert.equal(await row.getByRole('button').isEnabled(),true);assert.equal(await row.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
    }
    await page.evaluate(()=>window.setDeviceUncertain(true));const staleGuide=page.locator('.device-list-uncertain');await staleGuide.waitFor();assert.match(await staleGuide.innerText(),/表示中の情報は前回の内容/);assert.match(await staleGuide.innerText(),/「再読込」/);assert.equal(await staleGuide.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);assert.equal(await page.locator('.device-row').count(),6);
    const refreshDevices=page.getByRole('button',{name:'再読込',exact:true});await refreshDevices.focus();await page.keyboard.press('Enter');await staleGuide.waitFor({state:'detached'});assert.equal(await page.locator('.device-row').count(),6);assert.equal(await refreshDevices.evaluate(node=>document.activeElement===node),true);
    const legacyTarget=page.getByRole('button',{name:'4件目の端末をログアウト',exact:true});await legacyTarget.focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.deviceTarget),'blank-label');

    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.locator('.device-row').first().evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
  }
  await page.getByRole('button',{name:'閉じる',exact:true}).click();assert.equal(await page.getByRole('button',{name:'メニュー',exact:true}).evaluate(node=>node===document.activeElement),true);assert.equal(await page.locator('.device-panel').count(),0);await page.keyboard.press('Enter');await page.getByRole('heading',{name:'ログイン中の端末',exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'ログイン中の端末',exact:true}).evaluate(node=>node===document.activeElement),true);
  console.log('Device uncertainty: 3 widths preserve prior rows and fit persistent guidance; keyboard refresh clears guidance and retains focus.');
  console.log('Device rows: same-name targets, current/inactive/unknown states, 9 blank/trimmed label checks and keyboard target recording at 3 widths; no device mutation.');
  await page.goto(`http://127.0.0.1:${port}/__push_test.html`);
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});await page.evaluate(()=>window.pushFixture.setState({enabled:true,permission:'granted',pending:null}));
    const settings=page.locator('.push-settings-toggle');await settings.focus();await page.keyboard.press('Enter');assert.equal(await settings.getAttribute('aria-expanded'),'true');assert.equal(await settings.getAttribute('aria-controls'),'push-enabled-actions');assert.equal(await page.getByRole('status').innerText(),'通知ON');
    for(const action of ['test','disable']){
      await page.getByRole('button',{name:action==='test'?'通知テスト':'通知OFF',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.push-panel').getAttribute('aria-busy')==='true');assert.equal(await page.locator('.push-panel button:not(:disabled)').count(),0);
      await page.evaluate(()=>window.pushFixture.setState({enabled:true,permission:'granted',pending:null}));await page.waitForFunction(()=>document.querySelector('.push-panel').getAttribute('aria-busy')==='false');
    }
    await page.evaluate(()=>window.pushFixture.setState({enabled:true,permission:'granted',pending:null,uncertain:true}));await page.getByRole('status').filter({hasText:'通知状態未確認'}).waitFor();assert.equal(await page.locator('.push-status.enabled').count(),0);assert.match(await page.locator('.push-panel').innerText(),/登録状態を確認できません/);
    const retryStatus=page.getByRole('button',{name:'通知状態を再確認',exact:true});await retryStatus.focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'確認中…',exact:true}).waitFor();assert.equal(await page.locator('.push-panel button:not(:disabled)').count(),0);

    await page.evaluate(()=>window.pushFixture.setState({enabled:true,permission:'granted',pending:null,uncertain:false}));await page.getByRole('status').filter({hasText:'通知ON'}).waitFor();
    await settings.focus();await page.keyboard.press('Space');assert.equal(await settings.getAttribute('aria-expanded'),'false');assert.equal(await page.locator('#push-enabled-actions').count(),0);
    for(const permission of ['denied','unsupported','default']){
      await page.evaluate(permission=>window.pushFixture.setState({enabled:false,permission,pending:null}),permission);
      await page.waitForFunction(permission=>document.querySelector('.push-status').textContent===(permission==='denied'?'端末で拒否中':permission==='unsupported'?'通知非対応':'通知OFF'),permission);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
    await page.getByRole('button',{name:'通知を有効にする',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.push-panel').getAttribute('aria-busy')==='true');assert.equal(await page.locator('.push-panel button:not(:disabled)').count(),0);
  }
  console.log('Push panel: real JSX status announcements, keyboard disclosure, enable/test/disable busy lock, denied/unsupported/default guidance at 3 widths; no permission or push requests.');
  await page.goto(`http://127.0.0.1:${port}/__application_retry_test.html`);
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});await page.evaluate(()=>window.applicationRetryFixture.setPending(false));
    await page.getByRole('button',{name:'詳細を見る',exact:true}).click();const details=page.locator('#job-details-synthetic-job');await details.waitFor();for(const label of ['店舗住所','依頼元'])assert.equal(await details.locator('div').filter({has:page.locator('dt',{hasText:label})}).locator('dd').innerText(),'確認中');await page.getByRole('button',{name:'詳細を閉じる',exact:true}).click();assert.equal(await details.count(),0);
    const retry=page.getByRole('button',{name:'応募結果を再確認する',exact:true});await retry.waitFor();const description=await retry.getAttribute('aria-describedby');assert.equal(description,'application-result-synthetic-job');assert.match(await page.locator('#'+description).innerText(),/この案件の応募結果は未確認/);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await retry.focus();await retry.press('Enter');const busy=page.getByRole('button',{name:'応募中…',exact:true});await busy.waitFor();assert.equal(await busy.isDisabled(),true);assert.equal(await busy.getAttribute('aria-describedby'),null);assert.equal(await page.evaluate(()=>window.applicationRetryFixture.calls.at(-1)),'synthetic-job');
    await page.evaluate(()=>window.applicationRetryFixture.setPending(false));await retry.waitFor();assert.equal(await retry.isEnabled(),true);
  }
  console.log('Application result retry UI: 3 widths, long store name, described status, Enter target selection, pending disable and failure recovery; no application API.');
  await page.goto(`http://127.0.0.1:${port}/__open_page_test.html`);
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});await page.evaluate(()=>window.openPageFixture.setState({pending:false,more:true,message:''}));
    const more=page.getByRole('button',{name:'募集案件の続きを読み込む',exact:true});await more.focus();await more.press('Enter');
    const busy=page.getByRole('button',{name:'読み込み中…',exact:true});await busy.waitFor();assert.equal(await busy.isDisabled(),true);assert.equal(await busy.getAttribute('aria-busy'),'true');
    await page.evaluate(()=>window.openPageFixture.setState({pending:false,more:true,message:'募集案件の続きを読み込めませんでした。下のボタンでもう一度お試しください。'}));await more.waitFor();assert.equal(await more.isEnabled(),true);assert.match(await page.getByRole('status').innerText(),/もう一度/);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.evaluate(()=>window.openPageFixture.setState({pending:false,more:true,message:'募集案件の続きを読み込みました。一覧を確認してください。'}));assert.match(await page.getByRole('status').innerText(),/続きを読み込みました/);
    await more.focus();
    await page.evaluate(()=>window.openPageFixture.setState({pending:false,more:false,message:'募集案件の最後まで読み込みました。一覧を確認してください。'}));const done=page.getByRole('button',{name:'すべて読み込み済み',exact:true});await done.waitFor();assert.equal(await done.getAttribute('aria-disabled'),'true');assert.equal(await done.evaluate(node=>document.activeElement===node),true);assert.match(await page.getByRole('status').innerText(),/最後まで読み込みました/);await page.keyboard.press('Enter');assert.equal(await done.count(),1);await page.keyboard.press('Space');assert.equal(await done.count(),1);
  }
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});await page.evaluate(()=>window.openPageFixture.setState({status:'error',pending:false,more:false,message:''}));
    const group=page.getByRole('group',{name:'募集案件の読込エラー',exact:true});await group.waitFor();assert.match(await group.innerText(),/通信状態/);const retry=group.getByRole('button',{name:'もう一度試す',exact:true});await retry.focus();await retry.press('Enter');await page.getByRole('status').waitFor();assert.match(await page.getByRole('status').innerText(),/読み込んでいます/);assert.equal(await group.count(),0);
    await page.evaluate(()=>window.openPageFixture.setState({status:'error',pending:true,more:false,message:''}));await group.waitFor();assert.equal(await retry.isDisabled(),true);
    await page.evaluate(()=>window.openPageFixture.setState({status:'error',pending:false,more:false,message:''}));await page.waitForFunction(()=>!document.querySelector('button')?.disabled);assert.equal(await retry.isEnabled(),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  console.log('Open job read error: named error panel, connection guide, Enter retry/loading status, pending guard and failure recovery at 3 widths.');
  console.log('Open jobs continuation UI passed: 3 widths, keyboard, pending/disabled, error retry and final-page focus retention/no action; synthetic state.');
  await page.goto(`http://127.0.0.1:${port}/__diagnostic_test.html`);
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});await page.evaluate(()=>window.diagnosticFixture.setState({pending:false,report:window.diagnosticFixture.report}));
    for(const [index,label] of ['正常','要確認','エラー'].entries())assert.equal(await page.getByRole('group',{name:new RegExp('診断'+index+'.*: '+label)}).count(),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.locator('.diagnostic-row').first().evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
    const showText=page.getByText('共有用の文章を表示',{exact:true});await showText.focus();await page.keyboard.press('Enter');
    const sharedText=page.getByRole('textbox',{name:'診断結果の共有用文章',exact:true});await sharedText.waitFor();assert.equal(await sharedText.inputValue(),await page.evaluate(()=>window.diagnosticFixture.reportText));assert.equal(await sharedText.getAttribute('readonly'),'');await sharedText.focus();await page.keyboard.press('ControlOrMeta+A');assert.equal(await sharedText.evaluate(el=>el.selectionEnd-el.selectionStart),await sharedText.evaluate(el=>el.value.length));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const retry=page.getByRole('button',{name:'もう一度診断',exact:true});await retry.focus();await page.keyboard.press('Enter');await page.locator('.diagnostic-loading[role="status"]').waitFor();assert.equal(await page.getByRole('textbox',{name:'診断結果の共有用文章',exact:true}).count(),0);assert.equal(await page.locator('.diagnostic-panel').getAttribute('aria-busy'),'true');assert.equal(await page.getByRole('button',{name:'診断中…',exact:true}).isDisabled(),true);
    await page.evaluate(()=>window.diagnosticFixture.setState({pending:false,report:{summary:'fail',checks:[{id:'error',level:'fail',label:'診断の取得',detail:'もう一度診断してください。'}]}}));await page.getByRole('group',{name:'診断の取得: エラー',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'もう一度診断',exact:true}).isEnabled(),true);
  }
  const changedDiagnosticReports=[];
  for(const change of ['disconnect','reconnect','denied','default']){
    let permission='granted';const diagnosticScope={exports:{},navigator:{onLine:change!=='reconnect',serviceWorker:{ready:Promise.resolve({})}},window:{setTimeout,clearTimeout},require:()=>({currentPushPermission:()=>permission,loadServerPushStatusWithRetry:async()=>{if(change==='disconnect')diagnosticScope.navigator.onLine=false;else if(change==='reconnect')diagnosticScope.navigator.onLine=true;else permission=change;return true;}})};
    runInNewContext(ts.transpileModule(readFileSync('apps/staff/src/diagnostics.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,diagnosticScope);
    const report=await diagnosticScope.exports.runStaffDiagnostics({signedIn:true,companyScoped:true,businessDataStatus:'ready',businessDataSource:'live',businessRefreshing:false,homeDisplayMs:100,businessRefreshMs:100,homeLoadedFromCache:false,deviceSessionRegistered:true,functions:{}});changedDiagnosticReports.push({report,text:diagnosticScope.exports.formatDiagnosticReport(report)});
  }
  for(const width of [320,390,1280])for(const {report,text} of changedDiagnosticReports){
    await page.setViewportSize({width,height:844});await page.evaluate(report=>window.diagnosticFixture.setState({pending:false,report}),report);
    await page.waitForFunction(summary=>document.querySelector('.diagnostic-summary').classList.contains(summary),report.summary);assert.equal(await page.locator('.diagnostic-summary').innerText(),report.summary==='fail'?'エラーあり':'確認あり');
    for(const check of report.checks.filter(check=>check.detail.includes('診断中に'))){const row=page.getByRole('group',{name:check.label+': '+(check.level==='fail'?'エラー':'要確認'),exact:true});assert.ok((await row.innerText()).includes(check.detail));assert.equal(await row.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);}
    if(!await page.locator('.diagnostic-copy-text').evaluate(node=>node.open))await page.getByText('共有用の文章を表示',{exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'診断結果の共有用文章',exact:true}).inputValue(),text);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  console.log('Diagnostic changes browser: 3 widths × disconnection/recovery/denied/default show matching real summary, changed-state guidance and exact exported text.');
  await page.getByRole('button',{name:'閉じる',exact:true}).click();assert.equal(await page.getByRole('button',{name:'メニュー',exact:true}).evaluate(node=>node===document.activeElement),true);assert.equal(await page.locator('.diagnostic-panel').count(),0);await page.keyboard.press('Enter');await page.getByRole('heading',{name:'かんたん自動診断',exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'かんたん自動診断',exact:true}).evaluate(node=>node===document.activeElement),true);const copyResult=page.getByRole('button',{name:'コピー',exact:true});await copyResult.focus();await page.evaluate(()=>window.diagnosticFixture.setState({pending:false,report:window.diagnosticFixture.report}));assert.equal(await copyResult.evaluate(node=>node===document.activeElement),true);
  console.log('Diagnostic panel: named pass/warn/fail groups, long text at 3 widths, keyboard retry/loading status and failure recovery; no diagnostics or sharing requests.');
  await page.goto(`http://127.0.0.1:${port}/__business_state_test.html`);
  await page.getByRole('status').waitFor();assert.match(await page.getByRole('status').innerText(),/読み込んでいます/);
  for(const state of [{status:'error',source:'none'},{status:'ready',source:'cached'},{status:'ready',source:'stale'},{status:'ready',source:'live'}]){
    await page.evaluate(state=>window.businessFixture.setState(state),state);
    if(state.status==='error'){await page.getByRole('group',{name:'業務データの読込エラー'}).waitFor();assert.match(await page.locator('main').innerText(),/管理者にスタッフ登録・所属/);}
    else await page.waitForFunction(source=>document.querySelector('strong')?.textContent?.includes(source==='live'?'今日の対応':'前回確認時点'),state.source);
    for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  }
  await page.evaluate(()=>window.businessFixture.setState({status:'error',source:'none'}));
  const reloadBusiness=page.getByRole('button',{name:'再読み込み',exact:true});await reloadBusiness.focus();
  await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),reloadBusiness.press('Enter')]);
  await page.getByRole('status').waitFor();assert.match(await page.getByRole('status').innerText(),/読み込んでいます/);
  console.log('Business startup UI: real loading/error/empty JSX, named recovery group, 3 widths, keyboard reload restarts page; no auth/cloud.');
  await page.goto(`http://127.0.0.1:${port}/__login_input_test.html`);
  await page.getByText('メールが届かない・コードが使えないとき',{exact:true}).click();
  for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  assert.match(await page.locator('#login-code-help').innerText(),/15分間・1回限り/);
  assert.equal(await page.getByLabel('スタッフのメールアドレス',{exact:true}).getAttribute('type'),'email');
  const codeInput=page.getByLabel('確認コード',{exact:true});
  await codeInput.focus();await page.keyboard.insertText('１２３４５６');assert.equal(await codeInput.inputValue(),'123456');
  for(const [text,expected] of [['１２３ ４５６','123456'],['１２３-４５６','123456'],['123456','123456'],['abc',''],['１２３４５６７','123456']]){
    const prevented=await codeInput.evaluate((input,text)=>{const data=new DataTransfer();data.setData('text/plain',text);const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});input.dispatchEvent(event);return event.defaultPrevented;},text);
    assert.equal(prevented,true);assert.equal(await codeInput.inputValue(),expected);
  }
  console.log('Login input browser passed: real JSX, native full-width insertion and synthetic clipboard paste with separators; no authentication.');
  const emailInput=page.getByLabel('スタッフのメールアドレス',{exact:true});
  for(const invalidEmail of ['', 'invalid-address']){await emailInput.fill(invalidEmail);await codeInput.fill('123456');const before=await page.evaluate(()=>window.loginFixture.calls.length);await page.getByRole('button',{name:'確認コードでログイン',exact:true}).click();assert.equal(await emailInput.evaluate(input=>input===document.activeElement),true);assert.equal(await emailInput.evaluate(input=>input.validity.valid),false);assert.equal(await page.evaluate(()=>window.loginFixture.calls.length),before);assert.equal(await codeInput.inputValue(),'123456');}
  console.log('Code login rejects missing/malformed email, focuses the email field, retains code and makes no request.');
  await emailInput.fill('synthetic@example.test');
  for(const action of ['resend','verify']){
    await codeInput.fill('123456');
    const button=page.getByRole('button',{name:action==='resend'?'ログインメールを送る':'確認コードでログイン',exact:true});
    const before=await page.evaluate(()=>window.loginFixture.calls.length);
    await button.evaluate(button=>{button.click();button.click();});
    await page.waitForFunction(count=>window.loginFixture.calls.length===count,before+1);
    assert.equal(await emailInput.isDisabled(),true);assert.equal(await codeInput.isDisabled(),true);
    assert.equal(await page.locator('button:disabled').count(),2);assert.equal(await codeInput.inputValue(),'123456');
    await page.evaluate(()=>window.loginFixture.pending.shift().reject(Error('合成処理に失敗しました。')));
    await page.getByRole('alert').waitFor();await page.waitForFunction(()=>!document.querySelector('input').disabled);
    assert.equal(await codeInput.inputValue(),'123456');assert.equal(await button.isEnabled(),true);
    await button.click();await page.waitForFunction(count=>window.loginFixture.calls.length===count,before+2);
    assert.equal(await page.getByRole('alert').count(),0,'Previous error must disappear while retry is pending');
    await page.evaluate(()=>window.loginFixture.pending.shift().resolve({data:{accepted:true,message:'送信しました。',emailActionLink:'https://example.test/synthetic'}}));
    await page.waitForFunction(()=>!document.querySelector('input').disabled);assert.equal(await codeInput.inputValue(),'');
  }
  assert.equal(await page.evaluate(()=>window.loginFixture.signIns),1);
  console.log('Login actions passed: real handlers/pending hook, duplicate clicks blocked, failure keeps code and restores actions, retry clears code; SDK mocked.');
  const emailLinkFailure=app.match(/setMessage\("(メールのリンクでログインできませんでした。[^"\n]+)"\)/)[1];
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});await page.evaluate(message=>window.loginFixture.setMessage(message),emailLinkFailure);
    const alert=page.getByRole('alert');await alert.waitFor();assert.equal(await alert.innerText(),emailLinkFailure);assert.ok((await alert.getAttribute('class')).includes('error'));
    assert.equal(await emailInput.isEnabled(),true);assert.equal(await codeInput.isEnabled(),true);assert.equal(await page.getByRole('button',{name:'ログインメールを送る',exact:true}).isEnabled(),true);
    await codeInput.fill('123456');assert.equal(await page.getByRole('button',{name:'確認コードでログイン',exact:true}).isEnabled(),true);
    const help=page.locator('summary').filter({hasText:'メールが届かない・コードが使えないとき'});await help.focus();if(await help.evaluate(node=>node.parentElement.open)){await page.keyboard.press('Enter');}await page.keyboard.press('Enter');await page.getByText(/メールアドレスの入力と迷惑メールフォルダー/).waitFor();await page.keyboard.press('Enter');assert.equal(await help.evaluate(node=>document.activeElement===node),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await alert.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
  }
  console.log('Email-link recovery browser: actual error classification, exact guidance, available resend/code inputs and keyboard help at 3 widths.');


  await page.goto(`http://127.0.0.1:${port}/__preview_test.html`);
  const retry=page.getByRole("button",{name:"画像を再読み込み"});
  await retry.waitFor();
  await retry.evaluate(button=>{button.click();button.click();});
  assert.equal(await page.evaluate(()=>window.previewControl.calls),1);
  assert.equal(await page.getByRole("button",{name:"再取得中…"}).isDisabled(),true);
  await page.evaluate(()=>window.previewControl.resolvers.shift()(null));
  await retry.waitFor();
  assert.equal(await retry.isEnabled(),true);
  await retry.click();
  await page.evaluate(()=>window.previewControl.resolvers.shift()({url:'invalid'}));
  await retry.waitFor();
  assert.equal(await page.locator('img').count(),0,'Invalid preview responses must not become image sources.');
  assert.equal(await retry.isEnabled(),true);
  await retry.click();
  const imageUrl="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  await page.evaluate(url=>window.previewControl.resolvers.shift()(url),imageUrl);
  await page.locator("img.loaded").waitFor();
  assert.equal(await page.locator(".preview-frame").evaluate(node=>document.activeElement===node),true,"Successful retry restores focus to its named preview container");
  await page.locator('img').evaluate(img=>img.dispatchEvent(new Event('error')));
  await page.getByRole('button',{name:'再読み込み',exact:true}).click();
  assert.equal(await page.locator('img').count(),0,'An expired image must not remount while its replacement URL is pending.');
  assert.equal(await page.getByRole('button',{name:'再取得中…',exact:true}).isDisabled(),true);
  assert.equal(await page.locator('.preview-placeholder').evaluate(node=>document.activeElement===node),true);
  await page.evaluate(()=>{const other=document.createElement('button');other.id='other-focus';other.textContent='別の操作';document.body.appendChild(other);other.focus();});
  await page.evaluate(url=>window.previewControl.resolvers.shift()(url),imageUrl);
  await page.locator('img.loaded').waitFor();
  assert.equal(await page.locator('#other-focus').evaluate(node=>document.activeElement===node),true,'Preview completion must not steal focus moved elsewhere');
  await page.evaluate(()=>window.previewControl.replace({id:"two",submissionId:"other",originalName:"other.png",driveName:"",contentType:"image/png",previewUrl:null}));
  await retry.click();
  await page.evaluate(()=>window.previewControl.replace({id:"three",submissionId:"next",originalName:"next.png",driveName:"",contentType:"image/png",previewUrl:null}));
  await retry.waitFor();
  await page.evaluate(url=>window.previewControl.resolvers.shift()(url),imageUrl);
  assert.equal(await page.locator("img").count(),0,"Old preview response must not populate the next file.");
  assert.equal(await retry.isEnabled(),true);
  assert.deepEqual(errors,[]);

  for (const width of [320,390,1280]) {
    await page.setViewportSize({width,height:844});
    await page.evaluate(({width,imageUrl})=>window.previewControl.replace({id:'keyboard-'+width,submissionId:'keyboard',originalName:'keyboard.png',driveName:'',contentType:'image/png',previewUrl:imageUrl}),{width,imageUrl});
    await page.locator('img.loaded').waitFor();
    await page.locator('img').evaluate(img=>img.dispatchEvent(new Event('error')));
    const errorRetry=page.getByRole('button',{name:'再読み込み',exact:true});
    await errorRetry.focus();await page.keyboard.press('Enter');
    await page.getByRole('button',{name:'再取得中…',exact:true}).waitFor();
    await page.evaluate(()=>window.previewControl.resolvers.shift()(null));
    await retry.waitFor();
    assert.equal(await page.locator('.preview-placeholder').evaluate(node=>document.activeElement===node),true,'Failed image retry keeps a usable focus anchor');
    await page.keyboard.press('Tab');
    assert.equal(await retry.evaluate(node=>document.activeElement===node),true,'Tab reaches retry after failure');
    await page.keyboard.press('Enter');
    await page.getByRole('button',{name:'再取得中…',exact:true}).waitFor();
    await page.evaluate(url=>window.previewControl.resolvers.shift()(url),imageUrl);
    await page.locator('img.loaded').waitFor();
    assert.equal(await page.locator('.preview-frame').evaluate(node=>document.activeElement===node),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('img').evaluate(img=>img.dispatchEvent(new Event('error')));
    await errorRetry.focus();await page.keyboard.press('Enter');
    await page.locator('#other-focus').focus();
    await page.evaluate(width=>window.previewControl.replace({id:'replacement-'+width,submissionId:'new',originalName:'new.png',driveName:'',contentType:'image/png',previewUrl:null}),width);
    await retry.waitFor();
    await page.evaluate(url=>window.previewControl.resolvers.shift()(url),imageUrl);
    assert.equal(await page.locator('img').count(),0);
    assert.equal(await page.locator('#other-focus').evaluate(node=>document.activeElement===node),true,'Old completion after file replacement preserves external focus');
  }
  assert.deepEqual(errors,[]);
  console.log('Preview keyboard recovery passed: failed retry, Tab/Enter recovery, and replaced-file stale response at 3 widths.');

  const draftCheck=await page.evaluate(async()=>{
    const {saveDraft,loadDraft,clearDraft}=await import('/src/draft-store.ts');
    const {submissionDraftKey}=await import('/src/submission-draft-key.ts');
    const a=submissionDraftKey('company/user-a','fixture-job','report');
    const b=submissionDraftKey('company/user-b','fixture-job','report');
    await saveDraft(a,[new File(['draft-a'],'fixture.txt',{type:'text/plain'})]);
    const own=await loadDraft(a), other=await loadDraft(b);
    await clearDraft(a);
    return {own:own.length,body:await own[0].text(),other:other.length,cleared:(await loadDraft(a)).length};
  });
  assert.deepEqual(draftCheck,{own:1,body:'draft-a',other:0,cleared:0});

  const interruptedDrafts=await page.evaluate(async()=>{
    const {saveDraft,loadDraft,clearDraft}=await import('/src/draft-store.ts');
    const key='browser-abort-recovery';
    const file=new File(['retained'],'retained.pdf',{type:'application/pdf',lastModified:1234});
    await saveDraft(key,[file]);
    const outcomes=[];
    for(const [method,operation] of [
      ['put',()=>saveDraft(key,[new File(['replacement'],'replacement.pdf')])],
      ['delete',()=>clearDraft(key)],
      ['get',()=>loadDraft(key)],
    ]){
      const original=IDBObjectStore.prototype[method];
      let timer;
      IDBObjectStore.prototype[method]=function(...args){
        const request=original.apply(this,args);
        request.addEventListener('success',()=>request.transaction.abort(),{once:true});
        return request;
      };
      try{
        const outcome=await Promise.race([
          operation().then(()=>'unexpected-success',error=>error?.name),
          new Promise(resolve=>{timer=setTimeout(()=>resolve('timeout'),2000);}),
        ]);
        if(outcome!=='AbortError')throw new Error(`${method}: expected AbortError, got ${outcome}`);
        outcomes.push(outcome);
      }finally{
        clearTimeout(timer);
        IDBObjectStore.prototype[method]=original;
      }
      const retained=await loadDraft(key);
      if(retained.length!==1||await retained[0].text()!=='retained')throw new Error('Aborted transaction changed the saved draft');
    }
    // 中断したキーでも次の保存・解除が待機し続けないことを実DBで確認。
    await saveDraft(key,[file]);
    await clearDraft(key);
    return {outcomes,remaining:(await loadDraft(key)).length};
  });
  assert.deepEqual(interruptedDrafts,{outcomes:['AbortError','AbortError','AbortError'],remaining:0});

  const submittedDraft=await page.evaluate(async()=>{
    const store=await import('/src/draft-store.ts');
    const key='browser-submitted-cleanup';
    await store.saveDraft(key,[new File(['sent'],'sent.pdf')]);
    const durable=store.markDraftSubmitted(key);
    const original=IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete=function(...args){
      const request=original.apply(this,args);
      request.addEventListener('success',()=>request.transaction.abort(),{once:true});
      return request;
    };
    let failed=false;
    try{await store.clearDraft(key);}catch{failed=true;}finally{IDBObjectStore.prototype.delete=original;}
    const current=(await store.loadDraft(key)).length;
    // 新しいモジュールはメモリ状態を共有せず、永続した送信済み印だけで復元を抑止する。
    const fresh=await import('/src/draft-store.ts?submitted-reload');
    const restored=(await fresh.loadDraft(key)).length;
    const recoverable=fresh.getSubmittedDraftReceipt(key)?.durable===true;
    let staleSaveRejected=false;
    try{await store.saveDraft(key,[new File(['sent'],'sent.pdf')]);}catch{staleSaveRejected=true;}
    await store.clearDraft(key);
    await store.saveDraft(key,[new File(['new'],'new.pdf')]);
    const [next]=await store.loadDraft(key);
    const nextBody=await next.text();
    await store.clearDraft(key);
    return {durable,failed,current,restored,recoverable,staleSaveRejected,nextBody};
  });
  assert.deepEqual(submittedDraft,{durable:true,failed:true,current:0,restored:0,recoverable:true,staleSaveRejected:true,nextBody:'new'});
  const largeDraft=await page.evaluate(async()=>{
    const {saveDraft,loadDraft,clearDraft}=await import('/src/draft-store.ts');
    const key='browser-50mb-draft';
    const bytes=new Uint8Array(50*1024*1024);
    bytes[0]=37;bytes[bytes.length-1]=91;
    const file=new File([bytes],'large-report.pdf',{type:'application/pdf',lastModified:1234});
    try{
      await saveDraft(key,[file]);
      const [restored]=await loadDraft(key);
      return {size:restored.size,name:restored.name,type:restored.type,lastModified:restored.lastModified,
        first:new Uint8Array(await restored.slice(0,1).arrayBuffer())[0],
        last:new Uint8Array(await restored.slice(-1).arrayBuffer())[0]};
    }finally{await clearDraft(key);}
  });
  assert.deepEqual(largeDraft,{size:50*1024*1024,name:'large-report.pdf',type:'application/pdf',lastModified:1234,first:37,last:91});

  // The ordinary demo remains usable at phone and desktop widths.
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByRole("button",{name:"シフトを開く",exact:true}).waitFor();
  assert.deepEqual(await page.getByRole("heading",{level:2}).allTextContents(),["今日やること","次回シフト","プッシュ通知"]);
  for(const [nav,heading] of [['連絡','連絡先'],['案件','募集中の案件'],['ホーム','今日やること']]){
    await page.locator('.bottom-nav').getByRole('button',{name:new RegExp(nav)}).click();
    assert.equal(await page.getByRole('heading',{name:heading,exact:true}).evaluate(node=>document.activeElement===node),true,'Navigation focuses '+heading);
  }
  await page.locator('.bottom-nav').getByRole('button',{name:/提出/}).click();
  assert.equal(await page.getByRole('region',{name:'提出画面',exact:true}).evaluate(node=>document.activeElement===node),true,'Submission navigation focuses the panel.');
  await page.locator('.bottom-nav').getByRole('button',{name:/ホーム/}).click();
  const output=process.env.LKC_VISUAL_EVIDENCE_DIR;
  if(output){mkdirSync(output,{recursive:true});await page.screenshot({path:resolve(output,"staff-home-mobile.png"),fullPage:true});}
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,`Home overflows at ${width}px`);
    await page.getByRole("button",{name:"シフトを開く",exact:true}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,`Shifts overflow at ${width}px`);
    if(output)await page.screenshot({path:resolve(output,`staff-shifts-${width}.png`),fullPage:true});
    await page.getByRole("button",{name:"🖼️ 売場画像を提出",exact:true}).click();
    await page.getByRole("heading",{name:"売場画像を提出",exact:true}).waitFor();
    assert.equal(await page.getByRole('region',{name:'提出画面',exact:true}).evaluate(node=>document.activeElement===node),true,'Selected shift submission focuses its panel.');
    await page.getByRole("button",{name:"画像を再読み込み",exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,`Submission overflows at ${width}px`);
    if(output)await page.screenshot({path:resolve(output,`staff-submission-${width}.png`),fullPage:true});
    await page.locator(".bottom-nav").getByRole("button",{name:"ホーム"}).click();
  }
  assert.deepEqual(errors,[]);
  if(output){
    await page.setViewportSize({width:390,height:844});
    for(const [label,file] of [['案件','staff-jobs-390.png'],['連絡','staff-contact-390.png']]){
      await page.locator('.bottom-nav').getByRole('button',{name:new RegExp(label)}).click();
      await page.screenshot({path:resolve(output,file),fullPage:true});
    }
  }
  await page.setViewportSize({width:320,height:844});
  await page.locator('.bottom-nav').getByRole('button',{name:/提出/}).click();
  await page.addStyleTag({content:':root { font-size:32px; }'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Enlarged submission text must not overflow at 320px');
  await page.emulateMedia({reducedMotion:'reduce'});
  const reloadButton=page.getByRole('button',{name:'画像を再読み込み',exact:true});
  await reloadButton.focus();
  assert.equal(await reloadButton.evaluate(element=>element===document.activeElement),true);
  await page.keyboard.press('Enter');
  await reloadButton.waitFor();
  assert.equal(await reloadButton.isEnabled(),true);
  if(output)await page.screenshot({path:resolve(output,'staff-submission-large-text.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  // 実デモ画面で再提出の選び直しを検証。端末内だけで、送信は行わない。
  await page.addStyleTag({content:':root { font-size:16px; }'});
  await page.locator('.bottom-nav').getByRole('button',{name:'ホーム'}).click();
  const longTask=page.locator('.task-card').first();
  const taskOriginal=await longTask.evaluate(node=>[node.querySelector('strong').textContent,node.querySelector('span').textContent]);
  await longTask.evaluate(node=>{node.querySelector('strong').textContent='長い店舗名と対応事項'.repeat(35);node.querySelector('span').textContent='long-task-details-without-spaces-'.repeat(35);});
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await longTask.evaluate(node=>Array.from(node.children).every(child=>child.scrollWidth<=child.clientWidth+1)),true);
  }
  await longTask.evaluate((node,values)=>{node.querySelector('strong').textContent=values[0];node.querySelector('span').textContent=values[1];},taskOriginal);
  console.log('Home task cards: long Japanese titles and unbroken details fit 3 viewport widths.');
  await page.getByRole('button',{name:/報告書を再送してください/}).click();
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});
    const refreshInformation=page.getByRole('button',{name:'提出情報を再読み込み',exact:true});
    await refreshInformation.waitFor();await refreshInformation.focus();await page.keyboard.press('Enter');
    await page.locator('.submission-message').filter({hasText:'提出情報を更新しました。'}).waitFor();
    assert.equal(await refreshInformation.isEnabled(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  console.log('Submission manual refresh passed: real demo resubmission, ready history, keyboard and 320/390/1280px.');
  const historyCard=page.getByRole('article',{name:'提出履歴 1件目: 7.12 ベイシア成田 Aさん (1).jpg',exact:true});
  const originalHistory=await historyCard.locator('strong').innerText();
  await historyCard.locator('strong').evaluate(node=>node.textContent='long-history-file-name-'.repeat(30)+'.pdf');
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    for(const node of await historyCard.locator('strong,small').all()){
      assert.equal(await node.evaluate(element=>getComputedStyle(element).whiteSpace),'normal');
      assert.equal(await node.evaluate(element=>element.scrollWidth<=element.clientWidth+1),true);
    }
  }
  await historyCard.locator('strong').evaluate((node,text)=>node.textContent=text,originalHistory);
  console.log('History identity: named article and full long filename/status wrap at 3 widths.');

  const picker=page.locator('.file-picker-button.library input');
  const sendSelection=page.getByRole('button',{name:'この画像を再送する',exact:true});
  const sendHelp=page.locator('#submission-send-help');
  assert.equal(await sendSelection.getAttribute('aria-describedby'),'submission-send-help');
  assert.match(await sendHelp.innerText(),/写真・PDFを選んで/);assert.equal(await sendSelection.isDisabled(),true);

  const png=Buffer.from(imageUrl.split(',')[1],'base64');
  await picker.setInputFiles({name:'selected.png',mimeType:'image/png',buffer:png});
  const thumbnail=page.locator('.selected-file-preview img');
  await thumbnail.scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('.selected-file-preview img')?.naturalWidth>0);
  assert.equal(await thumbnail.getAttribute('loading'),'lazy');
  assert.equal(await thumbnail.getAttribute('decoding'),'async');
  const confirmSelection=page.locator('.submission-confirmation input');
  assert.match(await sendHelp.innerText(),/確認欄にチェック/);assert.equal(await sendSelection.isDisabled(),true);
  await confirmSelection.check();
  assert.match(await sendHelp.innerText(),/準備ができました/);assert.equal(await sendSelection.isEnabled(),true);

  await picker.setInputFiles({name:'unsupported.txt',mimeType:'text/plain',buffer:Buffer.from('invalid')});
  assert.equal(await page.locator('.selected-file-row').count(),1);
  assert.match(await page.locator('.selected-file-row').innerText(),/selected.png/);
  assert.equal(await confirmSelection.isChecked(),true);
  await picker.setInputFiles([]);
  assert.equal(await confirmSelection.isChecked(),true);
  await picker.setInputFiles({name:'replacement.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 fixture')});
  assert.match(await page.locator('.selected-file-row').innerText(),/replacement.pdf/);
  assert.match(await sendHelp.innerText(),/確認欄にチェック/);assert.equal(await sendSelection.isDisabled(),true);
  for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}

  assert.equal(await confirmSelection.isChecked(),false);
  assert.equal(await page.locator('.selected-file-preview img').count(),0);
  await page.getByRole('button',{name:'1件目のファイルを外す',exact:true}).click();
  assert.equal(await page.locator('.selected-file-row').count(),0);
  await page.locator('.bottom-nav').getByRole('button',{name:/シフト/}).click();
  assert.equal(await page.getByRole('heading',{name:'自分のシフト',exact:true}).evaluate(node=>document.activeElement===node),true,'Shift navigation focuses the heading before the refresh button.');
  await page.getByRole('button',{name:/報告書を提出/}).click();
  await page.waitForFunction(()=>{const input=document.querySelector('.file-picker-button.library input');return input?.multiple&&!input.disabled;});
  const repeatedName='same-name-'+('long-file-name-'.repeat(15))+'.pdf';
  const firstPdf=Buffer.from('%PDF-1.4 first'),secondPdf=Buffer.from('%PDF-1.4 second-longer');
  await picker.setInputFiles([{name:repeatedName,mimeType:'application/pdf',buffer:firstPdf},{name:repeatedName,mimeType:'application/pdf',buffer:secondPdf}]);
  await page.waitForFunction(()=>document.querySelectorAll('.selected-file-row').length===2);
  assert.equal(await page.getByRole('group',{name:'1件目: '+repeatedName,exact:true}).count(),1);assert.equal(await page.getByRole('group',{name:'2件目: '+repeatedName,exact:true}).count(),1);
  for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.locator('.file-copy span').first().evaluate(node=>getComputedStyle(node).whiteSpace),'normal');}
  await page.getByRole('button',{name:'2件目のファイルを外す',exact:true}).focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelectorAll('.selected-file-row').length===1);assert.equal(await page.locator('.file-copy small').innerText(),firstPdf.length+' B');
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='1件目のファイルを外す');
  await page.getByRole('button',{name:'1件目のファイルを外す',exact:true}).click();assert.equal(await page.locator('.selected-file-row').count(),0);
  await page.waitForFunction(()=>document.activeElement===document.querySelector('.file-picker-button.library input'));

  await picker.setInputFiles({name:'clear-all.pdf',mimeType:'application/pdf',buffer:firstPdf});
  page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'すべて解除',exact:true}).click();assert.equal(await page.locator('.selected-file-row').count(),1);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'すべて解除',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.selected-file-row').length===0&&document.activeElement===document.querySelector('.file-picker-button.library input'));
  console.log('Clear-all focus: cancel keeps file, confirmed cleanup restores enabled picker after async completion.');
  console.log('Selected file identity: two same-name PDFs use numbered groups/removal, long names wrap at 3 widths, keyboard removes only the selected item.');

  assert.deepEqual(errors,[]);
  console.log('Browser selection recovery passed: decoded lazy preview, rejected replacement retained, cancellation, PDF replacement, confirmation reset, and removal.');
  // 実画面の追加取得コントロールを使い、狭幅・処理中・失敗・再試行を確認する。
  await page.goto(`http://127.0.0.1:${port}/__upcoming_test.html`);
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});
    const button=page.getByRole('button',{name:'これからのシフトを続きを読み込む',exact:true});
    await button.waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  const more=page.getByRole('button',{name:'これからのシフトを続きを読み込む',exact:true});
  await more.focus();await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('button',{name:'読み込み中…',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'読み込み中…',exact:true}).getAttribute('aria-busy'),'true');
  await page.evaluate(()=>window.pagingControl.finish(false));
  await page.getByRole('alert').waitFor();await more.click();
  assert.equal(await page.evaluate(()=>window.pagingControl.calls),2);
  await page.evaluate(()=>window.pagingControl.finish(true));
  await more.waitFor({state:'detached'});
  assert.deepEqual(errors,[]);
  console.log('Upcoming controls passed: responsive widths, keyboard, busy lock, error and retry, final-page removal.');
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('.bottom-nav').getByRole('button',{name:/連絡/}).click();
  await page.evaluate(()=>{window.contactCopies=[];window.contactCopyFailure=false;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{if(window.contactCopyFailure)throw Error('denied');window.contactCopies.push(value);}}});});
  const email=await page.locator('.contact-details a[href^="mailto:"]').innerText(),phone=await page.locator('.contact-details a[href^="tel:"]').innerText();
  const contactShift=await page.getByLabel('連絡するシフト',{exact:true}).inputValue();
  assert.match(contactShift,/^勤務日：\d{4}-\d{2}-\d{2}\n/);assert.match(contactShift,/店舗：イオン船橋店/);assert.match(contactShift,/勤務時間：10:00〜18:00/);assert.equal(contactShift.split('\n').length,3);
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});
    for(const [label,value] of [['メールアドレス',email],['電話番号',phone],['シフト情報',contactShift]]){
      await page.getByRole('button',{name:label+'をコピー',exact:true}).focus();await page.keyboard.press('Enter');
      await page.getByText(label+'をコピーしました。',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.contactCopies.at(-1)),value);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await page.evaluate(()=>{window.originalContactClipboard=navigator.clipboard;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:value=>new Promise(resolve=>{window.contactCopies.push(value);window.finishContactCopy=resolve;})}});});
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});const copy=page.getByRole('button',{name:'シフト情報をコピー',exact:true});await copy.focus();await copy.press('Enter');
    await page.getByText('コピーしています。完了するまでお待ちください。',{exact:true}).waitFor();assert.equal(await copy.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'電話番号をコピー',exact:true}).isDisabled(),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.evaluate(()=>window.finishContactCopy());await page.getByText('シフト情報をコピーしました。',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('[aria-label="コピー状態"]')?.textContent==='');assert.equal(await copy.isEnabled(),true);
  }
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:window.originalContactClipboard}));
  await page.evaluate(()=>window.contactCopyFailure=true);
  await page.getByRole('button',{name:'メールアドレスをコピー',exact:true}).click();
  await page.getByText('コピーできませんでした。「連絡先を選択してコピー」を開き、必要な連絡先を選択してコピーしてください。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'メールアドレスをコピー',exact:true}).isEnabled(),true);
  console.log('Contact copy passed: synthetic clipboard, email/phone, 3 widths, keyboard and denied-copy recovery; no message or call sent.');
  await page.locator('.bottom-nav').getByRole('button',{name:/案件/}).click();
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});
    await page.getByRole('heading',{name:'募集中の案件',exact:true}).waitFor();
    assert.equal(await page.locator('.open-job').count(),1);
  assert.equal(await page.locator('.open-job [aria-label="報酬"]').innerText(),'10,000円');
    const refresh=page.getByRole('button',{name:'募集案件を更新',exact:true});
    await refresh.focus();await page.keyboard.press('Enter');
    await page.getByText('デモ：募集中の案件を確認しました。',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  console.log('Open jobs manual refresh: populated demo list, keyboard and 320/390/1280px passed.');
  const offer=page.getByRole('article',{name:/デモ募集店舗の募集案件/});
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});const toggle=offer.getByRole('button',{name:'詳細を見る',exact:true});
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');const detailId=await toggle.getAttribute('aria-controls');
    await toggle.focus();await page.keyboard.press('Enter');await offer.getByRole('button',{name:'詳細を閉じる',exact:true}).waitFor();
    assert.equal(await offer.getByRole('button',{name:'詳細を閉じる',exact:true}).getAttribute('aria-expanded'),'true');
    assert.equal(await page.evaluate(id=>Boolean(document.getElementById(id)),detailId),true);
    assert.match(await offer.locator('dl').innerText(),/実施日/);assert.match(await offer.locator('dl').innerText(),/勤務時間/);
    const originals=await offer.evaluate(card=>{const nodes=[...card.querySelectorAll('h3,p,dd')];const values=nodes.map(node=>node.textContent);nodes.forEach(node=>node.textContent='LongJobCondition'.repeat(40));return values;});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await offer.evaluate((card,values)=>[...card.querySelectorAll('h3,p,dd')].forEach((node,index)=>node.textContent=values[index]),originals);
    await offer.getByRole('button',{name:'詳細を閉じる',exact:true}).focus();await page.keyboard.press('Enter');
    await offer.getByRole('button',{name:'詳細を見る',exact:true}).waitFor();assert.equal(await offer.locator('dl').count(),0);
    assert.equal(await offer.getByRole('button',{name:'詳細を見る',exact:true}).evaluate(button=>button===document.activeElement),true);
    assert.equal(await page.locator('.open-job').count(),1);assert.equal(await page.getByText('デモ：応募を受け付けました。シフトで担当の確認状況を確認してください。',{exact:true}).count(),0);
  }
  console.log('Open job detail: named offer, keyboard expand/collapse and focus retained, controlled panel matches, long conditions fit 3 widths, no application from toggling.');

  await page.getByRole('button',{name:'この案件に応募する',exact:true}).click();
  await page.getByText('デモ：応募を受け付けました。シフトで担当の確認状況を確認してください。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'応募したシフトを確認',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'応募したシフトを確認',exact:true}).evaluate(node=>document.activeElement===node),true);

  assert.equal(await page.locator('.open-job').count(),0);
  await page.getByRole('button',{name:'募集案件を更新',exact:true}).click();
  assert.equal(await page.locator('.open-job').count(),0);
  await page.getByRole('button',{name:'応募したシフトを確認',exact:true}).click();
  assert.equal(await page.locator('.shift-card-button').count(),2);
  assert.equal(await page.getByRole('button',{name:/デモ募集店舗 .*のシフトを確認/}).getAttribute('aria-pressed'),'true');
  await page.getByRole('region',{name:'選択したシフトの詳細',exact:true}).getByRole('heading',{name:'デモ募集店舗',exact:true}).waitFor();
  console.log('Demo application passed: listing removed, refresh preserves acceptance, two shifts and assigned detail available.');
  for(const width of [320,390,1280])for(const fail of [false,true]){
    await page.setViewportSize({width,height:844});
    await page.getByRole('button',{name:/デモ募集店舗 .*のシフトを確認/}).click();
    if(await page.locator('.message-dismiss').count())await page.locator('.message-dismiss').click();
    const originalAddress=await page.locator('.shift-detail-heading p').innerText();
    await page.evaluate(fail=>{window.previousShiftClipboard=navigator.clipboard;window.shiftAddressCopies=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:value=>{window.shiftAddressCopies.push(value);return new Promise((resolve,reject)=>window.finishShiftAddressCopy=()=>fail?reject(Error('synthetic clipboard denial')):resolve());}}});},fail);
    await page.getByRole('button',{name:'住所をコピー',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'住所をコピー',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:/イオン船橋店 .*のシフトを確認/}).click();
    await page.getByRole('region',{name:'選択したシフトの詳細',exact:true}).getByRole('heading',{name:'イオン船橋店',exact:true}).waitFor();
    await page.evaluate(()=>window.finishShiftAddressCopy());
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='住所をコピー'&&!button.disabled));
    assert.deepEqual(await page.evaluate(()=>window.shiftAddressCopies),[originalAddress]);
    assert.equal(await page.getByText('店舗住所をコピーしました。',{exact:true}).count(),0);
    assert.equal(await page.getByText('コピーできませんでした。表示されている内容を選択してコピーしてください。',{exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:/イオン船橋店 .*のシフトを確認/}).getAttribute('aria-pressed'),'true');
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:window.previousShiftClipboard}));
  }
  await page.getByRole('button',{name:/デモ募集店舗 .*のシフトを確認/}).click();
  console.log('Shift address copy browser: 3 widths × delayed success/failure preserve the original copied text, suppress feedback after same-view shift changes and unlock controls.');

  await page.locator('.bottom-nav').getByRole('button',{name:/連絡/}).click();
  assert.match(await page.getByLabel('連絡するシフト',{exact:true}).inputValue(),/店舗：デモ募集店舗/);
  await page.getByRole('button',{name:'別のシフトを選ぶ',exact:true}).click();
  await page.getByRole('button',{name:/イオン船橋店 .*のシフトを確認/}).click();
  await page.locator('.bottom-nav').getByRole('button',{name:/連絡/}).click();
  assert.match(await page.getByLabel('連絡するシフト',{exact:true}).inputValue(),/店舗：イオン船橋店/);
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByRole('button',{name:'シフトを開く',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='選択したシフトの詳細');
  assert.equal(await page.getByRole('region',{name:'これからのシフト',exact:true}).count(),1);
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:844});
    const refresh=page.getByRole('button',{name:'シフトを更新',exact:true});
    await refresh.waitFor();

    await page.evaluate(()=>{window.addressCopies=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>window.addressCopies.push(value)}});});
    const addressText=await page.locator('.shift-detail-heading p').innerText();
    await page.getByRole('button',{name:'住所をコピー',exact:true}).focus();await page.keyboard.press('Enter');
    await page.getByText('店舗住所をコピーしました。',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.addressCopies.at(-1)),addressText);
    const originals=await page.locator('.shift-detail-heading').evaluate(heading=>{const nodes=[heading.querySelector('h2'),heading.querySelector('p')];const values=nodes.map(node=>node.textContent);nodes[0].textContent='店舗名'+('LongStoreName'.repeat(30));nodes[1].textContent='合成住所 '+('LongBuildingName'.repeat(40));return values;});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('.shift-detail-heading').evaluate((heading,values)=>{heading.querySelector('h2').textContent=values[0];heading.querySelector('p').textContent=values[1];},originals);
    console.log('Shift address: actual copy handler and keyboard match displayed address; synthetic long name/address stay within 3 viewport widths.');

    const card=page.locator('.shift-card-button').first();
    const cardOriginals=await card.evaluate(card=>{const nodes=[card.querySelector('.shift-card-store'),card.querySelector('.shift-card-time')];const values=nodes.map(node=>node.textContent);nodes[0].textContent='VeryLongStoreName'.repeat(40);nodes[1].textContent='10:00-18:00-'.repeat(50);return values;});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await card.evaluate(card=>{const bounds=card.getBoundingClientRect();return [...card.children].every(child=>child.getBoundingClientRect().right<=bounds.right+1);}),true);
    await card.evaluate((card,values)=>{card.querySelector('.shift-card-store').textContent=values[0];card.querySelector('.shift-card-time').textContent=values[1];},cardOriginals);
    const schedule=page.locator('.shift-detail dl[aria-label="勤務日時"]');
    assert.equal(await schedule.locator('dd').nth(0).innerText(),await page.locator('.shift-card-button.selected .date').innerText());
    assert.equal(await schedule.locator('dd').nth(1).innerText(),'10:00〜18:00');
    assert.equal(await page.locator('.shift-detail .prep-chip').first().innerText(),'発送準備中 / 印刷済み 0/1件');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await refresh.focus();await page.keyboard.press('Enter');
    await page.getByText('デモ：シフトを確認しました。実際の応募結果ではありません。',{exact:true}).waitFor();
  }
  console.log('Manual shift refresh button passed: real demo, 320/390/1280px and keyboard; no backend.');
  const temperatureInput=page.getByLabel('体温',{exact:true}),arrivalInput=page.getByLabel('到着予定時刻',{exact:true});
  for(const width of [320,390,1280])for(const invalid of ['0x24','3.6e1']){
    await page.setViewportSize({width,height:844});await arrivalInput.fill('09:45');await temperatureInput.fill(invalid);
    const send=page.getByRole('button',{name:'事前連絡を送信',exact:true});await send.focus();await page.keyboard.press('Enter');
    await page.getByText('体温は34〜42℃の数値で入力してください。',{exact:true}).waitFor();assert.equal(await temperatureInput.inputValue(),invalid);assert.equal(await arrivalInput.inputValue(),'09:45');assert.equal(await temperatureInput.getAttribute('aria-invalid'),'true');assert.equal(await temperatureInput.evaluate(node=>document.activeElement===node),true);
    assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),true);
    await temperatureInput.fill('36.5');assert.equal(await temperatureInput.getAttribute('aria-invalid'),'false');assert.equal(await page.locator('#precontact-input-error').count(),0);
    await page.locator('.bottom-nav').getByRole('button',{name:/ホーム/}).click();await page.locator('.bottom-nav').getByRole('button',{name:/シフト/}).click();
    await temperatureInput.waitFor();assert.equal(await temperatureInput.inputValue(),'36.5');assert.equal(await arrivalInput.inputValue(),'09:45');assert.equal(await send.isEnabled(),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  console.log('Precontact decimal recovery: 3 widths × hex/exponent rejection preserve input/time and draft; correction clears field error and survives home round-trip.');
  await temperatureInput.fill('');await page.getByRole('button',{name:'事前連絡を送信',exact:true}).click();
  await page.getByText('体温は34〜42℃の数値で入力してください。',{exact:true}).waitFor();
  assert.equal(await temperatureInput.evaluate(node=>document.activeElement===node),true);
  assert.equal(await temperatureInput.getAttribute("aria-invalid"),"true");assert.equal(await temperatureInput.getAttribute("aria-describedby"),"precontact-input-error");
  await temperatureInput.fill('36.5');assert.equal(await temperatureInput.getAttribute('aria-invalid'),'false');assert.equal(await page.locator('#precontact-input-error').count(),0);await arrivalInput.fill('');await page.getByRole('button',{name:'事前連絡を送信',exact:true}).click();
  await page.getByText('到着予定時刻を時:分で入力してください（例：09:30）。',{exact:true}).waitFor();
  assert.equal(await arrivalInput.evaluate(node=>document.activeElement===node),true);
  assert.equal(await arrivalInput.getAttribute("aria-invalid"),"true");assert.equal(await arrivalInput.getAttribute("aria-describedby"),"precontact-input-error");
  assert.equal(await temperatureInput.getAttribute('inputmode'),'decimal');assert.equal(await arrivalInput.getAttribute('type'),'time');
  await arrivalInput.fill('09:30');assert.equal(await arrivalInput.getAttribute('aria-invalid'),'false');assert.equal(await page.locator('#precontact-input-error').count(),0);await page.getByRole('button',{name:'事前連絡を送信',exact:true}).click();
  await page.getByText('デモ：事前連絡を送信しました。',{exact:true}).waitFor();
  const savedPrecontact=page.getByRole('status',{name:'登録済みの事前連絡',exact:true});
  await savedPrecontact.waitFor();assert.match(await savedPrecontact.innerText(),/体温 36.5℃ \/ 到着 09:30/);
  await temperatureInput.fill('36.6');assert.match(await savedPrecontact.innerText(),/体温 36.5℃/);
  await temperatureInput.fill('36.5');
  assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),false);
  for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  await page.locator('.bottom-nav').getByRole('button',{name:/ホーム/}).click();
  assert.equal(await page.getByText('事前連絡を送ってください',{exact:true}).count(),0);
  await page.locator('.bottom-nav').getByRole('button',{name:/案件/}).click();
  await page.getByRole('button',{name:'この案件に応募する',exact:true}).click();
  await page.getByRole('button',{name:'応募したシフトを確認',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.shift-detail input[inputmode="decimal"]')?.value==='');
  assert.equal(await page.getByLabel('体温',{exact:true}).inputValue(),'');
  await page.getByRole('button',{name:/イオン船橋店 .*のシフトを確認/}).click();
  await page.waitForFunction(()=>document.querySelector('.shift-detail input[inputmode="decimal"]')?.value==='36.5');
  assert.equal(await page.getByLabel('体温',{exact:true}).inputValue(),'36.5');
  assert.equal(await page.getByLabel('到着予定時刻',{exact:true}).inputValue(),'09:30');
  console.log('Precontact browser passed: empty temperature/time rejected, decimal keyboard/time input, valid demo submit.');
  await page.getByLabel('体温',{exact:true}).fill('36.7');
  await page.getByLabel('到着予定時刻',{exact:true}).fill('09:45');
  await page.getByRole('button',{name:/デモ募集店舗 .*のシフトを確認/}).click();
  await page.waitForFunction(()=>document.querySelector('.shift-detail input[inputmode="decimal"]')?.value==='');
  await page.getByRole('button',{name:/イオン船橋店 .*のシフトを確認/}).click();
  await page.waitForFunction(()=>document.querySelector('.shift-detail input[inputmode="decimal"]')?.value==='36.7');
  assert.equal(await page.getByLabel('到着予定時刻',{exact:true}).inputValue(),'09:45');
  const unsentExit=page.waitForEvent('dialog');
  await page.evaluate(()=>{setTimeout(()=>location.reload(),0);});
  const unsentDialog=await unsentExit;assert.equal(unsentDialog.type(),'beforeunload');await unsentDialog.dismiss();
  assert.equal(await page.getByLabel('体温',{exact:true}).inputValue(),'36.7');
  page.once('dialog',dialog=>dialog.dismiss());
  await page.getByRole('button',{name:'入力を登録内容に戻す',exact:true}).click();
  assert.equal(await page.getByLabel('体温',{exact:true}).inputValue(),'36.7');
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'入力を登録内容に戻す',exact:true}).click();
  assert.equal(await page.getByLabel('体温',{exact:true}).inputValue(),'36.5');
  assert.equal(await page.getByLabel('到着予定時刻',{exact:true}).inputValue(),'09:30');
  assert.equal(await page.getByRole('button',{name:'入力を登録内容に戻す',exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),false);

  assert.match(await page.getByRole('status',{name:'登録済みの事前連絡',exact:true}).innerText(),/体温 36.5℃/);

  await page.evaluate(()=>{window.printCopies=[];window.printCopyDenied=false;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:value=>{window.printCopies.push(value);if(window.printCopyDenied)return Promise.reject(Error('denied'));return new Promise(resolve=>window.finishPrintCopy=resolve);}}});});
  const printNumber=await page.locator('.netprint-row strong').first().innerText();
  const copyNumber=page.getByRole('button',{name:'ネットプリント番号 '+printNumber+' をコピー',exact:true});
  await copyNumber.evaluate(button=>{button.click();button.click();});assert.equal(await page.evaluate(()=>window.printCopies.length),1);assert.equal(await copyNumber.isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.printCopies[0]),printNumber);
  for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  assert.equal(await page.getByRole('button',{name:'印刷しました',exact:true}).isEnabled(),true);
  await page.evaluate(()=>window.finishPrintCopy());await page.getByText('ネットプリント番号 '+printNumber+'をコピーしました。',{exact:true}).waitFor();
  await page.evaluate(()=>window.printCopyDenied=true);await copyNumber.focus();await copyNumber.press('Enter');
  await page.getByText('コピーできませんでした。表示されている内容を選択してコピーしてください。',{exact:true}).waitFor();
  assert.equal(await copyNumber.isEnabled(),true);assert.equal(await page.getByRole('button',{name:'印刷しました',exact:true}).isEnabled(),true);
  assert.equal(await page.locator('.shift-detail .prep-chip').first().innerText(),'発送準備中 / 印刷済み 0/1件');
  console.log('Netprint copy: exact number, pending duplicate lock, 3 widths, keyboard denial recovery and unchanged print status; clipboard synthetic.');
  await page.getByRole('button',{name:'印刷しました',exact:true}).focus();await page.keyboard.press('Enter');
  await page.getByRole('button',{name:'印刷済み',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'印刷済み',exact:true}).evaluate(node=>document.activeElement===node),true,'Print completion keeps keyboard position');
  for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});await page.keyboard.press('Enter');assert.equal(await page.getByRole('button',{name:'印刷済み',exact:true}).evaluate(node=>document.activeElement===node),true);assert.equal(await page.locator('.shift-detail .prep-chip').first().innerText(),'発送準備中 / 印刷済み 1/1件');}
  console.log('Print completion retains keyboard focus and repeated Enter leaves completed state unchanged at 3 widths.');
  assert.equal(await copyNumber.isEnabled(),true);
  assert.equal(await page.locator('.shift-detail .prep-chip').first().innerText(),'発送準備中 / 印刷済み 1/1件');
  assert.equal(await page.locator('.shift-card-button.selected .prep-chip').innerText(),'発送準備中 / 印刷済み 1/1件');
  assert.equal(await page.getByRole('button',{name:'印刷済み',exact:true}).isDisabled(),true);
  await page.locator('.bottom-nav').getByRole('button',{name:/ホーム/}).click();
  assert.equal(await page.getByText('ネットプリントを印刷してください',{exact:true}).count(),0);
  await page.locator('.bottom-nav').getByRole('button',{name:/シフト/}).click();
  await page.getByRole('button',{name:/デモ募集店舗 .*のシフトを確認/}).click();
  await page.getByRole('button',{name:/イオン船橋店 .*のシフトを確認/}).click();
  await page.getByRole('button',{name:'印刷済み',exact:true}).waitFor();
  await page.goto(`http://127.0.0.1:${port}/shifts/demo_job_1/netprint`);
  await page.getByRole('region',{name:'選択したシフトの詳細'}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/');
  console.log('Shift notification browser passed: direct URL opens target shift and consumes path.');
  await page.goto(`http://127.0.0.1:${port}/resubmissions/demo_request`);
  await page.getByRole('button',{name:'提出情報を再読み込み',exact:true}).waitFor();
  await page.getByText('手ブレで文字が読めません',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/');
  await page.goto(`http://127.0.0.1:${port}/resubmissions/missing`);
  await page.getByText('この再提出依頼は終了済み、または対象の確定シフトを確認できません。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'通知の再提出依頼を再読込',exact:true}).waitFor();
  await page.getByRole('button',{name:'閉じる',exact:true}).click();assert.equal(new URL(page.url()).pathname,'/');
  console.log('Resubmission notification browser passed: request opens reason/submission, unknown request stays unavailable, close consumes URL.');




  console.log("Browser preview recovery, IndexedDB owner isolation/transaction abort recovery/50MB persistence, 320/390/1280px layout, enlarged text and keyboard recovery passed.");
} finally {
  await browser?.close();
  await server.close();
}

if(process.argv.includes("--browser")){const {verifyStaffOfflineNavigation}=await import("./test-staff-offline-navigation.mjs");await verifyStaffOfflineNavigation();}

if(process.argv.includes("--browser"))await import("./test-staff-day-rollover.mjs");
