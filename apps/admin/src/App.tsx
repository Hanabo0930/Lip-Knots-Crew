import { lazy, Suspense, useEffect, useState } from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  User,
} from "firebase/auth";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { auth, db, firebaseConfigured, functions } from "./firebase";
import { expectedFirebaseProjectId } from "./firebase-config";
import type { ProductionEvidenceView } from "./ProductionAcceptanceRollbackConsole";

const ProductionAcceptanceRollbackConsole = lazy(() => import("./ProductionAcceptanceRollbackConsole"));
const StoreLocationFields = lazy(() => import("./StoreLocationFields"));
const JobSafeEditPanel = lazy(() => import("./JobSafeEditPanel"));

type Job = {
  id: string;
  workDate: string;
  dateKey?: string;
  clientName: string;
  storeName: string;
  storeAddress?: string;
  storeNearestStation?: string;
  makerName: string;
  menuName?: string;
  entryTime?: string;
  workTime?: string;
  basePay?: number | null;
  groupId?: string;
  slotNumber?: number;
  slotCount?: number;
  publishable?: boolean;
  recruitmentStopped?: boolean;
  scheduledPublishAt?: unknown;
  revision?: number;
  clientChargeInputs?: Record<string,number|null>;
  staffPaymentInputs?: Record<string,number|null>;
  assignedStaffName?: string;
  assignedStaffId?: string;
  status: string;
  preContact?: unknown;
  netPrint?: { items?: Array<{ id:string; number:string; printed?:boolean }> };
  applicationAdminConfirmed?: boolean;
  expenses?: {
    transportation?: number | null;
    purchase8?: number | null;
    purchase10?: number | null;
    netPrintCost?: number | null;
    postageCost?: number | null;
  };
  financials?: {
    clientChargeTotal?: number | null;
    clientChargeAdditionsTotal?: number | null;
    staffPaymentTotal?: number | null;
    subcontractorTotal?: number | null;
  };
  subcontractorName?: string;
  cancellationReason?: string;
  cancellationReasonCategory?: string;
  cancellationFinancialTreatment?: string;
  cancelled?: boolean;
  preContactLate?: boolean;
  submissionStatus?: {
    report?: { lateFirstSubmission?: boolean };
    salesFloor?: { lateFirstSubmission?: boolean };
  };
  sheetRef?: { spreadsheetId?:string; sheetId?:number; currentRow?:number; sheetName?:string };
};


type StaffProfile = {
  id: string;
  displayName: string;
  emails?: string[];
  nearestStation?: string;
  homePrefecture?: string;
  areaLabels?: string[];
  rank?: string;
  active?: boolean;
  lastLoginAt?: unknown;
  emailConflicts?: string[];
  authUids?: string[];
};


type InviteCandidate = {
  staffId: string;
  displayName: string;
  emails: string[];
  areaLabels: string[];
  upcomingJobs: number;
};

type ResubmissionRequest = {
  id:string; jobId:string; staffId:string; type:"report"|"sales_floor";
  reasons:string[]; note?:string; status:string; submittedAt?:string;
};

type SubmissionFile = {
  id:string; submissionId:string; originalName:string; driveName:string; contentType:string;
  sequence:number|null; purpose:string; status:string; previewUrl:string|null; completedAt:string|null; replacesFileId:string|null;
};
type SubmissionGroup = { id:string; purpose:string; status:string; createdAt:string|null; completedAt:string|null; files:SubmissionFile[] };
type ResubmissionComparison = {
  request:{id:string;jobId:string;type:"report"|"sales_floor";reasons:string[];note:string;status:string};
  source:SubmissionFile|null; replacements:SubmissionFile[];
};


type SheetWriteIssue = {
  id:string;
  jobId:string;
  operation:string;
  status:string;
  errorType:string;
  errorMessage:string;
  attempts:number;
  canRetry:boolean;
  desiredUpdates:Record<string,unknown>;
  beforeValues:Record<string,unknown>;
  job:null|{workDate:string;storeName:string;assignedStaffName:string;clientName:string};
};

type ExpenseValues = {
  transportation:string;
  purchase8:string;
  purchase10:string;
  netPrintCost:string;
  postageCost:string;
};

const blankExpense: ExpenseValues = {
  transportation:"",
  purchase8:"",
  purchase10:"",
  netPrintCost:"",
  postageCost:"",
};

type NamedCount = { name:string; count:number };
type DashboardData = {
  month:string;
  counts:{
    totalRequests:number; effectiveJobs:number; implemented:number; scheduled:number;
    cancelled:number; open:number; assigned:number; stopped:number; draft:number;
    executionRate:number|null; cancellationRate:number|null;
  };
  finance:{
    bookedInvoice:number; bookedPayment:number; bookedGrossProfit:number;
    bookedGrossMargin:number|null; implementedInvoice:number;
    implementedPayment:number; implementedGrossProfit:number;
  };
  cancellationReasons:NamedCount[];
  cancellationTreatments:NamedCount[];
  clients:Array<NamedCount & {invoice:number;payment:number;grossProfit:number;cancelled:number}>;
};

type StaffPerformanceData = {
  profile:{id:string;displayName:string;rank:string;areaLabels:string[];nearestStation:string};
  performance:{
    totals:{assignedJobs:number;implementedJobs:number;scheduledJobs:number;cancelledJobs:number;preContactLate:number;reportLate:number;salesFloorLate:number;invoice:number;payment:number;grossProfit:number};
    clients:NamedCount[]; makers:NamedCount[]; menus:NamedCount[]; stores:NamedCount[]; months:NamedCount[];
    recentJobs:Array<{id:string;dateKey:string;clientName:string;storeName:string;makerName:string;menuName:string;cancelled:boolean}>;
  };
};




type SetupWizardResult = {
  inspectionId:string;
  expiresAt:string;
  shiftSpreadsheet:{
    id:string;
    title:string;
    sampleSheet:string;
    monthTabs:string[];
    header:{
      headerRow:number;
      score:number;
      columns:Record<string,string>;
      missingRequired:string[];
    };
    formulaColumns:string[];
    validationColumns:string[];
  };
  staffSpreadsheet:{
    id:string;
    title:string;
    sampleSheet:string;
    header:{
      headerRow:number;
      score:number;
      columns:Record<string,string>;
      missingRequired:string[];
    };
    activeSheetsFound:string[];
    excludedSheetsFound:string[];
  };
  warnings:string[];
  draft:Record<string,unknown>;
};

type MonthSheetPreview = {
  ready:boolean;
  errors:string[];
  warnings:string[];
  plan:{
    targetMonth:string;
    sourceMonth:string;
    sourceSheetId:number;
    inputColumns:string[];
    formulaColumns:string[];
    clearRanges:string[];
  };
  activation:{
    mappingEnabled:boolean;
    monthCreationEnabled:boolean;
    verifiedCopy:boolean;
  };
};

type MonthHistoryRun = {
  id:string;
  status?:string;
  sourceMonth?:string;
  targetMonth?:string;
  errorMessage?:string;
  startedAt?:string;
};



type LocalGasFile = {
  filename:string;
  source:string;
  size:number;
};

type GasSecretFinding = {
  id:string;
  filename:string;
  line:number;
  risk:"critical"|"high"|"medium";
  category:string;
  label:string;
  evidenceMasked:string;
  recommendation:string;
};

type GasAuditFindingView = {
  id:string;
  filename?:string;
  line:number;
  risk:string;
  category:string;
  title:string;
  evidence:string;
  recommendation:string;
  affectedColumns?:string[];
};

type GasAuditView = {
  gasAuditId:string;
  report:{
    grade:string;
    score:number;
    blockers:number;
    summary:Record<string,number>;
    findings:GasAuditFindingView[];
  };
};

type PilotCheck = {
  key:string;
  label:string;
  ok:boolean;
};

type PilotReadiness = {
  ready:boolean;
  checks:PilotCheck[];
  blockedCount:number;
  deadLetterCount:number;
  recentQueues:Array<{
    id:string;
    status?:string;
    sheetName?:string;
    startRow?:number;
    endRow?:number;
    errorMessage?:string;
  }>;
};

type PilotRolloutStatus = {
  rolloutId:string;
  releaseId:string;
  status:"preparing"|"active"|"blocked"|"stopped"|"review_required"|
    "expansion_review_pending"|"expansion_blocked"|"expansion_approved"|"expansion_rejected";
  participantCount:number;
  startedAt:string|null;
  endsAt:string|null;
  lastHealth:null|{
    action:"continue"|"watch"|"pause";
    observedAt:string|null;
    alerts:Array<{key:string;label:string;value:number;threshold:number;severity:string}>;
  };
};

type PilotExpansionCheck = {
  key:string;
  label:string;
  passed:boolean;
  blocking:boolean;
  actual:string|number|boolean;
  required:string;
};

type PilotExpansionAutomated = {
  pilotCompleted:boolean;
  participantCount:number;
  durationDays:number;
  inviteFailures:number;
  healthRunCount:number;
  expectedHealthRuns:number;
  monitoringCoveragePct:number;
  monitorFailureCount:number;
  criticalAlertCount:number;
  watchAlertCount:number;
  lastHealthAction:"continue"|"watch"|"pause"|"missing";
};

type PilotOutcomeValues = {
  totalCases:string;
  completedCases:string;
  moneyDiffYen:string;
  doubleBookings:string;
  mailTargetDiff:string;
  pdfDiff:string;
  manualQueue:string;
  supportCases:string;
  evidenceRefs:string;
  notes:string;
};

type PilotExpansionData = {
  rollout:null|{rolloutId:string;releaseId:string;status:string;participantCount:number;startedAt:string|null;endsAt:string|null};
  automated:PilotExpansionAutomated|null;
  review:null|{
    status:string;
    submittedAt:string|null;
    approvedAt:string|null;
    rejectedAt:string|null;
    decisionNote:string;
    fingerprint:string;
    currentAdminCanApprove:boolean;
    outcome:null|Record<string,unknown>;
    automated:PilotExpansionAutomated|null;
    gate:null|{
      eligible:boolean;
      completionRatePct:number;
      checks:PilotExpansionCheck[];
      blockers:PilotExpansionCheck[];
      warnings:PilotExpansionCheck[];
      fingerprint:string;
    };
  };
};

type StagedRolloutData = {
  stagedRolloutId:string;
  pilotRolloutId:string;
  releaseId:string;
  status:"ready"|"wave_preparing"|"observing"|"paused"|"stopped"|"completed";
  targetCount:number;
  wavePlan:Array<{waveNumber:number;startOffset:number;size:number;cumulativeCount:number}>;
  currentWave:number;
  deliveredCount:number;
  observationHours:number;
  requiredContinueRuns:number;
  consecutiveContinueRuns:number;
  criticalAlertCount:number;
  monitorFailureCount:number;
  inviteFailureCount:number;
  currentWaveStartedAt:string|null;
  lastHealth:null|{
    action:"continue"|"watch"|"pause"|"missing";
    observedAt:string|null;
    alerts:Array<{key:string;label:string;value:number;threshold:number;severity:string}>;
  };
  gate:{
    allowed:boolean;
    nextWave:null|{waveNumber:number;startOffset:number;size:number;cumulativeCount:number};
    checks:Array<{key:string;label:string;passed:boolean;actual:string|number|boolean;required:string}>;
    blockers:Array<{key:string;label:string;passed:boolean;actual:string|number|boolean;required:string}>;
    fingerprint:string;
  };
};

type ProductionManualChecks = {
  backupVerified:boolean;
  restoreTestPassed:boolean;
  gasHighCriticalZero:boolean;
  stagingSmokeGo:boolean;
  legalApproved:boolean;
  productionSecretsConfigured:boolean;
  cloudMonitoringReady:boolean;
  domainTlsReady:boolean;
  migrationPlanReady:boolean;
  rollbackPlanReady:boolean;
};

type ProductionControlData = {
  environment:string;
  rehearsalCertified:boolean;
  rehearsalFingerprint:string;
  stagedRollout:null|{
    stagedRolloutId:string;
    releaseId:string;
    status:string;
    targetCount:number;
    currentWave:number;
    deliveredCount:number;
    criticalAlertCount:number;
    monitorFailureCount:number;
    inviteFailureCount:number;
    lastHealthAction:string;
    completedAt:string|null;
  };
  review:null|{
    status:string;
    manual:ProductionManualChecks|null;
    evidenceRefs:string[];
    note:string;
    decisionNote:string;
    fingerprint:string;
    submittedAt:string|null;
    executiveApprovedAt:string|null;
    executiveRejectedAt:string|null;
    enabledAt:string|null;
    currentAdminCanExecutiveApprove:boolean;
    currentAdminCanEnable:boolean;
    gate:null|{
      eligible:boolean;
      checks:Array<{key:string;label:string;passed:boolean;actual:string|number|boolean;required:string}>;
      blockers:Array<{key:string;label:string;passed:boolean;actual:string|number|boolean;required:string}>;
      fingerprint:string;
    };
  };
  importedApproval:null|{
    approvalPackageId:string;
    status:string;
    releaseId:string;
    stagedRolloutId:string;
    sourceProjectId:string;
    targetProjectId:string;
    keyId:string;
    releaseFingerprint:string;
    rehearsalFingerprint:string;
    executiveApprovedEmail:string;
    issuedAt:string|null;
    expiresAt:string|null;
    importedAt:string|null;
    usedAt:string|null;
    currentAdminCanEnable:boolean;
  };
  control:{
    productionEnabled:boolean;
    emergencyLock:boolean;
    generation:number;
    activeStagedRolloutId:string;
    activeApprovalPackageId:string;
    pendingApprovalPackageId:string;
    emergencyReason:string;
    enabledAt:string|null;
    lockedAt:string|null;
  };
};

type ProductionRehearsalMetrics = {
  freezeConfirmed:boolean;firestoreExportComplete:boolean;storageManifestComplete:boolean;authExportComplete:boolean;
  sourceDocumentCount:number;sourceStorageObjectCount:number;sourceAuthUserCount:number;sourceSnapshotSha256:string;
  restoreComplete:boolean;restoredDocumentCount:number;restoredStorageObjectCount:number;restoredAuthUserCount:number;restoredSnapshotSha256:string;
  securityRulesDeployed:boolean;indexesReady:boolean;sampleMismatchCount:number;permissionProbeFailures:number;smokeFailures:number;
  migrationDryRunComplete:boolean;plannedMigrationCount:number;dryRunAppliedCount:number;migrationDiffCount:number;
  rollbackComplete:boolean;rollbackRtoMinutes:number;rollbackDataLossMinutes:number;postRollbackSmokeFailures:number;evidenceRefs:string[];
};

type ProductionRehearsalData = {
  rehearsalId:string;stagedRolloutId:string;releaseId:string;status:string;
  plan:null|{releaseId:string;sourceProjectId:string;restoreProjectId:string;backupBucket:string;maxRtoMinutes:number;maxRpoMinutes:number};
  planFingerprint:string;metrics:ProductionRehearsalMetrics|null;
  gate:null|{eligible:boolean;checks:Array<{key:string;label:string;passed:boolean;actual:string|number|boolean;required:string}>;blockers:Array<{key:string;label:string;passed:boolean;actual:string|number|boolean;required:string}>;fingerprint:string};
  createdAt:string|null;completedAt:string|null;abortedAt:string|null;abortedReason:string;
};

type ProductionCutoverReadiness = {
  signedApprovalReady:boolean;changeFreezeConfirmed:boolean;backupReferenceReady:boolean;rollbackOwnerAssigned:boolean;
  monitoringDashboardsReady:boolean;incidentChannelReady:boolean;supportRosterReady:boolean;smokePlanReady:boolean;migrationOwnerAssigned:boolean;
};
type ProductionCutoverObservation = {
  observedAtMs:number;authenticationAttempts:number;authenticationFailures:number;callableRequests:number;callableFailures:number;p95LatencyMs:number;
  sheetWriteFailures:number;notificationFailures:number;queueBacklog:number;smokeFailures:number;dataMismatchCount:number;criticalIncidentCount:number;monitoringProbeFailures:number;evidenceRefs:string[];
};
type ProductionCutoverGate = {
  action:"go"|"watch"|"pause"|"rollback_required"|"complete";phase:string;elapsedMinutes:number;
  checks:Array<{key:string;label:string;severity:string;passed:boolean;actual:string|number|boolean;required:string}>;
  blockers:Array<{key:string;label:string}>;rollbackBlockers:Array<{key:string;label:string}>;warnings:Array<{key:string;label:string}>;fingerprint:string;
};
type ProductionCutoverData = {
  runId:string;releaseId:string;approvalPackageId:string;status:string;windowStart:string;
  readiness:ProductionCutoverReadiness;readinessEvidenceRefs:string[];
  timeline:Array<{key:string;offsetMinutes:number;label:string;objective:string}>;
  lastObservation:ProductionCutoverObservation|null;consecutiveHealthyObservations:number;gate:ProductionCutoverGate|null;
  createdAt:string|null;completedAt:string|null;cancelledAt:string|null;rollbackStartedAt:string|null;rollbackReason:string;
};

type ProductionSloPolicy = {
  availabilityTargetPercent:number;authSuccessTargetPercent:number;callableSuccessTargetPercent:number;sheetWriteSuccessTargetPercent:number;notificationSuccessTargetPercent:number;
  p95LatencyTargetMs:number;queueOldestTargetMinutes:number;observationStaleWarnMinutes:number;observationStaleCriticalMinutes:number;requiredHealthyRunsForRecovery:number;
};
type ProductionSloEvaluation = {
  health:"healthy"|"at_risk"|"incident";severity:"SEV1"|"SEV2"|"SEV3"|null;incidentRequired:boolean;incidentKind:string|null;
  signals:Array<{key:string;label:string;passed:boolean;severity:string|null;actual:number|string;required:string}>;
  failedSignals:Array<{key:string;label:string;severity:string|null}>;
  windowResults:Array<{windowMinutes:number;totalRequests:number;failedRequests:number;availabilityPercent:number;burnRate:number}>;
  errorBudgetConsumedPercent:number;errorBudgetRemainingPercent:number;observationAgeMinutes:number|null;fingerprint:string;alertFingerprint:string;
};
type ProductionIncident = {
  incidentId:string;incidentNumber:string;releaseId:string;status:string;currentSeverity:string;highestSeverity:string;incidentKind:string;title:string;ownerName:string;
  failedSignalKeys:string[];recoveryHealthyRuns:number;updateCount:number;openedAt:string|null;acknowledgedAt:string|null;resolvedAt:string|null;rootCause:string;resolutionSummary:string;preventionAction:string;
};
type ProductionSloDashboard = {
  policy:ProductionSloPolicy;snapshot:null|{releaseId:string;policy:ProductionSloPolicy;evaluation:ProductionSloEvaluation|null;lastObservedAt:string|null;updatedAt:string|null};
  openIncident:ProductionIncident|null;recentIncidents:ProductionIncident[];
};
type ProductionSloObservationInput = {
  authenticationAttempts:number;authenticationFailures:number;callableRequests:number;callableFailures:number;sheetWriteAttempts:number;sheetWriteFailures:number;
  notificationAttempts:number;notificationFailures:number;p95LatencyMs:number;queueOldestAgeMinutes:number;dataMismatchCount:number;criticalOutageCount:number;monitoringProbeFailures:number;evidenceRefs:string[];
};
type ProductionTelemetryMetricKey = Exclude<keyof ProductionSloObservationInput,"evidenceRefs">;
type ProductionTelemetryStatus = {
  configured:boolean;enabled:boolean;projectId:string;metrics:Record<ProductionTelemetryMetricKey,string>;fingerprint:string;status:string;
  verifiedAt:string|null;lastCollectedAt:string|null;lastAttemptAt:string|null;lastWindowEnd:string|null;lastObservationId:string;lastRunId:string;lastError:string;
  exporterStatus:string;lastExportedAt:string|null;lastExportWindowEnd:string|null;lastExportRunId:string;lastExportError:string;
};
type ProductionDeploymentReadiness = {
  ready:boolean;
  checks:Array<{key:string;label:string;passed:boolean;actual:string|number|boolean;required:string}>;
  blockers:Array<{key:string;label:string;passed:boolean;actual:string|number|boolean;required:string}>;
  fingerprint:string;exportAgeMinutes:number|null;collectAgeMinutes:number|null;
  environment:string;runtimeProjectId:string;expectedProjectId:string;releaseApprovalPackageId:string;
};

type CutoverReadinessInput = Omit<ProductionCutoverReadiness,"signedApprovalReady">;
type CutoverObservationInput = Omit<ProductionCutoverObservation,"observedAtMs">;

const blankProductionManual:ProductionManualChecks = {
  backupVerified:false,
  restoreTestPassed:false,
  gasHighCriticalZero:false,
  stagingSmokeGo:false,
  legalApproved:false,
  productionSecretsConfigured:false,
  cloudMonitoringReady:false,
  domainTlsReady:false,
  migrationPlanReady:false,
  rollbackPlanReady:false,
};

const productionManualLabels:Array<[keyof ProductionManualChecks,string]> = [
  ["backupVerified","本番前バックアップ"],
  ["restoreTestPassed","復元演習"],
  ["gasHighCriticalZero","GAS高・重大リスク0件"],
  ["stagingSmokeGo","stagingスモークGO"],
  ["legalApproved","法務・社内規程確認"],
  ["productionSecretsConfigured","本番Secret設定"],
  ["cloudMonitoringReady","本番監視・通知"],
  ["domainTlsReady","独自ドメイン・TLS"],
  ["migrationPlanReady","移行計画"],
  ["rollbackPlanReady","切戻し計画"],
];
const rehearsalBackedManualKeys=new Set<keyof ProductionManualChecks>(["backupVerified","restoreTestPassed","migrationPlanReady","rollbackPlanReady"]);

const blankRehearsalMetrics:ProductionRehearsalMetrics={
  freezeConfirmed:false,firestoreExportComplete:false,storageManifestComplete:false,authExportComplete:false,
  sourceDocumentCount:0,sourceStorageObjectCount:0,sourceAuthUserCount:0,sourceSnapshotSha256:"",
  restoreComplete:false,restoredDocumentCount:0,restoredStorageObjectCount:0,restoredAuthUserCount:0,restoredSnapshotSha256:"",
  securityRulesDeployed:false,indexesReady:false,sampleMismatchCount:0,permissionProbeFailures:0,smokeFailures:0,
  migrationDryRunComplete:false,plannedMigrationCount:0,dryRunAppliedCount:0,migrationDiffCount:0,
  rollbackComplete:false,rollbackRtoMinutes:60,rollbackDataLossMinutes:0,postRollbackSmokeFailures:0,
  evidenceRefs:["freeze","firestore-export","storage-manifest","auth-export","restore-validation","migration-dry-run","rollback-drill"],
};

const blankCutoverReadiness:CutoverReadinessInput={changeFreezeConfirmed:false,backupReferenceReady:false,rollbackOwnerAssigned:false,monitoringDashboardsReady:false,incidentChannelReady:false,supportRosterReady:false,smokePlanReady:false,migrationOwnerAssigned:false};
const cutoverReadinessLabels:Array<[keyof CutoverReadinessInput,string]>=[
  ["changeFreezeConfirmed","変更凍結"],["backupReferenceReady","バックアップ参照"],["rollbackOwnerAssigned","切戻し責任者"],["monitoringDashboardsReady","監視ダッシュボード"],
  ["incidentChannelReady","障害連絡チャネル"],["supportRosterReady","当日サポート体制"],["smokePlanReady","本番smoke手順"],["migrationOwnerAssigned","移行責任者"],
];
const blankCutoverObservation:CutoverObservationInput={authenticationAttempts:0,authenticationFailures:0,callableRequests:0,callableFailures:0,p95LatencyMs:0,sheetWriteFailures:0,notificationFailures:0,queueBacklog:0,smokeFailures:0,dataMismatchCount:0,criticalIncidentCount:0,monitoringProbeFailures:0,evidenceRefs:["cloud-monitoring","production-smoke"]};
const defaultSloPolicy:ProductionSloPolicy={availabilityTargetPercent:99.9,authSuccessTargetPercent:99.5,callableSuccessTargetPercent:99.5,sheetWriteSuccessTargetPercent:99,notificationSuccessTargetPercent:98,p95LatencyTargetMs:2000,queueOldestTargetMinutes:15,observationStaleWarnMinutes:15,observationStaleCriticalMinutes:30,requiredHealthyRunsForRecovery:3};
const blankSloObservation:ProductionSloObservationInput={authenticationAttempts:1000,authenticationFailures:0,callableRequests:2000,callableFailures:0,sheetWriteAttempts:500,sheetWriteFailures:0,notificationAttempts:500,notificationFailures:0,p95LatencyMs:800,queueOldestAgeMinutes:2,dataMismatchCount:0,criticalOutageCount:0,monitoringProbeFailures:0,evidenceRefs:["cloud-monitoring/slo","operations/hourly-rollup"]};
const sloPolicyFields:Array<[keyof ProductionSloPolicy,string,number]>=[["availabilityTargetPercent","可用性 %",0.1],["authSuccessTargetPercent","認証成功 %",0.1],["callableSuccessTargetPercent","Functions成功 %",0.1],["sheetWriteSuccessTargetPercent","スプシ成功 %",0.1],["notificationSuccessTargetPercent","通知成功 %",0.1],["p95LatencyTargetMs","p95目標 ms",100],["queueOldestTargetMinutes","queue目標 分",1],["observationStaleWarnMinutes","監視断警告 分",1],["observationStaleCriticalMinutes","監視断重大 分",1],["requiredHealthyRunsForRecovery","復旧連続回数",1]];
const sloObservationFields:Array<[Exclude<keyof ProductionSloObservationInput,"evidenceRefs">,string]>=[["authenticationAttempts","認証試行"],["authenticationFailures","認証失敗"],["callableRequests","Functions要求"],["callableFailures","Functions失敗"],["sheetWriteAttempts","スプシ試行"],["sheetWriteFailures","スプシ失敗"],["notificationAttempts","通知試行"],["notificationFailures","通知失敗"],["p95LatencyMs","p95 ms"],["queueOldestAgeMinutes","最古queue 分"],["dataMismatchCount","データ差異"],["criticalOutageCount","重大停止"],["monitoringProbeFailures","監視probe失敗"]];
const defaultTelemetryMetrics:Record<ProductionTelemetryMetricKey,string>={authenticationAttempts:"custom.googleapis.com/lip_knots/authentication_attempts",authenticationFailures:"custom.googleapis.com/lip_knots/authentication_failures",callableRequests:"custom.googleapis.com/lip_knots/callable_requests",callableFailures:"custom.googleapis.com/lip_knots/callable_failures",sheetWriteAttempts:"custom.googleapis.com/lip_knots/sheet_write_attempts",sheetWriteFailures:"custom.googleapis.com/lip_knots/sheet_write_failures",notificationAttempts:"custom.googleapis.com/lip_knots/notification_attempts",notificationFailures:"custom.googleapis.com/lip_knots/notification_failures",p95LatencyMs:"custom.googleapis.com/lip_knots/p95_latency_ms",queueOldestAgeMinutes:"custom.googleapis.com/lip_knots/queue_oldest_age_minutes",dataMismatchCount:"custom.googleapis.com/lip_knots/data_mismatch_count",criticalOutageCount:"custom.googleapis.com/lip_knots/critical_outage_count",monitoringProbeFailures:"custom.googleapis.com/lip_knots/monitoring_probe_failures"};

const demoProductionControl:ProductionControlData={environment:"production",rehearsalCertified:true,rehearsalFingerprint:"48d1c7a25d933b9f69ee7d1b27b104b7812a5c64fdb9fd3668d9b0ed436e71fa",stagedRollout:{stagedRolloutId:"demo-rollout-v56",releaseId:"v5.6.0",status:"completed",targetCount:42,currentWave:3,deliveredCount:42,criticalAlertCount:0,monitorFailureCount:0,inviteFailureCount:0,lastHealthAction:"completed",completedAt:"2026-07-13T09:00:00.000Z"},review:{status:"enabled",manual:{...blankProductionManual,backupVerified:true,restoreTestPassed:true,gasHighCriticalZero:true,stagingSmokeGo:true,legalApproved:true,productionSecretsConfigured:true,cloudMonitoringReady:true,domainTlsReady:true,migrationPlanReady:true,rollbackPlanReady:true},evidenceRefs:["backup","restore","audit","smoke","monitoring"],note:"v5.6 production release",decisionNote:"全条件を確認し承認",fingerprint:"80ad39a263ba3ad393ea96f8817714aa9d71d84f74da8fdb78d6dbfc968b7850",submittedAt:"2026-07-13T07:00:00.000Z",executiveApprovedAt:"2026-07-13T07:30:00.000Z",executiveRejectedAt:null,enabledAt:"2026-07-13T09:00:00.000Z",currentAdminCanExecutiveApprove:false,currentAdminCanEnable:false,gate:{eligible:true,checks:[{key:"staged_rollout",label:"段階配布42名完了",passed:true,actual:42,required:"30〜50名"},{key:"rehearsal",label:"復元・切戻し演習",passed:true,actual:true,required:"合格"},{key:"monitoring",label:"Cloud Monitoring",passed:true,actual:true,required:"接続済み"}],blockers:[],fingerprint:"925fce7e608cb0e4d860ce998cd12c13f571de050869dbf07239d5df4e44ba53"}},importedApproval:{approvalPackageId:"demo-approval-v56",status:"used",releaseId:"v5.6.0",stagedRolloutId:"demo-rollout-v56",sourceProjectId:"lip-knots-staging",targetProjectId:"lip-knots-production",keyId:"production-signing-v1",releaseFingerprint:"f043c45a0382c3d3c669b53ac41e2fe0da0f6d62b928b31b036cb2171ef88a2b",rehearsalFingerprint:"48d1c7a25d933b9f69ee7d1b27b104b7812a5c64fdb9fd3668d9b0ed436e71fa",executiveApprovedEmail:"executive@example.jp",issuedAt:"2026-07-13T08:20:00.000Z",expiresAt:"2026-07-13T09:20:00.000Z",importedAt:"2026-07-13T08:30:00.000Z",usedAt:"2026-07-13T09:00:00.000Z",currentAdminCanEnable:false},control:{productionEnabled:true,emergencyLock:false,generation:42,activeStagedRolloutId:"demo-rollout-v56",activeApprovalPackageId:"demo-approval-v56",pendingApprovalPackageId:"",emergencyReason:"",enabledAt:"2026-07-13T09:00:00.000Z",lockedAt:null}};
const demoProductionCutover:ProductionCutoverData={runId:"demo-cutover-v56",releaseId:"v5.6.0",approvalPackageId:"demo-approval-v56",status:"monitoring",windowStart:"2026-07-13T09:00:00.000Z",readiness:{signedApprovalReady:true,changeFreezeConfirmed:true,backupReferenceReady:true,rollbackOwnerAssigned:true,monitoringDashboardsReady:true,incidentChannelReady:true,supportRosterReady:true,smokePlanReady:true,migrationOwnerAssigned:true},readinessEvidenceRefs:["evidence/change-freeze.md","evidence/rollback-owner.md","evidence/monitoring-dashboard.url"],timeline:[{key:"t-60",offsetMinutes:-60,label:"T−60",objective:"変更凍結・backup確認"},{key:"t-15",offsetMinutes:-15,label:"T−15",objective:"GO判断"},{key:"t0",offsetMinutes:0,label:"T±0",objective:"本番有効化"},{key:"t+15",offsetMinutes:15,label:"T＋15",objective:"初期smoke"},{key:"t+60",offsetMinutes:60,label:"T＋60",objective:"業務導線確認"},{key:"t+240",offsetMinutes:240,label:"T＋4h",objective:"中間SLO確認"},{key:"t+1440",offsetMinutes:1440,label:"T＋24h",objective:"切替完了固定"}],lastObservation:{observedAtMs:Date.parse("2026-07-14T09:00:00.000Z"),authenticationAttempts:2380,authenticationFailures:1,callableRequests:6240,callableFailures:2,p95LatencyMs:842,sheetWriteFailures:0,notificationFailures:0,queueBacklog:1,smokeFailures:0,dataMismatchCount:0,criticalIncidentCount:0,monitoringProbeFailures:0,evidenceRefs:["cloud-monitoring://demo","production-smoke://demo"]},consecutiveHealthyObservations:12,gate:{action:"go",phase:"T+24h-monitoring",elapsedMinutes:1380,checks:[{key:"auth",label:"認証成功率",severity:"rollback",passed:true,actual:"99.96%",required:"99.5%以上"},{key:"functions",label:"Functions成功率",severity:"rollback",passed:true,actual:"99.97%",required:"99.5%以上"},{key:"latency",label:"p95レイテンシ",severity:"pause",passed:true,actual:842,required:"2000ms以下"},{key:"data",label:"データ差異",severity:"rollback",passed:true,actual:0,required:"0件"}],blockers:[],rollbackBlockers:[],warnings:[],fingerprint:"6d606d8ebaa7c1a41683b1d486be87075b946511a5d560671ea24c75ea1e86df"},createdAt:"2026-07-13T08:00:00.000Z",completedAt:null,cancelledAt:null,rollbackStartedAt:null,rollbackReason:""};
const demoProductionSlo:ProductionSloDashboard={policy:defaultSloPolicy,snapshot:{releaseId:"v5.6.0",policy:defaultSloPolicy,lastObservedAt:"2026-07-14T09:00:00.000Z",updatedAt:"2026-07-14T09:00:04.000Z",evaluation:{health:"healthy",severity:null,incidentRequired:false,incidentKind:null,signals:[{key:"auth_success",label:"認証成功率",passed:true,severity:null,actual:99.96,required:"99.5%以上"},{key:"callable_success",label:"Functions成功率",passed:true,severity:null,actual:99.97,required:"99.5%以上"},{key:"sheet_success",label:"スプシ書込成功率",passed:true,severity:null,actual:100,required:"99%以上"},{key:"notification_success",label:"通知成功率",passed:true,severity:null,actual:100,required:"98%以上"},{key:"latency",label:"p95レイテンシ",passed:true,severity:null,actual:842,required:"2000ms以下"},{key:"queue",label:"queue最古滞留",passed:true,severity:null,actual:1,required:"15分以下"},{key:"integrity",label:"データ整合性",passed:true,severity:null,actual:0,required:"0件"},{key:"monitoring",label:"監視probe",passed:true,severity:null,actual:0,required:"0件"}],failedSignals:[],windowResults:[{windowMinutes:60,totalRequests:8620,failedRequests:3,availabilityPercent:99.965,burnRate:.35},{windowMinutes:360,totalRequests:48740,failedRequests:12,availabilityPercent:99.975,burnRate:.25},{windowMinutes:1440,totalRequests:181230,failedRequests:48,availabilityPercent:99.974,burnRate:.26},{windowMinutes:43200,totalRequests:4268140,failedRequests:1218,availabilityPercent:99.971,burnRate:.29}],errorBudgetConsumedPercent:28.5,errorBudgetRemainingPercent:71.5,observationAgeMinutes:4,fingerprint:"e915c30d67904fdb5e0f2c6222dc8ba4f70deeb2280a89ef5fa940d23dd3361b",alertFingerprint:"healthy"}},openIncident:null,recentIncidents:[{incidentId:"demo-inc-0711",incidentNumber:"INC-20260711-A38F21",releaseId:"v5.6.0",status:"resolved",currentSeverity:"SEV3",highestSeverity:"SEV3",incidentKind:"latency",title:"p95レイテンシ一時上昇",ownerName:"運用担当",failedSignalKeys:["latency"],recoveryHealthyRuns:3,updateCount:4,openedAt:"2026-07-11T03:20:00.000Z",acknowledgedAt:"2026-07-11T03:24:00.000Z",resolvedAt:"2026-07-11T03:48:00.000Z",rootCause:"外部API応答の一時遅延",resolutionSummary:"再試行制御で正常化を確認",preventionAction:"外部APIの遅延アラートを追加"}]};
const demoTelemetryStatus:ProductionTelemetryStatus={configured:true,enabled:true,projectId:"lip-knots-production",metrics:defaultTelemetryMetrics,fingerprint:"d4f0f2e4aa8078ad97b5734e635914d14189cdb8247e341a187ad632fd74b36c",status:"collecting",verifiedAt:"2026-07-13T08:42:00.000Z",lastCollectedAt:"2026-07-14T09:00:04.000Z",lastAttemptAt:"2026-07-14T09:00:00.000Z",lastWindowEnd:"2026-07-14T09:00:00.000Z",lastObservationId:"demo-observation-v46",lastRunId:"demo-ingest-v46",lastError:"",exporterStatus:"publishing",lastExportedAt:"2026-07-14T09:01:02.000Z",lastExportWindowEnd:"2026-07-14T09:00:00.000Z",lastExportRunId:"demo-export-v46",lastExportError:""};
const demoDeploymentReadiness:ProductionDeploymentReadiness={ready:true,checks:[
  ["environment","production環境","production","production"],["project","実行Project固定","lip-knots-production / lip-knots-production","一致"],["production_enabled","署名承認Release有効",true,"有効・承認IDあり"],["emergency_lock","全体停止なし",false,"false"],["telemetry_config","監視設定",true,"保存済み・ON"],["metric_count","Metric 13指標",13,"13"],["tenant_isolation","企業ラベル分離",true,"company_id必須"],["telemetry_verified","接続テスト",true,"合格"],["exporter","実測生成","publishing","publishing"],["export_fresh","生成鮮度",1,"10分以内"],["collector","SLO取込","collecting","collecting"],["collect_fresh","取込鮮度",4,"10分以内"],
].map(([key,label,actual,required])=>({key:String(key),label:String(label),passed:true,actual:actual as string|number|boolean,required:String(required)})),blockers:[],fingerprint:"9a9a9075e22f4816bc46434e3d8b62a4f658be126bcbce915cf038bcfbed70d1",exportAgeMinutes:1,collectAgeMinutes:4,environment:"production",runtimeProjectId:"lip-knots-production",expectedProjectId:"lip-knots-production",releaseApprovalPackageId:"demo-approval-v56"};

const blankPilotOutcome:PilotOutcomeValues = {
  totalCases:"20",
  completedCases:"20",
  moneyDiffYen:"0",
  doubleBookings:"0",
  mailTargetDiff:"0",
  pdfDiff:"0",
  manualQueue:"0",
  supportCases:"0",
  evidenceRefs:"evidence/pilot-result.csv\nevidence/monitoring.json",
  notes:"",
};

type RowCreationPreview = {
  ready:boolean;
  errors:string[];
  warnings:string[];
  sheetName:string;
  templateRow:number;
  insertBeforeRow:number;
  insertedRows:number[];
  formulaColumns:string[];
  requiredValidationColumns:string[];
};

const demoPilotReadiness:PilotReadiness = {
  ready:false,
  checks:[
    {key:"shift_read",label:"シフト表の読取同期",ok:true},
    {key:"staff_read",label:"スタッフ名簿の読取同期",ok:true},
    {key:"safe_mapping",label:"安全書込マッピング",ok:true},
    {key:"row_creation",label:"新規行追加",ok:false},
    {key:"case_id",label:"案件ID列",ok:true},
    {key:"feature_flag",label:"管理画面の案件追加",ok:false},
    {key:"blocked_queue",label:"停止中の行追加キューなし",ok:true},
  ],
  blockedCount:0,
  deadLetterCount:0,
  recentQueues:[],
};

type JobForm = {
  workDate:string; clientName:string; storeName:string; makerName:string;
  storeAddress:string; storeNearestStation:string;
  menuName:string; entryTime:string; workTime:string; subcontractorName:string;
  slots:string; basePay:string; publicationMode:"draft"|"immediate"|"scheduled";
  publishAt:string;
};

type JobEditForm = {
  clientName:string; storeName:string; makerName:string; menuName:string;
  storeAddress:string; storeNearestStation:string;
  entryTime:string; workTime:string; subcontractorName:string;
  assignedStaffId:string;
  invoiceBase:string; invoiceBusinessAllowance:string; invoiceRemoteAllowance:string;
  invoiceUrgentAllowance:string; invoiceOutsideAllowance:string; invoiceBusyAllowance:string;
  invoiceMedicalCheck:string; invoiceOther:string;
  staffBasePay:string; staffBusinessAllowance:string; staffRemoteAllowance:string;
  staffUrgentAllowance:string; staffOutsideAllowance:string; staffBusyAllowance:string;
  staffMedicalCheck:string; staffOther:string;
};

const blankJobForm:JobForm = {
  workDate:"2026-08-01", clientName:"", storeName:"", makerName:"",
  storeAddress:"", storeNearestStation:"",
  menuName:"", entryTime:"9:45", workTime:"10:00～18:00", subcontractorName:"",
  slots:"1", basePay:"10000", publicationMode:"draft", publishAt:"",
};

const blankJobEdit:JobEditForm = {
  clientName:"",storeName:"",makerName:"",menuName:"",entryTime:"",workTime:"",
  storeAddress:"",storeNearestStation:"",
  subcontractorName:"",assignedStaffId:"",
  invoiceBase:"",invoiceBusinessAllowance:"",invoiceRemoteAllowance:"",
  invoiceUrgentAllowance:"",invoiceOutsideAllowance:"",invoiceBusyAllowance:"",
  invoiceMedicalCheck:"",invoiceOther:"",
  staffBasePay:"",staffBusinessAllowance:"",staffRemoteAllowance:"",
  staffUrgentAllowance:"",staffOutsideAllowance:"",staffBusyAllowance:"",
  staffMedicalCheck:"",staffOther:"",
};

const invoiceLabels:Array<[keyof JobEditForm,string]> = [
  ["invoiceBase","請求 基本単価"],["invoiceBusinessAllowance","請求 業務手当"],
  ["invoiceRemoteAllowance","請求 遠方手当"],["invoiceUrgentAllowance","請求 緊急手当"],
  ["invoiceOutsideAllowance","請求 店外手当"],["invoiceBusyAllowance","請求 繁忙手当"],
  ["invoiceMedicalCheck","請求 検査手当"],["invoiceOther","請求 その他"],
];
const staffPayLabels:Array<[keyof JobEditForm,string]> = [
  ["staffBasePay","支払 基本給"],["staffBusinessAllowance","支払 業務手当"],
  ["staffRemoteAllowance","支払 遠方手当"],["staffUrgentAllowance","支払 緊急手当"],
  ["staffOutsideAllowance","支払 店外手当"],["staffBusyAllowance","支払 繁忙手当"],
  ["staffMedicalCheck","支払 検査手当"],["staffOther","支払 その他"],
];


function currentTokyoMonth():string{
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit"}).format(new Date()).slice(0,7);
}
function yen(value:number):string{return `${Math.round(value).toLocaleString("ja-JP")}円`;}
function percent(value:number|null):string{return value===null?"－":`${(value*100).toFixed(1)}%`;}
function currentPushPermission():NotificationPermission|"unsupported"{
  return typeof Notification==="undefined"?"unsupported":Notification.permission;
}

function demoPreview(label:string,color:string){
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480"><rect width="100%" height="100%" fill="${color}"/><rect x="40" y="40" width="640" height="400" rx="24" fill="white" stroke="#d9c8ce"/><text x="360" y="220" text-anchor="middle" font-size="36" fill="#5f4b44" font-family="sans-serif">${label}</text><text x="360" y="270" text-anchor="middle" font-size="18" fill="#9b7e87" font-family="sans-serif">営業デモ用プレビュー</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

type StaffDevice = {
  id: string;
  label?: string;
  platform?: string;
  active?: boolean;
  lastSeenAt?: string;
};

const demoStaff: StaffProfile[] = [
  { id:"s1", displayName:"Aさん", emails:["a@example.com","a.sub@example.com"], nearestStation:"津田沼駅", homePrefecture:"千葉県", areaLabels:["首都圏・北関東"], rank:"A", active:true },
  { id:"s2", displayName:"Bさん", emails:["b@example.com"], nearestStation:"船橋駅", homePrefecture:"千葉県", areaLabels:["首都圏・北関東"], rank:"S", active:true },
  { id:"s3", displayName:"Cさん", emails:["c@example.com"], nearestStation:"仙台駅", homePrefecture:"宮城県", areaLabels:["東北"], rank:"A", active:true },
];

const demoJobs: Job[] = [
  { id:"1", workDate:"2026-07-15", clientName:"〇〇デモ", storeName:"イオン津田沼", storeAddress:"千葉県習志野市津田沼1丁目23-1", storeNearestStation:"新津田沼駅", makerName:"〇〇食品", menuName:"試食販売", entryTime:"9:45", workTime:"10:00～18:00", basePay:10000, revision:0, assignedStaffName:"Aさん", assignedStaffId:"s1", status:"assigned", financials:{clientChargeTotal:15000,clientChargeAdditionsTotal:1200,staffPaymentTotal:10000,subcontractorTotal:0} },
  { id:"2", workDate:"2026-07-15", clientName:"〇〇デモ", storeName:"イオン船橋", storeAddress:"千葉県船橋市山手1丁目1-8", storeNearestStation:"新船橋駅", makerName:"〇〇乳業", menuName:"ヨーグルト試食", entryTime:"9:45", workTime:"10:00～18:00", basePay:10500, revision:0, assignedStaffName:"Bさん", assignedStaffId:"s2", status:"assigned", preContact:{}, financials:{clientChargeTotal:15000,clientChargeAdditionsTotal:800,staffPaymentTotal:10500,subcontractorTotal:0} },
  { id:"3", workDate:"2026-07-12", clientName:"△△企画", storeName:"ベイシア成田", makerName:"△△菓子", menuName:"菓子試食", entryTime:"10:45", workTime:"11:00～19:00", basePay:11000, revision:0, assignedStaffName:"Cさん", assignedStaffId:"s3", status:"assigned", financials:{clientChargeTotal:16000,clientChargeAdditionsTotal:1500,staffPaymentTotal:11000,subcontractorTotal:0}, preContactLate:true, submissionStatus:{report:{lateFirstSubmission:true}} },
  { id:"4", workDate:"2026-07-08", clientName:"〇〇デモ", storeName:"イオン幕張", makerName:"〇〇食品", assignedStaffName:"Aさん", assignedStaffId:"s1", status:"cancelled", cancelled:true, cancellationReason:"メーカー都合", cancellationReasonCategory:"maker", cancellationFinancialTreatment:"invoice_only", financials:{clientChargeTotal:15000,clientChargeAdditionsTotal:0,staffPaymentTotal:10000,subcontractorTotal:0} },
 ];

const demoDashboard: DashboardData = {
  month:"2026-07",
  counts:{totalRequests:4,effectiveJobs:3,implemented:1,scheduled:2,cancelled:1,open:0,assigned:3,stopped:0,draft:0,executionRate:.5,cancellationRate:.25},
  finance:{bookedInvoice:63600,bookedPayment:31500,bookedGrossProfit:32100,bookedGrossMargin:32100/63600,implementedInvoice:17500,implementedPayment:11000,implementedGrossProfit:6500},
  cancellationReasons:[{name:"メーカー都合",count:1}],
  cancellationTreatments:[{name:"請求あり・支払なし",count:1}],
  clients:[
    {name:"〇〇デモ",count:3,invoice:46100,payment:20500,grossProfit:25600,cancelled:1},
    {name:"△△企画",count:1,invoice:17500,payment:11000,grossProfit:6500,cancelled:0},
  ],
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [jobs, setJobs] = useState<Job[]>(firebaseConfigured ? [] : demoJobs);
  const [message, setMessage] = useState("");
  const [queryText, setQueryText] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncSummary, setSyncSummary] = useState<string>("未実行");
  const [staff, setStaff] = useState<StaffProfile[]>(
    firebaseConfigured ? [] : demoStaff
  );
  const [staffQuery, setStaffQuery] = useState("");
  const [staffSyncBusy, setStaffSyncBusy] = useState(false);
  const [staffSyncSummary, setStaffSyncSummary] = useState("未実行");
  const [inviteCandidates, setInviteCandidates] = useState<InviteCandidate[]>([]);
  const [selectedInviteIds, setSelectedInviteIds] = useState<string[]>([]);
  const [inviteSubject, setInviteSubject] = useState("Lip Knots Crew ご利用のご案内");
  const [inviteIntro, setInviteIntro] = useState("今後のシフト確認や事前連絡、報告書提出に使用します。");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [pilotReleaseId, setPilotReleaseId] = useState("v5.6.0-pilot");
  const [pilotDurationDays, setPilotDurationDays] = useState("7");
  const [pilotRolloutStatus, setPilotRolloutStatus] = useState<PilotRolloutStatus|null>(null);
  const [pilotExpansion, setPilotExpansion] = useState<PilotExpansionData|null>(null);
  const [pilotOutcome, setPilotOutcome] = useState<PilotOutcomeValues>(blankPilotOutcome);
  const [pilotDecisionNote, setPilotDecisionNote] = useState("");
  const [pilotExpansionBusy, setPilotExpansionBusy] = useState(false);
  const [stagedRollout, setStagedRollout] = useState<StagedRolloutData|null>(null);
  const [stagedObservationHours, setStagedObservationHours] = useState("24");
  const [stagedContinueRuns, setStagedContinueRuns] = useState("12");
  const [stagedRolloutBusy, setStagedRolloutBusy] = useState(false);
  const [productionControl, setProductionControl] = useState<ProductionControlData|null>(firebaseConfigured?null:demoProductionControl);
  const [productionManual, setProductionManual] = useState<ProductionManualChecks>(blankProductionManual);
  const [productionEvidence, setProductionEvidence] = useState("evidence/backup.json\nevidence/restore-test.json\nevidence/gas-audit.json\nevidence/staging-smoke.json\nevidence/rollback-plan.md");
  const [productionNote, setProductionNote] = useState("");
  const [productionDecisionNote, setProductionDecisionNote] = useState("");
  const [approvalPackageText, setApprovalPackageText] = useState("");
  const [approvalPackageExpiresAt, setApprovalPackageExpiresAt] = useState("");
  const [productionKillReason, setProductionKillReason] = useState("");
  const [productionBusy, setProductionBusy] = useState(false);
  const [productionRehearsal, setProductionRehearsal] = useState<ProductionRehearsalData|null>(null);
  const [rehearsalRestoreProject, setRehearsalRestoreProject] = useState("lkc-restore-drill");
  const [rehearsalBackupBucket, setRehearsalBackupBucket] = useState("gs://lkc-production-rehearsal");
  const [rehearsalMetrics, setRehearsalMetrics] = useState<ProductionRehearsalMetrics>(blankRehearsalMetrics);
  const [rehearsalBusy, setRehearsalBusy] = useState(false);
  const [productionCutover, setProductionCutover] = useState<ProductionCutoverData|null>(firebaseConfigured?null:demoProductionCutover);
  const [cutoverReleaseId, setCutoverReleaseId] = useState("v5.6.0");
  const [cutoverWindowStart, setCutoverWindowStart] = useState(()=>new Date(Date.now()+60*60_000).toISOString().slice(0,16));
  const [cutoverReadiness, setCutoverReadiness] = useState<CutoverReadinessInput>(blankCutoverReadiness);
  const [cutoverReadinessEvidence, setCutoverReadinessEvidence] = useState("evidence/change-freeze.md\nevidence/rollback-owner.md\nevidence/monitoring-dashboard.url");
  const [cutoverObservation, setCutoverObservation] = useState<CutoverObservationInput>(blankCutoverObservation);
  const [cutoverBusy, setCutoverBusy] = useState(false);
  const [productionSlo, setProductionSlo] = useState<ProductionSloDashboard|null>(firebaseConfigured?null:demoProductionSlo);
  const [sloPolicy, setSloPolicy] = useState<ProductionSloPolicy>(defaultSloPolicy);
  const [sloObservation, setSloObservation] = useState<ProductionSloObservationInput>(blankSloObservation);
  const [sloBusy, setSloBusy] = useState(false);
  const [telemetryStatus, setTelemetryStatus] = useState<ProductionTelemetryStatus|null>(firebaseConfigured?null:demoTelemetryStatus);
  const [telemetryProjectId, setTelemetryProjectId] = useState(firebaseConfigured?"":"lip-knots-production");
  const [telemetryEnabled, setTelemetryEnabled] = useState(!firebaseConfigured);
  const [telemetryMetrics, setTelemetryMetrics] = useState<Record<ProductionTelemetryMetricKey,string>>(defaultTelemetryMetrics);
  const [telemetryBusy, setTelemetryBusy] = useState(false);
  const [deploymentReadiness, setDeploymentReadiness] = useState<ProductionDeploymentReadiness|null>(firebaseConfigured?null:demoDeploymentReadiness);
  const [deploymentReadinessBusy, setDeploymentReadinessBusy] = useState(false);
  const [productionEvidenceStatus, setProductionEvidenceStatus] = useState<ProductionEvidenceView>({configured:!firebaseConfigured,environment:"production",releaseId:"v5.6.0",evidence:null});
  const [productionEvidenceBusy, setProductionEvidenceBusy] = useState(false);
  const [incidentOwner, setIncidentOwner] = useState("");
  const [incidentNote, setIncidentNote] = useState("");
  const [incidentRootCause, setIncidentRootCause] = useState("");
  const [incidentResolution, setIncidentResolution] = useState("");
  const [incidentPrevention, setIncidentPrevention] = useState("");
  const [incidentEvidence, setIncidentEvidence] = useState("evidence/incident-timeline.md\nevidence/recovery-verification.json");
  const [deviceStaffName, setDeviceStaffName] = useState("");
  const [staffDevices, setStaffDevices] = useState<StaffDevice[]>([]);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [selectedAdminJobId, setSelectedAdminJobId] = useState(demoJobs[0]?.id ?? "");
  const [netPrintNumbers, setNetPrintNumbers] = useState(["", "", ""]);
  const [resubmitType, setResubmitType] = useState<"report" | "sales_floor">("report");
  const [resubmitReasons, setResubmitReasons] = useState<string[]>(["手ブレで文字が読めません"]);
  const [resubmitNote, setResubmitNote] = useState("");
  const [resubmissions, setResubmissions] = useState<ResubmissionRequest[]>([]);
  const [submissionTimeline, setSubmissionTimeline] = useState<SubmissionGroup[]>([]);
  const [selectedSourceFile, setSelectedSourceFile] = useState<SubmissionFile | null>(null);
  const [comparison, setComparison] = useState<ResubmissionComparison | null>(null);
  const [timelineBusy, setTimelineBusy] = useState(false);
  const [sheetIssues, setSheetIssues] = useState<SheetWriteIssue[]>([]);
  const [issuesBusy, setIssuesBusy] = useState(false);
  const [expenseJobId, setExpenseJobId] = useState(demoJobs[0]?.id ?? "");
  const [expenseValues, setExpenseValues] = useState<ExpenseValues>(blankExpense);
  const [expenseNote, setExpenseNote] = useState("");
  const [expenseStatus, setExpenseStatus] = useState("未読込");
  const [expenseBusy, setExpenseBusy] = useState(false);
  const [dashboardMonth, setDashboardMonth] = useState(currentTokyoMonth());
  const [dashboard, setDashboard] = useState<DashboardData | null>(firebaseConfigured ? null : demoDashboard);
  const [dashboardBusy, setDashboardBusy] = useState(false);
  const [cancellationJobId, setCancellationJobId] = useState(demoJobs.find((job)=>job.status!=="cancelled")?.id ?? "");
  const [cancellationReasonCategory, setCancellationReasonCategory] = useState("maker");
  const [cancellationTreatment, setCancellationTreatment] = useState("invoice_and_pay");
  const [cancellationNote, setCancellationNote] = useState("");
  const [cancellationBusy, setCancellationBusy] = useState(false);
  const [performance, setPerformance] = useState<StaffPerformanceData | null>(null);
  const [performanceBusy, setPerformanceBusy] = useState(false);

const [jobForm, setJobForm] = useState<JobForm>(blankJobForm);
const [jobCreateBusy, setJobCreateBusy] = useState(false);
const [jobEditId, setJobEditId] = useState(demoJobs[0]?.id ?? "");
const [jobEdit, setJobEdit] = useState<JobEditForm>(blankJobEdit);
const [jobEditRevision, setJobEditRevision] = useState(0);
const [jobEditBusy, setJobEditBusy] = useState(false);
const [exportFrom, setExportFrom] = useState("2026-07-01");
const [exportThrough, setExportThrough] = useState("2026-07-31");
const [exportGroupBy, setExportGroupBy] = useState<"client"|"maker">("client");
const [exportName, setExportName] = useState("");
const [exportIncludeCancelled, setExportIncludeCancelled] = useState(false);
const [exportBusy, setExportBusy] = useState(false);

const [pilotReadiness, setPilotReadiness] = useState<PilotReadiness>(
  firebaseConfigured ? { ...demoPilotReadiness, checks:[] } : demoPilotReadiness
);
const [pilotPreview, setPilotPreview] = useState<RowCreationPreview | null>(null);
const [pilotBusy, setPilotBusy] = useState(false);

const [gasFiles, setGasFiles] = useState<LocalGasFile[]>([]);
const [gasSecretFindings, setGasSecretFindings] = useState<GasSecretFinding[]>([]);
const [gasAuditView, setGasAuditView] = useState<GasAuditView | null>(null);
const [gasAuditBusy, setGasAuditBusy] = useState(false);
const [gasRiskFilter, setGasRiskFilter] = useState("all");


const [setupShiftSpreadsheet, setSetupShiftSpreadsheet] = useState("");
const [setupStaffSpreadsheet, setSetupStaffSpreadsheet] = useState("");
const [setupShiftSampleSheet, setSetupShiftSampleSheet] = useState("");
const [setupActiveSheets, setSetupActiveSheets] = useState("マスタ,東北");
const [setupExcludedSheets, setSetupExcludedSheets] = useState("抹消");
const [setupWizardResult, setSetupWizardResult] = useState<SetupWizardResult | null>(null);
const [setupBusy, setSetupBusy] = useState(false);
const [monthTarget, setMonthTarget] = useState("2026.8");
const [monthSource, setMonthSource] = useState("");
const [monthPreview, setMonthPreview] = useState<MonthSheetPreview | null>(null);
const [monthHistory, setMonthHistory] = useState<MonthHistoryRun[]>([]);
const [monthBusy, setMonthBusy] = useState(false);




  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, async (current) => {
      setUser(current);
      if (current && functions) {
        const bootstrap = httpsCallable(functions, "bootstrapSession");
        await bootstrap();
        await current.getIdToken(true);
        const { loadServerPushStatus } = await import("./push");
        const enabled = await loadServerPushStatus(functions);
        setPushEnabled(enabled);
        await Promise.all([loadJobs(), loadStaff(), loadSheetIssues(), loadDashboard(), loadPilotReadiness(), loadPilotRolloutStatus(), loadPilotExpansionReview(), loadStagedRolloutStatus(), loadProductionControlStatus(), loadProductionRehearsalStatus(), loadProductionCutoverStatus(), loadProductionSloDashboard(), loadProductionTelemetryStatus(), loadProductionDeploymentReadiness(), loadProductionReleaseEvidenceStatus(), loadMonthHistory()]);
      }
    });
  }, []);


  useEffect(() => {
    if (!selectedAdminJobId) return;
    void loadSubmissionTimeline();
  }, [selectedAdminJobId, resubmitType]);

  useEffect(() => {
    if (!user) return;
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    void import("./push")
      .then(({ listenForForegroundPush }) => listenForForegroundPush((payload) => {
        const title = payload.data?.title ?? "Lip Knots Crew";
        const body = payload.data?.body ?? "新しい管理通知があります。";
        setMessage(`${title}：${body}`);
      }))
      .then((value) => {
        if (cancelled) value?.();
        else unsubscribe = value;
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [user]);



async function inspectSetup() {
  if (!setupShiftSpreadsheet.trim()) {
    setMessage("シフト表のURLまたはIDを入力してください。");
    return;
  }
  setSetupBusy(true);
  try {
    if (!firebaseConfigured) {
      const demo:SetupWizardResult = {
        inspectionId:"demo-inspection",
        expiresAt:new Date(Date.now()+86400000).toISOString(),
        shiftSpreadsheet:{
          id:"demo-shift",
          title:"Lip Knots シフト表",
          sampleSheet:setupShiftSampleSheet || "2026.7",
          monthTabs:["2026.5","2026.6","2026.7"],
          header:{
            headerRow:1,
            score:20,
            columns:{workDate:"A",staffName:"B",temperature:"G",arrivalTime:"H",clientName:"J",storeName:"K",makerName:"L",menuName:"M",entryTime:"N",workTime:"O",subcontractorName:"P",caseId:"ZZ"},
            missingRequired:[],
          },
          formulaColumns:["AA","AJ","AR","BB"],
          validationColumns:["B"],
        },
        staffSpreadsheet:{
          id:"demo-staff",
          title:"Lip Knots スタッフ管理",
          sampleSheet:"マスタ",
          header:{
            headerRow:1,
            score:10,
            columns:{displayName:"B",homePrefecture:"G",nearestStation:"P",birthDate:"Q",email:"S",phone:"T"},
            missingRequired:[],
          },
          activeSheetsFound:["マスタ","東北"],
          excludedSheetsFound:["抹消"],
        },
        warnings:["すべてOFFの設定下書きとして生成します。"],
        draft:{safety:{allEnabled:false},shiftImportConfig:{enabled:false},staffImportConfig:{enabled:false},shiftMapping:{enabled:false,rowCreation:{enabled:false},monthCreation:{enabled:false}},companyFeatureSettings:{adminJobCreationSourceReady:false,monthSheetCreationReady:false}},
      };
      setSetupWizardResult(demo);
      setMonthSource("2026.7");
      setMessage("デモ：スプレッドシート構成を検査しました。");
      return;
    }
    if (!functions) return;
    const callable = httpsCallable(functions, "inspectSetupWizard");
    const response = await callable({
      shiftSpreadsheet:setupShiftSpreadsheet.trim(),
      staffSpreadsheet:setupStaffSpreadsheet.trim() || undefined,
      shiftSampleSheet:setupShiftSampleSheet.trim() || undefined,
      staffActiveSheets:setupActiveSheets.split(",").map((value)=>value.trim()).filter(Boolean),
      staffExcludedSheets:setupExcludedSheets.split(",").map((value)=>value.trim()).filter(Boolean),
      preferredIdColumn:"ZZ",
    });
    const result = response.data as SetupWizardResult;
    setSetupWizardResult(result);
    setMonthSource(result.shiftSpreadsheet.monthTabs.at(-1) ?? "");
    setMessage(
      result.warnings.length
        ? `検査完了。${result.warnings.length}件の確認事項があります。`
        : "検査完了。設定下書きを確認してください。"
    );
  } catch(error) {
    setSetupWizardResult(null);
    setMessage(error instanceof Error ? error.message : String(error));
  } finally {
    setSetupBusy(false);
  }
}

async function saveSetupDraft() {
  if (!setupWizardResult) return;
  setSetupBusy(true);
  try {
    if (!firebaseConfigured) {
      setMessage("デモ：すべてOFFの設定下書きを保存しました。");
      return;
    }
    if (!functions) return;
    const callable = httpsCallable(functions, "saveSetupWizardDraft");
    await callable({inspectionId:setupWizardResult.inspectionId});
    setMessage("すべてOFFの設定下書きを保存しました。");
  } catch(error) {
    setMessage(error instanceof Error ? error.message : String(error));
  } finally {
    setSetupBusy(false);
  }
}

function downloadSetupDraft() {
  if (!setupWizardResult) return;
  const content=JSON.stringify(setupWizardResult.draft,null,2);
  const blob=new Blob([content],{type:"application/json;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement("a");
  anchor.href=url;
  anchor.download="Lip_Knots_Crew_導入設定_OFF.json";
  anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  setMessage("設定下書きJSONを出力しました。");
}

async function previewMonthCreation() {
  setMonthBusy(true);
  try {
    if (!firebaseConfigured) {
      setMonthPreview({
        ready:true,
        errors:[],
        warnings:["安全書込・新月作成・会社設定は現在OFFです。"],
        plan:{
          targetMonth:monthTarget,
          sourceMonth:monthSource || "2026.7",
          sourceSheetId:7,
          inputColumns:["A","B","G","H","J","K","L","M","N","O","P","S","T","U","V","W","X","Y","Z","AB","AC","AD","AE","AF","AG","AH","AI","ZZ"],
          formulaColumns:["AA","AJ","AR","BB"],
          clearRanges:[`'${monthTarget}'!A2:B10000`,`'${monthTarget}'!G2:H10000`,`'${monthTarget}'!J2:P10000`],
        },
        activation:{mappingEnabled:false,monthCreationEnabled:false,verifiedCopy:false},
      });
      setMessage("デモ：新月タブの作成計画を確認しました。元スプシは変更していません。");
      return;
    }
    if (!functions) return;
    const callable = httpsCallable(functions, "previewMonthSheetCreation");
    const response = await callable({
      targetMonth:monthTarget,
      sourceMonth:monthSource || undefined,
    });
    const preview=response.data as MonthSheetPreview;
    setMonthPreview(preview);
    setMessage(preview.ready?"新月タブの事前検査に合格しました。":"新月タブの事前検査で要確認があります。");
  } catch(error) {
    setMonthPreview(null);
    setMessage(error instanceof Error ? error.message : String(error));
  } finally {
    setMonthBusy(false);
  }
}

async function createMonthSheet() {
  if (!monthPreview?.ready) {
    setMessage("先に事前検査を行ってください。");
    return;
  }
  if (!window.confirm(
    `${monthPreview.plan.sourceMonth}を複製し、${monthPreview.plan.targetMonth}を作成します。検証コピーであることを確認しましたか？`
  )) return;
  setMonthBusy(true);
  try {
    if (!firebaseConfigured) {
      setMonthHistory((current)=>[{
        id:`demo-${Date.now()}`,
        status:"completed",
        sourceMonth:monthPreview.plan.sourceMonth,
        targetMonth:monthPreview.plan.targetMonth,
        startedAt:new Date().toISOString(),
      },...current]);
      setMessage("デモ：新月タブを作成し、数式・保護範囲を検算しました。");
      return;
    }
    if (!functions) return;
    const callable = httpsCallable(functions, "createMonthSheetSafe");
    const response = await callable({
      targetMonth:monthTarget,
      sourceMonth:monthSource || undefined,
      confirmation:"検証コピーで作成",
    });
    const data=response.data as {targetMonth?:string};
    setMessage(`${data.targetMonth ?? monthTarget}タブを安全に作成しました。`);
    await Promise.all([loadMonthHistory(),loadPilotReadiness()]);
  } catch(error) {
    setMessage(error instanceof Error ? error.message : String(error));
  } finally {
    setMonthBusy(false);
  }
}

async function loadMonthHistory() {
  if (!firebaseConfigured) return;
  if (!functions) return;
  try {
    const callable=httpsCallable(functions,"getMonthCreationHistory");
    const response=await callable({});
    setMonthHistory((response.data as {runs?:MonthHistoryRun[]}).runs ?? []);
  } catch(error) {
    setMessage(error instanceof Error ? error.message : String(error));
  }
}



async function readGasFiles(fileList:FileList|null) {
  if (!fileList) return;
  const accepted:Array<LocalGasFile> = [];
  const rejected:string[] = [];
  for (const file of Array.from(fileList)) {
    const extension=file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!["gs","js","html","json","txt"].includes(extension)) {
      rejected.push(file.name);
      continue;
    }
    if (file.size>2_000_000) {
      rejected.push(`${file.name}（2MB超）`);
      continue;
    }
    accepted.push({
      filename:file.name,
      source:await file.text(),
      size:file.size,
    });
  }
  setGasFiles(accepted);
  setGasSecretFindings([]);
  setGasAuditView(null);
  setMessage(
    rejected.length
      ? `${accepted.length}件を取込、${rejected.length}件を除外しました。`
      : `${accepted.length}件のGAS関連ファイルを読み込みました。`
  );
}

async function scanGasSecrets() {
  if (!gasFiles.length) {
    setMessage("先にGASファイルを選択してください。");
    return;
  }
  setGasAuditBusy(true);
  try {
    if (!firebaseConfigured) {
      const findings:GasSecretFinding[] = gasFiles.flatMap((file)=>
        file.source.includes("AIza")
          ? [{
              id:`${file.filename}:1:api_key`,
              filename:file.filename,line:1,risk:"high",
              category:"api_key",label:"APIキーらしき値があります",
              evidenceMasked:"AIza…890",
              recommendation:"値を伏せてください。",
            }]
          : []
      );
      setGasSecretFindings(findings);
      setMessage(
        findings.length
          ? `秘密情報らしき値を${findings.length}件検出しました。`
          : "送信前の秘密情報検査に合格しました。"
      );
      return;
    }
    if (!functions) return;
    const callable=httpsCallable(functions,"scanGasUploadSafety");
    const response=await callable({files:gasFiles.map(({filename,source})=>({filename,source}))});
    const data=response.data as {safeToUpload:boolean;findings:GasSecretFinding[]};
    setGasSecretFindings(data.findings);
    setMessage(
      data.safeToUpload
        ? "送信前の秘密情報検査に合格しました。"
        : `秘密情報らしき値を${data.findings.length}件検出しました。`
    );
  } catch(error) {
    setMessage(error instanceof Error?error.message:String(error));
  } finally {
    setGasAuditBusy(false);
  }
}

async function runUploadedGasAudit() {
  if (!gasFiles.length) {
    setMessage("先にGASファイルを選択してください。");
    return;
  }
  if (gasSecretFindings.some((finding)=>["critical","high"].includes(finding.risk))) {
    setMessage("重大または高リスクの秘密情報を削除してから監査してください。");
    return;
  }
  setGasAuditBusy(true);
  try {
    if (!firebaseConfigured) {
      const findings:GasAuditFindingView[] = gasFiles.flatMap((file,index)=>
        file.source.includes("getRange(")
          ? [{
              id:`${file.filename}:${index}:numeric`,
              filename:file.filename,line:1,risk:"high",
              category:"numeric_column",
              title:"固定列番号があります",
              evidence:"getRange(2, 19)",
              recommendation:"列マッピングへ変更してください。",
              affectedColumns:["S"],
            }]
          : []
      );
      setGasAuditView({
        gasAuditId:"demo-audit",
        report:{
          grade:findings.length?"C":"A",
          score:findings.length?68:100,
          blockers:findings.length,
          summary:{critical:0,high:findings.length,medium:0,low:0},
          findings,
        },
      });
      setMessage("デモ：GAS監査が完了しました。");
      return;
    }
    if (!functions) return;
    const callable=httpsCallable(functions,"runGasAudit");
    const response=await callable({files:gasFiles.map(({filename,source})=>({filename,source}))});
    setGasAuditView(response.data as GasAuditView);
    setMessage("GAS監査が完了しました。");
  } catch(error) {
    setMessage(error instanceof Error?error.message:String(error));
  } finally {
    setGasAuditBusy(false);
  }
}

async function exportGasMarkdown() {
  if (!gasAuditView) return;
  try {
    if (!firebaseConfigured) {
      const content=`# GAS監査レポート\n\n評価: ${gasAuditView.report.grade}\n`;
      downloadTextFile("GAS監査_デモ.md",content,"text/markdown;charset=utf-8");
      return;
    }
    if (!functions) return;
    const callable=httpsCallable(functions,"exportGasAuditMarkdown");
    const response=await callable({gasAuditId:gasAuditView.gasAuditId});
    const data=response.data as {filename:string;markdown:string};
    downloadTextFile(data.filename,data.markdown,"text/markdown;charset=utf-8");
  } catch(error) {
    setMessage(error instanceof Error?error.message:String(error));
  }
}

function downloadTextFile(filename:string,content:string,type:string) {
  const blob=new Blob([content],{type});
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement("a");
  anchor.href=url;anchor.download=filename;anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}


async function loadPilotReadiness() {
  if (!firebaseConfigured) {
    setPilotReadiness(demoPilotReadiness);
    setMessage("デモ：本番導入の安全チェックを更新しました。");
    return;
  }
  if (!functions) return;
  setPilotBusy(true);
  try {
    const callable = httpsCallable(functions, "getPilotReadiness");
    const response = await callable({});
    setPilotReadiness(response.data as PilotReadiness);
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error));
  } finally {
    setPilotBusy(false);
  }
}

async function previewRowCreation() {
  const rows = Math.max(1, Math.min(20, Number(jobForm.slots) || 1));
  if (!firebaseConfigured) {
    setPilotPreview({
      ready:true,
      errors:[],
      warnings:["安全書込と新規行追加は現在OFFです。検証コピーでのみ有効化してください。"],
      sheetName:jobForm.workDate.slice(0,4)+"."+Number(jobForm.workDate.slice(5,7)),
      templateRow:486,
      insertBeforeRow:487,
      insertedRows:Array.from({length:rows},(_,index)=>487+index),
      formulaColumns:["AA","AJ","AR","BB"],
      requiredValidationColumns:[],
    });
    setMessage("デモ：行追加の事前検査に合格しました。元スプシは変更していません。");
    return;
  }
  if (!functions) return;
  setPilotBusy(true);
  try {
    const callable = httpsCallable(functions, "previewSheetRowCreation");
    const response = await callable({
      dateKey:jobForm.workDate,
      rows,
    });
    const preview = response.data as RowCreationPreview;
    setPilotPreview(preview);
    setMessage(
      preview.ready
        ? "行追加の事前検査に合格しました。スプシは変更していません。"
        : `事前検査で${preview.errors.length}件の要確認があります。`
    );
  } catch (error) {
    setPilotPreview(null);
    setMessage(error instanceof Error ? error.message : String(error));
  } finally {
    setPilotBusy(false);
  }
}


  async function enablePush() {
    if (!functions) {
      setPushEnabled(true);
      setMessage("デモ：管理者通知を有効にしました。");
      return;
    }
    setPushBusy(true);
    try {
      const { enablePushNotifications } = await import("./push");
      const result = await enablePushNotifications(functions, user?.uid ?? "");
      setPushEnabled(result.enabled);
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPushBusy(false);
    }
  }

  async function disablePush() {
    if (!functions) {
      setPushEnabled(false);
      setMessage("デモ：管理者通知を無効にしました。");
      return;
    }
    setPushBusy(true);
    try {
      const { disablePushNotifications } = await import("./push");
      const result = await disablePushNotifications(functions);
      setPushEnabled(false);
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPushBusy(false);
    }
  }

  async function testPush() {
    if (!functions) {
      setMessage("デモ：管理者通知テストを送信しました。");
      return;
    }
    const { requestTestPush } = await import("./push");
    await requestTestPush(functions);
    setMessage("管理者通知テストを送信しました。");
  }

  async function login() {
    if (!auth) return;
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  }

  async function loadJobs() {
    if (!db) return;
    const q = query(
      collection(db, "jobs"),
      where("companyId", "==", "lipknots"),
      orderBy("workDate", "asc"),
      limit(100)
    );
    const snap = await getDocs(q);
    setJobs(snap.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      const rawWorkDate = data.workDate as { toDate?: () => Date } | string | undefined;
      const workDate = typeof rawWorkDate === "object" && rawWorkDate?.toDate
        ? rawWorkDate.toDate().toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", weekday: "short" })
        : String(rawWorkDate ?? data.dateKey ?? "");
      return { id: doc.id, ...data, workDate } as Job;
    }));
  }



  async function loadStaff() {
    if (!db) return;
    const q = query(
      collection(db, "staffProfiles"),
      where("companyId", "==", "lipknots"),
      orderBy("displayName", "asc"),
      limit(500)
    );
    const snap = await getDocs(q);
    setStaff(snap.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() as Omit<StaffProfile, "id">),
    })));
  }


  async function loadInviteCandidates() {
    if (!firebaseConfigured) {
      const demo = demoStaff.slice(0, 3).map((profile, index) => ({
        staffId: profile.id,
        displayName: profile.displayName,
        emails: profile.emails ?? [],
        areaLabels: profile.areaLabels ?? [],
        upcomingJobs: index + 1,
      }));
      setInviteCandidates(demo);
      setSelectedInviteIds(demo.map((item) => item.staffId));
      setMessage("今後30日以内にシフトがある未ログイン者を抽出しました。");
      return;
    }
    if (!functions) return;
    setInviteBusy(true);
    try {
      const callable = httpsCallable(functions, "getLoginInviteCandidates");
      const response = await callable({ days: 30 });
      const candidates = (response.data as { candidates?: InviteCandidate[] }).candidates ?? [];
      setInviteCandidates(candidates);
      setSelectedInviteIds(candidates.map((item) => item.staffId));
      setMessage(`${candidates.length}名を案内対象として抽出しました。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setInviteBusy(false);
    }
  }

  async function sendInvites() {
    if (!selectedInviteIds.length) {
      setMessage("送信対象を選択してください。");
      return;
    }
    if (!window.confirm(`${selectedInviteIds.length}名へ案内メールを送りますか？`)) return;
    if (!firebaseConfigured) {
      setMessage(`デモ：${selectedInviteIds.length}名へ案内メールを送信しました。`);
      return;
    }
    if (!functions) return;
    setInviteBusy(true);
    try {
      const callable = httpsCallable(functions, "sendLoginInvites");
      const response = await callable({
        staffIds: selectedInviteIds,
        subject: inviteSubject,
        introText: inviteIntro,
      });
      const data = response.data as { successStaff?: number; failedStaff?: number };
      setMessage(
        `案内メール送信：成功${data.successStaff ?? 0}名 / 失敗${data.failedStaff ?? 0}名`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setInviteBusy(false);
    }
  }

  function toggleInvite(staffId: string) {
    setSelectedInviteIds((current) =>
      current.includes(staffId)
        ? current.filter((id) => id !== staffId)
        : [...current, staffId]
    );
  }

  async function loadPilotRolloutStatus() {
    if (!firebaseConfigured) return;
    if (!functions) return;
    try {
      const callable = httpsCallable(functions, "getPilotRolloutStatus");
      const response = await callable({});
      setPilotRolloutStatus((response.data as { rollout?:PilotRolloutStatus|null }).rollout ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadPilotExpansionReview(rolloutId?:string) {
    if (!firebaseConfigured || !functions) return;
    try {
      const callable = httpsCallable(functions, "getPilotExpansionReview");
      const response = await callable(rolloutId ? {rolloutId} : {});
      setPilotExpansion(response.data as PilotExpansionData);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadStagedRolloutStatus(stagedRolloutId?:string) {
    if (!firebaseConfigured || !functions) return;
    try {
      const callable = httpsCallable(functions, "getStagedRolloutStatus");
      const response = await callable(stagedRolloutId ? {stagedRolloutId} : {});
      setStagedRollout((response.data as {rollout?:StagedRolloutData|null}).rollout ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadProductionControlStatus() {
    if (!firebaseConfigured || !functions) return;
    try {
      const callable = httpsCallable(functions, "getProductionControlStatus");
      const response = await callable({});
      const data = response.data as ProductionControlData;
      setProductionControl(data);
      if (data.rehearsalCertified) setProductionManual((current)=>({...current,backupVerified:true,restoreTestPassed:true,migrationPlanReady:true,rollbackPlanReady:true}));
      if (data.review?.manual) setProductionManual(data.review.manual);
      if (data.review?.evidenceRefs?.length) setProductionEvidence(data.review.evidenceRefs.join("\n"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadProductionRehearsalStatus(rehearsalId?:string) {
    if (!firebaseConfigured || !functions) return;
    try {
      const callable=httpsCallable(functions,"getProductionRehearsalStatus");
      const response=await callable(rehearsalId?{rehearsalId}:{});
      const rehearsal=(response.data as {rehearsal?:ProductionRehearsalData|null}).rehearsal??null;
      setProductionRehearsal(rehearsal);
      if(rehearsal?.metrics)setRehearsalMetrics(rehearsal.metrics);
    }catch(error){setMessage(error instanceof Error?error.message:String(error));}
  }

  async function loadProductionCutoverStatus(runId?:string) {
    if(!firebaseConfigured||!functions)return;
    try{
      const callable=httpsCallable(functions,"getProductionCutoverStatus");
      const response=await callable(runId?{runId}:{});const cutover=(response.data as {cutover?:ProductionCutoverData|null}).cutover??null;setProductionCutover(cutover);
      if(cutover){const{signedApprovalReady:_,...manual}=cutover.readiness;setCutoverReadiness(manual);if(cutover.readinessEvidenceRefs.length)setCutoverReadinessEvidence(cutover.readinessEvidenceRefs.join("\n"));if(cutover.lastObservation){const{observedAtMs:__,...observation}=cutover.lastObservation;setCutoverObservation(observation);}}
    }catch(error){setMessage(error instanceof Error?error.message:String(error));}
  }

  async function createCutover() {
    if(!cutoverReleaseId.trim()||!cutoverWindowStart){setMessage("Release IDと切替予定時刻を入力してください。");return;}
    const parsed=new Date(cutoverWindowStart);if(Number.isNaN(parsed.getTime())){setMessage("切替予定時刻が不正です。");return;}
    if(!window.confirm("T−60からT＋24時間の本番切替指揮盤を開始しますか？"))return;setCutoverBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"createProductionCutover");const response=await callable({releaseId:cutoverReleaseId.trim(),windowStartIso:parsed.toISOString()});const runId=(response.data as {runId?:string}).runId;await loadProductionCutoverStatus(runId);setMessage("本番切替当日指揮盤を開始しました。T−60準備を固定してください。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setCutoverBusy(false);}
  }

  async function saveCutoverReadiness() {
    if(!productionCutover)return;const evidenceRefs=cutoverReadinessEvidence.split(/[\n,]/u).map(value=>value.trim()).filter(Boolean);if(evidenceRefs.length<3){setMessage("当日準備証跡を3件以上入力してください。");return;}setCutoverBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"saveProductionCutoverReadiness");await callable({runId:productionCutover.runId,...cutoverReadiness,evidenceRefs});await loadProductionCutoverStatus(productionCutover.runId);setMessage("T−60/T−15準備を再判定しました。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setCutoverBusy(false);}
  }

  async function recordCutoverObservation() {
    if(!productionCutover)return;const evidenceRefs=cutoverObservation.evidenceRefs.map(value=>value.trim()).filter(Boolean);if(evidenceRefs.length<2){setMessage("観測証跡を2件以上入力してください。");return;}setCutoverBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"recordProductionCutoverObservation");await callable({runId:productionCutover.runId,observedAtIso:new Date().toISOString(),...cutoverObservation,evidenceRefs});await loadProductionCutoverStatus(productionCutover.runId);setMessage("本番観測値を記録し、切戻し判定を更新しました。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setCutoverBusy(false);}
  }

  async function startCutoverRollback() {
    if(!productionCutover||productionCutover.gate?.action!=="rollback_required")return;const reason=window.prompt("切戻し理由を10文字以上で入力してください。");if(!reason||reason.trim().length<10)return;if(!window.confirm("本番処理を全体停止し、切戻しを開始しますか？ アプリから解除できません。"))return;const typed=window.prompt("最終確認として ROLLBACK と入力してください。");if(typed!=="ROLLBACK")return;setCutoverBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"activateProductionCutoverRollback");await callable({runId:productionCutover.runId,reason:reason.trim(),confirmation:"LOCK_AND_START_ROLLBACK"});await Promise.all([loadProductionCutoverStatus(productionCutover.runId),loadProductionControlStatus()]);setMessage("全体停止ロックを作動し、本番切戻しを開始しました。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setCutoverBusy(false);}
  }

  async function completeCutover() {
    if(!productionCutover||productionCutover.gate?.action!=="complete")return;if(!window.confirm("T＋24時間と連続正常runを固定し、本番切替を完了しますか？"))return;setCutoverBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"completeProductionCutover");await callable({runId:productionCutover.runId});await loadProductionCutoverStatus(productionCutover.runId);setMessage("本番切替を完了固定しました。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setCutoverBusy(false);}
  }

  async function cancelCutover() {
    if(!productionCutover)return;const reason=window.prompt("中止理由を10文字以上で入力してください。");if(!reason||reason.trim().length<10)return;if(!window.confirm("本番有効化前の指揮盤を中止しますか？"))return;setCutoverBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"cancelProductionCutover");await callable({runId:productionCutover.runId,reason:reason.trim()});await loadProductionCutoverStatus(productionCutover.runId);setMessage("本番切替指揮盤を中止しました。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setCutoverBusy(false);}
  }

  async function loadProductionSloDashboard() {
    if(!firebaseConfigured||!functions)return;
    try{const callable=httpsCallable(functions,"getProductionSloDashboard");const response=await callable({});const data=response.data as ProductionSloDashboard;setProductionSlo(data);if(data.policy)setSloPolicy(data.policy);if(data.openIncident?.ownerName)setIncidentOwner(data.openIncident.ownerName);}catch(error){setMessage(error instanceof Error?error.message:String(error));}
  }

  async function loadProductionTelemetryStatus() {
    if(!firebaseConfigured||!functions)return;
    try{const callable=httpsCallable(functions,"getProductionTelemetryStatus");const response=await callable({});const data=response.data as ProductionTelemetryStatus;setTelemetryStatus(data);setTelemetryProjectId(data.projectId);setTelemetryEnabled(data.enabled);setTelemetryMetrics(data.metrics);}catch(error){setMessage(error instanceof Error?error.message:String(error));}
  }

  async function loadProductionDeploymentReadiness() {
    if(!firebaseConfigured||!functions)return;setDeploymentReadinessBusy(true);
    try{const callable=httpsCallable(functions,"getProductionDeploymentReadiness");const response=await callable({});setDeploymentReadiness(response.data as ProductionDeploymentReadiness);}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setDeploymentReadinessBusy(false);}
  }

  async function loadProductionReleaseEvidenceStatus(silent=false) {
    if(!firebaseConfigured||!functions)return;if(!silent)setProductionEvidenceBusy(true);
    try{const callable=httpsCallable(functions,"getProductionReleaseEvidenceStatus");const response=await callable({});setProductionEvidenceStatus(response.data as ProductionEvidenceView);}catch(error){if(!silent)setMessage(error instanceof Error?error.message:String(error));}finally{if(!silent)setProductionEvidenceBusy(false);}
  }

  async function importProductionEvidencePackage(file:File) {
    if(file.size>900_000){setMessage("証跡JSONは900KB以下にしてください。");return;}
    setProductionEvidenceBusy(true);
    try{
      const syncPackage=JSON.parse(await file.text()) as unknown;
      if(!firebaseConfigured||!functions){setProductionEvidenceStatus({configured:true,environment:"production",releaseId:"v5.6.0",evidence:null});setMessage("デモ：証跡JSONを検証し、ライブ指揮盤へ同期しました。外部保存は行っていません。");return;}
      const callable=httpsCallable(functions,"importProductionReleaseEvidence");const response=await callable({syncPackage});const data=response.data as {duplicate:boolean;evidence:NonNullable<ProductionEvidenceView["evidence"]>};
      setProductionEvidenceStatus({configured:true,environment:"production",releaseId:"v5.6.0",evidence:data.evidence});setMessage(data.duplicate?"同一証跡を確認しました。保存済みライブ状態を表示しています。":"本番証跡を再検証し、ライブ指揮盤へ同期しました。");
    }catch(error){setMessage(error instanceof SyntaxError?"証跡JSONの形式が不正です。":error instanceof Error?error.message:String(error));}finally{setProductionEvidenceBusy(false);}
  }

  function downloadProductionSetupTemplate() {
    const projectId=deploymentReadiness?.expectedProjectId||telemetryStatus?.projectId||"YOUR_PRODUCTION_PROJECT";
    const placeholderProject=projectId==="lip-knots-production"?projectId:"YOUR_PRODUCTION_PROJECT";
    const content={version:1,firebase:{developmentProjectId:"YOUR_DEV_PROJECT",stagingProjectId:"YOUR_STAGING_PROJECT",productionProjectId:placeholderProject,productionStaffHostingSite:`${placeholderProject}-staff`,productionAdminHostingSite:`${placeholderProject}-admin`,webApiKey:"YOUR_PRODUCTION_WEB_API_KEY",authDomain:`${placeholderProject}.firebaseapp.com`,storageBucket:`${placeholderProject}.firebasestorage.app`,messagingSenderId:"YOUR_PRODUCTION_MESSAGING_SENDER_ID",staffAppId:"YOUR_PRODUCTION_STAFF_APP_ID",adminAppId:"YOUR_PRODUCTION_ADMIN_APP_ID",vapidKey:"YOUR_PRODUCTION_PUBLIC_VAPID_KEY",functionsRegion:"asia-northeast1"},application:{staffAppUrl:`https://${placeholderProject}-staff.web.app`,adminAppUrl:`https://${placeholderProject}-admin.web.app`,spreadsheetId:"YOUR_VERIFIED_PRODUCTION_SPREADSHEET_ID",backupBucket:"YOUR_PRODUCTION_BACKUP_BUCKET",defaultCompanyId:"lipknots-production",adminEmails:["info@lipknots.com"],executiveApproverEmails:["info@lipknots.com"],mailFrom:"info@lipknots.com",approvalPackageKeyId:"production-signing-v1"},telemetry:{projectId:placeholderProject,metricPrefix:"custom.googleapis.com/lip_knots",tenantLabel:"company_id"}};
    downloadTextFile("production-setup.json",`${JSON.stringify(content,null,2)}\n`,"application/json;charset=utf-8");setMessage("本番セットアップJSONを出力しました。サンプル値を実値へ変更してください。");
  }

  async function copyProductionSetupCommand() {
    try{await navigator.clipboard.writeText("npm run setup:production");setMessage("本番セットアップコマンドをコピーしました。");}catch{setMessage("コマンド: npm run setup:production");}
  }

  function downloadProductionDeployApprovalTemplate() {
    const approvedAt=new Date();const expiresAt=new Date(approvedAt.getTime()+30*60_000);const projectId=deploymentReadiness?.expectedProjectId||telemetryStatus?.projectId||"YOUR_PRODUCTION_PROJECT";
    const content={schemaVersion:1,releaseId:"v5.6.0",projectId,planFingerprint:"PLAN_FINGERPRINT_FROM_PREVIEW",deployScope:["firestore","storage","functions","hosting:staff","hosting:admin"],approvedByEmail:"APPROVER_EMAIL",changeTicketId:"CHANGE-TICKET-ID",approvedAt:approvedAt.toISOString(),expiresAt:expiresAt.toISOString(),previousSourceCheckpointId:"PREVIOUS-SOURCE-CHECKPOINT-ID",hostingRollbackSource:"PREVIOUS_HOSTING_VERSION_OR_CHANNEL",acknowledgements:{backupVerified:false,previousSourceCheckpointVerified:false,rulesRollbackLimitationAccepted:false,emergencyLockOwnerAssigned:false,hostingRollbackOwnerAssigned:false}};
    downloadTextFile("production-deploy-approval.json",`${JSON.stringify(content,null,2)}\n`,"application/json;charset=utf-8");setMessage("承認テンプレートを出力しました。実指紋はprepareコマンドで自動固定してください。");
  }

  async function copyProductionDeployCommands() {
    const command="npm run deploy:production:prepare\nnpm run deploy:production:validate\nnpm run deploy:production -- --confirm <64文字PLAN_FINGERPRINT>";
    try{await navigator.clipboard.writeText(command);setMessage("承認付き本番デプロイ手順をコピーしました。");}catch{setMessage("本番デプロイ手順は同梱ドキュメントを確認してください。");}
  }

  function downloadProductionRollbackRequestTemplate() {
    const content={schemaVersion:1,knownGoodReleaseId:"v5.1.0",bundleRelativePath:"rollback-sources/v5.1.0",hostingStaffSource:"STAFF_SITE@PREVIOUS_VERSION_ID",hostingAdminSource:"ADMIN_SITE@PREVIOUS_VERSION_ID"};
    downloadTextFile("production-rollback-request.json",`${JSON.stringify(content,null,2)}\n`,"application/json;charset=utf-8");setMessage("rollback requestを出力しました。既知正常bundleとHosting復旧元を実値へ変更してください。");
  }

  async function copyProductionAcceptanceRollbackCommands() {
    const command="npm run acceptance:production\n# 失敗時だけ\nnpm run rollback:bundle:preview -- --source <KNOWN_GOOD_SOURCE> --release v5.1.0 --project <PROJECT_ID>\nnpm run rollback:production:prepare\nnpm run rollback:production:validate\nnpm run rollback:production -- --confirm <ROLLBACK_FINGERPRINT> --typed ROLLBACK_PRODUCTION\n# rollback成功後、5分間隔で3回\nnpm run acceptance:production:recovery\n# 証跡同期JSONを生成し、管理画面から同期\nnpm run evidence:production";
    try{await navigator.clipboard.writeText(command);setMessage("本番受入・rollback・証跡同期コマンドをコピーしました。");}catch{setMessage("本番受入・rollback・証跡同期手順は同梱ドキュメントを確認してください。");}
  }

  async function saveTelemetryConfig() {
    if(!firebaseConfigured){setMessage("デモ：Cloud Monitoring 13指標は接続済みです。外部通信は行いません。");return;}
    if(!telemetryProjectId.trim()){setMessage("Cloud Monitoring Project IDを入力してください。");return;}setTelemetryBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"saveProductionTelemetryConfig");const response=await callable({projectId:telemetryProjectId.trim(),enabled:telemetryEnabled,metrics:telemetryMetrics});setTelemetryStatus(response.data as ProductionTelemetryStatus);setMessage("Cloud Monitoring設定を保存しました。接続テストを実行してください。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setTelemetryBusy(false);}
  }

  async function probeTelemetry() {
    if(!firebaseConfigured){setMessage("デモ：13指標すべての接続テストに合格しています。");return;}setTelemetryBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"probeProductionTelemetry");const response=await callable({});const data=response.data as {status:ProductionTelemetryStatus};setTelemetryStatus(data.status);setMessage("Cloud Monitoring 13指標の接続テストに合格しました。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setTelemetryBusy(false);}
  }

  async function publishTelemetryMetricsNow() {
    if(!firebaseConfigured){setMessage("デモ：認証・Functions・スプシ・通知・queueから13指標を生成し、企業ラベル付きで送信しました。");return;}setTelemetryBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"publishProductionMetricsNow");await callable({});await Promise.all([loadProductionTelemetryStatus(),loadProductionDeploymentReadiness()]);setMessage("直近5分の実測から13指標を生成し、Cloud Monitoringへ送信しました。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setTelemetryBusy(false);}
  }

  async function collectTelemetryNow() {
    if(!firebaseConfigured){setMessage("デモ：直近5分の監視値を取込済みです。");return;}setTelemetryBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"collectProductionTelemetryNow");await callable({});await Promise.all([loadProductionTelemetryStatus(),loadProductionSloDashboard(),loadProductionDeploymentReadiness()]);setMessage("直近5分のCloud Monitoring値をSLOへ自動取込しました。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setTelemetryBusy(false);}
  }

  async function saveSloPolicy() {
    if(productionSlo?.openIncident){setMessage("進行中インシデントを解決してからSLO基準を変更してください。");return;}if(!window.confirm("本番SLO基準を更新しますか？"))return;setSloBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"saveProductionSloPolicy");await callable(sloPolicy);await loadProductionSloDashboard();setMessage("本番SLO基準を更新しました。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setSloBusy(false);}
  }

  async function recordSloObservation() {
    const evidenceRefs=sloObservation.evidenceRefs.map(value=>value.trim()).filter(Boolean);if(evidenceRefs.length<2){setMessage("SLO観測証跡を2件以上入力してください。");return;}setSloBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"recordProductionSloObservation");await callable({observedAtIso:new Date().toISOString(),...sloObservation,evidenceRefs});await loadProductionSloDashboard();setMessage("SLO観測を集計し、インシデント判定を更新しました。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setSloBusy(false);}
  }

  async function acknowledgeIncident() {
    const incident=productionSlo?.openIncident;if(!incident)return;if(incidentOwner.trim().length<2||incidentNote.trim().length<10){setMessage("担当者名と10文字以上の初動メモを入力してください。");return;}setSloBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"acknowledgeProductionIncident");await callable({incidentId:incident.incidentId,ownerName:incidentOwner.trim(),note:incidentNote.trim()});await loadProductionSloDashboard();setMessage("インシデント担当と初動対応を固定しました。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setSloBusy(false);}
  }

  async function resolveIncident() {
    const incident=productionSlo?.openIncident;if(!incident)return;const evidenceRefs=incidentEvidence.split(/[\n,]/u).map(value=>value.trim()).filter(Boolean);if(incidentRootCause.trim().length<20||incidentResolution.trim().length<20||incidentPrevention.trim().length<20||evidenceRefs.length<2){setMessage("原因・復旧・再発防止を各20文字以上、証跡を2件以上入力してください。");return;}if(!window.confirm("インシデントを解決固定しますか？"))return;setSloBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"resolveProductionIncident");await callable({incidentId:incident.incidentId,rootCause:incidentRootCause.trim(),resolutionSummary:incidentResolution.trim(),preventionAction:incidentPrevention.trim(),evidenceRefs});await loadProductionSloDashboard();setMessage("原因・復旧・再発防止・証跡を固定し、インシデントを解決しました。");setIncidentRootCause("");setIncidentResolution("");setIncidentPrevention("");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setSloBusy(false);}
  }

  async function createRehearsal() {
    const stagedRolloutId=productionControl?.stagedRollout?.stagedRolloutId??stagedRollout?.stagedRolloutId;
    if(!stagedRolloutId||!expectedFirebaseProjectId||!rehearsalRestoreProject.trim()||!rehearsalBackupBucket.trim()){setMessage("staging Project ID・復元先・バックアップbucketを確認してください。");return;}
    if(!window.confirm("隔離環境で本番移行リハーサルと復元演習を開始しますか？"))return;
    setRehearsalBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"createProductionRehearsal");const response=await callable({stagedRolloutId,sourceProjectId:expectedFirebaseProjectId,restoreProjectId:rehearsalRestoreProject.trim(),backupBucket:rehearsalBackupBucket.trim(),maxRtoMinutes:60,maxRpoMinutes:5});const id=(response.data as {rehearsalId?:string}).rehearsalId;await loadProductionRehearsalStatus(id);setMessage("本番移行リハーサルを開始しました。7工程の証跡を入力してください。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setRehearsalBusy(false);}
  }

  async function saveRehearsalMetrics() {
    if(!productionRehearsal)return;setRehearsalBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"saveProductionRehearsalMetrics");await callable({rehearsalId:productionRehearsal.rehearsalId,...rehearsalMetrics,evidenceRefs:rehearsalMetrics.evidenceRefs.map(value=>value.trim()).filter(Boolean)});await loadProductionRehearsalStatus(productionRehearsal.rehearsalId);setMessage("復元・移行・切戻しの検算結果を保存しました。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setRehearsalBusy(false);}
  }

  async function completeRehearsal() {
    if(!productionRehearsal?.gate?.eligible)return;if(!window.confirm("全検算合格の証跡を固定し、本番公開ゲートへ連携しますか？"))return;setRehearsalBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"completeProductionRehearsal");await callable({rehearsalId:productionRehearsal.rehearsalId});await Promise.all([loadProductionRehearsalStatus(productionRehearsal.rehearsalId),loadProductionControlStatus()]);setMessage("復元演習証跡を固定し、本番公開ゲートへ自動連携しました。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setRehearsalBusy(false);}
  }

  async function abortRehearsal() {
    if(!productionRehearsal)return;const reason=window.prompt("中止理由を10文字以上で入力してください。");if(!reason||reason.trim().length<10)return;if(!window.confirm("リハーサルを中止しますか？ 証跡は残ります。"))return;setRehearsalBusy(true);
    try{if(!functions)return;const callable=httpsCallable(functions,"abortProductionRehearsal");await callable({rehearsalId:productionRehearsal.rehearsalId,reason:reason.trim()});await loadProductionRehearsalStatus(productionRehearsal.rehearsalId);setMessage("リハーサルを中止し、証跡を保存しました。");}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setRehearsalBusy(false);}
  }

  async function submitProductionReview() {
    const rolloutId = productionControl?.stagedRollout?.stagedRolloutId ?? stagedRollout?.stagedRolloutId;
    if (!rolloutId) return;
    const evidenceRefs = productionEvidence.split(/[\n,]/u).map((value)=>value.trim()).filter(Boolean);
    if (evidenceRefs.length < 5) {
      setMessage("本番公開証跡を5件以上入力してください。");
      return;
    }
    if (!window.confirm("公開条件を確定し、社長承認へ回しますか？ まだ本番は有効になりません。")) return;
    setProductionBusy(true);
    try {
      if (!firebaseConfigured) {
        setMessage("デモ：本番公開審査を社長承認待ちにしました。");
        return;
      }
      if (!functions) return;
      const callable = httpsCallable(functions, "submitProductionReleaseReview");
      await callable({stagedRolloutId:rolloutId,manual:productionManual,evidenceRefs,note:productionNote.trim()});
      await loadProductionControlStatus();
      setMessage("本番公開審査を提出しました。社長承認待ちです。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setProductionBusy(false);
    }
  }

  async function decideProductionReview(decision:"approve"|"reject") {
    const rolloutId=productionControl?.stagedRollout?.stagedRolloutId;
    if (!rolloutId || !productionDecisionNote.trim()) {
      setMessage("承認・否認理由を入力してください。");
      return;
    }
    const label=decision==="approve"?"承認":"否認";
    if (!window.confirm(`社長承認として${label}しますか？`)) return;
    setProductionBusy(true);
    try {
      if (!functions) return;
      const callable=httpsCallable(functions,"decideProductionReleaseExecutive");
      await callable({stagedRolloutId:rolloutId,decision,note:productionDecisionNote.trim()});
      await loadProductionControlStatus();
      setMessage(`本番公開審査を${label}しました。`);
    } catch(error) {
      setMessage(error instanceof Error?error.message:String(error));
    } finally {
      setProductionBusy(false);
    }
  }

  async function exportApprovalPackage() {
    const rolloutId=productionControl?.stagedRollout?.stagedRolloutId;
    if(!rolloutId)return;
    if(!window.confirm("社長承認済みの内容をproduction向けに30分限定で署名しますか？"))return;
    setProductionBusy(true);
    try{
      if(!functions)return;
      const callable=httpsCallable(functions,"exportProductionApprovalPackage");
      const response=await callable({stagedRolloutId:rolloutId});
      const data=response.data as {packageText:string;expiresAt:string};
      setApprovalPackageText(data.packageText);
      setApprovalPackageExpiresAt(data.expiresAt);
      try{await navigator.clipboard.writeText(data.packageText);}catch{/* 画面から手動コピー可能 */}
      setMessage("production向け署名パッケージを発行し、コピーしました。30分以内に受理してください。");
    }catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setProductionBusy(false);}
  }

  async function copyApprovalPackage() {
    if(!approvalPackageText)return;
    try{await navigator.clipboard.writeText(approvalPackageText);setMessage("署名パッケージをコピーしました。");}
    catch{setMessage("自動コピーできませんでした。テキスト欄からコピーしてください。");}
  }

  async function importApprovalPackage() {
    if(approvalPackageText.trim().length<100){setMessage("stagingで発行した署名パッケージJSONを貼り付けてください。");return;}
    if(!window.confirm("署名・Project・企業・公開ゲート・30分期限を検証して受理しますか？"))return;
    setProductionBusy(true);
    try{
      if(!functions)return;
      const callable=httpsCallable(functions,"importProductionApprovalPackage");
      const response=await callable({packageText:approvalPackageText.trim()});
      const releaseId=(response.data as {releaseId?:string}).releaseId;if(releaseId&&!productionCutover)setCutoverReleaseId(releaseId);
      await loadProductionControlStatus();
      setMessage("署名付き承認パッケージを受理しました。別管理者が期限内に最終実行してください。");
    }catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setProductionBusy(false);}
  }

  async function enableProduction() {
    const approvalPackageId=productionControl?.importedApproval?.approvalPackageId;
    if (!approvalPackageId) return;
    if (!window.confirm("署名・社長承認済みの本番公開を有効化しますか？")) return;
    if (!window.confirm("最終確認：production環境の業務処理を開始します。実行しますか？")) return;
    setProductionBusy(true);
    try {
      if (!functions) return;
      const callable=httpsCallable(functions,"enableProductionRelease");
      await callable({approvalPackageId,confirmation:"ENABLE_PRODUCTION"});
      await Promise.all([loadProductionControlStatus(),loadProductionCutoverStatus(),loadProductionSloDashboard()]);
      setMessage("本番公開を有効化しました。");
    } catch(error) {
      setMessage(error instanceof Error?error.message:String(error));
    } finally {
      setProductionBusy(false);
    }
  }

  async function activateKillSwitch() {
    if (productionKillReason.trim().length < 10) {
      setMessage("全体停止理由を10文字以上で入力してください。");
      return;
    }
    if (!window.confirm("全体停止スイッチを作動させますか？ すべての本番処理を停止します。")) return;
    const typed=window.prompt("解除不能を確認するため LOCK と入力してください。");
    if (typed!=="LOCK") return;
    setProductionBusy(true);
    try {
      if (!functions) return;
      const callable=httpsCallable(functions,"activateGlobalKillSwitch");
      await callable({reason:productionKillReason.trim(),confirmation:"LOCK_PRODUCTION_IRREVERSIBLY"});
      await Promise.all([loadProductionControlStatus(),loadProductionCutoverStatus(),loadProductionSloDashboard()]);
      setMessage("全体停止スイッチを作動しました。アプリから解除できません。");
    } catch(error) {
      setMessage(error instanceof Error?error.message:String(error));
    } finally {
      setProductionBusy(false);
    }
  }

  async function startSelectedPilot() {
    if (selectedInviteIds.length < 3 || selectedInviteIds.length > 5) {
      setMessage("パイロット参加者は3〜5名を選択してください。");
      return;
    }
    if (!pilotReleaseId.trim()) {
      setMessage("Go判定済みcheckpointのRelease IDを入力してください。");
      return;
    }
    if (!window.confirm(`${selectedInviteIds.length}名へ配布し、5分間隔の監視を開始しますか？`)) return;
    setInviteBusy(true);
    try {
      if (!firebaseConfigured) {
        const now = new Date();
        setPilotRolloutStatus({
          rolloutId:"demo-pilot",
          releaseId:pilotReleaseId.trim(),
          status:"active",
          participantCount:selectedInviteIds.length,
          startedAt:now.toISOString(),
          endsAt:new Date(now.getTime()+Number(pilotDurationDays)*86400000).toISOString(),
          lastHealth:{action:"continue",observedAt:now.toISOString(),alerts:[]},
        });
        setMessage(`デモ：${selectedInviteIds.length}名へ配布し、自動監視を開始しました。`);
        return;
      }
      if (!functions) return;
      const callable = httpsCallable(functions, "startPilotRollout");
      const response = await callable({
        staffIds:selectedInviteIds,
        releaseId:pilotReleaseId.trim(),
        durationDays:Math.max(1,Math.min(14,Number(pilotDurationDays)||7)),
        subject:inviteSubject,
        introText:inviteIntro,
        alertCooldownMinutes:30,
      });
      const result = response.data as {status?:string;successStaff?:number;failedStaff?:number};
      setMessage(
        result.status === "active"
          ? `パイロット開始：${result.successStaff ?? 0}名へ配布し、自動監視を開始しました。`
          : `パイロット停止：配布失敗${result.failedStaff ?? 0}名を確認してください。`
      );
      await loadPilotRolloutStatus();
      await loadPilotExpansionReview();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setInviteBusy(false);
    }
  }

  async function stopActivePilot() {
    if (!pilotRolloutStatus || pilotRolloutStatus.status !== "active") return;
    if (!window.confirm("進行中のパイロットを停止しますか？")) return;
    setInviteBusy(true);
    try {
      if (!firebaseConfigured) {
        setPilotRolloutStatus({...pilotRolloutStatus,status:"stopped"});
        setMessage("デモ：パイロットを停止しました。");
        return;
      }
      if (!functions) return;
      const callable = httpsCallable(functions, "stopPilotRollout");
      await callable({reason:"管理者による手動停止"});
      await loadPilotRolloutStatus();
      await loadPilotExpansionReview();
      setMessage("パイロットを停止しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setInviteBusy(false);
    }
  }

  function updatePilotOutcome(key:keyof PilotOutcomeValues,value:string) {
    setPilotOutcome((current)=>({...current,[key]:value}));
  }

  async function submitPilotOutcome() {
    if (!pilotRolloutStatus) return;
    const evidenceRefs = pilotOutcome.evidenceRefs.split(/[\n,]+/u).map((value)=>value.trim()).filter(Boolean);
    if (!evidenceRefs.length) {
      setMessage("証拠参照を1件以上入力してください。");
      return;
    }
    if (!window.confirm("結果を確定し、30〜50名移行ゲートを判定しますか？")) return;
    const numberValue = (key:keyof PilotOutcomeValues) => Math.max(0, Math.trunc(Number(pilotOutcome[key]) || 0));
    const payload = {
      rolloutId:pilotRolloutStatus.rolloutId,
      totalCases:numberValue("totalCases"),
      completedCases:numberValue("completedCases"),
      moneyDiffYen:numberValue("moneyDiffYen"),
      doubleBookings:numberValue("doubleBookings"),
      mailTargetDiff:numberValue("mailTargetDiff"),
      pdfDiff:numberValue("pdfDiff"),
      manualQueue:numberValue("manualQueue"),
      supportCases:numberValue("supportCases"),
      evidenceRefs,
      notes:pilotOutcome.notes,
    };
    setPilotExpansionBusy(true);
    try {
      if (!firebaseConfigured) {
        const checks:PilotExpansionCheck[] = [
          {key:"pilot_completed",label:"3〜5名パイロット完了",passed:true,blocking:true,actual:true,required:"完了済み"},
          {key:"monitor_coverage",label:"5分監視coverage",passed:true,blocking:true,actual:96.2,required:"90%以上"},
          {key:"case_volume",label:"検証案件数",passed:payload.totalCases>=10,blocking:true,actual:payload.totalCases,required:"10件以上"},
          {key:"money_diff",label:"請求・給与差額",passed:payload.moneyDiffYen===0,blocking:true,actual:payload.moneyDiffYen,required:"0円"},
        ];
        const eligible = checks.every((item)=>!item.blocking||item.passed);
        const automated:PilotExpansionAutomated = {pilotCompleted:true,participantCount:5,durationDays:7,inviteFailures:0,healthRunCount:1940,expectedHealthRuns:2017,monitoringCoveragePct:96.2,monitorFailureCount:0,criticalAlertCount:0,watchAlertCount:0,lastHealthAction:"continue"};
        setPilotRolloutStatus({...pilotRolloutStatus,status:eligible?"expansion_review_pending":"expansion_blocked"});
        setPilotExpansion({
          rollout:{...pilotRolloutStatus,status:eligible?"expansion_review_pending":"expansion_blocked"},
          automated,
          review:{status:eligible?"pending_approval":"blocked",submittedAt:new Date().toISOString(),approvedAt:null,rejectedAt:null,decisionNote:"",fingerprint:"demo",currentAdminCanApprove:true,outcome:payload,automated,gate:{eligible,completionRatePct:payload.totalCases?Math.round(payload.completedCases/payload.totalCases*10000)/100:0,checks,blockers:checks.filter((item)=>item.blocking&&!item.passed),warnings:[],fingerprint:"demo"}},
        });
        setMessage(eligible?"デモ：別管理者の承認待ちです。":"デモ：未達項目があるため移行を停止しました。");
        return;
      }
      if (!functions) return;
      const callable = httpsCallable(functions, "submitPilotOutcome");
      const response = await callable(payload);
      const result = response.data as {reviewStatus?:string};
      await Promise.all([loadPilotRolloutStatus(),loadPilotExpansionReview(pilotRolloutStatus.rolloutId)]);
      setMessage(result.reviewStatus==="pending_approval"?"結果を保存しました。別の管理者による承認待ちです。":"未達項目があるため移行を停止しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPilotExpansionBusy(false);
    }
  }

  async function decidePilotExpansion(decision:"approve"|"reject") {
    if (!pilotRolloutStatus || !pilotDecisionNote.trim()) {
      setMessage("承認・否認理由を入力してください。");
      return;
    }
    const label = decision==="approve"?"承認":"否認";
    if (!window.confirm(`30〜50名移行ゲートを${label}しますか？ 配布はまだ実行されません。`)) return;
    setPilotExpansionBusy(true);
    try {
      if (!firebaseConfigured) {
        const status = decision==="approve"?"expansion_approved":"expansion_rejected";
        setPilotRolloutStatus({...pilotRolloutStatus,status});
        setPilotExpansion((current)=>current?{...current,review:current.review?{...current.review,status:decision==="approve"?"approved":"rejected",decisionNote:pilotDecisionNote}:null}:current);
        setMessage(`デモ：移行ゲートを${label}しました。`);
        return;
      }
      if (!functions) return;
      const callable = httpsCallable(functions, "decidePilotExpansion");
      await callable({rolloutId:pilotRolloutStatus.rolloutId,decision,note:pilotDecisionNote.trim()});
      await Promise.all([loadPilotRolloutStatus(),loadPilotExpansionReview(pilotRolloutStatus.rolloutId)]);
      setMessage(`移行ゲートを${label}しました。配布はまだ実行されていません。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPilotExpansionBusy(false);
    }
  }

  async function createSelectedStagedRollout() {
    if (!pilotRolloutStatus || pilotRolloutStatus.status !== "expansion_approved") return;
    if (selectedInviteIds.length < 30 || selectedInviteIds.length > 50) {
      setMessage("30〜50名段階配布の参加者を30〜50名選択してください。");
      return;
    }
    const observationHours = Math.max(12,Math.min(72,Math.trunc(Number(stagedObservationHours)||24)));
    const requiredContinueRuns = Math.max(6,Math.min(36,Math.trunc(Number(stagedContinueRuns)||12)));
    if (!window.confirm(`${selectedInviteIds.length}名を3waveへ固定しますか？ まだ配布は始まりません。`)) return;
    setStagedRolloutBusy(true);
    try {
      if (!firebaseConfigured) {
        const remaining=selectedInviteIds.length-10;
        const second=Math.floor(remaining/2);
        const sizes=[10,second,remaining-second];
        let cumulative=0;
        const wavePlan=sizes.map((size,index)=>{const startOffset=cumulative;cumulative+=size;return{waveNumber:index+1,startOffset,size,cumulativeCount:cumulative};});
        setStagedRollout({
          stagedRolloutId:"demo-staged",pilotRolloutId:pilotRolloutStatus.rolloutId,releaseId:pilotRolloutStatus.releaseId,status:"ready",targetCount:selectedInviteIds.length,wavePlan,currentWave:0,deliveredCount:0,observationHours,requiredContinueRuns,consecutiveContinueRuns:0,criticalAlertCount:0,monitorFailureCount:0,inviteFailureCount:0,currentWaveStartedAt:null,lastHealth:null,
          gate:{allowed:true,nextWave:wavePlan[0]??null,checks:[{key:"approval",label:"30〜50名移行承認",passed:true,actual:true,required:"有効な二者承認"}],blockers:[],fingerprint:"demo"},
        });
        setMessage("デモ：3waveの段階配布を準備しました。初回waveはまだ未配布です。");
        return;
      }
      if (!functions) return;
      const callable=httpsCallable(functions,"createStagedRollout");
      const response=await callable({pilotRolloutId:pilotRolloutStatus.rolloutId,staffIds:selectedInviteIds,subject:inviteSubject,introText:inviteIntro,observationHours,requiredContinueRuns});
      const result=response.data as {stagedRolloutId?:string};
      await loadStagedRolloutStatus(result.stagedRolloutId);
      setMessage("30〜50名を3waveへ固定しました。初回waveは手動開始です。");
    } catch (error) {
      setMessage(error instanceof Error?error.message:String(error));
    } finally {
      setStagedRolloutBusy(false);
    }
  }

  async function releaseNextStagedWave() {
    if (!stagedRollout?.gate.allowed || !stagedRollout.gate.nextWave) return;
    const wave=stagedRollout.gate.nextWave;
    if (!window.confirm(`wave ${wave.waveNumber}として${wave.size}名へ配布しますか？ 配布後は${stagedRollout.observationHours}時間監視します。`)) return;
    setStagedRolloutBusy(true);
    try {
      if (!firebaseConfigured) {
        setStagedRollout({...stagedRollout,status:"observing",currentWave:wave.waveNumber,deliveredCount:wave.cumulativeCount,currentWaveStartedAt:new Date().toISOString(),consecutiveContinueRuns:0,lastHealth:{action:"continue",observedAt:new Date().toISOString(),alerts:[]},gate:{...stagedRollout.gate,allowed:false,nextWave:stagedRollout.wavePlan[wave.waveNumber]??null,blockers:[{key:"status",label:"段階配布状態",passed:false,actual:"observing",required:"READY"}]}});
        setMessage(`デモ：wave ${wave.waveNumber}を${wave.size}名へ配布し、自動監視を開始しました。`);
        return;
      }
      if (!functions) return;
      const callable=httpsCallable(functions,"releaseNextStagedWave");
      const response=await callable({stagedRolloutId:stagedRollout.stagedRolloutId});
      const result=response.data as {status?:string;waveNumber?:number;successStaff?:number;failedStaff?:number};
      await loadStagedRolloutStatus(stagedRollout.stagedRolloutId);
      setMessage(result.status==="observing"?`wave ${result.waveNumber}：${result.successStaff??0}名へ配布し監視開始。`:`wave停止：失敗${result.failedStaff??0}名。自動再開しません。`);
    } catch (error) {
      setMessage(error instanceof Error?error.message:String(error));
      await loadStagedRolloutStatus(stagedRollout.stagedRolloutId);
    } finally {
      setStagedRolloutBusy(false);
    }
  }

  async function stopCurrentStagedRollout() {
    if (!stagedRollout || ["stopped","completed"].includes(stagedRollout.status)) return;
    if (!window.confirm("30〜50名段階配布を即時停止しますか？ 自動再開はできません。")) return;
    setStagedRolloutBusy(true);
    try {
      if (!firebaseConfigured) {
        setStagedRollout({...stagedRollout,status:"stopped",gate:{...stagedRollout.gate,allowed:false,blockers:[{key:"status",label:"段階配布状態",passed:false,actual:"stopped",required:"READY"}]}});
        setMessage("デモ：段階配布を停止しました。自動再開しません。");
        return;
      }
      if (!functions) return;
      const callable=httpsCallable(functions,"stopStagedRollout");
      await callable({stagedRolloutId:stagedRollout.stagedRolloutId,reason:"管理者による手動停止"});
      await loadStagedRolloutStatus(stagedRollout.stagedRolloutId);
      setMessage("30〜50名段階配布を停止しました。自動再開しません。");
    } catch (error) {
      setMessage(error instanceof Error?error.message:String(error));
    } finally {
      setStagedRolloutBusy(false);
    }
  }

  async function openStaffDevices(profile: StaffProfile) {
    setDeviceStaffName(profile.displayName);
    if (!firebaseConfigured) {
      setStaffDevices([
        { id:"demo1", label:"iPhone", platform:"iOS", active:true, lastSeenAt:new Date().toISOString() },
        { id:"demo2", label:"自宅PC", platform:"Windows", active:true, lastSeenAt:new Date(Date.now()-86400000).toISOString() },
      ]);
      return;
    }
    if (!functions) return;
    const callable = httpsCallable(functions, "getStaffDevices");
    const response = await callable({ staffId: profile.id });
    setStaffDevices((response.data as { devices?: StaffDevice[] }).devices ?? []);
  }

  async function revokeStaffDevices(profile: StaffProfile) {
    if (!window.confirm(`${profile.displayName}さんの全端末をログアウトしますか？`)) return;
    if (!firebaseConfigured) {
      setMessage(`デモ：${profile.displayName}さんの全端末をログアウトしました。`);
      return;
    }
    if (!functions) return;
    const callable = httpsCallable(functions, "adminRevokeStaffDevices");
    await callable({ staffId: profile.id, allDevices: true });
    setMessage(`${profile.displayName}さんの全端末をログアウトしました。`);
    if (deviceStaffName === profile.displayName) await openStaffDevices(profile);
  }

  async function previewStaffSync() {
    if (!firebaseConfigured) {
      setStaffSyncSummary("デモ：マスタ＋東北 / 298名 / 複数メール12名");
      setMessage("スタッフ名簿のプレビューが完了しました。抹消タブは参照していません。");
      return;
    }
    if (!functions) return;
    setStaffSyncBusy(true);
    try {
      const callable = httpsCallable(functions, "previewStaffImport");
      const response = await callable({});
      const data = response.data as {
        totals?: {
          profiles?: number;
          multipleEmailProfiles?: number;
          profilesWithoutEmail?: number;
          emailConflicts?: number;
        };
      };
      setStaffSyncSummary(
        `${data.totals?.profiles ?? 0}名 / 複数メール${data.totals?.multipleEmailProfiles ?? 0}名 / メールなし${data.totals?.profilesWithoutEmail ?? 0}名`
      );
      setMessage("スタッフ名簿の読取専用プレビューが完了しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setStaffSyncBusy(false);
    }
  }

  async function runStaffSync() {
    if (!window.confirm("マスタ・東北を読み、同じ氏名の複数メールを1アカウントへ統合します。実行しますか？")) return;
    if (!firebaseConfigured) {
      setStaffSyncSummary("デモ同期完了：298名");
      setMessage("デモ：スタッフ名簿を同期しました。");
      return;
    }
    if (!functions) return;
    setStaffSyncBusy(true);
    try {
      const callable = httpsCallable(functions, "syncStaffDirectoryReadOnly");
      const response = await callable({});
      const data = response.data as {
        totals?: {
          profiles?: number;
          emailIndexesWritten?: number;
          sessionsRevoked?: number;
        };
      };
      setStaffSyncSummary(
        `${data.totals?.profiles ?? 0}名 / ログイン用メール${data.totals?.emailIndexesWritten ?? 0}件`
      );
      setMessage("スタッフ名簿の同期が完了しました。");
      await loadStaff();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setStaffSyncBusy(false);
    }
  }

  async function previewSheetSync() {
    if (!firebaseConfigured) {
      setSyncSummary("デモ：12タブ、486案件、未照合スタッフ0件");
      setMessage("読取専用プレビューが完了しました。元スプシは変更していません。");
      return;
    }
    if (!functions) return;
    setSyncBusy(true);
    try {
      const callable = httpsCallable(functions, "previewShiftImport");
      const response = await callable({});
      const data = response.data as {
        totals?: { sheets?: number; jobs?: number; unresolvedStaff?: number };
      };
      setSyncSummary(
        `${data.totals?.sheets ?? 0}タブ / ${data.totals?.jobs ?? 0}案件 / 未照合${data.totals?.unresolvedStaff ?? 0}件`
      );
      setMessage("読取専用プレビューが完了しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncBusy(false);
    }
  }

  async function runSheetSync() {
    if (!window.confirm("元スプシは変更せず、Firestoreへ案件を同期します。実行しますか？")) return;
    if (!firebaseConfigured) {
      setSyncSummary("デモ同期完了：486案件");
      setMessage("デモ：Firestoreへ同期しました。");
      return;
    }
    if (!functions) return;
    setSyncBusy(true);
    try {
      const callable = httpsCallable(functions, "syncShiftSheetsReadOnly");
      const response = await callable({});
      const data = response.data as {
        totals?: { sheets?: number; jobs?: number; unresolvedStaff?: number; writes?: number };
      };
      setSyncSummary(
        `${data.totals?.sheets ?? 0}タブ / ${data.totals?.jobs ?? 0}案件 / ${data.totals?.writes ?? 0}書込`
      );
      setMessage("Firestoreへの同期が完了しました。元スプシは変更していません。");
      await loadJobs();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncBusy(false);
    }
  }


  function selectAdminJob(jobId: string) {
    setSelectedAdminJobId(jobId);
    const job = jobs.find((item) => item.id === jobId);
    const values = (job?.netPrint?.items ?? []).map((item) => item.number);
    setNetPrintNumbers([values[0] ?? "", values[1] ?? "", values[2] ?? ""]);
    setSelectedSourceFile(null);
    setComparison(null);
  }

  async function saveNetPrint() {
    if (!selectedAdminJobId) return;
    if (!firebaseConfigured) {
      setJobs((current) => current.map((job) => job.id === selectedAdminJobId ? {
        ...job,
        netPrint: { items: netPrintNumbers.filter(Boolean).map((number, index) => ({ id:`demo_np_${index}`, number, printed:false })) },
      } : job));
      setMessage("デモ：ネットプリント番号を保存し、スタッフへ通知しました。");
      return;
    }
    if (!functions) return;
    const callable = httpsCallable(functions, "updateNetPrintNumbers");
    const response = await callable({ jobId:selectedAdminJobId, numbers:netPrintNumbers });
    setMessage(`ネットプリントを保存しました。変更${(response.data as {changedCount?:number}).changedCount ?? 0}件`);
    await loadJobs();
  }

  async function loadSubmissionTimeline() {
    if (!selectedAdminJobId) return;
    setTimelineBusy(true);
    try {
      if (!firebaseConfigured) {
        const source: SubmissionFile = { id:"demo_source", submissionId:"demo_submission", originalName:"report.jpg", driveName:"7.12 ベイシア成田 Aさん (1).jpg", contentType:"image/jpeg", sequence:1, purpose:"initial", status:"completed", previewUrl:demoPreview("元画像（手ブレ）","#f6dce6"), completedAt:new Date().toISOString(), replacesFileId:null };
        setSubmissionTimeline([{ id:"demo_submission", purpose:"initial", status:"completed", createdAt:new Date().toISOString(), completedAt:new Date().toISOString(), files:[source] }]);
        return;
      }
      if (!functions) return;
      const callable = httpsCallable(functions, "getSubmissionTimeline");
      const response = await callable({ jobId:selectedAdminJobId, type:resubmitType });
      setSubmissionTimeline((response.data as { submissions?:SubmissionGroup[] }).submissions ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setTimelineBusy(false);
    }
  }

  async function openComparison(requestId: string) {
    if (!firebaseConfigured) {
      setComparison({ request:{id:requestId,jobId:selectedAdminJobId,type:resubmitType,reasons:["手ブレで文字が読めません"],note:"",status:"submitted"}, source:selectedSourceFile ?? submissionTimeline[0]?.files[0] ?? null, replacements:[{ id:"demo_new", submissionId:"demo_new_submission", originalName:"new.jpg", driveName:"7.12 ベイシア成田 Aさん (2).jpg", contentType:"image/jpeg", sequence:2, purpose:"replacement", status:"completed", previewUrl:demoPreview("再送画像（鮮明）","#e8f5ee"), completedAt:new Date().toISOString(), replacesFileId:"demo_source" }] });
      return;
    }
    if (!functions) return;
    const callable = httpsCallable(functions, "getResubmissionComparison");
    const response = await callable({ requestId });
    setComparison(response.data as ResubmissionComparison);
  }

  function toggleReason(reason: string) {
    setResubmitReasons((current) => current.includes(reason)
      ? current.filter((value) => value !== reason)
      : [...current, reason]);
  }

  async function createResubmission() {
    if (!selectedAdminJobId || !resubmitReasons.length) {
      setMessage("再提出理由を1つ以上選んでください。");
      return;
    }
    if (!firebaseConfigured) {
      setResubmissions((current) => [{ id:crypto.randomUUID(), jobId:selectedAdminJobId, staffId:"s1", type:resubmitType, reasons:resubmitReasons, note:resubmitNote, status:"open", sourceSubmissionId:selectedSourceFile?.submissionId, sourceFileId:selectedSourceFile?.id }, ...current]);
      setMessage("デモ：再提出依頼を送りました。");
      return;
    }
    if (!functions) return;
    await httpsCallable(functions, "createResubmissionRequest")({
      jobId:selectedAdminJobId, type:resubmitType, reasons:resubmitReasons, note:resubmitNote,
      sourceSubmissionId:selectedSourceFile?.submissionId,
      sourceFileId:selectedSourceFile?.id,
    });
    setMessage("再提出依頼を送りました。");
    await loadResubmissions();
  }

  async function loadResubmissions() {
    if (!firebaseConfigured) return;
    if (!functions) return;
    const response = await httpsCallable(functions, "getAdminResubmissionRequests")({});
    setResubmissions((response.data as {requests?:ResubmissionRequest[]}).requests ?? []);
  }

  async function completeResubmission(requestId: string) {
    if (!firebaseConfigured) {
      setResubmissions((current) => current.map((item) => item.id === requestId ? {...item,status:"completed"} : item));
      return;
    }
    if (!functions) return;
    await httpsCallable(functions, "completeResubmissionRequest")({ requestId });
    setMessage("再提出の確認を完了しました。");
    setComparison(null);
    await loadResubmissions();
  }


  async function loadSheetIssues() {
    if (!firebaseConfigured) {
      setSheetIssues([
        {
          id:"issue_demo_conflict",
          jobId:"1",
          operation:"expense.review",
          status:"blocked",
          errorType:"conflict",
          errorMessage:"transportationはスプシ側で変更されています。現在値: 1,240",
          attempts:1,
          canRetry:false,
          desiredUpdates:{transportation:1500},
          beforeValues:{transportation:1240},
          job:{workDate:"7/15",storeName:"イオン津田沼",assignedStaffName:"Aさん",clientName:"〇〇デモ"},
        },
        {
          id:"issue_demo_system",
          jobId:"2",
          operation:"submission.report",
          status:"retry_wait",
          errorType:"system",
          errorMessage:"一時的なGoogle APIエラー",
          attempts:2,
          canRetry:true,
          desiredUpdates:{reportSubmitted:"提出済"},
          beforeValues:{reportSubmitted:""},
          job:{workDate:"7/15",storeName:"イオン船橋",assignedStaffName:"Bさん",clientName:"〇〇デモ"},
        },
      ]);
      return;
    }
    if (!functions) return;
    setIssuesBusy(true);
    try {
      const callable = httpsCallable(functions, "getSheetWriteIssues");
      const response = await callable({ limit:100 });
      setSheetIssues((response.data as { issues?:SheetWriteIssue[] }).issues ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIssuesBusy(false);
    }
  }

  async function retrySheetIssue(issue:SheetWriteIssue) {
    if (!issue.canRetry) {
      setMessage("競合は自動再試行できません。スプシの現在値を確認してください。");
      return;
    }
    if (!firebaseConfigured) {
      setSheetIssues((current)=>current.filter((item)=>item.id!==issue.id));
      setMessage("デモ：書込を再試行しました。");
      return;
    }
    if (!functions) return;
    await httpsCallable(functions,"retrySheetWriteIssue")({
      queueId:issue.id,
      note:"管理画面から手動再試行",
    });
    setMessage("書込を再試行しました。");
    await loadSheetIssues();
  }

  async function acknowledgeSheetIssue(issue:SheetWriteIssue) {
    const note=window.prompt("対応メモ", "スプシを確認して手動対応");
    if (note===null) return;
    if (!firebaseConfigured) {
      setSheetIssues((current)=>current.filter((item)=>item.id!==issue.id));
      setMessage("デモ：確認済みにしました。");
      return;
    }
    if (!functions) return;
    await httpsCallable(functions,"acknowledgeSheetWriteIssue")({
      queueId:issue.id,
      note,
    });
    setMessage("書込エラーを確認済みにしました。");
    await loadSheetIssues();
  }

  async function confirmJobApplication(job:Job) {
    if (job.applicationAdminConfirmed) return;
    if (!firebaseConfigured) {
      setJobs((current)=>current.map((item)=>item.id===job.id?{...item,applicationAdminConfirmed:true}:item));
      setMessage("デモ：応募を確認済みにしました。");
      return;
    }
    if (!functions) return;
    await httpsCallable(functions,"confirmApplication")({jobId:job.id});
    setMessage("応募を確認済みにしました。");
    await loadJobs();
  }

  async function loadExpenseReview(jobId:string) {
    setExpenseJobId(jobId);
    if (!jobId) return;
    if (!firebaseConfigured) {
      const job=jobs.find((item)=>item.id===jobId);
      setExpenseValues({
        transportation:String(job?.expenses?.transportation ?? ""),
        purchase8:String(job?.expenses?.purchase8 ?? ""),
        purchase10:String(job?.expenses?.purchase10 ?? ""),
        netPrintCost:String(job?.expenses?.netPrintCost ?? ""),
        postageCost:String(job?.expenses?.postageCost ?? ""),
      });
      setExpenseNote("");
      setExpenseStatus("デモ読込済み");
      return;
    }
    if (!functions) return;
    setExpenseBusy(true);
    try {
      const callable=httpsCallable(functions,"getExpenseReview");
      const response=await callable({jobId});
      const data=response.data as {
        currentValues?:Record<string,number|null>;
        draft?:{values?:Record<string,number|null>;note?:string;status?:string}|null;
      };
      const source=data.draft?.values ?? data.currentValues ?? {};
      setExpenseValues({
        transportation:String(source.transportation ?? ""),
        purchase8:String(source.purchase8 ?? ""),
        purchase10:String(source.purchase10 ?? ""),
        netPrintCost:String(source.netPrintCost ?? ""),
        postageCost:String(source.postageCost ?? ""),
      });
      setExpenseNote(data.draft?.note ?? "");
      setExpenseStatus(data.draft?.status ?? "未処理");
    } catch (error) {
      setMessage(error instanceof Error?error.message:String(error));
    } finally {
      setExpenseBusy(false);
    }
  }

  async function saveExpenseDraft() {
    if (!expenseJobId) return;
    if (!firebaseConfigured) {
      setExpenseStatus("一時保存");
      setMessage("デモ：経費を一時保存しました。");
      return;
    }
    if (!functions) return;
    setExpenseBusy(true);
    try {
      await httpsCallable(functions,"saveExpenseReviewDraft")({
        jobId:expenseJobId,
        values:expenseValues,
        note:expenseNote,
      });
      setExpenseStatus("一時保存");
      setMessage("経費を一時保存しました。");
    } catch(error) {
      setMessage(error instanceof Error?error.message:String(error));
    } finally {
      setExpenseBusy(false);
    }
  }

  async function completeExpense() {
    if (!expenseJobId) return;
    if (!window.confirm("スプシの現在値と一致する場合だけ、経費を書込キューへ送ります。続けますか？")) return;
    if (!firebaseConfigured) {
      setExpenseStatus("書込待ち");
      setMessage("デモ：経費を書込キューへ送りました。");
      return;
    }
    if (!functions) return;
    setExpenseBusy(true);
    try {
      await httpsCallable(functions,"completeExpenseReview")({
        jobId:expenseJobId,
        values:expenseValues,
        note:expenseNote,
        confirmExistingValues:false,
      });
      setExpenseStatus("書込待ち");
      setMessage("経費を書込キューへ送りました。");
      await loadSheetIssues();
    } catch(error) {
      setMessage(error instanceof Error?error.message:String(error));
    } finally {
      setExpenseBusy(false);
    }
  }

  async function openJobSheet(job:Job) {
    if (!firebaseConfigured) {
      setMessage(`デモ：${job.storeName}のスプシ該当行を開きます。`);
      return;
    }
    if (!functions) return;
    try {
      const response=await httpsCallable(functions,"getJobSheetLink")({jobId:job.id});
      const url=String((response.data as {url?:string}).url ?? "");
      if (url) window.open(url,"_blank","noopener,noreferrer");
    } catch(error) {
      setMessage(error instanceof Error?error.message:String(error));
    }
  }

  async function loadDashboard(month = dashboardMonth) {
    if (!firebaseConfigured) {
      setDashboard({ ...demoDashboard, month });
      return;
    }
    if (!functions) return;
    setDashboardBusy(true);
    try {
      const callable = httpsCallable(functions, "getOperationsDashboard");
      const response = await callable({ month });
      setDashboard(response.data as DashboardData);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDashboardBusy(false);
    }
  }

  function prepareCancellation(job: Job) {
    setCancellationJobId(job.id);
    setCancellationReasonCategory(job.cancellationReasonCategory || "maker");
    setCancellationTreatment(job.cancellationFinancialTreatment || "invoice_and_pay");
    setCancellationNote("");
    document.getElementById("cancellation-management")?.scrollIntoView({ behavior:"smooth", block:"center" });
  }

  async function submitCancellation() {
    if (!cancellationJobId) return;
    const job = jobs.find((item) => item.id === cancellationJobId);
    if (!job) return;
    if (!window.confirm(`${job.workDate} ${job.storeName}をキャンセルとして記録しますか？`)) return;
    if (!firebaseConfigured) {
      setJobs((current) => current.map((item) => item.id === cancellationJobId ? {
        ...item,
        status:"cancelled",
        cancelled:true,
        cancellationReasonCategory,
        cancellationFinancialTreatment:cancellationTreatment,
        cancellationReason:cancellationNote || cancellationReasonCategory,
      } : item));
      setMessage("デモ：キャンセルを記録しました。");
      setDashboard((current) => current ? {
        ...current,
        counts:{...current.counts,cancelled:current.counts.cancelled+1,effectiveJobs:Math.max(0,current.counts.effectiveJobs-1)},
      } : current);
      return;
    }
    if (!functions) return;
    setCancellationBusy(true);
    try {
      const callable = httpsCallable(functions, "adminSetJobCancellation");
      await callable({
        jobId:cancellationJobId,
        reasonCategory:cancellationReasonCategory,
        reasonNote:cancellationNote,
        financialTreatment:cancellationTreatment,
      });
      setMessage("キャンセルを記録しました。募集・事前連絡・提出タスクを停止します。");
      await Promise.all([loadJobs(), loadDashboard()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCancellationBusy(false);
    }
  }

  async function restoreCancellation(job: Job) {
    if (!window.confirm(`${job.workDate} ${job.storeName}のキャンセルを解除しますか？`)) return;
    const note = window.prompt("復帰メモ（任意）", "") ?? "";
    if (!firebaseConfigured) {
      setJobs((current) => current.map((item) => item.id === job.id ? {
        ...item,
        status:item.assignedStaffId ? "assigned" : "open",
        cancelled:false,
        cancellationReason:undefined,
        cancellationReasonCategory:undefined,
        cancellationFinancialTreatment:undefined,
      } : item));
      setMessage("デモ：キャンセルを解除しました。");
      return;
    }
    if (!functions) return;
    setCancellationBusy(true);
    try {
      const callable = httpsCallable(functions, "adminRestoreCancelledJob");
      await callable({ jobId:job.id, note });
      setMessage("キャンセルを解除しました。");
      await Promise.all([loadJobs(), loadDashboard()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCancellationBusy(false);
    }
  }

  async function loadStaffPerformance(profile: StaffProfile) {
    if (!firebaseConfigured) {
      const related = demoJobs.filter((job) => job.assignedStaffId === profile.id);
      const implemented = related.filter((job) => job.status !== "cancelled" && job.workDate <= "2026-07-13");
      const scheduled = related.filter((job) => job.status !== "cancelled" && job.workDate > "2026-07-13");
      const cancelled = related.filter((job) => job.status === "cancelled");
      setPerformance({
        profile:{id:profile.id,displayName:profile.displayName,rank:profile.rank || "A",areaLabels:profile.areaLabels || [],nearestStation:profile.nearestStation || ""},
        performance:{
          totals:{assignedJobs:implemented.length+scheduled.length,implementedJobs:implemented.length,scheduledJobs:scheduled.length,cancelledJobs:cancelled.length,preContactLate:related.filter((job)=>job.preContactLate).length,reportLate:related.filter((job)=>job.submissionStatus?.report?.lateFirstSubmission).length,salesFloorLate:related.filter((job)=>job.submissionStatus?.salesFloor?.lateFirstSubmission).length,invoice:related.reduce((sum,job)=>sum+(job.financials?.clientChargeTotal || 0)+(job.financials?.clientChargeAdditionsTotal || 0),0),payment:related.reduce((sum,job)=>sum+(job.financials?.staffPaymentTotal || 0),0),grossProfit:related.reduce((sum,job)=>sum+(job.financials?.clientChargeTotal || 0)+(job.financials?.clientChargeAdditionsTotal || 0)-(job.financials?.staffPaymentTotal || 0),0)},
          clients:[...new Set(related.map((job)=>job.clientName))].map((name)=>({name,count:related.filter((job)=>job.clientName===name).length})),
          makers:[...new Set(related.map((job)=>job.makerName))].map((name)=>({name,count:related.filter((job)=>job.makerName===name).length})),
          menus:[],
          stores:[...new Set(related.map((job)=>job.storeName))].map((name)=>({name,count:related.filter((job)=>job.storeName===name).length})),
          months:[{name:"2026-07",count:related.length}],
          recentJobs:related.map((job)=>({id:job.id,dateKey:job.workDate,clientName:job.clientName,storeName:job.storeName,makerName:job.makerName,menuName:"",cancelled:job.status==="cancelled"})),
        },
      });
      document.getElementById("staff-performance")?.scrollIntoView({ behavior:"smooth", block:"center" });
      return;
    }
    if (!functions) return;
    setPerformanceBusy(true);
    try {
      const callable = httpsCallable(functions, "getStaffPerformance");
      const response = await callable({
        staffId:profile.id,
        from:"2025-10-01",
        through:"2099-12-31",
      });
      setPerformance(response.data as StaffPerformanceData);
      setTimeout(()=>document.getElementById("staff-performance")?.scrollIntoView({ behavior:"smooth", block:"center" }),50);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPerformanceBusy(false);
    }
  }


function updateJobForm<K extends keyof JobForm>(key:K,value:JobForm[K]) {
  setJobForm((current)=>({...current,[key]:value}));
}

async function createJobGroup() {
  if (!window.confirm(`${jobForm.slots}名分の案件を下書き作成しますか？`)) return;
  setJobCreateBusy(true);
  try {
    if (!firebaseConfigured) {
      const groupId=`demo_group_${Date.now()}`;
      const created=Array.from({length:Number(jobForm.slots)||1},(_,index)=>({
        id:`demo_new_${Date.now()}_${index}`,workDate:jobForm.workDate,
        clientName:jobForm.clientName,storeName:jobForm.storeName,makerName:jobForm.makerName,
        storeAddress:jobForm.storeAddress,storeNearestStation:jobForm.storeNearestStation,
        menuName:jobForm.menuName,entryTime:jobForm.entryTime,workTime:jobForm.workTime,
        subcontractorName:jobForm.subcontractorName,basePay:Number(jobForm.basePay)||null,
        groupId,slotNumber:index+1,slotCount:Number(jobForm.slots)||1,
        status:jobForm.publicationMode==="draft"?"draft":"open",
        publishable:jobForm.publicationMode!=="draft",recruitmentStopped:jobForm.publicationMode==="draft",
        revision:0,
      } as Job));
      setJobs((current)=>[...created,...current]);
      setMessage(`デモ：${created.length}名分を作成しました。`);
      return;
    }
    if (!functions) return;
    const response=await httpsCallable(functions,"createAdminJobGroup")({
      ...jobForm,
      slots:Number(jobForm.slots),
      basePay:jobForm.basePay===""?null:Number(jobForm.basePay),
      publishAt:jobForm.publishAt?new Date(jobForm.publishAt).toISOString():null,
    });
    const data=response.data as {jobIds?:string[];warning?:string|null};
    setMessage(data.warning || `${data.jobIds?.length ?? 0}名分の案件を作成しました。`);
    setJobForm((current)=>({...blankJobForm,workDate:current.workDate}));
    await loadJobs();
  } catch(error) {
    setMessage(error instanceof Error?error.message:String(error));
  } finally {
    setJobCreateBusy(false);
  }
}

async function duplicateJob(job:Job) {
  const date=window.prompt("複製後の実施日",job.workDate) || job.workDate;
  const slots=Number(window.prompt("募集人数","1") || "1");
  if (!firebaseConfigured) {
    const copies=Array.from({length:Math.max(1,Math.min(20,slots))},(_,index)=>({
      ...job,id:`demo_copy_${Date.now()}_${index}`,workDate:date,dateKey:date,
      assignedStaffId:undefined,assignedStaffName:undefined,status:"draft",
      publishable:false,recruitmentStopped:true,revision:0,
    }));
    setJobs((current)=>[...copies,...current]);
    setMessage(`デモ：${copies.length}件を下書き複製しました。`);
    return;
  }
  if (!functions) return;
  try {
    const response=await httpsCallable(functions,"duplicateAdminJob")({
      sourceJobId:job.id,workDate:date,slots,publicationMode:"draft",publishAt:null,
    });
    setMessage(`${(response.data as {jobIds?:string[]}).jobIds?.length ?? 0}件を複製しました。`);
    await loadJobs();
  } catch(error) {
    setMessage(error instanceof Error?error.message:String(error));
  }
}

async function changePublication(job:Job,action:"publish"|"stop"|"draft"|"schedule") {
  let publishAt:string|null=null;
  if(action==="schedule") {
    const entered=window.prompt("公開日時（例 2026-08-01T09:00）","");
    if(!entered)return;
    publishAt=new Date(entered).toISOString();
  }
  if (!firebaseConfigured) {
    setJobs((current)=>current.map((item)=>item.id===job.id?{
      ...item,
      status:action==="publish"?"open":action==="schedule"?"scheduled":action==="draft"?"draft":item.assignedStaffId?"assigned":"stopped",
      publishable:action==="publish",
      recruitmentStopped:action!=="publish",
    }:item));
    setMessage(`デモ：公開状態を変更しました。`);
    return;
  }
  if(!functions)return;
  try {
    const response=await httpsCallable(functions,"updateJobPublication")({
      jobIds:[job.id],action,publishAt,
    });
    const data=response.data as {updated?:string[];blocked?:string[]};
    setMessage(data.blocked?.length?"安全条件により下書きのままです。":"公開状態を変更しました。");
    await loadJobs();
  } catch(error) {
    setMessage(error instanceof Error?error.message:String(error));
  }
}

function loadJobEdit(job:Job) {
  setJobEditId(job.id);
  setJobEditRevision(job.revision ?? 0);
  setJobEdit({
    ...blankJobEdit,
    clientName:job.clientName||"",storeName:job.storeName||"",makerName:job.makerName||"",
    storeAddress:job.storeAddress||"",storeNearestStation:job.storeNearestStation||"",
    menuName:job.menuName||"",entryTime:job.entryTime||"",workTime:job.workTime||"",
    subcontractorName:job.subcontractorName||"",assignedStaffId:job.assignedStaffId||"",
    ...Object.fromEntries(Object.entries(job.clientChargeInputs||{}).map(([key,value])=>[key,String(value??"")])),
    ...Object.fromEntries(Object.entries(job.staffPaymentInputs||{}).map(([key,value])=>[key,String(value??"")])),
  });
  setTimeout(()=>document.getElementById("job-safe-edit")?.scrollIntoView({behavior:"smooth",block:"center"}),50);
}

function updateJobEdit<K extends keyof JobEditForm>(key:K,value:JobEditForm[K]) {
  setJobEdit((current)=>({...current,[key]:value}));
}

async function saveJobEdit() {
  if(!jobEditId)return;
  if(!window.confirm("入力セルだけを保存します。合計・数式セルは変更しません。続けますか？"))return;
  setJobEditBusy(true);
  try {
    const clientChargeInputs=Object.fromEntries(invoiceLabels.map(([key])=>[key,jobEdit[key]===""?null:Number(jobEdit[key])]));
    const staffPaymentInputs=Object.fromEntries(staffPayLabels.map(([key])=>[key,jobEdit[key]===""?null:Number(jobEdit[key])]));
    if(!firebaseConfigured) {
      setJobs((current)=>current.map((job)=>job.id===jobEditId?{
        ...job,clientName:jobEdit.clientName,storeName:jobEdit.storeName,makerName:jobEdit.makerName,
        storeAddress:jobEdit.storeAddress,storeNearestStation:jobEdit.storeNearestStation,
        menuName:jobEdit.menuName,entryTime:jobEdit.entryTime,workTime:jobEdit.workTime,
        subcontractorName:jobEdit.subcontractorName,
        assignedStaffId:jobEdit.assignedStaffId||undefined,
        assignedStaffName:staff.find((profile)=>profile.id===jobEdit.assignedStaffId)?.displayName,
        clientChargeInputs,staffPaymentInputs,revision:(job.revision??0)+1,
      }:job));
      setJobEditRevision((value)=>value+1);
      setMessage("デモ：入力項目を保存しました。");
      return;
    }
    if(!functions)return;
    const response=await httpsCallable(functions,"adminEditJobInputs")({
      jobId:jobEditId,revision:jobEditRevision,
      fields:{
        clientName:jobEdit.clientName,storeName:jobEdit.storeName,makerName:jobEdit.makerName,
        storeAddress:jobEdit.storeAddress,storeNearestStation:jobEdit.storeNearestStation,
        menuName:jobEdit.menuName,entryTime:jobEdit.entryTime,workTime:jobEdit.workTime,
        subcontractorName:jobEdit.subcontractorName,
        assignedStaffId:jobEdit.assignedStaffId||null,
        clientChargeInputs,staffPaymentInputs,
      },
    });
    const data=response.data as {revision?:number;sheetWriteQueued?:boolean;pendingSourceWrite?:boolean};
    setJobEditRevision(data.revision ?? jobEditRevision+1);
    setMessage(data.sheetWriteQueued?"スプシ書込キューへ送りました。":data.pendingSourceWrite?"アプリへ保存しました。スプシ書込は安全確認待ちです。":"保存しました。");
    await loadJobs();
  } catch(error) {
    setMessage(error instanceof Error?error.message:String(error));
  } finally {
    setJobEditBusy(false);
  }
}

async function exportJobs() {
  setExportBusy(true);
  try {
    if(!firebaseConfigured) {
      const header='"実施日","クライアント","店舗","メーカー","メニュー","実施時間","スタッフ","状態"\\r\\n';
      const rows=jobs.filter((job)=>exportIncludeCancelled||job.status!=="cancelled").map((job)=>[
        job.workDate,job.clientName,job.storeName,job.makerName,job.menuName||"",job.workTime||"",job.assignedStaffName||"",job.status
      ].map((value)=>`"${String(value).replace(/"/g,'""')}"`).join(",")).join("\\r\\n");
      downloadCsv(`デモ_${exportGroupBy}_案件一覧.csv`,"\\uFEFF"+header+rows);
      setMessage("デモCSVを出力しました。");
      return;
    }
    if(!functions)return;
    const response=await httpsCallable(functions,"generateJobExport")({
      from:exportFrom,through:exportThrough,groupBy:exportGroupBy,
      name:exportName||undefined,includeCancelled:exportIncludeCancelled,
    });
    const data=response.data as {filename:string;csv:string;rows:number};
    downloadCsv(data.filename,data.csv);
    setMessage(`${data.rows}件の資料を出力しました。`);
  } catch(error) {
    setMessage(error instanceof Error?error.message:String(error));
  } finally {
    setExportBusy(false);
  }
}

function downloadCsv(filename:string,content:string) {
  const blob=new Blob([content],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement("a");
  anchor.href=url;anchor.download=filename;anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}


  const filtered = jobs.filter((job) => {
    const haystack = `${job.assignedStaffName ?? ""} ${job.storeName} ${job.makerName} ${job.clientName}`;
    return haystack.includes(queryText);
  });

  const filteredStaff = staff.filter((profile) => {
    const haystack = [
      profile.displayName,
      ...(profile.emails ?? []),
      profile.nearestStation ?? "",
      profile.homePrefecture ?? "",
      ...(profile.areaLabels ?? []),
    ].join(" ");
    return haystack.includes(staffQuery);
  });

  if (firebaseConfigured && !user) {
    return (
      <main className="login">
        <section>
          <img src="/logo.png" alt="Lip Knots" />
          <h1>Lip Knots Crew Admin</h1>
          <p>管理者Googleアカウントでログインしてください。</p>
          <button onClick={login}>Googleでログイン</button>
        </section>
      </main>
    );
  }

  const unresolved = jobs.filter((job) => job.status === "assigned" && !job.preContact).length;
  const monthly = dashboard ?? demoDashboard;
  const cancellationTarget = jobs.find((job) => job.id === cancellationJobId) ?? null;
  const productionBlocked = Boolean(
    productionControl?.control.emergencyLock ||
    (productionControl?.environment === "production" && !productionControl.control.productionEnabled)
  );

  return (
    <main className={`shell ${productionBlocked ? "production-blocked" : ""}`}>
      <header>
        <img src="/logo.png" alt="Lip Knots" />
        <div><strong>Lip Knots Crew 管理画面</strong><small>{user?.email ?? "デモ管理者"}</small></div>
        {user && (
          <div className="header-actions">
            <button className="ghost" onClick={enablePush} disabled={pushBusy || pushEnabled}>通知ON</button>
            <button className="ghost" onClick={() => auth && signOut(auth)}>ログアウト</button>
          </div>
        )}
      </header>
      {!firebaseConfigured&&<div className="demo-mode-banner"><strong>LIVE DEMO v5.6</strong><span>実データ送信なし。最新の本番監視・SLO・切替画面をそのまま確認できます。</span></div>}
      {message && <div className="message">{message}</div>}
      {productionBlocked && (
        <div className={`production-stop-banner ${productionControl?.control.emergencyLock ? "locked" : "waiting"}`}>
          <strong>{productionControl?.control.emergencyLock ? "全体停止ロック作動中" : "本番公開ロック中"}</strong>
          <span>{productionControl?.control.emergencyLock ? "アプリから解除できません。復旧リリースが必要です。" : "社長承認と別管理者による有効化が完了するまで業務処理は停止します。"}</span>
        </div>
      )}
      <section className="panel production-control-panel">
        <div className="production-control-head">
          <div>
            <h2>本番公開承認・全体停止</h2>
            <p>30〜50名完了証跡→社長承認→staging署名→production受理→別管理者実行。自動公開しません。</p>
          </div>
          <span className={`production-state ${productionControl?.control.emergencyLock?"locked":productionControl?.control.productionEnabled?"enabled":productionControl?.importedApproval?.status??productionControl?.review?.status??"waiting"}`}>
            {productionControl?.control.emergencyLock?"EMERGENCY LOCK":productionControl?.control.productionEnabled?"PRODUCTION ON":productionControl?.importedApproval?.status??productionControl?.review?.status??"未審査"}
          </span>
        </div>
        {productionControl?.stagedRollout ? (
          <div className="production-rollout-summary">
            <span><strong>{productionControl.stagedRollout.deliveredCount}/{productionControl.stagedRollout.targetCount}名</strong>段階配布</span>
            <span><strong>wave {productionControl.stagedRollout.currentWave}/3</strong>完了</span>
            <span><strong>{productionControl.stagedRollout.criticalAlertCount}</strong>重大アラート</span>
            <span><strong>{productionControl.stagedRollout.monitorFailureCount}</strong>監視失敗</span>
            <span><strong>{productionControl.stagedRollout.inviteFailureCount}</strong>招待失敗</span>
          </div>
        ) : <p className="production-waiting">{productionControl?.environment==="production"?(productionControl.control.productionEnabled?"本番公開中です。当日指揮盤でT＋24時間まで監視してください。":"stagingで発行した署名付き承認パッケージを受理してください。") : "30〜50名の全3waveと最終観察が完了すると、公開審査を開始できます。"}</p>}
        {productionControl?.stagedRollout && (
          <div className="rehearsal-panel">
            <div className="rehearsal-head">
              <div><strong>本番移行リハーサル＋復元演習</strong><small>バックアップ→隔離復元→件数・SHA検算→移行dry-run→切戻しを7工程で固定します。</small></div>
              <span className={`rehearsal-status ${productionControl.rehearsalCertified?"completed":productionRehearsal?.status??"unstarted"}`}>{productionControl.rehearsalCertified?"CERTIFIED":productionRehearsal?.status??"未開始"}</span>
            </div>
            {(!productionRehearsal||["aborted"].includes(productionRehearsal.status))&&!productionControl.rehearsalCertified&&(
              <div className="rehearsal-create">
                <label>元staging Project<input value={expectedFirebaseProjectId} disabled /></label>
                <label>隔離復元先Project<input value={rehearsalRestoreProject} onChange={(event)=>setRehearsalRestoreProject(event.target.value)} /></label>
                <label>演習backup bucket<input value={rehearsalBackupBucket} onChange={(event)=>setRehearsalBackupBucket(event.target.value)} /></label>
                <button onClick={createRehearsal} disabled={rehearsalBusy||!expectedFirebaseProjectId}>7工程を開始</button>
              </div>
            )}
            {productionRehearsal&&!productionControl.rehearsalCertified&&!["aborted","completed"].includes(productionRehearsal.status)&&(
              <>
                <div className="rehearsal-checks">
                  {([
                    ["freezeConfirmed","変更凍結"],["firestoreExportComplete","Firestore export"],["storageManifestComplete","Storage manifest"],["authExportComplete","Auth export"],
                    ["restoreComplete","隔離復元"],["securityRulesDeployed","Rules復元"],["indexesReady","Indexes READY"],["migrationDryRunComplete","移行dry-run"],["rollbackComplete","切戻し完了"],
                  ] as Array<[keyof ProductionRehearsalMetrics,string]>).map(([key,label])=><label className={rehearsalMetrics[key]?"checked":""} key={key}><input type="checkbox" checked={Boolean(rehearsalMetrics[key])} onChange={(event)=>setRehearsalMetrics(current=>({...current,[key]:event.target.checked}))}/><span>{label}</span></label>)}
                </div>
                <div className="rehearsal-number-grid">
                  {([
                    ["sourceDocumentCount","元Firestore件数"],["restoredDocumentCount","復元Firestore件数"],["sourceStorageObjectCount","元Storage件数"],["restoredStorageObjectCount","復元Storage件数"],
                    ["sourceAuthUserCount","元Auth人数"],["restoredAuthUserCount","復元Auth人数"],["sampleMismatchCount","標本差異"],["permissionProbeFailures","権限失敗"],["smokeFailures","復元smoke失敗"],
                    ["plannedMigrationCount","移行予定件数"],["dryRunAppliedCount","dry-run件数"],["migrationDiffCount","移行差異"],["rollbackRtoMinutes","RTO分"],["rollbackDataLossMinutes","RPO分"],["postRollbackSmokeFailures","切戻しsmoke失敗"],
                  ] as Array<[keyof ProductionRehearsalMetrics,string]>).map(([key,label])=><label key={key}>{label}<input type="number" min="0" value={Number(rehearsalMetrics[key])} onChange={(event)=>setRehearsalMetrics(current=>({...current,[key]:Math.max(0,Number(event.target.value)||0)}))}/></label>)}
                </div>
                <div className="rehearsal-hashes">
                  <label>元snapshot SHA-256<input value={rehearsalMetrics.sourceSnapshotSha256} onChange={(event)=>setRehearsalMetrics(current=>({...current,sourceSnapshotSha256:event.target.value.trim().toLowerCase()}))}/></label>
                  <label>復元snapshot SHA-256<input value={rehearsalMetrics.restoredSnapshotSha256} onChange={(event)=>setRehearsalMetrics(current=>({...current,restoredSnapshotSha256:event.target.value.trim().toLowerCase()}))}/></label>
                </div>
                <label className="production-evidence">演習証跡（7件以上・改行区切り）<textarea value={rehearsalMetrics.evidenceRefs.join("\n")} onChange={(event)=>setRehearsalMetrics(current=>({...current,evidenceRefs:event.target.value.split("\n")}))}/></label>
                {productionRehearsal.gate&&<div className="production-gate-checks">{productionRehearsal.gate.checks.map(check=><span className={check.passed?"passed":"blocked"} key={check.key}>{check.passed?"✓":"!"} {check.label}</span>)}</div>}
                <div className="rehearsal-actions"><button onClick={saveRehearsalMetrics} disabled={rehearsalBusy}>検算・保存</button><button onClick={completeRehearsal} disabled={rehearsalBusy||!productionRehearsal.gate?.eligible}>合格証跡を固定</button><button className="danger" onClick={abortRehearsal} disabled={rehearsalBusy}>中止</button></div>
              </>
            )}
            {productionControl.rehearsalCertified&&<p className="rehearsal-certified">復元演習合格証跡を公開ゲートへ連携済み。SHA-256：{productionControl.rehearsalFingerprint.slice(0,16)}…</p>}
          </div>
        )}
        {productionControl?.stagedRollout && (!productionControl.review || ["blocked","rejected"].includes(productionControl.review.status)) && !productionControl.control.emergencyLock && (
          <>
            <div className="production-check-grid">
              {productionManualLabels.map(([key,label])=><label key={key} className={productionManual[key]?"checked":""}>
                <input type="checkbox" checked={productionManual[key]} disabled={rehearsalBackedManualKeys.has(key)} onChange={(event)=>setProductionManual((current)=>({...current,[key]:event.target.checked}))} />
                <span>{label}{rehearsalBackedManualKeys.has(key)?"（演習自動連携）":""}</span>
              </label>)}
            </div>
            <label className="production-evidence">証跡参照（5件以上・改行区切り）<textarea value={productionEvidence} onChange={(event)=>setProductionEvidence(event.target.value)} /></label>
            <label className="production-evidence">提出メモ<textarea value={productionNote} onChange={(event)=>setProductionNote(event.target.value)} /></label>
            <button onClick={submitProductionReview} disabled={productionBusy}>公開条件を確定・社長承認へ</button>
          </>
        )}
        {productionControl?.review?.gate && (
          <div className="production-gate-checks">
            {productionControl.review.gate.checks.map((check)=><span className={check.passed?"passed":"blocked"} key={check.key}>{check.passed?"✓":"!"} {check.label}</span>)}
          </div>
        )}
        {productionControl?.review?.status === "pending_executive" && (
          <div className="production-decision">
            <label>社長承認・否認理由<textarea value={productionDecisionNote} onChange={(event)=>setProductionDecisionNote(event.target.value)} /></label>
            <button onClick={()=>decideProductionReview("approve")} disabled={productionBusy||!productionControl.review?.currentAdminCanExecutiveApprove}>社長承認</button>
            <button className="danger" onClick={()=>decideProductionReview("reject")} disabled={productionBusy||!productionControl.review?.currentAdminCanExecutiveApprove}>否認</button>
            {!productionControl.review.currentAdminCanExecutiveApprove && <small>指定承認アカウントかつ提出者とは別の管理者でログインしてください。</small>}
          </div>
        )}
        {productionControl?.environment === "staging" && productionControl.review?.status === "approved_pending_enable" && (
          <div className="approval-package-box signed">
            <div><strong>社長承認済み</strong><small>Ed25519署名・対象production固定・30分限定の承認パッケージを発行します。</small></div>
            <button onClick={exportApprovalPackage} disabled={productionBusy}>署名パッケージを発行</button>
          </div>
        )}
        {productionControl?.environment === "staging" && approvalPackageText && (
          <div className="approval-package-transfer">
            <div><strong>productionへ渡す署名JSON</strong><small>期限：{approvalPackageExpiresAt||"30分"}</small></div>
            <textarea value={approvalPackageText} readOnly spellCheck={false} />
            <button className="ghost" onClick={copyApprovalPackage}>もう一度コピー</button>
          </div>
        )}
        {productionControl?.environment === "production" && !productionControl.control.productionEnabled && (!productionControl.importedApproval||productionControl.importedApproval.status==="expired") && !productionControl.control.emergencyLock && (
          <div className="approval-package-transfer import">
            <div><strong>署名付き承認パッケージを受理</strong><small>署名・発行鍵・Project・企業・公開判定・期限をサーバーで再検証します。</small></div>
            <textarea value={approvalPackageText} onChange={(event)=>setApprovalPackageText(event.target.value)} placeholder="stagingで発行した署名JSONを貼り付け" spellCheck={false} />
            <button onClick={importApprovalPackage} disabled={productionBusy||approvalPackageText.trim().length<100}>検証して受理</button>
          </div>
        )}
        {productionControl?.environment === "production" && productionControl.importedApproval && productionControl.importedApproval.status!=="expired" && (
          <div className="approval-package-box accepted">
            <div>
              <strong>署名検証済み：{productionControl.importedApproval.releaseId}</strong>
              <small>{productionControl.importedApproval.sourceProjectId} → {productionControl.importedApproval.targetProjectId} / 期限 {productionControl.importedApproval.expiresAt??"不明"}</small>
              <small>公開SHA-256：{productionControl.importedApproval.releaseFingerprint.slice(0,16)}…</small>
            </div>
            {productionControl.importedApproval.status === "ready_to_enable" && <button onClick={enableProduction} disabled={productionBusy||!productionControl.importedApproval.currentAdminCanEnable||productionCutover?.status!=="ready"}>本番公開を有効化</button>}
            {productionControl.importedApproval.status === "ready_to_enable"&&!productionControl.importedApproval.currentAdminCanEnable&&<small className="approval-warning">社長承認者とは別の管理者でログインしてください。</small>}
            {productionControl.importedApproval.status === "ready_to_enable"&&productionCutover?.status!=="ready"&&<small className="approval-warning">同じReleaseの当日指揮盤を準備GOにし、T±5分で実行してください。</small>}
          </div>
        )}
        {productionControl?.environment === "production" && (
          <div className="cutover-panel">
            <div className="cutover-head">
              <div><strong>本番切替当日指揮盤</strong><small>T−60からT＋24時間を7地点で管理し、5分間隔で切戻し要否を再判定します。</small></div>
              <span className={`cutover-action ${productionCutover?.gate?.action??"unstarted"}`}>{productionCutover?.gate?.action?.toUpperCase()??"未開始"}</span>
            </div>
            {(!productionCutover||["completed","cancelled","rollback_started"].includes(productionCutover.status))&&!productionControl.control.emergencyLock&&(
              <div className="cutover-create">
                <label>Release ID<input value={cutoverReleaseId} onChange={(event)=>setCutoverReleaseId(event.target.value)} /></label>
                <label>切替予定<input type="datetime-local" value={cutoverWindowStart} onChange={(event)=>setCutoverWindowStart(event.target.value)} /></label>
                <button onClick={createCutover} disabled={cutoverBusy}>指揮盤を開始</button>
              </div>
            )}
            {productionCutover&&!["completed","cancelled","rollback_started"].includes(productionCutover.status)&&(
              <>
                <div className="cutover-meta"><span><strong>{productionCutover.releaseId}</strong>Release</span><span><strong>{productionCutover.gate?.phase??"preflight"}</strong>phase</span><span><strong>{productionCutover.gate?.elapsedMinutes??0}分</strong>T±経過</span><span><strong>{productionCutover.consecutiveHealthyObservations}/12</strong>連続正常</span></div>
                <div className="cutover-timeline">{productionCutover.timeline.map(point=><div className={(productionCutover.gate?.elapsedMinutes??-999)>=point.offsetMinutes?"done":""} key={point.key}><strong>{point.label}</strong><span>{point.objective}</span></div>)}</div>
                <div className="cutover-readiness">
                  <label className={productionCutover.readiness.signedApprovalReady?"checked auto":"auto"}><input type="checkbox" checked={productionCutover.readiness.signedApprovalReady} disabled/><span>署名付き本番承認（自動）</span></label>
                  {cutoverReadinessLabels.map(([key,label])=><label className={cutoverReadiness[key]?"checked":""} key={key}><input type="checkbox" checked={cutoverReadiness[key]} onChange={(event)=>setCutoverReadiness(current=>({...current,[key]:event.target.checked}))}/><span>{label}</span></label>)}
                </div>
                <label className="production-evidence">当日準備証跡（3件以上）<textarea value={cutoverReadinessEvidence} onChange={(event)=>setCutoverReadinessEvidence(event.target.value)} /></label>
                <button onClick={saveCutoverReadiness} disabled={cutoverBusy}>T−60/T−15準備を再判定</button>
                {productionControl.control.productionEnabled&&(
                  <div className="cutover-observation">
                    <div className="cutover-number-grid">
                      {([
                        ["authenticationAttempts","認証試行"],["authenticationFailures","認証失敗"],["callableRequests","Functions要求"],["callableFailures","Functions失敗"],
                        ["p95LatencyMs","p95 ms"],["sheetWriteFailures","スプシ失敗"],["notificationFailures","通知失敗"],["queueBacklog","queue滞留"],
                        ["smokeFailures","smoke失敗"],["dataMismatchCount","データ差異"],["criticalIncidentCount","重大障害"],["monitoringProbeFailures","監視probe失敗"],
                      ] as Array<[Exclude<keyof CutoverObservationInput,"evidenceRefs">,string]>).map(([key,label])=><label key={key}>{label}<input type="number" min="0" value={cutoverObservation[key]} onChange={(event)=>setCutoverObservation(current=>({...current,[key]:Math.max(0,Number(event.target.value)||0)}))}/></label>)}
                    </div>
                    <label className="production-evidence">観測証跡（2件以上）<textarea value={cutoverObservation.evidenceRefs.join("\n")} onChange={(event)=>setCutoverObservation(current=>({...current,evidenceRefs:event.target.value.split("\n")}))}/></label>
                    <button onClick={recordCutoverObservation} disabled={cutoverBusy}>観測記録・自動判定</button>
                  </div>
                )}
                {productionCutover.gate&&<div className="cutover-gate-checks">{productionCutover.gate.checks.map(check=><span className={check.passed?"passed":check.severity==="rollback"?"rollback":"blocked"} key={check.key}>{check.passed?"✓":check.severity==="rollback"?"↩":"!"} {check.label}</span>)}</div>}
                <div className="cutover-actions">
                  {productionCutover.gate?.action==="rollback_required"&&<button className="danger" onClick={startCutoverRollback} disabled={cutoverBusy}>全体停止・切戻し開始</button>}
                  {productionCutover.gate?.action==="complete"&&<button onClick={completeCutover} disabled={cutoverBusy}>T＋24h完了を固定</button>}
                  {!productionControl.control.productionEnabled&&<button className="ghost" onClick={cancelCutover} disabled={cutoverBusy}>有効化前に中止</button>}
                  <button className="ghost" onClick={()=>loadProductionCutoverStatus(productionCutover.runId)} disabled={cutoverBusy}>指揮盤を再読込</button>
                </div>
              </>
            )}
            {productionCutover&&["completed","cancelled","rollback_started"].includes(productionCutover.status)&&<p className={`cutover-final ${productionCutover.status}`}>{productionCutover.status==="completed"?"本番切替完了を固定済み":productionCutover.status==="rollback_started"?"全体停止ロック作動・切戻し進行中":"本番有効化前に中止済み"}</p>}
          </div>
        )}
        {productionControl?.environment === "production" && (
          <Suspense fallback={<div className="acceptance-rollback-console">本番リリース指揮盤を読込中…</div>}><ProductionAcceptanceRollbackConsole onDownloadSetup={downloadProductionSetupTemplate} onCopySetup={copyProductionSetupCommand} onReloadReadiness={loadProductionDeploymentReadiness} readinessBusy={deploymentReadinessBusy} onDownloadDeployApproval={downloadProductionDeployApprovalTemplate} onCopyDeployCommands={copyProductionDeployCommands} onDownloadRequest={downloadProductionRollbackRequestTemplate} onCopyCommands={copyProductionAcceptanceRollbackCommands} evidenceStatus={productionEvidenceStatus} evidenceBusy={productionEvidenceBusy} live={firebaseConfigured} onImportEvidence={importProductionEvidencePackage} onRefreshEvidence={loadProductionReleaseEvidenceStatus} firebaseFunctions={functions} onEvidenceStatusChange={setProductionEvidenceStatus} onEvidenceBusyChange={setProductionEvidenceBusy} onMessage={setMessage}/></Suspense>
        )}
        {productionControl?.environment === "production" && (
          <div className="slo-panel">
            <div className="slo-head">
              <div><strong>本番SLO・自動インシデント管理</strong><small>30日エラーバジェットと1h・6h・24hバーンレートを5分間隔で再判定します。</small></div>
              <span className={`slo-health ${productionSlo?.snapshot?.evaluation?.health??"unobserved"}`}>{productionSlo?.snapshot?.evaluation?.severity??productionSlo?.snapshot?.evaluation?.health?.toUpperCase()??"未観測"}</span>
            </div>
            <div className="telemetry-panel">
              <div className="telemetry-head"><div><strong>Cloud Monitoring 実測生成・自動取込</strong><small>認証・Functions・スプシ・通知・queueから13指標を生成し、SLO・エラーバジェット・インシデントへ直結します。</small></div><span className={`telemetry-state ${telemetryStatus?.lastExportError||telemetryStatus?.lastError?"collection_error":telemetryStatus?.exporterStatus==="publishing"&&telemetryStatus?.status==="collecting"?"collecting":telemetryStatus?.status??"unconfigured"}`}>{telemetryStatus?.exporterStatus==="publishing"&&telemetryStatus?.status==="collecting"?"GENERATE → SLO":telemetryStatus?.lastExportError||telemetryStatus?.lastError?"ERROR":telemetryStatus?.status==="verified"?"VERIFIED":"未設定"}</span></div>
              <div className="telemetry-summary"><span><strong>{telemetryStatus?.projectId||"—"}</strong>Project</span><span><strong>{telemetryStatus?.enabled?"ON":"OFF"}</strong>自動生成</span><span><strong>{telemetryStatus?.lastExportedAt?new Date(telemetryStatus.lastExportedAt).toLocaleString("ja-JP"):"—"}</strong>最終生成</span><span><strong>{telemetryStatus?.lastCollectedAt?new Date(telemetryStatus.lastCollectedAt).toLocaleString("ja-JP"):"—"}</strong>最終取込</span><span><strong>{telemetryStatus?.lastObservationId?"13/13":"0/13"}</strong>企業分離指標</span></div>
              {(telemetryStatus?.lastExportError||telemetryStatus?.lastError)&&<p className="telemetry-error">{telemetryStatus.lastExportError||telemetryStatus.lastError}</p>}
              <details className="telemetry-config">
                <summary>監視接続設定</summary>
                <div className="telemetry-project"><label>Cloud Project ID<input value={telemetryProjectId} disabled={!firebaseConfigured||telemetryBusy} onChange={event=>setTelemetryProjectId(event.target.value)}/></label><label className="telemetry-toggle"><input type="checkbox" checked={telemetryEnabled} disabled={!firebaseConfigured||telemetryBusy} onChange={event=>setTelemetryEnabled(event.target.checked)}/><span>5分ごとの自動取込</span></label></div>
                <div className="telemetry-metrics">{sloObservationFields.map(([key,label])=><label key={key}>{label}<input value={telemetryMetrics[key]} disabled={!firebaseConfigured||telemetryBusy} onChange={event=>setTelemetryMetrics(current=>({...current,[key]:event.target.value}))}/></label>)}</div>
                <div className="telemetry-actions"><button className="ghost" onClick={saveTelemetryConfig} disabled={telemetryBusy}>設定を保存</button><button onClick={publishTelemetryMetricsNow} disabled={telemetryBusy||!telemetryStatus?.enabled}>実測から13指標を生成</button><button className="ghost" onClick={probeTelemetry} disabled={telemetryBusy||!telemetryStatus?.configured}>企業分離を接続テスト</button><button className="ghost" onClick={collectTelemetryNow} disabled={telemetryBusy||!telemetryStatus?.enabled}>SLOへ今すぐ取込</button></div>
                {!firebaseConfigured&&<small className="demo-safe-note">デモ表示のため入力はロックされています。実環境ではProject IDとMetric typeを保存して接続テストします。</small>}
              </details>
            </div>
            {productionSlo?.snapshot?.evaluation&&(
              <>
                <div className="slo-summary">
                  <span><strong>{productionSlo.snapshot.evaluation.windowResults.find(item=>item.windowMinutes===43200)?.availabilityPercent??100}%</strong>30日可用性</span>
                  <span><strong>{productionSlo.snapshot.evaluation.errorBudgetRemainingPercent}%</strong>残エラーバジェット</span>
                  <span><strong>{productionSlo.snapshot.evaluation.observationAgeMinutes??"—"}分</strong>最終観測経過</span>
                  <span><strong>{productionSlo.snapshot.releaseId||"—"}</strong>監視Release</span>
                </div>
                <div className="slo-windows">
                  {productionSlo.snapshot.evaluation.windowResults.map(windowResult=><article key={windowResult.windowMinutes}><strong>{windowResult.windowMinutes===60?"1h":windowResult.windowMinutes===360?"6h":windowResult.windowMinutes===1440?"24h":"30d"}</strong><span>可用性 {windowResult.availabilityPercent}%</span><span>Burn ×{windowResult.burnRate}</span><small>{windowResult.failedRequests}/{windowResult.totalRequests} failure</small></article>)}
                </div>
                <div className="slo-signals">{productionSlo.snapshot.evaluation.signals.map(signal=><span className={signal.passed?"passed":`failed ${signal.severity?.toLowerCase()??""}`} key={signal.key}>{signal.passed?"✓":"!"} {signal.label}</span>)}</div>
              </>
            )}
            <details className="slo-policy" open={!productionSlo?.snapshot}>
              <summary>SLO基準</summary>
              <div className="slo-policy-grid">{sloPolicyFields.map(([key,label,step])=><label key={key}>{label}<input type="number" step={step} min="0" value={sloPolicy[key]} disabled={sloBusy||Boolean(productionSlo?.openIncident)} onChange={(event)=>setSloPolicy(current=>({...current,[key]:Number(event.target.value)||0}))}/></label>)}</div>
              <button className="ghost" onClick={saveSloPolicy} disabled={sloBusy||Boolean(productionSlo?.openIncident)}>SLO基準を保存</button>
              {productionSlo?.openIncident&&<small className="slo-policy-lock">インシデント中は基準変更を禁止しています。</small>}
            </details>
            {productionControl.control.activeApprovalPackageId&&(
              <div className="slo-observation">
                <strong>本番観測を集計</strong>
                <div className="slo-number-grid">{sloObservationFields.map(([key,label])=><label key={key}>{label}<input type="number" min="0" value={sloObservation[key]} onChange={(event)=>setSloObservation(current=>({...current,[key]:Math.max(0,Number(event.target.value)||0)}))}/></label>)}</div>
                <label className="production-evidence">観測証跡（2件以上）<textarea value={sloObservation.evidenceRefs.join("\n")} onChange={(event)=>setSloObservation(current=>({...current,evidenceRefs:event.target.value.split("\n")}))}/></label>
                <button onClick={recordSloObservation} disabled={sloBusy}>観測・SLO・インシデントを自動判定</button>
              </div>
            )}
            {productionSlo?.openIncident&&(
              <div className={`incident-box ${productionSlo.openIncident.currentSeverity.toLowerCase()}`}>
                <div className="incident-title"><div><strong>{productionSlo.openIncident.incidentNumber} / {productionSlo.openIncident.currentSeverity}</strong><span>{productionSlo.openIncident.title}</span></div><span>{productionSlo.openIncident.status}</span></div>
                <div className="incident-metrics"><span>最高 {productionSlo.openIncident.highestSeverity}</span><span>更新 {productionSlo.openIncident.updateCount}回</span><span>正常 {productionSlo.openIncident.recoveryHealthyRuns}/{sloPolicy.requiredHealthyRunsForRecovery}</span><span>担当 {productionSlo.openIncident.ownerName||"未割当"}</span></div>
                {!productionSlo.openIncident.acknowledgedAt&&<div className="incident-ack"><input value={incidentOwner} onChange={(event)=>setIncidentOwner(event.target.value)} placeholder="担当者名"/><textarea value={incidentNote} onChange={(event)=>setIncidentNote(event.target.value)} placeholder="初動メモ（10文字以上）"/><button onClick={acknowledgeIncident} disabled={sloBusy}>担当・初動を固定</button></div>}
                {productionSlo.openIncident.status==="recovery_pending"&&<div className="incident-resolution"><label>原因<textarea value={incidentRootCause} onChange={(event)=>setIncidentRootCause(event.target.value)} placeholder="20文字以上"/></label><label>復旧内容<textarea value={incidentResolution} onChange={(event)=>setIncidentResolution(event.target.value)} placeholder="20文字以上"/></label><label>再発防止<textarea value={incidentPrevention} onChange={(event)=>setIncidentPrevention(event.target.value)} placeholder="20文字以上"/></label><label>解決証跡（2件以上）<textarea value={incidentEvidence} onChange={(event)=>setIncidentEvidence(event.target.value)}/></label><button onClick={resolveIncident} disabled={sloBusy}>インシデント解決を固定</button></div>}
              </div>
            )}
            {!!productionSlo?.recentIncidents.length&&<div className="incident-history"><strong>直近インシデント</strong>{productionSlo.recentIncidents.slice(0,5).map(incident=><span key={incident.incidentId}><b>{incident.incidentNumber}</b>{incident.highestSeverity} / {incident.status}</span>)}</div>}
            <div className="slo-actions"><button className="ghost" onClick={loadProductionSloDashboard} disabled={sloBusy}>SLOを再読込</button><small>SEV1・SEV2は夜間も即時Push、正常3回で復旧確認へ移行</small></div>
          </div>
        )}
        {productionControl?.environment === "production" && deploymentReadiness&&(
          <div className={`deployment-readiness-panel ${deploymentReadiness.ready?"ready":"blocked"}`}>
            <div className="deployment-readiness-head">
              <div><strong>本番運用・デプロイ自動診断</strong><small>実行環境、承認Release、13指標、企業分離、生成・取込鮮度を一括検査します。</small></div>
              <span>{deploymentReadiness.ready?"15/15 READY":`${deploymentReadiness.blockers.length} BLOCKED`}</span>
            </div>
            <div className="deployment-readiness-summary"><span><strong>{deploymentReadiness.environment}</strong>環境</span><span><strong>{deploymentReadiness.runtimeProjectId||"—"}</strong>実行Project</span><span><strong>{deploymentReadiness.exportAgeMinutes??"—"}分</strong>指標生成経過</span><span><strong>{deploymentReadiness.collectAgeMinutes??"—"}分</strong>SLO取込経過</span><span><strong>{deploymentReadiness.releaseApprovalPackageId||"—"}</strong>承認Package</span></div>
            <div className="deployment-readiness-checks">{deploymentReadiness.checks.map(check=><span className={check.passed?"passed":"failed"} key={check.key}>{check.passed?"✓":"!"} {check.label}<small>{String(check.actual)} / {check.required}</small></span>)}</div>
            <div className="deployment-readiness-actions"><button className="ghost" onClick={loadProductionDeploymentReadiness} disabled={deploymentReadinessBusy}>{deploymentReadinessBusy?"診断中…":"12項目を再診断"}</button><small>fingerprint {deploymentReadiness.fingerprint.slice(0,12)}</small></div>
          </div>
        )}
        <div className="kill-switch-box">
          <div><strong>全体停止スイッチ</strong><small>本番処理・通知・スプシ書込・招待を停止。作動後はアプリから解除できません。</small></div>
          <textarea value={productionKillReason} onChange={(event)=>setProductionKillReason(event.target.value)} placeholder="停止理由（10文字以上）" disabled={productionControl?.control.emergencyLock} />
          <button className="danger kill-switch" onClick={activateKillSwitch} disabled={productionBusy||productionControl?.control.emergencyLock}>全体停止を作動</button>
        </div>
        <div className="production-actions"><button className="ghost" onClick={loadProductionControlStatus} disabled={productionBusy}>状態を再読込</button><small>環境：{productionControl?.environment??"demo"} / generation {productionControl?.control.generation??0}</small></div>
      </section>
      <section className="panel push-panel">
        <div className="sync-head">
          <div>
            <h2>管理者プッシュ通知</h2>
            <p>応募、遅延、未提出、再提出、送信エラーをこの端末で受け取ります。</p>
          </div>
          <span className={pushEnabled ? "push-status enabled" : "push-status"}>
            {pushEnabled ? "通知ON" : currentPushPermission() === "denied" ? "端末で拒否中" : "通知OFF"}
          </span>
        </div>
        <div className="sync-actions">
          {!pushEnabled ? (
            <button onClick={enablePush} disabled={pushBusy}>通知を有効にする</button>
          ) : (
            <>
              <button className="ghost" onClick={testPush}>通知テスト</button>
              <button className="ghost" onClick={disablePush} disabled={pushBusy}>この端末の通知をOFF</button>
            </>
          )}
        </div>
      </section>

<section className="panel pilot-panel">
  <div className="sync-head">
    <div>
      <h2>本番導入チェック</h2>
      <p>設定を一気にONにせず、読取・案件ID・数式・入力規則・行追加を順番に確認します。</p>
    </div>
    <span className={pilotReadiness.ready ? "pilot-status ready" : "pilot-status"}>
      {pilotReadiness.ready ? "導入可能" : "検証中"}
    </span>
  </div>
  <div className="pilot-progress">
    <div style={{width:`${pilotReadiness.checks.length ? Math.round(pilotReadiness.checks.filter((check)=>check.ok).length / pilotReadiness.checks.length * 100) : 0}%`}} />
  </div>
  <div className="pilot-checks">
    {pilotReadiness.checks.map((check)=>(
      <article key={check.key} className={check.ok ? "pilot-ok" : "pilot-wait"}>
        <span>{check.ok ? "✓" : "…"}</span>
        <strong>{check.label}</strong>
      </article>
    ))}
    {!pilotReadiness.checks.length && <div className="empty-inline">チェック状態を読み込んでください。</div>}
  </div>
  <div className="pilot-actions">
    <label>検査する月
      <input type="date" value={jobForm.workDate} onChange={(event)=>updateJobForm("workDate",event.target.value)} />
    </label>
    <label>追加予定行
      <input type="number" min="1" max="20" value={jobForm.slots} onChange={(event)=>updateJobForm("slots",event.target.value)} />
    </label>
    <button className="ghost" onClick={loadPilotReadiness} disabled={pilotBusy}>
      状態を更新
    </button>
    <button onClick={previewRowCreation} disabled={pilotBusy}>
      {pilotBusy ? "検査中…" : "行追加を事前検査"}
    </button>
  </div>
  {pilotPreview && (
    <div className={pilotPreview.ready ? "pilot-preview passed" : "pilot-preview failed"}>
      <strong>{pilotPreview.ready ? "事前検査 合格" : "事前検査 要確認"}</strong>
      <div>
        {pilotPreview.sheetName}タブ / 雛形行 {pilotPreview.templateRow} /
        追加予定 {pilotPreview.insertedRows[0]}～{pilotPreview.insertedRows[pilotPreview.insertedRows.length-1]}行
      </div>
      {!!pilotPreview.formulaColumns.length && <small>数式検査：{pilotPreview.formulaColumns.join("・")}</small>}
      {pilotPreview.errors.map((error)=><p key={error} className="pilot-error">{error}</p>)}
      {pilotPreview.warnings.map((warning)=><p key={warning} className="pilot-warning">{warning}</p>)}
    </div>
  )}
  {(pilotReadiness.blockedCount>0 || pilotReadiness.deadLetterCount>0) && (
    <div className="locked-note">
      停止中 {pilotReadiness.blockedCount}件 / 手動確認 {pilotReadiness.deadLetterCount}件。
      本番ONの前にすべて解消してください。
    </div>
  )}
</section>

      <section className="panel analytics-panel">
        <div className="section-heading">
          <div>
            <h2>経営ダッシュボード</h2>
            <p>総依頼・実施・予定・キャンセルと、シフト表の請求・支払から概算粗利を集計します。</p>
          </div>
          <div className="month-controls">
            <input type="month" value={dashboardMonth} onChange={(event)=>setDashboardMonth(event.target.value)} />
            <button className="ghost" onClick={()=>loadDashboard(dashboardMonth)} disabled={dashboardBusy}>{dashboardBusy?"集計中…":"再集計"}</button>
          </div>
        </div>
        <div className="analytics-counts">
          <article><small>総案件</small><strong>{monthly.counts.totalRequests}件</strong></article>
          <article><small>実施</small><strong>{monthly.counts.implemented}件</strong></article>
          <article><small>今後予定</small><strong>{monthly.counts.scheduled}件</strong></article>
          <article><small>キャンセル</small><strong>{monthly.counts.cancelled}件</strong></article>
          <article><small>実施率</small><strong>{percent(monthly.counts.executionRate)}</strong></article>
        </div>
        <div className="finance-cards">
          <article><small>請求概算</small><strong>{yen(monthly.finance.bookedInvoice)}</strong></article>
          <article><small>支払概算</small><strong>{yen(monthly.finance.bookedPayment)}</strong></article>
          <article><small>粗利概算</small><strong>{yen(monthly.finance.bookedGrossProfit)}</strong></article>
          <article><small>粗利率</small><strong>{percent(monthly.finance.bookedGrossMargin)}</strong></article>
        </div>
        <div className="analytics-split">
          <div>
            <h3>キャンセル理由</h3>
            <div className="rank-list">
              {monthly.cancellationReasons.map((item)=><div key={item.name}><span>{item.name}</span><strong>{item.count}件</strong></div>)}
              {!monthly.cancellationReasons.length && <div className="empty-inline">キャンセルはありません。</div>}
            </div>
          </div>
          <div>
            <h3>クライアント別</h3>
            <div className="mini-table-wrap">
              <table><thead><tr><th>クライアント</th><th>件数</th><th>請求</th><th>粗利</th><th>取消</th></tr></thead>
              <tbody>{monthly.clients.slice(0,8).map((item)=><tr key={item.name}><td>{item.name}</td><td>{item.count}</td><td>{yen(item.invoice)}</td><td>{yen(item.grossProfit)}</td><td>{item.cancelled}</td></tr>)}</tbody></table>
            </div>
          </div>
        </div>
        <p className="analytics-note">概算です。S～Z合計、AK～AN、AW～AYを請求側、ARまたはBBを支払側として集計し、税・源泉等は含みません。</p>
      </section>

      <section className="kpis">
        <article><small>今日の案件</small><strong>{jobs.length}件</strong></article>
        <article><small>事前連絡 未送信</small><strong>{unresolved}件</strong></article>
        <article><small>今月売上（概算）</small><strong>{yen(monthly.finance.bookedInvoice)}</strong></article>
        <article><small>粗利率（概算）</small><strong>{percent(monthly.finance.bookedGrossMargin)}</strong></article>
        <article><small>現役スタッフ</small><strong>{staff.filter((profile) => profile.active !== false).length}名</strong></article>
        <article><small>書込エラー</small><strong>{sheetIssues.length}件</strong></article>
      </section>

      <section className="panel issue-panel">
        <div className="sync-head">
          <div>
            <h2>スプシ書込エラー・競合</h2>
            <p>手入力との競合は上書きせず止め、一時エラーだけ再試行できます。</p>
          </div>
          <strong>{sheetIssues.length}件</strong>
        </div>
        <div className="sync-actions">
          <button className="ghost" onClick={loadSheetIssues} disabled={issuesBusy}>
            {issuesBusy ? "読込中…" : "再読込"}
          </button>
        </div>
        <div className="issue-list">
          {sheetIssues.map((issue)=>(
            <article key={issue.id} className={issue.errorType==="conflict"?"conflict-issue":""}>
              <div>
                <strong>{issue.job?.workDate} {issue.job?.storeName} {issue.job?.assignedStaffName}</strong>
                <small>{issue.operation} / {issue.errorMessage}</small>
              </div>
              <div className="row-actions">
                {issue.canRetry && <button className="ghost compact" onClick={()=>retrySheetIssue(issue)}>再試行</button>}
                <button className="ghost compact" onClick={()=>acknowledgeSheetIssue(issue)}>確認済み</button>
              </div>
            </article>
          ))}
          {!sheetIssues.length && <div className="empty-inline">書込エラーはありません。</div>}
        </div>
      </section>

      <section className="panel sync-panel">
        <div className="sync-head">
          <div>
            <h2>スプシ同期</h2>
            <p>月別タブを読取専用で確認し、元スプシを変更せずアプリ用データへ同期します。</p>
          </div>
          <strong>{syncSummary}</strong>
        </div>
        <div className="sync-actions">
          <button className="ghost" onClick={previewSheetSync} disabled={syncBusy}>
            {syncBusy ? "処理中…" : "プレビュー"}
          </button>
          <button onClick={runSheetSync} disabled={syncBusy}>
            Firestoreへ同期
          </button>
        </div>
      </section>

      <section className="panel sync-panel">
        <div className="sync-head">
          <div>
            <h2>スタッフ名簿同期</h2>
            <p>マスタ・東北だけを読み、同じ氏名の複数メールを同一アカウントへまとめます。抹消タブは参照しません。</p>
          </div>
          <strong>{staffSyncSummary}</strong>
        </div>
        <div className="sync-actions">
          <button className="ghost" onClick={previewStaffSync} disabled={staffSyncBusy}>
            {staffSyncBusy ? "処理中…" : "プレビュー"}
          </button>
          <button onClick={runStaffSync} disabled={staffSyncBusy}>
            スタッフ名簿を同期
          </button>
        </div>
      </section>


<section className="panel job-create-panel">
  <div className="section-heading">
    <div>
      <h2>案件を追加</h2>
      <p>同じ内容を募集人数分だけ作成します。スプシ新規行の安全処理が未有効の場合は、自動で下書き保存します。</p>
    </div>
    <strong>{jobForm.slots}名分</strong>
  </div>
  <div className="job-form-grid">
    <label>実施日<input type="date" value={jobForm.workDate} onChange={(e)=>updateJobForm("workDate",e.target.value)} /></label>
    <label>クライアント<input value={jobForm.clientName} onChange={(e)=>updateJobForm("clientName",e.target.value)} /></label>
    <label>店舗<input value={jobForm.storeName} onChange={(e)=>updateJobForm("storeName",e.target.value)} /></label>
    <Suspense fallback={null}><StoreLocationFields
      address={jobForm.storeAddress}
      nearestStation={jobForm.storeNearestStation}
      onAddressChange={(value)=>updateJobForm("storeAddress",value)}
      onNearestStationChange={(value)=>updateJobForm("storeNearestStation",value)}
    /></Suspense>
    <label>メーカー<input value={jobForm.makerName} onChange={(e)=>updateJobForm("makerName",e.target.value)} /></label>
    <label>メニュー<input value={jobForm.menuName} onChange={(e)=>updateJobForm("menuName",e.target.value)} /></label>
    <label>入店時間<input value={jobForm.entryTime} onChange={(e)=>updateJobForm("entryTime",e.target.value)} /></label>
    <label>実施時間<input value={jobForm.workTime} onChange={(e)=>updateJobForm("workTime",e.target.value)} /></label>
    <label>外注名<input value={jobForm.subcontractorName} onChange={(e)=>updateJobForm("subcontractorName",e.target.value)} /></label>
    <label>募集人数<input type="number" min="1" max="20" value={jobForm.slots} onChange={(e)=>updateJobForm("slots",e.target.value)} /></label>
    <label>基本単価<input inputMode="numeric" value={jobForm.basePay} onChange={(e)=>updateJobForm("basePay",e.target.value)} /></label>
    <label>公開方法<select value={jobForm.publicationMode} onChange={(e)=>updateJobForm("publicationMode",e.target.value as JobForm["publicationMode"])}><option value="draft">下書き</option><option value="immediate">すぐ募集</option><option value="scheduled">公開予約</option></select></label>
    {jobForm.publicationMode==="scheduled" && <label>公開日時<input type="datetime-local" value={jobForm.publishAt} onChange={(e)=>updateJobForm("publishAt",e.target.value)} /></label>}
  </div>
  <div className="locked-note">📍 住所と最寄駅はアプリで管理し、スタッフ画面の地図・公共交通経路に自動反映します。
  </div>
  <div className="sync-actions"><button onClick={createJobGroup} disabled={jobCreateBusy}>{jobCreateBusy?"作成中…":"案件を作成"}</button></div>
</section>

<section className="panel export-panel">
  <div className="section-heading">
    <div><h2>メーカー・クライアント別資料</h2><p>期間と対象を選び、案件・請求・支払・粗利のCSVを出力します。</p></div>
  </div>
  <div className="export-controls">
    <label>開始<input type="date" value={exportFrom} onChange={(e)=>setExportFrom(e.target.value)} /></label>
    <label>終了<input type="date" value={exportThrough} onChange={(e)=>setExportThrough(e.target.value)} /></label>
    <label>分類<select value={exportGroupBy} onChange={(e)=>setExportGroupBy(e.target.value as "client"|"maker")}><option value="client">クライアント</option><option value="maker">メーカー</option></select></label>
    <label>対象名<input value={exportName} onChange={(e)=>setExportName(e.target.value)} placeholder="空欄なら全件" /></label>
    <label className="check-line"><input type="checkbox" checked={exportIncludeCancelled} onChange={(e)=>setExportIncludeCancelled(e.target.checked)} />キャンセルを含む</label>
    <button onClick={exportJobs} disabled={exportBusy}>{exportBusy?"作成中…":"CSVを出力"}</button>
  </div>
</section>

      <section className="panel">
        <div className="toolbar">
          <input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="スタッフ名・店舗・メーカー・クライアントを検索" />
          <button onClick={() => setMessage(`${filtered.length}件見つかりました。`)}>検索</button>
        </div>
        <h2>案件一覧</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>日付</th><th>スタッフ</th><th>店舗</th><th>メーカー</th><th>状態</th><th>公開</th><th>操作</th></tr></thead>
            <tbody>
              {filtered.map((job) => (
                <tr key={job.id} className={job.status === "cancelled" ? "cancelled" : ""}>
                  <td>{job.workDate}</td>
                  <td>{job.assignedStaffName ?? "募集中"}</td>
                  <td>{job.storeName}</td>
                  <td>{job.makerName}</td>
                  <td>{job.status === "cancelled" ? "キャンセル" : job.status==="draft"?"下書き":job.status==="scheduled"?"公開予約":job.status==="stopped"?"募集停止":job.preContact ? "正常" : "事前連絡待ち"}</td>
                  <td>{job.publishable ? <span className="mini-tag">募集中</span> : <span className="mini-tag muted-tag">非公開</span>}</td>
                  <td className="row-actions">
                    <button className="ghost compact" onClick={()=>loadJobEdit(job)}>編集</button>
                    <button className="ghost compact" onClick={()=>duplicateJob(job)}>複製</button>
                    {job.status!=="cancelled" && !job.assignedStaffId && (
                      job.publishable
                        ? <button className="ghost compact" onClick={()=>changePublication(job,"stop")}>募集停止</button>
                        : <button className="ghost compact" onClick={()=>changePublication(job,"publish")}>募集開始</button>
                    )}
                    {job.status==="assigned" && !job.applicationAdminConfirmed && <button className="ghost compact" onClick={()=>confirmJobApplication(job)}>応募確認</button>}
                    {job.applicationAdminConfirmed && <span className="mini-tag">確認済み</span>}
                    <button className="ghost compact" onClick={()=>loadExpenseReview(job.id)}>経費</button>
                    <button className="ghost compact" onClick={()=>openJobSheet(job)}>スプシ</button>
                    {job.status === "cancelled" ? (
                      <button className="ghost compact" onClick={() => restoreCancellation(job)} disabled={cancellationBusy}>復帰</button>
                    ) : (
                      <button className="danger compact" onClick={() => prepareCancellation(job)}>取消</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>


<Suspense fallback={null}><JobSafeEditPanel
  jobs={jobs}
  staff={staff}
  jobEditId={jobEditId}
  revision={jobEditRevision}
  values={jobEdit}
  busy={jobEditBusy}
  invoiceLabels={invoiceLabels}
  staffPayLabels={staffPayLabels}
  onSelectJob={(jobId)=>{const job=jobs.find((item)=>item.id===jobId);if(job)loadJobEdit(job);}}
  onUpdate={(key,value)=>updateJobEdit(key as keyof JobEditForm,value)}
  onSave={saveJobEdit}
/></Suspense>

      <section className="panel cancellation-panel" id="cancellation-management">
        <div className="section-heading">
          <div>
            <h2>案件キャンセル管理</h2>
            <p>行を削除せず、理由・請求・スタッフ支払の扱いを残します。解除時は同日重複を再確認します。</p>
          </div>
          <span className="mini-tag">キャンセル {jobs.filter((job)=>job.status==="cancelled").length}件</span>
        </div>
        <div className="cancellation-grid">
          <label>対象案件
            <select value={cancellationJobId} onChange={(event)=>setCancellationJobId(event.target.value)}>
              {jobs.filter((job)=>job.status!=="cancelled").map((job)=><option value={job.id} key={job.id}>{job.workDate} {job.storeName} {job.assignedStaffName ?? "募集中"}</option>)}
            </select>
          </label>
          <label>キャンセル理由
            <select value={cancellationReasonCategory} onChange={(event)=>setCancellationReasonCategory(event.target.value)}>
              <option value="maker">メーカー都合</option>
              <option value="client">クライアント都合</option>
              <option value="already_staffed">他社で手配済み</option>
              <option value="store">店舗都合</option>
              <option value="weather">天候・災害</option>
              <option value="other">その他</option>
            </select>
          </label>
          <label>金銭処理
            <select value={cancellationTreatment} onChange={(event)=>setCancellationTreatment(event.target.value)}>
              <option value="invoice_and_pay">請求あり・支払あり</option>
              <option value="invoice_only">請求あり・支払なし</option>
              <option value="pay_only">請求なし・支払あり</option>
              <option value="neither">請求なし・支払なし</option>
            </select>
          </label>
          <label className="cancellation-note">補足
            <textarea value={cancellationNote} onChange={(event)=>setCancellationNote(event.target.value)} placeholder="必要な場合だけ入力" />
          </label>
        </div>
        {cancellationTarget && <div className="cancellation-preview"><strong>{cancellationTarget.workDate} {cancellationTarget.storeName}</strong><span>{cancellationTarget.assignedStaffName ?? "未手配"}</span></div>}
        <div className="sync-actions">
          <button className="danger" onClick={submitCancellation} disabled={cancellationBusy || !cancellationJobId}>キャンセルとして記録</button>
        </div>
        {!!jobs.filter((job)=>job.status==="cancelled").length && (
          <div className="cancelled-list">
            {jobs.filter((job)=>job.status==="cancelled").map((job)=><article key={job.id}>
              <div><strong>{job.workDate} {job.storeName}</strong><small>{job.cancellationReason || "キャンセル"} / {job.assignedStaffName || "未手配"}</small></div>
              <button className="ghost compact" onClick={()=>restoreCancellation(job)} disabled={cancellationBusy}>キャンセル解除</button>
            </article>)}
          </div>
        )}
      </section>

      <section className="panel expense-panel">
        <div className="section-heading">
          <div>
            <h2>報告書確認・経費入力</h2>
            <p>画像を見ながら一時保存し、確認完了時だけ安全なスプシ書込キューへ送ります。</p>
          </div>
          <span className="mini-tag">{expenseStatus}</span>
        </div>
        <div className="expense-select">
          <select value={expenseJobId} onChange={(event)=>loadExpenseReview(event.target.value)}>
            {jobs.map((job)=><option value={job.id} key={job.id}>{job.workDate} {job.storeName} {job.assignedStaffName ?? "募集中"}</option>)}
          </select>
          <button className="ghost" onClick={()=>loadExpenseReview(expenseJobId)} disabled={expenseBusy}>読込</button>
        </div>
        <div className="expense-grid">
          {[
            ["transportation","交通費"],
            ["purchase8","8％買取"],
            ["purchase10","10％買取"],
            ["netPrintCost","ネットプリント"],
            ["postageCost","切手・速達・レターパック"],
          ].map(([key,label])=>(
            <label key={key}>{label}
              <input
                inputMode="numeric"
                value={expenseValues[key as keyof ExpenseValues]}
                onChange={(event)=>setExpenseValues((current)=>({...current,[key]:event.target.value}))}
                placeholder="0"
              />
            </label>
          ))}
        </div>
        <label className="expense-note">確認メモ
          <textarea value={expenseNote} onChange={(event)=>setExpenseNote(event.target.value)} placeholder="途中メモや確認内容"/>
        </label>
        <div className="sync-actions">
          <button className="ghost" onClick={saveExpenseDraft} disabled={expenseBusy}>一時保存</button>
          <button onClick={completeExpense} disabled={expenseBusy}>確認完了・書込待ちへ</button>
          <button className="ghost" onClick={()=>{const job=jobs.find((item)=>item.id===expenseJobId);if(job)openJobSheet(job);}}>スプシ該当行</button>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>案件の資料・再提出</h2>
            <p>ネットプリント最大3件と、報告書・売場画像の再提出依頼を管理します。</p>
          </div>
          <select value={selectedAdminJobId} onChange={(event) => selectAdminJob(event.target.value)}>
            {jobs.map((job) => <option value={job.id} key={job.id}>{job.workDate} {job.storeName} {job.assignedStaffName ?? "募集中"}</option>)}
          </select>
        </div>
        <h3>ネットプリント番号</h3>
        <div className="netprint-inputs">
          {netPrintNumbers.map((value, index) => (
            <input key={index} value={value} onChange={(event) => setNetPrintNumbers((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder={`番号${index + 1}`} />
          ))}
          <button onClick={saveNetPrint}>保存・通知</button>
        </div>
        <hr />
        <h3>提出ファイルから再送対象を選択</h3>
        <div className="timeline-toolbar">
          <span>{resubmitType === "report" ? "報告書" : "売場画像"} / {submissionTimeline.reduce((sum,group)=>sum+group.files.length,0)}件</span>
          <button className="ghost compact" onClick={loadSubmissionTimeline} disabled={timelineBusy}>{timelineBusy ? "読込中…" : "再読込"}</button>
        </div>
        <div className="file-gallery">
          {submissionTimeline.flatMap((group)=>group.files).map((file)=>(
            <button type="button" className={`file-card ${selectedSourceFile?.id===file.id ? "selected" : ""}`} key={`${file.submissionId}_${file.id}`} onClick={()=>setSelectedSourceFile(file)}>
              {file.previewUrl && file.contentType.startsWith("image/") ? <img src={file.previewUrl} alt={file.driveName || file.originalName} /> : <div className="pdf-preview">{file.contentType.includes("pdf") ? "PDF" : "FILE"}</div>}
              <strong>{file.driveName || file.originalName}</strong>
              <small>{file.sequence ? `(${file.sequence})` : ""} {file.purpose}</small>
            </button>
          ))}
          {!submissionTimeline.length && <div className="empty-inline">提出済みファイルはありません。画像を指定せず案件全体への依頼もできます。</div>}
        </div>
        {selectedSourceFile && <div className="selected-file-note">選択中：{selectedSourceFile.driveName || selectedSourceFile.originalName} <button className="ghost compact" onClick={()=>setSelectedSourceFile(null)}>選択解除</button></div>}
        <h3>再提出理由</h3>
        <div className="resubmit-options">
          <select value={resubmitType} onChange={(event) => { setResubmitType(event.target.value as "report" | "sales_floor"); setSelectedSourceFile(null); }}>
            <option value="report">報告書</option><option value="sales_floor">売場画像</option>
          </select>
          {["手ブレで文字が読めません","画像が暗い・反射しています","一部が切れています","レシート全体が写っていません","金額・日付が確認できません","その他"].map((reason) => (
            <label className="reason-check" key={reason}><input type="checkbox" checked={resubmitReasons.includes(reason)} onChange={() => toggleReason(reason)} />{reason}</label>
          ))}
        </div>
        <textarea value={resubmitNote} onChange={(event) => setResubmitNote(event.target.value)} placeholder="必要なら補足を入力" />
        <button onClick={createResubmission}>{selectedSourceFile ? "この画像の再送を依頼する" : "案件全体へ再提出を依頼する"}</button>
        <div className="resubmit-list">
          {resubmissions.map((item) => (
            <div className="resubmit-row" key={item.id}>
              <div><strong>{item.type === "report" ? "報告書" : "売場画像"}</strong><small>{item.reasons.join(" / ")} {item.note ?? ""}</small></div>
              <span>{item.status === "open" ? "対応待ち" : item.status === "submitted" ? "確認待ち" : "完了"}</span>
              <div className="row-actions">
                {item.status === "submitted" && <button className="ghost compact" onClick={() => openComparison(item.id)}>旧・新を比較</button>}
                {item.status === "submitted" && <button className="ghost compact" onClick={() => completeResubmission(item.id)}>確認完了</button>}
              </div>
            </div>
          ))}
        </div>
        {comparison && (
          <div className="comparison-panel">
            <div className="comparison-head"><div><h3>再送画像の比較</h3><small>{comparison.request.reasons.join(" / ")}</small></div><button className="ghost compact" onClick={()=>setComparison(null)}>閉じる</button></div>
            <div className="comparison-grid">
              <figure><figcaption>元画像</figcaption>{comparison.source?.previewUrl ? <img src={comparison.source.previewUrl} alt="元画像" /> : <div className="pdf-preview">元画像なし</div>}<small>{comparison.source?.driveName ?? ""}</small></figure>
              <figure><figcaption>再送画像</figcaption>{comparison.replacements[0]?.previewUrl ? <img src={comparison.replacements[0].previewUrl!} alt="再送画像" /> : <div className="pdf-preview">再送待ち</div>}<small>{comparison.replacements[0]?.driveName ?? ""}</small></figure>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="sync-head">
          <div>
            <h2>未ログイン者への案内</h2>
            <p>今後30日以内にシフトがあり、まだ一度もログインしていない人だけを抽出します。</p>
          </div>
          <strong>{inviteCandidates.length}名 / 選択{selectedInviteIds.length}名</strong>
        </div>
        <div className="invite-form">
          <label>件名<input value={inviteSubject} onChange={(event) => setInviteSubject(event.target.value)} /></label>
          <label>追記<textarea value={inviteIntro} onChange={(event) => setInviteIntro(event.target.value)} /></label>
        </div>
        <div className="sync-actions">
          <button className="ghost" onClick={loadInviteCandidates} disabled={inviteBusy}>
            対象者を抽出
          </button>
          <button onClick={sendInvites} disabled={inviteBusy || selectedInviteIds.length === 0}>
            選択した人へ送信
          </button>
        </div>
        <div className="pilot-launch-box">
          <div>
            <strong>3〜5名パイロット配布＋自動監視</strong>
            <small>開始前に安全ゲートを再検査し、配布後は10項目を5分間隔で監視します。</small>
          </div>
          <label>Release ID
            <input value={pilotReleaseId} onChange={(event)=>setPilotReleaseId(event.target.value)} />
          </label>
          <label>期間（日）
            <input type="number" min="1" max="14" value={pilotDurationDays} onChange={(event)=>setPilotDurationDays(event.target.value)} />
          </label>
          <button
            onClick={startSelectedPilot}
            disabled={inviteBusy || selectedInviteIds.length < 3 || selectedInviteIds.length > 5 || pilotRolloutStatus?.status === "active"}
          >
            パイロット開始
          </button>
          {pilotRolloutStatus?.status === "active" && (
            <button className="danger" onClick={stopActivePilot} disabled={inviteBusy}>停止</button>
          )}
        </div>
        {pilotRolloutStatus && (
          <div className={`pilot-live-status ${pilotRolloutStatus.lastHealth?.action ?? pilotRolloutStatus.status}`}>
            <strong>
              {pilotRolloutStatus.status === "active"
                ? `監視 ${String(pilotRolloutStatus.lastHealth?.action ?? "waiting").toUpperCase()}`
                : `パイロット ${pilotRolloutStatus.status}`}
            </strong>
            <span>{pilotRolloutStatus.participantCount}名 / {pilotRolloutStatus.releaseId}</span>
            {!!pilotRolloutStatus.lastHealth?.alerts.length && (
              <small>{pilotRolloutStatus.lastHealth.alerts.map((alert)=>`${alert.label} ${alert.value}件`).join(" / ")}</small>
            )}
          </div>
        )}
        {pilotRolloutStatus && ["review_required","expansion_review_pending","expansion_blocked","expansion_rejected","expansion_approved"].includes(pilotRolloutStatus.status) && (
          <div className="pilot-expansion-panel">
            <div className="pilot-expansion-head">
              <div>
                <strong>30〜50名 移行承認ゲート</strong>
                <small>監視証跡を自動集計。提出者とは別の管理者だけが承認できます。</small>
              </div>
              <span className={`expansion-badge ${pilotExpansion?.review?.status ?? "unsubmitted"}`}>
                {pilotExpansion?.review?.status ?? "結果未提出"}
              </span>
            </div>
            {pilotExpansion?.automated && (
              <div className="pilot-expansion-metrics">
                <span><strong>{pilotExpansion.automated.participantCount}名</strong>参加者</span>
                <span><strong>{pilotExpansion.automated.durationDays}日</strong>実施</span>
                <span><strong>{pilotExpansion.automated.monitoringCoveragePct}%</strong>監視coverage</span>
                <span><strong>{pilotExpansion.automated.criticalAlertCount}件</strong>PAUSE</span>
                <span><strong>{pilotExpansion.automated.monitorFailureCount}件</strong>監視失敗</span>
              </div>
            )}
            {(!pilotExpansion?.review || ["blocked","rejected"].includes(pilotExpansion.review.status)) && (
              <>
                <div className="pilot-outcome-grid">
                  <label>検証案件数<input type="number" min="0" value={pilotOutcome.totalCases} onChange={(event)=>updatePilotOutcome("totalCases",event.target.value)} /></label>
                  <label>完了件数<input type="number" min="0" value={pilotOutcome.completedCases} onChange={(event)=>updatePilotOutcome("completedCases",event.target.value)} /></label>
                  <label>請求・給与差額（円）<input type="number" min="0" value={pilotOutcome.moneyDiffYen} onChange={(event)=>updatePilotOutcome("moneyDiffYen",event.target.value)} /></label>
                  <label>ダブルブッキング<input type="number" min="0" value={pilotOutcome.doubleBookings} onChange={(event)=>updatePilotOutcome("doubleBookings",event.target.value)} /></label>
                  <label>メール対象差異<input type="number" min="0" value={pilotOutcome.mailTargetDiff} onChange={(event)=>updatePilotOutcome("mailTargetDiff",event.target.value)} /></label>
                  <label>PDF差異<input type="number" min="0" value={pilotOutcome.pdfDiff} onChange={(event)=>updatePilotOutcome("pdfDiff",event.target.value)} /></label>
                  <label>手動確認キュー<input type="number" min="0" value={pilotOutcome.manualQueue} onChange={(event)=>updatePilotOutcome("manualQueue",event.target.value)} /></label>
                  <label>サポート問合せ<input type="number" min="0" value={pilotOutcome.supportCases} onChange={(event)=>updatePilotOutcome("supportCases",event.target.value)} /></label>
                  <label className="wide">証拠参照（改行またはカンマ区切り）<textarea value={pilotOutcome.evidenceRefs} onChange={(event)=>updatePilotOutcome("evidenceRefs",event.target.value)} /></label>
                  <label className="wide">備考<textarea value={pilotOutcome.notes} onChange={(event)=>updatePilotOutcome("notes",event.target.value)} /></label>
                </div>
                <button onClick={submitPilotOutcome} disabled={pilotExpansionBusy}>結果を確定して判定</button>
              </>
            )}
            {pilotExpansion?.review?.gate && (
              <div className="expansion-checks">
                {pilotExpansion.review.gate.checks.map((check)=>(
                  <span className={check.passed?"passed":check.blocking?"blocked":"warning"} key={check.key}>
                    {check.passed?"✓":"!"} {check.label}：{String(check.actual)} / {check.required}
                  </span>
                ))}
              </div>
            )}
            {pilotExpansion?.review?.status === "pending_approval" && (
              <div className="expansion-decision">
                <label>承認・否認理由<textarea value={pilotDecisionNote} onChange={(event)=>setPilotDecisionNote(event.target.value)} placeholder="確認内容と判断理由" /></label>
                <button onClick={()=>decidePilotExpansion("approve")} disabled={pilotExpansionBusy || !pilotExpansion.review?.currentAdminCanApprove}>別管理者として承認</button>
                <button className="danger" onClick={()=>decidePilotExpansion("reject")} disabled={pilotExpansionBusy || !pilotExpansion.review?.currentAdminCanApprove}>否認</button>
                {!pilotExpansion.review.currentAdminCanApprove && <small>結果を提出した管理者本人は承認できません。別の管理者でログインしてください。</small>}
              </div>
            )}
            {pilotExpansion?.review?.status === "approved" && <p className="expansion-approved">承認証跡を保存済み。30〜50名への配布はまだ実行されていません。</p>}
          </div>
        )}
        {(pilotRolloutStatus?.status === "expansion_approved" || stagedRollout) && (
          <div className="staged-rollout-panel">
            <div className="pilot-expansion-head">
              <div>
                <strong>30〜50名 3wave段階配布</strong>
                <small>各wave後に5分監視。観察時間と連続CONTINUEを満たすまで次waveはロックされます。</small>
              </div>
              <span className={`staged-badge ${stagedRollout?.status ?? "unprepared"}`}>{stagedRollout?.status ?? "未準備"}</span>
            </div>
            {!stagedRollout && (
              <div className="staged-prepare">
                <span>候補リストの選択：<strong>{selectedInviteIds.length}名</strong>（30〜50名）</span>
                <label>wave観察時間<input type="number" min="12" max="72" value={stagedObservationHours} onChange={(event)=>setStagedObservationHours(event.target.value)} /></label>
                <label>連続CONTINUE回数<input type="number" min="6" max="36" value={stagedContinueRuns} onChange={(event)=>setStagedContinueRuns(event.target.value)} /></label>
                <button onClick={createSelectedStagedRollout} disabled={stagedRolloutBusy||selectedInviteIds.length<30||selectedInviteIds.length>50}>3waveへ固定</button>
              </div>
            )}
            {stagedRollout && (
              <>
                <div className="staged-summary">
                  <span><strong>{stagedRollout.deliveredCount}/{stagedRollout.targetCount}名</strong>配布済み</span>
                  <span><strong>wave {stagedRollout.currentWave}/3</strong>進行</span>
                  <span><strong>{stagedRollout.consecutiveContinueRuns}/{stagedRollout.requiredContinueRuns}</strong>連続CONTINUE</span>
                  <span><strong>{stagedRollout.criticalAlertCount}</strong>PAUSE</span>
                  <span><strong>{stagedRollout.inviteFailureCount}</strong>招待失敗</span>
                </div>
                <div className="staged-waves">
                  {stagedRollout.wavePlan.map((wave)=><article className={wave.waveNumber<stagedRollout.currentWave?"done":wave.waveNumber===stagedRollout.currentWave?stagedRollout.status:"locked"} key={wave.waveNumber}>
                    <strong>wave {wave.waveNumber}</strong><span>{wave.size}名</span><small>累計{wave.cumulativeCount}名</small>
                  </article>)}
                </div>
                {stagedRollout.status === "observing" && <p className="staged-observing">監視中：{stagedRollout.observationHours}時間＋連続{stagedRollout.requiredContinueRuns}回CONTINUE後に自動でREADYになります。</p>}
                {stagedRollout.status === "paused" && <p className="staged-paused">PAUSE：安全のため次waveを永久ロックしました。確認後に停止してください。</p>}
                {stagedRollout.status === "completed" && <p className="expansion-approved">全3waveと最終観察が完了しました。</p>}
                {!!stagedRollout.gate.blockers.length && stagedRollout.status !== "completed" && <div className="staged-blockers">{stagedRollout.gate.blockers.map((item)=><span key={item.key}>{item.label}：{String(item.actual)} / {item.required}</span>)}</div>}
                <div className="staged-actions">
                  {stagedRollout.status === "ready" && stagedRollout.gate.nextWave && <button onClick={releaseNextStagedWave} disabled={stagedRolloutBusy||!stagedRollout.gate.allowed}>wave {stagedRollout.gate.nextWave.waveNumber}を{stagedRollout.gate.nextWave.size}名へ配布</button>}
                  {!["stopped","completed"].includes(stagedRollout.status) && <button className="danger" onClick={stopCurrentStagedRollout} disabled={stagedRolloutBusy}>即時停止</button>}
                  <button className="ghost" onClick={()=>loadStagedRolloutStatus(stagedRollout.stagedRolloutId)} disabled={stagedRolloutBusy}>再読込</button>
                </div>
              </>
            )}
          </div>
        )}
        {!!inviteCandidates.length && (
          <div className="candidate-list">
            {inviteCandidates.map((candidate) => (
              <label className="candidate-row" key={candidate.staffId}>
                <input
                  type="checkbox"
                  checked={selectedInviteIds.includes(candidate.staffId)}
                  onChange={() => toggleInvite(candidate.staffId)}
                />
                <span>
                  <strong>{candidate.displayName}</strong>
                  <small>{candidate.emails.length}アドレス / 今後のシフト{candidate.upcomingJobs}件</small>
                </span>
              </label>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="toolbar">
          <input
            value={staffQuery}
            onChange={(event) => setStaffQuery(event.target.value)}
            placeholder="スタッフ名・メール・最寄り駅・エリアを検索"
          />
          <button onClick={() => setMessage(`${filteredStaff.length}名見つかりました。`)}>
            スタッフ検索
          </button>
        </div>
        <h2>スタッフ一覧</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>スタッフ</th><th>エリア</th><th>メール</th><th>最寄り駅</th><th>ランク</th><th>状態</th><th>管理</th></tr>
            </thead>
            <tbody>
              {filteredStaff.slice(0, 100).map((profile) => (
                <tr key={profile.id} className={profile.active === false ? "cancelled" : ""}>
                  <td>{profile.displayName}</td>
                  <td>{(profile.areaLabels ?? []).join("・")}</td>
                  <td>
                    {(profile.emails ?? []).length}件
                    {(profile.emails ?? []).length > 1 && <span className="mini-tag">複数</span>}
                    {!!profile.emailConflicts?.length && <span className="mini-tag danger-tag">競合</span>}
                  </td>
                  <td>{profile.nearestStation ?? ""}</td>
                  <td>{profile.rank ?? "A"}</td>
                  <td>{profile.active === false ? "利用停止" : "利用可能"}</td>
                  <td className="row-actions">
                    <button className="ghost compact" onClick={() => loadStaffPerformance(profile)} disabled={performanceBusy}>実績</button>
                    <button className="ghost compact" onClick={() => openStaffDevices(profile)}>端末</button>
                    <button className="danger compact" onClick={() => revokeStaffDevices(profile)}>全ログアウト</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>


      {performance && (
        <section className="panel performance-panel" id="staff-performance">
          <div className="section-heading">
            <div>
              <h2>{performance.profile.displayName}さんの稼働実績</h2>
              <p>{performance.profile.areaLabels.join("・")} / {performance.profile.nearestStation} / ランク {performance.profile.rank}</p>
            </div>
            <button className="ghost" onClick={()=>setPerformance(null)}>閉じる</button>
          </div>
          <div className="performance-kpis">
            <article><small>稼働・予定</small><strong>{performance.performance.totals.assignedJobs}回</strong></article>
            <article><small>実施済み</small><strong>{performance.performance.totals.implementedJobs}回</strong></article>
            <article><small>今後予定</small><strong>{performance.performance.totals.scheduledJobs}回</strong></article>
            <article><small>キャンセル</small><strong>{performance.performance.totals.cancelledJobs}回</strong></article>
            <article><small>事前連絡遅延</small><strong>{performance.performance.totals.preContactLate}回</strong></article>
            <article><small>報告書遅延</small><strong>{performance.performance.totals.reportLate}回</strong></article>
          </div>
          <div className="performance-split">
            <div><h3>クライアント別</h3><div className="rank-list">{performance.performance.clients.slice(0,8).map((item)=><div key={item.name}><span>{item.name}</span><strong>{item.count}回</strong></div>)}</div></div>
            <div><h3>メーカー別</h3><div className="rank-list">{performance.performance.makers.slice(0,8).map((item)=><div key={item.name}><span>{item.name}</span><strong>{item.count}回</strong></div>)}</div></div>
            <div><h3>過去店舗</h3><div className="rank-list">{performance.performance.stores.slice(0,8).map((item)=><div key={item.name}><span>{item.name}</span><strong>{item.count}回</strong></div>)}</div></div>
          </div>
          <div className="mini-table-wrap">
            <table><thead><tr><th>日付</th><th>クライアント</th><th>店舗</th><th>メーカー</th><th>状態</th></tr></thead>
            <tbody>{performance.performance.recentJobs.slice(0,20).map((job)=><tr key={job.id}><td>{job.dateKey}</td><td>{job.clientName}</td><td>{job.storeName}</td><td>{job.makerName}</td><td>{job.cancelled?"キャンセル":"有効"}</td></tr>)}</tbody></table>
          </div>
        </section>
      )}

      {!!deviceStaffName && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>{deviceStaffName}さんの端末</h2>
              <p>個別端末の状態確認です。全端末ログアウトはスタッフ一覧から実行できます。</p>
            </div>
            <button className="ghost" onClick={() => { setDeviceStaffName(""); setStaffDevices([]); }}>閉じる</button>
          </div>
          <div className="device-grid">
            {staffDevices.map((device) => (
              <article key={device.id}>
                <strong>{device.label || device.platform || "端末"}</strong>
                <small>{device.active === false ? "ログアウト済み" : "利用中"}</small>
              </article>
            ))}
            {!staffDevices.length && <div>登録端末はありません。</div>}
          </div>
        </section>
      )}

      <section className="two">
        <article className="panel">
          <h2>今すぐ確認</h2>
          <p>報告書 未提出 <strong>2件</strong></p>
          <p>売場画像 未提出 <strong>1件</strong></p>
          <p>再提出 確認待ち <strong>1件</strong></p>
        </article>
        <article className="panel">
          <h2>今日の概算</h2>
          <p>請求予定 <strong>642,500円</strong></p>
          <p>支払予定 <strong>442,000円</strong></p>
          <p>粗利予定 <strong>200,500円</strong></p>
        </article>
      </section>
    </main>
  );
}
