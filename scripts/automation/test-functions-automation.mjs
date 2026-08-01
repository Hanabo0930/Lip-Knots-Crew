import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safetyConfig } from "./validate-staging-scope.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const expectedFunctions = [
  "bootstrapSession",
  "requestStaffLoginLink",
  "getSubmissionTimeline",
  "getSubmissionProcessingStatus",
  "getResubmissionComparison",
  "driveFilePreview",
  "finalizeStagedUpload",
  "listMyDevices",
  "registerPushToken",
  "unregisterPushToken",
  "getPushStatus",
  "sendTestPush",
  "processNotificationQueue",
];

assert.deepEqual(
  safetyConfig.allowedFunctions,
  expectedFunctions,
  "Functions allowlist must remain exact and ordered",
);

const workflow = read(".github/workflows/staging-functions-deploy.yml");
assert.match(
  workflow,
  /source_ref:[\s\S]*?default:\s*main/,
  "Functions deploy must default to the CI-passing main branch",
);
assert.match(
  workflow,
  /functions:[\s\S]*?default:\s*bootstrapSession/,
  "Functions deploy must default to bootstrapSession only",
);
assert.match(
  workflow,
  /environment:\s*lkc-staging-deploy/,
  "Functions deploy must retain the protected staging environment",
);
assert.match(
  workflow,
  /--functions "\$LKC_FUNCTIONS"/,
  "source authorization must inspect the exact requested Functions",
);
assert.match(
  workflow,
  /LKC_FUNCTIONS_GMAIL_DELEGATED_USER:\s*\$\{\{\s*secrets\.LKC_FUNCTIONS_GMAIL_DELEGATED_USER\s*\}\}/,
  "Functions deploy must preserve the delegated Gmail user from a protected secret",
);
assert.match(
  workflow,
  /printf 'GMAIL_DELEGATED_USER=%s\\n' "\$LKC_FUNCTIONS_GMAIL_DELEGATED_USER"/,
  "Functions dotenv must materialize GMAIL_DELEGATED_USER",
);

const deployScript = read("scripts/automation/deploy-staging-functions.sh");
assert.match(
  deployScript,
  /bootstrapSession\)\s+service_name="bootstrapsession"/,
  "bootstrapSession must map to its exact Cloud Run service",
);
assert.match(
  deployScript,
  /requestStaffLoginLink\)\s+service_name="requeststaffloginlink"/,
  "requestStaffLoginLink must map to its exact Cloud Run service",
);
assert.match(
  deployScript,
  /listMyDevices\)\s+service_name="listmydevices"/,
  "listMyDevices must map to its exact Cloud Run service",
);
for (const [functionName, serviceName] of [
  ["registerPushToken", "registerpushtoken"],
  ["unregisterPushToken", "unregisterpushtoken"],
  ["getPushStatus", "getpushstatus"],
  ["sendTestPush", "sendtestpush"],
]) {
  assert.match(
    deployScript,
    new RegExp(`${functionName}\\)\\s+service_name="${serviceName}"`),
    `${functionName} must map to its exact Cloud Run service`,
  );
}
assert.match(
  deployScript,
  /processNotificationQueue\)\s+service_name=""/,
  "processNotificationQueue must remain a non-public Firestore event trigger",
);
assert.match(
  deployScript,
  /allUsers[\s\S]*allAuthenticatedUsers/,
  "post-deploy verification must reject public IAM bindings",
);

const bootstrapScript = read("scripts/automation/bootstrap-github-wif.sh");
assert.match(
  bootstrapScript,
  /for function_name in \\\n\s+bootstrapSession \\/,
  "WIF bootstrap must discover bootstrapSession runtime and build identities",
);
assert.match(
  bootstrapScript,
  /for function_name in \\\n\s+bootstrapSession \\\n\s+requestStaffLoginLink \\/,
  "WIF bootstrap must discover requestStaffLoginLink runtime and build identities",
);
assert.match(
  bootstrapScript,
  /roles\/datastore\.viewer/,
  "staging observer must be able to verify the sanitized delivery record",
);

const authGuard = read("scripts/automation/check-function-auth-guards.mjs");
assert.match(
  authGuard,
  /bootstrapSession:\s*checkBootstrapSession/,
  "source guard must report bootstrapSession authorization",
);
assert.match(
  authGuard,
  /requestStaffLoginLink:\s*checkRequestStaffLoginLink/,
  "source guard must report requestStaffLoginLink authorization",
);
assert.match(
  authGuard,
  /listMyDevices:\s*checkListMyDevices/,
  "source guard must report listMyDevices authorization",
);
for (const [functionName, checkerName] of [
  ["registerPushToken", "checkRegisterPushToken"],
  ["unregisterPushToken", "checkUnregisterPushToken"],
  ["getPushStatus", "checkGetPushStatus"],
  ["sendTestPush", "checkSendTestPush"],
  ["processNotificationQueue", "checkProcessNotificationQueue"],
]) {
  assert.match(
    authGuard,
    new RegExp(`${functionName}:\\s*${checkerName}`),
    `source guard must report ${functionName} authorization`,
  );
}

const guardedOutput = execFileSync(
  process.execPath,
  [
    "scripts/automation/check-function-auth-guards.mjs",
    "--repository", root,
    "--ref", "HEAD",
    "--functions", expectedFunctions.join(","),
    "--require-pass",
  ],
  { cwd: root, encoding: "utf8" },
);
assert.match(
  guardedOutput,
  /SOURCE_GUARD_STATUS=PASS/,
  "every allowlisted Function must pass its source authorization guard",
);

console.log("Functions automation safety tests passed (28 cases)");
