/** Read-only deployment observations. This file does not authorize a Hosting change or API invocation. */
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {requireProtectedContext, validateHostingOperation} from "./hosting-operation-context.mjs";

const PROJECT = "lip-knots-crew-staging";
const REGION = "asia-northeast1";
const PREFIX = `projects/${PROJECT}/locations/${REGION}`;
const PROJECT_IDS = new Set([PROJECT, "740154137290"]);
const MAX_BYTES = 64 * 1024;
export const PILOT_FUNCTIONS = Object.freeze([
  "bootstrapSession", "loginGateway", "requestStaffLoginLink", "getMyTasks",
  "registerDeviceSession", "heartbeatDeviceSession", "getPushStatus",
]);
export const PILOT_FUNCTION_FIELDS = "name,environment,state,updateTime,buildConfig(build,runtime,entryPoint),serviceConfig(service,revision,allTrafficOnLatestRevision)";

class PilotMetadataError extends Error {}
const requireValue = (condition, code) => {if (!condition) throw new PilotMetadataError(code);};
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
function exactKeys(value, keys) {
  requireValue(plain(value) && Object.keys(value).length === keys.length
    && Object.keys(value).every(key => keys.includes(key)), "PILOT_METADATA_FIELDS_REJECTED");
}
function validTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

export function validatePilotMetadataContext() {
  requireProtectedContext();
  validateHostingOperation({operation: process.env.LKC_OPERATION,
    eventName: process.env.GITHUB_EVENT_NAME, confirmation: process.env.LKC_CONFIRMATION,
    projectId: process.env.LKC_PROJECT_ID, region: process.env.LKC_REGION,
    sourceRef: process.env.GITHUB_REF_NAME, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT)});
  requireValue(process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
    && ["promote", "readiness"].includes(process.env.LKC_OPERATION)
    && process.env.LKC_EVIDENCE_POLICY === "limited-staff-pilot"
    && process.env.LKC_METADATA_ONLY === "false"
    && process.env.GITHUB_RUN_ATTEMPT === "1", "PILOT_METADATA_CONTEXT_REJECTED");
  requireValue(/^[a-f0-9]{40}$/u.test(process.env.LKC_SOURCE_SHA ?? ""), "PILOT_SOURCE_SHA_REJECTED");
  requireValue(/^[1-9][0-9]{0,19}$/u.test(process.env.GITHUB_RUN_ID ?? ""), "PILOT_RUN_ID_REJECTED");
}

export function normalizePilotFunction(document, functionName) {
  requireValue(PILOT_FUNCTIONS.includes(functionName), "PILOT_FUNCTION_SCOPE_REJECTED");
  exactKeys(document, ["name", "environment", "state", "updateTime", "buildConfig", "serviceConfig"]);
  exactKeys(document.buildConfig, ["build", "runtime", "entryPoint"]);
  exactKeys(document.serviceConfig, ["service", "revision", "allTrafficOnLatestRevision"]);
  requireValue(document.name === `${PREFIX}/functions/${functionName}`, "PILOT_FUNCTION_IDENTITY_REJECTED");
  requireValue(document.environment === "GEN_2" && document.state === "ACTIVE", "PILOT_FUNCTION_NOT_ACTIVE");
  requireValue(document.buildConfig.runtime === "nodejs22" && document.buildConfig.entryPoint === functionName,
    "PILOT_FUNCTION_RUNTIME_REJECTED");
  const build = typeof document.buildConfig.build === "string"
    && /^projects\/([^/]+)\/locations\/([^/]+)\/builds\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/u.exec(document.buildConfig.build);
  requireValue(build && PROJECT_IDS.has(build[1]) && build[2] === REGION, "PILOT_BUILD_SCOPE_REJECTED");
  requireValue(document.serviceConfig.service === `${PREFIX}/services/${functionName.toLowerCase()}`,
    "PILOT_SERVICE_IDENTITY_REJECTED");
  requireValue(typeof document.serviceConfig.revision === "string"
    && new RegExp(`^${functionName.toLowerCase()}-[0-9]{1,10}-[a-z0-9]{1,20}$`, "u").test(document.serviceConfig.revision),
  "PILOT_REVISION_REJECTED");
  requireValue(document.serviceConfig.allTrafficOnLatestRevision === true, "PILOT_TRAFFIC_UNVERIFIED");
  requireValue(validTime(document.updateTime), "PILOT_UPDATE_TIME_REJECTED");
  return {name: document.name, function: functionName, state: document.state, environment: document.environment,
    runtime: document.buildConfig.runtime, entryPoint: document.buildConfig.entryPoint, build: document.buildConfig.build,
    service: document.serviceConfig.service, revision: document.serviceConfig.revision,
    allTrafficOnLatestRevision: true, updateTime: document.updateTime};
}

async function limitedJson(response) {
  requireValue(response.headers?.get("content-type")?.toLowerCase().includes("application/json"),
    "PILOT_METADATA_CONTENT_TYPE_REJECTED");
  requireValue(response.body && typeof response.body.getReader === "function", "PILOT_METADATA_BODY_REQUIRED");
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      requireValue(size <= MAX_BYTES, "PILOT_METADATA_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}

function safeError(error) {
  const guardCodes = ["PROTECTED_WORKFLOW_CONTEXT_REQUIRED", "ENVIRONMENT_REJECTED", "OPERATION_REJECTED",
    "TRIGGER_REJECTED", "MANUAL_OPERATION_REQUIRED", "CONFIRMATION_REJECTED", "WORKFLOW_RERUN_REJECTED"];
  return error instanceof PilotMetadataError || guardCodes.includes(error?.message)
    ? error.message : "PILOT_METADATA_TRANSPORT_OR_INPUT_FAILED";
}

export async function collectPilotMetadata({accessToken}, {request = globalThis.fetch, now = () => new Date().toISOString()} = {}) {
  const result = {schemaVersion: 1, status: "STOPPED", policy: "limited-staff-pilot",
    projectId: PROJECT, region: REGION, sourceAuthenticity: "UNVERIFIED", submissionAcceptance: "UNVERIFIED",
    hostingPromotionAuthorized: false, apiCompatibilityVerified: false, functions: {}, requests: []};
  try {
    validatePilotMetadataContext();
    requireValue(typeof accessToken === "string" && accessToken.length > 0 && !/[\r\n]/u.test(accessToken),
      "PILOT_METADATA_ACCESS_TOKEN_REQUIRED");
    const capturedAt = now();
    requireValue(validTime(capturedAt), "PILOT_OBSERVATION_TIME_REJECTED");
    result.sourceSha = process.env.LKC_SOURCE_SHA;
    result.observation = {runId: process.env.GITHUB_RUN_ID, runAttempt: 1, capturedAt};
    for (const functionName of PILOT_FUNCTIONS) {
      const url = new URL(`https://cloudfunctions.googleapis.com/v2/${PREFIX}/functions/${functionName}`);
      url.searchParams.set("fields", PILOT_FUNCTION_FIELDS);
      const record = {method: "GET", function: functionName};
      result.requests.push(record);
      const response = await request(url.href, {method: "GET", redirect: "error", cache: "no-store",
        headers: {Authorization: `Bearer ${accessToken}`, Accept: "application/json"}, signal: AbortSignal.timeout(15000)});
      record.status = response.status;
      requireValue(response.status !== 401 && response.status !== 403, "PILOT_METADATA_ACCESS_DENIED");
      requireValue(response.status === 200 && !response.redirected, "PILOT_METADATA_HTTP_FAILED");
      const document = await limitedJson(response);
      requireValue(!JSON.stringify(document).includes(accessToken), "PILOT_METADATA_TOKEN_REFLECTION_REJECTED");
      result.functions[functionName] = normalizePilotFunction(document, functionName);
    }
    result.status = "METADATA_COLLECTED";
  } catch (error) {result.reason = safeError(error);}
  return result;
}

export async function pilotMetadataMain({argv = process.argv.slice(2), request, save = async (result, phase) => {
  const target = path.resolve(process.env.LKC_EVIDENCE_DIR ?? "");
  const expected = path.resolve(process.env.RUNNER_TEMP ?? "", "hosting-promote-evidence");
  requireValue(path.isAbsolute(process.env.RUNNER_TEMP ?? "") && target === expected, "PILOT_EVIDENCE_DIRECTORY_REJECTED");
  await mkdir(target, {recursive: true});
  const filename = phase === "after" ? "pilot-metadata-after.json"
    : phase === "before-write" ? "pilot-metadata-before-write.json" : "pilot-metadata.json";
  await writeFile(path.join(target, filename),
    JSON.stringify(result, null, 2) + "\n", {mode: 0o600, flag: "wx"});
}, emit = line => console.log(line)} = {}) {
  requireValue(argv.length === 0 || (argv.length === 1 && ["--guard-only", "--after", "--before-write"].includes(argv[0])),
    "PILOT_METADATA_ARGUMENTS_REJECTED");
  validatePilotMetadataContext();
  if (argv[0] === "--guard-only") {emit("HOSTING_PILOT_METADATA_CONTEXT=VALIDATED"); return 0;}
  const accessToken = process.env.LKC_PILOT_METADATA_ACCESS_TOKEN;
  delete process.env.LKC_PILOT_METADATA_ACCESS_TOKEN;
  const result = await collectPilotMetadata({accessToken}, {request});
  await save(result, argv[0] === "--after" ? "after" : argv[0] === "--before-write" ? "before-write" : "initial");
  emit("HOSTING_PILOT_METADATA_RESULT=" + result.status);
  emit("HOSTING_PUBLICATION_AUTHORIZED=false");
  return result.status === "METADATA_COLLECTED" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  pilotMetadataMain().then(code => {process.exitCode = code;}).catch(error => {
    console.error("HOSTING_PILOT_METADATA_RESULT=STOPPED");
    console.error("HOSTING_PILOT_METADATA_ERROR=" + safeError(error));
    process.exitCode = 1;
  });
}
