import { createHash, randomUUID } from "node:crypto";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "./firebase";
import { companyFromClaims, requireAdmin } from "./utils";
import { assertProductionOperational } from "./system-safety";
import { AutomationBindingSchema, prepareAutomationHandoff } from "./automation-bridge-core";
import { RecruitmentRoutingSchema } from "./automation-recruitment-core";
import { automationRecordKey } from "./automation-intake";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

const operationContext = {expectedCompanyId:id.optional(),expectedActorUid:id.optional()};
function assertRegistryContext(input:{expectedCompanyId?:string;expectedActorUid?:string},companyId:string,uid:string){
  if((input.expectedCompanyId!==undefined||input.expectedActorUid!==undefined)&&
      (input.expectedCompanyId!==companyId||input.expectedActorUid!==uid)){
    throw new HttpsError("permission-denied","確認した会社または管理者が変更されています。台帳画面を開き直してください。");
  }
}
function registryInputHash(input:object){
  // 照合用の所属指定は権限確認にだけ使い、既存要求の再実行ハッシュを変えない。
  const {expectedCompanyId,expectedActorUid,...operation}=input as Record<string,unknown>;
  return createHash("sha256").update(JSON.stringify(operation)).digest("hex");
}

const common = {
  ...operationContext,
  requestId: id, expectedRevision: id.nullable(), evidenceRecordId: id,
  confirmedAgainstSource: z.literal(true),
};
const InputSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("principal"), producerId: id, active: z.boolean() }).strict(),
  z.object({ ...common, kind: z.literal("routing"), phase: z.enum(["mail_bridge", "app"]),
    sourceMailCreationStopped: z.literal(true).optional(), oldRepliesRetained: z.literal(true).optional() }).strict(),
  z.object({ ...common, kind: z.literal("person"), staffId: id, personKey: hash, active: z.boolean() }).strict(),
  z.object({ ...common, kind: z.literal("binding"), jobId: id,
    jobRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    fixedCaseId: id, assignment: z.object({staffId:id,personKey:hash,proofEpoch:id}).strict().nullable() }).strict(),
]);
const scoped = (name: string, ...parts: string[]) => db.collection(name).doc(automationRecordKey(...parts));
function fail(message: string): never { throw new HttpsError("failed-precondition", message); }
function own(value: FirebaseFirestore.DocumentData | undefined, companyId: string) {
  if (value && value.companyId !== companyId) fail("別の所属の記録が含まれています。");
  return value;
}
function unchanged(value: FirebaseFirestore.DocumentData | undefined, expected: string | null) {
  if (value && !id.safeParse(value.revision).success) fail("保存済みの確認版を読み取れません。");
  if ((value?.revision ?? null) !== expected) throw new HttpsError("aborted", "確認後に登録内容が変わっています。再確認してください。");
}

/** 管理者の原本照合を記録する。外部原本の自動検証・連携開始・送信は行わない。 */
export const saveAutomationRegistry = onCall(async request => {
  const session = requireAdmin(request);
  const companyId = id.parse(companyFromClaims(session.token));
  const input = InputSchema.parse(request.data);
  assertRegistryContext(input,companyId,session.uid);
  await assertProductionOperational(companyId);
  const revision = randomUUID();
  const eventRef = scoped("automationRegistryEvents", companyId, session.uid, input.requestId);
  const inputHash = registryInputHash(input);
  return db.runTransaction(async tx => {
    const event = own((await tx.get(eventRef)).data(), companyId);
    if (event) {
      if (event.actorUid !== session.uid || event.inputHash !== inputHash || event.kind !== input.kind) {
        throw new HttpsError("already-exists", "同じ操作番号の確認内容が異なります。");
      }
      if (event.status === "cancelled") throw new HttpsError("failed-precondition","この登録操作は中止されています。最新の内容を確認してください。",
        {reason:"registry_attempt_cancelled",requestId:input.requestId,accepted:false});
      if (event.status !== undefined && event.status !== "committed") fail("登録操作の状態を確認できません。");
      return { ok: true, kind: input.kind, revision: id.parse(event.revision), duplicate: true };
    }
    const now = Timestamp.now();
    const writes: {ref: FirebaseFirestore.DocumentReference; value: FirebaseFirestore.DocumentData}[] = [];
    const metadata = { verification: "verified", verificationMethod: "admin-source-confirmation",
      evidenceRecordId: input.evidenceRecordId, verifiedBy: session.uid, verifiedAt: now };
    if (input.kind === "principal") {
      const ref = scoped("automationIngestPrincipals", companyId, session.uid);
      const old = own((await tx.get(ref)).data(), companyId);
      unchanged(old, input.expectedRevision);
      if (old && (old.uid !== session.uid || old.producerId !== input.producerId)) fail("受信元の変更には別の実行者と履歴の確認が必要です。");
      writes.push({ref,value:{companyId,uid:session.uid,producerId:input.producerId,active:input.active,revision,...metadata}});
    } else if (input.kind === "routing") {
      const ref = db.collection("automationRecruitmentPolicies").doc(companyId);
      const old = own((await tx.get(ref)).data(), companyId);
      unchanged(old, input.expectedRevision);
      if (input.phase === "app" && (!input.sourceMailCreationStopped || !input.oldRepliesRetained)) {
        fail("元の募集作成の停止と、過去メールへの返信回収を確認してください。");
      }
      if (old?.phase === "app" && input.phase !== "app") fail("メール募集の再開には別途切替確認が必要です。");
      writes.push({ref,value:RecruitmentRoutingSchema.parse({version:1,companyId,revision,phase:input.phase,noticeOwner:"notice_control"})});
    } else if (input.kind === "person") {
      const ownerRef = scoped("automationPersonOwners", companyId, input.staffId);
      const personRef = scoped("automationPeople", companyId, input.personKey);
      const [ownerSnap, personSnap, staffSnap] = await Promise.all([
        tx.get(ownerRef),tx.get(personRef),tx.get(db.collection("staffProfiles").doc(input.staffId)),
      ]);
      const owner = own(ownerSnap.data(),companyId);
      const person = own(personSnap.data(),companyId);
      const staff = own(staffSnap.data(),companyId);
      unchanged(owner,input.expectedRevision);
      if (!staff || (input.active && staff.active !== true)) fail("現在のスタッフ利用状態を確認してください。");
      if (owner && owner.staffId !== input.staffId) fail("本人対応の保存記録が一致しません。");
      if (person && (person.staffId !== input.staffId || person.personKey !== input.personKey)) fail("この本人識別は別のスタッフに登録されています。");
      if (owner && owner.personKey !== input.personKey) {
        const oldRef = scoped("automationPeople",companyId,hash.parse(owner.personKey));
        const old = own((await tx.get(oldRef)).data(),companyId);
        if (!old || old.staffId !== input.staffId || old.revision !== owner.revision) fail("前の本人対応を確認できません。");
        writes.push({ref:oldRef,value:{...old,active:false,revision,retiredAt:now}});
      } else if (owner && (!person || person.revision !== owner.revision)) fail("本人対応の保存版が一致しません。");
      writes.push({ref:personRef,value:{companyId,staffId:input.staffId,personKey:input.personKey,active:input.active,revision,...metadata}});
      writes.push({ref:ownerRef,value:{companyId,staffId:input.staffId,personKey:input.personKey,active:input.active,revision}});
    } else {
      const bindingRef = scoped("automationBindings",companyId,input.jobId);
      const [bindingSnap,jobSnap] = await Promise.all([tx.get(bindingRef),tx.get(db.collection("jobs").doc(input.jobId))]);
      const old = own(bindingSnap.data(),companyId);
      const job = own(jobSnap.data(),companyId);
      unchanged(old,input.expectedRevision);
      if (!job || (job.revision ?? 0) !== input.jobRevision) fail("確認後に案件が変更されています。");
      const binding = AutomationBindingSchema.parse({version:1,companyId,jobId:input.jobId,appCaseId:job.caseId,
        spreadsheetId:job.sheetRef?.spreadsheetId,fixedCaseId:input.fixedCaseId,workDate:job.dateKey,revision,assignment:input.assignment});
      if (old && ["jobId","appCaseId","spreadsheetId","fixedCaseId"].some(key=>old[key]!==binding[key as keyof typeof binding])) {
        fail("元表・固定IDの差替えには既存履歴の移行確認が必要です。");
      }
      prepareAutomationHandoff({companyId,binding,job:{...job,id:input.jobId},revision:String(input.jobRevision)});
      const ownerRef = scoped("automationBindingOwners",companyId,binding.spreadsheetId,binding.fixedCaseId);
      const owner = own((await tx.get(ownerRef)).data(),companyId);
      if (owner && (owner.jobId !== input.jobId || owner.spreadsheetId !== binding.spreadsheetId ||
          owner.fixedCaseId !== binding.fixedCaseId || !old || owner.revision !== old.revision)) fail("この固定IDは他の案件に登録済み、または保存版が一致しません。");
      if (input.assignment) {
        const [personSnap,personOwnerSnap,staffSnap] = await Promise.all([
          tx.get(scoped("automationPeople",companyId,input.assignment.personKey)),
          tx.get(scoped("automationPersonOwners",companyId,input.assignment.staffId)),
          tx.get(db.collection("staffProfiles").doc(input.assignment.staffId)),
        ]);
        const person = own(personSnap.data(),companyId), personOwner = own(personOwnerSnap.data(),companyId), staff = own(staffSnap.data(),companyId);
        if (!person || person.staffId !== input.assignment.staffId || person.personKey !== input.assignment.personKey ||
            person.active !== true || person.verification !== "verified" || !personOwner || personOwner.active !== true ||
            personOwner.staffId !== input.assignment.staffId || personOwner.personKey !== person.personKey || personOwner.revision !== person.revision || staff?.active !== true) fail("確定担当者の本人対応を確認できません。");
      }
      writes.push({ref:bindingRef,value:binding});
      writes.push({ref:ownerRef,value:{companyId,jobId:input.jobId,spreadsheetId:binding.spreadsheetId,fixedCaseId:binding.fixedCaseId,revision}});
    }
    // 全ての検査と読取りを終えた後、対応表・一意な所有記録・再実行履歴を同時に保存する。
    for (const write of writes) tx.set(write.ref,write.value);
    tx.set(eventRef,{companyId,actorUid:session.uid,kind:input.kind,revision,inputHash,status:"committed",
      evidenceRecordId:input.evidenceRecordId,verificationMethod:"admin-source-confirmation",createdAt:now});
    return {ok:true,kind:input.kind,revision,duplicate:false};
  });
});


/** 結果不明の登録を解決する。保存済みなら結果を返し、未確定なら再実行を止める記録を残す。 */
export const cancelAutomationRegistryAttempt = onCall(async request => {
  const session = requireAdmin(request);
  const companyId = id.parse(companyFromClaims(session.token));
  const input = InputSchema.parse(request.data);
  assertRegistryContext(input,companyId,session.uid);
  await assertProductionOperational(companyId);
  const eventRef = scoped("automationRegistryEvents",companyId,session.uid,input.requestId);
  const inputHash = registryInputHash(input);
  return db.runTransaction(async tx => {
    const event = own((await tx.get(eventRef)).data(),companyId);
    if (event) {
      if (event.actorUid !== session.uid || event.inputHash !== inputHash || event.kind !== input.kind) {
        throw new HttpsError("already-exists","同じ操作番号の確認内容が異なります。");
      }
      if (event.status === "cancelled") return {ok:true,kind:input.kind,outcome:"cancelled",requestId:input.requestId};
      if (event.status !== undefined && event.status !== "committed") fail("登録操作の状態を確認できません。");
      return {ok:true,kind:input.kind,outcome:"committed",requestId:input.requestId,revision:id.parse(event.revision)};
    }
    tx.set(eventRef,{companyId,actorUid:session.uid,kind:input.kind,inputHash,status:"cancelled",
      evidenceRecordId:input.evidenceRecordId,createdAt:Timestamp.now()});
    return {ok:true,kind:input.kind,outcome:"cancelled",requestId:input.requestId};
  });
});

const ReadSchema = z.discriminatedUnion("kind", [
  z.object({...operationContext,kind:z.literal("principal")}).strict(),
  z.object({...operationContext,kind:z.literal("routing")}).strict(),
  z.object({...operationContext,kind:z.literal("person"),staffId:id}).strict(),
  z.object({...operationContext,kind:z.literal("binding"),jobId:id}).strict(),
]);

/** 登録画面で必要な現在版と選択対象だけを返す。会社全体の対応表は列挙しない。 */
export const getAutomationRegistry = onCall(async request => {
  const session = requireAdmin(request);
  const companyId = id.parse(companyFromClaims(session.token));
  const input = ReadSchema.parse(request.data);
  assertRegistryContext(input,companyId,session.uid);
  return db.runTransaction(async tx => {
    if (input.kind === "binding") {
      const [bindingSnap,jobSnap] = await Promise.all([
        tx.get(scoped("automationBindings",companyId,input.jobId)),tx.get(db.collection("jobs").doc(input.jobId)),
      ]);
      const binding = own(bindingSnap.data(),companyId), job = own(jobSnap.data(),companyId);
      if (!job) throw new HttpsError("not-found","案件が見つかりません。");
      return {ok:true,kind:input.kind,record:binding?AutomationBindingSchema.parse(binding):null,
        source:{jobId:input.jobId,jobRevision:job.revision??0,caseId:job.caseId??null,workDate:job.dateKey??null,
          storeName:typeof job.storeName==="string"?job.storeName:"",spreadsheetId:job.sheetRef?.spreadsheetId??null,
          assignedStaffId:job.assignedStaffId??null}};
    }
    if (input.kind === "person") {
      const [ownerSnap,staffSnap] = await Promise.all([
        tx.get(scoped("automationPersonOwners",companyId,input.staffId)),tx.get(db.collection("staffProfiles").doc(input.staffId)),
      ]);
      const owner = own(ownerSnap.data(),companyId), staff = own(staffSnap.data(),companyId);
      if (!staff) throw new HttpsError("not-found","スタッフが見つかりません。");
      return {ok:true,kind:input.kind,record:owner?{staffId:id.parse(owner.staffId),personKey:hash.parse(owner.personKey),
        revision:id.parse(owner.revision),active:owner.active===true}:null,
        source:{staffId:input.staffId,displayName:typeof staff.displayName==="string"?staff.displayName:"",active:staff.active===true}};
    }
    const ref = input.kind === "principal" ? scoped("automationIngestPrincipals",companyId,session.uid) :
      db.collection("automationRecruitmentPolicies").doc(companyId);
    const saved = own((await tx.get(ref)).data(),companyId);
    const record = !saved ? null : input.kind==="routing" ? RecruitmentRoutingSchema.parse(saved) :
      {uid:id.parse(saved.uid),producerId:id.parse(saved.producerId),revision:id.parse(saved.revision),active:saved.active===true};
    return {ok:true,kind:input.kind,record};
  });
});
