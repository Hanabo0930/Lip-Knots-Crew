import assert from "node:assert/strict";
import {after, beforeEach, test} from "node:test";
import {mkdtemp, mkdir, readFile, rm, stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {collectPilotMetadata, normalizePilotFunction, PILOT_FUNCTIONS, PILOT_FUNCTION_FIELDS,
  pilotMetadataMain} from "./collect-hosting-pilot-metadata.mjs";

const PROJECT = "lip-knots-crew-staging", REGION = "asia-northeast1";
const PREFIX = `projects/${PROJECT}/locations/${REGION}`;
const TOKEN = "SYNTHETIC_ONLY_METADATA_TOKEN";
const publicEnv = {GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Hanabo0930/Lip-Knots-Crew",
  GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main", GITHUB_JOB: "promote",
  GITHUB_WORKFLOW_REF: "Hanabo0930/Lip-Knots-Crew/.github/workflows/staging-hosting-promote.yml@refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "1",
  LKC_PROJECT_ID: PROJECT, LKC_REGION: REGION, LKC_OPERATION: "promote",
  LKC_CONFIRMATION: "PROMOTE_LKC_STAGING_HOSTING", LKC_EVIDENCE_POLICY: "limited-staff-pilot",
  LKC_METADATA_ONLY: "false", LKC_SOURCE_SHA: "a".repeat(40)};
const oldEnv = Object.fromEntries(Object.keys(publicEnv).map(key => [key, process.env[key]]));
beforeEach(() => Object.assign(process.env, publicEnv));
after(() => {for (const [key, value] of Object.entries(oldEnv)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}});

function fixture(name) {
  return {name: `${PREFIX}/functions/${name}`, environment: "GEN_2", state: "ACTIVE",
    updateTime: "2026-10-20T01:02:03.123456Z",
    buildConfig: {build: `${PREFIX}/builds/90834a05-b919-42a1-b963-bd8e07d13213`, runtime: "nodejs22", entryPoint: name},
    serviceConfig: {service: `${PREFIX}/services/${name.toLowerCase()}`, revision: `${name.toLowerCase()}-00001-abc`,
      allTrafficOnLatestRevision: true}};
}
function transport(change = document => document) {
  const calls = [];
  return {calls, request: async (url, options) => {
    calls.push({url, options});
    const name = new URL(url).pathname.split("/").at(-1);
    return Response.json(change(fixture(name), name));
  }};
}
function collect(io = transport()) {
  return collectPilotMetadata({accessToken: TOKEN}, {...io, now: () => "2026-10-20T02:00:00Z"});
}

test("exact seven API metadata GETs never invoke APIs, follow builds, or claim source/UI compatibility", async () => {
  const io = transport(), result = await collect(io);
  assert.equal(result.status, "METADATA_COLLECTED");
  assert.equal(result.policy, "limited-staff-pilot");
  assert.equal(result.sourceSha, publicEnv.LKC_SOURCE_SHA);
  assert.deepEqual(result.observation, {runId: "12345", runAttempt: 1, capturedAt: "2026-10-20T02:00:00Z"});
  assert.deepEqual(Object.keys(result.functions), PILOT_FUNCTIONS);
  assert.equal(result.sourceAuthenticity, "UNVERIFIED");
  assert.equal(result.submissionAcceptance, "UNVERIFIED");
  assert.equal(result.hostingPromotionAuthorized, false);
  assert.equal(result.apiCompatibilityVerified, false);
  assert.equal(io.calls.length, 7);
  for (const [index, {url, options}] of io.calls.entries()) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://cloudfunctions.googleapis.com");
    assert.equal(parsed.pathname, `/v2/${PREFIX}/functions/${PILOT_FUNCTIONS[index]}`);
    assert.equal(parsed.searchParams.get("fields"), PILOT_FUNCTION_FIELDS);
    assert.deepEqual([...parsed.searchParams.keys()], ["fields"]);
    assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store"); assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.body, undefined);
    assert(!/source|secret|environmentVariables|iam/iu.test(PILOT_FUNCTION_FIELDS));
  }
  assert(!JSON.stringify(result).includes(TOKEN));
});

test("normalization requires active nodejs22 exact scoped identity, build, revision and traffic", () => {
  const fields = [
    ["name", "projects/other/locations/asia-northeast1/functions/bootstrapSession"],
    ["environment", "GEN_1"], ["state", "DEPLOYING"], ["updateTime", ""],
    ["buildConfig.runtime", "nodejs20"], ["buildConfig.entryPoint", "getMyTasks"],
    ["buildConfig.build", "projects/other/locations/asia-northeast1/builds/90834a05-b919-42a1-b963-bd8e07d13213"],
    ["buildConfig.build", "projects/lip-knots-crew-staging/locations/us-central1/builds/90834a05-b919-42a1-b963-bd8e07d13213"],
    ["serviceConfig.service", `${PREFIX}/services/getmytasks`],
    ["serviceConfig.revision", "getmytasks-00001-abc"], ["serviceConfig.allTrafficOnLatestRevision", false],
  ];
  for (const [field, value] of fields) {
    const document = fixture("bootstrapSession"), parts = field.split(".");
    (parts.length === 1 ? document : document[parts[0]])[parts.at(-1)] = value;
    assert.throws(() => normalizePilotFunction(document, "bootstrapSession"), /^Error: PILOT_/u, field);
  }
  assert.throws(() => normalizePilotFunction(fixture("createUploadSession"), "createUploadSession"), /SCOPE_REJECTED/u);
  const document = fixture("bootstrapSession");
  document.buildConfig.build = document.buildConfig.build.replace(PROJECT, "740154137290");
  assert.equal(normalizePilotFunction(document, "bootstrapSession").build, document.buildConfig.build);
});

test("missing required metadata stops, with no inferred API readiness", async () => {
  for (const field of ["name", "environment", "state", "updateTime", "buildConfig", "serviceConfig"]) {
    const io = transport(document => {delete document[field]; return document;});
    const result = await collect(io);
    assert.equal(result.status, "STOPPED"); assert.equal(result.reason, "PILOT_METADATA_FIELDS_REJECTED");
    assert.equal(io.calls.length, 1); assert.deepEqual(result.functions, {});
  }
});

test("unexpected private fields and source metadata are rejected before retaining the document", async () => {
  for (const field of ["environmentVariables", "secretEnvironmentVariables", "sourceProvenance", "sourceToken"]) {
    const io = transport(document => {document.buildConfig[field] = "SYNTHETIC_PRIVATE_VALUE"; return document;});
    const result = await collect(io);
    assert.equal(result.reason, "PILOT_METADATA_FIELDS_REJECTED");
    assert(!JSON.stringify(result).includes("SYNTHETIC_PRIVATE_VALUE"));
    assert.deepEqual(result.functions, {});
  }
});

test("denial, redirect and HTTP failure stop immediately without retries", async () => {
  for (const status of [401, 403, 302, 404, 429, 500]) {
    let calls = 0;
    const result = await collect({request: async () => {calls++; return {status};}});
    assert.equal(calls, 1);
    assert.equal(result.reason, [401, 403].includes(status) ? "PILOT_METADATA_ACCESS_DENIED" : "PILOT_METADATA_HTTP_FAILED");
  }
  const result = await collect({request: async () => ({status: 200, redirected: true})});
  assert.equal(result.reason, "PILOT_METADATA_HTTP_FAILED");
});

test("invalid JSON, content type and oversized bodies cannot be persisted as observations", async () => {
  const cases = [
    [new Response("bad", {headers: {"content-type": "application/json"}}), "PILOT_METADATA_TRANSPORT_OR_INPUT_FAILED"],
    [new Response("private"), "PILOT_METADATA_CONTENT_TYPE_REJECTED"],
    [Response.json({value: "x".repeat(65536)}), "PILOT_METADATA_RESPONSE_TOO_LARGE"],
  ];
  for (const [response, reason] of cases) {
    const result = await collect({request: async () => response});
    assert.equal(result.status, "STOPPED"); assert.equal(result.reason, reason);
    assert.deepEqual(result.functions, {});
  }
});

test("transport failures and reflected tokens are sanitized", async () => {
  const result = await collect({request: async () => {throw Error(TOKEN);}});
  assert.equal(result.reason, "PILOT_METADATA_TRANSPORT_OR_INPUT_FAILED");
  assert(!JSON.stringify(result).includes(TOKEN));
  const reflected = await collect(transport(document => ({...document, updateTime: TOKEN})));
  assert.equal(reflected.reason, "PILOT_METADATA_TOKEN_REFLECTION_REJECTED");
  assert(!JSON.stringify(reflected).includes(TOKEN));
});

test("guard rejects wrong protected scope, automatic dispatch, reruns and unrelated policies before any request", async () => {
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: "false", GITHUB_REPOSITORY: "other/repository", GITHUB_REF: "refs/heads/other",
    GITHUB_REF_NAME: "other", GITHUB_JOB: "other", GITHUB_WORKFLOW_REF: "other",
    GITHUB_EVENT_NAME: "workflow_run", GITHUB_RUN_ATTEMPT: "2", GITHUB_RUN_ID: "0",
    LKC_PROJECT_ID: "production", LKC_REGION: "us-central1", LKC_OPERATION: "restore",
    LKC_CONFIRMATION: "unexpected", LKC_EVIDENCE_POLICY: "source-provenance",
    LKC_METADATA_ONLY: "true", LKC_SOURCE_SHA: "a".repeat(39),
  })) {
    process.env[key] = value;
    let calls = 0;
    const result = await collect({request: async () => {calls++; assert.fail("GET reached");}});
    assert.equal(result.status, "STOPPED", key); assert.equal(calls, 0, key);
    process.env[key] = publicEnv[key];
  }
});

test("readiness context is allowed only with its existing exact confirmation", async () => {
  process.env.LKC_OPERATION = "readiness";
  assert.equal((await collect()).reason, "CONFIRMATION_REJECTED");
  process.env.LKC_CONFIRMATION = "CHECK_LKC_STAGING_HOSTING_READINESS";
  assert.equal((await collect()).status, "METADATA_COLLECTED");
});

test("guard-only requires no token and cannot reach a transport or save", async () => {
  const output = [];
  const code = await pilotMetadataMain({argv: ["--guard-only"], request: () => assert.fail("Transport reached"),
    save: () => assert.fail("Save reached"), emit: line => output.push(line)});
  assert.equal(code, 0); assert.deepEqual(output, ["HOSTING_PILOT_METADATA_CONTEXT=VALIDATED"]);
});

test("CLI removes token and records metadata only; never reports PASS or Hosting authorization", async () => {
  process.env.LKC_PILOT_METADATA_ACCESS_TOKEN = TOKEN;
  const output = [], results = [], io = transport();
  const code = await pilotMetadataMain({argv: [], request: io.request, save: result => results.push(result), emit: line => output.push(line)});
  assert.equal(code, 0); assert.equal(process.env.LKC_PILOT_METADATA_ACCESS_TOKEN, undefined);
  assert.equal(results.length, 1); assert(!JSON.stringify(results).includes(TOKEN));
  assert.deepEqual(output, ["HOSTING_PILOT_METADATA_RESULT=METADATA_COLLECTED", "HOSTING_PUBLICATION_AUTHORIZED=false"]);
});

test("CLI rejects unexpected arguments before any request", async () => {
  await assert.rejects(pilotMetadataMain({argv: ["--functions", "createUploadSession"],
    request: () => assert.fail("Transport reached"), save: () => assert.fail("Save reached")}),
  /PILOT_METADATA_ARGUMENTS_REJECTED/u);
});

test("post-promotion snapshot uses a separate fixed evidence filename", async () => {
  process.env.LKC_PILOT_METADATA_ACCESS_TOKEN = TOKEN;
  const saved = [];
  const code = await pilotMetadataMain({argv: ["--after"], request: transport().request,
    save: (result, phase) => saved.push({result, phase}), emit: () => {}});
  assert.equal(code, 0); assert.equal(saved.length, 1); assert.equal(saved[0].phase, "after");
  assert.equal(saved[0].result.status, "METADATA_COLLECTED");
});

test("initial, before-write and after snapshots use distinct exclusive files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lkc-pilot-metadata-"));
  const priorRoot = process.env.RUNNER_TEMP, priorEvidence = process.env.LKC_EVIDENCE_DIR;
  try {
    process.env.RUNNER_TEMP = root;
    process.env.LKC_EVIDENCE_DIR = path.join(root, "hosting-promote-evidence");
    await mkdir(process.env.LKC_EVIDENCE_DIR);
    for (const [flag, filename] of [
      [null, "pilot-metadata.json"], ["--before-write", "pilot-metadata-before-write.json"],
      ["--after", "pilot-metadata-after.json"],
    ]) {
      const args = {argv: flag ? [flag] : [], request: transport().request, emit: () => {}};
      process.env.LKC_PILOT_METADATA_ACCESS_TOKEN = TOKEN;
      assert.equal(await pilotMetadataMain(args), 0);
      const file = path.join(process.env.LKC_EVIDENCE_DIR, filename);
      const saved = await readFile(file, "utf8");
      assert.equal(JSON.parse(saved).status, "METADATA_COLLECTED");
      if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
      process.env.LKC_PILOT_METADATA_ACCESS_TOKEN = TOKEN;
      await assert.rejects(pilotMetadataMain(args), {code: "EEXIST"});
      assert.equal(await readFile(file, "utf8"), saved, "Snapshot must never be overwritten");
    }
  } finally {
    if (priorRoot === undefined) delete process.env.RUNNER_TEMP; else process.env.RUNNER_TEMP = priorRoot;
    if (priorEvidence === undefined) delete process.env.LKC_EVIDENCE_DIR; else process.env.LKC_EVIDENCE_DIR = priorEvidence;
    await rm(root, {recursive: true, force: true});
  }
});
