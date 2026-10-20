import {writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {requireProtectedContext, validateHostingOperation} from "./hosting-operation-context.mjs";

const repository = "Hanabo0930/Lip-Knots-Crew";
const workflowPath = ".github/workflows/staging-hosting-promote.yml";
const decimal = /^[1-9][0-9]{0,19}$/u;
const sha = /^[a-f0-9]{40}$/u;
const conclusions = new Set(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"]);
const maximumResponseBytes = 8 * 1024 * 1024;
const writeSteps = new Set([
  "Back up both current live channels",
  "Promote the already-tested versions without rebuilding",
  "Restore both previous live versions on any failure",
  "Remove temporary channels after a successful promotion",
  "Restore the exact pair from successful promotion evidence",
  "Restore the trial if durable promotion evidence failed",
]);
// A started step with a new or renamed name is not assumed harmless.
const nonWritingSteps = new Set([
  "Set up job", "Complete job", "Prepare evidence directory",
  "Checkout the exact CI-passing main source", "Post Checkout the exact CI-passing main source",
  "Re-check source is still current main after approval",
  "Stop source verification unless a no-fee path is established",
  "Set up Node", "Post Set up Node", "Set up Node for metadata only", "Post Set up Node for metadata only",
  "Install locked automation dependencies", "Validate protected metadata-only scope before authentication",
  "Validate limited review and no additional cost before cloud access",
  "Authenticate with the short-lived staging identity", "Post Authenticate with the short-lived staging identity",
  "Authenticate for limited metadata GETs", "Post Authenticate for limited metadata GETs",
  "Collect only upload Function and referenced Build metadata",
  "Discover the two allowlisted Hosting sites", "Resolve the exact preview versions",
  "Pin limited trial preview and previous live versions", "Re-check both preview apps before any live change",
  "Set up Google Cloud CLI for read-only API verification",
  "Verify deployed upload APIs before any live Hosting change",
  "Validate limited evidence against fresh pinned API metadata",
  "Recheck current main before any live operation",
  "Require resolved earlier Hosting writes before a limited promotion",
  "Capture both saved live and immutable preview versions",
  "Recheck the saved live pair immediately before promotion",
  "Recheck limited trial capture and API revisions before live write",
  "Verify both live staging apps after promotion", "Recheck unchanged APIs after the limited trial",
  "Persist successful promotion manifest before channel cleanup",
  "Verify both live staging apps after rollback", "Prepare existing browser check for manual restore",
  "Check both live apps after manual restore", "Upload promotion and rollback evidence",
  "Check both apps after evidence failure recovery", "Publish promotion summary", "Enforce the final result",
]);
export class PromotionHistoryError extends Error {
  constructor(code, runId) {super(code); this.runId = runId;}
}
function requireValue(value, code, runId) {if (!value) throw new PromotionHistoryError(code, runId);}
function validId(id) {return Number.isSafeInteger(id) && id > 0 && decimal.test(String(id));}
function runOperation(run) {
  if (run.display_title === "promote staging Hosting") return "promote";
  if (/^restore staging Hosting from [1-9][0-9]{0,19}$/u.test(run.display_title ?? "")) return "restore";
  if (run.display_title === "readiness staging Hosting") return "readiness";
  return "unknown";
}
function validateRun(run, workflowId) {
  requireValue(validId(run?.id) && run.repository?.full_name === repository
    && run.path === workflowPath && typeof run.head_branch === "string" && run.head_branch.length > 0
    && validId(run.workflow_id) && (workflowId === undefined || run.workflow_id === workflowId)
    && sha.test(run.head_sha ?? "") && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0
    && ["workflow_dispatch", "workflow_run"].includes(run.event), "HOSTING_HISTORY_IDENTITY_REJECTED", String(run?.id ?? ""));
  const operation = runOperation(run);
  requireValue(run.name === "Staging Hosting Promote" || operation !== "unknown" && run.name === run.display_title,
    "HOSTING_HISTORY_IDENTITY_REJECTED", String(run.id));
  requireValue(run.event === "workflow_dispatch" || ["promote", "unknown"].includes(operation),
    "HOSTING_HISTORY_IDENTITY_REJECTED", String(run.id));
  return operation;
}

export function proveNoHostingWrite(run, jobs) {
  const id = String(run.id), operation = validateRun(run);
  requireValue(run.status === "completed" && run.run_attempt === 1
    && conclusions.has(run.conclusion), "HOSTING_PRIOR_RUN_UNRESOLVED", id);
  requireValue(Array.isArray(jobs) && jobs.length > 0, "HOSTING_HISTORY_JOBS_INCOMPLETE", id);
  let explicitStop = false;
  for (const job of jobs) {
    requireValue(validId(job?.id) && job.run_id === run.id && job.status === "completed"
      && conclusions.has(job.conclusion),
      "HOSTING_HISTORY_JOBS_INCOMPLETE", id);
    if (job.name === "guard") {
      if (["failure", "cancelled", "skipped", "timed_out", "action_required", "startup_failure"].includes(job.conclusion)) explicitStop = true;
      continue;
    }
    const steps = job.steps;
    if (job.name === "promote" && job.started_at === null
      && (steps === null || Array.isArray(steps) && steps.length === 0)
      && ["skipped", "cancelled"].includes(job.conclusion)) {
      explicitStop = true; continue;
    }
    requireValue(job.name === "promote" && Array.isArray(steps) && steps.length > 0,
      "HOSTING_PRIOR_WRITE_UNRESOLVED", id);
    const names = new Set();
    for (const step of steps) {
      requireValue(typeof step.name === "string" && !names.has(step.name)
        && step.status === "completed" && conclusions.has(step.conclusion), "HOSTING_HISTORY_STEPS_INCOMPLETE", id);
      names.add(step.name);
      requireValue(step.conclusion === "skipped"
        || nonWritingSteps.has(step.name) && !writeSteps.has(step.name),
      "HOSTING_PRIOR_WRITE_UNRESOLVED", id);
    }
    const required = operation === "restore"
      ? ["Restore the exact pair from successful promotion evidence"]
      : ["Back up both current live channels", "Promote the already-tested versions without rebuilding"];
    requireValue(required.every(name => names.has(name)), "HOSTING_HISTORY_WRITE_STEPS_MISSING", id);
    explicitStop = true;
  }
  requireValue(explicitStop, "HOSTING_PRIOR_WRITE_UNRESOLVED", id);
  return {runId: id, operation, sourceSha: run.head_sha, result: "NO_HOSTING_WRITE"};
}

function proveCompletedWriter(run, jobs) {
  const operation = validateRun(run), id = String(run.id);
  requireValue(run.head_branch === "main" && ["promote", "restore"].includes(operation),
    "HOSTING_PRIOR_WRITE_UNRESOLVED", id);
  const writers = jobs.filter(job => job.name === "promote");
  requireValue(writers.length === 1 && jobs.every(job => job.name === "guard" || job.name === "promote"),
    "HOSTING_HISTORY_JOBS_INCOMPLETE", id);
  for (const job of jobs) requireValue(validId(job.id) && job.run_id === run.id
    && job.status === "completed" && job.conclusion === "success", "HOSTING_PRIOR_WRITE_UNRESOLVED", id);
  const steps = writers[0].steps;
  requireValue(Array.isArray(steps) && steps.length > 0, "HOSTING_HISTORY_STEPS_INCOMPLETE", id);
  const names = new Set();
  for (const step of steps) {
    requireValue(typeof step.name === "string" && !names.has(step.name) && step.status === "completed"
      && ["success", "skipped"].includes(step.conclusion)
      && (step.conclusion === "skipped" || nonWritingSteps.has(step.name) || writeSteps.has(step.name)),
    "HOSTING_PRIOR_WRITE_UNRESOLVED", id);
    names.add(step.name);
    if (["Restore both previous live versions on any failure", "Restore the trial if durable promotion evidence failed"].includes(step.name)) {
      requireValue(step.conclusion === "skipped", "HOSTING_PRIOR_WRITE_UNRESOLVED", id);
    }
  }
  const required = operation === "promote"
    ? ["Back up both current live channels", "Promote the already-tested versions without rebuilding",
      "Verify both live staging apps after promotion", "Persist successful promotion manifest before channel cleanup",
      "Upload promotion and rollback evidence", "Enforce the final result"]
    : ["Restore the exact pair from successful promotion evidence", "Check both live apps after manual restore",
      "Upload promotion and rollback evidence", "Enforce the final result"];
  requireValue(required.every(name => steps.some(step => step.name === name && step.conclusion === "success")),
    "HOSTING_PRIOR_WRITE_UNRESOLVED", id);
  return {runId: id, operation, sourceSha: run.head_sha, result: "COMPLETED_SUCCESS"};
}

export async function readGithubHistory(endpoint, {fetchImpl = fetch, token = process.env.GH_TOKEN} = {}) {
  requireValue(typeof endpoint === "string"
    && /^\/repos\/Hanabo0930\/Lip-Knots-Crew\/actions\/(?:workflows\/staging-hosting-promote\.yml\/runs|runs\/[1-9][0-9]{0,19}\/attempts\/1\/jobs)\?per_page=100&page=(?:[1-9]|10)$/u.test(endpoint)
    && typeof token === "string" && /^[!-~]+$/u.test(token), "HOSTING_HISTORY_CONTEXT_REJECTED");
  try {
    const response = await fetchImpl("https://api.github.com" + endpoint, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: {Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
    });
    requireValue(response.status === 200 && !response.redirected && response.body,
      "HOSTING_HISTORY_READ_FAILED");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      requireValue(size <= maximumResponseBytes, "HOSTING_HISTORY_RESPONSE_TOO_LARGE");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof PromotionHistoryError) throw error;
    throw new PromotionHistoryError("HOSTING_HISTORY_READ_FAILED");
  }
}
async function listing(base, key, maximum, github) {
  const entries = [], seen = new Set();
  let total;
  for (let page = 1; page <= Math.ceil(maximum / 100); page++) {
    let data;
    try {
      const body = await github(base + "?per_page=100&page=" + page);
      requireValue(typeof body === "string" && Buffer.byteLength(body, "utf8") <= maximumResponseBytes,
        "HOSTING_HISTORY_RESPONSE_TOO_LARGE");
      data = JSON.parse(body);
    }
    catch (error) {if (error instanceof PromotionHistoryError) throw error; throw new PromotionHistoryError("HOSTING_HISTORY_READ_FAILED");}
    requireValue(Number.isInteger(data.total_count) && data.total_count >= 0 && data.total_count <= maximum
      && Array.isArray(data[key]), "HOSTING_HISTORY_LIST_INCOMPLETE");
    requireValue(total === undefined || total === data.total_count, "HOSTING_HISTORY_LIST_CHANGED");
    total = data.total_count;
    requireValue(data[key].length === Math.min(100, Math.max(0, total - (page - 1) * 100)),
      "HOSTING_HISTORY_LIST_INCOMPLETE");
    for (const entry of data[key]) {
      requireValue(validId(entry?.id) && !seen.has(entry.id), "HOSTING_HISTORY_LIST_INCOMPLETE");
      seen.add(entry.id); entries.push(entry);
    }
    if (page * 100 >= total) return entries;
  }
  throw new PromotionHistoryError("HOSTING_HISTORY_LIST_INCOMPLETE");
}

export async function requireResolvedPromotionHistory({sourceSha, currentRunId}, {github = readGithubHistory} = {}) {
  requireValue(sha.test(sourceSha ?? "") && decimal.test(currentRunId ?? ""), "HOSTING_HISTORY_CONTEXT_REJECTED");
  const base = "/repos/" + repository + "/actions";
  const runs = await listing(base + "/workflows/staging-hosting-promote.yml/runs", "workflow_runs", 1000, github);
  const current = runs.find(run => String(run.id) === currentRunId);
  requireValue(current && validateRun(current) === "promote" && current.head_sha === sourceSha
    && current.head_branch === "main" && current.event === "workflow_dispatch"
    && current.run_attempt === 1 && current.status === "in_progress", "HOSTING_HISTORY_CURRENT_RUN_MISMATCH");
  const resolved = [];
  for (const run of runs) {
    // Concurrency is not FIFO: inspect later-created runs as well as older runs.
    if (String(run.id) === currentRunId) continue;
    const operation = validateRun(run, current.workflow_id);
    if (operation === "readiness" && run.head_branch === "main") continue;
    requireValue(run.run_attempt === 1 && run.status === "completed" && conclusions.has(run.conclusion),
      "HOSTING_PRIOR_RUN_UNRESOLVED", String(run.id));
    if (run.conclusion === "success") {
      requireValue(operation !== "promote" || run.head_branch !== "main" || run.head_sha !== sourceSha,
        "HOSTING_PRIOR_PROMOTION_ALREADY_SUCCEEDED", String(run.id));
    }
    const jobs = await listing(base + "/runs/" + run.id + "/attempts/1/jobs", "jobs", 1000, github);
    try {resolved.push(proveNoHostingWrite(run, jobs));}
    catch (error) {
      if (run.conclusion !== "success") throw error;
      resolved.push(proveCompletedWriter(run, jobs));
    }
  }
  return {schemaVersion: 1, status: "HISTORY_CLEAR", sourceSha, currentRunId,
    limitedPromotionAuthorized: false, resolved};
}

export async function promotionHistoryMain() {
  requireValue(process.argv.slice(2).length === 0, "HOSTING_HISTORY_CONTEXT_REJECTED");
  requireProtectedContext();
  validateHostingOperation({operation: process.env.LKC_OPERATION, eventName: process.env.GITHUB_EVENT_NAME,
    confirmation: process.env.LKC_CONFIRMATION, projectId: process.env.LKC_PROJECT_ID,
    region: process.env.LKC_REGION, sourceRef: process.env.GITHUB_REF_NAME,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT)});
  requireValue(process.env.LKC_OPERATION === "promote" && process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
    && process.env.LKC_EVIDENCE_POLICY === "limited-staff-pilot" && process.env.LKC_METADATA_ONLY === "false"
    && process.env.GITHUB_SHA === process.env.LKC_SOURCE_SHA, "HOSTING_HISTORY_CONTEXT_REJECTED");
  const dir = process.env.LKC_EVIDENCE_DIR ?? "";
  requireValue(path.isAbsolute(process.env.RUNNER_TEMP ?? "")
    && path.resolve(dir) === path.resolve(process.env.RUNNER_TEMP, "hosting-promote-evidence"),
  "HOSTING_HISTORY_EVIDENCE_DIRECTORY_REJECTED");
  let result;
  try {result = await requireResolvedPromotionHistory({sourceSha: process.env.LKC_SOURCE_SHA, currentRunId: process.env.GITHUB_RUN_ID});}
  catch (error) {
    result = {schemaVersion: 1, status: "STOPPED", sourceSha: process.env.LKC_SOURCE_SHA,
      currentRunId: process.env.GITHUB_RUN_ID, reason: error instanceof PromotionHistoryError ? error.message : "HOSTING_HISTORY_READ_FAILED"};
    if (error instanceof PromotionHistoryError && decimal.test(error.runId ?? "")) result.blockedRunId = error.runId;
  }
  await writeFile(path.join(dir, "promotion-history.json"), JSON.stringify(result, null, 2) + "\n", {mode: 0o600, flag: "wx"});
  console.log("HOSTING_PRIOR_WRITE_HISTORY=" + result.status);
  if (result.reason) console.log("HOSTING_PRIOR_WRITE_ERROR=" + result.reason);
  if (result.blockedRunId) console.log("HOSTING_PRIOR_WRITE_RUN=" + result.blockedRunId);
  return result.status === "HISTORY_CLEAR" ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  promotionHistoryMain().then(code => {process.exitCode = code;}).catch(error => {
    console.error("HOSTING_PRIOR_WRITE_HISTORY=STOPPED");
    console.error(error instanceof PromotionHistoryError ? error.message : "HOSTING_HISTORY_CONTEXT_OR_READ_FAILED");
    process.exitCode = 1;
  });
}
