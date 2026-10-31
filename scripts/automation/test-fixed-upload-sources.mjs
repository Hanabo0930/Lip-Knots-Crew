import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {inspect} from "node:util";
import {collectFixedUploadSources, FIXED_SOURCE_LIMITS, OBJECT_FIELDS, FUNCTION_FIELDS, BUILD_FIELDS} from "./collect-upload-metadata.mjs";

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

test("fixed collector: never selects live fetch implicitly and existing CLI/workflow stays disconnected", () => isolated(async () => {
  assert.equal((await collectFixedUploadSources({accessToken: TOKEN})).diagnostics.reason, "FIXED_SOURCE_TRANSPORT_NOT_WIRED");
  const workflow = readFileSync(new URL("../../.github/workflows/staging-hosting-promote.yml", import.meta.url), "utf8");
  assert(!/collectFixedUploadSources|fixed-source-once|ACQUIRE_LKC_STAGING_FIXED_SOURCE_ONCE_20MIB/u.test(workflow));
  const source = readFileSync(new URL("./collect-upload-metadata.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("export async function metadataMain"));
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
