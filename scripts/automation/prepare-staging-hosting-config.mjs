import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const siteIdPattern = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const vapidPattern = /^B[A-Za-z0-9_-]{80,110}$/u;

function valueAfter(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

function addSiteId(values, candidate) {
  const raw = String(candidate ?? "").trim();
  const match = raw.match(/(?:^|\/)sites\/([^/]+)$/u);
  const siteId = match?.[1] ?? raw;
  if (siteIdPattern.test(siteId)) values.add(siteId);
}

export function extractSiteIds(document) {
  const values = new Set();
  const seen = new Set();

  function visit(value) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "site" || key === "siteId" || key === "name") {
        addSiteId(values, child);
      }
      visit(child);
    }
  }

  visit(document);
  return [...values].sort();
}

function uniqueMatching(values, predicate, label) {
  const matches = values.filter(predicate);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`${label}_SITE_AMBIGUOUS:${matches.join(",")}`);
  }
  return "";
}

export function selectHostingSites(
  siteIds,
  {
    projectId,
    requestedStaffSite = "",
    requestedAdminSite = "",
  },
) {
  const sites = [...new Set(siteIds)].filter((value) => siteIdPattern.test(value)).sort();
  if (sites.length < 2) throw new Error(`HOSTING_SITES_INSUFFICIENT:${sites.length}`);

  for (const [label, requested] of [
    ["STAFF", requestedStaffSite],
    ["ADMIN", requestedAdminSite],
  ]) {
    if (requested && !sites.includes(requested)) {
      throw new Error(`${label}_SITE_NOT_FOUND:${requested}`);
    }
  }

  const staffSite = requestedStaffSite
    || (sites.includes(projectId) ? projectId : "")
    || uniqueMatching(
      sites,
      (site) => site.includes("staff") && !site.includes("admin"),
      "STAFF",
    );
  if (!staffSite) throw new Error("STAFF_SITE_NOT_DISCOVERED");

  const remaining = sites.filter((site) => site !== staffSite);
  const adminSite = requestedAdminSite
    || uniqueMatching(remaining, (site) => site.includes("admin"), "ADMIN")
    || (remaining.length === 1 ? remaining[0] : "");
  if (!adminSite) throw new Error("ADMIN_SITE_NOT_DISCOVERED");
  if (staffSite === adminSite) throw new Error("HOSTING_SITES_NOT_SEPARATED");

  return { staffSite, adminSite };
}

function assertSafeValue(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized || /[\r\n\0]/u.test(normalized)) {
    throw new Error(`FIREBASE_INIT_INVALID:${label}`);
  }
  return normalized;
}

export function validateFirebaseInit(document, projectId, label) {
  const value = document?.result && typeof document.result === "object"
    ? document.result
    : document;
  const config = {
    apiKey: assertSafeValue(value?.apiKey, `${label}.apiKey`),
    authDomain: assertSafeValue(
      value?.authDomain || `${projectId}.firebaseapp.com`,
      `${label}.authDomain`,
    ),
    projectId: assertSafeValue(value?.projectId, `${label}.projectId`),
    storageBucket: assertSafeValue(value?.storageBucket, `${label}.storageBucket`),
    messagingSenderId: assertSafeValue(
      value?.messagingSenderId,
      `${label}.messagingSenderId`,
    ),
    appId: assertSafeValue(value?.appId, `${label}.appId`),
  };
  if (config.projectId !== projectId) {
    throw new Error(`FIREBASE_INIT_PROJECT_MISMATCH:${label}`);
  }
  return config;
}

export function findVapidCandidates(source) {
  return [
    ...new Set(
      String(source ?? "").match(/\bB[A-Za-z0-9_-]{80,110}\b/gu) ?? [],
    ),
  ].filter((candidate) => vapidPattern.test(candidate));
}

async function fetchText(url, { timeoutMs = 15_000, maxBytes = 2_000_000 } = {}) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "lkc-staging-hosting-automation/2" },
  });
  if (!response.ok) throw new Error(`PUBLIC_CONFIG_HTTP_${response.status}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > maxBytes) throw new Error("PUBLIC_CONFIG_TOO_LARGE");
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error("PUBLIC_CONFIG_TOO_LARGE");
  return text;
}

async function loadFirebaseInit(siteId, projectId, label) {
  const text = await fetchText(`https://${siteId}.web.app/__/firebase/init.json`);
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error(`FIREBASE_INIT_JSON_INVALID:${label}`);
  }
  return validateFirebaseInit(document, projectId, label);
}

function extractJavaScriptUrls(source, baseUrl) {
  const urls = [];
  const pattern = /(?:src=|href=|from\s*|import\s*)["']([^"']+\.js(?:\?[^"']*)?)["']/gu;
  for (const match of String(source).matchAll(pattern)) {
    try {
      const url = new URL(match[1], baseUrl);
      if (url.origin === new URL(baseUrl).origin) urls.push(url.href);
    } catch {
      // Ignore malformed non-URL strings from minified application code.
    }
  }
  return [...new Set(urls)];
}

async function discoverVapidKey(siteId) {
  const baseUrl = `https://${siteId}.web.app/`;
  const pending = [baseUrl];
  const visited = new Set();
  const candidates = new Set();
  let totalBytes = 0;

  while (pending.length && visited.size < 60 && totalBytes < 8_000_000) {
    const url = pending.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);
    const source = await fetchText(url);
    totalBytes += Buffer.byteLength(source);
    findVapidCandidates(source).forEach((candidate) => candidates.add(candidate));
    extractJavaScriptUrls(source, url)
      .filter((candidate) => !visited.has(candidate))
      .forEach((candidate) => pending.push(candidate));
  }

  if (candidates.size !== 1) {
    throw new Error(`VAPID_KEY_NOT_UNIQUELY_RECOVERED:${candidates.size}`);
  }
  return [...candidates][0];
}

export function renderClientEnv(config, { projectId, region, vapidKey }) {
  if (!vapidPattern.test(vapidKey)) throw new Error("VAPID_KEY_INVALID");
  const values = {
    VITE_APP_ENVIRONMENT: "staging",
    VITE_EXPECTED_FIREBASE_PROJECT_ID: projectId,
    VITE_FUNCTIONS_REGION: region,
    VITE_FIREBASE_API_KEY: config.apiKey,
    VITE_FIREBASE_AUTH_DOMAIN: config.authDomain,
    VITE_FIREBASE_PROJECT_ID: config.projectId,
    VITE_FIREBASE_STORAGE_BUCKET: config.storageBucket,
    VITE_FIREBASE_MESSAGING_SENDER_ID: config.messagingSenderId,
    VITE_FIREBASE_APP_ID: config.appId,
    VITE_USE_EMULATORS: "false",
    VITE_FIREBASE_VAPID_KEY: vapidKey,
  };
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

async function writeOutput(outputPath, values) {
  if (!outputPath) return;
  const content = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await appendFile(outputPath, `${content}\n`, "utf8");
}

async function main() {
  const projectId = valueAfter("--project", "lip-knots-crew-staging");
  const region = valueAfter("--region", "asia-northeast1");
  const sourceRoot = path.resolve(valueAfter("--source", "."));
  const sitesJsonPath = valueAfter("--sites-json");
  const outputPath = valueAfter("--github-output");
  const requestedStaffSite = valueAfter("--staff-site");
  const requestedAdminSite = valueAfter("--admin-site");
  const suppliedVapidKey = valueAfter("--vapid-key");
  const discoverOnly = process.argv.includes("--discover-only");

  if (projectId !== "lip-knots-crew-staging") {
    throw new Error(`PROJECT_NOT_ALLOWED:${projectId}`);
  }
  if (region !== "asia-northeast1") throw new Error(`REGION_NOT_ALLOWED:${region}`);
  if (!sitesJsonPath) throw new Error("SITES_JSON_REQUIRED");

  const sitesDocument = JSON.parse(await readFile(sitesJsonPath, "utf8"));
  const { staffSite, adminSite } = selectHostingSites(extractSiteIds(sitesDocument), {
    projectId,
    requestedStaffSite,
    requestedAdminSite,
  });

  const publicOutputs = {
    staff_site: staffSite,
    admin_site: adminSite,
    staff_live_url: `https://${staffSite}.web.app`,
    admin_live_url: `https://${adminSite}.web.app`,
  };
  await writeOutput(outputPath, publicOutputs);

  if (discoverOnly) {
    console.log("STAGING_HOSTING_DISCOVERY=PASS");
    console.log(`STAGING_HOSTING_SITES=${staffSite},${adminSite}`);
    return;
  }

  const [staffConfig, adminConfig] = await Promise.all([
    loadFirebaseInit(staffSite, projectId, "staff"),
    loadFirebaseInit(adminSite, projectId, "admin"),
  ]);
  const vapidKey = suppliedVapidKey || await discoverVapidKey(staffSite);
  if (!vapidPattern.test(vapidKey)) throw new Error("VAPID_KEY_INVALID");

  const firebaserc = {
    projects: { staging: projectId },
    targets: {
      [projectId]: {
        hosting: {
          staff: [staffSite],
          admin: [adminSite],
        },
      },
    },
  };
  await writeFile(
    path.join(sourceRoot, ".firebaserc"),
    `${JSON.stringify(firebaserc, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  for (const [app, config] of [
    ["staff", staffConfig],
    ["admin", adminConfig],
  ]) {
    const directory = path.join(sourceRoot, "apps", app);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, ".env.staging"),
      renderClientEnv(config, { projectId, region, vapidKey }),
      { encoding: "utf8", mode: 0o600 },
    );
  }

  console.log("STAGING_HOSTING_CONFIG=PASS");
  console.log(`STAGING_HOSTING_SITES=${staffSite},${adminSite}`);
  console.log("STAGING_HOSTING_CONFIG_VALUES_PRINTED=false");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error("STAGING_HOSTING_CONFIG=FAIL");
    console.error(`STAGING_HOSTING_CONFIG_ERROR=${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
