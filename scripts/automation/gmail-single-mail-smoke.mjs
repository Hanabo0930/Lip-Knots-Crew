import { createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const EXPECTED_PROJECT = "lip-knots-crew-staging";
const EXPECTED_REGION = "asia-northeast1";
const MAIL_FUNCTION = "requestStaffLoginLink";
const MAIL_SERVICE = "requeststaffloginlink";
const GATEWAY_FUNCTION = "loginGateway";
const GATEWAY_SERVICE = "logingateway";
const GMAIL_SECRET = "GMAIL_SERVICE_ACCOUNT_JSON";
const DELIVERY_SOURCE = "self_request";
const POLL_ATTEMPTS = 15;
const POLL_DELAY_MS = 2_000;

function requireValue(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`CONFIGURATION_MISSING:${name}`);
  return normalized;
}

function parseHttpsOrigin(value, name) {
  let parsed;
  try {
    parsed = new URL(requireValue(value, name));
  } catch {
    throw new Error(`URL_INVALID:${name}`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`URL_NOT_HTTPS_ORIGIN:${name}`);
  }
  return parsed.origin;
}

function parseHttpsUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(requireValue(value, name));
  } catch {
    throw new Error(`URL_INVALID:${name}`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`URL_NOT_SAFE_HTTPS:${name}`);
  }
  return parsed.toString();
}

export function validateOptions(environment = process.env) {
  const projectId = requireValue(environment.LKC_PROJECT_ID, "LKC_PROJECT_ID");
  const region = requireValue(environment.LKC_REGION, "LKC_REGION");
  const testEmail = requireValue(
    environment.LKC_GMAIL_SMOKE_EMAIL,
    "LKC_GMAIL_SMOKE_EMAIL",
  ).toLowerCase();
  const continueUrl = parseHttpsOrigin(
    environment.LKC_GMAIL_SMOKE_CONTINUE_URL,
    "LKC_GMAIL_SMOKE_CONTINUE_URL",
  );
  const expectedMailFrom = requireValue(
    environment.LKC_EXPECTED_MAIL_FROM,
    "LKC_EXPECTED_MAIL_FROM",
  ).toLowerCase();
  const expectedGatewayUrl = parseHttpsUrl(
    environment.LKC_EXPECTED_GATEWAY_URL,
    "LKC_EXPECTED_GATEWAY_URL",
  );
  const runAttempt = requireValue(
    environment.LKC_GMAIL_SMOKE_RUN_ATTEMPT,
    "LKC_GMAIL_SMOKE_RUN_ATTEMPT",
  );
  const runId = requireValue(
    environment.LKC_GMAIL_SMOKE_RUN_ID,
    "LKC_GMAIL_SMOKE_RUN_ID",
  );
  const evidenceDirectory = path.resolve(requireValue(
    environment.LKC_EVIDENCE_DIR,
    "LKC_EVIDENCE_DIR",
  ));

  if (projectId !== EXPECTED_PROJECT) {
    throw new Error(`PROJECT_NOT_ALLOWED:${projectId}`);
  }
  if (region !== EXPECTED_REGION) {
    throw new Error(`REGION_NOT_ALLOWED:${region}`);
  }
  if (/prod(uction)?/iu.test(projectId)) {
    throw new Error(`PRODUCTION_PROJECT_REJECTED:${projectId}`);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(testEmail)) {
    throw new Error("TEST_EMAIL_INVALID");
  }
  if (runAttempt !== "1") {
    throw new Error("WORKFLOW_RERUN_REJECTED");
  }

  const canonicalGatewayUrl =
    `https://${EXPECTED_REGION}-${EXPECTED_PROJECT}.cloudfunctions.net/${GATEWAY_FUNCTION}`;
  if (expectedGatewayUrl !== canonicalGatewayUrl) {
    throw new Error("EXPECTED_GATEWAY_URL_NOT_CANONICAL");
  }

  return {
    projectId,
    region,
    testEmail,
    continueUrl,
    expectedMailFrom,
    expectedGatewayUrl,
    runAttempt,
    runId,
    evidenceDirectory,
  };
}

function gcloudJson(arguments_) {
  const result = spawnSync("gcloud", arguments_, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`GCLOUD_COMMAND_FAILED:${arguments_[0]}:${arguments_[1] ?? ""}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`GCLOUD_JSON_INVALID:${arguments_[0]}:${arguments_[1] ?? ""}`);
  }
}

function accessToken() {
  const result = spawnSync("gcloud", ["auth", "print-access-token"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const token = String(result.stdout ?? "").trim();
  if (result.error || result.status !== 0 || !token) {
    throw new Error("ACCESS_TOKEN_UNAVAILABLE");
  }
  return token;
}

function runServiceReady(service) {
  return ((service.status ?? {}).conditions ?? []).some(
    (condition) => condition.type === "Ready" && condition.status === "True",
  );
}

export function validateRuntimeConfiguration(input) {
  const {
    mailFunction,
    mailService,
    gatewayFunction,
    gatewayService,
    options,
  } = input;
  const mailConfig = mailFunction.serviceConfig ?? {};
  const mailEnvironment = mailConfig.environmentVariables ?? {};
  const secretKeys = new Set(
    (mailConfig.secretEnvironmentVariables ?? [])
      .map((item) => item.key)
      .filter(Boolean),
  );
  const gatewayAnnotations = gatewayService.metadata?.annotations ?? {};
  const checks = {
    mailFunctionActive: mailFunction.state === "ACTIVE",
    mailServiceReady: runServiceReady(mailService),
    gatewayFunctionActive: gatewayFunction.state === "ACTIVE",
    gatewayServiceReady: runServiceReady(gatewayService),
    appEnvironmentStaging: mailEnvironment.APP_ENVIRONMENT === "staging",
    projectPinned:
      mailEnvironment.EXPECTED_FIREBASE_PROJECT_ID === EXPECTED_PROJECT,
    mailFromPinned:
      String(mailEnvironment.MAIL_FROM ?? "").toLowerCase()
      === options.expectedMailFrom,
    delegatedUserPinned:
      String(mailEnvironment.GMAIL_DELEGATED_USER ?? "").toLowerCase()
      === options.testEmail,
    gmailSecretBound: secretKeys.has(GMAIL_SECRET),
    staffAppUrlPinned:
      parseHttpsOrigin(mailEnvironment.STAFF_APP_URL, "STAFF_APP_URL")
      === options.continueUrl,
    gatewayUrlPinned:
      parseHttpsUrl(
        mailEnvironment.PUBLIC_LOGIN_GATEWAY_URL,
        "PUBLIC_LOGIN_GATEWAY_URL",
      ) === options.expectedGatewayUrl,
    gatewayInvokerCheckDisabled:
      gatewayAnnotations["run.googleapis.com/invoker-iam-disabled"] === "true",
  };
  const failed = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failed.length) {
    throw new Error(`RUNTIME_CONFIGURATION_UNSAFE:${failed.join(",")}`);
  }
  return checks;
}

function firestoreString(fields, key) {
  return String(fields?.[key]?.stringValue ?? "");
}

function firestoreBoolean(fields, key) {
  return fields?.[key]?.booleanValue === true;
}

function firestoreTimestamp(fields, key) {
  return String(fields?.[key]?.timestampValue ?? "");
}

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ""));
  if (!Number.isFinite(timestamp)) throw new Error("FIRESTORE_TIMESTAMP_INVALID");
  return timestamp;
}

export function summarizeDeliveries(rows, testEmail, startedAt) {
  const startedAtMs = parseTimestamp(startedAt);
  const matches = [];
  for (const row of rows ?? []) {
    const document = row.document;
    if (!document) continue;
    const fields = document.fields ?? {};
    const createdAt = firestoreTimestamp(fields, "createdAt");
    if (
      firestoreString(fields, "email") !== testEmail
      || firestoreString(fields, "source") !== DELIVERY_SOURCE
      || !createdAt
      || parseTimestamp(createdAt) < startedAtMs
    ) {
      continue;
    }
    matches.push({
      documentId: String(document.name ?? "").split("/").at(-1) ?? "",
      status: firestoreString(fields, "status"),
      createdAt,
      sentAt: firestoreTimestamp(fields, "sentAt"),
      gmailMessageIdPresent: Boolean(
        firestoreString(fields, "gmailMessageId"),
      ),
      errorPresent: Boolean(firestoreString(fields, "errorMessage")),
    });
  }
  matches.sort((left, right) => (
    parseTimestamp(right.createdAt) - parseTimestamp(left.createdAt)
  ));
  return {
    matchCount: matches.length,
    latest: matches[0] ?? null,
  };
}

async function fetchDocument(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`FIRESTORE_DOCUMENT_HTTP_${response.status}`);
  return response.json();
}

async function queryDeliveries(options, token, startedAt) {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${options.projectId}`
      + "/databases/(default)/documents:runQuery",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "loginInviteDeliveries" }],
          orderBy: [{
            field: { fieldPath: "createdAt" },
            direction: "DESCENDING",
          }],
          limit: 50,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`DELIVERY_QUERY_HTTP_${response.status}`);
  return summarizeDeliveries(
    await response.json(),
    options.testEmail,
    startedAt,
  );
}

async function probePublicEndpoints(options) {
  const gatewayResponse = await fetch(options.expectedGatewayUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const gatewayBody = await gatewayResponse.text();
  if (
    gatewayResponse.status !== 400
    || !gatewayBody.includes("ログインリンクが正しくありません。")
  ) {
    throw new Error(`GATEWAY_PUBLIC_PROBE_FAILED:${gatewayResponse.status}`);
  }

  const mailUrl =
    `https://${options.region}-${options.projectId}.cloudfunctions.net/${MAIL_FUNCTION}`;
  const optionsResponse = await fetch(mailUrl, {
    method: "OPTIONS",
    headers: {
      Origin: options.continueUrl,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (![200, 204].includes(optionsResponse.status)) {
    throw new Error(`MAIL_PUBLIC_PROBE_FAILED:${optionsResponse.status}`);
  }
  return { mailUrl, gatewayStatus: gatewayResponse.status };
}

async function validateTestRecipient(options, token) {
  const emailHash = createHash("sha256")
    .update(options.testEmail)
    .digest("hex");
  const index = await fetchDocument(
    `https://firestore.googleapis.com/v1/projects/${options.projectId}`
      + `/databases/(default)/documents/emailIndex/${emailHash}`,
    token,
  );
  const indexFields = index.fields ?? {};
  const staffId = firestoreString(indexFields, "staffId");
  const companyId = firestoreString(indexFields, "companyId");
  if (!firestoreBoolean(indexFields, "active") || !staffId || !companyId) {
    throw new Error("TEST_EMAIL_INDEX_INACTIVE_OR_INVALID");
  }
  const profile = await fetchDocument(
    `https://firestore.googleapis.com/v1/projects/${options.projectId}`
      + `/databases/(default)/documents/staffProfiles/${encodeURIComponent(staffId)}`,
    token,
  );
  if (!firestoreBoolean(profile.fields ?? {}, "active")) {
    throw new Error("TEST_STAFF_PROFILE_INACTIVE_OR_MISSING");
  }
  return true;
}

async function invokeSingleMail(mailUrl, options) {
  const response = await fetch(mailUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: {
        email: options.testEmail,
        continueUrl: options.continueUrl,
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`SINGLE_MAIL_RESPONSE_INVALID:${response.status}`);
  }
  const result = payload.result ?? payload.data ?? {};
  if (!response.ok || result.accepted !== true) {
    throw new Error(`SINGLE_MAIL_REQUEST_REJECTED:${response.status}`);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function awaitDelivery(options, token, startedAt) {
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
    const summary = await queryDeliveries(options, token, startedAt);
    console.log(`DELIVERY_CHECK_ATTEMPT=${attempt}`);
    console.log(`DELIVERY_MATCH_COUNT=${summary.matchCount}`);
    if (summary.matchCount > 1) {
      throw new Error("MULTIPLE_TEST_DELIVERIES_DETECTED");
    }
    if (summary.latest?.status === "failed" || summary.latest?.errorPresent) {
      throw new Error("DELIVERY_FAILED");
    }
    if (
      summary.matchCount === 1
      && summary.latest?.status === "sent"
      && summary.latest.sentAt
      && summary.latest.gmailMessageIdPresent
    ) {
      return summary;
    }
    if (attempt < POLL_ATTEMPTS) await sleep(POLL_DELAY_MS);
  }
  throw new Error("DELIVERY_SENT_NOT_CONFIRMED");
}

function writeEvidence(options, evidence) {
  mkdirSync(options.evidenceDirectory, { recursive: true });
  const filePath = path.join(
    options.evidenceDirectory,
    "gmail-single-mail-smoke.json",
  );
  writeFileSync(
    filePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return filePath;
}

async function main() {
  const options = validateOptions();
  const startedAt = new Date().toISOString();
  const evidence = {
    projectId: options.projectId,
    region: options.region,
    runId: options.runId,
    runAttempt: options.runAttempt,
    startedAt,
    testRecipientConfigured: true,
    requestInvoked: false,
    emailSent: false,
    emailCount: 0,
    productionTouched: false,
    directFirestoreWritePerformed: false,
  };

  console.log("=== LKC GMAIL SINGLE-MAIL AUTOMATED SMOKE ===");
  console.log(`PROJECT=${options.projectId}`);
  console.log(`REGION=${options.region}`);
  console.log(`RUN_ID=${options.runId}`);
  console.log(`RUN_ATTEMPT=${options.runAttempt}`);

  try {
    const [mailFunction, mailService, gatewayFunction, gatewayService] =
      await Promise.all([
        Promise.resolve(gcloudJson([
          "functions",
          "describe",
          MAIL_FUNCTION,
          "--gen2",
          "--project",
          options.projectId,
          "--region",
          options.region,
          "--format=json",
        ])),
        Promise.resolve(gcloudJson([
          "run",
          "services",
          "describe",
          MAIL_SERVICE,
          "--project",
          options.projectId,
          "--region",
          options.region,
          "--format=json",
        ])),
        Promise.resolve(gcloudJson([
          "functions",
          "describe",
          GATEWAY_FUNCTION,
          "--gen2",
          "--project",
          options.projectId,
          "--region",
          options.region,
          "--format=json",
        ])),
        Promise.resolve(gcloudJson([
          "run",
          "services",
          "describe",
          GATEWAY_SERVICE,
          "--project",
          options.projectId,
          "--region",
          options.region,
          "--format=json",
        ])),
      ]);
    evidence.runtimeChecks = validateRuntimeConfiguration({
      mailFunction,
      mailService,
      gatewayFunction,
      gatewayService,
      options,
    });
    console.log("RUNTIME_CONFIGURATION=SAFE");

    const publicProbe = await probePublicEndpoints(options);
    evidence.publicProbe = {
      gatewayStatus: publicProbe.gatewayStatus,
      mailOptionsPassed: true,
    };
    console.log("PUBLIC_ENDPOINTS=READY");

    const token = accessToken();
    await validateTestRecipient(options, token);
    evidence.testRecipientActive = true;
    console.log("TEST_RECIPIENT=ACTIVE");

    const requestStartedAt = new Date().toISOString();
    evidence.requestStartedAt = requestStartedAt;
    await invokeSingleMail(publicProbe.mailUrl, options);
    evidence.requestInvoked = true;
    console.log("SINGLE_MAIL_REQUEST=ACCEPTED");

    const delivery = await awaitDelivery(options, token, requestStartedAt);
    evidence.delivery = {
      matchCount: delivery.matchCount,
      documentId: delivery.latest.documentId,
      status: delivery.latest.status,
      createdAt: delivery.latest.createdAt,
      sentAt: delivery.latest.sentAt,
      gmailMessageIdPresent: delivery.latest.gmailMessageIdPresent,
      errorPresent: delivery.latest.errorPresent,
    };
    evidence.emailSent = true;
    evidence.emailCount = 1;
    evidence.completedAt = new Date().toISOString();
    const evidenceFile = writeEvidence(options, evidence);

    console.log("EMAIL_SENT=true");
    console.log("EMAIL_COUNT=1");
    console.log("PRODUCTION_CHANGED=false");
    console.log("DIRECT_FIRESTORE_WRITE=false");
    console.log(`EVIDENCE_FILE=${evidenceFile}`);
    console.log("LKC_GMAIL_SINGLE_MAIL_AUTOMATED_SMOKE_DONE");
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    evidence.completedAt = new Date().toISOString();
    const evidenceFile = writeEvidence(options, evidence);
    console.error(`SMOKE_ERROR=${evidence.error}`);
    console.error(`EVIDENCE_FILE=${evidenceFile}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
