import { createHash } from "node:crypto";

export type ProductionSloSeverity = "SEV1" | "SEV2" | "SEV3";
export type ProductionSloHealth = "healthy" | "at_risk" | "incident";

export type ProductionSloPolicy = {
  availabilityTargetPercent: number;
  authSuccessTargetPercent: number;
  callableSuccessTargetPercent: number;
  sheetWriteSuccessTargetPercent: number;
  notificationSuccessTargetPercent: number;
  p95LatencyTargetMs: number;
  queueOldestTargetMinutes: number;
  observationStaleWarnMinutes: number;
  observationStaleCriticalMinutes: number;
  requiredHealthyRunsForRecovery: number;
};

export type ProductionSloWindow = {
  windowMinutes: 60 | 360 | 1440 | 43200;
  authenticationAttempts: number;
  authenticationFailures: number;
  callableRequests: number;
  callableFailures: number;
  sheetWriteAttempts: number;
  sheetWriteFailures: number;
  notificationAttempts: number;
  notificationFailures: number;
  p95LatencyMaxMs: number;
  queueOldestAgeMaxMinutes: number;
  dataMismatchCount: number;
  criticalOutageCount: number;
  monitoringProbeFailures: number;
};

export type ProductionSloInput = {
  nowMs: number;
  lastObservedAtMs: number | null;
  policy: ProductionSloPolicy;
  windows: ProductionSloWindow[];
};

export type ProductionSloSignal = {
  key: string;
  label: string;
  passed: boolean;
  severity: ProductionSloSeverity | null;
  actual: number | string;
  required: string;
};

export type ProductionSloWindowResult = {
  windowMinutes: number;
  totalRequests: number;
  failedRequests: number;
  availabilityPercent: number;
  burnRate: number;
};

export type ProductionSloEvaluation = {
  health: ProductionSloHealth;
  severity: ProductionSloSeverity | null;
  incidentRequired: boolean;
  incidentKind: string | null;
  signals: ProductionSloSignal[];
  failedSignals: ProductionSloSignal[];
  windowResults: ProductionSloWindowResult[];
  errorBudgetConsumedPercent: number;
  errorBudgetRemainingPercent: number;
  observationAgeMinutes: number | null;
  fingerprint: string;
  alertFingerprint: string;
};

export type ProductionIncidentState = {
  status: string;
  currentSeverity: ProductionSloSeverity;
  highestSeverity: ProductionSloSeverity;
  recoveryHealthyRuns: number;
};

export type ProductionIncidentTransition = {
  action: "none" | "open" | "update" | "escalate" | "healthy_observation" | "recovery_pending";
  nextStatus: string | null;
  currentSeverity: ProductionSloSeverity | null;
  highestSeverity: ProductionSloSeverity | null;
  recoveryHealthyRuns: number;
};

const severityRank: Record<ProductionSloSeverity, number> = { SEV3: 1, SEV2: 2, SEV1: 3 };

export function defaultProductionSloPolicy(): ProductionSloPolicy {
  return {
    availabilityTargetPercent: 99.9,
    authSuccessTargetPercent: 99.5,
    callableSuccessTargetPercent: 99.5,
    sheetWriteSuccessTargetPercent: 99,
    notificationSuccessTargetPercent: 98,
    p95LatencyTargetMs: 2000,
    queueOldestTargetMinutes: 15,
    observationStaleWarnMinutes: 15,
    observationStaleCriticalMinutes: 30,
    requiredHealthyRunsForRecovery: 3,
  };
}

export function emptyProductionSloWindow(windowMinutes: ProductionSloWindow["windowMinutes"]): ProductionSloWindow {
  return {
    windowMinutes,
    authenticationAttempts: 0,
    authenticationFailures: 0,
    callableRequests: 0,
    callableFailures: 0,
    sheetWriteAttempts: 0,
    sheetWriteFailures: 0,
    notificationAttempts: 0,
    notificationFailures: 0,
    p95LatencyMaxMs: 0,
    queueOldestAgeMaxMinutes: 0,
    dataMismatchCount: 0,
    criticalOutageCount: 0,
    monitoringProbeFailures: 0,
  };
}

export function evaluateProductionSlo(input: ProductionSloInput): ProductionSloEvaluation {
  validateInput(input);
  const byWindow = new Map(input.windows.map((window) => [window.windowMinutes, window]));
  const hour = byWindow.get(60) ?? emptyProductionSloWindow(60);
  const sixHours = byWindow.get(360) ?? emptyProductionSloWindow(360);
  const day = byWindow.get(1440) ?? emptyProductionSloWindow(1440);
  const month = byWindow.get(43200) ?? emptyProductionSloWindow(43200);
  const allowedErrorRate = (100 - input.policy.availabilityTargetPercent) / 100;
  const windowResults = [hour, sixHours, day, month].map((window) => windowResult(window, allowedErrorRate));
  const resultByWindow = new Map(windowResults.map((result) => [result.windowMinutes, result]));
  const monthResult = resultByWindow.get(43200)!;
  const allowedMonthlyFailures = monthResult.totalRequests * allowedErrorRate;
  const errorBudgetConsumedPercent = allowedMonthlyFailures > 0
    ? round(monthResult.failedRequests / allowedMonthlyFailures * 100, 2)
    : 0;
  const observationAgeMinutes = input.lastObservedAtMs === null
    ? null
    : round(Math.max(0, input.nowMs - input.lastObservedAtMs) / 60_000, 1);
  const signals: ProductionSloSignal[] = [];

  signals.push(staleSignal(observationAgeMinutes, input.policy));
  signals.push(binarySignal("critical_outage", "重大機能停止", day.criticalOutageCount === 0, "0件", day.criticalOutageCount, "SEV1"));
  signals.push(binarySignal("data_mismatch", "データ差異", day.dataMismatchCount === 0, "0件", day.dataMismatchCount, "SEV1"));
  signals.push(burnSignal("burn_1h", "1時間バーンレート", resultByWindow.get(60)!, 100, 14.4, "SEV1"));
  signals.push(burnSignal("burn_6h", "6時間バーンレート", resultByWindow.get(360)!, 200, 6, "SEV2"));
  signals.push(burnSignal("burn_24h", "24時間バーンレート", resultByWindow.get(1440)!, 500, 3, "SEV2"));
  signals.push(budgetSignal(errorBudgetConsumedPercent, monthResult.totalRequests));
  signals.push(successSignal("auth_success", "認証成功率", day.authenticationAttempts, day.authenticationFailures, input.policy.authSuccessTargetPercent, 100, "SEV3"));
  signals.push(successSignal("callable_success", "Functions成功率", day.callableRequests, day.callableFailures, input.policy.callableSuccessTargetPercent, 100, "SEV3"));
  signals.push(successSignal("sheet_success", "スプシ書込成功率", day.sheetWriteAttempts, day.sheetWriteFailures, input.policy.sheetWriteSuccessTargetPercent, 20, successPercent(day.sheetWriteAttempts, day.sheetWriteFailures) < 95 ? "SEV2" : "SEV3"));
  signals.push(successSignal("notification_success", "通知成功率", day.notificationAttempts, day.notificationFailures, input.policy.notificationSuccessTargetPercent, 20, successPercent(day.notificationAttempts, day.notificationFailures) < 90 ? "SEV2" : "SEV3"));
  signals.push(latencySignal(day.p95LatencyMaxMs, input.policy.p95LatencyTargetMs));
  signals.push(queueSignal(day.queueOldestAgeMaxMinutes, input.policy.queueOldestTargetMinutes));
  signals.push(probeSignal(day.monitoringProbeFailures));

  const failedSignals = signals.filter((signal) => !signal.passed);
  const severity = failedSignals.reduce<ProductionSloSeverity | null>((current, signal) => {
    if (!signal.severity) return current;
    if (!current || severityRank[signal.severity] > severityRank[current]) return signal.severity;
    return current;
  }, null);
  const incidentRequired = severity !== null;
  const health: ProductionSloHealth = !incidentRequired
    ? "healthy"
    : severity === "SEV3" && failedSignals.every((signal) => signal.severity === "SEV3")
      ? "at_risk"
      : "incident";
  const incidentKind = severity
    ? failedSignals.find((signal) => signal.severity === severity)?.key ?? "slo_breach"
    : null;
  const fingerprint = createHash("sha256").update(JSON.stringify({
    policy: input.policy,
    windows: [hour, sixHours, day, month],
    observationAgeBand: observationAgeMinutes === null ? "missing" : observationAgeMinutes > input.policy.observationStaleCriticalMinutes ? "critical" : observationAgeMinutes > input.policy.observationStaleWarnMinutes ? "warn" : "fresh",
    severity,
    failedKeys: failedSignals.map((signal) => signal.key),
  })).digest("hex");
  const alertFingerprint = createHash("sha256").update(JSON.stringify({
    health,
    severity,
    incidentKind,
    failedKeys: failedSignals.map((signal) => signal.key).sort(),
  })).digest("hex");
  return {
    health,
    severity,
    incidentRequired,
    incidentKind,
    signals,
    failedSignals,
    windowResults,
    errorBudgetConsumedPercent,
    errorBudgetRemainingPercent: round(Math.max(0, 100 - errorBudgetConsumedPercent), 2),
    observationAgeMinutes,
    fingerprint,
    alertFingerprint,
  };
}

export function decideProductionIncidentTransition(evaluation: ProductionSloEvaluation, current: ProductionIncidentState | null, requiredHealthyRuns: number): ProductionIncidentTransition {
  if (!Number.isSafeInteger(requiredHealthyRuns) || requiredHealthyRuns < 2 || requiredHealthyRuns > 24) throw new Error("incident recovery target is invalid");
  if (evaluation.incidentRequired) {
    const severity = evaluation.severity!;
    if (!current) return { action: "open", nextStatus: "open", currentSeverity: severity, highestSeverity: severity, recoveryHealthyRuns: 0 };
    const action = severityRank[severity] > severityRank[current.currentSeverity] ? "escalate" : "update";
    const highestSeverity = severityRank[severity] > severityRank[current.highestSeverity] ? severity : current.highestSeverity;
    return { action, nextStatus: current.status === "acknowledged" ? "acknowledged" : "open", currentSeverity: severity, highestSeverity, recoveryHealthyRuns: 0 };
  }
  if (!current) return { action: "none", nextStatus: null, currentSeverity: null, highestSeverity: null, recoveryHealthyRuns: 0 };
  const recoveryHealthyRuns = current.recoveryHealthyRuns + 1;
  const recoveryPending = recoveryHealthyRuns >= requiredHealthyRuns;
  return { action: recoveryPending ? "recovery_pending" : "healthy_observation", nextStatus: recoveryPending ? "recovery_pending" : "monitoring_recovery", currentSeverity: current.currentSeverity, highestSeverity: current.highestSeverity, recoveryHealthyRuns };
}

function windowResult(window: ProductionSloWindow, allowedErrorRate: number): ProductionSloWindowResult {
  const totalRequests = window.authenticationAttempts + window.callableRequests + window.sheetWriteAttempts + window.notificationAttempts;
  const failedRequests = window.authenticationFailures + window.callableFailures + window.sheetWriteFailures + window.notificationFailures;
  const errorRate = totalRequests === 0 ? 0 : failedRequests / totalRequests;
  return {
    windowMinutes: window.windowMinutes,
    totalRequests,
    failedRequests,
    availabilityPercent: round(totalRequests === 0 ? 100 : (1 - errorRate) * 100, 4),
    burnRate: round(allowedErrorRate > 0 ? errorRate / allowedErrorRate : 0, 2),
  };
}

function staleSignal(age: number | null, policy: ProductionSloPolicy): ProductionSloSignal {
  if (age === null) return signal("monitoring_stale", "SLO観測鮮度", false, "SEV2", "未観測", `${policy.observationStaleWarnMinutes}分以内`);
  if (age > policy.observationStaleCriticalMinutes) return signal("monitoring_stale", "SLO観測鮮度", false, "SEV2", age, `${policy.observationStaleWarnMinutes}分以内`);
  if (age > policy.observationStaleWarnMinutes) return signal("monitoring_stale", "SLO観測鮮度", false, "SEV3", age, `${policy.observationStaleWarnMinutes}分以内`);
  return signal("monitoring_stale", "SLO観測鮮度", true, null, age, `${policy.observationStaleWarnMinutes}分以内`);
}

function burnSignal(key: string, label: string, result: ProductionSloWindowResult, minimumRequests: number, threshold: number, severity: ProductionSloSeverity): ProductionSloSignal {
  const passed = result.totalRequests < minimumRequests || result.burnRate < threshold;
  return signal(key, label, passed, passed ? null : severity, result.burnRate, `${threshold}未満（${minimumRequests}req以上）`);
}

function budgetSignal(consumed: number, totalRequests: number): ProductionSloSignal {
  if (totalRequests < 1000 || consumed < 80) return signal("error_budget", "30日エラーバジェット", true, null, consumed, "80%未満");
  return signal("error_budget", "30日エラーバジェット", false, consumed >= 100 ? "SEV2" : "SEV3", consumed, "80%未満");
}

function successSignal(key: string, label: string, attempts: number, failures: number, target: number, minimumAttempts: number, severity: ProductionSloSeverity): ProductionSloSignal {
  const actual = successPercent(attempts, failures);
  const passed = attempts < minimumAttempts || actual >= target;
  return signal(key, label, passed, passed ? null : severity, round(actual, 4), `${target}%以上（${minimumAttempts}件以上）`);
}

function latencySignal(actual: number, target: number): ProductionSloSignal {
  if (actual <= target) return signal("p95_latency", "p95応答時間", true, null, actual, `${target}ms以下`);
  return signal("p95_latency", "p95応答時間", false, actual > 5000 ? "SEV2" : "SEV3", actual, `${target}ms以下`);
}

function queueSignal(actual: number, target: number): ProductionSloSignal {
  if (actual <= target) return signal("queue_age", "最古queue滞留", true, null, actual, `${target}分以下`);
  return signal("queue_age", "最古queue滞留", false, actual > 60 ? "SEV2" : "SEV3", actual, `${target}分以下`);
}

function probeSignal(actual: number): ProductionSloSignal {
  if (actual === 0) return signal("monitoring_probe", "監視probe失敗", true, null, actual, "0件");
  return signal("monitoring_probe", "監視probe失敗", false, actual >= 3 ? "SEV2" : "SEV3", actual, "0件");
}

function binarySignal(key: string, label: string, passed: boolean, required: string, actual: number, severity: ProductionSloSeverity): ProductionSloSignal {
  return signal(key, label, passed, passed ? null : severity, actual, required);
}

function signal(key: string, label: string, passed: boolean, severity: ProductionSloSeverity | null, actual: number | string, required: string): ProductionSloSignal {
  return { key, label, passed, severity, actual, required };
}

function successPercent(attempts: number, failures: number): number {
  return attempts === 0 ? 100 : (attempts - failures) / attempts * 100;
}

function validateInput(input: ProductionSloInput): void {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw new Error("SLO now timestamp is invalid");
  if (input.lastObservedAtMs !== null && (!Number.isSafeInteger(input.lastObservedAtMs) || input.lastObservedAtMs > input.nowMs + 120_000)) throw new Error("SLO observation timestamp is invalid");
  const policy = input.policy;
  for (const value of [policy.availabilityTargetPercent, policy.authSuccessTargetPercent, policy.callableSuccessTargetPercent, policy.sheetWriteSuccessTargetPercent, policy.notificationSuccessTargetPercent]) {
    if (!Number.isFinite(value) || value <= 0 || value >= 100) throw new Error("SLO percentage target is invalid");
  }
  if (!Number.isSafeInteger(policy.p95LatencyTargetMs) || policy.p95LatencyTargetMs < 100 || !Number.isSafeInteger(policy.queueOldestTargetMinutes) || policy.queueOldestTargetMinutes < 1) throw new Error("SLO performance target is invalid");
  if (!Number.isSafeInteger(policy.observationStaleWarnMinutes) || !Number.isSafeInteger(policy.observationStaleCriticalMinutes) || policy.observationStaleWarnMinutes < 1 || policy.observationStaleCriticalMinutes <= policy.observationStaleWarnMinutes) throw new Error("SLO staleness target is invalid");
  if (!Number.isSafeInteger(policy.requiredHealthyRunsForRecovery) || policy.requiredHealthyRunsForRecovery < 2 || policy.requiredHealthyRunsForRecovery > 24) throw new Error("SLO recovery run target is invalid");
  const seen = new Set<number>();
  for (const window of input.windows) {
    if (![60, 360, 1440, 43200].includes(window.windowMinutes) || seen.has(window.windowMinutes)) throw new Error("SLO window is invalid");
    seen.add(window.windowMinutes);
    const values = [window.authenticationAttempts, window.authenticationFailures, window.callableRequests, window.callableFailures, window.sheetWriteAttempts, window.sheetWriteFailures, window.notificationAttempts, window.notificationFailures, window.p95LatencyMaxMs, window.queueOldestAgeMaxMinutes, window.dataMismatchCount, window.criticalOutageCount, window.monitoringProbeFailures];
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("SLO window metric is invalid");
    if (window.authenticationFailures > window.authenticationAttempts || window.callableFailures > window.callableRequests || window.sheetWriteFailures > window.sheetWriteAttempts || window.notificationFailures > window.notificationAttempts) throw new Error("SLO failures exceed attempts");
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
