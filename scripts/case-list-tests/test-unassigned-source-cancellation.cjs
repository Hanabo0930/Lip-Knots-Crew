'use strict';
// Actual cancellation APIs -> their existing queue -> the actual native helper.
// The publication baseline, native compact reads and SDK fakes are shared with
// the existing assigned/publication suites; no cloud I/O or credentials exist.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const H=require('./test-worker-binding.cjs'),P=require('./test-publication-worker.cjs');
const helper=H.load('case-list-source-core'),sheet=H.load('sheet-write-core'),native=H.load('case-list-source-cancellation');
const jobs=H.load('jobs'),analytics=H.load('analytics'),retention=H.load('cancellation-history-retention-core');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const literal=value=>{const key=typeof value==='boolean'?'boolValue':typeof value==='number'?'numberValue':'stringValue';return {userEnteredValue:{[key]:value},effectiveValue:{[key]:value}};};
H.db.doc=value=>new H.Doc(value);
const results=[];async function test(name,fn){await fn();results.push({name,passed:true});}
function staffOperations(){return [...H.documentReads,...H.documentWrites].filter(value=>/^(?:staffProfiles|staffDayLocks)\//.test(value));}
const owner=f=>({uid:'owner_fixture',token:{uid:'owner_fixture',companyId:f.companyId,role:'admin',email:'owner@example.invalid',email_verified:true}});
function noStaffOperations(){assert.equal(staffOperations().length,0,'Unassigned cancellation must neither read nor write staff profiles/day locks');}
async function setup(options={}){
 const {ackLoss,noEffectLoss,afterNative,...publicationOptions}=options;
 const c=await P.setup({...publicationOptions,queueId:sha('unassigned-publication-fixture')});
 const {h,f,records}=c;
 if(options.origin==='published'){
  const published=await c.run();assert.equal(published.state,'PUBLISHED',JSON.stringify(published));
 }else if(options.origin==='revoked'){
  const current=records.get('jobs/'+f.jobId),api=H.load('case-list-publication');
  const revoked=await api.updateCaseListSourcePublication({jobIds:[f.jobId],action:'stop',expectedRevisions:{[f.jobId]:current.revision},sourceTransition:{phase:'revoke',expectedIntentHash:current.caseListPublicationWrite.intentHash}},f.companyId,'owner_fixture',owner(f).token);
  assert.equal(revoked.sourcePublication.state,'REVOKED');
 }else if(options.origin!=='pending'){
  for(const key of [...records.keys()])if(key===c.queueRef.path||key===c.opPath||key.startsWith(c.opPath+'/events/'))records.delete(key);
  const current=records.get('jobs/'+f.jobId);delete current.caseListPublicationWrite;
  Object.assign(current,{revision:4,status:'draft',basePay:null,publishable:false,recruitmentStopped:true});
 }
 const job=records.get('jobs/'+f.jobId);
 Object.assign(job,{assignedStaffId:null,assignedStaffName:'',assignedUid:null,applicationUnconfirmed:false});
 for(const key of ['assignmentSheetWrite','caseListManualPending','caseListManualSelection','sheetRef'])delete job[key];
 for(const key of [...records.keys()])if(key.startsWith('staffProfiles/')||key.startsWith('staffDayLocks/'))records.delete(key);
 if(options.emptyLiteral)h.cells[2]={...literal(''),note:'Empty C representation must survive',userEnteredFormat:{backgroundColor:{red:0.5}}};
 const rebase=()=>job.caseListSource=helper.publicCaseListSource(h.catalog());
 if(options.emptyLiteral)rebase();
 const operation=options.operation??'job.cancel.v2',requestData=extra=>({jobId:f.jobId,expectedRevision:records.get('jobs/'+f.jobId).revision,reason:'合成未割当取消',reasonCategory:'other',reasonNote:'合成未割当取消',financialTreatment:'neither',...extra});
 const cancel=async(extra={},auth=owner(f))=>(operation==='job.cancel'?jobs.adminCancelJob:analytics.adminSetJobCancellation)({auth,data:requestData(extra)});
 H.clearAccessLog();
 let cancelQueueRef=null,queue=null,posts=0;
 const claim=()=>{
  const found=[...records].filter(([key,value])=>key.startsWith('sheetSyncQueue/')&&value.operation===operation).at(-1);
  assert.ok(found,'API creates the existing cancellation queue');cancelQueueRef=new H.Doc(found[0]);queue=records.get(found[0]);
  Object.assign(queue,{status:'processing',claimToken:'unassigned_cancellation_claim',retryAt:H.Stamp.fromMillis(Date.now()+600000)});
 };
 const prepare=async()=>{await cancel();claim();return records.get(cancelQueueRef.path);};
 H.setNativeHandler(async(body,config)=>{
  posts++;assert.equal(body.spreadsheetId,f.book);assert.equal(body.requestBody.requests.length,1,'Only BL changes for a proven empty C');
  const update=body.requestBody.requests[0].updateCells;
  assert.equal(update.fields,'userEnteredValue');assert.equal(update.range.sheetId,2026101601);assert.equal(update.range.startColumnIndex,63);assert.equal(update.range.endColumnIndex,64);assert.equal(update.range.endRowIndex-update.range.startRowIndex,1);
  assert.equal(JSON.stringify(update.rows[0].values[0]),JSON.stringify({userEnteredValue:{boolValue:true}}));
  assert.equal(config.retry,false);assert.equal(config.retryConfig.retry,0);assert.equal(config.retryConfig.noResponseRetries,0);assert.equal(config.retryConfig.httpMethodsToRetry.length,0);
  const opPath='caseListMonthlyOperations/'+sha(f.companyId+'|'+cancelQueueRef.id);
  assert.ok(records.has(opPath+'/events/INTENT'));assert.ok(records.has(opPath+'/events/WRITE_STARTED'),'Durable dispatch is committed before native POST');
  if(!options.noEffectLoss){h.cells[63].userEnteredValue={boolValue:true};h.cells[63].effectiveValue={boolValue:true};}
  if(options.afterNative)options.afterNative({h,f,records,job,cancelQueueRef});
  if(options.ackLoss||options.noEffectLoss)throw Error('SYNTHETIC_UNASSIGNED_POST_RESPONSE_LOST');
  return {};
 });
 return {c,h,f,records,get job(){return records.get('jobs/'+f.jobId)},operation,rebase,cancel,prepare,claim,queue:()=>records.get(cancelQueueRef.path),queueRef:()=>cancelQueueRef,posts:()=>posts,
  run:()=>native.processCaseListSourceCancellation(cancelQueueRef,H.copy(records.get(cancelQueueRef.path))),
  reconcile:(auth=owner(f))=>native.processCaseListSourceCancellation(cancelQueueRef,undefined,{actorUid:auth.uid,token:auth.token}),
  opPath:()=> 'caseListMonthlyOperations/'+sha(f.companyId+'|'+cancelQueueRef.id),
 };
}
(async()=>{
 for(const operation of ['job.cancel','job.cancel.v2'])for(const december of [false,true])for(const origin of ['draft','published','revoked'])await test(`${operation} ${december?'December':'November'} ${origin} unassigned cancels through API and exactly one BL POST`,async()=>{
  const c=await setup({operation,december,origin,emptyLiteral:origin==='draft'}),before=JSON.stringify(c.h.cells),beforeRevision=c.job.revision;
  await c.prepare();const saved=c.records.get('jobs/'+c.f.jobId),capture=saved.cancellationSheetWrite.caseListCancellation;
  assert.equal(capture.schema,'LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V2');assert.equal(capture.assignmentMode,'UNASSIGNED_SOURCE');assert.equal(capture.staffId,null);assert.equal(capture.staffName,null);assert.equal(capture.assignedUid,null);assert.equal(capture.priorAssignment,null);assert.equal(capture.manualPending,null);assert.equal(capture.beforeJobRevision,beforeRevision);assert.equal(saved.cancellationSheetWrite.sourceAckPending,true);assert.equal(saved.revision,beforeRevision+1);noStaffOperations();
  const result=await c.run();assert.equal(result.status,'SOURCE_CANCELLATION_READBACK_VERIFIED',JSON.stringify(result));assert.equal(result.nativeBatches,1);assert.equal(c.posts(),1);noStaffOperations();
  const after=c.records.get('jobs/'+c.f.jobId);assert.equal(after.status,'cancelled');assert.equal(after.cancelled,true);assert.equal(after.assignedStaffId,null);assert.equal(after.assignedStaffName,'');assert.equal(after.assignedUid,null);assert.equal(after.rawStaffName,'');assert.equal(after.publishable,false);assert.equal(after.recruitmentStopped,true);assert.equal(after.cancellationSheetWrite.sourceAckPending,false);assert.equal(after.cancellationSheetWrite.sourceAckProof.staffId,null);assert.equal(after.cancellationSheetWrite.sourceAckProof.origin,'UNASSIGNED_SOURCE');assert.equal(c.queue().status,'completed');
  const beforeCells=JSON.parse(before);for(let i=0;i<65;i++)if(i!==63)assert.equal(JSON.stringify(c.h.cells[i]),JSON.stringify(beforeCells[i]),'Preserved Source column '+i);
  const posts=c.posts();await c.run();assert.equal(c.posts(),posts,'Completed replay cannot POST');noStaffOperations();
  const countBefore=[...c.records].filter(([key,value])=>key.startsWith('sheetSyncQueue/')&&value.operation===operation).length;await c.cancel();assert.equal([...c.records].filter(([key,value])=>key.startsWith('sheetSyncQueue/')&&value.operation===operation).length,countBefore,'Repeated same confirmed cancellation does not make a second queue');
 });
 for(const origin of ['draft','published','revoked'])await test(origin+' lost response only settles exact immutable after-image through readonly recovery',async()=>{
  const c=await setup({origin,ackLoss:true});await c.prepare();const held=await c.run();assert.equal(held.status,'HELD');assert.equal(c.posts(),1);assert.equal(c.queue().writeVerificationRequired,true);assert.equal(c.records.get('jobs/'+c.f.jobId).cancellationSheetWrite.sourceAckPending,true);noStaffOperations();
  c.records.get('sheetImportConfigs/'+c.f.companyId).caseListAssignmentsEnabled=false;const result=await c.reconcile();assert.equal(result.status,'SOURCE_CANCELLATION_READBACK_VERIFIED',JSON.stringify(result));assert.equal(result.nativeBatches,0);assert.equal(c.posts(),1);noStaffOperations();
 });
 await test('unknown native response with original BL=false cannot be retried or guessed as ACK',async()=>{const c=await setup({noEffectLoss:true});await c.prepare();assert.equal((await c.run()).status,'HELD');assert.equal((await c.reconcile()).status,'HELD');assert.equal(c.posts(),1);assert.equal(c.queue().writeVerificationRequired,true);assert.equal(c.records.get('jobs/'+c.f.jobId).cancellationSheetWrite.sourceAckPending,true);noStaffOperations();});
 for(const field of ['assignedStaffName','assignedUid','assignmentSheetWrite','caseListManualPending','caseListManualSelection'])await test('partial unassigned '+field+' cannot enter the nullable authority',async()=>{const c=await setup();c.job[field]=field==='assignedStaffName'?'unexpected name':field==='assignedUid'?'unexpected_uid':{queueId:'unexpected'};const before=JSON.stringify([...c.records]);await assert.rejects(()=>c.cancel());assert.equal(JSON.stringify([...c.records]),before);assert.equal(c.posts(),0);noStaffOperations();});
 for(const [name,change]of [
  ['omitted revision',()=>({expectedRevision:undefined})],['stale revision',c=>({expectedRevision:c.job.revision-1})],['staff assigned since owner display',c=>{const old=c.job.revision;c.job.revision++;c.job.assignedStaffId='other_staff';return {expectedRevision:old};}],
 ])await test(name+' is rejected by each actual API with no queue or day mutation',async()=>{for(const operation of ['job.cancel','job.cancel.v2']){const c=await setup({operation}),request=change(c),before=JSON.stringify([...c.records]);await assert.rejects(()=>c.cancel(request),e=>e.code==='failed-precondition');assert.equal(JSON.stringify([...c.records]),before);assert.equal(H.documentWrites.length,0);noStaffOperations();}});
 for(const state of ['AWAITING_SOURCE_ACK','HELD','HELD_REVOKED'])await test('publication '+state+' barrier refuses unassigned cancellation capture before metadata or native change',async()=>{const c=await setup({origin:'pending'});c.job.caseListPublicationWrite.state=state;const before=JSON.stringify([...c.records]);await assert.rejects(()=>c.cancel(),e=>e.code==='failed-precondition');assert.equal(JSON.stringify([...c.records]),before);assert.equal(H.documentWrites.length,0);assert.equal(c.posts(),0);noStaffOperations();});
 for(const [name,change]of [
  ['Source C literal',c=>c.h.cells[2]=literal('new manual assignee')],['Source C whitespace',c=>c.h.cells[2]=literal(' ')],['Source C formula empty',c=>c.h.cells[2]={userEnteredValue:{formulaValue:'=""'},effectiveValue:{stringValue:''}}],['BL true',c=>c.h.cells[63]=literal(true)],['BL formula',c=>c.h.cells[63]={userEnteredValue:{formulaValue:'=FALSE()'},effectiveValue:{boolValue:false}}],['BL effective mismatch',c=>c.h.cells[63]={userEnteredValue:{boolValue:false},effectiveValue:{boolValue:true}}],
  ['headcount unconfirmed',c=>c.h.cells[62]=literal(JSON.stringify({schema:'LKCM1_CASE_META_V1',publicEligible:false,headcountConfirmed:false,issues:[]}))],['multiple dates',c=>c.h.cells[58]=literal('全日同一')],['group link',c=>c.h.cells[59]=literal('group')],['unsupported training',c=>c.h.cells[16]=literal('研修')],['unsupported menu-only training',c=>c.h.cells[13]=literal('研修')],['unsupported menu-only OJT',c=>c.h.cells[13]=literal('OJT')],['ledger missing',c=>c.h.ledger.pop()],['ledger assignee',c=>c.h.ledger[3][9]=literal('other')],['ledger ended',c=>c.h.ledger[3][10]=literal('募集終了')],['ledger monthly link',c=>c.h.ledger[3][19]=literal(JSON.stringify({schema:'LK_HISTORY_CORE_SNAPSHOT_V1',caseId:c.f.a.sourceCaseId,monthly:{sheetId:1773116117}}))],
 ])await test(name+' fresh evidence is held with zero native writes',async()=>{const c=await setup();change(c);c.rebase();await c.prepare();const before=JSON.stringify(c.h.cells),result=await c.run();assert.equal(result.status,'HELD',JSON.stringify(result));assert.equal(c.posts(),0);assert.equal(JSON.stringify(c.h.cells),before);assert.equal(c.records.get('jobs/'+c.f.jobId).cancellationSheetWrite.sourceAckPending,true);noStaffOperations();});
 await test('physical monthly destination or copied Source ID after capture is held before native POST',async()=>{for(const duplicate of [false,true]){let ready=false;const c=await setup({beforeRead:({sourceRows,cells,month,f})=>{if(!ready)return;if(duplicate){if(sourceRows.length===1)sourceRows.push({row:3,cells:H.copy(cells)});}else if(!month.rows.some(row=>row.fixedId===f.a.sourceCaseId))P.addPhysicalMonthlyTarget({month,f});}});await c.prepare();ready=true;assert.equal((await c.run()).status,'HELD');assert.equal(c.posts(),0);noStaffOperations();}});
 for(const origin of ['published','revoked'])for(const part of ['pointer','requested','terminal'])await test(origin+' '+part+' generation tamper cannot authorize BL cancellation',async()=>{const c=await setup({origin});await c.prepare();if(part==='pointer')c.job.caseListPublicationWrite.intentHash='a'.repeat(64);else{const stage=part==='requested'?'REQUESTED':origin==='published'?'ACK':'REVOKED',record=c.records.get(c.c.opPath+'/events/'+stage);record.payloadHash='b'.repeat(64);}assert.equal((await c.run()).status,'HELD');assert.equal(c.posts(),0);noStaffOperations();});
 await test('publication generation replaced after INTENT cannot receive old cancellation POST or ACK',async()=>{let c,replaced=false;c=await setup({origin:'published',beforeRead:({snapshots})=>{if(c&&snapshots>=2&&!replaced){replaced=true;c.job.caseListPublicationWrite={...c.job.caseListPublicationWrite,queueId:'replacement_generation',intentHash:'a'.repeat(64)};}}});await c.prepare();assert.equal((await c.run()).status,'HELD');assert.equal(c.posts(),0);assert.equal(c.job.caseListPublicationWrite.queueId,'replacement_generation');noStaffOperations();});
 await test('a concurrent new name is preserved after BL POST and prevents ACK',async()=>{const c=await setup({afterNative:({h})=>h.cells[2]=literal('new human name')});await c.prepare();assert.equal((await c.run()).status,'HELD');assert.equal(c.posts(),1);assert.equal(c.h.cells[2].userEnteredValue.stringValue,'new human name');assert.equal((await c.reconcile()).status,'HELD');assert.equal(c.posts(),1);assert.equal(c.records.get('jobs/'+c.f.jobId).cancellationSheetWrite.sourceAckPending,true);noStaffOperations();});
 await test('after-image memo edit is never normalized or rolled back',async()=>{const c=await setup({afterNative:({h})=>h.cells[16].note='CONCURRENT_NOTE'});await c.prepare();assert.equal((await c.run()).status,'HELD');assert.equal((await c.reconcile()).status,'HELD');assert.equal(c.posts(),1);assert.equal(c.h.cells[16].note,'CONCURRENT_NOTE');noStaffOperations();});
 for(const [name,change]of [
  ['foreign company',c=>c.job.companyId='foreign_company'],
  ['revised job',c=>c.job.revision++],
  ['staff assigned',c=>c.job.assignedStaffId='new_staff'],
  ['revoked owner',c=>c.records.set('authIdentities/owner_fixture',{companyId:c.f.companyId,active:false})],
  ['foreign owner identity',c=>c.records.set('authIdentities/owner_fixture',{companyId:'foreign_company',active:true})],
  ['nullable V1 downgrade',c=>{for(const doc of [c.queue().caseListCancellation,c.job.cancellationSheetWrite.caseListCancellation]){doc.schema='LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V1';delete doc.assignmentMode;}}],
 ])await test('nullable authority rejects '+name+' without touching staff or the Source',async()=>{const c=await setup();await c.prepare();change(c);assert.equal((await c.run()).status,'HELD');assert.equal(c.posts(),0);noStaffOperations();});
 await test('old open publication without new SourcePub ACK cannot enqueue cancellation',async()=>{const c=await setup();c.job.status='open';const before=JSON.stringify([...c.records]);await assert.rejects(()=>c.cancel());assert.equal(JSON.stringify([...c.records]),before);assert.equal(H.documentWrites.length,0);noStaffOperations();});
 await test('owner read-only route cannot invent dispatch proof or perform a POST',async()=>{const c=await setup();await c.prepare();c.queue().status='blocked';c.queue().retryAt=null;const result=await c.reconcile();assert.equal(result.status,'HELD');assert.equal(c.posts(),0);assert.equal(c.job.cancellationSheetWrite.sourceAckPending,true);noStaffOperations();});
 await test('published BK headcount remains required even when the old approval exists',async()=>{const c=await setup({origin:'published'});c.h.cells[62]=literal(JSON.stringify({schema:'LKCM1_CASE_META_V1',publicEligible:true,headcountConfirmed:false}));c.rebase();await c.prepare();assert.equal((await c.run()).status,'HELD');assert.equal(c.posts(),0);noStaffOperations();});
 for(const unknown of [false,true])await test((unknown?'unknown native result':'pending native write')+' cannot restore or change unassigned cancellation history',async()=>{
  const c=await setup({ackLoss:unknown});await c.prepare();if(unknown)assert.equal((await c.run()).status,'HELD');
  const before=JSON.stringify([...c.records]),posts=c.posts(),job=c.job;
  await assert.rejects(()=>analytics.adminRestoreCancelledJob({auth:owner(c.f),data:{jobId:c.f.jobId,note:'must not restore pending cancellation'}}),e=>e.code==='failed-precondition');
  await assert.rejects(()=>c.cancel({reason:'changed',reasonNote:'changed'}),e=>e.code==='failed-precondition');
  for(const fields of [{assignedStaffId:'new_staff'},{dateKey:'2026-12-21'},{workDate:'2026-12-21'}])assert.throws(()=>retention.assertCancelledHistoricalAssignmentCanEdit(job,fields));
  assert.equal(JSON.stringify([...c.records]),before);assert.equal(c.posts(),posts);noStaffOperations();
 });
 await test('ACK protects unassigned cancellation history from restore, reason, assignee or date edits',async()=>{const c=await setup();await c.prepare();assert.equal((await c.run()).status,'SOURCE_CANCELLATION_READBACK_VERIFIED');const job=c.records.get('jobs/'+c.f.jobId),before=JSON.stringify([...c.records]);await assert.rejects(()=>analytics.adminRestoreCancelledJob({auth:owner(c.f),data:{jobId:c.f.jobId,expectedRevision:job.revision,note:'must not restore'}}),e=>e.code==='failed-precondition');await assert.rejects(()=>c.cancel({reason:'changed',reasonNote:'changed'}),e=>e.code==='failed-precondition');for(const fields of [{assignedStaffId:'new_staff'},{dateKey:'2026-12-21'},{workDate:'2026-12-21'}])assert.throws(()=>retention.assertCancelledHistoricalAssignmentCanEdit(job,fields));assert.equal(JSON.stringify([...c.records]),before);noStaffOperations();});
 await test('private company request counts retain unassigned cancellation without inventing a staff request',async()=>{const c=await setup();await c.prepare();await c.run();const job=c.records.get('jobs/'+c.f.jobId),core=H.load('analytics-core'),dashboard=core.buildMonthlyDashboard([job],job.dateKey.slice(0,7),'2026-12-31'),history=core.buildStaffRequestHistory([job],'nonexistent-staff','2026-01-01','2026-12-31');assert.equal(dashboard.counts.totalRequests,1);assert.equal(dashboard.counts.cancelled,1);assert.equal(history.totalRequests,0);assert.equal([...c.records.keys()].some(key=>key.startsWith('staffDayLocks/')||key.startsWith('staffProfiles/')),false);noStaffOperations();});
 await test('cancelled unassigned result stays out of normal Admin, staff shifts and calendar',async()=>{const c=await setup();await c.prepare();await c.run();const job={id:c.f.jobId,...c.records.get('jobs/'+c.f.jobId)},staff=H.loadUiModel('apps/staff/src/job-list.ts'),calendar=H.loadUiModel('apps/staff/src/monthly-shift-calendar.ts'),admin=H.loadUiModel('apps/admin/src/job-search.ts');assert.equal(staff.pendingAssignedJobs([job],'2026-11-01').length,0);assert.equal(staff.splitAssignedJobs([job],'2026-11-01').upcoming.length,0);assert.equal(calendar.monthCalendar([job],job.dateKey.slice(0,7)).jobs.size,0);assert.equal(admin.filterJobSearchIndex(admin.buildJobSearchIndex([job]),'','all').length,0);assert.equal(admin.filterJobSearchIndex(admin.buildJobSearchIndex([job]),'','cancelled').length,1);});
 console.log(JSON.stringify({status:'PASS',tests:results.length,scope:'ACTUAL_UNASSIGNED_CANCELLATION_CALLABLES_AND_NATIVE_HELPER_WITH_NATIVE_COMPACT_PROOFS',cloudBusinessWrites:0,results},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
