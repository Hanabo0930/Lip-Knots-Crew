import { cancellationSheetWriteIdentity } from "./sheet-write-core";

// 担当・勤務日・元タブが変わっても資料番号と依頼履歴は保持し、印刷の確認だけを戻す。
export function netPrintAssignmentPatch(previous: Record<string, unknown> | undefined, next: Record<string, unknown>): Record<string, unknown> {
  const saved = previous?.netPrint;
  if (!previous || !saved || typeof saved !== "object" || Array.isArray(saved) ||
      cancellationSheetWriteIdentity(previous) === cancellationSheetWriteIdentity(next)) return {};
  const state = saved as Record<string, unknown>;
  const reset: Record<string, unknown> = { ...state, needsPrintReview: true };
  if (Array.isArray(state.items)) reset.items = state.items.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const item: Record<string, unknown> = { ...value, printed: false };
    for (const key of ["printedAt", "printOperationId", "printedByStaffId", "printedForDate", "printedContext"]) delete item[key];
    return item;
  });
  return { netPrint: reset };
}