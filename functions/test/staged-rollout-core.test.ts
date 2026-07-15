import {
  buildStagedWavePlan,
  evaluateNextStagedWave,
  StagedRolloutGateInput,
} from "../src/staged-rollout-core";

function equal(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(message);
}

const plan30 = buildStagedWavePlan(30);
equal(plan30.map((wave) => wave.size).join(","), "10,10,10", "30-person wave plan is wrong");
const plan50 = buildStagedWavePlan(50);
equal(plan50.map((wave) => wave.size).join(","), "10,20,20", "50-person wave plan is wrong");
equal(plan50[2]?.cumulativeCount, 50, "wave plan cumulative count is wrong");

const first: StagedRolloutGateInput = {
  approvalValid: true,
  status: "ready",
  targetCount: 40,
  currentWave: 0,
  deliveredCount: 0,
  observationHoursRequired: 24,
  hoursObserved: 0,
  requiredContinueRuns: 12,
  consecutiveContinueRuns: 0,
  criticalAlerts: 0,
  monitorFailures: 0,
  inviteFailures: 0,
  lastHealthAction: "missing",
};

equal(evaluateNextStagedWave(first).allowed, true, "approved first wave must be allowed");
equal(evaluateNextStagedWave(first).nextWave?.size, 10, "first wave size is wrong");
equal(evaluateNextStagedWave({ ...first, approvalValid: false }).allowed, false, "missing approval passed");
equal(evaluateNextStagedWave({ ...first, status: "paused" }).allowed, false, "paused rollout passed");
equal(evaluateNextStagedWave({ ...first, inviteFailures: 1 }).allowed, false, "invite failure passed");

const second: StagedRolloutGateInput = {
  ...first,
  currentWave: 1,
  deliveredCount: 10,
  hoursObserved: 24,
  consecutiveContinueRuns: 12,
  lastHealthAction: "continue",
};
equal(evaluateNextStagedWave(second).allowed, true, "healthy second wave must be allowed");
equal(evaluateNextStagedWave({ ...second, hoursObserved: 23.99 }).allowed, false, "short observation passed");
equal(evaluateNextStagedWave({ ...second, consecutiveContinueRuns: 11 }).allowed, false, "short continue streak passed");
equal(evaluateNextStagedWave({ ...second, criticalAlerts: 1 }).allowed, false, "critical alert passed");
equal(evaluateNextStagedWave({ ...second, monitorFailures: 1 }).allowed, false, "monitor failure passed");
equal(evaluateNextStagedWave({ ...second, lastHealthAction: "watch" }).allowed, false, "watch health passed");
equal(evaluateNextStagedWave({ ...second, deliveredCount: 9 }).allowed, false, "wrong delivered count passed");

const complete = evaluateNextStagedWave({ ...second, currentWave: 3, deliveredCount: 40 });
equal(complete.allowed, false, "completed wave plan allowed another wave");
equal(complete.nextWave, null, "completed wave plan has next wave");

let rejected = false;
try {
  buildStagedWavePlan(29);
} catch {
  rejected = true;
}
equal(rejected, true, "invalid target count was accepted");

const firstFingerprint = evaluateNextStagedWave(second).fingerprint;
const secondFingerprint = evaluateNextStagedWave({ ...second }).fingerprint;
equal(firstFingerprint, secondFingerprint, "gate fingerprint is not deterministic");

console.log("staged 30-50 rollout gate tests passed (16 cases)");
