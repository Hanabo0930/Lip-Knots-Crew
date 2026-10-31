import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {inspect} from "node:util";
import {mkdtemp, readFile, writeFile, readdir, rm, chmod, symlink, link, mkdir, lstat} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createHmac} from "node:crypto";
import {collectFixedUploadSources, fixedSourceMain, FIXED_SOURCE_LIMITS, OBJECT_FIELDS, FUNCTION_FIELDS, BUILD_FIELDS} from "./collect-upload-metadata.mjs";

const PROJECT = "lip-knots-crew-staging", PREFIX = `projects/${PROJECT}/locations/asia-northeast1`;
const BUCKET = "gcf-v2-sources-740154137290-asia-northeast1";
const NAMES = ["createUploadSession", "finalizeStagedUpload"];
const BUILD = `${PREFIX}/builds/11111111-1111-1111-1111-111111111111`;
const SECOND = `${PREFIX}/builds/22222222-2222-2222-2222-222222222222`;
const TOKEN = "SYNTHETIC_FIXED_SOURCE_TOKEN_PRIVATE";
const NOW = "2026-10-30T00:05:00Z";
const ENV = {GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Hanabo0930/Lip-Knots-Crew",
  GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main", GITHUB_JOB: "promote",
  GITHUB_WORKFLOW_REF: "Hanabo0930/Lip-Knots-Crew/.github/workflows/staging-hosting-promote.yml@refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1", GITHUB_RUN_ID: "12345",
  GITHUB_SHA: "a".repeat(40), LKC_SOURCE_SHA: "a".repeat(40), LKC_PROJECT_ID: PROJECT,
  LKC_REGION: "asia-northeast1", LKC_OPERATION: "readiness", LKC_METADATA_ONLY: "false",
  LKC_CONFIRMATION: "CHECK_LKC_STAGING_HOSTING_READINESS", LKC_EVIDENCE_POLICY: "source-provenance",
  LKC_SOURCE_ACQUISITION: "fixed-source-once",
  LKC_SOURCE_ACQUISITION_CONFIRMATION: "ACQUIRE_LKC_STAGING_FIXED_SOURCE_ONCE_20MIB"};

async function isolated(callback) {
  const before = Object.fromEntries(Object.keys(ENV).map(key => [key, process.env[key]]));
  const fetchBefore = globalThis.fetch;
  Object.assign(process.env, ENV);
  globalThis.fetch = () => assert.fail("LIVE_NETWORK_FORBIDDEN");
  try {return await callback();} finally {
    globalThis.fetch = fetchBefore;
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function fixtures(distinct = false) {
  const functions = Object.fromEntries(NAMES.map((name, i) => [name, {
    name: `${PREFIX}/functions/${name}`, environment: "GEN_2", state: "ACTIVE", updateTime: "2026-10-30T00:00:00Z",
    buildConfig: {build: distinct && i ? SECOND : BUILD, runtime: "nodejs22", entryPoint: name,
      sourceProvenance: {resolvedStorageSource: {bucket: BUCKET, object: `${name}/function-source.zip`, generation: String(123 + i)}}},
    serviceConfig: {service: `${PREFIX}/services/${name.toLowerCase()}`,
      revision: `${name.toLowerCase()}-00001-abc`, allTrafficOnLatestRevision: true}}]));
  const builds = Object.fromEntries((distinct ? [BUILD, SECOND] : [BUILD]).map(name => [name, {
    name, id: name.split("/").at(-1), projectId: PROJECT, status: "SUCCESS",
    createTime: "2026-10-29T23:50:00Z", startTime: "2026-10-29T23:51:00Z", finishTime: "2026-10-29T23:52:00Z",
    sourceProvenance: {}, results: {}}]));
  // Known CRC32C test vector, not real source. ZIP validation is separate.
  const bytes = Buffer.from("123456789");
  const objects = Object.fromEntries(NAMES.map((name, i) => [name, {bucket: BUCKET, name: `${name}/function-source.zip`,
    generation: String(123 + i), metageneration: "1", size: "9", storageClass: "STANDARD",
    crc32c: "4waSgw==", md5Hash: createHash("md5").update(bytes).digest("base64")} ]));
  return {functions, builds, objects, bytes};
}

function transport(data = fixtures(), change) {
  const calls = [];
  return {calls, now: () => NOW, request: async (raw, options) => {
    const url = new URL(raw), call = {url, options}; calls.push(call);
    assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store"); assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.headers["Accept-Encoding"], "identity");
    assert.equal(url.protocol, "https:"); assert.equal(url.username, ""); assert.equal(url.password, "");
    assert(!url.searchParams.has("userProject")); assert(!Object.keys(options.headers).some(key => /user-project|billing/iu.test(key)));
    let document, name, kind;
    if (url.hostname === "cloudfunctions.googleapis.com") {
      kind = "function"; name = url.pathname.split("/").at(-1);
      assert(NAMES.includes(name)); assert.equal(url.pathname, `/v2/${PREFIX}/functions/${name}`);
      assert.equal(url.searchParams.get("fields"), FUNCTION_FIELDS); document = structuredClone(data.functions[name]);
    } else if (url.hostname === "cloudbuild.googleapis.com") {
      kind = "build"; name = url.pathname.slice(4);
      assert(Object.hasOwn(data.builds, name)); assert.equal(url.searchParams.get("fields"), BUILD_FIELDS);
      document = structuredClone(data.builds[name]);
    } else {
      assert.equal(url.hostname, "storage.googleapis.com");
      name = NAMES.find(item => url.pathname.endsWith(encodeURIComponent(`${item}/function-source.zip`)));
      assert(name); assert.equal(url.pathname, `/storage/v1/b/${BUCKET}/o/${encodeURIComponent(`${name}/function-source.zip`)}`);
      assert.equal(url.searchParams.get("generation"), data.functions[name].buildConfig.sourceProvenance.resolvedStorageSource.generation);
      assert.equal(url.searchParams.get("ifGenerationMatch"), url.searchParams.get("generation"));
      kind = url.searchParams.get("alt") === "media" ? "media" : "object";
      if (kind === "object") {assert.equal(url.searchParams.get("fields"), OBJECT_FIELDS); document = structuredClone(data.objects[name]);}
      else assert.deepEqual([...url.searchParams.keys()], ["generation", "ifGenerationMatch", "alt"]);
    }
    const override = change?.({kind, name, document, calls, url});
    if (override) return override;
    return kind === "media" ? new Response(data.bytes, {headers: {"content-length": String(data.bytes.length),
      "x-goog-generation": data.objects[name].generation}}) : new Response(JSON.stringify(document), {headers: {"content-type": "application/json"}});
  }};
}
const collect = io => collectFixedUploadSources({accessToken: TOKEN}, io);

test("fixed collector: official hosts, fixed generations, ten/twelve GETs and no promotion authority", () => isolated(async () => {
  for (const distinct of [false, true]) {
    const data = fixtures(distinct), io = transport(data), result = await collect(io);
    assert.equal(result.diagnostics.status, "FIXED_SOURCE_COLLECTED");
    assert.equal(io.calls.length, distinct ? 12 : 10);
    assert.equal(result.diagnostics.bytesDownloaded, 18);
    assert.equal(result.diagnostics.deployedSourceVerified, false); assert.equal(result.diagnostics.hostingPromotionAuthorized, false);
    assert.deepEqual([...result.privateCapture.archives.values()], [data.bytes, data.bytes]);
    assert(!JSON.stringify(result.diagnostics).includes(TOKEN));
    assert(!Object.hasOwn(result.diagnostics, "evidenceDigest"));
    assert.deepEqual(Object.keys(result), ["diagnostics"]);
    assert(!inspect(result).includes("privateCapture"));
  }
}));

test("fixed collector: primitive never selects live fetch implicitly; metadata CLI remains separate", () => isolated(async () => {
  assert.equal((await collectFixedUploadSources({accessToken: TOKEN})).diagnostics.reason, "FIXED_SOURCE_TRANSPORT_NOT_WIRED");
  const source = readFileSync(new URL("./collect-upload-metadata.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("export async function metadataMain"), source.indexOf("if (process.argv[1]"));
  assert(!/collectFixedUploadSources/u.test(main));
}));

test("fixed collector: explicit manual scope and exact current source required before any GET", () => isolated(async () => {
  for (const [key, value] of Object.entries({GITHUB_EVENT_NAME: "workflow_run", GITHUB_RUN_ATTEMPT: "2",
    GITHUB_JOB: "other", GITHUB_REF: "refs/heads/other", GITHUB_SHA: "b".repeat(40), LKC_PROJECT_ID: "other",
    LKC_REGION: "global", LKC_METADATA_ONLY: "true", LKC_EVIDENCE_POLICY: "limited-staff-pilot",
    LKC_OPERATION: "promote", LKC_SOURCE_ACQUISITION: "", LKC_SOURCE_ACQUISITION_CONFIRMATION: ""})) {
    process.env[key] = value;
    const io = transport(), result = await collect(io);
    assert.equal(result.diagnostics.status, "STOPPED", key); assert.equal(io.calls.length, 0, key);
    process.env[key] = ENV[key];
  }
}));

test("fixed collector: wrong Function/project/runtime/traffic/source stops before Storage", () => isolated(async () => {
  for (const mutate of [
    d => {d.name = `${PREFIX}/functions/other`;}, d => {d.state = "FAILED";}, d => {d.buildConfig.runtime = "nodejs20";},
    d => {d.serviceConfig.allTrafficOnLatestRevision = false;}, d => {d.serviceConfig.revision = "other-00001-abc";},
    d => {d.buildConfig.build = "projects/foreign/locations/asia-northeast1/builds/x";},
    d => {d.buildConfig.sourceProvenance.resolvedStorageSource.bucket = "foreign";},
    d => {d.buildConfig.sourceProvenance.resolvedStorageSource.object = "other/function-source.zip";},
    d => {d.buildConfig.sourceProvenance.resolvedStorageSource.generation = "01";},
    d => {d.buildConfig.sourceProvenance.resolvedStorageSource.generation = 123;},
    d => {d.updateTime = "2099-01-01T00:00:00Z";},
  ]) {
    const data = fixtures(); mutate(data.functions.createUploadSession);
    const io = transport(data), result = await collect(io);
    assert.equal(result.diagnostics.status, "STOPPED"); assert.equal(io.calls.length, 1);
    assert(!result.privateCapture);
  }
}));

test("fixed collector: existing Build provenance/hash cannot be discarded when contradictory", () => isolated(async () => {
  for (const mutate of [
    d => {d.status = "FAILURE";}, d => {d.finishTime = "2099-01-01T00:00:00Z";},
    d => {d.sourceProvenance.resolvedStorageSource = {bucket: BUCKET, object: "other/source.zip", generation: "1"};},
    d => {d.sourceProvenance.fileHashes = {foreign: {fileHash: [{type: "SHA256", value: "AA=="}]}};},
    d => {d.sourceProvenance.fileHashes = {[`gs://${BUCKET}/createUploadSession/function-source.zip`]: {fileHash: [{type: "SHA256", value: "AA=="}]}};},
  ]) {
    const data = fixtures(); mutate(data.builds[BUILD]); const io = transport(data), result = await collect(io);
    assert.equal(result.diagnostics.status, "STOPPED"); assert.equal(io.calls.length, 3);
  }
}));

test("fixed collector: validate both object sizes/classes before downloading any body", () => isolated(async () => {
  for (const [key, value] of [["size", String(FIXED_SOURCE_LIMITS.archiveBytes + 1)], ["size", "0"], ["size", "09"],
    ["storageClass", "NEARLINE"], ["storageClass", ""], ["contentEncoding", "gzip"], ["customerEncryption", {}],
    ["kmsKeyName", "synthetic"], ["generation", "999"], ["bucket", "foreign"], ["name", "other.zip"], ["crc32c", "bad"]]) {
    const data = fixtures(); data.objects.finalizeStagedUpload[key] = value;
    const io = transport(data), result = await collect(io);
    assert.equal(result.diagnostics.status, "STOPPED", key); assert.equal(io.calls.length, 5, key);
    assert(io.calls.every(call => call.url.searchParams.get("alt") !== "media"));
  }
}));

test("fixed collector: 403/requester-pays/redirect/transport failure never retries or reads error bodies", () => isolated(async () => {
  for (const response of [{status: 403}, {status: 400}, {status: 302}, {status: 200, redirected: true},
    {status: 200, url: "https://foreign.example/redirect"}]) {
    const io = transport(fixtures(), ({kind}) => kind === "object" ? {...response,
      get body() {assert.fail("ERROR_BODY_READ");}} : undefined);
    const result = await collect(io); assert.equal(result.diagnostics.status, "STOPPED");
    assert.equal(io.calls.length, 4); assert(!result.privateCapture);
  }
  const result = await collect({request: async () => {throw Error(TOKEN);}, now: () => NOW});
  assert.equal(result.diagnostics.reason, "METADATA_TRANSPORT_OR_INPUT_FAILED"); assert(!JSON.stringify(result).includes(TOKEN));
}));

test("fixed collector: streamed sizes, encoding, generation and Storage checksums are enforced", () => isolated(async () => {
  const variants = [
    () => new Response("123456789X"), () => new Response("123"), () => new Response("987654321"),
    () => new Response("123456789", {headers: {"content-encoding": "gzip"}}),
    () => new Response("123456789", {headers: {"content-length": "10"}}),
    () => new Response("123456789", {headers: {"x-goog-generation": "999"}}),
  ];
  for (const response of variants) {
    const io = transport(fixtures(), ({kind}) => kind === "media" ? response() : undefined), result = await collect(io);
    assert.equal(result.diagnostics.status, "STOPPED"); assert.equal(io.calls.length, 6); assert(!result.privateCapture);
  }
}));

test("fixed collector: present Build digest checked against actual body", () => isolated(async () => {
  const data = fixtures(true), uri = `gs://${BUCKET}/createUploadSession/function-source.zip#123`;
  data.builds[BUILD].sourceProvenance.fileHashes = {[uri]: {fileHash: [{type: "SHA256", value: Buffer.alloc(32).toString("base64")}]}};
  const io = transport(data), result = await collect(io);
  assert.equal(result.diagnostics.reason, "FIXED_SOURCE_BUILD_HASH_MISMATCH"); assert.equal(io.calls.length, 7);
  assert(!result.privateCapture);
}));

test("fixed collector: Function or Build change after acquisition invalidates all private output", () => isolated(async () => {
  for (const kind of ["function", "build"]) {
    const seen = new Map();
    const io = transport(fixtures(), ({kind: actual, name, document}) => {
      const key = `${actual}:${name}`, count = (seen.get(key) ?? 0) + 1; seen.set(key, count);
      if (actual === kind && count === 2) {
        if (kind === "function") document.serviceConfig.revision = `${name.toLowerCase()}-00002-abc`;
        else document.results = {images: [{digest: "sha256:" + "a".repeat(64)}]};
        return new Response(JSON.stringify(document), {headers: {"content-type": "application/json"}});
      }
    });
    const result = await collect(io); assert.equal(result.diagnostics.status, "STOPPED"); assert(!result.privateCapture);
    assert.equal(io.calls.length, kind === "function" ? 8 : 10);
  }
}));

test("fixed collector: acquisition deadline checked before next HTTP and token reflection rejected", () => isolated(async () => {
  const io = transport(); let ticks = 0;
  io.now = () => ++ticks > 4 ? "2026-10-30T00:15:01Z" : NOW;
  const result = await collect(io); assert.equal(result.diagnostics.reason, "FIXED_SOURCE_CAPTURE_EXPIRED");
  assert(io.calls.length < 3);
  const data = fixtures(); data.functions.createUploadSession.updateTime = TOKEN;
  const reflected = await collect(transport(data)); assert.equal(reflected.diagnostics.reason, "METADATA_TOKEN_REFLECTION_REJECTED");
  assert(!JSON.stringify(reflected).includes(TOKEN));
}));

test("fixed collector: every failure phase stops at that GET without retries or authority", () => isolated(async () => {
  for (let position = 1; position <= FIXED_SOURCE_LIMITS.gets; position++) for (const status of [401, 403, 429, 500]) {
    let cancelled = 0, read = 0;
    const io = transport(fixtures(true), ({calls}) => calls.length === position ? {status,
      body: {cancel: async () => {cancelled++;}, getReader: () => {read++; assert.fail("ERROR_BODY_READ");}}} : undefined);
    const result = await collect(io);
    assert.equal(result.diagnostics.status, "STOPPED"); assert.equal(io.calls.length, position);
    assert.equal(cancelled, 1); assert.equal(read, 0); assert(!result.privateCapture);
    assert.equal(result.diagnostics.hostingPromotionAuthorized, false);
  }
}));

test("fixed collector: exact two 10 MiB archives fit the 20 MiB acquisition boundary", () => isolated(async () => {
  const data = fixtures(true); data.bytes = Buffer.alloc(FIXED_SOURCE_LIMITS.archiveBytes);
  let crc = 0xffffffff;
  for (const byte of data.bytes) {crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);}
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  for (const object of Object.values(data.objects)) Object.assign(object, {size: String(data.bytes.length),
    crc32c: checksum.toString("base64"), md5Hash: createHash("md5").update(data.bytes).digest("base64")});
  const io = transport(data), result = await collect(io);
  assert.equal(result.diagnostics.status, "FIXED_SOURCE_COLLECTED");
  assert.equal(result.diagnostics.bytesDownloaded, FIXED_SOURCE_LIMITS.totalBytes);
  assert.equal(io.calls.length, FIXED_SOURCE_LIMITS.gets);
  for (const blob of result.privateCapture.archives.values()) blob.fill(0);
}));

test("fixed collector: rejected metadata/media headers cancel unread streams immediately", () => isolated(async () => {
  for (const kind of ["object", "media"]) {
    let cancelled = 0;
    const io = transport(fixtures(), ({kind: actual}) => actual === kind ? new Response(new ReadableStream({
      cancel() {cancelled++;},
    }), {headers: kind === "object" ? {"content-type": "text/html"} : {"content-encoding": "gzip"}}) : undefined);
    const result = await collect(io); assert.equal(result.diagnostics.status, "STOPPED"); assert.equal(cancelled, 1);
    assert.equal(io.calls.length, kind === "object" ? 4 : 6);
  }
  const io = transport(fixtures(), ({kind}) => kind === "media" ? new Response("123456789X") : undefined);
  const oversized = await collect(io); assert.equal(oversized.diagnostics.bytesDownloaded, 10);
}));

test("fixed collector: actual synthetic ZIP traverses collection and strict inventory validation offline", () => isolated(async () => {
  const fixture = spawnSync("python3", ["-c", `import io,zipfile,json,hashlib,base64
files={"package.json":b'{"main":"lib/index.js"}',"lib/index.js":b"exports.synthetic=1;", "lib/uploads.js":b"exports.synthetic=1;", "lib/uploads.js.map":b'{"version":3}',"src/uploads.ts":b"export const synthetic=1;", "case-mail-runtime/synthetic.cjs":b"module.exports={};"}
out=io.BytesIO()
with zipfile.ZipFile(out,"w") as archive:
 for name,value in files.items(): archive.writestr(name,value)
print(json.dumps({"blob":base64.b64encode(out.getvalue()).decode(),"expected":{name:hashlib.sha256(value).hexdigest() for name,value in files.items()}}))`], {encoding: "utf8"});
  assert.equal(fixture.status, 0, fixture.stderr);
  const {blob, expected} = JSON.parse(fixture.stdout), bytes = Buffer.from(blob, "base64");
  let value = 0xffffffff;
  // Independent bit-at-a-time fixture checksum; collector uses a lookup table.
  for (const byte of bytes) {value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0x82f63b78 : 0);}
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((value ^ 0xffffffff) >>> 0);
  const data = fixtures(true); data.bytes = bytes;
  for (const object of Object.values(data.objects)) Object.assign(object, {size: String(bytes.length),
    md5Hash: createHash("md5").update(bytes).digest("base64"), crc32c: checksum.toString("base64")});
  for (const [index, ref] of [BUILD, SECOND].entries()) {
    const source = data.functions[NAMES[index]].buildConfig.sourceProvenance.resolvedStorageSource;
    data.builds[ref].sourceProvenance = {resolvedStorageSource: {...source}, fileHashes: {
      [`gs://${BUCKET}/${source.object}#${source.generation}`]: {fileHash: [{type: "SHA256", value: createHash("sha256").update(bytes).digest("base64")}]}}};
  }
  const result = await collect(transport(data)); assert.equal(result.diagnostics.status, "FIXED_SOURCE_COLLECTED");
  const checked = spawnSync("python3", ["-c", `import sys,json,base64,importlib.util,socket
socket.create_connection=lambda *args: (_ for _ in ()).throw(AssertionError("NETWORK_FORBIDDEN"))
spec=importlib.util.spec_from_file_location("readiness","scripts/automation/check-hosting-api-readiness.py")
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
data=json.load(sys.stdin)
for blob in data["archives"]: module.verify_archive(base64.b64decode(blob),data["expected"],strict=True)
print("STRICT_SYNTHETIC_ARCHIVES=2")`], {encoding: "utf8", input: JSON.stringify({expected,
    archives: [...result.privateCapture.archives.values()].map(bytes => bytes.toString("base64"))})});
  assert.equal(checked.status, 0, checked.stderr); assert.match(checked.stdout, /STRICT_SYNTHETIC_ARCHIVES=2/u);
  assert.equal(result.diagnostics.hostingPromotionAuthorized, false);
  assert(!JSON.stringify(result).includes(blob));
}));

async function privateFixture(callback) {
  return isolated(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "lkc-fixed-test-"));
    const values = Object.fromEntries(["RUNNER_TEMP", "LKC_EVIDENCE_DIR", "LKC_FIXED_SOURCE_ACCESS_TOKEN"].map(name => [name, process.env[name]]));
    process.env.RUNNER_TEMP = temporary;
    process.env.LKC_EVIDENCE_DIR = path.join(temporary, "hosting-promote-evidence");
    const directory = path.join(temporary, "hosting-fixed-source-evidence"), output = [];
    const run = (flag, io = {}) => fixedSourceMain({argv: [flag], now: () => NOW, emit: text => output.push(text), ...io});
    try {return await callback({temporary, directory, output, run});} finally {
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      await rm(temporary, {recursive: true, force: true});
    }
  });
}

test("fixed CLI: protected plan, one acquisition, private signed capture and public summary", () => privateFixture(async ({directory, output, run}) => {
  const io = transport(fixtures(true));
  assert.equal(await run("--fixed-source-guard"), 0); assert.equal(io.calls.length, 0);
  assert.deepEqual((await readdir(directory)).sort(), ["collector.key", "plan.hmac", "plan.json"]);
  const planBytes = await readFile(path.join(directory, "plan.json")), plan = JSON.parse(planBytes), key = await readFile(path.join(directory, "collector.key"));
  assert.equal(key.length, 32); assert.equal(plan.createdAt, NOW); assert.equal(plan.runId, ENV.GITHUB_RUN_ID);
  assert.equal(await readFile(path.join(directory, "plan.hmac"), "ascii"), createHmac("sha256", key).update(planBytes).digest("hex"));
  process.env.LKC_FIXED_SOURCE_ACCESS_TOKEN = TOKEN;
  assert.equal(await run("--collect-fixed-source", io), 0); assert.equal(io.calls.length, 12);
  assert.equal(process.env.LKC_FIXED_SOURCE_ACCESS_TOKEN, undefined);
  const captureBytes = await readFile(path.join(directory, "capture.json")), capture = JSON.parse(captureBytes);
  assert.equal(capture.method, "authenticated-fixed-generation"); assert.equal(capture.requestCount, 12);
  assert.equal(capture.bytesDownloaded, 18); assert.equal(capture.expiresAt, "2026-10-30T00:15:00.000Z");
  assert.equal(capture.archives.createUploadSession.size, 9);
  assert.equal(capture.archives.createUploadSession.sha256, createHash("sha256").update("123456789").digest("hex"));
  assert.equal(await readFile(path.join(directory, "capture.hmac"), "ascii"), createHmac("sha256", key).update(captureBytes).digest("hex"));
  assert.equal(JSON.parse(await readFile(path.join(directory, "attempt.json"))).startedAt, NOW);
  for (const file of await readdir(directory)) assert.equal((await lstat(path.join(directory, file))).mode & 0o777, 0o600);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  const summary = JSON.parse(await readFile(path.join(process.env.LKC_EVIDENCE_DIR, "fixed-source-collection.json")));
  assert.equal(summary.status, "FIXED_SOURCE_COLLECTED"); assert.equal(summary.hostingPromotionAuthorized, false);
  assert.equal(summary.deployedSourceVerified, false); assert(!JSON.stringify(summary).includes(TOKEN));
  assert(!Object.hasOwn(summary, "archives")); assert(!Object.hasOwn(summary, "before"));
  assert.deepEqual(await readdir(process.env.LKC_EVIDENCE_DIR), ["fixed-source-collection.json"]);
  assert(output.includes("HOSTING_PUBLICATION_AUTHORIZED=false")); assert(!output.some(value => value.includes(TOKEN)));
  key.fill(0);
}));

test("fixed CLI: matching promote confirmation is explicitly supported; automatic/default acquisition is rejected", () => privateFixture(async ({run}) => {
  process.env.LKC_OPERATION = "promote"; process.env.LKC_CONFIRMATION = "PROMOTE_LKC_STAGING_HOSTING";
  assert.equal(await run("--fixed-source-guard"), 0);
  for (const [name, value] of [["GITHUB_EVENT_NAME", "workflow_run"], ["GITHUB_RUN_ATTEMPT", "2"],
    ["LKC_SOURCE_ACQUISITION", "retained"], ["LKC_SOURCE_ACQUISITION_CONFIRMATION", ""]]) {
    const previous = process.env[name]; process.env[name] = value;
    let calls = 0; assert.equal(await run("--collect-fixed-source", {request: async () => {calls++; assert.fail("NETWORK_FORBIDDEN");}}), 1);
    assert.equal(calls, 0); process.env[name] = previous;
  }
}));

test("fixed CLI: duplicate guard/attempt and cleanup cannot reset the one-shot latch", () => privateFixture(async ({directory, run, output}) => {
  const io = transport(); assert.equal(await run("--fixed-source-guard"), 0);
  assert.equal(await run("--fixed-source-guard"), 1);
  process.env.LKC_FIXED_SOURCE_ACCESS_TOKEN = TOKEN; assert.equal(await run("--collect-fixed-source", io), 0);
  const count = io.calls.length;
  process.env.LKC_FIXED_SOURCE_ACCESS_TOKEN = TOKEN; assert.equal(await run("--collect-fixed-source", io), 1);
  assert.equal(io.calls.length, count); assert(output.includes("HOSTING_FIXED_SOURCE_ERROR=FIXED_SOURCE_ATTEMPT_ALREADY_EXISTS"));
  assert.equal(await run("--cleanup-fixed-source"), 0); assert.deepEqual(await readdir(directory), []);
  assert.equal(await run("--cleanup-fixed-source"), 0);
  assert.equal(await run("--fixed-source-guard"), 1);
  process.env.LKC_FIXED_SOURCE_ACCESS_TOKEN = TOKEN; assert.equal(await run("--collect-fixed-source", io), 1);
  assert.equal(io.calls.length, count);
}));

test("fixed CLI: changed key, mismatched plan or stale plan stops before any HTTP", () => privateFixture(async ({directory, run, output}) => {
  assert.equal(await run("--fixed-source-guard"), 0);
  const keyPath = path.join(directory, "collector.key"), planPath = path.join(directory, "plan.json");
  const key = await readFile(keyPath), planBytes = await readFile(planPath), signature = await readFile(path.join(directory, "plan.hmac"));
  let calls = 0; const io = {request: async () => {calls++; assert.fail("NETWORK_FORBIDDEN");}};
  const binarySignature = Buffer.from(signature); binarySignature[0] |= 0x80;
  await writeFile(path.join(directory, "plan.hmac"), binarySignature);
  process.env.LKC_FIXED_SOURCE_ACCESS_TOKEN = TOKEN;
  assert.equal(await run("--collect-fixed-source", io), 1); assert.equal(calls, 0);
  assert(output.includes("HOSTING_FIXED_SOURCE_ERROR=FIXED_SOURCE_PLAN_SIGNATURE_REJECTED"));
  await writeFile(path.join(directory, "plan.hmac"), signature);
  await writeFile(keyPath, Buffer.alloc(32)); process.env.LKC_FIXED_SOURCE_ACCESS_TOKEN = TOKEN;
  assert.equal(await run("--collect-fixed-source", io), 1); assert.equal(calls, 0);
  assert(output.includes("HOSTING_FIXED_SOURCE_ERROR=FIXED_SOURCE_PLAN_SIGNATURE_REJECTED"));
  await writeFile(keyPath, key);
  const plan = JSON.parse(planBytes); plan.sourceSha = "b".repeat(40);
  const changed = Buffer.from(JSON.stringify(plan));
  await writeFile(planPath, changed); await writeFile(path.join(directory, "plan.hmac"), createHmac("sha256", key).update(changed).digest("hex"));
  assert.equal(await run("--collect-fixed-source", io), 1); assert.equal(calls, 0);
  assert(output.includes("HOSTING_FIXED_SOURCE_ERROR=FIXED_SOURCE_PLAN_REJECTED"));
  await writeFile(planPath, planBytes); await writeFile(path.join(directory, "plan.hmac"), signature);
  assert.equal(await run("--collect-fixed-source", {...io, now: () => "2026-10-30T00:35:00Z"}), 1); assert.equal(calls, 0);
  assert(output.includes("HOSTING_FIXED_SOURCE_ERROR=FIXED_SOURCE_PLAN_EXPIRED"));
  assert(!await readdir(directory).then(names => names.includes("attempt.json")));
  key.fill(0);
}));

test("fixed CLI: symlinked directory/files, hardlinks, weak permissions and extra files are refused", () => privateFixture(async ({temporary, directory, run}) => {
  const outside = path.join(temporary, "outside"); await mkdir(outside, {mode: 0o700});
  await symlink(outside, directory, "dir"); assert.equal(await run("--fixed-source-guard"), 1);
  await rm(directory); assert.equal(await run("--fixed-source-guard"), 0);
  const keyPath = path.join(directory, "collector.key"), key = await readFile(keyPath);
  await rm(keyPath); await writeFile(path.join(outside, "key"), key, {mode: 0o600}); await symlink(path.join(outside, "key"), keyPath);
  let calls = 0; const io = {request: async () => {calls++; assert.fail("NETWORK_FORBIDDEN");}};
  assert.equal(await run("--collect-fixed-source", io), 1); assert.equal(calls, 0);
  await rm(keyPath); await link(path.join(outside, "key"), keyPath);
  assert.equal(await run("--collect-fixed-source", io), 1); assert.equal(calls, 0);
  await rm(keyPath); await writeFile(keyPath, key, {mode: 0o600}); await chmod(keyPath, 0o644);
  assert.equal(await run("--collect-fixed-source", io), 1); assert.equal(calls, 0);
  await chmod(keyPath, 0o600); await writeFile(path.join(directory, "unknown"), "synthetic", {mode: 0o600});
  assert.equal(await run("--collect-fixed-source", io), 1); assert.equal(calls, 0);
  assert.equal(await run("--cleanup-fixed-source"), 1);
  assert.deepEqual(await readFile(path.join(outside, "key")), key); key.fill(0);
}));

test("fixed CLI: failed acquisition records its one attempt and no private capture or fallback", () => privateFixture(async ({directory, run, output}) => {
  assert.equal(await run("--fixed-source-guard"), 0); process.env.LKC_FIXED_SOURCE_ACCESS_TOKEN = TOKEN;
  const io = transport(fixtures(), () => ({status: 403, body: {cancel: async () => {}}}));
  assert.equal(await run("--collect-fixed-source", io), 1); assert.equal(io.calls.length, 1);
  const names = await readdir(directory); assert(names.includes("attempt.json")); assert(!names.includes("capture.json"));
  const summary = JSON.parse(await readFile(path.join(process.env.LKC_EVIDENCE_DIR, "fixed-source-collection.json")));
  assert.equal(summary.reason, "METADATA_ACCESS_DENIED"); assert.equal(summary.requests, 1);
  process.env.LKC_FIXED_SOURCE_ACCESS_TOKEN = TOKEN;
  assert.equal(await run("--collect-fixed-source", io), 1); assert.equal(io.calls.length, 1);
  assert(!output.some(value => value.includes(TOKEN))); assert.equal(process.env.LKC_FIXED_SOURCE_ACCESS_TOKEN, undefined);
  assert.equal(await run("--cleanup-fixed-source"), 0); assert.deepEqual(await readdir(directory), []);
}));

test("fixed CLI: signed synthetic acquisition reaches strict Python verification and same-run mutation receipt", () => privateFixture(async ({temporary, directory, run}) => {
  const sourceRoot = path.join(temporary, "source"), files = {
    "package.json": '{"main":"lib/index.js"}', "lib/index.js": "exports.synthetic=1;", "lib/uploads.js": "exports.synthetic=1;",
    "lib/uploads.js.map": '{"version":3}', "src/uploads.ts": "export const synthetic=1;", "case-mail-runtime/synthetic.cjs": "module.exports={};"};
  for (const [name, bytes] of Object.entries(files)) {
    const target = path.join(sourceRoot, "functions", name); await mkdir(path.dirname(target), {recursive: true}); await writeFile(target, bytes);
  }
  const release = path.join(sourceRoot, "apps/admin/src/case-mail-release.json");
  await mkdir(path.dirname(release), {recursive: true}); await writeFile(release, '{"enabled":false}');
  const packed = spawnSync("python3", ["-c", `import sys,json,io,zipfile,base64
files=json.load(sys.stdin);out=io.BytesIO()
with zipfile.ZipFile(out,"w",compression=zipfile.ZIP_DEFLATED) as archive:
 for name,value in files.items():archive.writestr(name,value.encode())
print(base64.b64encode(out.getvalue()).decode())`], {encoding: "utf8", input: JSON.stringify(files)});
  assert.equal(packed.status, 0, packed.stderr);
  const data = fixtures(true); data.bytes = Buffer.from(packed.stdout.trim(), "base64");
  let crc = 0xffffffff;
  for (const byte of data.bytes) {crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);}
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  for (const object of Object.values(data.objects)) Object.assign(object, {size: String(data.bytes.length),
    md5Hash: createHash("md5").update(data.bytes).digest("base64"), crc32c: checksum.toString("base64")});
  assert.equal(await run("--fixed-source-guard"), 0); process.env.LKC_FIXED_SOURCE_ACCESS_TOKEN = TOKEN;
  const io = transport(data); assert.equal(await run("--collect-fixed-source", io), 0);
  assert.equal(io.calls.length, 12); assert.equal(process.env.LKC_FIXED_SOURCE_ACCESS_TOKEN, undefined);
  const verified = spawnSync("python3", ["-c", `import sys,json,datetime,importlib.util,pathlib,socket,os
from unittest.mock import patch
socket.create_connection=lambda *args:(_ for _ in ()).throw(AssertionError("NETWORK_FORBIDDEN"))
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,"scripts/automation/"+file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
g=load("fixed_bridge_readiness","check-hosting-api-readiness.py");e=load("fixed_bridge_evidence","hosting_source_evidence.py")
root=pathlib.Path(sys.argv[1]);directory=pathlib.Path(sys.argv[2]);now=datetime.datetime.fromisoformat("2026-10-30T00:05:00+00:00")
with patch.object(g.subprocess,"check_output",return_value=os.environ["LKC_SOURCE_SHA"].encode()):
 result=e.verify_fixed_capture(root,os.environ["LKC_SOURCE_SHA"],directory,g,now=now)
 receipt=e.bind_fixed_acceptance(result,now=now)
 target=pathlib.Path(os.environ["LKC_EVIDENCE_DIR"])/"api-readiness.json";target.write_text(json.dumps(receipt));target.chmod(0o600)
 fresh=e.verify_fixed_capture(root,os.environ["LKC_SOURCE_SHA"],directory,g,now=now)
 current=e.require_current_fixed_acceptance(target,fresh,now=now)
assert current["evidenceMethod"]=="authenticated-fixed-generation" and current["runId"]==os.environ["GITHUB_RUN_ID"]
assert result["hostingPromotionAuthorized"] is False
print("SYNTHETIC_FIXED_SOURCE_TO_MUTATION_GUARD=PASS")`, sourceRoot, directory], {encoding: "utf8"});
  assert.equal(verified.status, 0, verified.stderr); assert.match(verified.stdout, /SYNTHETIC_FIXED_SOURCE_TO_MUTATION_GUARD=PASS/u);
  assert(!verified.stdout.includes(TOKEN));
}));

test("fixed CLI: partial source output without its attempt latch is never reacquired", () => privateFixture(async ({directory, run, output}) => {
  assert.equal(await run("--fixed-source-guard"), 0);
  await writeFile(path.join(directory, "createuploadsession.zip"), "synthetic partial", {mode: 0o600});
  let calls = 0; process.env.LKC_FIXED_SOURCE_ACCESS_TOKEN = TOKEN;
  assert.equal(await run("--collect-fixed-source", {request: async () => {calls++; assert.fail("NETWORK_FORBIDDEN");}}), 1);
  assert.equal(calls, 0); assert(output.includes("HOSTING_FIXED_SOURCE_ERROR=FIXED_SOURCE_ATTEMPT_STATE_REJECTED"));
}));
