export type CaseMailPreparation = {
  mailIntake?: unknown; mailTargetHold?: unknown; mailIntakeReviewRequired?: boolean; pendingSourceWrite?: boolean;
  adminEditSheetWrite?: { pending?: boolean };
};
/** 受信・原本編集の確認が終わるまで、担当を保持して準備を保留する。 */
export function caseMailPreparationHeld(job: CaseMailPreparation): boolean {
  return job.mailTargetHold != null || job.mailIntakeReviewRequired === true || Boolean(job.mailIntake &&
    (job.pendingSourceWrite === true || job.adminEditSheetWrite?.pending === true));
}
