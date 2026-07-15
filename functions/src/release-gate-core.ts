export type ReleaseSeverity = "blocking" | "warning" | "info";

export type ReleaseCheck = {
  key: string;
  label: string;
  passed: boolean;
  severity: ReleaseSeverity;
  evidence: string;
};

export type ReleaseGateResult = {
  releasable: boolean;
  checks: ReleaseCheck[];
  blockingFailures: ReleaseCheck[];
  warnings: ReleaseCheck[];
  score: number;
};

export function evaluateProductionRelease(
  checks: ReleaseCheck[]
): ReleaseGateResult {
  const blockingFailures = checks.filter(
    (check) => check.severity === "blocking" && !check.passed
  );
  const warnings = checks.filter(
    (check) => check.severity === "warning" && !check.passed
  );

  const weights: Record<ReleaseSeverity, number> = {
    blocking: 10,
    warning: 3,
    info: 1,
  };
  const total = checks.reduce(
    (sum, check) => sum + weights[check.severity],
    0
  );
  const earned = checks.reduce(
    (sum, check) => sum + (check.passed ? weights[check.severity] : 0),
    0
  );

  return {
    releasable: blockingFailures.length === 0,
    checks,
    blockingFailures,
    warnings,
    score: total ? Math.round((earned / total) * 100) : 0,
  };
}

export function defaultReleaseChecks(input: {
  buildPassed: boolean;
  coreTestsPassed: boolean;
  securityBlockers: number;
  gasAuditBlockers: number;
  regressionFailures: number;
  billingProductionEnabled: boolean;
  productionSecretsConfigured: boolean;
  backupRestoreTested: boolean;
  monitoringConfigured: boolean;
  incidentRunbookApproved: boolean;
  pilotCompleted: boolean;
  dataMigrationCompleted: boolean;
  driveCleanupCompleted: boolean;
}): ReleaseCheck[] {
  return [
    check("build", "本番ビルド", input.buildPassed, "blocking"),
    check("core_tests", "コア自動テスト", input.coreTestsPassed, "blocking"),
    check(
      "security",
      "セキュリティ重大指摘0件",
      input.securityBlockers === 0,
      "blocking",
      `${input.securityBlockers}件`
    ),
    check(
      "gas",
      "既存GAS重大・高リスク0件",
      input.gasAuditBlockers === 0,
      "blocking",
      `${input.gasAuditBlockers}件`
    ),
    check(
      "regression",
      "回帰試験失敗0件",
      input.regressionFailures === 0,
      "blocking",
      `${input.regressionFailures}件`
    ),
    check(
      "secrets",
      "本番Secret設定済み",
      input.productionSecretsConfigured,
      "blocking"
    ),
    check(
      "backup_restore",
      "バックアップ復元試験",
      input.backupRestoreTested,
      "blocking"
    ),
    check(
      "monitoring",
      "監視・障害通知",
      input.monitoringConfigured,
      "blocking"
    ),
    check(
      "runbook",
      "障害対応手順承認",
      input.incidentRunbookApproved,
      "blocking"
    ),
    check(
      "pilot",
      "実パイロット完了",
      input.pilotCompleted,
      "blocking"
    ),
    check(
      "migration",
      "本番データ移行完了",
      input.dataMigrationCompleted,
      "blocking"
    ),
    check(
      "billing",
      "本番課金ON",
      input.billingProductionEnabled,
      "warning",
      "販売開始時のみ必要"
    ),
    check(
      "drive",
      "Drive整理完了",
      input.driveCleanupCompleted,
      "warning"
    ),
  ];
}

function check(
  key: string,
  label: string,
  passed: boolean,
  severity: ReleaseSeverity,
  evidence = ""
): ReleaseCheck {
  return { key, label, passed, severity, evidence };
}
