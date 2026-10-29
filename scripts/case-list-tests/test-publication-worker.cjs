'use strict';
// Actual queue continuation + shared native adapter + actual plan/finalizer.
// All Firestore/Google boundaries are the existing recording synthetic fakes.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const H=require('./test-worker-binding.cjs'),{buildWorkerCompactSnapshot}=require('./worker-compact-fixture.cjs');
const helper=H.load('case-list-source-core'),core=H.load('case-list-publication-core'),worker=H.load('case-list-publication-worker');
const Controller=require('../../functions/src/case-list-monthly-controller.cjs');
const sha=text=>crypto.createHash('sha256').update(text).digest('hex'),literal=value=>({userEnteredValue:{stringValue:value},effectiveValue:{stringValue:value}});
process.env.LKC_SHEET_WRITE_MODE='active';process.env.LKC_CASE_LIST_PUBLICATION_MODE='active';
async function setup(options={}){
 const h=H.journey(options),f=h.f,records=H.documents,cells=h.cells;
 cells[55]=literal('確認待ち');cells[56]={};cells[62]=literal(JSON.stringify({schema:'LKCM1_CASE_META_V1',publicEligible:true,headcountConfirmed:true,issues:[]}));cells[64]={};
 const source=h.catalog(),job=records.get('jobs/'+f.jobId);
 for(const key of ['assignedStaffId','assignedStaffName','assignedUid','assignmentSheetWrite','applicationUnconfirmed','caseListPublication','publicPayOffer'])delete job[key];
 Object.assign(job,{revision:4,status:'draft',publishable:false,recruitmentStopped:true,sourceReady:false,caseListSource:helper.publicCaseListSource(source)});
 records.delete('sheetSyncQueue/'+f.queueId);records.delete('caseListApprovals/'+f.jobId);records.delete(`staffDayLocks/${f.companyId}_${f.staffId}_${f.a.dateKey}`);
 records.set(`companies/${f.companyId}/sheetMappings/shift`,{enabled:true,spreadsheetId:f.book});
 const ledger=[[],[],helper.LEDGER_HEADERS.map(literal),Array.from({length:25},()=>({}))];for(const [i,text]of [[0,f.a.sourceCaseId],[8,'未手配'],[19,JSON.stringify({schema:'LK_HISTORY_CORE_SNAPSHOT_V1',caseId:f.a.sourceCaseId,monthly:null})]])ledger[3][i]=literal(text);
 const snapshot=buildWorkerCompactSnapshot({book:f.book,caseId:f.a.sourceCaseId,sourceHeader:Controller.SOURCE_HEADERS,sourceCells:cells,ledger,month:h.month});
 const confirmation={expectedSourceRevision:source.sourceRevision,confirmedRegion:'通常',confirmedFields:{arrival:true,execution:true,headcount:true,dateMode:true,payOffer:true,vacancy:true},payOffer:{dailyWageJPY:10000,travelExpenses:'全額支給',communicationExpenses:'全額支給'}};
 const plan=core.prepareCaseListPublicationPlan({snapshot,companyId:f.companyId,jobId:f.jobId,job,confirmation,expectedJobRevision:4,expectedSourceRevision:source.sourceRevision,nowISO:new Date().toISOString()});
 const queueId='publication_fixture',now=Date.now(),capture={schema:'LK_CASE_LIST_PUBLICATION_CAPTURE_V1',companyId:f.companyId,jobId:f.jobId,queueId,actorUid:'owner_fixture',caseId:f.a.sourceCaseId,source:helper.publicCaseListSource(source),beforeJobRevision:4,queuedJobRevision:5,confirmedRegion:'通常',confirmation,conditionsHash:helper.hashCaseList(confirmation),ownerPolicyHash:core.ownerPublicationPolicyHash(process.env.EXECUTIVE_APPROVER_EMAILS||''),createdAtMs:now,expiresAtMs:now+600000,reviewPlanHash:plan.reviewPlanHash,requestKey:plan.reviewPlanHash};
 Object.assign(job,{revision:5,caseListPublicationWrite:{queueId,intentHash:helper.hashCaseList(capture),pending:true,state:'AWAITING_SOURCE_ACK'}});
 const queue={companyId:f.companyId,jobId:f.jobId,operation:'case_list.publish',actorUid:'owner_fixture',caseListPublication:H.copy(capture),updates:{},expected:{},styles:{},idempotencyKey:`case_list.publish:${f.jobId}:${plan.reviewPlanHash}`,status:'processing',claimToken:'publication_claim',retryAt:H.Stamp.fromMillis(Date.now()+600000)};
 const queueRef=new H.Doc('sheetSyncQueue/'+queueId),opPath='caseListMonthlyOperations/'+sha(f.companyId+'|'+queueId);
 records.set(queueRef.path,queue);records.set(opPath,{schema:'LK_CASE_LIST_PUBLICATION_OPERATION_V1',companyId:f.companyId,jobId:f.jobId,queueId,captureHash:helper.hashCaseList(capture),status:'queued'});
 records.set(opPath+'/events/REQUESTED',{companyId:f.companyId,queueId,payload:H.copy(capture),payloadHash:helper.hashCaseList(capture)});
 const before=H.copy(cells);let batches=0;
 H.setNativeHandler(async(body,config)=>{
  batches++;assert.equal(body.spreadsheetId,f.book);assert.equal(body.requestBody.requests.length,1);assert.equal(config.retry,false);assert.equal(config.retryConfig.retry,0);assert.equal(config.retryConfig.noResponseRetries,0);assert.deepEqual([...config.retryConfig.httpMethodsToRetry],[]);
  assert.ok(records.has(opPath+'/events/WRITE_STARTED'),'immutable dispatch exists before POST');
  const request=body.requestBody.requests[0].updateCells;assert.equal(request.fields,'userEnteredValue');assert.equal(request.range.sheetId,2026101601);assert.equal(request.range.startColumnIndex,55);assert.equal(request.range.endColumnIndex,57);assert.equal(request.range.endRowIndex-request.range.startRowIndex,1);
  if(options.noEffectLoss)throw Error('SYNTHETIC_RESPONSE_UNKNOWN');
  for(let i=0;i<2;i++){const cell=cells[55+i];cell.userEnteredValue=H.copy(request.rows[0].values[i].userEnteredValue);cell.effectiveValue=H.copy(cell.userEnteredValue);}
  if(options.afterNative)options.afterNative(h,records);
  if(options.ackLoss)throw Error('SYNTHETIC_ACK_LOSS');return{};
 });
 return{h,f,records,job,queue,queueRef,opPath,capture,plan,snapshot,before,batches:()=>batches,run:()=>worker.processCaseListPublication(queueRef,H.copy(queue)),reconcile:()=>worker.processCaseListPublication(queueRef,undefined,{actorUid:'owner_fixture',token:{uid:'owner_fixture',companyId:f.companyId,role:'admin',email:'owner@example.invalid',email_verified:true}})};
}
// Simulate a valid physical monthly insertion by another operator. Source
// and ledger stay untouched; the native compact index must discover this ID.
function addPhysicalMonthlyTarget({month,f}) {
 const width=month.headers.length,existing=month.rows.find(row=>row.row===2),total=month.rows.find(row=>row.row===3);
 const inserted={row:3,fixedId:f.a.sourceCaseId,cells:H.copy(existing.cells)};
 inserted.cells[width-1]=literal(f.a.sourceCaseId);
 for(const row of month.rows)if(row.row>=3)row.row++;
 total.cells[1]={userEnteredValue:{formulaValue:'="（"&(COUNTIF($A$2:$A$4, A4)-1)&"人）"'},effectiveValue:{stringValue:'（2人）'}};
 month.rows.push(inserted);month.rows.sort((a,b)=>a.row-b.row);month.rowCount++;
 return inserted;
}
function physicalMonthlyCapability(c) {
 const observed=buildWorkerCompactSnapshot({book:c.f.book,caseId:c.f.a.sourceCaseId,sourceHeader:Controller.SOURCE_HEADERS,sourceCells:c.h.cells,ledger:c.snapshot.rawLedgerRows,month:c.h.month});
 return Controller.transferCapability(observed,observed.source.rows.find(row=>row.caseId===c.f.a.sourceCaseId));
}
// A complete second generation, planned by the actual core against the same
// native preimage after a simulated revoke/review revision. This is not merely
// a fake pointer mismatch: B has its own valid capture, queue and private proof.
function installFreshGenerationB(c,{ownLease=false}={}) {
 const jobPath='jobs/'+c.f.jobId,base={...H.copy(c.records.get(jobPath)),revision:c.capture.queuedJobRevision+1,caseListPublicationWrite:null};
 const plan=core.prepareCaseListPublicationPlan({snapshot:c.snapshot,companyId:c.f.companyId,jobId:c.f.jobId,job:base,confirmation:c.capture.confirmation,expectedJobRevision:base.revision,expectedSourceRevision:c.capture.source.sourceRevision,nowISO:new Date().toISOString()});
 const queueId='publication_fixture_generation_b',now=Date.now(),capture={...H.copy(c.capture),queueId,beforeJobRevision:base.revision,queuedJobRevision:base.revision+1,reviewPlanHash:plan.reviewPlanHash,requestKey:plan.reviewPlanHash,createdAtMs:now,expiresAtMs:now+600000};
 const captureHash=helper.hashCaseList(capture),queuePath='sheetSyncQueue/'+queueId,opPath='caseListMonthlyOperations/'+sha(c.f.companyId+'|'+queueId);
 c.records.set(jobPath,{...base,revision:capture.queuedJobRevision,caseListPublicationWrite:{queueId,intentHash:captureHash,pending:true,state:'AWAITING_SOURCE_ACK'}});
 const queue={operation:'case_list.publish',companyId:c.f.companyId,jobId:c.f.jobId,actorUid:capture.actorUid,status:'pending',idempotencyKey:`case_list.publish:${c.f.jobId}:${plan.reviewPlanHash}`,caseListPublication:capture,updates:{},expected:{},styles:{},createdAt:H.Stamp.now(),updatedAt:H.Stamp.now()};
 c.records.set(queuePath,queue);c.records.set(opPath,{schema:'LK_CASE_LIST_PUBLICATION_OPERATION_V1',companyId:c.f.companyId,jobId:c.f.jobId,queueId,captureHash,status:'queued',createdAt:H.Stamp.now()});
 c.records.set(opPath+'/events/REQUESTED',{companyId:c.f.companyId,queueId,payload:H.copy(capture),payloadHash:captureHash,createdAt:H.Stamp.now()});
 const leasePath='caseListSyncLocks/'+c.f.companyId;
 if(ownLease)c.records.set(leasePath,{tokenId:'generation_b_claim',activeUntil:H.Stamp.fromMillis(Date.now()+600000),kind:'source.publish',queueId});
 const protectedPaths=[jobPath,queuePath,opPath,opPath+'/events/REQUESTED',...(ownLease?[leasePath]:[])];
 return {queueId,capture,opPath,bytes:()=>JSON.stringify([...protectedPaths.map(path=>[path,c.records.get(path)]),...[...c.records].filter(([path])=>path.startsWith(opPath+'/events/')).sort(([a],[b])=>a.localeCompare(b))]),sourceBytes:()=>JSON.stringify(c.h.cells)};
}
const results=[];async function test(name,fn){process.env.LKC_SHEET_WRITE_MODE='active';process.env.LKC_CASE_LIST_PUBLICATION_MODE='active';await fn();results.push({name,passed:true});}
(async()=>{
 await test('same publisher continuation changes only BD/BE once, then atomically opens job and postSource approval',async()=>{
  const c=await setup();H.setAfterCommit(()=>{const job=c.records.get('jobs/'+c.f.jobId);if(job.publishable){assert.equal(job.status,'open');assert.equal(c.records.get(c.queueRef.path).status,'completed');assert.ok(c.records.has(c.opPath+'/events/ACK'));assert.equal(c.records.get('caseListApprovals/'+c.f.jobId).expectedSourceRevision,job.caseListSource.sourceRevision);}});
  const result=await c.run();assert.equal(result.state,'PUBLISHED',JSON.stringify(result));assert.equal(c.batches(),1);assert.equal(result.snapshotReads,3);assert.equal(result.nativeBatches,1);
  const job=c.records.get('jobs/'+c.f.jobId),approval=c.records.get('caseListApprovals/'+c.f.jobId);assert.equal(job.revision,6);assert.equal(job.region,'通常');assert.equal(job.caseListPublicationWrite.pending,false);assert.equal(approval.actorUid,'owner_fixture');assert.equal(job.caseListSource.sourceRevision,c.plan.postCatalog.sourceRevision);
  for(let i=0;i<65;i++)if(![55,56].includes(i))assert.equal(JSON.stringify(c.h.cells[i]),JSON.stringify(c.before[i]),'unchanged '+i);
  assert.equal(c.h.cells[55].userEnteredValue.stringValue,'募集中');assert.equal(c.h.cells[56].userEnteredValue.stringValue,'通常');
  const before=H.nativeCalls;assert.equal((await c.run()).state,'PUBLISHED');assert.equal(H.nativeCalls,before);
 });
 for(const [name,key,value]of [['missing scoped mode','LKC_CASE_LIST_PUBLICATION_MODE',null],['scoped pause','LKC_CASE_LIST_PUBLICATION_MODE','paused'],['unknown scoped mode','LKC_CASE_LIST_PUBLICATION_MODE','unknown'],['global pause','LKC_SHEET_WRITE_MODE','paused'],['missing global mode','LKC_SHEET_WRITE_MODE',null]])await test(name+' neither reads native data nor consumes queue',async()=>{const c=await setup(),before=JSON.stringify([...c.records]);if(value===null)delete process.env[key];else process.env[key]=value;const result=await c.run();assert.equal(result.status,'PUBLICATION_PAUSED');assert.equal(c.batches(),0);assert.equal(result.snapshotReads,0);assert.equal(JSON.stringify([...c.records]),before);});
 await test('lost POST response remains nonpublic until readonly reconciliation; pause does not authorize replay',async()=>{const c=await setup({ackLoss:true}),result=await c.run();assert.equal(result.state,'HELD');assert.equal(c.records.get(c.queueRef.path).writeVerificationRequired,true);assert.equal(c.records.get('jobs/'+c.f.jobId).publishable,false);assert.equal(c.batches(),1);process.env.LKC_SHEET_WRITE_MODE='paused';process.env.LKC_CASE_LIST_PUBLICATION_MODE='paused';const verified=await c.reconcile();assert.equal(verified.state,'PUBLISHED',JSON.stringify(verified));assert.equal(c.batches(),1);assert.equal(verified.nativeBatches,0);});
 await test('unknown POST with unchanged preimage is never blindly retried',async()=>{const c=await setup({noEffectLoss:true});assert.equal((await c.run()).state,'HELD');assert.equal((await c.reconcile()).state,'HELD');const q=c.records.get(c.queueRef.path);Object.assign(q,{status:'processing',claimToken:'newclaim',retryAt:H.Stamp.fromMillis(Date.now()+600000),writeVerificationRequired:false,errorType:null});assert.equal((await worker.processCaseListPublication(c.queueRef,H.copy(q))).state,'HELD');assert.equal(c.batches(),1);assert.equal(c.records.get('jobs/'+c.f.jobId).publishable,false);});
 for(const [name,mutate]of [['cancel',job=>{job.cancelled=true;job.status='cancelled';job.revision++;}],['stop',job=>{job.status='stopped';job.revision++;}],['revision',job=>job.revision++],['owner revocation',(job,c)=>c.records.set('authIdentities/owner_fixture',{companyId:c.f.companyId,active:false})],['expired intent',(job,c)=>H.advanceClock(610000)]])await test(name+' after POST cannot publish',async()=>{const c=await setup({afterNative:()=>mutate(c.records.get('jobs/'+c.f.jobId),c)});const result=await c.run();assert.equal(result.state,'HELD');assert.equal(c.batches(),1);assert.equal(c.records.get('jobs/'+c.f.jobId).publishable,false);assert.equal(c.records.has('caseListApprovals/'+c.f.jobId),false);assert.equal((await c.reconcile()).state,'HELD');assert.equal(c.batches(),1);});
 for(const [name,mutate]of [['changed source',c=>c.h.cells[11]=literal('changed')],['BL cancel',c=>c.h.cells[63]={userEnteredValue:{boolValue:true},effectiveValue:{boolValue:true}}],['BD ended',c=>c.h.cells[55]=literal('終了')],['BE filled',c=>c.h.cells[56]=literal('東北')],['changed memo',c=>c.h.cells[16].note='NEW_MEMO'],['job assigned',c=>c.job.assignedStaffId='staff'],['job revision',c=>c.job.revision++],['job pointer',c=>c.job.caseListPublicationWrite.intentHash='a'.repeat(64)],['actor revoked',c=>c.records.set('authIdentities/owner_fixture',{active:false,companyId:c.f.companyId})],['wrong mapping',c=>c.records.get(`companies/${c.f.companyId}/sheetMappings/shift`).spreadsheetId='WRONG_BOOK001'],['missing request proof',c=>c.records.delete(c.opPath+'/events/REQUESTED')],['tampered capture',c=>c.queue.caseListPublication.confirmedRegion='東北']])await test(name+' before POST holds original',async()=>{const c=await setup();mutate(c);assert.equal((await c.run()).state,'HELD');assert.equal(c.batches(),0);assert.equal(c.records.get('jobs/'+c.f.jobId).publishable,false);});
 for(const [name,change]of [['cancel before dispatch',c=>{c.job.cancelled=true;c.job.status='cancelled';c.job.revision++;}],['stop before dispatch',c=>{c.job.status='stopped';c.job.revision++;}],['expire before dispatch',()=>H.advanceClock(610000)],['lease lost before dispatch',c=>c.records.set('caseListSyncLocks/'+c.f.companyId,{tokenId:'stolen',activeUntil:H.Stamp.fromMillis(Date.now()+600000)})],['memo changed at final preflight',c=>c.h.cells[16].note='LAST_PREFLIGHT_EDIT']])await test(name+' after INTENT prevents POST',async()=>{let c; c=await setup({beforeRead:({snapshots})=>{if(snapshots===2)change(c);}});assert.equal((await c.run()).state,'HELD');assert.equal(c.batches(),0);assert.equal(c.records.get('jobs/'+c.f.jobId).publishable,false);});
 for(const [name,mutate]of [['intent image',intent=>intent.plan.sourceBefore[16].note='FAKE_HISTORY'],['postimage',intent=>intent.plan.postSourceValues[56]={userEnteredValue:{stringValue:'東北'},effectiveValue:{stringValue:'東北'}}],['preimage catalog',intent=>intent.plan.preCatalog.ledgerRevision='a'.repeat(64)]])await test('readonly reconciliation rejects rehashed '+name,async()=>{const c=await setup({ackLoss:true});await c.run();const event=c.records.get(c.opPath+'/events/INTENT');mutate(event.payload);event.payloadHash=helper.hashCaseList(event.payload);assert.equal((await c.reconcile()).state,'HELD');assert.equal(c.batches(),1);assert.equal(c.records.get('jobs/'+c.f.jobId).publishable,false);});
 await test('concurrent full-row memo edit after POST prevents ACK and cannot be rolled back',async()=>{const c=await setup({afterNative:h=>h.cells[16].note='CONCURRENT_NOTE'});assert.equal((await c.run()).state,'HELD');assert.equal((await c.reconcile()).state,'HELD');assert.equal(c.batches(),1);assert.equal(c.h.cells[16].note,'CONCURRENT_NOTE');});
 await test('owner allowlist policy change invalidates an already queued intent before POST',async()=>{const c=await setup();process.env.EXECUTIVE_APPROVER_EMAILS='different@example.invalid';try{assert.equal((await c.run()).state,'HELD');assert.equal(c.batches(),0);}finally{process.env.EXECUTIVE_APPROVER_EMAILS='owner@example.invalid';}});
 await test('immutable REVOKED event blocks retry without overwriting the owner revoked state',async()=>{const c=await setup();c.records.set(c.opPath+'/events/REVOKED',{companyId:c.f.companyId,queueId:c.queueRef.id,payload:{stage:'REVOKED'}});c.job.revision++;c.job.caseListPublicationWrite.state='HELD_REVOKED';assert.equal((await c.run()).state,'HELD');assert.equal(c.batches(),0);assert.equal(c.records.get('jobs/'+c.f.jobId).caseListPublicationWrite.state,'HELD_REVOKED');});
 await test('dispatch metadata response lost leaves durable barrier without ever starting a native POST',async()=>{const c=await setup();H.setAfterCommit(()=>{if(c.records.has(c.opPath+'/events/WRITE_STARTED')){H.setAfterCommit(null);throw Error('METADATA_RESPONSE_LOST');}});assert.equal((await c.run()).state,'HELD');assert.equal(c.batches(),0);assert.equal((await c.reconcile()).state,'HELD');assert.equal(c.batches(),0);});
 await test('company lease contention preserves unpublished state and writes no Source value',async()=>{const c=await setup();c.records.set('caseListSyncLocks/'+c.f.companyId,{tokenId:'other',activeUntil:H.Stamp.fromMillis(Date.now()+600000)});assert.equal((await c.run()).state,'HELD');assert.equal(c.batches(),0);});
 await test('duplicate fixed ID copied into Source halts global identity proof before POST',async()=>{let ready=false;const c=await setup({beforeRead:({sourceRows,cells})=>{if(ready)sourceRows.push({row:3,cells:H.copy(cells)});}});ready=true;assert.equal((await c.run()).state,'HELD');assert.equal(c.batches(),0);});
 for(const december of [false,true]) {
  await test((december?'December':'November')+' physical monthly ID appearing at final preflight prevents the Source POST',async()=>{
   const c=await setup({december,beforeRead:({snapshots,month,f})=>{if(snapshots===2)addPhysicalMonthlyTarget({month,f});}}),sourceBefore=JSON.stringify(c.h.cells),ledgerBefore=c.capture.source.ledgerRevision;
   const result=await c.run();assert.equal(result.state,'HELD');assert.equal(result.reason,'PUBLICATION_FINAL_TRANSFER_NOT_SUPPORTED',JSON.stringify(result));assert.equal(physicalMonthlyCapability(c).reason,'EXISTING_DESTINATION_WITHOUT_RECEIPT');assert.equal(c.batches(),0);assert.equal(result.nativeBatches,0);assert.equal(result.snapshotReads,2);assert.equal(JSON.stringify(c.h.cells),sourceBefore);assert.equal(c.h.catalog().ledgerRevision,ledgerBefore);assert.equal(c.records.has(c.opPath+'/events/WRITE_STARTED'),false);assert.equal(c.records.has(c.opPath+'/events/ACK'),false);assert.equal(c.records.has('caseListApprovals/'+c.f.jobId),false);assert.equal(c.records.get('jobs/'+c.f.jobId).publishable,false);
  });
  await test((december?'December':'November')+' physical monthly ID appearing after native BD/BE write prevents public ACK and readonly completion',async()=>{
   const c=await setup({december,afterNative:h=>addPhysicalMonthlyTarget(h)}),sourceBefore=H.copy(c.h.cells),ledgerBefore=c.capture.source.ledgerRevision;
   const result=await c.run();assert.equal(result.state,'HELD');assert.equal(result.reason,'PUBLICATION_READBACK_TRANSFER_NOT_SUPPORTED',JSON.stringify(result));assert.equal(physicalMonthlyCapability(c).reason,'EXISTING_DESTINATION_WITHOUT_RECEIPT');assert.equal(c.batches(),1);assert.equal(result.nativeBatches,1);assert.equal(c.records.get('jobs/'+c.f.jobId).publishable,false);assert.equal(c.records.has(c.opPath+'/events/ACK'),false);assert.equal(c.records.has('caseListApprovals/'+c.f.jobId),false);
   const monthlyBefore=JSON.stringify(c.h.month),afterSource=JSON.stringify(c.h.cells);const reconciled=await c.reconcile();assert.equal(reconciled.state,'HELD');assert.equal(reconciled.reason,'PUBLICATION_READBACK_TRANSFER_NOT_SUPPORTED',JSON.stringify(reconciled));assert.equal(reconciled.nativeBatches,0);assert.equal(c.batches(),1);assert.equal(JSON.stringify(c.h.month),monthlyBefore);assert.equal(JSON.stringify(c.h.cells),afterSource);assert.equal(c.h.catalog().ledgerRevision,ledgerBefore);assert.equal(c.records.has(c.opPath+'/events/ACK'),false);assert.equal(c.records.has('caseListApprovals/'+c.f.jobId),false);
   for(let i=0;i<65;i++)if(![55,56].includes(i))assert.equal(JSON.stringify(c.h.cells[i]),JSON.stringify(sourceBefore[i]),'Source preserved '+i);
  });
 }
 await test('late native A sees valid fresh B before trusted reads: only its own A failure record may change',async()=>{
  const c=await setup(),b=installFreshGenerationB(c),before=b.bytes(),source=b.sourceBytes();
  const result=await c.run();assert.equal(result.state,'HELD');assert.equal(c.batches(),0);assert.equal(c.h.snapshots(),0);assert.equal(b.bytes(),before);assert.equal(b.sourceBytes(),source);
  assert.equal(c.records.get(c.queueRef.path).status,'blocked','A still owns its processing claim and may record failure');
  assert.equal([...c.records.keys()].filter(path=>path.startsWith(b.opPath+'/events/')).length,1);
 });
 await test('unacquired owner readonly A against valid fresh B changes no metadata anywhere',async()=>{
  const c=await setup();installFreshGenerationB(c);const before=JSON.stringify([...c.records]);
  assert.equal((await c.reconcile()).state,'HELD');assert.equal(c.batches(),0);assert.equal(c.h.snapshots(),0);assert.equal(JSON.stringify([...c.records]),before);
 });
 for(const ownLease of [false,true])await test('fresh B replacing A just after A lease acquisition protects all B business/proof'+(ownLease?' and B lease':''),async()=>{
  const c=await setup();let b,before,source;
  H.setAfterCommit(()=>{if(!b&&c.records.get(c.opPath)?.status==='processing'){b=installFreshGenerationB(c,{ownLease});before=b.bytes();source=b.sourceBytes();}});
  const result=await c.run();assert.ok(b,'B replacement occurred after A claim/lease commit');assert.equal(result.state,'HELD');assert.equal(c.batches(),0);assert.equal(c.h.snapshots(),0);assert.equal(b.bytes(),before);assert.equal(b.sourceBytes(),source);assert.equal(c.records.has(c.opPath+'/events/INTENT'),false);
  assert.equal(c.records.get(c.queueRef.path).status,'blocked');
  if(ownLease)assert.equal(c.records.get('caseListSyncLocks/'+c.f.companyId).tokenId,'generation_b_claim');else assert.equal(c.records.has('caseListSyncLocks/'+c.f.companyId),false,'A may release only its own old lease');
 });
 await test('fresh B immediately after A readonly authorization never receives old A INTENT, POST, ACK or cleanup',async()=>{
  const c=await setup();let commitsWithLease=0,b,before,source;
  H.setAfterCommit(()=>{if(c.records.get(c.opPath)?.status==='processing'&&c.records.get('caseListSyncLocks/'+c.f.companyId)?.tokenId==='publication_claim'){commitsWithLease++;if(commitsWithLease===2){b=installFreshGenerationB(c);before=b.bytes();source=b.sourceBytes();}}});
  const result=await c.run();assert.ok(b,'B replaced after A last readonly authorization and before native snapshot');assert.equal(result.state,'HELD');assert.equal(c.batches(),0);assert.equal(c.h.snapshots(),1,'Only read-only native evidence was collected across the non-atomic boundary');assert.equal(b.bytes(),before);assert.equal(b.sourceBytes(),source);assert.equal(c.records.has(c.opPath+'/events/INTENT'),false);assert.equal(c.records.has(c.opPath+'/events/WRITE_STARTED'),false);
 });
 await test('nonexecutive or other-company owner cannot reconcile',async()=>{const c=await setup({ackLoss:true});await c.run();for(const token of [{uid:'owner_fixture',companyId:c.f.companyId,role:'admin',email:'other@example.invalid',email_verified:true},{uid:'owner_fixture',companyId:'other',role:'admin',email:'owner@example.invalid',email_verified:true}])await assert.rejects(()=>worker.processCaseListPublication(c.queueRef,undefined,{actorUid:'owner_fixture',token}));assert.equal(c.batches(),1);});
 console.log(JSON.stringify({status:'PASS',tests:results.length,scope:'ACTUAL_PUBLICATION_QUEUE_WORKER_ADAPTER_FINALIZER_SYNTHETIC_ONLY',nativeRequests:0,externalWrites:0,results},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
