import { HttpsError } from "firebase-functions/v2/https";

type Data = Record<string, unknown>;
export function assertSubmissionAcceptanceContext(job: Data, input: Data): void {
  const date = input.expectedDateKey;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date || date !== job.dateKey ||
      !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0 ||
      input.expectedRevision !== (job.revision ?? 0)) {
    throw new HttpsError("failed-precondition", "案件の日付・勤務条件が更新されています。ファイルは保持しています。「提出情報を再読み込み」で対象を確認し直してください。", {reason: "submission_context_changed"});
  }
}
