import { createHash, randomUUID } from "node:crypto";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "./firebase";
import { requireAdmin, companyFromClaims } from "./utils";
import { assertProductionOperational } from "./system-safety";
import { tokyoParts } from "./notification-time";
import { automationRecordKey } from "./automation-intake";
import { AutomationBindingSchema, prepareAutomationHandoff } from "./automation-bridge-core";
import { CampaignSchema, RecruitmentRoutingSchema, validateCaseMailCampaign } from "./automation-recruitment-core";

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
const context={expectedCompanyId:id,expectedActorUid:id};
const boundedCampaign=CampaignSchema.refine(value=>value.cases.length<=100,"一度に登録できる募集は100枠までです。");
const PreviewSchema=z.object({...context,campaign:boundedCampaign}).strict();
const InputSchema=z.object({...context,requestId:id,expectedPrincipalRevision:id,evidenceRecordId:id,
  confirmedAgainstSource:z.literal(true),campaign:boundedCampaign}).strict();
const ReadSchema=z.object({...context,campaignKey:hash}).strict();
const scoped=(collection:string,...parts:string[])=>db.collection(collection).doc(automationRecordKey(...parts));
function fail(message:string):never{throw new HttpsError("failed-precondition",message);}
function own(value:FirebaseFirestore.DocumentData|undefined,companyId:string){
  if(value&&value.companyId!==companyId)fail("別の所属の記録が含まれています。");return value;
}
function checkContext(input:{expectedCompanyId:string;expectedActorUid:string},companyId:string,uid:string){
  if(input.expectedCompanyId!==companyId||input.expectedActorUid!==uid)throw new HttpsError("permission-denied","確認した会社または管理者が変更されています。");
}
function checkedCampaign(value:unknown,companyId:string){
  const campaign=validateCaseMailCampaign(value);
  if(campaign.companyId!==companyId)throw new HttpsError("permission-denied","募集の会社が一致しません。");return campaign;
}
function result(value:FirebaseFirestore.DocumentData,duplicate:boolean){
  return {ok:true,duplicate,campaignKey:hash.parse(value.campaignKey),registrationRevision:id.parse(value.registrationRevision),
    caseCount:z.number().int().min(1).max(100).parse(value.caseCount),verificationMethod:"admin-source-confirmation",dispatch:"disabled"};
}
function operationHash(input:z.infer<typeof InputSchema>){
  const {expectedCompanyId,expectedActorUid,...operation}=input;
  return createHash("sha256").update(JSON.stringify(operation)).digest("hex");
}
function checkEvent(event:FirebaseFirestore.DocumentData,input:z.infer<typeof InputSchema>,uid:string,inputHash:string){
  if(event.actorUid!==uid||event.inputHash!==inputHash||event.campaignKey!==input.campaign.operationKey)
    throw new HttpsError("already-exists","同じ操作番号に異なる確認内容があります。");
  if(event.status!==undefined&&event.status!=="committed"&&event.status!=="cancelled")fail("登録操作の状態を確認できません。");
  if(event.status!=="cancelled"&&event.caseCount!==input.campaign.cases.length)fail("保存済みの登録件数が一致しません。");
}

/** プレビューと登録で同じ現在値を読む。確定済みの同一募集は最初の確認履歴を保持する。 */
async function readRegistrationContext(tx:FirebaseFirestore.Transaction,companyId:string,uid:string,
  campaign:z.infer<typeof CampaignSchema>,expectedPrincipalRevision?:string){
  const campaignRef=db.collection("automationCampaigns").doc(campaign.operationKey);
  const [senderSnap,previousSnap]=await Promise.all([
    tx.get(scoped("automationIngestPrincipals",companyId,uid)),tx.get(campaignRef),
  ]);
  const sender=own(senderSnap.data(),companyId);
  if(!sender||sender.uid!==uid||sender.active!==true||!id.safeParse(sender.producerId).success||
    !id.safeParse(sender.revision).success||(expectedPrincipalRevision!==undefined&&sender.revision!==expectedPrincipalRevision))
    throw new HttpsError("permission-denied","連携実行者の確認版または利用状態が変更されています。");
  const ownerRef=scoped("automationCampaignOwners",companyId,sender.producerId,campaign.sourceOperationId,campaign.area);
  const owner=own((await tx.get(ownerRef)).data(),companyId),previous=own(previousSnap.data(),companyId);
  if(previous){
    const existing=validateCaseMailCampaign(previous.campaign);
    if(existing.companyId!==companyId||previous.producerId!==sender.producerId||existing.operationKey!==campaign.operationKey||existing.payloadHash!==campaign.payloadHash)
      throw new HttpsError("already-exists","同じ募集の識別子に別の内容が登録されています。元の記録を確認してください。");
    if(previous.campaignKey!==campaign.operationKey||previous.caseCount!==campaign.cases.length||
      previous.verification!=="verified"||previous.verificationMethod!=="admin-source-confirmation"||
      !id.safeParse(previous.evidenceRecordId).success||!owner||owner.campaignKey!==campaign.operationKey||
      owner.producerId!==sender.producerId||owner.sourceOperationId!==campaign.sourceOperationId||owner.area!==campaign.area||
      owner.registrationRevision!==previous.registrationRevision)
      fail("既存募集の確認履歴と所有記録を照合できません。旧記録の移行確認が必要です。");
    result(previous,true);
    return {campaignRef,ownerRef,sender,previous,cases:campaign.cases.map(target=>({...target,storeName:null as string|null}))};
  }
  if(owner)throw new HttpsError("already-exists","この実行元の募集操作は登録済みです。別の受付版へ付け替えず元の募集を確認してください。");
  const parsedPolicy=RecruitmentRoutingSchema.safeParse(own((await tx.get(db.collection("automationRecruitmentPolicies").doc(companyId))).data(),companyId));
  if(!parsedPolicy.success||parsedPolicy.data.phase!=="mail_bridge"||parsedPolicy.data.revision!==campaign.policyRevision)
    fail("募集の受付窓口が変更されています。新しい募集メールの登録を中止してください。");
  const today=tokyoParts(new Date()).dateKey;
  const cases=await Promise.all(campaign.cases.map(async target=>{
    const [bindingSnap,jobSnap,ownerSnap]=await Promise.all([
      tx.get(scoped("automationBindings",companyId,target.jobId)),tx.get(db.collection("jobs").doc(target.jobId)),
      tx.get(scoped("automationBindingOwners",companyId,target.spreadsheetId,target.fixedCaseId)),
    ]);
    const parsedBinding=AutomationBindingSchema.safeParse(own(bindingSnap.data(),companyId)),job=own(jobSnap.data(),companyId);
    if(!parsedBinding.success)fail("募集に対応する連携台帳を確認してください。");
    const binding=parsedBinding.data,bindingOwner=own(ownerSnap.data(),companyId);
    if(!job||!Number.isSafeInteger(job.revision??0)||(job.revision??0)<0||String(job.revision??0)!==target.jobRevision)
      fail("募集の確認後に案件内容が変更されています。");
    for(const field of ["jobId","appCaseId","spreadsheetId","fixedCaseId","workDate"] as const)
      if(binding[field]!==target[field])fail("募集の案件対応が変更されています。");
    if(binding.revision!==target.bindingRevision||!bindingOwner||bindingOwner.jobId!==target.jobId||
      bindingOwner.spreadsheetId!==target.spreadsheetId||bindingOwner.fixedCaseId!==target.fixedCaseId||bindingOwner.revision!==binding.revision)
      fail("募集の固定IDと現在の所有記録が一致しません。");
    const state=prepareAutomationHandoff({companyId,binding,job:{...job,id:target.jobId},revision:target.jobRevision});
    if(!state.recruitmentEligible||target.workDate<today)fail("現在は募集できない案件が含まれています。");
    return {...target,storeName:typeof job.storeName==="string"&&job.storeName.trim()?job.storeName.slice(0,200):null};
  }));
  return {campaignRef,ownerRef,sender,previous:null,cases};
}

/** 原本の自動検証ではなく、取込候補とアプリの現在値だけを読み取る。書込みは行わない。 */
export const previewCaseMailCampaignRegistration=onCall(async request=>{
  const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token)),input=PreviewSchema.parse(request.data);
  checkContext(input,companyId,session.uid);const campaign=checkedCampaign(input.campaign,companyId);
  await assertProductionOperational(companyId);
  return db.runTransaction(async tx=>{
    const current=await readRegistrationContext(tx,companyId,session.uid,campaign);
    return {ok:true,campaignKey:campaign.operationKey,payloadHash:campaign.payloadHash,expectedPrincipalRevision:current.sender.revision,
      alreadyRegistered:Boolean(current.previous),registeredResult:current.previous?result(current.previous,true):null,
      evidenceRecordId:current.previous?current.previous.evidenceRecordId:null,cases:current.cases,dispatch:"disabled"};
  });
});

/** 管理者が募集原本を照合した記録。原本の自動検証・メール配信・応募確定は行わない。 */
export const registerCaseMailCampaign=onCall(async request=>{
  const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token)),input=InputSchema.parse(request.data);
  checkContext(input,companyId,session.uid);const campaign=checkedCampaign(input.campaign,companyId);
  await assertProductionOperational(companyId);
  const inputHash=operationHash(input),eventRef=scoped("automationCampaignRegistrationEvents",companyId,session.uid,input.requestId);
  const registrationRevision=randomUUID();
  return db.runTransaction(async tx=>{
    const event=own((await tx.get(eventRef)).data(),companyId);
    if(event){
      checkEvent(event,input,session.uid,inputHash);
      if(event.status==="cancelled")throw new HttpsError("failed-precondition","この募集登録は中止されています。",
        {reason:"campaign_registration_cancelled",requestId:input.requestId,campaignKey:campaign.operationKey,accepted:false});
      return result(event,true);
    }
    const current=await readRegistrationContext(tx,companyId,session.uid,campaign,input.expectedPrincipalRevision);
    const saved=current.previous??{companyId,producerId:current.sender.producerId,principalRevision:current.sender.revision,verifiedBy:session.uid,
      verification:"verified",verificationMethod:"admin-source-confirmation",evidenceRecordId:input.evidenceRecordId,
      campaign,campaignKey:campaign.operationKey,caseCount:campaign.cases.length,registrationRevision,createdAt:Timestamp.now()};
    if(!current.previous){
      tx.set(current.campaignRef,saved);
      tx.set(current.ownerRef,{companyId,producerId:current.sender.producerId,sourceOperationId:campaign.sourceOperationId,
        area:campaign.area,campaignKey:campaign.operationKey,registrationRevision});
    }
    tx.set(eventRef,{companyId,actorUid:session.uid,inputHash,status:"committed",evidenceRecordId:input.evidenceRecordId,
      campaignKey:campaign.operationKey,registrationRevision:saved.registrationRevision,caseCount:campaign.cases.length,createdAt:Timestamp.now()});
    return result(saved,Boolean(current.previous));
  });
});

/** 未確定の要求を永続的に中止する。先に登録済みならその結果を返し、募集原本は取り消さない。 */
export const cancelCaseMailCampaignRegistration=onCall(async request=>{
  const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token)),input=InputSchema.parse(request.data);
  checkContext(input,companyId,session.uid);const campaign=checkedCampaign(input.campaign,companyId);
  await assertProductionOperational(companyId);
  const inputHash=operationHash(input),eventRef=scoped("automationCampaignRegistrationEvents",companyId,session.uid,input.requestId);
  return db.runTransaction(async tx=>{
    const event=own((await tx.get(eventRef)).data(),companyId);
    if(event){
      checkEvent(event,input,session.uid,inputHash);
      return {ok:true,requestId:input.requestId,campaignKey:campaign.operationKey,outcome:event.status==="cancelled"?"cancelled":"committed",
        result:event.status==="cancelled"?null:result(event,true)};
    }
    tx.set(eventRef,{companyId,actorUid:session.uid,inputHash,status:"cancelled",campaignKey:campaign.operationKey,
      evidenceRecordId:input.evidenceRecordId,createdAt:Timestamp.now()});
    return {ok:true,requestId:input.requestId,campaignKey:campaign.operationKey,outcome:"cancelled",result:null};
  });
});

/** 指定した募集の登録結果だけを所属内で確認する。実送信の完了を示さない。 */
export const getCaseMailCampaignRegistration=onCall(async request=>{
  const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token)),input=ReadSchema.parse(request.data);
  checkContext(input,companyId,session.uid);
  const record=own((await db.collection("automationCampaigns").doc(input.campaignKey).get()).data(),companyId);
  if(!record)return {ok:true,record:null};
  if(record.verification!=="verified"||record.verificationMethod!=="admin-source-confirmation")fail("この募集には対応する原本確認記録がありません。");
  const campaign=checkedCampaign(record.campaign,companyId);
  if(campaign.operationKey!==input.campaignKey||record.campaignKey!==input.campaignKey||record.caseCount!==campaign.cases.length)fail("募集の保存先と識別子が一致しません。");
  return {ok:true,record:{...result(record,true),sourceOperationId:campaign.sourceOperationId,area:campaign.area,
    sourceHash:campaign.sourceHash,payloadHash:campaign.payloadHash,evidenceRecordId:id.parse(record.evidenceRecordId)}};
});
