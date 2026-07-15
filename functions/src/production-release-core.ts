import { createHash } from "node:crypto";

export type ProductionManualChecks = {
  backupVerified: boolean;
  restoreTestPassed: boolean;
  gasHighCriticalZero: boolean;
  stagingSmokeGo: boolean;
  legalApproved: boolean;
  productionSecretsConfigured: boolean;
  cloudMonitoringReady: boolean;
  domainTlsReady: boolean;
  migrationPlanReady: boolean;
  rollbackPlanReady: boolean;
};

export type ProductionReleaseGateInput = {
  stagedRolloutStatus: string;
  targetCount: number;
  currentWave: number;
  deliveredCount: number;
  criticalAlertCount: number;
  monitorFailureCount: number;
  inviteFailureCount: number;
  lastHealthAction: "continue" | "watch" | "pause" | "missing";
  manual: ProductionManualChecks;
  evidenceRefs: string[];
};

export type ProductionReleaseCheck = {
  key: string;
  label: string;
  passed: boolean;
  actual: string | number | boolean;
  required: string;
};

export type ProductionReleaseGate = {
  eligible: boolean;
  checks: ProductionReleaseCheck[];
  blockers: ProductionReleaseCheck[];
  normalizedEvidenceRefs: string[];
  fingerprint: string;
};

const MANUAL_CHECKS: Array<{ key: keyof ProductionManualChecks; label: string }> = [
  { key: "backupVerified", label: "本番前バックアップ" },
  { key: "restoreTestPassed", label: "復元演習" },
  { key: "gasHighCriticalZero", label: "GAS高・重大リスク0件" },
  { key: "stagingSmokeGo", label: "stagingスモークGO" },
  { key: "legalApproved", label: "法務・社内規程確認" },
  { key: "productionSecretsConfigured", label: "本番Secret設定" },
  { key: "cloudMonitoringReady", label: "本番監視・通知" },
  { key: "domainTlsReady", label: "独自ドメイン・TLS" },
  { key: "migrationPlanReady", label: "移行計画" },
  { key: "rollbackPlanReady", label: "切戻し計画" },
];

export function evaluateProductionRelease(input: ProductionReleaseGateInput): ProductionReleaseGate {
  validateInput(input);
  const normalizedEvidenceRefs = [...new Set(input.evidenceRefs.map((value) => value.trim()).filter(Boolean))].sort();
  const checks: ProductionReleaseCheck[] = [
    check("staged_status", "30〜50名段階配布", input.stagedRolloutStatus === "completed", "COMPLETED", input.stagedRolloutStatus),
    check("target_count", "段階配布対象人数", input.targetCount >= 30 && input.targetCount <= 50, "30〜50名", input.targetCount),
    check("wave_count", "完了wave", input.currentWave === 3, "3wave", input.currentWave),
    check("delivered_count", "配布完了人数", input.deliveredCount === input.targetCount, `${input.targetCount}名`, input.deliveredCount),
    check("critical_alerts", "重大アラート", input.criticalAlertCount === 0, "0件", input.criticalAlertCount),
    check("monitor_failures", "監視処理失敗", input.monitorFailureCount === 0, "0件", input.monitorFailureCount),
    check("invite_failures", "招待失敗", input.inviteFailureCount === 0, "0件", input.inviteFailureCount),
    check("last_health", "最終監視状態", input.lastHealthAction === "continue", "CONTINUE", input.lastHealthAction),
    ...MANUAL_CHECKS.map(({ key, label }) => check(key, label, input.manual[key], "確認済み")),
    check("evidence_refs", "公開証跡", normalizedEvidenceRefs.length >= 5, "5件以上", normalizedEvidenceRefs.length),
  ];
  const blockers = checks.filter((item) => !item.passed);
  const fingerprintInput = {
    ...input,
    evidenceRefs: normalizedEvidenceRefs,
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ input: fingerprintInput, checks }))
    .digest("hex");
  return {
    eligible: blockers.length === 0,
    checks,
    blockers,
    normalizedEvidenceRefs,
    fingerprint,
  };
}

function check(
  key: string,
  label: string,
  passed: boolean,
  required: string,
  actual: string | number | boolean = passed
): ProductionReleaseCheck {
  return { key, label, passed, actual, required };
}

function validateInput(input: ProductionReleaseGateInput): void {
  const counters = [
    input.targetCount,
    input.currentWave,
    input.deliveredCount,
    input.criticalAlertCount,
    input.monitorFailureCount,
    input.inviteFailureCount,
  ];
  if (counters.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("production release counters are invalid");
  }
  if (input.currentWave > 3 || input.deliveredCount > input.targetCount) {
    throw new Error("production release progress is invalid");
  }
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > 30) {
    throw new Error("production release evidence is invalid");
  }
}
