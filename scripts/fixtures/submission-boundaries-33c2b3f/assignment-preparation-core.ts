import { HttpsError } from "firebase-functions/v2/https";
import { netPrintAssignmentPatch } from "./netprint-state-core";
import { cancellationSheetWriteIdentity } from "./sheet-write-core";

function contactIdentity(job: Record<string, unknown>): string {
  const source = job.sheetRef as Record<string, unknown> | undefined;
  return JSON.stringify([job.assignedStaffId ?? null, job.dateKey ?? null, job.caseId ?? null,
    source?.spreadsheetId ?? null, source?.sheetId ?? null, source?.sheetName ?? null]);
}

/** 管理者が確認した担当・勤務条件。行移動や原本の応募確認だけでは失効させない。 */
export function applicationConfirmationIdentity(job: Record<string, unknown>): string {
  return JSON.stringify([contactIdentity(job), job.status ?? null, job.cancelled === true,
    job.sourceMissing === true, job.assignmentUnresolved === true,
    job.storeName ?? null, job.clientName ?? null, job.makerName ?? null,
    job.menuName ?? null, job.workTime ?? null, job.entryTime ?? null, job.basePay ?? null,
    ...(job.mailIntake ? [job.menuConditions ?? [], job.mailIntakeReviewRequired === true, job.pendingSourceWrite === true,
      (job.adminEditSheetWrite as Record<string, unknown> | undefined)?.pending === true] : [])]);
}

/** 行移動・原本反映だけでは失効せず、勤務条件が変わったら再確認する。 */
export function mailPreparationContext(job: Record<string, unknown>): string {
  return JSON.stringify([applicationConfirmationIdentity(job), job.storeAddress ?? "", job.storeNearestStation ?? ""]);
}

export function nextAssignmentRevision(job: Record<string, unknown>): number {
  const revision = job.revision ?? 0;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new HttpsError("failed-precondition", "案件の版情報を確認できません。再読込して確認してください。");
  }
  return revision + 1;
}

export function resetApplicationConfirmation(): Record<string, unknown> {
  return { applicationAdminConfirmed: false, applicationAdminConfirmedBy: null,
    applicationAdminConfirmedAt: null, applicationAdminConfirmedRevision: null };
}

/** 担当と案件の切替時に、前の人の準備結果を引き継がない。 */
export function assignmentPreparationPatch(previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>): Record<string, unknown> {
  const patch = netPrintAssignmentPatch(previous, next, Boolean(previous?.mailIntake &&
    (previous.revision !== next.revision || mailPreparationContext(previous) !== mailPreparationContext(next))));
  if (previous && applicationConfirmationIdentity(previous) !== applicationConfirmationIdentity(next)) {
    Object.assign(patch, resetApplicationConfirmation());
  }
  if (previous?.mailIntake && mailPreparationContext(previous) !== mailPreparationContext(next)) {
    Object.assign(patch, { preContactNeedsReview: true, preContactLate: false });
  }
  if (previous && contactIdentity(previous) !== contactIdentity(next)) {
    Object.assign(patch, { preContact: null, preContactNeedsReview: true, preContactSyncPending: false });
  }
  if (previous?.assignmentSheetWrite && (cancellationSheetWriteIdentity(previous) !== cancellationSheetWriteIdentity(next) ||
      previous.status !== next.status || previous.cancelled !== next.cancelled || next.sourceMissing === true || next.assignmentUnresolved === true ||
      (previous.mailIntake && applicationConfirmationIdentity(previous) !== applicationConfirmationIdentity(next)))) {
    patch.assignmentSheetWrite = null;
  }
  return patch;
}
