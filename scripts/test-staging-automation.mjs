import { strict as assert } from "node:assert";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  renderStagingFiles,
  stagingOutputPaths,
  validateStagingSetup,
} from "./staging-setup-core.mjs";

const sample = JSON.parse(
  await readFile("config-samples/staging-setup.example.json", "utf8")
);
assert.equal(validateStagingSetup(sample, { allowPlaceholders: true }).length, 0);
assert.deepEqual([...renderStagingFiles(sample).keys()], stagingOutputPaths);

const safe = {
  version: 1,
  firebase: {
    developmentProjectId: "crew-development",
    stagingProjectId: "crew-staging",
    productionProjectId: "crew-production",
    stagingStaffHostingSite: "crew-staff-staging",
    stagingAdminHostingSite: "crew-admin-staging",
    productionStaffHostingSite: "crew-staff-production",
    productionAdminHostingSite: "crew-admin-production",
    webApiKey: "staging-web-key",
    authDomain: "crew-staging.firebaseapp.com",
    storageBucket: "crew-staging.firebasestorage.app",
    messagingSenderId: "1234567890",
    staffAppId: "staff-staging-app",
    adminAppId: "admin-staging-app",
    vapidKey: "staging-public-vapid",
    functionsRegion: "asia-northeast1",
  },
  application: {
    appBaseUrl: "https://staff-staging.lipknots.test",
    staffAppUrl: "https://staff-staging.lipknots.test",
    adminAppUrl: "https://admin-staging.lipknots.test",
    spreadsheetId: "staging-sheet",
    backupBucket: "crew-staging-backup",
    defaultCompanyId: "lipknots-staging",
    adminEmails: ["admin@lipknots.test"],
    mailFrom: "staging@lipknots.test",
  },
};
assert.equal(validateStagingSetup(safe).length, 0);
const rendered = renderStagingFiles(safe);
assert.equal(JSON.parse(rendered.get(".firebaserc")).projects.staging, "crew-staging");
assert.match(rendered.get("apps/staff/.env.staging"), /VITE_USE_EMULATORS=false/u);
assert.match(rendered.get("functions/.env.staging"), /APP_ENVIRONMENT=staging/u);

const rejectionCases = [
  ["project collision", (value) => { value.firebase.productionProjectId = "crew-staging"; }, "Project ID"],
  ["hosting collision", (value) => { value.firebase.productionStaffHostingSite = "crew-staff-staging"; }, "Hosting site"],
  ["wrong region", (value) => { value.firebase.functionsRegion = "us-central1"; }, "asia-northeast1"],
  ["newline injection", (value) => { value.application.defaultCompanyId = "crew\nINJECTED=true"; }, "改行"],
  ["duplicate app", (value) => { value.firebase.adminAppId = value.firebase.staffAppId; }, "staffAppId"],
  ["http url", (value) => { value.application.appBaseUrl = "http://staff-staging.lipknots.test"; value.application.staffAppUrl = value.application.appBaseUrl; }, "HTTPS"],
  ["placeholder", (value) => { value.firebase.webApiKey = "YOUR_KEY"; }, "サンプル値"],
  ["project format", (value) => { value.firebase.stagingProjectId = "Crew STAGING"; }, "Project ID形式"],
  ["edge whitespace", (value) => { value.application.defaultCompanyId = " crew "; }, "先頭・末尾"],
];
for (const [name, mutate, expected] of rejectionCases) {
  const candidate = structuredClone(safe);
  mutate(candidate);
  const errors = validateStagingSetup(candidate);
  assert.ok(errors.some((error) => error.includes(expected)), `${name}: ${errors.join(" / ")}`);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "lkc-staging-setup-"));
try {
  const setupScript = resolve("scripts/setup-staging.mjs");
  const configPath = join(temporaryRoot, "staging-setup.json");
  await writeFile(configPath, `${JSON.stringify(safe, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const firstWrite = spawnSync(
    process.execPath,
    [setupScript, "--config", configPath, "--write"],
    { cwd: temporaryRoot, encoding: "utf8" }
  );
  assert.equal(firstWrite.status, 0, firstWrite.stderr);
  assert.doesNotMatch(firstWrite.stdout, /staging-web-key|crew-staging/u, "secret output");
  for (const path of stagingOutputPaths) {
    const generatedPath = join(temporaryRoot, path);
    assert.ok(existsSync(generatedPath), `${path} was not generated`);
    assert.equal(statSync(generatedPath).mode & 0o777, 0o600, `${path} mode`);
  }

  const refusedOverwrite = spawnSync(
    process.execPath,
    [setupScript, "--config", configPath, "--write"],
    { cwd: temporaryRoot, encoding: "utf8" }
  );
  assert.notEqual(refusedOverwrite.status, 0, "existing files must not be overwritten implicitly");

  const explicitReplace = spawnSync(
    process.execPath,
    [setupScript, "--config", configPath, "--write", "--replace"],
    { cwd: temporaryRoot, encoding: "utf8" }
  );
  assert.equal(explicitReplace.status, 0, explicitReplace.stderr);
  const backups = await readdir(join(temporaryRoot, ".staging-setup-backups"));
  assert.equal(backups.length, 1, "replacement backup");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(`staging setup automation tests passed (${rejectionCases.length + 4} cases)`);
