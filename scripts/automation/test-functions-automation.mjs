import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safetyConfig } from "./validate-staging-scope.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const expectedFunctions = [
  "bootstrapSession",
  "getSubmissionTimeline",
  "getSubmissionProcessingStatus",
  "getResubmissionComparison",
  "driveFilePreview",
  "finalizeStagedUpload",
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

const deployScript = read("scripts/automation/deploy-staging-functions.sh");
assert.match(
  deployScript,
  /bootstrapSession\)\s+service_name="bootstrapsession"/,
  "bootstrapSession must map to its exact Cloud Run service",
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

const authGuard = read("scripts/automation/check-function-auth-guards.mjs");
assert.match(
  authGuard,
  /bootstrapSession:\s*checkBootstrapSession/,
  "source guard must report bootstrapSession authorization",
);

console.log("Functions automation safety tests passed (9 cases)");
