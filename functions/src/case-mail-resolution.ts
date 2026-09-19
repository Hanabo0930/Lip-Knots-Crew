import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { requireAdmin, companyFromClaims } from "./utils";
import { assertProductionOperational } from "./system-safety";
import { caseMailRecordKey } from "./case-mail-job-creation";
import { caseMailReviewAccepted, caseMailResolutionIssue } from "./case-mail-resolution-core";
import { assignmentPreparationPatch } from "./assignment-preparation-core";
import { adminEditValueMatches, type EditSourceSnapshot } from "./admin-edit-state-core";
import { splitMenuConditions } from "./shift-parser";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const Command = z.object({ expectedCompanyId: id, expectedActorUid: id, receiptId: id, candidateId: id, jobId: id,
  reviewVersion: z.string().regex(/^[a-f0-9]{64}$/), note: z.string().trim().min(1).max(1000), confirmed: z.literal(true) }).strict();
function fail(): never { throw new HttpsError("failed-precondition", "受信元・案件・確認版が変わっています。最新の内容を読み直してください。"); }
const display = (job: Record<string, any>) => ({ workDate: String(job.workDate ?? ""), clientName: String(job.clientName ?? ""),
  storeName: String(job.storeName ?? ""), makerName: String(job.makerName ?? ""), menuName: [job.menuName, ...(job.menuConditions ?? [])].filter(Boolean).join(" ／ "),
  entryTime: String(job.entryTime ?? ""), workTime: String(job.workTime ?? ""), assignedStaffName: String(job.assignedStaffName ?? ""),
  cancelled: job.cancelled === true, cancellationFinancialTreatment: String(job.cancellationFinancialTreatment ?? "") });

export async function readCaseMailResolution(tx: FirebaseFirestore.Transaction, companyId: string, receiptId: string, candidateId: string) {
  const [receiptSnap, candidateSnap] = await tx.getAll(db.collection("caseMailIntakeReceipts").doc(id.parse(receiptId)), db.collection("caseMailIntakeCandidates").doc(id.parse(candidateId)));
  const receipt = receiptSnap!.data(), candidate = candidateSnap!.data();
  if (!receipt || !candidate || receipt.companyId !== companyId || candidate.companyId !== companyId ||
      receipt.version !== 1 || candidate.version !== 1 || receipt.verification !== "verified" ||
      receipt.status !== "review" || !receipt.issues?.includes("SOURCE_CHANGED") || !Number.isSafeInteger(receipt.revision) || receipt.revision < 2 ||
      !/^[a-f0-9]{64}$/.test(receipt.heldAnalysisHash ?? "") || !Array.isArray(receipt.candidateIds) || !receipt.candidateIds.includes(candidateId) ||
      candidate.receiptId !== receiptId || candidate.messageId !== receipt.messageId || candidate.status !== "linked" ||
      candidate.sourceFingerprint !== receipt.sourceFingerprint || !Array.isArray(receipt.parts) ||
      !receipt.parts.some((part: any) => part.partId === candidate.source?.partId && part.sha256 === candidate.source?.sha256)) fail();
  const jobId = id.parse(candidate.linkedJobId), jobRef = db.collection("jobs").doc(jobId);
  const job = (await tx.get(jobRef)).data();
  if (!job || job.companyId !== companyId || job.mailIntake?.receiptId !== receiptId || job.mailIntake?.candidateId !== candidateId ||
      !Number.isSafeInteger(job.revision) || job.revision < 0 || job.revision >= Number.MAX_SAFE_INTEGER) fail();
  const [ownerSnap, sourceSnap, principalSnap, featureSnap] = await tx.getAll(
    db.collection("caseMailJobSources").doc(id.parse(job.mailIntake.sourceKey)), db.collection("adminJobEditSources").doc(jobId),
    db.collection("automationIngestPrincipals").doc(caseMailRecordKey(companyId, receipt.ingestedBy)), db.collection("companyFeatureSettings").doc(companyId));
  const owner = ownerSnap!.data(), source = sourceSnap!.data(), principal = principalSnap!.data(), feature = featureSnap!.data();
  if (!owner || owner.companyId !== companyId || owner.receiptId !== receiptId || owner.candidateId !== candidateId ||
      owner.jobId !== jobId || owner.caseId !== job.caseId || owner.completedCandidateRevision !== candidate.revision ||
      !principal || principal.companyId !== companyId || principal.uid !== receipt.ingestedBy || principal.active !== true ||
      principal.producerId !== receipt.producerId || principal.revision !== receipt.principalRevision || feature?.caseMailIntakeEnabled !== true ||
      job.mailIntakeHold?.receiptId !== receiptId || job.mailIntakeHold.revision !== receipt.revision || job.mailIntakeHold.analysisHash !== receipt.heldAnalysisHash ||
      candidate.heldChange?.revision !== receipt.revision || candidate.heldChange.analysisHash !== receipt.heldAnalysisHash) fail();
  const accepted = job.mailTargetHold == null && caseMailReviewAccepted(receiptId, receipt, candidateId, job);
  let issue = caseMailResolutionIssue(jobId, job, source as EditSourceSnapshot | undefined, receipt.reviewRequestedAt?.toMillis?.());
  const proposed = candidate.heldChange.input;
  if (job.cancelled !== true) {
    if (!proposed) issue = "変更後の内容を照合できません。原文と対象の確認が必要です。";
    else {
      const menu = splitMenuConditions(String(proposed.menuName ?? "").normalize("NFKC").trim());
      if (["workDate","clientName","storeName","makerName","entryTime","workTime"].some(key => !adminEditValueMatches(key, proposed[key], job[key])) ||
          !adminEditValueMatches("menuName", menu.name, job.menuName) || JSON.stringify(menu.conditions) !== JSON.stringify(job.menuConditions ?? [])) issue = "変更後の依頼内容と現在の案件が一致していません。既存の案件編集・原本反映を確認してください。";
    }
  } else if (!["invoice_and_pay","invoice_only","pay_only","neither"].includes(job.cancellationFinancialTreatment)) issue = "取消の請求・支払の扱いを既存の取消画面で確認してください。";
  let lock: FirebaseFirestore.DocumentData | undefined;
  if (job.assignedStaffId) {
    lock = (await tx.get(db.collection("staffDayLocks").doc(companyId + "_" + job.assignedStaffId + "_" + job.dateKey))).data();
    if (job.cancelled !== true && (!lock || lock.companyId !== companyId || lock.staffId !== job.assignedStaffId || lock.dateKey !== job.dateKey || lock.jobId !== jobId || lock.active !== true)) issue = "担当者の勤務枠を確認してください。";
    if (job.cancelled === true && lock?.active === true && lock.jobId === jobId) issue = "取消後の勤務枠解除を確認してください。";
  }
  if (job.mailTargetHold != null) issue = "別メールによる変更・取消の保留を先に確認してください。";
  if (!accepted && job.mailIntakeReviewRequired !== true) fail();
  const reviewVersion = caseMailRecordKey(receipt, candidate, job, source ?? null, lock ?? null, principal, feature?.caseMailIntakeEnabled);
  return { receipt, candidate, job, jobRef, view: { jobId, reviewVersion, canConfirm: !accepted && !issue, resolved: accepted, issue,
    current: display(job), proposed: candidate.heldChange.input ? display(candidate.heldChange.input) : null } };
}

export const confirmCaseMailReview = onCall(async request => {
  const session = requireAdmin(request), companyId = companyFromClaims(session.token), input = Command.parse(request.data);
  if (input.expectedCompanyId !== companyId || input.expectedActorUid !== session.uid) fail();
  await assertProductionOperational(companyId);
  return db.runTransaction(async tx => {
    const current = await readCaseMailResolution(tx, companyId, input.receiptId, input.candidateId);
    const { job, jobRef, receipt, view } = current;
    if (view.jobId !== input.jobId) fail();
    if (view.resolved && job.mailReview?.reviewVersion === input.reviewVersion) return { ok: true, resolved: true, replayed: true, jobId: view.jobId };
    if (!view.canConfirm || view.reviewVersion !== input.reviewVersion) fail();
    const auditRef = db.collection("auditLogs").doc(caseMailRecordKey("case-mail-resolution", companyId, input.receiptId, receipt.revision, input.candidateId));
    if ((await tx.get(auditRef)).exists) fail();
    const now = Timestamp.now(), next = { ...job, mailIntakeReviewRequired: false, revision: job.revision + 1 };
    tx.set(jobRef, { ...assignmentPreparationPatch(job, next), mailIntakeReviewRequired: false, revision: next.revision,
      publishable: false, recruitmentStopped: true, scheduledPublishAt: FieldValue.delete(), mailPublication: FieldValue.delete(),
      mailReview: { receiptId: input.receiptId, candidateId: input.candidateId, receiptRevision: receipt.revision,
        analysisHash: receipt.heldAnalysisHash, reviewVersion: input.reviewVersion, note: input.note, actorUid: session.uid, confirmedAt: now }, updatedAt: now }, { merge: true });
    tx.set(auditRef, { companyId, actorUid: session.uid, action: "caseMail.review.confirm", jobId: view.jobId,
      receiptId: input.receiptId, candidateId: input.candidateId, receiptRevision: receipt.revision,
      reviewVersion: input.reviewVersion, note: input.note, current: view.current, createdAt: now });
    return { ok: true, resolved: true, replayed: false, jobId: view.jobId };
  });
});
