import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createServer} from 'node:http';
import ts from 'typescript';
import {chromium} from 'playwright';

const app=fs.readFileSync('apps/staff/src/App.tsx','utf8');
const start=app.indexOf('  async function uploadSubmission()');
const end=app.indexOf('  async function loadSubmissionHistory(',start);
const hydrationStart=app.indexOf('  useEffect(()=>{\n    setSubmissionConfirmed(false);');
const hydrationEnd=app.indexOf('  },[draftKey]);',hydrationStart)+17;
assert.ok(start>0&&end>start&&hydrationStart>0&&hydrationEnd>hydrationStart);
const saveStart=app.indexOf('  const draftSavePaused=');
const saveEnd=app.indexOf('  useEffect(()=>{ if(!pushEnabled)',saveStart);
assert.ok(saveStart>0&&saveEnd>saveStart);
const compile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const runtime=`import * as attemptStore from '/attempt.js';
import * as draftStore from '/draft.js';
import {runWithConcurrency} from '/concurrency.js';
window.makeFiles=()=>[new File(['one'],'one.png',{type:'image/png',lastModified:1}),new File(['two'],'two.pdf',{type:'application/pdf',lastModified:2})];
window.makeFixture=(key='company/user/job/report')=>{
 let files=window.makeFiles(),draftCleanup=null,submissionConfirmed=true,pending=false,draftHydrating=false;
 const state={messages:[],processing:[],status:{}};let draftSaveCleanup;const previewContextRef={current:key};const setMessage=m=>state.messages.push(m);
 const draftKey=key,authLoadVersionRef={current:1},hydratedDraftKeyRef={current:''},draftHydratingRef={current:false},skipNextDraftSaveRef={current:false};
 const MAX_SUBMISSION_FILE_SIZE=50*1024*1024,UPLOAD_CONCURRENCY=2,selectedJob={id:'job'},myJobs=[selectedJob],requestId='',submissionType='report',firebaseConfigured=true,functions={},firebaseApp={};
 const loadSubmissionAttempt=async()=>attemptStore,submissionFileContentType=f=>f.type,fileStateKey=f=>f.name;
 const isPending=()=>pending,isSubmissionActionPending=()=>pending;
 const setSubmissionConfirmed=v=>submissionConfirmed=v,setSubmissionMessage=()=>{},showSubmissionMessage=m=>state.messages.push(m);
 const setFiles=v=>files=v,setDraftCleanup=v=>draftCleanup=typeof v==='function'?v(draftCleanup):v,setDraftHydrating=v=>draftHydrating=v;
 const setUploadState=v=>state.status=typeof v==='function'?v(state.status):v;
 const {saveDraft,loadDraft,clearDraft,markDraftSubmitted,getSubmittedDraftReceipt}=draftStore;
 const pollSubmissionProcessing=async(...args)=>state.processing.push(args);
 const run=async(_key,fn,options)=>{pending=true;try{await fn();}catch(e){options?.setMessage?.(e.message);throw e;}finally{pending=false;}};
 const httpsCallable=(_api,name)=>{if(name!=='createUploadSession')throw Error('Unexpected synthetic API');return payload=>window.fixtureSession(payload);};
 const loadUploadStorage=async()=>({getClientStorage:()=>({}),ref:(_s,p)=>p,uploadBytesResumable:(path,file,metadata)=>({on:(_event,_progress,reject,resolve)=>{window.fixtureUpload({path,metadata}).then(resolve,reject);}})});
 ${app.slice(start,end)}
 function hydrate(){const useEffect=fn=>fn();${app.slice(hydrationStart,hydrationEnd)}}
 function queueDraftSave(){draftSaveCleanup?.();const selected=files;function render(){const files=selected;const useEffect=fn=>draftSaveCleanup=fn();${app.slice(saveStart,saveEnd)}}render();}
 return {uploadSubmission,retryDraftCleanup,hydrate,queueDraftSave,save:()=>saveDraft(draftKey,files),select:variant=>{files=variant?[new File([variant],'selected-'+variant+'.png',{type:'image/png'})]:window.makeFiles();submissionConfirmed=true;},snapshot:()=>({cleanup:draftCleanup,files:files.map(f=>f.name),confirmed:submissionConfirmed,draftHydrating,messages:state.messages,processing:state.processing}),switchAccount:()=>{authLoadVersionRef.current++;draftCleanup={key:'other-owner/job',durable:true};files=[new File(['other'],'other.png')];}};
};
window.draftStore=draftStore;window.attemptStore=attemptStore;window.ready=true;`;
const modules={'/fixture.js':compile(runtime),'/attempt.js':compile(fs.readFileSync('apps/staff/src/submission-attempt-store.ts','utf8')),'/draft.js':compile(fs.readFileSync('apps/staff/src/draft-store.ts','utf8')),'/concurrency.js':compile(fs.readFileSync('apps/staff/src/concurrency.ts','utf8'))};
const server=createServer((req,res)=>{res.setHeader('Content-Type',modules[req.url]?'text/javascript':'text/html');res.end(modules[req.url]??'<!doctype html><meta charset="utf-8"><title>Synthetic cleanup hydration</title><script type="module" src="/fixture.js"></script>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;const errors=[],external=[],receipts=new Map(),uploaded=new Set(),requests=[],writes=[];
try{
 browser=await chromium.launch({headless:true});
 const openContext=async()=>{
  const context=await browser.newContext();
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(route.request().url());return route.abort();});
  await context.exposeBinding('fixtureSession',(_source,payload)=>{requests.push(payload);const id=receipts.get(payload.clientRequestId)??'synthetic-'+receipts.size;receipts.set(payload.clientRequestId,id);return{data:{submissionId:id,clientRequestId:payload.clientRequestId,files:payload.files.map((_f,i)=>({storagePath:id+'/'+i,uploadRequired:!uploaded.has(id+'/'+i)}))}};});
  await context.exposeBinding('fixtureUpload',(_source,{path})=>{assert.equal(uploaded.has(path),false);writes.push(path);uploaded.add(path);});
  return context;
 };
 const cases=[];
 for(const mode of ['both-removals','marker-only','marker-noop','missing-original','account-switch','stale-saved','save-failed','stale-existing','same-session']){
  const context=await openContext(),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.waitForFunction(()=>window.ready);
  const beforeRequests=requests.length,beforeWrites=writes.length;
  await page.evaluate(async mode=>{
   window.f=window.makeFixture();await f.save();
   if(['stale-saved','save-failed','stale-existing'].includes(mode)){
    f.hydrate();while(f.snapshot().draftHydrating)await new Promise(resolve=>setTimeout(resolve,0));
    f.queueDraftSave();
    if(mode==='stale-existing')window.olderAttempt=await attemptStore.prepareSubmissionAttempt('company/user/job/report',makeFiles(),makeFiles().map(f=>f.type));
    f.select('B');
    if(mode==='save-failed'){
     const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...args){if(Array.isArray(value)&&value.some(v=>v.name==='selected-B.png'))throw new DOMException('Synthetic B save failure','QuotaExceededError');return put.call(this,value,...args);};
     await f.save().then(()=>{throw Error('Expected B save failure');},()=>{});
    }
    f.queueDraftSave();
   }
   const remove=Storage.prototype.removeItem;window.restoreRemove=()=>Storage.prototype.removeItem=remove;
   Storage.prototype.removeItem=function(key){
    if(key.startsWith('lkc-submitted-draft:')){if(mode==='marker-noop')return;throw new DOMException('Synthetic marker failure','SecurityError');}
    if(!['marker-only','marker-noop'].includes(mode)&&key.startsWith('lkc.'))throw new DOMException('Synthetic receipt failure','SecurityError');
    return remove.call(this,key);
   };
   await f.uploadSubmission();await new Promise(resolve=>setTimeout(resolve,350));
   if(mode==='missing-original')await new Promise((resolve,reject)=>{const open=indexedDB.open('lkc-submission-drafts',1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').delete('company/user/job/report');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
  },mode);
  assert.equal(requests.length,beforeRequests+1);const sentId=requests[beforeRequests].clientRequestId;
  const original=await page.evaluate(()=>f.snapshot().cleanup?.attempt);assert.ok(original);
  const submittedWrites=writes.length;
  if(mode==='same-session'){
   await page.evaluate(async()=>{restoreRemove();await f.retryDraftCleanup();});assert.equal((await page.evaluate(()=>f.snapshot())).cleanup,null);
   assert.equal(requests.length,beforeRequests+1);assert.equal(writes.length,submittedWrites);
   await page.evaluate(async()=>{f.select();await f.uploadSubmission();});assert.notEqual(requests[beforeRequests+1].clientRequestId,sentId);assert.equal(writes.length,beforeWrites+4);
   cases.push('known exact receipt in the current session: cleanup-only retry succeeds and intentional same-file submit gets a new receipt');
  }else if(mode==='account-switch'){
   await page.evaluate(()=>restoreRemove());
   const other=await page.evaluate(()=>attemptStore.prepareSubmissionAttempt('other-owner/job',makeFiles(),makeFiles().map(f=>f.type)));
   await page.evaluate(async key=>{window.held=navigator.locks.request(key,{mode:'exclusive'},async()=>{window.lockHeld=true;await new Promise(resolve=>window.releaseLock=resolve);});},original.storageKey);
   await page.waitForFunction(()=>window.lockHeld);await page.evaluate(()=>{window.retry=f.retryDraftCleanup();});await page.waitForFunction(async()=> (await navigator.locks.query()).pending.length===1);
   await page.evaluate(async()=>{f.switchAccount();releaseLock();await retry;});const view=await page.evaluate(()=>f.snapshot());assert.equal(view.cleanup.key,'other-owner/job');assert.deepEqual(view.files,['other.png']);
   for(const attempt of [other,original])assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).clientRequestId,attempt.storageKey),attempt.clientRequestId);
   assert.equal(requests.length,beforeRequests+1);assert.equal(writes.length,submittedWrites);
   cases.push('account switch while exact-receipt cleanup waits for the real Web Lock preserves both receipts and the newer view');
  }else{
   await page.reload();await page.waitForFunction(()=>window.ready);await page.evaluate(()=>{window.f=window.makeFixture();f.hydrate();});await page.waitForFunction(()=>!f.snapshot().draftHydrating);
   const before=await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage)));
   await page.evaluate(()=>f.retryDraftCleanup());const view=await page.evaluate(()=>f.snapshot());assert.ok(view.cleanup?.unverified);assert.equal(view.files.length,0);
   assert.deepEqual(await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage))),before,'Unknown identity cannot delete another receipt or its marker');
   await page.evaluate(async mode=>{f.select(['stale-saved','save-failed','stale-existing'].includes(mode)?'B':undefined);await f.uploadSubmission();},mode);
   assert.equal(requests.length,beforeRequests+1,'An unknown recovered identity cannot request another receipt');assert.equal(writes.length,submittedWrites,'Unknown cleanup cannot upload');
   assert.ok((await page.evaluate(()=>f.snapshot())).cleanup);
   cases.push(mode+': actual hydration keeps unknown identity blocked without deleting receipts, requesting or uploading');
  }
  await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 console.log(JSON.stringify({passed:true,cases,scope:'actual App upload, save debounce and hydration; real IndexedDB/localStorage/Web Locks; fresh local Chromium with synthetic API/Storage only',limitation:'The legacy submitted marker does not bind the sent files to their receipt. A reload without the exact in-memory identity remains unverified; this is a safety stop, not recovered submission acceptance.'}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
