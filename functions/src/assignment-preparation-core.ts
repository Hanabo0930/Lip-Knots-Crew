import { netPrintAssignmentPatch } from "./netprint-state-core";
import { cancellationSheetWriteIdentity } from "./sheet-write-core";

function contactIdentity(job: Record<string, unknown>): string {
  const source = job.sheetRef as Record<string, unknown> | undefined;
  return JSON.stringify([job.assignedStaffId ?? null, job.dateKey ?? null, job.caseId ?? null,
    source?.spreadsheetId ?? null, source?.sheetId ?? null, source?.sheetName ?? null]);
}

/** 担当と案件の切替時に、前の人の準備結果を引き継がない。 */
export function assignmentPreparationPatch(previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>): Record<string, unknown> {
  const patch = netPrintAssignmentPatch(previous, next);
  if (previous && contactIdentity(previous) !== contactIdentity(next)) {
    Object.assign(patch, { preContact: null, preContactNeedsReview: true, preContactSyncPending: false });
  }
  if (previous?.assignmentSheetWrite && (cancellationSheetWriteIdentity(previous) !== cancellationSheetWriteIdentity(next) ||
      previous.status !== next.status || previous.cancelled !== next.cancelled || next.sourceMissing === true || next.assignmentUnresolved === true)) {
    patch.assignmentSheetWrite = null;
  }
  return patch;
}
