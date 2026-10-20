/**
 * Validate a reviewed limited-pilot record. This is a pure evidence gate, not a
 * source-provenance check or an authenticated browser test. Review declarations
 * remain declarations: the protected reviewer must inspect their source records.
 */
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {requireProtectedContext, validateHostingOperation} from "./hosting-operation-context.mjs";
import {PILOT_FUNCTIONS, normalizePilotFunction} from "./collect-hosting-pilot-metadata.mjs";

const PROJECT = "lip-knots-crew-staging", REGION = "asia-northeast1";
const POLICY = "limited-staff-pilot";
const SHA = /^[a-f0-9]{40}$/u, DIGEST = /^sha256:[a-f0-9]{64}$/u;
const VERSION = /^[a-f0-9]{16}$/u, RUN = /^[1-9][0-9]{0,19}$/u;
const MAX_BYTES = 48 * 1024, MAX_AGE = 24 * 60 * 60 * 1000;
export const PILOT_READ_SCOPE = Object.freeze([
  "emailIndex:fixed-recipient", "staffProfiles:fixed-staff",
  "jobs:company-assigned-upcoming-301", "jobs:company-assigned-history-51",
  "jobs:company-open-101", "getMyTasks:company-staff-jobs-2000",
  "getMyTasks:open-resubmissions-100-and-referenced-jobs",
  "deviceSessions:current-session", "pushTokens:company-uid-role-staff-paged",
]);
export const PILOT_WRITE_SCOPE = Object.freeze(["login-records", "device-session-records"]);
export class PilotEvidenceError extends Error {}
const requireValue = (condition, code) => {if (!condition) throw new PilotEvidenceError(code);};
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
function keys(value, required, optional = []) {
  requireValue(plain(value) && required.every(k => Object.hasOwn(value, k))
    && Object.keys(value).every(k => required.includes(k) || optional.includes(k)), "PILOT_FIELDS_REJECTED");
}
function exactList(actual, expected, code) {
  requireValue(Array.isArray(actual) && actual.length === expected.length
    && actual.every((v, i) => v === expected[i]), code);
}
function timestamp(value) {
  requireValue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "PILOT_TIME_REJECTED");
  return Date.parse(value);
}
function evidenceReference(value) {requireValue(typeof value === "string" && DIGEST.test(value), "PILOT_RECORD_DIGEST_REQUIRED");}
function validateMailAttempts(attempts) {
  requireValue(Array.isArray(attempts) && attempts.length <= 1, "PILOT_SINGLE_RECIPIENT_MAIL_LEDGER_REQUIRED");
  for (const attempt of attempts) {
    keys(attempt, ["outcome", "evidenceDigest"]);
    requireValue(["SENT", "CONFIRMED_NOT_SENT"].includes(attempt.outcome), "PILOT_MAIL_OUTCOME_UNRESOLVED");
    evidenceReference(attempt.evidenceDigest);
  }
}
function versionPair(value) {
  keys(value, ["staff", "admin"]);
  requireValue(typeof value.staff === "string" && typeof value.admin === "string"
    && VERSION.test(value.staff) && VERSION.test(value.admin), "PILOT_VERSION_REJECTED");
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function pilotEvidenceDigest(value) {
  return "sha256:" + createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function validateEvidencePolicy({policy = "source-provenance", eventName, operation, metadataOnly = false, runAttempt = 1}) {
  requireValue(["source-provenance", POLICY].includes(policy), "EVIDENCE_POLICY_REJECTED");
  if (policy === POLICY) {
    requireValue(eventName === "workflow_dispatch", "LIMITED_PILOT_MANUAL_ONLY");
    requireValue(["promote", "readiness"].includes(operation) && metadataOnly === false,
      "LIMITED_PILOT_OPERATION_REJECTED");
    requireValue(runAttempt === 1, "LIMITED_PILOT_RERUN_REJECTED");
  }
  return policy;
}

function validateReview(review, {operation, pilotId, createdAt, expiresAt}) {
  keys(review, ["recordDigest", "cost", "account", "scope", "mail", "previewAuth", "recovery"]);
  evidenceReference(review.recordDigest);
  const {cost, account, scope, mail, previewAuth} = review;
  keys(cost, ["actions", "hosting", "apiAndFirestore", "evidenceDigest"]);
  requireValue(cost.actions === "NO_ADDITIONAL_COST" && cost.hosting === "NO_ADDITIONAL_COST"
    && cost.apiAndFirestore === "NO_ADDITIONAL_COST", "PILOT_NO_FEE_EVIDENCE_REQUIRED");
  evidenceReference(cost.evidenceDigest);
  keys(account, ["identityDigest", "existingDedicatedStaff", "emailVerified", "activeProfileAndEmailIndex",
    "exactExistingStaffClaims", "excludedFromAdminEmails", "gatewayNonproduction", "evidenceDigest"]);
  evidenceReference(account.identityDigest); evidenceReference(account.evidenceDigest);
  requireValue(account.existingDedicatedStaff === true && account.emailVerified === true
    && account.activeProfileAndEmailIndex === true && account.exactExistingStaffClaims === true
    && account.excludedFromAdminEmails === true && account.gatewayNonproduction === true,
  "PILOT_EXISTING_STAFF_ACCOUNT_REQUIRED");
  keys(scope, ["functions", "firestoreReads", "allowedWrites", "requestBoundaryEnforced",
    "admin", "authClaimsWrites", "businessMutations", "uploadAndStorage", "transferPause",
    "pushRegistration", "evidenceDigest"]);
  exactList(scope.functions, PILOT_FUNCTIONS, "PILOT_FUNCTION_SCOPE_REJECTED");
  exactList(scope.firestoreReads, PILOT_READ_SCOPE, "PILOT_READ_SCOPE_REJECTED");
  exactList(scope.allowedWrites, PILOT_WRITE_SCOPE, "PILOT_WRITE_SCOPE_REJECTED");
  requireValue(scope.requestBoundaryEnforced === true && scope.admin === "SIGNED_OUT_INITIAL_SCREEN_ONLY"
    && scope.authClaimsWrites === "FORBIDDEN" && scope.businessMutations === "FORBIDDEN"
    && scope.uploadAndStorage === "FORBIDDEN" && scope.transferPause === "UNOBSERVED_UNCHANGED"
    && scope.pushRegistration === "FORBIDDEN", "PILOT_SIDE_EFFECT_BOUNDARY_REQUIRED");
  evidenceReference(scope.evidenceDigest);
  keys(mail, ["pilotId", "recipientDigest", "maximumMessages", "attempts", "completeHistory",
    "irreversibleAcknowledged", "evidenceDigest"]);
  requireValue(mail.pilotId === pilotId && mail.recipientDigest === account.identityDigest
    && mail.maximumMessages === 1 && mail.completeHistory === true
    && mail.irreversibleAcknowledged === true && Array.isArray(mail.attempts) && mail.attempts.length <= 1,
  "PILOT_SINGLE_RECIPIENT_MAIL_LEDGER_REQUIRED");
  evidenceReference(mail.evidenceDigest);
  // An unknown delivery outcome consumes the single attempt and blocks further
  // progression until read-only evidence resolves it. Never infer not-sent.
  validateMailAttempts(mail.attempts);
  keys(previewAuth, ["status", "reason", "evidenceDigest"]);
  requireValue(["SUPPORTED", "UNSUPPORTED_VERIFIED", "UNKNOWN"].includes(previewAuth.status),
    "PILOT_PREVIEW_AUTH_REJECTED");
  evidenceReference(previewAuth.evidenceDigest);
  if (previewAuth.status === "UNSUPPORTED_VERIFIED") {
    requireValue(["EXISTING_AUTHORIZED_DOMAINS_EXCLUDE_PREVIEW", "OBSERVED_AUTH_UNAUTHORIZED_DOMAIN"].includes(previewAuth.reason),
      "PILOT_PREVIEW_AUTH_PROOF_REQUIRED");
  } else requireValue(previewAuth.reason === "NONE", "PILOT_PREVIEW_AUTH_REJECTED");
  if (operation === "promote") requireValue(previewAuth.status === "UNSUPPORTED_VERIFIED",
    "PILOT_STAGING_FALLBACK_NOT_PROVEN");
  const {recovery} = review;
  keys(recovery, ["bothPreviousVersionsAvailable", "restoreWorkflowVerified", "retainUntil",
    "cleanupBeforeAcceptance", "externalWritersExcluded", "externalWritersExcludedUntil", "evidenceDigest"]);
  requireValue(recovery.bothPreviousVersionsAvailable === true && recovery.restoreWorkflowVerified === true
    && recovery.cleanupBeforeAcceptance === false && timestamp(recovery.retainUntil) >= timestamp(expiresAt)
    && timestamp(recovery.retainUntil) <= timestamp(createdAt) + MAX_AGE
    && recovery.externalWritersExcluded === true && timestamp(recovery.externalWritersExcludedUntil) >= timestamp(expiresAt),
  "PILOT_RECOVERY_EVIDENCE_REQUIRED");
  evidenceReference(recovery.evidenceDigest);
}

function validateFunctionPins(functions) {
  keys(functions, [...PILOT_FUNCTIONS]);
  for (const name of PILOT_FUNCTIONS) {
    const item = functions[name];
    keys(item, ["name", "function", "state", "environment", "runtime", "entryPoint", "build",
      "service", "revision", "allTrafficOnLatestRevision", "updateTime"]);
    const normalized = normalizePilotFunction({
      name: item.name, state: item.state, environment: item.environment, updateTime: item.updateTime,
      buildConfig: {build: item.build, runtime: item.runtime, entryPoint: item.entryPoint},
      serviceConfig: {service: item.service, revision: item.revision, allTrafficOnLatestRevision: item.allTrafficOnLatestRevision},
    }, name);
    requireValue(item.function === name && pilotEvidenceDigest(normalized) === pilotEvidenceDigest(item),
      "PILOT_FUNCTION_PIN_REJECTED");
  }
}

/** Validates supplied declarations, not the truth of their external source records. */
export function validateLimitedPilotPreflight(evidence, {sourceSha, operation = "readiness", now = new Date().toISOString()} = {}) {
  requireValue(["readiness", "promote"].includes(operation), "LIMITED_PILOT_OPERATION_REJECTED");
  keys(evidence, ["schemaVersion", "policy", "projectId", "region", "sourceSha", "pilotId", "createdAt",
    "expiresAt", "sourceAuthenticity", "submissionAcceptance", "review", "hosting", "functions"]);
  requireValue(evidence.schemaVersion === 1 && evidence.policy === POLICY, "PILOT_SCHEMA_REJECTED");
  requireValue(evidence.projectId === PROJECT && evidence.region === REGION, "PILOT_ENVIRONMENT_REJECTED");
  requireValue(typeof sourceSha === "string" && SHA.test(sourceSha) && evidence.sourceSha === sourceSha, "PILOT_SOURCE_SHA_MISMATCH");
  requireValue(/^[a-f0-9]{32}$/u.test(evidence.pilotId ?? ""), "PILOT_ID_REJECTED");
  requireValue(evidence.sourceAuthenticity === "UNVERIFIED" && evidence.submissionAcceptance === "UNVERIFIED",
    "PILOT_UNPROVEN_SCOPE_CANNOT_PASS");
  const current = timestamp(now), created = timestamp(evidence.createdAt), expires = timestamp(evidence.expiresAt);
  requireValue(created <= current && current < expires && expires > created && expires - created <= MAX_AGE
    && current - created <= MAX_AGE, "PILOT_REVIEW_EXPIRED_OR_FUTURE");
  keys(evidence.hosting, ["previewRunId", "previewRunAttempt", "previewVersions", "previousVersions"]);
  requireValue(typeof evidence.hosting.previewRunId === "string" && RUN.test(evidence.hosting.previewRunId)
    && evidence.hosting.previewRunAttempt === 1,
    "PILOT_PREVIEW_RUN_REJECTED");
  versionPair(evidence.hosting.previewVersions); versionPair(evidence.hosting.previousVersions);
  for (const label of ["staff", "admin"]) requireValue(
    evidence.hosting.previewVersions[label] !== evidence.hosting.previousVersions[label], "PILOT_VERSION_PAIR_REJECTED");
  validateReview(evidence.review, {operation, pilotId: evidence.pilotId,
    createdAt: evidence.createdAt, expiresAt: evidence.expiresAt});
  validateFunctionPins(evidence.functions);
  return Object.freeze({schemaVersion: 1, policy: POLICY, evidenceValidation: "VALID",
    evidenceDigest: pilotEvidenceDigest(evidence), sourceSha, pilotId: evidence.pilotId,
    declarationsRequireProtectedReview: true, sourceAuthenticity: "UNVERIFIED", submissionAcceptance: "UNVERIFIED"});
}

function validateSnapshot(snapshot, {sourceSha, now}) {
  requireValue(typeof sourceSha === "string" && SHA.test(sourceSha), "PILOT_SOURCE_SHA_MISMATCH");
  keys(snapshot, ["schemaVersion", "status", "policy", "projectId", "region", "sourceSha",
    "sourceAuthenticity", "submissionAcceptance", "hostingPromotionAuthorized", "apiCompatibilityVerified",
    "observation", "functions", "requests"]);
  requireValue(snapshot?.schemaVersion === 1 && snapshot.status === "METADATA_COLLECTED"
    && snapshot.policy === POLICY && snapshot.projectId === PROJECT && snapshot.region === REGION
    && snapshot.sourceSha === sourceSha && snapshot.sourceAuthenticity === "UNVERIFIED"
    && snapshot.submissionAcceptance === "UNVERIFIED" && snapshot.hostingPromotionAuthorized === false
    && snapshot.apiCompatibilityVerified === false,
  "PILOT_METADATA_SNAPSHOT_REJECTED");
  keys(snapshot.observation, ["runId", "runAttempt", "capturedAt"]);
  requireValue(typeof snapshot.observation.runId === "string" && RUN.test(snapshot.observation.runId)
    && snapshot.observation.runAttempt === 1,
    "PILOT_METADATA_RUN_REJECTED");
  const age = timestamp(now) - timestamp(snapshot.observation.capturedAt);
  requireValue(age >= 0 && age <= 10 * 60 * 1000, "PILOT_METADATA_STALE");
  requireValue(Array.isArray(snapshot.requests) && snapshot.requests.length === PILOT_FUNCTIONS.length,
    "PILOT_METADATA_REQUESTS_INCOMPLETE");
  for (const [index, request] of snapshot.requests.entries()) {
    keys(request, ["method", "function", "status"]);
    requireValue(request.method === "GET" && request.function === PILOT_FUNCTIONS[index] && request.status === 200,
      "PILOT_METADATA_REQUESTS_INCOMPLETE");
  }
  validateFunctionPins(snapshot.functions);
}

export function validateLimitedPilotEvidence({evidence, sourceSha, previewRunId, previewVersions,
  previousVersions, snapshot, currentRunId, operation = "readiness", now = new Date().toISOString()}) {
  const result = validateLimitedPilotPreflight(evidence, {sourceSha, operation, now});
  versionPair(previewVersions); versionPair(previousVersions);
  requireValue(previewRunId === evidence.hosting.previewRunId
    && pilotEvidenceDigest(previewVersions) === pilotEvidenceDigest(evidence.hosting.previewVersions)
    && pilotEvidenceDigest(previousVersions) === pilotEvidenceDigest(evidence.hosting.previousVersions),
  "PILOT_HOSTING_PIN_MISMATCH");
  validateSnapshot(snapshot, {sourceSha, now});
  requireValue(snapshot.observation.runId === currentRunId, "PILOT_METADATA_RUN_MISMATCH");
  requireValue(pilotEvidenceDigest(snapshot.functions) === pilotEvidenceDigest(evidence.functions),
    "PILOT_DEPLOYMENT_PIN_MISMATCH");
  return Object.freeze({...result, readinessState: "PREAUTH_READY",
    stagingTrialAuthorized: operation === "promote", authenticatedStaffAcceptance: "UNVERIFIED",
    deploymentSnapshotDigest: pilotEvidenceDigest(snapshot.functions), observationRunId: currentRunId,
    hosting: structuredClone(evidence.hosting), accountDigest: evidence.review.account.identityDigest,
    mailAttemptsConsumed: evidence.review.mail.attempts.length,
    mailAttempts: structuredClone(evidence.review.mail.attempts),
    mailRecipientDigest: evidence.review.mail.recipientDigest,
    reviewedReadScopeDigest: pilotEvidenceDigest(evidence.review.scope), checkedAt: now,
    expiresAt: evidence.expiresAt,
    backupAndPreviewCleanupAuthorized: false, adminAuthenticated: false});
}

export function recheckPilotDeployment({before, after, sourceSha, currentRunId, now = new Date().toISOString()}) {
  requireValue(typeof currentRunId === "string" && RUN.test(currentRunId), "PILOT_METADATA_RUN_MISMATCH");
  validateSnapshot(before, {sourceSha, now}); validateSnapshot(after, {sourceSha, now});
  requireValue(before.observation.runId === currentRunId && after.observation.runId === currentRunId,
    "PILOT_METADATA_RUN_MISMATCH");
  requireValue(timestamp(after.observation.capturedAt) >= timestamp(before.observation.capturedAt)
    && pilotEvidenceDigest(before.functions) === pilotEvidenceDigest(after.functions),
  "PILOT_DEPLOYMENT_CHANGED");
  return {schemaVersion: 1, policy: POLICY, evidenceValidation: "VALID", deploymentUnchanged: true,
    sourceSha, observationRunId: currentRunId, beforeSnapshotDigest: pilotEvidenceDigest(before),
    afterSnapshotDigest: pilotEvidenceDigest(after), deploymentSnapshotDigest: pilotEvidenceDigest(after.functions),
    checkedAt: now, sourceAuthenticity: "UNVERIFIED"};
}

/**
 * Validate transition input format and consistency, not the authenticity of an
 * external record. Only preauth and trial reports can advance to another state.
 */
export function validatePilotReport(report, {
  now = new Date().toISOString(), allowedStates = ["PREAUTH_READY", "STAGING_TRIAL"],
} = {}) {
  requireValue(Array.isArray(allowedStates) && allowedStates.length > 0
    && allowedStates.every(state => ["PREAUTH_READY", "STAGING_TRIAL"].includes(state))
    && allowedStates.includes(report?.readinessState), "PILOT_PREAUTH_REPORT_REQUIRED");
  const trial = report.readinessState === "STAGING_TRIAL";
  keys(report, ["schemaVersion", "policy", "evidenceValidation", "evidenceDigest", "sourceSha", "pilotId",
    "declarationsRequireProtectedReview", "sourceAuthenticity", "submissionAcceptance", "readinessState",
    "stagingTrialAuthorized", "authenticatedStaffAcceptance", "deploymentSnapshotDigest", "observationRunId",
    "hosting", "accountDigest", "mailAttemptsConsumed", "mailAttempts", "mailRecipientDigest",
    "reviewedReadScopeDigest", "checkedAt", "expiresAt", "backupAndPreviewCleanupAuthorized", "adminAuthenticated",
    ...(trial ? ["trialRecordedAt"] : [])]);
  requireValue(report.schemaVersion === 1 && report.policy === POLICY && report.evidenceValidation === "VALID"
    && report.declarationsRequireProtectedReview === true
    && report.sourceAuthenticity === "UNVERIFIED" && report.submissionAcceptance === "UNVERIFIED"
    && report.authenticatedStaffAcceptance === "UNVERIFIED" && report.backupAndPreviewCleanupAuthorized === false
    && report.adminAuthenticated === false && typeof report.stagingTrialAuthorized === "boolean",
  "PILOT_REPORT_INVARIANT_REJECTED");
  requireValue(typeof report.sourceSha === "string" && SHA.test(report.sourceSha)
    && typeof report.pilotId === "string" && /^[a-f0-9]{32}$/u.test(report.pilotId)
    && typeof report.observationRunId === "string" && RUN.test(report.observationRunId),
  "PILOT_REPORT_IDENTITY_REJECTED");
  for (const field of ["evidenceDigest", "deploymentSnapshotDigest", "accountDigest",
    "mailRecipientDigest", "reviewedReadScopeDigest"]) evidenceReference(report[field]);
  requireValue(report.mailRecipientDigest === report.accountDigest, "PILOT_REPORT_IDENTITY_REJECTED");
  keys(report.hosting, ["previewRunId", "previewRunAttempt", "previewVersions", "previousVersions"]);
  requireValue(typeof report.hosting.previewRunId === "string" && RUN.test(report.hosting.previewRunId)
    && report.hosting.previewRunAttempt === 1, "PILOT_PREVIEW_RUN_REJECTED");
  versionPair(report.hosting.previewVersions); versionPair(report.hosting.previousVersions);
  for (const label of ["staff", "admin"]) requireValue(
    report.hosting.previewVersions[label] !== report.hosting.previousVersions[label], "PILOT_VERSION_PAIR_REJECTED");
  validateMailAttempts(report.mailAttempts);
  requireValue(Number.isInteger(report.mailAttemptsConsumed)
    && report.mailAttemptsConsumed === report.mailAttempts.length, "PILOT_SINGLE_RECIPIENT_MAIL_LEDGER_REQUIRED");
  const current = timestamp(now), checked = timestamp(report.checkedAt), expires = timestamp(report.expiresAt);
  requireValue(checked <= current && current < expires && expires > checked && expires - checked <= MAX_AGE,
    "PILOT_REVIEW_EXPIRED_OR_FUTURE");
  if (trial) requireValue(report.stagingTrialAuthorized === true
    && timestamp(report.trialRecordedAt) >= checked && timestamp(report.trialRecordedAt) <= current
    && timestamp(report.trialRecordedAt) < expires, "PILOT_TRIAL_REPORT_REJECTED");
  return report;
}

/** A successful Hosting trial remains unauthenticated until a separate observation is evaluated. */
export function recordStagingTrial({report, manifest, currentRunId, now = new Date().toISOString()}) {
  validatePilotReport(report, {now, allowedStates: ["PREAUTH_READY"]});
  requireValue(report.stagingTrialAuthorized === true
    && report.observationRunId === currentRunId, "PILOT_PREAUTH_REPORT_REQUIRED");
  requireValue(manifest?.schemaVersion === 1 && manifest.operation === "promote"
    && manifest.projectId === PROJECT && manifest.region === REGION && manifest.sourceSha === report.sourceSha
    && manifest.promotionRunId === currentRunId && manifest.runAttempt === 1
    && manifest.promotionResult === "success", "PILOT_SUCCESSFUL_TRIAL_MANIFEST_REQUIRED");
  for (const label of ["staff", "admin"]) {
    requireValue(manifest[label]?.siteId === PROJECT + (label === "admin" ? "-admin" : "")
      && manifest[label]?.previousVersion === report.hosting.previousVersions[label]
      && manifest[label]?.promotedVersion === report.hosting.previewVersions[label], "PILOT_TRIAL_VERSION_MISMATCH");
  }
  return {...structuredClone(report), readinessState: "STAGING_TRIAL", trialRecordedAt: now,
    sourceAuthenticity: "UNVERIFIED", submissionAcceptance: "UNVERIFIED",
    authenticatedStaffAcceptance: "UNVERIFIED", backupAndPreviewCleanupAuthorized: false};
}

/**
 * Only evaluates recorded authenticated observations. It does not authenticate,
 * invoke an API, send mail or write an acceptance record to a remote service.
 */
export function evaluateStaffAcceptance({report, observation, beforeSnapshot, afterSnapshot,
  now = new Date().toISOString()}) {
  validatePilotReport(report, {now});
  const checkpoint = timestamp(report.readinessState === "STAGING_TRIAL" ? report.trialRecordedAt : report.checkedAt);
  keys(observation, ["sourceSha", "pilotId", "accountDigest", "evidenceDigest", "target", "capturedAt", "observationRunId",
    "versions", "authenticated", "staffRole", "adminAuthenticated", "claimsUnchanged",
    "functionResults", "readScopeDigest", "writes", "mailAttemptsConsumed",
    "mailRecipientDigest", "mail", "submissionInvoked", "storageInvoked", "scopeViolations"]);
  evidenceReference(observation.evidenceDigest);
  requireValue(typeof observation.observationRunId === "string" && RUN.test(observation.observationRunId)
    && timestamp(now) >= timestamp(observation.capturedAt)
    && timestamp(now) - timestamp(observation.capturedAt) <= 10 * 60 * 1000
    && timestamp(observation.capturedAt) >= checkpoint, "PILOT_ACCEPTANCE_STALE");
  recheckPilotDeployment({before: beforeSnapshot, after: afterSnapshot, sourceSha: report.sourceSha,
    currentRunId: observation.observationRunId, now});
  requireValue(pilotEvidenceDigest(afterSnapshot.functions) === report.deploymentSnapshotDigest
    && timestamp(beforeSnapshot.observation.capturedAt) >= checkpoint
    && timestamp(beforeSnapshot.observation.capturedAt) <= timestamp(observation.capturedAt)
    && timestamp(afterSnapshot.observation.capturedAt) >= timestamp(observation.capturedAt),
  "PILOT_ACCEPTANCE_DEPLOYMENT_MISMATCH");
  requireValue(observation.sourceSha === report.sourceSha && observation.pilotId === report.pilotId
    && observation.accountDigest === report.accountDigest
    && observation.mailRecipientDigest === report.mailRecipientDigest, "PILOT_ACCEPTANCE_BINDING_REJECTED");
  requireValue(observation.target === (report.readinessState === "STAGING_TRIAL" ? "staging" : "preview")
    && pilotEvidenceDigest(observation.versions) === pilotEvidenceDigest(report.hosting.previewVersions),
  "PILOT_ACCEPTANCE_HOSTING_MISMATCH");
  requireValue(observation.authenticated === true && observation.staffRole === "staff"
    && observation.adminAuthenticated === false && observation.claimsUnchanged === true,
  "PILOT_AUTHENTICATED_STAFF_OBSERVATION_REQUIRED");
  const requiredCalls = PILOT_FUNCTIONS.filter(f => !["loginGateway", "requestStaffLoginLink"].includes(f));
  keys(observation.functionResults, requiredCalls);
  requireValue(requiredCalls.every(f => observation.functionResults[f] === "OBSERVED_COMPATIBLE_RESPONSE"),
    "PILOT_API_COMPATIBILITY_OBSERVATION_REQUIRED");
  requireValue(observation.readScopeDigest === report.reviewedReadScopeDigest
    && observation.submissionInvoked === false && observation.storageInvoked === false
    && Array.isArray(observation.scopeViolations) && observation.scopeViolations.length === 0,
  "PILOT_ACCEPTANCE_SCOPE_VIOLATION");
  exactList(observation.writes, PILOT_WRITE_SCOPE, "PILOT_WRITE_SCOPE_REJECTED");
  requireValue(Number.isInteger(observation.mailAttemptsConsumed)
    && observation.mailAttemptsConsumed >= report.mailAttemptsConsumed && observation.mailAttemptsConsumed <= 1,
  "PILOT_SINGLE_RECIPIENT_MAIL_LEDGER_REQUIRED");
  const mail = observation.mail;
  keys(mail, ["completeHistory", "recipientDigest", "attempts", "evidenceDigest"]);
  evidenceReference(mail.evidenceDigest);
  requireValue(mail.completeHistory === true && mail.recipientDigest === report.mailRecipientDigest
    && Array.isArray(mail.attempts) && mail.attempts.length === observation.mailAttemptsConsumed,
  "PILOT_SINGLE_RECIPIENT_MAIL_LEDGER_REQUIRED");
  validateMailAttempts(mail.attempts);
  requireValue(report.mailAttempts.every((attempt, index) =>
    pilotEvidenceDigest(attempt) === pilotEvidenceDigest(mail.attempts[index])), "PILOT_MAIL_HISTORY_CHANGED");
  return {...structuredClone(report), readinessState: "STAFF_UI_ACCEPTED", authenticatedStaffAcceptance: "ACCEPTED",
    acceptanceObservationDigest: observation.evidenceDigest, mailAttemptsConsumed: observation.mailAttemptsConsumed,
    mailAttempts: structuredClone(mail.attempts),
    sourceAuthenticity: "UNVERIFIED", submissionAcceptance: "UNVERIFIED",
    // Cleanup is a separate, reviewed lifecycle operation; this validator never performs it.
    backupAndPreviewCleanupAuthorized: false};
}

function runtimeContext() {
  requireProtectedContext();
  validateHostingOperation({operation: process.env.LKC_OPERATION, eventName: process.env.GITHUB_EVENT_NAME,
    confirmation: process.env.LKC_CONFIRMATION, projectId: process.env.LKC_PROJECT_ID, region: process.env.LKC_REGION,
    sourceRef: process.env.GITHUB_REF_NAME, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT)});
  const policy = validateEvidencePolicy({policy: process.env.LKC_EVIDENCE_POLICY, operation: process.env.LKC_OPERATION,
    eventName: process.env.GITHUB_EVENT_NAME, metadataOnly: process.env.LKC_METADATA_ONLY === "true",
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT)});
  requireValue(policy === POLICY && process.env.LKC_METADATA_ONLY === "false"
    && process.env.LKC_PROJECT_ID === PROJECT && process.env.LKC_REGION === REGION
    && SHA.test(process.env.LKC_SOURCE_SHA ?? "") && RUN.test(process.env.GITHUB_RUN_ID ?? ""),
  "PILOT_RUNTIME_CONTEXT_REJECTED");
  const root = process.env.RUNNER_TEMP ?? "", evidenceDir = process.env.LKC_EVIDENCE_DIR ?? "";
  requireValue(path.isAbsolute(root) && path.resolve(evidenceDir) === path.resolve(root, "hosting-promote-evidence"),
    "PILOT_EVIDENCE_DIRECTORY_REJECTED");
  return {sourceSha: process.env.LKC_SOURCE_SHA, operation: process.env.LKC_OPERATION,
    currentRunId: process.env.GITHUB_RUN_ID, root, evidenceDir};
}
function parseRecord(text) {
  requireValue(typeof text === "string" && Buffer.byteLength(text) > 0 && Buffer.byteLength(text) <= MAX_BYTES,
    "PILOT_RECORD_SIZE_REJECTED");
  try {return JSON.parse(text);} catch {throw new PilotEvidenceError("PILOT_RECORD_JSON_REJECTED");}
}
async function saveJson(file, value) {await writeFile(file, JSON.stringify(value, null, 2) + "\n", {mode: 0o600, flag: "wx"});}
async function loadJson(file) {return parseRecord(await readFile(file, "utf8"));}

export async function pilotMain({argv = process.argv.slice(2), emit = value => console.log(value)} = {}) {
  requireValue(argv.length === 1 && ["--guard-only", "--preflight-only", "--validate-review",
    "--validate", "--recheck", "--recheck-before-write", "--finalize"].includes(argv[0]), "PILOT_ARGUMENTS_REJECTED");
  if (argv[0] === "--guard-only") {
    const policy = validateEvidencePolicy({policy: process.env.LKC_EVIDENCE_POLICY,
      operation: process.env.LKC_OPERATION, eventName: process.env.GITHUB_EVENT_NAME,
      metadataOnly: process.env.LKC_METADATA_ONLY === "true", runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT)});
    if (policy === "source-provenance") requireValue(!process.env.LKC_LIMITED_EVIDENCE,
      "PILOT_EVIDENCE_WITH_STRICT_POLICY_REJECTED");
    else parseRecord(process.env.LKC_LIMITED_EVIDENCE);
    emit("HOSTING_EVIDENCE_POLICY=VALIDATED"); return 0;
  }
  const context = runtimeContext(), {root, evidenceDir} = context;
  const inputPath = path.join(root, "lkc-limited-pilot-review.json");
  if (["--preflight-only", "--validate-review"].includes(argv[0])) {
    const evidence = parseRecord(process.env.LKC_LIMITED_EVIDENCE);
    delete process.env.LKC_LIMITED_EVIDENCE;
    validateLimitedPilotPreflight(evidence, context);
    // The reviewed input is kept outside uploaded evidence; artifacts contain its
    // digest and a sanitized result. No source records or personal fields enter it.
    await saveJson(inputPath, evidence);
    emit("HOSTING_LIMITED_REVIEW=VALID"); return 0;
  }
  const before = await loadJson(path.join(evidenceDir, "pilot-metadata.json"));
  if (["--recheck", "--recheck-before-write"].includes(argv[0])) {
    const beforeWrite = argv[0] === "--recheck-before-write";
    const after = await loadJson(path.join(evidenceDir, beforeWrite ? "pilot-metadata-before-write.json" : "pilot-metadata-after.json"));
    const result = recheckPilotDeployment({...context, before, after});
    await saveJson(path.join(evidenceDir, beforeWrite ? "limited-pilot-before-write-recheck.json" : "limited-pilot-deployment-recheck.json"), result);
    emit("HOSTING_LIMITED_DEPLOYMENT=UNCHANGED"); return 0;
  }
  if (argv[0] === "--finalize") {
    const report = await loadJson(path.join(evidenceDir, "limited-pilot-evidence.json"));
    const manifest = await loadJson(path.join(evidenceDir, "restore-manifest.json"));
    const recheck = await loadJson(path.join(evidenceDir, "limited-pilot-deployment-recheck.json"));
    const after = await loadJson(path.join(evidenceDir, "pilot-metadata-after.json"));
    const checked = recheckPilotDeployment({...context, before, after});
    requireValue(recheck.deploymentUnchanged === true && recheck.sourceSha === checked.sourceSha
      && recheck.observationRunId === checked.observationRunId
      && recheck.beforeSnapshotDigest === checked.beforeSnapshotDigest
      && recheck.afterSnapshotDigest === checked.afterSnapshotDigest
      && checked.deploymentSnapshotDigest === report.deploymentSnapshotDigest,
    "PILOT_DEPLOYMENT_RECHECK_REQUIRED");
    await saveJson(path.join(evidenceDir, "limited-pilot-trial.json"), recordStagingTrial({...context, report, manifest}));
    emit("HOSTING_LIMITED_STATE=STAGING_TRIAL");
    emit("HOSTING_STAFF_UI_ACCEPTED=false"); return 0;
  }
  const evidence = await loadJson(inputPath);
  const result = validateLimitedPilotEvidence({...context, evidence, snapshot: before,
    previewRunId: process.env.LKC_PREVIEW_RUN_ID,
    previewVersions: {staff: process.env.LKC_STAFF_VERSION, admin: process.env.LKC_ADMIN_VERSION},
    previousVersions: {staff: process.env.LKC_PREVIOUS_STAFF_VERSION, admin: process.env.LKC_PREVIOUS_ADMIN_VERSION}});
  await mkdir(evidenceDir, {recursive: true});
  await saveJson(path.join(evidenceDir, "limited-pilot-evidence.json"), result);
  emit("HOSTING_LIMITED_STATE=PREAUTH_READY");
  emit("HOSTING_STAFF_UI_ACCEPTED=false");
  emit("HOSTING_SOURCE_AUTHENTICITY=UNVERIFIED");
  emit("HOSTING_SUBMISSION_ACCEPTANCE=UNVERIFIED");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  pilotMain().then(code => {process.exitCode = code;}).catch(error => {
    const guardCodes = ["PROTECTED_WORKFLOW_CONTEXT_REQUIRED"];
    const code = error instanceof PilotEvidenceError || guardCodes.includes(error?.message)
      ? error.message : "PILOT_INPUT_OR_METADATA_INVALID";
    console.error("HOSTING_LIMITED_RESULT=STOPPED");
    console.error("HOSTING_LIMITED_ERROR=" + code);
    process.exitCode = 1;
  });
}
