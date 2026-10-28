'use strict';
// Portable controller only: synthetic complete rows and recording transports.
// No production registration, Firestore, Google, Rules or GAS is executed here.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const Core=require('../../functions/src/case-list-monthly-controller.cjs');
const copy=x=>JSON.parse(JSON.stringify(x)),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const hash=x=>sha(typeof x==='string'?x:Core.canonical(x));
const literal=value=>{const key=typeof value==='number'?'numberValue':typeof value==='boolean'?'boolValue':'stringValue';return {userEnteredValue:{[key]:value},effectiveValue:{[key]:value}};};
const writable=cell=>Object.fromEntries(['userEnteredValue','note','userEnteredFormat','dataValidation','textFormatRuns','chipRuns'].filter(key=>Object.hasOwn(cell,key)).map(key=>[key,copy(cell[key])]));
function fixture({loseAck=false}={}){
 const book='SYNTHETIC_MANUAL_CONTROLLER_BOOK',caseId='LKCASE_00000000-0000-0000-0000-000000000001',operationId='manual-queue',date='2026-11-20';
 const serial=(Date.parse(date+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000;
 const cells=Array.from({length:65},()=>({}));
 for(const [column,value]of [[0,false],[1,serial],[2,'合成別名'],[10,'合成クライアント'],[11,'合成店舗'],[12,'合成メーカー'],[13,'合成業務'],[14,'09:45'],[15,'10:00〜18:00'],[16,'業務備考'],[36,10000],[47,'元の私用メモ'],[55,'募集中'],[58,'単日'],[60,caseId],[63,false]])cells[column]=literal(value);
 cells[16].note='保持するセル注記';
 const source={sheetId:2026101601,headers:copy(Core.SOURCE_HEADERS),rows:[{row:2,caseId,cells,staffId:'staff-one',staffIdentityVerified:true}]};
 const other=Array.from({length:55},()=>({}));
 for(const [column,value]of [[0,serial],[1,'別の合成スタッフ'],[9,'合成クライアント'],[10,'別店舗'],[11,'合成メーカー'],[12,'合成業務'],[13,'08:30'],[14,'09:00〜17:00'],[54,'LKCASE_00000000-0000-0000-0000-000000000002']])other[column]=literal(value);
 const total=Array.from({length:55},()=>({}));total[0]=literal(serial);total[1]={userEnteredValue:{formulaValue:'="（"&(COUNTIF($A$2:$A$3, A3)-1)&"人）"'},effectiveValue:{stringValue:'（1人）'}};
 const month={title:'2026.11',sheetId:1773116117,headers:[...Core.BUSINESS_HEADERS,'連絡_固定案件ID'],rowCount:3,rows:[{row:2,fixedId:other[54].userEnteredValue.stringValue,cells:other,staffId:'other-staff',staffIdentityVerified:true},{row:3,fixedId:'',cells:total}]};
 const catalog={version:1,spreadsheetId:book,sheetId:2026101601,caseId,rowRevision:hash(cells),ledgerRevision:hash('ledger'),sourceRevision:hash('source')};
 const snapshot={spreadsheetId:book,isolated:true,source,months:[month],catalog,dependencyHash:hash('dependencies')};
 const assignment={schema:'LK_CASE_LIST_MANUAL_ASSIGN_V1',authority:'SOURCE_MANUAL',queueId:operationId,operationId,companyId:'synthetic-company',jobId:'synthetic-job',caseId,staffId:'staff-one',staffName:'合成別名',canonicalStaffName:'合成スタッフ',dateKey:date,assignedJobRevision:2,preCatalog:{rowRevision:catalog.rowRevision,ledgerRevision:catalog.ledgerRevision,sourceRevision:catalog.sourceRevision},preMonthlyContentHash:Core.contentHash({sha256:sha},cells),observationHash:hash('import-observation'),ownerConditionsHash:hash('owner-conditions'),publicPayOffer:{dailyWageJPY:10000,travelExpenses:'全額支給',communicationExpenses:'全額支給'}};
 const observed={schema:'LK_SOURCE_MANUAL_OBSERVED_V1',stage:'SOURCE_MANUAL_OBSERVED',spreadsheetId:book,operationId,caseId,assignment:copy(assignment),assignmentHash:hash(assignment),preCatalog:copy(catalog),postCatalog:copy(catalog),preMonthlyContentHash:assignment.preMonthlyContentHash,postMonthlyContentHash:assignment.preMonthlyContentHash,sourceSnapshot:cells.map(writable),dependencyHash:snapshot.dependencyHash,observationHash:assignment.observationHash,ownerConditionsHash:assignment.ownerConditionsHash,createdAt:100};
 observed.observationProofHash=hash({...observed,createdAt:0});
 const events=[observed];let selected=true,sourceWrites=0,monthlyWrites=0;
 const selection=()=>selected?{schema:'LK_OWNER_MONTHLY_TRANSFER_V1',selected:true,clientNameUpConfirmed:true,sourceControlHeader:'キャンセル',operationId,caseId,assignmentHash:hash(assignment),sourceContentHash:assignment.preMonthlyContentHash,sourceRevision:catalog.sourceRevision,selectedBy:'owner-one',selectedAt:101}:{};
 const services={spreadsheetId:book,sha256:sha,now:()=>200,withLock:fn=>fn(),authorize:async()=>{},readSnapshot:async()=>copy(snapshot),resolveAssignment:async()=>copy(assignment),readEvents:async()=>copy(events),appendEvent:async event=>events.push(copy(event)),authorizeMonthlyTransfer:async()=>selection(),applySourceAssignment:async()=>{sourceWrites++;throw Error('MANUAL_SOURCE_WRITE_FORBIDDEN');},applyMonthly:async intent=>{
  Core.assertMonthlyWritePreflight(snapshot,intent,{sha256:sha});monthlyWrites++;
  const row=intent.mapped.business.map((cell,index)=>({...copy(cell),...(cells[index+1].effectiveValue?{effectiveValue:copy(cells[index+1].effectiveValue)}:{})}));row[54]=copy(intent.mapped.idCell);
  month.rows[1].row=4;month.rows[1].cells[1]={userEnteredValue:{formulaValue:'="（"&(COUNTIF($A$2:$A$4, A4)-1)&"人）"'},effectiveValue:{stringValue:'（2人）'}};
  month.rows.splice(1,0,{row:3,fixedId:caseId,cells:row,staffId:'staff-one',staffIdentityVerified:true});month.rowCount=4;
  if(loseAck)throw Error('synthetic response lost');
 }};
 return {core:Core.create(services),request:{operationId,caseId},assignment,cells,snapshot,catalog,events,observed,counts:()=>({sourceWrites,monthlyWrites}),unselect:()=>{selected=false;},select:()=>{selected=true;}};
}
function rehashObserved(h){const normalized={...h.observed,createdAt:0};delete normalized.observationProofHash;h.observed.observationProofHash=hash(normalized);}
async function held(fn,pattern){const result=await fn();assert.equal(result.status,'HELD',JSON.stringify(result));assert.match(result.reason,pattern);}
const results=[];async function test(name,fn){await fn();results.push({name,passed:true});}
(async()=>{
 await test('manual entry before explicit selection cannot prepare monthly or create Source events',async()=>{const h=fixture();h.unselect();await held(()=>h.core.prepareMonthly(h.request),/OWNER_TRANSFER_SELECTION_REQUIRED/);assert.deepEqual(h.counts(),{sourceWrites:0,monthlyWrites:0});assert.deepEqual(h.events.map(e=>e.stage),['SOURCE_MANUAL_OBSERVED']);});
 await test('selected manual alias transfers through common monthly phases with unchanged Source and exact ACK',async()=>{const h=fixture(),before=copy(h.cells);const prepared=await h.core.prepareMonthly(h.request);assert.equal(prepared.status,'MONTHLY_INTENT_PREPARED');assert.deepEqual(prepared.intent.preCatalog,prepared.intent.postCatalog);assert.equal(prepared.intent.preMonthlyContentHash,prepared.intent.postMonthlyContentHash);assert.equal((await h.core.applyMonthly(h.request)).status,'MONTHLY_WRITE_DISPATCHED');const result=await h.core.reconcile(h.request);assert.equal(result.status,'MONTHLY_READBACK_VERIFIED');assert.deepEqual(result.ack.preCatalog,result.ack.postCatalog);assert.equal(result.ack.preMonthlyContentHash,result.ack.postMonthlyContentHash);assert.equal(result.ack.staffId,'staff-one');assert.equal(result.ack.staffName,'合成別名');assert.equal(result.ack.placementVerification.chronologicalPlacementAccepted,true);assert.deepEqual(h.cells,before);assert.deepEqual(h.counts(),{sourceWrites:0,monthlyWrites:1});assert.deepEqual(h.events.map(e=>e.stage),['SOURCE_MANUAL_OBSERVED','INTENT','MONTHLY_WRITE_STARTED','MONTHLY_DISPATCHED','ACCEPTED']);assert.equal(prepared.intent.mapped.business[15].note,'保持するセル注記');assert.equal(prepared.intent.mapped.business[46].userEnteredValue.stringValue,'元の私用メモ');});
 await test('manual origin cannot enter Source prepare/apply routes',async()=>{const h=fixture();await held(()=>h.core.prepareSource(h.request),/MANUAL_SOURCE_WRITE_PHASE_FORBIDDEN/);await held(()=>h.core.applySource(h.request),/MANUAL_SOURCE_WRITE_PHASE_FORBIDDEN/);await held(()=>h.core.reconcileSource(h.request),/MANUAL_SOURCE_WRITE_PHASE_FORBIDDEN/);assert.deepEqual(h.counts(),{sourceWrites:0,monthlyWrites:0});});
 await test('manual unknown monthly response is never automatically resent',async()=>{const h=fixture({loseAck:true});await h.core.prepareMonthly(h.request);assert.equal((await h.core.applyMonthly(h.request)).status,'MONTHLY_WRITE_UNKNOWN');assert.equal((await h.core.applyMonthly(h.request)).status,'MONTHLY_RECONCILIATION_REQUIRED');assert.deepEqual(h.counts(),{sourceWrites:0,monthlyWrites:1});assert.equal((await h.core.reconcile(h.request)).status,'MONTHLY_READBACK_VERIFIED');});
 await test('duplicate action after verified monthly returns same ACK with no additional write',async()=>{const h=fixture();await h.core.prepareMonthly(h.request);await h.core.applyMonthly(h.request);await h.core.reconcile(h.request);assert.equal((await h.core.applyMonthly(h.request)).status,'NO_OP_ALREADY_ACCEPTED');assert.deepEqual(h.counts(),{sourceWrites:0,monthlyWrites:1});});
 for(const [name,mutate,pattern]of [
  ['missing manual event',h=>h.events.splice(0),/MANUAL_SOURCE_OBSERVATION_REQUIRED/],
  ['unverified manual staff ID',h=>h.snapshot.source.rows[0].staffIdentityVerified=false,/MANUAL_SOURCE_STAFF_IDENTITY_CHANGED/],
  ['different stable staff ID',h=>h.snapshot.source.rows[0].staffId='another-staff',/MANUAL_SOURCE_STAFF_IDENTITY_CHANGED/],
  ['Source cancellation checkbox',h=>h.cells[0]=literal(true),/SOURCE_CANCELLED_OR_INVALID/],
  ['Source cancellation flag',h=>{h.cells[63]=literal(true);h.observed.sourceSnapshot=h.cells.map(writable);h.assignment.preMonthlyContentHash=Core.contentHash({sha256:sha},h.cells);},/MANUAL_SOURCE_OBSERVATION_BINDING_INVALID|OWNER_TRANSFER_SELECTION_REQUIRED/],
  ['Source body changed',h=>h.cells[16]=literal('changed'),/OWNER_TRANSFER_SELECTION_REQUIRED|MANUAL_SOURCE_OBSERVATION_CHANGED/],
  ['Source catalog changed',h=>h.catalog.rowRevision=hash('changed'),/MANUAL_SOURCE_OBSERVATION_CHANGED/],
  ['dependencies changed',h=>h.snapshot.dependencyHash=hash('changed'),/MANUAL_SOURCE_OBSERVATION_CHANGED/],
  ['owner business conditions changed',h=>{h.observed.ownerConditionsHash=hash('other');rehashObserved(h);},/MANUAL_SOURCE_OBSERVATION_BINDING_INVALID/],
  ['manual observation hash changed',h=>{h.observed.observationHash=hash('other');rehashObserved(h);},/MANUAL_SOURCE_OBSERVATION_BINDING_INVALID/],
  ['manual proof hash changed',h=>h.observed.observationProofHash=hash('other'),/MANUAL_SOURCE_OBSERVATION_BINDING_INVALID/],
  ['fake changed post catalog',h=>{h.observed.postCatalog.rowRevision=hash('other');rehashObserved(h);},/MANUAL_SOURCE_OBSERVATION_CHANGED/],
  ['fake changed post content',h=>{h.observed.postMonthlyContentHash=hash('other');rehashObserved(h);},/MANUAL_SOURCE_OBSERVATION_CHANGED/],
  ['unreviewed pay offer',h=>h.assignment.publicPayOffer.dailyWageJPY=9999,/MANUAL_SOURCE_OBSERVATION_BINDING_INVALID/],
 ])await test('manual monthly preparation holds '+name,async()=>{const h=fixture();mutate(h);await held(()=>h.core.prepareMonthly(h.request),pattern);assert.deepEqual(h.counts(),{sourceWrites:0,monthlyWrites:0});assert(!h.events.some(e=>e.stage==='INTENT'));});
 for(const stage of ['SOURCE_INTENT','SOURCE_PROJECTED','SOURCE_WRITE_STARTED','SOURCE_DISPATCHED','SOURCE_UNKNOWN','SOURCE_DEFERRED'])await test('manual origin rejects counterfeit Crew '+stage+' proof',async()=>{const h=fixture();h.events.push({stage,caseId:h.request.caseId,spreadsheetId:h.snapshot.spreadsheetId});await held(()=>h.core.prepareMonthly(h.request),/MANUAL_SOURCE_WRITE_PROOF_FORBIDDEN/);assert.deepEqual(h.counts(),{sourceWrites:0,monthlyWrites:0});});
 function cancellationHistoryRow(h,staffCell={}){const row=h.snapshot.months[0].rows[0];row.cells[9]=literal('合成クライアント（キャンセル）');row.cells[1]=staffCell;delete row.staffId;delete row.staffIdentityVerified;return row;}
 await test('literal cancellation marker with physically blank staff releases monthly occupancy for a different case',async()=>{const h=fixture();cancellationHistoryRow(h);assert.equal((await h.core.prepareMonthly(h.request)).status,'MONTHLY_INTENT_PREPARED');assert.equal((await h.core.applyMonthly(h.request)).status,'MONTHLY_WRITE_DISPATCHED');assert.equal((await h.core.reconcile(h.request)).status,'MONTHLY_READBACK_VERIFIED');assert.deepEqual(h.counts(),{sourceWrites:0,monthlyWrites:1});});
 await test('ASCII parenthesized cancellation marker with literal empty staff is recognized',async()=>{const h=fixture(),row=cancellationHistoryRow(h,literal(''));row.cells[9]=literal('合成クライアント(キャンセル)');assert.equal((await h.core.prepareMonthly(h.request)).status,'MONTHLY_INTENT_PREPARED');});
 await test('cancelled row retaining the selected fixed ID still blocks a second monthly row',async()=>{const h=fixture(),row=cancellationHistoryRow(h);row.fixedId=h.request.caseId;row.cells[54]=literal(h.request.caseId);await held(()=>h.core.prepareMonthly(h.request),/EXISTING_DESTINATION_WITHOUT_RECEIPT/);assert.deepEqual(h.counts(),{sourceWrites:0,monthlyWrites:0});});
 await test('cancelled blank monthly history must still have a verified native date',async()=>{const h=fixture(),row=cancellationHistoryRow(h);row.cells[0]=literal('unknown-date');await held(()=>h.core.prepareMonthly(h.request),/MONTHLY_ASSIGNMENT_DATE_UNVERIFIED/);assert.deepEqual(h.counts(),{sourceWrites:0,monthlyWrites:0});});
 await test('copied cancelled monthly fixed IDs still fail duplicate validation',async()=>{const h=fixture(),row=cancellationHistoryRow(h),duplicate=copy(row);duplicate.row=4;h.snapshot.months[0].rows.push(duplicate);await held(()=>h.core.prepareMonthly(h.request),/DUPLICATE_MONTHLY_ID/);assert.deepEqual(h.counts(),{sourceWrites:0,monthlyWrites:0});});
 await test('marked cancellation with a retained same stable staff stays occupied until native clearing',async()=>{const h=fixture(),row=cancellationHistoryRow(h,literal(h.assignment.staffName));row.staffId=h.assignment.staffId;row.staffIdentityVerified=true;await held(()=>h.core.prepareMonthly(h.request),/STAFF_ALREADY_ASSIGNED_SAME_DAY/);assert.deepEqual(h.counts(),{sourceWrites:0,monthlyWrites:0});});
 for(const [name,staff]of [
  ['formula with empty result',{userEnteredValue:{formulaValue:'=""'},effectiveValue:{stringValue:''}}],
  ['number',literal(0)],['boolean',literal(false)],['calculation error',{effectiveValue:{errorValue:{type:'REF'}}}],
  ['unknown cell',{$unknown:true}],['whitespace name',literal(' ')],['malformed value',{userEnteredValue:[]}],
 ])await test('marked cancellation cannot hide malformed staff '+name,async()=>{const h=fixture();cancellationHistoryRow(h,staff);await held(()=>h.core.prepareMonthly(h.request),/MONTHLY_STAFF_IDENTITY_UNVERIFIED/);assert.deepEqual(h.counts(),{sourceWrites:0,monthlyWrites:0});});
 for(const [name,client]of [
  ['unparenthesized marker',literal('合成クライアント キャンセル')],['marker within text',literal('合成（キャンセル）クライアント')],
  ['dynamic formula marker',{userEnteredValue:{formulaValue:'="合成（キャンセル）"'},effectiveValue:{stringValue:'合成（キャンセル）'}}],
  ['English cancelled text',literal('Client (cancelled)')],
 ])await test('unrecognized cancellation text does not release blank staff occupancy: '+name,async()=>{const h=fixture(),row=cancellationHistoryRow(h);row.cells[9]=client;await held(()=>h.core.prepareMonthly(h.request),/MONTHLY_STAFF_IDENTITY_UNVERIFIED/);assert.deepEqual(h.counts(),{sourceWrites:0,monthlyWrites:0});});
 await test('manual final adapter preflight retains strict effective basic-pay comparison',async()=>{const h=fixture();const prepared=await h.core.prepareMonthly(h.request);h.cells[36].effectiveValue.numberValue=9999;assert.throws(()=>Core.assertMonthlyWritePreflight(h.snapshot,prepared.intent,{sha256:sha}),/PUBLIC_PAY_OFFER_SOURCE_BASIC_MISMATCH/);assert.deepEqual(h.counts(),{sourceWrites:0,monthlyWrites:0});});
 console.log(JSON.stringify({status:'PASS',tests:results.length,scope:'PORTABLE_MANUAL_ORIGIN_CONTROLLER_WITH_SYNTHETIC_SOURCE_AND_RECORDING_TRANSPORT_ONLY',nativeAcceptance:false,results},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
