import { HttpsError } from "firebase-functions/v2/https";

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

export function assertSubmissionOwner(submission: Data, job: Data | undefined, staff?: Data): void {
  if (!job || typeof submission.companyId !== "string" || !submission.companyId ||
      typeof submission.staffId !== "string" || !submission.staffId ||
      job.companyId !== submission.companyId || job.assignedStaffId !== submission.staffId ||
      (staff !== undefined && staff.companyId !== submission.companyId)) {
    throw new HttpsError("failed-precondition", "提出と案件の会社・担当者が一致しません。");
  }
}

export function assertReplacementRequest(request: Data | undefined, submission: Data, submissionId: string): void {
  if (!request || ["companyId", "jobId", "staffId", "type"].some(key => request[key] !== submission[key]) ||
      (request.replacementSubmissionId && request.replacementSubmissionId !== submissionId) ||
      !["open", "submitted", "completed"].includes(String(request.status)) ||
      (request.status !== "open" && request.replacementSubmissionId !== submissionId)) {
    throw new HttpsError("failed-precondition", "この再提出依頼へ転送できません。依頼と提出を確認してください。");
  }
}
