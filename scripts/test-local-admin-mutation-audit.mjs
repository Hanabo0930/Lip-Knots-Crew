import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {localAcceptanceEnvironment,blockNonEmulatorConnections} from './local-firestore-acceptance-safety.mjs';
const environment=localAcceptanceEnvironment(process.env),network=blockNonEmulatorConnections(environment.port);
const require=createRequire(import.meta.url),{google}=require('googleapis');
const {analyzeFetchedCaseMail}=await import('./case-mail-intake-adapter.mjs');
const {db}=require('../functions/lib/firebase.js'),safety=require('../functions/lib/system-safety.js');
const originalSheets=google.sheets,originalState=safety.getProductionOperationalState,originalMode=process.env.LKC_SHEET_WRITE_MODE;
process.env.LKC_SHEET_WRITE_MODE='active';safety.getProductionOperationalState=async()=>({operational:true});
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
 values:{get:async request=>{sheetReads++;return {data:{values:readRange(state(request),request.range)}};},batchGet:async request=>{sheetReads++;const s=state(request);return {data:{valueRanges:request.ranges.map(range=>({values:readRange(s,range)}))}};}}
}});
const management=require('../functions/lib/job-management.js'),worker=require('../functions/lib/sheet-row-creation.js'),sync=require('../functions/lib/shift-import.js'),jobs=require('../functions/lib/jobs.js');
const {createCaseMailReceiver}=require('../functions/lib/case-mail-intake.js'),{caseMailRecordKey}=require('../functions/lib/case-mail-job-creation.js');
const workDate=new Date(Date.now()+32*86400000).toISOString().slice(0,10),month=workDate.slice(0,4)+'.'+Number(workDate.slice(5,7));
const columns={workDate:'A',staffName:'B',clientName:'J',storeName:'K',makerName:'L',menuName:'M',entryTime:'N',workTime:'O',subcontractorName:'P',staffBasePay:'Q',caseId:'BC'};
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
try{
 const collections=['jobs','jobGroups','sheetRowCreateQueue','sheetSyncQueue','auditLogs','staffDayLocks'];
 const saved=async h=>Object.fromEntries(await Promise.all(collections.map(async name=>[name,(await h.list(name)).map(d=>({id:d.id,data:d.data()})).sort((a,b)=>a.id.localeCompare(b.id))])));
 for(const kind of ['publication','app-edit','sheet-edit'])for(const rejectAudit of [false,true])await test('受信案件の'+kind+'と監査を原子保存: 監査拒否'+rejectAudit,async()=>{
  const h=await (await fixture()).start();await h.run();await h.import();
  await db.doc('companies/'+h.companyId+'/sheetMappings/shift').update({operations:{'job.admin_edit':{values:['storeName']}}});
  const current=(await h.job.get()).data(),auditId=h.companyId+'-existing-audit';
  if(rejectAudit)await db.doc('auditLogs/'+auditId).set({companyId:h.companyId,marker:'既存監査を保持'});
  const before=await saved(h),original=db.collection.bind(db);
  // createの既存ID衝突を実SDKへ渡し、transaction全体のロールバックを確認する。
  if(rejectAudit)db.collection=function(name){const ref=original(name);if(name==='auditLogs')ref.doc=()=>original(name).doc(auditId);return ref;};
  const invoke=()=>kind==='publication'?management.updateJobPublication.run({auth:h.auth,data:{jobIds:h.created.jobIds,action:'stop'}}):management.adminEditJobInputs.run({auth:h.auth,data:{jobId:h.job.id,revision:current.revision,fields:kind==='app-edit'?{storeAddress:'合成の新住所'}:{storeName:'合成の新店舗'}}});
  let result;try{if(rejectAudit)await assert.rejects(invoke,e=>e.code===6);else result=await invoke();}finally{db.collection=original;}
  const after=await saved(h);
  if(rejectAudit){assert.deepEqual(after,before,'案件/勤務枠/書戻し依頼/監査の部分保存を禁止');return;}
  const job=(await h.job.get()).data();assert.equal(job.revision,current.revision+1);
  const audits=after.auditLogs.filter(d=>!before.auditLogs.some(old=>old.id===d.id));assert.equal(audits.length,1);assert.equal(audits[0].data.actorUid,h.auth.uid);assert.equal(audits[0].data.action,kind==='publication'?'job.publication.update':'job.admin_edit');assert.ok(audits[0].data.createdAt);
  assert.equal(after.sheetSyncQueue.length-before.sheetSyncQueue.length,kind==='sheet-edit'?1:0);
  if(kind==='publication'){assert.equal(job.status,'stopped');assert.deepEqual(audits[0].data.detail.updated,result.updated);}
  else{assert.equal(job[kind==='app-edit'?'storeAddress':'storeName'],kind==='app-edit'?'合成の新住所':'合成の新店舗');assert.deepEqual(audits[0].data.detail.result,result);assert.equal(result.sheetWriteQueued,kind==='sheet-edit');}
 });

}finally{
 google.sheets=originalSheets;safety.getProductionOperationalState=originalState;if(originalMode===undefined)delete process.env.LKC_SHEET_WRITE_MODE;else process.env.LKC_SHEET_WRITE_MODE=originalMode;
 await db.terminate();const stats=network.stats();network.restore();const result={project:environment.project,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length+(stats.blocked?1:0),network:stats,syntheticFetches,syntheticSheetReads:sheetReads,syntheticSheetWrites:sheetWrites,realCloud:false,realSheetWrites:0,realMessages:0,results};fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:result.passed,failed:result.failed,network:stats}));if(result.failed)process.exitCode=1;
}
