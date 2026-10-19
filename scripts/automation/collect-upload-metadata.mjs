/** Observation only. Uses the existing protected promote job; never authorizes release. */
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {requireProtectedContext, validateHostingOperation} from "./restore-staging-hosting.mjs";

const PROJECT = "lip-knots-crew-staging";
const REGION = "asia-northeast1";
const PROJECT_IDS = new Set([PROJECT, "740154137290"]);
const FUNCTIONS = ["createUploadSession", "finalizeStagedUpload"];
const PREFIX = `projects/${PROJECT}/locations/${REGION}`;
const MAX_BYTES = 512 * 1024;
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
