import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(root, "apps", "admin", "src", "App.tsx");
const authPath = path.join(root, "functions", "src", "auth.ts");
const indexPath = path.join(root, "functions", "src", "index.ts");
const firebaseJsonPath = path.join(root, "firebase.json");
const adminSwPath = path.join(root, "apps", "admin", "src", "sw.ts");
const staffSwPath = path.join(root, "apps", "staff", "src", "sw.ts");
const adminVitePath = path.join(root, "apps", "admin", "vite.config.ts");
const staffVitePath = path.join(root, "apps", "staff", "vite.config.ts");
const adminMessagingSwPath = path.join(root, "apps", "admin", "public", "firebase-messaging-sw.js");
const staffMessagingSwPath = path.join(root, "apps", "staff", "public", "firebase-messaging-sw.js");
const adminFirebaseConfigPath = path.join(root, "apps", "admin", "src", "firebase-config.ts");

const appSource = fs.readFileSync(appPath, "utf8");
const authSource = fs.readFileSync(authPath, "utf8");
const indexSource = fs.readFileSync(indexPath, "utf8");
const firebaseJson = fs.readFileSync(firebaseJsonPath, "utf8");
const adminSw = fs.readFileSync(adminSwPath, "utf8");
const staffSw = fs.readFileSync(staffSwPath, "utf8");
const adminVite = fs.readFileSync(adminVitePath, "utf8");
const staffVite = fs.readFileSync(staffVitePath, "utf8");
const adminMessagingSw = fs.readFileSync(adminMessagingSwPath, "utf8");
const staffMessagingSw = fs.readFileSync(staffMessagingSwPath, "utf8");
const adminFirebaseConfig = fs.readFileSync(adminFirebaseConfigPath, "utf8");

function normalizeNewlines(source) {
  return source.replace(/\r\n/g, "\n").trim();
}

function indexExportsUnchanged() {
  try {
    execSync("git diff --quiet d1d91bacad8331fc51cc3aeffcdc7718c924d373 -- functions/src/index.ts", {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function countMatches(source, pattern) {
  return (source.match(pattern) ?? []).length;
}

function hostingTargetHeaders(target) {
  const match = firebaseJson.match(new RegExp(`"target": "${target}"[\\s\\S]*?"headers": \\[([\\s\\S]*?)\\]\\s*,\\s*"rewrites"`, "m"));
  return match?.[1] ?? "";
}

const staffHeaders = hostingTargetHeaders("staff");
const adminHeaders = hostingTargetHeaders("admin");

const checks = [
  {
    label: "Admin App.tsx has zero direct jobs collection reads",
    ok: !/collection\(\s*db,\s*["']jobs["']\s*\)/.test(appSource),
  },
  {
    label: "Admin App.tsx has zero direct staffProfiles collection reads",
    ok: !/collection\(\s*db,\s*["']staffProfiles["']\s*\)/.test(appSource),
  },
  {
    label: "Admin App.tsx has zero getDocs calls",
    ok: !/\bgetDocs\b/.test(appSource),
  },
  {
    label: "startup directory is loaded from bootstrapSession response",
    ok:
      appSource.includes('httpsCallable(activeFunctions,"bootstrapSession")') &&
      appSource.includes("Array.isArray(bootstrapData.jobs)") &&
      appSource.includes("Array.isArray(bootstrapData.staff)"),
  },
  {
    label: "startup primary work excludes loadJobs and loadStaff",
    ok:
      /primaryResults\s*=\s*await Promise\.allSettled\(\[\s*loadSheetIssues\(isCurrentRun\),\s*loadDashboard\(dashboardMonth,isCurrentRun\),\s*loadResubmissions\(isCurrentRun\),\s*\]\)/.test(appSource) &&
      !/primaryResults[\s\S]{0,220}loadJobs\(/.test(appSource),
  },
  {
    label: "directory refresh uses bootstrapSession refreshDirectory callable",
    ok:
      appSource.includes('httpsCallable(functions, "bootstrapSession")') &&
      appSource.includes("refreshDirectory: true"),
  },
  {
    label: "no new Cloud Function exports were added",
    ok: indexExportsUnchanged(),
  },
  {
    label: "bootstrapSession requires authentication",
    ok: authSource.includes("requireAuth(request)") && authSource.includes("export const bootstrapSession"),
  },
  {
    label: "directory refresh requires admin claims server-side",
    ok: authSource.includes("requireAdmin(request)") && authSource.includes("refreshDirectory"),
  },
  {
    label: "directory fetch enforces companyId boundary server-side",
    ok:
      authSource.includes('.where("companyId", "==", companyId)') &&
      authSource.includes("fetchAdminDirectory"),
  },
  {
    label: "auth generation guard remains on startup",
    ok:
      appSource.includes("const currentRun=++authRun;") &&
      appSource.includes("canApplyAuthResult(isCurrentRun)") &&
      appSource.includes("authRun+=1;"),
  },
  {
    label: "account changes clear auth-scoped Admin data",
    ok:
      appSource.includes("if(activeUid!==nextUid)") &&
      ["setJobs([])", "setStaff([])", "setSelectedAdminJobId(\"\")"].every((call) => appSource.includes(call)),
  },
  {
    label: "Staff hosting index.html is always revalidated",
    ok: staffHeaders.includes('"/index.html"') && staffHeaders.includes('"no-cache"'),
  },
  {
    label: "Admin hosting index.html is always revalidated",
    ok: adminHeaders.includes('"/index.html"') && adminHeaders.includes('"no-cache"'),
  },
  {
    label: "Staff hosting navigation HTML is always revalidated",
    ok: staffHeaders.includes('"**/*.html"') && staffHeaders.includes('"no-cache"'),
  },
  {
    label: "Admin hosting navigation HTML is always revalidated",
    ok: adminHeaders.includes('"**/*.html"') && adminHeaders.includes('"no-cache"'),
  },
  {
    label: "Staff hashed assets are cached immutable for one year",
    ok: staffHeaders.includes('"/assets/**"') && staffHeaders.includes("max-age=31536000, immutable"),
  },
  {
    label: "Admin hashed assets are cached immutable for one year",
    ok: adminHeaders.includes('"/assets/**"') && adminHeaders.includes("max-age=31536000, immutable"),
  },
  {
    label: "Staff service worker uses network-first navigation",
    ok: staffSw.includes("NavigationRoute") && staffSw.includes("NetworkFirst"),
  },
  {
    label: "Admin service worker uses network-first navigation",
    ok: adminSw.includes("NavigationRoute") && adminSw.includes("NetworkFirst"),
  },
  {
    label: "Staff PWA precache excludes HTML",
    ok: !staffVite.includes("html,png") && staffVite.includes('"**/*.{js,css,png,svg,ico}"'),
  },
  {
    label: "Admin PWA precache excludes HTML",
    ok: !adminVite.includes("html,png") && adminVite.includes('"**/*.{js,css,png,svg,ico}"'),
  },
  {
    label: "service worker activation avoids immediate infinite reload",
    ok:
      adminSw.includes('event.data?.type === "SKIP_WAITING"') &&
      staffSw.includes('event.data?.type === "SKIP_WAITING"') &&
      !adminSw.includes("self.skipWaiting();\ncleanupOutdatedCaches") &&
      !staffSw.includes("self.skipWaiting();\ncleanupOutdatedCaches") &&
      !adminSw.includes("self.skipWaiting();\nclientsClaim();") &&
      !staffSw.includes("self.skipWaiting();\nclientsClaim();"),
  },
  {
    label: "legacy admin firebase-messaging-sw.js remains unchanged placeholder",
    ok: adminMessagingSw.includes("YOUR_") && !adminMessagingSw.includes("lip-knots-crew-staging"),
  },
  {
    label: "legacy staff firebase-messaging-sw.js remains unchanged placeholder",
    ok: staffMessagingSw.includes("YOUR_") && !staffMessagingSw.includes("lip-knots-crew-staging"),
  },
  {
    label: "authDomain remains the staging Firebase domain",
    ok:
      adminFirebaseConfig.includes("authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN") &&
      !adminFirebaseConfig.includes(".web.app") &&
      fs.readFileSync(
        path.join(root, "scripts", "automation", "prepare-staging-hosting-config.mjs"),
        "utf8"
      ).includes("`${projectId}.firebaseapp.com`"),
  },
];

const failures = checks.filter((check) => !check.ok);
for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"} admin startup cache v2: ${check.label}`);
}

const directJobsReads = countMatches(appSource, /collection\(\s*db,\s*["']jobs["']\s*\)/g);
const directStaffReads = countMatches(appSource, /collection\(\s*db,\s*["']staffProfiles["']\s*\)/g);
const startupCallableCalls = countMatches(appSource, /httpsCallable\(activeFunctions,\s*["']bootstrapSession["']\)/g);
console.log(`DIRECT_JOBS_READS=${directJobsReads}`);
console.log(`DIRECT_STAFF_READS=${directStaffReads}`);
console.log(`STARTUP_BOOTSTRAP_CALLS=${startupCallableCalls}`);
console.log(`NEW_FUNCTION_EXPORTS=${indexExportsUnchanged() ? 0 : "changed-index.ts"}`);

if (failures.length) {
  process.exitCode = 1;
  console.log(`ADMIN STARTUP CACHE FIX V2: FAIL (${checks.length - failures.length}/${checks.length} checks)`);
} else {
  console.log(`ADMIN STARTUP CACHE FIX V2: PASS (${checks.length}/${checks.length} checks)`);
}
