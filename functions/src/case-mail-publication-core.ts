import { splitMenuConditions } from "./shift-parser";
import { adminEditKeys, adminEditValueMatches, editProjection, editSourceIdentity, type EditSourceSnapshot } from "./admin-edit-state-core";

/** 原本の再取込で同じ条件なら募集を維持し、条件・担当・原本状態が変われば再確認する。 */
export function mailPublicationContext(job: Record<string, any>): string {
  return JSON.stringify([editSourceIdentity(job), job.workDate ?? null, editProjection(job, [...adminEditKeys]),
    job.basePay ?? null, job.menuConditions ?? [], job.storeAddress ?? "", job.storeNearestStation ?? "", job.assignedStaffId ?? null, job.rawStaffName ?? "",
    job.cancelled === true, job.sourceMissing === true, job.assignmentUnresolved === true,
    job.applicationUnconfirmed === true, job.pendingSourceWrite === true, job.adminEditSheetWrite?.pending === true,
    job.mailIntakeReviewRequired === true]);
}
export function mailSourceIssue(jobId: string, job: Record<string, any>, source: EditSourceSnapshot | undefined): string | null {
  if (!source || source.version !== 1 || source.companyId !== job.companyId || source.jobId !== jobId ||
      source.identity !== editSourceIdentity(job) || !Number.isFinite(source.readStartedAtMs) ||
      job.source?.type !== "google_sheets_readonly" || !job.sheetRef?.spreadsheetId ||
      !Number.isInteger(job.sheetRef?.currentRow) || job.sheetRef.currentRow < 2 || !job.caseId) return "原本の再取込・固定ID照合が必要です。";
  if (job.cancelled === true || job.sourceMissing === true || job.assignmentUnresolved === true ||
      job.applicationUnconfirmed === true || job.pendingSourceWrite === true || job.adminEditSheetWrite?.pending === true ||
      job.mailIntakeReviewRequired === true || job.appOverride?.active === true || job.assignedStaffId || job.assignedStaffName || job.rawStaffName) return "変更・取消・担当または未反映項目を確認してください。";
  const columns: Record<string, string> = { staffName: "B", clientName: "J", storeName: "K", makerName: "L", menuName: "M", entryTime: "N", workTime: "O" };
  const menu = splitMenuConditions(String(source.values?.menuName ?? "").normalize("NFKC").trim());
  if (!adminEditValueMatches("menuName", menu.name, job.menuName) || JSON.stringify(menu.conditions) !== JSON.stringify(job.menuConditions ?? [])) return "原本のメニュー条件を確認してください。";
  if (!source.columns || !source.values || source.values.staffName !== "" ||
      Object.entries(columns).some(([key, column]) => source.columns[key] !== column ||
        !Object.hasOwn(source.values, key) || !adminEditValueMatches(key, key === "menuName" ? menu.name : source.values[key], key === "staffName" ? "" : job[key]))) return "取込済みの原本内容と案件が一致していません。";
  if ([job.clientName, job.storeName, job.makerName, job.menuName, job.workTime].some(value => typeof value !== "string" || !value.trim())) return "募集条件に未確認の項目があります。";
  if ([job.clientName, job.storeName, job.makerName, job.menuName, ...(job.menuConditions ?? [])].some(value => String(value).normalize("NFKC").includes("ラウンダー"))) return "ラウンダーはこの募集の対象外です。";
  return null;
}
