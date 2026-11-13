import { HttpsError } from "firebase-functions/v2/https";

import { caseMailPreparationHeld } from "./case-mail-preparation-core";
import { mailPreparationContext } from "./assignment-preparation-core";

type Data = Record<string, unknown>;
const identityFields = ["companyId", "uid", "jobId", "staffId", "type"] as const;

export function assertSubmissionFileIdentity(submission: Data | undefined, file: Data | undefined, submissionId: string): void {
  if (!submission || !file || file.submissionId !== submissionId ||
      identityFields.some(key => typeof submission[key] !== "string" || !submission[key] || submission[key] !== file[key]) ||
      !["report", "sales_floor"].includes(String(submission.type)) ||
      (submission.resubmissionRequestId ?? null) !== (file.resubmissionRequestId ?? null)) {
    throw new HttpsError("failed-precondition", "提出とファイルの所属情報が一致しません。");
  }
}

export function assertSubmissionFile(submission: Data | undefined, file: Data | undefined, submissionId: string): void {
  assertSubmissionFileIdentity(submission, file, submissionId);
  if (!submission || !file) throw new HttpsError("failed-precondition", "提出が見つかりません。");
  assertSubmissionCounters(submission);
  if (submission.completedFiles === submission.totalFiles && file.completionCounted !== true) {
    throw new HttpsError("failed-precondition", "提出の完了数とファイルの加算状態が一致しません。");
  }
}

export function assertSubmissionCounters(submission: Data): void {
  const total = submission.totalFiles;
  const completed = submission.completedFiles;
  if (!Number.isInteger(total) || Number(total) < 1 || Number(total) > 20 ||
      !Number.isInteger(completed) || Number(completed) < 0 || Number(completed) > Number(total)) {
    throw new HttpsError("failed-precondition", "提出のファイル数を確認できません。");
  }
}

/** 新しい提出の受付だけに使用し、受付済みの履歴やファイルは保持する。 */
export function assertSubmissionReadiness(job: Data): void {
  if (caseMailPreparationHeld(job)) throw new HttpsError("failed-precondition", "受信内容・勤務条件を確認中です。保存済みファイルは保持し、確認後に提出状況を再読み込みしてください。", { reason: "case_mail_review_pending" });
  if (job.sourceMissing === true) throw new HttpsError("failed-precondition", "取込元の案件を確認できません。シフトを更新してから提出してください。", { reason: "source_unavailable" });
  if (job.applicationUnconfirmed === true) throw new HttpsError("failed-precondition", "応募は受付済みです。シフト表の担当確認が済んでから提出してください。", { reason: "assignment_sheet_confirmation_pending" });
  if (job.assignmentUnresolved === true) throw new HttpsError("failed-precondition", "担当者の照合が完了していません。シフトを更新してから提出してください。", { reason: "assignment_identity_unresolved" });
}

/** 受信案件の受付時点を固定し、担当の復帰や保留解除でも旧提出へすり替えない。 */
export function caseMailSubmissionContext(job: Data): string {
  return JSON.stringify([job.companyId ?? null, job.revision ?? null, mailPreparationContext(job),
    (job.assignmentSheetWrite as Data | undefined)?.queueId ?? null]);
}

export function assertCaseMailSubmissionRevision(job: Data, expectedRevision: unknown): void {
  if (!job.mailIntake) return;
  assertSubmissionReadiness(job);
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0 || expectedRevision !== job.revision) {
    throw new HttpsError("failed-precondition", "受信案件の勤務条件が更新されています。ファイルは保持しています。シフトと提出履歴を再読み込みしてください。", { reason: "case_mail_submission_changed" });
  }
}

export function assertCaseMailSubmissionCurrent(record: Data, job: Data): void {
  if (!job.mailIntake && record.acceptedMailContext == null) return;
  assertSubmissionReadiness(job);
  if (!job.mailIntake || job.status !== "assigned" || job.cancelled === true ||
      typeof record.acceptedMailContext !== "string" || record.acceptedMailContext !== caseMailSubmissionContext(job)) {
    throw new HttpsError("failed-precondition", "受付後に受信案件の担当・勤務条件が変わりました。保存済みファイルを再送せず、管理者と提出履歴を確認してください。", { reason: "case_mail_submission_changed" });
  }
}

export function assertSubmissionOwner(submission: Data, job: Data | undefined, staff?: Data): void {
  if (!job || typeof submission.companyId !== "string" || !submission.companyId ||
      typeof submission.staffId !== "string" || !submission.staffId ||
      job.companyId !== submission.companyId || job.assignedStaffId !== submission.staffId ||
      (staff !== undefined && staff.companyId !== submission.companyId)) {
    throw new HttpsError("failed-precondition", "提出と案件の会社・担当者が一致しません。");
  }
  assertCaseMailSubmissionCurrent(submission, job);
}

export function assertReplacementRequest(request: Data | undefined, submission: Data, submissionId: string): void {
  if (!request || ["companyId", "jobId", "staffId", "type"].some(key => request[key] !== submission[key]) ||
      (request.replacementSubmissionId && request.replacementSubmissionId !== submissionId) ||
      !["open", "submitted", "completed"].includes(String(request.status)) ||
      (request.status !== "open" && request.replacementSubmissionId !== submissionId)) {
    throw new HttpsError("failed-precondition", "この再提出依頼へ転送できません。依頼と提出を確認してください。");
  }
}
