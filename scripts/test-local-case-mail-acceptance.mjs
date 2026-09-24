import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {localAcceptanceEnvironment,blockNonEmulatorConnections} from './local-firestore-acceptance-safety.mjs';
const environment=localAcceptanceEnvironment(process.env);
const network=blockNonEmulatorConnections(environment.port);
const require=createRequire(import.meta.url);
const {analyzeFetchedCaseMail}=await import('./case-mail-intake-adapter.mjs');
const {db}=require('../functions/lib/firebase.js');
const {createCaseMailReceiver}=require('../functions/lib/case-mail-intake.js');
const {caseMailRecordKey}=require('../functions/lib/case-mail-job-creation.js');
const {createAdminJobGroup}=require('../functions/lib/job-management.js');
let sequence=0,syntheticFetches=0;const results=[];
const workDate=new Date(Date.now()+32*86400000).toISOString().slice(0,10);
async function fixture() {
  const companyId='synthetic-mail-sdk-'+(++sequence),uid=companyId+'-receiver';
  const config={companyId,uid,producerId:'synthetic-producer',principalRevision:'principal-1',mailbox:'info@lipknots.com',startedAt:new Date(Date.now()-86400000).toISOString()};
  await db.doc('companyFeatureSettings/'+companyId).set({caseMailIntakeEnabled:true,caseMailJobCreationEnabled:true,adminJobCreationSourceReady:true});
  await db.doc('automationIngestPrincipals/'+caseMailRecordKey(companyId,uid)).set({companyId,uid,active:true,producerId:config.producerId,revision:config.principalRevision});
  await db.doc('companies/'+companyId+'/sheetMappings/shift').set({enabled:true,rowCreation:{enabled:true},spreadsheetId:'synthetic-local-only-sheet'});
  const body=Buffer.from(['実施日：'+workDate.replaceAll('-','/'),'クライアント：合成取引先','店舗：合成店舗','メーカー：合成メーカー','メニュー：試食','入店時間：09:30','実施時間：10:00～18:00','人数：1名'].join('\n'));
  const source={rawMessage:{id:'synthetic-message',threadId:'synthetic-thread',internalDate:String(Date.now()),payload:{partId:'0',mimeType:'text/plain',headers:[{name:'From',value:'sender@example.invalid'},{name:'To',value:'info@lipknots.com'},{name:'Subject',value:'新規手配依頼'}],body:{size:body.length,data:body.toString('base64url')}}},documents:[]};
  // Gmail取得だけを合成境界へ置換し、解析と保存・作成は実装本体を使う。
  const hooks={};
  const receiver=createCaseMailReceiver(config,{fetch:async request=>{assert.equal(request.messageId,source.rawMessage.id);syntheticFetches++;await hooks.afterFetch?.();return structuredClone(source);},parse:analyzeFetchedCaseMail});
  const auth={uid:companyId+'-admin',token:{role:'admin',companyId}};
  const command=(received,operationId='synthetic-operation')=>({mailIntake:{receiptId:received.receiptId,candidateId:received.candidateIds[0],expectedReceiptRevision:received.revision,expectedRevision:1,operationId}});
  return {companyId,config,source,auth,command,hooks,receive:()=>receiver({messageId:source.rawMessage.id}),
    create:(received,operationId,user=auth)=>createAdminJobGroup.run({auth:user,data:command(received,operationId)}),
    list:async name=>(await db.collection(name).where('companyId','==',companyId).get()).docs};
}
async function test(name,fn) {
  try{await fn();results.push({name,passed:true});console.log('PASS '+name);}
  catch(error){results.push({name,passed:false,error:String(error.stack??error)});console.error('FAIL '+name+' '+error.message);}
}
try {
  await test('同一メールの同時受信が受信記録・候補・監査1組に収束',async()=>{
    const h=await fixture(),out=await Promise.all([h.receive(),h.receive(),h.receive()]);
    assert.ok(out.every(x=>x.status==='ready'));assert.deepEqual(out[0].candidateIds,out[1].candidateIds);assert.deepEqual(out[1].candidateIds,out[2].candidateIds);
    assert.equal((await h.list('caseMailIntakeReceipts')).length,1);assert.equal((await h.list('caseMailIntakeCandidates')).length,1);assert.equal((await h.list('auditLogs')).length,1);assert.equal((await h.list('jobs')).length,0);
    assert.equal(out.filter(x=>x.replayed).length,2);
  });
  await test('解析→同じ候補の別操作ID同時作成は案件・行依頼1組へ収束',async()=>{
    const h=await fixture(),received=await h.receive();const out=await Promise.all([h.create(received,'operation-a'),h.create(received,'operation-b')]);
    assert.deepEqual(out[0].jobIds,out[1].jobIds);
    for(const name of ['jobs','jobGroups','caseMailJobSources','caseMailJobCreates','sheetRowCreateQueue'])assert.equal((await h.list(name)).length,1,name);
    assert.equal((await h.list('auditLogs')).length,2);
    const job=(await h.list('jobs'))[0].data();assert.equal(job.status,'draft');assert.equal(job.publishable,false);assert.equal(job.sourceReady,false);assert.equal(job.workDate,workDate);
    const replay=await h.receive();assert.equal(replay.replayed,true);assert.deepEqual((await h.create(replay,'operation-c')).jobIds,out[0].jobIds);
    assert.equal((await h.list('jobs')).length,1);assert.equal((await h.list('sheetRowCreateQueue')).length,1);
  });
  await test('同じ操作の再送で受領結果を回収し版違いは拒否',async()=>{
    const h=await fixture(),received=await h.receive(),first=await h.create(received);
    assert.deepEqual((await h.create(received)).jobIds,first.jobIds);
    const changed=h.command(received);changed.mailIntake.expectedRevision=2;
    await assert.rejects(createAdminJobGroup.run({auth:h.auth,data:changed}),e=>e.code==='failed-precondition');
    assert.equal((await h.list('jobs')).length,1);assert.equal((await h.list('sheetRowCreateQueue')).length,1);
  });
  await test('会社・役割・確認版の不一致は案件や行依頼を作らない',async()=>{
    const h=await fixture(),received=await h.receive();
    await assert.rejects(h.create(received,'foreign',{uid:'foreign-admin',token:{role:'admin',companyId:'foreign-company'}}),e=>e.code==='failed-precondition');
    await assert.rejects(h.create(received,'staff',{uid:'staff',token:{role:'staff',companyId:h.companyId,staffId:'synthetic-staff'}}),e=>e.code==='permission-denied');
    await assert.rejects(h.create({...received,revision:received.revision+1},'stale'),e=>e.code==='failed-precondition');
    for(const name of ['jobs','jobGroups','sheetRowCreateQueue','caseMailJobCreates'])assert.equal((await h.list(name)).length,0);
  });
  await test('受信停止・実行者失効で取得と保存を止める',async()=>{
    const h=await fixture();await db.doc('companyFeatureSettings/'+h.companyId).update({caseMailIntakeEnabled:false});const before=syntheticFetches;
    await assert.rejects(h.receive(),e=>e.code==='failed-precondition');assert.equal(syntheticFetches,before);
    await db.doc('companyFeatureSettings/'+h.companyId).update({caseMailIntakeEnabled:true});
    await db.doc('automationIngestPrincipals/'+caseMailRecordKey(h.companyId,h.config.uid)).update({active:false});
    await assert.rejects(h.receive(),e=>e.code==='failed-precondition');assert.equal(syntheticFetches,before);assert.equal((await h.list('caseMailIntakeReceipts')).length,0);
  });
  await test('取得中に受信停止へ変わった場合は再確認して保存拒否',async()=>{
    const h=await fixture();h.hooks.afterFetch=()=>db.doc('companyFeatureSettings/'+h.companyId).update({caseMailIntakeEnabled:false});
    await assert.rejects(h.receive(),e=>e.code==='failed-precondition');
    for(const name of ['caseMailIntakeReceipts','caseMailIntakeCandidates','jobs','auditLogs'])assert.equal((await h.list(name)).length,0,name);
  });
  await test('登録後の原文変更は案件を増やさず旧内容保持・募集保留へ遷移',async()=>{
    const h=await fixture(),received=await h.receive();await h.create(received);
    const original=(await h.list('jobs'))[0],before=original.data();
    const body=Buffer.from(h.source.rawMessage.payload.body.data,'base64url').toString('utf8').replace('合成店舗','変更後の合成店舗');
    h.source.rawMessage.payload.body={size:Buffer.byteLength(body),data:Buffer.from(body).toString('base64url')};
    const changed=await h.receive();assert.equal(changed.status,'review');assert.equal(changed.revision,received.revision+1);
    const current=(await original.ref.get()).data();
    for(const key of ['caseId','workDate','storeName','groupId','mailIntake'])assert.deepEqual(current[key],before[key],key);
    assert.equal(current.publishable,false);assert.equal(current.recruitmentStopped,true);assert.equal(current.mailIntakeReviewRequired,true);
    await assert.rejects(h.create(changed,'operation-changed'),e=>e.code==='failed-precondition');
    const replay=await h.receive();assert.equal(replay.replayed,true);assert.equal(replay.revision,changed.revision);
    assert.equal((await h.list('jobs')).length,1);assert.equal((await h.list('sheetRowCreateQueue')).length,1);assert.equal((await h.list('auditLogs')).length,3);
  });
} finally {
  await db.terminate();const stats=network.stats();network.restore();
  const result={project:environment.project,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length+(stats.blocked?1:0),network:stats,syntheticFetches,
    firestore:'real SDK / local emulator',gmail:'synthetic fetch boundary; production parser',authentication:'synthetic callable claims',actualMailReads:0,actualMessagesSent:0,realSheetWrites:0,results};
  fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:result.passed,failed:result.failed,network:stats,actualMailReads:0,realSheetWrites:0}));if(result.failed)process.exitCode=1;
}
