import { adminEditValueMatches, editSourceIdentity, type EditSourceSnapshot } from "./admin-edit-state-core";
import { splitMenuConditions } from "./shift-parser";

export function caseMailReviewAccepted(receiptId: string, receipt: Record<string, any>, candidateId: string, job: Record<string, any>): boolean {
  const saved = job.mailReview, hold = job.mailIntakeHold;
  return receipt.status === "review" && Number.isSafeInteger(receipt.revision) && receipt.revision >= 2 &&
    typeof receipt.heldAnalysisHash === "string" && /^[a-f0-9]{64}$/.test(receipt.heldAnalysisHash) && job.mailIntakeReviewRequired === false && saved?.receiptId === receiptId && saved.candidateId === candidateId &&
    saved.receiptRevision === receipt.revision && saved.analysisHash === receipt.heldAnalysisHash &&
    typeof saved.reviewVersion === "string" && /^[a-f0-9]{64}$/.test(saved.reviewVersion) &&
    hold?.receiptId === receiptId && hold.revision === receipt.revision && hold.analysisHash === receipt.heldAnalysisHash;
}

/** 保留を解く前に、受信変更後に読み直した原本と現在の案件を照合する。 */
export function caseMailResolutionIssue(jobId: string, job: Record<string, any>, source: EditSourceSnapshot | undefined, requestedAtMs: number): string | null {
  if (job.sourceMissing || job.assignmentUnresolved || job.applicationUnconfirmed || job.pendingSourceWrite ||
      job.adminEditSheetWrite?.pending || job.appOverride?.active) return "担当・編集・取消の原本反映を確認してから、受信内容を再確認してください。";
  if (!source || source.version !== 1 || source.companyId !== job.companyId || source.jobId !== jobId ||
      source.identity !== editSourceIdentity(job) || !Number.isFinite(requestedAtMs) ||
      !Number.isFinite(source.readStartedAtMs) || source.readStartedAtMs <= requestedAtMs ||
      job.source?.type !== "google_sheets_readonly" || !job.sheetRef?.spreadsheetId ||
      !Number.isInteger(job.sheetRef?.currentRow) || job.sheetRef.currentRow < 2 || !job.caseId) return "変更受信後のシフト再取込・固定ID照合が必要です。";
  const day = String(job.dateKey ?? ""), date = new Date(day + "T00:00:00Z");
  if (day !== job.workDate || day < "2026-10-01" || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== day) return "勤務日・原本の対象月を確認してください。";
  const cancelled = job.status === "cancelled" && job.cancelled === true;
  if (!cancelled && (job.cancelled || !["draft", "stopped", "assigned"].includes(job.status) || (job.status === "assigned") !== Boolean(job.assignedStaffId))) return "現在の担当・取消状態を確認してください。";
  const columns: Record<string, string> = { staffName: "B", clientName: "J", storeName: "K", makerName: "L", menuName: "M", entryTime: "N", workTime: "O" };
  if (!source.columns || !source.values || typeof job.rawStaffName !== "string" || typeof job.rawClientName !== "string" ||
      Object.entries(columns).some(([key, column]) => source.columns[key] !== column || !Object.hasOwn(source.values, key))) return "原本の担当・勤務条件の確認値が不足しています。";
  const menu = splitMenuConditions(String(source.values.menuName).normalize("NFKC").trim());
  if (Object.keys(columns).some(key => key === "menuName" ? !adminEditValueMatches(key, menu.name, job.menuName) || JSON.stringify(menu.conditions) !== JSON.stringify(job.menuConditions ?? []) :
      !adminEditValueMatches(key, source.values[key], key === "staffName" ? job.rawStaffName : key === "clientName" ? job.rawClientName : job[key]))) return "取込済みの原本と現在の担当・勤務条件が一致していません。";
  if (cancelled && !/[（(]\s*キャンセル\s*[）)]/u.test(job.rawStaffName + job.rawClientName)) return "原本の取消表示を確認してください。";
  return null;
}
