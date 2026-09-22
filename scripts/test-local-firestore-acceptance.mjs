import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {localAcceptanceEnvironment,blockNonEmulatorConnections} from './local-firestore-acceptance-safety.mjs';
const environment=localAcceptanceEnvironment(process.env);
const network=blockNonEmulatorConnections(environment.port);
const require=createRequire(import.meta.url);
const {Timestamp}=require('firebase-admin/firestore');
const {google}=require('googleapis');
const sheets=new Map();
let sheetReads=0,sheetWrites=0;
function sheet(input){assert.ok(sheets.has(input.spreadsheetId),'synthetic sheet required');return sheets.get(input.spreadsheetId);}
function cell(s,range){
  const match=/^'([^']+)'!([A-Z]+)([0-9]+)$/.exec(range);
  assert.ok(match&&match[1]===s.month,'synthetic range required');
  const column=[...match[2]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
  const row=s.rows[Number(match[3])-2];assert.ok(row,'synthetic row required');return {row,column};
}
// 実DB・実トランザクションを使い、外部Sheetsだけを合成セルで置き換える。
google.sheets=()=>({spreadsheets:{
  get:async input=>{const s=sheet(input);sheetReads++;return {data:{sheets:[{properties:{sheetId:1,title:s.month,gridProperties:{rowCount:100,columnCount:55}}}]}};},
  batchUpdate:async input=>{const s=sheet(input);s.styles.push(...input.requestBody.requests);sheetWrites++;return {data:{}};},
  values:{
    get:async input=>{const s=sheet(input);sheetReads++;return {data:{values:input.range.endsWith('Q:Q')?[['case'],...s.rows.map(row=>[row[16]])]:[Array(55).fill('header'),...s.rows.map(row=>[...row])]}};},
    batchGet:async input=>{const s=sheet(input);sheetReads++;return {data:{valueRanges:input.ranges.map(range=>{const c=cell(s,range);return {values:[[c.row[c.column]]]};})}};},
    batchUpdate:async input=>{const s=sheet(input);for(const item of input.requestBody.data){const c=cell(s,item.range);c.row[c.column]=item.values[0][0];}sheetWrites++;s.writes++;
      if(s.loseReply){s.loseReply=false;throw new Error('synthetic reply lost after sheet write');}return {data:{}};}
  }
}});
const load=name=>require('../functions/lib/'+name+'.js');
const {db,storage}=load('firebase');
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
const uploads=load('uploads'),requests=load('resubmissions'),views=load('submission-files');
const jobs=load('jobs'),admin=load('admin-operations'),precontact=load('precontact'),netprint=load('netprint');
const worker=load('safe-sheet-writes'),sync=load('shift-import'),tasks=load('staff-tasks');
const results=[];
let sequence=0;
const call=(handler,auth,data={})=>handler.run({auth,data});
const tomorrow=new Date(Date.now()+33*3600000).toISOString().slice(0,10);
async function fixture(count=1) {
  const companyId='synthetic-sdk-'+(++sequence),sheetId='synthetic-sheet-'+sequence;
  const staff=[0,1].map(i=>({uid:companyId+'-uid-'+i,token:{role:'staff',companyId,staffId:companyId+'-staff-'+i}}));
  const manager={uid:companyId+'-admin',token:{role:'admin',companyId}};
  for(const [i,user] of staff.entries())await db.doc('staffProfiles/'+user.token.staffId).set({companyId,active:true,displayName:'Synthetic Staff '+i});
  const month=tomorrow.slice(0,4)+'.'+Number(tomorrow.slice(5,7));
  const rows=Array.from({length:count},(_,i)=>{
    const row=Array(55).fill('');Object.assign(row,{0:tomorrow,1:'',5:'Not assignment',9:'Synthetic Client',10:'Synthetic Store '+i,11:'Synthetic Maker',12:'Synthetic Menu',14:'10:00-18:00',16:'sdk-case-'+i});return row;
  });
  const state={month,rows,writes:0,styles:[]};sheets.set(sheetId,state);
  await db.doc('sheetImportConfigs/'+companyId).set({companyId,enabled:true,spreadsheetId:sheetId,headerRow:1,dataStartRow:2,readRangeEndColumn:'BC',
    columns:{workDate:'A',staffName:'B',temperature:'G',arrivalTime:'H',clientName:'J',storeName:'K',makerName:'L',menuName:'M',workTime:'O',caseId:'Q'}});
  await db.doc('companies/'+companyId+'/sheetMappings/shift').set({enabled:true,spreadsheetId:sheetId,idColumn:'Q',
    columns:{staffName:'B',workDate:'A',temperature:'G',arrivalTime:'H',netPrint1:'AT',reportSubmitted:'I'},
    operations:{'job.assign':{values:['staffName']},'precontact.submit':{values:['temperature','arrivalTime']},'submission.report':{values:['reportSubmitted']},'netprint.printed':{values:[],styles:['netPrint1']}}});
  const jobIds=rows.map(row=>load('case-id').createJobIdFromPersistedCaseId(companyId,row[16]));
  await call(sync.syncShiftSheetsReadOnly,manager);
  for(const id of jobIds)assert.equal((await db.doc('jobs/'+id).get()).data().status,'open','B blank must remain recruitable when F is populated');
  return {companyId,staff,manager,jobIds,jobId:jobIds[0],state,
    job:async(id=jobIds[0])=>(await db.doc('jobs/'+id).get()).data(),
    list:async name=>(await db.collection(name).where('companyId','==',companyId).get()).docs,
    apply:(index=0,id=jobIds[0],requestId='synthetic-request-0001')=>call(jobs.applyToJob,staff[index],{jobId:id,requestId}),
    sync:()=>call(sync.syncShiftSheetsReadOnly,manager),
    run:async doc=>worker.processSafeSheetWrite.run({data:{after:await doc.ref.get()}})
  };
}
const preparation=(h,index=0)=>call(precontact.submitPreContact,h.staff[index],{jobId:h.jobId,dateKey:tomorrow,temperature:36.5,arrivalTime:'09:30'});
async function confirmSource(h){
  process.env.LKC_SHEET_WRITE_MODE='active';
  const queue=(await h.list('sheetSyncQueue')).find(doc=>doc.data().operation==='job.assign');
  await h.run(queue);assert.equal((await queue.ref.get()).data().status,'completed');
  await h.sync();assert.equal((await h.job()).applicationUnconfirmed,false);
}
async function test(name,fn){
  const started=Date.now();
  try{await fn();results.push({name,passed:true,durationMs:Date.now()-started});console.log('PASS '+name);}
  catch(error){results.push({name,passed:false,error:String(error.stack??error),durationMs:Date.now()-started});console.error('FAIL '+name+'\n'+error.stack);}
}
try {
  await test('同時応募: 2人のうち1人だけ確定し勤務枠・依頼・通知を重複作成しない',async()=>{
    const h=await fixture();const values=await Promise.allSettled([h.apply(0),h.apply(1)]);
    assert.equal(values.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(values.find(x=>x.status==='rejected').reason.code,'already-exists');
    assert.equal((await h.list('sheetSyncQueue')).length,1);assert.equal((await h.list('notificationQueue')).length,2);
    assert.equal((await h.list('staffDayLocks')).length,1);assert.equal((await h.list('idempotencyKeys')).length,1);
    assert.ok((await h.job()).assignedAt instanceof Timestamp);
  });
  await test('同じ応募の並行再送: 同じ受付結果へ収束する',async()=>{
    const h=await fixture();const values=await Promise.all([h.apply(),h.apply(),h.apply()]);
    assert.deepEqual(values[0],values[1]);assert.deepEqual(values[1],values[2]);
    assert.equal((await h.list('sheetSyncQueue')).length,1);assert.equal((await h.list('notificationQueue')).length,2);
    assert.equal((await h.list('idempotencyKeys')).length,1);
  });
  await test('同日2案件への並行応募: 同じスタッフの勤務枠を二重確保しない',async()=>{
    const h=await fixture(2);const values=await Promise.allSettled([h.apply(0,h.jobIds[0],'request-first-job'),h.apply(0,h.jobIds[1],'request-second-job')]);
    assert.equal(values.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(values.find(x=>x.status==='rejected').reason.code,'failed-precondition');
    const states=await Promise.all(h.jobIds.map(id=>h.job(id)));assert.deepEqual(states.map(x=>x.status).sort(),['assigned','open']);
    assert.equal((await h.list('staffDayLocks')).length,1);assert.equal((await h.list('sheetSyncQueue')).length,1);
  });
  await test('取込→応募→管理確認→合成原本反映→再取込→事前連絡を実SDKで一往復',async()=>{
    const h=await fixture();await h.apply();
    await assert.rejects(preparation(h),e=>e.code==='failed-precondition'&&e.details.reason==='assignment_sheet_confirmation_pending');
    const revision=(await h.job()).revision;
    await assert.rejects(call(admin.confirmApplication,h.manager,{jobId:h.jobId,expectedRevision:revision-1}),e=>e.code==='failed-precondition');
    await Promise.all([call(admin.confirmApplication,h.manager,{jobId:h.jobId,expectedRevision:revision}),call(admin.confirmApplication,h.manager,{jobId:h.jobId,expectedRevision:revision})]);
    assert.equal((await h.list('auditLogs')).filter(x=>x.data().action==='application.confirm').length,1);
    await assert.rejects(preparation(h),e=>e.code==='failed-precondition');
    process.env.LKC_SHEET_WRITE_MODE='paused';
    const pending=(await h.list('sheetSyncQueue'))[0],before=JSON.stringify((await pending.ref.get()).data()),writes=sheetWrites,reads=sheetReads;
    await h.run(pending);await worker.retrySafeSheetWrites.run({});
    assert.equal(JSON.stringify((await pending.ref.get()).data()),before);assert.equal(sheetWrites,writes);assert.equal(sheetReads,reads);
    await confirmSource(h);assert.equal(h.state.rows[0][1],'Synthetic Staff 0');
    await Promise.all([preparation(h),preparation(h)]);
    const contacts=(await h.list('sheetSyncQueue')).filter(x=>x.data().operation==='precontact.submit');assert.equal(contacts.length,1);
    assert.equal((await h.list('auditLogs')).filter(x=>x.data().action==='precontact.submit').length,1);
    await h.run(contacts[0]);assert.equal((await contacts[0].ref.get()).data().status,'completed');
    assert.equal(h.state.rows[0][6],36.5);assert.equal(h.state.rows[0][7],'09:30');
    const saved=await h.job();assert.equal(saved.preContactSyncPending,false);assert.ok(saved.preContact.submittedAt instanceof Timestamp);
    const mine=await call(tasks.getMyTasks,h.staff[0]);assert.equal(mine.tasks.some(t=>t.kind==='precontact'&&t.jobId===h.jobId),false);
  });
  await test('会社・役割・現在担当の拒否で業務依頼を増やさない',async()=>{
    const h=await fixture();
    await assert.rejects(call(jobs.applyToJob,null,{jobId:h.jobId,requestId:'request-unauth'}),e=>e.code==='unauthenticated');
    await assert.rejects(call(jobs.applyToJob,h.manager,{jobId:h.jobId,requestId:'request-admin'}),e=>e.code==='permission-denied');
    await assert.rejects(call(jobs.applyToJob,{...h.staff[0],token:{...h.staff[0].token,companyId:'synthetic-other'}},{jobId:h.jobId,requestId:'request-other-company'}),e=>e.code==='permission-denied');
    assert.equal((await h.list('sheetSyncQueue')).length,0);
    await h.apply();await confirmSource(h);
    const before=(await h.list('sheetSyncQueue')).length;
    await assert.rejects(preparation(h,1),e=>e.code==='permission-denied');
    await assert.rejects(call(admin.confirmApplication,h.staff[0],{jobId:h.jobId,expectedRevision:(await h.job()).revision}),e=>e.code==='permission-denied');
    assert.equal((await h.list('sheetSyncQueue')).length,before);
    assert.equal((await call(tasks.getMyTasks,{...h.staff[0],token:{...h.staff[0].token,companyId:'synthetic-other'}})).count,0);
  });
  await test('書込後の応答喪失: 結果未確認で保持し実SDK再呼出でも再書込みしない',async()=>{
    const h=await fixture();await h.apply();await confirmSource(h);await preparation(h);
    const queue=(await h.list('sheetSyncQueue')).find(x=>x.data().operation==='precontact.submit');
    h.state.loseReply=true;await h.run(queue);
    const failed=(await queue.ref.get()).data();assert.equal(failed.status,'blocked');assert.equal(failed.writeVerificationRequired,true);
    const writes=h.state.writes;await h.run(queue);await worker.retrySafeSheetWrites.run({});
    assert.equal(h.state.writes,writes);assert.equal((await queue.ref.get()).data().writeVerificationRequired,true);
  });
  await test('印刷済みの並行再送: 1件の書式依頼へ収束し別担当を拒否',async()=>{
    const h=await fixture();await h.apply();await confirmSource(h);
    h.state.rows[0][45]='SYNTH001';
    // 印刷番号の合成fixture。実原本や他の案件は変更しない。
    await db.doc('jobs/'+h.jobId).update({'netPrint.items':[{id:'synthetic-print',position:1,number:'SYNTH001',printed:false}]});
    const input={jobId:h.jobId,itemId:'synthetic-print',dateKey:tomorrow};
    await Promise.all([call(netprint.markNetPrintPrinted,h.staff[0],input),call(netprint.markNetPrintPrinted,h.staff[0],input)]);
    await assert.rejects(call(netprint.markNetPrintPrinted,h.staff[1],input),e=>e.code==='permission-denied');
    const queues=(await h.list('sheetSyncQueue')).filter(x=>x.data().operation==='netprint.printed');assert.equal(queues.length,1);
    await h.run(queues[0]);assert.equal((await queues[0].ref.get()).data().status,'completed');assert.equal(h.state.styles.length,1);
  });
  for(const scope of ['file','submission'])await test('提出・再提出の実SDK一往復: '+scope,async()=>{
    const h=await fixture();await h.apply();await confirmSource(h);
    await call(admin.confirmApplication,h.manager,{jobId:h.jobId,expectedRevision:(await h.job()).revision});
    await db.doc('companies/'+h.companyId+'/settings/drive').set({rootFolderId:'synthetic-root'});
    process.env.LKC_SUBMISSION_TRANSFER_MODE='active';
    const initialCopies=driveCopies,initialSize=driveFiles.size;
    const start=(count,patch={})=>call(uploads.createUploadSession,h.staff[0],{jobId:h.jobId,type:'report',
      files:Array.from({length:count},(_,i)=>({originalName:'synthetic-'+i+'.png',contentType:'image/png',size:100,contentSha256:'a'.repeat(64)})),...patch});
    const finish=file=>{
      storageObjects.set(file.storagePath,{size:'100',contentType:'image/png',generation:'1',metadata:{lkcContentSha256:'a'.repeat(64)}});
      return uploads.finalizeStagedUpload.run({data:{name:file.storagePath,bucket:'synthetic-bucket',contentType:'image/png',size:100,generation:'1',md5Hash:'AAAAAAAAAAAAAAAAAAAAAA=='}});
    };
    const clientRequestId=crypto.randomUUID();
    const sessions=await Promise.all([start(2,{clientRequestId}),start(2,{clientRequestId})]);
    assert.equal(sessions[0].submissionId,sessions[1].submissionId);
    const first=sessions[0];
    assert.equal((await h.list('submissions')).length,1);
    assert.equal((await db.doc('submissions/'+first.submissionId).collection('files').get()).size,2);
    await Promise.all(first.files.map(finish));
    const originalIds=await Promise.all(first.files.map(async file=>(await db.doc('submissions/'+first.submissionId+'/files/'+file.fileId).get()).data().driveFileId));
    assert.equal((await db.doc('submissions/'+first.submissionId).get()).data().completedFiles,2);
    await finish(first.files[0]);
    assert.equal((await db.doc('submissions/'+first.submissionId).get()).data().completedFiles,2);
    assert.equal(driveCopies-initialCopies,2);
    const reports=(await h.list('sheetSyncQueue')).filter(x=>x.data().operation==='submission.report');assert.equal(reports.length,1);
    await h.run(reports[0]);assert.equal((await reports[0].ref.get()).data().status,'completed');
    assert.equal((await h.job()).submissionStatus.report.sheetWrite.pending,false);
    const request=await call(requests.createResubmissionRequest,h.manager,{jobId:h.jobId,type:'report',sourceSubmissionId:first.submissionId,
      ...(scope==='file'?{sourceFileId:first.files[0].fileId}:{}),reasons:['その他']});
    const detail=await call(views.getResubmissionComparison,h.staff[0],request);assert.equal(detail.request.scope,scope);
    await assert.rejects(call(requests.completeResubmissionRequest,h.manager,request),e=>e.code==='failed-precondition');
    const count=scope==='file'?1:2;
    const replacement=await start(count,{clientRequestId:crypto.randomUUID(),purpose:'replacement',resubmissionRequestId:request.requestId});
    if(count===2){await finish(replacement.files[0]);await assert.rejects(call(requests.completeResubmissionRequest,h.manager,request),e=>e.code==='failed-precondition');}
    await finish(replacement.files.at(-1));
    assert.equal((await db.doc('resubmissionRequests/'+request.requestId).get()).data().status,'submitted');
    const comparison=await call(views.getResubmissionComparison,h.manager,request);assert.equal(comparison.replacements.length,count);
    await Promise.all([call(requests.completeResubmissionRequest,h.manager,request),call(requests.completeResubmissionRequest,h.manager,request)]);
    assert.equal((await call(requests.getMyResubmissionRequests,h.staff[0])).requests.length,0);
    assert.equal((await call(requests.getAdminResubmissionRequests,h.manager)).requests.length,0);
    assert.equal((await call(tasks.getMyTasks,h.staff[0])).tasks.filter(x=>x.kind==='resubmission').length,0);
    assert.equal(driveFiles.size-initialSize,2+count);
    for(const id of originalIds)assert.ok(driveFiles.has(id),'original files must be retained');
    const timeline=await call(views.getSubmissionTimeline,h.manager,{jobId:h.jobId,type:'report'});
    assert.equal(timeline.submissions.length,2);
    assert.equal(timeline.submissions.reduce((n,x)=>n+x.files.length,0),2+count);
  });
} finally {
  await db.terminate();
  const stats=network.stats();network.restore();
  const failed=results.filter(x=>!x.passed).length;
  const result={project:environment.project,firestore:'real SDK / local emulator',passed:results.length-failed,failed,network:stats,
    sheets:'synthetic boundary',storageAndDrive:'synthetic boundaries',syntheticDriveCopies:driveCopies,sheetReads,syntheticSheetWrites:sheetWrites,realSheetWrites:0,actualMessagesSent:0,
    authentication:'synthetic callable context; token verification, Auth emulator and Security Rules are not certified',
    sourceModules:['jobs','admin-operations','precontact','netprint','safe-sheet-writes','shift-import','staff-tasks','uploads','drive-transfer','resubmissions','submission-status','submission-files'].map(name=>({name,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.resolve('functions/lib/'+name+'.js'))).digest('hex')})),results};
  if(stats.blocked)result.failed++;
  fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({passed:result.passed,failed:result.failed,network:stats,realSheetWrites:0,actualMessagesSent:0}));
  if(result.failed)process.exitCode=1;
}

