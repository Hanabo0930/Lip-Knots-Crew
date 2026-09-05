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
    ok: source.includes("if (selectedAdminJobId&&(!firebaseConfigured||user))void loadSubmissionTimeline();") && source.includes("if (!selectedAdminJobId||(firebaseConfigured&&(!user||!functions)))return;"),
  },
  {
    label: "primary startup work is isolated with allSettled",
    ok: /primaryResults\s*=\s*await Promise\.allSettled\(\[/.test(source),
  },
  {
    label: "startup directory comes from bootstrapSession before primary loads",
    ok:
      source.includes("const bootstrapResponse=await bootstrap();") &&
      source.includes("Array.isArray(bootstrapData.jobs)") &&
      source.includes("Array.isArray(bootstrapData.staff)"),
  },
  {
    label: "primary startup excludes direct jobs and staff loaders",
    ok:
      /primaryResults\s*=\s*await Promise\.allSettled\(\[\s*loadSheetIssues\(isCurrentRun\),\s*loadDashboard\(dashboardMonth,isCurrentRun\),\s*loadResubmissions\(isCurrentRun\),\s*\]\)/.test(source),
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
  {
    label: "each auth change invalidates the previous startup run",
    ok:
      source.includes("const currentRun=++authRun;") &&
      source.includes("currentRun===authRun") &&
      source.includes("authRun+=1;"),
  },
  {
    label: "startup results are pinned to the current Firebase user",
    ok:
      source.includes("activeAuth.currentUser?.uid===current?.uid") &&
      source.includes("if(!isCurrentRun())return;"),
  },
  {
    label: "account changes clear auth-scoped data before the next load",
    ok:
      source.includes("if(activeUid!==nextUid)") &&
      ["setJobs([])", "setStaff([])", "setSelectedAdminJobId(\"\")", "setDashboard(null)", "setPushEnabled(false)"].every((call) =>
        source.includes(call)
      ),
  },
  {
    label: "primary startup loaders receive and enforce the auth guard",
    ok:
      ["loadSheetIssues", "loadDashboard", "loadResubmissions"].every((name) =>
        new RegExp(`${name}[(][^)]*isCurrentRun`).test(source)
      ) &&
      source.includes("loadAdminDirectory(guard)") &&
      (source.match(/canApplyAuthResult[(]guard[)]/g) ?? []).length >= 15,
  },
  {
    label: "deferred startup loaders and push status stay in the active auth run",
    ok:
      source.includes(".then((enabled)=>{if(isCurrentRun())setPushEnabled(enabled);})") &&
      [
        "loadPilotReadiness(isCurrentRun)",
        "loadProductionControlStatus(isCurrentRun)",
        "loadProductionSloDashboard(isCurrentRun)",
        "loadProductionTelemetryStatus(isCurrentRun)",
        "loadProductionDeploymentReadiness(isCurrentRun)",
        "loadMonthHistory(isCurrentRun)",
      ].every((call) => source.includes(call)),
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
