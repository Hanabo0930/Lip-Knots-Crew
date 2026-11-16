import { db } from './firebase';
import { gasHandoffSettings } from './case-list-gas-handoff';
import { createFirebaseOwnerAuthContext } from './case-list-owner-context';
import { createOwnerReviewService } from './case-list-owner-review-runtime';
import { createApprovedSentAccess } from './case-list-approved-sent-access';
import * as external from './case-list-external-transfer';
type Data=Record<string,any>;
const Owner=require('../src/case-list-owner-authorization.cjs');
const {withFreshPrincipal}=require('../src/case-list-gas-handoff-core.cjs');
function need(x:unknown,c:string):asserts x{if(!x)throw Object.assign(Error(c),{code:c});}
export const OWNER_REVIEW_ACTIONS=['preview-case-list-gas-send','confirm-case-list-gas-send','observe-case-list-gas-send'] as const;
export async function handleOwnerNameUpReview(request:Data,session:Data,ports:Data={}){
 const data=request.data,env=ports.env??process.env;
 need(data&&Object.keys(data).sort().join('|')==='action|payload'&&OWNER_REVIEW_ACTIONS.includes(data.action)&&data.payload&&typeof data.payload==='object'&&!Array.isArray(data.payload)&&Buffer.byteLength(JSON.stringify(data))<=131072,'OWNER_REVIEW_REQUEST_INVALID');
 const observing=data.action==='observe-case-list-gas-send';
 need(observing?['business','read-only'].includes(env.LKC_GAS_SYNC_MODE):env.LKC_GAS_SYNC_MODE==='business','OWNER_REVIEW_DISABLED');
 const database=ports.db??db,now=ports.now??(()=>Date.now()),config=ports.config??gasHandoffSettings(env);
 const auth=ports.auth??createFirebaseOwnerAuthContext(request,session,config,ports.identityOverrides);
 const authorization=request.rawRequest?.headers?.authorization;
 return withFreshPrincipal(auth,authorization,async(actor:Data)=>{
  const {formal,store}=createOwnerReviewService(auth,{...ports,db:database,now});
  if(observing){
   const {reference,operationKey}=data.payload;
   need(Object.keys(data.payload).sort().join('|')==='operationKey|reference'&&/^[a-f0-9]{48}$/.test(reference?.reviewId??'')&&/^[a-f0-9]{64}$/.test(reference?.displayHash??'')&&(operationKey===''||/^[a-f0-9]{64}$/.test(operationKey??'')),'OWNER_OBSERVATION_INPUT_INVALID');
   const saved=await store.read(reference.reviewId);
   need(saved?.body?.actorUid===actor.uid&&saved.body.companyId===actor.companyId&&saved.body.schema==='LK_CREW_OWNER_SEND_VIEW_V1'&&saved.displayHash===reference.displayHash&&Owner.hash(saved.body)===saved.displayHash,'OWNER_OBSERVATION_CHANGED');
   if(saved.result?.ownerAuthorization)Owner.validateOwnerObservation(saved.result.ownerAuthorization,actor,now(),{reviewId:reference.reviewId,displayHash:reference.displayHash,bindingHash:Owner.reviewBindingHash(saved)});
   const items=[];
   if(operationKey){
    const record=(await database.collection('lkcSyntheticAsyncJournalV1').doc(operationKey).get()).data(),r=record?.payload;
    need(r&&record.payloadHash===Owner.hash(r)&&r.key===operationKey&&r.actorUid===actor.uid&&r.companyId===actor.companyId&&r.ownerApprovalRef?.reviewId===reference.reviewId&&r.ownerApprovalRef.displayHash===reference.displayHash&&r.ownerAuthorizationHash===saved.result?.ownerAuthorization?.hash,'OWNER_OPERATION_CHANGED');
    for(const item of r.items){
     let accepted=false;
     if(item.binding){const observed=await (ports.observeAccepted??external.observeCompletedExternalCaseListTransfer)(database.collection('sheetSyncQueue').doc(item.queueId),actor.uid,actor);accepted=observed?.status==='EXTERNAL_ALREADY_ACCEPTED'&&observed.queueId===item.queueId;}
     items.push({caseId:item.caseId,state:accepted?'ACKED':item.state});
    }
   }
   await withFreshPrincipal(auth,authorization,async(fresh:Data)=>need(fresh.uid===actor.uid&&fresh.companyId===actor.companyId&&fresh.principalStateHash===actor.principalStateHash,'OWNER_OBSERVATION_AUTHORITY_CHANGED'));
   return {status:'OBSERVED',reviewState:saved.state,approvalRecorded:saved.result?.status==='OWNER_APPROVED_FOR_GAS',expired:!saved.result?.ownerAuthorization||now()>=saved.result.ownerAuthorization.validUntil,items,readOnly:true,mailRetried:false};
  }
  const reader=(await database.collection('caseMailReceiverConfigs').doc(actor.companyId).get()).data();
  need(reader?.companyId===actor.companyId,'SENT_READ_CONFIG_REQUIRED');
  await (ports.sentAccess??createApprovedSentAccess({db:database,now,operational:ports.operational})).assertReaderReady(reader,actor);
  if(data.action==='preview-case-list-gas-send'){
   need(Object.keys(data.payload).join('|')==='gasPreview','OWNER_PREVIEW_INPUT_INVALID');
   return formal.preview(authorization,data.payload);
  }
  need(Object.keys(data.payload).sort().join('|')==='confirmation|gasPreview','OWNER_CONFIRM_INPUT_INVALID');
  const result=await formal.confirm(authorization,data.payload);
  // Browser/GAS receive only the reference and expiry, never a token, subject,
  // raw auth_time, principal-state hash, or the durable authorization record.
  return {status:result.status,reference:result.reference,validUntil:result.ownerAuthorization.validUntil,actorUid:actor.uid,companyId:actor.companyId,mailSends:0,monthlyWrites:0};
 });
}
