import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {readPilotHostingPins, validatePilotCapture, validatePilotPins} from "./hosting-limited-workflow.mjs";
const project = "lip-knots-crew-staging", sha = "a".repeat(40);
const options = {sourceSha: sha, previewRunId: "123"};
const versions = {staff: ["1".repeat(16), "2".repeat(16)], admin: ["3".repeat(16), "4".repeat(16)]};
const reader = {channel: async (site, channel) => ({release: {version: {
  name: `sites/${site}/versions/${versions[site === project ? "staff" : "admin"][channel === "live" ? 0 : 1]}`,
  status: "FINALIZED",
}}})};
const evidence = pins => ({sourceSha: sha, hosting: {
  previewRunId: pins.previewRunId, previousVersions: pins.previousVersions, previewVersions: pins.previewVersions,
}});
function manifest(pins) {
  return {schemaVersion: 1, projectId: project, region: "asia-northeast1", operation: "promote", promotionResult: "prepared",
    sourceSha: sha, promotionRunId: "456", runAttempt: 1,
    ...Object.fromEntries(["staff", "admin"].map(label => [label, {siteId: project + (label === "admin" ? "-admin" : ""),
      previousVersion: pins.previousVersions[label], promotedVersion: pins.previewVersions[label]}]))};
}
test("pins both immutable preview versions and both previous live versions without writes", async () => {
  const calls = [];
  const pins = await readPilotHostingPins(options, {channel: async (...args) => {calls.push(args); return reader.channel(...args);}});
  assert.equal(calls.length, 4);
  assert.deepEqual(new Set(calls.map(call => call[1])), new Set(["live", "rc-" + sha.slice(0, 12)]));
  validatePilotPins(pins, evidence(pins));
  validatePilotCapture(pins, manifest(pins), {runId: "456", runAttempt: 1});
});
test("unknown identities and non-finalized or cross-project versions stop", async () => {
  for (const extra of [{sourceSha: "main"}, {previewRunId: "123\n"}])
    await assert.rejects(readPilotHostingPins({...options, ...extra}, reader), /PILOT_PIN_IDENTITY_REQUIRED/u);
  for (const version of [{status: "CREATED", name: "anything"}, {status: "FINALIZED", name: `sites/production/versions/${"a".repeat(16)}`}])
    await assert.rejects(readPilotHostingPins(options, {channel: async () => ({release: {version}})}), /PILOT_VERSION/u);
});
test("review pins cannot substitute a different preview or previous live version", async () => {
  const pins = await readPilotHostingPins(options, reader);
  for (const field of ["previewVersions", "previousVersions"]) for (const label of ["staff", "admin"]) {
    const e = structuredClone(evidence(pins));
    e.hosting[field][label] = "f".repeat(16);
    assert.throws(() => validatePilotPins(pins, e), /PILOT_REVIEW_VERSION_MISMATCH/u);
  }
});
test("captured pair must match reviewed versions, run, attempt, scope and SHA", async () => {
  const pins = await readPilotHostingPins(options, reader);
  const changes = [
    m => {m.sourceSha = "b".repeat(40);}, m => {m.runAttempt = 2;}, m => {m.promotionRunId = "457";},
    m => {m.operation = "readiness";}, m => {m.projectId = "production";}, m => {m.region = "us-central1";},
    m => {m.staff.previousVersion = "f".repeat(16);}, m => {m.admin.promotedVersion = "f".repeat(16);},
    m => {m.admin.siteId = project;}, m => {m.promotionResult = "success";},
  ];
  for (const change of changes) {
    const m = manifest(pins); change(m);
    assert.throws(() => validatePilotCapture(pins, m, {runId: "456", runAttempt: 1}), /PILOT_CAPTURE/u);
  }
});
test("limited workflow keeps canonical promotion and restore identity and no early cleanup", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/staging-hosting-promote.yml", import.meta.url), "utf8");
  assert.match(workflow, /^name: Staging Hosting Promote$/mu);
  assert.match(workflow, /options: \[source-provenance, limited-staff-pilot\]/u);
  assert.match(workflow, /name: staging-hosting-\$\{\{ env\.LKC_OPERATION \}\}-\$\{\{ env\.LKC_SOURCE_SHA \}\}/u);
  assert.match(workflow, /env\.LKC_EVIDENCE_POLICY == 'source-provenance'.*\n.*working-directory: source\n.*run: \|\n.*node scripts\/automation\/restore-staging-hosting\.mjs \\\n.*--cleanup/u);
  assert.doesNotMatch(workflow, /continue-on-error: true[\s\S]{0,80}hosting-limited-pilot\.mjs --validate/u);
  for (const command of ["--validate-review", "--validate", "--verify-capture", "--recheck", "--finalize"])
    assert.ok(workflow.includes(command), command);
  const strict = await readFile(new URL("./check-hosting-api-readiness.py", import.meta.url), "utf8");
  assert.ok(strict.includes('"SOURCE_PROVENANCE_REQUIRED"'));
  const restore = await readFile(new URL("./restore-staging-hosting.mjs", import.meta.url), "utf8");
  assert.match(restore, /throw new Error\("VERIFIED_NO_FEE_SOURCE_PATH_REQUIRED"\)/u);
});
