const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {stripTypeScriptTypes}=require('node:module');
const clone=value=>value instanceof Timestamp?value:Array.isArray(value)?value.map(clone):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clone(v)])):value;
class Timestamp{constructor(ms){this.ms=ms;}static now(){return new Timestamp(Date.parse('2026-10-27T00:00:00Z'));}static fromMillis(ms){return new Timestamp(ms);}toMillis(){return this.ms;}toDate(){return new Date(this.ms);}}
class HttpsError extends Error{constructor(code,message,details){super(message);this.code=code;this.details=details;}}
const chain=new Proxy({parse:x=>x},{get:(o,k)=>k in o?o[k]:(...args)=>chain});
function setup(caseList=true){
 const records=new Map(),commits=[];let serial=0,sourceReads=0,sourceChanged=false;
 const ref=(collection,id=String(++serial).padStart(8,'0'))=>({id,path:collection+'/'+id});
 const snap=r=>({ref:r,id:r.id,exists:records.has(r.path),data:()=>clone(records.get(r.path))});
 const db={collection:c=>({doc:id=>ref(c,id)}),runTransaction:async callback=>{
  for(let attempt=0;attempt<8;attempt++){
   const reads=new Map(),writes=[];
   const tx={get:async r=>{assert.equal(writes.length,0,'read after write');reads.set(r.path,JSON.stringify(records.get(r.path)));return snap(r);},set:(r,data,options)=>writes.push({r,data:clone(data),merge:options?.merge}),update:(r,data)=>writes.push({r,data:clone(data),merge:true})};
   const result=await callback(tx);
   if([...reads].some(([key,old])=>JSON.stringify(records.get(key))!==old))continue;
   for(const w of writes)records.set(w.r.path,w.merge?{...records.get(w.r.path),...w.data}:w.data);
   commits.push(writes);return result;
  }throw Error('contention');
 }};
 const source={version:1,spreadsheetId:'synthetic-book',sheetId:2026101601,caseId:'LKCASE_00000000-0000-5000-8000-000000000001',sourceRevision:'a'.repeat(64),rowRevision:'b'.repeat(64),ledgerRevision:'c'.repeat(64)};
 const jobId='job_synthetic',companyId='synthetic-company',staffId='staff-1';
 const modules={
  'firebase-functions/v2/https':{onCall:(...a)=>a.at(-1),HttpsError},'firebase-admin/firestore':{Timestamp,FieldValue:{}},zod:{z:chain},'./firebase':{db},
  './utils':{requireAuth:r=>{if(!r.auth)throw new HttpsError('unauthenticated','auth');return r.auth;},companyFromClaims:t=>t.companyId,staffFromClaims:t=>t.staffId,dateKeyFromIso:x=>x},
  './notification-core':{queueDocumentData:x=>x},'./notification-time':{tokyoParts:()=>({dateKey:'2026-10-27'})},'./sheet-write-core':{cancellationSheetWriteIdentity:j=>j.caseId+':'+j.assignedStaffId},
  './assignment-preparation-core':{nextAssignmentRevision:j=>j.revision+1,assignmentPreparationPatch:()=>({}),applicationConfirmationIdentity:()=>'',mailPreparationContext:()=>''},
  './system-safety':{assertProductionOperational:async()=>{}},'./automation-intake':{readMailApplicationForAssignment:async()=>null},'./case-mail-publication':{readMailPublication:async()=>{throw Error('wrong source path');}},
  './cancellation-history-retention-core':{assertAcknowledgedCancellationCanChange:()=>{}},
  './case-list-source':{readCaseListPublication:async(tx,company,id,job,revision,hash)=>{sourceReads++;if(sourceChanged||revision!==job.revision||hash!==source.sourceRevision)throw new HttpsError('failed-precondition','source changed');return {source,preMonthlyContentHash:'d'.repeat(64),candidate:{},approval:{}};}},
 };
 const filename=path.join(__dirname,'../../functions/src/jobs.ts');
 let code=stripTypeScriptTypes(fs.readFileSync(filename,'utf8'),{mode:'transform'});
 code=code.replace(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)";/g,(_,bindings,name)=>`const {${bindings}}=require(${JSON.stringify(name)});`).replace(/^export /gm,'');
 const context={require:n=>{if(!modules[n])throw Error('unexpected module '+n);return modules[n];},module:{exports:{}},Date,console};
 vm.runInNewContext(code+'\nmodule.exports={applyToJob};',context,{filename});
 records.set('jobs/'+jobId,{companyId,caseId:source.caseId,dateKey:'2026-11-20',workDate:'2026-11-20',storeName:'合成店舗',revision:3,status:'open',publishable:true,sourceReady:true,...(caseList?{caseListSource:source}:{})});
 records.set('staffProfiles/'+staffId,{companyId,active:true,displayName:'合成スタッフ1'});records.set('staffProfiles/staff-2',{companyId,active:true,displayName:'合成スタッフ2'});
 const command={jobId,requestId:'synthetic-request-1',expectedJobRevision:3,...(caseList?{expectedSourceRevision:source.sourceRevision}:{})};
 const auth={uid:'user-1',token:{companyId,staffId,role:'staff'}};
 return {records,commits,command,auth,source,jobId,companyId,staffId,sourceReads:()=>sourceReads,changeSource:()=>{sourceChanged=true;},apply:(data=command,user=auth)=>context.module.exports.applyToJob({data,auth:user}),queues:()=>[...records].filter(([k])=>k.startsWith('sheetSyncQueue/')).map(([key,data])=>({key,...data})),job:()=>records.get('jobs/'+jobId)};
}
const results=[];async function test(name,fn){await fn();results.push({name,passed:true});}
(async()=>{
await test('actual callable creates typed CaseList queue and keeps unconfirmed until native ACK',async()=>{const h=setup();await h.apply();const q=h.queues()[0];assert.equal(q.operation,'case_list.assign');assert.equal(q.caseListAssignment.sourceRevision,h.source.sourceRevision);assert.equal(q.caseListAssignment.sourceRowRevision,h.source.rowRevision);assert.equal(q.caseListAssignment.sourceLedgerRevision,h.source.ledgerRevision);assert.equal(q.caseListAssignment.assignedJobRevision,4);assert.equal(q.caseListAssignment.sourceCaseId,h.source.caseId);assert.equal(q.caseListAssignment.staffId,h.staffId);assert.equal(h.job().applicationUnconfirmed,true);assert.equal(h.job().assignmentSheetWrite.operation,'case_list.assign');});
await test('same request replays saved result before liveSource GET after manualedit',async()=>{const h=setup(),a=await h.apply();h.changeSource();const reads=h.sourceReads(),b=await h.apply();assert.deepEqual(a,b);assert.equal(h.sourceReads(),reads);assert.equal(h.queues().length,1);});
await test('request reused with changedSourceHash rejects before another queue',async()=>{const h=setup();await h.apply();await assert.rejects(()=>h.apply({...h.command,expectedSourceRevision:'d'.repeat(64)}));assert.equal(h.queues().length,1);});
await test('new application rejects stale live source with zero assignment writes',async()=>{const h=setup();h.changeSource();await assert.rejects(()=>h.apply());assert.equal(h.queues().length,0);assert.equal(h.job().status,'open');});
await test('known precommit source rejection has exact safe retry identity',async()=>{const h=setup();h.changeSource();await assert.rejects(()=>h.apply(),e=>e.details?.accepted===false&&e.details.reason==='case_list_job_changed'&&e.details.jobId===h.jobId&&e.details.requestId===h.command.requestId&&e.details.expectedSourceRevision===h.source.sourceRevision);assert.equal(h.queues().length,0);});
await test('two concurrent staff exact snapshot produce one winner',async()=>{const h=setup(),auth={uid:'user-2',token:{...h.auth.token,staffId:'staff-2'}};const r=await Promise.allSettled([h.apply(),h.apply({...h.command,requestId:'synthetic-request-2'},auth)]);assert.equal(r.filter(r=>r.status==='fulfilled').length,1);assert.equal(h.queues().length,1);});
await test('existing same day lock rejects another assignment',async()=>{const h=setup();h.records.set(`staffDayLocks/${h.companyId}_${h.staffId}_2026-11-20`,{active:true,jobId:'other'});await assert.rejects(()=>h.apply());assert.equal(h.queues().length,0);});
await test('ambiguous dayLock active flag is held for CaseList',async()=>{const h=setup();h.records.set(`staffDayLocks/${h.companyId}_${h.staffId}_2026-11-20`,{active:'false',jobId:'other'});await assert.rejects(()=>h.apply());});
await test('auth principal defeats forged body staff identity',async()=>{const h=setup();await h.apply({...h.command,staffId:'staff-2',companyId:'other'});assert.equal(h.queues()[0].caseListAssignment.staffId,'staff-1');});
await test('company boundary rejects',async()=>{const h=setup();h.records.get('staffProfiles/staff-1').companyId='other';await assert.rejects(()=>h.apply());});
await test('disabled staff rejects',async()=>{const h=setup();h.records.get('staffProfiles/staff-1').active=false;await assert.rejects(()=>h.apply());});
await test('legacy monthly apply preserves existing queue contract and avoids newSource GET',async()=>{const h=setup(false);await h.apply();assert.equal(h.queues()[0].operation,'job.assign');assert.equal(h.queues()[0].caseListAssignment,undefined);assert.equal(h.sourceReads(),0);});
console.log(JSON.stringify({status:'PASS',tests:results.length,results},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
