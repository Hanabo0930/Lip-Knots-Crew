'use strict';
// One physical synthetic Source/ledger/month and one Firestore map cross the
// production publication ACK, draft validator, apply/import, owner selection,
// monthly worker and frontend selectors. Business documents are never reseeded
// between these stages. Authentication and SDK transports are synthetic only.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const H = require('./test-worker-binding.cjs'), P = require('./test-publication-worker.cjs');
const src = path.resolve(__dirname, '../../functions/src');
const worker = H.load('case-list-monthly-worker');
const mailSubject = require('../../functions/src/recruitment-mail-core.cjs').subjects()[0];
const literal = value => ({userEnteredValue:{stringValue:value}, effectiveValue:{stringValue:value}});
class HttpsError extends Error { constructor(code, message, details) { super(message); this.code=code; this.details=details; } }
// Keep the business-date admission reproducible. Explicit dates and the real
// lease clock (Date.now/Stamp) retain the existing native harness semantics.
class FixtureDate extends Date { constructor(...args) { super(...(args.length?args:['2026-10-29T00:00:00.000Z'])); } }
function actualModules(h) {
  const cache = new Map();
  const db = {collection:H.db.collection, doc:p=>new H.Doc(p),
    getAll:(...refs)=>Promise.all(refs.map(ref=>ref.get())),
    runTransaction:(fn, options)=>H.db.runTransaction(tx=>fn({...tx,
      getAll:(...refs)=>Promise.all(refs.map(ref=>tx.get(ref))),
    }), options)};
  const auth = request => { assert.ok(request.auth); return request.auth; };
  const readOnlyGoogle = {spreadsheets:{get:async input=>{
    const snap=h.snapshot(); assert.equal(input.spreadsheetId,h.f.book);
    const rows=snap.rawRows, ledger=snap.rawLedgerRows;
    const sheets=[{properties:{sheetId:2026101601,title:'案件リスト',gridProperties:{rowCount:rows.length,columnCount:65}}},
      {properties:{sheetId:2026102605,title:'案件_実績台帳',gridProperties:{rowCount:ledger.length,columnCount:25}}}];
    if(input.includeGridData){
      assert.deepEqual([...input.ranges],[`'案件リスト'!A1:BM${rows.length}`,`'案件_実績台帳'!A1:Y${ledger.length}`]);
      sheets[0].data=[{startRow:0,startColumn:0,rowData:rows.map(values=>({values:H.copy(values)}))}];
      sheets[1].data=[{startRow:0,startColumn:0,rowData:ledger.map(values=>({values:H.copy(values)}))}];
    }
    return {data:{spreadsheetId:h.f.book,properties:{timeZone:'Asia/Tokyo'},sheets}};
  }}};
  function load(name) {
    if(cache.has(name))return cache.get(name);
    const filename=path.join(src,name+'.ts'), module={exports:{}};
    cache.set(name,module.exports);
    const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
    const requireActual = specifier => {
      if(specifier==='firebase-functions/v2/https')return {HttpsError,onCall:(...args)=>args.at(-1)};
      if(specifier==='firebase-admin/firestore')return {Timestamp:H.Stamp,FieldValue:H.FieldValue};
      if(specifier==='./firebase')return {db};
      if(specifier==='./utils')return {requireAuth:auth, requireAdmin:request=>{const user=auth(request);assert.equal(user.token.role,'admin');return user;},
        companyFromClaims:token=>token.companyId,staffFromClaims:token=>token.staffId,dateKeyFromIso:value=>value};
      if(specifier==='./system-safety')return {assertProductionOperational:async()=>{},getProductionOperationalState:async()=>({operational:true})};
      if(specifier==='./sheet-reader')return {createReadOnlySheetsClient:async()=>readOnlyGoogle};
      if(specifier==='./case-list-monthly-reader')return {readCaseListMonthlySnapshot:async(company,caseId,options={})=>{
        assert.equal(company,h.f.companyId);assert.equal(caseId,h.f.a.sourceCaseId);return h.snapshot(options.resolveStaff);
      }};
      if(specifier==='./automation-intake')return {readMailApplicationForAssignment:async()=>assert.fail('Mail application is outside this synthetic journey')};
      if(specifier==='./case-mail-publication')return {readMailPublication:async()=>assert.fail('Mail-origin publication is outside this journey')};
      if(['./case-list-monthly-worker','./case-list-source-core','./case-id','./sheet-write-core','./cancellation-history-retention-core'].includes(specifier))return H.load(specifier.slice(2));
      if(specifier.endsWith('.cjs'))return require(path.resolve(src,specifier));
      if(specifier.startsWith('./'))return load(specifier.slice(2));
      if(specifier.startsWith('node:')||specifier==='zod')return require(specifier);
      throw Error('Unexpected journey dependency '+specifier);
    };
    vm.runInNewContext(code,{module,exports:module.exports,require:requireActual,process,Buffer,Date:FixtureDate,console,Intl},{filename});
    cache.set(name,module.exports);return module.exports;
  }
  return {load};
}
const results=[];
async function journey(origin, december, cancelBeforeSelection=false) {
  const c=await P.setup({december}),{h,f,records}=c,actual=actualModules(h);
  const source=actual.load('case-list-source'),drafts=actual.load('case-list-recruitment'),jobs=actual.load('jobs');
  const owner={uid:'owner_fixture',companyId:f.companyId,role:'admin',email:'owner@example.invalid',email_verified:true};
  const publicJob=()=>({id:f.jobId,...H.copy(records.get('jobs/'+f.jobId))});
  const staffUI=H.loadUiModel('apps/staff/src/job-list.ts'),calendar=H.loadUiModel('apps/staff/src/monthly-shift-calendar.ts'),admin=H.loadUiModel('apps/admin/src/job-search.ts');
  const command=()=>({purpose:'recruitment-draft',region:'通常',subject:mailSubject,notice:'',selections:[{jobId:f.jobId,expectedJobRevision:publicJob().revision,expectedSourceRevision:publicJob().caseListSource.sourceRevision}]});
  await assert.rejects(()=>drafts.generateCaseListRecruitmentDraft(command(),f.companyId,owner));
  assert.equal(calendar.monthCalendar([publicJob()],f.a.dateKey.slice(0,7)).jobs.size,0);
  assert.equal((await c.run()).state,'PUBLISHED');
  const published=publicJob(),approval=records.get('caseListApprovals/'+f.jobId);
  assert.equal(approval.expectedSourceRevision,published.caseListSource.sourceRevision);
  const recordsBeforeDraft=JSON.stringify([...records]),draft=await drafts.generateCaseListRecruitmentDraft(command(),f.companyId,owner);
  assert.equal(draft.caseCount,1);assert.equal(draft.dispatch,'disabled');
  assert.ok(draft.body.includes(published.storeName));assert.ok(draft.body.includes('10,000'));
  assert.equal(JSON.stringify([...records]),recordsBeforeDraft,'Draft is read-only and uses actual publication ACK output');
  h.restoreAssignmentNative();
  if(origin==='application'){
    const request={data:{jobId:f.jobId,requestId:'connected-journey-request',expectedJobRevision:published.revision,expectedSourceRevision:published.caseListSource.sourceRevision},
      auth:{uid:'uid_fixture',token:{role:'staff',companyId:f.companyId,staffId:f.staffId}}};
    await jobs.applyToJob(request);
    const queues=()=>[...records].filter(([,value])=>value.operation==='case_list.assign');
    assert.equal(queues().length,1);
    const assignment=queues()[0];h.adoptQueue(assignment[0].split('/').at(-1));
    const nativeBeforeReplay=H.nativeCalls;await jobs.applyToJob(request);
    assert.equal(queues().length,1);assert.equal(H.nativeCalls,nativeBeforeReplay);
    await h.run();
    assert.equal(records.get(h.queueRef.path).errorType,'owner_transfer_required');
    await assert.rejects(()=>h.confirmNameUpAndSelect(false));
  }else{
    // The operator's only direct business edit. Google recalculation of the
    // existing C reference is emulated by the same native fixture convention.
    h.cells[2]=literal(f.staffName);h.cells[6].effectiveValue={stringValue:f.staffName};
    await source.executeCaseListImport(f.companyId,'commit','owner_fixture',owner);
    const job=publicJob(),observation=records.get('caseListManualObservations/'+f.jobId);
    assert.ok(observation,'Actual Source import produces the private manual observation');
    assert.equal(job.caseListManualPending.observationHash,observation.observationHash);
  }
  const pending=publicJob(),month=pending.dateKey.slice(0,7);
  assert.equal(pending.applicationUnconfirmed,true);
  assert.equal(staffUI.pendingAssignedJobs([pending],'2026-11-01').length,1);
  assert.equal(calendar.monthCalendar([pending],month).jobs.size,0);
  assert.equal(h.counts().monthCalls,0);
  await assert.rejects(()=>drafts.generateCaseListRecruitmentDraft(command(),f.companyId,owner));
  if(cancelBeforeSelection){
    const before=H.copy(h.cells),jobBefore=publicJob();
    await jobs.adminCancelJob({auth:{uid:owner.uid,token:owner},data:{jobId:f.jobId,expectedRevision:jobBefore.revision,reason:'合成案件の転記前取消'}});
    const item=[...records].find(([,value])=>value.operation==='job.cancel');
    assert.ok(item);const queueRef=new H.Doc(item[0]),queue=records.get(item[0]);
    Object.assign(queue,{status:'processing',claimToken:'connected_cancel_claim',retryAt:H.Stamp.fromMillis(Date.now()+600000)});
    let cancelPosts=0;
    H.db.doc=value=>new H.Doc(value);
    H.setNativeHandler(async(body,options)=>{
      cancelPosts++;assert.equal(body.spreadsheetId,f.book);assert.equal(options.retry,false);assert.equal(options.retryConfig.retry,0);
      const requests=body.requestBody.requests;assert.equal(requests.length,2);
      assert.deepEqual(Array.from(requests,r=>r.updateCells.range.startColumnIndex),[2,63]);
      for(const request of requests){const update=request.updateCells;
        assert.equal(update.fields,'userEnteredValue');assert.equal(update.range.sheetId,2026101601);
        assert.equal(update.range.endColumnIndex-update.range.startColumnIndex,1);
        const cell=h.cells[update.range.startColumnIndex],value=update.rows[0].values[0].userEnteredValue;
        if(value){cell.userEnteredValue=H.copy(value);cell.effectiveValue=H.copy(value);}
        else{delete cell.userEnteredValue;delete cell.effectiveValue;}
      }
      h.cells[6].effectiveValue={stringValue:''};return {};
    });
    const native=H.load('case-list-source-cancellation');
    const outcome=await native.processCaseListSourceCancellation(queueRef,H.copy(queue));
    assert.equal(outcome.status,'SOURCE_CANCELLATION_READBACK_VERIFIED',JSON.stringify(outcome));
    const cancelled=publicJob();assert.equal(cancelled.cancellationSheetWrite.sourceAckPending,false);
    assert.equal(cancelled.cancelled,true);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.publishable,false);
    assert.equal(cancelled.recruitmentStopped,true);assert.equal(cancelPosts,1);assert.equal(h.counts().monthCalls,0);
    assert.equal(h.cells[63].userEnteredValue.boolValue,true);
    for(let i=0;i<65;i++)if(![2,63].includes(i))for(const key of ['userEnteredValue','note','userEnteredFormat','dataValidation','textFormatRuns','chipRuns'])assert.deepEqual(h.cells[i][key],before[i][key],`${i}:${key}`);
    assert.equal(calendar.monthCalendar([cancelled],month).jobs.size,0);
    assert.equal(staffUI.pendingAssignedJobs([cancelled],'2026-11-01').length,0);
    assert.equal(admin.filterJobSearchIndex(admin.buildJobSearchIndex([cancelled]),'','all').length,0);
    assert.equal(admin.filterJobSearchIndex(admin.buildJobSearchIndex([cancelled]),'','cancelled').length,1);
    const analytics=H.load('analytics-core');
    assert.equal(analytics.buildMonthlyDashboard([cancelled],month,'2026-12-31').counts.totalRequests,1);
    assert.equal(analytics.buildStaffRequestHistory([cancelled],f.staffId,'2026-01-01','2026-12-31').totalRequests,1);
    const nativeBeforeReplay=H.nativeCalls;await native.processCaseListSourceCancellation(queueRef,H.copy(records.get(item[0])));
    assert.equal(H.nativeCalls,nativeBeforeReplay);assert.equal(cancelPosts,1);
    assert.equal(h.month.rows.filter(row=>row.fixedId===f.a.sourceCaseId).length,0);
    results.push({origin,month,path:'OWNER_CANCELLATION_BEFORE_MONTHLY_SELECTION',passed:true,cancelPosts});return;
  }
  if(origin==='application')await h.confirmNameUpAndSelect();
  else{
    const observation=records.get('caseListManualObservations/'+f.jobId);
    const selection={jobId:f.jobId,
      observationHash:observation.observationHash,expectedJobRevision:pending.revision,expectedSourceRevision:pending.caseListSource.sourceRevision,
      clientNameUpConfirmed:true,manualConfirmation:{confirmedFields:{arrival:true,execution:true,headcount:true,dateMode:true,payOffer:true},payOffer:published.publicPayOffer}};
    await assert.rejects(()=>worker.selectCaseListManualMonthlyTransfer(f.companyId,'owner_fixture',owner,{...selection,clientNameUpConfirmed:false}));
    const result=await worker.selectCaseListManualMonthlyTransfer(f.companyId,'owner_fixture',owner,selection);
    h.adoptQueue(result.queueId);
  }
  assert.equal(calendar.monthCalendar([publicJob()],month).jobs.size,0,'Selection alone does not confirm a shift');
  await h.run();
  const confirmed=publicJob();
  assert.equal(confirmed.assignmentSheetWrite.nativeAck.status,'MONTHLY_READBACK_VERIFIED');
  assert.equal(confirmed.applicationUnconfirmed,false);
  assert.equal(h.month.rows.filter(row=>row.fixedId===f.a.sourceCaseId).length,1);
  const shown=calendar.monthCalendar([confirmed],month).jobs.get(confirmed.dateKey)[0];
  for(const field of ['clientName','storeName','makerName','menuName','entryTime','workTime'])assert.equal(shown[field],published[field],field);
  assert.equal(staffUI.pendingAssignedJobs([confirmed],'2026-11-01').length,0);
  assert.equal(staffUI.splitAssignedJobs([confirmed],'2026-11-01').upcoming[0].id,f.jobId);
  assert.equal(admin.filterJobSearchIndex(admin.buildJobSearchIndex([confirmed]),'','all').length,0);
  assert.equal(admin.filterJobSearchIndex(admin.buildJobSearchIndex([confirmed]),'','monthly-transferred').length,1);
  const nativeBeforeReplay=H.nativeCalls;
  await h.run();assert.equal(H.nativeCalls,nativeBeforeReplay);
  assert.equal(h.month.rows.filter(row=>row.fixedId===f.a.sourceCaseId).length,1);
  assert.equal(h.cells[60].userEnteredValue.stringValue,f.a.sourceCaseId,'Source history row is retained');
  results.push({origin,month,passed:true,publicationPost:c.batches(),...h.counts()});
}
(async()=>{
  for(const december of [false,true])for(const origin of ['application','manual']){
    await journey(origin,december);await journey(origin,december,true);
  }
  console.log(JSON.stringify({status:'PASS',connectedJourneys:results.length,actualProductionValidators:true,sameBusinessDocumentsBetweenStages:true,
    scope:'PUBLICATION_ACK_DRAFT_ACTUAL_APPLY_OR_MANUAL_IMPORT_OWNER_SELECTION_MONTHLY_ACK_UI_AND_PRESELECTION_CANCELLATION_HISTORY',
    firestoreAndGoogleAreMocks:true,realMailSent:0,cloudWrites:0,results},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
