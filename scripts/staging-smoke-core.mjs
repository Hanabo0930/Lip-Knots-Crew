import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const maxBodyBytes = 1024 * 1024;
const smokeCheckIds = [
  "staff-app",
  "admin-app",
  "staff-manifest",
  "admin-manifest",
  "staff-service-worker",
  "admin-service-worker",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hasPlaceholder(value) {
  return /YOUR_|REPLACE_ME|example\.com/iu.test(String(value ?? ""));
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (/^127\./u.test(host) || /^10\./u.test(host) || /^169\.254\./u.test(host) || /^192\.168\./u.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./u);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function validateHttpsUrl(value, label, allowPlaceholders, errors) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") errors.push(`${label}はHTTPSが必須です。`);
    if (url.username || url.password) errors.push(`${label}に認証情報を埋め込めません。`);
    if (!allowPlaceholders && isPrivateHostname(url.hostname)) errors.push(`${label}にprivate hostを使用できません。`);
    if (url.pathname !== "/" || url.search || url.hash) errors.push(`${label}はoriginだけを指定してください。`);
  } catch {
    errors.push(`${label}がURLとして不正です。`);
  }
}

export function validateSmokeConfig(config, { allowPlaceholders = false } = {}) {
  const errors = [];
  if (config?.schemaVersion !== 1) errors.push("schemaVersionは1が必須です。");
  if (config?.environment !== "staging") errors.push("environmentはstaging固定です。");
  validateHttpsUrl(config?.staffBaseUrl, "staffBaseUrl", allowPlaceholders, errors);
  validateHttpsUrl(config?.adminBaseUrl, "adminBaseUrl", allowPlaceholders, errors);
  if (config?.staffBaseUrl === config?.adminBaseUrl) errors.push("staffBaseUrlとadminBaseUrlは分離してください。");

  if (!Array.isArray(config?.forbiddenHosts) || !config.forbiddenHosts.length) {
    errors.push("forbiddenHostsを1件以上指定してください。");
  } else {
    for (const host of config.forbiddenHosts) {
      if (typeof host !== "string" || !host.trim() || /[/:\s\r\n\0]/u.test(host)) {
        errors.push("forbiddenHostsはhostnameだけを指定してください。");
      }
    }
  }
  if (!Number.isInteger(config?.requestTimeoutMs) || config.requestTimeoutMs < 1000 || config.requestTimeoutMs > 30000) {
    errors.push("requestTimeoutMsは1000～30000の整数にしてください。");
  }
  if (!Number.isInteger(config?.retries) || config.retries < 0 || config.retries > 3) {
    errors.push("retriesは0～3の整数にしてください。");
  }
  for (const [key, label] of [["staffHtmlMarkers", "staff"], ["adminHtmlMarkers", "admin"]]) {
    const markers = config?.[key];
    if (!Array.isArray(markers) || !markers.length || markers.some((marker) => typeof marker !== "string" || !marker || marker.length > 200 || /[\r\n\0]/u.test(marker))) {
      errors.push(`${label}HtmlMarkersが不正です。`);
    }
  }
  for (const key of ["staffManifestName", "adminManifestName", "serviceWorkerMarker"]) {
    const value = config?.[key];
    if (typeof value !== "string" || !value || value.length > 200 || /[\r\n\0]/u.test(value)) {
      errors.push(`${key}が不正です。`);
    }
  }
  if (!allowPlaceholders) {
    const values = [
      config?.staffBaseUrl,
      config?.adminBaseUrl,
      ...(config?.forbiddenHosts ?? []),
    ];
    if (values.some(hasPlaceholder)) errors.push("smoke設定にサンプル値が残っています。");
  }
  if (Array.isArray(config?.forbiddenHosts)) {
    for (const [key, label] of [["staffBaseUrl", "staffBaseUrl"], ["adminBaseUrl", "adminBaseUrl"]]) {
      try {
        if (forbiddenHost(new URL(config?.[key]).hostname, config.forbiddenHosts)) {
          errors.push(`${label}がforbiddenHostsに含まれています。`);
        }
      } catch {
        // URL形式のエラーはvalidateHttpsUrlで報告する。
      }
    }
  }
  return [...new Set(errors)];
}

function endpoint(baseUrl, pathname) {
  return new URL(pathname, baseUrl).href;
}

export function buildSmokeChecks(config) {
  return [
    { id: "staff-app", kind: "html", url: endpoint(config.staffBaseUrl, "/"), markers: config.staffHtmlMarkers },
    { id: "admin-app", kind: "html", url: endpoint(config.adminBaseUrl, "/"), markers: config.adminHtmlMarkers },
    { id: "staff-manifest", kind: "manifest", url: endpoint(config.staffBaseUrl, "/manifest.webmanifest"), expectedName: config.staffManifestName },
    { id: "admin-manifest", kind: "manifest", url: endpoint(config.adminBaseUrl, "/manifest.webmanifest"), expectedName: config.adminManifestName },
    { id: "staff-service-worker", kind: "javascript", url: endpoint(config.staffBaseUrl, "/sw.js"), markers: [config.serviceWorkerMarker] },
    { id: "admin-service-worker", kind: "javascript", url: endpoint(config.adminBaseUrl, "/sw.js"), markers: [config.serviceWorkerMarker] },
  ];
}

async function readLimitedBody(response) {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > maxBodyBytes) throw new Error("response body exceeds 1 MiB");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBodyBytes) throw new Error("response body exceeds 1 MiB");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBodyBytes) {
      await reader.cancel();
      throw new Error("response body exceeds 1 MiB");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function forbiddenHost(hostname, forbiddenHosts) {
  const host = hostname.toLowerCase();
  return forbiddenHosts.some((item) => {
    const forbidden = item.toLowerCase();
    return host === forbidden || host.endsWith(`.${forbidden}`);
  });
}

class SmokeRequestError extends Error {}

function assertSafeRemoteUrl(value, config) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new SmokeRequestError("redirected to a non-HTTPS URL");
  if (url.username || url.password) throw new SmokeRequestError("redirected to a URL with embedded credentials");
  if (isPrivateHostname(url.hostname)) throw new SmokeRequestError("redirected to a private host");
  if (forbiddenHost(url.hostname, config.forbiddenHosts)) {
    throw new SmokeRequestError("redirected to a forbidden production host");
  }
  return url;
}

async function fetchWithSafeRedirects(url, options, fetchImpl, config) {
  let currentUrl = assertSafeRemoteUrl(url, config).href;
  const redirectStatuses = new Set([301, 302, 303, 307, 308]);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetchImpl(currentUrl, { ...options, redirect: "manual" });
    if (redirectStatuses.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new SmokeRequestError("redirect response has no location");
      if (redirects === 5) throw new SmokeRequestError("too many redirects");
      currentUrl = assertSafeRemoteUrl(new URL(location, currentUrl).href, config).href;
      continue;
    }
    const finalUrl = assertSafeRemoteUrl(response.url || currentUrl, config).href;
    return { response, finalUrl };
  }
  throw new SmokeRequestError("too many redirects");
}

function checkResponse(check, response, body, config, finalUrlValue) {
  if (response.status < 200 || response.status >= 300) return `HTTP ${response.status}`;
  const finalUrl = new URL(finalUrlValue);
  if (finalUrl.protocol !== "https:") return "final URL is not HTTPS";
  if (forbiddenHost(finalUrl.hostname, config.forbiddenHosts)) return "redirected to a forbidden production host";
  if (check.kind === "html") {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return "content-type is not text/html";
    const missing = check.markers.find((marker) => !body.includes(marker));
    if (missing) return "required HTML marker is missing";
  }
  if (check.kind === "manifest") {
    try {
      const manifest = JSON.parse(body);
      if (manifest.name !== check.expectedName) return "manifest name mismatch";
    } catch {
      return "manifest JSON is invalid";
    }
  }
  if (check.kind === "javascript") {
    const contentType = response.headers.get("content-type") ?? "";
    if (!/(javascript|ecmascript)/iu.test(contentType)) return "content-type is not JavaScript";
    const missing = check.markers.find((marker) => !body.includes(marker));
    if (missing) return "service worker marker is missing";
  }
  return null;
}

export async function runSmokeChecks(config, { fetchImpl = globalThis.fetch } = {}) {
  const configErrors = validateSmokeConfig(config);
  if (configErrors.length) throw new Error(configErrors.join(" / "));
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  const results = [];

  for (const check of buildSmokeChecks(config)) {
    const started = Date.now();
    let result = null;
    for (let attempt = 1; attempt <= config.retries + 1; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      try {
        const fetched = await fetchWithSafeRedirects(check.url, {
          method: "GET",
          signal: controller.signal,
          headers: { "user-agent": "Lip-Knots-Crew-Staging-Smoke/1" },
        }, fetchImpl, config);
        const { response, finalUrl } = fetched;
        const body = await readLimitedBody(response);
        const error = checkResponse(check, response, body, config, finalUrl);
        const finalHost = new URL(finalUrl).hostname;
        result = {
          id: check.id,
          passed: !error,
          attempts: attempt,
          status: response.status,
          finalHost,
          durationMs: Date.now() - started,
          error,
        };
        if (!error) break;
      } catch (error) {
        result = {
          id: check.id,
          passed: false,
          attempts: attempt,
          status: null,
          finalHost: null,
          durationMs: Date.now() - started,
          error: error.name === "AbortError"
            ? "request timed out"
            : error instanceof SmokeRequestError ? error.message : "request failed",
        };
      } finally {
        clearTimeout(timeout);
      }
    }
    results.push(result);
  }
  return results;
}

export function evaluateGoNoGo({
  smokeResults,
  preflightPassed,
  readinessPassed,
  checkpointErrors,
  deploymentStatus,
}) {
  const blockers = [];
  if (!preflightPassed) blockers.push("staging preflight failed");
  if (!readinessPassed) blockers.push("deployment readiness failed");
  if (checkpointErrors.length) blockers.push("release checkpoint verification failed");
  if (deploymentStatus !== "succeeded") blockers.push("successful deployment result is missing");
  const resultIds = smokeResults.map((result) => result.id);
  if (
    resultIds.length !== smokeCheckIds.length ||
    new Set(resultIds).size !== resultIds.length ||
    smokeCheckIds.some((id) => !resultIds.includes(id))
  ) {
    blockers.push("smoke check set is incomplete");
  }
  for (const result of smokeResults) {
    if (!result.passed) blockers.push(`smoke check failed: ${result.id}`);
  }
  return { decision: blockers.length ? "NO_GO" : "GO", blockers };
}

export async function writeSmokeEvidence({ checkpointDirectory, report, replace = false }) {
  const reportPath = resolve(checkpointDirectory, "smoke-report.json");
  const markdownPath = resolve(checkpointDirectory, "GO_NO_GO.md");
  const checksumPath = resolve(checkpointDirectory, "smoke-evidence.sha256");
  if ((existsSync(reportPath) || existsSync(markdownPath) || existsSync(checksumPath)) && !replace) {
    throw new Error("smoke evidence already exists");
  }
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = `# Staging Go / No-Go\n\n- Release ID: ${report.releaseId}\n- Version: ${report.releaseVersion}\n- Decision: **${report.decision}**\n- Recorded: ${report.recordedAt}\n- Smoke checks: ${report.smokeResults.filter((item) => item.passed).length}/${report.smokeResults.length}\n\n## Blockers\n\n${report.blockers.length ? report.blockers.map((item) => `- ${item}`).join("\n") : "- None"}\n`;
  const checksum = `${sha256(reportText)}  smoke-report.json\n${sha256(markdown)}  GO_NO_GO.md\n`;
  const temporaryPaths = [reportPath, markdownPath, checksumPath].map((path) => `${path}.tmp-${process.pid}`);
  try {
    await writeFile(temporaryPaths[0], reportText, { encoding: "utf8", mode: 0o600 });
    await writeFile(temporaryPaths[1], markdown, { encoding: "utf8", mode: 0o600 });
    await writeFile(temporaryPaths[2], checksum, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPaths[0], reportPath);
    await rename(temporaryPaths[1], markdownPath);
    await rename(temporaryPaths[2], checksumPath);
  } catch (error) {
    await Promise.all(temporaryPaths.map((path) => rm(path, { force: true })));
    throw error;
  }
  return { reportPath, markdownPath };
}

function validateSmokeReport(report) {
  const errors = [];
  if (report.schemaVersion !== 1) errors.push("smoke report schemaVersion mismatch");
  if (report.environment !== "staging") errors.push("smoke report environment mismatch");
  for (const key of ["releaseId", "releaseVersion", "firebaseProjectId"]) {
    if (typeof report[key] !== "string" || !report[key] || /[\r\n\0]/u.test(report[key])) {
      errors.push(`smoke report ${key} is invalid`);
    }
  }
  if (Number.isNaN(Date.parse(report.recordedAt))) errors.push("smoke report recordedAt is invalid");
  for (const key of ["preflightPassed", "readinessPassed", "checkpointPassed"]) {
    if (typeof report[key] !== "boolean") errors.push(`smoke report ${key} is invalid`);
  }
  if (report.deploymentStatus !== null && !new Set(["succeeded", "failed", "rolled_back"]).has(report.deploymentStatus)) {
    errors.push("smoke report deploymentStatus is invalid");
  }
  if (!Array.isArray(report.smokeResults) || !Array.isArray(report.blockers)) {
    errors.push("smoke report result arrays are invalid");
    return errors;
  }
  const ids = report.smokeResults.map((result) => result?.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !smokeCheckIds.includes(id))) {
    errors.push("smoke report check IDs are invalid");
  }
  if (report.smokeResults.some((result) => typeof result?.passed !== "boolean")) {
    errors.push("smoke report check result is invalid");
  }
  const expected = evaluateGoNoGo({
    smokeResults: report.smokeResults,
    preflightPassed: report.preflightPassed,
    readinessPassed: report.readinessPassed,
    checkpointErrors: report.checkpointPassed ? [] : ["failed"],
    deploymentStatus: report.deploymentStatus,
  });
  if (report.decision !== expected.decision) errors.push("smoke report decision is inconsistent");
  if (JSON.stringify(report.blockers) !== JSON.stringify(expected.blockers)) {
    errors.push("smoke report blockers are inconsistent");
  }
  return errors;
}

export async function verifySmokeEvidence(checkpointDirectory) {
  const errors = [];
  try {
    const reportText = await readFile(resolve(checkpointDirectory, "smoke-report.json"), "utf8");
    const markdown = await readFile(resolve(checkpointDirectory, "GO_NO_GO.md"), "utf8");
    const checksum = await readFile(resolve(checkpointDirectory, "smoke-evidence.sha256"), "utf8");
    const expected = `${sha256(reportText)}  smoke-report.json\n${sha256(markdown)}  GO_NO_GO.md\n`;
    if (checksum !== expected) errors.push("smoke evidence SHA-256 mismatch");
    const report = JSON.parse(reportText);
    errors.push(...validateSmokeReport(report));
    return { errors, report };
  } catch (error) {
    return { errors: [`smoke evidence could not be verified: ${error.message}`], report: null };
  }
}
