import assert from "node:assert/strict";
import fs from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the production handler and pending-action hook. Only module loading,
// React state setters and diagnostic reads are synthetic; no network is available.
const app = fs.readFileSync("apps/staff/src/App.tsx", "utf8");
const start = app.indexOf("  async function openQuickDiagnostics(");
const end = app.indexOf("  async function copyDisplayText(", start);
assert.ok(start >= 0 && end > start);
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const handler = transpile(app.slice(start, end));
const hook = transpile(fs.readFileSync("apps/staff/src/useAsyncAction.ts", "utf8"));
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const report = () => ({ checkedAt: "2026-10-30T00:00:00Z", summary: "pass", checks: [], serverPushEnabled: null });

function setup() {
  const state = { loads: [], reads: [], reports: [], messages: [], visible: false };
  const defer = list => (...args) => new Promise((resolve, reject) => list.push({ args, resolve, reject }));
  const scope = {
    Error, Date,
    diagnosticsVersionRef: { current: 0 }, authLoadVersionRef: { current: 1 },
    pastShiftVersionRef: { current: 0 }, pushStateVersionRef: { current: 0 },
    user: { uid: "synthetic" }, companyId: "synthetic", staffId: "synthetic",
    businessDataStatus: "ready", businessDataSource: "live", businessRefreshing: false,
    homeDisplayMs: null, businessRefreshMs: null, homeLoadedFromCache: false,
    deviceSessionId: "synthetic", functions: {},
    loadStaffDiagnostics: defer(state.loads),
    setShowAccountMenu() {}, setShowDevices() {},
    setShowDiagnostics: value => { state.visible = value; },
    setDiagnosticReport: value => { state.reports.push(value); },
    setMessage: value => { state.messages.push(value); },
  };
  const hookScope = { exports: {}, require: name => {
    assert.equal(name, "react");
    return { useCallback: fn => fn, useRef: value => ({ current: value }), useState: initial => [initial(), () => {}] };
  } };
  runInNewContext(hook, hookScope);
  Object.assign(scope, hookScope.exports.useAsyncAction());
  runInNewContext(handler, scope);
  return { scope, state, module: { runStaffDiagnostics: defer(state.reads) } };
}

let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log(`PASS ${name}`);
}

await test("no eager diagnostic execution; double click shares one pending module load", async () => {
  const h = setup();
  assert.equal(h.state.loads.length, 0);
  const action = h.scope.openQuickDiagnostics();
  await h.scope.openQuickDiagnostics();
  assert.equal(h.state.loads.length, 1);
  assert.equal(h.state.reads.length, 0);
  assert.equal(h.scope.isDiagnosticsPending(), true);
  assert.equal(h.state.visible, true);
  h.state.loads[0].resolve(h.module);
  await settle();
  assert.equal(h.state.reads.length, 1);
  assert.equal(h.state.reads[0].args[0].functions, h.scope.functions);
  h.state.reads[0].resolve(report());
  await action;
  assert.equal(h.state.reports.at(-1).summary, "pass");
  assert.equal(h.scope.isDiagnosticsPending(), false);
});

await test("module failure uses the existing error panel; explicit retry succeeds", async () => {
  const h = setup(), action = h.scope.openQuickDiagnostics();
  h.state.loads[0].reject(Error("synthetic chunk unavailable"));
  await action;
  assert.equal(h.state.reads.length, 0);
  assert.equal(h.state.reports.at(-1).summary, "fail");
  assert.match(h.state.reports.at(-1).checks[0].detail, /もう一度診断/);
  assert.equal(h.scope.isDiagnosticsPending(), false);
  const retry = h.scope.openQuickDiagnostics();
  assert.equal(h.state.reports.at(-1), null);
  h.state.loads[1].resolve(h.module);
  await settle();
  h.state.reads[0].resolve(report());
  await retry;
  assert.equal(h.state.reports.at(-1).summary, "pass");
  assert.equal(h.state.reads.length, 1);
});

for (const change of ["closed", "auth"]) for (const failure of [false, true]) {
  await test(`${change} during module load discards late ${failure ? "failure" : "success"}`, async () => {
    const h = setup(), action = h.scope.openQuickDiagnostics();
    if (change === "closed") h.scope.closeDiagnostics();
    else h.scope.authLoadVersionRef.current++;
    const reports = h.state.reports.length, messages = h.state.messages.length;
    if (failure) h.state.loads[0].reject(Error("synthetic stale load"));
    else h.state.loads[0].resolve(h.module);
    await action;
    assert.equal(h.state.reads.length, 0);
    assert.equal(h.state.reports.length, reports);
    assert.equal(h.state.messages.length, messages);
    assert.equal(h.scope.isPending("diagnostics:1"), false);
  });
}

await test("reopened diagnosis is not overwritten by an old module rejection", async () => {
  const h = setup(), old = h.scope.openQuickDiagnostics();
  h.scope.closeDiagnostics();
  const current = h.scope.openQuickDiagnostics();
  h.state.loads[1].resolve(h.module);
  await settle();
  h.state.reads[0].resolve(report());
  await current;
  const reports = h.state.reports.length, messages = h.state.messages.length;
  h.state.loads[0].reject(Error("synthetic old load"));
  await old;
  assert.equal(h.state.reports.length, reports);
  assert.equal(h.state.messages.length, messages);
  assert.equal(h.state.reports.at(-1).summary, "pass");
});

for (const change of ["business", "push"]) {
  await test(`${change} changes while loading remain unverified`, async () => {
    const h = setup(), action = h.scope.openQuickDiagnostics();
    h.scope[change === "business" ? "pastShiftVersionRef" : "pushStateVersionRef"].current++;
    h.state.loads[0].resolve(h.module);
    await settle();
    h.state.reads[0].resolve(report());
    await action;
    assert.equal(h.state.reports.at(-1).summary, "warn");
    assert.ok(h.state.reports.at(-1).checks.some(check => check.id === change + "-changed"));
  });
}

console.log(`Diagnostic lazy loading: ${passed} cases passed; production handler/hook, synthetic loader and reads, no real service calls.`);
