import { createHash } from 'node:crypto';
import { db } from './firebase';
import { createJobIdFromPersistedCaseId } from './case-id';
import { hashCaseList } from './case-list-source-core';
import { getProductionOperationalState } from './system-safety';
import { assertExternalIntakeEnabled,assertExternalAcceptanceEnabled } from './case-list-external-mode';
import * as worker from './case-list-monthly-worker';
import * as external from './case-list-external-transfer';
import { createGasReadPorts,type ReadPorts } from './case-list-gas-read-ports';
type Data=Record<string,any>;
const core=require('../src/case-list-external-core.cjs') as {assertOriginal(r:Data,q:string):string;originalIdentity(r:Data):Data;sourceCatalog(r:Data):Data};
const authority=require('../src/case-list-gas-handoff-core.cjs') as {withFreshPrincipal(s:Data,bearer:string,fn:(actor:Data,fresh:()=>void)=>Promise<any>):Promise<any>;hash(x:unknown):string;validateContinuation(record:Data,binding:Data,actor:Data,now:number):Data;createHandoff(s:Data):{handle(bearer:string,input:Data):Promise<Data>}};
function need(x:unknown,c:string):asserts x{if(!x)throw Object.assign(Error(c),{code:c});}
const clone=(x:Data):Data=>JSON.parse(JSON.stringify(x));
const observed=require("../src/case-list-assignment-observation.cjs") as {observeRow(row:Data,width:number):unknown[]};
const monthFinancialColumns=[...Array.from({length:26},(_,i)=>i+18),...Array.from({length:7},(_,i)=>i+47)];
const monthWritable=(cell:Data)=>Object.fromEntries(["userEnteredValue","note","userEnteredFormat","dataValidation","textFormatRuns","chipRuns"]
 .filter(key=>Object.hasOwn(cell,key)).map(key=>[key,cell[key]]));
function verifyMonthlyReadbackBeforeArchive(selection:Data,binding:Data,snapshot:Data,now:number) {
 const plan=selection.gasPreview,observedAt=Date.parse(snapshot?.observedAt),monthTitle=binding.dateKey.slice(0,4)+"."+Number(binding.dateKey.slice(5,7));
 const hold="HANDOFF_MONTH_ARCHIVE_UNVERIFIED";
 need(selection.selectionHash===binding.selectionHash&&snapshot.isolated===false&&snapshot.spreadsheetId===binding.gas.book&&
  Number.isFinite(observedAt)&&observedAt>=binding.selectedAt&&observedAt<=now&&now-observedAt<=60_000,hold);
 const months=snapshot.months,coverage=snapshot.coverage?.months;
 need(Array.isArray(months)&&Array.isArray(coverage)&&months.length===coverage.length&&
  new Set(months.map(month=>month.sheetId)).size===months.length&&months.every(month=>
   Array.isArray(month.rows)&&month.rows.length===month.rowCount-1&&coverage.some(index=>index.sheetId===month.sheetId&&
    index.rowCount===month.rowCount&&index.columnCount===month.columnCount&&index.indexReadComplete===true&&index.headersComplete===true)),hold);
 const matches=months.flatMap(month=>month.rows.filter((row:Data)=>typeof row.fixedId==="string"&&
  row.fixedId.toLowerCase()===binding.caseId.toLowerCase()).map((row:Data)=>({month,row})));
 const match=matches[0],target=snapshot.selectedRows?.destinations;
 need(matches.length===1&&target?.length===1&&match.row.fixedId===binding.caseId&&match.row.row>=2&&
  match.month.sheetId===binding.gas.sheetId&&match.month.title===monthTitle&&match.month.columnCount===plan.width&&
  target[0].sheetId===binding.gas.sheetId&&target[0].row===match.row.row,hold);
 const values=observed.observeRow(match.row,plan.width);
 // Compare the same immutable writable fields and observed financial values as reconciliation.
 // Application-date and material defaults are checked by GAS and final reconciliation.
 for(let i=0;i<54;i++)if(i!==8&&i!==17){
  need(hashCaseList(monthWritable(match.row.cells[i]))===hashCaseList(selection.expectedMapped.business[i]),hold);
 }
 need(hashCaseList(monthFinancialColumns.map(index=>values[index]))===hashCaseList(selection.expectedFees),hold);
}
export type CrewPortsConfig={auth:Data;authorization:string;reads:ReadPorts;readFormal(caseId:string,actor:Data,reference?:Data):Promise<Data|null>;now():number};
export function createCrewSyncPorts(c:CrewPortsConfig){
 const reads=createGasReadPorts(c.reads),qref=(q:string)=>db.collection('sheetSyncQueue').doc(q),opref=(company:string,q:string)=>db.collection('caseListMonthlyOperations').doc(createHash('sha256').update(company+'|'+q).digest('hex'));
 async function fresh(actor:Data){await authority.withFreshPrincipal(c.auth,c.authorization,async current=>{need(current.uid===actor.uid&&current.companyId===actor.companyId,'CURRENT_OWNER_CHANGED');need((await getProductionOperationalState(actor.companyId)).operational,'GLOBAL_STOPPED');});}
 async function original(q:string,actor:Data,own?:string){const r=await external.readExternalOriginalForGasHandoff(qref(q),actor.uid,actor,own);core.assertOriginal(r,q);return r;}
 const eligible=(r:Data)=>({queueId:r.queueId,companyId:r.job.companyId,jobId:r.jobId,caseId:r.job.caseId,dateKey:r.job.dateKey,staffId:r.job.assignedStaffId,staffName:r.job.assignedStaffName,client:r.job.clientName,store:r.job.storeName,originalIdentity:core.originalIdentity(r),a1Verified:true});
 async function currentBoundary(r:Data,actor:Data,stage:string,ids:string[],ownLease?:string){
  await fresh(actor);if(stage==='BEFORE_ACCEPTANCE')assertExternalAcceptanceEnabled();else assertExternalIntakeEnabled();
  for(const id of ids){const i=r.items.find((x:Data)=>x.caseId===id);need(i,'HANDOFF_ITEM_REQUIRED');const e=i.eligible,j=(await db.collection('jobs').doc(e.jobId).get()).data(),q=(await qref(i.queueId).get()).data();
   if(!q){
    need(stage!=='BEFORE_SOURCE_ARCHIVE','PROTECTED_RECORD_REQUIRED');
    const p=e.manualPreparation,f=await c.readFormal(id,actor,r.formalReference),o=(await db.collection('caseListManualObservations').doc(e.jobId).get()).data(),staff=(await db.collection('staffProfiles').doc(e.staffId).get()).data();
    need(e.manualPrepared===true&&f&&f.actorUid===actor.uid&&f.companyId===actor.companyId&&authority.hash(f.input)===e.manualInputHash,'FORMAL_MANUAL_REVIEW_CHANGED');
    need(hashCaseList(j)===p.currentJobHash&&hashCaseList(o)===p.currentObservationHash&&staff?.active===true&&staff.companyId===actor.companyId&&staff.displayName===p.canonicalStaffName,'MANUAL_PREPARATION_CHANGED');
    await reads.assertSource(actor as any,id,p);
   }else{
    const o=await original(i.queueId,actor,ownLease);need(authority.hash(core.originalIdentity(o))===authority.hash(e.originalIdentity),'ORIGINAL_MUTATED');
    if(o.queue.caseListAssignment?.origin==='SOURCE_MANUAL')need(o.operation.ownerTransferSelection?.selectedBy===actor.uid&&o.operation.manualConditions?.actorUid===actor.uid,'MANUAL_OWNER_CHANGED');
    if(stage!=='BEFORE_ACCEPTANCE'){
     const snapshot=await reads.assertSource(actor as any,id,{sourceSnapshot:o.originalSourceRecord.payload.sourceSnapshot??o.originalSourceRecord.payload.expectedSourceAfter,dependencyHash:o.originalSourceRecord.payload.dependencyHash,sourceRevision:core.sourceCatalog(o).sourceRevision});
     if(stage==='BEFORE_SOURCE_ARCHIVE'){
      const binding=await external.readExternalCaseListSelectionBinding(qref(i.queueId),actor.uid,actor);
      try {verifyMonthlyReadbackBeforeArchive(o.externalSelection,binding,snapshot,c.now());}
      catch {need(false,'HANDOFF_MONTH_ARCHIVE_UNVERIFIED');}
     }
    }
   }
  }await fresh(actor);need(c.now()<r.deadlineAt,'ORIGINAL_PREPARATION_EXPIRED');return true;
 }
 async function commitGuard(i:Data,r:Data,check:()=>Promise<void>,kind:string,uid:string,token:Data,records?:Data){
  await check();await fresh(token);const sent=await reads.observeMail(i,r,token as any);need(sent.state==='SENT_VERIFIED'&&uid===token.uid,'CURRENT_SENT_REQUIRED');
  await currentBoundary(r,token,kind==='ACCEPT_EXTERNAL'?'BEFORE_ACCEPTANCE':'BEFORE_A2_COMMIT',[i.caseId],records?.lease?.tokenId);await check();
 }
 return {
  readEligible:async(selection:Data[],actor:Data,reference?:Data)=>{assertExternalIntakeEnabled();const out=[];
   for(const selected of selection){const jobId=createJobIdFromPersistedCaseId(actor.companyId,selected.id),job=(await db.collection('jobs').doc(jobId).get()).data();need(job&&job.caseId===selected.id&&job.dateKey===selected.date,'JOB_DATE_CHANGED');
    if(job!.assignmentSheetWrite?.queueId){const r=await original(job!.assignmentSheetWrite.queueId,actor);await reads.assertSource(actor as any,selected.id,{sourceSnapshot:r.originalSourceRecord.payload.sourceSnapshot??r.originalSourceRecord.payload.expectedSourceAfter,dependencyHash:r.originalSourceRecord.payload.dependencyHash,sourceRevision:core.sourceCatalog(r).sourceRevision});out.push(eligible(r));}
    else{const formal=await c.readFormal(selected.id,actor,reference);need(formal&&formal.actorUid===actor.uid&&formal.companyId===actor.companyId&&formal.input?.clientNameUpConfirmed===false,'MANUAL_FORMAL_APPROVAL_REQUIRED');
     const p=await worker.prepareCaseListManualForHandoff(actor.companyId,actor.uid,actor,formal!.input,()=>fresh(actor));out.push({queueId:p.prospectiveQueueId,companyId:p.companyId,jobId:p.jobId,caseId:p.caseId,dateKey:p.dateKey,staffId:p.staffId,staffName:p.staffName,client:job!.clientName,store:job!.storeName,manualPrepared:true,a1Verified:false,manualPreparation:p,manualInput:formal!.input,manualInputHash:authority.hash(formal!.input)});
    }
   }await fresh(actor);return out;
  },
  observeMail:reads.observeMail,currentBoundary,
  protectSelection:async(i:Data,r:Data,actor:Data,check:()=>Promise<void>)=>{
   if(i.eligible.manualPrepared===true){const out=await worker.registerCaseListManualForHandoff(actor.companyId,actor.uid,actor,{...i.eligible.manualInput,clientNameUpConfirmed:true},()=>commitGuard(i,r,check,'MANUAL_A1',actor.uid,actor));need(out.queueId===i.queueId,'MANUAL_QUEUE_CHANGED');}
   const before=await original(i.queueId,actor),guarded=clone(r);guarded.items.find((x:Data)=>x.caseId===i.caseId).eligible=eligible(before);
   if(!before.externalSelection)await external.selectExternalCaseListMonthlyTransferForHandoff(qref(i.queueId),actor.uid,actor,{clientNameUpConfirmed:true,reviewKey:before.queue.caseListPhase.continuationHash},(...args:any[])=>commitGuard(i,guarded,check,args[0],args[1],args[2],args[3]));
   return {binding:await external.readExternalCaseListSelectionBinding(qref(i.queueId),actor.uid,actor),eligible:eligible(before)};
  },
  persistContinuation:async(i:Data,r:Data,actor:Data,check:()=>Promise<void>)=>{
   const b=i.binding,sent=await reads.observeMail(i,r,actor as any),body={schema:'LK_GAS_CREW_HANDOFF_GATE_V1',queueId:b.queueId,companyId:b.companyId,jobId:b.jobId,caseId:b.caseId,staffId:b.staffId,dateKey:b.dateKey,sourceRevision:b.sourceRevision,selectionHash:b.selectionHash,actorUid:actor.uid,nameUpExpected:b.gas.nameUpExpected,groupDigest:sent.digest,messageId:sent.messageId,firstPreparedAt:r.firstPreparedAt,deadlineAt:r.deadlineAt,phase:'SENT_VERIFIED',sentVerifiedAt:c.now()};
   await db.runTransaction(async tx=>{const ref=opref(actor.companyId,i.queueId),op=(await tx.get(ref)).data();need(op&&op.externalSelection?.selectionHash===b.selectionHash&&op.externalSelection.selectedBy===actor.uid,'CONTINUATION_CHANGED');if(op.gasHandoff){const old=authority.validateContinuation(op.gasHandoff,b,actor,c.now());need(old.firstPreparedAt===r.firstPreparedAt&&old.deadlineAt===r.deadlineAt,'DEADLINE_REFRESH_FORBIDDEN');need(old.messageId===sent.messageId&&old.groupDigest===sent.digest,'CONTINUATION_SENT_CHANGED');return;}await commitGuard(i,r,check,'CONTINUATION',actor.uid,actor);tx.set(ref,{gasHandoff:{...body,hash:authority.hash(body)}},{merge:true});});
  },
  checkProtected:async(i:Data,r:Data,actor:Data)=>{
   const api=authority.createHandoff({...c.auth,config:{...c.auth.config,allowOriginalReadback:true},operational:async()=> (await getProductionOperationalState(actor.companyId)).operational,
    readOriginalGateSnapshot:async(queue:string,current:Data)=>{const snapshot=await external.readExternalCaseListHandoffGateSnapshot(qref(queue),current.uid,current);need(snapshot.binding.selectionHash===i.binding.selectionHash&&snapshot.continuation?.firstPreparedAt===r.firstPreparedAt&&snapshot.continuation?.deadlineAt===r.deadlineAt,'PROTECTED_RECORD_CHANGED');return snapshot;},
    verifySentEvidence:async()=>{const sent=await reads.observeMail(i,r,actor as any);return {verified:sent.state==='SENT_VERIFIED',messageId:sent.messageId,groupDigest:sent.digest};}
   });
   return api.handle(c.authorization,{protocol:'LK_GAS_CREW_HANDOFF_V1',action:'CHECK_ORIGINAL',requestId:'gas_check_'+i.caseId.slice(-12),queueId:i.queueId,caseId:i.caseId,selectionHash:i.binding.selectionHash,nameUpExpected:i.binding.gas.nameUpExpected});
  },
  reconcile:async(i:Data,r:Data,actor:Data,check:()=>Promise<void>)=>external.reconcileExternalCaseListMonthlyTransferForHandoff(qref(i.queueId),actor.uid,actor,(...args:any[])=>commitGuard(i,r,check,args[0],args[1],args[2],args[3])),
  observeAccepted:async(i:Data,_r:Data,actor:Data)=>external.observeCompletedExternalCaseListTransfer(qref(i.queueId),actor.uid,actor)
 };
}
