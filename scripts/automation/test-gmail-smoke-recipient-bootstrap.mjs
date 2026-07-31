import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = readFileSync(
  resolve(root, "scripts/automation/provision-staging-gmail-smoke-recipient.sh"),
  "utf8",
);

assert.match(script, /EXPECTED_ACCOUNT='info@lipknots\.com'/u);
assert.match(script, /EXPECTED_PROJECT='lip-knots-crew-staging'/u);
assert.match(script, /EXPECTED_COMPANY_ID='lipknots-staging'/u);
assert.match(script, /PROVISION_LKC_STAGING_GMAIL_SMOKE_RECIPIENT/u);
assert.match(script, /RECIPIENT_NOT_DEDICATED_STAGING_ALIAS/u);
assert.match(script, /SENDER_RECIPIENT_NOT_SEPARATED/u);
assert.match(script, /PRODUCTION_PROJECT_REJECTED/u);
assert.match(script, /lkc-change-backups\/staging-gmail-smoke-recipient-/u);
assert.match(script, /documents:commit/u);
assert.match(script, /currentDocument/u);
assert.match(script, /POST_WRITE_VERIFICATION_FAILED/u);
assert.match(script, /FIRESTORE_CHANGED=NOT_CONFIRMED/u);
assert.match(script, /LKC_STAGING_GMAIL_SMOKE_RECIPIENT_ALREADY_PROVISIONED/u);
assert.match(script, /LKC_STAGING_GMAIL_SMOKE_RECIPIENT_PROVISIONED/u);
assert.doesNotMatch(script, /firebase\s+deploy/u);
assert.doesNotMatch(script, /add-iam-policy-binding/u);
assert.doesNotMatch(script, /\/storage\/v1\//u);
assert.doesNotMatch(script, /deleteDocument|documents:batchWrite/u);

console.log("Gmail smoke recipient bootstrap safety tests passed (18 cases)");
