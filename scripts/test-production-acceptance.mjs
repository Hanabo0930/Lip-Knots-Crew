import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildProductionAcceptancePlan, evaluateAcceptanceCheck, parseInventoryNames, runProductionAcceptance, updateAcceptanceLedger, validateDeploymentEvidence, validateProductionAcceptanceConfig, validateRollbackEvidence } from "./production-acceptance-core.mjs";

let cases = 0; async function test(name, operation) { try { await operation(); cases += 1; } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); } }
const config = JSON.parse(await readFile("config-samples/production-acceptance.example.json", "utf8")); const plan = buildProductionAcceptancePlan(config); const now = new Date("2026-07-14T10:01:00.000Z");
const deploymentEvidence = { schemaVersion: 1, releaseId: "v5.6.0", projectId: config.projectId, planFingerprint: "a".repeat(64), status: "succeeded", completedAt: "2026-07-14T10:00:00.000Z", results: ["project_access", "rules_and_storage", "functions", "hosting", "functions_inventory", "hosting_inventory", "staff_https", "admin_https"].map((key) => ({ key, code: 0 })) };
const recoveryPlan = buildProductionAcceptancePlan(config, { releaseIdOverride: "v3.8.0" });
const rollbackEvidence = { schemaVersion: 1, releaseId: "v5.6.0", knownGoodReleaseId: "v3.8.0", projectId: config.projectId, rollbackPlanFingerprint: "b".repeat(64), status: "rollback_succeeded", completedAt: "2026-07-14T10:00:00.000Z", results: ["project_access", "known_good_rules", "known_good_functions", "staff_hosting_clone", "admin_hosting_clone", "functions_inventory", "hosting_inventory", "staff_https", "admin_https"].map((key) => ({ key, code: 0 })) };
const securityHeaders = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "permissions-policy": "camera=()", "strict-transport-security": "max-age=31536000" };
const firebaseResult = (check) => check.key === "project_access" ? { code: 0, stdout: JSON.stringify({ result: [{ projectId: config.projectId }] }), stderr: "" } : check.key === "functions_inventory" ? { code: 0, stdout: JSON.stringify({ result: config.requiredFunctions.map((id) => ({ id })) }), stderr: "" } : { code: 0, stdout: JSON.stringify({ result: Object.values(config.hostingSites).map((siteId) => ({ siteId })) }), stderr: "" };
const httpResult = (check) => ({ status: check.expected.statuses[0], finalUrl: check.url, headers: check.expected.requireSecurityHeaders ? { ...securityHeaders } : {}, body: `ready ${check.expected.marker}` });

await test("valid config", () => assert.deepEqual(validateProductionAcceptanceConfig(config), []));
await test("deterministic plan", () => assert.equal(buildProductionAcceptancePlan(structuredClone(config)).fingerprint, plan.fingerprint));
await test("nine checks", () => assert.equal(plan.checks.length, 9));
await test("fingerprint", () => assert.match(plan.fingerprint, /^[a-f0-9]{64}$/u));
await test("valid deployment evidence", () => assert.equal(validateDeploymentEvidence(deploymentEvidence, plan, { now }).valid, true));
await test("recovery release override", () => assert.equal(recoveryPlan.releaseId, "v3.8.0"));
await test("valid rollback evidence", () => assert.equal(validateRollbackEvidence(rollbackEvidence, recoveryPlan, { now }).valid, true));
await test("rollback release mismatch rejected", () => assert.equal(validateRollbackEvidence({ ...rollbackEvidence, knownGoodReleaseId: "v3.7.0" }, recoveryPlan, { now }).valid, false));
await test("rollback missing stage rejected", () => assert.equal(validateRollbackEvidence({ ...rollbackEvidence, results: rollbackEvidence.results.filter((item) => item.key !== "known_good_functions") }, recoveryPlan, { now }).valid, false));

const configRejections = [
  ["schema", (value) => { value.schemaVersion = 2; }], ["release", (value) => { value.releaseId = "v3.8.0"; }], ["project", (value) => { value.projectId = "BAD"; }], ["passes", (value) => { value.requiredPasses = 1; }], ["spacing", (value) => { value.minimumSpacingMinutes = 0; }], ["deadline", (value) => { value.acceptanceDeadlineMinutes = 10; }], ["functions", (value) => { value.requiredFunctions = ["one"]; }], ["duplicate functions", (value) => { value.requiredFunctions[1] = value.requiredFunctions[0]; }], ["sites", (value) => { value.hostingSites.admin = value.hostingSites.staff; }], ["http", (value) => { value.urls.staffAppUrl = "http://bad.test"; }], ["duplicate url", (value) => { value.urls.adminAppUrl = value.urls.staffAppUrl; }], ["secret", (value) => { value.accessToken = "never"; }],
];
for (const [name, mutate] of configRejections) await test(`reject config ${name}`, () => { const value = structuredClone(config); mutate(value); assert.ok(validateProductionAcceptanceConfig(value).length > 0); });

const evidenceRejections = [
  ["schema", (value) => { value.schemaVersion = 2; }], ["status", (value) => { value.status = "failed"; }], ["release", (value) => { value.releaseId = "v3.8.0"; }], ["project", (value) => { value.projectId = "other-production"; }], ["fingerprint", (value) => { value.planFingerprint = "bad"; }], ["missing stage", (value) => { value.results = value.results.filter((item) => item.key !== "functions"); }], ["failed stage", (value) => { value.results.find((item) => item.key === "hosting").code = 1; }], ["future", (value) => { value.completedAt = "2026-07-14T10:03:00.000Z"; }], ["deadline", (value) => { value.completedAt = "2026-07-14T09:00:00.000Z"; }],
];
for (const [name, mutate] of evidenceRejections) await test(`reject evidence ${name}`, () => { const value = structuredClone(deploymentEvidence); mutate(value); assert.equal(validateDeploymentEvidence(value, plan, { now }).valid, false); });

await test("inventory parsing", () => assert.deepEqual(parseInventoryNames({ stdout: JSON.stringify({ result: [{ id: "one" }, { siteId: "two" }] }) }).sort(), ["one", "two"]));
await test("project check", () => assert.equal(evaluateAcceptanceCheck(plan.checks[0], firebaseResult(plan.checks[0])).passed, true));
await test("function inventory check", () => assert.equal(evaluateAcceptanceCheck(plan.checks[1], firebaseResult(plan.checks[1])).passed, true));
await test("hosting inventory check", () => assert.equal(evaluateAcceptanceCheck(plan.checks[2], firebaseResult(plan.checks[2])).passed, true));
await test("http check", () => assert.equal(evaluateAcceptanceCheck(plan.checks[3], httpResult(plan.checks[3])).passed, true));
await test("http status rejected", () => assert.equal(evaluateAcceptanceCheck(plan.checks[3], { ...httpResult(plan.checks[3]), status: 503 }).passed, false));
await test("http marker rejected", () => assert.equal(evaluateAcceptanceCheck(plan.checks[3], { ...httpResult(plan.checks[3]), body: "wrong" }).passed, false));
await test("security header rejected", () => { const value = httpResult(plan.checks[3]); delete value.headers["x-frame-options"]; assert.equal(evaluateAcceptanceCheck(plan.checks[3], value).passed, false); });
await test("cross origin redirect rejected", () => assert.equal(evaluateAcceptanceCheck(plan.checks[3], { ...httpResult(plan.checks[3]), finalUrl: "https://evil.test/" }).passed, false));
await test("invalid final URL rejected", () => assert.equal(evaluateAcceptanceCheck(plan.checks[3], { ...httpResult(plan.checks[3]), finalUrl: "not-a-url" }).passed, false));
await test("missing function rejected", () => assert.equal(evaluateAcceptanceCheck(plan.checks[1], { code: 0, stdout: JSON.stringify({ result: [] }) }).passed, false));

let successfulReport;
await test("successful acceptance run", async () => { successfulReport = await runProductionAcceptance({ plan, deploymentEvidence, executor: async (check) => firebaseResult(check), httpProbe: async (check) => httpResult(check), now }); assert.equal(successfulReport.passed, true); assert.equal(successfulReport.checks.length, 9); });
await test("successful recovery acceptance run", async () => { const report = await runProductionAcceptance({ plan: recoveryPlan, deploymentEvidence: rollbackEvidence, executor: async (check) => firebaseResult(check), httpProbe: async (check) => httpResult(check), now, evidenceKind: "rollback" }); assert.equal(report.passed, true); assert.equal(report.sourceKind, "rollback"); assert.equal(report.releaseId, "v3.8.0"); });
await test("failed acceptance run", async () => { const report = await runProductionAcceptance({ plan, deploymentEvidence, executor: async (check) => firebaseResult(check), httpProbe: async (check) => check.key === "admin_app" ? { ...httpResult(check), status: 500 } : httpResult(check), now }); assert.equal(report.passed, false); assert.ok(report.checks.some((item) => !item.passed)); });
await test("observing after first pass", () => assert.equal(updateAcceptanceLedger(null, successfulReport, plan).status, "observing"));
await test("duplicate run not counted", () => { const first = updateAcceptanceLedger(null, successfulReport, plan); const second = updateAcceptanceLedger(first, { ...successfulReport, observedAt: "2026-07-14T10:02:00.000Z" }, plan); assert.equal(second.validPasses, 1); });
await test("accepted after three spaced passes", () => { const first = updateAcceptanceLedger(null, successfulReport, plan); const second = updateAcceptanceLedger(first, { ...successfulReport, observedAt: "2026-07-14T10:06:00.000Z" }, plan); const third = updateAcceptanceLedger(second, { ...successfulReport, observedAt: "2026-07-14T10:11:00.000Z" }, plan); assert.equal(third.status, "accepted"); assert.equal(third.validPasses, 3); });
await test("failure requires rollback", () => { const failed = { ...successfulReport, passed: false, checks: successfulReport.checks.map((item, index) => index ? item : { ...item, passed: false }) }; const ledger = updateAcceptanceLedger(null, failed, plan); assert.equal(ledger.status, "rollback_required"); assert.deepEqual(ledger.failedCheckKeys, [successfulReport.checks[0].key]); });
await test("new deployment resets ledger", () => { const first = updateAcceptanceLedger(null, successfulReport, plan); const report = { ...successfulReport, deploymentPlanFingerprint: "b".repeat(64), observedAt: "2026-07-14T10:06:00.000Z" }; assert.equal(updateAcceptanceLedger(first, report, plan).runs.length, 1); });
await test("invalid evidence blocks run", async () => { await assert.rejects(() => runProductionAcceptance({ plan, deploymentEvidence: { ...deploymentEvidence, status: "failed" }, executor: async () => ({}), httpProbe: async () => ({}), now }), /デプロイ証跡/u); });
await test("invalid rollback evidence blocks recovery", async () => { await assert.rejects(() => runProductionAcceptance({ plan: recoveryPlan, deploymentEvidence: { ...rollbackEvidence, status: "rollback_failed_locked" }, executor: async () => ({}), httpProbe: async () => ({}), now, evidenceKind: "rollback" }), /rollback証跡/u); });
await test("CLI preview", () => { const result = spawnSync(process.execPath, [resolve("scripts/run-production-acceptance.mjs"), "--config", "config-samples/production-acceptance.example.json", "--examples"], { cwd: process.cwd(), encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /外部通信なし/u); });
console.log(`production acceptance tests passed (${cases} cases)`);
