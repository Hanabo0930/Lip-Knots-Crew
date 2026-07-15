import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildProductionEvidenceSyncPackage, sha256, validateProductionEvidenceInventory, verifyFingerprint } from "./production-evidence-sync-core.mjs";

let cases = 0; async function test(name, operation) { try { await operation(); cases += 1; } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); } }
const seal = (value) => { const base = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "fingerprint")); return { ...base, fingerprint: sha256(base) }; };
const deployment = seal({ schemaVersion: 1, releaseId: "v5.6.0", projectId: "lip-knots-production", planFingerprint: "a".repeat(64), status: "succeeded" });
const acceptance = seal({ schemaVersion: 1, releaseId: "v5.6.0", projectId: "lip-knots-production", deploymentPlanFingerprint: "a".repeat(64), status: "rollback_required" });
const rollback = seal({ schemaVersion: 1, releaseId: "v5.6.0", knownGoodReleaseId: "v5.1.0", projectId: "lip-knots-production", rollbackPlanFingerprint: "b".repeat(64), acceptanceLedgerFingerprint: acceptance.fingerprint, status: "rollback_succeeded" });
const recovery = seal({ schemaVersion: 1, releaseId: "v5.1.0", projectId: "lip-knots-production", deploymentPlanFingerprint: "b".repeat(64), status: "accepted" });
await test("valid deployment inventory", () => assert.deepEqual(validateProductionEvidenceInventory({ deploymentResult: deployment }), []));
await test("valid full inventory", () => assert.deepEqual(validateProductionEvidenceInventory({ deploymentResult: deployment, acceptanceLedger: acceptance, rollbackResult: rollback, recoveryAcceptanceLedger: recovery }), []));
await test("package fingerprint", () => assert.equal(verifyFingerprint(buildProductionEvidenceSyncPackage({ deploymentResult: deployment }, "2026-07-14T06:00:00.000Z")), true));
await test("deterministic package", () => assert.equal(buildProductionEvidenceSyncPackage({ deploymentResult: deployment }, "2026-07-14T06:00:00.000Z").fingerprint, buildProductionEvidenceSyncPackage({ deploymentResult: deployment }, "2026-07-14T06:00:00.000Z").fingerprint));
for (const [name, evidence] of [["missing deployment", {}], ["unknown key", { deploymentResult: deployment, extra: {} }], ["bad deployment", { deploymentResult: { ...deployment, fingerprint: "c".repeat(64) } }], ["rollback without acceptance", { deploymentResult: deployment, rollbackResult: rollback }], ["recovery without rollback", { deploymentResult: deployment, acceptanceLedger: acceptance, recoveryAcceptanceLedger: recovery }], ["bad acceptance chain", { deploymentResult: deployment, acceptanceLedger: seal({ ...acceptance, deploymentPlanFingerprint: "c".repeat(64) }) }], ["secret", { deploymentResult: seal({ ...deployment, stderr: "Bearer abcdefghijklmnopqrstuvwxyz" }) }]]) await test(`reject ${name}`, () => assert.ok(validateProductionEvidenceInventory(evidence).length));
const temporary = await mkdtemp(join(tmpdir(), "lkc-evidence-sync-"));
await writeFile(join(temporary, "deployment-result.json"), JSON.stringify(deployment));
await test("CLI preview", () => { const result = spawnSync(process.execPath, [resolve("scripts/create-production-evidence-sync-package.mjs"), "--evidence-root", temporary, "--output", join(temporary, "admin-sync-package.json")], { cwd: process.cwd(), encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /保存なし/u); });
await test("CLI write", () => { const result = spawnSync(process.execPath, [resolve("scripts/create-production-evidence-sync-package.mjs"), "--evidence-root", temporary, "--output", join(temporary, "admin-sync-package.json"), "--write"], { cwd: process.cwd(), encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); });
await test("CLI output valid", async () => { const value = JSON.parse(await readFile(join(temporary, "admin-sync-package.json"), "utf8")); assert.equal(verifyFingerprint(value), true); assert.equal(value.releaseId, "v5.6.0"); });
await test("CLI overwrite blocked", () => { const result = spawnSync(process.execPath, [resolve("scripts/create-production-evidence-sync-package.mjs"), "--evidence-root", temporary, "--output", join(temporary, "admin-sync-package.json"), "--write"], { cwd: process.cwd(), encoding: "utf8" }); assert.notEqual(result.status, 0); });
console.log(`production evidence sync package tests passed (${cases} cases)`);
