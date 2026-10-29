'use strict';
// Reuse the actual monthly worker's synthetic journey, proof chain and compact
// native-read constructor. All SDK boundaries are recording fakes; no cloud I/O.
const assert=require('node:assert/strict');
const harness=require('./test-worker-binding.cjs'),api=harness.load('case-list-source-cancellation'),sheet=harness.load('sheet-write-core'),helper=harness.load('case-list-source-core');
harness.db.doc=path=>new harness.Doc(path);
const owner=h=>({actorUid:'owner_fixture',token:{uid:'owner_fixture',companyId:h.f.companyId,role:'admin',email:'owner@example.invalid',email_verified:true}});
const results=[];async function test(name,fn){await fn();results.push({name,passed:true});}
async function cancellation(origin='manual',options={}){
 const h=harness.journey(options);
 if(origin==='manual')h.prepareManual();else await h.run();
 if(options.selectBeforeCancel){if(origin==='manual')await h.selectManual();else await h.confirmNameUpAndSelect();}
 if(options.monthlyStartedBeforeCancel){await h.step();await h.step();}
 const records=harness.documents,job=records.get('jobs/'+h.f.jobId),queueId='source_cancel_fixture',actorUid='owner_fixture';
 const nextRevision=job.revision+1,capture=sheet.captureCaseListSourceCancellation(job,h.f.jobId,queueId,actorUid,nextRevision),identity=sheet.cancellationSheetWriteIdentity(job),sourceAck=sheet.cancellationSourceAckFields(job,true,Date.now()-10,nextRevision);
 Object.assign(job,{status:'cancelled',cancelled:true,sourceCancellationClosed:true,publishable:false,recruitmentStopped:true,cancelledBy:actorUid,cancellationReason:'合成取消',revision:job.revision+1,
  cancellationSheetWrite:{queueId,operation:'job.cancel',identity,...sourceAck,caseListCancellation:capture},assignmentSheetWrite:null});
 const queue={companyId:h.f.companyId,jobId:h.f.jobId,operation:'job.cancel',caseListCancellation:capture,updates:{cancelled:true,cancellationReason:'合成取消'},actorUid,idempotencyKey:`job.cancel:${h.f.jobId}:${queueId}`,status:'processing',claimToken:'native_cancel_claim',retryAt:harness.Stamp.fromMillis(Date.now()+600000)};
 records.set('sheetSyncQueue/'+queueId,queue);records.set(`companies/${h.f.companyId}/sheetMappings/shift`,{enabled:true,spreadsheetId:h.f.book});
 const queueRef=new harness.Doc('sheetSyncQueue/'+queueId),before=JSON.stringify(h.cells),beforeNative=harness.nativeCalls;
 let writes=0;
 harness.setNativeHandler(async(body,requestOptions)=>{
  writes++;assert.equal(body.spreadsheetId,h.f.book);assert.equal(body.requestBody.requests.length,2);assert.equal(requestOptions.retry,false);assert.deepEqual([...requestOptions.retryConfig.httpMethodsToRetry],[]);
  const requests=body.requestBody.requests;assert.equal(requests[0].updateCells.range.startColumnIndex,2);assert.equal(requests[1].updateCells.range.startColumnIndex,63);
  const operationId=require('node:crypto').createHash('sha256').update(h.f.companyId+'|'+queueId).digest('hex');assert.ok(records.has('caseListMonthlyOperations/'+operationId+'/events/WRITE_STARTED'),'Durable WRITE_STARTED exists before POST');
  for(const request of requests){const update=request.updateCells;assert.equal(update.fields,'userEnteredValue');assert.equal(update.range.sheetId,2026101601);assert.equal(update.range.endRowIndex-update.range.startRowIndex,1);const index=update.range.startColumnIndex,cell=h.cells[index];delete cell.userEnteredValue;delete cell.effectiveValue;if(update.rows[0].values[0].userEnteredValue){cell.userEnteredValue=harness.copy(update.rows[0].values[0].userEnteredValue);cell.effectiveValue=harness.copy(cell.userEnteredValue);}}
  if(options.ackLoss)throw Error('SYNTHETIC_ACK_LOSS');
  if(options.afterNative)options.afterNative(h);
  return {};
 });
 return {h,job,queue,queueRef,capture,records,before,beforeNative,writes:()=>writes,run:()=>api.processCaseListSourceCancellation(queueRef,queue),reconcile:()=>api.processCaseListSourceCancellation(queueRef,undefined,owner(h)),day:()=>records.get(`staffDayLocks/${h.f.companyId}_${h.f.staffId}_${h.f.a.dateKey}`)};
}
(async()=>{
 for(const origin of ['manual','application']){
  await test(origin+' unselected cancellation clears only Source C/BL, ACKs, releases own day, keeps history and never recruits',async()=>{
   const c=await cancellation(origin),before=JSON.parse(c.before),result=await c.run();assert.equal(result.status,'SOURCE_CANCELLATION_READBACK_VERIFIED',JSON.stringify(result));assert.equal(c.writes(),1);assert.equal(result.nativeBatches,1);
   const job=c.records.get('jobs/'+c.h.f.jobId),day=c.day();assert.equal(job.status,'cancelled');assert.equal(job.cancelled,true);assert.equal(job.assignedStaffId,c.h.f.staffId);assert.equal(job.assignedStaffName,c.h.f.staffName);assert.equal(job.rawStaffName,'');assert.equal(job.publishable,false);assert.equal(job.recruitmentStopped,true);assert.equal(job.cancellationSheetWrite.sourceAckPending,false);assert.equal(day.active,false);assert.equal(job.cancellationSheetWrite.sourceAckProof.origin,origin==='manual'?'SOURCE_MANUAL':'CREW_QUEUE');
   const staffUi=harness.loadUiModel('apps/staff/src/job-list.ts'),calendar=harness.loadUiModel('apps/staff/src/monthly-shift-calendar.ts'),admin=harness.loadUiModel('apps/admin/src/job-search.ts'),publicJob={id:c.h.f.jobId,...job};
   assert.equal(staffUi.pendingAssignedJobs([publicJob],'2026-11-01').length,0);assert.equal(staffUi.splitAssignedJobs([publicJob],'2026-11-01').upcoming.length,0);assert.equal(calendar.monthCalendar([publicJob],job.dateKey.slice(0,7)).jobs.size,0);assert.equal(admin.filterJobSearchIndex(admin.buildJobSearchIndex([publicJob]),'','all').length,0);assert.equal(admin.filterJobSearchIndex(admin.buildJobSearchIndex([publicJob]),'','cancelled').length,1);
   for(let i=0;i<65;i++)if(![2,63].includes(i))assert.equal(JSON.stringify(c.h.cells[i]),JSON.stringify(before[i]));assert.equal(c.h.cells[2].userEnteredValue,undefined);assert.equal(c.h.cells[63].userEnteredValue.boolValue,true);
   const calls=harness.nativeCalls;await c.run();assert.equal(harness.nativeCalls,calls,'Completed replay cannot POST');
   const retention=harness.load('cancellation-history-retention-core');assert.throws(()=>retention.assertCancelledAssignmentCanRestore(job));assert.throws(()=>retention.assertAcknowledgedCancellationCanChange(job));
  });
  await test(origin+' lost response is held; readonly owner reconciliation ACKs without another POST',async()=>{
   const c=await cancellation(origin,{ackLoss:true}),first=await c.run();assert.equal(first.status,'HELD');assert.equal(c.writes(),1);assert.equal(c.day().active,true);assert.equal(c.records.get(c.queueRef.path).writeVerificationRequired,true);
   const before=harness.nativeCalls,result=await c.reconcile();assert.equal(result.status,'SOURCE_CANCELLATION_READBACK_VERIFIED',JSON.stringify(result));assert.equal(result.nativeBatches,0);assert.equal(harness.nativeCalls,before);assert.equal(c.day().active,false);
  });
 }
 for(const [name,mutate]of [
  ['changed staff',c=>c.job.assignedStaffId='other'],['changed job revision',c=>c.job.revision++],['foreign lock',c=>c.day().jobId='other'],['disabled mapping',c=>c.records.get(`companies/${c.h.f.companyId}/sheetMappings/shift`).enabled=false],
  ['changed binding',c=>c.job.caseListSource.bindingHash='a'.repeat(64)],['manual owner selection',c=>c.job.caseListManualSelection={queueId:'selected'}],['changed private observation',c=>c.records.get('caseListManualObservations/'+c.h.f.jobId).selected=true],
  ['changed Source C',c=>c.h.cells[2]={userEnteredValue:{stringValue:'別担当'},effectiveValue:{stringValue:'別担当'}}],['C formula',c=>c.h.cells[2]={userEnteredValue:{formulaValue:'="架空担当"'},effectiveValue:{stringValue:c.h.f.staffName}}],['BL formula',c=>c.h.cells[63]={userEnteredValue:{formulaValue:'=FALSE()'},effectiveValue:{boolValue:false}}],
  ['A checkbox alone',c=>c.h.cells[0]={userEnteredValue:{boolValue:true},effectiveValue:{boolValue:true}}],['existing monthly ref',c=>c.records.set('caseListSheetRefs/'+c.h.f.jobId,{companyId:c.h.f.companyId})],
 ])await test('holds '+name+' before POST and retains own day',async()=>{const c=await cancellation();mutate(c);const result=await c.run();assert.equal(result.status,'HELD');assert.equal(c.writes(),0);assert.equal(c.day().active,true);});
 for(const stage of ['INTENT','MONTHLY_WRITE_STARTED','UNKNOWN','SOURCE_UNKNOWN','ACCEPTED'])await test('app '+stage+' proof prevents native Source cancellation',async()=>{const c=await cancellation('application');const prior=c.capture.priorAssignment.queueId,crypto=require('node:crypto'),id=crypto.createHash('sha256').update(c.h.f.companyId+'|'+prior).digest('hex');c.records.set('caseListMonthlyOperations/'+id+'/events/'+stage,{payload:{stage},payloadHash:'0'.repeat(64)});const result=await c.run();assert.equal(result.status,'HELD');assert.equal(c.writes(),0);assert.equal(c.day().active,true);});
 await test('app private owner selection prevents native Source cancellation',async()=>{const c=await cancellation('application'),prior=c.capture.priorAssignment.queueId,id=require('node:crypto').createHash('sha256').update(c.h.f.companyId+'|'+prior).digest('hex');c.records.get('caseListMonthlyOperations/'+id).ownerTransferSelection={selected:true};assert.equal((await c.run()).status,'HELD');assert.equal(c.writes(),0);assert.equal(c.day().active,true);});
 await test('readback detects unrelated memo edits and keeps lock until real comparison',async()=>{const c=await cancellation('manual',{afterNative:h=>h.cells[16].note='CONCURRENT_MEMO'});assert.equal((await c.run()).status,'HELD');assert.equal(c.writes(),1);assert.equal(c.day().active,true);assert.equal((await c.reconcile()).status,'HELD');assert.equal(c.writes(),1);assert.equal(c.day().active,true);});
 await test('nonexecutive reconciliation cannot read/write or release lock',async()=>{const c=await cancellation('manual',{ackLoss:true});await c.run();const calls=harness.nativeCalls;await assert.rejects(()=>api.processCaseListSourceCancellation(c.queueRef,undefined,{actorUid:'other',token:{uid:'other',companyId:c.h.f.companyId,role:'admin',email:'other@example.invalid',email_verified:true}}),/CASE_LIST_EXECUTIVE_REQUIRED/);assert.equal(harness.nativeCalls,calls);assert.equal(c.day().active,true);});
 await test('known prewrite company lease contention remains safely retryable, never a result-unknown replay',async()=>{const c=await cancellation();c.records.set('caseListSyncLocks/'+c.h.f.companyId,{tokenId:'other',activeUntil:harness.Stamp.fromMillis(Date.now()+600000)});assert.equal((await c.run()).status,'HELD');const held=c.records.get(c.queueRef.path);assert.equal(held.writeVerificationRequired,false);assert.equal(held.errorType,'blocked');assert.equal(harness.load('admin-operations-core').canManuallyRetrySheetWrite(held),true);assert.equal(c.writes(),0);assert.equal(c.day().active,true);});
 await test('manual raw alias maps exact physical name to its canonical staff ID',async()=>{const c=await cancellation('manual',{manualName:' 架空担当 '});const result=await c.run();assert.equal(result.status,'SOURCE_CANCELLATION_READBACK_VERIFIED',JSON.stringify(result));assert.equal(c.records.get('jobs/'+c.h.f.jobId).assignedStaffName,' 架空担当 ');assert.equal(c.day().active,false);});
 await test('December uses the same single Source cancellation batch',async()=>{const c=await cancellation('application',{december:true});const result=await c.run();assert.equal(result.status,'SOURCE_CANCELLATION_READBACK_VERIFIED',JSON.stringify(result));assert.equal(c.writes(),1);assert.equal(c.day().active,false);});
 await test('job.cancel.v2 has the same Source-only operation and retains private reason/treatment',async()=>{const c=await cancellation(),labels=harness.load('analytics-core');c.queue.operation='job.cancel.v2';c.queue.idempotencyKey=`job.cancel.v2:${c.h.f.jobId}:${c.queueRef.id}`;c.job.cancellationSheetWrite.operation='job.cancel.v2';c.job.cancellationReasonCategory='other';c.job.cancellationFinancialTreatment='neither';c.queue.updates.cancellationReasonCategory=labels.cancellationReasonLabels.other;c.queue.updates.cancellationFinancialTreatment=labels.cancellationTreatmentLabels.neither;const result=await c.run();assert.equal(result.status,'SOURCE_CANCELLATION_READBACK_VERIFIED',JSON.stringify(result));const job=c.records.get('jobs/'+c.h.f.jobId);assert.equal(job.cancellationReason,'合成取消');assert.equal(job.cancellationReasonCategory,'other');assert.equal(job.cancellationFinancialTreatment,'neither');assert.equal(c.writes(),1);});
 await test('writer disabled blocks native POST but owner readonly settles a previously started exact after-image',async()=>{const c=await cancellation('application',{ackLoss:true});await c.run();c.records.get('sheetImportConfigs/'+c.h.f.companyId).caseListAssignmentsEnabled=false;const before=harness.nativeCalls,result=await c.reconcile();assert.equal(result.status,'SOURCE_CANCELLATION_READBACK_VERIFIED',JSON.stringify(result));assert.equal(result.nativeBatches,0);assert.equal(harness.nativeCalls,before);assert.equal(c.day().active,false);});
 for(const [name,mutate]of [
  ['writer disabled',c=>c.records.get('sheetImportConfigs/'+c.h.f.companyId).caseListAssignmentsEnabled=false],
  ['revoked actor',c=>c.records.set('authIdentities/'+c.queue.actorUid,{companyId:c.h.f.companyId,active:false})],
  ['foreign actor',c=>c.records.set('authIdentities/'+c.queue.actorUid,{companyId:'other',active:true})],
  ['capture tamper',c=>c.queue.caseListCancellation.staffName='FAKE'],
  ['oversized private journal',c=>c.h.cells[16].note='x'.repeat(900000)],
 ])await test(name+' is held with zero native writes',async()=>{const c=await cancellation();mutate(c);assert.equal((await c.run()).status,'HELD');assert.equal(c.writes(),0);assert.equal(c.day().active,true);});
 for(const origin of ['manual','application'])await test(origin+' actual owner-selected path is held before cancellation POST',async()=>{const c=await cancellation(origin,{selectBeforeCancel:true});assert.equal((await c.run()).status,'HELD');assert.equal(c.writes(),0);assert.equal(c.day().active,true);});
 await test('actual app monthly WRITE_STARTED path is held before any Source cancellation POST',async()=>{const c=await cancellation('application',{selectBeforeCancel:true,monthlyStartedBeforeCancel:true});assert.equal((await c.run()).status,'HELD');assert.equal(c.writes(),0);assert.equal(c.day().active,true);});
 await test('actual app uncertain Source assignment cannot be cancelled by blindly reapplying',async()=>{const c=await cancellation('application',{sourceAckLoss:true});assert.equal((await c.run()).status,'HELD');assert.equal(c.writes(),0);assert.equal(c.day().active,true);});
 for(const [name,mutate]of [
  ['wrong physical name',p=>{p.sourceBefore[2].userEnteredValue={stringValue:'FAKE'};p.sourceBeforeValues[2]={userEnteredValue:{stringValue:'FAKE'},effectiveValue:{stringValue:'FAKE'}};}],
  ['wrong effective preimage',p=>p.sourceBeforeValues[10].effectiveValue={stringValue:'FAKE'}],
  ['wrong catalog',p=>p.expectedCatalog.rowRevision='a'.repeat(64)],
  ['out-of-scope writable field',p=>p.sourceBefore[0].unexpected='FAKE'],
 ])await test('readonly rejects coherently rehashed '+name+' without another POST',async()=>{const c=await cancellation('manual',{ackLoss:true});await c.run();const id=require('node:crypto').createHash('sha256').update(c.h.f.companyId+'|'+c.queueRef.id).digest('hex'),base='caseListMonthlyOperations/'+id+'/events/',intent=c.records.get(base+'INTENT'),started=c.records.get(base+'WRITE_STARTED');mutate(intent.payload);intent.payloadHash=helper.hashCaseList(intent.payload);started.payload.intentHash=intent.payloadHash;started.payloadHash=helper.hashCaseList(started.payload);const before=harness.nativeCalls,result=await c.reconcile();assert.equal(result.status,'HELD');assert.equal(harness.nativeCalls,before);assert.equal(c.day().active,true);});
 console.log(JSON.stringify({status:'PASS',tests:results.length,scope:'ACTUAL_SOURCE_CANCEL_WORKER_WITH_COMPACT_NATIVE_READS_AND_MONTHLY_PROOF_CHAIN',cloudBusinessWrites:0,results},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
