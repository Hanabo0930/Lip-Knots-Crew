import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "apps/staff/src/App.tsx"), "utf8");

assert.doesNotMatch(
  source,
  /where\("companyId","==","lipknots"\)/u,
  "Staff Firestore queries must not hard-code a company ID.",
);
assert.match(
  source,
  /const cid=String\(token\.claims\.companyId\?\?""\)/u,
  "Staff startup must derive the company ID from verified auth claims.",
);
assert.match(
  source,
  /await loadPrimaryBusinessData\(sid,cid\)/u,
  "Staff startup must scope its priority data load to the claimed company.",
);
assert.match(
  source,
  /where\("companyId","==",cid\)/u,
  "Staff Firestore queries must use the claimed company ID.",
);

console.log("Staff company scope check passed.");
