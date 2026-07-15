import { ProductionEvidenceSummary, sha256 } from "./production-evidence-core";

export type ProductionEvidenceMonitorStatus = "healthy"|"watch"|"critical"|"complete";
export type ProductionEvidenceHealth = {
  status: ProductionEvidenceMonitorStatus;
  severity: null|"warning"|"critical";
  phase: ProductionEvidenceSummary["phase"];
  reasonKeys: string[];
  headline: string;
  nextAction: string;
  deadlineAt: string|null;
  overdueMinutes: number;
  fingerprint: string;
  evaluatedAt: string;
};
export type ProductionEvidenceDiff = {
  kind: "initial"|"progress"|"alert"|"no_change";
  fromPhase: string|null;
  toPhase: string;
  progressDelta: number;
  acceptancePassDelta: number;
  recoveryPassDelta: number;
  changedKeys: string[];
  fingerprint: string;
};
export type ProductionEvidenceAlertStatus = "open"|"acknowledged"|"in_progress"|"resolved";
export type ProductionEvidenceAlertSlaStatus = "on_track"|"ack_due"|"response_due"|"breached"|"met";
export type ProductionEvidenceAlertSlaStage = "none"|"acknowledgement"|"response"|"handoff";
export type ProductionEvidenceAlertSla = {
  status:ProductionEvidenceAlertSlaStatus;
  stage:ProductionEvidenceAlertSlaStage;
  escalationLevel:0|1|2|3;
  escalationKey:string;
  label:string;
  ageMinutes:number;
  remainingMinutes:number;
  acknowledgementTargetMinutes:number;
  responseTargetMinutes:number;
  handoffTargetMinutes:number;
  acknowledgementDeadlineAt:string|null;
  responseDeadlineAt:string|null;
  handoffDeadlineAt:string|null;
};
export type ProductionEvidenceAlertQueueItem = {
  alertId:string;
  fingerprint:string;
  status:ProductionEvidenceAlertStatus;
  priority:"critical"|"watch";
  phase:ProductionEvidenceSummary["phase"];
  headline:string;
  nextAction:string;
  firstDetectedAt:string|null;
  lastDetectedAt:string|null;
  acknowledgedAt?:string|null;
  responseStartedAt?:string|null;
  resolvedAt?:string|null;
  reasonKeys?:string[];
  assignedToEmail?:string|null;
  handoffCount?:number;
  maximumEscalationLevel?:number;
  reviewStatus?:"open"|"in_progress"|"completed"|null;
  handoffPending?:boolean;
  handoffAt?:string|null;
  sla?:ProductionEvidenceAlertSla;
};
export type ProductionEvidenceSlaPerformance = {
  period:{days:number;startAt:string;endAt:string};
  grade:"A"|"B"|"C"|"D";
  score:number;
  totalAlerts:number;
  criticalAlerts:number;
  resolvedAlerts:number;
  activeAlerts:number;
  atRiskAlerts:number;
  breachedAlerts:number;
  acknowledgementSlaRate:number;
  responseSlaRate:number;
  averageAcknowledgementMinutes:number;
  averageResponseMinutes:number;
  averageResolutionMinutes:number;
  handoffCount:number;
  reviewRequired:number;
  reviewCompleted:number;
  reviewPending:number;
  daily:Array<{date:string;alerts:number;breaches:number;responsesMet:number}>;
  hotspots:Array<{key:string;alerts:number;breaches:number}>;
  ownerLoad:Array<{email:string;alerts:number;breaches:number;active:number}>;
  recommendations:string[];
};
export type ProductionEvidenceSlaWeeklyComparison = {
  current:ProductionEvidenceSlaPerformance;
  previous:ProductionEvidenceSlaPerformance;
  deltas:{score:number;acknowledgementSlaRate:number;responseSlaRate:number;totalAlerts:number;breachedAlerts:number;averageResolutionMinutes:number;reviewPending:number};
  direction:"improved"|"stable"|"declined";
  headline:string;
  highlights:string[];
};
export type ProductionEvidenceAfterActionReviewReminderInput = {
  status:"open"|"in_progress"|"completed";
  dueAt:string|null;
  lastReminderAt?:string|null;
};
export type ProductionEvidenceAfterActionReviewReminder = {
  status:"none"|"due_soon"|"overdue";
  shouldNotify:boolean;
  urgent:boolean;
  reminderKey:string|null;
  label:string;
  dueInHours:number;
  overdueDays:number;
  escalationLevel:0|1|2|3;
};
export type ProductionEvidenceWeeklyReportRecipient = {
  weekKey?:string;
  status:"unread"|"read"|"proxy_read"|"unresolved";
  deliveredAt:string|null;
  lastReminderAt?:string|null;
  reminderCount?:number;
  escalationLevel?:number;
  assignedToEmail?:string|null;
  backupToEmail?:string|null;
  previousAssignedToEmails?:string[];
  assignedAt?:string|null;
  lastReassignedAt?:string|null;
  approvalStatus?:"pending"|"approved"|null;
  approvalDeadlineAt?:string|null;
  approvedAt?:string|null;
  reassignmentCount?:number;
  assignmentEscalationKey?:string|null;
  approvalFlowStatus?:"none"|"waiting"|"expired"|"escalated";
  responsibilityStatus?:"complete"|"safe"|"watch"|"at_risk"|"overdue";
};
export type ProductionEvidenceWeeklyReportReadReminder = {
  status:"none"|"waiting"|"remind"|"escalated";
  shouldNotify:boolean;
  urgent:boolean;
  reminderKey:string|null;
  escalationLevel:0|1|2|3;
  unreadHours:number;
  label:string;
};
export type ProductionEvidenceWeeklyReadTrendPoint = {
  weekKey:string;
  deliveredAt:string|null;
  total:number;
  read:number;
  proxyRead:number;
  unread:number;
  unresolved:number;
  escalated:number;
  readRate:number;
};
export type ProductionEvidenceWeeklyReadTrend = {
  points:ProductionEvidenceWeeklyReadTrendPoint[];
  currentReadRate:number;
  previousReadRate:number;
  delta:number;
  direction:"improved"|"stable"|"declined";
  averageReadRate:number;
  proxyReadTotal:number;
  unresolvedTotal:number;
  headline:string;
};
export type ProductionEvidenceExecutiveReportHistoryPoint = ProductionEvidenceWeeklyReadTrendPoint & {
  alertStatus:string;
  riskScore:number;
};
export type ProductionEvidenceExecutiveReportHistory = {
  points:ProductionEvidenceExecutiveReportHistoryPoint[];
  currentReadRate:number;
  averageReadRate:number;
  readTotal:number;
  proxyReadTotal:number;
  unreadTotal:number;
  unresolvedTotal:number;
  escalatedTotal:number;
  headline:string;
};
export type ProductionEvidenceExecutiveDecisionTaskStatus = "open"|"in_progress"|"completed";
export type ProductionEvidenceExecutiveDecisionTaskPriority = "normal"|"high"|"critical";
export type ProductionEvidenceExecutiveDecisionOutcomeDirection = "increase"|"decrease";
export type ProductionEvidenceExecutiveDecisionOutcome = {
  policyVersion:"outcome_v1";
  status:"unmeasured"|"negative"|"below_target"|"effective"|"excellent";
  metricName:string|null;
  unit:string|null;
  direction:ProductionEvidenceExecutiveDecisionOutcomeDirection|null;
  baselineValue:number|null;
  targetValue:number|null;
  actualValue:number|null;
  improvementValue:number;
  improvementRate:number;
  targetAchievementRate:number;
  investmentYen:number;
  benefitYen:number;
  netBenefitYen:number;
  roiPercent:number|null;
  score:number;
  label:string;
};
export type ProductionEvidenceExecutiveDecisionRecoveryCause = "none"|"execution_gap"|"process_gap"|"resource_gap"|"economics_gap"|"measurement_gap"|"external_factor";
export type ProductionEvidenceExecutiveDecisionRecoveryRecommendation = {
  policyVersion:"recovery_v1";
  status:"not_required"|"required"|"planned";
  causeCode:ProductionEvidenceExecutiveDecisionRecoveryCause;
  severity:"none"|"watch"|"critical";
  priority:ProductionEvidenceExecutiveDecisionTaskPriority;
  dueDays:number;
  headline:string;
  diagnosis:string;
  recommendedAction:string;
  followUpTitle:string;
};
export type ProductionEvidenceExecutiveDecisionRecoveryPlan = ProductionEvidenceExecutiveDecisionRecoveryRecommendation & {
  selectedCauseCode:Exclude<ProductionEvidenceExecutiveDecisionRecoveryCause,"none">;
  causeDetail:string;
  improvementPlan:string;
  createdAt:string|null;
  createdByEmail:string|null;
  followUpTaskId:string;
};
export type ProductionEvidenceExecutiveDecisionTask = {
  taskId:string;
  weekKey:string;
  title:string;
  priority:ProductionEvidenceExecutiveDecisionTaskPriority;
  status:ProductionEvidenceExecutiveDecisionTaskStatus;
  ownerEmail:string|null;
  dueAt:string|null;
  createdAt:string|null;
  startedAt:string|null;
  completedAt:string|null;
  completedByEmail:string|null;
  completionNote:string|null;
  metricName?:string|null;
  metricUnit?:string|null;
  metricDirection?:ProductionEvidenceExecutiveDecisionOutcomeDirection|null;
  baselineValue?:number|null;
  targetValue?:number|null;
  actualValue?:number|null;
  investmentYen?:number|null;
  benefitYen?:number|null;
  measurementPeriodDays?:number|null;
  measuredAt?:string|null;
  measuredByEmail?:string|null;
  outcomeNote?:string|null;
  outcome?:ProductionEvidenceExecutiveDecisionOutcome;
  recoveryRecommendation?:ProductionEvidenceExecutiveDecisionRecoveryRecommendation;
  recoveryPlan?:ProductionEvidenceExecutiveDecisionRecoveryPlan|null;
  recoveryTaskId?:string|null;
  recoveryPlannedAt?:string|null;
  recoveryPlannedByEmail?:string|null;
  lastReminderAt?:string|null;
  reminderCount?:number;
  maximumEscalationLevel?:number;
};
export type ProductionEvidenceExecutiveDecisionTaskDeadline = {
  status:"none"|"due_soon"|"overdue"|"escalated";
  shouldNotify:boolean;
  urgent:boolean;
  reminderKey:string|null;
  escalationLevel:0|1|2|3;
  remainingHours:number;
  overdueHours:number;
  label:string;
};
export type ProductionEvidenceExecutiveDecisionTaskSummary = {
  total:number;
  open:number;
  inProgress:number;
  completed:number;
  overdue:number;
  dueSoon:number;
  escalated:number;
  completionRate:number;
  onTimeCompleted:number;
  onTimeCompletionRate:number;
  averageCompletionHours:number;
  measured:number;
  unmeasuredCompleted:number;
  outcomeMeasurementRate:number;
  effective:number;
  positiveRoi:number;
  averageOutcomeScore:number;
  totalInvestmentYen:number;
  totalBenefitYen:number;
  netBenefitYen:number;
  portfolioRoiPercent:number|null;
  outcomeHeadline:string;
  headline:string;
};
export type ProductionEvidenceWeeklyResponsibility = {
  status:"complete"|"safe"|"watch"|"at_risk"|"overdue";
  riskScore:number;
  slaDueAt:string|null;
  hoursRemaining:number;
  overdueHours:number;
  shouldAssign:boolean;
  requiresApproval:boolean;
  label:string;
};
export type ProductionEvidenceWeeklyResponsibilityReassignment = {
  status:"none"|"waiting"|"expired"|"escalated";
  shouldReassign:boolean;
  shouldEscalate:boolean;
  urgent:boolean;
  remainingMinutes:number;
  overdueMinutes:number;
  reassignmentCount:number;
  escalationKey:string|null;
  label:string;
};
export type ProductionEvidenceWeeklyOwnerRanking = {
  primary:string|null;
  backup:string|null;
  candidates:Array<{email:string;activeAssignments:number;tieBreaker:string}>;
};
export type ProductionEvidenceWeeklyResponsibilityAnalytics = {
  weeks:Array<{weekKey:string;assigned:number;approved:number;reassigned:number;reassignmentSuccess:number;escalated:number;approvalRate:number;reassignmentSuccessRate:number}>;
  owners:Array<{email:string;primary:number;backup:number;reassignedIn:number;approved:number;pending:number;averageApprovalMinutes:number;weeks:Array<{weekKey:string;primary:number;backup:number;reassigned:number;approved:number}>}>;
  assignedTotal:number;
  approvedTotal:number;
  pendingTotal:number;
  approvalRate:number;
  onTimeApprovedTotal:number;
  onTimeApprovalRate:number;
  averageApprovalMinutes:number;
  p95ApprovalMinutes:number;
  reassignmentTotal:number;
  reassignmentSuccessTotal:number;
  reassignmentSuccessRate:number;
  escalatedTotal:number;
  loadSpread:number;
  headline:string;
  recommendations:string[];
};
export type ProductionEvidenceResponsibilityAlertThresholds = {
  approvalRateMin:number;
  onTimeApprovalRateMin:number;
  p95ApprovalMinutesMax:number;
  reassignmentSuccessRateMin:number;
  escalatedTotalMax:number;
  loadSpreadMax:number;
  pendingRateMax:number;
};
export type ProductionEvidenceResponsibilityAnalyticsAlert = {
  key:string;
  severity:"critical"|"warning";
  metric:keyof ProductionEvidenceResponsibilityAlertThresholds;
  operator:"min"|"max";
  current:number;
  threshold:number;
  title:string;
  message:string;
  action:string;
};
export type ProductionEvidenceResponsibilityAnalyticsAlertSummary = {
  policyVersion:"auto_v1";
  status:"healthy"|"watch"|"critical";
  riskScore:number;
  thresholds:ProductionEvidenceResponsibilityAlertThresholds;
  alerts:ProductionEvidenceResponsibilityAnalyticsAlert[];
  headline:string;
  fingerprint:string;
};
export type ProductionEvidenceResponsibilityExecutiveDigest = {
  generatedAt:string;
  period:{startWeek:string|null;endWeek:string|null;weeks:number};
  status:ProductionEvidenceResponsibilityAnalyticsAlertSummary["status"];
  headline:string;
  summary:string;
  kpis:Array<{key:string;label:string;value:string;delta:number|null;status:"good"|"watch"|"critical"}>;
  wins:string[];
  risks:string[];
  decisions:string[];
  markdown:string;
};
export type ProductionEvidenceResponsibilityExecutiveDelivery = {
  shouldDeliver:boolean;
  weekKey:string;
  availableAt:string;
  nextScheduledAt:string;
  deliveryKey:string;
};
export type ProductionEvidenceResponsibilityAlertWorkflow = {
  alertKey:string;
  alertFingerprint:string;
  status:"open"|"acknowledged"|"assigned";
  ownerEmail:string|null;
  acknowledgedByEmail:string|null;
  acknowledgedAt:string|null;
  assignedAt:string|null;
  note:string|null;
};

export function diffProductionEvidence(previous: ProductionEvidenceSummary|null, current: ProductionEvidenceSummary): ProductionEvidenceDiff {
  const changedKeys:string[]=[];
  if(!previous)changedKeys.push("initial_import");
  else {
    changed(changedKeys,"phase",previous.phase,current.phase);
    changed(changedKeys,"progress",previous.progressScore,current.progressScore);
    changed(changedKeys,"acceptance_status",previous.acceptance?.status,current.acceptance?.status);
    changed(changedKeys,"acceptance_passes",previous.acceptance?.validPasses??0,current.acceptance?.validPasses??0);
    changed(changedKeys,"acceptance_runs",previous.acceptance?.runCount??0,current.acceptance?.runCount??0);
    changed(changedKeys,"acceptance_failures",join(previous.acceptance?.failedCheckKeys),join(current.acceptance?.failedCheckKeys));
    changed(changedKeys,"rollback_status",previous.rollback?.status,current.rollback?.status);
    changed(changedKeys,"rollback_release",previous.rollback?.knownGoodReleaseId,current.rollback?.knownGoodReleaseId);
    changed(changedKeys,"recovery_status",previous.recovery?.status,current.recovery?.status);
    changed(changedKeys,"recovery_passes",previous.recovery?.validPasses??0,current.recovery?.validPasses??0);
    changed(changedKeys,"recovery_runs",previous.recovery?.runCount??0,current.recovery?.runCount??0);
    changed(changedKeys,"recovery_failures",join(previous.recovery?.failedCheckKeys),join(current.recovery?.failedCheckKeys));
    changed(changedKeys,"package",previous.packageFingerprint,current.packageFingerprint);
  }
  const alertKeys=new Set(["acceptance_failures","rollback_status","recovery_failures"]);
  const kind:ProductionEvidenceDiff["kind"]=!previous?"initial":changedKeys.some(key=>alertKeys.has(key))||["rollback_required","rollback_failed_locked","recovery_failed_locked"].includes(current.phase)?"alert":changedKeys.length?"progress":"no_change";
  const base={kind,fromPhase:previous?.phase??null,toPhase:current.phase,progressDelta:current.progressScore-(previous?.progressScore??0),acceptancePassDelta:(current.acceptance?.validPasses??0)-(previous?.acceptance?.validPasses??0),recoveryPassDelta:(current.recovery?.validPasses??0)-(previous?.recovery?.validPasses??0),changedKeys};
  return{...base,fingerprint:sha256(base)};
}

export function evaluateProductionEvidenceHealth(summary: ProductionEvidenceSummary, nowMs = Date.now()): ProductionEvidenceHealth {
  const evaluatedAt=new Date(nowMs).toISOString();let status:ProductionEvidenceMonitorStatus="healthy";let severity:ProductionEvidenceHealth["severity"]=null;let reasonKeys:string[]=[];let headline="証跡は正常に進行しています";let nextAction="次の証跡同期を待機";let deadlineMs:number|null=null;
  if(summary.phase==="accepted"||summary.phase==="recovered"){status="complete";headline=summary.phase==="accepted"?"本番受入を3回合格で固定済み":"既知正常版の復旧受入を3回合格で固定済み";nextAction="監視を継続";}
  else if(summary.phase==="rollback_required"){status="critical";severity="critical";reasonKeys=["acceptance_failed","rollback_required"];headline="本番受入失敗・rollbackが必要です";nextAction="緊急停止を維持し、別承認rollbackを開始";}
  else if(summary.phase==="rollback_failed_locked"){status="critical";severity="critical";reasonKeys=["rollback_failed_locked"];headline="rollback失敗・緊急停止固定中です";nextAction="失敗stageを確認し、責任者判断で復旧";}
  else if(summary.phase==="recovery_failed_locked"){status="critical";severity="critical";reasonKeys=["recovery_acceptance_failed"];headline="復旧受入失敗・緊急停止固定中です";nextAction="既知正常版と失敗検査を再確認";}
  else if(summary.phase==="deployed"){
    deadlineMs=Date.parse(summary.deployment.completedAt)+7*60_000;const late=overdue(nowMs,deadlineMs);
    if(late>8){status="critical";severity="critical";reasonKeys=["acceptance_start_overdue"];headline="デプロイ後の本番受入が開始されていません";nextAction="30分期限内に本番受入を実行";}
    else if(late>0){status="watch";severity="warning";reasonKeys=["acceptance_not_started"];headline="本番受入の開始が遅れています";nextAction="本番受入1回目を実行";}
    else{nextAction="本番受入1回目を実行";}
  }
  else if(summary.phase==="acceptance_observing"){
    deadlineMs=Date.parse(summary.acceptance?.lastObservedAt??summary.deployment.completedAt)+7*60_000;const late=overdue(nowMs,deadlineMs);
    if(late>8){status="critical";severity="critical";reasonKeys=["acceptance_run_overdue"];headline="本番受入の次回観測が大幅に遅れています";nextAction="30分期限と現状態を確認";}
    else if(late>0){status="watch";severity="warning";reasonKeys=["acceptance_run_due"];headline="本番受入の次回観測時刻を超過しました";nextAction="次の本番受入を実行";}
    else{nextAction=`本番受入 ${Math.min(3,(summary.acceptance?.validPasses??0)+1)}/3を実行`;}
  }
  else if(summary.phase==="rollback_succeeded"){
    deadlineMs=Date.parse(summary.rollback?.completedAt??summary.deployment.completedAt)+7*60_000;const late=overdue(nowMs,deadlineMs);status=late>0?"critical":"watch";severity=late>0?"critical":"warning";reasonKeys=[late>0?"recovery_start_overdue":"recovery_not_started"];headline=late>0?"rollback後の復旧受入が開始されていません":"rollback成功・復旧受入待ちです";nextAction="緊急停止を維持し、復旧受入1回目を実行";
  }
  else if(summary.phase==="recovery_observing"){
    deadlineMs=Date.parse(summary.recovery?.lastObservedAt??summary.rollback?.completedAt??summary.deployment.completedAt)+7*60_000;const late=overdue(nowMs,deadlineMs);status=late>0?"critical":"watch";severity=late>0?"critical":"warning";reasonKeys=[late>0?"recovery_run_overdue":"recovery_in_progress"];headline=late>0?"復旧受入の次回観測時刻を超過しました":"復旧受入を観測中です";nextAction=`緊急停止を維持し、復旧受入 ${Math.min(3,(summary.recovery?.validPasses??0)+1)}/3を実行`;
  }
  const deadlineAt=Number.isFinite(deadlineMs)?new Date(deadlineMs as number).toISOString():null;const overdueMinutes=deadlineMs==null?0:overdue(nowMs,deadlineMs);const fingerprint=sha256({releaseId:summary.releaseId,phase:summary.phase,status,severity,reasonKeys,deadlineAt});
  return{status,severity,phase:summary.phase,reasonKeys,headline,nextAction,deadlineAt,overdueMinutes,fingerprint,evaluatedAt};
}

export function decideProductionEvidenceNotification(input:{previous:ProductionEvidenceHealth|null;current:ProductionEvidenceHealth;lastAlertFingerprint?:string|null;lastAlertAtMs?:number|null;acknowledgedFingerprint?:string|null;nowMs?:number}){
  const nowMs=input.nowMs??Date.now();const changed=input.lastAlertFingerprint!==input.current.fingerprint;const age=input.lastAlertAtMs==null?Number.POSITIVE_INFINITY:Math.max(0,nowMs-input.lastAlertAtMs);let shouldNotify=false;let urgent=false;let kind:"none"|"watch"|"critical"|"recovered"="none";
  if(input.current.status==="critical"){urgent=true;kind="critical";shouldNotify=(changed&&input.acknowledgedFingerprint!==input.current.fingerprint)||age>=30*60_000;}
  else if(input.current.status==="watch"){kind="watch";shouldNotify=changed&&input.previous?.status!=="watch"&&input.acknowledgedFingerprint!==input.current.fingerprint;}
  else if(input.current.status==="complete"&&input.previous&&["watch","critical"].includes(input.previous.status)){kind="recovered";shouldNotify=true;}
  return{shouldNotify,urgent,kind};
}

export function productionEvidenceAlertRunbook(phase:ProductionEvidenceSummary["phase"]){
  if(phase==="deployed"||phase==="acceptance_observing")return{actionKey:"run_acceptance",label:"本番受入を実行",command:"npm run acceptance:production"};
  if(phase==="rollback_required")return{actionKey:"prepare_rollback",label:"別承認rollbackを準備",command:"npm run rollback:production:prepare"};
  if(phase==="rollback_succeeded"||phase==="recovery_observing")return{actionKey:"run_recovery_acceptance",label:"復旧受入を実行",command:"npm run acceptance:production:recovery"};
  if(phase==="rollback_failed_locked")return{actionKey:"inspect_rollback_failure",label:"rollback失敗stageを確認",command:"npm run rollback:production:preview"};
  if(phase==="recovery_failed_locked")return{actionKey:"inspect_recovery_failure",label:"復旧失敗証跡を確認",command:"npm run evidence:production:preview"};
  return{actionKey:"continue_monitoring",label:"監視を継続",command:"npm run evidence:production:preview"};
}

export function productionEvidenceAlertSlaTargets(priorityValue:ProductionEvidenceAlertQueueItem["priority"]){
  return priorityValue==="critical"
    ?{acknowledgementTargetMinutes:5,responseTargetMinutes:10,handoffTargetMinutes:10}
    :{acknowledgementTargetMinutes:15,responseTargetMinutes:30,handoffTargetMinutes:30};
}

export function evaluateProductionEvidenceAlertSla(item:ProductionEvidenceAlertQueueItem,nowMs=Date.now()):ProductionEvidenceAlertSla{
  const targets=productionEvidenceAlertSlaTargets(item.priority);const firstMs=parseTime(item.firstDetectedAt,nowMs);const ageMinutes=elapsedMinutes(nowMs,firstMs);const acknowledgementDeadlineMs=firstMs+targets.acknowledgementTargetMinutes*60_000;const responseDeadlineMs=firstMs+targets.responseTargetMinutes*60_000;const handoffMs=item.handoffPending?parseTime(item.handoffAt,nowMs):null;const handoffDeadlineMs=handoffMs==null?null:handoffMs+targets.handoffTargetMinutes*60_000;
  const base={ageMinutes,...targets,acknowledgementDeadlineAt:toIso(acknowledgementDeadlineMs),responseDeadlineAt:toIso(responseDeadlineMs),handoffDeadlineAt:handoffDeadlineMs==null?null:toIso(handoffDeadlineMs)};
  if(item.status==="resolved")return{...base,status:"met",stage:"none",escalationLevel:0,escalationKey:"none:0",label:"解決済み",remainingMinutes:0};
  if(item.handoffPending&&handoffDeadlineMs!=null){const remaining=remainingMinutes(nowMs,handoffDeadlineMs);if(nowMs>=handoffDeadlineMs)return{...base,status:"breached",stage:"handoff",escalationLevel:3,escalationKey:"handoff:3",label:"引継ぎ受領期限超過",remainingMinutes:0};if(remaining<=Math.max(2,Math.ceil(targets.handoffTargetMinutes/3)))return{...base,status:"response_due",stage:"handoff",escalationLevel:2,escalationKey:"handoff:2",label:"引継ぎ受領期限接近",remainingMinutes:remaining};return{...base,status:"on_track",stage:"handoff",escalationLevel:0,escalationKey:"handoff:0",label:"引継ぎ受領待ち",remainingMinutes:remaining};}
  if(item.responseStartedAt){const responseMs=parseTime(item.responseStartedAt,nowMs);const breached=responseMs>responseDeadlineMs;return{...base,status:breached?"breached":"met",stage:"response",escalationLevel:0,escalationKey:"response:0",label:breached?"対応開始済み・SLA超過":"対応開始SLA達成",remainingMinutes:0};}
  const responseRemaining=remainingMinutes(nowMs,responseDeadlineMs);if(nowMs>=responseDeadlineMs)return{...base,status:"breached",stage:"response",escalationLevel:3,escalationKey:"response:3",label:"対応開始SLA超過",remainingMinutes:0};
  if(item.acknowledgedAt||nowMs>=acknowledgementDeadlineMs)return{...base,status:"response_due",stage:"response",escalationLevel:2,escalationKey:"response:2",label:"対応開始待ち",remainingMinutes:responseRemaining};
  const acknowledgementRemaining=remainingMinutes(nowMs,acknowledgementDeadlineMs);if(acknowledgementRemaining<=Math.max(2,Math.ceil(targets.acknowledgementTargetMinutes/3)))return{...base,status:"ack_due",stage:"acknowledgement",escalationLevel:1,escalationKey:"acknowledgement:1",label:"確認期限接近",remainingMinutes:acknowledgementRemaining};
  return{...base,status:"on_track",stage:"acknowledgement",escalationLevel:0,escalationKey:"acknowledgement:0",label:"SLA内",remainingMinutes:acknowledgementRemaining};
}

export function summarizeProductionEvidenceAlerts(items:ProductionEvidenceAlertQueueItem[]){
  const normalized=items.map(item=>({...item,sla:item.sla??evaluateProductionEvidenceAlertSla(item)}));
  const sorted=normalized.sort((left,right)=>Number(left.status==="resolved")-Number(right.status==="resolved")||right.sla.escalationLevel-left.sla.escalationLevel||priority(right.priority)-priority(left.priority)||statusRank(left.status)-statusRank(right.status)||Date.parse(right.lastDetectedAt??"")-Date.parse(left.lastDetectedAt??"")||left.alertId.localeCompare(right.alertId));
  return{total:items.length,unresolved:normalized.filter(item=>item.status!=="resolved").length,critical:normalized.filter(item=>item.status!=="resolved"&&item.priority==="critical").length,inProgress:normalized.filter(item=>item.status==="in_progress").length,slaBreached:normalized.filter(item=>item.status!=="resolved"&&item.sla.status==="breached").length,escalated:normalized.filter(item=>item.status!=="resolved"&&item.sla.escalationLevel>0).length,handoffPending:normalized.filter(item=>item.status!=="resolved"&&item.handoffPending).length,items:sorted};
}

export function summarizeProductionEvidenceSlaPerformance(items:ProductionEvidenceAlertQueueItem[],nowMs=Date.now(),days=7):ProductionEvidenceSlaPerformance{
  const periodDays=Math.min(31,Math.max(1,Math.floor(days)));const dayMs=24*60*60_000;const todayStart=tokyoDayStart(nowMs);const startMs=todayStart-(periodDays-1)*dayMs;const recent=items.filter(item=>{const value=Date.parse(item.firstDetectedAt??"");return Number.isFinite(value)&&value>=startMs&&value<=nowMs;});
  const rows=recent.map(item=>performanceRow(item,nowMs));const acknowledgementEligible=rows.filter(row=>row.acknowledgementEligible);const responseEligible=rows.filter(row=>row.responseEligible);const acknowledgementMet=acknowledgementEligible.filter(row=>row.acknowledgementMet).length;const responseMet=responseEligible.filter(row=>row.responseMet).length;const acknowledgementSlaRate=percentage(acknowledgementMet,acknowledgementEligible.length);const responseSlaRate=percentage(responseMet,responseEligible.length);const atRiskAlerts=rows.filter(row=>row.atRisk).length;const breachedAlerts=rows.filter(row=>row.breached).length;const score=Math.max(0,Math.min(100,Math.round(acknowledgementSlaRate*.4+responseSlaRate*.6-Math.min(20,atRiskAlerts*5))));const grade:ProductionEvidenceSlaPerformance["grade"]=score>=95?"A":score>=85?"B":score>=70?"C":"D";
  const daily=Array.from({length:periodDays},(_,index)=>{const date=tokyoDateKey(startMs+index*dayMs);const values=rows.filter(row=>row.date===date);return{date,alerts:values.length,breaches:values.filter(row=>row.breached).length,responsesMet:values.filter(row=>row.responseMet).length};});
  const hotspotMap=new Map<string,{alerts:number;breaches:number}>();for(const row of rows)for(const key of row.item.reasonKeys??["unknown"]){const value=hotspotMap.get(key)??{alerts:0,breaches:0};value.alerts+=1;if(row.breached)value.breaches+=1;hotspotMap.set(key,value);}const hotspots=[...hotspotMap].map(([key,value])=>({key,...value})).sort((a,b)=>b.breaches-a.breaches||b.alerts-a.alerts||a.key.localeCompare(b.key)).slice(0,5);
  const ownerMap=new Map<string,{alerts:number;breaches:number;active:number}>();for(const row of rows){const email=row.item.assignedToEmail??"未割当";const value=ownerMap.get(email)??{alerts:0,breaches:0,active:0};value.alerts+=1;if(row.breached)value.breaches+=1;if(row.item.status!=="resolved")value.active+=1;ownerMap.set(email,value);}const ownerLoad=[...ownerMap].map(([email,value])=>({email,...value})).sort((a,b)=>b.active-a.active||b.breaches-a.breaches||b.alerts-a.alerts||a.email.localeCompare(b.email));
  const reviewRows=rows.filter(row=>row.breached||Number(row.item.maximumEscalationLevel??0)>=3);const reviewCompleted=reviewRows.filter(row=>row.item.reviewStatus==="completed").length;const reviewPending=reviewRows.length-reviewCompleted;const recommendations:string[]=[];if(atRiskAlerts)recommendations.push(`期限接近・超過中の${atRiskAlerts}件へ担当を固定`);if(responseSlaRate<95)recommendations.push("対応開始SLAの遅延原因を上位ホットスポットから除去");if(acknowledgementSlaRate<95)recommendations.push("初動確認の通知・当番導線を再点検");if(reviewPending)recommendations.push(`再発防止レビュー未完了${reviewPending}件を期限内に完了`);if(!recommendations.length)recommendations.push("現行SLA運用を維持し、週次レビューを継続");
  return{period:{days:periodDays,startAt:new Date(startMs).toISOString(),endAt:new Date(nowMs).toISOString()},grade,score,totalAlerts:rows.length,criticalAlerts:rows.filter(row=>row.item.priority==="critical").length,resolvedAlerts:rows.filter(row=>row.item.status==="resolved").length,activeAlerts:rows.filter(row=>row.item.status!=="resolved").length,atRiskAlerts,breachedAlerts,acknowledgementSlaRate,responseSlaRate,averageAcknowledgementMinutes:average(rows.flatMap(row=>row.acknowledgementMinutes==null?[]:[row.acknowledgementMinutes])),averageResponseMinutes:average(rows.flatMap(row=>row.responseMinutes==null?[]:[row.responseMinutes])),averageResolutionMinutes:average(rows.flatMap(row=>row.resolutionMinutes==null?[]:[row.resolutionMinutes])),handoffCount:rows.reduce((total,row)=>total+Math.max(0,Number(row.item.handoffCount??0)),0),reviewRequired:reviewRows.length,reviewCompleted,reviewPending,daily,hotspots,ownerLoad,recommendations};
}

export function buildProductionEvidenceWeeklyReport(value:ProductionEvidenceSlaPerformance){
  const hotspot=value.hotspots[0];return[`# 本番SLA週次レポート`,`期間: ${value.period.startAt.slice(0,10)}〜${value.period.endAt.slice(0,10)}（${value.period.days}日）`,`総合評価: ${value.grade} / ${value.score}点`,`アラート: ${value.totalAlerts}件（CRITICAL ${value.criticalAlerts}件・解決 ${value.resolvedAlerts}件・対応中 ${value.activeAlerts}件）`,`SLA: 確認 ${value.acknowledgementSlaRate}% / 対応開始 ${value.responseSlaRate}% / 超過 ${value.breachedAlerts}件`,`平均: 確認 ${value.averageAcknowledgementMinutes}分 / 対応開始 ${value.averageResponseMinutes}分 / 解決 ${value.averageResolutionMinutes}分`,`引継ぎ: ${value.handoffCount}回`,`再発防止レビュー: 必須 ${value.reviewRequired}件 / 完了 ${value.reviewCompleted}件 / 未完了 ${value.reviewPending}件`,`最多要因: ${hotspot?`${hotspot.key}（${hotspot.alerts}件）`:"該当なし"}`,`次の一手: ${value.recommendations.join(" / ")}`].join("\n");
}

export function compareProductionEvidenceSlaWeeks(items:ProductionEvidenceAlertQueueItem[],nowMs=Date.now()):ProductionEvidenceSlaWeeklyComparison{
  const current=summarizeProductionEvidenceSlaPerformance(items,nowMs,7);const previousEndMs=Date.parse(current.period.startAt)-1;const previous=summarizeProductionEvidenceSlaPerformance(items,previousEndMs,7);const deltas={score:current.score-previous.score,acknowledgementSlaRate:current.acknowledgementSlaRate-previous.acknowledgementSlaRate,responseSlaRate:current.responseSlaRate-previous.responseSlaRate,totalAlerts:current.totalAlerts-previous.totalAlerts,breachedAlerts:current.breachedAlerts-previous.breachedAlerts,averageResolutionMinutes:roundDelta(current.averageResolutionMinutes-previous.averageResolutionMinutes),reviewPending:current.reviewPending-previous.reviewPending};
  const direction:ProductionEvidenceSlaWeeklyComparison["direction"]=deltas.score>=3||deltas.breachedAlerts<0&&deltas.score>=0?"improved":deltas.score<=-3||deltas.breachedAlerts>0&&deltas.score<=0?"declined":"stable";const headline=direction==="improved"?"前週よりSLA運用が改善しています":direction==="declined"?"前週よりSLA運用が低下しています":"前週と同水準を維持しています";const highlights:string[]=[];
  if(deltas.responseSlaRate)highlights.push(`対応開始SLA ${signed(deltas.responseSlaRate)}pt`);if(deltas.acknowledgementSlaRate)highlights.push(`確認SLA ${signed(deltas.acknowledgementSlaRate)}pt`);if(deltas.breachedAlerts)highlights.push(`超過 ${signed(deltas.breachedAlerts)}件`);if(deltas.averageResolutionMinutes)highlights.push(`平均解決 ${signed(deltas.averageResolutionMinutes)}分`);if(deltas.reviewPending)highlights.push(`レビュー未完了 ${signed(deltas.reviewPending)}件`);if(!highlights.length)highlights.push("主要指標に変化なし");
  return{current,previous,deltas,direction,headline,highlights};
}

export function buildProductionEvidenceWeeklyComparisonReport(value:ProductionEvidenceSlaWeeklyComparison){
  const current=buildProductionEvidenceWeeklyReport(value.current);return[`${current}`,"",`## 前週比較：${value.headline}`,`前週評価: ${value.previous.grade} / ${value.previous.score}点`,`差分: スコア ${signed(value.deltas.score)}点 / 確認 ${signed(value.deltas.acknowledgementSlaRate)}pt / 対応開始 ${signed(value.deltas.responseSlaRate)}pt / 超過 ${signed(value.deltas.breachedAlerts)}件 / 平均解決 ${signed(value.deltas.averageResolutionMinutes)}分`,`変化: ${value.highlights.join(" / ")}`].join("\n");
}

export function productionEvidenceWeekKey(nowMs=Date.now()){
  const start=tokyoDayStart(nowMs);const weekday=new Date(start+9*60*60_000).getUTCDay();const monday=start-((weekday+6)%7)*24*60*60_000;return tokyoDateKey(monday);
}

export function evaluateProductionEvidenceResponsibilityExecutiveDelivery(lastDeliveredWeekKey:string|null|undefined,nowMs=Date.now()):ProductionEvidenceResponsibilityExecutiveDelivery{
  const weekKey=productionEvidenceWeekKey(nowMs);const mondayStart=Date.parse(`${weekKey}T00:00:00+09:00`);const availableMs=mondayStart+33*60*60_000;const shouldDeliver=nowMs>=availableMs&&lastDeliveredWeekKey!==weekKey;const nextAvailableMs=lastDeliveredWeekKey===weekKey||nowMs>=availableMs?availableMs+7*24*60*60_000:availableMs;return{shouldDeliver,weekKey,availableAt:new Date(availableMs).toISOString(),nextScheduledAt:new Date(nextAvailableMs).toISOString(),deliveryKey:sha256({kind:"responsibility_executive",weekKey}).slice(0,24)};
}

export function evaluateProductionEvidenceWeeklyReportDelivery(lastDeliveredWeekKey:string|null|undefined,nowMs=Date.now()){
  const weekKey=productionEvidenceWeekKey(nowMs);const start=Date.parse(`${weekKey}T00:00:00+09:00`);const availableAt=start+9*60*60_000;const shouldDeliver=nowMs>=availableAt&&lastDeliveredWeekKey!==weekKey;const nextStart=lastDeliveredWeekKey===weekKey?start+7*24*60*60_000:availableAt>nowMs?start:start+7*24*60*60_000;return{shouldDeliver,weekKey,availableAt:new Date(availableAt).toISOString(),nextScheduledAt:new Date(nextStart+9*60*60_000).toISOString()};
}

export function evaluateProductionEvidenceAfterActionReviewReminder(input:ProductionEvidenceAfterActionReviewReminderInput,nowMs=Date.now()):ProductionEvidenceAfterActionReviewReminder{
  const dueMs=Date.parse(input.dueAt??"");if(input.status==="completed"||!Number.isFinite(dueMs))return{status:"none",shouldNotify:false,urgent:false,reminderKey:null,label:input.status==="completed"?"完了済み":"期限未設定",dueInHours:0,overdueDays:0,escalationLevel:0};
  const remaining=dueMs-nowMs;if(remaining>24*60*60_000)return{status:"none",shouldNotify:false,urgent:false,reminderKey:null,label:"期限まで24時間超",dueInHours:Math.ceil(remaining/3_600_000),overdueDays:0,escalationLevel:0};const status=remaining<0?"overdue" as const:"due_soon" as const;const overdueHours=status==="overdue"?Math.max(1,Math.ceil(-remaining/3_600_000)):0;const escalationLevel:0|1|2|3=status==="due_soon"?0:overdueHours>=72?3:overdueHours>=24?2:1;const dayKey=tokyoDateKey(nowMs);const reminderKey=`${status}_${escalationLevel}_${dayKey}`;const lastMs=Date.parse(input.lastReminderAt??"");const shouldNotify=!Number.isFinite(lastMs)||lastMs<tokyoDayStart(nowMs);const dueInHours=status==="due_soon"?Math.max(0,Math.ceil(remaining/3_600_000)):0;const overdueDays=status==="overdue"?Math.max(1,Math.ceil(-remaining/(24*60*60_000))):0;return{status,shouldNotify,urgent:status==="overdue",reminderKey,label:status==="overdue"?`LEVEL ${escalationLevel}・期限超過 ${overdueDays}日`:`期限まで ${dueInHours}時間`,dueInHours,overdueDays,escalationLevel};
}

export function evaluateProductionEvidenceWeeklyReportReadReminder(input:ProductionEvidenceWeeklyReportRecipient,nowMs=Date.now()):ProductionEvidenceWeeklyReportReadReminder{
  if(input.status==="read"||input.status==="proxy_read")return{status:"none",shouldNotify:false,urgent:false,reminderKey:null,escalationLevel:0,unreadHours:0,label:input.status==="proxy_read"?"代理確認済み":"既読"};const deliveredMs=Date.parse(input.deliveredAt??"");if(input.status==="unresolved"||!Number.isFinite(deliveredMs))return{status:"none",shouldNotify:false,urgent:false,reminderKey:null,escalationLevel:0,unreadHours:0,label:"配信先未解決"};const unreadHours=Math.max(0,Math.floor((nowMs-deliveredMs)/3_600_000));if(unreadHours<24)return{status:"waiting",shouldNotify:false,urgent:false,reminderKey:null,escalationLevel:0,unreadHours,label:`既読期限まで ${24-unreadHours}時間`};const previousCount=Math.max(0,Math.floor(Number(input.reminderCount??0)));if(previousCount>=3)return{status:"escalated",shouldNotify:false,urgent:true,reminderKey:null,escalationLevel:3,unreadHours,label:"LEVEL 3・未読継続"};const elapsedLevel:1|2|3=unreadHours>=72?3:unreadHours>=48?2:1;const escalationLevel=Math.max(elapsedLevel,Math.min(3,previousCount+1)) as 1|2|3;const lastMs=Date.parse(input.lastReminderAt??"");const shouldNotify=!Number.isFinite(lastMs)||lastMs<tokyoDayStart(nowMs);const reminderKey=`unread_${escalationLevel}_${tokyoDateKey(nowMs)}`;return{status:escalationLevel>=3?"escalated":"remind",shouldNotify,urgent:escalationLevel>=3,reminderKey,label:`LEVEL ${escalationLevel}・未読 ${unreadHours}時間`,escalationLevel,unreadHours};
}

export function evaluateProductionEvidenceExecutiveReportReadReminder(input:ProductionEvidenceWeeklyReportRecipient,nowMs=Date.now()):ProductionEvidenceWeeklyReportReadReminder{
  return evaluateProductionEvidenceWeeklyReportReadReminder(input,nowMs);
}

export function evaluateProductionEvidenceExecutiveDecisionTaskDeadline(input:Pick<ProductionEvidenceExecutiveDecisionTask,"status"|"dueAt"|"lastReminderAt">,nowMs=Date.now()):ProductionEvidenceExecutiveDecisionTaskDeadline{
  if(input.status==="completed")return{status:"none",shouldNotify:false,urgent:false,reminderKey:null,escalationLevel:0,remainingHours:0,overdueHours:0,label:"完了済み"};const dueMs=Date.parse(input.dueAt??"");if(!Number.isFinite(dueMs))return{status:"escalated",shouldNotify:true,urgent:true,reminderKey:`deadline_missing_${tokyoDateKey(nowMs)}`,escalationLevel:3,remainingHours:0,overdueHours:0,label:"LEVEL 3・期限未設定"};const remainingMs=dueMs-nowMs;const remainingHours=Math.max(0,Math.ceil(remainingMs/3_600_000));if(remainingMs>24*3_600_000)return{status:"none",shouldNotify:false,urgent:false,reminderKey:null,escalationLevel:0,remainingHours,overdueHours:0,label:`期限まで ${remainingHours}時間`};const lastMs=Date.parse(input.lastReminderAt??"");const shouldNotify=!Number.isFinite(lastMs)||lastMs<tokyoDayStart(nowMs);if(remainingMs>=0)return{status:"due_soon",shouldNotify,urgent:false,reminderKey:`due_soon_0_${tokyoDateKey(nowMs)}`,escalationLevel:0,remainingHours,overdueHours:0,label:`期限まで ${remainingHours}時間`};const overdueHours=Math.max(1,Math.ceil(-remainingMs/3_600_000));const escalationLevel:1|2|3=overdueHours>=72?3:overdueHours>=24?2:1;return{status:escalationLevel>=3?"escalated":"overdue",shouldNotify,urgent:escalationLevel>=3,reminderKey:`overdue_${escalationLevel}_${tokyoDateKey(nowMs)}`,escalationLevel,remainingHours:0,overdueHours,label:`LEVEL ${escalationLevel}・期限超過 ${overdueHours}時間`};
}

export function evaluateProductionEvidenceExecutiveDecisionOutcome(input:Pick<ProductionEvidenceExecutiveDecisionTask,"metricName"|"metricUnit"|"metricDirection"|"baselineValue"|"targetValue"|"actualValue"|"investmentYen"|"benefitYen">):ProductionEvidenceExecutiveDecisionOutcome{
  const direction=input.metricDirection??null;const baseline=Number(input.baselineValue);const target=Number(input.targetValue);const actual=Number(input.actualValue);const measured=Boolean(input.metricName&&input.metricUnit&&direction&&Number.isFinite(baseline)&&Number.isFinite(target)&&Number.isFinite(actual));const investmentYen=Math.max(0,Math.round(Number(input.investmentYen??0)));const benefitYen=Math.max(0,Math.round(Number(input.benefitYen??0)));const netBenefitYen=benefitYen-investmentYen;
  if(!measured)return{policyVersion:"outcome_v1",status:"unmeasured",metricName:null,unit:null,direction:null,baselineValue:null,targetValue:null,actualValue:null,improvementValue:0,improvementRate:0,targetAchievementRate:0,investmentYen,benefitYen,netBenefitYen,roiPercent:investmentYen?Math.round(netBenefitYen/investmentYen*1000)/10:null,score:0,label:"成果未入力"};
  const sign=direction==="increase"?1:-1;const improvementValue=Math.round((actual-baseline)*sign*10_000)/10_000;const targetGap=(target-baseline)*sign;const improvementRate=Math.round((Math.abs(baseline)>0?improvementValue/Math.abs(baseline)*100:improvementValue>0?100:improvementValue<0?-100:0)*10)/10;const targetAchievementRate=Math.round((targetGap>0?improvementValue/targetGap*100:0)*10)/10;const roiPercent=investmentYen?Math.round(netBenefitYen/investmentYen*1000)/10:null;const targetScore=Math.min(60,Math.max(0,targetAchievementRate)/2);const improvementScore=Math.min(15,Math.max(0,improvementRate)*.15);const roiScore=roiPercent===null?(benefitYen>0?25:12.5):Math.min(25,Math.max(0,(roiPercent+100)/12));const score=Math.round(Math.min(100,targetScore+improvementScore+roiScore));const status:ProductionEvidenceExecutiveDecisionOutcome["status"]=improvementValue<=0?"negative":score>=85&&targetAchievementRate>=100?"excellent":score>=65?"effective":"below_target";const label=status==="excellent"?`目標達成・ROI ${roiPercent===null?"算定外":`${roiPercent}%`}`:status==="effective"?`改善効果あり・${score}点`:status==="below_target"?`改善したが目標未達・${score}点`:`効果未達・${score}点`;return{policyVersion:"outcome_v1",status,metricName:String(input.metricName),unit:String(input.metricUnit),direction,baselineValue:baseline,targetValue:target,actualValue:actual,improvementValue,improvementRate,targetAchievementRate,investmentYen,benefitYen,netBenefitYen,roiPercent,score,label};
}

export function evaluateProductionEvidenceExecutiveDecisionRecovery(input:Pick<ProductionEvidenceExecutiveDecisionTask,"title"|"metricName"|"metricUnit"|"metricDirection"|"baselineValue"|"targetValue"|"actualValue"|"investmentYen"|"benefitYen"|"outcome"|"recoveryPlan">):ProductionEvidenceExecutiveDecisionRecoveryRecommendation{
  if(input.recoveryPlan)return{...input.recoveryPlan,status:"planned"};
  const outcome=input.outcome??evaluateProductionEvidenceExecutiveDecisionOutcome(input);
  if(outcome.status==="excellent"||outcome.status==="effective")return{policyVersion:"recovery_v1",status:"not_required",causeCode:"none",severity:"none",priority:"normal",dueDays:0,headline:"改善効果を確認",diagnosis:outcome.label,recommendedAction:"現行施策を標準化し、同じKPIで継続測定してください。",followUpTitle:""};
  if(outcome.status==="unmeasured")return{policyVersion:"recovery_v1",status:"required",causeCode:"measurement_gap",severity:"watch",priority:"high",dueDays:7,headline:"成果測定を設計",diagnosis:"完了後の実行前・目標・実績KPIが揃っていません。",recommendedAction:"KPI定義・測定期間・効果額の根拠を固定して再測定してください。",followUpTitle:`【成果再測定】${input.title}`};
  if(outcome.status==="negative")return{policyVersion:"recovery_v1",status:"required",causeCode:"execution_gap",severity:"critical",priority:"critical",dueDays:7,headline:"効果悪化を即時是正",diagnosis:`${outcome.metricName}が実行前から改善せず、目標達成率${outcome.targetAchievementRate}%です。`,recommendedAction:"実行手順・担当・投入資源を分解し、最も大きい阻害要因を除いて再実行してください。",followUpTitle:`【効果未達・再実行】${input.title}`};
  if(outcome.netBenefitYen<0||Number(outcome.roiPercent??0)<0)return{policyVersion:"recovery_v1",status:"required",causeCode:"economics_gap",severity:"critical",priority:"critical",dueDays:7,headline:"投資対効果を再設計",diagnosis:`純効果が${outcome.netBenefitYen}円、ROIが${outcome.roiPercent??0}%です。`,recommendedAction:"投資額を縮小するか効果額を高める施策へ組み替え、採算ラインを固定してください。",followUpTitle:`【ROI是正・再実行】${input.title}`};
  return{policyVersion:"recovery_v1",status:"required",causeCode:"process_gap",severity:"watch",priority:"high",dueDays:14,headline:"目標未達を再設計",diagnosis:`改善率${outcome.improvementRate}%、目標達成率${outcome.targetAchievementRate}%で到達不足です。`,recommendedAction:"実績と目標の差分を工程単位に分解し、期限・担当・確認点を追加して再実行してください。",followUpTitle:`【目標未達・改善実行】${input.title}`};
}

export function summarizeProductionEvidenceExecutiveDecisionTasks(items:ProductionEvidenceExecutiveDecisionTask[],nowMs=Date.now()):ProductionEvidenceExecutiveDecisionTaskSummary{
  const total=items.length;const completedItems=items.filter(item=>item.status==="completed");const completed=completedItems.length;const open=items.filter(item=>item.status==="open").length;const inProgress=items.filter(item=>item.status==="in_progress").length;const active=items.filter(item=>item.status!=="completed").map(item=>evaluateProductionEvidenceExecutiveDecisionTaskDeadline(item,nowMs));const overdue=active.filter(item=>item.status==="overdue"||item.status==="escalated").length;const dueSoon=active.filter(item=>item.status==="due_soon").length;const escalated=active.filter(item=>item.escalationLevel>=3).length;const onTimeCompleted=completedItems.filter(item=>{const completedMs=Date.parse(item.completedAt??"");const dueMs=Date.parse(item.dueAt??"");return Number.isFinite(completedMs)&&Number.isFinite(dueMs)&&completedMs<=dueMs;}).length;const completionHours=completedItems.map(item=>{const createdMs=Date.parse(item.createdAt??"");const completedMs=Date.parse(item.completedAt??"");return Number.isFinite(createdMs)&&Number.isFinite(completedMs)?Math.max(0,(completedMs-createdMs)/3_600_000):null;}).filter((value):value is number=>value!==null);const outcomes=completedItems.map(item=>item.outcome??evaluateProductionEvidenceExecutiveDecisionOutcome(item));const measuredOutcomes=outcomes.filter(item=>item.status!=="unmeasured");const measured=measuredOutcomes.length;const unmeasuredCompleted=completed-measured;const effective=measuredOutcomes.filter(item=>item.status==="effective"||item.status==="excellent").length;const positiveRoi=measuredOutcomes.filter(item=>item.roiPercent!==null&&item.roiPercent>0).length;const totalInvestmentYen=measuredOutcomes.reduce((sum,item)=>sum+item.investmentYen,0);const totalBenefitYen=measuredOutcomes.reduce((sum,item)=>sum+item.benefitYen,0);const netBenefitYen=totalBenefitYen-totalInvestmentYen;const portfolioRoiPercent=totalInvestmentYen?Math.round(netBenefitYen/totalInvestmentYen*1000)/10:null;const averageOutcomeScore=measuredOutcomes.length?Math.round(measuredOutcomes.reduce((sum,item)=>sum+item.score,0)/measuredOutcomes.length):0;const outcomeMeasurementRate=percentage(measured,completed);const completionRate=percentage(completed,total);const onTimeCompletionRate=percentage(onTimeCompleted,completed);const averageCompletionHours=completionHours.length?Math.round(completionHours.reduce((sum,value)=>sum+value,0)/completionHours.length*10)/10:0;const negative=measuredOutcomes.filter(item=>item.status==="negative").length;const headline=!total?"経営判断タスク待ち":escalated?`LEVEL 3未完了 ${escalated}件を即時対応`:overdue?`期限超過 ${overdue}件を優先対応`:completionRate===100?"経営判断タスクは全件完了":`完了率 ${completionRate}%・未完了 ${total-completed}件`;const outcomeHeadline=!completed?"完了後の成果測定待ち":unmeasuredCompleted?`完了 ${unmeasuredCompleted}件の成果入力待ち`:negative?`効果未達 ${negative}件を再評価`:portfolioRoiPercent!==null?`実行効果 ${averageOutcomeScore}点・ROI ${portfolioRoiPercent}%`:`実行効果 ${averageOutcomeScore}点・金額効果を継続測定`;return{total,open,inProgress,completed,overdue,dueSoon,escalated,completionRate,onTimeCompleted,onTimeCompletionRate,averageCompletionHours,measured,unmeasuredCompleted,outcomeMeasurementRate,effective,positiveRoi,averageOutcomeScore,totalInvestmentYen,totalBenefitYen,netBenefitYen,portfolioRoiPercent,outcomeHeadline,headline};
}

export function buildProductionEvidenceExecutiveDecisionTasksCsv(items:ProductionEvidenceExecutiveDecisionTask[],nowMs=Date.now()){
  const header=["week_key","task_id","priority","status","owner_email","due_at","deadline_status","escalation_level","completed_at","completed_by_email","title","completion_note","metric_name","metric_unit","direction","baseline","target","actual","improvement","improvement_rate","target_achievement_rate","investment_yen","benefit_yen","net_benefit_yen","roi_percent","outcome_score","outcome_status","measured_at","measured_by_email","outcome_note","recovery_status","recovery_cause","recovery_severity","recovery_due_days","recovery_action","recovery_task_id"];const rows=items.map(item=>{const deadline=evaluateProductionEvidenceExecutiveDecisionTaskDeadline(item,nowMs);const outcome=item.outcome??evaluateProductionEvidenceExecutiveDecisionOutcome(item);const recovery=evaluateProductionEvidenceExecutiveDecisionRecovery(item);return[item.weekKey,item.taskId,item.priority,item.status,item.ownerEmail??"",item.dueAt??"",deadline.status,deadline.escalationLevel,item.completedAt??"",item.completedByEmail??"",item.title,item.completionNote??"",outcome.metricName??"",outcome.unit??"",outcome.direction??"",outcome.baselineValue??"",outcome.targetValue??"",outcome.actualValue??"",outcome.improvementValue,outcome.improvementRate,outcome.targetAchievementRate,outcome.investmentYen,outcome.benefitYen,outcome.netBenefitYen,outcome.roiPercent??"",outcome.score,outcome.status,item.measuredAt??"",item.measuredByEmail??"",item.outcomeNote??"",recovery.status,recovery.causeCode,recovery.severity,recovery.dueDays,recovery.recommendedAction,item.recoveryTaskId??""];});const cell=(value:string|number)=>{let text=String(value);if(/^[=+\-@]/u.test(text))text=`'${text}`;return`"${text.replaceAll('"','""')}"`;};return`\uFEFF${[header,...rows].map(row=>row.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function evaluateProductionEvidenceWeeklyReportResponsibility(input:ProductionEvidenceWeeklyReportRecipient,nowMs=Date.now()):ProductionEvidenceWeeklyResponsibility{
  if(input.status==="read"||input.status==="proxy_read")return{status:"complete",riskScore:0,slaDueAt:null,hoursRemaining:0,overdueHours:0,shouldAssign:false,requiresApproval:false,label:input.status==="proxy_read"?"代理確認済み":"本人確認済み"};
  const deliveredMs=Date.parse(input.deliveredAt??"");const assigned=Boolean(input.assignedToEmail);const requiresApproval=assigned&&input.approvalStatus!=="approved";
  if(!Number.isFinite(deliveredMs))return{status:"at_risk",riskScore:100,slaDueAt:null,hoursRemaining:0,overdueHours:0,shouldAssign:!assigned,requiresApproval,label:"配信時刻不明・即時担当割当"};
  const dueMs=deliveredMs+24*60*60_000;const remainingMs=dueMs-nowMs;const hoursRemaining=Math.max(0,Math.ceil(remainingMs/3_600_000));const overdueHours=Math.max(0,Math.ceil(-remainingMs/3_600_000));const elapsedHours=Math.max(0,Math.floor((nowMs-deliveredMs)/3_600_000));
  if(remainingMs<=0)return{status:"overdue",riskScore:100,slaDueAt:new Date(dueMs).toISOString(),hoursRemaining:0,overdueHours,shouldAssign:!assigned,requiresApproval,label:`既読SLA ${overdueHours}時間超過`};
  if(input.status==="unresolved")return{status:"at_risk",riskScore:95,slaDueAt:new Date(dueMs).toISOString(),hoursRemaining,overdueHours:0,shouldAssign:!assigned,requiresApproval,label:`配信先未解決・残り${hoursRemaining}時間`};
  const status:ProductionEvidenceWeeklyResponsibility["status"]=elapsedHours>=20?"at_risk":elapsedHours>=12?"watch":"safe";const riskScore=status==="at_risk"?85:status==="watch"?55:Math.min(40,Math.round(elapsedHours/20*40));return{status,riskScore,slaDueAt:new Date(dueMs).toISOString(),hoursRemaining,overdueHours:0,shouldAssign:status==="at_risk"&&!assigned,requiresApproval,label:status==="at_risk"?`期限超過予測・残り${hoursRemaining}時間`:status==="watch"?`要監視・残り${hoursRemaining}時間`:`正常・残り${hoursRemaining}時間`};
}

export function evaluateProductionEvidenceWeeklyResponsibilityReassignment(input:ProductionEvidenceWeeklyReportRecipient,nowMs=Date.now()):ProductionEvidenceWeeklyResponsibilityReassignment{
  const reassignmentCount=Math.max(0,Math.floor(Number(input.reassignmentCount??0)));if(input.status==="read"||input.status==="proxy_read"||input.approvalStatus==="approved"||!input.assignedToEmail)return{status:"none",shouldReassign:false,shouldEscalate:false,urgent:false,remainingMinutes:0,overdueMinutes:0,reassignmentCount,escalationKey:null,label:input.approvalStatus==="approved"?"責任者承認済み":"再割当不要"};
  const deadlineMs=Date.parse(input.approvalDeadlineAt??"");const valid=Number.isFinite(deadlineMs);const remaining=valid?deadlineMs-nowMs:-1;if(remaining>0)return{status:"waiting",shouldReassign:false,shouldEscalate:false,urgent:false,remainingMinutes:Math.ceil(remaining/60_000),overdueMinutes:0,reassignmentCount,escalationKey:null,label:`責任者承認まで${Math.ceil(remaining/60_000)}分`};
  const overdueMinutes=valid?Math.max(1,Math.ceil(-remaining/60_000)):0;const exhausted=reassignmentCount>=2;const status=exhausted?"escalated" as const:"expired" as const;return{status,shouldReassign:!exhausted,shouldEscalate:exhausted,urgent:true,remainingMinutes:0,overdueMinutes,reassignmentCount,escalationKey:exhausted?`approval_exhausted_${reassignmentCount}`:null,label:exhausted?`再割当上限・責任者承認${overdueMinutes}分超過`:`責任者承認${overdueMinutes}分超過・自動再割当`};
}

export function rankProductionEvidenceWeeklyResponsibilityOwners(recipientEmail:string,weekKey:string,adminEmails:string[],activeLoads:Record<string,number>={},excludedEmails:string[]=[]):ProductionEvidenceWeeklyOwnerRanking{const recipient=recipientEmail.trim().toLowerCase();const excluded=new Set(excludedEmails.map(value=>value.trim().toLowerCase()).filter(Boolean));const candidates=[...new Set(adminEmails.map(value=>value.trim().toLowerCase()).filter(value=>value&&value!==recipient&&!excluded.has(value)))].map(email=>({email,activeAssignments:Math.max(0,Math.floor(Number(activeLoads[email]??0))),tieBreaker:sha256({recipient,weekKey,email}).slice(0,12)})).sort((left,right)=>left.activeAssignments-right.activeAssignments||left.tieBreaker.localeCompare(right.tieBreaker)||left.email.localeCompare(right.email));return{primary:candidates[0]?.email??null,backup:candidates[1]?.email??null,candidates};}

export function selectProductionEvidenceWeeklyResponsibilityOwner(recipientEmail:string,weekKey:string,adminEmails:string[]){return rankProductionEvidenceWeeklyResponsibilityOwners(recipientEmail,weekKey,adminEmails).primary;}

export function summarizeProductionEvidenceWeeklyReportRecipients(items:ProductionEvidenceWeeklyReportRecipient[]){const total=items.length;const proxyRead=items.filter(item=>item.status==="proxy_read").length;const read=items.filter(item=>item.status==="read"||item.status==="proxy_read").length;const unresolved=items.filter(item=>item.status==="unresolved").length;const unread=total-read-unresolved;const escalated=items.filter(item=>Number(item.escalationLevel??0)>=3&&item.status!=="read"&&item.status!=="proxy_read").length;const assigned=items.filter(item=>Boolean(item.assignedToEmail)&&item.status!=="read"&&item.status!=="proxy_read").length;const backedUp=items.filter(item=>Boolean(item.backupToEmail)&&item.status!=="read"&&item.status!=="proxy_read").length;const pendingApproval=items.filter(item=>item.approvalStatus==="pending"&&item.status!=="read"&&item.status!=="proxy_read").length;const approved=items.filter(item=>item.approvalStatus==="approved"&&item.status!=="read"&&item.status!=="proxy_read").length;const reassigned=items.filter(item=>Number(item.reassignmentCount??0)>0&&item.status!=="read"&&item.status!=="proxy_read").length;const approvalExpired=items.filter(item=>item.approvalFlowStatus==="expired"||item.approvalFlowStatus==="escalated").length;const atRisk=items.filter(item=>item.responsibilityStatus==="at_risk"||item.responsibilityStatus==="overdue").length;const overdue=items.filter(item=>item.responsibilityStatus==="overdue").length;return{total,read,proxyRead,unread,unresolved,escalated,assigned,backedUp,pendingApproval,approved,reassigned,approvalExpired,atRisk,overdue,readRate:total?Math.round(read/total*100):100};}

export function summarizeProductionEvidenceWeeklyResponsibilityAnalytics(items:Array<ProductionEvidenceWeeklyReportRecipient&{weekKey:string}>):ProductionEvidenceWeeklyResponsibilityAnalytics{
  const weekKeys=[...new Set(items.map(item=>item.weekKey).filter(Boolean))].sort().slice(-8);const weekSet=new Set(weekKeys);const scoped=items.filter(item=>weekSet.has(item.weekKey));type WeekValue={weekKey:string;assigned:number;approved:number;reassigned:number;reassignmentSuccess:number;escalated:number};type OwnerValue={email:string;primary:number;backup:number;reassignedIn:number;approved:number;pending:number;approvalMinutes:number[];weeks:Map<string,{weekKey:string;primary:number;backup:number;reassigned:number;approved:number}>};const weekMap=new Map(weekKeys.map(weekKey=>[weekKey,{weekKey,assigned:0,approved:0,reassigned:0,reassignmentSuccess:0,escalated:0} as WeekValue]));const ownerMap=new Map<string,OwnerValue>();const approvalMinutes:number[]=[];let assignedTotal=0,approvedTotal=0,pendingTotal=0,onTimeApprovedTotal=0,reassignmentTotal=0,reassignmentSuccessTotal=0,escalatedTotal=0;
  const ownerValue=(email:string)=>{const normalized=email.trim().toLowerCase();let value=ownerMap.get(normalized);if(!value){value={email:normalized,primary:0,backup:0,reassignedIn:0,approved:0,pending:0,approvalMinutes:[],weeks:new Map()};ownerMap.set(normalized,value);}return value;};const ownerWeek=(owner:OwnerValue,weekKey:string)=>{let value=owner.weeks.get(weekKey);if(!value){value={weekKey,primary:0,backup:0,reassigned:0,approved:0};owner.weeks.set(weekKey,value);}return value;};
  for(const item of scoped){const week=weekMap.get(item.weekKey)!;const owner=String(item.assignedToEmail??"").trim().toLowerCase();const backup=String(item.backupToEmail??"").trim().toLowerCase();const previous=[...new Set((item.previousAssignedToEmails??[]).map(value=>value.trim().toLowerCase()).filter(Boolean))];const reassignmentCount=Math.max(0,Math.floor(Number(item.reassignmentCount??0)));const reassigned=reassignmentCount>0;const approved=item.approvalStatus==="approved";const escalated=Boolean(item.assignmentEscalationKey)||item.approvalFlowStatus==="escalated";const outcomeComplete=approved||item.status==="read"||item.status==="proxy_read";const reassignmentSuccess=reassigned&&outcomeComplete&&!escalated;
    if(owner){assignedTotal++;week.assigned++;const current=ownerValue(owner);current.primary++;ownerWeek(current,item.weekKey).primary++;if(reassigned){current.reassignedIn++;ownerWeek(current,item.weekKey).reassigned++;}if(approved){approvedTotal++;week.approved++;current.approved++;ownerWeek(current,item.weekKey).approved++;const startMs=Date.parse((reassigned?item.lastReassignedAt:item.assignedAt)??item.assignedAt??"");const approvedMs=Date.parse(item.approvedAt??"");if(Number.isFinite(startMs)&&Number.isFinite(approvedMs)){const minutes=Math.max(0,Math.ceil((approvedMs-startMs)/60_000));approvalMinutes.push(minutes);current.approvalMinutes.push(minutes);}const deadlineMs=Date.parse(item.approvalDeadlineAt??"");if(Number.isFinite(approvedMs)&&Number.isFinite(deadlineMs)&&approvedMs<=deadlineMs)onTimeApprovedTotal++;}else if(item.approvalStatus==="pending"){pendingTotal++;current.pending++;}}
    for(const previousOwner of previous){if(previousOwner===owner)continue;const value=ownerValue(previousOwner);value.primary++;ownerWeek(value,item.weekKey).primary++;}
    if(backup&&backup!==owner){const value=ownerValue(backup);value.backup++;ownerWeek(value,item.weekKey).backup++;}
    if(reassigned){reassignmentTotal++;week.reassigned++;if(reassignmentSuccess){reassignmentSuccessTotal++;week.reassignmentSuccess++;}}
    if(escalated){escalatedTotal++;week.escalated++;}
  }
  const average=(values:number[])=>values.length?Math.round(values.reduce((sum,value)=>sum+value,0)/values.length):0;const owners=[...ownerMap.values()].map(owner=>({email:owner.email,primary:owner.primary,backup:owner.backup,reassignedIn:owner.reassignedIn,approved:owner.approved,pending:owner.pending,averageApprovalMinutes:average(owner.approvalMinutes),weeks:weekKeys.map(weekKey=>owner.weeks.get(weekKey)??{weekKey,primary:0,backup:0,reassigned:0,approved:0})})).sort((left,right)=>right.primary-left.primary||right.backup-left.backup||left.email.localeCompare(right.email));const loads=owners.map(owner=>owner.primary);const loadSpread=loads.length?Math.max(...loads)-Math.min(...loads):0;const sortedApproval=[...approvalMinutes].sort((left,right)=>left-right);const p95ApprovalMinutes=sortedApproval.length?sortedApproval[Math.max(0,Math.ceil(sortedApproval.length*.95)-1)]!:0;const approvalRate=assignedTotal?Math.round(approvedTotal/assignedTotal*100):100;const onTimeApprovalRate=approvedTotal?Math.round(onTimeApprovedTotal/approvedTotal*100):100;const reassignmentSuccessRate=reassignmentTotal?Math.round(reassignmentSuccessTotal/reassignmentTotal*100):100;const weeks=weekKeys.map(weekKey=>{const value=weekMap.get(weekKey)!;return{...value,approvalRate:value.assigned?Math.round(value.approved/value.assigned*100):100,reassignmentSuccessRate:value.reassigned?Math.round(value.reassignmentSuccess/value.reassigned*100):100};});const recommendations:string[]=[];if(approvalRate<90)recommendations.push(`責任者承認率を${approvalRate}%から90%以上へ改善`);if(onTimeApprovalRate<80)recommendations.push(`期限内承認率${onTimeApprovalRate}%・期限前フォローを強化`);if(loadSpread>2)recommendations.push(`担当差${loadSpread}件・高負荷担当から再配分`);if(reassignmentTotal>0&&reassignmentSuccessRate<70)recommendations.push(`再割当成功率${reassignmentSuccessRate}%・副担当候補を追加`);if(escalatedTotal>0)recommendations.push(`管理者緊急移管${escalatedTotal}件の原因を確認`);if(!recommendations.length)recommendations.push("負荷分散と承認運用は基準内・現行ポリシーを維持");const headline=escalatedTotal?`管理者緊急移管 ${escalatedTotal}件を優先改善`:onTimeApprovalRate>=90&&loadSpread<=1?"担当負荷と承認速度は安定":"承認遅延または担当偏りを改善";return{weeks,owners,assignedTotal,approvedTotal,pendingTotal,approvalRate,onTimeApprovedTotal,onTimeApprovalRate,averageApprovalMinutes:average(approvalMinutes),p95ApprovalMinutes,reassignmentTotal,reassignmentSuccessTotal,reassignmentSuccessRate,escalatedTotal,loadSpread,headline,recommendations};
}

export function productionEvidenceResponsibilityAlertThresholds():ProductionEvidenceResponsibilityAlertThresholds{
  return{approvalRateMin:90,onTimeApprovalRateMin:80,p95ApprovalMinutesMax:120,reassignmentSuccessRateMin:70,escalatedTotalMax:0,loadSpreadMax:2,pendingRateMax:20};
}

export function evaluateProductionEvidenceResponsibilityAnalyticsAlerts(analytics:ProductionEvidenceWeeklyResponsibilityAnalytics,custom:Partial<ProductionEvidenceResponsibilityAlertThresholds>={}):ProductionEvidenceResponsibilityAnalyticsAlertSummary{
  const defaults=productionEvidenceResponsibilityAlertThresholds();const number=(value:unknown,fallback:number)=>Number.isFinite(Number(value))?Math.max(0,Math.round(Number(value))):fallback;const thresholds:ProductionEvidenceResponsibilityAlertThresholds={approvalRateMin:number(custom.approvalRateMin,defaults.approvalRateMin),onTimeApprovalRateMin:number(custom.onTimeApprovalRateMin,defaults.onTimeApprovalRateMin),p95ApprovalMinutesMax:number(custom.p95ApprovalMinutesMax,defaults.p95ApprovalMinutesMax),reassignmentSuccessRateMin:number(custom.reassignmentSuccessRateMin,defaults.reassignmentSuccessRateMin),escalatedTotalMax:number(custom.escalatedTotalMax,defaults.escalatedTotalMax),loadSpreadMax:number(custom.loadSpreadMax,defaults.loadSpreadMax),pendingRateMax:number(custom.pendingRateMax,defaults.pendingRateMax)};const alerts:ProductionEvidenceResponsibilityAnalyticsAlert[]=[];const add=(value:ProductionEvidenceResponsibilityAnalyticsAlert)=>alerts.push(value);const pendingRate=analytics.assignedTotal?Math.round(analytics.pendingTotal/analytics.assignedTotal*100):0;
  if(analytics.assignedTotal&&analytics.approvalRate<thresholds.approvalRateMin){const gap=thresholds.approvalRateMin-analytics.approvalRate;add({key:"approval_rate_low",severity:gap>=15?"critical":"warning",metric:"approvalRateMin",operator:"min",current:analytics.approvalRate,threshold:thresholds.approvalRateMin,title:"責任承認率が基準未達",message:`責任承認率 ${analytics.approvalRate}%（基準 ${thresholds.approvalRateMin}%以上）`,action:"未承認案件の主担当を当日中に固定"});}
  if(analytics.approvedTotal&&analytics.onTimeApprovalRate<thresholds.onTimeApprovalRateMin){const gap=thresholds.onTimeApprovalRateMin-analytics.onTimeApprovalRate;add({key:"on_time_approval_low",severity:gap>=15?"critical":"warning",metric:"onTimeApprovalRateMin",operator:"min",current:analytics.onTimeApprovalRate,threshold:thresholds.onTimeApprovalRateMin,title:"期限内承認率が基準未達",message:`期限内承認 ${analytics.onTimeApprovalRate}%（基準 ${thresholds.onTimeApprovalRateMin}%以上）`,action:"承認期限30分前の主担当・副担当通知を確認"});}
  if(analytics.approvedTotal&&analytics.p95ApprovalMinutes>thresholds.p95ApprovalMinutesMax){add({key:"p95_approval_delay",severity:analytics.p95ApprovalMinutes>=thresholds.p95ApprovalMinutesMax*1.5?"critical":"warning",metric:"p95ApprovalMinutesMax",operator:"max",current:analytics.p95ApprovalMinutes,threshold:thresholds.p95ApprovalMinutesMax,title:"承認時間P95が基準超過",message:`P95 ${analytics.p95ApprovalMinutes}分（基準 ${thresholds.p95ApprovalMinutesMax}分以内）`,action:"遅延上位担当の割当数を翌週から1件減らす"});}
  if(analytics.reassignmentTotal&&analytics.reassignmentSuccessRate<thresholds.reassignmentSuccessRateMin){const gap=thresholds.reassignmentSuccessRateMin-analytics.reassignmentSuccessRate;add({key:"reassignment_success_low",severity:gap>=20?"critical":"warning",metric:"reassignmentSuccessRateMin",operator:"min",current:analytics.reassignmentSuccessRate,threshold:thresholds.reassignmentSuccessRateMin,title:"再割当成功率が基準未達",message:`再割当成功 ${analytics.reassignmentSuccessRate}%（基準 ${thresholds.reassignmentSuccessRateMin}%以上）`,action:"副担当候補と引継ぎ期限を再設定"});}
  if(analytics.escalatedTotal>thresholds.escalatedTotalMax)add({key:"emergency_handoff_detected",severity:"critical",metric:"escalatedTotalMax",operator:"max",current:analytics.escalatedTotal,threshold:thresholds.escalatedTotalMax,title:"管理者緊急移管を検知",message:`緊急移管 ${analytics.escalatedTotal}件（許容 ${thresholds.escalatedTotalMax}件）`,action:"緊急移管案件の原因・責任者・再発防止期限を固定"});
  if(analytics.loadSpread>thresholds.loadSpreadMax)add({key:"owner_load_imbalance",severity:analytics.loadSpread-thresholds.loadSpreadMax>=3?"critical":"warning",metric:"loadSpreadMax",operator:"max",current:analytics.loadSpread,threshold:thresholds.loadSpreadMax,title:"担当負荷に偏り",message:`担当差 ${analytics.loadSpread}件（基準 ${thresholds.loadSpreadMax}件以内）`,action:"高負荷担当から低負荷担当へ翌週割当を再配分"});
  if(pendingRate>thresholds.pendingRateMax)add({key:"pending_rate_high",severity:pendingRate-thresholds.pendingRateMax>=20?"critical":"warning",metric:"pendingRateMax",operator:"max",current:pendingRate,threshold:thresholds.pendingRateMax,title:"承認待ち比率が基準超過",message:`承認待ち ${pendingRate}%（基準 ${thresholds.pendingRateMax}%以内）`,action:"承認待ちを期限順に並べ、主担当へ即時通知"});
  alerts.sort((left,right)=>(right.severity==="critical"?2:1)-(left.severity==="critical"?2:1)||left.key.localeCompare(right.key));const critical=alerts.filter(alert=>alert.severity==="critical").length;const warning=alerts.length-critical;const status:ProductionEvidenceResponsibilityAnalyticsAlertSummary["status"]=critical?"critical":warning?"watch":"healthy";const riskScore=Math.min(100,critical*25+warning*12);const headline=status==="critical"?`重大アラート ${critical}件・経営判断が必要`:status==="watch"?`改善アラート ${warning}件を検知`:"全指標が自動基準内";const fingerprint=sha256({policyVersion:"auto_v1",thresholds,alerts:alerts.map(({key,severity,current,threshold})=>({key,severity,current,threshold}))});return{policyVersion:"auto_v1",status,riskScore,thresholds,alerts,headline,fingerprint};
}

export function buildProductionEvidenceResponsibilityExecutiveDigest(analytics:ProductionEvidenceWeeklyResponsibilityAnalytics,alertSummary=evaluateProductionEvidenceResponsibilityAnalyticsAlerts(analytics),nowMs=Date.now()):ProductionEvidenceResponsibilityExecutiveDigest{
  const current=analytics.weeks.at(-1);const previous=analytics.weeks.at(-2);const approvalDelta=current&&previous?current.approvalRate-previous.approvalRate:null;const reassignmentDelta=current&&previous?current.reassignmentSuccessRate-previous.reassignmentSuccessRate:null;const severityByKey=new Map(alertSummary.alerts.map(alert=>[alert.key,alert.severity]));const metricStatus=(keys:string[]):"good"|"watch"|"critical"=>keys.some(key=>severityByKey.get(key)==="critical")?"critical":keys.some(key=>severityByKey.get(key)==="warning")?"watch":"good";const kpis:ProductionEvidenceResponsibilityExecutiveDigest["kpis"]=[{key:"approval",label:"責任承認率",value:`${analytics.approvalRate}%`,delta:approvalDelta,status:metricStatus(["approval_rate_low","pending_rate_high"])},{key:"on_time",label:"期限内承認",value:`${analytics.onTimeApprovalRate}%`,delta:null,status:metricStatus(["on_time_approval_low"])},{key:"p95",label:"承認P95",value:`${analytics.p95ApprovalMinutes}分`,delta:null,status:metricStatus(["p95_approval_delay"])},{key:"reassignment",label:"再割当成功",value:`${analytics.reassignmentSuccessRate}%`,delta:reassignmentDelta,status:metricStatus(["reassignment_success_low","emergency_handoff_detected"])},{key:"load",label:"担当差",value:`${analytics.loadSpread}件`,delta:null,status:metricStatus(["owner_load_imbalance"])}];const wins:string[]=[];if(analytics.approvalRate>=alertSummary.thresholds.approvalRateMin)wins.push(`責任承認率${analytics.approvalRate}%で基準達成`);if(analytics.onTimeApprovalRate>=alertSummary.thresholds.onTimeApprovalRateMin)wins.push(`期限内承認率${analytics.onTimeApprovalRate}%で基準達成`);if(analytics.reassignmentTotal&&analytics.reassignmentSuccessRate>=alertSummary.thresholds.reassignmentSuccessRateMin)wins.push(`再割当成功率${analytics.reassignmentSuccessRate}%で基準達成`);if(!analytics.escalatedTotal)wins.push("管理者緊急移管0件");if(!wins.length)wins.push("8週分の責任運用データを継続取得中");const risks=alertSummary.alerts.map(alert=>alert.message);const decisions=[...new Set(alertSummary.alerts.map(alert=>alert.action))].slice(0,4);if(!decisions.length)decisions.push("現行の担当負荷・承認期限ポリシーを維持");const summary=alertSummary.status==="critical"?`重大指標を${alertSummary.alerts.filter(alert=>alert.severity==="critical").length}件検知。今週中の責任者判断が必要です。`:alertSummary.status==="watch"?`改善対象を${alertSummary.alerts.length}件検知。次週割当前に調整してください。`:"主要指標は基準内です。現行運用を維持してください。";const period={startWeek:analytics.weeks.at(0)?.weekKey??null,endWeek:current?.weekKey??null,weeks:analytics.weeks.length};const generatedAt=new Date(nowMs).toISOString();const lines=["# 週次責任運用エグゼクティブレポート",`対象: ${period.startWeek??"—"}〜${period.endWeek??"—"}（${period.weeks}週）`,`判定: ${alertSummary.status.toUpperCase()} / RISK ${alertSummary.riskScore}`,`要約: ${summary}`,"",`## KPI`,`責任承認率 ${analytics.approvalRate}% / 期限内承認 ${analytics.onTimeApprovalRate}% / 承認P95 ${analytics.p95ApprovalMinutes}分`,`再割当成功 ${analytics.reassignmentSuccessRate}% / 緊急移管 ${analytics.escalatedTotal}件 / 担当差 ${analytics.loadSpread}件`,"",`## 成果`,...wins.map(value=>`- ${value}`),"",`## リスク`,...(risks.length?risks:["該当なし"]).map(value=>`- ${value}`),"",`## 経営判断`,...decisions.map(value=>`- ${value}`)];return{generatedAt,period,status:alertSummary.status,headline:alertSummary.headline,summary,kpis,wins,risks,decisions,markdown:lines.join("\n")};
}

export function buildProductionEvidenceResponsibilityAnalyticsCsv(analytics:ProductionEvidenceWeeklyResponsibilityAnalytics,alertSummary=evaluateProductionEvidenceResponsibilityAnalyticsAlerts(analytics)){
  const header=["record_type","week_key","owner_email","metric","assigned","approved","pending","primary","backup","reassigned","escalated","value","severity","note"];const rows:Array<Array<string|number>>=[];rows.push(["summary","","","approval_rate",analytics.assignedTotal,analytics.approvedTotal,analytics.pendingTotal,"","",analytics.reassignmentTotal,analytics.escalatedTotal,analytics.approvalRate,alertSummary.status,analytics.headline]);rows.push(["summary","","","on_time_approval_rate",analytics.assignedTotal,analytics.onTimeApprovedTotal,analytics.pendingTotal,"","",analytics.reassignmentTotal,analytics.escalatedTotal,analytics.onTimeApprovalRate,alertSummary.status,"期限内承認率"]);rows.push(["summary","","","p95_approval_minutes",analytics.assignedTotal,analytics.approvedTotal,analytics.pendingTotal,"","",analytics.reassignmentTotal,analytics.escalatedTotal,analytics.p95ApprovalMinutes,alertSummary.status,"承認時間P95"]);for(const week of analytics.weeks)rows.push(["week",week.weekKey,"","weekly_outcome",week.assigned,week.approved,"","","",week.reassigned,week.escalated,week.approvalRate,"",`再割当成功率 ${week.reassignmentSuccessRate}%`]);for(const owner of analytics.owners){rows.push(["owner","",owner.email,"owner_total","",owner.approved,owner.pending,owner.primary,owner.backup,owner.reassignedIn,"",owner.averageApprovalMinutes,"","平均承認分"]);for(const week of owner.weeks)rows.push(["owner_week",week.weekKey,owner.email,"owner_load","",week.approved,"",week.primary,week.backup,week.reassigned,"",week.primary+week.backup,"",""]);}for(const alert of alertSummary.alerts)rows.push(["alert","","",alert.key,"","","","","","","",alert.current,alert.severity,`${alert.message} / ${alert.action}`]);const cell=(value:string|number)=>{let text=String(value);if(/^[=+\-@]/u.test(text))text=`'${text}`;return`"${text.replaceAll('"','""')}"`;};return`\uFEFF${[header,...rows].map(row=>row.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function summarizeProductionEvidenceWeeklyReadTrend(items:ProductionEvidenceWeeklyReadTrendPoint[]):ProductionEvidenceWeeklyReadTrend{
  const points=[...items].sort((left,right)=>left.weekKey.localeCompare(right.weekKey)).slice(-8);const current=points.at(-1);const previous=points.at(-2);const currentReadRate=current?.readRate??100;const previousReadRate=previous?.readRate??currentReadRate;const delta=currentReadRate-previousReadRate;const direction:ProductionEvidenceWeeklyReadTrend["direction"]=delta>0?"improved":delta<0?"declined":"stable";const averageReadRate=points.length?Math.round(points.reduce((sum,item)=>sum+item.readRate,0)/points.length):100;const proxyReadTotal=points.reduce((sum,item)=>sum+item.proxyRead,0);const unresolvedTotal=points.reduce((sum,item)=>sum+item.unresolved,0);const headline=direction==="improved"?`前週より既読率が${delta}pt改善`:direction==="declined"?`前週より既読率が${Math.abs(delta)}pt低下`:"前週と同じ既読率";return{points,currentReadRate,previousReadRate,delta,direction,averageReadRate,proxyReadTotal,unresolvedTotal,headline};
}

export function summarizeProductionEvidenceExecutiveReportHistory(items:ProductionEvidenceExecutiveReportHistoryPoint[]):ProductionEvidenceExecutiveReportHistory{
  const points=[...items].sort((left,right)=>right.weekKey.localeCompare(left.weekKey)).slice(0,8);const current=points[0];const averageReadRate=points.length?Math.round(points.reduce((sum,item)=>sum+item.readRate,0)/points.length):100;const readTotal=points.reduce((sum,item)=>sum+item.read,0);const proxyReadTotal=points.reduce((sum,item)=>sum+item.proxyRead,0);const unreadTotal=points.reduce((sum,item)=>sum+item.unread,0);const unresolvedTotal=points.reduce((sum,item)=>sum+item.unresolved,0);const escalatedTotal=points.reduce((sum,item)=>sum+item.escalated,0);const currentReadRate=current?.readRate??100;const headline=!points.length?"経営レポート配信待ち":currentReadRate===100?"最新経営レポートは全員確認済み":`最新経営レポートの確認率 ${currentReadRate}%・未確認 ${Math.max(0,(current?.unread??0)+(current?.unresolved??0))}名`;return{points,currentReadRate,averageReadRate,readTotal,proxyReadTotal,unreadTotal,unresolvedTotal,escalatedTotal,headline};
}

function changed(output:string[],key:string,left:unknown,right:unknown){if(left!==right)output.push(key);}
function join(value:string[]|undefined){return[...(value??[])].sort().join("|");}
function overdue(nowMs:number,deadlineMs:number){return Math.max(0,Math.floor((nowMs-deadlineMs)/60_000));}
function priority(value:ProductionEvidenceAlertQueueItem["priority"]){return value==="critical"?2:1;}
function statusRank(value:ProductionEvidenceAlertStatus){return value==="open"?0:value==="in_progress"?1:value==="acknowledged"?2:3;}
function parseTime(value:string|null|undefined,fallback:number){const parsed=Date.parse(value??"");return Number.isFinite(parsed)?parsed:fallback;}
function elapsedMinutes(nowMs:number,startMs:number){return Math.max(0,Math.floor((nowMs-startMs)/60_000));}
function remainingMinutes(nowMs:number,deadlineMs:number){return Math.max(0,Math.ceil((deadlineMs-nowMs)/60_000));}
function toIso(value:number){return new Date(value).toISOString();}
function tokyoDayStart(value:number){const shifted=new Date(value+9*60*60_000);return Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth(),shifted.getUTCDate())-9*60*60_000;}
function tokyoDateKey(value:number){return new Date(value+9*60*60_000).toISOString().slice(0,10);}
function percentage(numerator:number,denominator:number){return denominator?Math.round(numerator/denominator*100):100;}
function average(values:number[]){return values.length?Math.round(values.reduce((sum,value)=>sum+value,0)/values.length*10)/10:0;}
function roundDelta(value:number){return Math.round(value*10)/10;}
function signed(value:number){return value>0?`+${value}`:`${value}`;}
function performanceRow(item:ProductionEvidenceAlertQueueItem,nowMs:number){const firstMs=parseTime(item.firstDetectedAt,nowMs);const targets=productionEvidenceAlertSlaTargets(item.priority);const acknowledgementMs=parseOptionalTime(item.acknowledgedAt);const responseMs=parseOptionalTime(item.responseStartedAt);const resolvedMs=parseOptionalTime(item.resolvedAt);const acknowledgementDeadline=firstMs+targets.acknowledgementTargetMinutes*60_000;const responseDeadline=firstMs+targets.responseTargetMinutes*60_000;const acknowledgementEligible=acknowledgementMs!=null||nowMs>=acknowledgementDeadline;const responseEligible=responseMs!=null||nowMs>=responseDeadline;const acknowledgementMet=acknowledgementMs!=null&&acknowledgementMs<=acknowledgementDeadline;const responseMet=responseMs!=null&&responseMs<=responseDeadline;const breached=(acknowledgementEligible&&!acknowledgementMet)||(responseEligible&&!responseMet)||Number(item.maximumEscalationLevel??0)>=3;return{item,date:tokyoDateKey(firstMs),acknowledgementEligible,responseEligible,acknowledgementMet,responseMet,breached,atRisk:item.status!=="resolved"&&(breached||item.sla?.escalationLevel===2||item.sla?.escalationLevel===3),acknowledgementMinutes:acknowledgementMs==null?null:elapsedPreciseMinutes(acknowledgementMs,firstMs),responseMinutes:responseMs==null?null:elapsedPreciseMinutes(responseMs,firstMs),resolutionMinutes:resolvedMs==null?null:elapsedPreciseMinutes(resolvedMs,firstMs)};}
function parseOptionalTime(value:string|null|undefined){const parsed=Date.parse(value??"");return Number.isFinite(parsed)?parsed:null;}
function elapsedPreciseMinutes(endMs:number,startMs:number){return Math.round(Math.max(0,endMs-startMs)/60_000*10)/10;}
