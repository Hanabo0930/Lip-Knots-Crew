import { setGlobalOptions } from "firebase-functions/v2";

setGlobalOptions({ region: "asia-northeast1", maxInstances: 20 });

export { bootstrapSession } from "./auth";
export { applyToJob, adminCancelJob } from "./jobs";
export { submitPreContact } from "./precontact";
export { createUploadSession, finalizeStagedUpload } from "./uploads";
export { processSafeSheetWrite, retrySafeSheetWrites } from "./safe-sheet-writes";
export { processNotificationQueue } from "./notifications";

export { previewShiftImport, syncShiftSheetsReadOnly, syncShiftSheetsScheduled, getShiftSyncStatus } from "./shift-import";

export { previewStaffImport, syncStaffDirectoryReadOnly, syncStaffDirectoryScheduled, getStaffSyncStatus } from "./staff-import";

export {
  requestStaffLoginLink,
  getLoginInviteCandidates,
  sendLoginInvites,
  loginGateway,
  cleanupExpiredLoginTokens,
} from "./login-links";
export {
  registerDeviceSession,
  heartbeatDeviceSession,
  listMyDevices,
  revokeMyDevice,
  revokeAllMyDevices,
  getStaffDevices,
  adminRevokeStaffDevices,
} from "./devices";
export {
  registerPushToken,
  unregisterPushToken,
  getPushStatus,
  sendTestPush,
} from "./push-tokens";
export { dispatchDueNotifications } from "./notifications";
export { scheduleOperationalReminders } from "./reminder-scheduler";
export { setSalesFloorClientSubmitted } from "./submission-status";
export {
  startPilotRollout,
  getPilotRolloutStatus,
  stopPilotRollout,
  monitorPilotHealth,
} from "./pilot-monitoring";
export {
  getPilotExpansionReview,
  submitPilotOutcome,
  decidePilotExpansion,
} from "./pilot-expansion";
export {
  createStagedRollout,
  getStagedRolloutStatus,
  releaseNextStagedWave,
  stopStagedRollout,
  monitorStagedRolloutHealth,
} from "./staged-rollout";
export {
  getProductionControlStatus,
  submitProductionReleaseReview,
  decideProductionReleaseExecutive,
  enableProductionRelease,
  activateGlobalKillSwitch,
} from "./production-control";
export {
  getProductionRehearsalStatus,
  createProductionRehearsal,
  saveProductionRehearsalMetrics,
  completeProductionRehearsal,
  abortProductionRehearsal,
} from "./production-rehearsal";
export {
  exportProductionApprovalPackage,
  importProductionApprovalPackage,
} from "./production-approval-package";
export {
  getProductionCutoverStatus,
  createProductionCutover,
  saveProductionCutoverReadiness,
  recordProductionCutoverObservation,
  monitorProductionCutover,
  activateProductionCutoverRollback,
  completeProductionCutover,
  cancelProductionCutover,
} from "./production-cutover";
export {
  getProductionSloDashboard,
  saveProductionSloPolicy,
  recordProductionSloObservation,
  monitorProductionSlo,
  acknowledgeProductionIncident,
  resolveProductionIncident,
} from "./production-slo";
export {
  getProductionTelemetryStatus,
  saveProductionTelemetryConfig,
  probeProductionTelemetry,
  collectProductionTelemetryNow,
  collectProductionTelemetry,
} from "./production-telemetry";
export {
  getProductionMetricPublisherStatus,
  publishProductionMetricsNow,
  publishProductionMetrics,
} from "./production-metrics";
export { getProductionDeploymentReadiness } from "./production-deployment-readiness";
export { getProductionReleaseEvidenceStatus, importProductionReleaseEvidence, acknowledgeProductionEvidenceAlert, startProductionEvidenceAlertResponse, handoffProductionEvidenceAlertResponse, saveProductionEvidenceAfterActionReview, acknowledgeProductionEvidenceWeeklyReport, acknowledgeProductionEvidenceWeeklyReportAsProxy, acknowledgeProductionEvidenceExecutiveReport, acknowledgeProductionEvidenceExecutiveReportAsProxy, updateProductionEvidenceExecutiveDecisionTask, recordProductionEvidenceExecutiveDecisionOutcome, createProductionEvidenceExecutiveDecisionRecoveryPlan, approveProductionEvidenceWeeklyReportResponsibility, updateProductionEvidenceResponsibilityAlert, monitorProductionReleaseEvidence, runProductionEvidenceOperationsDigest } from "./production-evidence";

export { getMyTasks } from "./staff-tasks";
export { updateNetPrintNumbers, markNetPrintPrinted } from "./netprint";
export { createResubmissionRequest, getMyResubmissionRequests, getAdminResubmissionRequests, completeResubmissionRequest } from "./resubmissions";

export { getSubmissionTimeline, getResubmissionComparison, driveFilePreview } from "./submission-files";

export {
  getSheetWriteIssues,
  retrySheetWriteIssue,
  acknowledgeSheetWriteIssue,
  confirmApplication,
  getExpenseReview,
  saveExpenseReviewDraft,
  completeExpenseReview,
  getJobSheetLink,
  updateExpenseReviewFromQueue,
} from "./admin-operations";
export {
  getOperationsDashboard,
  getStaffPerformance,
  adminSetJobCancellation,
  adminRestoreCancelledJob,
} from "./analytics";

export {
  createAdminJobGroup,
  duplicateAdminJob,
  updateJobPublication,
  publishScheduledJobs,
  adminEditJobInputs,
  generateJobExport,
} from "./job-management";

export {
  processSheetRowCreation,
  retrySheetRowCreation,
  previewSheetRowCreation,
  getPilotReadiness,
} from "./sheet-row-creation";

export {
  inspectSetupWizard,
  saveSetupWizardDraft,
  getSetupWizardDraft,
} from "./setup-wizard";
export {
  previewMonthSheetCreation,
  createMonthSheetSafe,
  getMonthCreationHistory,
} from "./month-sheet";

export { runGasAudit, evaluateFirstWriteSafetyGate } from "./gas-audit";

export {
  scanGasUploadSafety,
  saveGasRemediation,
  getGasAuditDetail,
  compareGasAudits,
  exportGasAuditMarkdown,
} from "./gas-remediation";

export {
  generateGasPatchPlan,
  previewGasPatch,
  getRegressionTemplate,
  saveRegressionRun,
} from "./gas-patch";
