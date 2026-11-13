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
const runtime=`import * as attemptStore from '/cooperative-submission-store';
import * as draftStore from '/cooperative-submission-store';
import {getSubmittedDraftReceipt} from '/submitted-marker-store';
import {hasSubmittedBindings,saveSubmittedBinding,finishSubmittedBindings} from '/cooperative-submission-store';
import {SubmissionContextBusyError} from '/submission-context-error';
const loadDraftStore=()=>import('/cooperative-submission-store');
const loadSubmittedBindings=loadDraftStore;
import {runWithConcurrency} from '/concurrency.js';
window.makeFiles=()=>[new File(['one'],'one.png',{type:'image/png',lastModified:1}),new File(['two'],'two.pdf',{type:'application/pdf',lastModified:2})];
window.makeFixture=(key='company/user/job/report')=>{
 let files=window.makeFiles(),draftCleanup=null,submissionConfirmed=true,pending=false,draftHydrating=false;
 const state={messages:[],processing:[],status:{}};let draftSaveCleanup;const previewContextRef={current:key};const setMessage=m=>state.messages.push(m);
 const draftKey=key,authLoadVersionRef={current:1},hydratedDraftKeyRef={current:''},draftHydratingRef={current:false},skipNextDraftSaveRef={current:false};
 const MAX_SUBMISSION_FILE_SIZE=50*1024*1024,UPLOAD_CONCURRENCY=2,selectedJob={id:'job',dateKey:'2026-10-24',revision:0},myJobs=[selectedJob],requestId='',submissionType='report',firebaseConfigured=true,functions={},firebaseApp={};
 const loadSubmissionAttempt=async()=>attemptStore,submissionFileContentType=f=>f.type,fileStateKey=f=>f.name;
 const isPending=()=>pending,isSubmissionActionPending=()=>pending;
 const setSubmissionConfirmed=v=>submissionConfirmed=v,setSubmissionMessage=()=>{},showSubmissionMessage=m=>state.messages.push(m);
 const setFiles=v=>files=v,setDraftCleanup=v=>draftCleanup=typeof v==='function'?v(draftCleanup):v,setDraftHydrating=v=>draftHydrating=v;
 const setUploadState=v=>state.status=typeof v==='function'?v(state.status):v;
 const {saveDraft,loadDraft,clearDraft,markDraftSubmitted,hasStoredDraft,confirmDraftCleanupComplete}=draftStore;
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
const modules={'/submitted-marker-store':compile(fs.readFileSync('apps/staff/src/submitted-marker-store.ts','utf8')),'/submitted-binding-store':compile(fs.readFileSync('apps/staff/src/submitted-binding-store.ts','utf8')),'/submission-attempt-store':compile(fs.readFileSync('apps/staff/src/submission-attempt-store.ts','utf8')),'/fixture.js':compile(runtime),'/attempt.js':compile(fs.readFileSync('apps/staff/src/submission-attempt-store.ts','utf8')),'/draft.js':compile(fs.readFileSync('apps/staff/src/draft-store.ts','utf8')),'/concurrency.js':compile(fs.readFileSync('apps/staff/src/concurrency.ts','utf8'))};
for(const name of ['cooperative-submission-store','submission-context-lock','submission-context-error','submission-file-content-type','submission-namespace','draft-store'])modules['/'+name]=compile(fs.readFileSync('apps/staff/src/'+name+'.ts','utf8'));
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
    if(mode==='stale-existing')window.olderAttempt=await attemptStore.prepareSubmissionAttempt('company/user/job/report',makeFiles(),makeFiles().map(f=>f.type),()=>true,0,undefined,'2026-10-24');
    f.select('B');
    if(mode==='save-failed'){
     const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...args){if(Array.isArray(value)&&value.some(v=>v.name==='selected-B.png'))throw new DOMException('Synthetic B save failure','QuotaExceededError');return put.call(this,value,...args);};
     await f.save().then(()=>{throw Error('Expected B save failure');},()=>{});
    }
    f.queueDraftSave();
   }
   const remove=Storage.prototype.removeItem;window.restoreRemove=()=>Storage.prototype.removeItem=remove;
   Storage.prototype.removeItem=function(key){
    if(key.startsWith('lkc.submit.g2:submitted:')){if(mode==='marker-noop')return;throw new DOMException('Synthetic marker failure','SecurityError');}
    if(!['marker-only','marker-noop'].includes(mode)&&key.startsWith('lkc.'))throw new DOMException('Synthetic receipt failure','SecurityError');
    return remove.call(this,key);
   };
   await f.uploadSubmission();await new Promise(resolve=>setTimeout(resolve,350));
   if(mode==='missing-original')await new Promise((resolve,reject)=>{const open=indexedDB.open('lkc-submission-drafts-g2',1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').delete('company/user/job/report');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
  },mode);
  if(['save-failed','stale-existing'].includes(mode)){
   const state=await page.evaluate(()=>f.snapshot());assert.deepEqual(state.files,['selected-B.png']);assert.equal(state.cleanup,null);assert.equal(requests.length,beforeRequests);assert.equal(writes.length,beforeWrites);
   const retained=await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage)));
   await page.reload();await page.waitForFunction(()=>window.ready);await page.evaluate(()=>{window.f=makeFixture();f.hydrate();});await page.waitForFunction(()=>!f.snapshot().draftHydrating);
   assert.deepEqual((await page.evaluate(()=>f.snapshot())).files,['one.png','two.pdf']);assert.deepEqual(await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage))),retained);
   cases.push(mode+': actual immediate-submit flush rejects before acceptance, keeps B in UI and retains A/pending identity on disk');await context.close();continue;
  }
  assert.equal(requests.length,beforeRequests+1);const sentId=requests[beforeRequests].clientRequestId;
  const original=await page.evaluate(()=>f.snapshot().cleanup?.attempt);assert.ok(original);
  const submittedWrites=writes.length;
  if(mode==='same-session'){
   await page.evaluate(async()=>{restoreRemove();await f.retryDraftCleanup();});assert.equal((await page.evaluate(()=>f.snapshot())).cleanup,null);
   assert.equal(requests.length,beforeRequests+1);assert.equal(writes.length,submittedWrites);
   await page.evaluate(async()=>{f.select();await f.uploadSubmission();});assert.equal(requests.length,beforeRequests+2);assert.equal(writes.length,submittedWrites+2);
   assert.notEqual(requests.at(-1).clientRequestId,sentId);cases.push('same-session exact g2 identity permits cleanup and deliberate next submission without retransmitting the first');
  }else if(mode==='account-switch'){
   await page.evaluate(()=>restoreRemove());
   const other=await page.evaluate(()=>attemptStore.prepareSubmissionAttempt('other-owner/job',makeFiles(),makeFiles().map(f=>f.type),()=>true,0,undefined,'2026-10-24'));

   await page.evaluate(async()=>{const retry=f.retryDraftCleanup();f.switchAccount();await retry;});const view=await page.evaluate(()=>f.snapshot());assert.equal(view.cleanup.key,'other-owner/job');assert.deepEqual(view.files,['other.png']);
   for(const attempt of [other,original])assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).clientRequestId,attempt.storageKey),attempt.clientRequestId);
   assert.equal(requests.length,beforeRequests+1);assert.equal(writes.length,submittedWrites);
   cases.push('account switch during lazy cleanup entry preserves both receipts and the newer view');
  }else{
   await page.reload();await page.waitForFunction(()=>window.ready);await page.evaluate(()=>{window.f=window.makeFixture();f.hydrate();});await page.waitForFunction(()=>!f.snapshot().draftHydrating);
   const before=await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage)));assert.ok(Object.keys(before).some(k=>k.startsWith('lkc.submit.g2:binding.v2:')));
   await page.evaluate(()=>f.retryDraftCleanup());const view=await page.evaluate(()=>f.snapshot());assert.equal(view.cleanup,null);assert.equal(view.files.length,0);
   assert.deepEqual(await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage))),{});assert.equal(requests.length,beforeRequests+1);assert.equal(writes.length,submittedWrites);
   await page.evaluate(async mode=>{f.select(mode==='stale-saved'?'B':undefined);await f.uploadSubmission();},mode);
   assert.equal(requests.length,beforeRequests+2);assert.notEqual(requests.at(-1).clientRequestId,sentId);assert.equal(writes.length,submittedWrites+(mode==='stale-saved'?1:2));
   assert.equal((await page.evaluate(()=>f.snapshot())).cleanup,null);
   cases.push(mode+': actual hydration uses the stored exact g2 binding, cleans without transfer, then allows an intentional new ID');
  }
  await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 console.log(JSON.stringify({passed:true,cases,scope:'actual App upload, save debounce and hydration; real IndexedDB/localStorage/Web Locks; fresh local Chromium with synthetic API/Storage only',limitation:'Recovery is limited to exact g2 bindings under the common context lock. Missing/invalid evidence stays stopped; no legacy migration or real service acceptance.'}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
