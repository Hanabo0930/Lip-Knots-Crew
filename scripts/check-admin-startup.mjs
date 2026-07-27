import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(root, "apps", "admin", "src", "App.tsx");
const source = fs.readFileSync(appPath, "utf8");

const checks = [
  {
    label: "live startup does not preselect the demo job",
    ok: /selectedAdminJobId[\s\S]{0,160}firebaseConfigured\s*\?\s*""\s*:\s*demoJobs/.test(source),
  },
  {
    label: "submission timeline waits for an authenticated user",
    ok: source.includes("if (!user || !selectedAdminJobId) return;"),
  },
  {
    label: "primary startup work is isolated with allSettled",
    ok: /primaryResults\s*=\s*await Promise\.allSettled\(\[/.test(source),
  },
  {
    label: "non-critical startup work is deferred until browser idle",
    ok: source.includes("cancelDeferredLoads=scheduleWhenIdle"),
  },
  {
    label: "legacy 17-way startup fan-out is removed",
    ok: !/Promise\.all\(\[loadJobs\(\),\s*loadStaff\(\),[\s\S]{0,700}loadMonthHistory\(\)\]\)/.test(source),
  },
  {
    label: "live dashboard uses a truthful empty state",
    ok: source.includes("const monthly = dashboard ?? emptyDashboard(dashboardMonth);"),
  },
  {
    label: "hard-coded acceptance-test footer figures are removed",
    ok: !["642,500円", "442,000円", "200,500円", "報告書 未提出 <strong>2件</strong>"].some((value) =>
      source.includes(value)
    ),
  },
  {
    label: "footer summaries are derived from loaded staging data",
    ok:
      source.includes("pendingResubmissions") &&
      source.includes("actionableSheetIssues") &&
      source.includes("dashboard.finance.bookedInvoice"),
  },
];

const failures = checks.filter((check) => !check.ok);
for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"} admin startup: ${check.label}`);
}

if (failures.length) {
  process.exitCode = 1;
} else {
  console.log(`ADMIN STARTUP GUARD: PASS (${checks.length} checks)`);
}
