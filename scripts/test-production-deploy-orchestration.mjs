import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  approvalAcknowledgementKeys,
  buildProductionDeploymentPlan,
  createApprovalDraft,
  createRollbackPlan,
  projectListIncludesProject,
  runDeploymentWithExecutor,
  sanitizeCommandResult,
  validateProductionApproval,
  validateProductionDeployConfig,
} from "./production-deploy-core.mjs";

let cases = 0;
async function test(name, operation) {
  try { await operation(); cases += 1; }
  catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

const config = {
  appEnvironment: "production",
  projectId: "lip-knots-production",
  expectedNodeMajor: 22,
  deployScope: ["functions", "firestore", "storage", "hosting:staff", "hosting:admin"],
  staffAppUrl: "https://staff.lipknots.test",
  adminAppUrl: "https://admin.lipknots.test",
};
const now = new Date("2026-07-14T10:00:00.000Z");
const plan = buildProductionDeploymentPlan(config);
const approval = {
  ...createApprovalDraft(plan, new Date("2026-07-14T09:45:00.000Z")),
  approvedByEmail: "executive@lipknots.test",
  changeTicketId: "CHG-2026-0714",
  previousSourceCheckpointId: "release-v3.7.0",
  hostingRollbackSource: "lip-knots-staff@previous-version",
  acknowledgements: Object.fromEntries(approvalAcknowledgementKeys.map((key) => [key, true])),
};
const validationOptions = { now, allowedApproverEmails: ["executive@lipknots.test"] };

await test("valid config", () => assert.deepEqual(validateProductionDeployConfig(config), []));
await test("deterministic fingerprint", () => assert.equal(buildProductionDeploymentPlan(structuredClone(config)).fingerprint, plan.fingerprint));
await test("fingerprint length", () => assert.match(plan.fingerprint, /^[a-f0-9]{64}$/u));
await test("stage order", () => assert.deepEqual(plan.stages.map((item) => item.key), ["rules_and_storage", "functions", "hosting"]));
await test("exact deploy scopes", () => assert.deepEqual(plan.stages.map((item) => item.args[2]), ["firestore,storage", "functions", "hosting:staff,hosting:admin"]));
await test("valid approval", () => assert.equal(validateProductionApproval(approval, plan, validationOptions).valid, true));

const configRejections = [
  ["environment", (value) => { value.appEnvironment = "staging"; }],
  ["project", (value) => { value.projectId = "BAD PROJECT"; }],
  ["node", (value) => { value.expectedNodeMajor = 20; }],
  ["scope missing", (value) => { value.deployScope = ["functions"]; }],
  ["scope extra", (value) => { value.deployScope.push("database"); }],
  ["http staff", (value) => { value.staffAppUrl = "http://staff.lipknots.test"; }],
  ["url collision", (value) => { value.adminAppUrl = value.staffAppUrl; }],
  ["secret", (value) => { value.accessToken = "never"; }],
];
for (const [name, mutate] of configRejections) await test(`reject config ${name}`, () => { const value = structuredClone(config); mutate(value); assert.ok(validateProductionDeployConfig(value).length > 0); });

const approvalRejections = [
  ["schema", (value) => { value.schemaVersion = 2; }],
  ["release", (value) => { value.releaseId = "v3.7.0"; }],
  ["project", (value) => { value.projectId = "other-production"; }],
  ["fingerprint", (value) => { value.planFingerprint = "a".repeat(64); }],
  ["scope", (value) => { value.deployScope = ["functions"]; }],
  ["email", (value) => { value.approvedByEmail = "bad"; }],
  ["allowlist", (value) => { value.approvedByEmail = "other@lipknots.test"; }],
  ["ticket", (value) => { value.changeTicketId = "!"; }],
  ["checkpoint", (value) => { value.previousSourceCheckpointId = ""; }],
  ["hosting source", (value) => { value.hostingRollbackSource = ""; }],
  ["expired", (value) => { value.expiresAt = "2026-07-14T09:59:59.000Z"; }],
  ["future", (value) => { value.approvedAt = "2026-07-14T10:02:00.000Z"; value.expiresAt = "2026-07-14T10:20:00.000Z"; }],
  ["long window", (value) => { value.expiresAt = "2026-07-14T10:20:01.000Z"; }],
  ["ack", (value) => { value.acknowledgements.backupVerified = false; }],
];
for (const [name, mutate] of approvalRejections) await test(`reject approval ${name}`, () => { const value = structuredClone(approval); mutate(value); assert.equal(validateProductionApproval(value, plan, validationOptions).valid, false); });

await test("project list result", () => assert.equal(projectListIncludesProject({ code: 0, stdout: JSON.stringify({ result: [{ projectId: config.projectId }] }) }, config.projectId), true));
await test("project list reject", () => assert.equal(projectListIncludesProject({ code: 0, stdout: JSON.stringify({ result: [{ projectId: "other" }] }) }, config.projectId), false));
await test("evidence redaction", () => { const value = sanitizeCommandResult({ code: 1, stdout: "access_token=abc123 Bearer secret.token", stderr: "" }); assert.doesNotMatch(value.stdout, /abc123|secret\.token/u); });
await test("rollback plan", () => { const value = createRollbackPlan({ plan, approval, failedStageKey: "functions" }); assert.equal(value.failedStageKey, "functions"); assert.equal(value.recovery.length, 3); });

await test("successful orchestration", async () => {
  const calls = [];
  const executor = async (step) => { calls.push(step.key); return step.key === "project_access" ? { code: 0, stdout: JSON.stringify({ result: [{ projectId: config.projectId }] }), stderr: "" } : { code: 0, stdout: "{}", stderr: "" }; };
  const result = await runDeploymentWithExecutor({ plan, approval, confirmFingerprint: plan.fingerprint, executor, httpProbe: async (step) => { calls.push(step.key); return { code: 0, stdout: "200", stderr: "" }; }, allowedApproverEmails: validationOptions.allowedApproverEmails, now });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(calls, ["project_access", "rules_and_storage", "functions", "hosting", "functions_inventory", "hosting_inventory", "staff_https", "admin_https"]);
});

await test("failure stops later stages", async () => {
  const calls = [];
  const executor = async (step) => { calls.push(step.key); if (step.key === "project_access") return { code: 0, stdout: JSON.stringify({ result: [{ projectId: config.projectId }] }), stderr: "" }; return { code: step.key === "functions" ? 1 : 0, stdout: "{}", stderr: "failure" }; };
  const result = await runDeploymentWithExecutor({ plan, approval, confirmFingerprint: plan.fingerprint, executor, httpProbe: async () => ({ code: 0 }), allowedApproverEmails: validationOptions.allowedApproverEmails, now });
  assert.equal(result.status, "failed");
  assert.equal(result.failedStageKey, "functions");
  assert.deepEqual(calls, ["project_access", "rules_and_storage", "functions"]);
});

await test("access failure stops deploy", async () => {
  const calls = [];
  const result = await runDeploymentWithExecutor({ plan, approval, confirmFingerprint: plan.fingerprint, executor: async (step) => { calls.push(step.key); return { code: 0, stdout: JSON.stringify({ result: [] }), stderr: "" }; }, httpProbe: async () => ({ code: 0 }), allowedApproverEmails: validationOptions.allowedApproverEmails, now });
  assert.equal(result.failedStageKey, "project_access");
  assert.deepEqual(calls, ["project_access"]);
});

await test("postcheck failure is recorded", async () => {
  const executor = async (step) => step.key === "project_access" ? { code: 0, stdout: JSON.stringify({ result: [{ projectId: config.projectId }] }), stderr: "" } : { code: step.key === "hosting_inventory" ? 1 : 0, stdout: "{}", stderr: "" };
  const result = await runDeploymentWithExecutor({ plan, approval, confirmFingerprint: plan.fingerprint, executor, httpProbe: async () => ({ code: 0 }), allowedApproverEmails: validationOptions.allowedApproverEmails, now });
  assert.equal(result.failedStageKey, "hosting_inventory");
});

await test("fingerprint confirmation required", async () => {
  await assert.rejects(() => runDeploymentWithExecutor({ plan, approval, confirmFingerprint: "bad", executor: async () => ({ code: 0 }), httpProbe: async () => ({ code: 0 }), allowedApproverEmails: validationOptions.allowedApproverEmails, now }), /確認指紋/u);
});

await test("CLI preview has no deploy", async () => {
  const cli = resolve("scripts/deploy-production.mjs");
  const result = spawnSync(process.execPath, [cli, "--config", "config-samples/production-deploy.example.json", "--examples"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /外部変更なし/u);
  assert.doesNotMatch(result.stdout, /PRODUCTION DEPLOY: SUCCEEDED/u);
});

await test("example approval contains false gates", async () => {
  const example = JSON.parse(await readFile("config-samples/production-deploy-approval.example.json", "utf8"));
  const exampleConfig = JSON.parse(await readFile("config-samples/production-deploy.example.json", "utf8"));
  assert.equal(Object.values(example.acknowledgements).every((value) => value === false), true);
  assert.equal(example.planFingerprint, buildProductionDeploymentPlan(exampleConfig, { allowPlaceholders: true }).fingerprint);
});

console.log(`production deploy orchestration tests passed (${cases} cases)`);
