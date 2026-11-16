import assert from 'node:assert/strict';import fs from 'node:fs';import {webcrypto,randomUUID,createHash}from'node:crypto';import{File}from'node:buffer';import{runInNewContext}from'node:vm';import {join} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(process.env.LKC_TEST_DEPENDENCY_ROOT?join(process.env.LKC_TEST_DEPENDENCY_ROOT,'package.json'):import.meta.url),ts=require('typescript'),{renderToStaticMarkup}=require('react-dom/server');
const compile=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const app=fs.readFileSync('apps/staff/src/App.tsx','utf8'),start=app.indexOf('  async function finishSubmittedDraft('),end=app.indexOf('  async function retryDraftCleanup()',start);assert.ok(start>=0&&end>start);const upload=compile(app.slice(start,end)+app.slice(end,app.indexOf("  async function loadSubmissionHistory(",end)));
const results=[];async function test(name,run){try{await run();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.stack});}}
function fixture(retained={}){const files=[new File(['one'],'one.png',{type:'image/png'}),new File(['two'],'two.pdf',{type:'application/pdf'})],rows=retained.rows??new Map(),uploaded=retained.uploaded??new Set(),receipts=retained.receipts??new Map(),state={files,processing:[],messages:[],payloads:[],storageWrites:[],status:{},cleanup:0,marked:0};const attemptScope={exports:{},crypto:{subtle:webcrypto.subtle,randomUUID},Uint8Array,TextEncoder,navigator:{locks:{request:async(_key,_opts,fn)=>fn({})}},localStorage:{getItem:k=>rows.get(k)??null,setItem:(k,v)=>rows.set(k,v),removeItem:k=>{if(state.failReceiptRemove)throw Error("synthetic receipt cleanup failure");rows.delete(k)}}};runInNewContext(compile(fs.readFileSync('apps/staff/src/submission-attempt-store.ts','utf8')),attemptScope);const concurrency={exports:{}};runInNewContext(compile(fs.readFileSync('apps/staff/src/concurrency.ts','utf8')),concurrency);
 const ctx={companyId:"company",staffId:"staff",user:{uid:"user"},files,draftCleanup:null,submissionConfirmed:true,isSubmissionActionPending:()=>state.pending,isPending:()=>state.pending,MAX_SUBMISSION_FILE_SIZE:50*1024*1024,UPLOAD_CONCURRENCY:2,selectedJob:{id:'job',dateKey:'2026-12-08'},myJobs:[{id:'job',dateKey:'2026-12-08'}],hasValidDateKey:job=>/^\d{4}-\d{2}-\d{2}$/.test(job.dateKey),submissionConfirmationContext:'displayed',submissionConfirmationContextRef:{current:'displayed'},requestId:'',submissionType:'report',firebaseConfigured:true,functions:{},firebaseApp:{},draftKey:'company/user/job/report',authLoadVersionRef:{current:1},loadSubmissionAttempt:async()=>attemptScope.exports,submissionFileContentType:f=>f.type,fileStateKey:f=>f.name,showSubmissionMessage:m=>state.messages.push(m),setSubmissionMessage:()=>{},setUploadState:v=>state.status=typeof v==='function'?v(state.status):v,setFiles:v=>state.files=v,setSubmissionConfirmed:v=>state.confirmed=v,setDraftCleanup:v=>{state.cleanupRecord=typeof v==="function"?v(state.cleanupRecord):v;ctx.draftCleanup=state.cleanupRecord;},skipNextDraftSaveRef:{current:false},clearSubmittedDraft:async()=>{state.marked++;if(state.failCleanup)throw Error('synthetic cleanup failure');if(state.otherDraft)return 'preserved';if(!state.cleanup)state.cleanup++;return 'cleared';},pollSubmissionProcessing:async(...args)=>state.processing.push(args),runWithConcurrency:concurrency.exports.runWithConcurrency,run:async(_key,fn,options)=>{state.pending=true;try{await fn();}catch(e){options?.setMessage?.(e.message);throw e;}finally{state.pending=false;}},httpsCallable:(_api,name)=>{assert.equal(name,'createUploadSession');return async payload=>{state.payloads.push(payload);if(payload.receiptOnly&&!receipts.has(payload.clientRequestId))throw Error('Unobserved synthetic legacy receipt');const id=submissionIdFor(payload.clientRequestId);receipts.set(payload.clientRequestId,id);if(state.loseResponse){state.loseResponse=false;throw Error('synthetic lost response');}return{data:{submissionId:id,clientRequestId:payload.clientRequestId,acceptedContext:{jobId:payload.jobId,dateKey:payload.expectedDateKey,revision:payload.expectedRevision},files:payload.files.map((f,i)=>({fileId:fileIdFor(id,i),storagePath:storagePath(id,i),uploadRequired:!uploaded.has(storagePath(id,i))}))}};}},loadUploadStorage:async()=>({getClientStorage:()=>({}),ref:(_s,p)=>p,uploadBytesResumable:(p,file,metadata)=>({on:(_event,_progress,reject,resolve)=>{state.storageWrites.push({path:p,file,metadata});if(state.failFile!==undefined&&p.endsWith("/"+state.failFile)){state.failFile=undefined;reject(Error('synthetic offline'));}else{assert.equal(uploaded.has(p),false,'must not overwrite an existing create-only object');uploaded.add(p);resolve();}}})})};runInNewContext(upload,ctx);return{ctx,state,rows,receipts,uploaded,original:files};}
const uploadStorageSource=compile(fs.readFileSync('apps/staff/src/upload-storage.ts','utf8'));
function storageModule(auth,startUpload){
 const scope={exports:{},require(name){
  if(name==="firebase/storage")return {ref:(_storage,fullPath)=>({fullPath}),getStorage:()=>({}),uploadBytesResumable:startUpload};
  if(name==="./firebase")return {auth,firebaseApp:{}};
  assert.equal(name,"./firebase-config");return {useFirebaseEmulators:false};
 }};
 runInNewContext(uploadStorageSource,scope);return scope.exports;
}
function deviceAuth(owner){
 const subscribers=new Set();
 return {subscribers,currentUser:owner,onAuthStateChanged(listener){
  subscribers.add(listener);
  return ()=>subscribers.delete(listener);
 },changeAccount(user){
  this.currentUser=user;
  for(const listener of subscribers)listener(user);
 }};
}
await test('signed-out or mismatched browser identity cannot start a report transfer',async()=>{
 let starts=0;
 for(const owner of [null,{uid:"other-user"}]){
  const auth=deviceAuth(owner);
  const storage=storageModule(auth,()=>{starts++;return {then(){},cancel(){}};});
  assert.throws(()=>storage.uploadBytesResumable({fullPath:"staging/company/user/submission/file/report.pdf"},new Uint8Array([1])),/本人と送信先を照合/);
  assert.equal(auth.subscribers.size,0);
 }
 assert.equal(starts,0);
});
for(const change of ['logout','other-account'])await test('in-flight report transfer stops on '+change+' and resumes from original receipt',async()=>{
 const first=fixture();
 const owner=first.ctx.user,auth=deviceAuth(owner);
 const transfers=[];
 let started;
 const allStarted=new Promise(resolve=>{started=resolve;});
 const module=storageModule(auth,target=>{
  let reject;
  const done=new Promise((_resolve,fail)=>{reject=fail;});
  const transfer={target,reject,cancellations:0};
  transfers.push(transfer);
  if(transfers.length===2)started();
  return {
   on(_event,_progress,onError,onComplete){void done.then(onComplete,onError);},
   then:done.then.bind(done),
   cancel(){transfer.cancellations++;reject(Error("synthetic canceled"));return true;},
  };
 });
 first.ctx.loadUploadStorage=async()=>module;
 const upload=first.ctx.uploadSubmission();
 try {
  await Promise.race([allStarted,upload.then(()=>assert.fail("report files did not start"))]);
  auth.changeAccount({uid:owner.uid});
  assert.deepEqual(transfers.map(transfer=>transfer.cancellations),[0,0]);
  // One object reached storage before its response and the account change.
  first.uploaded.add(transfers[0].target.fullPath);
  first.ctx.authLoadVersionRef.current++;
  auth.changeAccount(change==="logout"?null:{uid:"another-user"});
  assert.deepEqual(transfers.map(transfer=>transfer.cancellations),[1,1]);
 } finally {
  for(const transfer of transfers)transfer.reject(Error("synthetic test cleanup"));
  await upload;
 }
 assert.equal(auth.subscribers.size,0);
 assert.equal(first.rows.size,1);
 assert.equal(first.state.files,first.original);
 assert.equal(first.state.marked,0);
 assert.deepEqual(first.state.processing,[]);
 const retry=fixture(first);
 await retry.ctx.uploadSubmission();
 assert.equal(retry.state.payloads[0].clientRequestId,first.state.payloads[0].clientRequestId);
 assert.equal(retry.receipts.size,1);
 assert.deepEqual(retry.state.storageWrites.map(write=>write.path),[transfers[1].target.fullPath]);
 assert.equal(retry.state.cleanup,1);
});
for(const outcome of ['success','failure'])await test('finished '+outcome+' transfer detaches its auth observer',async()=>{
 const auth=deviceAuth({uid:"user"});
 const done=outcome==="success"?Promise.resolve():Promise.reject(Error("synthetic offline"));
 const settlement=done.catch(()=>undefined);
 let cancellations=0;
 const task={then:done.then.bind(done),cancel(){cancellations++;return false;}};
 const module=storageModule(auth,()=>task);
 assert.equal(module.uploadBytesResumable({fullPath:"staging/company/user/submission/file/report.pdf"},new Uint8Array([1])),task);
 assert.equal(auth.subscribers.size,1);
 await settlement;
 auth.changeAccount(null);
 assert.equal(auth.subscribers.size,0);
 assert.equal(cancellations,0);
});
await test('lost receipt response reuses operation ID and keeps files until upload succeeds',async()=>{const f=fixture();f.state.loseResponse=true;await f.ctx.uploadSubmission();assert.equal(f.state.storageWrites.length,0);assert.equal(f.state.files,f.original);assert.equal(f.rows.size,1);await f.ctx.uploadSubmission();assert.equal(f.state.payloads[0].clientRequestId,f.state.payloads[1].clientRequestId);assert.equal(f.receipts.size,1);assert.equal(f.state.storageWrites.length,2);assert.equal(f.state.files.length,0);assert.equal(f.rows.size,0);assert.equal(f.state.cleanup,1);});
function hash(value){return createHash('sha256').update(value).digest('hex');}
function submissionIdFor(request){return 'submission_'+hash(JSON.stringify(['company','staff','user',request]));}
function fileIdFor(id,index){return 'file_'+hash(id+'|'+index).slice(0,32);}
function storagePath(id,index){return 'staging/company/user/'+id+'/'+fileIdFor(id,index)+'/'+index;}
for(const [name,alter] of [
 ["another company",r=>{r.files[0].storagePath=r.files[0].storagePath.replace("/company/","/other-company/");}],
 ["another staff account",r=>{r.files[0].storagePath=r.files[0].storagePath.replace("/user/","/other-user/");}],
 ["another submission",r=>{r.files[0].storagePath=r.files[0].storagePath.replace("/"+r.submissionId+"/","/other-submission/");}],
 ["another file",r=>{r.files[0].storagePath=r.files[0].storagePath.replace("/"+r.files[0].fileId+"/","/file-mismatch/");}],
 ["duplicate file ID on two objects",r=>{r.files[1].storagePath=r.files[1].storagePath.replace("/"+r.files[1].fileId+"/","/"+r.files[0].fileId+"/");r.files[1].fileId=r.files[0].fileId;}],
 ["extra path component",r=>{r.files[0].storagePath+="/extra";}],
 ["files in reverse order",r=>{r.files.reverse();}],
 ["another operation with internally consistent IDs",r=>{
  r.submissionId=submissionIdFor("22222222-2222-4222-8222-222222222222");
  r.files.forEach((target,index)=>{target.fileId=fileIdFor(r.submissionId,index);target.storagePath=storagePath(r.submissionId,index);});
 }],
 ["missing authorization scope",(_r,f)=>{f.ctx.user=null;}],
])await test("reject "+name+" before sending bytes and retry with the same receipt",async()=>{
 const f=fixture(),invoke=f.ctx.httpsCallable;
 f.ctx.httpsCallable=(...args)=>async payload=>{const reply=await invoke(...args)(payload);alter(reply.data,f);return reply;};
 await f.ctx.uploadSubmission();
 assert.equal(f.state.storageWrites.length,0);assert.equal(f.state.files,f.original);
 assert.equal(f.state.processing.length,0);assert.equal(f.rows.size,1);
 assert.match(f.state.messages.at(-1),/送信先/u);
 f.ctx.httpsCallable=invoke;f.ctx.user={uid:"user"};
 await f.ctx.uploadSubmission();
 assert.equal(f.state.payloads[0].clientRequestId,f.state.payloads[1].clientRequestId);
 assert.equal(f.state.storageWrites.length,2);assert.equal(f.state.processing.length,1);
});
await test('account switch during upload target verification prevents transfer or receipt cleanup',async()=>{
 const f=fixture(),load=f.ctx.loadSubmissionAttempt;
 let resolve,started;
 const awaiting=new Promise(done=>{started=done;});
 f.ctx.loadSubmissionAttempt=async()=>{
  const store=await load();
  return {...store,readSubmissionUploadReceipt:async(...args)=>{
   const checked=await store.readSubmissionUploadReceipt(...args);
   await new Promise(done=>{resolve=done;started();});
   return checked;
  }};
 };
 const pending=f.ctx.uploadSubmission();
 await awaiting;
 f.ctx.authLoadVersionRef.current++;
 resolve();
 await pending;
 assert.equal(f.state.storageWrites.length,0);
 assert.equal(f.state.marked,0);
 assert.equal(f.state.files,f.original);
 assert.equal(f.rows.size,1);
});
await test('partial failure resumes only missing file with identical receipt and hashes',async()=>{const f=fixture();f.state.failFile=1;await f.ctx.uploadSubmission();assert.equal(f.state.files,f.original);assert.equal(f.state.marked,0);assert.equal(f.state.status['one.png'],'送信済み');assert.match(f.state.messages.at(-1),/同じ選択ファイル/);await f.ctx.uploadSubmission();assert.equal(f.receipts.size,1);assert.deepEqual(f.state.storageWrites.map(v=>v.path),[storagePath(submissionIdFor(f.state.payloads[0].clientRequestId),0),storagePath(submissionIdFor(f.state.payloads[0].clientRequestId),1),storagePath(submissionIdFor(f.state.payloads[0].clientRequestId),1)]);assert.equal(f.state.payloads[0].clientRequestId,f.state.payloads[1].clientRequestId);for(const call of f.state.storageWrites){assert.equal(call.metadata.customMetadata.lkcContentSha256,f.state.payloads[0].files[f.original.indexOf(call.file)].contentSha256);}assert.equal(f.state.files.length,0);});
await test('lost browser cleanup keeps receipt when draft transaction fails',async()=>{const f=fixture();f.state.failCleanup=true;await f.ctx.uploadSubmission();assert.equal(f.state.files.length,0);assert.equal(f.state.marked,1);assert.equal(f.rows.size,1);assert.equal(f.state.storageWrites.length,2);});
await test('completed existing uploads reach processing view without another Storage write',async()=>{const f=fixture();f.state.loseResponse=true;await f.ctx.uploadSubmission();f.uploaded.add(storagePath(submissionIdFor(f.state.payloads[0].clientRequestId),0));f.uploaded.add(storagePath(submissionIdFor(f.state.payloads[0].clientRequestId),1));await f.ctx.uploadSubmission();assert.equal(f.state.storageWrites.length,0);assert.equal(f.state.marked,1);assert.equal(f.state.files.length,0);});
await test('an older server response without matching operation ID cannot upload blindly',async()=>{const f=fixture();f.ctx.httpsCallable=()=>async()=>({data:{submissionId:'old',files:[{storagePath:'old/0'},{storagePath:'old/1'}]}});await f.ctx.uploadSubmission();assert.equal(f.state.files,f.original);assert.equal(f.state.storageWrites.length,0);assert.equal(f.state.marked,0);assert.equal(f.rows.size,1);assert.match(f.state.messages.at(-1),/提出先/);});
await test('account switch during receipt cleanup cannot clear the new account view',async()=>{const f=fixture(),load=f.ctx.loadSubmissionAttempt;f.ctx.loadSubmissionAttempt=async()=>{const module=await load();return {...module,clearSubmissionAttempt:async attempt=>{const cleared=await module.clearSubmissionAttempt(attempt);f.ctx.authLoadVersionRef.current++;return cleared;}};};await f.ctx.uploadSubmission();assert.equal(f.state.files,f.original);assert.equal(f.state.cleanup,1);assert.equal(f.state.messages.length,0);});
await test('retry of post-submit cleanup clears retained operation without uploading again',async()=>{const f=fixture();f.state.failCleanup=true;await f.ctx.uploadSubmission();assert.equal(f.rows.size,1);assert.ok(f.state.cleanupRecord.attempt);await f.ctx.retryDraftCleanup();assert.equal(f.rows.size,1);assert.ok(f.state.cleanupRecord);f.state.failCleanup=false;await f.ctx.retryDraftCleanup();assert.equal(f.rows.size,0);assert.equal(f.state.cleanupRecord,null);assert.equal(f.state.storageWrites.length,2);assert.equal(f.state.cleanup,1);});

for(const scope of ['file','submission',undefined])await test('resubmission upload honors explicit scope '+String(scope),async()=>{const f=fixture();f.ctx.requestId='request-a';f.ctx.resubmissionDetail={request:{id:'request-a',jobId:f.ctx.selectedJob.id,type:'report',status:'open',...(scope?{scope}:{})}};await f.ctx.uploadSubmission();if(scope==='submission'){assert.equal(f.state.storageWrites.length,2);assert.equal(f.state.files.length,0);assert.equal(f.state.payloads[0].purpose,'replacement');assert.equal(f.state.payloads[0].resubmissionRequestId,'request-a');}else{assert.equal(f.state.storageWrites.length,0);assert.equal(f.state.payloads.length,0);assert.equal(f.state.files,f.original);assert.match(f.state.messages.at(-1),/1ファイル/);}});


await test('mail lost response retains original displayed revision on retry',async()=>{const f=fixture();Object.assign(f.ctx.myJobs[0],{mailIntake:{receiptId:'mail'},revision:5});f.ctx.selectedJob.revision=5;f.state.loseResponse=true;await f.ctx.uploadSubmission();f.ctx.myJobs[0].revision=6;f.ctx.selectedJob.revision=6;await f.ctx.uploadSubmission();assert.equal(f.state.payloads.length,2);assert.equal(f.state.payloads[0].expectedRevision,5);assert.equal(f.state.payloads[1].expectedRevision,5);assert.equal(f.state.payloads[0].clientRequestId,f.state.payloads[1].clientRequestId);});
for(const match of ['match','accepted','id','revision','reason','date','job','type','purpose','replacement'])await test('mail rejection clears only proven unaccepted receipt '+match,async()=>{const f=fixture();Object.assign(f.ctx.myJobs[0],{mailIntake:{receiptId:'mail'},revision:5});f.ctx.selectedJob.revision=5;f.ctx.httpsCallable=()=>async payload=>{const details={reason:'submission_context_changed',accepted:false,clientRequestId:payload.clientRequestId,jobId:payload.jobId,type:payload.type,purpose:payload.purpose,resubmissionRequestId:payload.resubmissionRequestId??null,expectedDateKey:payload.expectedDateKey,expectedRevision:payload.expectedRevision};if(match==='accepted')details.accepted=true;if(match==='id')details.clientRequestId='different';if(match==='revision')details.expectedRevision=9;if(match==='reason')details.reason='unknown';if(match==='date')details.expectedDateKey='2026-12-09';if(match==='job')details.jobId='other';if(match==='type')details.type='sales_floor';if(match==='purpose')details.purpose='initial';if(match==='replacement')details.resubmissionRequestId='other';throw Object.assign(Error('synthetic changed job'),{details});};await f.ctx.uploadSubmission();assert.equal(f.rows.size,match==='match'?0:1);assert.equal(f.state.files,f.original);assert.equal(f.state.cleanup,0);assert.equal(f.state.storageWrites.length,0);});
for(const durable of [true,false])await test('receipt cleanup failure stays visible without repeating transfer; durable '+durable,async()=>{
 const f=fixture();f.state.failReceiptRemove=true;f.state.failCleanup=!durable;
 await f.ctx.uploadSubmission();
 assert.equal(f.state.files.length,0);assert.equal(f.state.confirmed,false);
 assert.equal(f.rows.size,1);assert.ok(f.state.cleanupRecord.attempt);assert.equal(Boolean(f.state.cleanupRecord.draftCleared),durable);
 assert.equal(f.state.processing.length,1);assert.match(f.state.messages.at(-1),/送信しました/);
 assert.equal(f.state.storageWrites.length,2);const originalId=f.state.payloads[0].clientRequestId;
 f.ctx.files=f.original;f.state.files=f.original;f.ctx.submissionConfirmed=true;
 await f.ctx.uploadSubmission();assert.equal(f.state.payloads.length,1);assert.equal(f.state.files,f.original);
 assert.match(f.state.messages.at(-1),/端末の後片付けを再試行/);
 await f.ctx.retryDraftCleanup();assert.equal(f.rows.size,1);assert.ok(f.state.cleanupRecord);
 assert.equal(f.state.cleanup,durable?1:0,'Keep the request ID until the draft transaction succeeds');
 f.state.failReceiptRemove=false;f.state.failCleanup=false;await f.ctx.retryDraftCleanup();
 assert.equal(f.rows.size,0);assert.equal(f.state.cleanupRecord,null);assert.equal(f.state.cleanup,1);
 assert.equal(f.state.payloads.length,1);assert.equal(f.state.storageWrites.length,2);assert.equal(f.state.files,f.original);
 await f.ctx.uploadSubmission();assert.equal(f.receipts.size,2);assert.notEqual(f.state.payloads[1].clientRequestId,originalId);
 assert.equal(f.state.storageWrites.length,4);assert.equal(f.state.files.length,0);
});
await test('reload retains accepted receipt, reports reuse, and permits a new intent only after cleanup',async()=>{
 const first=fixture();first.state.failReceiptRemove=true;await first.ctx.uploadSubmission();
 const fresh=fixture(first);fresh.state.failReceiptRemove=true;await fresh.ctx.uploadSubmission();
 assert.equal(fresh.state.payloads[0].clientRequestId,first.state.payloads[0].clientRequestId);
 assert.equal(fresh.receipts.size,1);assert.equal(fresh.state.storageWrites.length,0);
 assert.match(fresh.state.messages.at(-1),/受付済み/);assert.doesNotMatch(fresh.state.messages.at(-1),/送信しました/);
 assert.equal(fresh.state.processing[0][1],first.state.processing[0][1]);assert.ok(fresh.state.cleanupRecord);
 fresh.state.failReceiptRemove=false;await fresh.ctx.retryDraftCleanup();
 assert.equal(fresh.state.payloads.length,1);assert.equal(fresh.state.storageWrites.length,0);
 fresh.ctx.files=fresh.original;fresh.state.files=fresh.original;fresh.ctx.submissionConfirmed=true;
 await fresh.ctx.uploadSubmission();assert.equal(fresh.receipts.size,2);
 assert.notEqual(fresh.state.payloads[1].clientRequestId,first.state.payloads[0].clientRequestId);
 assert.equal(fresh.state.storageWrites.length,2);
});
await test('a newer saved draft preserves the request ID during cleanup',async()=>{
 const f=fixture();f.state.otherDraft=true;
 await f.ctx.uploadSubmission();
 assert.equal(f.rows.size,1);
 assert.equal(f.state.cleanupRecord,null);
 assert.equal(f.state.storageWrites.length,2);
 assert.match(f.state.messages.at(-1),/保存済みの下書きと提出IDは端末に残しています/);
 await f.ctx.retryDraftCleanup();
 assert.equal(f.state.payloads.length,1);
 assert.equal(f.state.cleanup,0);
});
await test('partial transfer survives a fresh module and writes only the missing object',async()=>{
 const first=fixture();first.state.failFile=1;await first.ctx.uploadSubmission();
 assert.equal(first.state.cleanupRecord,undefined);assert.equal(first.state.marked,0);
 const fresh=fixture(first);await fresh.ctx.uploadSubmission();
 assert.equal(fresh.state.payloads[0].clientRequestId,first.state.payloads[0].clientRequestId);
 assert.deepEqual(fresh.state.storageWrites.map(x=>x.path),[storagePath(submissionIdFor(first.state.payloads[0].clientRequestId),1)]);assert.equal(fresh.receipts.size,1);
 assert.equal(fresh.state.cleanupRecord,null);assert.equal(fresh.state.files.length,0);
});
for(const change of ['account','cleanup-target'])await test('late cleanup cannot dismiss a newer '+change+' recovery',async()=>{
 const f=fixture();f.state.failReceiptRemove=true;await f.ctx.uploadSubmission();f.state.failReceiptRemove=false;
 let release;const gate=new Promise(resolve=>{release=resolve;});const load=f.ctx.loadSubmissionAttempt;
 f.ctx.loadSubmissionAttempt=async()=>{const module=await load();return {...module,clearSubmissionAttempt:async attempt=>{await gate;return module.clearSubmissionAttempt(attempt);}};};
 const pending=f.ctx.retryDraftCleanup();await Promise.resolve();
 const current={key:'other-owner/job',durable:true};f.ctx.setDraftCleanup(current);
 const files=[new File(['new'],'new.png',{type:'image/png'})];f.state.files=files;
 if(change==='account')f.ctx.authLoadVersionRef.current++;
 release();await pending;assert.equal(f.state.cleanupRecord,current);assert.equal(f.state.files,files);
 assert.equal(f.state.payloads.length,1);assert.equal(f.state.storageWrites.length,2);
});
await test('cleanup retry excludes duplicate retry and upload while the lock is pending',async()=>{
 const f=fixture();f.state.failReceiptRemove=true;await f.ctx.uploadSubmission();f.state.failReceiptRemove=false;
 let release,calls=0;const gate=new Promise(resolve=>{release=resolve;});const load=f.ctx.loadSubmissionAttempt;
 f.ctx.loadSubmissionAttempt=async()=>{const module=await load();return {...module,clearSubmissionAttempt:async attempt=>{calls++;await gate;return module.clearSubmissionAttempt(attempt);}};};
 const pending=f.ctx.retryDraftCleanup();await Promise.resolve();await f.ctx.retryDraftCleanup();
 f.ctx.files=f.original;f.ctx.submissionConfirmed=true;await f.ctx.uploadSubmission();
 assert.equal(calls,1);assert.equal(f.state.payloads.length,1);release();await pending;
 assert.equal(f.state.cleanupRecord,null);assert.equal(f.state.storageWrites.length,2);
});
await test('actual recovery guidance and send control distinguish cleanup pending from another target',async()=>{
 const bannerAt=app.indexOf('{draftCleanup&&<section'),bannerEnd=app.indexOf('</section>',bannerAt)+10;
 const helpAt=app.indexOf('<p id="submission-send-help"'),helpEnd=app.indexOf('</button>',helpAt)+9;
 const pendingAt=app.indexOf('  const submissionCleanupPending='),pendingEnd=app.indexOf('\n',pendingAt);
 assert.ok(bannerAt>=0&&bannerEnd>bannerAt&&helpAt>=0&&helpEnd>helpAt&&pendingAt>=0);
 const render=(fragment,props)=>{
  const output={exports:{}};
  const js=ts.transpileModule(app.slice(pendingAt,pendingEnd)+'\nexport const tree=(<>'+fragment+'</>);',{
   fileName:'actual-cleanup-view.tsx',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},
  }).outputText;
  runInNewContext(js,{...props,exports:output.exports,require});return renderToStaticMarkup(output.exports.tree);
 };
 const props={draftKey:'owner/job',draftCleanup:{key:'owner/job',durable:true},retryDraftCleanup:()=>{},
  isPending:()=>false,submissionReadiness:null,resubmissionSendBlocked:false,submissionEditPending:false,
  files:[new File(['new'],'new.png',{type:'image/png'})],submissionConfirmed:true,submissionType:'report',
  uploadSubmission:()=>{},processingSubmission:false,requestId:'',singleFileResubmission:false};
 const banner=render(app.slice(bannerAt+15,bannerEnd),props);
 assert.match(banner,/ファイルの送信は済んでいます/);assert.match(banner,/受付記録の後片付けが完了していません/);
 assert.match(banner,/端末の後片付けを再試行/);assert.doesNotMatch(banner,/<button[^>]* disabled/);
 const help=app.slice(helpAt,helpEnd),blocked=render(help,props);
 assert.match(blocked,/新しい提出へ進んでください/);assert.match(blocked,/<button[^>]* disabled=""/);
 for(const cleanup of [null,{key:'other/job',durable:true}])assert.doesNotMatch(render(help,{...props,draftCleanup:cleanup}),/<button[^>]* disabled/);
});
await test('actual submission action guard blocks editing during cleanup lock acquisition',async()=>{
 const at=app.indexOf('  function isSubmissionActionPending()'),end=app.indexOf('\n  }',at)+4;
 assert.ok(at>=0&&end>at);const ctx={draftHydratingRef:{current:false},isPending:key=>key==='draft-cleanup',processingSubmission:false};
 runInNewContext(compile(app.slice(at,end)),ctx);assert.equal(ctx.isSubmissionActionPending(),true);
 ctx.isPending=()=>false;assert.equal(ctx.isSubmissionActionPending(),false);
});

// Supplemental cases for the display, server echo and legacy retry boundary.
await test('new submissions bind the displayed job date and revision',async()=>{
 const f=fixture();await f.ctx.uploadSubmission();
 const payload=f.state.payloads[0];
 assert.equal(payload.jobId,f.ctx.selectedJob.id);
 assert.equal(payload.expectedDateKey,f.ctx.selectedJob.dateKey);
 assert.equal(payload.expectedRevision,0);
 assert.equal(payload.receiptOnly,false);
 assert.equal(f.state.storageWrites.length,2);
});
await test('newer assigned schedule cannot be submitted from a stale displayed job',async()=>{
 const f=fixture();f.ctx.myJobs[0].dateKey='2026-12-09';await f.ctx.uploadSubmission();
 assert.equal(f.state.storageWrites.length,0);
 assert.equal(f.state.payloads.length,0);
 assert.equal(f.state.files,f.original);
 assert.equal(f.state.confirmed,false);
});
for(const field of ['jobId','dateKey','revision','missing'])await test('mismatched or old-server receipt refuses Storage / '+field,async()=>{
 const f=fixture(),original=f.ctx.httpsCallable;
 f.ctx.httpsCallable=(...args)=>async payload=>{
  const response=await original(...args)(payload);
  if(field==='missing')delete response.data.acceptedContext;
  else response.data.acceptedContext[field]='wrong';
  return response;
 };
 await f.ctx.uploadSubmission();
 assert.equal(f.state.storageWrites.length,0);
 assert.equal(f.state.files,f.original);
 assert.equal(f.rows.size,1);
});
await test('a displayed-context change while awaiting the receipt refuses every file upload',async()=>{
 const f=fixture(),original=f.ctx.httpsCallable;
 f.ctx.httpsCallable=(...args)=>async payload=>{
  const response=await original(...args)(payload);
  f.ctx.submissionConfirmationContextRef.current='new-render';
  return response;
 };
 await f.ctx.uploadSubmission();
 assert.equal(f.state.storageWrites.length,0);
 assert.equal(f.state.files,f.original);
 assert.equal(f.rows.size,1);
});
for(const accepted of [true,false])await test('legacy saved ID checks receipt only, never starts a new one / '+accepted,async()=>{
 const f=fixture();
 f.state.loseResponse=true;
 await f.ctx.uploadSubmission();
 const entry=[...f.rows][0],record=JSON.parse(entry[1]);
 delete record.expectedDateKey;
 delete record.expectedRevision;
 f.rows.set(entry[0],JSON.stringify(record));
 if(!accepted)f.receipts.clear();
 await f.ctx.uploadSubmission();
 const last=f.state.payloads.at(-1);
 assert.equal(last.receiptOnly,true);
 assert.equal(last.clientRequestId,record.clientRequestId);
 assert.equal(f.state.storageWrites.length,accepted?2:0);
 assert.equal(f.receipts.size,accepted?1:0);
 if(!accepted)assert.equal(f.rows.size,1);
});

const passed=results.filter(r=>r.passed).length;console.log(JSON.stringify({passed,total:results.length,results,scope:'actual extracted upload handler, Storage adapter, concurrency, attempt store and React cleanup view; synthetic Auth/API/Storage only'},null,2));process.exitCode=passed===results.length?0:1;
