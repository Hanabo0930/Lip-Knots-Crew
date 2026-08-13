import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const MAX_INSPECTION_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_500;

function valueAfter(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

function parseCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sanitizeMessage(value) {
  return String(value ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .slice(0, 800);
}

function isAllowedSiteHost(hostname, siteId) {
  return hostname === `${siteId}.web.app`
    || hostname === `${siteId}.firebaseapp.com`
    || hostname.startsWith(`${siteId}--`);
}

export function validateTargetUrl(rawUrl, allowedSites) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error(`BROWSER_URL_NOT_HTTPS:${rawUrl}`);
  if (
    !url.hostname.endsWith(".web.app")
    && !url.hostname.endsWith(".firebaseapp.com")
  ) {
    throw new Error(`BROWSER_URL_HOST_REJECTED:${url.hostname}`);
  }
  if (/prod(uction)?/iu.test(url.hostname)) {
    throw new Error(`BROWSER_PRODUCTION_URL_REJECTED:${url.hostname}`);
  }
  if (!allowedSites.some((siteId) => isAllowedSiteHost(url.hostname, siteId))) {
    throw new Error(`BROWSER_URL_SITE_REJECTED:${url.hostname}`);
  }
  return url.origin;
}

export function shouldRetryBrowserIssues(issues, attempt, maxAttempts = MAX_INSPECTION_ATTEMPTS) {
  return issues.length > 0 && attempt < maxAttempts;
}

export function evaluateBrowserResult(result) {
  const issues = [];
  if (result.httpStatus !== 200) issues.push(`HTTP_${result.httpStatus}`);
  if (!result.rootVisible) issues.push("ROOT_NOT_VISIBLE");
  if (result.rootChildCount < 1) issues.push("ROOT_NOT_MOUNTED");
  if (result.bodyTextLength < 10) issues.push("BODY_EFFECTIVELY_BLANK");
  if (result.demoModeVisible) issues.push("STAGING_CONFIG_NOT_ACTIVE");
  if (result.navigationDurationMs > 12_000) issues.push("NAVIGATION_TOO_SLOW");
  if (result.pageErrors.length) issues.push("PAGE_ERROR");
  if (result.fatalConsoleErrors.length) issues.push("FATAL_CONSOLE_ERROR");
  if (result.failedResources.length) issues.push("STATIC_RESOURCE_FAILURE");
  return issues;
}

function isFatalConsoleError(message) {
  return [
    /Cannot access .* before initialization/iu,
    /Failed to fetch dynamically imported module/iu,
    /Firebase設定/iu,
    /\b(?:ReferenceError|SyntaxError|TypeError|Uncaught)\b/iu,
  ].some((pattern) => pattern.test(message));
}

async function inspectPage(browser, { label, url, evidenceDirectory, attempt }) {
  const pageErrors = [];
  const fatalConsoleErrors = [];
  const failedResources = [];
  const context = await browser.newContext({
    serviceWorkers: "allow",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();

  page.on("pageerror", (error) => {
    pageErrors.push(sanitizeMessage(error.message));
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = sanitizeMessage(message.text());
    if (isFatalConsoleError(text)) fatalConsoleErrors.push(text);
  });
  page.on("requestfailed", (request) => {
    if (!["document", "script", "stylesheet"].includes(request.resourceType())) return;
    failedResources.push({
      url: sanitizeMessage(request.url()),
      error: sanitizeMessage(request.failure()?.errorText ?? "request failed"),
    });
  });
  page.on("response", (response) => {
    const request = response.request();
    if (!["document", "script", "stylesheet"].includes(request.resourceType())) return;
    if (response.status() < 400) return;
    failedResources.push({
      url: sanitizeMessage(response.url()),
      error: `HTTP_${response.status()}`,
    });
  });

  let httpStatus = 0;
  let rootVisible = false;
  let rootChildCount = 0;
  let bodyTextLength = 0;
  let demoModeVisible = false;
  let navigationDurationMs = Number.POSITIVE_INFINITY;
  let navigationError = "";

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    httpStatus = response?.status() ?? 0;
    await page.waitForFunction(
      () => {
        const root = document.querySelector("#root");
        return Boolean(root && root.childElementCount > 0 && document.body.innerText.trim().length > 9);
      },
      undefined,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(750);
    const pageState = await page.evaluate(() => {
      const root = document.querySelector("#root");
      const navigation = performance.getEntriesByType("navigation")[0];
      return {
        rootVisible: Boolean(root && getComputedStyle(root).display !== "none"),
        rootChildCount: root?.childElementCount ?? 0,
        bodyTextLength: document.body.innerText.trim().length,
        demoModeVisible: document.body.innerText.includes("LIVE DEMO"),
        navigationDurationMs: navigation && "duration" in navigation
          ? Math.round(navigation.duration)
          : Number.POSITIVE_INFINITY,
      };
    });
    ({ rootVisible, rootChildCount, bodyTextLength, demoModeVisible, navigationDurationMs } = pageState);
  } catch (error) {
    navigationError = sanitizeMessage(error instanceof Error ? error.message : String(error));
    pageErrors.push(navigationError);
  }

  await page.screenshot({
    path: path.join(evidenceDirectory, `${label}-attempt-${attempt}.png`),
    fullPage: true,
  }).catch((error) => {
    pageErrors.push(`SCREENSHOT_FAILED:${sanitizeMessage(error)}`);
  });
  await context.close();

  const result = {
    label,
    url,
    attempt,
    httpStatus,
    rootVisible,
    rootChildCount,
    bodyTextLength,
    demoModeVisible,
    navigationDurationMs,
    pageErrors,
    fatalConsoleErrors,
    failedResources,
  };
  return { ...result, issues: evaluateBrowserResult(result) };
}

async function inspectTargetWithRetry(browser, target, evidenceDirectory) {
  const attempts = [];
  for (let attempt = 1; attempt <= MAX_INSPECTION_ATTEMPTS; attempt += 1) {
    const result = await inspectPage(browser, {
      ...target,
      evidenceDirectory,
      attempt,
    });
    attempts.push(result);
    if (!shouldRetryBrowserIssues(result.issues, attempt)) break;
    console.warn(
      `${target.label}: browser check attempt ${attempt} failed (${result.issues.join(", ")}); retrying once.`,
    );
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }

  const finalResult = attempts.at(-1);
  if (!finalResult) throw new Error(`BROWSER_CHECK_NO_RESULT:${target.label}`);
  await copyFile(
    path.join(evidenceDirectory, `${target.label}-attempt-${finalResult.attempt}.png`),
    path.join(evidenceDirectory, `${target.label}.png`),
  ).catch(() => undefined);
  return {
    ...finalResult,
    attemptCount: attempts.length,
    attempts,
  };
}

async function main() {
  const staffUrl = valueAfter("--staff-url");
  const adminUrl = valueAfter("--admin-url");
  const allowedSites = parseCsv(valueAfter("--allowed-sites"));
  const evidenceDirectory = path.resolve(
    valueAfter("--evidence-dir", "hosting-browser-evidence"),
  );
  if (!staffUrl || !adminUrl || allowedSites.length !== 2) {
    throw new Error("BROWSER_CHECK_ARGUMENTS_REQUIRED");
  }
  const targets = [
    { label: "staff", url: validateTargetUrl(staffUrl, allowedSites) },
    { label: "admin", url: validateTargetUrl(adminUrl, allowedSites) },
  ];
  if (targets[0].url === targets[1].url) throw new Error("BROWSER_URLS_NOT_SEPARATED");

  await mkdir(evidenceDirectory, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  let results;
  try {
    results = [];
    for (const target of targets) {
      results.push(await inspectTargetWithRetry(browser, target, evidenceDirectory));
    }
  } finally {
    await browser.close();
  }

  const report = {
    schemaVersion: 2,
    checkedAt: new Date().toISOString(),
    results,
    passed: results.every((result) => result.issues.length === 0),
  };
  await writeFile(
    path.join(evidenceDirectory, "browser-evidence.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  for (const result of results) {
    console.log(
      `${result.label}: HTTP ${result.httpStatus}, root children ${result.rootChildCount}, ` +
      `navigation ${result.navigationDurationMs}ms, issues ${result.issues.length}, ` +
      `attempts ${result.attemptCount}`,
    );
  }
  if (!report.passed) throw new Error("BROWSER_CHECK_FAILED");
  console.log("STAGING_HOSTING_BROWSER_CHECK=PASS");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error("STAGING_HOSTING_BROWSER_CHECK=FAIL");
    console.error(`STAGING_HOSTING_BROWSER_ERROR=${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
