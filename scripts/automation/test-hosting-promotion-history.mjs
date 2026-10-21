import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  PromotionHistoryError,
  proveNoHostingWrite,
  readGithubHistory,
  requireResolvedPromotionHistory,
} from "./check-hosting-promotion-history.mjs";

let cases = 0;
const sourceSha = "b".repeat(40), oldSha = "a".repeat(40);
const context = {sourceSha, currentRunId: "200"};
const runEndpoint = "/repos/Hanabo0930/Lip-Knots-Crew/actions/workflows/staging-hosting-promote.yml/runs";
const baseRun = {
  id: 100, workflow_id: 99, repository: {full_name: "Hanabo0930/Lip-Knots-Crew"},
  path: ".github/workflows/staging-hosting-promote.yml", head_branch: "main",
  head_sha: oldSha, run_attempt: 1, event: "workflow_dispatch",
  name: "Staging Hosting Promote", display_title: "promote staging Hosting",
  status: "completed", conclusion: "failure",
};
const current = {...baseRun, id: 200, head_sha: sourceSha, status: "in_progress", conclusion: null};
const step = (name, conclusion = "skipped") => ({name, status: "completed", conclusion});
const noWriteSteps = [
  step("Set up job", "success"), step("Recheck current main before any live operation", "failure"),
  step("Back up both current live channels"),
  step("Promote the already-tested versions without rebuilding"),
  step("Restore the exact pair from successful promotion evidence"),
  step("Enforce the final result", "failure"),
];
const job = (overrides = {}) => ({
  id: 1000, run_id: 100, name: "promote", status: "completed", conclusion: "failure",
  started_at: "2026-10-20T00:00:00Z", steps: noWriteSteps, ...overrides,
});
const neverStarted = job({started_at: null, conclusion: "cancelled", steps: []});
const successfulSteps = [
  "Back up both current live channels", "Promote the already-tested versions without rebuilding",
  "Verify both live staging apps after promotion", "Persist successful promotion manifest before channel cleanup",
  "Upload promotion and rollback evidence", "Enforce the final result",
].map(name => step(name, "success"));
const successJob = job({conclusion: "success", steps: successfulSteps});
function stub(runs = [], jobs = {}, transform = value => value) {
  const calls = [];
  return {
    calls,
    github: async endpoint => {
      calls.push(endpoint);
      const url = new URL(endpoint, "https://api.github.com");
      const page = Number(url.searchParams.get("page"));
      assert.equal(url.searchParams.get("per_page"), "100");
      let key, values;
      if (url.pathname === runEndpoint) {key = "workflow_runs"; values = [current, ...runs];}
      else {
        const match = url.pathname.match(/\/runs\/([1-9][0-9]*)\/attempts\/1\/jobs$/u);
        assert.ok(match, "Only known read endpoints are requested");
        key = "jobs"; values = jobs[match[1]] ?? [job({run_id: Number(match[1])})];
      }
      return JSON.stringify(transform({total_count: values.length, [key]: values.slice((page - 1) * 100, page * 100)}, endpoint));
    },
  };
}
async function clear(runs, jobs) {
  const api = stub(runs, jobs);
  const result = await requireResolvedPromotionHistory(context, api);
  assert.equal(result.status, "HISTORY_CLEAR");
  assert.equal(result.limitedPromotionAuthorized, false);
  cases++; return {result, calls: api.calls};
}
async function blocked(runs, jobs, code, options = {}) {
  const api = stub(runs, jobs);
  await assert.rejects(requireResolvedPromotionHistory(context, {...api, ...options}),
    error => error instanceof PromotionHistoryError && error.message === code);
  cases++; return api.calls;
}
await clear([]);
await clear([baseRun]);
await clear([{...baseRun, conclusion: "cancelled"}], {100: [neverStarted]});
await clear([baseRun], {100: [job({name: "guard", conclusion: "failure", steps: []})]});
await clear([{...baseRun, head_branch: "automation/ignored", conclusion: "skipped"}],
  {100: [job({id: 1001, name: "guard", conclusion: "skipped", started_at: null, steps: []}), neverStarted]});
await clear([{...baseRun, conclusion: "cancelled"}],
  {100: [job({id: 1001, name: "guard", conclusion: "success", steps: []}), neverStarted]});
// Sanitized shape of a cancelled environment-waiting job: GitHub supplied a
// started_at timestamp, but never assigned a runner or recorded a step.
const cancelledWaitingRun = {...baseRun, event: "workflow_run", conclusion: "cancelled"};
const cancelledWaitingJob = job({
  conclusion: "cancelled", head_sha: oldSha, run_attempt: 1,
  started_at: "2026-10-20T03:49:59Z", completed_at: "2026-10-21T00:18:41Z",
  runner_id: 0, runner_name: "", runner_group_id: 0, runner_group_name: "", steps: [],
});
const waitingGuard = job({id: 1001, name: "guard", conclusion: "success", steps: []});
const {result: cancelledWaiting} = await clear([cancelledWaitingRun], {100: [waitingGuard, cancelledWaitingJob]});
assert.equal(cancelledWaiting.resolved[0].result, "NO_HOSTING_WRITE"); cases++;
for (const overrides of [
  {runner_id: undefined}, {runner_id: null}, {runner_id: "0"}, {runner_id: 1},
  {runner_name: undefined}, {runner_name: null}, {runner_name: "runner"}, {runner_name: " "},
  {runner_group_id: undefined}, {runner_group_id: null}, {runner_group_id: "0"}, {runner_group_id: 1},
  {runner_group_name: undefined}, {runner_group_name: null}, {runner_group_name: "group"},
  {steps: undefined}, {steps: null}, {steps: {}},
  {started_at: undefined}, {started_at: "invalid"}, {started_at: "2026-02-30T03:49:59Z"},
  {completed_at: undefined}, {completed_at: null}, {completed_at: "invalid"},
  {completed_at: "2026-10-20T03:49:58Z"},
  {head_sha: undefined}, {head_sha: sourceSha}, {run_attempt: undefined}, {run_attempt: 2},
  {conclusion: "failure"}, {conclusion: "skipped"}, {name: "other"},
]) {
  await blocked([cancelledWaitingRun], {100: [waitingGuard, {...cancelledWaitingJob, ...overrides}]},
    "HOSTING_PRIOR_WRITE_UNRESOLVED");
}
for (const overrides of [{conclusion: "failure"}, {display_title: "Old workflow title"},
  {event: "workflow_dispatch", display_title: "restore staging Hosting from 90"}]) {
  await blocked([{...cancelledWaitingRun, ...overrides}], {100: [waitingGuard, cancelledWaitingJob]},
    "HOSTING_PRIOR_WRITE_UNRESOLVED");
}
await blocked([cancelledWaitingRun], {100: [waitingGuard, {...cancelledWaitingJob, steps: [step("Set up job")]}]},
  "HOSTING_HISTORY_WRITE_STEPS_MISSING");
await blocked([cancelledWaitingRun], {100: [waitingGuard, {...cancelledWaitingJob,
  steps: [step("Promote the already-tested versions without rebuilding", "failure")]}]},
  "HOSTING_PRIOR_WRITE_UNRESOLVED");
await blocked([cancelledWaitingRun], {100: [waitingGuard, cancelledWaitingJob,
  job({id: 1002, name: "unknown", steps: []})]}, "HOSTING_PRIOR_WRITE_UNRESOLVED");
await blocked([cancelledWaitingRun], {100: [waitingGuard, cancelledWaitingJob,
  job({id: 1002, steps: [step("Promote the already-tested versions without rebuilding", "failure")]})]},
  "HOSTING_PRIOR_WRITE_UNRESOLVED");
await clear([{...baseRun, display_title: "Old workflow title"}], {100: [neverStarted]});
const {result: success} = await clear([{...baseRun, conclusion: "success"}], {100: [successJob]});
assert.equal(success.resolved[0].result, "COMPLETED_SUCCESS"); cases++;
await clear([{...baseRun, display_title: "restore staging Hosting from 90", head_sha: sourceSha, conclusion: "success"}],
  {100: [job({conclusion: "success", steps: [
    "Restore the exact pair from successful promotion evidence", "Check both live apps after manual restore",
    "Upload promotion and rollback evidence", "Enforce the final result",
  ].map(name => step(name, "success"))})]});
const readiness = {...baseRun, display_title: "readiness staging Hosting", status: "in_progress", conclusion: null};
const {calls: readinessCalls} = await clear([readiness]);
assert.equal(readinessCalls.length, 1); cases++;
await blocked([{...baseRun, conclusion: "success", head_sha: sourceSha}], {}, "HOSTING_PRIOR_PROMOTION_ALREADY_SUCCEEDED");
for (const status of ["waiting", "in_progress", "queued", "pending", "requested", "unknown"]) {
  const calls = await blocked([{...baseRun, status, conclusion: null}], {}, "HOSTING_PRIOR_RUN_UNRESOLVED");
  assert.equal(calls.length, 1);
}
await blocked([{...baseRun, id: 300, status: "in_progress", conclusion: null}], {}, "HOSTING_PRIOR_RUN_UNRESOLVED");
await blocked([{...baseRun, id: 300}], {300: [job({run_id: 300, steps: [step("Back up both current live channels", "failure")]})]},
  "HOSTING_PRIOR_WRITE_UNRESOLVED");
await blocked([{...baseRun, run_attempt: 2}], {}, "HOSTING_PRIOR_RUN_UNRESOLVED");
await blocked([{...baseRun, conclusion: null}], {}, "HOSTING_PRIOR_RUN_UNRESOLVED");
await blocked([baseRun], {100: []}, "HOSTING_HISTORY_JOBS_INCOMPLETE");
await blocked([baseRun], {100: [job({name: "guard", conclusion: "success"})]}, "HOSTING_PRIOR_WRITE_UNRESOLVED");
await blocked([baseRun], {100: [job({name: "other", started_at: null, conclusion: "skipped", steps: []})]},
  "HOSTING_PRIOR_WRITE_UNRESOLVED");
await blocked([baseRun], {100: [job({started_at: undefined, conclusion: "cancelled", steps: []})]}, "HOSTING_PRIOR_WRITE_UNRESOLVED");
for (const name of [
  "Back up both current live channels", "Promote the already-tested versions without rebuilding",
  "Restore both previous live versions on any failure", "Remove temporary channels after a successful promotion",
  "Restore the exact pair from successful promotion evidence", "Restore the trial if durable promotion evidence failed",
  "Unrecognized step",
]) {
  await blocked([baseRun], {100: [job({steps: [step(name, "failure")]})]}, "HOSTING_PRIOR_WRITE_UNRESOLVED");
}
await blocked([baseRun], {100: [job({steps: [step("Set up job", "success")]})]}, "HOSTING_HISTORY_WRITE_STEPS_MISSING");
await blocked([baseRun], {100: [job({steps: [...noWriteSteps, noWriteSteps[0]]})]}, "HOSTING_HISTORY_STEPS_INCOMPLETE");
await blocked([baseRun], {100: [job({steps: noWriteSteps.map((value, index) => index ? value : {...value, status: "in_progress"})})]},
  "HOSTING_HISTORY_STEPS_INCOMPLETE");
await blocked([baseRun], {100: [job({run_id: 999})]}, "HOSTING_HISTORY_JOBS_INCOMPLETE");
await blocked([{...baseRun, conclusion: "success", display_title: "Legacy promote title"}], {100: [successJob]},
  "HOSTING_PRIOR_WRITE_UNRESOLVED");
await blocked([{...baseRun, conclusion: "success", head_branch: "automation/ignored"}], {100: [successJob]},
  "HOSTING_PRIOR_WRITE_UNRESOLVED");
await blocked([{...baseRun, conclusion: "success"}], {100: [job({conclusion: "success",
  steps: successfulSteps.map(value => value.name.startsWith("Promote ") ? {...value, conclusion: "failure"} : value)})]},
  "HOSTING_PRIOR_WRITE_UNRESOLVED");
await blocked([{...baseRun, conclusion: "success"}], {100: [job({conclusion: "success",
  steps: [...successfulSteps, step("Restore the trial if durable promotion evidence failed", "success")]})]},
  "HOSTING_PRIOR_WRITE_UNRESOLVED");
await blocked([{...baseRun, conclusion: "success"}], {100: [job({conclusion: "success",
  steps: successfulSteps.filter(value => value.name !== "Enforce the final result")})]},
  "HOSTING_PRIOR_WRITE_UNRESOLVED");
for (const overrides of [
  {repository: {full_name: "other/repo"}}, {workflow_id: 101}, {path: ".github/workflows/other.yml"},
  {head_sha: "bad"}, {head_branch: ""}, {event: "push"}, {name: "Other workflow"},
  {run_attempt: 0}, {event: "workflow_run", display_title: "restore staging Hosting from 90"},
]) {
  await blocked([{...baseRun, ...overrides}], {}, "HOSTING_HISTORY_IDENTITY_REJECTED");
}
for (const overrides of [
  {head_sha: oldSha}, {head_branch: "other"}, {run_attempt: 2}, {status: "completed"},
  {event: "workflow_run"}, {display_title: "readiness staging Hosting"},
]) {
  const transport = stub([], {}, data => ({...data, workflow_runs: [{...current, ...overrides}]}));
  await blocked([], {}, "HOSTING_HISTORY_CURRENT_RUN_MISMATCH", transport);
}
for (const change of [
  data => ({...data, total_count: 1001}), data => ({...data, total_count: 2}),
  data => ({...data, workflow_runs: [current, current], total_count: 2}),
  data => ({...data, workflow_runs: [{...current, id: Number.MAX_SAFE_INTEGER + 1}]}),
  () => ({total_count: 0}), data => ({...data, total_count: -1}),
]) await blocked([], {}, "HOSTING_HISTORY_LIST_INCOMPLETE", stub([], {}, change));
await blocked([], {}, "HOSTING_HISTORY_CURRENT_RUN_MISMATCH",
  {github: async () => JSON.stringify({total_count: 0, workflow_runs: []})});
await blocked([], {}, "HOSTING_HISTORY_READ_FAILED", {github: async () => "invalid"});
await blocked([], {}, "HOSTING_HISTORY_READ_FAILED", {github: async () => {throw new Error("secret must not escape");}});
await blocked([], {}, "HOSTING_HISTORY_RESPONSE_TOO_LARGE", {github: async () => "x".repeat(8 * 1024 * 1024 + 1)});
const manyReadiness = Array.from({length: 101}, (_, index) => ({...readiness, id: 500 + index}));
const {calls: pages} = await clear(manyReadiness);
assert.equal(pages.length, 2); cases++;
await blocked(manyReadiness, {}, "HOSTING_HISTORY_LIST_CHANGED", stub(manyReadiness, {},
  (data, endpoint) => endpoint.endsWith("page=2") ? {...data, total_count: data.total_count - 1} : data));
await blocked(manyReadiness, {}, "HOSTING_HISTORY_LIST_INCOMPLETE", stub(manyReadiness, {},
  (data, endpoint) => endpoint.endsWith("page=2") ? {...data, workflow_runs: []} : data));
assert.throws(() => proveNoHostingWrite({...baseRun, run_attempt: 2}, [neverStarted]), /HOSTING_PRIOR_RUN_UNRESOLVED/u); cases++;

const endpoint = runEndpoint + "?per_page=100&page=1";
const transportOptions = {token: "fake-test-token", fetchImpl: async (url, options) => {
  assert.equal(url, "https://api.github.com" + endpoint);
  assert.equal(options.method, "GET");
  assert.equal(options.redirect, "error");
  assert.equal(options.headers.Authorization, "Bearer fake-test-token");
  assert.ok(options.signal instanceof AbortSignal);
  return new Response('{"ok":true}', {status: 200});
}};
assert.equal(await readGithubHistory(endpoint, transportOptions), '{"ok":true}'); cases++;
for (const invalid of ["https://evil.invalid/", "//evil.invalid/", "/repos/other/repo/actions/runs",
  endpoint + "&unexpected=1", endpoint.replace("page=1", "page=11")]) {
  await assert.rejects(readGithubHistory(invalid, transportOptions), /HOSTING_HISTORY_CONTEXT_REJECTED/u); cases++;
}
for (const response of [
  new Response("", {status: 302, headers: {Location: "https://evil.invalid/"}}),
  new Response("secret-token", {status: 403}), new Response("", {status: 500}),
  {status: 200, redirected: true, body: new Response("").body},
]) {
  await assert.rejects(readGithubHistory(endpoint, {...transportOptions, fetchImpl: async () => response}),
    /HOSTING_HISTORY_READ_FAILED/u); cases++;
}
await assert.rejects(readGithubHistory(endpoint, {...transportOptions,
  fetchImpl: async () => new Response("x".repeat(8 * 1024 * 1024 + 1))}), /HOSTING_HISTORY_RESPONSE_TOO_LARGE/u); cases++;
await assert.rejects(readGithubHistory(endpoint, {...transportOptions, token: "bad\ntoken"}), /HOSTING_HISTORY_CONTEXT_REJECTED/u); cases++;
await assert.rejects(readGithubHistory(endpoint, {...transportOptions,
  fetchImpl: async () => {throw new Error("secret token");}}), error => error.message === "HOSTING_HISTORY_READ_FAILED"); cases++;
const source = readFileSync(new URL("./check-hosting-promotion-history.mjs", import.meta.url), "utf8");
assert.doesNotMatch(source, /console\.(?:log|error)\([^)]*(?:token|response|endpoint|jobs|runs|error\.stack)/u); cases++;
console.log(`Hosting promotion history tests: ${cases} cases passed`);
