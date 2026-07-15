import {
  evaluateProductionRelease,
  ProductionReleaseGateInput,
} from "../src/production-release-core";

function equal(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(message);
}

const passing: ProductionReleaseGateInput = {
  stagedRolloutStatus: "completed",
  targetCount: 40,
  currentWave: 3,
  deliveredCount: 40,
  criticalAlertCount: 0,
  monitorFailureCount: 0,
  inviteFailureCount: 0,
  lastHealthAction: "continue",
  manual: {
    backupVerified: true,
    restoreTestPassed: true,
    gasHighCriticalZero: true,
    stagingSmokeGo: true,
    legalApproved: true,
    productionSecretsConfigured: true,
    cloudMonitoringReady: true,
    domainTlsReady: true,
    migrationPlanReady: true,
    rollbackPlanReady: true,
  },
  evidenceRefs: ["backup:1", "restore:1", "audit:1", "smoke:1", "rollback:1"],
};

equal(evaluateProductionRelease(passing).eligible, true, "passing production gate was blocked");
equal(evaluateProductionRelease({ ...passing, stagedRolloutStatus: "observing" }).eligible, false, "unfinished rollout passed");
equal(evaluateProductionRelease({ ...passing, targetCount: 29, deliveredCount: 29 }).eligible, false, "small rollout passed");
equal(evaluateProductionRelease({ ...passing, currentWave: 2 }).eligible, false, "two waves passed");
equal(evaluateProductionRelease({ ...passing, deliveredCount: 39 }).eligible, false, "partial delivery passed");
equal(evaluateProductionRelease({ ...passing, criticalAlertCount: 1 }).eligible, false, "critical alert passed");
equal(evaluateProductionRelease({ ...passing, monitorFailureCount: 1 }).eligible, false, "monitor failure passed");
equal(evaluateProductionRelease({ ...passing, inviteFailureCount: 1 }).eligible, false, "invite failure passed");
equal(evaluateProductionRelease({ ...passing, lastHealthAction: "watch" }).eligible, false, "WATCH passed");
equal(evaluateProductionRelease({ ...passing, manual: { ...passing.manual, backupVerified: false } }).eligible, false, "missing backup passed");
equal(evaluateProductionRelease({ ...passing, manual: { ...passing.manual, restoreTestPassed: false } }).eligible, false, "missing restore test passed");
equal(evaluateProductionRelease({ ...passing, manual: { ...passing.manual, legalApproved: false } }).eligible, false, "missing legal approval passed");
equal(evaluateProductionRelease({ ...passing, manual: { ...passing.manual, rollbackPlanReady: false } }).eligible, false, "missing rollback passed");
equal(evaluateProductionRelease({ ...passing, evidenceRefs: passing.evidenceRefs.slice(0, 4) }).eligible, false, "insufficient evidence passed");
equal(evaluateProductionRelease({ ...passing, evidenceRefs: [...passing.evidenceRefs, "backup:1", " "] }).normalizedEvidenceRefs.length, 5, "evidence normalization failed");
equal(
  evaluateProductionRelease(passing).fingerprint,
  evaluateProductionRelease({ ...passing, evidenceRefs: [...passing.evidenceRefs].reverse() }).fingerprint,
  "production gate fingerprint is not deterministic"
);

let rejected = false;
try {
  evaluateProductionRelease({ ...passing, deliveredCount: 41 });
} catch {
  rejected = true;
}
equal(rejected, true, "invalid production progress was accepted");

console.log("production release gate tests passed (17 cases)");
