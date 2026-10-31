import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {test, beforeEach, afterEach} from "node:test";
import vm from "node:vm";
import {collectUploadMetadata, metadataMain, FUNCTION_FIELDS, BUILD_FIELDS} from "./collect-upload-metadata.mjs";
import "./test-fixed-upload-sources.mjs";
import "./test-fixed-source-workflow.mjs";

const PROJECT = "lip-knots-crew-staging", REGION = "asia-northeast1";
const PREFIX = `projects/${PROJECT}/locations/${REGION}`;
const BUILD = `${PREFIX}/builds/synthetic-build`;
const TOKEN = "SYNTHETIC_ACCESS_TOKEN_DO_NOT_RECORD";
const publicEnv = {
  GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Hanabo0930/Lip-Knots-Crew",
  GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main", GITHUB_JOB: "promote",
  GITHUB_WORKFLOW_REF: "Hanabo0930/Lip-Knots-Crew/.github/workflows/staging-hosting-promote.yml@refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1", GITHUB_RUN_ID: "12345",
  GITHUB_SHA: "a".repeat(40),
  LKC_OPERATION: "readiness", LKC_METADATA_ONLY: "true", LKC_SOURCE_SHA: "a".repeat(40),
  LKC_CONFIRMATION: "CHECK_LKC_STAGING_HOSTING_READINESS", LKC_PROJECT_ID: PROJECT, LKC_REGION: REGION,
};
let saved, savedFetch;
beforeEach(() => {
  savedFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail("Live HTTP is forbidden in this offline suite");
  saved = Object.fromEntries(Object.keys(publicEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, publicEnv);
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  delete process.env.LKC_METADATA_ACCESS_TOKEN;
});

function fixtures() {
  const functions = Object.fromEntries(["createUploadSession", "finalizeStagedUpload"].map(name => [name, {
    name: `${PREFIX}/functions/${name}`, environment: "GEN_2", state: "ACTIVE",
    buildConfig: {build: BUILD, runtime: "nodejs22", entryPoint: name,
      sourceProvenance: {resolvedStorageSource: {bucket: "synthetic-source", object: "source.zip", generation: "123"}}},
    serviceConfig: {service: `${PREFIX}/services/${name.toLowerCase()}`, revision: `${name.toLowerCase()}-00001-abc`,
      allTrafficOnLatestRevision: true},
  }]));
  const builds = {[BUILD]: {id: "synthetic-build", projectId: PROJECT, status: "SUCCESS",
    sourceProvenance: {resolvedStorageSource: {bucket: "synthetic-source", object: "source.zip", generation: "123"},
      fileHashes: {"unpresumed-archive-key": {fileHash: [{type: "SHA256", value: "AA=="}]}}},
    results: {images: [{digest: "sha256:" + "0".repeat(64)}]}}};
  return {functions, builds};
}

function transport(data, behavior) {
  const calls = [];
  return {calls, request: async (rawUrl, options) => {
    const url = new URL(rawUrl);
    calls.push({url: rawUrl, method: options.method});
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(url.protocol, "https:");
    assert.deepEqual([...url.searchParams.keys()], ["fields"]);
    let document;
    if (url.hostname === "cloudfunctions.googleapis.com") {
      assert.equal(url.searchParams.get("fields"), FUNCTION_FIELDS);
      assert.match(url.pathname, new RegExp(`^/v2/${PREFIX}/functions/(createUploadSession|finalizeStagedUpload)$`, "u"));
      document = data.functions[url.pathname.split("/").at(-1)];
    } else {
      assert.equal(url.hostname, "cloudbuild.googleapis.com");
      assert.equal(url.searchParams.get("fields"), BUILD_FIELDS);
      const name = url.pathname.slice(4);
      assert(Object.hasOwn(data.builds, name), "Only explicitly referenced Builds may be fetched");
      document = data.builds[name];
    }
    if (behavior) {const override = behavior({url, document, calls}); if (override) return override;}
    return new Response(JSON.stringify(document), {status: 200, headers: {"content-type": "application/json"}});
  }};
}
const collect = io => collectUploadMetadata({accessToken: TOKEN}, io);

test("two Functions and one shared Build; GET-only observation, never readiness PASS", async () => {
  const io = transport(fixtures()), result = await collect(io);
  assert.equal(result.status, "METADATA_COLLECTED");
  assert.equal(io.calls.length, 3);
  assert.equal(result.readinessStatus, "NOT_EVALUATED");
  assert.equal(result.hostingPromotionAuthorized, false);
  assert.equal(result.deploymentBindingVerified, false);
  assert.equal(result.archive.status, "NOT_PROVIDED");
  assert.equal(result.archive.downloaded, false);
  assert(!JSON.stringify(result).includes(TOKEN));
});

test("distinct referenced Builds are each fetched once; no guessed hash-key contract", async () => {
  const data = fixtures(), second = `${PREFIX}/builds/second`;
  data.functions.finalizeStagedUpload.buildConfig.build = second;
  data.builds[second] = {...data.builds[BUILD], id: "second"};
  const io = transport(data), result = await collect(io);
  assert.equal(result.status, "METADATA_COLLECTED");
  assert.equal(io.calls.length, 4);
  assert(result.builds[second].sourceProvenance.fileHashes["unpresumed-archive-key"]);
});

test("unexpected runtime/state and missing hash are observations, not readiness success", async () => {
  const data = fixtures();
  data.functions.createUploadSession.state = "FAILED";
  data.functions.createUploadSession.buildConfig.runtime = "nodejs20";
  delete data.builds[BUILD].sourceProvenance.fileHashes;
  const io = transport(data), result = await collect(io);
  assert.equal(result.status, "METADATA_COLLECTED");
  assert(result.findings.some(f => f.field === "state" && f.code === "UNEXPECTED"));
  assert(result.findings.some(f => f.field === "runtime" && f.code === "UNEXPECTED"));
  assert(result.findings.some(f => f.field === "fileHashes" && f.code === "MISSING"));
  assert.equal(result.hostingPromotionAuthorized, false);
  assert.equal(io.calls.length, 3);
});

test("missing Build and source are explicitly reported without download or guessed GET", async () => {
  const data = fixtures();
  for (const item of Object.values(data.functions)) {delete item.buildConfig.build; delete item.buildConfig.sourceProvenance;}
  const io = transport(data), result = await collect(io);
  assert.equal(result.status, "METADATA_COLLECTED");
  assert.equal(io.calls.length, 2);
  assert.equal(result.findings.filter(f => f.code === "MISSING").length, 4);
  assert.deepEqual(result.builds, {});
});

test("malformed SHA256 and partial source metadata are reported without assuming package format", async () => {
  const data = fixtures();
  delete data.functions.finalizeStagedUpload.buildConfig.sourceProvenance.resolvedStorageSource.generation;
  const result = await collect(transport(data));
  assert.equal(result.status, "METADATA_COLLECTED");
  assert(result.findings.some(f => f.field === "SHA256" && f.code === "MALFORMED"));
  assert(result.findings.some(f => f.field === "resolvedStorageSource.generation" && f.code === "MISSING"));
  assert.equal(result.archive.checked, false);
});

test("unexpected Build response fields and wrong Build identity cannot enter artifacts", async () => {
  for (const field of ["steps", "substitutions", "secrets"]) {
    const data = fixtures(); data.builds[BUILD][field] = "SYNTHETIC_BUILD_PRIVATE";
    const result = await collect(transport(data));
    assert.equal(result.reason, "RESPONSE_FIELDS_REJECTED");
    assert(!JSON.stringify(result).includes("SYNTHETIC_BUILD_PRIVATE"));
    assert.deepEqual(result.builds, {});
  }
  const data = fixtures(); data.builds[BUILD].projectId = "other";
  assert.equal((await collect(transport(data))).reason, "BUILD_IDENTITY_MISMATCH");
});

test("oversized or non-JSON responses stop and no fallback transport runs", async () => {
  for (const response of [
    new Response("x".repeat(512 * 1024 + 1), {headers: {"content-type": "application/json"}}),
    new Response("<html>error</html>", {headers: {"content-type": "text/html"}}),
  ]) {
    const io = transport(fixtures(), () => response), result = await collect(io);
    assert.equal(result.status, "STOPPED"); assert.equal(io.calls.length, 1);
    assert(["METADATA_RESPONSE_TOO_LARGE", "METADATA_CONTENT_TYPE_REJECTED"].includes(result.reason));
  }
});

test("missing access token stops before any HTTP request", async () => {
  let calls = 0;
  const result = await collectUploadMetadata({}, {request: async () => {calls++; assert.fail("Transport reached");}});
  assert.equal(result.reason, "METADATA_ACCESS_TOKEN_REQUIRED"); assert.equal(calls, 0);
});

test("foreign project/region/host or malformed Build reference stops before any Build GET", async () => {
  for (const name of ["projects/foreign/locations/asia-northeast1/builds/x",
    `projects/${PROJECT}/locations/global/builds/x`, "https://storage.googleapis.com/bucket/source.zip",
    `${PREFIX}/builds/../secret`]) {
    const data = fixtures(); data.functions.finalizeStagedUpload.buildConfig.build = name;
    const io = transport(data), result = await collect(io);
    assert.equal(result.status, "STOPPED"); assert.equal(result.reason, "BUILD_SCOPE_MISMATCH");
    assert.equal(io.calls.length, 2);
    assert(io.calls.every(call => new URL(call.url).hostname === "cloudfunctions.googleapis.com"));
  }
});

test("403/401 stop without reading error body, retrying, or changing permissions", async () => {
  for (const status of [401, 403]) {
    const io = transport(fixtures(), () => ({status, get body() {throw Error("Do not read error body");}}));
    const result = await collect(io);
    assert.equal(result.reason, "METADATA_ACCESS_DENIED"); assert.equal(io.calls.length, 1);
    assert(!JSON.stringify(result).includes(TOKEN));
  }
});

test("Build 403 preserves only prior allowlisted Function metadata; no retry", async () => {
  const io = transport(fixtures(), ({url}) => url.hostname === "cloudbuild.googleapis.com" ? {status: 403} : undefined);
  const result = await collect(io);
  assert.equal(result.reason, "METADATA_ACCESS_DENIED"); assert.equal(io.calls.length, 3);
  assert.equal(Object.keys(result.functions).length, 2); assert.deepEqual(result.builds, {});
});

test("redirect and HTTP failure never follow a source URL", async () => {
  for (const response of [{status: 302, redirected: false}, {status: 200, redirected: true}, {status: 500}]) {
    const io = transport(fixtures(), () => response), result = await collect(io);
    assert.equal(result.reason, "METADATA_HTTP_FAILED"); assert.equal(io.calls.length, 1);
  }
});

test("unexpected env/secret/credential response fields are never retained", async () => {
  for (const field of ["environmentVariables", "secretEnvironmentVariables", "sourceToken"]) {
    const data = fixtures(); data.functions.createUploadSession.buildConfig[field] = "SYNTHETIC_PRIVATE_VALUE";
    const result = await collect(transport(data));
    assert.equal(result.reason, "RESPONSE_FIELDS_REJECTED");
    assert(!JSON.stringify(result).includes("SYNTHETIC_PRIVATE_VALUE"));
    assert.deepEqual(result.functions, {});
  }
});

test("transport errors and reflected tokens cannot leak into evidence", async () => {
  const thrown = await collect({request: async () => {throw Error(TOKEN);}});
  assert.equal(thrown.reason, "METADATA_TRANSPORT_OR_INPUT_FAILED");
  assert(!JSON.stringify(thrown).includes(TOKEN));
  const data = fixtures(); data.functions.createUploadSession.updateTime = TOKEN;
  const reflected = await collect(transport(data));
  assert.equal(reflected.reason, "METADATA_TOKEN_REFLECTION_REJECTED");
  assert(!JSON.stringify(reflected).includes(TOKEN));
});

test("wrong protected context, typed confirmation or metadata mode stops before GET", async () => {
  for (const [key, value] of Object.entries({GITHUB_JOB: "metadata", GITHUB_REF: "refs/heads/other",
    GITHUB_WORKFLOW_REF: "Hanabo0930/Lip-Knots-Crew/.github/workflows/new-metadata.yml@refs/heads/main",
    GITHUB_REPOSITORY: "other/repo", LKC_CONFIRMATION: "PROMOTE_LKC_STAGING_HOSTING",
    LKC_OPERATION: "promote", LKC_METADATA_ONLY: "false", LKC_PROJECT_ID: "production", LKC_REGION: "us-central1"})) {
    process.env[key] = value;
    let calls = 0;
    const result = await collect({request: async () => {calls++; throw Error("Forbidden");}});
    assert.equal(result.status, "STOPPED"); assert.equal(calls, 0);
    process.env[key] = publicEnv[key];
  }
});

test("guard-only does not obtain a token, call a transport, or save evidence", async () => {
  const output = [];
  const code = await metadataMain({argv: ["--guard-only"], request: () => assert.fail("Transport reached"),
    save: () => assert.fail("Save reached"), emit: line => output.push(line)});
  assert.equal(code, 0); assert.deepEqual(output, ["HOSTING_METADATA_CONTEXT=VALIDATED"]);
});

test("CLI saves only limited metadata; emits METADATA_COLLECTED and no PASS/SUCCESS", async () => {
  const io = transport(fixtures()), output = [], savedResults = [];
  process.env.LKC_METADATA_ACCESS_TOKEN = TOKEN;
  const code = await metadataMain({argv: [], request: io.request, save: result => savedResults.push(result), emit: line => output.push(line)});
  assert.equal(code, 0); assert.equal(process.env.LKC_METADATA_ACCESS_TOKEN, undefined);
  assert.deepEqual(output, ["HOSTING_METADATA_RESULT=METADATA_COLLECTED", "HOSTING_PUBLICATION_AUTHORIZED=false"]);
  assert.equal(savedResults.length, 1); assert(!JSON.stringify(savedResults).includes(TOKEN));
});

const workflow = readFileSync(new URL("../../.github/workflows/staging-hosting-promote.yml", import.meta.url), "utf8");
function stepBlocks(text) {
  const headers = [...text.matchAll(/^      - name: (.+)\r?\n/gmu)];
  return headers.map((match, index) => ({name: match[1],
    body: text.slice(match.index + match[0].length, headers[index + 1]?.index ?? text.length)}));
}
function condition(block) {
  const match = /^        if: (.+)$/mu.exec(block.body);
  if (!match) return "success()";
  if (match[1].trim() !== ">-") return match[1].trim();
  return /^        if: >-\r?\n((?:          .+\r?\n)+)/mu.exec(block.body)[1].trim().replace(/\s+/gu, " ");
}
function evaluate(expression, context, jobStatus = "success") {
  // Test-only evaluation of this checked-in workflow expression, never a shell command.
  return vm.runInNewContext(expression, {...context, always: () => true,
    success: () => jobStatus === "success", failure: () => jobStatus === "failure",
    cancelled: () => jobStatus === "cancelled"}, {timeout: 100});
}

function shouldRun(block, context, jobStatus = "success") {
  const expression = condition(block);
  // GitHub adds success() unless the condition already has a status function.
  if (!/\b(?:always|success|failure|cancelled)\s*\(/u.test(expression) && jobStatus !== "success") return false;
  return Boolean(evaluate(expression, context, jobStatus));
}

function scriptedBody(block) {
  const match = /^        run: \|\r?\n([\s\S]*)/mu.exec(block.body);
  assert(match, `Missing run body for ${block.name}`);
  return match[1].split(/\r?\n/u).map(line => line.replace(/^          /u, "")).join("\n").trim();
}

function validateDecisionShell(script) {
  assert(!/`|\$\(/u.test(script));
  const logicalLines = script.replace(/\\\r?\n\s*/gu, " ").split("\n");
  assert(logicalLines.every(line => /^(?:\s*|\s*if \[\[ .* \]\]; then|\s*else|\s*fi|\s*echo "[A-Za-z0-9_=.-]+"|\s*exit [01])$/u.test(line)),
    "Decision script contains a non-decision command");
}

function metadataDecisionPrefix(script) {
  const policyGuard = "node scripts/automation/hosting-limited-pilot.mjs --guard-only\n";
  assert(script.startsWith(policyGuard), "Evidence policy must be checked before the metadata-only branch");
  // The real policy CLI is exercised by test-hosting-automation.mjs. Keep this
  // Linux/Windows decision-only fixture incapable of executing arbitrary Node.
  const prefix = script.slice(policyGuard.length, script.indexOf("\nnode scripts/automation/restore-staging-hosting.mjs"));
  assert(prefix.endsWith("fi"));
  return prefix;
}

function runDecisionShell(script, operation, metadataOnly) {
  // Execute only the extracted decision on Linux CI. Windows Bash was denied;
  // do not retry it, launch WSL/another shell, or count these cases as verified.
  assert.notEqual(process.platform, "win32", "Windows Bash access denied; no retry allowed");
  validateDecisionShell(script);
  const executable = "/bin/bash";
  const result = spawnSync(executable, ["--noprofile", "--norc", "-c", script], {
    encoding: "utf8", timeout: 5000,
    env: {LKC_OPERATION: operation, LKC_METADATA_ONLY: String(metadataOnly), LKC_EVIDENCE_POLICY: "source-provenance"},
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  return result;
}

test("metadata-only workflow graph cannot reach Hosting/Storage/build/deploy side effects", () => {
  const blocks = stepBlocks(workflow);
  assert(blocks.length > 25, "Workflow parser must cover the full job");
  const steps = Object.fromEntries(["backup", "promotion", "live_check", "rollback", "manual_restore", "manual_restore_check", "evidence_rollback"]
    .map(name => [name, {outcome: "success", outputs: {ready: "true", rollback_allowed: "true", attempted: "true"}}]));
  const allowed = new Set(["Require the deliberate live-staging enable switch", "Checkout current main",
    "Require current main, canonical CI and exact scope", "Prepare evidence directory",
    "Checkout the exact CI-passing main source", "Re-check source is still current main after approval", "Set up Node for metadata only",
    "Validate protected metadata-only scope before authentication", "Authenticate for limited metadata GETs",
    "Collect only upload Function and referenced Build metadata", "Upload promotion and rollback evidence",
    "Publish promotion summary", "Enforce the final result"]);
  for (const block of blocks) if (evaluate(condition(block), {env: {LKC_OPERATION: "readiness", LKC_METADATA_ONLY: "true", LKC_EVIDENCE_POLICY: "source-provenance"}, steps})) {
    assert(allowed.has(block.name), `Unexpected reachable step: ${block.name}`);
    assert(!/npx firebase|npm run build|setup-gcloud|--backup|--promote-capture|--restore-capture|--cleanup/u.test(block.body), block.name);
  }
  const names = blocks.map(b => b.name);
  assert(names.indexOf("Validate protected metadata-only scope before authentication") < names.indexOf("Authenticate for limited metadata GETs"));
  assert(names.indexOf("Authenticate for limited metadata GETs") < names.indexOf("Collect only upload Function and referenced Build metadata"));
});

test("same filename/job/protected environment/pinned identity; current-main and CI checks retained", () => {
  assert.match(workflow, /  promote:\s+needs: guard/u);
  assert.match(workflow, /environment: lkc-staging-hosting/u);
  assert.match(workflow, /CANONICAL_CI_NOT_SUCCESSFUL/u);
  assert.match(workflow, /SOURCE_SHA_NOT_CURRENT_MAIN/u);
  assert.match(workflow, /SOURCE_SHA_CHANGED_DURING_APPROVAL/u);
  assert.match(workflow, /CHECK_LKC_STAGING_HOSTING_READINESS/u);
  const auth = [...workflow.matchAll(/uses: google-github-actions\/auth@([^\s]+)/gu)].map(m => m[1]);
  assert.deepEqual(auth, ["7c6bc770dae815cd3e89ee6cdf493a5fab2cc093", "7c6bc770dae815cd3e89ee6cdf493a5fab2cc093"]);
  assert.match(workflow, /create_credentials_file: false\s+export_environment_variables: false/u);
  assert.match(workflow, /access_token_scopes: https:\/\/www\.googleapis\.com\/auth\/cloud-platform\r?\n/u);
  assert.match(workflow, /service_account: \$\{\{ env\.LKC_GCP_STAGING_DEPLOY_SERVICE_ACCOUNT \}\}/u);
  const final = stepBlocks(workflow).find(block => block.name === "Enforce the final result").body;
  const metadataBranch = final.slice(0, final.indexOf('if [[ "$LKC_OPERATION" == "readiness" ]]'));
  assert.match(metadataBranch, /HOSTING_METADATA_RESULT=METADATA_COLLECTED/u);
  assert(!/HOSTING_READINESS_RESULT=SUCCESS|HOSTING_PROMOTION_RESULT=SUCCESS/u.test(metadataBranch));
  assert.match(metadataBranch, /exit 0/u);
  const nodeSteps = stepBlocks(workflow).filter(block => block.body.includes("uses: actions/setup-node@"));
  assert.equal(nodeSteps.length, 2);
  for (const metadataOnly of [true, false]) {
    const active = nodeSteps.filter(block => shouldRun(block, {env: {LKC_METADATA_ONLY: String(metadataOnly)}}));
    assert.equal(active.length, 1);
    assert.match(active[0].body, /uses: actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/u);
    assert.match(active[0].body, /node-version: "22"/u);
    assert.match(active[0].body, /package-manager-cache: false/u);
    assert.doesNotMatch(active[0].body, /^\s+cache(?:-dependency-path)?:/mu);
  }
});

test("metadata-only queue is separate and serial; promote group is unchanged, no cancellation", () => {
  const expression = /concurrency:\s+group: >-\s+\$\{\{([\s\S]*?)\}\}\s+cancel-in-progress: false/u.exec(workflow)?.[1];
  assert(expression);
  const github = {event_name: "workflow_dispatch", ref: "refs/heads/main", run_id: "12345"};
  const format = (value, id) => value.replace("{0}", id);
  const group = inputs => evaluate(expression, {github, inputs, format});
  assert.equal(group({operation: "readiness", metadata_only: true}), "lkc-staging-hosting-metadata-readiness");
  assert.equal(group({operation: "readiness", metadata_only: false}), "lkc-staging-hosting-promote");
  assert.equal(group({operation: "promote", metadata_only: false}), "lkc-staging-hosting-promote");
  assert.equal(group({operation: "restore", metadata_only: false}), "lkc-staging-hosting-promote");
  assert.equal(group({operation: "readiness", metadata_only: true, evidence_policy: "source-provenance"}), "lkc-staging-hosting-metadata-readiness");
  assert.equal(group({operation: "readiness", metadata_only: true, evidence_policy: "limited-staff-pilot"}), "lkc-staging-hosting-promote");
  assert(!/gh run cancel|pending_deployments.*POST|cancel-in-progress: true/u.test(workflow));
});

test("metadata mode graph excludes side effects under success, failure, cancelled and always", () => {
  const blocks = stepBlocks(workflow.slice(workflow.indexOf("\n  promote:")));
  const steps = Object.fromEntries(["backup", "promotion", "live_check", "rollback", "manual_restore", "manual_restore_check", "evidence_rollback"]
    .map(name => [name, {outcome: "success", outputs: {ready: "true", rollback_allowed: "true", attempted: "true"}}]));
  const context = {env: {LKC_OPERATION: "readiness", LKC_METADATA_ONLY: "true", LKC_EVIDENCE_POLICY: "source-provenance"}, steps};
  const forbidden = ["Set up Node", "Install locked automation dependencies", "Authenticate with the short-lived staging identity",
    "Discover the two allowlisted Hosting sites", "Set up Google Cloud CLI for read-only API verification",
    "Verify deployed upload APIs before any live Hosting change", "Back up both current live channels",
    "Promote the already-tested versions without rebuilding", "Restore both previous live versions on any failure",
    "Verify both live staging apps after rollback", "Remove temporary channels after a successful promotion",
    "Restore the exact pair from successful promotion evidence",
    "Validate limited review and no additional cost before cloud access",
    "Pin limited trial preview and previous live versions",
    "Validate limited evidence against fresh pinned API metadata",
    "Recheck limited trial capture and API revisions before live write",
    "Recheck unchanged APIs after the limited trial",
    "Restore the trial if durable promotion evidence failed",
    "Check both apps after evidence failure recovery"];
  for (const status of ["success", "failure", "cancelled"]) {
    const reached = blocks.filter(block => shouldRun(block, context, status)).map(block => block.name);
    for (const name of forbidden) assert(!reached.includes(name), `${status}: reached ${name}`);
    for (const name of ["Upload promotion and rollback evidence", "Publish promotion summary", "Enforce the final result"])
      assert(reached.includes(name), `${status}: always() step missing ${name}`);
    assert.equal(reached.includes("Collect only upload Function and referenced Build metadata"), status === "success");
  }
  const withoutMetadata = {env: {...context.env, LKC_METADATA_ONLY: "false"}, steps};
  for (const status of ["success", "failure", "cancelled"]) {
    const reached = blocks.filter(block => shouldRun(block, withoutMetadata, status)).map(block => block.name);
    assert(!reached.includes("Authenticate for limited metadata GETs"));
    assert(!reached.includes("Collect only upload Function and referenced Build metadata"));
    assert.equal(reached.includes("Stop source verification unless a no-fee path is established"), status === "success");
  }
});

test("failed prerequisite/auth/collection skips later default steps but retains always diagnostics", async () => {
  const blocks = stepBlocks(workflow.slice(workflow.indexOf("\n  promote:")));
  for (const failedName of ["Re-check source is still current main after approval",
    "Validate protected metadata-only scope before authentication", "Authenticate for limited metadata GETs",
    "Collect only upload Function and referenced Build metadata", null]) {
    let status = "success", collectionCalls = 0;
    const reached = [], io = transport(fixtures(), () => failedName === "Collect only upload Function and referenced Build metadata" ? {status: 403} : undefined);
    const context = {env: {LKC_OPERATION: "readiness", LKC_METADATA_ONLY: "true", LKC_EVIDENCE_POLICY: "source-provenance"}, steps: new Proxy({}, {
      get: () => ({outcome: "skipped", outputs: {}}),
    })};
    for (const block of blocks) {
      if (!shouldRun(block, context, status)) continue;
      reached.push(block.name);
      if (block.name === "Collect only upload Function and referenced Build metadata") {
        collectionCalls++;
        const result = await collect(io);
        if (result.status === "STOPPED") status = "failure";
      } else if (block.name === failedName) status = "failure";
    }
    assert.equal(collectionCalls, failedName === null || failedName === "Collect only upload Function and referenced Build metadata" ? 1 : 0);
    assert.equal(io.calls.length, failedName === null ? 3 : failedName === "Collect only upload Function and referenced Build metadata" ? 1 : 0);
    assert(reached.includes("Enforce the final result"));
    assert(reached.includes("Upload promotion and rollback evidence"));
    assert(!reached.includes("Discover the two allowlisted Hosting sites"));
    assert(!reached.includes("Verify deployed upload APIs before any live Hosting change"));
    assert(!reached.some(name => /Back up|Restore both|Promote the already|Remove temporary/u.test(name)));
  }
});

const shellCoverage = {skip: process.platform === "win32" ?
  "Required Linux CI verification pending: Windows Bash NtCreateDirectoryObject denied (0xC0000022); not retried" : false};

test("decision-only shell fixtures validate without invoking the denied Bash runtime", () => {
  const blocks = stepBlocks(workflow);
  const final = scriptedBody(blocks.find(block => block.name === "Enforce the final result"));
  for (const outcome of ["success", "failure", "skipped", "cancelled"]) {
    validateDecisionShell(final.replace(/\$\{\{\s*(steps\.[^}]+?)\s*\}\}/gu, (_, expression) =>
      expression.includes("outputs.rollback_allowed") ? "true" : outcome));
  }
  const guard = scriptedBody(blocks.find(block => block.name === "Require current main, canonical CI and exact scope"));
  validateDecisionShell(metadataDecisionPrefix(guard));
  assert.throws(() => validateDecisionShell("node scripts/automation/hosting-limited-pilot.mjs --guard-only"),
    /non-decision command/u,"the decision fixture must still reject Node execution");
});

test("actual final-result shell distinguishes metadata collection from readiness/publication across 24 cases", shellCoverage, () => {
  const script = scriptedBody(stepBlocks(workflow).find(block => block.name === "Enforce the final result"));
  for (const metadataOnly of [true, false]) for (const operation of ["readiness", "promote", "restore"])
    for (const outcome of ["success", "failure", "skipped", "cancelled"]) {
      const rendered = script.replace(/\$\{\{\s*(steps\.[^}]+?)\s*\}\}/gu, (_, expression) =>
        expression === "steps.promotion_evidence.outcome" ? "success" :
          expression.includes("outputs.rollback_allowed") ? "true" : outcome);
      assert(!rendered.includes("${{"));
      const result = runDecisionShell(rendered, operation, metadataOnly);
      if (metadataOnly) {
        const collected = operation === "readiness" && outcome === "success";
        assert.equal(result.status, collected ? 0 : 1);
        assert.equal(result.stdout.includes("HOSTING_METADATA_RESULT=METADATA_COLLECTED"), collected);
        assert(!/HOSTING_READINESS_RESULT=SUCCESS|HOSTING_PROMOTION_RESULT=SUCCESS|HOSTING_MANUAL_RESTORE_RESULT=SUCCESS/u.test(result.stdout));
      } else {
        assert(!result.stdout.includes("HOSTING_METADATA_RESULT="));
        assert.equal(result.status, outcome === "success" ? 0 : 1);
      }
    }
});

test("failed durable evidence never reports metadata-only success", shellCoverage, () => {
  const script = scriptedBody(stepBlocks(workflow).find(block => block.name === "Enforce the final result"));
  for (const operation of ["readiness", "promote", "restore"]) {
    const rendered = script.replace(/\$\{\{\s*(steps\.[^}]+?)\s*\}\}/gu, (_, expression) =>
      expression === "steps.promotion_evidence.outcome" ? "failure" :
        expression.includes("outputs.rollback_allowed") ? "true" : "success");
    const result = runDecisionShell(rendered, operation, true);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /HOSTING_EVIDENCE_RESULT=FAILED/u);
    assert.doesNotMatch(result.stdout, /METADATA_COLLECTED|HOSTING_READINESS_RESULT=SUCCESS|HOSTING_PROMOTION_RESULT=SUCCESS/u);
  }
});

test("actual guard shell rejects metadata-only with promote/restore before authentication across six cases", shellCoverage, () => {
  const script = scriptedBody(stepBlocks(workflow).find(block => block.name === "Require current main, canonical CI and exact scope"));
  const prefix = metadataDecisionPrefix(script);
  for (const metadataOnly of [true, false]) for (const operation of ["readiness", "promote", "restore"]) {
    const result = runDecisionShell(prefix, operation, metadataOnly);
    assert.equal(result.status, metadataOnly && operation !== "readiness" ? 1 : 0);
  }
});
