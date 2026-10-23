import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {fixturePortsPlugin,syntheticPorts,makeVisibilityBackend} from './staff-visibility-fixture.mjs';
const root=resolve(import.meta.dirname,'..'),evidenceDir=resolve(process.argv[2]??resolve(root,'release-evidence/ci-staff-visibility'));
await mkdir(evidenceDir,{recursive:true});
const {chromium}=await import('playwright');
const originalReturn='return {data:await window.__mockApi({name,payload,uid:auth.currentUser?.uid})};';
assert.equal(syntheticPorts.split(originalReturn).length,2);
const source=syntheticPorts.replace(originalReturn,`const data=await window.__mockApi({name,payload,uid:auth.currentUser?.uid});if(data?.__fixtureError){const error=new Error(data.__fixtureError.message);Object.assign(error,data.__fixtureError);throw error;}return {data};`)+
 `\nObject.assign(job,{revision:1,mailIntake:{receiptId:'synthetic-mail'}});window.__fixture.patchJob=patch=>Object.assign(job,patch);`;
const plugin=fixturePortsPlugin();
const server=await createServer({root:resolve(root,'apps/staff'),configFile:false,envDir:false,plugins:[{...plugin,load(id){return plugin.load(id)?source:undefined;}},react()],
 cacheDir:resolve(root,'.vite-visibility-test'),server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['react','react-dom/client','react/jsx-dev-runtime'],exclude:['firebase']}});
await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({headless:true}),results=[],external=[],errors=[];
const file={name:'synthetic-boundary.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nSynthetic boundary only\n%%EOF')};
const poll=async(fn,label)=>{const end=Date.now()+8000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error(label);};
const send=p=>p.getByRole('button',{name:'報告書を送信する',exact:true});
const receipt=p=>p.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('lkc.submissionAttempt.v1:'))));
const taskReads=p=>p.evaluate(()=>window.__fixture.entered.filter(n=>n==='getMyTasks').length);
const visibility=(p,{advance=0,visible=true,patch={}}={})=>p.evaluate(({advance,visible,patch})=>{
 window.__fixture.patchJob(patch);
 window.__testNow??=Date.now();window.__testNow+=advance;Date.now=()=>window.__testNow;
 Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visible?'visible':'hidden'});
 document.dispatchEvent(new Event('visibilitychange'));
},{advance,visible,patch});
const retainedFileCount=p=>p.getByRole('button',{name:/件目のファイルを外す/}).count();
const refresh=async p=>{await p.getByRole('button',{name:'提出情報を再読み込み',exact:true}).click();await poll(()=>p.getByRole('button',{name:'提出情報を再読み込み',exact:true}).isEnabled(),'refresh pending');};
async function scenario(name,run){
 if(process.env.LKC_TEST_FILTER&&!new RegExp(process.env.LKC_TEST_FILTER).test(name))return;
 const context=await browser.newContext({serviceWorkers:'block'});context.setDefaultTimeout(8000);const backend=makeVisibilityBackend();
 await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith(origin+'/'))return route.continue();external.push(url.split('?')[0]);return route.abort('blockedbyclient');});
 backend.calls=[];
 await context.exposeFunction('__mockApi',async({name,payload,uid})=>{
  backend.calls.push({name,uid});
  if(name==='getMyTasks'){
   if(backend.pauseTasksFor===uid)await backend.tasksGate;
   if(backend.failNextTasks){backend.failNextTasks=false;return {__fixtureError:{code:'unavailable',message:'Synthetic business refresh failure'}};}
  }
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
 await scenario('visibility refresh must use current idle state after initial hydration',async({p,backend,evidence})=>{
  backend.job.revision=2;
  evidence.before=await p.evaluate(()=>window.__fixture.entered.slice());
  await p.evaluate(()=>{window.__fixture.patchJob({revision:2,storeName:'Synthetic refreshed store'});const now=Date.now;Date.now=()=>now()+600000;Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));});
  try{await poll(()=>p.locator('.submission-target-summary').innerText().then(v=>v.includes('Synthetic refreshed store')),'Visibility refresh did not update the displayed context');}
  finally{Object.assign(evidence,await p.evaluate(()=>({after:window.__fixture.entered.slice(),currentTarget:document.querySelector('.submission-target-summary')?.textContent})));}
  assert.equal(backend.requests.length,0);assert.deepEqual(await receipt(p),{});assert.equal(await p.getByRole('button',{name:/件目のファイルを外す/}).count(),1);
  await p.locator('.submission-confirmation input').check();await send(p).click();await poll(()=>backend.uploads.length===1,'explicitly confirmed submission missing');assert.equal(backend.requests[0].expectedRevision,2);
 });
 await scenario('visibility keeps hidden/throttle/in-flight guards and does not register extra sessions',async({p,backend,evidence})=>{
  const before=await taskReads(p),registrations=backend.calls.filter(c=>c.name==='registerDeviceSession').length;
  await visibility(p,{advance:60000,visible:false});await p.waitForTimeout(80);assert.equal(await taskReads(p),before);
  await p.evaluate(()=>window.__fixture.pause('getMyTasks'));
  await visibility(p,{patch:{storeName:'Synthetic guard refresh one'}});await poll(async()=>await taskReads(p)===before+1,'visible refresh missing');
  await visibility(p,{advance:60000});await p.waitForTimeout(80);assert.equal(await taskReads(p),before+1);
  await p.evaluate(()=>window.__fixture.release('getMyTasks'));await poll(()=>p.locator('.submission-target-summary').innerText().then(v=>v.includes('Synthetic guard refresh one')),'first refresh did not reach the UI');
  await visibility(p,{patch:{storeName:'Synthetic guard refresh two'}});await poll(()=>p.locator('.submission-target-summary').innerText().then(v=>v.includes('Synthetic guard refresh two')),'second refresh did not reach the UI');assert.equal(await taskReads(p),before+2);
  await visibility(p,{advance:29999});await p.waitForTimeout(80);assert.equal(await taskReads(p),before+2);
  await visibility(p,{advance:1,patch:{storeName:'Synthetic guard refresh three'}});await poll(()=>p.locator('.submission-target-summary').innerText().then(v=>v.includes('Synthetic guard refresh three')),'30-second refresh did not reach the UI');assert.equal(await taskReads(p),before+3);
  assert.equal(backend.calls.filter(c=>c.name==='registerDeviceSession').length,registrations);assert.equal(backend.requests.length,0);assert.deepEqual(await receipt(p),{});assert.equal(await retainedFileCount(p),1);evidence.existingGuardsPreserved=true;
 });
 await scenario('pending request blocks visibility refresh; unknown result later refreshes without losing original receipt',async({p,backend,evidence})=>{
  backend.unknownBeforeAccept=true;await p.evaluate(()=>window.__fixture.pause('createUploadSession'));await send(p).click();
  await poll(()=>p.evaluate(()=>window.__fixture.entered.includes('createUploadSession')),'request not pending');
  const before=await receipt(p),reads=await taskReads(p);assert.equal(Object.keys(before).length,1);
  await visibility(p,{advance:60000});await p.waitForTimeout(80);assert.equal(await taskReads(p),reads);assert.deepEqual(await receipt(p),before);assert.equal(await retainedFileCount(p),1);
  await p.evaluate(()=>window.__fixture.release('createUploadSession'));await settled(p);assert.equal(backend.parents.size,0);
  await visibility(p);await poll(async()=>await taskReads(p)===reads+1,'idle refresh after pending missing');await p.waitForTimeout(80);
  assert.deepEqual(await receipt(p),before);assert.equal(await retainedFileCount(p),1);assert.equal(backend.requests.length,1);assert.equal(backend.uploads.length,0);
  await send(p).click();await poll(()=>backend.uploads.length===1,'original request resume failed');assert.equal(backend.requests.length,2);assert.equal(backend.requests[0].clientRequestId,backend.requests[1].clientRequestId);evidence.originalIdResumedExplicitly=true;
 });
 await scenario('accepted unknown receipt survives changed-context visibility refresh and explicit retry retains original ID',async({p,backend,evidence})=>{
  backend.loseNextResponse=true;await send(p).click();await settled(p);const before=await receipt(p),reads=await taskReads(p);assert.equal(backend.parents.size,1);
  backend.rejectResume=true;backend.job.revision=2;
  await visibility(p,{advance:60000,patch:{revision:2,storeName:'Synthetic changed target'}});await poll(async()=>await taskReads(p)===reads+1,'changed-context refresh missing');
  await poll(()=>p.locator('.submission-target-summary').innerText().then(v=>v.includes('Synthetic changed target')),'changed target missing');assert.deepEqual(await receipt(p),before);assert.equal(await retainedFileCount(p),1);assert.equal(backend.requests.length,1);assert.equal(backend.uploads.length,0);
  await p.locator('.submission-confirmation input').check();await send(p).click();await settled(p);assert.deepEqual(await receipt(p),before);assert.equal(backend.parents.size,1);assert.equal(backend.requests[1].clientRequestId,backend.requests[0].clientRequestId);assert.equal(backend.requests[1].expectedRevision,1);assert.equal(backend.uploads.length,0);assert.equal(await retainedFileCount(p),1);evidence.acceptedReceiptAndPinsRetained=true;
 });
 await scenario('post-upload processing suppresses refresh until complete without extra submission',async({p,backend,evidence})=>{
  await p.evaluate(()=>window.__fixture.pause('getSubmissionProcessingStatus'));await send(p).click();await poll(()=>p.evaluate(()=>window.__fixture.entered.includes('getSubmissionProcessingStatus')),'processing not pending');
  const reads=await taskReads(p),before=await receipt(p);await visibility(p,{advance:60000});await p.waitForTimeout(80);assert.equal(await taskReads(p),reads);assert.deepEqual(await receipt(p),before);
  await p.evaluate(()=>window.__fixture.release('getSubmissionProcessingStatus'));await poll(()=>p.locator('.submission-confirmation input').isEnabled(),'processing did not finish');
  const afterProcessingReads=await taskReads(p);assert.equal(afterProcessingReads,reads+1,'Completion already refreshes the task list once');
  await visibility(p);await poll(async()=>await taskReads(p)===afterProcessingReads+1,'refresh after processing missing');assert.equal(backend.requests.length,1);assert.equal(backend.uploads.length,1);evidence.completionTaskReads=afterProcessingReads-reads;evidence.noAutomaticResubmission=true;
 });
 await scenario('failed visibility read preserves unknown receipt/files; next visible event can retry the read',async({p,backend,evidence})=>{
  backend.unknownBeforeAccept=true;await send(p).click();await settled(p);const before=await receipt(p),reads=await taskReads(p);backend.failNextTasks=true;
  await visibility(p,{advance:60000});await poll(()=>backend.failNextTasks===false,'failed refresh not called');await p.waitForTimeout(80);assert.deepEqual(await receipt(p),before);assert.equal(await retainedFileCount(p),1);assert.equal(backend.requests.length,1);
  await visibility(p);await poll(async()=>await taskReads(p)===reads+2,'retry read was blocked');await p.waitForTimeout(80);assert.deepEqual(await receipt(p),before);assert.equal(await retainedFileCount(p),1);assert.equal(backend.requests.length,1);assert.equal(backend.uploads.length,0);evidence.failedReadDoesNotResetReceipt=true;
 });
 await scenario('owner switch during visibility read rejects stale completion and keeps old-owner receipt isolated',async({p,backend,evidence})=>{
  backend.unknownBeforeAccept=true;await send(p).click();await settled(p);const before=await receipt(p),reads=await taskReads(p);
  let release;backend.pauseTasksFor='synthetic-owner-a';backend.tasksGate=new Promise(r=>{release=r;});
  await visibility(p,{advance:60000});await poll(async()=>await taskReads(p)===reads+1,'old owner refresh missing');
  await p.evaluate(()=>window.__fixture.switchOwner('synthetic-owner-b'));await poll(()=>backend.calls.some(c=>c.name==='getMyTasks'&&c.uid==='synthetic-owner-b'),'new owner not loaded');await poll(()=>p.locator('.file-picker-button.library input').isEnabled(),'new owner hydration pending');
  release();await p.waitForTimeout(100);assert.deepEqual(await receipt(p),before);assert.equal(await retainedFileCount(p),0);assert.equal(backend.requests.length,1);assert.equal(backend.uploads.length,0);
  await visibility(p,{advance:60000});await poll(()=>backend.calls.filter(c=>c.name==='getMyTasks'&&c.uid==='synthetic-owner-b').length===2,'new owner visibility read missing');assert.deepEqual(await receipt(p),before);assert.equal(await retainedFileCount(p),0);evidence.oldReceiptNotMixedOrCleared=true;
 });
}finally{
 await browser.close();await server.close();const passed=results.every(r=>r.passed)&&errors.length===0&&external.length===0;
 const report={passed,appSha256:createHash('sha256').update(await readFile(resolve(root,'apps/staff/src/App.tsx'))).digest('hex'),
  scope:'Actual React App and real local stores with synthetic service ports/backend. No real Auth, Storage, Functions or Admin E2E.',results,errors,external};
 await writeFile(resolve(evidenceDir,'result.json'),JSON.stringify(report,null,2)+'\n');process.exitCode=passed?0:1;
}
