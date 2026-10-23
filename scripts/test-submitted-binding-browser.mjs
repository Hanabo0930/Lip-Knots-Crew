import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createServer} from 'node:http';
import ts from 'typescript';
import {chromium} from 'playwright';

// Old tabs run frozen production code, not today's stores with a legacy label.
const legacy=JSON.parse(fs.readFileSync('scripts/fixtures/legacy-submitted-cleanup-0be40aa.json','utf8'));
assert.equal(legacy.sourceCommit,'0be40aa76609776a38bec97e841f1fa6a73ed8fb');
const app=fs.readFileSync('apps/staff/src/App.tsx','utf8');
function between(start,end,includeEnd=false){
 const a=app.indexOf(start),b=app.indexOf(end,a);assert.ok(a>=0&&b>a);
 return app.slice(a,b+(includeEnd?end.length:0));
}
const current={
 draftLoaders:between('const loadDraftStore=','const loadSubmittedBindings='),
 bindingLoaders:between('const loadSubmittedBindings=','import { submissionDraftKey }'),
 uploadAndRetry:between('  async function uploadSubmission()','  async function loadSubmissionHistory('),
 hydration:between('  useEffect(()=>{\n    setSubmissionConfirmed(false);','  },[draftKey]);',true),
 draftSave:between('  const draftSavePaused=','  useEffect(()=>{ if(!pushEnabled)'),
 draftStore:fs.readFileSync('apps/staff/src/draft-store.ts','utf8'),
 attemptStore:fs.readFileSync('apps/staff/src/submission-attempt-store.ts','utf8'),
};
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const key=JSON.stringify(['v2',JSON.stringify(['synthetic-company','synthetic-owner']),'job','report','normal']);
const marker='lkc.submit.g2:submitted:'+key,auxPrefix='lkc.submit.g2:binding.v2:',receiptPrefix='lkc.submit.g2:attempt.v1:';
const legacyMarker='lkc-submitted-draft:'+key,legacyReceiptPrefix='lkc.submissionAttempt.v1:';
function runtime(source,old=false){
 const prefix=old?'/legacy':'';
 return compile(`
 import * as attemptStore from '${old?'/legacy/attempt.js':'/cooperative-submission-store'}';
 ${old?"import * as draftStore from '/legacy/draft.js';":`import {getSubmittedDraftReceipt} from '/submitted-marker-store';
 ${source.draftLoaders}
 const draftStore={markDraftSubmitted,getSubmittedDraftReceipt,clearDraft,loadDraft,saveDraft,hasStoredDraft,confirmDraftCleanupComplete};`}
 import {runWithConcurrency} from '/concurrency.js';
  import {withSubmissionContext,SubmissionContextBusyError} from '/submission-context-lock';
 import {submissionFileContentType} from '/submission-file-content-type';
 ${old?'':source.bindingLoaders}
 const bindingStore={saveSubmittedBinding:async(...args)=>(await import('/submitted-binding-store')).saveSubmittedBinding(...args)};
 window.makeFixture=(key=${JSON.stringify(key)})=>{
  let files=[new File(['A'],'selected-A.png',{type:'image/png',lastModified:1})],draftCleanup=null,submissionConfirmed=true,pending=false,draftHydrating=false;
  const state={messages:[],processing:[],status:{}};let draftSaveCleanup;const previewContextRef={current:key};const setMessage=m=>state.messages.push(m);
  const draftKey=key,authLoadVersionRef={current:1},hydratedDraftKeyRef={current:''},draftHydratingRef={current:false},skipNextDraftSaveRef={current:false};
  const MAX_SUBMISSION_FILE_SIZE=50*1024*1024,UPLOAD_CONCURRENCY=2,selectedJob={id:'job',dateKey:'2026-10-24',revision:0},myJobs=[selectedJob],requestId='',submissionType='report',firebaseConfigured=true,functions={},firebaseApp={};
  const loadSubmissionAttempt=async()=>attemptStore,fileStateKey=f=>f.name;
  const isPending=()=>pending,isSubmissionActionPending=()=>pending;
  const setSubmissionConfirmed=v=>submissionConfirmed=v,setSubmissionMessage=()=>{},showSubmissionMessage=m=>state.messages.push(m);
  const setFiles=v=>files=v,setDraftCleanup=v=>draftCleanup=typeof v==='function'?v(draftCleanup):v,setDraftHydrating=v=>draftHydrating=v;
  const setUploadState=v=>state.status=typeof v==='function'?v(state.status):v;
  const {saveDraft,loadDraft,clearDraft,markDraftSubmitted,getSubmittedDraftReceipt,hasStoredDraft,confirmDraftCleanupComplete}=draftStore;
  const pollSubmissionProcessing=async(...args)=>state.processing.push(args);
  const run=async(_key,fn,options)=>{pending=true;try{await fn();}catch(e){options?.setMessage?.(e.message);throw e;}finally{pending=false;}};
  const httpsCallable=(_api,name)=>{if(name!=='createUploadSession')throw Error('Unexpected API');return payload=>window.fixtureSession(payload);};
  const loadUploadStorage=async()=>({getClientStorage:()=>({}),ref:(_s,p)=>p,uploadBytesResumable:(path,file,metadata)=>({on:(_event,_progress,reject,resolve)=>{window.fixtureUpload({path,metadata}).then(resolve,reject);}})});
  ${source.uploadAndRetry}
  function hydrate(){const useEffect=fn=>fn();${source.hydration}}
  function queueDraftSave(){draftSaveCleanup?.();const selected=files;function render(){const files=selected;const useEffect=fn=>draftSaveCleanup=fn();${source.draftSave}}render();}
  return {uploadSubmission,retryDraftCleanup,hydrate,queueDraftSave,save:()=>saveDraft(draftKey,files),select:variant=>{files=[new File([variant],'selected-'+variant+'.png',{type:'image/png',lastModified:1})];submissionConfirmed=true;},selectFile:(name,body,type)=>{files=[new File([body],name,{type,lastModified:1})];submissionConfirmed=true;},snapshot:()=>({cleanup:draftCleanup,files:files.map(f=>f.name),confirmed:submissionConfirmed,draftHydrating,messages:state.messages,processing:state.processing}),switchAccount:()=>{authLoadVersionRef.current++;draftCleanup={key:'other-owner/job',durable:true};files=[new File(['other'],'other.png')];}};
 };
 window.draftStore=draftStore;window.attemptStore=attemptStore;window.bindingStore=bindingStore;window.withSubmissionContext=withSubmissionContext;window.ready=true;`);
}
const modules={
 '/fixture.js':runtime(current),'/legacy/fixture.js':runtime(legacy,true),
 '/submitted-marker-store':compile(fs.readFileSync('apps/staff/src/submitted-marker-store.ts','utf8')),
 '/submission-context-error':compile(fs.readFileSync('apps/staff/src/submission-context-error.ts','utf8')),
 '/draft-store':compile(current.draftStore),
 '/draft.js':compile(current.draftStore),'/attempt.js':compile(current.attemptStore),
 '/legacy/draft.js':compile(legacy.draftStore),'/legacy/attempt.js':compile(legacy.attemptStore),
 '/submitted-binding-store':compile(fs.readFileSync('apps/staff/src/submitted-binding-store.ts','utf8')),
 '/submission-attempt-store':compile(current.attemptStore),
 '/concurrency.js':compile(fs.readFileSync('apps/staff/src/concurrency.ts','utf8')),
};
for(const name of ['cooperative-submission-store','submission-context-lock','submission-file-content-type','submission-namespace'])modules['/'+name]=compile(fs.readFileSync('apps/staff/src/'+name+'.ts','utf8'));
const serve=(req,res)=>{
 res.setHeader('Content-Type',modules[req.url]?'text/javascript':'text/html');
 res.end(modules[req.url]??`<!doctype html><meta charset="utf-8"><title>Synthetic receipt binding</title><script type="module" src="${req.url==='/legacy'?'/legacy':''}/fixture.js"></script>`);
};
const server=createServer(serve),legacyServer=createServer(serve);
await new Promise(resolve=>legacyServer.listen(0,'127.0.0.1',resolve));
const legacyOrigin=`http://127.0.0.1:${legacyServer.address().port}`;
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,cases=[],errors=[],external=[];
let browser;
const storage=page=>page.evaluate(()=>Object.fromEntries(Object.entries(localStorage)));
const view=page=>page.evaluate(()=>f.snapshot());
const bindings=state=>Object.entries(state).filter(([k])=>k.startsWith(auxPrefix));
async function hydrate(page){await page.evaluate(()=>{window.f=makeFixture();f.hydrate();});await page.waitForFunction(()=>!f.snapshot().draftHydrating);}
async function reload(page){await page.reload();await page.waitForFunction(()=>window.ready);await hydrate(page);}
async function failReceiptRemoval(page,prefix=receiptPrefix){await page.evaluate(prefix=>{const remove=Storage.prototype.removeItem;window.restoreRemove=()=>Storage.prototype.removeItem=remove;Storage.prototype.removeItem=function(key){if(key.startsWith(prefix))throw new DOMException('Synthetic removal failure','SecurityError');return remove.call(this,key);};},prefix);}
async function pending(page,variant='A'){
 await page.evaluate(async v=>{window.f=makeFixture();f.select(v);await f.save();},variant);
 await failReceiptRemoval(page);await page.evaluate(()=>f.uploadSubmission());
 assert.ok((await view(page)).cleanup?.bindingSaved);
 return (await view(page)).cleanup.attempt;
}
async function holdReceipt(page,storageKey){await page.evaluate(key=>{window.held=navigator.locks.request(key,{mode:'exclusive'},async()=>{window.lockHeld=true;await new Promise(resolve=>window.releaseLock=resolve);});},storageKey);await page.waitForFunction(()=>window.lockHeld);}
try{
 browser=await chromium.launch({headless:true});
 async function scenario(name,run){
  if(process.env.LKC_LOCAL_CASE_FILTER&&name!==process.env.LKC_LOCAL_CASE_FILTER)return;
  const context=await browser.newContext(),requests=[],uploads=[],accepted=new Map(),written=new Set();
   const control={pauseName:null,waiting:false,release:null,rejectSession:false,rejectUpload:false};
  await context.route('**/*',route=>{if([origin,legacyOrigin].includes(new URL(route.request().url()).origin))return route.continue();external.push(route.request().url());return route.abort();});
  await context.exposeBinding('fixtureSession',async(_source,payload)=>{
   requests.push(payload);const id=accepted.get(payload.clientRequestId)??'synthetic-'+accepted.size;accepted.set(payload.clientRequestId,id);
   if(control.pauseName===payload.files[0].originalName){control.pauseName=null;control.waiting=true;await new Promise(resolve=>control.release=resolve);}
    if(control.rejectSession){control.rejectSession=false;throw Error('Synthetic session response failure');}
   return {data:{submissionId:id,clientRequestId:payload.clientRequestId,files:payload.files.map((_f,i)=>({storagePath:id+'/'+i,uploadRequired:!written.has(id+'/'+i)}))}};
  });
   await context.exposeBinding('fixtureUpload',(_source,{path})=>{if(control.rejectUpload){control.rejectUpload=false;throw Error('Synthetic upload failure');}assert.ok(!written.has(path),'No second upload of an accepted object');written.add(path);uploads.push(path);});
  const open=async(old=false)=>{const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto((old?legacyOrigin:origin)+(old?'/legacy':''));await page.waitForFunction(()=>window.ready);return page;};
  try{await run({open,requests,uploads,control});cases.push(name);console.log(JSON.stringify({case:name,passed:true}));}finally{control.release?.();await context.close();}
 }

 await scenario('single tab: complete A then deliberate identical-file next submission',async({open,requests,uploads})=>{
 const page=await open();await page.evaluate(async()=>{window.f=makeFixture();await f.save();await f.uploadSubmission();});
 const first=await view(page);assert.equal(first.cleanup,null,JSON.stringify(first));assert.deepEqual(first.files,[]);assert.equal(first.processing.length,1);assert.deepEqual(await storage(page),{});
 await page.evaluate(async()=>{f.select('A');await f.uploadSubmission();});assert.equal((await view(page)).cleanup,null);assert.deepEqual(await storage(page),{});
 assert.equal(requests.length,2);assert.equal(uploads.length,2);assert.notEqual(requests[0].clientRequestId,requests[1].clientRequestId);
});
// ADDITIONAL_CASES
await scenario('busy initial hydration: explicit reread after prior success permits the next deliberate submission',async({open,control,requests,uploads})=>{
  const a=await open(),b=await open();await a.evaluate(async()=>{window.f=makeFixture();await f.save();});
  control.pauseName='selected-A.png';await a.evaluate(()=>{window.upload=f.uploadSubmission();});
  for(let i=0;!control.waiting&&i<1000;i++)await new Promise(r=>setTimeout(r,5));assert.ok(control.waiting);
  await hydrate(b);assert.ok((await view(b)).cleanup);const held=await storage(b);
  await b.evaluate(()=>f.retryDraftCleanup());assert.ok((await view(b)).cleanup);assert.deepEqual(await storage(b),held);assert.equal(requests.length,1);assert.equal(uploads.length,0);
  control.release();await a.evaluate(()=>upload);assert.equal((await view(a)).cleanup,null);assert.deepEqual(await storage(b),{});
  await b.evaluate(()=>f.retryDraftCleanup());
  const reread=await view(b);console.log(JSON.stringify({observation:'busy hydration after successful peer cleanup',cleanup:reread.cleanup,requests:requests.length,uploads:uploads.length}));
  assert.equal(reread.cleanup,null,'Busy hydration must recover by a read-only explicit retry after the peer finishes');
  assert.deepEqual(reread.files,[]);assert.equal(reread.confirmed,false);assert.equal(requests.length,1);assert.equal(uploads.length,1);
  await b.evaluate(async()=>{f.select('B');await f.uploadSubmission();});assert.equal((await view(b)).cleanup,null);assert.equal(requests.length,2);assert.equal(uploads.length,2);assert.notEqual(requests[0].clientRequestId,requests[1].clientRequestId);
});
for(const stage of ['session','upload'])await scenario('busy hydration after '+stage+' failure: reread preserves the pending receipt; only explicit submit resumes it',async({open,control,requests,uploads})=>{
  const a=await open(),b=await open();await a.evaluate(async()=>{window.f=makeFixture();await f.save();});
  control.pauseName='selected-A.png';control[stage==='session'?'rejectSession':'rejectUpload']=true;await a.evaluate(()=>{window.upload=f.uploadSubmission();});
  for(let i=0;!control.waiting&&i<1000;i++)await new Promise(r=>setTimeout(r,5));assert.ok(control.waiting);
  await hydrate(b);assert.equal((await view(b)).cleanup?.busy,true);control.release();await a.evaluate(()=>upload);
  const retained=await storage(b);assert.equal(Object.keys(retained).filter(k=>k.startsWith(receiptPrefix)).length,1);assert.equal(retained[marker],undefined);assert.equal(bindings(retained).length,0);
  assert.equal(requests.length,1);assert.equal(uploads.length,0);const id=requests[0].clientRequestId;
  await b.evaluate(()=>f.retryDraftCleanup());const reread=await view(b);assert.equal(reread.cleanup,null);assert.deepEqual(reread.files,['selected-A.png']);assert.equal(reread.confirmed,false);
  assert.deepEqual(await storage(b),retained);assert.equal(await b.evaluate(key=>draftStore.hasStoredDraft(key),key),true);assert.equal(requests.length,1);assert.equal(uploads.length,0);
  await b.evaluate(()=>f.uploadSubmission());assert.equal(requests.length,1,'Reread never grants submission confirmation');
  await b.evaluate(async()=>{f.select('A');await f.uploadSubmission();});assert.equal((await view(b)).cleanup,null);assert.equal(requests.length,2);assert.equal(requests[1].clientRequestId,id);assert.equal(uploads.length,1);
});
await scenario('busy hydration after incomplete cleanup: reread retains evidence until a separate explicit cleanup',async({open,control,requests,uploads})=>{
  const a=await open(),b=await open();await a.evaluate(async()=>{window.f=makeFixture();await f.save();});await failReceiptRemoval(a);
  control.pauseName='selected-A.png';await a.evaluate(()=>{window.upload=f.uploadSubmission();});
  for(let i=0;!control.waiting&&i<1000;i++)await new Promise(r=>setTimeout(r,5));assert.ok(control.waiting);
  await hydrate(b);assert.equal((await view(b)).cleanup?.busy,true);control.release();await a.evaluate(()=>upload);const retained=await storage(b);
  assert.equal(retained[marker],'1');assert.equal(bindings(retained).length,1);
  await b.evaluate(()=>f.retryDraftCleanup());assert.ok((await view(b)).cleanup);assert.notEqual((await view(b)).cleanup.busy,true);assert.deepEqual(await storage(b),retained);
  assert.equal(await b.evaluate(key=>draftStore.hasStoredDraft(key),key),true);await b.evaluate(async()=>{f.select('B');await f.uploadSubmission();});assert.equal(requests.length,1);assert.equal(uploads.length,1);
  await b.evaluate(()=>f.retryDraftCleanup());assert.equal((await view(b)).cleanup,null);assert.deepEqual(await storage(b),{});assert.equal(requests.length,1);assert.equal(uploads.length,1);
});
for(const mode of ['missing-binding','partial-binding','foreign-context','newer-receipt','invalid-marker'])await scenario('busy hydration with '+mode+': explicit reread cannot dismiss real uncertain evidence',async({open,control,requests,uploads})=>{
  const a=await open(),b=await open();await a.evaluate(async()=>{window.f=makeFixture();await f.save();});await failReceiptRemoval(a);
  control.pauseName='selected-A.png';await a.evaluate(()=>{window.upload=f.uploadSubmission();});
  for(let i=0;!control.waiting&&i<1000;i++)await new Promise(r=>setTimeout(r,5));assert.ok(control.waiting);
  await hydrate(b);assert.equal((await view(b)).cleanup?.busy,true);control.release();await a.evaluate(()=>upload);
  await b.evaluate(({mode,auxPrefix,receiptPrefix,marker})=>{
    const k=Object.keys(localStorage).find(k=>k.startsWith(auxPrefix)),raw=localStorage.getItem(k),value=JSON.parse(raw);
    if(mode==='missing-binding')localStorage.removeItem(k);
    if(mode==='partial-binding')localStorage.setItem(k,'{');
    if(mode==='foreign-context')localStorage.setItem(k,JSON.stringify({...value,draftScopeSha256:'f'.repeat(64)}));
    if(mode==='newer-receipt')localStorage.setItem(value.receiptStorageKey,JSON.stringify({version:1,clientRequestId:crypto.randomUUID()}));
    if(mode==='invalid-marker')localStorage.setItem(marker,'invalid');
  },{mode,auxPrefix,receiptPrefix,marker});
  const retained=await storage(b);await b.evaluate(()=>f.retryDraftCleanup());assert.ok((await view(b)).cleanup);assert.notEqual((await view(b)).cleanup.busy,true);assert.deepEqual(await storage(b),retained);
  await b.evaluate(()=>f.retryDraftCleanup());assert.ok((await view(b)).cleanup);assert.deepEqual(await storage(b),retained);assert.equal(await b.evaluate(key=>draftStore.hasStoredDraft(key),key),true);
  await b.evaluate(async()=>{f.select('B');await f.uploadSubmission();});assert.equal(requests.length,1);assert.equal(uploads.length,1);
});
await scenario('account switch during explicit busy reread cannot replace the new owner state or clear the old receipt',async({open,control,requests,uploads})=>{
  const a=await open(),b=await open();await a.evaluate(async()=>{window.f=makeFixture();await f.save();});
  control.pauseName='selected-A.png';control.rejectSession=true;await a.evaluate(()=>{window.upload=f.uploadSubmission();});
  for(let i=0;!control.waiting&&i<1000;i++)await new Promise(r=>setTimeout(r,5));assert.ok(control.waiting);
  await hydrate(b);control.release();await a.evaluate(()=>upload);const retained=await storage(b);
  await b.evaluate(()=>{const open=indexedDB.open.bind(indexedDB);let pause=true;indexedDB.open=(...args)=>{const req=open(...args);if(pause){pause=false;Object.defineProperty(req,'onsuccess',{configurable:true,set(fn){req.addEventListener('success',()=>{window.rereadPaused=true;window.releaseReread=()=>fn.call(req);});}});}return req;};window.retry=f.retryDraftCleanup();});
  await b.waitForFunction(()=>window.rereadPaused);await b.evaluate(async()=>{f.switchAccount();releaseReread();await retry;});
  assert.equal((await view(b)).cleanup.key,'other-owner/job');assert.deepEqual((await view(b)).files,['other.png']);assert.deepEqual(await storage(b),retained);assert.equal(requests.length,1);assert.equal(uploads.length,0);
});
await scenario('reload while request response is pending resumes the same receipt with one upload',async({open,control,requests,uploads})=>{
 const page=await open();await page.evaluate(async()=>{window.f=makeFixture();await f.save();});control.pauseName='selected-A.png';await page.evaluate(()=>{window.upload=f.uploadSubmission();});
 for(let i=0;!control.waiting&&i<1000;i++)await new Promise(r=>setTimeout(r,5));assert.ok(control.waiting);const originalId=requests[0].clientRequestId;
 await reload(page);assert.deepEqual((await view(page)).files,['selected-A.png']);await page.evaluate(async()=>{f.select('A');await f.uploadSubmission();});
 assert.equal((await view(page)).cleanup,null);assert.equal(requests.length,2);assert.equal(requests[1].clientRequestId,originalId);assert.equal(uploads.length,1);
 control.release();await page.waitForTimeout(20);assert.equal(uploads.length,1);assert.deepEqual(await storage(page),{});
});
await scenario('account switch during pending draft save rejects before IDB write',async({open,requests,uploads})=>{
 const page=await open();await page.evaluate(async key=>{
  window.f=makeFixture();await f.save();window.ownerCurrent=true;
  const open=indexedDB.open.bind(indexedDB);let pause=true;
  indexedDB.open=(...args)=>{const req=open(...args);if(pause){pause=false;Object.defineProperty(req,'onsuccess',{configurable:true,set(fn){req.addEventListener('success',()=>{window.savePaused=true;window.releaseSave=()=>fn.call(req);});}});}return req;};
  const store=await import('/cooperative-submission-store');window.pendingSave=store.saveDraft(key,[new File(['B'],'selected-B.png',{type:'image/png',lastModified:1})],()=>ownerCurrent).then(()=>true,()=>false);
 },key);
 await page.waitForFunction(()=>window.savePaused);assert.equal(await page.evaluate(async()=>{ownerCurrent=false;f.switchAccount();releaseSave();return await pendingSave;}),false);
 const names=await page.evaluate(async key=>(await draftStore.loadDraft(key)).map(f=>f.name),key);assert.deepEqual(names,['selected-A.png']);assert.deepEqual((await view(page)).files,['other.png']);
 assert.equal(requests.length,0);assert.equal(uploads.length,0);
});
await scenario('parallel current tabs: busy submit/save/discard never run later; explicit next intent succeeds',async({open,control,requests,uploads})=>{
 const a=await open(),b=await open();await a.evaluate(async()=>{window.f=makeFixture();await f.save();});await b.evaluate(()=>{window.f=makeFixture();});
 control.pauseName='selected-A.png';await a.evaluate(()=>{window.upload=f.uploadSubmission();});
 for(let i=0;!control.waiting&&i<1000;i++)await new Promise(r=>setTimeout(r,5));assert.ok(control.waiting);
 await b.evaluate(()=>f.uploadSubmission());assert.match((await view(b)).messages.at(-1),/別の画面/);assert.deepEqual((await view(b)).files,['selected-A.png']);
 assert.equal(await b.evaluate(async key=>{try{await draftStore.saveDraft(key,[new File(['B'],'B.png')]);return false;}catch{return true;}},key),true);
 assert.equal(await b.evaluate(async key=>{try{await draftStore.clearDraft(key);return false;}catch{return true;}},key),true);
 assert.equal(requests.length,1);control.release();await a.evaluate(()=>upload);await b.waitForTimeout(30);assert.equal(requests.length,1);assert.equal(uploads.length,1);
 await b.evaluate(async()=>{f.select('B');await f.uploadSubmission();});assert.equal((await view(b)).cleanup,null);assert.equal(requests.length,2);assert.equal(uploads.length,2);
});

async function pauseAutomaticRead(page){
 await page.evaluate(({auxPrefix,marker})=>{
  const open=indexedDB.open.bind(indexedDB);let pause=true;
  indexedDB.open=(...args)=>{const req=open(...args);if(pause&&localStorage.getItem(marker)==='1'&&Object.keys(localStorage).some(k=>k.startsWith(auxPrefix))){pause=false;Object.defineProperty(req,'onsuccess',{configurable:true,set(fn){req.addEventListener('success',()=>{window.autoReadPaused=true;window.releaseAutoRead=()=>fn.call(req);});}});}return req;};
 },{auxPrefix,marker});
}
await scenario('automatic cleanup await holds context: new current writer B cannot replace shared state',async({open,requests,uploads})=>{
 const a=await open(),b=await open();await a.evaluate(async()=>{window.f=makeFixture();await f.save();});await b.evaluate(()=>{window.f=makeFixture();f.select('B');});
 await pauseAutomaticRead(a);await a.evaluate(()=>{window.upload=f.uploadSubmission();});await a.waitForFunction(()=>window.autoReadPaused);
 const before=await storage(a);await b.evaluate(()=>f.uploadSubmission());assert.match((await view(b)).messages.at(-1),/別の画面/);
 assert.equal(await b.evaluate(async()=>{try{await f.save();return false;}catch{return true;}}),true);assert.deepEqual(await storage(a),before);
 await a.evaluate(async()=>{releaseAutoRead();await upload;});assert.equal((await view(a)).cleanup,null);assert.equal(requests.length,1);assert.equal(uploads.length,1);
 await b.evaluate(()=>f.uploadSubmission());assert.equal((await view(b)).cleanup,null);assert.equal(requests.length,2);assert.equal(uploads.length,2);
});

await scenario('actual 300ms save timer: immediate changed-file submit flushes B and never restores A after cleanup',async({open,requests,uploads})=>{
 const page=await open();await page.evaluate(async()=>{window.f=makeFixture();await f.save();f.hydrate();while(f.snapshot().draftHydrating)await new Promise(r=>setTimeout(r,0));f.queueDraftSave();f.select('B');f.queueDraftSave();await f.uploadSubmission();await new Promise(r=>setTimeout(r,350));});
 assert.equal((await view(page)).cleanup,null);assert.deepEqual(await storage(page),{});assert.equal(await page.evaluate(key=>draftStore.hasStoredDraft(key),key),false);
 assert.equal(requests[0].files[0].originalName,'selected-B.png');assert.equal(uploads.length,1);
});

for(const mode of ['receipt-throw','receipt-noop','marker-throw','marker-noop','aux-remove-throw','draft-delete-throw','draft-delete-abort','draft-delete-noop'])await scenario(mode+': reload cleans the exact completed receipt and draft without another API/upload',async({open,requests,uploads})=>{
 const page=await open();await page.evaluate(async({mode,marker,auxPrefix,receiptPrefix})=>{
  window.f=makeFixture();await f.save();const remove=Storage.prototype.removeItem,del=IDBObjectStore.prototype.delete,get=IDBObjectStore.prototype.get;
  Storage.prototype.removeItem=function(k){
   const match=mode.startsWith('receipt')?k.startsWith(receiptPrefix):mode.startsWith('marker')?k===marker:mode==='aux-remove-throw'?k.startsWith(auxPrefix):false;
   if(match){if(mode.endsWith('noop'))return;throw new DOMException('Synthetic remove failure','SecurityError');}return remove.call(this,k);
  };
  IDBObjectStore.prototype.delete=function(...args){if(mode==='draft-delete-throw')throw Error('Synthetic delete failure');if(mode==='draft-delete-noop')return get.apply(this,args);const result=del.apply(this,args);if(mode==='draft-delete-abort'){const tx=this.transaction;queueMicrotask(()=>tx.abort());}return result;};
  await f.uploadSubmission();
 },{mode,marker,auxPrefix,receiptPrefix});
 const pending=await view(page);assert.ok(pending.cleanup,mode);assert.equal(pending.processing.length,1);assert.deepEqual(pending.files,[]);assert.match(pending.messages.at(-1),/送信しました/);
 const count=[requests.length,uploads.length];assert.deepEqual(count,[1,1]);const id=requests[0].clientRequestId;
 await reload(page);await page.evaluate(()=>f.retryDraftCleanup());assert.equal((await view(page)).cleanup,null,mode+': '+JSON.stringify(await view(page)));
 assert.deepEqual(await storage(page),{});assert.equal(await page.evaluate(key=>draftStore.hasStoredDraft(key),key),false);assert.deepEqual([requests.length,uploads.length],count);
 await page.evaluate(async()=>{f.select('A');await f.uploadSubmission();});assert.equal((await view(page)).cleanup,null);assert.equal(requests.length,2);assert.notEqual(requests[1].clientRequestId,id);
});

await scenario('auxiliary write failure: same screen retains exact ID and recovers without retransmission',async({open,requests,uploads})=>{
 const page=await open();await page.evaluate(async prefix=>{window.f=makeFixture();await f.save();const set=Storage.prototype.setItem;window.restoreSet=()=>Storage.prototype.setItem=set;Storage.prototype.setItem=function(k,v){if(k.startsWith(prefix))throw Error('Synthetic full storage');return set.call(this,k,v);};await f.uploadSubmission();},auxPrefix);
 assert.ok((await view(page)).cleanup?.attempt);assert.equal(bindings(await storage(page)).length,0);await page.evaluate(async()=>{restoreSet();await f.retryDraftCleanup();});
 assert.equal((await view(page)).cleanup,null);assert.deepEqual(await storage(page),{});assert.equal(requests.length,1);assert.equal(uploads.length,1);
});

await scenario('saved A / B save failure: B stays visible and no receipt or upload starts',async({open,requests,uploads})=>{
 const page=await open();await page.evaluate(async()=>{window.f=makeFixture();await f.save();f.select('B');const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(rows,...args){if(rows.some(r=>r.name==='selected-B.png'))throw Error('Synthetic B save failure');return put.call(this,rows,...args);};await f.uploadSubmission();});
 assert.equal((await view(page)).cleanup,null);assert.deepEqual((await view(page)).files,['selected-B.png']);assert.match((await view(page)).messages.at(-1),/保存できません/);assert.deepEqual(await storage(page),{});
 assert.deepEqual(await page.evaluate(async key=>(await draftStore.loadDraft(key)).map(f=>f.name),key),['selected-A.png']);assert.equal(requests.length,0);assert.equal(uploads.length,0);
});

for(const mode of ['missing','partial','foreign-context','newer-receipt'])await scenario(mode+': invalid ownership stays stopped after reload',async({open,requests,uploads})=>{
 const page=await open();const attempt=await pending(page);await page.evaluate(({mode,auxPrefix,attempt})=>{
  const k=Object.keys(localStorage).find(k=>k.startsWith(auxPrefix)),value=JSON.parse(localStorage.getItem(k));
  if(mode==='missing')localStorage.removeItem(k);if(mode==='partial')localStorage.setItem(k,'{');if(mode==='foreign-context')localStorage.setItem(k,JSON.stringify({...value,draftScopeSha256:'f'.repeat(64)}));
  if(mode==='newer-receipt')localStorage.setItem(attempt.storageKey,JSON.stringify({version:1,clientRequestId:crypto.randomUUID()}));
 },{mode,auxPrefix,attempt});
 await reload(page);const before=await storage(page);await page.evaluate(()=>f.retryDraftCleanup());assert.ok((await view(page)).cleanup);assert.deepEqual(await storage(page),before);
 assert.equal(requests.length,1);assert.equal(uploads.length,1);
});

await scenario('account switch while API waits: no upload or mutation of new account UI',async({open,control,requests,uploads})=>{
 const page=await open();await page.evaluate(async()=>{window.f=makeFixture();await f.save();});control.pauseName='selected-A.png';await page.evaluate(()=>{window.upload=f.uploadSubmission();});
 for(let i=0;!control.waiting&&i<1000;i++)await new Promise(r=>setTimeout(r,5));assert.ok(control.waiting);
 await page.evaluate(()=>f.switchAccount());control.release();await page.evaluate(()=>upload);const result=await view(page);
 assert.equal(result.cleanup.key,'other-owner/job');assert.deepEqual(result.files,['other.png']);assert.equal(requests.length,1);assert.equal(uploads.length,0);
});

await scenario('account switch during automatic draft read preserves saved old data and new account view',async({open,requests,uploads})=>{
 const page=await open();await page.evaluate(async()=>{window.f=makeFixture();await f.save();});await pauseAutomaticRead(page);
 await page.evaluate(()=>{window.upload=f.uploadSubmission();});await page.waitForFunction(()=>window.autoReadPaused);const before=await storage(page);
 await page.evaluate(async()=>{f.switchAccount();releaseAutoRead();await upload;});const result=await view(page);
 assert.equal(result.cleanup.key,'other-owner/job');assert.deepEqual(result.files,['other.png']);assert.deepEqual(await storage(page),before);
 assert.equal(await page.evaluate(key=>draftStore.hasStoredDraft(key),key),true);assert.equal(requests.length,1);assert.equal(uploads.length,1);
});

await scenario('unknown or expired lock capability cannot write a different context',async({open,requests,uploads})=>{
 const page=await open();const result=await page.evaluate(async key=>{
  let expired;await withSubmissionContext(key,()=>true,lease=>{expired=lease;});
  const store=await import('/cooperative-submission-store');const files=[new File(['X'],'x.png')];
  const rejected=[];for(const [k,lease] of [[key,expired],['foreign',expired],[key,{key}]]){try{await store.saveDraft(k,files,()=>true,lease);rejected.push(false);}catch{rejected.push(true);}}
  return rejected;
 },key);assert.deepEqual(result,[true,true,true]);assert.deepEqual(await storage(page),{});assert.equal(requests.length,0);assert.equal(uploads.length,0);
});

await scenario('same-origin context separation: another owner can proceed while A holds its lock',async({open,control,requests,uploads})=>{
 const a=await open(),b=await open();await a.evaluate(()=>{window.f=makeFixture();});control.pauseName='selected-A.png';await a.evaluate(()=>{window.upload=f.uploadSubmission();});
 for(let i=0;!control.waiting&&i<1000;i++)await new Promise(r=>setTimeout(r,5));assert.ok(control.waiting);
 await b.evaluate(async()=>{window.f=makeFixture(JSON.stringify(['v2',JSON.stringify(['synthetic-company','other-owner']),'job','report','normal']));f.select('B');await f.uploadSubmission();});
 assert.equal((await view(b)).cleanup,null);control.release();await a.evaluate(()=>upload);assert.equal((await view(a)).cleanup,null);assert.equal(requests.length,2);assert.equal(uploads.length,2);
});

await scenario('legacy separate origin: A cleanup cannot erase old-tab B records',async({open,requests,uploads})=>{
 const page=await open(),old=await open(true);await page.evaluate(async()=>{window.f=makeFixture();await f.save();});await pauseAutomaticRead(page);
 await page.evaluate(()=>{window.upload=f.uploadSubmission();});await page.waitForFunction(()=>window.autoReadPaused);
 await old.evaluate(async()=>{window.f=makeFixture();f.select('B');await f.save();});await failReceiptRemoval(old,legacyReceiptPrefix);await old.evaluate(()=>f.uploadSubmission());const before=await storage(old);
 assert.equal(before[legacyMarker],'1');await page.evaluate(async()=>{releaseAutoRead();await upload;});assert.equal((await view(page)).cleanup,null);assert.deepEqual(await storage(old),before);
 assert.equal(requests.length,2);assert.equal(uploads.length,2);
});

await scenario('documented boundary: separate origins still create separate backend operations for identical files',async({open,requests,uploads})=>{
 const page=await open(),old=await open(true);for(const p of [page,old])await p.evaluate(async()=>{window.f=makeFixture();await f.save();await f.uploadSubmission();});
 assert.equal(requests.length,2);assert.notEqual(requests[0].clientRequestId,requests[1].clientRequestId);assert.equal(uploads.length,2);
 console.log(JSON.stringify({residualRisk:'Distinct origins have distinct receipt UUIDs; common mock backend accepts both identical-file operations. Not a cross-origin duplicate-prevention claim.'}));
});
await scenario('legacy same-origin writer cannot touch g2 draft even though it ignores the new lock',async({open,requests,uploads})=>{
 const a=await open(),b=await open(true);await b.goto(new URL('/legacy',a.url()).href);await b.waitForFunction(()=>window.ready);
 await a.evaluate(async()=>{window.f=makeFixture();await f.save();});
 await a.evaluate(key=>{window.holding=withSubmissionContext(key,()=>true,async()=>{window.contextHeld=true;await new Promise(resolve=>window.releaseContext=resolve);});},key);
 await a.waitForFunction(()=>window.contextHeld);
 try{
  await b.evaluate(async()=>{window.f=makeFixture();f.select('B');await f.save();});
  const saved=await b.evaluate(async key=>(await draftStore.loadDraft(key)).map(f=>f.name),key);
  assert.deepEqual(saved,['selected-B.png']);assert.equal(requests.length,0);assert.equal(uploads.length,0);
  const current=await a.evaluate(async key=>(await (await import('/draft-store')).readStoredDraftFiles(key)).map(f=>f.name),key);assert.deepEqual(current,['selected-A.png']);console.log(JSON.stringify({isolation:'Frozen legacy save is restricted to its old database; g2 draft remains A.',legacy:saved,current}));
 }finally{await a.evaluate(async()=>{releaseContext();await holding;});}
});

assert.ok(cases.length>0,'A test filter must select an actual case');assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
console.log(JSON.stringify({passed:true,total:cases.length,cases,scope:'isolated local origins; actual candidate App handler/effect and stores; mock API/Storage only; not full React/Auth/backend E2E'}));
}finally{await browser?.close();await Promise.all([server,legacyServer].map(s=>new Promise(resolve=>s.close(resolve))));}
