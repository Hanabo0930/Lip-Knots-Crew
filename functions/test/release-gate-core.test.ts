import {
  defaultReleaseChecks,
  evaluateProductionRelease,
} from "../src/release-gate-core";

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(message);
}

const checks = defaultReleaseChecks({
  buildPassed: true,
  coreTestsPassed: true,
  securityBlockers: 0,
  gasAuditBlockers: 0,
  regressionFailures: 0,
  billingProductionEnabled: false,
  productionSecretsConfigured: true,
  backupRestoreTested: true,
  monitoringConfigured: true,
  incidentRunbookApproved: true,
  pilotCompleted: true,
  dataMigrationCompleted: true,
  driveCleanupCompleted: false,
});

const result = evaluateProductionRelease(checks);
equal(result.releasable, true, "警告だけでリリースを停止しています。");
equal(result.warnings.length, 2, "警告数が違います。");

const blocked = evaluateProductionRelease(
  checks.map((check) =>
    check.key === "pilot" ? { ...check, passed: false } : check
  )
);
equal(blocked.releasable, false, "パイロット未完了を許可しています。");
console.log("release gate core tests passed");
