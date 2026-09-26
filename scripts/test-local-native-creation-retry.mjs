import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {localAcceptanceEnvironment,blockNonEmulatorConnections} from './local-firestore-acceptance-safety.mjs';
const environment=localAcceptanceEnvironment(process.env),network=blockNonEmulatorConnections(environment.port);
const require=createRequire(import.meta.url),{db}=require('../functions/lib/firebase.js'),management=require('../functions/lib/job-management.js');
const collections=['jobs','jobGroups','sheetRowCreateQueue','auditLogs','nativeJobCreationReceipts'];
const results=[];let sequence=0;
async function snapshot(companyId){return Object.fromEntries(await Promise.all(collections.map(async name=>[name,(await db.collection(name).where('companyId','==',companyId).get()).docs.map(d=>({id:d.id,data:d.data()})).sort((a,b)=>a.id.localeCompare(b.id))])));}
async function test(name,fn){try{await fn();results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:String(error.stack??error)});console.error('FAIL '+name+' '+error.message);}}
async function setup(kind,enabled=true){
 const companyId='synthetic-retry-'+(++sequence),auth={uid:companyId+'-admin',token:{companyId,role:'admin'}};
 await db.doc('companyFeatureSettings/'+companyId).set({adminJobCreationSourceReady:enabled});
 await db.doc('companies/'+companyId+'/sheetMappings/shift').set({enabled:true,rowCreation:{enabled:true}});
 const input={workDate:new Date(Date.now()+32*86400000).toISOString().slice(0,10),clientName:'合成取引先',storeName:'合成店舗',makerName:'合成メーカー',menuName:'試食',workTime:'10:00～18:00',slots:2,publicationMode:'draft'};
 if(kind==='duplicate')await db.doc('jobs/'+companyId+'-source').set({...input,companyId,financials:{marker:'retain'},assignedStaffId:'not-copied'});
 const command={operationId:randomUUID(),expectedCompanyId:companyId,expectedActorUid:auth.uid,action:'create',input:kind==='create'?input:{sourceJobId:companyId+'-source',workDate:input.workDate,slots:2,publicationMode:'draft'}};
 const callable=kind==='create'?management.createAdminJobGroup:management.duplicateAdminJob;
 return {companyId,auth,command,invoke:(patch={},user=auth)=>callable.run({auth:user,data:{nativeCreation:{...command,...patch}}}),state:()=>snapshot(companyId)};
}
try{
 for(const kind of ['create','duplicate']){
  for(const enabled of [false,true])await test(kind+'/同時再送・保存済み結果・原本追加'+enabled,async()=>{
   const h=await setup(kind,enabled),before=await h.state();
   const responses=await Promise.all([h.invoke(),h.invoke(),h.invoke()]);
   assert.equal(new Set(responses.map(r=>r.groupId)).size,1);
   const result=responses[0],after=await h.state();
   assert.equal(after.jobs.length-before.jobs.length,2);assert.equal(after.jobGroups.length,1);assert.equal(after.auditLogs.length,1);assert.equal(after.nativeJobCreationReceipts.length,1);assert.equal(after.sheetRowCreateQueue.length,enabled?1:0);
   assert.equal(result.nativeCreationReceipt.status,'committed');
   for(const id of result.jobIds){const job=(await db.doc('jobs/'+id).get()).data();assert.equal(job.sourceReady,false);assert.equal(job.status,'draft');assert.equal(job.assignedStaffId,undefined);if(kind==='duplicate'){assert.deepEqual(job.financials,{marker:'retain'});assert.equal(job.source.type,'admin_duplicate');}}
   const replay=await h.invoke();assert.equal(replay.replayed,true);assert.deepEqual(replay.jobIds,result.jobIds);assert.deepEqual(await h.state(),after);
  });
  await test(kind+'/commit後の応答喪失を同じ依頼で復旧',async()=>{
   const h=await setup(kind),original=db.runTransaction.bind(db);let lost=true;
   db.runTransaction=async(...args)=>{const value=await original(...args);if(lost){lost=false;throw Error('synthetic response lost after commit');}return value;};
   try{await assert.rejects(h.invoke(),/response lost/);}finally{db.runTransaction=original;}
   const before=await h.state(),result=await h.invoke();assert.equal(result.replayed,true);assert.deepEqual(await h.state(),before);assert.equal(result.jobIds.length,2);
  });
  await test(kind+'/取消先行は遅延作成も閉鎖',async()=>{
   const h=await setup(kind),before=await h.state();const cancelled=await h.invoke({action:'cancel'});assert.equal(cancelled.nativeCreationReceipt.status,'cancelled');
   const replay=await h.invoke();assert.equal(replay.nativeCreationReceipt.status,'cancelled');const after=await h.state();for(const name of collections.filter(n=>n!=='nativeJobCreationReceipts'))assert.deepEqual(after[name],before[name]);assert.equal(after.nativeJobCreationReceipts.length,1);
  });
  await test(kind+'/作成先行の取消は作成済み結果を保持',async()=>{
   const h=await setup(kind),created=await h.invoke(),before=await h.state(),cancelled=await h.invoke({action:'cancel'});assert.equal(cancelled.nativeCreationReceipt.status,'committed');assert.deepEqual(cancelled.jobIds,created.jobIds);assert.deepEqual(await h.state(),before);
  });
  await test(kind+'/作成と取消の競合は一つの確定結果',async()=>{
   const h=await setup(kind);const result=await Promise.all([h.invoke(),h.invoke({action:'cancel'})]);assert.equal(new Set(result.map(r=>r.nativeCreationReceipt.status)).size,1);const after=await h.state();assert.equal(after.nativeJobCreationReceipts.length,1);assert.equal(after.jobGroups.length,result[0].nativeCreationReceipt.status==='committed'?1:0);
  });
  for(const change of ['input','actor','company','kind'])await test(kind+'/再送の境界拒否/'+change,async()=>{
   const h=await setup(kind);await h.invoke();const before=await h.state();
   if(change==='input')await assert.rejects(h.invoke({input:{...h.command.input,slots:3}}),e=>e.code==='failed-precondition');
   if(change==='actor'){const auth={uid:'other',token:h.auth.token};await assert.rejects(h.invoke({expectedActorUid:'other'},auth),e=>e.code==='failed-precondition');}
   if(change==='company')await assert.rejects(h.invoke({expectedCompanyId:'other'}),e=>e.code==='permission-denied');
   if(change==='kind'){const opposite=kind==='create'?management.duplicateAdminJob:management.createAdminJobGroup;await assert.rejects(opposite.run({auth:h.auth,data:{nativeCreation:h.command}}),e=>e.code==='failed-precondition');}
   assert.deepEqual(await h.state(),before);
  });
  for(const change of ['missing-job','foreign-job','case-id','group','receipt'])await test(kind+'/保存済み照合拒否/'+change,async()=>{
   const h=await setup(kind),created=await h.invoke();const ref=db.doc('jobs/'+created.jobIds[0]);
   if(change==='missing-job')await ref.delete();if(change==='foreign-job')await ref.update({companyId:'foreign'});if(change==='case-id')await ref.update({caseId:'foreign-case'});
   if(change==='group')await db.doc('jobGroups/'+created.groupId).update({jobIds:[]});
   if(change==='receipt'){const receipt=(await db.collection('nativeJobCreationReceipts').where('companyId','==',h.companyId).get()).docs[0];await receipt.ref.update({result:{groupId:created.groupId}});}
   const before=await h.state();await assert.rejects(h.invoke(),e=>e.code==='failed-precondition');assert.deepEqual(await h.state(),before);
  });
  await test(kind+'/保存後の担当・取消状態を巻き戻さない',async()=>{
   const h=await setup(kind),created=await h.invoke();await db.doc('jobs/'+created.jobIds[0]).update({status:'cancelled',assignedStaffId:'synthetic-staff',revision:12});
   if(kind==='duplicate')await db.doc('jobs/'+h.command.input.sourceJobId).delete();
   const before=await h.state();assert.deepEqual((await h.invoke()).jobIds,created.jobIds);assert.deepEqual(await h.state(),before);
  });
  await test(kind+'/監査拒否時に全体未保存・同じ依頼で復旧',async()=>{
   const h=await setup(kind),auditId=h.companyId+'-existing';await db.doc('auditLogs/'+auditId).set({companyId:h.companyId,marker:'existing'});
   const before=await h.state(),original=db.collection.bind(db);db.collection=name=>{const ref=original(name);if(name==='auditLogs')ref.doc=()=>original(name).doc(auditId);return ref;};
   try{await assert.rejects(h.invoke(),e=>e.code===6);}finally{db.collection=original;}
   assert.deepEqual(await h.state(),before);assert.equal((await h.invoke()).nativeCreationReceipt.status,'committed');
  });
  await test(kind+'/不正入力の依頼も安全に閉じる',async()=>{
   const h=await setup(kind);h.command.input={};await assert.rejects(h.invoke());const before=await h.state();assert.equal(before.nativeJobCreationReceipts.length,0);assert.equal((await h.invoke({action:'cancel'})).nativeCreationReceipt.status,'cancelled');assert.equal((await h.invoke()).nativeCreationReceipt.status,'cancelled');
  });
  await test(kind+'/未認証・非管理者・混在形式は保存しない',async()=>{
   const h=await setup(kind),before=await h.state(),call=kind==='create'?management.createAdminJobGroup:management.duplicateAdminJob;
   await assert.rejects(h.invoke({},null),e=>e.code==='unauthenticated');await assert.rejects(h.invoke({},{uid:h.auth.uid,token:{...h.auth.token,role:'staff'}}),e=>e.code==='permission-denied');
   await assert.rejects(call.run({auth:h.auth,data:{nativeCreation:h.command,mailIntake:{}}}),e=>e.code==='invalid-argument');assert.deepEqual(await h.state(),before);
  });
 }
 await test('複製元の会社不一致では案件・受領とも保存しない',async()=>{const h=await setup('duplicate');await db.doc('jobs/'+h.command.input.sourceJobId).update({companyId:'foreign'});const before=await h.state();await assert.rejects(h.invoke(),e=>e.code==='not-found');assert.deepEqual(await h.state(),before);});
 for(const format of ['native','legacy'])for(const kind of ['create','duplicate'])for(const [field,value] of [['workDate','2026-02-30'],['workDate','2026-13-01'],['workDate','2026-00-10'],['publishAt','2026-02-30T09:00:00Z'],['publishAt','2026-01-01T24:00:00Z']])await test(format+'/'+kind+'/不正日時を保存しない/'+field+'/'+value,async()=>{
  const h=await setup(kind),input={...h.command.input,[field]:value,...(field==='publishAt'?{publicationMode:'scheduled'}:{})},before=await h.state();
  const invoke=()=>format==='native'?h.invoke({input}):(kind==='create'?management.createAdminJobGroup:management.duplicateAdminJob).run({auth:h.auth,data:input});
  await assert.rejects(invoke,e=>e.code==='invalid-argument');assert.deepEqual(await h.state(),before);
 });
 for(const kind of ['create','duplicate'])for(const value of ['2028-02-29','2026-10-01'])await test(kind+'/有効な実施日の対照/'+value,async()=>{const h=await setup(kind);const out=await h.invoke({input:{...h.command.input,workDate:value}});assert.equal(out.jobIds.length,2);});
 for(const publishAt of [undefined,null,'','invalid','2026-02-30T09:00:00Z','2026-01-01T24:00:00Z'])await test('公開予約/不正日時は案件と監査を変更しない/'+publishAt,async()=>{
  const h=await setup('create'),created=await h.invoke(),before=await h.state();
  await assert.rejects(management.updateJobPublication.run({auth:h.auth,data:{jobIds:created.jobIds,action:'schedule',...(publishAt===undefined?{}:{publishAt})}}),e=>e.code==='invalid-argument');assert.deepEqual(await h.state(),before);
 });
}finally{
 await db.terminate();const stats=network.stats();network.restore();const result={project:environment.project,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length+(stats.blocked?1:0),network:stats,realCloud:false,realSheetWrites:0,realMessages:0,results};fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:result.passed,failed:result.failed,network:stats}));if(result.failed)process.exitCode=1;
}
