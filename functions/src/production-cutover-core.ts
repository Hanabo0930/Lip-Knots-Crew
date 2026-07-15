import { createHash } from "node:crypto";

export type ProductionCutoverAction = "go" | "watch" | "pause" | "rollback_required" | "complete";
export type ProductionCutoverPhase = "preflight" | "smoke" | "stabilization" | "extended" | "final_review";

export type ProductionCutoverReadiness = {
  signedApprovalReady: boolean;
  changeFreezeConfirmed: boolean;
  backupReferenceReady: boolean;
  rollbackOwnerAssigned: boolean;
  monitoringDashboardsReady: boolean;
  incidentChannelReady: boolean;
  supportRosterReady: boolean;
  smokePlanReady: boolean;
  migrationOwnerAssigned: boolean;
};

export type ProductionCutoverObservation = {
  observedAtMs: number;
  authenticationAttempts: number;
  authenticationFailures: number;
  callableRequests: number;
  callableFailures: number;
  p95LatencyMs: number;
  sheetWriteFailures: number;
  notificationFailures: number;
  queueBacklog: number;
  smokeFailures: number;
  dataMismatchCount: number;
  criticalIncidentCount: number;
  monitoringProbeFailures: number;
  evidenceRefs: string[];
};

export type ProductionCutoverThresholds = {
  authErrorRatePausePercent: number;
  authErrorRateRollbackPercent: number;
  callableErrorRatePausePercent: number;
  callableErrorRateRollbackPercent: number;
  p95LatencyPauseMs: number;
  p95LatencyRollbackMs: number;
  sheetWriteFailureRollbackCount: number;
  notificationFailurePauseCount: number;
  queueBacklogPauseCount: number;
  queueBacklogRollbackCount: number;
  monitoringStalePauseMinutes: number;
  monitoringStaleRollbackMinutes: number;
  requiredHealthyRunsForCompletion: number;
};

export type ProductionCutoverInput = {
  windowStartMs: number;
  nowMs: number;
  productionActive?: boolean;
  readiness: ProductionCutoverReadiness;
  readinessEvidenceRefs: string[];
  observation: ProductionCutoverObservation | null;
  consecutiveHealthyObservations: number;
  thresholds: ProductionCutoverThresholds;
};

export type ProductionCutoverCheck = {
  key: string;
  label: string;
  severity: "block" | "rollback" | "watch";
  passed: boolean;
  actual: string | number | boolean;
  required: string;
};

export type ProductionCutoverEvaluation = {
  action: ProductionCutoverAction;
  phase: ProductionCutoverPhase;
  elapsedMinutes: number;
  checks: ProductionCutoverCheck[];
  blockers: ProductionCutoverCheck[];
  rollbackBlockers: ProductionCutoverCheck[];
  warnings: ProductionCutoverCheck[];
  normalizedEvidenceRefs: string[];
  healthyForStreak: boolean;
  fingerprint: string;
};

export type ProductionCutoverCheckpoint = {
  key: string;
  offsetMinutes: number;
  label: string;
  objective: string;
};

export type ProductionCutoverEnableInput = {
  runStatus: string;
  action: string;
  phase: string;
  runReleaseId: string;
  packageReleaseId: string;
  runApprovalPackageId: string;
  approvalPackageId: string;
  windowStartMs: number;
  nowMs: number;
};

export type ProductionCutoverEnableGate = {
  allowed: boolean;
  checks: ProductionCutoverCheck[];
  blockers: ProductionCutoverCheck[];
};

const READINESS_LABELS: Array<[keyof ProductionCutoverReadiness, string]> = [
  ["signedApprovalReady", "署名付き本番承認"],
  ["changeFreezeConfirmed", "変更凍結"],
  ["backupReferenceReady", "バックアップ参照"],
  ["rollbackOwnerAssigned", "切戻し責任者"],
  ["monitoringDashboardsReady", "監視ダッシュボード"],
  ["incidentChannelReady", "障害連絡チャネル"],
  ["supportRosterReady", "当日サポート体制"],
  ["smokePlanReady", "本番smoke手順"],
  ["migrationOwnerAssigned", "移行責任者"],
];

export function defaultProductionCutoverThresholds(): ProductionCutoverThresholds {
  return {
    authErrorRatePausePercent: 2,
    authErrorRateRollbackPercent: 10,
    callableErrorRatePausePercent: 1,
    callableErrorRateRollbackPercent: 10,
    p95LatencyPauseMs: 2000,
    p95LatencyRollbackMs: 5000,
    sheetWriteFailureRollbackCount: 3,
    notificationFailurePauseCount: 2,
    queueBacklogPauseCount: 20,
    queueBacklogRollbackCount: 100,
    monitoringStalePauseMinutes: 10,
    monitoringStaleRollbackMinutes: 30,
    requiredHealthyRunsForCompletion: 12,
  };
}

export function buildProductionCutoverTimeline(): ProductionCutoverCheckpoint[] {
  return [
    { key: "t_minus_60", offsetMinutes: -60, label: "T−60", objective: "変更凍結・バックアップ・責任者確認" },
    { key: "t_minus_15", offsetMinutes: -15, label: "T−15", objective: "署名承認・監視・連絡網の最終確認" },
    { key: "t_zero", offsetMinutes: 0, label: "T±0", objective: "別管理者による本番有効化" },
    { key: "t_plus_5", offsetMinutes: 5, label: "T＋5", objective: "認証・Functions・smoke即時確認" },
    { key: "t_plus_30", offsetMinutes: 30, label: "T＋30", objective: "書込・通知・queue安定性確認" },
    { key: "t_plus_120", offsetMinutes: 120, label: "T＋120", objective: "拡張監視と切戻し判断締切" },
    { key: "t_plus_1440", offsetMinutes: 1440, label: "T＋24h", objective: "連続正常run確認・切替完了固定" },
  ];
}

export function evaluateProductionCutoverEnable(input: ProductionCutoverEnableInput): ProductionCutoverEnableGate {
  if (!Number.isSafeInteger(input.windowStartMs) || !Number.isSafeInteger(input.nowMs)) throw new Error("cutover enable timestamps are invalid");
  const checks: ProductionCutoverCheck[] = [
    check("run_status", "指揮盤状態", "block", input.runStatus === "ready", "READY", input.runStatus),
    check("run_action", "指揮盤判定", "block", input.action === "go", "GO", input.action),
    check("run_phase", "指揮盤phase", "block", input.phase === "preflight", "PREFLIGHT", input.phase),
    check("release_binding", "Release一致", "block", Boolean(input.runReleaseId && input.runReleaseId === input.packageReleaseId), input.packageReleaseId, input.runReleaseId),
    check("approval_binding", "署名パッケージ一致", "block", Boolean(input.runApprovalPackageId && input.runApprovalPackageId === input.approvalPackageId), input.approvalPackageId, input.runApprovalPackageId),
    check("enable_window", "本番有効化時刻", "block", Math.abs(input.nowMs - input.windowStartMs) <= 5 * 60_000, "T±5分", Math.round((input.nowMs - input.windowStartMs) / 60_000 * 10) / 10),
  ];
  const blockers=checks.filter(item=>!item.passed);
  return {allowed:blockers.length===0,checks,blockers};
}

export function evaluateProductionCutover(input: ProductionCutoverInput): ProductionCutoverEvaluation {
  validateInput(input);
  const elapsedMinutes = Math.floor((input.nowMs - input.windowStartMs) / 60_000);
  const productionActive = input.productionActive !== false;
  const phase = productionActive ? phaseFor(elapsedMinutes) : "preflight";
  const afterStart = elapsedMinutes >= 0 && productionActive;
  const normalizedReadinessEvidence = normalizeEvidence(input.readinessEvidenceRefs);
  const normalizedObservationEvidence = normalizeEvidence(input.observation?.evidenceRefs ?? []);
  const normalizedEvidenceRefs = [...new Set([...normalizedReadinessEvidence, ...normalizedObservationEvidence])].sort();
  const checks: ProductionCutoverCheck[] = [
    ...READINESS_LABELS.map(([key, label]) => check(key, label, "block", input.readiness[key], "確認済み", input.readiness[key])),
    check("readiness_evidence", "当日準備証跡", "block", normalizedReadinessEvidence.length >= 3, "3件以上", normalizedReadinessEvidence.length),
  ];

  if (afterStart) {
    if (!input.observation) {
      checks.push(check("observation", "本番観測", "block", false, "10分以内の観測", "missing"));
    } else {
      const observation = input.observation;
      const authRate = percent(observation.authenticationFailures, observation.authenticationAttempts);
      const callableRate = percent(observation.callableFailures, observation.callableRequests);
      const ageMinutes = (input.nowMs - observation.observedAtMs) / 60_000;
      checks.push(
        check("observation_time", "観測時刻", "block", observation.observedAtMs <= input.nowMs + 2 * 60_000, "未来2分以内", Math.round(ageMinutes * 10) / 10),
        check("monitoring_stale", "監視鮮度", ageMinutes > input.thresholds.monitoringStaleRollbackMinutes ? "rollback" : "block", ageMinutes <= input.thresholds.monitoringStalePauseMinutes, `${input.thresholds.monitoringStalePauseMinutes}分以内`, Math.round(ageMinutes * 10) / 10),
        check("observation_evidence", "観測証跡", "block", normalizedObservationEvidence.length >= 2, "2件以上", normalizedObservationEvidence.length),
        rateCheck("auth_error_rate", "認証失敗率", authRate, observation.authenticationAttempts, input.thresholds.authErrorRatePausePercent, input.thresholds.authErrorRateRollbackPercent, 10),
        rateCheck("callable_error_rate", "Functions失敗率", callableRate, observation.callableRequests, input.thresholds.callableErrorRatePausePercent, input.thresholds.callableErrorRateRollbackPercent, 20),
        thresholdCheck("p95_latency", "p95応答時間", observation.p95LatencyMs, input.thresholds.p95LatencyPauseMs, input.thresholds.p95LatencyRollbackMs, "ms"),
        countCheck("sheet_write_failures", "スプシ書込失敗", observation.sheetWriteFailures, 0, input.thresholds.sheetWriteFailureRollbackCount),
        countCheck("notification_failures", "通知失敗", observation.notificationFailures, input.thresholds.notificationFailurePauseCount, Number.POSITIVE_INFINITY),
        thresholdCheck("queue_backlog", "queue滞留", observation.queueBacklog, input.thresholds.queueBacklogPauseCount, input.thresholds.queueBacklogRollbackCount, "件"),
        countCheck("monitoring_probe_failures", "監視probe失敗", observation.monitoringProbeFailures, 0, 3),
        check("smoke_failures", "本番smoke失敗", "rollback", observation.smokeFailures === 0, "0件", observation.smokeFailures),
        check("data_mismatch", "データ差異", "rollback", observation.dataMismatchCount === 0, "0件", observation.dataMismatchCount),
        check("critical_incidents", "重大障害", "rollback", observation.criticalIncidentCount === 0, "0件", observation.criticalIncidentCount)
      );
    }
  }

  const rollbackBlockers = checks.filter((item) => item.severity === "rollback" && !item.passed);
  const blockers = checks.filter((item) => item.severity === "block" && !item.passed);
  const baseWarnings = warningChecks(input, afterStart);
  const healthyForStreak = rollbackBlockers.length === 0 && blockers.length === 0 && baseWarnings.length === 0;
  const completionPending = phase === "final_review" && input.consecutiveHealthyObservations < input.thresholds.requiredHealthyRunsForCompletion;
  const warnings = completionPending
    ? [...baseWarnings, check("completion_streak", "連続正常run", "watch", false, `${input.thresholds.requiredHealthyRunsForCompletion}回以上`, input.consecutiveHealthyObservations)]
    : baseWarnings;

  let action: ProductionCutoverAction;
  if (rollbackBlockers.length > 0) action = "rollback_required";
  else if (blockers.length > 0) action = "pause";
  else if (warnings.length > 0) action = "watch";
  else if (phase === "final_review") action = "complete";
  else action = "go";

  const fingerprintInput = {
    windowStartMs: input.windowStartMs,
    readiness: input.readiness,
    readinessEvidenceRefs: normalizedReadinessEvidence,
    observation: input.observation ? { ...input.observation, evidenceRefs: normalizedObservationEvidence } : null,
    consecutiveHealthyObservations: input.consecutiveHealthyObservations,
    thresholds: input.thresholds,
    productionActive,
    phase,
    action,
    blockerKeys: blockers.map((item) => item.key),
    rollbackKeys: rollbackBlockers.map((item) => item.key),
    warningKeys: warnings.map((item) => item.key),
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(fingerprintInput))
    .digest("hex");
  return { action, phase, elapsedMinutes, checks, blockers, rollbackBlockers, warnings, normalizedEvidenceRefs, healthyForStreak, fingerprint };
}

function warningChecks(input: ProductionCutoverInput, afterStart: boolean): ProductionCutoverCheck[] {
  if (!afterStart || !input.observation) return [];
  const o = input.observation;
  const t = input.thresholds;
  const authRate = percent(o.authenticationFailures, o.authenticationAttempts);
  const callableRate = percent(o.callableFailures, o.callableRequests);
  const candidates: ProductionCutoverCheck[] = [
    check("auth_error_watch", "認証失敗率上昇", "watch", authRate < t.authErrorRatePausePercent * 0.8, `${t.authErrorRatePausePercent * 0.8}%未満`, authRate),
    check("callable_error_watch", "Functions失敗率上昇", "watch", callableRate < t.callableErrorRatePausePercent * 0.8, `${t.callableErrorRatePausePercent * 0.8}%未満`, callableRate),
    check("latency_watch", "p95遅延上昇", "watch", o.p95LatencyMs < t.p95LatencyPauseMs * 0.8, `${t.p95LatencyPauseMs * 0.8}ms未満`, o.p95LatencyMs),
    check("queue_watch", "queue滞留増加", "watch", o.queueBacklog < t.queueBacklogPauseCount * 0.8, `${t.queueBacklogPauseCount * 0.8}件未満`, o.queueBacklog),
    check("notification_watch", "通知失敗発生", "watch", o.notificationFailures === 0, "0件", o.notificationFailures),
  ];
  return candidates.filter((item) => !item.passed && !hardFailureFor(item.key, input));
}

function hardFailureFor(warningKey: string, input: ProductionCutoverInput): boolean {
  const o = input.observation;
  if (!o) return false;
  const t = input.thresholds;
  if (warningKey === "auth_error_watch") return percent(o.authenticationFailures, o.authenticationAttempts) > t.authErrorRatePausePercent;
  if (warningKey === "callable_error_watch") return percent(o.callableFailures, o.callableRequests) > t.callableErrorRatePausePercent;
  if (warningKey === "latency_watch") return o.p95LatencyMs > t.p95LatencyPauseMs;
  if (warningKey === "queue_watch") return o.queueBacklog > t.queueBacklogPauseCount;
  if (warningKey === "notification_watch") return o.notificationFailures > t.notificationFailurePauseCount;
  return false;
}

function rateCheck(key: string, label: string, rate: number, sample: number, pause: number, rollback: number, rollbackMinSample: number): ProductionCutoverCheck {
  const rollbackTriggered = sample >= rollbackMinSample && rate >= rollback;
  return check(key, label, rollbackTriggered ? "rollback" : "block", rate <= pause, `${pause}%以下`, Math.round(rate * 100) / 100);
}

function thresholdCheck(key: string, label: string, value: number, pause: number, rollback: number, unit: string): ProductionCutoverCheck {
  return check(key, label, value > rollback ? "rollback" : "block", value <= pause, `${pause}${unit}以下`, value);
}

function countCheck(key: string, label: string, value: number, pause: number, rollback: number): ProductionCutoverCheck {
  return check(key, label, value >= rollback ? "rollback" : "block", value <= pause, `${pause}件以下`, value);
}

function check(key: string, label: string, severity: ProductionCutoverCheck["severity"], passed: boolean, required: string, actual: string | number | boolean): ProductionCutoverCheck {
  return { key, label, severity, passed, required, actual };
}

function percent(failures: number, total: number): number {
  return total === 0 ? 0 : failures / total * 100;
}

function normalizeEvidence(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function phaseFor(elapsedMinutes: number): ProductionCutoverPhase {
  if (elapsedMinutes < 0) return "preflight";
  if (elapsedMinutes < 15) return "smoke";
  if (elapsedMinutes < 120) return "stabilization";
  if (elapsedMinutes < 1440) return "extended";
  return "final_review";
}

function validateInput(input: ProductionCutoverInput): void {
  if (![input.windowStartMs, input.nowMs].every(Number.isSafeInteger)) throw new Error("cutover timestamps are invalid");
  if (!Number.isInteger(input.consecutiveHealthyObservations) || input.consecutiveHealthyObservations < 0) throw new Error("cutover streak is invalid");
  if (!Array.isArray(input.readinessEvidenceRefs) || input.readinessEvidenceRefs.length > 40) throw new Error("cutover readiness evidence is invalid");
  const thresholds = Object.values(input.thresholds);
  if (thresholds.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("cutover thresholds are invalid");
  if (!input.observation) return;
  const counts = [
    input.observation.authenticationAttempts, input.observation.authenticationFailures,
    input.observation.callableRequests, input.observation.callableFailures,
    input.observation.sheetWriteFailures,
    input.observation.notificationFailures, input.observation.queueBacklog,
    input.observation.smokeFailures, input.observation.dataMismatchCount,
    input.observation.criticalIncidentCount, input.observation.monitoringProbeFailures,
  ];
  if (counts.some((value) => !Number.isInteger(value) || value < 0) || !Number.isFinite(input.observation.p95LatencyMs) || input.observation.p95LatencyMs < 0) throw new Error("cutover observation counters are invalid");
  if (input.observation.authenticationFailures > input.observation.authenticationAttempts || input.observation.callableFailures > input.observation.callableRequests) throw new Error("cutover failure counters exceed totals");
  if (!Number.isSafeInteger(input.observation.observedAtMs) || input.observation.evidenceRefs.length > 40) throw new Error("cutover observation metadata is invalid");
}
