import {onCall,HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import {db} from "./firebase";
import {requireAdmin,companyFromClaims} from "./utils";
import {assertProductionOperational} from "./system-safety";
import {prepareAutomationHandoff} from "./automation-bridge-core";
import {RecruitmentRoutingSchema} from "./automation-recruitment-core";
import {readAutomationJobContext,automationProofDigest,automationPreContactEvidence,matchesAutomationPreContactProof} from "./automation-precontact-proof";

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const InputSchema=z.object({expectedCompanyId:id,expectedActorUid:id,jobId:id}).strict();
const SenderSchema=z.object({companyId:id,uid:id,producerId:id,revision:id,active:z.literal(true)});
function fail(message:string,reason?:string):never{throw new HttpsError("failed-precondition",message,reason?{reason}:undefined);}

/** 認証された連携実行者へ現在の案件と本人入力を返すだけ。外部送信・原本更新は行わない。 */
export const getAutomationNoticeHandoff=onCall(async request=>{
 const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token)),input=InputSchema.parse(request.data);
 if(input.expectedCompanyId!==companyId||input.expectedActorUid!==session.uid)throw new HttpsError("permission-denied","確認した会社または管理者が変更されています。");
 await assertProductionOperational(companyId);
 return db.runTransaction(async tx=>{
  const [senderSnap,policySnap,jobSnap]=await Promise.all([
   tx.get(db.collection("automationIngestPrincipals").doc(automationProofDigest([companyId,session.uid]))),
   tx.get(db.collection("automationRecruitmentPolicies").doc(companyId)),tx.get(db.collection("jobs").doc(input.jobId)),
  ]);
  const sender=SenderSchema.safeParse(senderSnap.data()),policy=RecruitmentRoutingSchema.safeParse(policySnap.data()),job=jobSnap.data();
  if(!sender.success||sender.data.companyId!==companyId||sender.data.uid!==session.uid)throw new HttpsError("permission-denied","現在の連携実行者を確認できません。");
  if(!policy.success||policy.data.companyId!==companyId)fail("現在の出発・入店連絡の連携窓口を確認できません。");
  if(!job||job.companyId!==companyId)fail("対象の案件を確認できません。");
  if(!Number.isSafeInteger(job.revision??0)||(job.revision??0)<0)fail("現在の案件の版を確認できません。");
  // 応募後の確認待ちを台帳の不足や内部エラーへ置き換えず、実行可能な次の確認を伝える。
  if(job.sourceMissing===true||job.status==="archived")fail("取込元の案件を確認できません。元の案件と取込状態を確認してください。","source_unavailable");
  if(job.applicationUnconfirmed===true)fail("応募内容はアプリに保存されています。シフト表で担当を確認できるまで、連携データは取得できません。反映確認後に再取得してください。","assignment_sheet_confirmation_pending");
  if(job.assignmentUnresolved===true)fail("担当者の照合が完了していません。担当者と連携台帳を確認してください。","assignment_identity_unresolved");
  const context=await readAutomationJobContext(tx,companyId,input.jobId,job);
  if(!context)fail("現在の案件・固定ID・担当の対応を確認できません。連携台帳を確認してください。");
  const base=prepareAutomationHandoff({companyId,binding:context.binding,job:{...job,id:input.jobId},revision:String(job.revision??0)});
  const rawContact=job.preContact,evidence=automationPreContactEvidence(rawContact);
  const applicable=base.status==="assigned"&&context.binding.assignment!==null;
  const linked=applicable&&job.preContactNeedsReview!==true&&matchesAutomationPreContactProof(context,rawContact,rawContact?.automationProof);
  const preContact=linked&&evidence?{temperature:evidence.temperature,arrivalTime:evidence.arrivalTime,submittedAt:evidence.submittedAt}:null;
  const preContactState=!applicable?"not_applicable":job.preContactNeedsReview===true?"needs_review":preContact?"linked":rawContact==null?"missing":"unverified";
  // 案件版が変わらない本人入力の更新も識別する。読取時刻やファイル時刻は版に含めない。
  const revision=automationProofDigest({base:base.payloadHash,policyRevision:policy.data.revision,preContactState,preContact,
   proof:preContact?{operationId:evidence!.operationId,evidenceHash:rawContact.automationProof.evidenceHash,
    personRevision:context.personRevision,confirmedAt:rawContact.automationProof.confirmedAt.toDate().toISOString()}:null,
   sheetSyncPending:preContact?job.preContactSyncPending===true:false});
  const handoff=prepareAutomationHandoff({companyId,binding:context.binding,job:{...job,id:input.jobId},revision,preContact});
  return {ok:true,handoff,policy:policy.data,preContactState,sheetSyncPending:preContact?job.preContactSyncPending===true:false,
   deliveryVerified:false,automaticRetryAllowed:false,dispatch:"disabled"};
 });
});
