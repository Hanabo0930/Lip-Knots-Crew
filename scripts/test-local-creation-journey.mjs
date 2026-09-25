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
 await test('受信→実作成→行追加→原本読取→版付き公開と再送',async()=>{
  const h=await (await fixture()).start();assert.equal((await h.publishCurrent()).blocked.length,1);
  await h.run();assert.equal((await h.queue.get()).data().status,'completed');assert.equal((await h.job.get()).data().status,'draft');assert.equal((await h.publishCurrent()).blocked.length,1);
  await h.import();assert.ok((await db.doc('adminJobEditSources/'+h.job.id).get()).exists);assert.deepEqual((await h.publishCurrent()).updated,[h.job.id]);assert.equal((await h.job.get()).data().status,'open');
  await h.run();const replay=await h.receive();assert.deepEqual((await h.create(replay,'replay-operation')).jobIds,h.created.jobIds);await h.import();assert.equal((await h.job.get()).data().status,'open');assert.equal(h.sheet.inserted,1);assert.equal((await h.list('sheetRowCreateQueue')).length,1);
 });
 await test('原本の条件変更後は古い確認版を拒否して再確認で公開',async()=>{
  const h=await (await fixture()).start();await h.run();await h.import();const before=(await h.job.get()).data();h.sheet.rows.find(row=>row[54]===before.caseId)[10]='変更後店舗';await h.import();assert.equal((await h.publish([h.job.id],{[h.job.id]:before.revision})).blocked.length,1);assert.deepEqual((await h.publishCurrent()).updated,[h.job.id]);
 });
 await test('行追加中の実取消API結果を同期・公開で戻さない',async()=>{
  const h=await (await fixture()).start();h.sheet.afterWrite=async()=>{h.sheet.afterWrite=null;await jobs.adminCancelJob.run({auth:h.auth,data:{jobId:h.job.id,reason:'合成取消'}});};await h.run();const cancelled=(await h.job.get()).data();await assert.rejects(h.import(),e=>e.code==='failed-precondition');assert.deepEqual((await h.job.get()).data(),cancelled);assert.equal((await h.job.get()).data().status,'cancelled');assert.equal((await h.publishCurrent()).blocked.length,1);assert.equal(h.sheet.inserted,1);
 });
 await test('公開APIの会社・役割・確認版の境界',async()=>{
  const h=await (await fixture()).start();await h.run();await h.import();const before=(await h.job.get()).data();assert.equal((await h.publish([h.job.id],{[h.job.id]:before.revision},{uid:'foreign',token:{role:'admin',companyId:'synthetic-other'}})).updated.length,0);
  await assert.rejects(h.publish([h.job.id],{[h.job.id]:before.revision},{uid:'staff',token:{role:'staff',companyId:h.companyId}}),e=>e.code==='permission-denied');assert.equal((await h.publish([h.job.id],{})).blocked.length,1);assert.deepEqual((await h.job.get()).data(),before);
 });
 await test('受信内容の変更後は原本再同期でも募集保留を維持',async()=>{
  const h=await (await fixture()).start();await h.run();await h.import();await h.publishCurrent();
  const body=Buffer.from(h.source.rawMessage.payload.body.data,'base64url').toString('utf8').replace('合成店舗','受信変更後店舗');h.source.rawMessage.payload.body={size:Buffer.byteLength(body),data:Buffer.from(body).toString('base64url')};assert.equal((await h.receive()).status,'review');await h.import();const job=(await h.job.get()).data();assert.equal(job.mailIntakeReviewRequired,true);assert.equal(job.publishable,false);assert.equal((await h.publishCurrent()).blocked.length,1);
 });
 for(const count of [1,2])await test('管理者作成から原本同期で案件を重複させない '+count+'枠',async()=>{
  const h=await fixture();const result=await management.createAdminJobGroup.run({auth:h.auth,data:{workDate,clientName:'合成取引先',storeName:'合成店舗',makerName:'合成メーカー',menuName:'試食',entryTime:'09:30',workTime:'10:00～18:00',slots:count,publicationMode:'draft'}});
  const queue=db.doc('sheetRowCreateQueue/'+result.rowCreationQueueId),event={data:{after:await queue.get()}};await worker.processSheetRowCreation.run(event);assert.equal((await queue.get()).data().status,'completed');const before=await db.getAll(...result.jobIds.map(id=>db.doc('jobs/'+id)));await h.import();
  const all=await h.list('jobs');for(const original of before){const matches=all.filter(doc=>doc.data().caseId===original.data().caseId);assert.equal(matches.length,1,'同じcaseIdの案件は1件');assert.equal(matches[0].id,original.id);assert.ok((await db.doc('adminJobEditSources/'+original.id).get()).exists);assert.equal(matches[0].data().status,'draft','管理者が保存した下書きを同期で公開しない');}
  await worker.processSheetRowCreation.run(event);assert.equal(h.sheet.inserted,count);
 });

 await test('実複製APIの複数枠も原本同期で同じ案件へ収束',async()=>{
  const h=await (await fixture()).start();await h.run();const created=await management.duplicateAdminJob.run({auth:h.auth,data:{sourceJobId:h.job.id,slots:2,publicationMode:'draft'}});const queue=db.doc('sheetRowCreateQueue/'+created.rowCreationQueueId);await worker.processSheetRowCreation.run({data:{after:await queue.get()}});assert.equal((await queue.get()).data().status,'completed');const before=await db.getAll(...created.jobIds.map(id=>db.doc('jobs/'+id)));await h.import();const all=await h.list('jobs');for(const original of before){const matches=all.filter(doc=>doc.data().caseId===original.data().caseId);assert.equal(matches.length,1);assert.equal(matches[0].id,original.id);assert.equal(matches[0].data().status,'draft');}assert.equal(h.sheet.inserted,3);
 });
 for(const mode of ['legacy-only','canonical-and-legacy','foreign-legacy'])await test('旧管理者IDの検出と会社境界 '+mode,async()=>{
  const h=await fixture();const created=await management.createAdminJobGroup.run({auth:h.auth,data:{workDate,clientName:'合成取引先',storeName:'合成店舗',makerName:'合成メーカー',menuName:'試食',entryTime:'09:30',workTime:'10:00～18:00',slots:1,publicationMode:'draft'}});const queue=db.doc('sheetRowCreateQueue/'+created.rowCreationQueueId);await worker.processSheetRowCreation.run({data:{after:await queue.get()}});const ref=db.doc('jobs/'+created.jobIds[0]),data=(await ref.get()).data(),legacy=db.doc('jobs/legacy-'+h.companyId);await legacy.set({...data,companyId:mode==='foreign-legacy'?'synthetic-other':h.companyId});if(mode==='legacy-only')await ref.delete();const beforeRef=await ref.get(),beforeLegacy=(await legacy.get()).data();
  if(mode==='foreign-legacy'){await h.import();assert.ok((await ref.get()).exists);}else{await assert.rejects(h.import(),e=>e.code==='failed-precondition'&&e.message.includes('旧ID'));assert.deepEqual((await ref.get()).data(),beforeRef.data());}assert.deepEqual((await legacy.get()).data(),beforeLegacy);assert.equal(h.sheet.inserted,1);
 });

 for(const mode of ['scheduled','stopped','immediate'])await test('管理者の募集指定を原本同期で保持 '+mode,async()=>{
  const h=await fixture();const created=await management.createAdminJobGroup.run({auth:h.auth,data:{workDate,clientName:'合成取引先',storeName:'合成店舗',makerName:'合成メーカー',menuName:'試食',entryTime:'09:30',workTime:'10:00～18:00',slots:1,publicationMode:mode==='stopped'?'immediate':mode,publishAt:mode==='scheduled'?new Date(Date.now()+3600000).toISOString():null}});
  const queue=db.doc('sheetRowCreateQueue/'+created.rowCreationQueueId);await worker.processSheetRowCreation.run({data:{after:await queue.get()}});const ref=db.doc('jobs/'+created.jobIds[0]);if(mode==='stopped')await management.updateJobPublication.run({auth:h.auth,data:{jobIds:created.jobIds,action:'stop'}});const before=(await ref.get()).data();await h.import();const after=(await ref.get()).data();for(const key of ['status','publishable','recruitmentStopped','scheduledPublishAt'])assert.deepEqual(after[key],before[key],key);assert.equal((await h.list('jobs')).filter(doc=>doc.data().caseId===before.caseId).length,1);
 });

 await test('人数枠を分けた受信候補2件の作成・行追加・一括公開',async()=>{
  const h=await fixture(2),received=await h.receive();assert.equal(received.status,'ready');assert.equal(received.candidateIds.length,2);const created=[];
  for(const [i,id] of received.candidateIds.entries()){const out=await h.create({...received,candidateIds:[id]},'slot-'+i);created.push(out);const queue=db.doc('sheetRowCreateQueue/'+out.rowCreationQueueId);await worker.processSheetRowCreation.run({data:{after:await queue.get()}});assert.equal((await queue.get()).data().status,'completed');}
  const ids=created.flatMap(x=>x.jobIds),revision=async()=>Object.fromEntries((await db.getAll(...ids.map(id=>db.doc('jobs/'+id)))).map(snap=>[snap.id,snap.data().revision]));assert.equal((await h.publish(ids,await revision())).blocked.length,2);await h.import();assert.deepEqual(new Set((await h.publish(ids,await revision())).updated),new Set(ids));assert.equal(h.sheet.inserted,2);
  for(const id of ids){const job=(await db.doc('jobs/'+id).get()).data();assert.equal(job.status,'open');assert.equal(h.sheet.rows.filter(row=>row[54]===job.caseId).length,1);}
 });

 for(const kind of ['create','duplicate'])for(const mode of ['draft','immediate','scheduled'])await test('受領記録→行作成→原本取込→同じ依頼の結果確認 '+kind+'/'+mode,async()=>{
  const h=await fixture();let initialRows=0;
  if(kind==='duplicate'){await h.start();await h.run();initialRows=1;}
  const input=kind==='create'?{workDate,clientName:'合成取引先',storeName:'合成再送店舗',makerName:'合成メーカー',menuName:'試食',entryTime:'09:30',workTime:'10:00～18:00',slots:2,publicationMode:mode,publishAt:mode==='scheduled'?new Date(Date.now()+3600000).toISOString():null}:{sourceJobId:h.job.id,workDate,slots:2,publicationMode:mode,publishAt:mode==='scheduled'?new Date(Date.now()+3600000).toISOString():null};
  const command={operationId:crypto.randomUUID(),expectedCompanyId:h.companyId,expectedActorUid:h.auth.uid,action:'create',input};const api=kind==='create'?management.createAdminJobGroup:management.duplicateAdminJob;
  const invoke=action=>api.run({auth:h.auth,data:{nativeCreation:{...command,action:action??'create'}}});
  await invoke();const created=await invoke();assert.equal(created.replayed,true);assert.equal((await h.list('nativeJobCreationReceipts')).length,1);
  const queue=db.doc('sheetRowCreateQueue/'+created.rowCreationQueueId),event={data:{after:await queue.get()}};await worker.processSheetRowCreation.run(event);assert.equal((await queue.get()).data().status,'completed');await worker.processSheetRowCreation.run(event);assert.equal(h.sheet.inserted,initialRows+2);
  const priorJobs=await db.getAll(...created.jobIds.map(id=>db.doc('jobs/'+id)));
  await h.import();const all=await h.list('jobs');for(const id of created.jobIds){const job=(await db.doc('jobs/'+id).get()).data();assert.equal(all.filter(d=>d.data().caseId===job.caseId).length,1);assert.ok(job.nativeCreationReceiptId);assert.ok((await db.doc('adminJobEditSources/'+id).get()).exists);const prior=priorJobs.find(doc=>doc.id===id).data();for(const field of ['status','publishable','recruitmentStopped','scheduledPublishAt'])assert.deepEqual(job[field],prior[field],field);assert.equal(job.nativeCreationReceiptId,prior.nativeCreationReceiptId);}
  const state=async()=>Object.fromEntries(await Promise.all(['jobs','jobGroups','sheetRowCreateQueue','auditLogs','nativeJobCreationReceipts','adminJobEditSources'].map(async name=>[name,(await h.list(name)).map(d=>({id:d.id,data:d.data(),updateTime:d.updateTime})).sort((a,b)=>a.id.localeCompare(b.id))])));
  const before=await state();assert.deepEqual((await invoke()).jobIds,created.jobIds);assert.equal((await invoke('cancel')).nativeCreationReceipt.status,'committed');assert.deepEqual(await state(),before);assert.equal(h.sheet.inserted,initialRows+2);
 });

}finally{
 google.sheets=originalSheets;safety.getProductionOperationalState=originalState;if(originalMode===undefined)delete process.env.LKC_SHEET_WRITE_MODE;else process.env.LKC_SHEET_WRITE_MODE=originalMode;
 await db.terminate();const stats=network.stats();network.restore();const result={project:environment.project,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length+(stats.blocked?1:0),network:stats,syntheticFetches,syntheticSheetReads:sheetReads,syntheticSheetWrites:sheetWrites,realCloud:false,realSheetWrites:0,realMessages:0,results};fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:result.passed,failed:result.failed,network:stats}));if(result.failed)process.exitCode=1;
}
