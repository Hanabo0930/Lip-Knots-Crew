import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";

const dependency = createRequire(process.env.LKC_TEST_DEPENDENCY_ROOT
  ? join(process.env.LKC_TEST_DEPENDENCY_ROOT, "package.json")
  : import.meta.url);
const ts = dependency("typescript");
const compile = text => ts.transpileModule(text, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const jsx = (tag, props) => ({ tag, props });
const state = [];
let position = 0;
const react = { useRef(initial) {
  const index = position++;
  if (!(index in state)) state[index] = { current: initial };
  return state[index];
}, useState(initial) {
  const index = position++;
  if (!(index in state)) state[index] = initial;
  return [state[index], next => { state[index] = next; }];
} };
const module = { exports: {} };
const source = fs.readFileSync(new URL("../apps/admin/src/AdminExpenseOperation.tsx", import.meta.url), "utf8");
runInNewContext(compile(source), { exports: module.exports, require(name) {
  if (name === "react") return react;
  assert.equal(name, "react/jsx-runtime");
  return { jsx, jsxs: jsx };
} });

const { default: Component, parseExpenseOperation } = module.exports;
const jobId = "synthetic-job";
const operationId = "11111111-1111-4111-8111-111111111111";
const response = { jobId, confirmationOperation: { operationId, status: "readback_required" } };
const plain = value => JSON.parse(JSON.stringify(value));
const out = [];
function pass(name) { out.push({ name, passed: true }); }

assert.deepEqual(plain(parseExpenseOperation(response, jobId, operationId)), response.confirmationOperation);
assert.equal(parseExpenseOperation({ jobId, confirmationOperation: null }, jobId), null);
for (const [data, requestedJob, requestedId] of [
  [response, "another-job", operationId],
  [response, jobId, "22222222-2222-4222-8222-222222222222"],
  [{ jobId, confirmationOperation: null }, jobId, operationId],
  [{ jobId, confirmationOperation: { operationId, status: "unexpected" } }, jobId, operationId],
  [{ jobId, confirmationOperation: { operationId, status: "toString" } }, jobId, operationId],
  [{ job: { id: jobId }, draft: { values: { transportation: 850 } } }, jobId, undefined],
]) assert.throws(() => parseExpenseOperation(data, requestedJob, requestedId), /照会結果を確認できません/);
pass("response must match the requested job and operation and contain a recognized status");

const calls = [];
let nextResponse = response;
const lookup = async id => {
  calls.push(id);
  return parseExpenseOperation(nextResponse, jobId, id);
};
const render = () => { position = 0; return Component({ lookup }); };
function find(node, tag) {
  if (!node || typeof node !== "object") return undefined;
  if (node.tag === tag) return node;
  return [node.props?.children].flat().map(child => find(child, tag)).find(Boolean);
}
function visible(node) {
  if (!node || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  return [node.props?.children].flat().map(visible).join(" ");
}
find(render(), "button").props.onClick();
await setImmediate();
assert.deepEqual(calls, [undefined]);
assert.match(visible(render()), /反映結果の確認待ち/);
assert.match(visible(render()), new RegExp(operationId));
pass("a missing ID fetches and displays the current operation");

find(render(), "input").props.onChange({ target: { value: " ../wrong " } });
find(render(), "button").props.onClick();
assert.match(visible(render()), /操作IDの形式/);
assert.equal(calls.length, 1);
find(render(), "input").props.onChange({ target: { value: operationId.toUpperCase() } });
nextResponse = { jobId, confirmationOperation: { operationId, status: "completed" } };
find(render(), "button").props.onClick();
await setImmediate();
assert.equal(calls.at(-1), operationId);
assert.match(visible(render()), /反映・管理記録確定済み/);
pass("an entered ID is checked before lookup, and the matching final status is displayed");

const previousCalls = calls.length;
const click = find(render(), "button").props.onClick;
click();
click();
assert.equal(calls.length, previousCalls + 1);
assert.equal(find(render(), "button").props.disabled, true);
await setImmediate();
assert.equal(find(render(), "button").props.disabled, false);
find(render(), "button").props.onClick();
await setImmediate();
assert.equal(calls.length, previousCalls + 2);
assert.match(visible(render()), /反映・管理記録確定済み/);
pass("rapid clicks make one request and a new lookup can follow its completion");

const app = fs.readFileSync(new URL("../apps/admin/src/App.tsx", import.meta.url), "utf8");
const start = app.indexOf("  async function lookupExpenseOperation(");
const end = app.indexOf("  async function saveExpenseDraft()", start);
assert.ok(start >= 0 && end > start);
const actor = { uid: "synthetic-admin" };
const apiCalls = [];
let respond;
const appPort = {
  auth: { currentUser: actor }, adminAuthEpochRef: { current: 1 }, adminAuthorizationReadyRef: { current: true },
  adminSessionReady: true, expenseJobId: jobId, functions: {}, parseExpenseOperation, exports: {},
  httpsCallable: (_functions, command) => input => {
    apiCalls.push({ command, input });
    return new Promise(resolve => { respond = resolve; });
  },
};
runInNewContext(compile(app.slice(start, end) + "\nexports.lookup=lookupExpenseOperation;"), appPort);
await assert.rejects(() => appPort.exports.lookup("other-job"), /管理者のログイン/);
const promise = appPort.exports.lookup(jobId, operationId);
assert.deepEqual(plain(apiCalls), [{ command: "getExpenseReview", input: { jobId, mode: "confirmation-status", operationId } }]);
appPort.auth.currentUser = { uid: "another-admin" };
appPort.adminAuthEpochRef.current++;
respond({ data: response });
await assert.rejects(promise, /ログイン状態が変わりました/);
appPort.adminAuthorizationReadyRef.current = false;
await assert.rejects(() => appPort.exports.lookup(jobId), /管理者のログイン/);
assert.equal(apiCalls.length, 1);
pass("the actual App handler refuses a different job and drops responses after the login changes");

console.log(JSON.stringify({ passed: out.length, results: out, scope: "Actual status component and App request handler with synthetic UI state and callable transport." }, null, 2));
