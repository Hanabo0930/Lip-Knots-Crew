import {
  evaluatePilotExpansion,
  PilotExpansionAutomated,
  PilotOutcomeInput,
} from "../src/pilot-expansion-core";

function equal(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(message);
}

const automated: PilotExpansionAutomated = {
  pilotCompleted: true,
  participantCount: 5,
  durationDays: 7,
  inviteFailures: 0,
  healthRunCount: 1900,
  expectedHealthRuns: 2017,
  monitoringCoveragePct: 94.2,
  monitorFailureCount: 0,
  criticalAlertCount: 0,
  watchAlertCount: 0,
  lastHealthAction: "continue",
};

const outcome: PilotOutcomeInput = {
  totalCases: 20,
  completedCases: 20,
  moneyDiffYen: 0,
  doubleBookings: 0,
  mailTargetDiff: 0,
  pdfDiff: 0,
  manualQueue: 0,
  supportCases: 0,
  evidenceRefs: ["evidence/pilot-result.csv", "evidence/monitoring.json"],
  notes: "verified",
};

equal(evaluatePilotExpansion(automated, outcome).eligible, true, "healthy pilot must be eligible");
equal(evaluatePilotExpansion({ ...automated, pilotCompleted: false }, outcome).eligible, false, "incomplete pilot passed");
equal(evaluatePilotExpansion({ ...automated, participantCount: 6 }, outcome).eligible, false, "participant limit passed");
equal(evaluatePilotExpansion({ ...automated, durationDays: 6 }, outcome).eligible, false, "short pilot passed");
equal(evaluatePilotExpansion({ ...automated, monitoringCoveragePct: 89.9 }, outcome).eligible, false, "low coverage passed");
equal(evaluatePilotExpansion({ ...automated, criticalAlertCount: 1 }, outcome).eligible, false, "critical alert passed");
equal(evaluatePilotExpansion({ ...automated, monitorFailureCount: 1 }, outcome).eligible, false, "monitor failure passed");
equal(evaluatePilotExpansion(automated, { ...outcome, totalCases: 9, completedCases: 9 }).eligible, false, "small case volume passed");
equal(evaluatePilotExpansion(automated, { ...outcome, moneyDiffYen: 1 }).eligible, false, "money difference passed");
equal(evaluatePilotExpansion(automated, { ...outcome, completedCases: 18 }).eligible, false, "low completion passed");

const warned = evaluatePilotExpansion(
  { ...automated, watchAlertCount: 2 },
  { ...outcome, supportCases: 6 }
);
equal(warned.eligible, true, "warnings should not block");
equal(warned.warnings.length, 2, "warnings are missing");

const first = evaluatePilotExpansion(automated, outcome);
const second = evaluatePilotExpansion(automated, { ...outcome, evidenceRefs: [...outcome.evidenceRefs].reverse() });
equal(first.fingerprint, second.fingerprint, "fingerprint is not deterministic");

let rejected = false;
try {
  evaluatePilotExpansion(automated, { ...outcome, completedCases: 21 });
} catch {
  rejected = true;
}
equal(rejected, true, "invalid outcome was accepted");

console.log("pilot expansion approval gate tests passed (13 cases)");
