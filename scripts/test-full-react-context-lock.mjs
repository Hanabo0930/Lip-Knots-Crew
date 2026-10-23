import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {fixturePortsPlugin} from './full-react-fixture.mjs';
import {candidateIdentity} from './verification-candidate.mjs';
const root=resolve(import.meta.dirname,'..');
const {chromium}=await import('playwright');
const server=await createServer({root:resolve(root,'apps/staff'),configFile:false,envDir:false,
  cacheDir:resolve(root,'.vite-react-test'),plugins:[fixturePortsPlugin(),react()],
  server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false},
  optimizeDeps:{include:['react','react-dom/client','react/jsx-dev-runtime'],exclude:['firebase']},
});
await server.listen();
const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({headless:true});
const results=[], blocked=[], browserErrors=[];
const file={name:'synthetic-report.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nSynthetic fixture only\n%%EOF')};
const key=JSON.stringify(['v2',JSON.stringify(['synthetic-company','synthetic-owner-a']),'synthetic-job','report','normal']);
const requestPrefix='lkc.submit.g2:attempt.v1:',markerPrefix='lkc.submit.g2:submitted:',bindingPrefix='lkc.submit.g2:binding.v2:';
const poll=async(fn,message)=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,25));}throw Error(message);};

async function scenario(name,fn){
  const context=await browser.newContext({serviceWorkers:'block'});
  context.setDefaultTimeout(10000);
  const state={calls:[],uploads:[],sessions:new Map(),failSession:false,failUpload:false};
  await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith(origin+'/'))return route.continue();blocked.push(url.split('?')[0]);return route.abort('blockedbyclient');});
  await context.exposeFunction('__mockApi',async({name,payload,uid})=>{
    state.calls.push({name,payload,uid});
    switch(name){
      case 'bootstrapSession':return {refreshToken:false};
      case 'getMyTasks':return {tasks:[]};
      case 'registerDeviceSession':return {sessionId:'synthetic-device'};
      case 'heartbeatDeviceSession':return {};
      case 'getSubmissionTimeline':return {submissions:[]};
      case 'getSubmissionProcessingStatus':return {status:'completed',completedFiles:1,totalFiles:1,errorMessage:null};
      case 'createUploadSession':{
        if(state.failSession){state.failSession=false;throw Error('Synthetic session failure');}
        const old=state.sessions.get(payload.clientRequestId);
        const result={submissionId:old?.submissionId??`synthetic-submission-${state.sessions.size+1}`,clientRequestId:payload.clientRequestId,
          files:payload.files.map((_,i)=>({storagePath:`synthetic/${payload.clientRequestId}/${i}`,uploadRequired:!old?.uploaded}))};
        state.sessions.set(payload.clientRequestId,{...result,uploaded:old?.uploaded??false});return result;
      }
      default:throw Error(`Unexpected synthetic API: ${name}`);
    }
  });
  await context.exposeFunction('__mockUpload',async payload=>{
    state.uploads.push(payload);
    if(state.failUpload){state.failUpload=false;throw Error('Synthetic upload failure');}
    const requestId=payload.path.split('/')[1];state.sessions.get(requestId).uploaded=true;
  });
  const newPage=async()=>{const p=await context.newPage();p.on('pageerror',e=>browserErrors.push({scenario:name,error:e.message}));return p;};
  try{await fn({context,state,newPage});results.push({name,passed:true,apiSessions:state.calls.filter(c=>c.name==='createUploadSession').length,mockUploads:state.uploads.length});console.log('PASS '+name);}
  catch(error){results.push({name,passed:false,error:error.stack});console.error('FAIL '+name+': '+error.message);for(const p of context.pages())console.error((await p.locator('body').innerText()).slice(0,3000));throw error;}
  finally{await context.close();}
}
const navigateSubmission=p=>p.locator('.bottom-nav').getByRole('button',{name:/提出/}).click();
async function open(p){await p.goto(origin);await navigateSubmission(p);await p.locator('.submission-confirmation input').waitFor();await poll(()=>p.locator('.file-picker-button.library input').isEnabled(),'hydration did not settle');}
async function select(p){await p.locator('.file-picker-button.library input').setInputFiles(file);await p.locator('.submission-confirmation input').check();}
const submit=p=>p.getByRole('button',{name:'報告書を送信する',exact:true}).click();
const successful=p=>poll(async()=>await p.locator('.submission-message').textContent().catch(()=>'')==='Driveへの保存が完了しました。','submission completion message');
const cleanupClear=p=>poll(()=>p.evaluate(()=>!Object.keys(localStorage).some(k=>k.startsWith('lkc.submit.g2:submitted:')||k.startsWith('lkc.submit.g2:binding.v2:')||k.startsWith('lkc.submit.g2:attempt.v1:'))),'cleanup remained');
const records=p=>p.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>['lkc.submit.g2:submitted:','lkc.submit.g2:binding.v2:','lkc.submit.g2:attempt.v1:'].some(prefix=>k.startsWith(prefix)))));
const busyButton=p=>p.getByRole('button',{name:'端末の記録を再読み込み',exact:true});
const cleanupButton=p=>p.getByRole('button',{name:'端末の後片付けを再試行',exact:true});

try{
  await scenario('actual React StrictMode: normal consecutive same-file submissions',async({newPage,state})=>{
    const p=await newPage();await open(p);
    for(let i=1;i<=2;i++){await select(p);await submit(p);await successful(p);await cleanupClear(p);assert.equal(state.uploads.length,i);}
    const ids=state.calls.filter(c=>c.name==='createUploadSession').map(c=>c.payload.clientRequestId);assert.equal(new Set(ids).size,2);
  });
  await scenario('busy initial hydration: peer success then explicit read, no automatic upload',async({newPage,state})=>{
    const a=await newPage();await open(a);await a.evaluate(()=>window.__fixture.pause('createUploadSession'));await select(a);await submit(a);
    await poll(()=>a.evaluate(()=>window.__fixture.entered.includes('createUploadSession')),'peer session not entered');
    const b=await newPage();await open(b);await busyButton(b).waitFor();
    await a.evaluate(()=>window.__fixture.release('createUploadSession'));await successful(a);await cleanupClear(a);
    await busyButton(b).click();await busyButton(b).waitFor({state:'hidden'});assert.equal(state.uploads.length,1);assert.deepEqual(await records(b),{});
    await select(b);await submit(b);await successful(b);await cleanupClear(b);assert.equal(state.uploads.length,2);
  });
  await scenario('busy peer session failure: explicit read retains files and same request for explicit retry',async({newPage,state})=>{
    const a=await newPage();await open(a);state.failSession=true;await a.evaluate(()=>window.__fixture.pause('createUploadSession'));await select(a);await submit(a);
    await poll(()=>a.evaluate(()=>window.__fixture.entered.includes('createUploadSession')),'peer session not entered');
    const b=await newPage();await open(b);await busyButton(b).waitFor();await a.evaluate(()=>window.__fixture.release('createUploadSession'));
    await poll(()=>state.calls.some(c=>c.name==='createUploadSession'),'session failure not reached');
    await poll(()=>a.getByRole('button',{name:'報告書を送信する',exact:true}).isEnabled(),'peer did not release');
    const before=await records(b);assert(Object.keys(before).some(k=>k.startsWith(requestPrefix)));
    await busyButton(b).click();await busyButton(b).waitFor({state:'hidden'});assert.deepEqual(await records(b),before);assert.equal(state.uploads.length,0);
    await b.locator('.submission-confirmation input').check();await submit(b);await successful(b);await cleanupClear(b);
    const ids=state.calls.filter(c=>c.name==='createUploadSession').map(c=>c.payload.clientRequestId);assert.equal(ids[0],ids[1]);assert.equal(state.uploads.length,1);
  });
  await scenario('post-submit receipt delete failure, reload then explicit cleanup without reupload',async({newPage,state})=>{
    const p=await newPage();await open(p);
    await p.evaluate(()=>{const remove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(k){if(k.startsWith('lkc.submit.g2:attempt.v1:'))throw Error('Synthetic removal denied');return remove.call(this,k);};});
    await select(p);await submit(p);await successful(p);await cleanupButton(p).waitFor();const before=await records(p);assert.equal(Object.keys(before).length,3);
    await p.reload();await navigateSubmission(p);await cleanupButton(p).waitFor();assert.deepEqual(await records(p),before);
    await cleanupButton(p).click();await cleanupButton(p).waitFor({state:'hidden'});await cleanupClear(p);assert.equal(state.uploads.length,1);
    await select(p);await submit(p);await successful(p);await cleanupClear(p);assert.equal(state.uploads.length,2);
  });
  await scenario('busy peer incomplete cleanup: explicit hydration retains completed receipt then separate cleanup',async({newPage,state})=>{
    const a=await newPage();await open(a);await a.evaluate(()=>{window.__fixture.pause('createUploadSession');const remove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(k){if(k.startsWith('lkc.submit.g2:attempt.v1:'))throw Error('Synthetic removal denied');return remove.call(this,k);};});
    await select(a);await submit(a);await poll(()=>a.evaluate(()=>window.__fixture.entered.includes('createUploadSession')),'peer session not entered');
    const b=await newPage();await open(b);await busyButton(b).waitFor();await a.evaluate(()=>window.__fixture.release('createUploadSession'));await successful(a);await cleanupButton(a).waitFor();
    const before=await records(b);await busyButton(b).click();await cleanupButton(b).waitFor();assert.deepEqual(await records(b),before);assert.equal(state.uploads.length,1);
    await cleanupButton(b).click();await cleanupButton(b).waitFor({state:'hidden'});await cleanupClear(b);assert.equal(state.uploads.length,1);
  });
  await scenario('corrupt persisted binding remains STOP after actual reload and explicit retry',async({newPage,state})=>{
    const p=await newPage();await open(p);await p.evaluate(async key=>{const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),v=>v.toString(16).padStart(2,'0')).join('');localStorage.setItem('lkc.submit.g2:binding.v2:'+digest+':synthetic','{broken');},key);
    const before=await records(p);await p.reload();await navigateSubmission(p);await cleanupButton(p).waitFor();await cleanupButton(p).click();await poll(()=>cleanupButton(p).isEnabled(),'retry did not settle');
    assert.deepEqual(await records(p),before);await select(p);assert(await p.getByRole('button',{name:'報告書を送信する',exact:true}).isDisabled());assert.equal(state.uploads.length,0);
  });
  await scenario('owner switch during pending upload session does not upload or clean old owner',async({newPage,state})=>{
    const p=await newPage();await open(p);await p.evaluate(()=>window.__fixture.pause('createUploadSession'));await select(p);await submit(p);
    await poll(()=>p.evaluate(()=>window.__fixture.entered.includes('createUploadSession')),'session not entered');const before=await records(p);
    await p.evaluate(()=>window.__fixture.switchOwner('synthetic-owner-b'));await poll(()=>state.calls.some(c=>c.name==='getMyTasks'&&c.uid==='synthetic-owner-b'),'new owner load');
    await p.evaluate(()=>window.__fixture.release('createUploadSession'));await poll(()=>state.calls.some(c=>c.name==='createUploadSession'),'session unresolved');
    await poll(()=>p.locator('.file-picker-button.library input').isEnabled(),'old upload not settled');assert.deepEqual(await records(p),before);assert.equal(state.uploads.length,0);
    await select(p);await submit(p);await successful(p);await poll(async()=>JSON.stringify(await records(p))===JSON.stringify(before),'new owner cleanup changed old receipt');assert.equal(state.uploads.length,1);const calls=state.calls.filter(c=>c.name==='createUploadSession');assert.notEqual(calls[0].payload.clientRequestId,calls[1].payload.clientRequestId);assert.equal(state.uploads[0].path.split('/')[1],calls[1].payload.clientRequestId);
  });
  assert.equal(browserErrors.length,0,JSON.stringify(browserErrors));
}finally{
  await browser.close();await server.close();
  const report={passed:results.every(r=>r.passed)&&browserErrors.length===0,scope:'Actual main.tsx / StrictMode / App / React effects, DOM handlers, native IndexedDB/localStorage/Web Locks. Only external service ports mocked.',
    sourceCommit:process.env.GITHUB_SHA??null,candidate:candidateIdentity(root),
    appSha256:createHash('sha256').update(await readFile(resolve(root,'apps/staff/src/App.tsx'))).digest('hex'),tests:results,blockedExternalRequests:blocked,browserErrors};
  await writeFile(resolve(root,'FULL_REACT_CONTEXT_LOCK_RESULT.json'),JSON.stringify(report,null,2)+'\n');
}
