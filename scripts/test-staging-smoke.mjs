import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateGoNoGo,
  runSmokeChecks,
  validateSmokeConfig,
  verifySmokeEvidence,
  writeSmokeEvidence,
} from "./staging-smoke-core.mjs";

const config = {
  schemaVersion: 1,
  environment: "staging",
  staffBaseUrl: "https://staff-staging.web.app",
  adminBaseUrl: "https://admin-staging.web.app",
  forbiddenHosts: ["staff-production.web.app", "admin-production.web.app"],
  requestTimeoutMs: 1000,
  retries: 2,
  staffHtmlMarkers: ["<div id=\"root\"></div>"],
  adminHtmlMarkers: ["<div id=\"root\"></div>"],
  staffManifestName: "Lip Knots Crew",
  adminManifestName: "Lip Knots Crew Admin",
  serviceWorkerMarker: "self",
};

function response(body, { status = 200, contentType = "text/plain", url = "", headers = {} } = {}) {
  const raw = new Response(body, { status, headers: { "content-type": contentType, ...headers } });
  return { status: raw.status, headers: raw.headers, body: raw.body, url };
}

function successFetch(url) {
  const parsed = new URL(url);
  if (parsed.pathname === "/") {
    return response("<html><div id=\"root\"></div></html>", { contentType: "text/html", url });
  }
  if (parsed.pathname === "/manifest.webmanifest") {
    const name = parsed.hostname.startsWith("admin-") ? config.adminManifestName : config.staffManifestName;
    return response(JSON.stringify({ name }), { contentType: "application/manifest+json", url });
  }
  return response("self.addEventListener('fetch', () => {});", { contentType: "text/javascript", url });
}

let cases = 0;
assert.deepEqual(validateSmokeConfig(config), []); cases += 1;
assert.ok(validateSmokeConfig({ ...config, staffBaseUrl: "http://staff-staging.web.app" }).some((error) => error.includes("HTTPS"))); cases += 1;
assert.ok(validateSmokeConfig({ ...config, staffBaseUrl: "https://127.0.0.1" }).some((error) => error.includes("private host"))); cases += 1;
assert.ok(validateSmokeConfig({ ...config, adminBaseUrl: config.staffBaseUrl }).some((error) => error.includes("分離"))); cases += 1;

let results = await runSmokeChecks(config, { fetchImpl: async (url) => successFetch(url) });
assert.equal(results.length, 6);
assert.ok(results.every((item) => item.passed)); cases += 1;

results = await runSmokeChecks(config, {
  fetchImpl: async (url) => url === config.staffBaseUrl + "/"
    ? response("<html>missing</html>", { contentType: "text/html", url })
    : successFetch(url),
});
assert.equal(results[0].passed, false);
assert.equal(results[0].error, "required HTML marker is missing"); cases += 1;

let productionRequests = 0;
results = await runSmokeChecks(config, {
  fetchImpl: async (url) => {
    if (url === config.staffBaseUrl + "/") {
      return response("", {
        status: 302,
        contentType: "text/html",
        url,
        headers: { location: "https://staff-production.web.app/" },
      });
    }
    if (url.includes("production")) productionRequests += 1;
    return successFetch(url);
  },
});
assert.equal(results[0].error, "redirected to a forbidden production host"); cases += 1;
assert.equal(productionRequests, 0);

let attempts = 0;
results = await runSmokeChecks(config, {
  fetchImpl: async (url) => {
    if (url === config.staffBaseUrl + "/" && attempts++ === 0) {
      return response("unavailable", { status: 503, contentType: "text/html", url });
    }
    return successFetch(url);
  },
});
assert.equal(results[0].passed, true);
assert.equal(results[0].attempts, 2); cases += 1;

results = await runSmokeChecks(config, {
  fetchImpl: async (url) => url === config.staffBaseUrl + "/"
    ? response("x".repeat(1024 * 1024 + 1), { contentType: "text/html", url })
    : successFetch(url),
});
assert.equal(results[0].passed, false);
assert.equal(results[0].error, "request failed"); cases += 1;

const passingResults = await runSmokeChecks(config, { fetchImpl: async (url) => successFetch(url) });
const go = evaluateGoNoGo({
  smokeResults: passingResults,
  preflightPassed: true,
  readinessPassed: true,
  checkpointErrors: [],
  deploymentStatus: "succeeded",
});
assert.deepEqual(go, { decision: "GO", blockers: [] }); cases += 1;
const noGo = evaluateGoNoGo({
  smokeResults: [],
  preflightPassed: true,
  readinessPassed: true,
  checkpointErrors: [],
  deploymentStatus: null,
});
assert.equal(noGo.decision, "NO_GO");
assert.ok(noGo.blockers.some((item) => item.includes("deployment"))); cases += 1;

const directory = await mkdtemp(join(tmpdir(), "lkc-smoke-"));
try {
  const report = {
    schemaVersion: 1,
    releaseId: "v2.6.0-test",
    releaseVersion: "2.6.0",
    firebaseProjectId: "crew-staging",
    environment: "staging",
    recordedAt: "2026-07-14T02:00:00.000Z",
    preflightPassed: true,
    readinessPassed: true,
    checkpointPassed: true,
    deploymentStatus: "succeeded",
    smokeResults: passingResults,
    decision: "GO",
    blockers: [],
  };
  await writeSmokeEvidence({ checkpointDirectory: directory, report });
  let verified = await verifySmokeEvidence(directory);
  assert.deepEqual(verified.errors, []); cases += 1;

  const markdownPath = join(directory, "GO_NO_GO.md");
  const markdown = await readFile(markdownPath, "utf8");
  await writeFile(markdownPath, `${markdown}tampered\n`, "utf8");
  verified = await verifySmokeEvidence(directory);
  assert.ok(verified.errors.some((error) => error.includes("SHA-256"))); cases += 1;
  await writeFile(markdownPath, markdown, "utf8");

  await assert.rejects(
    writeSmokeEvidence({ checkpointDirectory: directory, report }),
    /already exists/u
  ); cases += 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log(`staging smoke and Go/No-Go tests passed (${cases} cases, 6 remote checks)`);
