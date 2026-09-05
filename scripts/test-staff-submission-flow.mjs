import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// No Firebase config, external accounts, mail, or cloud writes are used.
const app = readFileSync("apps/staff/src/App.tsx", "utf8");
function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Cannot locate ${start}`);
  return source.slice(from, to);
}
const handler = section(app, "  async function openTask(", "  async function pollSubmissionProcessing(");
const events = [];
const scope = {
  myJobs: [{ id: "assigned" }], authLoadVersionRef:{current:0}, isSubmissionActionPending:()=>false, isPending:()=>false, loadTaskJob:async()=>null,
  setMessage: () => events.push("error"), navigate: value => events.push(value),
  setSelectedJob: () => events.push("selected"),
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
for (const metadata of [{requestId:"request"},{type:"report"},{type:"unknown",requestId:"request"},{type:"report",requestId:42},{type:"sales_floor",requestId:"   "}]) {
  events.length = 0;
  await scope.openTask({jobId:"assigned",kind:"resubmission",metadata});
  assert.deepEqual(events,["error"]);
}
events.length = 0;
await scope.openTask({jobId:"missing",kind:"report"});
assert.deepEqual(events,["error","shifts"]);
for (const kind of ["precontact", "netprint"]) {
  events.length = 0;
  await scope.openTask({jobId:"assigned",kind});
  assert.deepEqual(events,["selected","shifts"]);
}

// Exercise the real async handlers with controlled responses, including responses
// arriving after the account or submission context changes.
const refreshHandler = section(app, "  async function refreshFilePreview(", "  async function loadResubmissionDetail(");
const previewFile = {id:"file",submissionId:"submission",previewUrl:"refreshed"};
for (const change of ["none", "account", "context"]) {
  let complete;
  const history = [];
  const refreshScope = {
    selectedJob:{id:"assigned"}, functions:{}, submissionType:"sales_floor",
    authLoadVersionRef:{current:1}, previewContextRef:{current:"assigned_sales_floor_normal"},
    httpsCallable:()=>()=>new Promise(resolve=>{complete=resolve;}),
    setSubmissionHistory:value=>history.push(value),
  };
  runInNewContext(ts.transpileModule(refreshHandler,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,refreshScope);
  const pending = refreshScope.refreshFilePreview(previewFile);
  if(change==="account")refreshScope.authLoadVersionRef.current++;
  if(change==="context")refreshScope.previewContextRef.current="other_report_normal";
  complete({data:{submissions:[{files:[previewFile]}]}});
  assert.equal(await pending,change==="none"?"refreshed":null);
  assert.equal(history.length,change==="none"?1:0);
}

const component = readFileSync("apps/staff/src/SubmissionPreviewImage.tsx","utf8");
const retryHandler = section(component,"  async function retryPreview()", "\n  if (!src)");
for (const result of ["success", "missing", "failure", "replaced", "unmounted"]) {
  let complete, fail, calls=0;
  const state = {src:null,loadState:"error",refreshing:false};
  const retryScope = {
    file:previewFile, refreshPending:{current:false}, refreshVersion:{current:1},
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
  else complete(result==="missing"?null:"refreshed");
  await pending;
  assert.equal(state.src,result==="success"?"refreshed":null);
  if(result!=="replaced"&&result!=="unmounted"){
    assert.equal(retryScope.refreshPending.current,false);
    assert.equal(state.refreshing,false);
    if(result!=="success")assert.equal(state.loadState,"error");
  }else assert.equal(state.refreshing,true,"Obsolete callbacks must not update the current component state.");
}

const moduleScope={exports:{},require:createRequire(import.meta.url)};
runInNewContext(ts.transpileModule(component,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,moduleScope);
const markup=renderToStaticMarkup(createElement(moduleScope.exports.default,{
  file:{...previewFile,originalName:"photo.png",driveName:"",contentType:"image/png",previewUrl:null},
  onRefreshPreview:async()=>null,
}));
assert.match(markup,/<button[^>]*>画像を再読み込み<\/button>/u,"A missing URL must expose a recovery action.");
console.log("Staff submission flow passed: 12 routing, 3 timeline isolation, 5 retry scenarios, and missing-URL recovery rendering.");
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
const server = await createServer({
  root:resolve("apps/staff"),configFile:resolve("apps/staff/vite.config.ts"),
  server:{host:"127.0.0.1",port:0},
  plugins:[{
    name:"submission-browser-fixture",
    configureServer(devServer){
      // SPAのフォールバックより先に検証用ページを配信する。
      devServer.middlewares.use(async(req,res,next)=>{
        if(req.url!=="/__preview_test.html")return next();
        try{
          res.setHeader("Content-Type","text/html");
          res.end(await devServer.transformIndexHtml(req.url,fixture));
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
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.route("**/*",route=>{
    const url=new URL(route.request().url());
    return url.hostname==="127.0.0.1"||url.protocol==="data:"?route.continue():route.abort();
  });
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
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
  const imageUrl="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  await page.evaluate(url=>window.previewControl.resolvers.shift()(url),imageUrl);
  await page.locator("img.loaded").waitFor();
  await page.evaluate(()=>window.previewControl.replace({id:"two",submissionId:"other",originalName:"other.png",driveName:"",contentType:"image/png",previewUrl:null}));
  await retry.click();
  await page.evaluate(()=>window.previewControl.replace({id:"three",submissionId:"next",originalName:"next.png",driveName:"",contentType:"image/png",previewUrl:null}));
  await retry.waitFor();
  await page.evaluate(url=>window.previewControl.resolvers.shift()(url),imageUrl);
  assert.equal(await page.locator("img").count(),0,"Old preview response must not populate the next file.");
  assert.equal(await retry.isEnabled(),true);
  assert.deepEqual(errors,[]);

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
    let staleSaveRejected=false;
    try{await store.saveDraft(key,[new File(['sent'],'sent.pdf')]);}catch{staleSaveRejected=true;}
    await store.clearDraft(key);
    await store.saveDraft(key,[new File(['new'],'new.pdf')]);
    const [next]=await store.loadDraft(key);
    const nextBody=await next.text();
    await store.clearDraft(key);
    return {durable,failed,current,restored,staleSaveRejected,nextBody};
  });
  assert.deepEqual(submittedDraft,{durable:true,failed:true,current:0,restored:0,staleSaveRejected:true,nextBody:'new'});
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
  console.log("Browser preview recovery, IndexedDB owner isolation/transaction abort recovery/50MB persistence, 320/390/1280px layout, enlarged text and keyboard recovery passed.");
} finally {
  await browser?.close();
  await server.close();
}
