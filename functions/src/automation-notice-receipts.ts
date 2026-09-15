import {createHash} from "node:crypto";
import {onCall,HttpsError} from "firebase-functions/v2/https";
import {Timestamp,FieldPath} from "firebase-admin/firestore";
import {z} from "zod";
import {db} from "./firebase";
import {requireAdmin,companyFromClaims} from "./utils";
import {assertProductionOperational} from "./system-safety";
import {AutomationBindingSchema,AutomationReceiptSchema,prepareAutomationHandoff,reconcileAutomationReceipt,type AutomationBinding,type AutomationReceipt} from "./automation-bridge-core";
import {RecruitmentRoutingSchema} from "./automation-recruitment-core";
import {automationRecordKey} from "./automation-intake";

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
const scope={expectedCompanyId:id,expectedActorUid:id};
const NoticeSchema=AutomationReceiptSchema.refine(row=>row.kind==="notice.departure"||row.kind==="notice.entry","出発・入店連絡の外部報告だけを受け取ります。");
const SenderSchema=z.object({companyId:id,uid:id,producerId:id,revision:id,active:z.literal(true)});
const PersonSchema=z.object({companyId:id,staffId:id,personKey:hash,revision:id,active:z.literal(true),verification:z.literal("verified"),evidenceRecordId:id});
const StateSchema=z.enum(["current","historical","needs_review"]);
const ReasonSchema=z.enum(["aligned","binding_changed","binding_missing","job_missing","fixed_id_unverified","person_unverified","job_unavailable","notice_owner_unverified","source_unavailable"]);
const StreamSchema=z.object({
 version:z.literal(1),companyId:id,operationKey:hash,producerId:id,receivedBy:id,firstPrincipalRevision:id,
 binding:AutomationBindingSchema,current:NoticeSchema,currentHash:hash,currentEventKey:hash,
 verificationMethod:z.literal("authenticated-source-report"),deliveryVerified:z.literal(false),
 createdAt:z.instanceof(Timestamp),updatedAt:z.instanceof(Timestamp),
}).strict();
const EventSchema=z.object({
 version:z.literal(1),companyId:id,operationKey:hash,eventKey:hash,producerId:id,receivedBy:id,principalRevision:id,
 incoming:NoticeSchema,inputHash:hash,disposition:z.enum(["accepted","stale"]),
 currentSequenceAtReceipt:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 stateAtReceipt:StateSchema,reasonAtReceipt:ReasonSchema,createdAt:z.instanceof(Timestamp),
}).strict();
type Stream=z.infer<typeof StreamSchema>;
type Sender=z.infer<typeof SenderSchema>;
type Alignment={state:z.infer<typeof StateSchema>;reason:z.infer<typeof ReasonSchema>};
type Reader={get(ref:FirebaseFirestore.DocumentReference):Promise<FirebaseFirestore.DocumentSnapshot>};
const scoped=(name:string,...parts:string[])=>db.collection(name).doc(automationRecordKey(...parts));
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const operationKey=(row:AutomationReceipt)=>automationRecordKey("notice.report",row.companyId,row.jobId,row.bindingRevision,row.kind,row.operationId);
const eventKey=(key:string,sequence:number)=>automationRecordKey("notice.report.event",key,String(sequence));
function fail(message:string):never{throw new HttpsError("failed-precondition",message);}
function own(value:FirebaseFirestore.DocumentData|undefined,companyId:string){
 if(value&&value.companyId!==companyId)fail("別の所属の保存記録が含まれています。");return value;
}
function checkedScope(input:{expectedCompanyId:string;expectedActorUid:string},companyId:string,uid:string){
 if(input.expectedCompanyId!==companyId||input.expectedActorUid!==uid)throw new HttpsError("permission-denied","確認した会社または管理者が変更されています。");
}
function senderOf(value:FirebaseFirestore.DocumentData|undefined,companyId:string,uid:string):Sender|null{
 const parsed=SenderSchema.safeParse(own(value,companyId));return parsed.success&&parsed.data.uid===uid?parsed.data:null;
}
function reconcile(binding:AutomationBinding,incoming:AutomationReceipt,current?:AutomationReceipt){
 try{return reconcileAutomationReceipt({companyId:binding.companyId,binding,incoming,current});}
 catch{fail("連絡結果の案件・担当証跡・連番または状態遷移が一致しません。元の配信記録を確認してください。");}
}
function streamOf(value:FirebaseFirestore.DocumentData|undefined,companyId:string,key:string):Stream|null{
 if(!value)return null;
 const parsed=StreamSchema.safeParse(own(value,companyId));
 if(!parsed.success)fail("保存済み連絡結果の形式を確認できません。");
 const row=parsed.data;
 if(row.operationKey!==key||operationKey(row.current)!==key||row.currentHash!==digest(row.current)||
   row.currentEventKey!==eventKey(key,row.current.sequence))fail("保存済み連絡結果の対応が一致しません。");
 reconcile(row.binding,row.current);return row;
}
function eventOf(value:FirebaseFirestore.DocumentData|undefined,stream:Stream,key:string){
 const parsed=EventSchema.safeParse(own(value,stream.companyId));
 if(!parsed.success)fail("連絡結果の受信履歴を確認できません。");
 const row=parsed.data;
 if(row.eventKey!==key||row.operationKey!==stream.operationKey||eventKey(row.operationKey,row.incoming.sequence)!==key||
   operationKey(row.incoming)!==stream.operationKey||row.inputHash!==digest(row.incoming)||
   row.producerId!==stream.producerId||row.receivedBy!==stream.receivedBy)fail("連絡結果と受信履歴の対応が一致しません。");
 reconcile(stream.binding,row.incoming);return row;
}
async function currentContext(tx:Reader,companyId:string,jobId:string){
 const [bindingSnap,jobSnap,policySnap]=await Promise.all([
  tx.get(scoped("automationBindings",companyId,jobId)),tx.get(db.collection("jobs").doc(jobId)),
  tx.get(db.collection("automationRecruitmentPolicies").doc(companyId)),
 ]);
 const rawBinding=own(bindingSnap.data(),companyId),job=own(jobSnap.data(),companyId),rawPolicy=own(policySnap.data(),companyId);
 const parsed=AutomationBindingSchema.safeParse(rawBinding);
 if(rawBinding&&!parsed.success)fail("現在の案件対応を読み取れません。");
 const binding=parsed.success?parsed.data:null;
 if(binding&&binding.jobId!==jobId)fail("案件対応の保存先が一致しません。");
 const reason=(value:z.infer<typeof ReasonSchema>)=>({binding,reason:value});
 if(!binding)return reason("binding_missing");
 if(!job)return reason("job_missing");
 const assignment=binding.assignment;
 const [ownerSnap,personSnap,personOwnerSnap,staffSnap]=await Promise.all([
  tx.get(scoped("automationBindingOwners",companyId,binding.spreadsheetId,binding.fixedCaseId)),
  assignment?tx.get(scoped("automationPeople",companyId,assignment.personKey)):Promise.resolve(null),
  assignment?tx.get(scoped("automationPersonOwners",companyId,assignment.staffId)):Promise.resolve(null),
  assignment?tx.get(db.collection("staffProfiles").doc(assignment.staffId)):Promise.resolve(null),
 ]);
 const owner=own(ownerSnap.data(),companyId),person=own(personSnap?.data(),companyId),personOwner=own(personOwnerSnap?.data(),companyId),staff=own(staffSnap?.data(),companyId);
 if(!owner||owner.jobId!==jobId||owner.spreadsheetId!==binding.spreadsheetId||owner.fixedCaseId!==binding.fixedCaseId||owner.revision!==binding.revision)return reason("fixed_id_unverified");
 const parsedPerson=PersonSchema.safeParse(person);
 if(!assignment||!parsedPerson.success||parsedPerson.data.personKey!==assignment.personKey||parsedPerson.data.staffId!==assignment.staffId||
   !personOwner||personOwner.staffId!==assignment.staffId||personOwner.personKey!==assignment.personKey||
   personOwner.revision!==parsedPerson.data.revision||personOwner.active!==true||staff?.active!==true)return reason("person_unverified");
 const policy=RecruitmentRoutingSchema.safeParse(rawPolicy);
 if(!policy.success||policy.data.noticeOwner!=="notice_control")return reason("notice_owner_unverified");
 if(!Number.isSafeInteger(job.revision??0)||(job.revision??0)<0)return reason("job_unavailable");
 try{if(!prepareAutomationHandoff({companyId,binding,job:{...job,id:jobId},revision:String(job.revision??0)}).noticeEligible)return reason("job_unavailable");}
 catch{return reason("job_unavailable");}
 return reason("aligned");
}
function alignment(binding:AutomationBinding,context:Awaited<ReturnType<typeof currentContext>>,sender:Sender|null,producerId:string):Alignment{
 if(context.binding&&digest(context.binding)!==digest(binding))return {state:"historical",reason:"binding_changed"};
 if(!sender||sender.producerId!==producerId)return {state:"needs_review",reason:"source_unavailable"};
 return {state:context.reason==="aligned"?"current":"needs_review",reason:context.reason};
}
function publicReport(stream:Stream,current:Alignment){
 const row=stream.current;
 return {operationKey:stream.operationKey,jobId:row.jobId,bindingRevision:row.bindingRevision,workDate:row.workDate,
  fixedCaseId:row.fixedCaseId,kind:row.kind,operationId:row.operationId,sequence:row.sequence,
  reportedStatus:row.status,observedAt:row.observedAt,sourceRecordId:row.sourceRecordId,
  state:current.state,reason:current.reason,receivedAt:stream.updatedAt.toDate().toISOString(),
  verificationMethod:stream.verificationMethod,deliveryVerified:false as const,automaticRetryAllowed:false as const};
}

/** 外部の配信報告を保存するだけ。G/H・通知キュー・スタッフの業務完了は変更しない。 */
export const receiveAutomationNoticeReceipt=onCall(async request=>{
 const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token));
 const input=z.object({...scope,incoming:NoticeSchema}).strict().parse(request.data),incoming=input.incoming;
 checkedScope(input,companyId,session.uid);
 if(incoming.companyId!==companyId)throw new HttpsError("permission-denied","連絡結果の所属が一致しません。");
 await assertProductionOperational(companyId);
 const key=operationKey(incoming),sequenceKey=eventKey(key,incoming.sequence),inputHash=digest(incoming);
 const streamRef=db.collection("automationNoticeReceipts").doc(key),eventRef=db.collection("automationNoticeEvents").doc(sequenceKey);
 return db.runTransaction(async tx=>{
  const [senderSnap,streamSnap,eventSnap]=await Promise.all([
   tx.get(scoped("automationIngestPrincipals",companyId,session.uid)),tx.get(streamRef),tx.get(eventRef),
  ]);
  const sender=senderOf(senderSnap.data(),companyId,session.uid);
  if(!sender)throw new HttpsError("permission-denied","現在の連携実行者を確認できません。");
  const previous=streamOf(streamSnap.data(),companyId,key),context=await currentContext(tx,companyId,incoming.jobId);
  if(previous&&(previous.producerId!==sender.producerId||previous.receivedBy!==session.uid))
   throw new HttpsError("permission-denied","元の報告実行者と一致しません。");
  let saved:Stream,disposition:"accepted"|"stale"|"duplicate",duplicate=false;
  const now=Timestamp.now();
  if(previous){
   // 最新連番の原文が存在することも、同じ取引で確認する。
   const anchor=previous.currentEventKey===sequenceKey?eventSnap:await tx.get(db.collection("automationNoticeEvents").doc(previous.currentEventKey));
   const anchorEvent=eventOf(anchor.data(),previous,previous.currentEventKey);
   if(anchorEvent.inputHash!==previous.currentHash||anchorEvent.disposition!=="accepted"||anchorEvent.currentSequenceAtReceipt!==previous.current.sequence)
    fail("最新の連絡結果と原文履歴が一致しません。");
   const oldEvent=eventSnap.exists?eventOf(eventSnap.data(),previous,sequenceKey):null;
   if(oldEvent&&oldEvent.inputHash!==inputHash)throw new HttpsError("already-exists","同じ連番に異なる連絡結果があります。");
   const next=reconcile(previous.binding,incoming,previous.current);
   if(oldEvent){saved=previous;disposition="duplicate";duplicate=true;}
   else{
    disposition=next.disposition==="stale"?"stale":"accepted";
    saved=disposition==="accepted"?{...previous,current:next.receipt,currentHash:inputHash,currentEventKey:sequenceKey,updatedAt:now}:previous;
   }
  }else{
   if(eventSnap.exists)fail("連絡結果の操作記録がなく、受信履歴だけが残っています。");
   if(!context.binding||context.reason!=="aligned")fail("初回報告の現在案件・固定ID・担当証跡・連携窓口を確認できません。元の報告を保持してください。");
   reconcile(context.binding,incoming);
   saved={version:1,companyId,operationKey:key,producerId:sender.producerId,receivedBy:session.uid,firstPrincipalRevision:sender.revision,
    binding:context.binding,current:incoming,currentHash:inputHash,currentEventKey:sequenceKey,
    verificationMethod:"authenticated-source-report",deliveryVerified:false,createdAt:now,updatedAt:now};
   disposition="accepted";
  }
  const state=alignment(saved.binding,context,sender,saved.producerId);
  if(!duplicate){
   const event={version:1 as const,companyId,operationKey:key,eventKey:sequenceKey,producerId:sender.producerId,receivedBy:session.uid,principalRevision:sender.revision,
    incoming,inputHash,disposition:disposition as "accepted"|"stale",currentSequenceAtReceipt:saved.current.sequence,stateAtReceipt:state.state,reasonAtReceipt:state.reason,createdAt:now};
   tx.set(eventRef,event);
   if(disposition==="accepted")tx.set(streamRef,saved);
  }
  return {ok:true,duplicate,disposition,eventKey:sequenceKey,report:publicReport(saved,state),assignmentPerformed:false,dispatch:"disabled"};
 });
});

/** 案件ごとの報告一覧。現在の担当への一致と、外部が報告した配信状態を分けて返す。 */
export const listAutomationNoticeReceipts=onCall(async request=>{
 const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token));
 const input=z.object({...scope,jobId:id,cursor:hash.optional()}).strict().parse(request.data);
 checkedScope(input,companyId,session.uid);await assertProductionOperational(companyId);
 return db.runTransaction(async tx=>{
  let query=db.collection("automationNoticeReceipts").where("companyId","==",companyId).where("current.jobId","==",input.jobId).orderBy(FieldPath.documentId()).limit(26);
  if(input.cursor)query=query.startAfter(input.cursor);
  const [page,context]=await Promise.all([tx.get(query),currentContext(tx,companyId,input.jobId)]);
  const rows=page.docs.slice(0,25).map(doc=>{
   const row=streamOf(doc.data(),companyId,doc.id);
   if(!row||row.current.jobId!==input.jobId)fail("取得した連絡結果が対象案件と一致しません。");return row;
  });
  const senders=new Map<string,Sender|null>();
  await Promise.all([...new Set(rows.map(row=>row.receivedBy))].map(async uid=>senders.set(uid,senderOf((await tx.get(scoped("automationIngestPrincipals",companyId,uid))).data(),companyId,uid))));
  const reports=await Promise.all(rows.map(async row=>{
   const event=eventOf((await tx.get(db.collection("automationNoticeEvents").doc(row.currentEventKey))).data(),row,row.currentEventKey);
   if(event.inputHash!==row.currentHash||event.disposition!=="accepted"||event.currentSequenceAtReceipt!==row.current.sequence)fail("連絡結果の最新原文を確認できません。");
   return publicReport(row,alignment(row.binding,context,senders.get(row.receivedBy)??null,row.producerId));
  }));
  return {ok:true,jobId:input.jobId,reports,nextCursor:page.docs.length>25?page.docs[24]!.id:null,dispatch:"disabled"};
 });
});
