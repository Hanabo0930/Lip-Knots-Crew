import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { hasCaseMailCollision } from "./case-mail-collision";
import { hashText } from "./case-id";
import { AdminJobInput } from "./job-management-core";
import { allocateAdminJobGroup, stageAdminJobGroup } from "./job-group-creation";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().min(1);
const CommandSchema = z.object({
  receiptId: id, candidateId: id, expectedReceiptRevision: revision, expectedRevision: revision, operationId: id,
}).strict();
const RequestSchema = z.object({ mailIntake: CommandSchema, expectedCompanyId: id.optional(), expectedActorUid: id.optional() }).strict();
const ReceiptSchema = z.object({
  version: z.literal(1), companyId: id, messageId: id, revision,
  status: z.enum(["ready", "review", "cancelled"]),
  verification: z.literal("verified"), structuralComplete: z.literal(true), kind: z.literal("new"),
  sourceFingerprint: hash, ingestedBy: id, producerId: id, principalRevision: id,
  candidateIds: z.array(id).min(1).max(1000),
  parts: z.array(z.object({ partId: id, sha256: hash })).min(1).max(500),
});
const CandidateSchema = z.object({
  version: z.literal(1), companyId: id, receiptId: id, messageId: id, revision,
  status: z.enum(["ready", "linked", "review", "cancelled"]), sourceFingerprint: hash,
  importVersion: revision,
  source: z.object({ partId: id, rowKey: z.string().min(1).max(500).regex(/^[^\r\n]+$/), unitIndex: z.number().int().min(0).max(99), sha256: hash }).strict(),
  input: z.record(z.string(), z.unknown()),
}).passthrough();
const SavedSchema = z.object({
  companyId: id, status: z.literal("committed"), command: CommandSchema, sourceKey: hash, payloadHash: hash,
  jobId: id, caseId: id, groupId: id, completedCandidateRevision: revision,
  result: z.object({
    groupId: id, jobIds: z.array(id).length(1), sourceReady: z.literal(false),
    publication: z.record(z.string(), z.unknown()), rowCreationQueued: z.boolean(),
    rowCreationQueueId: id.nullable(), warning: z.string(),
  }),
});
function fail(message: string): never { throw new HttpsError("failed-precondition", message); }
export const caseMailRecordKey = (...parts: unknown[]) => hashText(JSON.stringify(parts), 64);

async function committedResult(tx: FirebaseFirestore.Transaction, raw: unknown, companyId: string) {
  const parsed = SavedSchema.safeParse(raw);
  if (!parsed.success || parsed.data.companyId !== companyId) fail("保存済み操作の会社・結果を確認してください。");
  const saved = parsed.data;
  const [jobSnap, ownerSnap, groupSnap] = await Promise.all([
    tx.get(db.collection("jobs").doc(saved.jobId)),
    tx.get(db.collection("caseMailJobSources").doc(saved.sourceKey)),
    tx.get(db.collection("jobGroups").doc(saved.groupId)),
  ]);
  const job = jobSnap.data(), owner = ownerSnap.data(), group = groupSnap.data();
  if (!job || job.companyId !== companyId || job.caseId !== saved.caseId || job.groupId !== saved.groupId ||
      job.mailIntake?.sourceKey !== saved.sourceKey || !owner || owner.companyId !== companyId ||
      owner.jobId !== saved.jobId || owner.caseId !== saved.caseId || owner.payloadHash !== saved.payloadHash ||
      !group || group.companyId !== companyId || JSON.stringify(group.jobIds) !== JSON.stringify([saved.jobId]) ||
      saved.result.groupId !== saved.groupId || saved.result.jobIds[0] !== saved.jobId) {
    fail("保存済み案件と受信元の対応が不整合です。新規作成せず確認してください。");
  }
  return { ...saved.result, replayed: true, resultIsCreationReceipt: true };
}

/** サーバー受信記録だけを利用する。クライアントの解析JSONを登録根拠にしない。 */
export async function createCaseMailJobGroup(
  data: unknown, companyId: string, actorUid: string, normalize: (raw: unknown) => AdminJobInput,
) {
  id.parse(companyId);
  const { mailIntake: command, expectedCompanyId, expectedActorUid } = RequestSchema.parse(data);
  if ((expectedCompanyId !== undefined || expectedActorUid !== undefined) &&
      (expectedCompanyId !== companyId || expectedActorUid !== actorUid)) fail("ログイン情報が変更されています。画面を開き直してください。");
  const operationRecordId = caseMailRecordKey("case-mail-create", companyId, command.operationId);
  const operationRef = db.collection("caseMailJobCreates").doc(operationRecordId);
  return db.runTransaction(async tx => {
    const previous = (await tx.get(operationRef)).data();
    if (previous) {
      const savedCommand = CommandSchema.safeParse(previous.command);
      if (!savedCommand.success || Object.entries(command).some(([key, value]) => savedCommand.data[key as keyof typeof command] !== value)) fail("同じ操作IDに別の依頼・確認版が指定されています。");
      // 作成後の担当変更・取消を巻き戻さず、元の作成受領結果だけを返す。
      return committedResult(tx, previous, companyId);
    }
    const candidateRef = db.collection("caseMailIntakeCandidates").doc(command.candidateId);
    const [receiptSnap, candidateSnap, featureSnap, mappingSnap] = await Promise.all([
      tx.get(db.collection("caseMailIntakeReceipts").doc(command.receiptId)),
      tx.get(candidateRef),
      tx.get(db.collection("companyFeatureSettings").doc(companyId)),
      tx.get(db.doc("companies/" + companyId + "/sheetMappings/shift")),
    ]);
    const receiptResult = ReceiptSchema.safeParse(receiptSnap.data());
    const candidateResult = CandidateSchema.safeParse(candidateSnap.data());
    if (!receiptResult.success || !candidateResult.success) fail("検証済みの受信記録・解析候補がありません。プレビューだけでは登録できません。");
    const receipt = receiptResult.data, candidate = candidateResult.data;
    if (receipt.companyId !== companyId || candidate.companyId !== companyId ||
        candidate.receiptId !== command.receiptId || candidate.messageId !== receipt.messageId ||
        candidate.sourceFingerprint !== receipt.sourceFingerprint || receipt.status !== "ready" ||
        receipt.revision !== command.expectedReceiptRevision ||
        new Set(receipt.candidateIds).size !== receipt.candidateIds.length ||
        !receipt.candidateIds.includes(command.candidateId) ||
        new Set(receipt.parts.map(part => part.partId)).size !== receipt.parts.length ||
        !receipt.parts.some(part => part.partId === candidate.source.partId && part.sha256 === candidate.source.sha256)) {
      fail("会社・受信元・全文取得・確認版が一致しません。確認待ちとして再照合してください。");
    }
    const principal = (await tx.get(db.collection("automationIngestPrincipals")
      .doc(caseMailRecordKey(companyId, receipt.ingestedBy)))).data();
    if (!principal || principal.companyId !== companyId || principal.uid !== receipt.ingestedBy ||
        principal.active !== true || principal.producerId !== receipt.producerId || principal.revision !== receipt.principalRevision) {
      fail("受信実行者の登録・有効状態・確認版が一致しません。");
    }
    if (candidate.targetBinding !== undefined) fail("この受信候補は既存案件への対応記録があります。新規作成できません。");
    const input = normalize(candidate.input);
    const date = new Date(input.workDate + "T00:00:00Z");
    if (input.slots !== 1 || input.basePay !== null || input.publicationMode !== "draft" || input.publishAt !== null ||
        input.workDate < "2026-10-01" || !/^\d{4}-\d{2}-\d{2}$/.test(input.workDate) ||
        !Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== input.workDate) {
      fail("受信案件は対象月以降の1名枠・下書きとして確認してください。給与・公開予約は受信から設定できません。");
    }
    // 日付は内容照合に含め、所有キーからは除く。同じ原文位置の日付変更を別案件として追加しない。
    const sourceKey = caseMailRecordKey("case-mail-source", companyId, receipt.messageId,
      candidate.source.partId, candidate.source.rowKey, candidate.source.unitIndex);
    const payloadHash = caseMailRecordKey(receipt.sourceFingerprint, candidate.importVersion, candidate.source, input);
    const ownerRef = db.collection("caseMailJobSources").doc(sourceKey);
    const owner = (await tx.get(ownerRef)).data();
    if (owner) {
      if (owner.companyId !== companyId || owner.receiptId !== command.receiptId || owner.candidateId !== command.candidateId ||
          owner.payloadHash !== payloadHash || owner.sourceRevision !== command.expectedRevision ||
          candidate.status !== "linked" || candidate.revision !== owner.completedCandidateRevision ||
          candidate.linkedJobId !== owner.jobId || typeof owner.operationRecordId !== "string") {
        fail("同じ受信元に変更・取消・減枠または別の対応があります。新規追加せず確認してください。");
      }
      return committedResult(tx, (await tx.get(db.collection("caseMailJobCreates").doc(owner.operationRecordId))).data(), companyId);
    }
    if (candidate.status !== "ready" || candidate.revision !== command.expectedRevision) fail("候補の状態・確認版が変わっています。");
    if (featureSnap.data()?.caseMailJobCreationEnabled !== true) fail("受信案件の登録は未有効です。");
    if (await hasCaseMailCollision(tx, companyId, command.receiptId, input.workDate, input.storeName, false)) {
      fail("同日・同店の別案件または別受信候補があります。追加せず確認してください。");
    }
    const mapping = mappingSnap.data();
    const rowCreationConfigured = featureSnap.data()?.adminJobCreationSourceReady === true &&
      mapping?.enabled === true && mapping?.rowCreation?.enabled === true;
    const allocation = allocateAdminJobGroup(companyId, input.workDate, 1, true);
    const job = allocation.jobs[0]!;
    const rowQueueId = rowCreationConfigured ? db.collection("sheetRowCreateQueue").doc().id : null;
    const auditRef = db.collection("auditLogs").doc(operationRecordId);
    const refs = [db.collection("jobs").doc(job.id), db.collection("jobGroups").doc(allocation.groupId), auditRef];
    if (rowQueueId) refs.push(db.collection("sheetRowCreateQueue").doc(rowQueueId));
    const collisions = await Promise.all(refs.map(ref => tx.get(ref)));
    if (collisions.some(snap => snap.exists)) fail("予定IDに既存記録があります。上書きせず確認してください。");
    const now = Timestamp.now();
    const origin = { sourceKey, receiptId: command.receiptId, candidateId: command.candidateId, operationId: command.operationId };
    const result = stageAdminJobGroup(tx, { ...allocation, companyId, actorUid, input, rowQueueId, now, mailIntake: origin });
    const completedCandidateRevision = candidate.revision + 1;
    tx.set(candidateRef, { status: "linked", revision: completedCandidateRevision, linkedJobId: job.id,
      operationRecordId, updatedAt: now }, { merge: true });
    tx.set(ownerRef, { companyId, receiptId: command.receiptId, candidateId: command.candidateId,
      messageId: receipt.messageId, source: candidate.source, workDate: input.workDate,
      jobId: job.id, caseId: job.caseId, payloadHash, sourceRevision: command.expectedRevision,
      completedCandidateRevision, operationRecordId, createdAt: now });
    tx.set(operationRef, { companyId, status: "committed", command, sourceKey, payloadHash,
      jobId: job.id, caseId: job.caseId, groupId: allocation.groupId, completedCandidateRevision, result, actorUid, createdAt: now });
    tx.set(auditRef, { companyId, actorUid, action: "job.group.create", requestId: operationRecordId,
      detail: { groupId: allocation.groupId, jobIds: [job.id], slots: 1, publicationMode: "draft", ...origin }, createdAt: now });
    return { ...result, replayed: false, resultIsCreationReceipt: true };
  });
}
