import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractSiteIds,
  findVapidCandidates,
  renderClientEnv,
  resolveFirebaseConfigs,
  selectHostingSites,
  selectApplicationVapidKey,
  validateFirebaseInit,
} from "./prepare-staging-hosting-config.mjs";
import {
  extractChannels,
  resolveChannelUrl,
} from "./resolve-hosting-channel.mjs";
import {
  evaluateBrowserResult,
  validateTargetUrl,
} from "./hosting-browser-check.mjs";
import {
  restoreBothSites,
  validateRestoreOptions,
} from "./restore-staging-hosting.mjs";

let cases = 0;
const projectId = "lip-knots-crew-staging";
const staffSite = projectId;
const adminSite = "lip-knots-crew-staging-admin";
const channelId = "rc-02516b6e28e4";
const vapidKey = `B${"A".repeat(86)}`;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

for (const [workflowPath, evidenceFolder] of [
  [".github/workflows/staging-hosting-preview.yml", "hosting-preview-evidence"],
  [".github/workflows/staging-hosting-promote.yml", "hosting-promote-evidence"],
]) {
  const workflow = readFileSync(resolve(repoRoot, workflowPath), "utf8");
  const jobEnvBlocks = workflow.matchAll(/^    env:\n((?:      [^\n]*\n)*)/gmu);
  for (const [, jobEnv] of jobEnvBlocks) {
    assert.doesNotMatch(
      jobEnv,
      /\$\{\{\s*runner\./u,
      `${workflowPath} cannot use the runner context in job-level env`,
    );
  }
  assert.ok(
    workflow.includes(
      [
        "      - name: Prepare evidence directory",
        "        run: |",
        `          evidence_dir="$RUNNER_TEMP/${evidenceFolder}"`,
        '          mkdir -p "$evidence_dir"',
        '          echo "LKC_EVIDENCE_DIR=$evidence_dir" >> "$GITHUB_ENV"',
      ].join("\n"),
    ),
    `${workflowPath} must initialize its evidence directory at runtime`,
  );
  cases += 1;
}

const promoteWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/staging-hosting-promote.yml"),
  "utf8",
);
const previewWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/staging-hosting-preview.yml"),
  "utf8",
);
assert.ok(
  previewWorkflow.includes(
    [
      "  preview:",
      "    needs: guard",
      "    environment: lkc-staging-hosting",
      "    runs-on: ubuntu-latest",
    ].join("\n"),
  ),
  "Hosting preview must use the protected lkc-staging-hosting environment",
);
cases += 1;
assert.match(
  promoteWorkflow,
  /node scripts\/automation\/restore-staging-hosting\.mjs/u,
);
assert.match(
  promoteWorkflow,
  /- name: Verify both live staging apps after rollback[\s\S]*?if: always\(\) && steps\.rollback\.outputs\.attempted == 'true'/u,
);
cases += 1;

const restoreOptions = {
  projectId,
  staffSite,
  adminSite,
  rollbackChannel: "rb-30193717024",
};
assert.equal(
  validateRestoreOptions({
    ...restoreOptions,
    evidenceDir: resolve(repoRoot, "temporary-evidence"),
  }).projectId,
  projectId,
);
assert.throws(
  () => validateRestoreOptions({
    ...restoreOptions,
    projectId: "lip-knots-production",
    evidenceDir: resolve(repoRoot, "temporary-evidence"),
  }),
  /PROJECT_NOT_ALLOWED/u,
);
cases += 2;

const temporary = await mkdtemp(join(tmpdir(), "lkc-hosting-rollback-test-"));
try {
  const calls = [];
  const result = await restoreBothSites(
    {
      ...restoreOptions,
      evidenceDir: temporary,
    },
    {
      executor: async (request) => {
        calls.push(request.label);
        return {
          code: request.label === "staff" ? 1 : 0,
          stdout: JSON.stringify({ status: request.label === "staff" ? "error" : "success" }),
        };
      },
    },
  );
  assert.equal(result.success, false);
  assert.deepEqual(calls, ["staff", "admin"]);
  assert.deepEqual(
    result.attempts.map(({ label, status }) => ({ label, status })),
    [
      { label: "staff", status: "failure" },
      { label: "admin", status: "success" },
    ],
  );
  assert.match(await readFile(join(temporary, "staff-rollback.json"), "utf8"), /error/u);
  assert.match(await readFile(join(temporary, "admin-rollback.json"), "utf8"), /success/u);
  cases += 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const sitesDocument = {
  status: "success",
  result: {
    sites: [
      { name: `projects/${projectId}/sites/${staffSite}` },
      { name: `projects/${projectId}/sites/${adminSite}` },
    ],
  },
};
assert.deepEqual(extractSiteIds(sitesDocument), [staffSite, adminSite].sort());
cases += 1;
assert.deepEqual(
  selectHostingSites(extractSiteIds(sitesDocument), { projectId }),
  { staffSite, adminSite },
);
cases += 1;
assert.throws(
  () => selectHostingSites([staffSite], { projectId }),
  /HOSTING_SITES_INSUFFICIENT/u,
);
cases += 1;

const firebaseInit = {
  apiKey: "public-web-api-key",
  authDomain: `${projectId}.firebaseapp.com`,
  projectId,
  storageBucket: `${projectId}.firebasestorage.app`,
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef",
};
assert.deepEqual(validateFirebaseInit(firebaseInit, projectId, "staff"), firebaseInit);
cases += 1;
assert.throws(
  () => validateFirebaseInit({ ...firebaseInit, projectId: "production-project" }, projectId, "staff"),
  /PROJECT_MISMATCH/u,
);
cases += 1;
const adminWithoutAppId = { ...firebaseInit };
delete adminWithoutAppId.appId;
const sharedFirebaseConfigs = resolveFirebaseConfigs(
  firebaseInit,
  adminWithoutAppId,
  projectId,
);
assert.equal(sharedFirebaseConfigs.adminConfig.appId, firebaseInit.appId);
assert.equal(sharedFirebaseConfigs.adminAppIdSource, "staff-same-project");
cases += 1;
assert.throws(
  () => resolveFirebaseConfigs(
    firebaseInit,
    { ...adminWithoutAppId, appId: "\n" },
    projectId,
  ),
  /FIREBASE_INIT_INVALID:admin.appId/u,
);
cases += 1;
assert.throws(
  () => resolveFirebaseConfigs(
    firebaseInit,
    { ...adminWithoutAppId, messagingSenderId: "9999999999" },
    projectId,
  ),
  /FIREBASE_INIT_APP_ID_FALLBACK_REJECTED:admin.messagingSenderId/u,
);
cases += 1;
const adminWithOwnAppId = {
  ...firebaseInit,
  appId: "1:1234567890:web:admin-app",
};
const distinctFirebaseConfigs = resolveFirebaseConfigs(
  firebaseInit,
  adminWithOwnAppId,
  projectId,
);
assert.equal(distinctFirebaseConfigs.adminConfig.appId, adminWithOwnAppId.appId);
assert.equal(distinctFirebaseConfigs.adminAppIdSource, "admin-public-config");
cases += 1;
assert.deepEqual(findVapidCandidates(`const key="${vapidKey}";`), [vapidKey]);
cases += 1;
const sdkVapidKey = `B${"S".repeat(86)}`;
assert.equal(
  selectApplicationVapidKey(
    [sdkVapidKey, vapidKey, sdkVapidKey],
    [sdkVapidKey],
  ),
  vapidKey,
);
cases += 1;
assert.throws(
  () => selectApplicationVapidKey([sdkVapidKey], [sdkVapidKey]),
  /VAPID_KEY_NOT_UNIQUELY_RECOVERED:0/u,
);
cases += 1;
assert.throws(
  () => selectApplicationVapidKey(
    [vapidKey, `B${"Z".repeat(86)}`, sdkVapidKey],
    [sdkVapidKey],
  ),
  /VAPID_KEY_NOT_UNIQUELY_RECOVERED:2/u,
);
cases += 1;
const env = renderClientEnv(firebaseInit, {
  projectId,
  region: "asia-northeast1",
  vapidKey,
});
assert.match(env, /VITE_APP_ENVIRONMENT=staging/u);
assert.match(env, new RegExp(`VITE_EXPECTED_FIREBASE_PROJECT_ID=${projectId}`, "u"));
assert.doesNotMatch(env, /production/u);
cases += 1;

const channelDocument = {
  status: "success",
  result: {
    channels: [{
      name: `sites/${staffSite}/channels/${channelId}`,
      url: `https://${staffSite}--${channelId}-abc123.web.app`,
    }],
  },
};
assert.equal(extractChannels(channelDocument).length, 1);
cases += 1;
assert.equal(
  resolveChannelUrl(channelDocument, { channelId, siteId: staffSite }),
  `https://${staffSite}--${channelId}-abc123.web.app`,
);
cases += 1;
assert.throws(
  () => resolveChannelUrl(channelDocument, { channelId: "rc-other", siteId: staffSite }),
  /NOT_UNIQUELY_RESOLVED/u,
);
cases += 1;

assert.equal(
  validateTargetUrl(`https://${staffSite}.web.app`, [staffSite, adminSite]),
  `https://${staffSite}.web.app`,
);
cases += 1;
assert.throws(
  () => validateTargetUrl("https://lip-knots-production.web.app", [staffSite, adminSite]),
  /PRODUCTION_URL_REJECTED/u,
);
cases += 1;
const passingBrowserResult = {
  httpStatus: 200,
  rootVisible: true,
  rootChildCount: 1,
  bodyTextLength: 100,
  demoModeVisible: false,
  navigationDurationMs: 1200,
  pageErrors: [],
  fatalConsoleErrors: [],
  failedResources: [],
};
assert.deepEqual(evaluateBrowserResult(passingBrowserResult), []);
cases += 1;
assert.ok(
  evaluateBrowserResult({
    ...passingBrowserResult,
    rootChildCount: 0,
    pageErrors: ["Cannot access x before initialization"],
  }).includes("ROOT_NOT_MOUNTED"),
);
cases += 1;

console.log(`staging Hosting automation tests passed (${cases} cases)`);
