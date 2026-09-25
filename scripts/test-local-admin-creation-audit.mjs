import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {localAcceptanceEnvironment,blockNonEmulatorConnections} from './local-firestore-acceptance-safety.mjs';
const environment=localAcceptanceEnvironment(process.env),network=blockNonEmulatorConnections(environment.port);
const require=createRequire(import.meta.url),{db}=require('../functions/lib/firebase.js');
const management=require('../functions/lib/job-management.js');
const results=[];let sequence=0;
const collections=['jobs','jobGroups','sheetRowCreateQueue','auditLogs'];
async function list(companyId,name){return(await db.collection(name).where('companyId','==',companyId).get()).docs;}
async function snapshot(companyId){return Object.fromEntries(await Promise.all(collections.map(async name=>[name,(await list(companyId,name)).map(d=>({id:d.id,data:d.data()})).sort((a,b)=>a.id.localeCompare(b.id))])));}
async function test(name,fn){try{await fn();results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:String(error.stack??error)});console.error('FAIL '+name+' '+error.message);}}
try{
 for(const enabled of [false,true])for(const duplicate of [false,true])for(const rejectAudit of [false,true])await test(`${duplicate?'複製':'新規'}/行作成${enabled}/監査拒否${rejectAudit}`,async()=>{
  const companyId='synthetic-audit-'+(++sequence),auth={uid:companyId+'-admin',token:{companyId,role:'admin'}};
  await db.doc('companyFeatureSettings/'+companyId).set({adminJobCreationSourceReady:enabled});
  await db.doc('companies/'+companyId+'/sheetMappings/shift').set({enabled:true,rowCreation:{enabled:true}});
  const workDate=new Date(Date.now()+32*86400000).toISOString().slice(0,10);
  const input={workDate,clientName:'合成取引先',storeName:'合成店舗',makerName:'合成メーカー',menuName:'試食',entryTime:'09:30',workTime:'10:00～18:00',slots:2,publicationMode:'draft'};
  const source=duplicate?await management.createAdminJobGroup.run({auth,data:input}):null;
  const auditId=companyId+'-existing-audit';
  if(rejectAudit)await db.doc('auditLogs/'+auditId).set({companyId,marker:'既存監査を保持'});
  const before=await snapshot(companyId),originalCollection=db.collection.bind(db);
  // 監査のcreateだけを既存IDへ向け、実SDKのALREADY_EXISTSでcommitを拒否する。
  if(rejectAudit)db.collection=function(name){const ref=originalCollection(name);if(name==='auditLogs')ref.doc=()=>originalCollection(name).doc(auditId);return ref;};
  const invoke=()=>duplicate?management.duplicateAdminJob.run({auth,data:{sourceJobId:source.jobIds[0],slots:2,publicationMode:'draft'}}):management.createAdminJobGroup.run({auth,data:input});
  let result;
  try{if(rejectAudit)await assert.rejects(invoke,e=>e.code===6);else result=await invoke();}
  finally{db.collection=originalCollection;}
  const after=await snapshot(companyId);
  if(rejectAudit){assert.deepEqual(after,before,'監査拒否時は既存案件と全書込先を保持');return;}
  assert.equal(after.jobs.length-before.jobs.length,2);assert.equal(after.jobGroups.length-before.jobGroups.length,1);assert.equal(after.sheetRowCreateQueue.length-before.sheetRowCreateQueue.length,enabled?1:0);
  const audits=after.auditLogs.filter(d=>!before.auditLogs.some(old=>old.id===d.id));assert.equal(audits.length,1);assert.equal(audits[0].data.action,duplicate?'job.group.duplicate':'job.group.create');assert.equal(audits[0].data.actorUid,auth.uid);assert.equal(audits[0].data.detail.groupId,result.groupId);assert.deepEqual(audits[0].data.detail.jobIds,result.jobIds);assert.ok(audits[0].data.createdAt);assert.equal(result.rowCreationQueued,enabled);
 });
}finally{
 await db.terminate();const stats=network.stats();network.restore();const result={project:environment.project,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length+(stats.blocked?1:0),network:stats,realCloud:false,realSheetWrites:0,realMessages:0,results};fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:result.passed,failed:result.failed,network:stats}));if(result.failed)process.exitCode=1;
}
