import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import {mkdtemp, readFile, rm, writeFile, mkdir, stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {PILOT_FUNCTIONS, normalizePilotFunction} from "./collect-hosting-pilot-metadata.mjs";
import {PILOT_READ_SCOPE, PILOT_WRITE_SCOPE, evaluateStaffAcceptance, evaluateOwnerManualObservation, pilotEvidenceDigest,
  recordStagingTrial, recheckPilotDeployment, validateEvidencePolicy,
  validateLimitedPilotEvidence, validateLimitedPilotPreflight, validatePilotReport} from "./hosting-limited-pilot.mjs";
import {requireCurrentPilotMutationReview} from "./restore-staging-hosting.mjs";

const PROJECT = "lip-knots-crew-staging", REGION = "asia-northeast1";
const PREFIX = `projects/${PROJECT}/locations/${REGION}`, SHA = "a".repeat(40), RUN = "39367729999";
const NOW = "2026-10-20T12:00:00.000Z", DIGEST = "sha256:" + "b".repeat(64);
let savedFetch;
before(() => {savedFetch = globalThis.fetch; globalThis.fetch = () => assert.fail("Offline tests must never access a live endpoint");});
after(() => {globalThis.fetch = savedFetch;});

/** Synthetic declarations for offline tests. These are not operational evidence. */
export function pilotFixture() {
  return {schemaVersion: 1, policy: "limited-staff-pilot", projectId: PROJECT, region: REGION,
    sourceSha: SHA, pilotId: "1".repeat(32), createdAt: "2026-10-20T11:00:00.000Z",
    expiresAt: "2026-10-20T15:00:00.000Z", sourceAuthenticity: "UNVERIFIED", submissionAcceptance: "UNVERIFIED",
    review: {recordDigest: DIGEST,
      cost: {actions: "NO_ADDITIONAL_COST", hosting: "NO_ADDITIONAL_COST", apiAndFirestore: "NO_ADDITIONAL_COST", evidenceDigest: DIGEST},
      account: {identityDigest: DIGEST, existingDedicatedStaff: true, emailVerified: true,
        activeProfileAndEmailIndex: true, exactExistingStaffClaims: true, excludedFromAdminEmails: true,
        gatewayNonproduction: true, evidenceDigest: DIGEST},
      scope: {functions: [...PILOT_FUNCTIONS], firestoreReads: [...PILOT_READ_SCOPE], allowedWrites: [...PILOT_WRITE_SCOPE],
        requestBoundaryEnforced: true, admin: "SIGNED_OUT_INITIAL_SCREEN_ONLY", authClaimsWrites: "FORBIDDEN",
        businessMutations: "FORBIDDEN", uploadAndStorage: "FORBIDDEN", transferPause: "UNOBSERVED_UNCHANGED",
        pushRegistration: "FORBIDDEN", evidenceDigest: DIGEST},
      mail: {pilotId: "1".repeat(32), recipientDigest: DIGEST, maximumMessages: 1, attempts: [],
        completeHistory: true, irreversibleAcknowledged: true, evidenceDigest: DIGEST},
      previewAuth: {status: "UNSUPPORTED_VERIFIED", reason: "EXISTING_AUTHORIZED_DOMAINS_EXCLUDE_PREVIEW", evidenceDigest: DIGEST},
      recovery: {bothPreviousVersionsAvailable: true, restoreWorkflowVerified: true,
        retainUntil: "2026-10-21T10:00:00.000Z", cleanupBeforeAcceptance: false,
        externalWritersExcluded: true, externalWritersExcludedUntil: "2026-10-20T15:00:00.000Z",
        evidenceDigest: DIGEST},
    },
    hosting: {previewRunId: "39367728888", previewRunAttempt: 1,
      previewVersions: {staff: "1111111111111111", admin: "2222222222222222"},
      previousVersions: {staff: "3333333333333333", admin: "4444444444444444"}},
    functions: Object.fromEntries(PILOT_FUNCTIONS.map(name => [name, normalizePilotFunction({
      name: `${PREFIX}/functions/${name}`, environment: "GEN_2", state: "ACTIVE",
      updateTime: "2026-10-19T01:00:00.123456Z",
      buildConfig: {build: `${PREFIX}/builds/90834a05-b919-42a1-b963-bd8e07d13213`, runtime: "nodejs22", entryPoint: name},
      serviceConfig: {service: `${PREFIX}/services/${name.toLowerCase()}`,
        revision: `${name.toLowerCase()}-00001-abc`, allTrafficOnLatestRevision: true},
    }, name)])),
  };
}
function snapshot(evidence = pilotFixture()) {
  return {schemaVersion: 1, status: "METADATA_COLLECTED", policy: "limited-staff-pilot", projectId: PROJECT,
    region: REGION, sourceSha: SHA, sourceAuthenticity: "UNVERIFIED", submissionAcceptance: "UNVERIFIED",
    hostingPromotionAuthorized: false, apiCompatibilityVerified: false,
    observation: {runId: RUN, runAttempt: 1, capturedAt: "2026-10-20T11:59:00.000Z"},
    functions: structuredClone(evidence.functions),
    requests: PILOT_FUNCTIONS.map(name => ({method: "GET", function: name, status: 200}))};
}
function context(evidence = pilotFixture(), operation = "promote") {
  return {evidence, sourceSha: SHA, currentRunId: RUN, operation, now: NOW,
    previewRunId: evidence.hosting.previewRunId, previewVersions: evidence.hosting.previewVersions,
    previousVersions: evidence.hosting.previousVersions,
    ...(evidence.acceptanceMethod === "OWNER_MANUAL_UI" ? {} : {snapshot: snapshot(evidence)})};
}
function manifest(report) {
  return {schemaVersion: 1, operation: "promote", projectId: PROJECT, region: REGION, sourceSha: SHA,
    promotionRunId: RUN, runAttempt: 1, promotionResult: "success",
    ...Object.fromEntries(["staff", "admin"].map(label => [label, {
      siteId: PROJECT + (label === "admin" ? "-admin" : ""),
      previousVersion: report.hosting.previousVersions[label], promotedVersion: report.hosting.previewVersions[label],
    }]))};
}
function acceptance(report) {
  return {sourceSha: SHA, pilotId: report.pilotId, accountDigest: report.accountDigest, evidenceDigest: DIGEST,
    capturedAt: NOW, observationRunId: RUN,
    target: report.readinessState === "STAGING_TRIAL" ? "staging" : "preview",
    versions: structuredClone(report.hosting.previewVersions), authenticated: true, staffRole: "staff",
    adminAuthenticated: false, claimsUnchanged: true,
    functionResults: Object.fromEntries(PILOT_FUNCTIONS.filter(f => !["loginGateway", "requestStaffLoginLink"].includes(f))
      .map(f => [f, "OBSERVED_COMPATIBLE_RESPONSE"])),
    readScopeDigest: report.reviewedReadScopeDigest, writes: [...PILOT_WRITE_SCOPE], mailAttemptsConsumed: 1,
    mailRecipientDigest: report.mailRecipientDigest,
    mail: {completeHistory: true, recipientDigest: report.mailRecipientDigest,
      attempts: [{outcome: "SENT", evidenceDigest: DIGEST}], evidenceDigest: DIGEST},
    submissionInvoked: false, storageInvoked: false, scopeViolations: []};
}
function evaluate(input) {
  const beforeSnapshot = snapshot(), afterSnapshot = snapshot();
  beforeSnapshot.observation.capturedAt = NOW; afterSnapshot.observation.capturedAt = NOW;
  return evaluateStaffAcceptance({beforeSnapshot, afterSnapshot, now: NOW, ...input});
}
function manualFixture() {
  const evidence = pilotFixture();
  evidence.acceptanceMethod = "OWNER_MANUAL_UI";
  delete evidence.functions;
  evidence.review.scope.requestBoundaryEnforced = false;
  evidence.review.manualObservationPlan = {actor: "REVIEWED_OWNER", ownerIdentityConfirmed: true,
    maximumSessions: 1, maximumAuthenticationAttempts: 1, maximumMailAttempts: 1,
    initialScreen: "STAFF_HOME_ONLY", observationWindowSeconds: 120, windowMeaning: "HUMAN_OBSERVATION_ONLY",
    requestCountsEnforced: false, secretsRetention: "FORBIDDEN", onErrorOrUnknown: "STOP",
    sessionContext: "FRESH_DEDICATED_CONTEXT", authenticationMode: "EXISTING_STAFF_EMAIL_CODE",
    mailPolicy: "PILOT_LEDGER_SINGLE_ATTEMPT_NO_RESEND"};
  return evidence;
}
function manualInput(report = validateLimitedPilotEvidence(context(manualFixture()))) {
  const capturedAt = "2026-10-20T12:00:30.000Z";
  const observation = {sourceSha: SHA, pilotId: report.pilotId, accountDigest: report.accountDigest,
    evidenceDigest: DIGEST,
    target: report.readinessState === "STAGING_TRIAL" ? "staging" : "preview",
    versions: structuredClone(report.hosting.previewVersions), protectedReviewDigest: report.protectedReviewDigest,
    manualPlanDigest: report.manualPlanDigest, sessionStartedAt: NOW, startedAt: NOW, capturedAt, actor: "REVIEWED_OWNER",
    sessionsObserved: 1, authenticationAttempts: 1, authentication: "OWNER_CONFIRMED_COMPLETED",
    screen: "STAFF_HOME", renderMode: "LIVE_INITIAL_HOME", displayedIdentityMatched: true, targetConfirmed: true,
    errorsObserved: false, unknownStateObserved: false, adminAuthenticated: false, actions: "INITIAL_HOME_ONLY",
    homeDisplay: {todo: "CONTENT_OR_EMPTY_STATE_VISIBLE", upcomingShifts: "CONTENT_OR_EMPTY_STATE_VISIBLE"}, taskOpened: false,
    secretsStored: false, sessionContext: "FRESH_DEDICATED_CONTEXT", authenticationMode: "EXISTING_STAFF_EMAIL_CODE",
    mailAttemptsConsumed: 1, mailRecipientDigest: report.mailRecipientDigest,
    mail: {completeHistory: true, recipientDigest: report.mailRecipientDigest,
      attempts: [{outcome: "SENT", evidenceDigest: DIGEST}], evidenceDigest: DIGEST}};
  return {report, observation, now: capturedAt};
}

test("manual method is explicit, typed and never weakens the default controlled boundary", () => {
  const legacy = validateLimitedPilotEvidence(context());
  assert.equal(Object.hasOwn(legacy, "acceptanceMethod"), false);
  const explicit = pilotFixture(); explicit.acceptanceMethod = "CONTROLLED_BROWSER";
  assert.equal(validateLimitedPilotEvidence(context(explicit)).acceptanceMethod, "CONTROLLED_BROWSER");
  for (const method of ["UNKNOWN", false, null, 1, undefined]) {
    const evidence = manualFixture(); evidence.acceptanceMethod = method;
    assert.throws(() => validateLimitedPilotEvidence(context(evidence)), /PILOT_ACCEPTANCE_METHOD_REJECTED/u);
  }
  for (const evidence of [pilotFixture(), explicit]) {
    evidence.review.scope.requestBoundaryEnforced = false;
    assert.throws(() => validateLimitedPilotEvidence(context(evidence)), /SIDE_EFFECT_BOUNDARY/u);
  }
  const manual = manualFixture(); manual.review.scope.requestBoundaryEnforced = true;
  assert.throws(() => validateLimitedPilotEvidence(context(manual)), /SIDE_EFFECT_BOUNDARY/u);
});
test("manual plan is exact and bound to protected review while all existing prerequisites remain", () => {
  const evidence = manualFixture(), result = validateLimitedPilotEvidence(context(evidence));
  assert.equal(validatePilotReport(result, {now: NOW}), result);
  assert.equal(result.manualPlanDigest, pilotEvidenceDigest({protectedReviewDigest: evidence.review.recordDigest,
    manualPlan: evidence.review.manualObservationPlan}));
  for (const [field, value] of [["actor", "OPERATOR"], ["ownerIdentityConfirmed", false], ["maximumSessions", 2],
    ["maximumAuthenticationAttempts", 2], ["maximumMailAttempts", 2], ["observationWindowSeconds", 1.5],
    ["observationWindowSeconds", Number.MAX_SAFE_INTEGER + 1],
    ["observationWindowSeconds", 0], ["observationWindowSeconds", "120"], ["windowMeaning", "NETWORK_DEADLINE"],
    ["requestCountsEnforced", true], ["initialScreen", "ALL_STAFF_PAGES"], ["secretsRetention", "HAR"],
    ["onErrorOrUnknown", "RETRY"], ["sessionContext", "EXISTING_SESSION"], ["authenticationMode", "ADMIN"],
    ["mailPolicy", "RESEND_IF_NOT_SENT"]]) {
    const changed = manualFixture(); changed.review.manualObservationPlan[field] = value;
    assert.throws(() => validateLimitedPilotEvidence(context(changed)), /PILOT_MANUAL_PLAN_REJECTED/u, field);
  }
  for (const mutate of [e => {delete e.review.manualObservationPlan;}, e => {e.review.manualObservationPlan.email = "synthetic";},
    e => {e.review.cost.apiAndFirestore = "UNKNOWN";}, e => {e.review.account.exactExistingStaffClaims = false;},
    e => {e.review.scope.allowedWrites.push("business-records");}, e => {e.review.recovery.bothPreviousVersionsAvailable = false;},
    e => {e.review.previewAuth = {status: "SUPPORTED", reason: "NONE", evidenceDigest: DIGEST};}]) {
    const changed = manualFixture(); mutate(changed);
    assert.throws(() => validateLimitedPilotEvidence(context(changed)), /PILOT_/u);
  }
  for (const mutate of [r => {delete r.acceptanceMethod;}, r => {r.acceptanceMethod = "CONTROLLED_BROWSER";},
    r => {r.manualPlan.observationWindowSeconds = 60;}, r => {r.protectedReviewDigest = "sha256:" + "c".repeat(64);},
    r => {r.requestBoundaryEnforced = true;}, r => {r.requestCountsEnforced = true;},
    ...["apiCompatibility", "technicalAcceptance", "claimsUnchanged", "serverSideEffects", "backendDeploymentUnchanged"].map(field => r => {r[field] = "VERIFIED";})]) {
    const changed = structuredClone(result); mutate(changed);
    assert.throws(() => validatePilotReport(changed, {now: NOW}), /PILOT_/u);
  }
});
test("owner observation reaches only its own terminal state for preview or a proven staging trial", () => {
  for (const target of ["preview", "staging"]) {
    const evidence = manualFixture();
    if (target === "preview") evidence.review.previewAuth = {status: "SUPPORTED", reason: "NONE", evidenceDigest: DIGEST};
    let report = validateLimitedPilotEvidence(context(evidence, target === "preview" ? "readiness" : "promote"));
    if (target === "staging") report = recordStagingTrial({report, manifest: manifest(report), currentRunId: RUN, now: NOW});
    const input = manualInput(report), original = JSON.stringify(input), result = evaluateOwnerManualObservation(input);
    assert.equal(result.readinessState, "STAFF_MANUAL_UI_OBSERVED");
    assert.equal(result.manualUiObservation, "OWNER_REPORTED_UI_ONLY");
    for (const field of ["authenticatedStaffAcceptance", "apiCompatibility", "technicalAcceptance", "claimsUnchanged",
      "serverSideEffects", "backendDeploymentUnchanged", "sourceAuthenticity", "submissionAcceptance"]) assert.equal(result[field], "UNVERIFIED", field);
    assert.equal(result.requestBoundaryEnforced, false); assert.equal(result.requestCountsEnforced, false);
    assert.equal(result.backupAndPreviewCleanupAuthorized, false);
    for (const field of ["deploymentSnapshotDigest", "beforeSnapshotDigest", "afterSnapshotDigest", "beforeMetadataRunId", "afterMetadataRunId"])
      assert.equal(Object.hasOwn(result, field), false, field);
    assert.deepEqual(result.homeDisplay, input.observation.homeDisplay); assert.equal(result.taskOpened, false);
    assert.equal(JSON.stringify(input), original);
    assert.throws(() => evaluate({report, observation: acceptance(report)}), /CONTROLLED_BROWSER_REPORT_REQUIRED/u);
    assert.throws(() => evaluateOwnerManualObservation({...input, report: result}), /PREAUTH_REPORT_REQUIRED/u);
    assert.throws(() => recordStagingTrial({report: result, manifest: manifest(result), currentRunId: RUN, now: NOW}), /PREAUTH_REPORT_REQUIRED/u);
    input.observation.mail.attempts[0].evidenceDigest = "sha256:" + "c".repeat(64);
    result.manualPlan.observationWindowSeconds = 1;
    assert.equal(result.mailAttempts[0].evidenceDigest, DIGEST); assert.equal(report.manualPlan.observationWindowSeconds, 120);
  }
  assert.throws(() => evaluateOwnerManualObservation(manualInput(validateLimitedPilotEvidence(context()))), /OWNER_MANUAL_REPORT_REQUIRED/u);
});
test("manual screen errors, cache, demo, mismatches, unfinished auth and extra raw records cannot pass", () => {
  const mutations = [
    o => {o.renderMode = "CACHED";}, o => {o.renderMode = "DEMO";}, o => {o.errorsObserved = true;},
    o => {o.unknownStateObserved = true;}, o => {o.authentication = "INCOMPLETE";}, o => {o.authenticationAttempts = 2;},
    o => {o.sessionsObserved = 2;}, o => {o.actor = "AGENT";}, o => {o.targetConfirmed = false;},
    o => {o.displayedIdentityMatched = false;}, o => {o.adminAuthenticated = true;}, o => {o.screen = "ADMIN_HOME";},
    o => {o.actions = "SUBMISSION";}, o => {o.secretsStored = true;}, o => {o.sessionContext = "CACHED_SESSION";},
    o => {o.taskOpened = true;}, o => {o.homeDisplay.todo = "LOADING";}, o => {o.homeDisplay.upcomingShifts = "ERROR";},
    o => {delete o.homeDisplay.todo;}, o => {o.homeDisplay.allBusinessRecords = "VISIBLE";},
    ...["email", "url", "code", "HAR", "claimsUnchanged", "functionResults", "beforeMetadataRunId", "afterMetadataRunId"].map(field => o => {o[field] = "synthetic";}),
  ];
  for (const mutate of mutations) {
    const input = manualInput(); mutate(input.observation);
    assert.throws(() => evaluateOwnerManualObservation(input), /PILOT_/u);
  }
  const complete = manualInput();
  for (const field of Object.keys(complete.observation)) {
    const input = manualInput(); delete input.observation[field];
    assert.throws(() => evaluateOwnerManualObservation(input), /PILOT_/u, field);
  }
});
test("manual preflight needs Hosting pins but rejects mixed backend evidence; controlled still requires every Function", () => {
  const evidence = manualFixture(), input = context(evidence);
  assert.equal(Object.hasOwn(evidence, "functions"), false); assert.equal(Object.hasOwn(input, "snapshot"), false);
  const report = validateLimitedPilotEvidence(input);
  assert.equal(report.backendDeploymentUnchanged, "UNVERIFIED");
  assert.equal(Object.hasOwn(report, "deploymentSnapshotDigest"), false);
  for (const functions of [{}, pilotFixture().functions]) {
    assert.throws(() => validateLimitedPilotEvidence(context({...evidence, functions})), /PILOT_FIELDS_REJECTED/u);
  }
  for (const backend of [null, {}, snapshot()]) {
    assert.throws(() => validateLimitedPilotEvidence({...input, snapshot: backend}), /PILOT_MANUAL_METADATA_REJECTED/u);
    assert.throws(() => evaluateOwnerManualObservation({...manualInput(report), beforeSnapshot: backend}), /PILOT_FIELDS_REJECTED/u);
    assert.throws(() => evaluateOwnerManualObservation({...manualInput(report), afterSnapshot: backend}), /PILOT_FIELDS_REJECTED/u);
  }
  assert.throws(() => validatePilotReport({...report, deploymentSnapshotDigest: DIGEST}, {now: NOW}), /PILOT_FIELDS_REJECTED/u);
  for (const currentRunId of [undefined, "", "unknown", 123])
    assert.throws(() => validateLimitedPilotEvidence({...input, currentRunId}), /PILOT_REPORT_IDENTITY_REJECTED/u);
  const controlled = pilotFixture(); delete controlled.functions;
  assert.throws(() => validateLimitedPilotPreflight(controlled, {sourceSha: SHA, now: NOW}), /PILOT_FIELDS_REJECTED/u);
  const controlledInput = context(); delete controlledInput.snapshot;
  assert.throws(() => validateLimitedPilotEvidence(controlledInput), /PILOT_FIELDS_REJECTED/u);
});
test("manual observation binds protected Hosting identity, checkpoints and its agreed human window", () => {
  assert.equal(evaluateOwnerManualObservation(manualInput()).observationRunId, RUN,
    "Original readiness/promotion run remains pinned without a fabricated authentication run");
  for (const mutate of [
    i => {i.observation.sourceSha = "c".repeat(40);}, i => {i.observation.pilotId = "2".repeat(32);},
    i => {i.observation.accountDigest = "sha256:" + "c".repeat(64);},
    i => {i.observation.protectedReviewDigest = "sha256:" + "c".repeat(64);},
    i => {i.observation.manualPlanDigest = "sha256:" + "c".repeat(64);}, i => {i.observation.target = "staging";},
    i => {i.observation.versions.staff = "c".repeat(16);}, i => {i.observation.startedAt = "2026-10-20T11:59:59.000Z";},
    i => {i.observation.capturedAt = "2026-10-20T12:02:01.000Z"; i.now = i.observation.capturedAt;},
    i => {i.observation.startedAt = i.observation.capturedAt;}, i => {i.now = "2026-10-20T15:00:00.000Z";},
  ]) {
    const input = manualInput(); mutate(input);
    assert.throws(() => evaluateOwnerManualObservation(input), /PILOT_/u);
  }
});
test("manual session must follow the trial; agreed windows have no arbitrary 300-second or ten-minute evaluation cap", () => {
  const report = validateLimitedPilotEvidence(context(manualFixture()));
  const trial = recordStagingTrial({report, manifest: manifest(report), currentRunId: RUN,
    now: "2026-10-20T12:00:05.000Z"});
  const beforeTrialSession = manualInput(trial);
  beforeTrialSession.observation.startedAt = "2026-10-20T12:00:10.000Z";
  assert.throws(() => evaluateOwnerManualObservation(beforeTrialSession), /PILOT_MANUAL_OBSERVATION_WINDOW_REJECTED/u);
  const reversedSession = manualInput(); reversedSession.observation.sessionStartedAt = "2026-10-20T12:00:10.000Z";
  assert.throws(() => evaluateOwnerManualObservation(reversedSession), /PILOT_MANUAL_OBSERVATION_WINDOW_REJECTED/u);
  const evidence = manualFixture(); evidence.review.manualObservationPlan.observationWindowSeconds = 900;
  const longer = manualInput(validateLimitedPilotEvidence(context(evidence)));
  longer.observation.capturedAt = "2026-10-20T12:08:00.000Z";
  longer.now = "2026-10-20T13:00:00.000Z";
  assert.equal(evaluateOwnerManualObservation(longer).readinessState, "STAFF_MANUAL_UI_OBSERVED");
  assert.throws(() => evaluateOwnerManualObservation({...longer, now: "2026-10-20T15:00:00.000Z"}), /EXPIRED/u);
});
test("manual email-code observation requires exactly one SENT attempt and cannot reset or replace the ledger", () => {
  for (const prior of [[], [{outcome: "SENT", evidenceDigest: DIGEST}], [{outcome: "CONFIRMED_NOT_SENT", evidenceDigest: DIGEST}]]) {
    const evidence = manualFixture(); evidence.review.mail.attempts = structuredClone(prior);
    const report = validateLimitedPilotEvidence(context(evidence)), input = manualInput(report);
    if (prior[0]?.outcome === "CONFIRMED_NOT_SENT") {
      assert.throws(() => evaluateOwnerManualObservation(input), /MAIL_HISTORY_CHANGED/u);
      input.observation.mail.attempts = structuredClone(prior);
      assert.throws(() => evaluateOwnerManualObservation(input), /EMAIL_CODE_DELIVERY_REQUIRED/u);
      continue;
    }
    assert.equal(evaluateOwnerManualObservation(input).mailAttemptsConsumed, 1);
    for (const mutate of [o => {o.mailAttemptsConsumed = 0; o.mail.attempts = [];},
      o => {o.mailAttemptsConsumed = 2; o.mail.attempts.push({outcome: "SENT", evidenceDigest: DIGEST});},
      o => {o.mail.recipientDigest = "sha256:" + "c".repeat(64);}, o => {o.mail.completeHistory = false;},
      o => {o.mail.attempts[0].outcome = "UNKNOWN";}, o => {o.pilotId = "2".repeat(32);},
      ...(prior.length ? [o => {o.mail.attempts[0].evidenceDigest = "sha256:" + "c".repeat(64);}] : [])]) {
      const changed = manualInput(report); mutate(changed.observation);
      assert.throws(() => evaluateOwnerManualObservation(changed), /PILOT_/u);
    }
  }
});
test("manual preauth report remains compatible with protected writer recheck without widening promotion", async () => {
  const report = validateLimitedPilotEvidence(context(manualFixture()));
  const capture = {...manifest(report), promotionResult: "prepared"};
  const options = {evidencePolicy: "limited-staff-pilot", projectId: PROJECT, region: REGION,
    staffSite: PROJECT, adminSite: PROJECT + "-admin", evidenceDir: "/synthetic-evidence", sourceSha: SHA,
    promotionRunId: RUN, runAttempt: 1, capture,
    mutation: {kind: "promote", siteId: PROJECT, previousVersion: report.hosting.previousVersions.staff,
      promotedVersion: report.hosting.previewVersions.staff}};
  const io = {read: async () => JSON.stringify(report), now: () => NOW};
  await requireCurrentPilotMutationReview(options, io);
  for (const mutate of [r => {r.stagingTrialAuthorized = false;}, r => {r.expiresAt = NOW;},
    r => {r.hosting.previewVersions.staff = "c".repeat(16);}, r => {r.observationRunId = "123";}]) {
    const changed = structuredClone(report); mutate(changed);
    await assert.rejects(() => requireCurrentPilotMutationReview(options, {...io, read: async () => JSON.stringify(changed)}));
  }
});

test("strict policy remains default; limited policy is manual, explicit and never restore/metadata-only/rerun", () => {
  assert.equal(validateEvidencePolicy({eventName: "workflow_run", operation: "promote"}), "source-provenance");
  assert.equal(validateEvidencePolicy({policy: "limited-staff-pilot", eventName: "workflow_dispatch", operation: "promote"}),
    "limited-staff-pilot");
  for (const change of [{policy: ""}, {policy: "skip"}, {eventName: "workflow_run"}, {operation: "restore"},
    {operation: "deploy"}, {metadataOnly: true}, {runAttempt: 2}, {runAttempt: "1"}]) {
    assert.throws(() => validateEvidencePolicy({policy: "limited-staff-pilot", eventName: "workflow_dispatch",
      operation: "promote", ...change}), /REJECTED|MANUAL_ONLY/u);
  }
});
test("pure preflight validates declarations without calling HTTP or proving source, submission or actual authentication", () => {
  const evidence = pilotFixture(), original = JSON.stringify(evidence);
  const result = validateLimitedPilotPreflight(evidence, {sourceSha: SHA, operation: "promote", now: NOW});
  assert.equal(result.evidenceValidation, "VALID");
  assert.equal(result.declarationsRequireProtectedReview, true);
  assert.equal(result.sourceAuthenticity, "UNVERIFIED"); assert.equal(result.submissionAcceptance, "UNVERIFIED");
  assert.equal(result.readinessState, undefined);
  assert.equal(JSON.stringify(evidence), original);
});
test("metadata and Hosting pins yield PREAUTH_READY only, never source/API/auth acceptance", () => {
  const input = context(), original = JSON.stringify(input), result = validateLimitedPilotEvidence(input);
  assert.equal(result.readinessState, "PREAUTH_READY"); assert.equal(result.stagingTrialAuthorized, true);
  assert.equal(result.authenticatedStaffAcceptance, "UNVERIFIED");
  assert.equal(result.sourceAuthenticity, "UNVERIFIED"); assert.equal(result.submissionAcceptance, "UNVERIFIED");
  assert.equal(result.backupAndPreviewCleanupAuthorized, false); assert.equal(result.adminAuthenticated, false);
  assert.equal(JSON.stringify(input), original);
});
test("supported or unknown Preview auth permits read-only preauth but cannot authorize staging fallback", () => {
  for (const status of ["SUPPORTED", "UNKNOWN"]) {
    const evidence = pilotFixture(); evidence.review.previewAuth = {status, reason: "NONE", evidenceDigest: DIGEST};
    const result = validateLimitedPilotEvidence(context(evidence, "readiness"));
    assert.equal(result.stagingTrialAuthorized, false); assert.equal(result.readinessState, "PREAUTH_READY");
    assert.throws(() => validateLimitedPilotEvidence(context(evidence)), /STAGING_FALLBACK_NOT_PROVEN/u);
  }
});
test("all safety prerequisites are fail-closed, including exact claims and unknown API/read costs", () => {
  const mutations = [
    ["schemaVersion", 2], ["policy", "source-provenance"], ["projectId", "prod"], ["region", "us-central1"],
    ["sourceSha", "c".repeat(40)], ["pilotId", ""], ["sourceAuthenticity", "PASS"], ["submissionAcceptance", "PASS"],
    ["review.recordDigest", "unknown"], ["review.cost.actions", "UNKNOWN"], ["review.cost.hosting", "UNKNOWN"],
    ["review.cost.apiAndFirestore", "ASSUMED_FREE"], ["review.account.existingDedicatedStaff", false],
    ["review.account.emailVerified", false], ["review.account.activeProfileAndEmailIndex", false],
    ["review.account.exactExistingStaffClaims", false], ["review.account.excludedFromAdminEmails", false],
    ["review.account.gatewayNonproduction", false], ["review.scope.requestBoundaryEnforced", false],
    ["review.scope.admin", "EXISTING_SESSION"], ["review.scope.authClaimsWrites", "ALLOWED"],
    ["review.scope.businessMutations", "READ_WRITE"], ["review.scope.uploadAndStorage", "PAUSE_PROBE"],
    ["review.scope.transferPause", "PAUSED"], ["review.scope.pushRegistration", "ALLOWED"],
    ["review.mail.maximumMessages", 2], ["review.mail.completeHistory", false],
    ["review.mail.irreversibleAcknowledged", false], ["review.mail.pilotId", "2".repeat(32)],
    ["review.mail.recipientDigest", "sha256:" + "c".repeat(64)],
    ["review.previewAuth.reason", "NOT_YET_TESTED"], ["review.recovery.bothPreviousVersionsAvailable", false],
    ["review.recovery.restoreWorkflowVerified", false], ["review.recovery.cleanupBeforeAcceptance", true],
    ["review.recovery.retainUntil", "2026-10-20T12:00:00.000Z"], ["hosting.previewRunAttempt", 2],
    ["review.recovery.retainUntil", "2026-10-21T12:00:00.000Z"],
    ["review.recovery.externalWritersExcluded", false],
    ["review.recovery.externalWritersExcludedUntil", "2026-10-20T12:00:00.000Z"],
  ];
  for (const [field, value] of mutations) {
    const evidence = pilotFixture(), parts = field.split("."), last = parts.pop();
    let target = evidence; for (const part of parts) target = target[part];
    target[last] = value;
    assert.throws(() => validateLimitedPilotPreflight(evidence, {sourceSha: SHA, operation: "promote", now: NOW}),
      /PILOT_/u, field);
  }
});
test("unknown fields, missing records, unsupported read families and upload APIs reject", () => {
  for (const mutate of [
    e => {e.email = "synthetic-personal-value";}, e => {delete e.review.account;},
    e => {e.review.account.fullName = "synthetic";}, e => {e.review.scope.functions.push("createUploadSession");},
    e => {e.review.scope.firestoreReads.pop();}, e => {e.review.scope.firestoreReads.push("all-jobs");},
    e => {e.review.scope.allowedWrites.push("business-records");},
    e => {e.functions.createUploadSession = e.functions.getMyTasks;},
    e => {delete e.functions.getPushStatus;}, e => {e.functions.getPushStatus.environmentVariables = {};},
  ]) {
    const evidence = pilotFixture(); mutate(evidence);
    assert.throws(() => validateLimitedPilotPreflight(evidence, {sourceSha: SHA, now: NOW}), /PILOT_/u);
  }
});
test("source/revision/build/runtime/traffic pin mutations cannot borrow old two-Function metadata", () => {
  for (const change of [
    c => {c.snapshot.functions = {createUploadSession: {}, finalizeStagedUpload: {}};},
    c => {c.snapshot.sourceSha = "b".repeat(40);}, c => {c.snapshot.policy = "source-provenance";},
    c => {c.snapshot.functions.getMyTasks.revision = "getmytasks-00002-def";},
    c => {c.snapshot.functions.bootstrapSession.runtime = "nodejs20";},
    c => {c.snapshot.functions.loginGateway.state = "DEPLOYING";},
    c => {c.snapshot.functions.getPushStatus.allTrafficOnLatestRevision = false;},
    c => {c.snapshot.functions.registerDeviceSession.build = c.snapshot.functions.registerDeviceSession.build.replace("asia-northeast1", "us-central1");},
    c => {c.snapshot.observation.runId = "123";}, c => {c.snapshot.observation.runAttempt = 2;},
    c => {c.snapshot.hostingPromotionAuthorized = true;},
  ]) {
    const input = context(); change(input);
    assert.throws(() => validateLimitedPilotEvidence(input), /PILOT_/u);
  }
});
test("stale, future, malformed and overly long reviewed intervals fail", () => {
  for (const [field, value] of [["expiresAt", NOW], ["createdAt", "2026-10-20T13:00:00.000Z"],
    ["expiresAt", "2026-10-22T12:00:00.000Z"], ["createdAt", "2026-02-30T12:00:00.000Z"],
    ["expiresAt", "never"]]) {
    const evidence = pilotFixture(); evidence[field] = value;
    assert.throws(() => validateLimitedPilotPreflight(evidence, {sourceSha: SHA, now: NOW}), /PILOT_/u);
  }
  for (const capturedAt of ["2026-10-20T11:49:59.000Z", "2026-10-20T12:00:01.000Z"]) {
    const input = context(); input.snapshot.observation.capturedAt = capturedAt;
    assert.throws(() => validateLimitedPilotEvidence(input), /METADATA_STALE/u);
  }
});
test("changed or mismatched preview/rollback pair is rejected", () => {
  for (const mutate of [
    c => {c.previewRunId = "123";}, c => {c.previewVersions = {staff: "c".repeat(16), admin: "d".repeat(16)};},
    c => {c.previousVersions = {staff: "c".repeat(16), admin: "d".repeat(16)};},
    c => {c.evidence.hosting.previousVersions.staff = c.evidence.hosting.previewVersions.staff;},
    c => {c.evidence.hosting.previewVersions.staff = "../live";},
  ]) {
    const input = context(); mutate(input);
    assert.throws(() => validateLimitedPilotEvidence(input), /PILOT_/u);
  }
});
test("single mail ledger is across the pilot, no resend on unknown or confirmed-not-sent attempt", () => {
  const evidence = pilotFixture();
  for (const outcome of ["SENT", "CONFIRMED_NOT_SENT"]) {
    evidence.review.mail.attempts = [{outcome, evidenceDigest: DIGEST}];
    assert.equal(validateLimitedPilotEvidence(context(evidence)).mailAttemptsConsumed, 1);
  }
  evidence.review.mail.attempts = [{outcome: "UNKNOWN", evidenceDigest: DIGEST}];
  assert.throws(() => validateLimitedPilotEvidence(context(evidence)), /MAIL_OUTCOME_UNRESOLVED/u);
  evidence.review.mail.attempts = Array.from({length: 2}, () => ({outcome: "SENT", evidenceDigest: DIGEST}));
  assert.throws(() => validateLimitedPilotEvidence(context(evidence)), /MAIL_LEDGER_REQUIRED/u);
});
test("posttrial deployment drift and backwards observation time fail", () => {
  const before = snapshot(), after = snapshot(); after.observation.capturedAt = NOW;
  assert.equal(recheckPilotDeployment({before, after, sourceSha: SHA, currentRunId: RUN, now: NOW}).deploymentUnchanged, true);
  after.functions.getPushStatus.revision = "getpushstatus-00002-def";
  assert.throws(() => recheckPilotDeployment({before, after, sourceSha: SHA, currentRunId: RUN, now: NOW}), /DEPLOYMENT_CHANGED/u);
  after.functions = structuredClone(before.functions); after.observation.capturedAt = "2026-10-20T11:58:00.000Z";
  assert.throws(() => recheckPilotDeployment({before, after, sourceSha: SHA, currentRunId: RUN, now: NOW}), /DEPLOYMENT_CHANGED/u);
});
test("successful trial manifest records STAGING_TRIAL with no authentication acceptance or cleanup", () => {
  const report = validateLimitedPilotEvidence(context());
  const result = recordStagingTrial({report, manifest: manifest(report), currentRunId: RUN, now: NOW});
  assert.equal(result.readinessState, "STAGING_TRIAL"); assert.equal(result.authenticatedStaffAcceptance, "UNVERIFIED");
  assert.equal(result.sourceAuthenticity, "UNVERIFIED"); assert.equal(result.submissionAcceptance, "UNVERIFIED");
  assert.equal(result.backupAndPreviewCleanupAuthorized, false);
  for (const change of [
    m => {m.promotionResult = "prepared";}, m => {m.operation = "limited-promote";},
    m => {m.sourceSha = "c".repeat(40);}, m => {m.runAttempt = 2;},
    m => {m.promotionRunId = "123";}, m => {m.staff.previousVersion = "d".repeat(16);},
    m => {m.admin.promotedVersion = "d".repeat(16);}, m => {m.admin.siteId = PROJECT;},
  ]) {
    const value = manifest(report); change(value);
    assert.throws(() => recordStagingTrial({report, manifest: value, currentRunId: RUN, now: NOW}), /PILOT_/u);
  }
});
test("separate authenticated observation required for STAFF_UI_ACCEPTED, other scopes remain unverified", () => {
  const report = validateLimitedPilotEvidence(context(pilotFixture(), "readiness"));
  const result = evaluate({report, observation: acceptance(report)});
  assert.equal(result.readinessState, "STAFF_UI_ACCEPTED"); assert.equal(result.authenticatedStaffAcceptance, "ACCEPTED");
  assert.equal(result.sourceAuthenticity, "UNVERIFIED"); assert.equal(result.submissionAcceptance, "UNVERIFIED");
  assert.equal(result.backupAndPreviewCleanupAuthorized, false);
  assert.throws(() => evaluate({report, observation: {browserResult: "PASS"}}), /PILOT_/u);
});
test("anonymous browser success, Admin session, claim change, scope violations and submission cannot pass", () => {
  const report = validateLimitedPilotEvidence(context());
  for (const mutate of [
    o => {o.authenticated = false;}, o => {o.staffRole = "admin";}, o => {o.adminAuthenticated = true;},
    o => {o.claimsUnchanged = false;}, o => {o.functionResults.getMyTasks = "METADATA_ACTIVE";},
    o => {delete o.functionResults.getPushStatus;}, o => {o.scopeViolations.push("unknown-request");},
    o => {o.submissionInvoked = true;}, o => {o.storageInvoked = true;},
    o => {o.mailAttemptsConsumed = 2;}, o => {o.mailRecipientDigest = "sha256:" + "c".repeat(64);},
    o => {o.target = "staging";}, o => {o.accountDigest = "sha256:" + "c".repeat(64);},
  ]) {
    const observation = acceptance(report); mutate(observation);
    assert.throws(() => evaluate({report, observation}), /PILOT_/u);
  }
});
test("acceptance expires and requires unchanged deployments around the authenticated observation", () => {
  const report = validateLimitedPilotEvidence(context()), observation = acceptance(report);
  assert.throws(() => evaluate({report, observation, now: "2026-10-20T16:00:00.000Z"}), /EXPIRED/u);
  const afterSnapshot = snapshot(); afterSnapshot.observation.capturedAt = NOW;
  afterSnapshot.functions.getMyTasks.revision = "getmytasks-00002-def";
  assert.throws(() => evaluate({report, observation, afterSnapshot}), /DEPLOYMENT_CHANGED/u);
  observation.mail.attempts[0].outcome = "UNKNOWN";
  assert.throws(() => evaluate({report, observation}), /MAIL_OUTCOME_UNRESOLVED/u);
});
test("every transition report field is required and unknown fields cannot carry alternate state", () => {
  const report = validateLimitedPilotEvidence(context()), savedManifest = manifest(report), observation = acceptance(report);
  assert.equal(validatePilotReport(report, {now: NOW}), report);
  for (const key of Object.keys(report)) {
    const malformed = structuredClone(report); delete malformed[key];
    assert.throws(() => validatePilotReport(malformed, {now: NOW}), /PILOT_/u, key);
    assert.throws(() => recordStagingTrial({report: malformed, manifest: savedManifest, currentRunId: RUN, now: NOW}), /PILOT_/u, key);
    assert.throws(() => evaluate({report: malformed, observation}), /PILOT_/u, key);
  }
  for (const extra of [{unknown: true}, {trialRecordedAt: NOW}, {acceptanceObservationDigest: DIGEST}]) {
    assert.throws(() => evaluate({report: {...report, ...extra}, observation}), /PILOT_FIELDS_REJECTED/u);
  }
});
test("report types, safety invariants, source identity and exact Hosting pair cannot be substituted", () => {
  const report = validateLimitedPilotEvidence(context());
  const mutations = [
    r => {r.schemaVersion = 2;}, r => {r.policy = "source-provenance";}, r => {r.evidenceValidation = "PASS";},
    r => {r.sourceSha = "not-a-sha";}, r => {r.sourceSha = [SHA];}, r => {r.pilotId = null;},
    r => {r.observationRunId = Number(RUN);}, r => {r.stagingTrialAuthorized = "true";},
    r => {r.declarationsRequireProtectedReview = false;}, r => {r.sourceAuthenticity = "PASS";},
    r => {r.submissionAcceptance = "PASS";}, r => {r.authenticatedStaffAcceptance = "ACCEPTED";},
    r => {r.backupAndPreviewCleanupAuthorized = true;}, r => {r.adminAuthenticated = true;},
    r => {r.mailRecipientDigest = "sha256:" + "c".repeat(64);}, r => {r.mailAttemptsConsumed = 1;},
    r => {r.hosting.previewRunId = 123;}, r => {r.hosting.previewRunAttempt = 2;},
    r => {r.hosting.previewVersions.staff = "invalid";}, r => {r.hosting.previousVersions.admin = r.hosting.previewVersions.admin;},
    r => {r.expiresAt = r.checkedAt;}, r => {r.expiresAt = "2026-10-22T12:00:00.000Z";},
    r => {r.checkedAt = "2026-10-20T12:01:00.000Z";},
    ...["evidenceDigest", "deploymentSnapshotDigest", "accountDigest", "mailRecipientDigest", "reviewedReadScopeDigest"]
      .map(field => r => {r[field] = null;}),
  ];
  for (const mutate of mutations) {
    const malformed = structuredClone(report); mutate(malformed);
    assert.throws(() => validatePilotReport(malformed, {now: NOW}), /PILOT_/u);
    assert.throws(() => evaluate({report: malformed, observation: acceptance(malformed)}), /PILOT_/u);
  }
  const missingIdentity = structuredClone(report);
  for (const field of ["accountDigest", "pilotId", "reviewedReadScopeDigest", "mailRecipientDigest"]) missingIdentity[field] = null;
  assert.throws(() => evaluate({report: missingIdentity, observation: acceptance(missingIdentity)}), /PILOT_/u,
    "Matching null identity fields cannot turn an incomplete report into authenticated acceptance");
  const badSha = structuredClone(report), beforeSnapshot = snapshot(), afterSnapshot = snapshot();
  badSha.sourceSha = beforeSnapshot.sourceSha = afterSnapshot.sourceSha = "not-a-sha";
  beforeSnapshot.observation.capturedAt = afterSnapshot.observation.capturedAt = NOW;
  const observation = acceptance(badSha); observation.sourceSha = badSha.sourceSha;
  assert.throws(() => evaluate({report: badSha, observation, beforeSnapshot, afterSnapshot}), /PILOT_/u);
  assert.throws(() => recheckPilotDeployment({before: beforeSnapshot, after: afterSnapshot,
    sourceSha: "not-a-sha", currentRunId: RUN, now: NOW}), /PILOT_SOURCE_SHA_MISMATCH/u);
  assert.throws(() => recheckPilotDeployment({before: snapshot(), after: snapshot(),
    sourceSha: SHA, currentRunId: Number(RUN), now: NOW}), /PILOT_METADATA_RUN_MISMATCH/u);
});
test("one recorded mail attempt must remain the exact prefix of the acceptance history", () => {
  for (const outcome of ["SENT", "CONFIRMED_NOT_SENT"]) {
    const evidence = pilotFixture();
    evidence.review.mail.attempts = [{outcome, evidenceDigest: "sha256:" + "1".repeat(64)}];
    const report = validateLimitedPilotEvidence(context(evidence, "readiness")), observation = acceptance(report);
    observation.mail.attempts = structuredClone(evidence.review.mail.attempts);
    assert.equal(evaluate({report, observation}).readinessState, "STAFF_UI_ACCEPTED");
    const changes = [
      o => {o.mail.attempts[0].evidenceDigest = "sha256:" + "2".repeat(64);},
      o => {o.mail.attempts[0].outcome = outcome === "SENT" ? "CONFIRMED_NOT_SENT" : "SENT";},
      o => {o.mailAttemptsConsumed = 0; o.mail.attempts = [];},
      o => {o.mailAttemptsConsumed = 2; o.mail.attempts.push({outcome: "SENT", evidenceDigest: DIGEST});},
    ];
    for (const change of changes) {
      const changed = structuredClone(observation); change(changed);
      assert.throws(() => evaluate({report, observation: changed}), /PILOT_MAIL_HISTORY_CHANGED|PILOT_SINGLE_RECIPIENT_MAIL_LEDGER_REQUIRED/u);
    }
  }
});
test("staging acceptance and its initial metadata observation must follow the recorded trial", () => {
  const report = validateLimitedPilotEvidence(context());
  const trial = recordStagingTrial({report, manifest: manifest(report), currentRunId: RUN, now: "2026-10-20T12:05:00.000Z"});
  const observation = acceptance(trial), beforeSnapshot = snapshot(), afterSnapshot = snapshot();
  observation.capturedAt = "2026-10-20T12:05:30.000Z";
  beforeSnapshot.observation.capturedAt = "2026-10-20T12:05:00.000Z";
  afterSnapshot.observation.capturedAt = "2026-10-20T12:05:45.000Z";
  const input = {report: trial, observation, beforeSnapshot, afterSnapshot, now: "2026-10-20T12:06:00.000Z"};
  assert.equal(evaluateStaffAcceptance(input).readinessState, "STAFF_UI_ACCEPTED");
  const premature = structuredClone(input);
  premature.observation.capturedAt = "2026-10-20T12:01:00.000Z";
  premature.beforeSnapshot.observation.capturedAt = "2026-10-20T12:00:30.000Z";
  premature.afterSnapshot.observation.capturedAt = "2026-10-20T12:01:30.000Z";
  assert.throws(() => evaluateStaffAcceptance(premature), /PILOT_ACCEPTANCE_STALE/u);
  const staleBefore = structuredClone(input); staleBefore.beforeSnapshot.observation.capturedAt = "2026-10-20T12:04:59.000Z";
  assert.throws(() => evaluateStaffAcceptance(staleBefore), /PILOT_ACCEPTANCE_DEPLOYMENT_MISMATCH/u);
  assert.throws(() => evaluate({report, observation: acceptance(report), beforeSnapshot: snapshot()}), /PILOT_ACCEPTANCE_DEPLOYMENT_MISMATCH/u,
    "Preauth acceptance also requires a new metadata observation after its readiness checkpoint");
});
test("state labels cannot skip a trial or repeat one-way transitions", () => {
  const report = validateLimitedPilotEvidence(context()), readiness = validateLimitedPilotEvidence(context(pilotFixture(), "readiness"));
  const trial = recordStagingTrial({report, manifest: manifest(report), currentRunId: RUN, now: NOW});
  for (const malformed of [
    {...readiness, readinessState: "STAGING_TRIAL"},
    {...readiness, readinessState: "STAGING_TRIAL", trialRecordedAt: NOW},
    {...trial, trialRecordedAt: "2026-10-20T11:59:59.000Z"},
    {...trial, trialRecordedAt: "2026-10-20T12:00:01.000Z"},
  ]) assert.throws(() => evaluate({report: malformed, observation: acceptance(malformed)}), /PILOT_/u);
  assert.throws(() => recordStagingTrial({report: trial, manifest: manifest(trial), currentRunId: RUN, now: NOW}), /PILOT_PREAUTH_REPORT_REQUIRED/u);
  const accepted = evaluate({report: trial, observation: acceptance(trial)});
  assert.throws(() => evaluate({report: accepted, observation: acceptance(accepted)}), /PILOT_PREAUTH_REPORT_REQUIRED/u);
  assert.throws(() => recordStagingTrial({report: accepted, manifest: manifest(accepted), currentRunId: RUN, now: NOW}), /PILOT_PREAUTH_REPORT_REQUIRED/u);
});
test("report histories and transition outputs do not alias mutable inputs", () => {
  const evidence = pilotFixture(); evidence.review.mail.attempts = [{outcome: "SENT", evidenceDigest: DIGEST}];
  const report = validateLimitedPilotEvidence(context(evidence));
  evidence.review.mail.attempts[0].evidenceDigest = "sha256:" + "1".repeat(64);
  assert.equal(report.mailAttempts[0].evidenceDigest, DIGEST);
  const trial = recordStagingTrial({report, manifest: manifest(report), currentRunId: RUN, now: NOW});
  assert.notEqual(trial.mailAttempts, report.mailAttempts);
  assert.notEqual(trial.mailAttempts[0], report.mailAttempts[0]);
  assert.notEqual(trial.hosting.previewVersions, report.hosting.previewVersions);
  const observation = acceptance(trial), original = JSON.stringify({report: trial, observation});
  const accepted = evaluate({report: trial, observation});
  assert.equal(JSON.stringify({report: trial, observation}), original);
  observation.mail.attempts[0].evidenceDigest = "sha256:" + "2".repeat(64);
  accepted.hosting.previewVersions.staff = "f".repeat(16);
  assert.equal(accepted.mailAttempts[0].evidenceDigest, DIGEST);
  assert.equal(trial.hosting.previewVersions.staff, "1111111111111111");
});
test("evidence digests are order independent and never mutate input", () => {
  assert.equal(pilotEvidenceDigest({z: 1, a: {b: 2, a: 1}}), pilotEvidenceDigest({a: {a: 1, b: 2}, z: 1}));
});
for (const method of ["CONTROLLED_BROWSER", "OWNER_MANUAL_UI"]) test("CLI preflight and writer recheck preserve sanitized " + method + " reports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lkc-pilot-test-"));
  const now = new Date(), evidence = method === "OWNER_MANUAL_UI" ? manualFixture() : pilotFixture();
  evidence.createdAt = new Date(now.getTime() - 60_000).toISOString();
  evidence.expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
  evidence.review.recovery.retainUntil = evidence.expiresAt;
  evidence.review.recovery.externalWritersExcludedUntil = evidence.expiresAt;
  const evidenceDir = path.join(root, "hosting-promote-evidence");
  const outputFile = path.join(root, "github-output.txt");
  const env = {...process.env, GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Hanabo0930/Lip-Knots-Crew",
    GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main", GITHUB_JOB: "promote",
    GITHUB_WORKFLOW_REF: "Hanabo0930/Lip-Knots-Crew/.github/workflows/staging-hosting-promote.yml@refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: RUN, GITHUB_RUN_ATTEMPT: "1",
    RUNNER_TEMP: root, GITHUB_OUTPUT: outputFile, LKC_EVIDENCE_DIR: evidenceDir, LKC_SOURCE_SHA: SHA, LKC_PROJECT_ID: PROJECT, LKC_REGION: REGION,
    LKC_OPERATION: "promote", LKC_CONFIRMATION: "PROMOTE_LKC_STAGING_HOSTING",
    LKC_EVIDENCE_POLICY: "limited-staff-pilot", LKC_METADATA_ONLY: "false",
    LKC_LIMITED_EVIDENCE: JSON.stringify(evidence), LKC_PREVIEW_RUN_ID: evidence.hosting.previewRunId,
    LKC_STAFF_VERSION: evidence.hosting.previewVersions.staff, LKC_ADMIN_VERSION: evidence.hosting.previewVersions.admin,
    LKC_PREVIOUS_STAFF_VERSION: evidence.hosting.previousVersions.staff, LKC_PREVIOUS_ADMIN_VERSION: evidence.hosting.previousVersions.admin};
  const cli = (...args) => spawnSync(process.execPath, ["scripts/automation/hosting-limited-pilot.mjs", ...args],
    {env, encoding: "utf8"});
  try {
    assert.equal(cli("--guard-only").status, 0);
    const guard = spawnSync(process.execPath, ["scripts/automation/hosting-limited-pilot.mjs", "--guard-only"],
      {env: {GITHUB_JOB: "guard", GITHUB_EVENT_NAME: "workflow_run", GITHUB_RUN_ATTEMPT: "1",
        LKC_OPERATION: "promote", LKC_EVIDENCE_POLICY: "source-provenance", LKC_METADATA_ONLY: "false"}, encoding: "utf8"});
    assert.equal(guard.status, 0, guard.stderr);
    const preflight = cli("--validate-review"); assert.equal(preflight.status, 0, preflight.stderr);
    assert.ok(preflight.stdout.includes("HOSTING_ACCEPTANCE_METHOD=" + method));
    assert.equal(await readFile(outputFile, "utf8"), "acceptance_method=" + method + "\n");
    assert.equal(cli("--validate-review").status, 1, "A rejected duplicate cannot append a method output");
    assert.equal(await readFile(outputFile, "utf8"), "acceptance_method=" + method + "\n");
    assert(!preflight.stdout.includes(DIGEST));
    assert.equal((await stat(path.join(root, "lkc-limited-pilot-review.json"))).mode & 0o777, 0o600);
    await mkdir(evidenceDir);
    const metadata = method === "CONTROLLED_BROWSER" ? snapshot(evidence) : undefined;
    if (metadata) {
      metadata.observation.capturedAt = now.toISOString();
      await writeFile(path.join(evidenceDir, "pilot-metadata.json"), JSON.stringify(metadata));
    }
    const check = cli("--validate"); assert.equal(check.status, 0, check.stderr);
    assert.ok(check.stdout.includes("HOSTING_ACCEPTANCE_METHOD=" + method));
    const report = JSON.parse(await readFile(path.join(evidenceDir, "limited-pilot-evidence.json"), "utf8"));
    assert.equal(report.readinessState, "PREAUTH_READY"); assert.equal(report.review, undefined);
    assert.equal(cli("--validate").status, 1, "No overwrite of existing evidence");
    const recheckFile = path.join(evidenceDir, "limited-pilot-deployment-recheck.json");
    await writeFile(path.join(evidenceDir, "restore-manifest.json"), JSON.stringify(manifest(report)));
    if (method === "CONTROLLED_BROWSER") {
      await writeFile(path.join(evidenceDir, "pilot-metadata-before-write.json"), JSON.stringify(metadata));
      const beforeWrite = cli("--recheck-before-write"); assert.equal(beforeWrite.status, 0, beforeWrite.stderr);
      await writeFile(path.join(evidenceDir, "pilot-metadata-after.json"), JSON.stringify(metadata));
      const afterWrite = cli("--recheck"); assert.equal(afterWrite.status, 0, afterWrite.stderr);
      const recheckText = await readFile(recheckFile, "utf8");
      await writeFile(recheckFile, JSON.stringify({deploymentUnchanged: true}));
      assert.equal(cli("--finalize").status, 1, "Unbound boolean recheck cannot finalize a trial");
      await writeFile(recheckFile, recheckText);
    } else {
      assert.equal(Object.hasOwn(report, "deploymentSnapshotDigest"), false);
      for (const command of ["--recheck", "--recheck-before-write"]) {
        const rejected = cli(command);
        assert.equal(rejected.status, 1); assert.match(rejected.stderr, /PILOT_MANUAL_RECHECK_NOT_APPLICABLE/u);
      }
      // These directories would fail a metadata read; manual finalization never reads them.
      for (const name of ["pilot-metadata.json", "pilot-metadata-after.json", "limited-pilot-deployment-recheck.json"])
        await mkdir(path.join(evidenceDir, name));
      const invalidManifest = manifest(report); invalidManifest.staff.promotedVersion = "e".repeat(16);
      await writeFile(path.join(evidenceDir, "restore-manifest.json"), JSON.stringify(invalidManifest));
      assert.equal(cli("--finalize").status, 1, "Manual finalization still rejects Hosting version drift");
      await writeFile(path.join(evidenceDir, "restore-manifest.json"), JSON.stringify(manifest(report)));
    }
    const finalize = cli("--finalize"); assert.equal(finalize.status, 0, finalize.stderr);
    assert.ok(finalize.stdout.includes("HOSTING_ACCEPTANCE_METHOD=" + method));
    const trial = JSON.parse(await readFile(path.join(evidenceDir, "limited-pilot-trial.json"), "utf8"));
    assert.equal(trial.readinessState, "STAGING_TRIAL");
    assert.equal(trial.authenticatedStaffAcceptance, "UNVERIFIED");
    if (method === "OWNER_MANUAL_UI") {
      assert.equal(trial.acceptanceMethod, method); assert.equal(trial.requestBoundaryEnforced, false);
      for (const output of [preflight.stdout, check.stdout, finalize.stdout]) {
        for (const marker of ["HOSTING_REQUEST_BOUNDARY_ENFORCED=false", "HOSTING_REQUEST_COUNTS_ENFORCED=false",
          "HOSTING_TECHNICAL_ACCEPTANCE=UNVERIFIED", "HOSTING_API_COMPATIBILITY=UNVERIFIED",
          "HOSTING_SERVER_SIDE_EFFECTS=UNVERIFIED", "HOSTING_BACKEND_DEPLOYMENT_UNCHANGED=UNVERIFIED",
          "HOSTING_MANUAL_OBSERVATION=NOT_PERFORMED"])
          assert.ok(output.includes(marker), marker);
        assert.equal(output.includes(DIGEST), false); assert.equal(output.includes("EXISTING_STAFF_EMAIL_CODE"), false);
      }
    }
    const unknown = cli("--anything", "synthetic-sensitive-data");
    assert.equal(unknown.status, 1); assert(!unknown.stderr.includes("synthetic-sensitive-data"));
  } finally {await rm(root, {recursive: true, force: true});}
});
