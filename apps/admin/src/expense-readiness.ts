type ExpenseJobState = {
  mailIntake?: unknown; mailIntakeReviewRequired?: boolean; pendingSourceWrite?: boolean;
  adminEditSheetWrite?: { pending?: boolean }; appOverride?: { active?: boolean };
  sourceMissing?: boolean; applicationUnconfirmed?: boolean; assignmentUnresolved?: boolean;
  status?: string; cancelled?: boolean; assignedStaffId?: string; revision?: number;
};
export function expenseReadinessMessage(job: ExpenseJobState | undefined): string | null {
  if (!job) return null;
  if (job.mailIntakeReviewRequired || (job.mailIntake && (job.pendingSourceWrite || job.adminEditSheetWrite?.pending)))
    return "受信内容・勤務条件の変更を確認中です。入力した金額とメモは保持しています。確認後に経費を読み直してください。";
  if (!job.mailIntake) return null;
  if (job.sourceMissing || job.applicationUnconfirmed || job.assignmentUnresolved || job.appOverride?.active)
    return "受信案件の担当・原本照合が完了していません。入力は保持しています。原本確認後に経費を読み直してください。";
  const cancelled = job.status === "cancelled" && job.cancelled === true;
  if ((!cancelled && (job.status !== "assigned" || job.cancelled || !job.assignedStaffId)) || !Number.isSafeInteger(job.revision) || Number(job.revision) < 0)
    return "受信案件の担当・確認版を確認できません。最新の案件と経費を読み直してください。";
  return null;
}
