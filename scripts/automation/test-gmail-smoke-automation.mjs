import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  summarizeDeliveries,
  validateOptions,
  validateRuntimeConfiguration,
} from "./gmail-single-mail-smoke.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const testEmail = "staging-smoke@example.com";
const delegatedUser = "sender@example.com";
const baseEnvironment = {
  LKC_PROJECT_ID: "lip-knots-crew-staging",
  LKC_REGION: "asia-northeast1",
  LKC_GMAIL_SMOKE_RECIPIENT_EMAIL: testEmail,
  LKC_EXPECTED_GMAIL_DELEGATED_USER: delegatedUser,
  LKC_GMAIL_SMOKE_CONTINUE_URL: "https://lip-knots-crew-staging.web.app/",
  LKC_EXPECTED_MAIL_FROM: "staging@example.com",
  LKC_EXPECTED_GATEWAY_URL:
    "https://asia-northeast1-lip-knots-crew-staging.cloudfunctions.net/loginGateway",
  LKC_GMAIL_SMOKE_RUN_ATTEMPT: "1",
  LKC_GMAIL_SMOKE_RUN_ID: "123456789",
  LKC_EVIDENCE_DIR: "/tmp/lkc-gmail-smoke-test",
};

const options = validateOptions(baseEnvironment);
assert.equal(options.projectId, "lip-knots-crew-staging");
assert.equal(options.continueUrl, "https://lip-knots-crew-staging.web.app");
assert.equal(options.testRecipientEmail, testEmail);
assert.equal(options.expectedDelegatedUser, delegatedUser);

for (const environment of [
  { ...baseEnvironment, LKC_PROJECT_ID: "lip-knots-crew-production" },
  { ...baseEnvironment, LKC_REGION: "us-central1" },
  { ...baseEnvironment, LKC_GMAIL_SMOKE_RUN_ATTEMPT: "2" },
  {
    ...baseEnvironment,
    LKC_EXPECTED_GMAIL_DELEGATED_USER: testEmail,
  },
  {
    ...baseEnvironment,
    LKC_GMAIL_SMOKE_CONTINUE_URL:
      "https://lip-knots-crew-staging.web.app/path",
  },
  {
    ...baseEnvironment,
    LKC_EXPECTED_GATEWAY_URL:
      "https://example.com/",
  },
]) {
  assert.throws(() => validateOptions(environment));
}

const readyService = {
  status: {
    conditions: [{ type: "Ready", status: "True" }],
  },
};
const mailFunction = {
  state: "ACTIVE",
  serviceConfig: {
    environmentVariables: {
      APP_ENVIRONMENT: "staging",
      EXPECTED_FIREBASE_PROJECT_ID: "lip-knots-crew-staging",
      MAIL_FROM: "staging@example.com",
      GMAIL_DELEGATED_USER: delegatedUser,
      STAFF_APP_URL: "https://lip-knots-crew-staging.web.app/",
      PUBLIC_LOGIN_GATEWAY_URL:
        "https://asia-northeast1-lip-knots-crew-staging.cloudfunctions.net/loginGateway",
    },
    secretEnvironmentVariables: [{ key: "GMAIL_SERVICE_ACCOUNT_JSON" }],
  },
};
const gatewayService = {
  ...readyService,
  metadata: {
    annotations: {
      "run.googleapis.com/invoker-iam-disabled": "true",
    },
  },
};
assert.equal(
  validateRuntimeConfiguration({
    mailFunction,
    mailService: readyService,
    gatewayFunction: { state: "ACTIVE" },
    gatewayService,
    options,
  }).gmailSecretBound,
  true,
);
assert.throws(
  () => validateRuntimeConfiguration({
    mailFunction: {
      ...mailFunction,
      serviceConfig: {
        ...mailFunction.serviceConfig,
        environmentVariables: {
          ...mailFunction.serviceConfig.environmentVariables,
          GMAIL_DELEGATED_USER: "wrong@example.com",
        },
      },
    },
    mailService: readyService,
    gatewayFunction: { state: "ACTIVE" },
    gatewayService,
    options,
  }),
  /delegatedUserPinned/u,
);

function deliveryRow({
  id,
  status = "sent",
  createdAt = "2026-07-31T06:00:01Z",
  sentAt = "2026-07-31T06:00:02Z",
  email = testEmail,
  source = "self_request",
  messageId = "gmail-message-id",
  error = "",
}) {
  return {
    document: {
      name:
        `projects/lip-knots-crew-staging/databases/(default)/documents/loginInviteDeliveries/${id}`,
      fields: {
        email: { stringValue: email },
        source: { stringValue: source },
        status: { stringValue: status },
        createdAt: { timestampValue: createdAt },
        sentAt: sentAt ? { timestampValue: sentAt } : {},
        gmailMessageId: messageId ? { stringValue: messageId } : {},
        errorMessage: error ? { stringValue: error } : {},
      },
    },
  };
}

const oneDelivery = summarizeDeliveries(
  [deliveryRow({ id: "delivery-1" })],
  testEmail,
  "2026-07-31T06:00:00Z",
);
assert.equal(oneDelivery.matchCount, 1);
assert.equal(oneDelivery.latest.status, "sent");
assert.equal(oneDelivery.latest.gmailMessageIdPresent, true);

const filteredDelivery = summarizeDeliveries(
  [
    deliveryRow({ id: "too-old", createdAt: "2026-07-31T05:59:59Z" }),
    deliveryRow({ id: "other-email", email: "other@example.com" }),
    deliveryRow({ id: "other-source", source: "admin_batch" }),
  ],
  testEmail,
  "2026-07-31T06:00:00Z",
);
assert.equal(filteredDelivery.matchCount, 0);

const duplicates = summarizeDeliveries(
  [
    deliveryRow({ id: "delivery-1" }),
    deliveryRow({
      id: "delivery-2",
      createdAt: "2026-07-31T06:00:03Z",
    }),
  ],
  testEmail,
  "2026-07-31T06:00:00Z",
);
assert.equal(duplicates.matchCount, 2);
assert.equal(duplicates.latest.documentId, "delivery-2");

const workflow = readFileSync(
  resolve(root, ".github/workflows/staging-functions-deploy.yml"),
  "utf8",
);
assert.match(workflow, /gmail-smoke/u);
assert.match(
  workflow,
  /LKC_GMAIL_SMOKE_RUN_ATTEMPT:\s*\$\{\{\s*github\.run_attempt\s*\}\}/u,
);
assert.match(workflow, /scripts\/automation\/gmail-single-mail-smoke\.mjs/u);
assert.match(workflow, /GCP_STAGING_OBSERVER_SERVICE_ACCOUNT/u);
assert.match(workflow, /LKC_FUNCTIONS_GMAIL_DELEGATED_USER/u);
assert.match(workflow, /GMAIL_DELEGATED_USER=%s/u);
assert.match(
  workflow,
  /LKC_FUNCTIONS_GMAIL_DELEGATED_USER:\s*\$\{\{\s*secrets\.LKC_FUNCTIONS_GMAIL_DELEGATED_USER\s*\}\}/u,
);
assert.match(
  workflow,
  /LKC_GMAIL_SMOKE_RECIPIENT_EMAIL:\s*\$\{\{\s*secrets\.LKC_GMAIL_SMOKE_RECIPIENT_EMAIL\s*\}\}/u,
);
assert.doesNotMatch(workflow, /secrets\.LKC_GMAIL_SMOKE_EMAIL/u);
assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/u);

const bootstrap = readFileSync(
  resolve(root, "scripts/automation/bootstrap-github-wif.sh"),
  "utf8",
);
assert.match(bootstrap, /roles\/datastore\.viewer/u);

console.log("Gmail smoke automation safety tests passed (23 cases)");
