import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRollbackManifest, collectKnownGoodBundleFiles, inspectBundleSource, renderRollbackFirebaseConfig, validateKnownGoodBundleInput } from "./known-good-bundle-core.mjs";

let cases = 0; async function test(name, operation) { try { await operation(); cases += 1; } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); } }
const packageJson = { version: "3.8.0" }; const firebaseJson = { functions: { source: "functions", runtime: "nodejs22", predeploy: ["danger"] }, firestore: { rules: "firestore.rules", indexes: "firestore.indexes.json" }, storage: { rules: "storage.rules" }, hosting: [] };
await test("valid input", () => assert.deepEqual(validateKnownGoodBundleInput({ releaseId: "v3.8.0", projectId: "lip-knots-production", packageJson, firebaseJson }), []));
await test("predeploy removed", () => { const value = renderRollbackFirebaseConfig(firebaseJson); assert.equal(value.functions.predeploy, undefined); assert.equal(value.functions.runtime, "nodejs22"); });
const rejections = [["release", { releaseId: "latest" }], ["project", { projectId: "BAD" }], ["version", { releaseId: "v3.7.0" }], ["functions", { firebaseJson: { ...firebaseJson, functions: { source: "wrong" } } }], ["firestore", { firebaseJson: { ...firebaseJson, firestore: { rules: "wrong" } } }], ["storage", { firebaseJson: { ...firebaseJson, storage: { rules: "wrong" } } }]];
for (const [name, override] of rejections) await test(`reject ${name}`, () => assert.ok(validateKnownGoodBundleInput({ releaseId: "v3.8.0", projectId: "lip-knots-production", packageJson, firebaseJson, ...override }).length));
const temporary = await mkdtemp(join(tmpdir(), "lkc-known-good-"));
try {
  await mkdir(join(temporary, "functions/lib/nested"), { recursive: true });
  await writeFile(join(temporary, "package.json"), JSON.stringify(packageJson)); await writeFile(join(temporary, "firebase.json"), JSON.stringify(firebaseJson));
  for (const [path, content] of [["firestore.rules", "rules"], ["firestore.indexes.json", "{}"], ["storage.rules", "rules"], ["functions/package.json", "{\"main\":\"lib/index.js\"}"], ["functions/lib/index.js", "exports.ok=true"], ["functions/lib/nested/core.js", "exports.core=true"]]) { await mkdir(join(temporary, path, ".."), { recursive: true }); await writeFile(join(temporary, path), content); }
  await test("collect files", async () => { const paths = await collectKnownGoodBundleFiles(temporary); assert.ok(paths.includes("functions/lib/index.js")); assert.ok(paths.includes("functions/lib/nested/core.js")); assert.equal(paths.length, 6); });
  let inspection;
  await test("inspect source", async () => { inspection = await inspectBundleSource(temporary, { releaseId: "v3.8.0", projectId: "lip-knots-production" }); assert.equal(inspection.valid, true); });
  await test("manifest", async () => { const manifest = await buildRollbackManifest({ sourceRoot: temporary, releaseId: "v3.8.0", projectId: "lip-knots-production", paths: inspection.paths, firebaseRollback: inspection.firebaseRollback }); assert.match(manifest.fingerprint, /^[a-f0-9]{64}$/u); assert.match(manifest.files["functions/lib/index.js"], /^[a-f0-9]{64}$/u); assert.equal(Object.keys(manifest.files).length, 7); });
  await test("missing build rejected", async () => { await rm(join(temporary, "functions/lib/index.js")); const value = await inspectBundleSource(temporary, { releaseId: "v3.8.0", projectId: "lip-knots-production" }); assert.equal(value.valid, false); assert.ok(value.errors.includes("functionsBuild")); });
} finally { await rm(temporary, { recursive: true, force: true }); }
await test("CLI preview", () => { const result = spawnSync(process.execPath, [resolve("scripts/create-known-good-rollback-bundle.mjs"), "--source", ".", "--release", "v5.6.0", "--project", "lip-knots-production"], { cwd: process.cwd(), encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /保存なし/u); });
await test("CLI version mismatch", () => { const result = spawnSync(process.execPath, [resolve("scripts/create-known-good-rollback-bundle.mjs"), "--source", ".", "--release", "v3.8.0", "--project", "lip-knots-production"], { cwd: process.cwd(), encoding: "utf8" }); assert.notEqual(result.status, 0); });
console.log(`known-good rollback bundle tests passed (${cases} cases)`);
