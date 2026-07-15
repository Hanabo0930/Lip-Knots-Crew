import { createHash } from "node:crypto";

export type StagedWave = {
  waveNumber: number;
  startOffset: number;
  size: number;
  cumulativeCount: number;
};

export type StagedRolloutGateInput = {
  approvalValid: boolean;
  status: "ready" | "wave_preparing" | "observing" | "paused" | "stopped" | "completed";
  targetCount: number;
  currentWave: number;
  deliveredCount: number;
  observationHoursRequired: number;
  hoursObserved: number;
  requiredContinueRuns: number;
  consecutiveContinueRuns: number;
  criticalAlerts: number;
  monitorFailures: number;
  inviteFailures: number;
  lastHealthAction: "continue" | "watch" | "pause" | "missing";
};

export type StagedRolloutGateCheck = {
  key: string;
  label: string;
  passed: boolean;
  actual: string | number | boolean;
  required: string;
};

export type StagedRolloutGate = {
  allowed: boolean;
  nextWave: StagedWave | null;
  checks: StagedRolloutGateCheck[];
  blockers: StagedRolloutGateCheck[];
  fingerprint: string;
};

export function buildStagedWavePlan(targetCount: number): StagedWave[] {
  if (!Number.isInteger(targetCount) || targetCount < 30 || targetCount > 50) {
    throw new Error("staged rollout target must be between 30 and 50");
  }
  const first = 10;
  const remaining = targetCount - first;
  const second = Math.floor(remaining / 2);
  const sizes = [first, second, remaining - second];
  let offset = 0;
  return sizes.map((size, index) => {
    offset += size;
    return {
      waveNumber: index + 1,
      startOffset: offset - size,
      size,
      cumulativeCount: offset,
    };
  });
}

export function evaluateNextStagedWave(input: StagedRolloutGateInput): StagedRolloutGate {
  validateInput(input);
  const plan = buildStagedWavePlan(input.targetCount);
  const nextWave = plan[input.currentWave] ?? null;
  const previousWave = input.currentWave > 0 ? plan[input.currentWave - 1] ?? null : null;
  const requiresObservation = input.currentWave > 0;
  const checks: StagedRolloutGateCheck[] = [
    check("approval", "30〜50名移行承認", input.approvalValid, "有効な二者承認"),
    check("status", "段階配布状態", input.status === "ready", "READY" , input.status),
    check("remaining_wave", "未配布wave", nextWave !== null, "waveあり", nextWave?.waveNumber ?? "none"),
    check(
      "delivered_count",
      "配布済み人数",
      input.deliveredCount === (previousWave?.cumulativeCount ?? 0),
      `${previousWave?.cumulativeCount ?? 0}名`,
      input.deliveredCount
    ),
    check(
      "observation_window",
      "前wave観察時間",
      !requiresObservation || input.hoursObserved >= input.observationHoursRequired,
      requiresObservation ? `${input.observationHoursRequired}時間以上` : "初回は不要",
      Math.round(input.hoursObserved * 100) / 100
    ),
    check(
      "continue_runs",
      "連続CONTINUE",
      !requiresObservation || input.consecutiveContinueRuns >= input.requiredContinueRuns,
      requiresObservation ? `${input.requiredContinueRuns}run以上` : "初回は不要",
      input.consecutiveContinueRuns
    ),
    check("critical_alerts", "PAUSE判定", input.criticalAlerts === 0, "0件", input.criticalAlerts),
    check("monitor_failures", "監視処理失敗", input.monitorFailures === 0, "0件", input.monitorFailures),
    check("invite_failures", "招待失敗", input.inviteFailures === 0, "0件", input.inviteFailures),
    check(
      "last_health",
      "最終監視状態",
      !requiresObservation || input.lastHealthAction === "continue",
      requiresObservation ? "CONTINUE" : "初回は不要",
      input.lastHealthAction
    ),
  ];
  const blockers = checks.filter((item) => !item.passed);
  const fingerprint = createHash("sha256").update(JSON.stringify({ input, nextWave, checks })).digest("hex");
  return { allowed: blockers.length === 0, nextWave, checks, blockers, fingerprint };
}

function check(
  key: string,
  label: string,
  passed: boolean,
  required: string,
  actual: string | number | boolean = passed
): StagedRolloutGateCheck {
  return { key, label, passed, actual, required };
}

function validateInput(input: StagedRolloutGateInput): void {
  const integers = [
    input.currentWave,
    input.deliveredCount,
    input.requiredContinueRuns,
    input.consecutiveContinueRuns,
    input.criticalAlerts,
    input.monitorFailures,
    input.inviteFailures,
  ];
  if (integers.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("staged rollout counters are invalid");
  }
  const decimals = [input.observationHoursRequired, input.hoursObserved];
  if (decimals.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("staged rollout observation values are invalid");
  }
  if (input.currentWave > 3 || input.deliveredCount > input.targetCount) {
    throw new Error("staged rollout progress is invalid");
  }
}
