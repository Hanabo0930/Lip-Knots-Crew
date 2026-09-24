import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import http from "node:http";
import https from "node:https";
import { PROJECT, REGION, TARGET, FUNCTION, SERVICE, JOB, assertRecoveryBefore, assertExistingInvoker, assertServiceAgentConfiguration,
  assertRecoveryPlan, assertReadyFunction, assertReadyService, assertScheduler, installRecoveryAdapters } from "./retry-worker-recovery-core.mjs";
import { loadRecoveryModules, recoveryReader, verifyRecoveryAfter, runRetryWorkerRecovery } from "./run-retry-worker-recovery.mjs";
const require = createRequire(import.meta.url), root = fileURLToPath(new URL("../../", import.meta.url));
const cliRoot = path.dirname(require.resolve("firebase-tools/package.json"));
let network = 0, cases = 0;
http.request = https.request = globalThis.fetch = () => { network++; throw Error("NETWORK_NOT_ALLOWED"); };
const native = loadRecoveryModules(cliRoot);
assert.equal(require(path.join(cliRoot, "package.json")).version, "15.24.0");
const clone = value => structuredClone(value);
const context = {projectNumber: "123456789012", identity: "123456789012-compute@developer.gserviceaccount.com", sourceSha: "a".repeat(40)};
const env = {APP_ENVIRONMENT: "staging", EXPECTED_FIREBASE_PROJECT_ID: PROJECT, LKC_SHEET_WRITE_MODE: "paused", LKC_NOTIFICATION_DELIVERY_MODE: "paused"};
const agents = [
  {api: "pubsub.googleapis.com", suffix: "gcp-sa-pubsub", role: "roles/pubsub.serviceAgent"},
  {api: "eventarc.googleapis.com", suffix: "gcp-sa-eventarc", role: "roles/eventarc.serviceAgent"},
  {api: "cloudscheduler.googleapis.com", suffix: "gcp-sa-cloudscheduler", role: "roles/cloudscheduler.serviceAgent"},
];
const enabledServices = agents.map(a => ({config: {name: a.api}, state: "ENABLED"}));
const agentEmail = a => `service-${context.projectNumber}@${a.suffix}.iam.gserviceaccount.com`;
const agentBinding = a => ({role: a.role, members: [`serviceAccount:${agentEmail(a)}`]});
const policy = {bindings: [{role: "roles/run.invoker", members: [`serviceAccount:${context.identity}`]}, ...agents.map(agentBinding)]};
const endpoint = {id: TARGET, project: PROJECT, region: REGION, platform: "gcfv2", runtime: "nodejs22", entryPoint: TARGET,
  timeoutSeconds: 300, scheduleTrigger: {schedule: "every 5 minutes", timeZone: "Asia/Tokyo"}, environmentVariables: env, serviceAccount: context.identity};
const plan = {default: {regionalChangesets: {one: {endpointsToCreate: [], endpointsToDelete: [], endpointsToSkip: [], endpointsToUpdate: [{endpoint, unsafe: false}]}}}};
const fn = {name: FUNCTION, state: "ACTIVE", environment: "GEN_2", buildConfig: {runtime: "nodejs22", entryPoint: TARGET},
  serviceConfig: {service: SERVICE, serviceAccountEmail: context.identity, revision: "retrysafesheetwrites-00002-abc", uri: "https://retrysafesheetwrites-synthetic-an.a.run.app", timeoutSeconds: 300, environmentVariables: env}};
const service = {metadata: {name: "retrysafesheetwrites", annotations: {}}, status: {latestReadyRevisionName: fn.serviceConfig.revision,
  latestCreatedRevisionName: fn.serviceConfig.revision, url: fn.serviceConfig.uri, conditions: [{type: "Ready", status: "True"}], traffic: [{revisionName: fn.serviceConfig.revision, percent: 100}]},
  spec: {template: {spec: {serviceAccountName: context.identity, containers: [{env: Object.entries(env).map(([name, value]) => ({name, value}))}]}}}};
const job = {name: JOB, state: "ENABLED", schedule: "every 5 minutes", timeZone: "Asia/Tokyo", httpTarget: {uri: fn.serviceConfig.uri, httpMethod: "POST", oidcToken: {serviceAccountEmail: context.identity}}};
const before = {...context, fn: {...fn, state: "FAILED", serviceConfig: {}}, service: null, job: null, projectPolicy: policy};
async function test(name, callback) { try { await callback(); cases++; } catch (error) { throw Error(name + ": " + error.message); } }
await test("missing recovery baseline", () => assertRecoveryBefore(before));
// Scheduler APIが付与するルート末尾の / を、別パスへの許可と区別する。
await test("Scheduler API root slash response passes read-only verification", async () => {
  const h = harness(); h.state.job = clone(job);
  h.state.job.httpTarget.uri += "/";
  h.state.job.httpTarget.oidcToken.audience = h.state.job.httpTarget.uri;
  const result = await verifyRecoveryAfter(h.read, context);
  assert.equal(result.retryRecovery, "paused-configuration-verified");
  assert.equal(h.state.updates, 0); assert.equal(h.state.schedulers, 0); assert.equal(h.state.forbidden, 0);
});
for (const suffix of ["//", "/other", "/../", "/?x=1", "/#fragment", ":443/", ".other.invalid/", "/%2f", "\\", " "]) {
  await test("Scheduler rejects non-root or rewritten destination " + suffix, () => {
    const value = clone(job); value.httpTarget.uri += suffix;
    value.httpTarget.oidcToken.audience = value.httpTarget.uri;
    assert.throws(() => assertScheduler(value, fn, context, true), /RETRY_SCHEDULER_NOT_VERIFIED/);
  });
}
await test("Scheduler root slash keeps exact audience requirement", () => {
  const value = clone(job); value.httpTarget.uri += "/";
  value.httpTarget.oidcToken.audience = fn.serviceConfig.uri;
  assert.throws(() => assertScheduler(value, fn, context, true), /RETRY_SCHEDULER_NOT_VERIFIED/);
});
await test("Scheduler rejects credentials even for the same hostname", () => {
  const value = clone(job); value.httpTarget.uri = value.httpTarget.uri.replace("https://", "https://user@");
  value.httpTarget.oidcToken.audience = value.httpTarget.uri;
  assert.throws(() => assertScheduler(value, fn, context, true), /RETRY_SCHEDULER_NOT_VERIFIED/);
});

for (const mutate of [x => x.fn.state = "ACTIVE", x => x.fn.name += "other", x => x.fn.buildConfig.runtime = "nodejs20", x => x.fn.environment = "GEN_1", x => x.fn.serviceConfig.revision = "old", x => x.service = {}, x => x.job = {}, x => x.projectNumber = "other", x => x.identity = "other@example.invalid", x => x.projectPolicy.bindings = []]) {
  await test("reject mismatched baseline", () => { const x = clone(before); mutate(x); assert.throws(() => assertRecoveryBefore(x)); });
}
for (const p of [{}, {bindings: []}, {bindings: [{...policy.bindings[0], condition: {expression: "true"}}]}, {bindings: [{role: "roles/viewer", members: policy.bindings[0].members}]}, {bindings: [...policy.bindings, {members: ["allUsers"]}]}]) {
  await test("reject unknown, conditional or public IAM", () => assert.throws(() => assertExistingInvoker(p, context.identity)));
}
await test("update-only native plan", () => assertRecoveryPlan(plan, context));
for (const mutate of [x => x.extra = x.default, x => x.default.rolesToAdd = ["roles/owner"], x => x.default.rolesToRemove = ["x"], x => x.default.serviceAccountToCreate = "x", x => x.default.serviceAccountToDelete = "x", x => x.default.regionalChangesets.two = x.default.regionalChangesets.one,
  x => x.default.regionalChangesets.one.endpointsToCreate = [endpoint], x => x.default.regionalChangesets.one.endpointsToDelete = [endpoint], x => x.default.regionalChangesets.one.endpointsToSkip = [endpoint], x => x.default.regionalChangesets.one.endpointsToUpdate.push({endpoint}),
  x => x.default.regionalChangesets.one.endpointsToUpdate[0].deleteAndRecreate = endpoint, x => x.default.regionalChangesets.one.endpointsToUpdate[0].unsafe = true,
  x => x.default.regionalChangesets.one.endpointsToUpdate[0].endpoint.id = "processSafeSheetWrite", x => x.default.regionalChangesets.one.endpointsToUpdate[0].endpoint.environmentVariables.LKC_SHEET_WRITE_MODE = "active",
  x => x.default.regionalChangesets.one.endpointsToUpdate[0].endpoint.httpsTrigger = {}, x => x.default.regionalChangesets.one.endpointsToUpdate[0].endpoint.scheduleTrigger.schedule = "every 1 minutes",
  x => x.default.regionalChangesets.one.endpointsToUpdate[0].endpoint.serviceAccount = "other@example.invalid"]) {
  await test("reject broad native plan", () => { const x = clone(plan); mutate(x); assert.throws(() => assertRecoveryPlan(x, context)); });
}
function harness() {
  const modules = Object.fromEntries(Object.entries(native).map(([key, object]) => [key, typeof object === "function" ? object : Object.fromEntries(Object.getOwnPropertyNames(object).map(k => [k, object[k]]))]));
  const state = {updates: 0, schedulers: 0, iamWrites: 0, forbidden: 0, policy: clone(policy), enabledServices: clone(enabledServices), directGets: 0, fn: clone(fn), service: clone(service), job: null};
  for (const [key, names] of Object.entries({run: ["setInvokerCreate", "setInvokerUpdate", "setIamPolicy", "updateService", "replaceService"], resourceManager: ["setIamPolicy", "addServiceAccountToRoles", "addServiceAccountRoles", "removeServiceAccountRoles"], iam: ["createServiceAccount", "deleteServiceAccount", "createServiceAccountKey"], serviceUsage: ["generateServiceIdentity", "generateServiceIdentityAndPoll"], artifacts: ["setCleanupPolicy", "setCleanupPolicies", "updateRepository", "optOutRepository"], gcf: ["createFunction", "deleteFunction"], scheduler: ["deleteJob"]})) {
    for (const name of names) modules[key][name] = async () => { state.forbidden++; if (/Iam|Invoker/.test(name)) state.iamWrites++; };
  }
  modules.ensureApi.check = async () => state.apiEnabled ?? true;
  modules.iam.getServiceAccount = async () => { state.directGets++; throw Error("DIRECT_SERVICE_AGENT_GET_FORBIDDEN"); };
  modules.gcf.updateFunction = async () => { state.updates++; return {name: "synthetic-operation"}; };
  modules.scheduler.createOrReplaceJob = async () => { state.forbidden++; };
  modules.createScheduler = async value => { if (state.schedulerConflict) throw Error("SCHEDULER_ALREADY_EXISTS_AT_CREATE"); state.schedulers++; state.job = {...value, state: "ENABLED"}; };
  const read = {fn: async () => state.fn, service: async () => state.service, job: async () => state.job,
    projectPolicy: async () => { if (state.policyReadError) throw Error("RETRY_METADATA_READ_FAILED"); return state.policy; },
    enabledServices: async () => { if (state.apiReadError) throw Error("RETRY_METADATA_READ_FAILED"); return state.enabledServices; },
    assertPrivateService: async () => { if (state.public) throw Error("RETRY_PUBLIC_BINDING_FOUND"); }};
  modules.fabricator.applyPlan = async function(value) {
    const ep = value.default.regionalChangesets.one.endpointsToUpdate[0].endpoint;
    // 実固定CLIの変換を使い、合成の送信先だけを差し替える。
    const apiFunction = native.gcf.functionFromEndpoint(ep);
    await modules.gcf.updateFunction(apiFunction);
    await modules.run.setInvokerUpdate(PROJECT, SERVICE, [context.identity]);
    const scheduled = await native.scheduler.jobFromEndpoint({...ep, uri: fn.serviceConfig.uri}, REGION, context.projectNumber);
    await modules.scheduler.createOrReplaceJob(scheduled);
    return {results: []};
  };
  const status = installRecoveryAdapters(modules, context, read);
  return {modules, state, read, status};
}
// 実SDKのmanifestと固定CLI変換を通し、手作りendpointだけでは見逃した空設定を検証する。
await test("real SDK empty schedule retry config survives pinned CLI discovery", async () => {
  let invoked = 0;
  const {onSchedule} = require("firebase-functions/v2/scheduler");
  const sdk = onSchedule({schedule: "every 5 minutes", timeZone: "Asia/Tokyo", timeoutSeconds: 300, region: REGION}, async () => { invoked++; });
  const {buildFromV1Alpha1} = require(path.join(cliRoot, "lib/deploy/functions/runtimes/discovery/v1alpha1.js"));
  const {toBackend} = require(path.join(cliRoot, "lib/deploy/functions/build.js"));
  const manifest = {specVersion: "v1alpha1", endpoints: {[TARGET]: {...sdk.__endpoint, entryPoint: TARGET, environmentVariables: env}}};
  const backend = toBackend(buildFromV1Alpha1(manifest, PROJECT, REGION, "nodejs22"), {});
  const actual = backend.endpoints[REGION][TARGET];
  assert.deepEqual(actual.scheduleTrigger.retryConfig, {});
  const candidate = clone(plan); candidate.default.regionalChangesets.one.endpointsToUpdate[0].endpoint = actual;
  assertRecoveryPlan(candidate, context);
  const h = harness(); await h.modules.fabricator.applyPlan(candidate); h.status.assertCompleted();
  assert.equal(h.state.updates, 1); assert.equal(h.state.schedulers, 1); assert.equal(h.state.forbidden, 0);
  assert.equal(h.state.job.retryConfig, undefined); assert.equal(invoked, 0);
});
for (const retryConfig of [null, [], 0, false, "", {retryCount: 0}, {retryCount: 3}, {minBackoffSeconds: 5}, {unknown: true}]) {
  await test("configured or malformed schedule retry remains rejected", async () => {
    const candidate = clone(plan); candidate.default.regionalChangesets.one.endpointsToUpdate[0].endpoint.scheduleTrigger.retryConfig = retryConfig;
    const h = harness(); await assert.rejects(h.modules.fabricator.applyPlan(candidate), /RETRY_ENDPOINT_SCOPE_INVALID/);
    assert.equal(h.state.updates, 0); assert.equal(h.state.schedulers, 0);
  });
}
await test("unknown schedule key remains rejected beside empty retry", () => {
  const candidate = clone(plan); Object.assign(candidate.default.regionalChangesets.one.endpointsToUpdate[0].endpoint.scheduleTrigger, {retryConfig: {}, unknown: true});
  assert.throws(() => assertRecoveryPlan(candidate, context), /RETRY_ENDPOINT_SCOPE_INVALID/);
});
await test("execute paused recovery without IAM writes", async () => { const h = harness(); await h.modules.fabricator.applyPlan(clone(plan)); h.status.assertCompleted(); const result = await verifyRecoveryAfter(h.read, context); assert.equal(result.iamWritten, false); assert.equal(h.state.updates, 1); assert.equal(h.state.schedulers, 1); assert.equal(h.state.forbidden, 0); });
for (const [key, method] of [["run", "setIamPolicy"], ["run", "updateService"], ["run", "replaceService"], ["gcf", "createFunction"], ["gcf", "deleteFunction"], ["scheduler", "deleteJob"], ["resourceManager", "setIamPolicy"], ["resourceManager", "addServiceAccountToRoles"], ["iam", "createServiceAccount"], ["iam", "createServiceAccountKey"], ["artifacts", "setCleanupPolicy"]]) {
  await test("deny " + method, async () => { const h = harness(); await assert.rejects(h.modules[key][method](), /UNAUTHORIZED_CLOUD_MUTATION/); assert.equal(h.state.forbidden, 0); });
}
await test("abort before any update when IAM vanished", async () => { const h = harness(); h.state.policy = {bindings: []}; await assert.rejects(h.modules.fabricator.applyPlan(plan), /EXISTING_INVOKER_REQUIRED/); assert.equal(h.state.updates, 0); });
await test("reject scheduler before Function", async () => { const h = harness(); await assert.rejects(h.modules.scheduler.createOrReplaceJob(job), /FUNCTION_UPDATE_REQUIRED/); assert.equal(h.state.schedulers, 0); });
await test("reject update before plan", async () => { const h = harness(); await assert.rejects(h.modules.gcf.updateFunction(fn), /PLAN_REQUIRED/); assert.equal(h.state.updates, 0); });
await test("refuse existing Scheduler overwrite", async () => { const h = harness(); h.state.job = job; await assert.rejects(h.modules.fabricator.applyPlan(plan), /SCHEDULER_ALREADY_EXISTS/); assert.equal(h.state.schedulers, 0); });
await test("concurrent Scheduler creation cannot overwrite", async () => { const h = harness(); h.state.schedulerConflict = true; await assert.rejects(h.modules.fabricator.applyPlan(plan), /ALREADY_EXISTS_AT_CREATE/); assert.equal(h.state.schedulers, 0); assert.equal(h.state.forbidden, 0); });
await test("private Run check gates Scheduler", async () => { const h = harness(); h.state.public = true; await assert.rejects(h.modules.fabricator.applyPlan(plan), /PUBLIC_BINDING_FOUND/); assert.equal(h.state.schedulers, 0); });
await test("missing API is not enabled", async () => { const h = harness(); h.state.apiEnabled = false; await assert.rejects(h.modules.ensureApi.ensure(PROJECT, "run.googleapis.com"), /API_ENABLEMENT_NOT_ALLOWED/); assert.equal(h.state.forbidden, 0); });
await test("best effort cannot enable missing API", async () => { const h = harness(); h.state.apiEnabled = false; await assert.rejects(h.modules.ensureApi.bestEffortEnsure(PROJECT, "run.googleapis.com"), /API_ENABLEMENT_NOT_ALLOWED/); });
await test("agent generation uses configuration without direct get", async () => {
  const h = harness();
  for (const a of agents.slice(0, 2)) {
    assert.deepEqual(await h.modules.serviceUsage.generateServiceIdentity(context.projectNumber, a.api), {done: true, response: {email: agentEmail(a)}});
    assert.equal(await h.modules.serviceUsage.generateServiceIdentityAndPoll(context.projectNumber, a.api), undefined);
  }
  assert.equal(h.state.directGets, 0); assert.equal(h.state.forbidden, 0);
});
await test("missing agent binding rejected", async () => { const h = harness(); h.state.policy.bindings.splice(1, 1); await assert.rejects(h.modules.serviceUsage.generateServiceIdentity(context.projectNumber, "pubsub.googleapis.com"), /SERVICE_AGENT_BINDING_REQUIRED/); });
// すべて合成値。Google管理エージェントを直接getできなくても、構成照合は可能。
for (const a of agents) {
  await test(`exact ${a.api} configuration`, () => assert.equal(assertServiceAgentConfiguration(policy, enabledServices, context, a.api), agentEmail(a)));
  for (const [name, mutate] of [
    ["missing", b => b.members = []],
    ["wrong role", b => b.role = "roles/viewer"],
    ["wrong project", b => b.members = b.members.map(m => m.replace(context.projectNumber, "999999999999"))],
    ["wrong principal type", b => b.members = b.members.map(m => m.replace("serviceAccount:", "user:"))],
    ["deleted", b => b.members = b.members.map(m => `deleted:${m}?uid=123`)],
    ["conditional", b => b.condition = {expression: "true"}],
    ["unknown condition", b => b.condition = null],
    ["malformed members", b => b.members = "unknown"],
  ]) {
    await test(`${a.api} rejects ${name} binding`, () => {
      const value = clone(policy); mutate(value.bindings.find(b => b.role === a.role));
      assert.throws(() => assertServiceAgentConfiguration(value, enabledServices, context, a.api), /SERVICE_AGENT_/);
    });
  }
  await test(`${a.api} rejects live and deleted bindings together`, () => {
    const value = clone(policy); value.bindings.push({role: "roles/viewer", members: [`deleted:serviceAccount:${agentEmail(a)}?uid=123`]});
    assert.throws(() => assertServiceAgentConfiguration(value, enabledServices, context, a.api), /DELETED_BINDING/);
  });
  await test(`${a.api} requires API enabled even with correct IAM`, () => {
    for (const value of [enabledServices.filter(s => s.config.name !== a.api), enabledServices.map(s => s.config.name === a.api ? {...s, state: "DISABLED"} : s), [...enabledServices, {config: {name: a.api}, state: "ENABLED"}]]) {
      assert.throws(() => assertServiceAgentConfiguration(policy, value, context, a.api), /SERVICE_AGENT_API_REQUIRED/);
    }
  });
}
for (const value of [null, {}, {bindings: null}, {bindings: [null]}, {bindings: [{role: "roles/viewer", members: [null]}]}]) {
  await test("unknown service agent policy never passes", () => assert.throws(() => assertServiceAgentConfiguration(value, enabledServices, context, agents[0].api), /SERVICE_AGENT_POLICY_UNKNOWN/));
}
for (const value of [null, {}, [null], [{config: {name: agents[0].api}}]]) {
  await test("unknown API state never passes", () => assert.throws(() => assertServiceAgentConfiguration(policy, value, context, agents[0].api), /SERVICE_API_STATE_UNKNOWN/));
}
for (const [number, api] of [["999", agents[0].api], [context.projectNumber, "unknown.googleapis.com"], [context.projectNumber, agents[2].api], [context.projectNumber, "toString"]]) {
  await test("generation request stays limited to two fixed APIs", async () => {
    const h = harness(); await assert.rejects(h.modules.serviceUsage.generateServiceIdentity(number, api), /PROJECT_NUMBER_MISMATCH|SERVICE_AGENT_SCOPE_INVALID/);
    assert.equal(h.state.directGets, 0); assert.equal(h.state.forbidden, 0);
  });
}
for (const error of ["policyReadError", "apiReadError"]) {
  await test(`${error} never falls back to agent creation`, async () => {
    const h = harness(); h.state[error] = true;
    await assert.rejects(h.modules.serviceUsage.generateServiceIdentity(context.projectNumber, agents[0].api), /METADATA_READ_FAILED/);
    assert.equal(h.state.directGets, 0); assert.equal(h.state.forbidden, 0);
  });
}
await test("cached CLI API success cannot bypass fresh disabled API", async () => {
  const h = harness(); h.state.apiEnabled = true; h.state.enabledServices = [];
  await assert.rejects(h.modules.fabricator.applyPlan(clone(plan)), /SERVICE_AGENT_API_REQUIRED/);
  assert.equal(h.state.updates, 0); assert.equal(h.state.schedulers, 0); assert.equal(h.state.forbidden, 0);
});
for (const a of agents) {
  await test(`missing ${a.api} role blocks plan before writes`, async () => {
    const h = harness(); h.state.policy.bindings = h.state.policy.bindings.filter(b => b.role !== a.role);
    await assert.rejects(h.modules.fabricator.applyPlan(clone(plan)), /SERVICE_AGENT_BINDING_REQUIRED/);
    assert.equal(h.state.updates, 0); assert.equal(h.state.schedulers, 0);
  });
}
await test("role loss after plan blocks Function update", async () => {
  const h = harness(); await h.modules.fabricator.applyPlan(clone(plan));
  h.state.policy.bindings = h.state.policy.bindings.filter(b => b.role !== agents[1].role);
  await assert.rejects(h.modules.gcf.updateFunction(fn), /SERVICE_AGENT_BINDING_REQUIRED/);
  assert.equal(h.state.updates, 1);
});
await test("scheduler role loss blocks scheduler write", async () => {
  const h = harness(); await h.modules.fabricator.applyPlan(clone(plan));
  h.state.policy.bindings = h.state.policy.bindings.filter(b => b.role !== agents[2].role);
  await assert.rejects(h.modules.scheduler.createOrReplaceJob(job), /SERVICE_AGENT_BINDING_REQUIRED/);
  assert.equal(h.state.schedulers, 1);
});
await test("configuration loss blocks successful final verification", async () => {
  const h = harness(); await h.modules.fabricator.applyPlan(clone(plan)); h.state.enabledServices = [];
  await assert.rejects(verifyRecoveryAfter(h.read, context), /SERVICE_AGENT_API_REQUIRED/);
});
await test("final result explicitly limits service agent proof", async () => {
  const h = harness(); await h.modules.fabricator.applyPlan(clone(plan));
  assert.equal((await verifyRecoveryAfter(h.read, context)).serviceAgents, "api-and-role-bindings-only");
});
await test("API reader uses uncached fixed project state", () => {
  let call;
  const read = recoveryReader(args => { call = args; return JSON.stringify(enabledServices); });
  assert.deepEqual(read.enabledServices(), enabledServices);
  assert.deepEqual(call, ["services", "list", "--enabled", `--project=${PROJECT}`, "--format=json(config.name,state)"]);
});
for (const stderr of ["PERMISSION_DENIED", "NOT_FOUND", "UNAUTHENTICATED"]) {
  await test("API read failure remains failure", () => assert.throws(() => recoveryReader(() => { throw {stderr}; }).enabledServices(), /METADATA_READ_FAILED/));
}
await test("default identity never guessed", async () => { const h = harness(); assert.equal(await h.modules.compute.getDefaultServiceAccount(context.projectNumber), context.identity); await assert.rejects(h.modules.compute.getDefaultServiceAccount("999"), /PROJECT_NUMBER_MISMATCH/); });
await test("invoker cannot run before verified plan", async () => { const h = harness(); await assert.rejects(h.modules.run.setInvokerUpdate(PROJECT, SERVICE, [context.identity]), /INVOKER_REQUEST_INVALID/); assert.equal(h.state.iamWrites, 0); });
for (const args of [["other", SERVICE, [context.identity]], [PROJECT, SERVICE + "other", [context.identity]], [PROJECT, SERVICE, ["public"]], [PROJECT, SERVICE, ["private"]], [PROJECT, SERVICE, [context.identity, "other"]]]) {
  await test("reject unexpected Invoker request", async () => { const h = harness(); await h.modules.fabricator.applyPlan(clone(plan)); await assert.rejects(h.modules.run.setInvokerUpdate(...args), /INVOKER_REQUEST_INVALID/); await assert.rejects(h.modules.run.setInvokerCreate(...args), /INVOKER_REQUEST_INVALID/); assert.equal(h.state.iamWrites, 0); });
}
await test("invoker policy rechecked after update", async () => { const h = harness(); await h.modules.fabricator.applyPlan(clone(plan)); h.state.policy = {bindings: []}; await assert.rejects(h.modules.run.setInvokerUpdate(PROJECT, SERVICE, [context.identity]), /EXISTING_INVOKER_REQUIRED/); assert.equal(h.state.iamWrites, 0); });
await test("active API payload rejected before second write", async () => { const h = harness(); await h.modules.fabricator.applyPlan(clone(plan)); const value = clone(fn); value.serviceConfig.environmentVariables.LKC_SHEET_WRITE_MODE = "active"; await assert.rejects(h.modules.gcf.updateFunction(value), /PAUSE_REQUIRED/); assert.equal(h.state.updates, 1); });
await test("second native plan refused", async () => { const h = harness(); await h.modules.fabricator.applyPlan(clone(plan)); await assert.rejects(h.modules.fabricator.applyPlan(clone(plan)), /PLAN_ALREADY_APPLIED/); assert.equal(h.state.updates, 1); });
await test("other API project refused", async () => { const h = harness(); await assert.rejects(h.modules.ensureApi.ensure("other", "run.googleapis.com"), /API_PROJECT_MISMATCH/); });
await test("real Scheduler client uses create, never patch", async () => {
  const {Client} = require(path.join(cliRoot, "lib/apiv2.js")); const post = Client.prototype.post; let called = 0;
  Client.prototype.post = async function(url, body) { assert.equal(url, `/projects/${PROJECT}/locations/${REGION}/jobs`); assert.equal(body.name, JOB); called++; return {status: 200}; };
  try { await native.createScheduler(job); assert.equal(called, 1); } finally { Client.prototype.post = post; }
});
await test("missing phase never succeeds", () => assert.throws(() => harness().status.assertCompleted(), /RECOVERY_INCOMPLETE/));
for (const mutate of [x => x.state = "FAILED", x => x.serviceConfig.environmentVariables.LKC_SHEET_WRITE_MODE = "active", x => x.serviceConfig.serviceAccountEmail = "other", x => x.serviceConfig.service += "other", x => x.serviceConfig.uri = "http://unsafe.invalid"]) {
  await test("reject bad postdeploy Function", () => { const x = clone(fn); mutate(x); assert.throws(() => assertReadyFunction(x, context)); });
}
for (const mutate of [x => x.metadata.annotations["run.googleapis.com/invoker-iam-disabled"] = "true", x => x.status.traffic[0].percent = 99, x => x.status.url = "https://other.run.app", x => x.metadata.annotations["run.googleapis.com/invoker-iam-disabled"] = true, x => x.status.latestReadyRevisionName = "old", x => x.spec.template.spec.serviceAccountName = "other", x => x.spec.template.spec.containers[0].env.push({name: "LKC_SHEET_WRITE_MODE", value: "active"})]) {
  await test("reject bad postdeploy Run", () => { const x = clone(service); mutate(x); assert.throws(() => assertReadyService(x, fn, context)); });
}
for (const mutate of [x => x.name += "other", x => x.httpTarget.uri += "/other", x => x.httpTarget.oidcToken.serviceAccountEmail = "other", x => x.httpTarget.oidcToken.audience = "other", x => x.httpTarget.httpMethod = "GET", x => x.httpTarget.oauthToken = {}, x => x.state = "DISABLED"]) {
  await test("reject bad postdeploy Scheduler", () => { const x = clone(job); mutate(x); assert.throws(() => assertScheduler(x, fn, context, true)); });
}
await test("read errors do not become missing", () => { for (const stderr of ["PERMISSION_DENIED", "UNAUTHENTICATED NOT_FOUND", "unrelated failure"]) assert.throws(() => recoveryReader(() => { throw {stderr}; }).job(), /METADATA_READ_FAILED/); });
await test("exact absent Run accepted", () => assert.equal(recoveryReader(() => { throw {stderr: "ERROR: (gcloud.run.services.describe) Cannot find service [retrysafesheetwrites]."}; }).service(), null));
await test("missing Scheduler accepted", () => assert.equal(recoveryReader(() => { throw {stderr: "ERROR: (gcloud.scheduler.jobs.describe) NOT_FOUND: requested job not found"}; }).job(), null));
await test("all reads fixed project and no writes", () => { const calls = [], read = recoveryReader(args => { calls.push(args); return args[0] === "projects" && args[1] === "describe" ? JSON.stringify({projectId: PROJECT, projectNumber: context.projectNumber}) : args[0] === "compute" ? JSON.stringify({defaultServiceAccount: context.identity}) : "{}"; }); read.before(); read.assertPrivateService(); assert.ok(calls.every(a => !a.includes("deploy") && !a.includes("update") && !a.includes("set-iam-policy") && a.some(x => x === PROJECT || x === `--project=${PROJECT}`))); });
// 実gcloudの読取で確認した投影結果を、個人情報を含まない合成値で再現する。
// 配列の子だけを指定するとbindingsはnull、containersは欠落する。
function projectedMetadataReader({projectPolicy = policy, servicePolicy = {etag: "synthetic"}} = {}) {
  return recoveryReader(args => {
    const format = args.find(a => a.startsWith("--format="));
    if (args[0] === "projects" && args[1] === "get-iam-policy") {
      return JSON.stringify(format === "--format=json(bindings,etag,version)" ? projectPolicy : null);
    }
    if (args[0] === "run" && args[2] === "get-iam-policy") {
      return JSON.stringify(format === "--format=json(bindings,etag,version)" ? servicePolicy : null);
    }
    if (args[0] === "run" && args[2] === "describe") {
      const result = clone(service);
      if (!format.slice("--format=json(".length, -1).split(",").includes("spec.template.spec.containers")) {
        delete result.spec.template.spec.containers;
      }
      return JSON.stringify(result);
    }
    assert.fail("unexpected metadata command");
  });
}
await test("project policy projection preserves binding arrays", () => {
  assertExistingInvoker(projectedMetadataReader().projectPolicy(), context.identity);
});
await test("project policy projection preserves conditional bindings", () => {
  const value = {bindings: [{...policy.bindings[0], condition: {expression: "true"}}]};
  assert.throws(() => assertExistingInvoker(projectedMetadataReader({projectPolicy: value}).projectPolicy(), context.identity), /EXISTING_INVOKER_REQUIRED/);
});
await test("project policy projection preserves public members", () => {
  const value = {bindings: [...policy.bindings, {role: "roles/run.invoker", members: ["allUsers"]}]};
  assert.throws(() => assertExistingInvoker(projectedMetadataReader({projectPolicy: value}).projectPolicy(), context.identity), /PUBLIC_BINDING_FOUND/);
});
await test("Run projection preserves paused container environment", () => {
  assertReadyService(projectedMetadataReader().service(), fn, context);
});
await test("service policy without bindings preserves valid envelope", () => {
  projectedMetadataReader().assertPrivateService();
});
await test("service policy projection preserves public members", () => {
  assert.throws(() => projectedMetadataReader({servicePolicy: {bindings: [{members: ["allAuthenticatedUsers"]}]}}).assertPrivateService(), /PUBLIC_BINDING_FOUND/);
});
await test("null policy remains unknown, never private", () => {
  assert.throws(() => projectedMetadataReader({servicePolicy: null}).assertPrivateService(), /RUN_POLICY_UNKNOWN/);
});
await test("live runner requires dedicated recovery confirmation before cloud", async () => { await assert.rejects(runRetryWorkerRecovery({plan: {project: PROJECT, region: REGION, sourceRef: "main", functions: [TARGET]}, source: root, sourceSha: context.sourceSha, cliRoot}, {read: {before() { assert.fail("must not read cloud"); }}}), /RETRY_RECOVERY_CONFIRMATION_REJECTED/); });
assert.equal(network, 0);
console.log(JSON.stringify({retryWorkerRecoveryTests: cases, cloudCalls: network, realDeployments: 0, retryOnlyAllowlisted: true}));
