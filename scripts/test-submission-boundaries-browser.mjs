import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {fixturePortsPlugin,syntheticPorts} from './full-react-fixture.mjs';
import {legacyStorePlugin,legacySourceCommit} from './namespace-legacy-fixture.mjs';
import {candidateIdentity} from './verification-candidate.mjs';
import {makeBoundaryBackend,boundarySourceEvidence} from './submission-boundary-guard-fixture.mjs';
const root=resolve(import.meta.dirname,'..'),phase=process.argv[2]??'observation';
assert.match(phase,/^[a-z0-9-]+$/);
const {chromium}=await import('playwright');
const originalReturn='return {data:await window.__mockApi({name,payload,uid:auth.currentUser?.uid})};';
assert.equal(syntheticPorts.split(originalReturn).length,2);
const source=syntheticPorts.replace(originalReturn,`const data=await window.__mockApi({name,payload,uid:auth.currentUser?.uid});if(data?.__fixtureError){const error=new Error(data.__fixtureError.message);Object.assign(error,data.__fixtureError);throw error;}return {data};`)+
 `\nObject.assign(job,{dateKey:'2026-10-24',revision:1});window.__fixture.patchJob=patch=>Object.assign(job,patch);`;
const plugin=fixturePortsPlugin();
const server=await createServer({root:resolve(root,'apps/staff'),configFile:false,envDir:false,plugins:[legacyStorePlugin(),{...plugin,load(id){return plugin.load(id)?source:undefined;}},react()],
 cacheDir:resolve(root,'.vite-boundary-test'),server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['react','react-dom/client','react/jsx-dev-runtime'],exclude:['firebase']}});
await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({headless:true}),results=[],external=[],errors=[];
const file={name:'synthetic-boundary.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nSynthetic boundary only\n%%EOF')};
const poll=async(fn,label)=>{const end=Date.now()+8000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error(label);};
const send=p=>p.getByRole('button',{name:'報告書を送信する',exact:true});
const receipt=p=>p.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('lkc.submit.g2:attempt.v1:'))));
const refresh=async p=>{await p.getByRole('button',{name:'提出情報を再読み込み',exact:true}).click();await poll(()=>p.getByRole('button',{name:'提出情報を再読み込み',exact:true}).isEnabled(),'refresh pending');};
async function scenario(name,run){
 if(process.env.LKC_TEST_FILTER&&!new RegExp(process.env.LKC_TEST_FILTER).test(name))return;
 const context=await browser.newContext({serviceWorkers:'block'});context.setDefaultTimeout(8000);const backend=makeBoundaryBackend();
 // Pin synthetic calendar data while preserving normal timers and elapsed time.
 await context.addInitScript(()=>{const NativeDate=Date,start=NativeDate.now(),fixed=NativeDate.parse('2026-10-23T03:00:00Z');globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[fixed+NativeDate.now()-start]));}static now(){return fixed+NativeDate.now()-start;}};});
 await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith(origin+'/'))return route.continue();external.push(url.split('?')[0]);return route.abort('blockedbyclient');});
 await context.exposeFunction('__mockApi',async({name,payload})=>{
  switch(name){case 'bootstrapSession':return {refreshToken:false};case 'getMyTasks':return {tasks:[]};case 'registerDeviceSession':return {sessionId:'synthetic-device'};case 'heartbeatDeviceSession':return {};case 'getSubmissionTimeline':return backend.timeline();case 'createUploadSession':return backend.create(payload);case 'getSubmissionProcessingStatus':return {status:'completed',completedFiles:1,totalFiles:1,errorMessage:null};default:throw Error('Unexpected mock API '+name);}
 });
 await context.exposeFunction('__mockUpload',backend.upload);const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));
 const evidence={};
 try{
  await p.goto(origin);await p.locator('.bottom-nav').getByRole('button',{name:/提出/}).click();await p.locator('.submission-confirmation input').waitFor();await poll(()=>p.locator('.file-picker-button.library input').isEnabled(),'initial hydration');
  await p.locator('.file-picker-button.library input').setInputFiles(file);await p.locator('.submission-confirmation input').check();
  await run({p,backend,evidence,context});results.push({name,passed:true,evidence,requests:backend.requests.length,uploads:backend.uploads.length});console.log('PASS '+name);
 }catch(error){results.push({name,passed:false,error:error.message,evidence,requests:backend.requests.length,uploads:backend.uploads.length});console.log('FAIL '+name+': '+error.message);}
 finally{await context.close();}
}
async function settled(p){await poll(()=>send(p).isEnabled(),'submission did not settle');}
async function rejectedRetained(p,before,backend,evidence){
 await settled(p);assert.equal(await p.getByRole('button',{name:/件目のファイルを外す/}).count(),1);assert.deepEqual(await receipt(p),before);
 evidence.message=await p.locator('.submission-message').innerText();evidence.messageClass=await p.locator('.submission-message').getAttribute('class');
 evidence.role=await p.locator('.submission-message').getAttribute('role');evidence.backendReject=backend.rejections.at(-1);evidence.retainedReceipt=true;evidence.fileRetained=true;
}
try{
 for(const change of ['date','revision','assigned-staff','job-id'])await scenario('accepted waiting_upload then '+change+' change: same receipt rejected, files retained, error shown',async({p,backend,evidence})=>{
  backend.loseNextResponse=true;await send(p).click();await settled(p);const before=await receipt(p);assert.equal(backend.parents.size,1);assert.equal(backend.uploads.length,0);await refresh(p);
  if(change==='date')backend.job.dateKey='2026-10-25';
  if(change==='revision')backend.job.revision=2;
  if(change==='assigned-staff')backend.job.assignedStaffId='other-synthetic-staff';
  if(change==='job-id')[...backend.parents.values()][0].jobId='other-synthetic-job';
  await send(p).click();await rejectedRetained(p,before,backend,evidence);
  assert.equal(backend.parents.size,1);assert.equal(backend.uploads.length,0);assert.equal(backend.requests[0].clientRequestId,backend.requests[1].clientRequestId);
  assert.match(await p.locator('.history-grid').innerText(),/アップロード待ち/);evidence.waitingUploadPreserved=true;
  assert.equal(evidence.role,'alert','Pre-acceptance rejection must not look successful while history remains waiting_upload');
 });
 await scenario('explicit unaccepted mail revision rejection: only matching receipt cleared; manual refresh and retry creates one new receipt',async({p,backend,evidence})=>{
  await p.evaluate(()=>window.__fixture.patchJob({mailIntake:{receiptId:'synthetic-mail'},revision:1}));await refresh(p);
  backend.job.mailIntake={receiptId:'synthetic-mail'};backend.job.revision=2;await send(p).click();await poll(()=>p.locator('.submission-message').getAttribute('role').then(r=>r==='alert'),'rejection missing');
  assert.equal(backend.parents.size,0);assert.equal(backend.uploads.length,0);assert.deepEqual(await receipt(p),{});
  const rejected=backend.requests[0].clientRequestId;evidence.rejection=backend.rejections[0];evidence.role=await p.locator('.submission-message').getAttribute('role');
  assert.equal(await p.getByRole('button',{name:/件目のファイルを外す/}).count(),1);
  await p.evaluate(()=>window.__fixture.patchJob({revision:2}));await refresh(p);await p.locator('.submission-confirmation input').check();await send(p).click();await poll(()=>backend.uploads.length===1,'explicit retry not uploaded');
  assert.equal(backend.parents.size,1);assert.notEqual(backend.requests[1].clientRequestId,rejected);evidence.explicitRetryOnly=true;
  assert.equal(evidence.role,'alert','Explicit rejected revision must not look successful');
 });
 await scenario('unknown result before acceptance: reload keeps exact receipt and explicit retry does not create another ID',async({p,backend,evidence})=>{
  backend.unknownBeforeAccept=true;await send(p).click();await settled(p);const before=await receipt(p);assert.equal(Object.keys(before).length,1);assert.equal(backend.parents.size,0);
  await p.reload();await p.locator('.bottom-nav').getByRole('button',{name:/提出/}).click();await p.locator('.file-list').waitFor();assert.deepEqual(await receipt(p),before);
  assert.equal(backend.requests.length,1);await p.locator('.submission-confirmation input').check();await send(p).click();await poll(()=>backend.uploads.length===1,'resume not uploaded');assert.equal(backend.parents.size,1);assert.equal(backend.requests[0].clientRequestId,backend.requests[1].clientRequestId);evidence.sameIdAfterReload=true;
 });
 for(const change of ['date','revision'])await scenario('review refresh '+change+' invalidates confirmation without losing files',async({p,backend,evidence})=>{
  if(change==='date')backend.job.dateKey='2026-10-25';else backend.job.revision=2;
  await p.evaluate(job=>window.__fixture.patchJob(job),{dateKey:backend.job.dateKey,revision:backend.job.revision});await refresh(p);
  assert.equal(await p.locator('.submission-confirmation input').isChecked(),false,'Changed displayed context must require reconfirmation');
  assert.equal(await send(p).isDisabled(),true);assert.equal(backend.requests.length,0);assert.deepEqual(await receipt(p),{});
  assert.equal(await p.getByRole('button',{name:/件目のファイルを外す/}).count(),1);evidence.filesRetained=true;
  await p.locator('.submission-confirmation input').check();await send(p).click();await poll(()=>backend.uploads.length===1,'reconfirmed submission missing');
  assert.equal(backend.requests.length,1);assert.equal(backend.requests[0].expectedDateKey,backend.job.dateKey);assert.equal(backend.requests[0].expectedRevision,backend.job.revision);evidence.reconfirmedContextAccepted=true;
 });
 await scenario('review returned context does not resurrect an older confirmation',async({p,backend,evidence})=>{
  await p.evaluate(()=>window.__fixture.patchJob({revision:2}));await refresh(p);
  assert.equal(await p.locator('.submission-confirmation input').isChecked(),false);assert.equal(await send(p).isDisabled(),true);assert.equal(backend.requests.length,0);
  await p.evaluate(()=>window.__fixture.patchJob({revision:1}));await refresh(p);
  assert.equal(await p.locator('.submission-confirmation input').isChecked(),false,'Returning context must not restore old confirmation');
  assert.equal(await p.getByRole('button',{name:/件目のファイルを外す/}).count(),1);
  await p.locator('.submission-confirmation input').check();await send(p).click();await poll(()=>backend.uploads.length===1,'explicit reconfirmation failed');evidence.returnedContextRequiresConfirmation=true;
 });
 await scenario('review unchanged context refresh preserves confirmation and selected files',async({p,backend,evidence})=>{
  await refresh(p);assert.equal(await p.locator('.submission-confirmation input').isChecked(),true);assert.equal(await p.getByRole('button',{name:/件目のファイルを外す/}).count(),1);
  await send(p).click();await poll(()=>backend.uploads.length===1,'unchanged confirmed context did not submit');assert.equal(backend.requests.length,1);evidence.normalRefreshUnchanged=true;
 });
 for(const change of ['date','revision'])await scenario('non-mail first acceptance pins displayed '+change+'; manual refresh/reconfirmation only',async({p,backend,evidence})=>{
  if(change==='date')backend.job.dateKey='2026-10-25';else backend.job.revision=2;
  await send(p).click();await poll(()=>p.locator('.submission-message').getAttribute('role').then(r=>r==='alert'),'rejection missing');
  assert.equal(backend.parents.size,0);assert.equal(backend.uploads.length,0);assert.deepEqual(await receipt(p),{});
  assert.equal(await p.getByRole('button',{name:/件目のファイルを外す/}).count(),1);assert.equal(await p.locator('.submission-confirmation input').isChecked(),false);
  assert.equal(backend.requests[0].expectedDateKey,'2026-10-24');assert.equal(backend.requests[0].expectedRevision,1);
  await p.evaluate(job=>window.__fixture.patchJob(job),{dateKey:backend.job.dateKey,revision:backend.job.revision});await refresh(p);
  assert.equal(backend.requests.length,1);await p.locator('.submission-confirmation input').check();await send(p).click();await poll(()=>backend.uploads.length===1,'confirmed new submission missing');
  assert.notEqual(backend.requests[0].clientRequestId,backend.requests[1].clientRequestId);evidence.explicitReconfirmation=true;
 });
 await scenario('unknown receipt is not backfilled from refreshed date/revision',async({p,backend,evidence})=>{
  backend.unknownBeforeAccept=true;await send(p).click();await settled(p);const before=await receipt(p);
  await p.evaluate(()=>window.__fixture.patchJob({dateKey:'2026-10-25',revision:2}));await refresh(p);assert.deepEqual(await receipt(p),before);
  assert.equal(await p.locator('.submission-confirmation input').isChecked(),false);assert.equal(backend.requests.length,1);
  backend.job.dateKey='2026-10-25';backend.job.revision=2;await p.locator('.submission-confirmation input').check();await send(p).click();await poll(()=>p.locator('.submission-confirmation input').isChecked().then(v=>!v),'confirmation not reset');
  assert.equal(backend.requests[1].clientRequestId,backend.requests[0].clientRequestId);assert.equal(backend.requests[1].expectedDateKey,'2026-10-24');assert.equal(backend.requests[1].expectedRevision,1);assert.equal(backend.parents.size,0);evidence.originalContextRetained=true;
 });
 await scenario('mismatched non-acceptance details cannot clear receipt or files',async({p,backend,evidence})=>{
  const fields={clientRequestId:'other',jobId:'other',type:'sales_floor',purpose:'replacement',resubmissionRequestId:'other',expectedDateKey:'2026-10-25',expectedRevision:99,accepted:true};let first;
  for(const [field,value] of Object.entries(fields)){
   backend.create=async input=>{backend.requests.push(structuredClone(input));return {__fixtureError:{code:'failed-precondition',message:'Synthetic mismatch',details:{reason:'submission_context_changed',accepted:false,clientRequestId:input.clientRequestId,jobId:input.jobId,type:input.type,purpose:input.purpose,resubmissionRequestId:null,expectedDateKey:input.expectedDateKey,expectedRevision:input.expectedRevision,[field]:value}}};};
   await send(p).click();await settled(p);const saved=await receipt(p);assert.equal(Object.keys(saved).length,1);first??=saved;assert.deepEqual(saved,first);assert.equal(await p.getByRole('button',{name:/件目のファイルを外す/}).count(),1);
  }assert.equal(backend.uploads.length,0);evidence.mismatchedFields=Object.keys(fields);
 });
 await scenario('receipt write failure prevents API and preserves selected file',async({p,backend,evidence})=>{
  await p.evaluate(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('lkc.submit.g2:attempt.v1:'))throw Error('Synthetic write failure');return set.call(this,k,v);};});
  await send(p).click();await settled(p);assert.equal(backend.requests.length,0);assert.equal(backend.uploads.length,0);assert.equal(await p.getByRole('button',{name:/件目のファイルを外す/}).count(),1);assert.equal(await p.locator('.submission-message').getAttribute('role'),'alert');evidence.noAcceptance=true;
 });
 await scenario('unknown outcome then changed files cannot create another receipt or overwrite original draft',async({p,backend,evidence})=>{
  backend.unknownBeforeAccept=true;await send(p).click();await settled(p);const before=await receipt(p);
  await p.locator('.file-picker-button.library input').setInputFiles({...file,name:'synthetic-other.pdf',buffer:Buffer.from('%PDF-1.4 synthetic B')});await p.locator('.submission-confirmation input').check();await send(p).click();
  await poll(()=>p.locator('.submission-message').count().then(v=>v>0),'message absent');
  await p.waitForTimeout(450);assert.equal(backend.requests.length,1,'Unknown outcome must not create a different request');assert.deepEqual(await receipt(p),before);
  const saved=await p.evaluate(async key=>(await (await import('/src/draft-store.ts')).readStoredDraftFiles(key)).map(f=>f.name),JSON.stringify(['v2',JSON.stringify(['synthetic-company','synthetic-owner-a']),'synthetic-job','report','normal']));assert.deepEqual(saved,[file.name]);evidence.originalDraftRetained=true;
  await p.getByRole('button',{name:/件目のファイルを外す/}).last().click();await p.locator('.submission-confirmation input').check();await send(p).click();await poll(()=>backend.uploads.length===1,'original receipt did not resume');assert.equal(backend.requests[0].clientRequestId,backend.requests[1].clientRequestId);assert.equal(backend.parents.size,1);evidence.originalReceiptResumed=true;
 });
 await scenario('draft save failure prevents acceptance and keeps current selected file',async({p,backend,evidence})=>{
  await p.evaluate(()=>{IDBObjectStore.prototype.put=function(){throw new DOMException('Synthetic disk full','QuotaExceededError');};});await send(p).click();await p.waitForTimeout(450);
  assert.equal(backend.requests.length,0,'Do not accept an operation whose selected files were not saved');assert.equal(await p.getByRole('button',{name:/件目のファイルを外す/}).count(),1);assert.equal(await p.locator('.submission-message').getAttribute('role'),'alert');evidence.fileRetained=true;
 });
 await scenario('double activation while request is pending creates only one receipt/upload',async({p,backend,evidence})=>{
  await p.evaluate(()=>window.__fixture.pause('createUploadSession'));await send(p).dblclick();await poll(()=>p.evaluate(()=>window.__fixture.entered.includes('createUploadSession')),'pending request not reached');
  assert.equal(await p.locator('.submission-confirmation input').isDisabled(),true);await p.evaluate(()=>window.__fixture.release('createUploadSession'));await poll(()=>backend.uploads.length===1,'upload missing');assert.equal(backend.requests.length,1);assert.equal(backend.parents.size,1);evidence.oneIntent=true;
 });
 const key=JSON.stringify(['v2',JSON.stringify(['synthetic-company','synthetic-owner-a']),'synthetic-job','report','normal']);
 const currentDraft=p=>p.evaluate(async key=>(await (await import('/src/draft-store.ts')).readStoredDraftFiles(key)).map(f=>f.name),key);
 const openLegacy=async context=>{const p=await context.newPage();await p.goto(origin+'/__legacy');await p.waitForFunction(()=>window.legacy);return p;};
 const seedLegacy=async p=>p.evaluate(async key=>{const files=[new File(['legacy'],'legacy.pdf',{type:'application/pdf'})];await legacy.drafts.saveDraft(key,files);window.legacyAttempt=await legacy.attempts.prepareSubmissionAttempt(key,files,['application/pdf'],()=>true,1);},key);
 await scenario('same-origin legacy save/delete cannot alter pending new-generation draft/receipt',async({p,backend,evidence,context})=>{
  const old=await openLegacy(context);await seedLegacy(old);await p.evaluate(()=>window.__fixture.pause('createUploadSession'));await send(p).click();await poll(()=>p.evaluate(()=>window.__fixture.entered.includes('createUploadSession')),'new writer not locked');const before=await receipt(p);
  await old.evaluate(async key=>{await legacy.drafts.saveDraft(key,[new File(['B'],'legacy-B.pdf',{type:'application/pdf'})]);legacy.drafts.markDraftSubmitted(key);await legacy.drafts.clearDraft(key);await legacy.attempts.clearSubmissionAttempt(legacyAttempt);},key);
  assert.deepEqual(await currentDraft(p),[file.name]);assert.deepEqual(await receipt(p),before);await p.evaluate(()=>window.__fixture.release('createUploadSession'));await poll(()=>backend.uploads.length===1,'new upload missing');evidence.legacySourceCommit=legacySourceCommit;
 });
 await scenario('new cleanup/reload does not delete, migrate or hydrate legacy records',async({p,backend,evidence,context})=>{
  const old=await openLegacy(context);await seedLegacy(old);await old.evaluate(key=>legacy.drafts.markDraftSubmitted(key),key);
  const oldRecords=()=>old.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('lkc.submissionAttempt.v1:')||k.startsWith('lkc-submitted-draft:'))));const before=await oldRecords();
  await send(p).click();await poll(()=>backend.uploads.length===1,'upload missing');await poll(()=>p.evaluate(()=>!Object.keys(localStorage).some(k=>k.startsWith('lkc.submit.g2:'))),'new cleanup pending');assert.deepEqual(await oldRecords(),before);
  const legacyFiles=await old.evaluate(key=>new Promise((resolve,reject)=>{const r=indexedDB.open('lkc-submission-drafts',1);r.onsuccess=()=>{const db=r.result,q=db.transaction('drafts','readonly').objectStore('drafts').get(key);q.onsuccess=()=>{resolve(q.result.map(f=>f.name));db.close();};q.onerror=reject;};r.onerror=reject;}),key);assert.deepEqual(legacyFiles,['legacy.pdf']);
  await p.reload();await p.locator('.bottom-nav').getByRole('button',{name:/提出/}).click();await poll(()=>p.locator('.file-picker-button.library input').isEnabled(),'reload pending');assert.equal(await p.getByRole('button',{name:/件目のファイルを外す/}).count(),0);assert.deepEqual(await oldRecords(),before);evidence.legacyUntouched=true;
 });
 await scenario('new binding rejects a legacy receipt reference without deleting it',async({p,backend,evidence})=>{
  const result=await p.evaluate(async key=>{const raw=await import('/src/submission-attempt-store.ts'),binding=await import('/src/submitted-binding-store.ts'),ns=await import('/src/submission-namespace.ts');const scope=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),v=>v.toString(16).padStart(2,'0')).join('');const id=crypto.randomUUID(),oldKey='lkc.submissionAttempt.v1:'+'a'.repeat(64),saved=JSON.stringify({version:1,clientRequestId:id});localStorage.setItem(oldKey,saved);localStorage.setItem(ns.submittedBindingPrefix+scope+':'+id,JSON.stringify({version:2,clientRequestId:id,receiptStorageKey:oldKey,draftScopeSha256:scope}));let stopped=false;try{await binding.hasSubmittedBindings(key);}catch{stopped=true;}return {stopped,cleared:await raw.clearSubmissionAttempt({storageKey:oldKey,clientRequestId:id}),unchanged:localStorage.getItem(oldKey)===saved};},key);
  assert.deepEqual(result,{stopped:true,cleared:false,unchanged:true});assert.equal(backend.requests.length,0);Object.assign(evidence,result);
 });

}finally{
 await browser.close();await server.close();const passed=results.every(r=>r.passed)&&errors.length===0&&external.length===0;
 const report={passed,phase,candidate:candidateIdentity(root),appSha256:createHash('sha256').update(await readFile(resolve(root,'apps/staff/src/App.tsx'))).digest('hex'),
  scope:'Actual React App, real local stores; candidate production transaction body + integrity helpers with mock data. Not full Functions/Auth/backend E2E.',boundarySourceEvidence,results,errors,external};
 await writeFile(resolve(root,`SUBMISSION_BOUNDARIES_${phase}.json`),JSON.stringify(report,null,2)+'\n');process.exitCode=passed?0:1;
}
