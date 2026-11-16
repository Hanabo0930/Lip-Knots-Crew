/** Adopted isolated purpose gate. Legacy receiver active/intake flags stay
 * untouched: this distinct permit never authorizes receive/list/save APIs. */
import { db } from './firebase';
import { getProductionOperationalState } from './system-safety';
import type { ExistingMailConfig, SentMessageScope } from './case-list-gas-read-ports';
type Data=Record<string,any>;
const Owner=require('../src/case-list-owner-authorization.cjs') as Data;
const HEX=/^[a-f0-9]{64}$/,REVIEW=/^[a-f0-9]{48}$/,CASE=/^LKCASE_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const POLICY='lkcSyntheticAsyncPolicyV1',JOURNAL='lkcSyntheticAsyncJournalV1',VIEWS='lkcSyntheticReviewViewsV1';
function need(x:unknown,c:string):asserts x{if(!x)throw Object.assign(Error(c),{code:c});}
export function createApprovedSentAccess(ports:{db?:any;now?:()=>number;operational?:(companyId:string)=>Promise<boolean>}={}){
 const database=ports.db??db,now=ports.now??(()=>Date.now()),operational=ports.operational??(async c=>(await getProductionOperationalState(c)).operational);
 function permit(policy:Data,config:ExistingMailConfig,actor:Data){
  Owner.freshActor(actor,now());
  need(config.companyId===actor.companyId&&config.mailbox===actor.email,'SENT_READER_COMPANY_OR_MAILBOX_CHANGED');
  const p=policy?.sentRead;
  need(policy?.companyId===actor.companyId&&policy.mode==='active'&&Number.isSafeInteger(policy.epoch)&&policy.epoch>0&&Array.isArray(policy.allowedUids)&&policy.allowedUids.includes(actor.uid),'SENT_PURPOSE_POLICY_CLOSED');
  need(p?.purpose==='NAMEUP_KNOWN_SENT_VERIFICATION_V1'&&p.enabled===true&&p.ownerUid===actor.uid&&p.mailbox===config.mailbox&&p.gmailServiceAccountEmail===config.gmailServiceAccountEmail&&p.principalRevision===config.principalRevision&&p.readerConfigHash===Owner.hash(config),'SENT_PURPOSE_NOT_AUTHORIZED');
 }
 async function ready(config:ExistingMailConfig,actor:Data){
  need(await operational(actor.companyId)===true,'GLOBAL_STOPPED');
  await database.runTransaction(async(tx:any)=>{const policy=(await tx.get(database.collection(POLICY).doc(actor.companyId))).data();permit(policy,config,actor);},{readOnly:true});
 }
 async function message(config:ExistingMailConfig,actor:Data,scope?:SentMessageScope){
  need(scope&&HEX.test(scope.operationKey??'')&&CASE.test(scope.caseId??'')&&/^[a-z0-9_-]{1,160}$/i.test(scope.messageId??'')&&HEX.test(scope.digest??''),'SENT_OPERATION_SCOPE_REQUIRED');
  need(await operational(actor.companyId)===true,'GLOBAL_STOPPED');
  await database.runTransaction(async(tx:any)=>{
   const [policySnap,journalSnap]=await Promise.all([tx.get(database.collection(POLICY).doc(actor.companyId)),tx.get(database.collection(JOURNAL).doc(scope.operationKey))]);
   const policy=policySnap.data(),journal=journalSnap.data();permit(policy,config,actor);
   const r=journal?.payload;
   need(journal?.schema==='LK_CREW_ASYNC_JOURNAL_PROPOSAL_V1'&&journal.key===scope.operationKey&&journal.payloadHash===Owner.hash(r)&&r?.schema==='LK_CREW_SYNC_GATE_PROPOSAL_V1'&&r.key===scope.operationKey&&r.actorUid===actor.uid&&r.companyId===actor.companyId,'SENT_OPERATION_CHANGED');
   need(journal.lease?.epoch===policy.epoch&&journal.lease.expiresAt>now(),'SENT_OPERATION_LEASE_LOST');
   const ref=r.ownerApprovalRef;
   need(REVIEW.test(ref?.reviewId??'')&&HEX.test(ref?.displayHash??'')&&HEX.test(r.ownerAuthorizationHash??'')&&HEX.test(r.ownerBindingHash??''),'SENT_OWNER_APPROVAL_REQUIRED');
   const saved=(await tx.get(database.collection(VIEWS).doc(ref.reviewId))).data(),grant=saved?.result?.ownerAuthorization;
   need(saved?.state==='RESULT_OBSERVED'&&saved.body?.schema==='LK_CREW_OWNER_SEND_VIEW_V1'&&saved.body.actorUid===actor.uid&&saved.body.companyId===actor.companyId&&saved.result?.status==='OWNER_APPROVED_FOR_GAS'&&saved.displayHash===ref.displayHash&&Owner.hash(saved.body)===saved.displayHash&&grant?.hash===r.ownerAuthorizationHash,'SENT_OWNER_APPROVAL_CHANGED');
   Owner.validateOwnerAuthorization(grant,actor,now(),{reviewId:ref.reviewId,displayHash:ref.displayHash,bindingHash:r.ownerBindingHash,firstPreparedAt:r.firstPreparedAt,deadlineAt:r.deadlineAt});
   const item=r.items?.find((i:Data)=>i.caseId===scope.caseId),prepared=r.prepared?.cases?.find((i:Data)=>i.id===scope.caseId);
   const proposed=r.pending?.action==='SENT_RETURNED'?r.proposedSentReceipts?.find((i:Data)=>i.caseId===scope.caseId):null;
   const receipt=item?.sent??proposed;
   need(item&&prepared&&prepared.nameUpDigest===scope.digest&&receipt?.messageId===scope.messageId&&receipt.digest===scope.digest,'SENT_MESSAGE_NOT_BOUND_TO_OPERATION');
   // Recheck the original observation/expiry after awaited policy/journal/view
   // reads. A readiness permit is never enough to read a message body.
   permit(policy,config,actor);
   Owner.validateOwnerAuthorization(grant,actor,now(),{reviewId:ref.reviewId,displayHash:ref.displayHash,bindingHash:r.ownerBindingHash,firstPreparedAt:r.firstPreparedAt,deadlineAt:r.deadlineAt});
  },{readOnly:true});
 }
 return Object.freeze({assertReaderReady:ready,assertMessageAccess:message});
}
