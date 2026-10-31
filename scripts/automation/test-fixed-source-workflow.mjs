import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {backupCurrentPair, releaseHostingVersion, requireCurrentSourceMutationReview} from "./restore-staging-hosting.mjs";

const workflow = readFileSync(new URL("../../.github/workflows/staging-hosting-promote.yml", import.meta.url), "utf8");
const blocks = workflow.split(/(?=^      - name: )/mu);
const step = name => {
  const block = blocks.find(text => text.startsWith(`      - name: ${name}\n`));
  assert(block, name); return block;
};
const SHA = "a".repeat(40), RUN = "12345", PROJECT = "lip-knots-crew-staging";
const METHOD = "authenticated-fixed-generation", CONFIRM = "ACQUIRE_LKC_STAGING_FIXED_SOURCE_ONCE_20MIB";
const ENV = {GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Hanabo0930/Lip-Knots-Crew",
  GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main", GITHUB_JOB: "promote",
  GITHUB_WORKFLOW_REF: "Hanabo0930/Lip-Knots-Crew/.github/workflows/staging-hosting-promote.yml@refs/heads/main",
  GITHUB_SHA: SHA, GITHUB_RUN_ID: RUN, GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "workflow_dispatch",
  LKC_OPERATION: "promote", LKC_METADATA_ONLY: "false", LKC_EVIDENCE_POLICY: "source-provenance",
  LKC_SOURCE_ACQUISITION: "fixed-source-once", LKC_SOURCE_ACQUISITION_CONFIRMATION: CONFIRM,
  LKC_APPROVED_SOURCE_EVIDENCE_SHA256: ""};
async function context(callback) {
  const previous = Object.fromEntries(Object.keys(ENV).map(key => [key, process.env[key]]));
  Object.assign(process.env, ENV);
  try {await callback();} finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
const OPTIONS = {projectId: PROJECT, region: "asia-northeast1", staffSite: PROJECT,
  adminSite: `${PROJECT}-admin`, evidenceDir: "/synthetic-fixed-evidence", sourceSha: SHA,
  promotionRunId: RUN, runAttempt: 1, rollbackChannel: `rb-${RUN}`};
const DEADLINE = "2026-10-31T00:10:00.000Z", BEFORE = "2026-10-31T00:09:59.000Z";
const receipt = () => ({status: "PASS", sourceSha: SHA, evidenceDigest: "b".repeat(64),
  evidenceMethod: METHOD, expiresAt: DEADLINE, runId: RUN, runAttempt: 1});

test("fixed workflow: deliberate manual acquisition guard precedes authentication; retained path remains default", () => {
  assert.match(workflow, /source_acquisition:\n[\s\S]*?default: retained/u);
  assert(workflow.includes("github.event_name == 'workflow_run' && 'retained'"));
  const guard = step("Prepare the approved fixed-source one-shot guard before authentication");
  assert.match(guard, /if: env\.LKC_SOURCE_ACQUISITION == 'fixed-source-once'/u);
  assert(guard.includes("--fixed-source-guard"));
  assert(workflow.indexOf(guard) < workflow.indexOf(step("Authenticate with the short-lived staging identity")));
  const retained = step("Stop source verification unless a no-fee path is established");
  assert(retained.includes("env.LKC_SOURCE_ACQUISITION != 'fixed-source-once'"));
  assert(retained.includes("--no-fee-source-guard"));
  assert(retained.includes("vars.LKC_STAGING_SOURCE_EVIDENCE_SHA256"));
});

test("fixed workflow: actual dispatch shell rejects unintended acquisition combinations", () => {
  const guard = step("Require current main, canonical CI and exact scope");
  const start = guard.indexOf('          case "$LKC_SOURCE_ACQUISITION" in\n');
  const end = guard.indexOf("          esac\n", start) + "          esac\n".length;
  assert(start >= 0 && end > start);
  const shell = guard.slice(start, end).split("\n").map(line => line.slice(10)).join("\n");
  const base = {...process.env, ...ENV};
  for (const operation of ["readiness", "promote"]) {
    assert.equal(spawnSync("bash", ["-euo", "pipefail", "-c", shell], {env: {...base, LKC_OPERATION: operation}}).status, 0);
  }
  for (const [key, value] of Object.entries({GITHUB_EVENT_NAME: "workflow_run", GITHUB_RUN_ATTEMPT: "2",
    LKC_OPERATION: "restore", LKC_METADATA_ONLY: "true", LKC_EVIDENCE_POLICY: "limited-staff-pilot",
    LKC_SOURCE_ACQUISITION: "other", LKC_SOURCE_ACQUISITION_CONFIRMATION: ""})) {
    assert.notEqual(spawnSync("bash", ["-euo", "pipefail", "-c", shell], {env: {...base, [key]: value}}).status, 0, key);
  }
  assert.equal(spawnSync("bash", ["-euo", "pipefail", "-c", shell], {env: {...base,
    LKC_SOURCE_ACQUISITION: "retained", LKC_SOURCE_ACQUISITION_CONFIRMATION: ""}}).status, 0);
  assert.notEqual(spawnSync("bash", ["-euo", "pipefail", "-c", shell], {env: {...base,
    LKC_SOURCE_ACQUISITION: "retained"}}).status, 0);
});

test("fixed workflow: build, collection and strict readiness precede every Hosting change", () => {
  const readiness = step("Verify deployed upload APIs before any live Hosting change");
  assert(readiness.indexOf("npm run build -w @lkc/functions") < readiness.indexOf("--collect-fixed-source"));
  assert(readiness.indexOf("--collect-fixed-source") < readiness.indexOf("check-hosting-api-readiness.py"));
  assert(readiness.includes('if [[ "$LKC_SOURCE_ACQUISITION" == "fixed-source-once" ]]'));
  assert(readiness.indexOf("unset LKC_FIXED_SOURCE_ACCESS_TOKEN") < readiness.indexOf("check-hosting-api-readiness.py"));
  assert(readiness.indexOf("unset LKC_FIXED_SOURCE_ACCESS_TOKEN") < readiness.indexOf("npm run build -w @lkc/functions"));
  assert(readiness.includes('LKC_FIXED_SOURCE_ACCESS_TOKEN="$fixed_source_access_token" node scripts/automation/collect-upload-metadata.mjs --collect-fixed-source'));
  for (const name of ["Back up both current live channels", "Promote the already-tested versions without rebuilding"]) {
    assert(workflow.indexOf(readiness) < workflow.indexOf(step(name)));
  }
  assert(step("Upload promotion and rollback evidence").includes("path: ${{ env.LKC_EVIDENCE_DIR }}"));
  assert(!step("Upload promotion and rollback evidence").includes("hosting-fixed-source-evidence"));
  const cleanup = step("Remove private fixed-source bytes and key after all verification and recovery");
  assert(cleanup.includes("always() && env.LKC_SOURCE_ACQUISITION == 'fixed-source-once'"));
  assert(workflow.indexOf(cleanup) > workflow.indexOf(step("Check both apps after evidence failure recovery")));
  assert(cleanup.includes("--cleanup-fixed-source"));
});

test("fixed mutation guard: method/run-bound verifier receipt required without repurposing retained pin", () => context(async () => {
  let calls = 0;
  const run = (command, args, settings) => {
    calls++; assert.equal(command, "python3"); assert(args.includes("--mutation-guard"));
    assert(!args.includes("--preflight")); assert.deepEqual(settings.stdio, ["ignore", "pipe", "pipe"]);
    return {status: 0, stdout: JSON.stringify(receipt())};
  };
  await requireCurrentSourceMutationReview(OPTIONS, {run, now: () => BEFORE}); assert.equal(calls, 1);
  for (const change of [{evidenceMethod: "retained"}, {evidenceMethod: undefined}, {evidenceDigest: "untrusted"},
    {sourceSha: "c".repeat(40)}, {runId: "999"}, {runAttempt: 2}, {status: "COLLECTED"}, {verified: true}]) {
    await assert.rejects(() => requireCurrentSourceMutationReview(OPTIONS, {run: () => ({status: 0,
      stdout: JSON.stringify({...receipt(), ...change})}), now: () => BEFORE}), /SOURCE_MUTATION_RECEIPT_MISMATCH/u);
  }
  for (const [key, value] of Object.entries({GITHUB_EVENT_NAME: "workflow_run", LKC_OPERATION: "readiness",
    LKC_METADATA_ONLY: "true", LKC_EVIDENCE_POLICY: "limited-staff-pilot", GITHUB_SHA: "c".repeat(40),
    LKC_SOURCE_ACQUISITION_CONFIRMATION: ""})) {
    process.env[key] = value;
    await assert.rejects(() => requireCurrentSourceMutationReview(OPTIONS, {run: () => assert.fail("VERIFIER_UNEXPECTED")}),
      /FIXED_SOURCE_EXPLICIT_REVIEW_REQUIRED/u);
    process.env[key] = ENV[key];
  }
  process.env.LKC_SOURCE_ACQUISITION = "retained";
  await assert.rejects(() => requireCurrentSourceMutationReview(OPTIONS, {run: () => assert.fail("PIN_REQUIRED")}), /SOURCE_MUTATION_PIN_REQUIRED/u);
}));

test("fixed mutation guard: all four backup and two live POST hooks recheck receipt deadline", () => context(async () => {
  for (let expiredAt = 1; expiredAt <= 7; expiredAt++) {
    let checks = 0, posts = 0;
    const live = new Map([[PROJECT, "1".repeat(16)], [`${PROJECT}-admin`, "2".repeat(16)]]), backup = new Map();
    const metadata = (site, id) => ({name: `sites/${site}/versions/${id}`, status: "FINALIZED"});
    const reader = {
      channel: async (site, channel) => ({release: {version: metadata(site, channel === "live" ? live.get(site) : backup.get(site))}}),
      version: async (site, id) => metadata(site, id),
      createBackup: async () => {posts++;},
      release: async (site, channel, id) => {posts++; (channel === "live" ? live : backup).set(site, id);},
    };
    const authorizeMutation = () => requireCurrentSourceMutationReview(OPTIONS, {
      run: () => {checks++; return {status: 0, stdout: JSON.stringify(receipt())};},
      now: () => checks >= expiredAt ? DEADLINE : BEFORE,
    });
    let failed = false;
    try {await backupCurrentPair(OPTIONS, reader, {authorizeMutation});} catch (error) {
      assert.match(error.message, /SOURCE_MUTATION_EVIDENCE_EXPIRED/u); failed = true;
    }
    if (!failed) for (const site of [PROJECT, `${PROJECT}-admin`]) {
      const result = await releaseHostingVersion({source: `${site}@${"3".repeat(16)}`, target: `${site}:live`,
        projectId: PROJECT, cwd: ".", expectedLiveVersion: live.get(site), authorizeMutation}, {reader});
      if (result.code !== 0) {assert.equal(result.outcome, "not-attempted"); break;}
    }
    assert.equal(posts, Math.min(expiredAt - 1, 6)); assert.equal(checks, Math.min(expiredAt, 6));
  }
}));
