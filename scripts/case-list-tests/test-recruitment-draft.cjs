'use strict';
// Actual generateJobExport purpose branch + actual Source publication reader
// and existing formatter. Only Firestore / Google transport are mocked.
const assert=require('node:assert/strict');
const {z}=require('zod');
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {environment,fixture,putJob,source,confirmation,owner,company,actor,jobId,caseId,str,core,load,HttpsError}=require('./test-source-io.cjs');
const ids=load('case-id.ts',{},['createJobIdFromPersistedCaseId']);
const clone=v=>structuredClone(v);
const SUBJECT='【案件メール】';
const records=e=>e.dbState.state;
function setup({count=1,region='東京',formatterFault}={}){
 const f=fixture();f.rows[1][56]=str(region);
 for(let i=1;i<count;i++){
  const id='LKCASE_00000000-0000-5000-8000-'+String(i+1).padStart(12,'0');
  const row=clone(f.rows[1]);row[60]=str(id);row[11]=str('合成店舗'+i);f.rows.push(row);
  const ledger=clone(f.ledger[3]);ledger[0]=str(id);ledger[19]=str(JSON.stringify({schema:'LK_HISTORY_CORE_SNAPSHOT_V1',caseId:id,monthly:null}));f.ledger.push(ledger);
 }
 const e=environment(f),entries=core.inspectCaseList(f.rows,f.ledger,'2026-10-27T00:00:00.000Z','synthetic_book_20261027').jobs;
 const selections=[];
 for(const entry of entries){
  const id=ids.createJobIdFromPersistedCaseId(company,entry.caseId);
  const job={...clone(entry.fields),companyId:company,caseId:entry.caseId,revision:3,caseListSource:clone(core.publicCaseListSource(entry.source)),caseListPublication:{sourceRevision:entry.source.sourceRevision},status:'open',sourceReady:true,publishable:true,recruitmentStopped:false,assignedStaffId:null,basePay:10000,publicPayOffer:{dailyWageJPY:10000,travelExpenses:'全額支給',communicationExpenses:'全額支給'},financials:{secret:'PRIVATE_FINANCE_MARKER'},assignedStaffName:null};
  records(e).set('jobs/'+id,job);
  records(e).set('caseListApprovals/'+id,{...confirmation(e),expectedSourceRevision:entry.source.sourceRevision,companyId:company,jobId:id,actorUid:actor,confirmedRegion:region,privateReceipt:'PRIVATE_RECEIPT_MARKER'});
  selections.push({jobId:id,expectedJobRevision:3,expectedSourceRevision:entry.source.sourceRevision});
 }
 let transactions=0;
 const db={collection:e.db.collection,runTransaction:async(fn,options)=>{
  assert.equal(options.readOnly,true);assert.equal(Object.keys(options).join(','),'readOnly');transactions++;
  return e.db.runTransaction(tx=>fn({...tx,getAll:(...refs)=>Promise.all(refs.map(ref=>tx.get(ref))),set:()=>assert.fail('read-only draft set'),update:()=>assert.fail('read-only draft update'),delete:()=>assert.fail('read-only draft delete'),create:()=>assert.fail('read-only draft create')}));
 }};
 const formatter=require('../../functions/src/recruitment-mail-core.cjs');
 const stubs={'./firebase':{db},'./case-list-source':e.adapter,'firebase-functions/v2/https':{HttpsError},zod:{z}};
 if(formatterFault)stubs['../src/recruitment-mail-core.cjs']={...formatter,compose:(...args)=>{if(formatterFault==='throw')throw Error('formatter rejected');const out=formatter.compose(...args);return formatterFault==='partial'?{...out,caseCount:0}:{...out,warnings:[{code:'REJECTED_ONE_CASE'}]};}};
 const bridge=load('case-list-recruitment.ts',stubs,['generateCaseListRecruitmentDraft']);
 const command={purpose:'recruitment-draft',subject:SUBJECT,notice:'',region,selections};
 const run=(patch={},token=owner)=>bridge.generateCaseListRecruitmentDraft({...command,...patch},company,token);
 const first=()=>records(e).get('jobs/'+selections[0].jobId);
 const approval=()=>records(e).get('caseListApprovals/'+selections[0].jobId);
 return {...e,bridge,command,run,first,approval,transactions:()=>transactions};
}
const results=[];async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.stack});}}
const rejected=async(fn,code)=>assert.rejects(fn,error=>!code||error.code===code);
function refreshAuthority(e) {
 const entries=core.inspectCaseList(e.f.rows,e.f.ledger,'2026-10-27T00:00:00.000Z','synthetic_book_20261027').jobs;
 for(const entry of entries){const id=ids.createJobIdFromPersistedCaseId(company,entry.caseId),job=records(e).get('jobs/'+id);job.caseListSource=core.publicCaseListSource(entry.source);job.caseListPublication.sourceRevision=entry.source.sourceRevision;records(e).get('caseListApprovals/'+id).expectedSourceRevision=entry.source.sourceRevision;e.command.selections.find(row=>row.jobId===id).expectedSourceRevision=entry.source.sourceRevision;}
}
(async()=>{
 await test('formatter is the unchanged reviewed LK_RM_CORE_V1 source',async()=>{const bytes=fs.readFileSync(path.join(__dirname,'../../functions/src/recruitment-mail-core.cjs'));assert.equal(createHash('sha256').update(bytes).digest('hex'),'bf63bb0851e39b27a1dc759caec8e693501dc874a7d9b35884935c7d5bf362b2');});
 await test('GAS source builder uses canonical formatter and retains adapter tail byte-for-byte',async()=>{
  const {bundleRecruitmentGas}=await import('../build-recruitment-gas.mjs');
  const tail='\n/* Fast read-only adapter. Synthetic non-executed adapter */\nvar LK_RM_ADAPTER_V1 = {fixture: true};\n';
  const before='/* Public recruitment text only. Synthetic old prefix */\nvar LK_RM_CORE_V1 = {};'+tail;
  const out=bundleRecruitmentGas(before),coreText=fs.readFileSync(path.join(__dirname,'../../functions/src/recruitment-mail-core.cjs'),'utf8');
  assert.equal(out,coreText.trimEnd()+'\n'+tail);assert.equal(out.slice(out.indexOf('\n/* Fast read-only adapter.')),tail);
  for(const bad of ['invalid',before+tail])assert.throws(()=>bundleRecruitmentGas(bad),/BOUNDARY_REQUIRED/);
 });
 await test('existing approved publisher -> fresh Source/ledger -> same formatter, no writes',async()=>{
  const e=setup();const out=await e.run();
  assert.equal(out.caseCount,1);assert.equal(out.subject,SUBJECT);assert.equal(out.dispatch,'disabled');assert.equal(out.region,'東京');assert.equal(out.validatedAt,'2026-10-27T00:00:00.000Z');
  assert.equal(out.body,'お疲れ様です！\n\n下記案件でスタッフを募集しております。\n希望者はご連絡ください。\n\n【条件】\n日給10,000円＋交通費＆通信費全額支給\n※別条件の場合は、案件毎に記載有\n\n【11/20（金）】\n※合成依頼元\n合成メーカー：合成試食\n入店9:30／実施10:00～18:00\n・合成店舗');
  assert.equal(e.requests.length,2);assert.equal(e.capabilityChecks.length,1);assert.equal(e.dbState.writes.length,0);
  assert.deepEqual(Object.keys(out).sort(),['purpose','subject','body','caseCount','region','validatedAt','dispatch'].sort());
 });
 await test('public offer is the confirmed 12,000, not financial or source supplier amount',async()=>{
  const e=setup();e.first().basePay=12000;e.first().publicPayOffer.dailyWageJPY=12000;e.approval().payOffer.dailyWageJPY=12000;
  e.f.rows[1][36]={userEnteredValue:{numberValue:12000},effectiveValue:{numberValue:12000}};refreshAuthority(e);
  const out=await e.run();assert.match(out.body,/★日給12,000円/);assert.equal(e.dbState.writes.length,0);
 });
 await test('confirmed public wage must match native Source AK basic before recruiting',async()=>{const e=setup();e.first().basePay=12000;e.first().publicPayOffer.dailyWageJPY=12000;e.approval().payOffer.dailyWageJPY=12000;await rejected(()=>e.run(),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 await test('private Q/finance/BK provenance/receipt is absent in public return',async()=>{
  const e=setup();e.f.rows[1][16]=str('PRIVATE_Q_NOTE_MARKER');e.f.rows[1][19]=str('PRIVATE_AMOUNT_MARKER');
  e.f.rows[1][62]=str(JSON.stringify({schema:'LKCM1_CASE_META_V1',publicEligible:true,headcountConfirmed:true,privateData:'PRIVATE_PROVENANCE_MARKER'}));
  const entry=core.inspectCaseList(e.f.rows,e.f.ledger,'2026-10-27T00:00:00.000Z','synthetic_book_20261027').jobs[0];
  e.first().caseListSource=core.publicCaseListSource(entry.source);e.first().caseListPublication.sourceRevision=entry.source.sourceRevision;e.approval().expectedSourceRevision=entry.source.sourceRevision;e.command.selections[0].expectedSourceRevision=entry.source.sourceRevision;
  const out=await e.run();const text=JSON.stringify(out);for(const marker of ['PRIVATE_','synthetic_book','sourceRevision','actorUid','jobId','caseId','financials','reviewedIssues'])assert.ok(!text.includes(marker),marker);assert.equal(e.dbState.writes.length,0);
 });
 for(const [name,patch]of [['assigned ID',{assignedStaffId:'staff-1'}],['retained name',{assignedStaffName:'Private assigned staff'}],['cancelled',{cancelled:true}],['cancelled status',{status:'cancelled'}],['not open',{status:'draft'}],['not publishable',{publishable:false}],['not source-ready',{sourceReady:false}],['stopped',{recruitmentStopped:true}],['missing source',{sourceMissing:true}],['unresolved',{assignmentUnresolved:true}],['application pending',{applicationUnconfirmed:true}],['manual pending',{caseListManualPending:{state:'PENDING'}}],['pending source write',{pendingSourceWrite:true}],['admin edit pending',{adminEditSheetWrite:{pending:true}}],['assignment pending',{assignmentSheetWrite:{pending:true}}],['cancel ack pending',{cancellationSheetWrite:{sourceAckPending:true}}],['monthly linked',{sheetRef:{spreadsheetId:'private'}}],['wrong company',{companyId:'other'}],['non-CaseList',{caseListSource:null}]])await test('current app holds '+name,async()=>{const e=setup();Object.assign(e.first(),patch);await rejected(()=>e.run());assert.equal(e.dbState.writes.length,0);});
 for(const [name,change]of [['missing private approval',e=>records(e).delete('caseListApprovals/'+e.command.selections[0].jobId)],['wrong private company',e=>e.approval().companyId='other'],['wrong private job',e=>e.approval().jobId='other'],['missing owner actor',e=>delete e.approval().actorUid],['old approval',e=>e.approval().expectedSourceRevision='f'.repeat(64)],['old job revision',e=>e.first().revision++],['old Source',e=>e.f.rows[1][11]=str('new store')],['old ledger',e=>e.f.ledger[3][9]=str('Private assigned staff')],['old app fields',e=>e.first().menuName='old menu'],['old app pay',e=>e.first().basePay=9999],['old public offer',e=>e.first().publicPayOffer.travelExpenses='unconfirmed'],['old publication receipt',e=>e.first().caseListPublication.sourceRevision='f'.repeat(64)],['missing publication receipt',e=>delete e.first().caseListPublication],['legacy approval lacks region',e=>delete e.approval().confirmedRegion],['region mismatch',e=>e.approval().confirmedRegion='東北'],['unsupported capability',e=>e.state.capabilityReject=true]])await test('authoritative comparison holds '+name,async()=>{const e=setup();change(e);await rejected(()=>e.run(),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 for(const token of [{...owner,role:'staff'},{...owner,email_verified:false},{...owner,email:'other@example.invalid'}])await test('unverified/nonexecutive performs zero reads',async()=>{const e=setup();await rejected(()=>e.run({},token),'permission-denied');assert.equal(e.requests.length,0);assert.equal(e.transactions(),0);});
 for(const [name,patch]of [['empty selection',{selections:[]}],['21 selection cap',{selections:Array.from({length:21},(_,i)=>({jobId:'job_'+i,expectedJobRevision:1,expectedSourceRevision:'a'.repeat(64)}))}],['caller approval',{approval:{approved:true}}],['caller public field',{cases:[{client:'forged'}]}],['caller company',{companyId:'other'}],['caller finance',{financials:{basePay:100000}}],['unknown purpose',{purpose:'send'}],['unknown subject',{subject:'Forged Subject'}],['blank region',{region:''}],['untrimmed region',{region:' 東京'}],['overlong notice',{notice:'x'.repeat(4001)}],['forged job path',{selections:[{jobId:'jobs/other',expectedJobRevision:1,expectedSourceRevision:'a'.repeat(64)}]}]])await test('strict command rejects '+name,async()=>{const e=setup();await rejected(()=>e.run(patch));assert.equal(e.requests.length,0);assert.equal(e.transactions(),0);});
 await test('duplicate selected ID rejected before any reads',async()=>{const e=setup();await rejected(()=>e.run({selections:[...e.command.selections,...e.command.selections]}),'invalid-argument');assert.equal(e.requests.length,0);assert.equal(e.transactions(),0);});
 await test('region cannot be overridden by caller or private approval',async()=>{const e=setup();e.approval().confirmedRegion='東北';await rejected(()=>e.run({region:'東北'}),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 await test('blank Source BE cannot be replaced with owner region',async()=>{const e=setup({region:''});await rejected(()=>e.run({region:'通常'}),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 for(const sourceState of ['確認待ち','終了'])await test('Source '+sourceState+' cannot be bypassed by approval',async()=>{const e=setup();e.f.rows[1][55]=str(sourceState);const entry=core.inspectCaseList(e.f.rows,e.f.ledger,'2026-10-27T00:00:00.000Z','synthetic_book_20261027').jobs[0];e.first().caseListSource=core.publicCaseListSource(entry.source);e.approval().expectedSourceRevision=entry.source.sourceRevision;e.command.selections[0].expectedSourceRevision=entry.source.sourceRevision;await rejected(()=>e.run(),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 for(const [name,value] of [['public note',str('公開注意事項を確認してください')],['formula even empty',{userEnteredValue:{formulaValue:'=""'},effectiveValue:{stringValue:''}}],['number',{userEnteredValue:{numberValue:1}}],['boolean',{userEnteredValue:{boolValue:false}}],['unobserved effective only',{effectiveValue:{stringValue:'公開条件'}}]])await test('fresh BM '+name+' holds instead of silently dropping a condition',async()=>{const e=setup();e.f.rows[1][64]=value;refreshAuthority(e);await rejected(()=>e.run(),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 for(const column of [31,32,33,34,35])for(const [label,value]of [['nonzero',{userEnteredValue:{numberValue:1000},effectiveValue:{numberValue:1000}}],['unresolved formula',{userEnteredValue:{formulaValue:'=SYNTHETIC_UNRESOLVED()'}}],['empty effective formula',{userEnteredValue:{formulaValue:'=SYNTHETIC_UNKNOWN()'},effectiveValue:{}}]])await test('additional public allowance column '+column+' '+label+' holds instead of silently omitting pay',async()=>{const e=setup();e.f.rows[1][column]=value;refreshAuthority(e);await rejected(()=>e.run(),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 await test('proven zero public extras do not fabricate an allowance',async()=>{const e=setup();e.f.rows[1][31]={userEnteredValue:{formulaValue:'=0'},effectiveValue:{numberValue:0}};refreshAuthority(e);const out=await e.run();assert.equal(out.caseCount,1);assert.ok(!out.body.includes('★遠方'));});
 for(const hint of ['研修','OJT','ラウンダー','出口調査','グレイス','グレース'])await test('fresh Q unsupported type '+hint+' remains held and private',async()=>{const e=setup();e.f.rows[1][16]=str(hint+' PRIVATE_Q');refreshAuthority(e);await rejected(()=>e.run(),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 for(const fault of ['warning','partial','throw'])await test('formatter '+fault+' prevents a partial ready-looking draft',async()=>{const e=setup({formatterFault:fault});await rejected(()=>e.run(),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 await test('20 selections compose all and leak no private source identifiers',async()=>{const e=setup({count:20});const out=await e.run();assert.equal(out.caseCount,20);assert.equal(e.capabilityChecks.length,20);assert.equal(e.dbState.writes.length,0);assert.ok(!JSON.stringify(out).includes('LKCASE_'));});
 await test('one stale selection stops complete batch without partial text or writes',async()=>{const e=setup({count:2});records(e).get('jobs/'+e.command.selections[1].jobId).revision++;await rejected(()=>e.run(),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 await test('two Source regions cannot be mixed even with requested one region',async()=>{const e=setup({count:2});e.f.rows[2][56]=str('東北');await rejected(()=>e.run(),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 await test('each copy-equivalent revalidation catches later assignment',async()=>{const e=setup();await e.run();e.first().assignedStaffId='now-assigned';await rejected(()=>e.run(),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 // Existing callable dispatch stays behind admin + operational checks and uses
 // only the verified module. Existing CSV tests cover its unaffected branch.
 await test('existing generateJobExport routes draft without CSV query or export log',async()=>{
  const e=setup(),calls=[];const noop={};
  const api=load('job-management.ts',{'node:crypto':require('node:crypto'),'firebase-admin/firestore':{FieldValue:{},Timestamp:{}},'firebase-functions/v2/https':{HttpsError,onCall:(...args)=>args.at(-1)},'firebase-functions/v2/scheduler':{onSchedule:(...args)=>args.at(-1)},zod:{z},'./firebase':{db:{collection:()=>assert.fail('CSV path query/log')}} ,'./case-id':noop,'./job-group-creation':noop,'./native-job-creation':noop,'./case-mail-job-creation':noop,'./case-mail-publication':noop,'./assignment-preparation-core':noop,'./sheet-write-core':noop,'./cancellation-history-retention-core':noop,'./admin-edit-state-core':noop,'./job-management-core':noop,'./case-list-recruitment':e.bridge,'./utils':{requireAdmin:r=>{calls.push('auth');if(r.auth?.token.role!=='admin')throw new HttpsError('permission-denied','admin required');return r.auth;},companyFromClaims:t=>t.companyId},'./system-safety':{assertProductionOperational:async c=>{calls.push('operational');assert.equal(c,company);}}},['generateJobExport']);
  const out=await api.generateJobExport({data:e.command,auth:{token:owner}});assert.equal(out.caseCount,1);assert.deepEqual(calls,['auth','operational']);assert.equal(e.dbState.writes.length,0);
  await rejected(()=>api.generateJobExport({data:e.command,auth:{token:{...owner,role:'staff'}}}),'permission-denied');
  await rejected(()=>api.generateJobExport({data:{purpose:'send'},auth:{token:owner}}),'invalid-argument');
 });
 console.log(JSON.stringify({status:results.every(r=>r.passed)?'PASS':'FAIL',tests:results.length,passed:results.filter(r=>r.passed).length,scope:'ACTUAL_CALLABLE_SOURCE_READER_AND_SHARED_FORMATTER',nativeRequests:0,externalWrites:0,results},null,2));
 if(results.some(r=>!r.passed))process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
