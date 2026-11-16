import { db } from './firebase';
import { withFirebaseOwnerCallable, type FirebaseOwnerPolicy, type FirebaseOwnerPorts } from './case-list-firebase-owner';
type Data=Record<string,any>;
const Owner=require('../src/case-list-owner-authorization.cjs') as Data;
const Core=require('../src/case-list-gas-handoff-core.cjs') as Data;
const HEX=/^[a-f0-9]{64}$/,REVIEW=/^[a-f0-9]{48}$/;
function need(x:unknown,c:string):asserts x{if(!x)throw Object.assign(Error(c),{code:c});}
export function createFirebaseOwnerAuthContext(request:Data,session:Data,config:Data,
 overrides:{policy?:FirebaseOwnerPolicy;identity?:FirebaseOwnerPorts;now?:()=>number}={}){
 const authorization=request.rawRequest?.headers?.authorization;
 need(typeof authorization==='string','FIREBASE_OWNER_BEARER_REQUIRED');
 const ownerContext=Owner.createOwnerContext(async (supplied:string)=>{
  need(supplied===authorization,'FIREBASE_OWNER_REQUEST_CHANGED');
  return withFirebaseOwnerCallable(request,session as any,async actor=>actor,overrides.policy,overrides.identity);
 });
 return {config,now:overrides.now??(()=>Date.now()),ownerContext};
}
export function createGasOwnerAuthContext(baseAuth:Data,body:Data,overrides:{db?:any;now?:()=>number}={}){
 const database=overrides.db??db,now=overrides.now??baseAuth.now,action=body?.action;
 const originalBody=body;
 const ownerContext=Owner.createOwnerContext(async (authorization:string)=>{
  need(originalBody.action===action,'OWNER_REQUEST_ACTION_CHANGED');
  // This verifies Google signature/issuer/audience/expiry and current existing
  // UID/provider/role/MFA/revocation state, but invents no Google auth_time.
  const actor=await Core.readVerifiedGoogleAccount(baseAuth,authorization);
  const saved=await database.runTransaction(async(tx:any)=>{
   let ref=body.payload?.formalReference??body.payload?.ownerApprovalRef,operation:Data|undefined;
   if(body.operationKey){
    need(HEX.test(body.operationKey),'RPC_OPERATION_REQUIRED');
    const journal=(await tx.get(database.collection('lkcSyntheticAsyncJournalV1').doc(body.operationKey))).data();
    operation=journal?.payload;
    need(operation&&journal?.schema==='LK_CREW_ASYNC_JOURNAL_PROPOSAL_V1'&&journal.payloadHash===Owner.hash(operation)&&operation.key===body.operationKey&&operation.actorUid===actor.uid&&operation.companyId===actor.companyId,'OWNER_OPERATION_CHANGED');
    ref=operation.ownerApprovalRef;
   }
   need(REVIEW.test(ref?.reviewId??'')&&HEX.test(ref?.displayHash??''),'OWNER_APPROVAL_REQUIRED');
   const value=(await tx.get(database.collection('lkcSyntheticReviewViewsV1').doc(ref.reviewId))).data();
   need(value?.state==='RESULT_OBSERVED'&&value.body?.actorUid===actor.uid&&value.body.companyId===actor.companyId&&value.displayHash===ref.displayHash&&Owner.hash(value.body)===value.displayHash&&value.result?.status==='OWNER_APPROVED_FOR_GAS','OWNER_APPROVAL_CHANGED');
   const bindingHash=Owner.reviewBindingHash(value),expected={reviewId:ref.reviewId,displayHash:ref.displayHash,bindingHash};
   if(operation)need(operation.ownerBindingHash===bindingHash&&operation.ownerAuthorizationHash===value.result.ownerAuthorization?.hash,'OWNER_OPERATION_APPROVAL_CHANGED');
   if(action==='OBSERVE')Owner.validateOwnerObservation(value.result.ownerAuthorization,actor,now(),expected);
   else Owner.validateOwnerAuthorization(value.result.ownerAuthorization,actor,now(),{...expected,...(operation?{firstPreparedAt:operation.firstPreparedAt,deadlineAt:operation.deadlineAt}:{})});
   return value;
  },{readOnly:true});
  Owner.freshActor(actor,now());
  need(originalBody.action===action,'OWNER_REQUEST_ACTION_CHANGED');
  const grant=saved.result.ownerAuthorization;
  if(action==='OBSERVE')Owner.validateOwnerObservation(grant,actor,now(),{bindingHash:Owner.reviewBindingHash(saved)});
  else Owner.validateOwnerAuthorization(grant,actor,now(),{bindingHash:Owner.reviewBindingHash(saved)});
  return Object.freeze({...actor,identityExpiresAt:action==='OBSERVE'?actor.identityExpiresAt:Math.min(actor.identityExpiresAt,grant.validUntil),permissionMode:action==='OBSERVE'?'observe-only':'approved-operation'});
 });
 return {...baseAuth,ownerContext};
}
