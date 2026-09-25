import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {localAcceptanceEnvironment,blockNonEmulatorConnections} from './local-firestore-acceptance-safety.mjs';
const environment=localAcceptanceEnvironment(process.env),network=blockNonEmulatorConnections(environment.port);
const require=createRequire(import.meta.url),{google}=require('googleapis');
const {analyzeFetchedCaseMail}=await import('./case-mail-intake-adapter.mjs');
const {db,storage}=require('../functions/lib/firebase.js'),safety=require('../functions/lib/system-safety.js');
const originalSheets=google.sheets,originalState=safety.getProductionOperationalState,originalMode=process.env.LKC_SHEET_WRITE_MODE,originalTransferMode=process.env.LKC_SUBMISSION_TRANSFER_MODE;
process.env.LKC_SHEET_WRITE_MODE='active';safety.getProductionOperationalState=async()=>({operational:true});
const load=name=>require('../functions/lib/'+name+'.js');
const driveFiles=new Map(),storageObjects=new Map();let allocated=0,driveCopies=0;
const drive={files:{
  generateIds:async()=>({data:{ids:['synthetic-drive-'+(++allocated)]}}),
  list:async()=>({data:{files:[{id:'synthetic-folder'}]}}),
  get:async({fileId})=>{if(!driveFiles.has(fileId))throw {code:404};return {data:structuredClone(driveFiles.get(fileId))};},
  create:async input=>{
    assert.ok(input.media,'only synthetic file transfers are allowed');
    const id=input.requestBody.id;if(driveFiles.has(id))throw {code:409};
    const file={...input.requestBody,id,size:'100',md5Checksum:'00000000000000000000000000000000',createdTime:new Date().toISOString()};
    driveFiles.set(id,file);driveCopies++;return {data:structuredClone(file)};
  }
}};
load('google-drive-client').getWritableDriveClient=()=>drive;
storage.bucket=(name='synthetic-bucket')=>{
  assert.equal(name,'synthetic-bucket');
  return {file:(key,options)=>({
    getMetadata:async()=>{if(!storageObjects.has(key))throw {code:404};return [structuredClone(storageObjects.get(key))];},
    createReadStream:()=>{assert.equal(options?.generation,'1');assert.ok(storageObjects.has(key));return {syntheticPath:key};},
    delete:async()=>{storageObjects.delete(key);}
  })};
};

const sheets=new Map(),results=[];let sequence=0,syntheticFetches=0,sheetReads=0,sheetWrites=0;
const column=s=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
function state(request){assert.ok(sheets.has(request.spreadsheetId),'synthetic sheet required');return sheets.get(request.spreadsheetId);}
function readRange(s,range){
 const m=/^'([^']+)'!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(range);assert.ok(m&&m[1]===s.month,'unexpected range '+range);
 const first=Number(m[3]||1)-1,last=Math.min(m[4]?Number(m[5]||s.rows.length):first+1,s.rows.length),left=column(m[2]),right=column(m[4]||m[2]);
 return s.rows.slice(first,last).map(row=>row.slice(left,right+1));
}
// workerの実書込要求を合成表に適用し、読取同期にも同じ表を返す。
google.sheets=()=>({spreadsheets:{
 get:async request=>{const s=state(request);sheetReads++;return {data:{sheets:[{properties:{sheetId:1,title:s.month,gridProperties:{rowCount:100,columnCount:55}},conditionalFormats:[]}]}};},
 batchUpdate:async request=>{const s=state(request);sheetWrites++;for(const item of request.requestBody.requests){
  if(item.insertDimension){const q=item.insertDimension.range;assert.equal(q.sheetId,1);assert.equal(q.dimension,'ROWS');const count=q.endIndex-q.startIndex;s.rows.splice(q.startIndex,0,...Array.from({length:count},()=>Array(55).fill('')));s.inserted+=count;}
  else if(item.updateCells){const q=item.updateCells;for(const [i,row] of q.rows.entries())for(const [j,cell] of row.values.entries()){const v=cell.userEnteredValue;s.rows[q.range.startRowIndex+i][q.range.startColumnIndex+j]=v?.stringValue??v?.numberValue??v?.boolValue??'';}}
  else if(item.deleteDimension){const q=item.deleteDimension.range;s.rows.splice(q.startIndex,q.endIndex-q.startIndex);s.deleted+=q.endIndex-q.startIndex;}
  else throw Error('Unexpected synthetic write '+Object.keys(item));
 }await s.afterWrite?.();return {data:{}};},
 values:{batchUpdate:async request=>{const s=state(request);sheetWrites++;for(const item of request.requestBody.data){const m=/^'([^']+)'!([A-Z]+)([0-9]+)$/.exec(item.range);assert.ok(m&&m[1]===s.month);s.rows[Number(m[3])-1][column(m[2])]=item.values[0][0];}return {data:{}};},get:async request=>{sheetReads++;return {data:{values:readRange(state(request),request.range)}};},batchGet:async request=>{sheetReads++;const s=state(request);return {data:{valueRanges:request.ranges.map(range=>({values:readRange(s,range)}))}};}}
}});
const management=require('../functions/lib/job-management.js'),worker=require('../functions/lib/sheet-row-creation.js'),sync=require('../functions/lib/shift-import.js'),jobs=require('../functions/lib/jobs.js');
const {createCaseMailReceiver}=require('../functions/lib/case-mail-intake.js'),{caseMailRecordKey}=require('../functions/lib/case-mail-job-creation.js');
const workDate=new Date(Date.now()+32*86400000).toISOString().slice(0,10),month=workDate.slice(0,4)+'.'+Number(workDate.slice(5,7));
const columns={workDate:'A',staffName:'B',temperature:'G',arrivalTime:'H',reportSubmitted:'I',transportation:'AK',purchase8:'AL',purchase10:'AM',netPrintCost:'AO',postageCost:'AP',clientName:'J',storeName:'K',makerName:'L',menuName:'M',entryTime:'N',workTime:'O',subcontractorName:'P',staffBasePay:'Q',caseId:'BC'};
async function fixture(slots=1){
 const companyId='synthetic-journey-'+(++sequence),spreadsheetId='synthetic-sheet-'+sequence,uid=companyId+'-receiver',auth={uid:companyId+'-admin',token:{companyId,role:'admin'}};
 const template=Array(55).fill('');Object.assign(template,{0:workDate,9:'合成取引先',10:'雛形店舗',11:'合成メーカー',12:'試食',13:'09:30',14:'10:00～18:00',54:'SYNTHETIC-TEMPLATE'});
 const sheet={month,rows:[Array(55).fill('header'),template],inserted:0,deleted:0};sheets.set(spreadsheetId,sheet);
 await db.doc('companyFeatureSettings/'+companyId).set({caseMailIntakeEnabled:true,caseMailJobCreationEnabled:true,adminJobCreationSourceReady:true});
 await db.doc('companies/'+companyId+'/sheetMappings/shift').set({enabled:true,spreadsheetId,idColumn:'BC',columns,identityColumns:{workDate:'A',clientName:'J',storeName:'K',workTime:'O'},rowCreation:{enabled:true,rowEndColumn:'BC',formulaColumns:[],requiredValidationColumns:[],copyFormula:false,copyFormat:false,copyDataValidation:false,cloneConditionalFormatting:false}});
 await db.doc('sheetImportConfigs/'+companyId).set({companyId,enabled:true,spreadsheetId,headerRow:1,dataStartRow:2,readRangeEndColumn:'BC',columns:{...columns,basePayColumns:['Q']}});
 const config={companyId,uid,producerId:'synthetic-producer',principalRevision:'principal-1',mailbox:'info@lipknots.com',startedAt:new Date(Date.now()-86400000).toISOString()};
 await db.doc('automationIngestPrincipals/'+caseMailRecordKey(companyId,uid)).set({companyId,uid,active:true,producerId:config.producerId,revision:config.principalRevision});
 const body=Buffer.from(['実施日：'+workDate.replaceAll('-','/'),'クライアント：合成取引先','店舗：合成店舗','メーカー：合成メーカー','メニュー：試食','入店時間：09:30','実施時間：10:00～18:00','人数：'+slots+'名'].join('\n'));
 const source={rawMessage:{id:'synthetic-message',threadId:'synthetic-thread',internalDate:String(Date.now()),payload:{partId:'0',mimeType:'text/plain',headers:[{name:'From',value:'sender@example.invalid'},{name:'To',value:'info@lipknots.com'},{name:'Subject',value:'新規手配依頼'}],body:{size:body.length,data:body.toString('base64url')}}},documents:[]};
 const receiver=createCaseMailReceiver(config,{fetch:async()=>{syntheticFetches++;return structuredClone(source);},parse:analyzeFetchedCaseMail});
 const h={companyId,spreadsheetId,auth,sheet,source,receive:()=>receiver({messageId:source.rawMessage.id}),create:(received,operationId='synthetic-operation')=>management.createAdminJobGroup.run({auth,data:{mailIntake:{receiptId:received.receiptId,candidateId:received.candidateIds[0],expectedReceiptRevision:received.revision,expectedRevision:1,operationId}}}),
  import:()=>sync.syncShiftSheetsReadOnly.run({auth,data:{sheetNames:[month]}}),publish:(jobIds,expectedRevisions,user=auth)=>management.updateJobPublication.run({auth:user,data:{jobIds,action:'publish',expectedRevisions}}),
  list:async name=>(await db.collection(name).where('companyId','==',companyId).get()).docs};
 h.start=async()=>{const received=await h.receive();assert.equal(received.status,'ready');const created=await h.create(received);h.received=received;h.created=created;h.job=db.doc('jobs/'+created.jobIds[0]);h.queue=db.doc('sheetRowCreateQueue/'+created.rowCreationQueueId);h.event={data:{after:await h.queue.get()}};return h;};
 h.run=()=>worker.processSheetRowCreation.run(h.event);h.publishCurrent=async()=>h.publish(h.created.jobIds,{[h.job.id]:(await h.job.get()).data().revision});return h;
}
async function test(name,body){try{await body();results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:String(error.stack??error)});console.error('FAIL '+name+' '+error.message);}}
async function assignedFixture(nativeKind){
 const h=await fixture();
 if(nativeKind){
  const input=nativeKind==='create'?{workDate,clientName:'合成取引先',storeName:'合成店舗',makerName:'合成メーカー',menuName:'試食',entryTime:'09:30',workTime:'10:00～18:00',slots:1,publicationMode:'draft'}:{sourceJobId:(await h.start()).job.id,workDate,slots:1,publicationMode:'draft'};
  if(nativeKind==='duplicate')await h.run();
  const command={operationId:crypto.randomUUID(),expectedCompanyId:h.companyId,expectedActorUid:h.auth.uid,input,action:'create'};
  const api=nativeKind==='create'?management.createAdminJobGroup:management.duplicateAdminJob;
  h.retryNative=action=>api.run({auth:h.auth,data:{nativeCreation:{...command,action:action??'create'}}});
  h.created=await h.retryNative();h.job=db.doc('jobs/'+h.created.jobIds[0]);h.queue=db.doc('sheetRowCreateQueue/'+h.created.rowCreationQueueId);h.event={data:{after:await h.queue.get()}};
 }else await h.start();
 await h.run();await h.import();assert.deepEqual((await h.publishCurrent()).updated,[h.job.id]);
 h.staff=[0,1].map(i=>({uid:h.companyId+'-uid-'+i,token:{role:'staff',companyId:h.companyId,staffId:h.companyId+'-staff-'+i}}));
 for(const [i,user] of h.staff.entries())await db.doc('staffProfiles/'+user.token.staffId).set({companyId:h.companyId,active:true,displayName:'Synthetic Staff '+i});
 h.publishedRevision=(await h.job.get()).data().revision;
 h.apply=(i=0,requestId='synthetic-apply-request')=>jobs.applyToJob.run({auth:h.staff[i],data:{jobId:h.job.id,requestId,expectedJobRevision:h.publishedRevision}});return h;
}
// 作成結果の再確認は、その後に進んだ業務の値と更新時刻を変えない。
async function assertNativeReplayKeepsState(h){
 const receipt=(await h.job.get()).data().nativeCreationReceiptId;assert.ok(receipt);
 const collections=['jobs','jobGroups','sheetRowCreateQueue','sheetSyncQueue','auditLogs','nativeJobCreationReceipts','adminJobEditSources','expenseReviews','notificationQueue','staffDayLocks','submissions','resubmissionRequests'];
 const snapshots=docs=>docs.map(d=>({id:d.id,data:d.data(),updateTime:d.updateTime})).sort((a,b)=>a.id.localeCompare(b.id));
 const capture=async()=>{
  const saved=Object.fromEntries(await Promise.all(collections.map(async name=>[name,snapshots(await h.list(name))])));
  saved.submissionFiles=Object.fromEntries(await Promise.all((await h.list('submissions')).map(async doc=>[doc.id,snapshots((await doc.ref.collection('files').get()).docs)])));
  return saved;
 };
 const before=await capture(),writeCount=sheetWrites,copies=driveCopies,stored=structuredClone([...storageObjects]);
 assert.deepEqual((await h.retryNative()).jobIds,h.created.jobIds);
 assert.equal((await h.retryNative('cancel')).nativeCreationReceipt.status,'committed');
 assert.deepEqual(await capture(),before);assert.equal(sheetWrites,writeCount);assert.equal(driveCopies,copies);assert.deepEqual([...storageObjects],stored);
 assert.equal((await h.job.get()).data().nativeCreationReceiptId,receipt);
}
try{
 const admin=load('admin-operations'),writes=load('safe-sheet-writes');
 await test('受信作成から公開・応募・同じ応募再送・管理確認まで連結',async()=>{
  const h=await assignedFixture(),first=await h.apply();assert.equal(first.ok,true);const retries=await Promise.all([h.apply(),h.apply()]);assert.deepEqual(retries,[first,first]);
  const current=(await h.job.get()).data();assert.equal(current.status,'assigned');assert.equal(current.applicationUnconfirmed,true);assert.equal((await h.list('sheetSyncQueue')).length,1);assert.equal((await h.list('notificationQueue')).length,2);
  await assert.rejects(admin.confirmApplication.run({auth:h.auth,data:{jobId:h.job.id,expectedRevision:current.revision-1}}),e=>e.code==='failed-precondition');
  await Promise.all([1,2].map(()=>admin.confirmApplication.run({auth:h.auth,data:{jobId:h.job.id,expectedRevision:current.revision}})));
  assert.equal((await h.list('auditLogs')).filter(doc=>doc.data().action==='application.confirm').length,1);const confirmed=(await h.job.get()).data();assert.equal(confirmed.applicationAdminConfirmed,true);assert.equal(confirmed.applicationUnconfirmed,true);
  await assert.rejects(h.import(),e=>e.code==='failed-precondition');assert.deepEqual((await h.job.get()).data(),confirmed);
 });
 await test('公開済み受信案件への2人同時応募は1人・1勤務枠に収束',async()=>{
  const h=await assignedFixture(),out=await Promise.allSettled([h.apply(0),h.apply(1)]);assert.equal(out.filter(x=>x.status==='fulfilled').length,1);assert.equal((await h.list('sheetSyncQueue')).length,1);assert.equal((await h.list('staffDayLocks')).filter(doc=>doc.data().active===true).length,1);assert.equal((await h.list('notificationQueue')).length,2);
 });
 await test('確認版なし・古い版・別会社の応募は受信案件を変更しない',async()=>{
  const h=await assignedFixture(),before=(await h.job.get()).data();
  for(const revision of [undefined,h.publishedRevision-1])await assert.rejects(jobs.applyToJob.run({auth:h.staff[0],data:{jobId:h.job.id,requestId:'synthetic-invalid-version',...(revision===undefined?{}:{expectedJobRevision:revision})}}),e=>e.code==='failed-precondition');
  await assert.rejects(jobs.applyToJob.run({auth:{...h.staff[0],token:{...h.staff[0].token,companyId:'synthetic-foreign'}},data:{jobId:h.job.id,requestId:'synthetic-foreign-request',expectedJobRevision:h.publishedRevision}}),e=>e.code==='permission-denied');assert.deepEqual((await h.job.get()).data(),before);assert.equal((await h.list('sheetSyncQueue')).length,0);assert.equal((await h.list('staffDayLocks')).length,0);
 });
 await test('受信案件の応募・管理確認・担当書戻し・原本再照合を一往復',async()=>{
  const h=await assignedFixture();await db.doc('companies/'+h.companyId+'/sheetMappings/shift').update({operations:{'job.assign':{values:['staffName']}}});await h.apply();const assigned=(await h.job.get()).data();await admin.confirmApplication.run({auth:h.auth,data:{jobId:h.job.id,expectedRevision:assigned.revision}});
  const queues=await h.list('sheetSyncQueue');assert.equal(queues.length,1);const event={data:{after:await queues[0].ref.get()}};await writes.processSafeSheetWrite.run(event);const done=(await queues[0].ref.get()).data();assert.equal(done.status,'completed',JSON.stringify({status:done.status,error:done.errorMessage}));
  assert.equal(h.sheet.rows.find(row=>row[54]===assigned.caseId)[1],'Synthetic Staff 0');await h.import();const confirmed=(await h.job.get()).data();assert.equal(confirmed.status,'assigned');assert.equal(confirmed.assignedStaffId,h.staff[0].token.staffId);assert.equal(confirmed.applicationUnconfirmed,false);assert.equal(confirmed.applicationAdminConfirmed,true);
  const count=sheetWrites;await writes.processSafeSheetWrite.run(event);assert.equal(sheetWrites,count);assert.equal((await h.list('staffDayLocks')).filter(doc=>doc.data().active).length,1);
 });
 await test('受信案件の担当確認後に事前連絡・原本書戻し・再読込を一往復',async()=>{
  const h=await assignedFixture();await db.doc('companies/'+h.companyId+'/sheetMappings/shift').update({operations:{'job.assign':{values:['staffName']},'precontact.submit':{values:['temperature','arrivalTime']}}});await h.apply();const assigned=(await h.job.get()).data();await admin.confirmApplication.run({auth:h.auth,data:{jobId:h.job.id,expectedRevision:assigned.revision}});
  const queues=await h.list('sheetSyncQueue');assert.equal(queues.length,1);const event={data:{after:await queues[0].ref.get()}};await writes.processSafeSheetWrite.run(event);const done=(await queues[0].ref.get()).data();assert.equal(done.status,'completed',JSON.stringify({status:done.status,error:done.errorMessage}));
  assert.equal(h.sheet.rows.find(row=>row[54]===assigned.caseId)[1],'Synthetic Staff 0');await h.import();const confirmed=(await h.job.get()).data();assert.equal(confirmed.status,'assigned');assert.equal(confirmed.assignedStaffId,h.staff[0].token.staffId);assert.equal(confirmed.applicationUnconfirmed,false);assert.equal(confirmed.applicationAdminConfirmed,true);
  const count=sheetWrites;await writes.processSafeSheetWrite.run(event);assert.equal(sheetWrites,count);assert.equal((await h.list('staffDayLocks')).filter(doc=>doc.data().active).length,1);
  const precontact=require('../functions/lib/precontact.js');
  const request={auth:h.staff[0],data:{jobId:h.job.id,dateKey:workDate,expectedRevision:confirmed.revision,temperature:36.5,arrivalTime:'09:30'}};
  await assert.rejects(()=>precontact.submitPreContact.run({...request,data:{...request.data,expectedRevision:confirmed.revision-1}}),error=>error.code==='failed-precondition');
  await precontact.submitPreContact.run(request);
  const submitted=(await h.job.get()).data();assert.equal(submitted.preContactSyncPending,true);assert.equal(submitted.preContact.temperature,36.5);
  const pending=(await h.list('sheetSyncQueue')).filter(doc=>doc.data().operation==='precontact.submit');assert.equal(pending.length,1);
  const preEvent={data:{after:await pending[0].ref.get()}};await writes.processSafeSheetWrite.run(preEvent);
  assert.equal((await pending[0].ref.get()).data().status,'completed');
  await h.import();const imported=(await h.job.get()).data();assert.equal(imported.preContactSyncPending,false);assert.equal(imported.preContactNeedsReview,false);assert.equal(imported.preContact.temperature,36.5);assert.equal(imported.preContact.arrivalTime,'09:30');assert.equal(imported.preContact.staffId,h.staff[0].token.staffId);
  const completedWrites=sheetWrites;await writes.processSafeSheetWrite.run(preEvent);assert.equal(sheetWrites,completedWrites);

 });
 for(const kind of [undefined,'create','duplicate'])await test((kind?'新再送契約 '+kind:'受信案件')+'の担当・事前連絡・提出・差替完了までの連結',async()=>{
  const h=await assignedFixture(kind);await db.doc('companies/'+h.companyId+'/sheetMappings/shift').update({operations:{'job.assign':{values:['staffName']},'precontact.submit':{values:['temperature','arrivalTime']},'submission.report':{values:['reportSubmitted']}}});await h.apply();const assigned=(await h.job.get()).data();await admin.confirmApplication.run({auth:h.auth,data:{jobId:h.job.id,expectedRevision:assigned.revision}});
  const queues=await h.list('sheetSyncQueue');assert.equal(queues.length,1);const event={data:{after:await queues[0].ref.get()}};await writes.processSafeSheetWrite.run(event);const done=(await queues[0].ref.get()).data();assert.equal(done.status,'completed',JSON.stringify({status:done.status,error:done.errorMessage}));
  assert.equal(h.sheet.rows.find(row=>row[54]===assigned.caseId)[1],'Synthetic Staff 0');await h.import();const confirmed=(await h.job.get()).data();assert.equal(confirmed.status,'assigned');assert.equal(confirmed.assignedStaffId,h.staff[0].token.staffId);assert.equal(confirmed.applicationUnconfirmed,false);assert.equal(confirmed.applicationAdminConfirmed,true);
  const count=sheetWrites;await writes.processSafeSheetWrite.run(event);assert.equal(sheetWrites,count);assert.equal((await h.list('staffDayLocks')).filter(doc=>doc.data().active).length,1);
  const precontact=require('../functions/lib/precontact.js');
  const request={auth:h.staff[0],data:{jobId:h.job.id,dateKey:workDate,expectedRevision:confirmed.revision,temperature:36.5,arrivalTime:'09:30'}};
  if(!kind)await assert.rejects(()=>precontact.submitPreContact.run({...request,data:{...request.data,expectedRevision:confirmed.revision-1}}),error=>error.code==='failed-precondition');
  await precontact.submitPreContact.run(request);
  const submitted=(await h.job.get()).data();assert.equal(submitted.preContactSyncPending,true);assert.equal(submitted.preContact.temperature,36.5);
  const pending=(await h.list('sheetSyncQueue')).filter(doc=>doc.data().operation==='precontact.submit');assert.equal(pending.length,1);
  const preEvent={data:{after:await pending[0].ref.get()}};await writes.processSafeSheetWrite.run(preEvent);
  assert.equal((await pending[0].ref.get()).data().status,'completed');
  await h.import();const imported=(await h.job.get()).data();assert.equal(imported.preContactSyncPending,false);assert.equal(imported.preContactNeedsReview,false);assert.equal(imported.preContact.temperature,36.5);assert.equal(imported.preContact.arrivalTime,'09:30');assert.equal(imported.preContact.staffId,h.staff[0].token.staffId);
  const completedWrites=sheetWrites;await writes.processSafeSheetWrite.run(preEvent);assert.equal(sheetWrites,completedWrites);
  const uploads=load('uploads'),requests=load('resubmissions'),views=load('submission-files');
  await db.doc('companies/'+h.companyId+'/settings/drive').set({rootFolderId:'synthetic-root'});process.env.LKC_SUBMISSION_TRANSFER_MODE='active';
  const start=async patch=>uploads.createUploadSession.run({auth:h.staff[0],data:{jobId:h.job.id,type:'report',expectedRevision:(await h.job.get()).data().revision,files:[{originalName:'synthetic.png',contentType:'image/png',size:100,contentSha256:'a'.repeat(64)}],...patch}});
  const finish=file=>{storageObjects.set(file.storagePath,{size:'100',contentType:'image/png',generation:'1',metadata:{lkcContentSha256:'a'.repeat(64)}});return uploads.finalizeStagedUpload.run({data:{name:file.storagePath,bucket:'synthetic-bucket',contentType:'image/png',size:100,generation:'1',md5Hash:'AAAAAAAAAAAAAAAAAAAAAA=='}});};
  if(!kind)await assert.rejects(()=>start({expectedRevision:0}),e=>e.code==='failed-precondition');
  const copiesBefore=driveCopies;const clientRequestId=crypto.randomUUID();const sessions=await Promise.all([start({clientRequestId}),start({clientRequestId})]);assert.equal(sessions[0].submissionId,sessions[1].submissionId);const first=sessions[0];await finish(first.files[0]);await finish(first.files[0]);assert.equal(driveCopies-copiesBefore,1);
  const original=(await db.doc('submissions/'+first.submissionId+'/files/'+first.files[0].fileId).get()).data().driveFileId;assert.ok(original);assert.equal((await db.doc('submissions/'+first.submissionId).get()).data().completedFiles,1);
  const reports=(await h.list('sheetSyncQueue')).filter(doc=>doc.data().operation==='submission.report');assert.equal(reports.length,1);await writes.processSafeSheetWrite.run({data:{after:await reports[0].ref.get()}});assert.equal((await reports[0].ref.get()).data().status,'completed');
  const resubmissionRequest=await requests.createResubmissionRequest.run({auth:h.auth,data:{jobId:h.job.id,type:'report',sourceSubmissionId:first.submissionId,sourceFileId:first.files[0].fileId,reasons:['その他'],expectedRevision:(await h.job.get()).data().revision}});
  await assert.rejects(()=>requests.completeResubmissionRequest.run({auth:h.auth,data:resubmissionRequest}),e=>e.code==='failed-precondition');
  const replacement=await start({clientRequestId:crypto.randomUUID(),purpose:'replacement',resubmissionRequestId:resubmissionRequest.requestId});await finish(replacement.files[0]);assert.equal((await db.doc('resubmissionRequests/'+resubmissionRequest.requestId).get()).data().status,'submitted');
  const comparison=await views.getResubmissionComparison.run({auth:h.auth,data:resubmissionRequest});assert.equal(comparison.replacements.length,1);
  await Promise.all([requests.completeResubmissionRequest.run({auth:h.auth,data:resubmissionRequest}),requests.completeResubmissionRequest.run({auth:h.auth,data:resubmissionRequest})]);assert.equal((await db.doc('resubmissionRequests/'+resubmissionRequest.requestId).get()).data().status,'completed');assert.equal(driveCopies-copiesBefore,2);assert.ok(driveFiles.has(original));
  if(kind)await assertNativeReplayKeepsState(h);


 });

 // API間で保存された確認情報を渡し、原本反映とDB確定の両順序を検証する。
 async function expenseFixture(kind){
  const h=await assignedFixture(kind);
  const expenseColumns={transportation:'AK',purchase8:'AL',purchase10:'AM',netPrintCost:'AO',postageCost:'AP'};
  await db.doc('companies/'+h.companyId+'/sheetMappings/shift').update({operations:{'job.assign':{values:['staffName']},'expense.review':{values:Object.keys(expenseColumns)}}});
  await h.apply();await admin.confirmApplication.run({auth:h.auth,data:{jobId:h.job.id,expectedRevision:(await h.job.get()).data().revision}});
  const assign=(await h.list('sheetSyncQueue'))[0];await writes.processSafeSheetWrite.run({data:{after:await assign.ref.get()}});assert.equal((await assign.ref.get()).data().status,'completed');
  const caseId=(await h.job.get()).data().caseId;h.row=h.sheet.rows.find(row=>row[54]===caseId);
  Object.assign(h.row,{36:1000,37:0,38:'',40:120,41:430});await h.import();
  h.read=()=>admin.getExpenseReview.run({auth:h.auth,data:{jobId:h.job.id}});
  h.values={transportation:1500,purchase8:0,purchase10:null,netPrintCost:200,postageCost:430};
  h.write=async(complete,patch={})=>admin[complete?'completeExpenseReview':'saveExpenseReviewDraft'].run({auth:h.auth,data:{jobId:h.job.id,values:h.values,note:'合成経費確認',expectedVersion:(await h.read()).reviewVersion,...patch}});
  h.review=db.doc('expenseReviews/'+h.job.id);
  h.expenseQueue=async()=>db.doc('sheetSyncQueue/'+(await h.review.get()).data().queueId);
  h.runExpense=async()=>writes.processSafeSheetWrite.run({data:{after:await (await h.expenseQueue()).get()}});
  h.finalize=async()=>admin.updateExpenseReviewFromQueue.run({data:{after:await (await h.expenseQueue()).get()}});
  return h;
 }

 for(const [kind,importFirst] of [[undefined,false],[undefined,true],['create',true],['duplicate',true]])await test((kind?'新再送契約 '+kind:'受信案件')+'の経費下書き・書戻し・確定・再読込: '+(importFirst?'読取先行':'確定先行'),async()=>{
  const h=await expenseFixture(kind),read=await h.read();if(kind)assert.notEqual(read.job.receivedMail,true);else assert.equal(read.job.receivedMail,true);assert.equal(read.writeBlockedReason,null);assert.equal(read.currentValues.transportation,1000);
  await h.write(false);assert.equal((await h.review.get()).data().status,'draft');
  await assert.rejects(()=>h.write(true,{expectedVersion:read.reviewVersion}),e=>e.code==='failed-precondition');
  await h.write(true);assert.equal((await h.review.get()).data().status,'queued');assert.equal((await h.job.get()).data().expenses.transportation,1000);
  const before=[...h.row],count=sheetWrites;await h.runExpense();assert.equal((await (await h.expenseQueue()).get()).data().status,'completed');assert.equal(sheetWrites,count+1);
  for(let i=0;i<h.row.length;i++)if(![36,37,38,40,41].includes(i))assert.equal(h.row[i],before[i]);
  assert.equal(h.row[36],1500);assert.equal(h.row[37],0);assert.equal(h.row[38],'');
  if(importFirst)await h.import();await h.finalize();assert.equal((await h.review.get()).data().status,'completed');
  if(!importFirst)await h.import();const job=(await h.job.get()).data();assert.equal(job.expenses.transportation,1500);assert.equal(job.expenses.netPrintCost,200);assert.equal(job.expenseReviewStatus,'completed');
  await h.runExpense();assert.equal(sheetWrites,count+1);const saved=(await h.job.get()).data();await h.finalize();assert.deepEqual((await h.job.get()).data(),saved);
  if(kind){await jobs.adminCancelJob.run({auth:h.auth,data:{jobId:h.job.id,reason:'合成取消'}});assert.equal((await h.job.get()).data().status,'cancelled');await assertNativeReplayKeepsState(h);}
 });
 await test('受信変更は確認済み経費依頼の原本書戻しを停止',async()=>{
  const h=await expenseFixture();await h.write(true);const beforeWrites=sheetWrites;
  const payload=h.source.rawMessage.payload;payload.body.data=Buffer.from(Buffer.from(payload.body.data,'base64url').toString('utf-8').replace('合成店舗','変更店舗')).toString('base64url');payload.body.size=Buffer.from(payload.body.data,'base64url').length;
  await h.receive();assert.equal((await h.job.get()).data().mailIntakeReviewRequired,true);await h.runExpense();assert.equal((await (await h.expenseQueue()).get()).data().status,'blocked');assert.equal(sheetWrites,beforeWrites);await h.finalize();assert.equal((await h.review.get()).data().status,'error');assert.equal((await h.job.get()).data().expenses.transportation,1000);
 });

}finally{
 google.sheets=originalSheets;safety.getProductionOperationalState=originalState;if(originalMode===undefined)delete process.env.LKC_SHEET_WRITE_MODE;else process.env.LKC_SHEET_WRITE_MODE=originalMode;
 if(originalTransferMode===undefined)delete process.env.LKC_SUBMISSION_TRANSFER_MODE;else process.env.LKC_SUBMISSION_TRANSFER_MODE=originalTransferMode;
 await db.terminate();const stats=network.stats();network.restore();const result={project:environment.project,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length+(stats.blocked?1:0),network:stats,syntheticFetches,syntheticSheetReads:sheetReads,syntheticSheetWrites:sheetWrites,realCloud:false,realSheetWrites:0,realMessages:0,syntheticDriveCopies:driveCopies,authentication:'synthetic callable claims; real login, token verification and Security Rules are not certified',sourceModules:['job-management','sheet-row-creation','shift-import','jobs','admin-operations','safe-sheet-writes','precontact','uploads','resubmissions'].map(name=>({name,sha256:crypto.createHash('sha256').update(fs.readFileSync(new URL('../functions/lib/'+name+'.js',import.meta.url))).digest('hex')})),results};fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:result.passed,failed:result.failed,network:stats}));if(result.failed)process.exitCode=1;
}
