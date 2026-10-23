import {staffStoreLoader} from './submission-store-test-loader.mjs';
import assert from 'node:assert/strict';import fs from 'node:fs';import {webcrypto,randomUUID}from'node:crypto';import{File}from'node:buffer';import{runInNewContext}from'node:vm';import ts from'typescript';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{renderToStaticMarkup}=require('react-dom/server');
const compile=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const app=fs.readFileSync('apps/staff/src/App.tsx','utf8'),start=app.indexOf('  async function uploadSubmission()'),end=app.indexOf('  async function retryDraftCleanup()',start);assert.ok(start>=0&&end>start);const upload=compile(app.slice(start,end)+app.slice(end,app.indexOf("  async function loadSubmissionHistory(",end)));
const results=[];async function test(name,run){try{await run();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.stack});}}
function fixture(retained={}){
 const files=[new File(['one'],'one.png',{type:'image/png'}),new File(['two'],'two.pdf',{type:'application/pdf'})];
 // This unit fixture retains receipts/API outcomes across reload; full IndexedDB hydration is tested in Chromium.
 const rows=retained.rows??new Map(),aux=new Map(),drafts=new Map(),uploaded=retained.uploaded??new Set(),receipts=retained.receipts??new Map();
 const state={files,processing:[],messages:[],payloads:[],storageWrites:[],status:{},cleanup:0,marked:0};
 const recordMap=k=>k.startsWith('lkc.submit.g2:attempt.v1:')?rows:aux;
 const localStorage={get length(){return rows.size+aux.size;},key:i=>[...rows.keys(),...aux.keys()][i]??null,getItem:k=>recordMap(k).get(k)??null,
  setItem:(k,v)=>{if(state.failReceiptStorage&&k.startsWith('lkc.submit.g2:submitted:'))throw Error('synthetic marker failure');recordMap(k).set(k,v);},
  removeItem:k=>{if(state.failReceiptRemove&&k.startsWith('lkc.submit.g2:attempt.v1:'))throw Error('synthetic receipt cleanup failure');recordMap(k).delete(k);}};
 const globals={crypto:{subtle:webcrypto.subtle,randomUUID},Uint8Array,TextEncoder,location:{hostname:'127.0.0.1'},localStorage,
  navigator:{locks:{request:async(key,_opts,fn)=>fn({name:key})}}};
 let load;
 const draftPort={saveDraft:async(key,selected)=>drafts.set(key,selected),loadDraft:async key=>drafts.get(key)??[],readStoredDraftFiles:async key=>drafts.get(key)??[],hasStoredDraft:async key=>Boolean(drafts.get(key)?.length),
  clearDraft:async key=>{if(state.failCleanup)throw Error('synthetic cleanup failure');drafts.delete(key);const markers=load('submitted-marker-store');localStorage.removeItem(markers.receiptKey(key));markers.submittedDrafts.delete(key);state.cleanup++;},
  confirmDraftCleanupComplete:async(key,current)=>current()&&!drafts.has(key)&&localStorage.getItem(load('submitted-marker-store').receiptKey(key))===null&&!await load('submitted-binding-store').hasSubmittedBindings(key)};
 load=staffStoreLoader(globals,{'draft-store':draftPort});const adapter=load('cooperative-submission-store'),raw=load('submission-attempt-store'),markers=load('submitted-marker-store');
 const marked=adapter.markDraftSubmitted;adapter.markDraftSubmitted=(...args)=>{state.marked++;return marked(...args);};
 const concurrency=load('concurrency');
 const ctx={...adapter,loadDraftStore:async()=>adapter,loadSubmittedBindings:async()=>adapter,loadSubmissionAttempt:async()=>adapter,
  getSubmittedDraftReceipt:markers.getSubmittedDraftReceipt,previewContextRef:{current:'company/user/job/report'},files,draftCleanup:null,submissionConfirmed:true,
  isSubmissionActionPending:()=>state.pending,isPending:()=>state.pending,MAX_SUBMISSION_FILE_SIZE:50*1024*1024,UPLOAD_CONCURRENCY:2,
  selectedJob:{id:'job',dateKey:'2026-10-24',revision:0},myJobs:[],requestId:'',submissionType:'report',firebaseConfigured:true,functions:{},firebaseApp:{},draftKey:'company/user/job/report',authLoadVersionRef:{current:1},
  submissionFileContentType:f=>f.type,fileStateKey:f=>f.name,showSubmissionMessage:m=>state.messages.push(m),setSubmissionMessage:()=>{},
  setUploadState:v=>state.status=typeof v==='function'?v(state.status):v,setFiles:v=>state.files=v,setSubmissionConfirmed:v=>state.confirmed=v,
  setDraftCleanup:v=>{state.cleanupRecord=typeof v==='function'?v(state.cleanupRecord):v;ctx.draftCleanup=state.cleanupRecord;if(state.cleanupRecord?.attempt)state.completedAttempt=state.cleanupRecord.attempt;},
  skipNextDraftSaveRef:{current:false},pollSubmissionProcessing:async(...args)=>state.processing.push(args),runWithConcurrency:concurrency.runWithConcurrency,
  run:async(_key,fn,options)=>{state.pending=true;try{await fn();}catch(e){options?.setMessage?.(e.message);throw e;}finally{state.pending=false;}},
  httpsCallable:(_api,name)=>{assert.equal(name,'createUploadSession');return async payload=>{state.payloads.push(payload);const id=receipts.get(payload.clientRequestId)??'submission-'+receipts.size;receipts.set(payload.clientRequestId,id);if(state.loseResponse){state.loseResponse=false;throw Error('synthetic lost response');}return{data:{submissionId:id,clientRequestId:payload.clientRequestId,files:payload.files.map((f,i)=>({storagePath:id+'/'+i,uploadRequired:!uploaded.has(id+'/'+i)}))}};}},
  loadUploadStorage:async()=>({getClientStorage:()=>({}),ref:(_s,p)=>p,uploadBytesResumable:(p,file,metadata)=>({on:(_event,_progress,reject,resolve)=>{state.storageWrites.push({path:p,file,metadata});if(state.failFile===p){state.failFile=null;reject(Error('synthetic offline'));}else{assert.equal(uploaded.has(p),false,'must not overwrite an existing create-only object');uploaded.add(p);resolve();}}})})};
 ctx.myJobs=[ctx.selectedJob];runInNewContext(upload,ctx);return{ctx,state,rows,receipts,uploaded,original:files,adapter,raw};
}
await test('lost receipt response reuses operation ID and keeps files until upload succeeds',async()=>{const f=fixture();f.state.loseResponse=true;await f.ctx.uploadSubmission();assert.equal(f.state.storageWrites.length,0);assert.equal(f.state.files,f.original);assert.equal(f.rows.size,1);await f.ctx.uploadSubmission();assert.equal(f.state.payloads[0].clientRequestId,f.state.payloads[1].clientRequestId);assert.equal(f.receipts.size,1);assert.equal(f.state.storageWrites.length,2);assert.equal(f.state.files.length,0);assert.equal(f.rows.size,0);assert.equal(f.state.cleanup,1);});
await test('partial failure resumes only missing file with identical receipt and hashes',async()=>{const f=fixture();f.state.failFile='submission-0/1';await f.ctx.uploadSubmission();assert.equal(f.state.files,f.original);assert.equal(f.state.marked,0);assert.equal(f.state.status['one.png'],'送信済み');assert.match(f.state.messages.at(-1),/同じ選択ファイル/);await f.ctx.uploadSubmission();assert.equal(f.receipts.size,1);assert.deepEqual(f.state.storageWrites.map(v=>v.path),['submission-0/0','submission-0/1','submission-0/1']);assert.equal(f.state.payloads[0].clientRequestId,f.state.payloads[1].clientRequestId);for(const call of f.state.storageWrites){assert.equal(call.metadata.customMetadata.lkcContentSha256,f.state.payloads[0].files[f.original.indexOf(call.file)].contentSha256);}assert.equal(f.state.files.length,0);});
await test('lost browser cleanup keeps receipt when durable submitted marker is unavailable',async()=>{const f=fixture();f.state.failReceiptStorage=true;f.state.failCleanup=true;await f.ctx.uploadSubmission();assert.equal(f.state.files.length,0);assert.equal(f.state.marked,1);assert.equal(f.rows.size,1);assert.equal(f.state.storageWrites.length,2);});
await test('completed existing uploads reach processing view without another Storage write',async()=>{const f=fixture();f.state.loseResponse=true;await f.ctx.uploadSubmission();f.uploaded.add('submission-0/0');f.uploaded.add('submission-0/1');await f.ctx.uploadSubmission();assert.equal(f.state.storageWrites.length,0);assert.equal(f.state.marked,1);assert.equal(f.state.files.length,0);});
await test('an older server response without matching operation ID cannot upload blindly',async()=>{const f=fixture();f.ctx.httpsCallable=()=>async()=>({data:{submissionId:'old',files:[{storagePath:'old/0'},{storagePath:'old/1'}]}});await f.ctx.uploadSubmission();assert.equal(f.state.files,f.original);assert.equal(f.state.storageWrites.length,0);assert.equal(f.state.marked,0);assert.equal(f.rows.size,1);assert.match(f.state.messages.at(-1),/送信先/);});
await test('account switch during receipt cleanup cannot clear the new account view',async()=>{const f=fixture(),clear=f.raw.clearSubmissionAttempt;f.raw.clearSubmissionAttempt=async(...args)=>{const cleared=await clear(...args);f.ctx.authLoadVersionRef.current++;return cleared;};await f.ctx.uploadSubmission();assert.equal(f.state.files,f.original);assert.equal(f.state.cleanup,0);assert.equal(f.state.messages.length,0);});
await test('missing durable marker remains stopped even when the screen remembers the completed receipt',async()=>{const f=fixture();f.state.failReceiptStorage=true;f.state.failCleanup=true;await f.ctx.uploadSubmission();assert.equal(f.rows.size,1);assert.ok(f.state.cleanupRecord.attempt);await f.ctx.retryDraftCleanup();assert.equal(f.rows.size,1);assert.ok(f.state.cleanupRecord);f.state.failCleanup=false;f.state.failReceiptStorage=false;await f.ctx.retryDraftCleanup();assert.equal(f.rows.size,1);assert.ok(f.state.cleanupRecord.unverified);assert.equal(f.state.storageWrites.length,2);assert.equal(f.state.cleanup,0);});

for(const scope of ['file','submission',undefined])await test('resubmission upload honors explicit scope '+String(scope),async()=>{const f=fixture();f.ctx.requestId='request-a';f.ctx.resubmissionDetail={request:{id:'request-a',jobId:f.ctx.selectedJob.id,type:'report',status:'open',...(scope?{scope}:{})}};await f.ctx.uploadSubmission();if(scope==='submission'){assert.equal(f.state.storageWrites.length,2);assert.equal(f.state.files.length,0);assert.equal(f.state.payloads[0].purpose,'replacement');assert.equal(f.state.payloads[0].resubmissionRequestId,'request-a');}else{assert.equal(f.state.storageWrites.length,0);assert.equal(f.state.payloads.length,0);assert.equal(f.state.files,f.original);assert.match(f.state.messages.at(-1),/1ファイル/);}});


await test('mail lost response retains original displayed revision on retry',async()=>{const f=fixture();Object.assign(f.ctx.myJobs[0],{mailIntake:{receiptId:'mail'},revision:5});f.state.loseResponse=true;await f.ctx.uploadSubmission();f.ctx.myJobs[0].revision=6;await f.ctx.uploadSubmission();assert.equal(f.state.payloads.length,2);assert.equal(f.state.payloads[0].expectedRevision,5);assert.equal(f.state.payloads[1].expectedRevision,5);assert.equal(f.state.payloads[0].clientRequestId,f.state.payloads[1].clientRequestId);});
for(const match of ['match','accepted','id','revision','reason'])await test('mail rejection clears only proven unaccepted receipt '+match,async()=>{const f=fixture();Object.assign(f.ctx.myJobs[0],{mailIntake:{receiptId:'mail'},revision:5});f.ctx.httpsCallable=()=>async payload=>{const details={reason:'submission_context_changed',accepted:false,clientRequestId:payload.clientRequestId,expectedRevision:payload.expectedRevision,expectedDateKey:payload.expectedDateKey,jobId:payload.jobId,type:payload.type,purpose:payload.purpose,resubmissionRequestId:payload.resubmissionRequestId??null};if(match==='accepted')details.accepted=true;if(match==='id')details.clientRequestId='different';if(match==='revision')details.expectedRevision=9;if(match==='reason')details.reason='unknown';throw Object.assign(Error('synthetic changed job'),{details});};await f.ctx.uploadSubmission();assert.equal(f.rows.size,match==='match'?0:1);assert.equal(f.state.files,f.original);assert.equal(f.state.cleanup,0);assert.equal(f.state.storageWrites.length,0);});
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
 if(!durable){assert.equal(f.rows.size,1);assert.ok(f.state.cleanupRecord.unverified);assert.equal(f.state.cleanup,0);assert.equal(f.state.payloads.length,1);assert.equal(f.state.storageWrites.length,2);return;}
 assert.equal(f.rows.size,0);assert.equal(f.state.cleanupRecord,null);assert.equal(f.state.cleanup,1);
 assert.equal(f.state.payloads.length,1);assert.equal(f.state.storageWrites.length,2);assert.equal(f.state.files,f.original);
 await f.ctx.uploadSubmission();assert.equal(f.receipts.size,2);assert.notEqual(f.state.payloads[1].clientRequestId,originalId);
 assert.equal(f.state.storageWrites.length,4);assert.equal(f.state.files.length,0);
});
await test('receipt-boundary retry retains accepted ID; a new intent requires confirmed shared absence and cleanup',async()=>{
 const first=fixture();first.state.failReceiptRemove=true;await first.ctx.uploadSubmission();
 const fresh=fixture(first);fresh.state.failReceiptRemove=true;await fresh.ctx.uploadSubmission();
 assert.equal(fresh.state.payloads[0].clientRequestId,first.state.payloads[0].clientRequestId);
 assert.equal(fresh.receipts.size,1);assert.equal(fresh.state.storageWrites.length,0);
 assert.match(fresh.state.messages.at(-1),/受付済み/);assert.doesNotMatch(fresh.state.messages.at(-1),/送信しました/);
 assert.equal(fresh.state.processing[0][1],first.state.processing[0][1]);assert.ok(fresh.state.cleanupRecord);
 fresh.state.failReceiptRemove=false;fresh.state.sharedAbsent=true;await fresh.ctx.retryDraftCleanup();
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
 const f=fixture();f.state.failReceiptRemove=true;await f.ctx.uploadSubmission();f.state.failReceiptRemove=false;f.state.sharedAbsent=true;
 let release;const gate=new Promise(resolve=>{release=resolve;});const clear=f.raw.clearSubmissionAttempt;
 f.raw.clearSubmissionAttempt=async(...args)=>{await gate;return clear(...args);};
 const pending=f.ctx.retryDraftCleanup();await Promise.resolve();
 const current={key:'other-owner/job',durable:true};f.ctx.setDraftCleanup(current);
 const files=[new File(['new'],'new.png',{type:'image/png'})];f.state.files=files;
 if(change==='account')f.ctx.authLoadVersionRef.current++;
 release();await pending;assert.equal(f.state.cleanupRecord,current);assert.equal(f.state.files,files);
 assert.equal(f.state.payloads.length,1);assert.equal(f.state.storageWrites.length,2);
});
await test('cleanup retry excludes duplicate retry and upload while the lock is pending',async()=>{
 const f=fixture();f.state.failReceiptRemove=true;await f.ctx.uploadSubmission();f.state.failReceiptRemove=false;f.state.sharedAbsent=true;
 let release,calls=0;const gate=new Promise(resolve=>{release=resolve;});const clear=f.raw.clearSubmissionAttempt;
 f.raw.clearSubmissionAttempt=async(...args)=>{calls++;await gate;return clear(...args);};
 const pending=f.ctx.retryDraftCleanup();while(calls===0)await new Promise(resolve=>setImmediate(resolve));await f.ctx.retryDraftCleanup();
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
