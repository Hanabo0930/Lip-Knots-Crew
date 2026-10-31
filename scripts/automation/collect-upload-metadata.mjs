/** Observation only. Uses the existing protected promote job; never authorizes release. */
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {requireProtectedContext, validateHostingOperation} from "./restore-staging-hosting.mjs";

const PROJECT = "lip-knots-crew-staging";
const REGION = "asia-northeast1";
const PROJECT_IDS = new Set([PROJECT, "740154137290"]);
const FUNCTIONS = ["createUploadSession", "finalizeStagedUpload"];
const PREFIX = `projects/${PROJECT}/locations/${REGION}`;
const MAX_BYTES = 512 * 1024;
export const FIXED_SOURCE_LIMITS = Object.freeze({archiveBytes: 10 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024, gets: 12});
export const OBJECT_FIELDS = "bucket,name,generation,metageneration,size,storageClass,md5Hash,crc32c,contentEncoding,customerEncryption,kmsKeyName";
const SOURCE_BUCKET = "gcf-v2-sources-740154137290-asia-northeast1";
export const FUNCTION_FIELDS = "name,environment,state,updateTime,buildConfig(build,runtime,entryPoint,sourceProvenance(resolvedStorageSource(bucket,object,generation))),serviceConfig(service,revision,allTrafficOnLatestRevision)";
export const BUILD_FIELDS = "name,id,projectId,status,createTime,startTime,finishTime,sourceProvenance(resolvedStorageSource(bucket,object,generation),fileHashes),results(images(digest))";
class MetadataError extends Error {}
const requireValue = (condition, code) => {if (!condition) throw new MetadataError(code);};
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function validateMetadataContext() {
  requireProtectedContext(); // Existing exact repository/ref/job/workflow_ref checks.
  validateHostingOperation({operation: process.env.LKC_OPERATION,
    eventName: process.env.GITHUB_EVENT_NAME, confirmation: process.env.LKC_CONFIRMATION,
    projectId: process.env.LKC_PROJECT_ID, region: process.env.LKC_REGION,
    sourceRef: process.env.GITHUB_REF_NAME, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT)});
  requireValue(process.env.LKC_OPERATION === "readiness" && process.env.LKC_METADATA_ONLY === "true",
    "METADATA_READINESS_ONLY");
  requireValue(/^[a-f0-9]{40}$/u.test(process.env.LKC_SOURCE_SHA ?? ""), "SOURCE_SHA_REJECTED");
  requireValue(/^[1-9][0-9]{0,19}$/u.test(process.env.GITHUB_RUN_ID ?? ""), "RUN_ID_REJECTED");
}

function onlyKeys(value, keys) {
  requireValue(plain(value) && Object.keys(value).every(key => keys.includes(key)), "RESPONSE_FIELDS_REJECTED");
}
function textFields(value, keys, max = 2048) {
  for (const key of keys) if (Object.hasOwn(value, key)) {
    requireValue(typeof value[key] === "string" && value[key].length <= max && !/[\u0000-\u001f]/u.test(value[key]),
      "RESPONSE_VALUE_REJECTED");
  }
}
function storageSource(provenance, allowHashes = false) {
  onlyKeys(provenance, allowHashes ? ["resolvedStorageSource", "fileHashes"] : ["resolvedStorageSource"]);
  if (Object.hasOwn(provenance, "resolvedStorageSource")) {
    const fixed = provenance.resolvedStorageSource;
    onlyKeys(fixed, ["bucket", "object", "generation"]);
    textFields(fixed, ["bucket", "object"]);
    if (Object.hasOwn(fixed, "generation")) requireValue(
      (typeof fixed.generation === "string" && fixed.generation.length <= 32) ||
      (Number.isSafeInteger(fixed.generation) && fixed.generation >= 0), "RESPONSE_VALUE_REJECTED");
  }
}

function validateFunction(document, functionName) {
  onlyKeys(document, ["name", "environment", "state", "updateTime", "buildConfig", "serviceConfig"]);
  requireValue(document.name === `${PREFIX}/functions/${functionName}`, "FUNCTION_SCOPE_MISMATCH");
  textFields(document, ["name", "environment", "state", "updateTime"]);
  if (Object.hasOwn(document, "buildConfig")) {
    onlyKeys(document.buildConfig, ["build", "runtime", "entryPoint", "sourceProvenance"]);
    textFields(document.buildConfig, ["build", "runtime", "entryPoint"]);
    if (Object.hasOwn(document.buildConfig, "sourceProvenance")) storageSource(document.buildConfig.sourceProvenance);
  }
  if (Object.hasOwn(document, "serviceConfig")) {
    onlyKeys(document.serviceConfig, ["service", "revision", "allTrafficOnLatestRevision"]);
    textFields(document.serviceConfig, ["service", "revision"]);
    if (Object.hasOwn(document.serviceConfig, "allTrafficOnLatestRevision"))
      requireValue(typeof document.serviceConfig.allTrafficOnLatestRevision === "boolean", "RESPONSE_VALUE_REJECTED");
  }
  return document;
}

function buildScope(name) {
  const match = typeof name === "string" && /^projects\/([^/]+)\/locations\/([^/]+)\/builds\/([A-Za-z0-9-]+)$/u.exec(name);
  requireValue(match && PROJECT_IDS.has(match[1]) && match[2] === REGION, "BUILD_SCOPE_MISMATCH");
  return match[3];
}

function validateBuild(document, name) {
  onlyKeys(document, ["name", "id", "projectId", "status", "createTime", "startTime", "finishTime", "sourceProvenance", "results"]);
  requireValue(document.id === buildScope(name) && PROJECT_IDS.has(document.projectId)
    && (!Object.hasOwn(document, "name") || document.name === name), "BUILD_IDENTITY_MISMATCH");
  textFields(document, ["name", "id", "projectId", "status", "createTime", "startTime", "finishTime"]);
  if (Object.hasOwn(document, "sourceProvenance")) {
    storageSource(document.sourceProvenance, true);
    if (Object.hasOwn(document.sourceProvenance, "fileHashes")) {
      const hashes = document.sourceProvenance.fileHashes;
      requireValue(plain(hashes) && Object.keys(hashes).length <= 1000, "RESPONSE_VALUE_REJECTED");
      // Observe hash map keys; do not presume a gs:// key shape before real evidence.
      for (const [key, value] of Object.entries(hashes)) {
        requireValue(key.length <= 2048 && !/[\u0000-\u001f]/u.test(key), "RESPONSE_VALUE_REJECTED");
        onlyKeys(value, ["fileHash"]);
        requireValue(Array.isArray(value.fileHash) && value.fileHash.length <= 16, "RESPONSE_VALUE_REJECTED");
        for (const item of value.fileHash) {
          onlyKeys(item, ["type", "value"]);
          textFields(item, ["type", "value"], 256);
        }
      }
    }
  }
  if (Object.hasOwn(document, "results")) {
    onlyKeys(document.results, ["images"]);
    if (Object.hasOwn(document.results, "images")) {
      requireValue(Array.isArray(document.results.images) && document.results.images.length <= 100, "RESPONSE_VALUE_REJECTED");
      for (const item of document.results.images) {onlyKeys(item, ["digest"]); textFields(item, ["digest"], 256);}
    }
  }
  return document;
}

async function limitedJson(response) {
  requireValue(response.headers.get("content-type")?.toLowerCase().includes("application/json"), "METADATA_CONTENT_TYPE_REJECTED");
  requireValue(response.body && typeof response.body.getReader === "function", "METADATA_BODY_REQUIRED");
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      requireValue(size <= MAX_BYTES, "METADATA_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}

function safeError(error) {
  const message = error instanceof Error ? error.message : "";
  const guardCodes = ["PROTECTED_WORKFLOW_CONTEXT_REQUIRED", "ENVIRONMENT_REJECTED", "OPERATION_REJECTED",
    "TRIGGER_REJECTED", "MANUAL_OPERATION_REQUIRED", "CONFIRMATION_REJECTED", "WORKFLOW_RERUN_REJECTED"];
  return error instanceof MetadataError || guardCodes.includes(message) ? message : "METADATA_TRANSPORT_OR_INPUT_FAILED";
}

export async function collectUploadMetadata({accessToken}, {request = globalThis.fetch, now = () => new Date().toISOString()} = {}) {
  const result = {schemaVersion: 1, status: "STOPPED", operation: "metadata-only",
    projectId: PROJECT, region: REGION, readinessStatus: "NOT_EVALUATED", hostingPromotionAuthorized: false,
    deploymentBindingVerified: false, archive: {status: "NOT_PROVIDED", checked: false, downloaded: false},
    functions: {}, builds: {}, requests: [], findings: []};
  try {
    validateMetadataContext();
    requireValue(typeof accessToken === "string" && accessToken.length > 0 && !/[\r\n]/u.test(accessToken), "METADATA_ACCESS_TOKEN_REQUIRED");
    result.sourceSha = process.env.LKC_SOURCE_SHA;
    result.observation = {workflowRef: process.env.GITHUB_WORKFLOW_REF, job: "promote",
      runId: process.env.GITHUB_RUN_ID, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), capturedAt: now()};
    const get = async (kind, name) => {
      const isFunction = kind === "function";
      if (isFunction) requireValue(FUNCTIONS.some(f => name === `${PREFIX}/functions/${f}`), "FUNCTION_SCOPE_MISMATCH");
      else {requireValue(kind === "build", "METADATA_KIND_REJECTED"); buildScope(name);}
      const url = new URL(isFunction ? `https://cloudfunctions.googleapis.com/v2/${name}` : `https://cloudbuild.googleapis.com/v1/${name}`);
      url.searchParams.set("fields", isFunction ? FUNCTION_FIELDS : BUILD_FIELDS);
      const record = {method: "GET", url: url.href};
      result.requests.push(record);
      const response = await request(url.href, {method: "GET", redirect: "error", cache: "no-store",
        headers: {Authorization: `Bearer ${accessToken}`, Accept: "application/json"}, signal: AbortSignal.timeout(15000)});
      record.status = response.status;
      requireValue(response.status !== 401 && response.status !== 403, "METADATA_ACCESS_DENIED");
      requireValue(response.status === 200 && !response.redirected, "METADATA_HTTP_FAILED");
      const document = await limitedJson(response);
      requireValue(!JSON.stringify(document).includes(accessToken), "METADATA_TOKEN_REFLECTION_REJECTED");
      return document;
    };
    for (const f of FUNCTIONS) {
      const document = validateFunction(await get("function", `${PREFIX}/functions/${f}`), f);
      result.functions[f] = document;
      for (const [field, actual, expected] of [
        ["state", document.state, "ACTIVE"], ["environment", document.environment, "GEN_2"],
        ["runtime", document.buildConfig?.runtime, "nodejs22"], ["entryPoint", document.buildConfig?.entryPoint, f],
        ["latestTraffic", document.serviceConfig?.allTrafficOnLatestRevision, true]]) {
        if (actual !== expected) result.findings.push({resource: f, field, code: actual === undefined ? "MISSING" : "UNEXPECTED"});
      }
      if (!document.buildConfig?.sourceProvenance?.resolvedStorageSource)
        result.findings.push({resource: f, field: "resolvedStorageSource", code: "MISSING"});
      else for (const field of ["bucket", "object", "generation"]) {
        if (!Object.hasOwn(document.buildConfig.sourceProvenance.resolvedStorageSource, field))
          result.findings.push({resource: f, field: `resolvedStorageSource.${field}`, code: "MISSING"});
      }
      for (const field of ["service", "revision"]) if (!document.serviceConfig?.[field])
        result.findings.push({resource: f, field, code: "MISSING"});
    }
    const names = new Set();
    // Validate ALL references before making any Build request, including the second Function.
    for (const f of FUNCTIONS) {
      const name = result.functions[f].buildConfig?.build;
      if (name === undefined || name === "") {result.findings.push({resource: f, field: "build", code: "MISSING"}); continue;}
      buildScope(name);
      names.add(name);
    }
    for (const name of names) {
      const document = validateBuild(await get("build", name), name);
      result.builds[name] = document;
      if (document.status !== "SUCCESS") result.findings.push({resource: name, field: "status", code: "UNEXPECTED"});
      const hashes = document.sourceProvenance?.fileHashes;
      if (!hashes || Object.keys(hashes).length === 0) result.findings.push({resource: name, field: "fileHashes", code: "MISSING"});
      else if (!Object.values(hashes).some(item => item.fileHash.some(hash => hash.type === "SHA256")))
        result.findings.push({resource: name, field: "SHA256", code: "MISSING"});
      else if (Object.values(hashes).some(item => item.fileHash.some(hash => hash.type === "SHA256" &&
        (typeof hash.value !== "string" || !/^[A-Za-z0-9+/]{43}=$/u.test(hash.value) || Buffer.from(hash.value, "base64").length !== 32))))
        result.findings.push({resource: name, field: "SHA256", code: "MALFORMED"});
    }
    result.status = "METADATA_COLLECTED";
  } catch (error) {result.reason = safeError(error);}
  return result;
}

// Dormant, offline-reviewed acquisition primitive. There is deliberately NO CLI
// or workflow entry to this method. A trusted caller must supply the transport.
// It returns private bytes, never readiness PASS or a retained-evidence pin.
export function validateFixedSourceContext() {
  requireProtectedContext();
  validateHostingOperation({operation: process.env.LKC_OPERATION,
    eventName: process.env.GITHUB_EVENT_NAME, confirmation: process.env.LKC_CONFIRMATION,
    projectId: process.env.LKC_PROJECT_ID, region: process.env.LKC_REGION,
    sourceRef: process.env.GITHUB_REF_NAME, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT)});
  requireValue(process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
    && process.env.GITHUB_RUN_ATTEMPT === "1"
    && process.env.LKC_OPERATION === "readiness" && process.env.LKC_METADATA_ONLY === "false"
    && process.env.LKC_EVIDENCE_POLICY === "source-provenance"
    && process.env.LKC_SOURCE_ACQUISITION === "fixed-source-once"
    && process.env.LKC_SOURCE_ACQUISITION_CONFIRMATION === "ACQUIRE_LKC_STAGING_FIXED_SOURCE_ONCE_20MIB",
  "FIXED_SOURCE_EXPLICIT_REVIEW_REQUIRED");
  requireValue(/^[a-f0-9]{40}$/u.test(process.env.LKC_SOURCE_SHA ?? "")
    && process.env.GITHUB_SHA === process.env.LKC_SOURCE_SHA
    && /^[1-9][0-9]{0,19}$/u.test(process.env.GITHUB_RUN_ID ?? ""), "FIXED_SOURCE_CONTEXT_REJECTED");
}

function fixedTime(value) {
  requireValue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value)), "FIXED_SOURCE_TIME_REJECTED");
  requireValue(new Date(value).toISOString().slice(0, 19) === value.slice(0, 19), "FIXED_SOURCE_TIME_REJECTED");
  return Date.parse(value);
}

function fixedFunction(document, name, observed) {
  validateFunction(document, name);
  requireValue(document.environment === "GEN_2" && document.state === "ACTIVE"
    && document.buildConfig?.runtime === "nodejs22" && document.buildConfig.entryPoint === name
    && document.serviceConfig?.service === `${PREFIX}/services/${name.toLowerCase()}`
    && new RegExp(`^${name.toLowerCase()}-[0-9]+-[a-z0-9]+$`, "u").test(document.serviceConfig.revision)
    && document.serviceConfig.allTrafficOnLatestRevision === true, "FIXED_SOURCE_FUNCTION_NOT_READY");
  requireValue(fixedTime(document.updateTime) <= observed, "FIXED_SOURCE_TIME_REJECTED");
  const build = document.buildConfig.build;
  requireValue(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(buildScope(build)), "FIXED_SOURCE_BUILD_REJECTED");
  const source = document.buildConfig.sourceProvenance?.resolvedStorageSource;
  requireValue(source?.bucket === SOURCE_BUCKET && source.object === `${name}/function-source.zip`
    && typeof source.generation === "string" && /^[1-9][0-9]{0,31}$/u.test(source.generation),
  "FIXED_SOURCE_OBJECT_REJECTED");
  return source;
}

function canonicalHash(value, bytes) {
  requireValue(typeof value === "string" && Buffer.from(value, "base64").length === bytes
    && Buffer.from(value, "base64").toString("base64") === value, "FIXED_SOURCE_HASH_REJECTED");
  return value;
}

function fixedBuild(document, name, sources, observed) {
  validateBuild(document, name);
  requireValue(document.status === "SUCCESS" && fixedTime(document.createTime) <= fixedTime(document.startTime)
    && fixedTime(document.startTime) <= fixedTime(document.finishTime)
    && fixedTime(document.finishTime) <= observed, "FIXED_SOURCE_BUILD_REJECTED");
  const provenance = document.sourceProvenance;
  // A missing Build hash is allowed ONLY in this unprivileged collection method.
  // Present provenance must still agree; it cannot be silently discarded.
  if (provenance?.resolvedStorageSource) requireValue(sources.every(source =>
    isDeepStrictEqual(source, provenance.resolvedStorageSource)), "FIXED_SOURCE_BUILD_GENERATION_MISMATCH");
  if (provenance?.fileHashes) {
    const uris = new Set(sources.flatMap(source => {
      const uri = `gs://${source.bucket}/${source.object}`;
      return [uri, `${uri}#${source.generation}`];
    }));
    for (const [uri, hashes] of Object.entries(provenance.fileHashes)) {
      requireValue(uris.has(uri) && hashes.fileHash.length > 0 && hashes.fileHash.length <= 3,
        "FIXED_SOURCE_BUILD_HASH_SCOPE_REJECTED");
      const seen = new Set();
      for (const item of hashes.fileHash) {
        requireValue(["MD5", "SHA256", "SHA512"].includes(item.type) && !seen.has(item.type), "FIXED_SOURCE_HASH_REJECTED");
        seen.add(item.type); canonicalHash(item.value, {MD5: 16, SHA256: 32, SHA512: 64}[item.type]);
      }
    }
  }
}

function objectMetadata(document, source) {
  onlyKeys(document, OBJECT_FIELDS.split(","));
  requireValue(document.bucket === source.bucket && document.name === source.object
    && document.generation === source.generation, "FIXED_SOURCE_OBJECT_IDENTITY_MISMATCH");
  requireValue(document.storageClass === "STANDARD" && !Object.hasOwn(document, "contentEncoding")
    && !Object.hasOwn(document, "customerEncryption") && !Object.hasOwn(document, "kmsKeyName"),
  "FIXED_SOURCE_STORAGE_CONDITIONS_REJECTED");
  requireValue(typeof document.size === "string" && /^[1-9][0-9]{0,7}$/u.test(document.size)
    && Number(document.size) <= FIXED_SOURCE_LIMITS.archiveBytes, "FIXED_SOURCE_SIZE_REJECTED");
  requireValue(typeof document.metageneration === "string" && /^[1-9][0-9]{0,31}$/u.test(document.metageneration),
    "FIXED_SOURCE_OBJECT_IDENTITY_MISMATCH");
  canonicalHash(document.crc32c, 4);
  if (Object.hasOwn(document, "md5Hash")) canonicalHash(document.md5Hash, 16);
  return Number(document.size);
}

const crc32cTable = Array.from({length: 256}, (_, initial) => {
  let value = initial;
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0x82f63b78 : 0);
  return value >>> 0;
});
function crc32c(blob) {
  let value = 0xffffffff;
  for (const byte of blob) value = (value >>> 8) ^ crc32cTable[(value ^ byte) & 255];
  const raw = Buffer.alloc(4); raw.writeUInt32BE((value ^ 0xffffffff) >>> 0);
  return raw.toString("base64");
}

async function cancelUnread(response) {
  try {await response.body?.cancel();} catch {} // Cancel without reading/logging an error body.
}

async function fixedBody(response, metadata, source, token, received) {
  let reader;
  const chunks = [];
  let size = 0, complete = false;
  try {
    const encoding = response.headers.get("content-encoding");
    requireValue(!encoding || encoding === "identity", "FIXED_SOURCE_CONTENT_ENCODING_REJECTED");
    for (const [header, expected] of [["content-length", metadata.size], ["x-goog-generation", source.generation]]) {
      const actual = response.headers.get(header);
      requireValue(actual === null || actual === expected, "FIXED_SOURCE_TRANSPORT_IDENTITY_MISMATCH");
    }
    requireValue(response.body && typeof response.body.getReader === "function", "FIXED_SOURCE_BODY_REQUIRED");
    reader = response.body.getReader();
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      received(value.length);
      requireValue(size <= Number(metadata.size) && size <= FIXED_SOURCE_LIMITS.archiveBytes,
        "FIXED_SOURCE_BODY_TOO_LARGE");
      chunks.push(Buffer.from(value));
    }
    requireValue(size === Number(metadata.size), "FIXED_SOURCE_BODY_SIZE_MISMATCH");
    const blob = Buffer.concat(chunks);
    try {
      requireValue(crc32c(blob) === metadata.crc32c && (!metadata.md5Hash
        || createHash("md5").update(blob).digest("base64") === metadata.md5Hash), "FIXED_SOURCE_BODY_HASH_MISMATCH");
      requireValue(!blob.includes(Buffer.from(token)), "METADATA_TOKEN_REFLECTION_REJECTED");
      complete = true;
      return blob;
    } finally {if (!complete) blob.fill(0);}
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    if (reader) {await reader.cancel().catch(() => {}); reader.releaseLock();}
    else await cancelUnread(response);
  }
}

export async function collectFixedUploadSources({accessToken}, {request, now = () => new Date().toISOString()} = {}) {
  const diagnostics = {status: "STOPPED", method: "authenticated-fixed-generation", requests: 0,
    bytesDownloaded: 0, deployedSourceVerified: false, hostingPromotionAuthorized: false};
  const archives = new Map();
  try {
    validateFixedSourceContext();
    // No implicit live transport; the existing metadata CLI cannot reach here.
    requireValue(typeof request === "function", "FIXED_SOURCE_TRANSPORT_NOT_WIRED");
    requireValue(typeof accessToken === "string" && accessToken.length > 0 && !/[\r\n]/u.test(accessToken), "METADATA_ACCESS_TOKEN_REQUIRED");
    const capturedAt = now(), started = fixedTime(capturedAt);
    const checkTime = () => {
      const checked = fixedTime(now());
      requireValue(started <= checked && checked - started < 10 * 60 * 1000, "FIXED_SOURCE_CAPTURE_EXPIRED");
      return checked;
    };
    const get = async (url, json = true) => {
      checkTime();
      requireValue(++diagnostics.requests <= FIXED_SOURCE_LIMITS.gets, "FIXED_SOURCE_REQUEST_LIMIT");
      const response = await request(url.href, {method: "GET", redirect: "error", cache: "no-store",
        headers: {Authorization: `Bearer ${accessToken}`, Accept: json ? "application/json" : "application/octet-stream",
          "Accept-Encoding": "identity"}, signal: AbortSignal.timeout(15000)});
      try {
        requireValue(![401, 403].includes(response.status), "METADATA_ACCESS_DENIED");
        requireValue(response.status === 200 && !response.redirected && (!response.url || response.url === url.href), "METADATA_HTTP_FAILED");
      } catch (error) {await cancelUnread(response); throw error;}
      if (!json) return response;
      try {
        const document = await limitedJson(response);
        requireValue(!JSON.stringify(document).includes(accessToken), "METADATA_TOKEN_REFLECTION_REJECTED");
        return document;
      } catch (error) {await cancelUnread(response); throw error;}
    };
    const readFunction = name => {
      const url = new URL(`https://cloudfunctions.googleapis.com/v2/${PREFIX}/functions/${name}`);
      url.searchParams.set("fields", FUNCTION_FIELDS); return get(url);
    };
    const readBuild = name => {
      buildScope(name);
      const url = new URL(`https://cloudbuild.googleapis.com/v1/${name}`);
      url.searchParams.set("fields", BUILD_FIELDS); return get(url);
    };
    const objectUrl = (source, media = false) => {
      const url = new URL(`https://storage.googleapis.com/storage/v1/b/${SOURCE_BUCKET}/o/${encodeURIComponent(source.object)}`);
      url.searchParams.set("generation", source.generation);
      url.searchParams.set("ifGenerationMatch", source.generation);
      url.searchParams.set(media ? "alt" : "fields", media ? "media" : OBJECT_FIELDS);
      return url;
    };
    const before = {}, sources = {}, builds = {}, objects = {};
    for (const name of FUNCTIONS) {
      const document = await readFunction(name);
      sources[name] = fixedFunction(document, name, checkTime()); before[name] = document;
    }
    const references = [...new Set(FUNCTIONS.map(name => before[name].buildConfig.build))];
    for (const ref of references) {
      const document = await readBuild(ref);
      fixedBuild(document, ref, FUNCTIONS.filter(name => before[name].buildConfig.build === ref).map(name => sources[name]), checkTime());
      builds[ref] = document;
    }
    let total = 0;
    // Validate BOTH object sizes and storage conditions before the first body.
    for (const name of FUNCTIONS) {
      const document = await get(objectUrl(sources[name]));
      total += objectMetadata(document, sources[name]); objects[name] = document;
    }
    requireValue(total <= FIXED_SOURCE_LIMITS.totalBytes, "FIXED_SOURCE_TOTAL_TOO_LARGE");
    for (const name of FUNCTIONS) {
      const blob = await fixedBody(await get(objectUrl(sources[name], true), false), objects[name], sources[name], accessToken,
        bytes => {diagnostics.bytesDownloaded += bytes;});
      archives.set(name, blob);
      const provenance = builds[before[name].buildConfig.build].sourceProvenance;
      const uri = `gs://${SOURCE_BUCKET}/${sources[name].object}`;
      for (const [key, hashes] of Object.entries(provenance?.fileHashes ?? {})) if ([uri, `${uri}#${sources[name].generation}`].includes(key)) {
        for (const hash of hashes.fileHash) requireValue(createHash(hash.type.toLowerCase()).update(blob).digest("base64") === hash.value,
          "FIXED_SOURCE_BUILD_HASH_MISMATCH");
      }
    }
    const after = {}, afterBuilds = {};
    for (const name of FUNCTIONS) {
      const document = await readFunction(name); fixedFunction(document, name, checkTime());
      requireValue(isDeepStrictEqual(document, before[name]), "FIXED_SOURCE_DEPLOYMENT_CHANGED"); after[name] = document;
    }
    for (const ref of references) {
      const document = await readBuild(ref);
      requireValue(isDeepStrictEqual(document, builds[ref]), "FIXED_SOURCE_BUILD_CHANGED"); afterBuilds[ref] = document;
    }
    const endsAt = now(); checkTime();
    diagnostics.status = "FIXED_SOURCE_COLLECTED";
    return Object.defineProperty({diagnostics}, "privateCapture", {value: {sourceSha: process.env.LKC_SOURCE_SHA,
      runId: process.env.GITHUB_RUN_ID, capturedAt, endsAt, before, builds, objects, after, afterBuilds, archives}});
  } catch (error) {
    for (const blob of archives.values()) blob.fill(0);
    diagnostics.reason = safeError(error);
    return {diagnostics};
  }
}

export async function metadataMain({argv = process.argv.slice(2), request, save = async result => {
  const target = path.resolve(process.env.LKC_EVIDENCE_DIR ?? "");
  const expected = path.resolve(process.env.RUNNER_TEMP ?? "", "hosting-promote-evidence");
  requireValue(path.isAbsolute(process.env.RUNNER_TEMP ?? "") && target === expected, "EVIDENCE_DIRECTORY_REJECTED");
  await mkdir(target, {recursive: true});
  await writeFile(path.join(target, "upload-metadata.json"), JSON.stringify(result, null, 2) + "\n", {mode: 0o600, flag: "wx"});
}, emit = text => console.log(text)} = {}) {
  requireValue(argv.length === 0 || (argv.length === 1 && argv[0] === "--guard-only"), "METADATA_ARGUMENTS_REJECTED");
  validateMetadataContext();
  if (argv[0] === "--guard-only") {emit("HOSTING_METADATA_CONTEXT=VALIDATED"); return 0;}
  const accessToken = process.env.LKC_METADATA_ACCESS_TOKEN;
  delete process.env.LKC_METADATA_ACCESS_TOKEN;
  const result = await collectUploadMetadata({accessToken}, {request});
  await save(result);
  emit("HOSTING_METADATA_RESULT=" + result.status);
  emit("HOSTING_PUBLICATION_AUTHORIZED=false");
  return result.status === "METADATA_COLLECTED" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  metadataMain().then(code => {process.exitCode = code;}).catch(error => {
    console.error("HOSTING_METADATA_RESULT=STOPPED");
    console.error("HOSTING_METADATA_ERROR=" + safeError(error));
    process.exitCode = 1;
  });
}
