import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {localAcceptanceEnvironment,blockNonEmulatorConnections} from './local-firestore-acceptance-safety.mjs';
const environment=localAcceptanceEnvironment(process.env),network=blockNonEmulatorConnections(environment.port);
const require=createRequire(import.meta.url),{Timestamp}=require('firebase-admin/firestore');
const {db}=require('../functions/lib/firebase.js'),safety=require('../functions/lib/system-safety.js');
const {google}=require('googleapis');
const previousMode=process.env.LKC_SHEET_WRITE_MODE,originalState=safety.getProductionOperationalState,originalSheets=google.sheets,originalTransaction=db.runTransaction;
process.env.LKC_SHEET_WRITE_MODE='active';
safety.getProductionOperationalState=async()=>({operational:true});
let sequence=0,sheetsCalls=0,syntheticSheetCalls=0,sheetState=null,afterClaim=null;
const results=[],refs=[],companies=[];
const remember=path=>{const ref=db.doc(path);refs.push(ref);return ref;};
db.runTransaction=async function(...args){
 const result=await originalTransaction.apply(this,args);
 if(afterClaim&&result?.companyId&&Array.isArray(result.jobIds)){const callback=afterClaim;afterClaim=null;await callback();}
 if(sheetState?.commitLoss&&sheetState.inserted&&!sheetState.commitLossInjected&&(await sheetState.queue.get()).data()?.status==='completed'){
  sheetState.commitLossInjected=true;throw Error('synthetic-commit-response-lost');
 }
 return result;
};
google.sheets=()=>{
 if(!sheetState){sheetsCalls++;throw Error('UNEXPECTED_SHEETS_ACCESS');}
 return {spreadsheets:{
  get:async request=>{syntheticSheetCalls++;assert.equal(request.spreadsheetId,'synthetic-only');return {data:{sheets:[{properties:{sheetId:1,title:'2026.9',gridProperties:{rowCount:100,columnCount:11}},conditionalFormats:[]}]}};},
  batchUpdate:async request=>{
   syntheticSheetCalls++;assert.equal(request.spreadsheetId,'synthetic-only');
   if(request.requestBody.requests.some(r=>r.insertDimension)){sheetState.inserted=true;await sheetState.afterInsert();}
   else {assert.ok(request.requestBody.requests.every(r=>r.deleteDimension));sheetState.deletes++;}
   return {data:{}};
  },
  values:{
   batchGet:async request=>{syntheticSheetCalls++;assert.equal(request.spreadsheetId,'synthetic-only');return {data:{valueRanges:(request.valueRenderOption==='FORMATTED_VALUE'?['2026-09-25','Synthetic Client','Synthetic Store','09:00-17:00']:[sheetState.verifyMismatch?'synthetic-wrong-id':sheetState.caseId]).map(value=>({values:[[value]]}))}};},
   get:async request=>{syntheticSheetCalls++;assert.equal(request.spreadsheetId,'synthetic-only');sheetState.rollbackReads++;if(sheetState.rollbackError)throw Error('synthetic-rollback-read-error');return {data:{values:[[sheetState.rollbackMismatch?'synthetic-other-id':sheetState.caseId]]}};},
  },
 }};
};
const workers=require('../functions/lib/sheet-row-creation.js');
async function fixture(full=false){
 const id='synthetic-success-'+(++sequence),companyId=id;companies.push(companyId);
 const job=remember('jobs/'+id),queue=remember('sheetRowCreateQueue/'+id),group=remember('jobGroups/'+id),mapping=remember('companies/'+id+'/sheetMappings/shift'),lock=remember('syncLocks/'+id+'_sheet_row_create_2026_9');
 await group.set({companyId,jobIds:[id]});
 await job.set({companyId,groupId:id,caseId:id,dateKey:'2026-09-25',sourceReady:!full,status:'draft',requestedPublicationMode:'immediate',...(!full?{sheetRef:{spreadsheetId:'synthetic-only',currentRow:2}}:{})});
 await mapping.set({enabled:true,spreadsheetId:'synthetic-only',idColumn:'A',identityColumns:{workDate:'B',clientName:'D',storeName:'E',workTime:'I'},columns:{caseId:'A',workDate:'B',staffName:'C',clientName:'D',storeName:'E',makerName:'F',menuName:'G',entryTime:'H',workTime:'I',subcontractorName:'J',staffBasePay:'K'},rowCreation:{enabled:true,rowEndColumn:'K',formulaColumns:[],requiredValidationColumns:[],copyFormula:false,copyFormat:false,copyDataValidation:false,cloneConditionalFormatting:false}});
 await queue.set({companyId,groupId:id,jobIds:[id],status:'pending',attempts:2});
 const snapshot=await queue.get();
 return {id,companyId,job,queue,group,mapping,lock,event:()=>workers.processSheetRowCreation.run({data:{after:snapshot}})};
}
async function test(name,body){
 try{await body();results.push({name,passed:true});console.log('PASS '+name);}
 catch(error){results.push({name,passed:false,error:String(error.stack??error)});console.error('FAIL '+name+' '+error.message);}
 finally{
  afterClaim=null;sheetState=null;
  for(const companyId of companies.splice(0))for(const collection of ['auditLogs','sheetRowManualInterventions']){
   const snapshots=await db.collection(collection).where('companyId','==',companyId).get();refs.push(...snapshots.docs.map(doc=>doc.ref));
  }
  if(refs.length){const batch=db.batch();for(const ref of refs.splice(0))batch.delete(ref);await batch.commit();}
 }
}
const changes=['completed','paused_global','retry_wait','pending','deleted','company','group','jobs','attempt'];
async function changeQueue(h,mode){
 if(mode==='deleted')await h.queue.delete();
 else await h.queue.update(mode==='company'?{companyId:'synthetic-other'}:mode==='group'?{groupId:'synthetic-other'}:mode==='jobs'?{jobIds:[]}:mode==='attempt'?{attempts:99}:{status:mode});
}
try{
 for(const entry of ['alreadyReady','idempotency'])for(const mode of changes)await test(entry+'の旧試行完了を抑止 '+mode,async()=>{
  const h=await fixture();
  if(entry==='idempotency'){
   const key='synthetic-key';await h.queue.update({idempotencyKey:key});
   const receipt=remember('sheetRowCreationIdempotency/'+createHash('sha256').update(h.companyId+'|'+key).digest('hex'));
   await receipt.set({companyId:h.companyId,status:'completed',queueId:'synthetic-prior-queue'});
  }
  let preserved;afterClaim=async()=>{await changeQueue(h,mode);preserved=(await h.queue.get()).data();};
  await h.event();assert.deepEqual((await h.queue.get()).data(),preserved);
 });
 for(const entry of ['alreadyReady','idempotency','foreign-receipt'])await test('有効な早期完了と完了記録の会社照合 '+entry,async()=>{
  const h=await fixture();if(entry!=='alreadyReady'){
   const key='synthetic-key';await h.queue.update({idempotencyKey:key});
   await remember('sheetRowCreationIdempotency/'+createHash('sha256').update(h.companyId+'|'+key).digest('hex')).set({companyId:entry==='foreign-receipt'?'synthetic-other':h.companyId,status:'completed',queueId:'synthetic-prior-queue'});
  }
  await h.event();const result=(await h.queue.get()).data();assert.equal(result.status,entry==='foreign-receipt'?'blocked':'completed');if(entry==='idempotency')assert.equal(result.duplicateOf,'synthetic-prior-queue');
 });
 const fullModes=['initial-cancel','initial-assigned','initial-stopped','mail-marker-removed','native-cancel','received-cancel','assigned','stopped','publication-change','deleted-job','foreign-job','moved-job','case-change','input-change','deleted-group','foreign-group','mapping-change','deleted-queue','queue-attempt','lock-lost','lock-expired','rollback-mismatch','rollback-error','verification-mismatch','rollback-disabled','commit-response-lost','valid'];
 for(const mode of fullModes)await test('行追加・完了・取消の往復 '+mode,async()=>{
  const h=await fixture(true);
  if(['received-cancel','mail-marker-removed'].includes(mode))await h.job.update({mailIntake:{synthetic:true}});
  if(mode.startsWith('initial-'))await h.job.update({status:mode==='initial-cancel'?'cancelled':mode==='initial-assigned'?'assigned':'stopped',publishable:false,cancelled:mode==='initial-cancel'});
  if(mode==='rollback-disabled')await h.mapping.update({'rowCreation.rollbackOnVerificationFailure':false});
  let preserved,target;
  sheetState={queue:h.queue,caseId:h.id,inserted:false,deletes:0,rollbackReads:0,commitLoss:mode==='commit-response-lost',rollbackMismatch:mode==='rollback-mismatch',rollbackError:mode==='rollback-error',verifyMismatch:['verification-mismatch','rollback-disabled'].includes(mode),afterInsert:async()=>{
   if(mode==='mail-marker-removed'){const current=(await h.job.get()).data();delete current.mailIntake;await h.job.set(current);}
   if(mode==='native-cancel'||mode==='received-cancel')await h.job.update({status:'cancelled',cancelled:true,publishable:false,recruitmentStopped:true});
   if(mode==='assigned')await h.job.update({status:'assigned',assignedStaffId:'synthetic-staff',publishable:false});
   if(mode==='stopped')await h.job.update({status:'stopped',publishable:false,recruitmentStopped:true});
   if(mode==='publication-change')await h.job.update({requestedPublicationMode:'draft',publishable:false});
   if(mode==='deleted-job'){target=h.job;await target.delete();}
   if(['foreign-job','rollback-mismatch','rollback-error'].includes(mode)){target=h.job;await target.update({companyId:'synthetic-other-company'});}
   if(mode==='moved-job'){target=h.job;await target.update({groupId:'synthetic-other-group'});}
   if(mode==='case-change')await h.job.update({caseId:'synthetic-new-case'});
   if(mode==='input-change')await h.job.update({storeName:'synthetic-new-store'});
   if(mode==='deleted-group'){target=h.group;await target.delete();}
   if(mode==='foreign-group'){target=h.group;await target.update({companyId:'synthetic-other-company'});}
   if(mode==='mapping-change'){target=h.mapping;await target.update({spreadsheetId:'synthetic-new-sheet'});}
   if(mode==='deleted-queue'){target=h.queue;await target.delete();}
   if(mode==='queue-attempt'){target=h.queue;await target.update({attempts:99});}
   if(mode==='lock-lost')await h.lock.update({token:'synthetic-new-owner'});
   if(mode==='lock-expired')await h.lock.update({leaseUntil:Timestamp.fromMillis(0)});
   if(target)preserved=(await target.get()).data();
  }};
  await h.event();assert.equal(sheetState.inserted,true);if(target)assert.deepEqual((await target.get()).data(),preserved);
  const job=(await h.job.get()).data(),queue=(await h.queue.get()).data();
  if(mode.startsWith('initial-')){assert.equal(job.status,mode==='initial-cancel'?'cancelled':mode==='initial-assigned'?'assigned':'stopped');assert.equal(job.publishable,false);}
  if(mode==='mail-marker-removed')assert.equal(job.status,'draft');
  if(mode==='native-cancel'||mode==='received-cancel'){assert.equal(job.cancelled,true);assert.equal(job.status,'cancelled');assert.equal(job.publishable,false);assert.equal(job.recruitmentStopped,true);}
  if(mode==='assigned'){assert.equal(job.status,'assigned');assert.equal(job.assignedStaffId,'synthetic-staff');}
  if(mode==='stopped'){assert.equal(job.status,'stopped');assert.equal(job.publishable,false);}
  if(mode==='publication-change'){assert.equal(job.status,'draft');assert.equal(job.publishable,false);}
  if(mode==='case-change')assert.equal(job.caseId,'synthetic-new-case');
  if(mode==='input-change')assert.equal(job.storeName,'synthetic-new-store');
  const manual=['deleted-queue','queue-attempt','lock-lost','lock-expired','rollback-mismatch','rollback-error','rollback-disabled','commit-response-lost'].includes(mode);
  const rollback=['deleted-job','foreign-job','moved-job','case-change','input-change','deleted-group','foreign-group','mapping-change','verification-mismatch'].includes(mode);
  const interventions=await db.collection('sheetRowManualInterventions').where('companyId','==',h.companyId).get();
  assert.equal(interventions.size,manual?1:0);assert.equal(sheetState.deletes,rollback?1:0);
  if(rollback)assert.equal(queue.status,'blocked');
  if(mode==='lock-lost')assert.equal((await h.lock.get()).data().token,'synthetic-new-owner');
  if(mode==='commit-response-lost'){assert.equal(sheetState.commitLossInjected,true);assert.equal(queue.status,'completed');assert.equal(job.sourceReady,true);}
  if(mode==='valid'){assert.equal(queue.status,'completed');assert.equal(job.sourceReady,true);assert.equal(job.status,'open');}
 });
}finally{
 db.runTransaction=originalTransaction;safety.getProductionOperationalState=originalState;google.sheets=originalSheets;
 if(previousMode===undefined)delete process.env.LKC_SHEET_WRITE_MODE;else process.env.LKC_SHEET_WRITE_MODE=previousMode;
 await db.terminate();const stats=network.stats();network.restore();
 const result={project:environment.project,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length+(stats.blocked||sheetsCalls?1:0),network:stats,sheetsCalls,syntheticSheetCalls,firestore:'real SDK / local emulator',sheetsBoundary:'synthetic API responses',realMessages:0,realSheetWrites:0,results};
 fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:result.passed,failed:result.failed,network:stats,sheetsCalls,syntheticSheetCalls}));if(result.failed)process.exitCode=1;
}
