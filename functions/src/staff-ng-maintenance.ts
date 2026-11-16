import {Timestamp} from 'firebase-admin/firestore';
import {db} from './firebase';
import {createHash} from 'node:crypto';
import {assertExecutive} from './case-list-source-core';
type Data=Record<string,any>;
const {assertCapacity,assertJournalCapacity}=require('../src/private-ng/capacity.cjs');
async function fresh(actor:Data){need(typeof actor.beforeCommit==='function','VERIFIED_OWNER_RECHECK_REQUIRED');await actor.beforeCommit();}

const SCHEMA='LK_STAFF_NG_MAINTENANCE_V1';
function need(v:unknown,code:string):asserts v {if(!v)throw Object.assign(Error(code),{code});}
const time=()=>Timestamp.now();
const selected=(company:string)=>{
 const configured=process.env.DEFAULT_COMPANY_ID;
 need(typeof configured==='string'&&configured.length>0,'MAINTENANCE_COMPANY_SCOPE_REQUIRED');
 return company===configured;
};
const reference=(company:string)=>db.collection('staffNgMaintenance').doc(company);
function validate(c:Data|undefined,company:string):asserts c is Data{
 need(c?.schema===SCHEMA&&c.companyId===company&&['OPEN','DRAINING','PAUSED'].includes(c.state)&&Number.isSafeInteger(c.generation)&&c.generation>=0,'MAINTENANCE_STATE_UNKNOWN');
}
function owner(actor:Data,company:string){need(selected(company)&&actor?.uid&&actor.token?.companyId===company,'MAINTENANCE_OWNER_COMPANY_MISMATCH');assertExecutive(actor.token,process.env.EXECUTIVE_APPROVER_EMAILS??'');}
function operation(c:Data|undefined,company:string,binding:Data,allowExpired=false):asserts c is Data {
 validate(c,company);need(c.operationId===binding.operationId&&c.generation===binding.generation&&c.ownerUid===binding.ownerUid,'MAINTENANCE_OPERATION_CHANGED');
 need(c.deadline instanceof Timestamp&&(allowExpired||c.deadline.toMillis()>Date.now()),'MAINTENANCE_EXPIRED');
}
export async function initializeMaintenance(company:string,actor:Data){
 owner(actor,company);const ref=reference(company);
 await db.runTransaction(async(tx:any)=>{const snap=await tx.get(ref);need(!snap.exists,'MAINTENANCE_ALREADY_INITIALIZED');await fresh(actor);tx.create(ref,{schema:SCHEMA,companyId:company,state:'OPEN',generation:0,ngWriteSequence:0,activeImport:null,operationId:null,ownerUid:null,deadline:null,updatedAt:time()});});
}
export async function assertNewApplicationAllowed(tx:any,company:string){
 if(!selected(company))return;
 const c=(await tx.get(reference(company))).data();validate(c,company);need(c.state==='OPEN','NG_MAINTENANCE_APPLICATIONS_PAUSED');
}
export async function readImportAdmission(tx:any,company:string,token:string){
 if(!selected(company))return null;
 const ref=reference(company),c=(await tx.get(ref)).data();validate(c,company);
 need(c.state==='OPEN'&&!c.activeImport,'NG_MAINTENANCE_IMPORT_ADMISSION_PAUSED');
 return {ref,c,token,generation:c.generation};
}
export function registerImport(tx:any,admission:Data|null){
 if(!admission)return;
 assertCapacity({...admission.c,activeImport:{token:admission.token,generation:admission.generation,state:'RUNNING',mutations:0,external:{}}});
 tx.update(admission.ref,{activeImport:{token:admission.token,generation:admission.generation,state:'RUNNING',mutations:0,external:{}},updatedAt:time()});
}
export async function readImportWriteFence(tx:any,company:string,token:string){
 if(!selected(company))return null;
 const ref=reference(company),c=(await tx.get(ref)).data();validate(c,company);
 const active=c.activeImport;
 need(active?.token===token&&active.state==='RUNNING'&&
  ((c.state==='OPEN'&&active.generation===c.generation)||(c.state==='DRAINING'&&active.generation===c.drainGeneration)), 'NG_MAINTENANCE_IMPORT_FENCE_LOST');
 need(!Object.values(active.external??{}).some((e:any)=>e.state==='UNKNOWN'||e.state==='INTENT'),'NG_MAINTENANCE_EXTERNAL_UNRESOLVED');
 return {ref,c,token,generation:active.generation};
}
export function recordImportMutation(tx:any,fence:Data|null,count:number){
 if(fence)tx.update(fence.ref,{'activeImport.mutations':fence.c.activeImport.mutations+count,updatedAt:time()});
}
export async function finishImport(tx:any,company:string,token:string,successful:boolean){
 if(!selected(company))return;
 const ref=reference(company),c=(await tx.get(ref)).data();validate(c,company);need(c.activeImport?.token===token,'MAINTENANCE_IMPORT_OWNERSHIP_CHANGED');
 const entries=Object.values(c.activeImport.external??{}) as Data[],unresolved=entries.some(e=>e.state!=='ACK');
 const cleanAbort=!successful&&c.activeImport.mutations===0&&entries.length===0;
 if((successful&&!unresolved)||cleanAbort)tx.update(ref,{activeImport:null,updatedAt:time()});
 else tx.update(ref,{'activeImport.state':unresolved?'UNKNOWN':'FAILED',updatedAt:time()});
}
export async function beforeSessionRevocation(company:string,token:string,runRef:any,uid:string){
 if(!selected(company))return null;
 const key=createHash('sha256').update(uid).digest('hex');
 await db.runTransaction(async(tx:any)=>{
  const fence=await readImportWriteFence(tx,company,token),run=await tx.get(runRef);
  need(fence&&run.data()?.companyId===company,'MAINTENANCE_RUN_REQUIRED');
  need(!fence.c.activeImport.external[key],'REVOCATION_ALREADY_DISPATCHED');
  const entry={state:'INTENT',generation:fence.generation,startedAt:time()};assertCapacity({...fence.c,activeImport:{...fence.c.activeImport,external:{...fence.c.activeImport.external,[key]:{...entry,state:'UNKNOWN',finishedAt:time()}}}});assertCapacity({...run.data(),ngMaintenanceRevocations:{...run.data()?.ngMaintenanceRevocations,[key]:{...entry,state:'UNKNOWN',finishedAt:time()}}});
  tx.update(fence.ref,{['activeImport.external.'+key]:entry,updatedAt:time()});
  tx.update(runRef,{['ngMaintenanceRevocations.'+key]:entry});
 });
 return key;
}
export async function recordSessionRevocation(company:string,token:string,runRef:any,key:string|null,acked:boolean){
 if(!selected(company))return;
 need(key,'REVOCATION_INTENT_REQUIRED');
 await db.runTransaction(async(tx:any)=>{
  const ref=reference(company),c=(await tx.get(ref)).data(),run=await tx.get(runRef);validate(c,company);
  need(c.activeImport?.token===token&&c.activeImport.external?.[key!]?.state==='INTENT'&&run.data()?.companyId===company,'REVOCATION_INTENT_CHANGED');
  const entry={...c.activeImport.external[key!],state:acked?'ACK':'UNKNOWN',finishedAt:time()};
  tx.update(ref,{['activeImport.external.'+key]:entry,updatedAt:time()});tx.update(runRef,{['ngMaintenanceRevocations.'+key]:entry});
 });
}
async function noPendingAssignments(tx:any,company:string,staffIds:string[]){
 const snap=await tx.get(db.collection('sheetSyncQueue').where('companyId','==',company).where('status','in',['pending','processing','retry_wait']).select('operation','actorStaffId').limit(501));
 need(snap.size<=500,'MAINTENANCE_QUEUE_COVERAGE_UNKNOWN');
 need(!snap.docs.some((d:any)=>{const q=d.data();return ['job.assign','case_list.assign'].includes(q.operation)&&(!q.actorStaffId||staffIds.includes(q.actorStaffId));}),'MAINTENANCE_ASSIGNMENT_QUEUE_UNSETTLED');
}
export async function beginDrain(company:string,actor:Data,input:Data){
 owner(actor,company);need(typeof input.operationId==='string'&&/^[A-Za-z0-9_-]{8,120}$/.test(input.operationId)&&Array.isArray(input.staffIds)&&input.staffIds.length>0&&input.staffIds.length<=10&&new Set(input.staffIds).size===input.staffIds.length&&input.staffIds.every((id:any)=>typeof id==='string'&&!id.includes('/'))&&Number.isSafeInteger(input.expiresAt)&&input.expiresAt>Date.now(),'EXACT_MAINTENANCE_SCOPE_REQUIRED');
 return db.runTransaction(async(tx:any)=>{const ref=reference(company),c=(await tx.get(ref)).data();validate(c,company);need(c.state==='OPEN','MAINTENANCE_ALREADY_ACTIVE');
  const next={startNgWriteSequence:c.ngWriteSequence,state:'DRAINING',generation:c.generation+1,drainGeneration:c.generation,operationId:input.operationId,ownerUid:actor.uid,staffIds:input.staffIds,deadline:Timestamp.fromMillis(input.expiresAt),updatedAt:time()};assertCapacity({...c,...next},4096);await fresh(actor);tx.update(ref,next);return {operationId:next.operationId,generation:next.generation,ownerUid:actor.uid};});
}
export async function pauseWhenDrained(company:string,actor:Data,binding:Data){
 owner(actor,company);need(actor.uid===binding.ownerUid,'MAINTENANCE_OWNER_CHANGED');
 await db.runTransaction(async(tx:any)=>{const ref=reference(company),c=(await tx.get(ref)).data();operation(c,company,binding);need(c.state==='DRAINING'&&!c.activeImport,'MAINTENANCE_IMPORT_NOT_DRAINED');
  const lock=await tx.get(db.collection('syncLocks').doc(company+'_staff_import'));
  need(!lock.exists,'MAINTENANCE_RESIDUAL_IMPORT_LOCK');await noPendingAssignments(tx,company,c.staffIds);
  await fresh(actor);tx.update(ref,{state:'PAUSED',updatedAt:time()});});
}
export async function assertPausedTransaction(tx:any,company:string,binding:Data){
 need(selected(company),'MAINTENANCE_COMPANY_SCOPE_MISMATCH');
 const ref=reference(company),c=(await tx.get(ref)).data();operation(c,company,binding);
 need(c.state==='PAUSED'&&!c.activeImport&&binding.staffIds?.every((id:string)=>c.staffIds.includes(id)),'MAINTENANCE_NOT_PAUSED_FOR_TARGETS');return c;
}
export async function readPausedEnvironment(company:string,binding:Data){
 return db.runTransaction(async(tx:any)=>{const c=await assertPausedTransaction(tx,company,binding);return {ownerEnabled:true,applicationsStopped:true,legacyWritersFenced:true,companyId:company,scopeRevision:c.operationId+':'+c.generation};},{readOnly:true});
}
export async function readPausedWriteFence(company:string,binding:Data){
 need(selected(company),'MAINTENANCE_COMPANY_SCOPE_MISMATCH');
 const ref=reference(company),snapshot=await ref.get(),c=snapshot.data();operation(c,company,binding);
 need(c.state==='PAUSED'&&!c.activeImport&&binding.staffIds?.every((id:string)=>c.staffIds.includes(id))&&Number.isSafeInteger(c.ngWriteSequence),'MAINTENANCE_NOT_PAUSED_FOR_TARGETS');
 return {ref,updateTime:snapshot.updateTime,sequence:c.ngWriteSequence};
}
export async function resumeMaintenance(company:string,actor:Data,binding:Data,journalRef:any,recordId:string){
 owner(actor,company);need(actor.uid===binding.ownerUid&&journalRef?.firestore===db,'MAINTENANCE_OWNER_OR_JOURNAL_CHANGED');
 await db.runTransaction(async(tx:any)=>{const ref=reference(company),c=(await tx.get(ref)).data();operation(c,company,binding);
  const journal=(await tx.get(journalRef)).data(),r=journal?.records?.[recordId];
  need(c.state==='PAUSED'&&!c.activeImport&&journal?.schema==='LKC_NG_JOURNAL_V1'&&r?.maintenanceBinding?.operationId===c.operationId&&r.maintenanceBinding.generation===c.generation&&r.maintenanceBinding.ownerUid===actor.uid,'MAINTENANCE_JOURNAL_BINDING_REQUIRED');
  const records=Object.values(journal.records) as Data[];
  const operationRecords=records.filter(x=>x.maintenanceBinding?.operationId===c.operationId&&x.maintenanceBinding.generation===c.generation);
  need(operationRecords.length>0&&operationRecords.every(x=>x.maintenanceBinding.ownerUid===actor.uid&&['COMPLETE','ROLLED_BACK'].includes(x.status)&&x.members.every((m:any)=>['APPLIED','NOOP','ROLLED_BACK'].includes(m.state))),'MAINTENANCE_NG_RESULT_UNRESOLVED');
  const covered=[...new Set(operationRecords.flatMap(x=>x.members.map((m:any)=>m.plan.target.id)))].sort();
  need(JSON.stringify(covered)===JSON.stringify([...c.staffIds].sort()),'MAINTENANCE_TARGET_COVERAGE_INCOMPLETE');
  await noPendingAssignments(tx,company,c.staffIds);
  for(const record of operationRecords){for(const member of record.members){need(journal.locks[member.key]===record.id,'MAINTENANCE_JOURNAL_LOCK_CHANGED');delete journal.locks[member.key];}record.completionStatus=record.status;record.status='CLOSED';}
  assertJournalCapacity(journal);assertCapacity(c,4096);await fresh(actor);tx.update(journalRef,{records:journal.records,locks:journal.locks});
  tx.update(ref,{state:'OPEN',operationId:null,ownerUid:null,deadline:null,staffIds:[],lastOperation:{operationId:c.operationId,generation:c.generation,status:r.status},updatedAt:time()});
 });
}
// Capacity preflight happens before the first business-directory batch is queued.
export async function ensureImportCapacity(company:string,token:string,runId:string,uids:string[]){
 if(!selected(company))return;
 const ref=reference(company),runRef=db.collection('staffImportRuns').doc(runId);
 await db.runTransaction(async(tx:any)=>{const fence=await readImportWriteFence(tx,company,token),run=await tx.get(runRef);need(fence&&run.data()?.companyId===company,'MAINTENANCE_RUN_REQUIRED');
 const external:Data={...fence.c.activeImport.external};for(const uid of new Set(uids)){need(typeof uid==='string'&&uid.length<=200,'REVOCATION_UID_SCOPE_UNKNOWN');external[createHash('sha256').update(uid).digest('hex')]={state:'UNKNOWN',generation:fence.generation,startedAt:time(),finishedAt:time()};}
 assertCapacity({...fence.c,activeImport:{...fence.c.activeImport,mutations:Number.MAX_SAFE_INTEGER,external}});assertCapacity({...run.data(),ngMaintenanceRevocations:external},65536);
 },{readOnly:true});
}
// No TTL release and no inference from matching NG values. Only undispatched work.
export async function abortUnchangedMaintenance(company:string,actor:Data,binding:Data,journalRef:any){
 owner(actor,company);need(actor.uid===binding.ownerUid&&journalRef?.firestore===db,'MAINTENANCE_OWNER_OR_JOURNAL_CHANGED');
 await db.runTransaction(async(tx:any)=>{const ref=reference(company),c=(await tx.get(ref)).data();operation(c,company,binding);
 need(['DRAINING','PAUSED'].includes(c.state)&&!c.activeImport&&c.ngWriteSequence===c.startNgWriteSequence,'MAINTENANCE_ABORT_CHANGED_OR_ACTIVE');
 const lease=await tx.get(db.collection('syncLocks').doc(company+'_staff_import')),journal=(await tx.get(journalRef)).data();need(!lease.exists&&journal?.schema==='LKC_NG_JOURNAL_V1','MAINTENANCE_ABORT_LEASE_OR_JOURNAL_UNKNOWN');
 const records=(Object.values(journal.records) as Data[]).filter(r=>r.maintenanceBinding?.operationId===c.operationId&&r.maintenanceBinding.generation===c.generation);
 need(records.every(r=>r.maintenanceBinding.ownerUid===actor.uid&&r.status==='APPROVED'&&r.members.every((x:any)=>['UNTOUCHED','NOOP'].includes(x.state))),'MAINTENANCE_ABORT_DISPATCHED_OR_UNKNOWN');
 for(const record of records)for(const member of record.members){need(member.plan.target.companyId===company&&c.staffIds.includes(member.plan.target.id)&&journal.locks[member.key]===record.id,'MAINTENANCE_ABORT_SCOPE_CHANGED');const current=await tx.get(db.collection('staffProfiles').doc(member.plan.target.id));need(current.exists&&current.data()?.companyId===company&&current.updateTime.seconds===member.version.seconds&&current.updateTime.nanoseconds===member.version.nanoseconds,'MAINTENANCE_ABORT_PROFILE_CHANGED');}
 await noPendingAssignments(tx,company,c.staffIds);
 for(const record of records){record.status='ABORTED';for(const member of record.members)delete journal.locks[member.key];}
 assertJournalCapacity(journal);await fresh(actor);tx.update(journalRef,{records:journal.records,locks:journal.locks});tx.update(ref,{state:'OPEN',operationId:null,ownerUid:null,deadline:null,staffIds:[],lastOperation:{operationId:c.operationId,generation:c.generation,status:'ABORTED_UNCHANGED'},updatedAt:time()});
 });
}
