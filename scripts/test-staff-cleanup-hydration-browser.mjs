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
const compile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const runtime=`import * as attemptStore from '/attempt.js';
import * as draftStore from '/draft.js';
import {runWithConcurrency} from '/concurrency.js';
window.makeFiles=()=>[new File(['one'],'one.png',{type:'image/png',lastModified:1}),new File(['two'],'two.pdf',{type:'application/pdf',lastModified:2})];
window.makeFixture=(key='company/user/job/report')=>{
 let files=window.makeFiles(),draftCleanup=null,submissionConfirmed=true,pending=false,draftHydrating=false;
 const state={messages:[],processing:[],status:{}};
 const draftKey=key,authLoadVersionRef={current:1},hydratedDraftKeyRef={current:''},draftHydratingRef={current:false},skipNextDraftSaveRef={current:false};
 const MAX_SUBMISSION_FILE_SIZE=50*1024*1024,UPLOAD_CONCURRENCY=2,selectedJob={id:'job'},myJobs=[selectedJob],requestId='',submissionType='report',firebaseConfigured=true,functions={},firebaseApp={};
 const loadSubmissionAttempt=async()=>attemptStore,submissionFileContentType=f=>f.type,fileStateKey=f=>f.name;
 const isPending=()=>pending,isSubmissionActionPending=()=>pending;
 const setSubmissionConfirmed=v=>submissionConfirmed=v,setSubmissionMessage=()=>{},showSubmissionMessage=m=>state.messages.push(m);
 const setFiles=v=>files=v,setDraftCleanup=v=>draftCleanup=typeof v==='function'?v(draftCleanup):v,setDraftHydrating=v=>draftHydrating=v;
 const setUploadState=v=>state.status=typeof v==='function'?v(state.status):v;
 const {saveDraft,loadDraft,clearDraft,markDraftSubmitted,getSubmittedDraftReceipt,loadSubmittedDraft}=draftStore;
 const pollSubmissionProcessing=async(...args)=>state.processing.push(args);
 const run=async(_key,fn,options)=>{pending=true;try{await fn();}catch(e){options?.setMessage?.(e.message);throw e;}finally{pending=false;}};
 const httpsCallable=(_api,name)=>{if(name!=='createUploadSession')throw Error('Unexpected synthetic API');return payload=>window.fixtureSession(payload);};
 const loadUploadStorage=async()=>({getClientStorage:()=>({}),ref:(_s,p)=>p,uploadBytesResumable:(path,file,metadata)=>({on:(_event,_progress,reject,resolve)=>{window.fixtureUpload({path,metadata}).then(resolve,reject);}})});
 ${app.slice(start,end)}
 function hydrate(){const useEffect=fn=>fn();${app.slice(hydrationStart,hydrationEnd)}}
 return {uploadSubmission,retryDraftCleanup,hydrate,save:()=>saveDraft(draftKey,files),select:()=>{files=window.makeFiles();submissionConfirmed=true;},snapshot:()=>({cleanup:draftCleanup,files:files.map(f=>f.name),confirmed:submissionConfirmed,draftHydrating,messages:state.messages,processing:state.processing}),switchAccount:()=>{authLoadVersionRef.current++;draftCleanup={key:'other-owner/job',durable:true};files=[new File(['other'],'other.png')];}};
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
 const context=await openContext();
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.waitForFunction(()=>window.ready);
 await page.evaluate(async()=>{window.f=window.makeFixture();await f.save();const remove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(key){if(key.startsWith('lkc.')||key.startsWith('lkc-submitted-draft:'))throw new DOMException('Synthetic cleanup failure','SecurityError');return remove.call(this,key);};await f.uploadSubmission();});
 assert.equal(requests.length,1);assert.equal(writes.length,2);const oldId=requests[0].clientRequestId;
 assert.ok((await page.evaluate(()=>f.snapshot())).cleanup);
 await page.reload();await page.waitForFunction(()=>window.ready);
 await page.evaluate(()=>{window.f=window.makeFixture();f.hydrate();});await page.waitForFunction(()=>!f.snapshot().draftHydrating);
 const hydrated=await page.evaluate(()=>f.snapshot());assert.ok(hydrated.cleanup);assert.equal(hydrated.files.length,0);
 await page.evaluate(()=>f.retryDraftCleanup());
 assert.equal(requests.length,1,'Cleanup never creates a server receipt');assert.equal(writes.length,2,'Cleanup never uploads');
 const recovered=await page.evaluate(()=>f.snapshot());assert.equal(recovered.cleanup,null,'Recovery confirms the exact original attempt before dismissing');
 await page.evaluate(async()=>{f.select();await f.uploadSubmission();});
 assert.equal(receipts.size,2,'A deliberate next submission after real hydration must not reuse the old server receipt');
 assert.notEqual(requests[1].clientRequestId,oldId);assert.equal(writes.length,4);
 await context.close();
 const cases=['both removals failed: reload recovers the exact receipt and permits a deliberate new submission'];
 for(const mode of ['marker-only','marker-noop','missing-original','account-switch']){
  const next=await openContext(),tab=await next.newPage();tab.on('pageerror',e=>errors.push(e.message));
  await tab.goto(origin);await tab.waitForFunction(()=>window.ready);
  if(mode==='marker-only'||mode==='marker-noop'){
   const beforeRequests=requests.length,beforeWrites=writes.length;
   await tab.evaluate(async mode=>{window.f=window.makeFixture();await f.save();const remove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(key){if(key.startsWith('lkc-submitted-draft:')){if(mode==='marker-noop')return;throw new DOMException('Synthetic marker failure','SecurityError');}return remove.call(this,key);};await f.uploadSubmission();},mode);
   assert.ok((await tab.evaluate(()=>f.snapshot())).cleanup);
   await tab.reload();await tab.waitForFunction(()=>window.ready);await tab.evaluate(()=>{window.f=window.makeFixture();f.hydrate();});await tab.waitForFunction(()=>!f.snapshot().draftHydrating);
   await tab.evaluate(()=>f.retryDraftCleanup());assert.equal((await tab.evaluate(()=>f.snapshot())).cleanup,null);
   assert.equal(requests.length,beforeRequests+1);assert.equal(writes.length,beforeWrites+2);
   await tab.evaluate(async()=>{f.select();await f.uploadSubmission();});
   assert.notEqual(requests[beforeRequests].clientRequestId,requests[beforeRequests+1].clientRequestId);assert.equal(writes.length,beforeWrites+4);
   cases.push(mode+': original draft remains recoverable; reload proves receipt absence without reserving another');
  }else{
   await tab.evaluate(async mode=>{
    window.f=window.makeFixture();await f.save();window.originalAttempt=await attemptStore.prepareSubmissionAttempt('company/user/job/report',makeFiles(),makeFiles().map(f=>f.type));draftStore.markDraftSubmitted('company/user/job/report');
    if(mode==='missing-original')await new Promise((resolve,reject)=>{const open=indexedDB.open('lkc-submission-drafts',1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').delete('company/user/job/report');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
   },mode);
   const original=await tab.evaluate(()=>originalAttempt),beforeRequests=requests.length,beforeWrites=writes.length;
   await tab.reload();await tab.waitForFunction(()=>window.ready);await tab.evaluate(()=>{window.f=window.makeFixture();f.hydrate();});await tab.waitForFunction(()=>!f.snapshot().draftHydrating);
   if(mode==='missing-original'){
    await tab.evaluate(()=>f.retryDraftCleanup());const blocked=await tab.evaluate(()=>f.snapshot());assert.ok(blocked.cleanup?.unverified);
    await tab.evaluate(async()=>{f.select();await f.uploadSubmission();});assert.ok((await tab.evaluate(()=>f.snapshot())).cleanup);
    cases.push('legacy marker without original files stays unverified and blocks a new send; no guessed receipt');
   }else{
    const other=await tab.evaluate(()=>attemptStore.prepareSubmissionAttempt('other-owner/job',makeFiles(),makeFiles().map(f=>f.type)));
    await tab.evaluate(async key=>{window.held=navigator.locks.request(key,{mode:'exclusive'},async()=>{window.lockHeld=true;await new Promise(resolve=>window.releaseLock=resolve);});},original.storageKey);
    await tab.waitForFunction(()=>window.lockHeld);await tab.evaluate(()=>{window.retry=f.retryDraftCleanup();});await tab.waitForFunction(async()=> (await navigator.locks.query()).pending.length===1);
    await tab.evaluate(async()=>{f.switchAccount();releaseLock();await retry;});const view=await tab.evaluate(()=>f.snapshot());assert.equal(view.cleanup.key,'other-owner/job');assert.deepEqual(view.files,['other.png']);
    assert.equal(await tab.evaluate(key=>JSON.parse(localStorage.getItem(key)).clientRequestId,other.storageKey),other.clientRequestId);
    cases.push('account switch while recovery waits for the real Web Lock preserves both owners and the newer view');
   }
   assert.equal(await tab.evaluate(key=>JSON.parse(localStorage.getItem(key)).clientRequestId,original.storageKey),original.clientRequestId);
   assert.equal(requests.length,beforeRequests);assert.equal(writes.length,beforeWrites);
  }
  await next.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 console.log(JSON.stringify({passed:true,cases,receipts:receipts.size,uploads:writes.length,scope:'fresh local Chromium; real IndexedDB/localStorage/Web Locks; actual App hydration and handlers; synthetic API/Storage bindings only'}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
