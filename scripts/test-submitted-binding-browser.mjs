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
 uploadAndRetry:between('  async function uploadSubmission()','  async function loadSubmissionHistory('),
 hydration:between('  useEffect(()=>{\n    setSubmissionConfirmed(false);','  },[draftKey]);',true),
 draftSave:between('  const draftSavePaused=','  useEffect(()=>{ if(!pushEnabled)'),
 draftStore:fs.readFileSync('apps/staff/src/draft-store.ts','utf8'),
 attemptStore:fs.readFileSync('apps/staff/src/submission-attempt-store.ts','utf8'),
};
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const key=JSON.stringify(['v2',JSON.stringify(['synthetic-company','synthetic-owner']),'job','report','normal']);
const marker='lkc-submitted-draft:'+key,auxPrefix='lkc.submittedDraftBinding.v2:',receiptPrefix='lkc.submissionAttempt.v1:';
function runtime(source,old=false){
 const prefix=old?'/legacy':'';
 return compile(`
 import * as attemptStore from '${prefix}/attempt.js';
 import * as draftStore from '${prefix}/draft.js';
 import * as bindingStore from '/submitted-binding-store';
 import {runWithConcurrency} from '/concurrency.js';
 const {hasSubmittedBindings,saveSubmittedBinding,finishSubmittedBindings}=bindingStore;
 window.makeFixture=(key=${JSON.stringify(key)})=>{
  let files=[new File(['A'],'selected-A.png',{type:'image/png',lastModified:1})],draftCleanup=null,submissionConfirmed=true,pending=false,draftHydrating=false;
  const state={messages:[],processing:[],status:{}};let draftSaveCleanup;const previewContextRef={current:key};const setMessage=m=>state.messages.push(m);
  const draftKey=key,authLoadVersionRef={current:1},hydratedDraftKeyRef={current:''},draftHydratingRef={current:false},skipNextDraftSaveRef={current:false};
  const MAX_SUBMISSION_FILE_SIZE=50*1024*1024,UPLOAD_CONCURRENCY=2,selectedJob={id:'job'},myJobs=[selectedJob],requestId='',submissionType='report',firebaseConfigured=true,functions={},firebaseApp={};
  const loadSubmissionAttempt=async()=>attemptStore,submissionFileContentType=f=>f.type,fileStateKey=f=>f.name;
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
  return {uploadSubmission,retryDraftCleanup,hydrate,queueDraftSave,save:()=>saveDraft(draftKey,files),select:variant=>{files=[new File([variant],'selected-'+variant+'.png',{type:'image/png',lastModified:1})];submissionConfirmed=true;},snapshot:()=>({cleanup:draftCleanup,files:files.map(f=>f.name),confirmed:submissionConfirmed,draftHydrating,messages:state.messages,processing:state.processing}),switchAccount:()=>{authLoadVersionRef.current++;draftCleanup={key:'other-owner/job',durable:true};files=[new File(['other'],'other.png')];}};
 };
 window.draftStore=draftStore;window.attemptStore=attemptStore;window.bindingStore=bindingStore;window.ready=true;`);
}
const modules={
 '/fixture.js':runtime(current),'/legacy/fixture.js':runtime(legacy,true),
 '/draft.js':compile(current.draftStore),'/attempt.js':compile(current.attemptStore),
 '/legacy/draft.js':compile(legacy.draftStore),'/legacy/attempt.js':compile(legacy.attemptStore),
 '/submitted-binding-store':compile(fs.readFileSync('apps/staff/src/submitted-binding-store.ts','utf8')),
 '/submission-attempt-store':compile(current.attemptStore),
 '/concurrency.js':compile(fs.readFileSync('apps/staff/src/concurrency.ts','utf8')),
};
const server=createServer((req,res)=>{
 res.setHeader('Content-Type',modules[req.url]?'text/javascript':'text/html');
 res.end(modules[req.url]??`<!doctype html><meta charset="utf-8"><title>Synthetic receipt binding</title><script type="module" src="${req.url==='/legacy'?'/legacy':''}/fixture.js"></script>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,cases=[],errors=[],external=[];
let browser;
const storage=page=>page.evaluate(()=>Object.fromEntries(Object.entries(localStorage)));
const view=page=>page.evaluate(()=>f.snapshot());
const bindings=state=>Object.entries(state).filter(([k])=>k.startsWith(auxPrefix));
async function hydrate(page){await page.evaluate(()=>{window.f=makeFixture();f.hydrate();});await page.waitForFunction(()=>!f.snapshot().draftHydrating);}
async function reload(page){await page.reload();await page.waitForFunction(()=>window.ready);await hydrate(page);}
async function failReceiptRemoval(page){await page.evaluate(prefix=>{const remove=Storage.prototype.removeItem;window.restoreRemove=()=>Storage.prototype.removeItem=remove;Storage.prototype.removeItem=function(key){if(key.startsWith(prefix))throw new DOMException('Synthetic removal failure','SecurityError');return remove.call(this,key);};},receiptPrefix);}
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
  const context=await browser.newContext(),requests=[],uploads=[],accepted=new Map(),written=new Set();
  const control={pauseName:null,waiting:false,release:null};
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(route.request().url());return route.abort();});
  await context.exposeBinding('fixtureSession',async(_source,payload)=>{
   requests.push(payload);const id=accepted.get(payload.clientRequestId)??'synthetic-'+accepted.size;accepted.set(payload.clientRequestId,id);
   if(control.pauseName===payload.files[0].originalName){control.pauseName=null;control.waiting=true;await new Promise(resolve=>control.release=resolve);}
   return {data:{submissionId:id,clientRequestId:payload.clientRequestId,files:payload.files.map((_f,i)=>({storagePath:id+'/'+i,uploadRequired:!written.has(id+'/'+i)}))}};
  });
  await context.exposeBinding('fixtureUpload',(_source,{path})=>{assert.ok(!written.has(path),'No second upload of an accepted object');written.add(path);uploads.push(path);});
  const open=async(old=false)=>{const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+(old?'/legacy':''));await page.waitForFunction(()=>window.ready);return page;};
  try{await run({open,requests,uploads,control});cases.push(name);}finally{control.release?.();await context.close();}
 }

 await scenario('normal submission preserves legacy 1; four fields read back before cleanup; no retained record',async({open,requests,uploads})=>{
  const page=await open();await page.evaluate(async()=>{window.saved=[];const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){saved.push([k,v]);return set.call(this,k,v);};window.f=makeFixture();await f.save();await f.uploadSubmission();});
  const saved=await page.evaluate(()=>saved),entry=saved.find(([k])=>k.startsWith(auxPrefix));assert.ok(entry);
  assert.deepEqual(Object.keys(JSON.parse(entry[1])).sort(),['clientRequestId','draftScopeSha256','receiptStorageKey','version']);
  assert.deepEqual(saved.filter(([k])=>k===marker).map(([,v])=>v),['1']);
  assert.equal((await view(page)).cleanup,null);assert.deepEqual(await storage(page),{});assert.equal(requests.length,1);assert.equal(uploads.length,1);
 });

 for(const mode of ['aux-throw','aux-noop','aux-mismatch','marker-throw','marker-noop'])await scenario(mode+': save uncertainty retains receipt; current-session retry never resends',async({open,requests,uploads})=>{
  const page=await open();await page.evaluate(async({mode,auxPrefix,marker})=>{
   window.f=makeFixture();await f.save();const set=Storage.prototype.setItem;window.restoreSet=()=>Storage.prototype.setItem=set;
   Storage.prototype.setItem=function(k,v){if(mode.startsWith('aux')?k.startsWith(auxPrefix):k===marker){if(mode.endsWith('throw'))throw new DOMException('Synthetic write failure','QuotaExceededError');if(mode.endsWith('mismatch'))return set.call(this,k,'{}');return;}return set.call(this,k,v);};
   await f.uploadSubmission();
  },{mode,auxPrefix,marker});
  const pendingView=await view(page);assert.ok(pendingView.cleanup);assert.equal(pendingView.cleanup.attemptCleared,false);
  const receipt=pendingView.cleanup.attempt;assert.equal(JSON.parse((await storage(page))[receipt.storageKey]).clientRequestId,receipt.clientRequestId);
  await page.evaluate(()=>restoreSet());
  await page.evaluate(()=>f.retryDraftCleanup());
  if(mode==='aux-mismatch')assert.ok((await view(page)).cleanup,'Malformed durable metadata is not overwritten');
  else assert.equal((await view(page)).cleanup,null);
  assert.equal(requests.length,1);assert.equal(uploads.length,1);
 });

 for(const mode of ['missing','partial','wrong-owner','extra-field','expired-clock','retained-draft'])await scenario(mode+': actual reload retains guard and unknown shared records',async({open,requests,uploads})=>{
  const page=await open();await pending(page);
  await page.evaluate(({mode,auxPrefix,marker})=>{
   const k=Object.keys(localStorage).find(k=>k.startsWith(auxPrefix));const value=JSON.parse(localStorage.getItem(k));
   if(mode==='missing')localStorage.removeItem(k);
   if(mode==='partial')localStorage.setItem(k,'{');
   if(mode==='wrong-owner')localStorage.setItem(k,JSON.stringify({...value,draftScopeSha256:'a'.repeat(64)}));
   if(mode==='extra-field')localStorage.setItem(k,JSON.stringify({...value,unexpected:'synthetic'}));
   if(mode==='retained-draft')localStorage.removeItem(marker);
  },{mode,auxPrefix,marker});
  await reload(page);if(mode==='expired-clock')await page.clock.setFixedTime(new Date(Date.now()+31*86400000));
  const before=await storage(page);await page.evaluate(()=>f.retryDraftCleanup());assert.ok((await view(page)).cleanup?.unverified);
  assert.deepEqual(await storage(page),before);await page.evaluate(async()=>{f.select('A');await f.uploadSubmission();});
  assert.equal(requests.length,1);assert.equal(uploads.length,1);
 });

 await scenario('old A -> old B: auxiliary A never clears legacy B marker, draft or receipt',async({open,requests,uploads})=>{
  const page=await open();await pending(page);
  const old=await open(true);await old.evaluate(async()=>{window.f=makeFixture();await f.uploadSubmission();f.select('B');await f.save();});
  await failReceiptRemoval(old);await old.evaluate(()=>f.uploadSubmission());
  const before=await storage(page);assert.equal(before[marker],'1');assert.equal(bindings(before).length,1);
  const b=(await view(old)).cleanup.attempt;assert.equal(JSON.parse(before[b.storageKey]).clientRequestId,b.clientRequestId);
  await reload(page);await page.evaluate(()=>f.retryDraftCleanup());assert.ok((await view(page)).cleanup?.unverified);assert.deepEqual(await storage(page),before);
  assert.equal(await page.evaluate(async key=>{try{await draftStore.clearDraft(key);return false;}catch{return true;}},key),true);
  assert.equal(await page.evaluate(async key=>{try{await draftStore.saveDraft(key,[new File(['C'],'C.png')]);return false;}catch{return true;}},key),true);
  assert.deepEqual(await storage(page),before);assert.equal(requests.length,3);assert.equal(uploads.length,2);
 });

 for(const mode of ['debounced','save-failed'])await scenario(mode+': saved A / immediate B binds actual B, reload never infers identity from A',async({open,requests,uploads})=>{
  const page=await open();await page.evaluate(async mode=>{
   window.f=makeFixture();await f.save();f.hydrate();while(f.snapshot().draftHydrating)await new Promise(resolve=>setTimeout(resolve,0));
   f.queueDraftSave();f.select('B');
   if(mode==='save-failed'){
    const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(records,...args){if(records.some(record=>record.name==='selected-B.png'))throw new DOMException('Synthetic B save failure','QuotaExceededError');return put.call(this,records,...args);};
    await f.save().then(()=>{throw Error('Expected synthetic failure');},()=>{});
   }
   f.queueDraftSave();
  },mode);
  await failReceiptRemoval(page);await page.evaluate(async()=>{await f.uploadSubmission();await new Promise(resolve=>setTimeout(resolve,350));});
  const attempt=(await view(page)).cleanup.attempt,binding=JSON.parse(bindings(await storage(page))[0][1]);
  assert.equal(binding.clientRequestId,attempt.clientRequestId);assert.equal(binding.receiptStorageKey,attempt.storageKey);assert.equal(requests[0].files[0].originalName,'selected-B.png');
  const old=await open(true);await old.evaluate(()=>{window.f=makeFixture();f.hydrate();});await old.waitForFunction(()=>!f.snapshot().draftHydrating);
  assert.equal((await view(old)).files.length,0,'Legacy tab still understands literal 1');assert.ok((await view(old)).cleanup);
  assert.equal(await old.evaluate(async()=>{try{f.select('C');await f.save();return false;}catch{return true;}}),true);
  await reload(page);const before=await storage(page);await page.evaluate(()=>f.retryDraftCleanup());assert.ok((await view(page)).cleanup?.unverified);assert.deepEqual(await storage(page),before);
  assert.equal(requests.length,1);assert.equal(uploads.length,1);
 });

 await scenario('auxiliary disappears after receipt cleanup: same-session shared cleanup remains blocked',async({open,requests,uploads})=>{
  const page=await open();await pending(page);
  await page.evaluate(async auxPrefix=>{restoreRemove();const remove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(k){remove.call(this,k);if(k.startsWith('lkc.submissionAttempt.v1:'))for(const aux of Object.keys(localStorage).filter(k=>k.startsWith(auxPrefix)))remove.call(this,aux);};await f.retryDraftCleanup();},auxPrefix);
  assert.ok((await view(page)).cleanup);assert.equal((await storage(page))[marker],'1');assert.equal(await page.evaluate(key=>draftStore.hasStoredDraft(key),key),true);
  assert.equal(requests.length,1);assert.equal(uploads.length,1);
 });

 // Real legacy cleanup races with an already-started B upload. It removes the shared
 // marker/draft but cannot see B's auxiliary record. Only the latter is recoverable.
 async function boundedSetup({open,control}){
  const page=await open();await page.evaluate(async()=>{window.f=makeFixture();f.select('B');await f.save();});
  await failReceiptRemoval(page);control.pauseName='selected-B.png';await page.evaluate(()=>{window.upload=f.uploadSubmission();});
  for(let tries=0;!control.waiting&&tries<1000;tries++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(control.waiting,'Current B reached the synthetic API pause');
  const old=await open(true);await old.evaluate(async()=>{window.f=makeFixture();await f.save();});await failReceiptRemoval(old);await old.evaluate(()=>f.uploadSubmission());
  const a=(await view(old)).cleanup.attempt,locker=await open(true);await holdReceipt(locker,a.storageKey);
  await old.evaluate(()=>{restoreRemove();window.retry=f.retryDraftCleanup();});await old.waitForFunction(async()=> (await navigator.locks.query()).pending.length===1);
  control.release();await page.evaluate(()=>upload);const b=(await view(page)).cleanup.attempt;assert.ok((await view(page)).cleanup.bindingSaved);
  await locker.evaluate(()=>releaseLock());await old.evaluate(()=>retry);assert.equal((await view(old)).cleanup,null);
  assert.equal((await storage(page))[marker],undefined);assert.equal(await page.evaluate(key=>draftStore.hasStoredDraft(key),key),false);
  await reload(page);assert.ok((await view(page)).cleanup?.recovered);return {page,b,locker};
 }
 await scenario('actual old-tab race -> reload -> exact receipt/auxiliary cleanup -> intentional new B',async env=>{
  const {page,b}=await boundedSetup(env),beforeRequests=env.requests.length,beforeUploads=env.uploads.length;
  await page.evaluate(marker=>{const remove=Storage.prototype.removeItem,del=IDBObjectStore.prototype.delete,put=IDBObjectStore.prototype.put;window.restoreShared=()=>{Storage.prototype.removeItem=remove;IDBObjectStore.prototype.delete=del;IDBObjectStore.prototype.put=put;};Storage.prototype.removeItem=function(k){if(k===marker)throw Error('Recovered cleanup must not remove marker');return remove.call(this,k);};IDBObjectStore.prototype.delete=()=>{throw Error('Recovered cleanup must not delete draft');};IDBObjectStore.prototype.put=()=>{throw Error('Recovered cleanup must not save draft');};},marker);
  await page.evaluate(()=>f.retryDraftCleanup());assert.equal((await view(page)).cleanup,null);assert.deepEqual(await storage(page),{});
  assert.equal(env.requests.length,beforeRequests);assert.equal(env.uploads.length,beforeUploads);
  await page.evaluate(async()=>{restoreShared();f.select('B');await f.uploadSubmission();});assert.equal(env.requests.length,beforeRequests+1);assert.equal(env.uploads.length,beforeUploads+1);assert.notEqual(env.requests.at(-1).clientRequestId,b.clientRequestId);
 });

 for(const mode of ['newer-receipt','receipt-noop','aux-noop','account-switch','old-marker-reappears','other-owner'])await scenario(mode+': bounded recovery preserves newer/foreign/uncertain state',async env=>{
  const {page,b}=await boundedSetup(env),counts=[env.requests.length,env.uploads.length];
  if(mode==='newer-receipt')await page.evaluate(k=>localStorage.setItem(k,JSON.stringify({version:1,clientRequestId:crypto.randomUUID()})),b.storageKey);
  if(mode==='other-owner')await page.evaluate(async()=>{window.foreign=await attemptStore.prepareSubmissionAttempt('other-owner/job',[new File(['other'],'other.png')],['application/octet-stream']);draftStore.markDraftSubmitted('other-owner/job');if(!await bindingStore.saveSubmittedBinding('other-owner/job',foreign,()=>true))throw Error('Foreign setup failed');});
  if(['receipt-noop','aux-noop'].includes(mode))await page.evaluate(({mode,auxPrefix,k})=>{const remove=Storage.prototype.removeItem;window.restoreRemove=()=>Storage.prototype.removeItem=remove;Storage.prototype.removeItem=function(key){if(mode==='aux-noop'?key.startsWith(auxPrefix):key===k)return;return remove.call(this,key);};},{mode,auxPrefix,k:b.storageKey});
  const before=await storage(page);
  if(mode==='account-switch'||mode==='old-marker-reappears'){
   const holder=await env.open(true);await holdReceipt(holder,b.storageKey);await page.evaluate(()=>{window.retry=f.retryDraftCleanup();});await page.waitForFunction(async()=> (await navigator.locks.query()).pending.length===1);
   if(mode==='account-switch')await page.evaluate(()=>f.switchAccount());else await holder.evaluate(marker=>localStorage.setItem(marker,'1'),marker);
   await holder.evaluate(()=>releaseLock());await page.evaluate(()=>retry);
  }else await page.evaluate(()=>f.retryDraftCleanup());
  if(mode==='other-owner'){
   assert.equal((await view(page)).cleanup,null);const after=await storage(page);for(const [k,v] of Object.entries(before))if(k!==b.storageKey&&!bindings(before).some(([aux,raw])=>aux===k&&JSON.parse(raw).receiptStorageKey===b.storageKey))assert.equal(after[k],v);
  }else{
   assert.ok((await view(page)).cleanup);if(mode==='account-switch'){assert.equal((await view(page)).cleanup.key,'other-owner/job');assert.deepEqual((await view(page)).files,['other.png']);}
   if(mode!=='aux-noop')assert.equal((await storage(page))[b.storageKey],before[b.storageKey]);
   assert.equal(bindings(await storage(page)).length,1);
   if(mode==='aux-noop'){await page.evaluate(async()=>{restoreRemove();await f.retryDraftCleanup();});assert.equal((await view(page)).cleanup,null);}
  }
  assert.deepEqual([env.requests.length,env.uploads.length],counts);
 });
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 console.log(JSON.stringify({passed:true,cases,scope:'Actual current App handlers, hydration and stores; frozen 0be40aa legacy handlers/stores; real localStorage/IndexedDB/Web Locks; synthetic API/uploads only',limitation:'Only exact receipt and auxiliary cleanup is recoverable after reload when shared marker and draft are absent. Unknown shared state and malformed/missing evidence remain blocked. No forced old-tab update or automatic resend.'}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
