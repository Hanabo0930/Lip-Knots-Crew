import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;
type Validation = { valid: boolean; errors: string[] };

export const productionEvidenceReleaseId = "v5.6.0";
export const productionAcceptanceCheckKeys = [
  "project_access", "functions_inventory", "hosting_inventory", "staff_app", "staff_manifest",
  "admin_app", "admin_manifest", "login_gateway", "drive_preview",
] as const;
const deploymentResultKeys = ["project_access", "rules_and_storage", "functions", "hosting", "functions_inventory", "hosting_inventory", "staff_https", "admin_https"];
const rollbackResultKeys = ["project_access", "known_good_rules", "known_good_functions", "staff_hosting_clone", "admin_hosting_clone", "functions_inventory", "hosting_inventory", "staff_https", "admin_https"];
const shaPattern = /^[a-f0-9]{64}$/u;
const releasePattern = /^v\d+\.\d+\.\d+$/u;
const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;

export type ProductionEvidenceSummary = {
  schemaVersion: 1;
  releaseId: string;
  projectId: string;
  phase: "deployed"|"acceptance_observing"|"accepted"|"rollback_required"|"rollback_failed_locked"|"rollback_succeeded"|"recovery_observing"|"recovery_failed_locked"|"recovered";
  progressScore: number;
  packageFingerprint: string;
  deployment: { status: string; planFingerprint: string; evidenceFingerprint: string; approvedByEmail: string; changeTicketId: string; completedAt: string; passedStages: number };
  acceptance: null|{ status: string; validPasses: number; requiredPasses: number; runCount: number; failedCheckKeys: string[]; ledgerFingerprint: string; lastObservedAt: string|null; passedChecks: number };
  rollback: null|{ status: string; knownGoodReleaseId: string; planFingerprint: string; evidenceFingerprint: string; completedAt: string; failedStageKey: string|null; completedStages: number };
  recovery: null|{ status: string; releaseId: string; validPasses: number; requiredPasses: number; runCount: number; failedCheckKeys: string[]; ledgerFingerprint: string; lastObservedAt: string|null; passedChecks: number };
  timeline: Array<{ key: string; label: string; status: "passed"|"active"|"blocked"|"waiting"; at: string|null }>;
};

export function stableJson(value: unknown): string { return JSON.stringify(stable(value)); }
export function sha256(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex"); }

export function createProductionEvidenceSyncPackage(evidence: JsonRecord, createdAt = new Date().toISOString()): JsonRecord {
  const deployment = record(evidence.deploymentResult);
  const base = { schemaVersion: 1, releaseId: text(deployment.releaseId), projectId: text(deployment.projectId), createdAt, evidence };
  return { ...base, fingerprint: sha256(base) };
}

export function validateProductionEvidenceSyncPackage(value: unknown, { expectedReleaseId = productionEvidenceReleaseId, expectedProjectId }: { expectedReleaseId?: string; expectedProjectId: string }): Validation & { summary?: ProductionEvidenceSummary } {
  const errors: string[] = [];
  const pkg = record(value);
  const byteLength = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  if (byteLength > 900_000) errors.push("packageSize");
  if (pkg.schemaVersion !== 1) errors.push("schemaVersion");
  if (pkg.releaseId !== expectedReleaseId || !releasePattern.test(text(pkg.releaseId))) errors.push("releaseId");
  if (pkg.projectId !== expectedProjectId || !projectPattern.test(text(pkg.projectId))) errors.push("projectId");
  if (!validIso(pkg.createdAt)) errors.push("createdAt");
  if (Date.parse(text(pkg.createdAt)) > Date.now() + 5 * 60_000) errors.push("createdAtFuture");
  if (containsSecret(value)) errors.push("secretDetected");
  if (!verifyFingerprint(pkg)) errors.push("packageFingerprint");
  const evidence = record(pkg.evidence);
  const evidenceKeys = Object.keys(evidence);
  const allowedKeys = ["deploymentResult", "acceptanceLedger", "rollbackResult", "recoveryAcceptanceLedger"];
  if (!evidenceKeys.includes("deploymentResult") || evidenceKeys.some((key) => !allowedKeys.includes(key))) errors.push("evidenceInventory");

  const deployment = record(evidence.deploymentResult);
  errors.push(...validateDeployment(deployment, text(pkg.releaseId), text(pkg.projectId)));
  const acceptance = evidence.acceptanceLedger == null ? null : record(evidence.acceptanceLedger);
  if (acceptance) errors.push(...validateLedger(acceptance, { releaseId: text(pkg.releaseId), projectId: text(pkg.projectId), sourceKind: "deployment", sourcePlanFingerprint: text(deployment.planFingerprint) }).errors.map((item) => `acceptance.${item}`));
  const rollback = evidence.rollbackResult == null ? null : record(evidence.rollbackResult);
  if (rollback) errors.push(...validateRollback(rollback, { releaseId: text(pkg.releaseId), projectId: text(pkg.projectId), acceptance }).map((item) => `rollback.${item}`));
  const recovery = evidence.recoveryAcceptanceLedger == null ? null : record(evidence.recoveryAcceptanceLedger);
  if (recovery) {
    if (!rollback || rollback.status !== "rollback_succeeded") errors.push("recovery.rollbackNotSucceeded");
    else errors.push(...validateLedger(recovery, { releaseId: text(rollback.knownGoodReleaseId), projectId: text(pkg.projectId), sourceKind: "rollback", sourcePlanFingerprint: text(rollback.rollbackPlanFingerprint) }).errors.map((item) => `recovery.${item}`));
  }
  if (rollback && (!acceptance || acceptance.status !== "rollback_required")) errors.push("rollback.acceptanceNotFailed");
  if (acceptance?.status === "accepted" && (rollback || recovery)) errors.push("acceptedHasRollback");
  const uniqueErrors = [...new Set(errors)];
  if (uniqueErrors.length) return { valid: false, errors: uniqueErrors };
  return { valid: true, errors: [], summary: summarize(pkg, deployment, acceptance, rollback, recovery) };
}

function validateDeployment(value: JsonRecord, releaseId: string, projectId: string): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== 1 || value.releaseId !== releaseId || value.projectId !== projectId) errors.push("deployment.metadata");
  if (value.status !== "succeeded") errors.push("deployment.status");
  if (!shaPattern.test(text(value.planFingerprint))) errors.push("deployment.planFingerprint");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text(value.approvedByEmail))) errors.push("deployment.approvedByEmail");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{2,79}$/u.test(text(value.changeTicketId))) errors.push("deployment.changeTicketId");
  if (!validIso(value.startedAt) || !validIso(value.completedAt) || Date.parse(text(value.completedAt)) < Date.parse(text(value.startedAt))) errors.push("deployment.time");
  if (!verifyFingerprint(value)) errors.push("deployment.fingerprint");
  const resultKeys = Array.isArray(value.results) ? value.results.map(record).map((item) => text(item.key)) : [];
  if (!sameStrings(resultKeys, deploymentResultKeys)) errors.push("deployment.resultInventory");
  const results = resultMap(value.results);
  if (deploymentResultKeys.some((key) => Number(results.get(key)?.code) !== 0)) errors.push("deployment.results");
  return errors;
}

function validateLedger(value: JsonRecord, expected: { releaseId: string; projectId: string; sourceKind: "deployment"|"rollback"; sourcePlanFingerprint: string }): Validation {
  const errors: string[] = [];
  if (value.schemaVersion !== 1 || value.releaseId !== expected.releaseId || value.projectId !== expected.projectId) errors.push("metadata");
  if (!shaPattern.test(text(value.acceptancePlanFingerprint)) || value.deploymentPlanFingerprint !== expected.sourcePlanFingerprint) errors.push("planFingerprint");
  if (value.requiredPasses !== 3) errors.push("requiredPasses");
  if (!verifyFingerprint(value)) errors.push("fingerprint");
  const runs = Array.isArray(value.runs) ? value.runs.map(record) : [];
  if (!runs.length || runs.length > 20) errors.push("runs");
  let previousObserved = 0;
  for (const run of runs) {
    if (!verifyFingerprint(run)) errors.push("runFingerprint");
    if (run.schemaVersion !== 1 || run.releaseId !== expected.releaseId || run.projectId !== expected.projectId || run.sourceKind !== expected.sourceKind) errors.push("runMetadata");
    if (run.acceptancePlanFingerprint !== value.acceptancePlanFingerprint || run.deploymentPlanFingerprint !== expected.sourcePlanFingerprint) errors.push("runPlanFingerprint");
    const observed = Date.parse(text(run.observedAt)); const completed = Date.parse(text(run.deploymentCompletedAt));
    if (!Number.isFinite(observed) || !Number.isFinite(completed) || observed < completed || observed - completed > 30 * 60_000 || observed <= previousObserved) errors.push("runTime");
    previousObserved = observed;
    const checks = Array.isArray(run.checks) ? run.checks.map(record) : [];
    const keys = checks.map((item) => text(item.key));
    if (!sameStrings(keys, [...productionAcceptanceCheckKeys])) errors.push("checkInventory");
    if (run.passed !== checks.every((item) => item.passed === true)) errors.push("runPassed");
  }
  const spacedPasses: JsonRecord[] = [];
  for (const run of runs.filter((item) => item.passed === true)) {
    const prior = spacedPasses.at(-1);
    if (!prior || Date.parse(text(run.observedAt)) - Date.parse(text(prior.observedAt)) >= 5 * 60_000) spacedPasses.push(run);
  }
  const failed = runs.find((item) => item.passed !== true);
  const expectedStatus = failed ? "rollback_required" : spacedPasses.length >= 3 ? "accepted" : "observing";
  if (value.status !== expectedStatus || value.validPasses !== spacedPasses.length) errors.push("ledgerState");
  const failedKeys = failed ? (Array.isArray(failed.checks) ? failed.checks.map(record).filter((item) => item.passed !== true).map((item) => text(item.key)) : []) : [];
  if (!sameStrings(Array.isArray(value.failedCheckKeys) ? value.failedCheckKeys.map(text) : [], failedKeys)) errors.push("failedCheckKeys");
  if (expectedStatus === "observing") {
    const last = spacedPasses.at(-1) ?? runs.at(-1); const expectedNext = new Date(Date.parse(text(last?.observedAt)) + 5 * 60_000).toISOString();
    if (value.nextEligibleAt !== expectedNext) errors.push("nextEligibleAt");
  } else if (value.nextEligibleAt !== null) errors.push("nextEligibleAt");
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function validateRollback(value: JsonRecord, expected: { releaseId: string; projectId: string; acceptance: JsonRecord|null }): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== 1 || value.releaseId !== expected.releaseId || value.projectId !== expected.projectId || !releasePattern.test(text(value.knownGoodReleaseId)) || value.knownGoodReleaseId === expected.releaseId) errors.push("metadata");
  if (!shaPattern.test(text(value.rollbackPlanFingerprint)) || value.acceptanceLedgerFingerprint !== expected.acceptance?.fingerprint) errors.push("fingerprintChain");
  if (!verifyFingerprint(value)) errors.push("fingerprint");
  if (!validIso(value.startedAt) || !validIso(value.completedAt) || Date.parse(text(value.completedAt)) < Date.parse(text(value.startedAt))) errors.push("time");
  const status = text(value.status); const results = Array.isArray(value.results) ? value.results.map(record) : []; const map = resultMap(results);
  if (status === "rollback_succeeded") {
    if (value.failedStageKey !== null || !sameStrings(results.map((item) => text(item.key)), rollbackResultKeys) || rollbackResultKeys.some((key) => Number(map.get(key)?.code) !== 0)) errors.push("successfulResults");
  } else if (status === "rollback_failed_locked") {
    const failedKey = text(value.failedStageKey); const index = rollbackResultKeys.indexOf(failedKey);
    const expectedKeys = index < 0 ? [] : rollbackResultKeys.slice(0, index + 1);
    if (index < 0 || !sameStrings(results.map((item) => text(item.key)), expectedKeys) || expectedKeys.slice(0, -1).some((key) => Number(map.get(key)?.code) !== 0) || Number(map.get(failedKey)?.code) === 0) errors.push("failedResults");
  } else errors.push("status");
  return errors;
}

function summarize(pkg: JsonRecord, deployment: JsonRecord, acceptance: JsonRecord|null, rollback: JsonRecord|null, recovery: JsonRecord|null): ProductionEvidenceSummary {
  const acceptanceSummary = acceptance ? ledgerSummary(acceptance) : null;
  const recoverySummary = recovery ? { releaseId: text(recovery.releaseId), ...ledgerSummary(recovery) } : null;
  let phase: ProductionEvidenceSummary["phase"] = "deployed";
  if (acceptance?.status === "observing") phase = "acceptance_observing";
  if (acceptance?.status === "accepted") phase = "accepted";
  if (acceptance?.status === "rollback_required") phase = "rollback_required";
  if (rollback?.status === "rollback_failed_locked") phase = "rollback_failed_locked";
  if (rollback?.status === "rollback_succeeded") phase = "rollback_succeeded";
  if (recovery?.status === "observing") phase = "recovery_observing";
  if (recovery?.status === "rollback_required") phase = "recovery_failed_locked";
  if (recovery?.status === "accepted") phase = "recovered";
  const runCount = Number(acceptanceSummary?.runCount ?? 0); const recoveryRunCount = Number(recoverySummary?.runCount ?? 0);
  const progressScore = phase === "deployed" ? 100 : phase === "acceptance_observing" ? 200 + Number(acceptanceSummary?.validPasses ?? 0) * 20 + runCount : phase === "accepted" ? 300 : phase === "rollback_required" ? 400 : phase === "rollback_failed_locked" ? 500 : phase === "rollback_succeeded" ? 600 : phase === "recovery_observing" ? 700 + Number(recoverySummary?.validPasses ?? 0) * 20 + recoveryRunCount : phase === "recovery_failed_locked" ? 800 : 900;
  const timeline: ProductionEvidenceSummary["timeline"] = [
    { key: "deploy", label: "承認付き本番デプロイ", status: "passed", at: text(deployment.completedAt) },
    { key: "acceptance", label: "本番受入 3回", status: phase === "deployed" ? "waiting" : acceptance?.status === "accepted" ? "passed" : acceptance?.status === "rollback_required" ? "blocked" : "active", at: latestRunAt(acceptance) },
    { key: "rollback", label: "既知正常版rollback", status: !rollback ? (phase === "rollback_required" ? "active" : "waiting") : rollback.status === "rollback_succeeded" ? "passed" : "blocked", at: rollback ? text(rollback.completedAt) : null },
    { key: "recovery", label: "復旧受入 3回", status: !recovery ? "waiting" : recovery.status === "accepted" ? "passed" : recovery.status === "rollback_required" ? "blocked" : "active", at: latestRunAt(recovery) },
  ];
  return { schemaVersion: 1, releaseId: text(pkg.releaseId), projectId: text(pkg.projectId), phase, progressScore, packageFingerprint: text(pkg.fingerprint), deployment: { status: text(deployment.status), planFingerprint: text(deployment.planFingerprint), evidenceFingerprint: text(deployment.fingerprint), approvedByEmail: text(deployment.approvedByEmail), changeTicketId: text(deployment.changeTicketId), completedAt: text(deployment.completedAt), passedStages: deploymentResultKeys.filter((key) => Number(resultMap(deployment.results).get(key)?.code) === 0).length }, acceptance: acceptanceSummary, rollback: rollback ? { status: text(rollback.status), knownGoodReleaseId: text(rollback.knownGoodReleaseId), planFingerprint: text(rollback.rollbackPlanFingerprint), evidenceFingerprint: text(rollback.fingerprint), completedAt: text(rollback.completedAt), failedStageKey: rollback.failedStageKey == null ? null : text(rollback.failedStageKey), completedStages: (Array.isArray(rollback.results) ? rollback.results.map(record) : []).filter((item) => Number(item.code) === 0).length } : null, recovery: recoverySummary, timeline };
}

function ledgerSummary(value: JsonRecord) { const runs = Array.isArray(value.runs) ? value.runs.map(record) : []; const last = runs.at(-1); const checks = Array.isArray(last?.checks) ? last.checks.map(record) : []; return { status: text(value.status), validPasses: Number(value.validPasses ?? 0), requiredPasses: Number(value.requiredPasses ?? 3), runCount: runs.length, failedCheckKeys: Array.isArray(value.failedCheckKeys) ? value.failedCheckKeys.map(text) : [], ledgerFingerprint: text(value.fingerprint), lastObservedAt: last ? text(last.observedAt) : null, passedChecks: checks.filter((item) => item.passed === true).length }; }
function latestRunAt(value: JsonRecord|null) { const runs = Array.isArray(value?.runs) ? value.runs.map(record) : []; return runs.length ? text(runs.at(-1)?.observedAt) : null; }
function verifyFingerprint(value: JsonRecord) { const fingerprint = text(value.fingerprint); if (!shaPattern.test(fingerprint)) return false; const base = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "fingerprint")); return sha256(base) === fingerprint; }
function resultMap(value: unknown) { const results = Array.isArray(value) ? value.map(record) : []; return new Map(results.map((item) => [text(item.key), item])); }
function sameStrings(actual: string[], expected: string[]) { return actual.length === expected.length && actual.every((value, index) => value === expected[index]); }
function validIso(value: unknown) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function record(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(value: unknown): string { return String(value ?? ""); }
function stable(value: unknown): unknown { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as JsonRecord).sort().map((key) => [key, stable((value as JsonRecord)[key])])); return value; }
function containsSecret(value: unknown): boolean { if (typeof value === "string") return /-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]{12,}/iu.test(value); if (Array.isArray(value)) return value.some(containsSecret); if (!value || typeof value !== "object") return false; return Object.entries(value as JsonRecord).some(([key, item]) => (/access[_-]?token|refresh[_-]?token|authorization|private[_-]?key|client[_-]?secret/iu.test(key) && text(item) && text(item) !== "[REDACTED]") || containsSecret(item)); }
