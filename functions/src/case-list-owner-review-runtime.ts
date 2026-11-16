/** Existing Firebase callable and existing private stores; no deployment or
 * permission is created by composing this factory. */
import { db } from './firebase';
import { createJobIdFromPersistedCaseId } from './case-id';
import * as worker from './case-list-monthly-worker';
import * as external from './case-list-external-transfer';
import { getProductionOperationalState } from './system-safety';
type Data=Record<string,any>;
const {createFormalTicketService}=require('../src/case-list-gas-formal-ticket.cjs');
const {createReviewStorePort}=require('../src/case-list-manual-review-store.cjs');
const core=require('../src/case-list-external-core.cjs');
function need(x:unknown,c:string):asserts x{if(!x)throw Object.assign(Error(c),{code:c});}
export function createOwnerReviewService(auth:Data,ports:Data={}){
 const database=ports.db??db,now=ports.now??(()=>Date.now());
 const store=ports.store??createReviewStorePort({isolatedProposal:true,runTransaction:(fn:any,options?:Data)=>database.runTransaction(fn,options),reviewRef:(id:string)=>database.collection('lkcSyntheticReviewViewsV1').doc(id),guardRef:(id:string)=>database.collection('lkcSyntheticReviewCaseGuardsV1').doc(id),now,viewMaxAgeMs:180000});
 const formal=createFormalTicketService({auth,store,now,ownerAuthorization:true,
  operational:ports.operational??(async(companyId:string)=>(await getProductionOperationalState(companyId)).operational),
  readManualRefs:ports.readRefs??(async(selection:Data[],actor:Data)=>{
   const refs=[];
   for(const selected of selection){
    const jobId=createJobIdFromPersistedCaseId(actor.companyId,selected.id),job=(await database.collection('jobs').doc(jobId).get()).data();
    need(job?.companyId===actor.companyId&&job.caseId===selected.id&&job.dateKey===selected.date,'FORMAL_JOB_CHANGED');
    const queueId=job.assignmentSheetWrite?.queueId;
    if(queueId){
     const original=await external.readExternalOriginalForGasHandoff(database.collection('sheetSyncQueue').doc(queueId),actor.uid,actor);
     need(core.assertOriginal(original,queueId)==='CREW_APPLICATION'&&original.jobId===jobId,'OWNER_REVIEW_QUEUE_CHANGED');
     refs.push({jobId,queueId,expectedJobRevision:job.revision,expectedSourceRevision:core.sourceCatalog(original).sourceRevision});
    }else{
     const observed=(await database.collection('caseListManualObservations').doc(jobId).get()).data();
     need(observed?.companyId===actor.companyId&&observed.caseId===selected.id,'FORMAL_OBSERVATION_REQUIRED');
     refs.push({jobId,observationHash:observed.observationHash,expectedJobRevision:job.revision,expectedSourceRevision:job.caseListSource.sourceRevision});
    }
   }
   return refs;
  }),
  readUnconfirmed:ports.readUnconfirmed??((actor:Data,input:Data,check:()=>Promise<void>)=>worker.readCaseListOwnerNameUpReviewForHandoff(actor.companyId,actor.uid,actor,input,check)),
  prepareConfirmed:ports.prepareConfirmed??((actor:Data,input:Data,check:()=>Promise<void>)=>worker.prepareCaseListOwnerNameUpReviewForHandoff(actor.companyId,actor.uid,actor,input,check))
 });
 return {formal,store};
}
