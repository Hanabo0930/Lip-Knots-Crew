import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractSiteIds,
  findVapidCandidates,
  renderClientEnv,
  selectHostingSites,
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
assert.deepEqual(findVapidCandidates(`const key="${vapidKey}";`), [vapidKey]);
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
