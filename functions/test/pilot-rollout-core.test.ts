import {
  defaultPilotMetrics,
  defaultPilotMonitoringThresholds,
  evaluatePilotMonitoring,
  evaluatePilotReadiness,
  PilotMonitoringSnapshot,
} from "../src/pilot-rollout-core";

function equal(a: unknown, b: unknown, message: string) {
  if (a !== b) throw new Error(message);
}

const healthy: PilotMonitoringSnapshot = {
  sheetWriteBlocked: 0,
  sheetWriteDeadLetters: 0,
  rowCreationBlocked: 0,
  rowCreationDeadLetters: 0,
  manualInterventions: 0,
  notificationErrors: 0,
  inviteFailures: 0,
  retryingQueues: 0,
  unactivatedParticipants: 0,
  inactiveParticipants: 0,
};

const metrics = defaultPilotMetrics();
equal(evaluatePilotReadiness("staff_3_5", metrics).ready, true, "default pass");
metrics[0]!.value = 1;
equal(evaluatePilotReadiness("staff_3_5", metrics).ready, false, "write error blocks");

let result = evaluatePilotMonitoring(healthy);
equal(result.action, "continue", "healthy pilot should continue");
equal(result.alerts.length, 0, "healthy pilot has alerts");

result = evaluatePilotMonitoring({ ...healthy, sheetWriteBlocked: 1 });
equal(result.action, "pause", "blocked sheet write must pause");

result = evaluatePilotMonitoring({ ...healthy, rowCreationDeadLetters: 1 });
equal(result.action, "pause", "row creation dead letter must pause");

result = evaluatePilotMonitoring({ ...healthy, retryingQueues: 3 });
equal(result.action, "watch", "retry warning must watch");

result = evaluatePilotMonitoring({ ...healthy, unactivatedParticipants: 2 });
equal(result.action, "watch", "unactivated participant must watch");

const relaxed = defaultPilotMonitoringThresholds();
relaxed.retryingQueues = 5;
result = evaluatePilotMonitoring({ ...healthy, retryingQueues: 3 }, relaxed);
equal(result.action, "continue", "threshold override ignored");

const first = evaluatePilotMonitoring({ ...healthy, notificationErrors: 1 });
const second = evaluatePilotMonitoring({ ...healthy, notificationErrors: 1 });
equal(first.fingerprint, second.fingerprint, "fingerprint must be deterministic");

let rejected = false;
try {
  evaluatePilotMonitoring({ ...healthy, inviteFailures: -1 });
} catch {
  rejected = true;
}
equal(rejected, true, "negative metric must be rejected");

console.log("pilot rollout and monitoring core tests passed (10 cases)");
