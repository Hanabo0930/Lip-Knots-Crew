import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {localAcceptanceEnvironment,blockNonEmulatorConnections} from './local-firestore-acceptance-safety.mjs';
const environment=localAcceptanceEnvironment(process.env),network=blockNonEmulatorConnections(environment.port);
const require=createRequire(import.meta.url),{google}=require('googleapis');
const {analyzeFetchedCaseMail}=await import('./case-mail-intake-adapter.mjs');
const {db}=require('../functions/lib/firebase.js'),safety=require('../functions/lib/system-safety.js');
const originalSheets=google.sheets,originalState=safety.getProductionOperationalState,originalMode=process.env.LKC_SHEET_WRITE_MODE;
process.env.LKC_SHEET_WRITE_MODE='active';safety.getProductionOperationalState=async()=>({operational:true});
const load=name=>require('../functions/lib/'+name+'.js');
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
const columns={workDate:'A',staffName:'B',temperature:'G',arrivalTime:'H',reportSubmitted:'I',cancelled:'V',cancellationReason:'W',cancellationReasonCategory:'X',cancellationFinancialTreatment:'Y',transportation:'AK',purchase8:'AL',purchase10:'AM',netPrintCost:'AO',postageCost:'AP',clientName:'J',storeName:'K',makerName:'L',menuName:'M',entryTime:'N',workTime:'O',subcontractorName:'P',staffBasePay:'Q',caseId:'BC'};
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
async function stateOf(h){return Object.fromEntries(await Promise.all(['jobs','jobGroups','sheetSyncQueue','notificationQueue','auditLogs','staffDayLocks'].map(async name=>[name,(await h.list(name)).map(doc=>({id:doc.id,data:doc.data()})).sort((a,b)=>a.id.localeCompare(b.id))])));}
async function test(name,body){try{await body();results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:String(error.stack??error)});console.error('FAIL '+name+' '+error.message);}}
async function assignedFixture(){
 const h=await (await fixture()).start();await h.run();await h.import();assert.deepEqual((await h.publishCurrent()).updated,[h.job.id]);
 h.staff=[0,1].map(i=>({uid:h.companyId+'-uid-'+i,token:{role:'staff',companyId:h.companyId,staffId:h.companyId+'-staff-'+i}}));
 for(const [i,user] of h.staff.entries())await db.doc('staffProfiles/'+user.token.staffId).set({companyId:h.companyId,active:true,displayName:'Synthetic Staff '+i});
 h.publishedRevision=(await h.job.get()).data().revision;
 h.apply=(i=0,requestId='synthetic-apply-request')=>jobs.applyToJob.run({auth:h.staff[i],data:{jobId:h.job.id,requestId,expectedJobRevision:h.publishedRevision}});return h;
}
try{
 const admin=load('admin-operations'),writes=load('safe-sheet-writes'),analytics=load('analytics');
 async function ready(assigned){
  const h=await assignedFixture(),keys=['cancelled','cancellationReason','cancellationReasonCategory','cancellationFinancialTreatment'];
  await db.doc('companies/'+h.companyId+'/sheetMappings/shift').update({operations:{'job.assign':{values:['staffName']},'job.cancel.v2':{values:keys},'job.restore':{values:keys}}});
  if(assigned){await h.apply();await admin.confirmApplication.run({auth:h.auth,data:{jobId:h.job.id,expectedRevision:(await h.job.get()).data().revision}});const q=(await h.list('sheetSyncQueue'))[0];await writes.processSafeSheetWrite.run({data:{after:await q.ref.get()}});assert.equal((await q.ref.get()).data().status,'completed');await h.import();}
  h.cancel=async()=>analytics.adminSetJobCancellation.run({auth:h.auth,data:{jobId:h.job.id,reasonCategory:'other',reasonNote:'合成取消',financialTreatment:'neither',expectedRevision:(await h.job.get()).data().revision}});
  h.restore=async()=>analytics.adminRestoreCancelledJob.run({auth:h.auth,data:{jobId:h.job.id,note:'合成復旧',expectedRevision:(await h.job.get()).data().revision}});
  h.queueFor=async operation=>(await h.list('sheetSyncQueue')).filter(doc=>doc.data().operation===operation).at(-1);
  h.process=async operation=>{const q=await h.queueFor(operation);await writes.processSafeSheetWrite.run({data:{after:await q.ref.get()}});return (await q.ref.get()).data();};return h;
 }
 for(const assigned of [false,true])await test('受信案件の取消・原本同期・復旧・再同期: 担当'+assigned,async()=>{
  const h=await ready(assigned);await h.cancel();assert.equal((await h.job.get()).data().cancelled,true);assert.equal((await h.list('staffDayLocks')).filter(d=>d.data().active).length,0);
  let q=await h.process('job.cancel.v2');assert.equal(q.status,'completed',q.errorMessage);await h.import();assert.equal((await h.job.get()).data().status,'cancelled');assert.equal((await h.job.get()).data().appOverride,undefined);
  await h.restore();assert.equal((await h.job.get()).data().cancelled,false);q=await h.process('job.restore');assert.equal(q.status,'completed',q.errorMessage);await h.import();const restored=(await h.job.get()).data();assert.equal(restored.cancelled,false);assert.equal(restored.status,assigned?'assigned':'stopped');assert.equal(restored.publishable,false);assert.equal((await h.list('staffDayLocks')).filter(d=>d.data().active).length,assigned?1:0);
  if(!assigned)assert.deepEqual((await h.publishCurrent()).updated,[h.job.id]);
 });
 await test('復旧後に遅れて届いた取消イベントは原本を書き換えない',async()=>{
  const h=await ready(true);await h.cancel();const cancelled=await h.queueFor('job.cancel.v2');await h.restore();const count=sheetWrites;await writes.processSafeSheetWrite.run({data:{after:await cancelled.ref.get()}});assert.equal((await cancelled.ref.get()).data().status,'blocked');assert.equal(sheetWrites,count);assert.equal((await h.process('job.restore')).status,'completed');await h.import();assert.equal((await h.job.get()).data().status,'assigned');
 });

 for(const active of [false,null])await test('無効・有効性不明の担当者へ受信案件を復旧しない: '+active,async()=>{
  const h=await ready(true);await h.cancel();const profile=db.doc('staffProfiles/'+h.staff[0].token.staffId);
  if(active===null){const value=(await profile.get()).data();delete value.active;await profile.set(value);}else await profile.update({active});
  const before=await stateOf(h);await assert.rejects(h.restore(),e=>e.code==='failed-precondition');assert.deepEqual(await stateOf(h),before);
 });
 await test('取消後に別案件が勤務枠を獲得した場合は復旧しない',async()=>{
  const h=await ready(true);await h.cancel();const lock=(await h.list('staffDayLocks'))[0];await lock.ref.update({active:true,jobId:'synthetic-other-job'});const before=await stateOf(h);await assert.rejects(h.restore(),e=>e.code==='failed-precondition');assert.deepEqual(await stateOf(h),before);
 });
 for(const restore of [false,true])await test('受信案件の古い確認版で'+(restore?'復旧':'取消')+'を行わない',async()=>{
  const h=await ready(true);if(restore)await h.cancel();const revision=(await h.job.get()).data().revision;await h.job.update({revision:revision+1});const before=await stateOf(h);
  const data=restore?{jobId:h.job.id,note:'合成復旧',expectedRevision:revision}:{jobId:h.job.id,reasonCategory:'other',reasonNote:'合成取消',financialTreatment:'neither',expectedRevision:revision};
  await assert.rejects((restore?analytics.adminRestoreCancelledJob:analytics.adminSetJobCancellation).run({auth:h.auth,data}),e=>e.code==='failed-precondition');assert.deepEqual(await stateOf(h),before);
 });

}finally{
 google.sheets=originalSheets;safety.getProductionOperationalState=originalState;if(originalMode===undefined)delete process.env.LKC_SHEET_WRITE_MODE;else process.env.LKC_SHEET_WRITE_MODE=originalMode;
 await db.terminate();const stats=network.stats();network.restore();const result={project:environment.project,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length+(stats.blocked?1:0),network:stats,syntheticFetches,syntheticSheetReads:sheetReads,syntheticSheetWrites:sheetWrites,realCloud:false,realSheetWrites:0,realMessages:0,authentication:'synthetic callable claims; real login, token verification and Security Rules are not certified',sourceModules:['job-management','sheet-row-creation','shift-import','jobs','admin-operations','safe-sheet-writes','analytics'].map(name=>({name,sha256:crypto.createHash('sha256').update(fs.readFileSync(new URL('../functions/lib/'+name+'.js',import.meta.url))).digest('hex')})),results};fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:result.passed,failed:result.failed,network:stats}));if(result.failed)process.exitCode=1;
}
