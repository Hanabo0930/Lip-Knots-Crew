import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {localAcceptanceEnvironment,blockNonEmulatorConnections} from './local-firestore-acceptance-safety.mjs';
const environment=localAcceptanceEnvironment(process.env),network=blockNonEmulatorConnections(environment.port);
const require=createRequire(import.meta.url),{Timestamp,Query}=require('firebase-admin/firestore');
const {db}=require('../functions/lib/firebase.js'),safety=require('../functions/lib/system-safety.js');
const previousMode=process.env.LKC_SHEET_WRITE_MODE;
process.env.LKC_SHEET_WRITE_MODE='active';
let operational=true,operationalCompanies=[],afterQuery=null,sequence=0,sheetsCalls=0;
const originalState=safety.getProductionOperationalState;
safety.getProductionOperationalState=async companyId=>{operationalCompanies.push(companyId);return {operational,reason:'synthetic-global-pause'};};
const {google}=require('googleapis'),originalSheets=google.sheets;
google.sheets=()=>{sheetsCalls++;throw Error('UNEXPECTED_SHEETS_ACCESS');};
const workers=require('../functions/lib/sheet-row-creation.js'),originalGet=Query.prototype.get;
Query.prototype.get=async function(...args){const result=await originalGet.apply(this,args);if(afterQuery)await afterQuery(result);return result;};
const refs=[],results=[];
const remember=path=>{const ref=db.doc(path);refs.push(ref);return ref;};
async function fixture(status='pending'){
 const id='synthetic-row-'+(++sequence),companyId=id,job=remember('jobs/'+id),queue=remember('sheetRowCreateQueue/'+id),mapping=remember('companies/'+companyId+'/sheetMappings/shift');
 const retryAt=Timestamp.fromMillis(Date.now()-60000),future=Timestamp.fromMillis(Date.now()+3600000);
 await job.set({companyId,sourceReady:true,sheetRef:{spreadsheetId:'synthetic-only',currentRow:2}});
 await mapping.set({enabled:true,spreadsheetId:'synthetic-only',idColumn:'A',identityColumns:{workDate:'B',clientName:'C',storeName:'D',workTime:'E'},rowCreation:{enabled:true}});
 await queue.set({companyId,groupId:id,jobIds:[id],status,attempts:2,retryAt});
 const snapshot=await queue.get();return {id,companyId,job,queue,mapping,retryAt,future,event:()=>workers.processSheetRowCreation.run({data:{after:snapshot}})};
}
async function test(name,body){
 try{await body();results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:String(error.stack??error)});console.error('FAIL '+name+' '+error.message);}
 finally{afterQuery=null;operational=true;operationalCompanies=[];if(refs.length){const batch=db.batch();for(const ref of refs.splice(0))batch.delete(ref);await batch.commit();}}
}
try{
 for(const status of ['completed','processing','retry_wait','blocked','manual_intervention','paused_global'])await test('遅延pendingイベントが現在の'+status+'を変えない',async()=>{
  const h=await fixture();await h.queue.update({status});const before=(await h.queue.get()).data();operational=false;await h.event();assert.deepEqual((await h.queue.get()).data(),before);
 });
 await test('遅延イベントで削除済み依頼を再作成しない',async()=>{const h=await fixture();await h.queue.delete();operational=false;await h.event();assert.equal((await h.queue.get()).exists,false);});
 await test('運用停止の確認は現在の会社で行う',async()=>{const h=await fixture();await h.queue.update({companyId:'synthetic-new-company'});operational=false;await h.event();assert.deepEqual(operationalCompanies,['synthetic-new-company']);assert.equal((await h.queue.get()).data().status,'paused_global');});
 await test('行作成は取得権を得た現在の案件を使う',async()=>{
  const h=await fixture(),next=remember('jobs/'+h.id+'-new');await next.set((await h.job.get()).data());await h.job.delete();await h.queue.update({jobIds:[next.id]});await h.event();
  const queue=(await h.queue.get()).data();assert.equal(queue.status,'completed');assert.equal(queue.alreadyCompleted,true);assert.equal(queue.attempts,3);assert.equal((await next.get()).data().sourceCreationStatus,undefined);
 });
 await test('同じpendingイベントの重複配送で実行権を重複取得しない',async()=>{const h=await fixture();await Promise.all([h.event(),h.event()]);const queue=(await h.queue.get()).data();assert.equal(queue.status,'completed');assert.equal(queue.attempts,3);});
 await test('有効なpending依頼は全体停止時に試行回数を増やさず停止',async()=>{const h=await fixture();operational=false;await h.event();const queue=(await h.queue.get()).data();assert.equal(queue.status,'paused_global');assert.equal(queue.attempts,2);});
 for(const status of ['completed','processing','blocked','manual_intervention','paused_global'])await test('再試行検索後の'+status+'をpendingへ戻さない',async()=>{
  const h=await fixture('retry_wait');let changed=false;
  afterQuery=async result=>{if(!changed&&result.docs.some(d=>d.ref.path===h.queue.path)){changed=true;await h.queue.update({status});}};
  await workers.retrySheetRowCreation.run({});assert.equal(changed,true);assert.equal((await h.queue.get()).data().status,status);
 });
 for(const mode of ['future','null','removed'])await test('再試行検索後の期限変更 '+mode+' を保持',async()=>{
  const h=await fixture('retry_wait');let changed=false;
  afterQuery=async result=>{if(!changed&&result.docs.some(d=>d.ref.path===h.queue.path)){changed=true;await h.queue.set({companyId:h.companyId,status:'retry_wait',...(mode==='removed'?{}:{retryAt:mode==='future'?h.future:null})});}};
  await workers.retrySheetRowCreation.run({});assert.equal(changed,true);assert.equal((await h.queue.get()).data().status,'retry_wait');
 });
 await test('再試行検索後の削除を復活させない',async()=>{const h=await fixture('retry_wait');let changed=false;afterQuery=async result=>{if(!changed&&result.docs.some(d=>d.ref.path===h.queue.path)){changed=true;await h.queue.delete();}};await workers.retrySheetRowCreation.run({});assert.equal(changed,true);assert.equal((await h.queue.get()).exists,false);});
 await test('期限を迎えた再試行だけをpendingへ移す',async()=>{const h=await fixture('retry_wait');await workers.retrySheetRowCreation.run({});const queue=(await h.queue.get()).data();assert.equal(queue.status,'pending');assert.equal(queue.attempts,2);});
 await test('1回50件の再試行上限を維持',async()=>{
  const batch=db.batch(),queues=[];for(let i=0;i<51;i++){const ref=remember('sheetRowCreateQueue/synthetic-limit-'+i);queues.push(ref);batch.set(ref,{status:'retry_wait',retryAt:Timestamp.fromMillis(Date.now()-60000),attempts:2});}await batch.commit();
  await workers.retrySheetRowCreation.run({});const docs=await db.getAll(...queues);assert.equal(docs.filter(d=>d.data().status==='pending').length,50);assert.equal(docs.filter(d=>d.data().status==='retry_wait').length,1);
 });
}finally{
 Query.prototype.get=originalGet;safety.getProductionOperationalState=originalState;google.sheets=originalSheets;
 if(previousMode===undefined)delete process.env.LKC_SHEET_WRITE_MODE;else process.env.LKC_SHEET_WRITE_MODE=previousMode;
 await db.terminate();const stats=network.stats();network.restore();
 const result={project:environment.project,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length+(stats.blocked||sheetsCalls?1:0),network:stats,sheetsCalls,firestore:'real SDK / local emulator',operationalGate:'synthetic state boundary',realMessages:0,realSheetWrites:0,results};
 fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:result.passed,failed:result.failed,network:stats,sheetsCalls}));if(result.failed)process.exitCode=1;
}
