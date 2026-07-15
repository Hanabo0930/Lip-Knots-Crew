import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createReleaseCheckpoint,
  recordDeploymentResult,
  restoreReleaseCheckpoint,
  verifyReleaseCheckpoint,
} from "./release-checkpoint-core.mjs";
import { writeSmokeEvidence } from "./staging-smoke-core.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const temporaryRoot = await mkdtemp(join(tmpdir(), "lkc-checkpoint-"));
const projectRoot = join(temporaryRoot, "project");
const checkpointDirectory = join(projectRoot, "release-evidence", "staging", "v2.6.0-test");

async function put(path, content) {
  const absolutePath = join(projectRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

try {
  await put("package.json", `${JSON.stringify({ version: "2.6.0" })}\n`);
  await put("firebase.json", `${JSON.stringify({ functions: { runtime: "nodejs22" } })}\n`);
  await put("firestore.rules", "rules_version = '2';\n");
  await put("firestore.indexes.json", "{}\n");
  await put("storage.rules", "rules_version = '2';\n");
  await put("apps/staff/src/main.ts", "export const version = '2.6.0';\n");
  await put("apps/staff/dist/index.html", "<main>staff</main>\n");
  await put("apps/staff/.env.staging.example", "VITE_FIREBASE_API_KEY=YOUR_KEY\n");
  await put("apps/admin/src/main.ts", "export const admin = true;\n");
  await put("apps/admin/.env.staging", "VITE_FIREBASE_API_KEY=real-secret\n");
  await put("functions/src/index.ts", "export const handler = true;\n");
  await put("functions/.env.staging", "PRIVATE_TOKEN=real-secret\n");
  await put("config/staging-setup.json", "{\"private\":true}\n");
  await put("config/staging-smoke.json", "{\"private\":true}\n");
  await put("config/environments/staging.json", "{\"spreadsheetId\":\"private\"}\n");
  await put(".firebaserc", "{\"projects\":{\"staging\":\"private-project\"}}\n");
  await put("node_modules/example/index.js", "generated\n");
  await put("functions/test-core-lib/test.js", "generated\n");

  const created = await createReleaseCheckpoint({
    root: projectRoot,
    checkpointDirectory,
    releaseId: "v2.6.0-test",
    firebaseProjectId: "crew-staging",
    createdAt: "2026-07-14T00:00:00.000Z",
  });
  const paths = created.manifest.files.map((file) => file.path);
  assert.ok(paths.includes("apps/staff/src/main.ts"));
  assert.ok(paths.includes("apps/staff/dist/index.html"));
  assert.ok(paths.includes("apps/staff/.env.staging.example"));
  assert.ok(!paths.some((path) => path.includes(".env.staging") && !path.endsWith(".example")));
  assert.ok(!paths.includes(".firebaserc"));
  assert.ok(!paths.includes("config/staging-smoke.json"));
  assert.ok(!paths.some((path) => path.startsWith("config/environments/")));
  assert.ok(!paths.some((path) => path.startsWith("node_modules/")));
  assert.equal(created.manifest.secretFilesIncluded, false);

  let verified = await verifyReleaseCheckpoint(checkpointDirectory);
  assert.deepEqual(verified.errors, []);

  const sourceFile = join(checkpointDirectory, "source/apps/staff/src/main.ts");
  const sourceOriginal = await readFile(sourceFile, "utf8");
  await writeFile(sourceFile, `${sourceOriginal}tampered\n`, "utf8");
  verified = await verifyReleaseCheckpoint(checkpointDirectory);
  assert.ok(verified.errors.some((error) => error.includes("SHA-256不一致")));
  await writeFile(sourceFile, sourceOriginal, "utf8");

  const manifestPath = join(checkpointDirectory, "checkpoint.json");
  const checksumPath = join(checkpointDirectory, "checkpoint.sha256");
  const manifestOriginal = await readFile(manifestPath, "utf8");
  const checksumOriginal = await readFile(checksumPath, "utf8");
  await writeFile(manifestPath, `${manifestOriginal} `, "utf8");
  verified = await verifyReleaseCheckpoint(checkpointDirectory);
  assert.ok(verified.errors.some((error) => error.includes("SHA-256")));
  await writeFile(manifestPath, manifestOriginal, "utf8");
  await writeFile(checksumPath, checksumOriginal, "utf8");

  const traversalManifest = JSON.parse(manifestOriginal);
  traversalManifest.files[0].path = "../escape";
  const traversalText = `${JSON.stringify(traversalManifest, null, 2)}\n`;
  await writeFile(manifestPath, traversalText, "utf8");
  await writeFile(checksumPath, `${hash(traversalText)}  checkpoint.json\n`, "utf8");
  verified = await verifyReleaseCheckpoint(checkpointDirectory);
  assert.ok(verified.errors.some((error) => error.includes("unsafe checkpoint path")));
  await writeFile(manifestPath, manifestOriginal, "utf8");
  await writeFile(checksumPath, checksumOriginal, "utf8");

  const extraPath = join(checkpointDirectory, "source/extra.txt");
  await writeFile(extraPath, "extra\n", "utf8");
  verified = await verifyReleaseCheckpoint(checkpointDirectory);
  assert.ok(verified.errors.some((error) => error.includes("ファイル一覧")));
  await rm(extraPath);

  const restoreDestination = join(temporaryRoot, "restored");
  const restoredManifest = await restoreReleaseCheckpoint({ checkpointDirectory, destination: restoreDestination });
  assert.equal(restoredManifest.releaseId, "v2.6.0-test");
  assert.ok(existsSync(join(restoreDestination, "package.json")));
  assert.ok(existsSync(join(restoreDestination, "ROLLBACK_READY.md")));
  assert.ok(!existsSync(join(restoreDestination, "apps/admin/.env.staging")));

  const nonempty = join(temporaryRoot, "nonempty");
  await mkdir(nonempty);
  await writeFile(join(nonempty, "keep.txt"), "keep\n", "utf8");
  await assert.rejects(
    restoreReleaseCheckpoint({ checkpointDirectory, destination: nonempty }),
    /destination must be empty/u
  );

  const resultInput = {
    status: "succeeded",
    operator: "release-manager",
    notes: "staging verified",
    releaseRefs: ["hosting-release-1", "functions-release-1"],
    recordedAt: "2026-07-14T01:00:00.000Z",
  };
  const recorded = await recordDeploymentResult({ checkpointDirectory, input: resultInput });
  assert.equal(recorded.releaseId, "v2.6.0-test");
  assert.ok(existsSync(join(checkpointDirectory, "deployment-result.sha256")));

  await writeSmokeEvidence({
    checkpointDirectory,
    report: {
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
      smokeResults: [
        "staff-app",
        "admin-app",
        "staff-manifest",
        "admin-manifest",
        "staff-service-worker",
        "admin-service-worker",
      ].map((id) => ({
        id,
        passed: true,
        attempts: 1,
        status: 200,
        finalHost: "crew-staging.web.app",
        durationMs: 1,
        error: null,
      })),
      decision: "GO",
      blockers: [],
    },
  });
  verified = await verifyReleaseCheckpoint(checkpointDirectory);
  assert.deepEqual(verified.errors, []);
  assert.equal(verified.deploymentResult.status, "succeeded");
  assert.equal(verified.smokeReport.decision, "GO");

  const smokeMarkdownPath = join(checkpointDirectory, "GO_NO_GO.md");
  const smokeMarkdownOriginal = await readFile(smokeMarkdownPath, "utf8");
  await writeFile(smokeMarkdownPath, `${smokeMarkdownOriginal}tampered\n`, "utf8");
  verified = await verifyReleaseCheckpoint(checkpointDirectory);
  assert.ok(verified.errors.some((error) => error.includes("smoke evidence SHA-256")));
  await writeFile(smokeMarkdownPath, smokeMarkdownOriginal, "utf8");

  const deploymentResultPath = join(checkpointDirectory, "deployment-result.json");
  const deploymentChecksumPath = join(checkpointDirectory, "deployment-result.sha256");
  const deploymentResultOriginal = await readFile(deploymentResultPath, "utf8");
  const deploymentChecksumOriginal = await readFile(deploymentChecksumPath, "utf8");
  await writeFile(deploymentResultPath, `${deploymentResultOriginal} `, "utf8");
  verified = await verifyReleaseCheckpoint(checkpointDirectory);
  assert.ok(verified.errors.some((error) => error.includes("deployment-result.jsonのSHA-256")));
  await writeFile(deploymentResultPath, deploymentResultOriginal, "utf8");
  await writeFile(deploymentChecksumPath, deploymentChecksumOriginal, "utf8");

  await assert.rejects(
    recordDeploymentResult({ checkpointDirectory, input: { ...resultInput, status: "unknown" } }),
    /status/u
  );
  await assert.rejects(
    recordDeploymentResult({ checkpointDirectory, input: resultInput }),
    /already exists/u
  );
  const replaced = await recordDeploymentResult({
    checkpointDirectory,
    input: { ...resultInput, status: "rolled_back", notes: "rollback verified" },
    replace: true,
  });
  assert.equal(replaced.status, "rolled_back");

  console.log("release checkpoint and rollback tests passed (15 cases)");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
