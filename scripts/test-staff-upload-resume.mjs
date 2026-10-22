import assert from 'node:assert/strict';import fs from 'node:fs';import {webcrypto,randomUUID}from'node:crypto';import{File}from'node:buffer';import{runInNewContext}from'node:vm';import ts from'typescript';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{renderToStaticMarkup}=require('react-dom/server');
const compile=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const app=fs.readFileSync('apps/staff/src/App.tsx','utf8'),start=app.indexOf('  async function uploadSubmission()'),end=app.indexOf('  async function retryDraftCleanup()',start);assert.ok(start>=0&&end>start);const upload=compile(app.slice(start,end)+app.slice(end,app.indexOf("  async function loadSubmissionHistory(",end)));
const results=[];async function test(name,run){try{await run();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.stack});}}
function fixture(retained={}){const files=[new File(['one'],'one.png',{type:'image/png'}),new File(['two'],'two.pdf',{type:'application/pdf'})],rows=retained.rows??new Map(),uploaded=retained.uploaded??new Set(),receipts=retained.receipts??new Map(),state={files,processing:[],messages:[],payloads:[],storageWrites:[],status:{},cleanup:0,marked:0};const attemptScope={exports:{},crypto:{subtle:webcrypto.subtle,randomUUID},Uint8Array,TextEncoder,navigator:{locks:{request:async(_key,_opts,fn)=>fn({})}},localStorage:{getItem:k=>rows.get(k)??null,setItem:(k,v)=>rows.set(k,v),removeItem:k=>{if(state.failReceiptRemove)throw Error("synthetic receipt cleanup failure");rows.delete(k)}}};runInNewContext(compile(fs.readFileSync('apps/staff/src/submission-attempt-store.ts','utf8')),attemptScope);const concurrency={exports:{}};runInNewContext(compile(fs.readFileSync('apps/staff/src/concurrency.ts','utf8')),concurrency);
 const ctx={files,draftCleanup:null,submissionConfirmed:true,isSubmissionActionPending:()=>state.pending,isPending:()=>state.pending,MAX_SUBMISSION_FILE_SIZE:50*1024*1024,UPLOAD_CONCURRENCY:2,selectedJob:{id:'job'},myJobs:[{id:'job'}],requestId:'',submissionType:'report',firebaseConfigured:true,functions:{},firebaseApp:{},draftKey:'company/user/job/report',authLoadVersionRef:{current:1},loadSubmissionAttempt:async()=>attemptScope.exports,submissionFileContentType:f=>f.type,fileStateKey:f=>f.name,showSubmissionMessage:m=>state.messages.push(m),setSubmissionMessage:()=>{},setUploadState:v=>state.status=typeof v==='function'?v(state.status):v,setFiles:v=>state.files=v,setSubmissionConfirmed:v=>state.confirmed=v,setDraftCleanup:v=>{state.cleanupRecord=typeof v==="function"?v(state.cleanupRecord):v;ctx.draftCleanup=state.cleanupRecord;},skipNextDraftSaveRef:{current:false},markDraftSubmitted:()=>{state.marked++;return !state.failReceiptStorage;},clearDraft:async()=>{if(state.failCleanup)throw Error('synthetic cleanup failure');state.cleanup++;},pollSubmissionProcessing:async(...args)=>state.processing.push(args),runWithConcurrency:concurrency.exports.runWithConcurrency,run:async(_key,fn,options)=>{state.pending=true;try{await fn();}catch(e){options?.setMessage?.(e.message);throw e;}finally{state.pending=false;}},httpsCallable:(_api,name)=>{assert.equal(name,'createUploadSession');return async payload=>{state.payloads.push(payload);const id=receipts.get(payload.clientRequestId)??'submission-'+receipts.size;receipts.set(payload.clientRequestId,id);if(state.loseResponse){state.loseResponse=false;throw Error('synthetic lost response');}return{data:{submissionId:id,clientRequestId:payload.clientRequestId,files:payload.files.map((f,i)=>({storagePath:id+'/'+i,uploadRequired:!uploaded.has(id+'/'+i)}))}};}},loadUploadStorage:async()=>({getClientStorage:()=>({}),ref:(_s,p)=>p,uploadBytesResumable:(p,file,metadata)=>({on:(_event,_progress,reject,resolve)=>{state.storageWrites.push({path:p,file,metadata});if(state.failFile===p){state.failFile=null;reject(Error('synthetic offline'));}else{assert.equal(uploaded.has(p),false,'must not overwrite an existing create-only object');uploaded.add(p);resolve();}}})})};runInNewContext(upload,ctx);return{ctx,state,rows,receipts,uploaded,original:files};}
await test('lost receipt response reuses operation ID and keeps files until upload succeeds',async()=>{const f=fixture();f.state.loseResponse=true;await f.ctx.uploadSubmission();assert.equal(f.state.storageWrites.length,0);assert.equal(f.state.files,f.original);assert.equal(f.rows.size,1);await f.ctx.uploadSubmission();assert.equal(f.state.payloads[0].clientRequestId,f.state.payloads[1].clientRequestId);assert.equal(f.receipts.size,1);assert.equal(f.state.storageWrites.length,2);assert.equal(f.state.files.length,0);assert.equal(f.rows.size,0);assert.equal(f.state.cleanup,1);});
await test('partial failure resumes only missing file with identical receipt and hashes',async()=>{const f=fixture();f.state.failFile='submission-0/1';await f.ctx.uploadSubmission();assert.equal(f.state.files,f.original);assert.equal(f.state.marked,0);assert.equal(f.state.status['one.png'],'送信済み');assert.match(f.state.messages.at(-1),/同じ選択ファイル/);await f.ctx.uploadSubmission();assert.equal(f.receipts.size,1);assert.deepEqual(f.state.storageWrites.map(v=>v.path),['submission-0/0','submission-0/1','submission-0/1']);assert.equal(f.state.payloads[0].clientRequestId,f.state.payloads[1].clientRequestId);for(const call of f.state.storageWrites){assert.equal(call.metadata.customMetadata.lkcContentSha256,f.state.payloads[0].files[f.original.indexOf(call.file)].contentSha256);}assert.equal(f.state.files.length,0);});
await test('lost browser cleanup keeps receipt when durable submitted marker is unavailable',async()=>{const f=fixture();f.state.failReceiptStorage=true;f.state.failCleanup=true;await f.ctx.uploadSubmission();assert.equal(f.state.files.length,0);assert.equal(f.state.marked,1);assert.equal(f.rows.size,1);assert.equal(f.state.storageWrites.length,2);});
await test('completed existing uploads reach processing view without another Storage write',async()=>{const f=fixture();f.state.loseResponse=true;await f.ctx.uploadSubmission();f.uploaded.add('submission-0/0');f.uploaded.add('submission-0/1');await f.ctx.uploadSubmission();assert.equal(f.state.storageWrites.length,0);assert.equal(f.state.marked,1);assert.equal(f.state.files.length,0);});
await test('an older server response without matching operation ID cannot upload blindly',async()=>{const f=fixture();f.ctx.httpsCallable=()=>async()=>({data:{submissionId:'old',files:[{storagePath:'old/0'},{storagePath:'old/1'}]}});await f.ctx.uploadSubmission();assert.equal(f.state.files,f.original);assert.equal(f.state.storageWrites.length,0);assert.equal(f.state.marked,0);assert.equal(f.rows.size,1);assert.match(f.state.messages.at(-1),/送信先/);});
await test('account switch during receipt cleanup cannot clear the new account view',async()=>{const f=fixture(),load=f.ctx.loadSubmissionAttempt;f.ctx.loadSubmissionAttempt=async()=>{const module=await load();return {...module,clearSubmissionAttempt:async attempt=>{const cleared=await module.clearSubmissionAttempt(attempt);f.ctx.authLoadVersionRef.current++;return cleared;}};};await f.ctx.uploadSubmission();assert.equal(f.state.files,f.original);assert.equal(f.state.cleanup,0);assert.equal(f.state.messages.length,0);});
await test('retry of post-submit cleanup clears retained operation without uploading again',async()=>{const f=fixture();f.state.failReceiptStorage=true;f.state.failCleanup=true;await f.ctx.uploadSubmission();assert.equal(f.rows.size,1);assert.ok(f.state.cleanupRecord.attempt);await f.ctx.retryDraftCleanup();assert.equal(f.rows.size,1);assert.ok(f.state.cleanupRecord);f.state.failCleanup=false;f.state.failReceiptStorage=false;await f.ctx.retryDraftCleanup();assert.equal(f.rows.size,0);assert.equal(f.state.cleanupRecord,null);assert.equal(f.state.storageWrites.length,2);assert.equal(f.state.cleanup,1);});

for(const scope of ['file','submission',undefined])await test('resubmission upload honors explicit scope '+String(scope),async()=>{const f=fixture();f.ctx.requestId='request-a';f.ctx.resubmissionDetail={request:{id:'request-a',jobId:f.ctx.selectedJob.id,type:'report',status:'open',...(scope?{scope}:{})}};await f.ctx.uploadSubmission();if(scope==='submission'){assert.equal(f.state.storageWrites.length,2);assert.equal(f.state.files.length,0);assert.equal(f.state.payloads[0].purpose,'replacement');assert.equal(f.state.payloads[0].resubmissionRequestId,'request-a');}else{assert.equal(f.state.storageWrites.length,0);assert.equal(f.state.payloads.length,0);assert.equal(f.state.files,f.original);assert.match(f.state.messages.at(-1),/1ファイル/);}});


await test('mail lost response retains original displayed revision on retry',async()=>{const f=fixture();Object.assign(f.ctx.myJobs[0],{mailIntake:{receiptId:'mail'},revision:5});f.state.loseResponse=true;await f.ctx.uploadSubmission();f.ctx.myJobs[0].revision=6;await f.ctx.uploadSubmission();assert.equal(f.state.payloads.length,2);assert.equal(f.state.payloads[0].expectedRevision,5);assert.equal(f.state.payloads[1].expectedRevision,5);assert.equal(f.state.payloads[0].clientRequestId,f.state.payloads[1].clientRequestId);});
for(const match of ['match','accepted','id','revision','reason'])await test('mail rejection clears only proven unaccepted receipt '+match,async()=>{const f=fixture();Object.assign(f.ctx.myJobs[0],{mailIntake:{receiptId:'mail'},revision:5});f.ctx.httpsCallable=()=>async payload=>{const details={reason:'case_mail_submission_changed',accepted:false,clientRequestId:payload.clientRequestId,expectedRevision:payload.expectedRevision};if(match==='accepted')details.accepted=true;if(match==='id')details.clientRequestId='different';if(match==='revision')details.expectedRevision=9;if(match==='reason')details.reason='unknown';throw Object.assign(Error('synthetic changed job'),{details});};await f.ctx.uploadSubmission();assert.equal(f.rows.size,match==='match'?0:1);assert.equal(f.state.files,f.original);assert.equal(f.state.cleanup,0);assert.equal(f.state.storageWrites.length,0);});
for(const durable of [true,false])await test('receipt cleanup failure stays visible without repeating transfer; durable '+durable,async()=>{
 const f=fixture();f.state.failReceiptRemove=true;f.state.failReceiptStorage=!durable;
 await f.ctx.uploadSubmission();
 assert.equal(f.state.files.length,0);assert.equal(f.state.confirmed,false);
 assert.equal(f.rows.size,1);assert.ok(f.state.cleanupRecord.attempt);assert.equal(Boolean(f.state.cleanupRecord.draftCleared),false);
 assert.equal(f.state.processing.length,1);assert.match(f.state.messages.at(-1),/送信しました/);
 assert.equal(f.state.storageWrites.length,2);const originalId=f.state.payloads[0].clientRequestId;
 f.ctx.files=f.original;f.state.files=f.original;f.ctx.submissionConfirmed=true;
 await f.ctx.uploadSubmission();assert.equal(f.state.payloads.length,1);assert.equal(f.state.files,f.original);
 assert.match(f.state.messages.at(-1),/端末の後片付けを再試行/);
 await f.ctx.retryDraftCleanup();assert.equal(f.rows.size,1);assert.ok(f.state.cleanupRecord);
 assert.equal(f.state.cleanup,0,'Retain the original draft until its receipt is confirmed absent');
 f.state.failReceiptRemove=false;f.state.failReceiptStorage=false;await f.ctx.retryDraftCleanup();
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
await test('partial transfer survives a fresh module and writes only the missing object',async()=>{
 const first=fixture();first.state.failFile='submission-0/1';await first.ctx.uploadSubmission();
 assert.equal(first.state.cleanupRecord,undefined);assert.equal(first.state.marked,0);
 const fresh=fixture(first);await fresh.ctx.uploadSubmission();
 assert.equal(fresh.state.payloads[0].clientRequestId,first.state.payloads[0].clientRequestId);
 assert.deepEqual(fresh.state.storageWrites.map(x=>x.path),['submission-0/1']);assert.equal(fresh.receipts.size,1);
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
const passed=results.filter(r=>r.passed).length;console.log(JSON.stringify({passed,total:results.length,results,scope:'actual extracted upload handler, concurrency, attempt store and React cleanup view; synthetic API/Storage only'},null,2));process.exitCode=passed===results.length?0:1;
