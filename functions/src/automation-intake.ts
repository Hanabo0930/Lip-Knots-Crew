import { createHash } from "node:crypto";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { Timestamp, FieldPath } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "./firebase";
import { companyFromClaims, requireAdmin, requireAuth, staffFromClaims } from "./utils";
import { tokyoParts } from "./notification-time";
import { assertProductionOperational } from "./system-safety";
import { AutomationBindingSchema } from "./automation-bridge-core";
import { RecruitmentApplicationSchema, RecruitmentRoutingSchema, reconcileCaseMailApplication } from "./automation-recruitment-core";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export function automationRecordKey(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
const receiptKey = (receipt: z.infer<typeof RecruitmentApplicationSchema>) =>
  automationRecordKey("mail.application", receipt.companyId, receipt.sourceRecordId, receipt.fixedCaseId, receipt.workDate);
const scoped = (name: string, ...parts: string[]) => db.collection(name).doc(automationRecordKey(...parts));
const requireRecord = (value: FirebaseFirestore.DocumentData | undefined, companyId: string) => {
  if (!value || value.companyId !== companyId) throw new HttpsError("failed-precondition", "連携用の保存記録を確認できません。");
  return value;
};

const SenderSchema = z.object({
  companyId: id, active: z.literal(true), producerId: id, uid: id, revision: id,
});
const PersonSchema = z.object({
  companyId: id, staffId: id, personKey: hash, revision: id,
  active: z.literal(true), verification: z.literal("verified"), evidenceRecordId: id,
});
const CampaignRecordSchema = z.object({
  companyId: id, producerId: id, verification: z.literal("verified"),
  evidenceRecordId: id, campaign: z.unknown(),
});

type IntakeReader = {get(ref:FirebaseFirestore.DocumentReference):Promise<FirebaseFirestore.DocumentSnapshot>};

async function readContext(tx: IntakeReader, companyId: string, incoming: z.infer<typeof RecruitmentApplicationSchema>) {
  const [policySnap, campaignSnap] = await Promise.all([
    tx.get(db.collection("automationRecruitmentPolicies").doc(companyId)),
    tx.get(db.collection("automationCampaigns").doc(incoming.campaignKey)),
  ]);
  const policy = RecruitmentRoutingSchema.parse(requireRecord(policySnap.data(), companyId));
  const record = CampaignRecordSchema.parse(requireRecord(campaignSnap.data(), companyId));
  // 元の募集に記録された案件だけを読む。受信側にアプリjobIdを選ばせない。
  const target = z.object({ cases: z.array(z.object({ jobId: id, fixedCaseId: id, workDate: z.string(), jobRevision: id })) })
    .parse(record.campaign).cases.filter(item => item.fixedCaseId === incoming.fixedCaseId && item.workDate === incoming.workDate);
  if (target.length !== 1) throw new HttpsError("failed-precondition", "応募先の募集枠を特定できません。");
  const selected = target[0]!;
  const [bindingSnap, jobSnap, personSnap] = await Promise.all([
    tx.get(scoped("automationBindings", companyId, selected.jobId)),
    tx.get(db.collection("jobs").doc(selected.jobId)),
    incoming.applicantPersonKey ? tx.get(scoped("automationPeople", companyId, incoming.applicantPersonKey)) : Promise.resolve(null),
  ]);
  const binding = AutomationBindingSchema.parse(requireRecord(bindingSnap.data(), companyId));
  const job = requireRecord(jobSnap.data(), companyId);
  const bindingOwner = requireRecord((await tx.get(scoped("automationBindingOwners", companyId, binding.spreadsheetId, binding.fixedCaseId))).data(), companyId);
  if (bindingOwner.jobId !== binding.jobId || bindingOwner.spreadsheetId !== binding.spreadsheetId ||
      bindingOwner.fixedCaseId !== binding.fixedCaseId || bindingOwner.revision !== binding.revision) {
    throw new HttpsError("failed-precondition", "固定案件IDの登録先を確認できません。");
  }
  const parsedPerson = PersonSchema.safeParse(personSnap?.data());
  const matchedPerson = parsedPerson.success && parsedPerson.data.companyId === companyId &&
    parsedPerson.data.personKey === incoming.applicantPersonKey ? parsedPerson.data : null;
  const personOwner = matchedPerson ? (await tx.get(scoped("automationPersonOwners", companyId, matchedPerson.staffId))).data() : null;
  const person = matchedPerson && personOwner?.companyId === companyId && personOwner.staffId === matchedPerson.staffId &&
    personOwner.personKey === matchedPerson.personKey && personOwner.revision === matchedPerson.revision && personOwner.active === true ? matchedPerson : null;
  const staffSnap = person ? await tx.get(db.collection("staffProfiles").doc(person.staffId)) : null;
  const staff = staffSnap?.data();
  const verifiedApplicant = person && staff?.companyId === companyId && staff.active === true
    ? { companyId, staffId: person.staffId, personKey: person.personKey, active: true } : undefined;
  let result: ReturnType<typeof reconcileCaseMailApplication>;
  try { result = reconcileCaseMailApplication({
    companyId, policy, campaign: record.campaign, incoming, binding,
    job: { ...job, id: selected.jobId }, verifiedApplicant, today: tokyoParts(new Date()).dateKey,
  });
  } catch { throw new HttpsError("failed-precondition","応募元の募集と現在の案件を照合できません。"); }
  if (!Number.isSafeInteger(job.revision ?? 0) || selected.jobRevision !== String(job.revision ?? 0)) {
    result.route = "hold";
    result.applicationKey = null;
    result.reasons.push("募集時から案件の内容が変更されています");
  }
  return { result, policy, record, person, selected, job, binding };
}

function requireOptionalApplication(value:FirebaseFirestore.DocumentData|undefined,companyId:string,jobId:string,staffId:string|undefined,workDate:string) {
  const existing=value?requireRecord(value,companyId):null;
  if(existing&&(existing.jobId!==jobId||existing.staffId!==staffId||existing.workDate!==workDate||
    !Number.isSafeInteger(existing.revision)||existing.revision<1||existing.revision>=Number.MAX_SAFE_INTEGER||
    !["review","assigned"].includes(existing.status))) {
    throw new HttpsError("failed-precondition","保存済み応募との対応を確認できません。");
  }
  return existing;
}


function publicReceipt(value: FirebaseFirestore.DocumentData, duplicate: boolean) {
  return {
    ok: true, duplicate, receiptKey: value.receiptKey, applicationId: value.applicationId ?? null,
    route: value.route, intakeOwner: value.intakeOwner,
    assignmentPerformed: false, dispatch: "disabled",
  };
}

/** 認証済みの連携実行者による受信保存。実送信・担当確定はしない。 */
export const receiveCaseMailApplication = onCall(async request => {
  const session = requireAdmin(request);
  const companyId = id.parse(companyFromClaims(session.token));
  const incoming = RecruitmentApplicationSchema.parse(request.data);
  if (incoming.companyId !== companyId) throw new HttpsError("permission-denied", "会社情報が一致しません。");
  await assertProductionOperational(companyId);
  const key = receiptKey(incoming);
  const receiptRef = db.collection("automationApplicationReceipts").doc(key);
  return db.runTransaction(async tx => {
    const [senderSnap, previousSnap] = await Promise.all([
      tx.get(scoped("automationIngestPrincipals", companyId, session.uid)),
      tx.get(receiptRef),
    ]);
    const senderResult = SenderSchema.safeParse(senderSnap.data());
    if (!senderResult.success || senderResult.data.companyId !== companyId || senderResult.data.uid !== session.uid) {
      throw new HttpsError("permission-denied", "この実行者の連携受付は有効になっていません。");
    }
    const sender = senderResult.data;
    if (previousSnap.exists) {
      const previous = requireRecord(previousSnap.data(), companyId);
      if (previous.producerId !== sender.producerId ||
          JSON.stringify(RecruitmentApplicationSchema.parse(previous.incoming)) !== JSON.stringify(incoming)) {
        throw new HttpsError("already-exists", "同じ応募記録に異なる内容があります。元の記録を確認してください。");
      }
      return publicReceipt(previous, true);
    }
    const context = await readContext(tx, companyId, incoming);
    if (context.record.producerId !== sender.producerId) throw new HttpsError("permission-denied", "募集と受信元が一致しません。");
    const result = context.result;
    const applicationRef = result.applicationKey ? db.collection("automationApplications").doc(result.applicationKey) : null;
    const applicationSnap = applicationRef ? await tx.get(applicationRef) : null;
    const existing = requireOptionalApplication(applicationSnap?.data(), companyId, result.jobId, context.person?.staffId, incoming.workDate);

    const now = Timestamp.now();
    const saved = {
      companyId, receiptKey: key, incoming, revision: 1, producerId: sender.producerId, receivedBy: session.uid,
      principalRevision: sender.revision, applicationId: result.applicationKey, route: result.route,
      intakeOwner: result.intakeOwner, policyRevision: result.policyRevision, reasons: result.reasons,
      createdAt: now,
    };
    tx.set(receiptRef, saved);
    if (applicationRef && existing?.status !== "assigned") {
      tx.set(applicationRef, {
        companyId, jobId: result.jobId, staffId: context.person!.staffId, workDate: incoming.workDate,
        status: "review", revision: (existing?.revision ?? 0) + 1, receiptKey: key,
        personRevision: context.person!.revision, createdAt: existing?.createdAt ?? now, updatedAt: now,
      });
    }
    return publicReceipt(saved, false);
  });
});

const CandidateSchema = z.object({
  companyId: id, jobId: id, staffId: id, workDate: z.string(),
  status: z.literal("review"), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  receiptKey: hash, personRevision: id,
});

/** 既存applyToJobの取引内で読む。書込みは同じ取引の担当確定と一緒に行う。 */
export async function readMailApplicationForAssignment(tx: IntakeReader, input: {
  companyId: string; staffId: string; jobId: string; applicationId: string; revision: number;
}) {
  const ref = db.collection("automationApplications").doc(hash.parse(input.applicationId));
  const snap = await tx.get(ref);
  const parsed = CandidateSchema.safeParse(snap.data());
  if (!parsed.success || parsed.data.companyId !== input.companyId || parsed.data.staffId !== input.staffId ||
      parsed.data.jobId !== input.jobId) throw new HttpsError("permission-denied", "この応募候補を確定できません。");
  const candidate = parsed.data;
  if (candidate.revision !== input.revision) throw new HttpsError("failed-precondition", "応募候補が更新されています。もう一度確認してください。",
    {reason:"mail_application_changed",accepted:false,applicationId:input.applicationId,revision:input.revision});
  const savedReceipt = requireRecord((await tx.get(db.collection("automationApplicationReceipts").doc(candidate.receiptKey))).data(), input.companyId);
  const incoming = RecruitmentApplicationSchema.parse(savedReceipt.incoming);
  if (receiptKey(incoming) !== candidate.receiptKey || savedReceipt.applicationId !== input.applicationId) {
    throw new HttpsError("failed-precondition", "応募候補の元記録を確認できません。");
  }
  const currentSender = SenderSchema.safeParse((await tx.get(scoped("automationIngestPrincipals", input.companyId, id.parse(savedReceipt.receivedBy)))).data());
  if (!currentSender.success || currentSender.data.companyId !== input.companyId || currentSender.data.uid !== savedReceipt.receivedBy ||
      currentSender.data.producerId !== savedReceipt.producerId || currentSender.data.revision !== savedReceipt.principalRevision) {
    throw new HttpsError("failed-precondition", "応募受信元の確認状態が変更されています。");
  }
  const context = await readContext(tx, input.companyId, incoming);
  if (context.policy.phase !== "app" || context.result.route !== "review" ||
      context.result.applicationKey !== input.applicationId || context.person?.staffId !== input.staffId ||
      context.person.revision !== candidate.personRevision || context.selected.workDate !== candidate.workDate ||
      savedReceipt.producerId !== context.record.producerId) {
    throw new HttpsError("failed-precondition", "受付窓口・本人・案件が変更されています。現在の状況を確認してください。");
  }
  return ref;
}

const ListApplicationsSchema = z.object({cursor:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();

/** 本人の確認待ち候補を25件ずつ取得する。受信時の判断を現在の応募可能性として表示しない。 */
export const listMyMailApplications = onCall(async request => {
  const session = requireAuth(request);
  if (session.token.role !== "staff") throw new HttpsError("permission-denied","スタッフ本人だけが確認できます。");
  const companyId = id.parse(companyFromClaims(session.token)), staffId = id.parse(staffFromClaims(session.token));
  const input = ListApplicationsSchema.parse(request.data ?? {});
  let query = db.collection("automationApplications").where("companyId","==",companyId)
    .where("staffId","==",staffId).where("status","==","review").orderBy(FieldPath.documentId()).limit(26);
  if (input.cursor) query = query.startAfter(input.cursor);
  return db.runTransaction(async tx => {
    const [staffSnap,policySnap] = await Promise.all([
      tx.get(db.collection("staffProfiles").doc(staffId)),tx.get(db.collection("automationRecruitmentPolicies").doc(companyId)),
    ]);
    const staff = staffSnap.data();
    if (staff?.companyId !== companyId || staff.active !== true) throw new HttpsError("permission-denied","スタッフの利用状態を確認できません。");
    if (!policySnap.exists) return {ok:true,mode:"not_configured",items:[],nextCursor:null};
    const policy = RecruitmentRoutingSchema.parse(requireRecord(policySnap.data(),companyId));
    if (policy.phase !== "app") return {ok:true,mode:"legacy_mail",items:[],nextCursor:null};
    const page = await tx.get(query);
    const records = page.docs.slice(0,25);
    const cache = new Map<string,Promise<FirebaseFirestore.DocumentSnapshot>>([
      ...page.docs.map(doc=>[doc.ref.path,Promise.resolve(doc)] as const),
      [staffSnap.ref.path,Promise.resolve(staffSnap)], [policySnap.ref.path,Promise.resolve(policySnap)],
    ]);
    const reader: IntakeReader = {get:ref=>{
      let value = cache.get(ref.path);
      if (!value) { value = tx.get(ref); cache.set(ref.path,value); }
      return value;
    }};
    const items = await Promise.all(records.map(async doc => {
      const candidate = CandidateSchema.parse(doc.data());
      if (candidate.companyId !== companyId || candidate.staffId !== staffId) throw new HttpsError("permission-denied","応募候補の所属が一致しません。");
      const jobData = (await reader.get(db.collection("jobs").doc(candidate.jobId))).data();
      if (jobData && jobData.companyId !== companyId) throw new HttpsError("permission-denied","案件の所属が一致しません。");
      const text = (key:string) => typeof jobData?.[key] === "string" ? jobData[key] : "";
      const job = {id:candidate.jobId,workDate:candidate.workDate,dateKey:candidate.workDate,
        clientName:text("clientName"),makerName:text("makerName"),menuName:text("menuName"),
        storeName:text("storeName"),workTime:text("workTime"),storeAddress:text("storeAddress"),
        basePay:typeof jobData?.basePay==="number"&&Number.isFinite(jobData.basePay)?jobData.basePay:null,
        status:text("status")};
      let state: "ready" | "assigned" | "needs_review" = "needs_review";
      if (jobData?.status==="assigned" && jobData.assignedStaffId===staffId && !jobData.cancelled) state="assigned";
      else if (jobData) {
        try {
          await readMailApplicationForAssignment(reader,{companyId,staffId,jobId:candidate.jobId,
            applicationId:doc.id,revision:candidate.revision});
          state="ready";
        } catch(error) {
          if (!(error instanceof z.ZodError) && !(error instanceof HttpsError &&
              ["failed-precondition","permission-denied","not-found"].includes(error.code))) throw error;
        }
      }
      return {id:doc.id,revision:candidate.revision,job,state};
    }));
    return {ok:true,mode:"app",items,nextCursor:page.docs.length>25?records.at(-1)!.id:null};
  });
});

const ReviewContextSchema = z.object({expectedCompanyId:id,expectedActorUid:id});
const HeldReceiptReadSchema = ReviewContextSchema.extend({receiptKey:hash}).strict();
const HeldReviewResultSchema=z.object({
  ok:z.literal(true),duplicate:z.literal(false),receiptKey:hash,
  receiptRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  route:z.enum(["hold","review"]),applicationId:hash.nullable(),intakeOwner:z.enum(["app","legacy_mail"]),
  assignmentPerformed:z.literal(false),dispatch:z.literal("disabled"),
}).strict();
const HeldReceiptReviewSchema = HeldReceiptReadSchema.extend({
  requestId:id,expectedReceiptRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),
  expectedReviewRevision:hash,evidenceRecordId:id,confirmedAgainstSource:z.literal(true),
}).strict();
function requireReviewScope(input:z.infer<typeof ReviewContextSchema>,companyId:string,uid:string) {
  if(input.expectedCompanyId!==companyId||input.expectedActorUid!==uid) throw new HttpsError("permission-denied","確認した会社または管理者が変更されています。");
}
function storedReceiptRevision(record:FirebaseFirestore.DocumentData) {
  return z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1).parse(record.revision??0);
}
async function readHeldReceiptContext(tx:IntakeReader,companyId:string,key:string) {
  const ref=db.collection("automationApplicationReceipts").doc(key);
  const record=requireRecord((await tx.get(ref)).data(),companyId);
  const incoming=RecruitmentApplicationSchema.parse(record.incoming);
  if(incoming.companyId!==companyId||receiptKey(incoming)!==key||record.receiptKey!==key) {
    throw new HttpsError("failed-precondition","元の応募受信記録と識別子が一致しません。");
  }
  const revision=storedReceiptRevision(record);
  if(record.route!=="hold") {
    if(record.route!=="review") throw new HttpsError("failed-precondition","受信記録の処理状態を確認できません。");
    return {ref,record,incoming,revision,context:null,sender:null,reviewRevision:null};
  }
  if(record.applicationId!=null) throw new HttpsError("failed-precondition","保留記録と応募候補の保存状態が矛盾しています。");
  const senderResult=SenderSchema.safeParse(requireRecord((await tx.get(scoped("automationIngestPrincipals",companyId,id.parse(record.receivedBy)))).data(),companyId));
  if(!senderResult.success) throw new HttpsError("failed-precondition","元の受信実行者は利用できません。連携台帳の登録状態を確認してください。");
  const sender=senderResult.data;
  if(sender.uid!==record.receivedBy||sender.producerId!==record.producerId) throw new HttpsError("failed-precondition","元の応募を受信した実行者を確認できません。");
  const context=await readContext(tx,companyId,incoming);
  if(context.record.producerId!==sender.producerId) throw new HttpsError("failed-precondition","募集と元の受信実行者が一致しません。");
  const reviewRevision=automationRecordKey(JSON.stringify({
    receiptRevision:revision,principalRevision:sender.revision,incoming,receivedBy:record.receivedBy,producerId:record.producerId,
    campaignHash:(context.record.campaign as {payloadHash:string}).payloadHash,
    policyRevision:context.policy.revision,policyPhase:context.policy.phase,bindingRevision:context.binding.revision,
    jobRevision:context.job.revision??0,personRevision:context.person?.revision??null,
    route:context.result.route,reasons:context.result.reasons,applicationKey:context.result.applicationKey,
    today:tokyoParts(new Date()).dateKey,
  }));
  return {ref,record,incoming,revision,context,sender,reviewRevision};
}

/** 保留理由と現在の照合版を管理者が確認する。氏名等から本人を推測しない。 */
export const getHeldMailApplication=onCall(async request=>{
  const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token));
  const input=HeldReceiptReadSchema.parse(request.data);requireReviewScope(input,companyId,session.uid);
  return db.runTransaction(async tx=>{
    const held=await readHeldReceiptContext(tx,companyId,input.receiptKey);
    return {ok:true,receiptKey:input.receiptKey,receiptRevision:held.revision,reviewRevision:held.reviewRevision,
      sourceRecordId:held.incoming.sourceRecordId,campaignKey:held.incoming.campaignKey,
      fixedCaseId:held.incoming.fixedCaseId,workDate:held.incoming.workDate,
      hasApplicantIdentity:held.incoming.applicantPersonKey!==null,route:held.record.route,
      current:held.context?{route:held.context.result.route,reasons:held.context.result.reasons,
        intakeOwner:held.context.result.intakeOwner,jobId:held.context.result.jobId}:null,
      assignmentPerformed:false,dispatch:"disabled"};
  });
});

/** 元の受信内容を保持した再照合。解決した本人対応だけを既存の確認候補へ回収する。 */
export const recheckHeldMailApplication=onCall(async request=>{
  const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token));
  const input=HeldReceiptReviewSchema.parse(request.data);requireReviewScope(input,companyId,session.uid);
  await assertProductionOperational(companyId);
  const {expectedCompanyId,expectedActorUid,...operation}=input;
  const inputHash=createHash("sha256").update(JSON.stringify(operation)).digest("hex");
  const eventRef=scoped("automationReceiptReviewEvents",companyId,session.uid,input.requestId);
  return db.runTransaction(async tx=>{
    const previous=(await tx.get(eventRef)).data();
    if(previous) {
      if(previous.companyId!==companyId||previous.actorUid!==session.uid||previous.inputHash!==inputHash) {
        throw new HttpsError("already-exists","同じ操作番号に異なる再照合内容があります。");
      }
      if(previous.status==="cancelled") throw new HttpsError("failed-precondition","この再照合操作は中止されています。最新の内容を確認してください。",
        {reason:"held_review_cancelled",requestId:input.requestId,receiptKey:input.receiptKey,accepted:false});
      if(previous.status!==undefined&&previous.status!=="committed") throw new HttpsError("failed-precondition","再照合操作の状態を確認できません。");
      const saved=HeldReviewResultSchema.parse(previous.result);
      if(saved.receiptKey!==input.receiptKey||previous.receiptKey!==input.receiptKey) throw new HttpsError("failed-precondition","再照合の保存結果が一致しません。");
      return {...saved,duplicate:true};
    }
    const held=await readHeldReceiptContext(tx,companyId,input.receiptKey);
    if(held.revision!==input.expectedReceiptRevision||held.reviewRevision!==input.expectedReviewRevision||
      !held.context||!held.sender) throw new HttpsError("aborted","確認後に応募や照合条件が変わっています。最新の内容を確認してください。");
    const context=held.context,result=context.result;
    const applicationRef=result.applicationKey?db.collection("automationApplications").doc(result.applicationKey):null;
    const existing=applicationRef?requireOptionalApplication((await tx.get(applicationRef)).data(),companyId,result.jobId,context.person?.staffId,held.incoming.workDate):null;
    const revision=held.revision+1,now=Timestamp.now();
    const saved={...held.record,revision,applicationId:result.applicationKey,route:result.route,
      intakeOwner:result.intakeOwner,policyRevision:result.policyRevision,reasons:result.reasons,
      principalRevision:held.sender.revision,lastReviewedAt:now,lastReviewedBy:session.uid,
      lastReviewEvidenceRecordId:input.evidenceRecordId};
    const response={ok:true,duplicate:false,receiptKey:input.receiptKey,receiptRevision:revision,
      route:result.route,applicationId:result.applicationKey,intakeOwner:result.intakeOwner,
      assignmentPerformed:false,dispatch:"disabled"};
    tx.set(held.ref,saved);
    if(applicationRef&&existing?.status!=="assigned") {
      tx.set(applicationRef,{companyId,jobId:result.jobId,staffId:context.person!.staffId,workDate:held.incoming.workDate,
        status:"review",revision:(existing?.revision??0)+1,receiptKey:input.receiptKey,personRevision:context.person!.revision,
        createdAt:existing?.createdAt??now,updatedAt:now});
    }
    tx.set(eventRef,{companyId,actorUid:session.uid,inputHash,evidenceRecordId:input.evidenceRecordId,
      receiptKey:input.receiptKey,previousReceiptRevision:held.revision,previousRoute:held.record.route,status:"committed",
      previousReasons:z.array(z.string()).parse(held.record.reasons),reviewRevision:held.reviewRevision,result:response,createdAt:now});
    return response;
  });
});

const HeldReceiptListSchema=ReviewContextSchema.extend({cursor:hash.optional()}).strict();
/** 保存された保留記録を25件ずつ表示する。現在の解決可否は個別確認で再照合する。 */
export const listHeldMailApplications=onCall(async request=>{
  const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token));
  const input=HeldReceiptListSchema.parse(request.data);requireReviewScope(input,companyId,session.uid);
  let query=db.collection("automationApplicationReceipts").where("companyId","==",companyId)
    .where("route","==","hold").orderBy(FieldPath.documentId()).limit(26);
  if(input.cursor)query=query.startAfter(input.cursor);
  return db.runTransaction(async tx=>{
    const page=await tx.get(query);
    const items=page.docs.slice(0,25).map(doc=>{
      const record=requireRecord(doc.data(),companyId),incoming=RecruitmentApplicationSchema.parse(record.incoming);
      if(record.route!=="hold"||record.applicationId!=null||incoming.companyId!==companyId||
        record.receiptKey!==doc.id||receiptKey(incoming)!==doc.id) {
        throw new HttpsError("failed-precondition","保留一覧に照合できない受信記録があります。");
      }
      return {receiptKey:doc.id,receiptRevision:storedReceiptRevision(record),sourceRecordId:incoming.sourceRecordId,
        campaignKey:incoming.campaignKey,fixedCaseId:incoming.fixedCaseId,workDate:incoming.workDate,
        hasApplicantIdentity:incoming.applicantPersonKey!==null,reasons:z.array(z.string().max(500)).max(20).parse(record.reasons)};
    });
    return {ok:true,items,nextCursor:page.docs.length>25?items.at(-1)!.receiptKey:null};
  });
});

/** 未確定の再照合だけを中止する。完了済みの候補や受信履歴は巻き戻さない。 */
export const cancelHeldMailApplicationReview=onCall(async request=>{
  const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token));
  const input=HeldReceiptReviewSchema.parse(request.data);requireReviewScope(input,companyId,session.uid);
  await assertProductionOperational(companyId);
  const {expectedCompanyId,expectedActorUid,...operation}=input;
  const inputHash=createHash("sha256").update(JSON.stringify(operation)).digest("hex");
  const eventRef=scoped("automationReceiptReviewEvents",companyId,session.uid,input.requestId);
  return db.runTransaction(async tx=>{
    const previous=(await tx.get(eventRef)).data();
    if(previous){
      if(previous.companyId!==companyId||previous.actorUid!==session.uid||previous.inputHash!==inputHash||previous.receiptKey!==input.receiptKey) {
        throw new HttpsError("already-exists","同じ操作番号に異なる再照合内容があります。");
      }
      if(previous.status==="cancelled") return {ok:true,requestId:input.requestId,receiptKey:input.receiptKey,outcome:"cancelled"};
      if(previous.status!==undefined&&previous.status!=="committed") throw new HttpsError("failed-precondition","再照合操作の状態を確認できません。");
      const saved=HeldReviewResultSchema.parse(previous.result);
      if(saved.receiptKey!==input.receiptKey) throw new HttpsError("failed-precondition","再照合の保存結果が一致しません。");
      return {ok:true,requestId:input.requestId,receiptKey:input.receiptKey,outcome:"committed",result:saved};
    }
    tx.set(eventRef,{companyId,actorUid:session.uid,inputHash,receiptKey:input.receiptKey,status:"cancelled",
      evidenceRecordId:input.evidenceRecordId,createdAt:Timestamp.now()});
    return {ok:true,requestId:input.requestId,receiptKey:input.receiptKey,outcome:"cancelled"};
  });
});
