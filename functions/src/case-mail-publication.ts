import { db } from "./firebase";
import { caseMailReviewAccepted } from "./case-mail-resolution-core";
import { mailSourceIssue, mailPublicationContext } from "./case-mail-publication-core";
import { tokyoParts } from "./notification-time";
import type { EditSourceSnapshot } from "./admin-edit-state-core";
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
export async function readMailPublication(tx: FirebaseFirestore.Transaction, jobId: string, job: Record<string, any>, expected: number | undefined, now: Date, purpose: "publish" | "apply" = "publish") {
  const origin = job.mailIntake;
  if (!Number.isSafeInteger(job.revision) || expected !== job.revision) return { issue: "確認後に案件が変わっています。一覧を読み直してください。" };
  if (!origin || ![origin.receiptId, origin.candidateId, origin.sourceKey].every(id)) return { issue: "受信元の対応を確認できません。" };
  const [receiptSnap, candidateSnap, ownerSnap, sourceSnap] = await tx.getAll(
    db.collection("caseMailIntakeReceipts").doc(origin.receiptId), db.collection("caseMailIntakeCandidates").doc(origin.candidateId),
    db.collection("caseMailJobSources").doc(origin.sourceKey), db.collection("adminJobEditSources").doc(jobId));
  const receipt = receiptSnap!.data(), candidate = candidateSnap!.data(), owner = ownerSnap!.data();
  if (!receipt || !candidate || !owner || [receipt, candidate, owner].some(row => row.companyId !== job.companyId) ||
      receipt.version !== 1 || candidate.version !== 1 || !id(receipt.messageId) ||
      !/^[a-f0-9]{64}$/.test(receipt.sourceFingerprint ?? "") || !id(candidate.source?.partId) || !/^[a-f0-9]{64}$/.test(candidate.source?.sha256 ?? "") ||
      !Number.isSafeInteger(candidate.revision) || candidate.revision < 1 || (receipt.status !== "ready" && !caseMailReviewAccepted(origin.receiptId, receipt, origin.candidateId, job)) || receipt.verification !== "verified" || receipt.structuralComplete !== true || receipt.kind !== "new" ||
      !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || !Array.isArray(receipt.candidateIds) || !receipt.candidateIds.includes(origin.candidateId) ||
      candidate.status !== "linked" || candidate.linkedJobId !== jobId || candidate.receiptId !== origin.receiptId ||
      candidate.messageId !== receipt.messageId || candidate.sourceFingerprint !== receipt.sourceFingerprint ||
      !Array.isArray(receipt.parts) || !receipt.parts.some((part: any) => part.partId === candidate.source?.partId && part.sha256 === candidate.source?.sha256) ||
      owner.jobId !== jobId || owner.caseId !== job.caseId || owner.receiptId !== origin.receiptId || owner.candidateId !== origin.candidateId ||
      owner.completedCandidateRevision !== candidate.revision) return { issue: "受信内容の変更・取消または対応関係を確認してください。" };
  const date = String(job.workDate ?? ""), valid = new Date(date + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(valid.valueOf()) || valid.toISOString().slice(0,10) !== date ||
      date !== job.dateKey || date < "2026-10-01" || (purpose === "publish" ? date <= tokyoParts(now).dateKey : date < tokyoParts(now).dateKey)) return { issue: purpose === "publish" ? "募集できるのは翌日以降の対象案件です。" : "この案件は応募できる実施日の対象外です。" };
  const issue = mailSourceIssue(jobId, job, sourceSnap!.data() as EditSourceSnapshot | undefined);
  return { issue, confirmation: issue ? undefined : { context: mailPublicationContext(job), receiptRevision: receipt.revision, candidateRevision: candidate.revision } };
}
