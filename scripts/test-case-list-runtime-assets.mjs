import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const functionsSource = JSON.parse(fs.readFileSync(path.join(root, "firebase.json"), "utf8")).functions;
assert.equal(functionsSource.source, "functions");
assert.equal(functionsSource.ignore, undefined, "A new upload exclusion needs explicit asset closure review");
const assets = [
  ["case-list-publication-core", "case-list-monthly-controller.cjs", ["checkPromisedPay", "transferCapability", "assertSnapshotCoverage"]],
  ["case-list-publication-worker", "case-list-monthly-adapter.cjs", ["createGoogleSheetsMutationAdapter"]],
  ["case-list-recruitment", "recruitment-mail-core.cjs", ["compose", "subjects", "normalizeNotice"]],
  ["case-list-source-core", "case-list-projection.cjs", ["create"]],
  ["case-list-monthly-reader", "case-list-monthly-compact.cjs", ["createCompactSnapshot"]],
  ["case-list-monthly-worker", "case-list-monthly-controller.cjs", ["create", "transferCapability", "assertSnapshotCoverage"]],
  ["case-list-monthly-worker", "case-list-monthly-adapter.cjs", ["createGoogleSheetsMutationAdapter"]],
];
for (const [module, asset, exports] of assets) {
  const compiled = path.join(root, "functions/lib", module + ".js");
  assert.ok(fs.existsSync(compiled), "Build is required before verifying deployment runtime assets");
  const runtimeRequire = createRequire(compiled), relative = "../src/" + asset;
  assert.ok(fs.readFileSync(compiled, "utf8").includes(relative), module + " does not retain its deployed CJS coordinate");
  assert.equal(runtimeRequire.resolve(relative), path.join(root, "functions/src", asset));
  const loaded = runtimeRequire(relative);
  for (const name of exports) assert.equal(typeof loaded[name], "function", asset + " missing " + name);
}
console.log(JSON.stringify({ status: "PASS", assets: assets.length, scope: "BUILT_FUNCTIONS_RELATIVE_ASSET_CLOSURE", nativeRequests: 0 }));
