import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { hashText, createJobIdFromPersistedCaseId } from "./case-id";
import { allocateAdminJobGroup, stageAdminJobGroup } from "./job-group-creation";
import { AdminJobInput } from "./job-management-core";

type Kind = "create" | "duplicate";
const envelopeSchema = z.object({ nativeCreation: z.object({
  operationId: z.string().uuid(), expectedCompanyId: z.string().min(1).max(200),
  expectedActorUid: z.string().min(1).max(200), action: z.enum(["create", "cancel"]),
  input: z.record(z.string(), z.unknown()),
}).strict() }).strict();
const resultSchema = z.object({
  groupId: z.string().min(1), jobIds: z.array(z.string().min(1)).min(1).max(20),
  sourceReady: z.literal(false), publication: z.record(z.string(), z.unknown()),
  rowCreationQueued: z.boolean(), rowCreationQueueId: z.string().nullable(), warning: z.string(),
}).strict();
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  throw new HttpsError("invalid-argument", "作成内容を確認できません。");
}
function invalidReceipt(): never { throw new HttpsError("failed-precondition", "保存済みの作成記録と案件を照合できません。管理者による確認が必要です。"); }

// 案件・原本追加キュー・監査・受領記録を同じ取引で確定する。取消は未確定の依頼だけを閉じる。
export async function createNativeJobGroup(raw: unknown, companyId: string, actorUid: string, kind: Kind,
  prepare: (input: Record<string, unknown>, tx: FirebaseFirestore.Transaction) => Promise<{
    input: AdminJobInput; sourceJobId?: string; extraFields?: FirebaseFirestore.DocumentData;
  }>) {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) throw new HttpsError("invalid-argument", "作成依頼の形式を確認できません。");
  const command = parsed.data.nativeCreation;
  if (command.expectedCompanyId !== companyId || command.expectedActorUid !== actorUid)
    throw new HttpsError("permission-denied", "会社またはログインが切り替わりました。元のログインで結果を確認してください。");
  const encoded = canonical(command.input);
  if (encoded.length > 20000) throw new HttpsError("invalid-argument", "作成内容が長すぎます。");
  const inputHash = hashText(encoded, 64);
  const receiptId = hashText(JSON.stringify([companyId, command.operationId]), 64);
  const receiptRef = db.collection("nativeJobCreationReceipts").doc(receiptId);
  const binding = { version: 1, operationId: command.operationId, companyId, actorUid, kind };
  return db.runTransaction(async tx => {
    const stored = await tx.get(receiptRef);
    if (stored.exists) {
      const receipt = stored.data()!;
      if (Object.entries(binding).some(([key, value]) => receipt[key] !== value) || receipt.inputHash !== inputHash)
        throw new HttpsError("failed-precondition", "同じ作成依頼の内容または担当者が一致しません。");
      if (receipt.status === "cancelled") return { nativeCreationReceipt: { ...binding, status: "cancelled" }, replayed: true };
      const saved = resultSchema.safeParse(receipt.result);
      if (receipt.status !== "committed" || !saved.success) invalidReceipt();
      const result = saved.data;
      if (new Set(result.jobIds).size !== result.jobIds.length || !Array.isArray(receipt.caseIds) || receipt.caseIds.length !== result.jobIds.length) invalidReceipt();
      const group = (await tx.get(db.collection("jobGroups").doc(result.groupId))).data();
      if (!group || group.companyId !== companyId || group.nativeCreationReceiptId !== receiptId || JSON.stringify(group.jobIds) !== JSON.stringify(result.jobIds)) invalidReceipt();
      for (let index = 0; index < result.jobIds.length; index++) {
        const job = (await tx.get(db.collection("jobs").doc(result.jobIds[index]!))).data();
        if (!job || job.companyId !== companyId || job.groupId !== result.groupId || job.caseId !== receipt.caseIds[index] || job.nativeCreationReceiptId !== receiptId || createJobIdFromPersistedCaseId(companyId, job.caseId) !== result.jobIds[index]) invalidReceipt();
      }
      return { ...result, nativeCreationReceipt: { ...binding, status: "committed" }, replayed: true };
    }
    const now = Timestamp.now();
    if (command.action === "cancel") {
      tx.create(receiptRef, { ...binding, inputHash, status: "cancelled", createdAt: now });
      return { nativeCreationReceipt: { ...binding, status: "cancelled" }, replayed: false };
    }
    const prepared = await prepare(command.input, tx);
    const feature = (await tx.get(db.collection("companyFeatureSettings").doc(companyId))).data();
    const mapping = (await tx.get(db.collection("companies").doc(companyId).collection("sheetMappings").doc("shift"))).data();
    const configured = feature?.adminJobCreationSourceReady === true && mapping?.enabled === true && mapping?.rowCreation?.enabled === true;
    const allocation = allocateAdminJobGroup(companyId, prepared.input.workDate, prepared.input.slots);
    if (kind === "duplicate") allocation.jobs = allocation.jobs.map(job => {
      const caseId = job.caseId.replace("LKC-ADMIN-", "LKC-DUP-");
      return { caseId, id: createJobIdFromPersistedCaseId(companyId, caseId) };
    });
    const writer = { set(ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData) {
      const extra = ref.parent.id === "jobs" ? {
        ...prepared.extraFields, ...(kind === "duplicate" ? { source: { type: "admin_duplicate", sourceJobId: prepared.sourceJobId, createdBy: actorUid } } : {}),
      } : ref.parent.id === "jobGroups" && kind === "duplicate" ? { duplicatedFromJobId: prepared.sourceJobId } : {};
      tx.create(ref, { ...data, ...extra, nativeCreationReceiptId: receiptId });
    } };
    const result = stageAdminJobGroup(writer, { companyId, actorUid, input: prepared.input, ...allocation,
      rowQueueId: configured ? db.collection("sheetRowCreateQueue").doc().id : null, now });
    tx.create(db.collection("auditLogs").doc(), { companyId, actorUid, action: kind === "create" ? "job.group.create" : "job.group.duplicate",
      detail: { groupId: result.groupId, jobIds: result.jobIds, slots: prepared.input.slots, publicationMode: prepared.input.publicationMode,
        ...(prepared.sourceJobId ? { sourceJobId: prepared.sourceJobId } : {}) }, requestId: command.operationId, createdAt: now });
    tx.create(receiptRef, { ...binding, inputHash, status: "committed", result, caseIds: allocation.jobs.map(job => job.caseId), createdAt: now });
    return { ...result, nativeCreationReceipt: { ...binding, status: "committed" }, replayed: false };
  });
}
