import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyReleaseCheckpoint } from "./release-checkpoint-core.mjs";
import {
  buildSmokeChecks,
  evaluateGoNoGo,
  runSmokeChecks,
  validateSmokeConfig,
  writeSmokeEvidence,
} from "./staging-smoke-core.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const exampleMode = args.includes("--examples");
const previewMode = args.includes("--preview");
const replaceMode = args.includes("--replace");

function value(name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? "") : fallback;
}

function runLocalScript(path) {
  const result = spawnSync(process.execPath, [resolve(root, path)], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0 && !result.error;
}

const configPath = resolve(root, value("--config", "config/staging-smoke.json"));
if (!existsSync(configPath)) {
  console.error("staging smoke設定がありません。setup:stagingを先に実行してください。");
  process.exit(1);
}
if (!exampleMode && (statSync(configPath).mode & 0o077) !== 0) {
  console.error("staging smoke設定の権限が広すぎます。chmod 600を実行してください。");
  process.exit(1);
}

let config;
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  console.error(`staging smoke設定を読み込めません: ${error.message}`);
  process.exit(1);
}
const configErrors = validateSmokeConfig(config, { allowPlaceholders: exampleMode });
if (configErrors.length) {
  console.error(`STAGING SMOKE CONFIG: FAIL (${configErrors.length})`);
  configErrors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  process.exit(1);
}

if (previewMode) {
  console.log(`STAGING SMOKE PREVIEW: PASS (${buildSmokeChecks(config).length} checks)`);
  console.log("判定=preflight + readiness + checkpoint + deployment result + remote smoke");
  console.log("URL・Project ID・秘密値は表示していません。");
  process.exit(0);
}
if (exampleMode) {
  console.error("--examplesは--previewと同時に使用してください。");
  process.exit(1);
}

const checkpointValue = value("--checkpoint");
if (!checkpointValue) {
  console.error("--checkpoint <path> が必須です。");
  process.exit(1);
}
const checkpointDirectory = resolve(root, checkpointValue);
const verified = await verifyReleaseCheckpoint(checkpointDirectory);
if (!verified.manifest) {
  console.error("STAGING GO/NO-GO: NO_GO");
  console.error("checkpointを読み込めません。");
  process.exit(1);
}

const preflightPassed = runLocalScript("scripts/staging-preflight.mjs");
const readinessPassed = runLocalScript("scripts/staging-deploy-readiness.mjs");
const deploymentStatus = verified.deploymentResult?.status ?? null;
let smokeResults = [];
if (
  preflightPassed &&
  readinessPassed &&
  verified.errors.length === 0 &&
  deploymentStatus === "succeeded"
) {
  smokeResults = await runSmokeChecks(config);
}

const evaluation = evaluateGoNoGo({
  smokeResults,
  preflightPassed,
  readinessPassed,
  checkpointErrors: verified.errors,
  deploymentStatus,
});
const report = {
  schemaVersion: 1,
  releaseId: verified.manifest.releaseId,
  releaseVersion: verified.manifest.releaseVersion,
  firebaseProjectId: verified.manifest.firebaseProjectId,
  environment: "staging",
  recordedAt: new Date().toISOString(),
  preflightPassed,
  readinessPassed,
  checkpointPassed: verified.errors.length === 0,
  deploymentStatus,
  smokeResults,
  ...evaluation,
};

try {
  await writeSmokeEvidence({ checkpointDirectory, report, replace: replaceMode });
} catch (error) {
  console.error(`smoke証跡を保存できません: ${error.message}`);
  process.exit(1);
}

console.log(`STAGING GO/NO-GO: ${report.decision}`);
console.log(`SMOKE: ${smokeResults.filter((item) => item.passed).length}/${smokeResults.length}`);
if (report.blockers.length) console.log(`BLOCKERS: ${report.blockers.join(" | ")}`);
console.log("証跡: smoke-report.json / GO_NO_GO.md / smoke-evidence.sha256");
process.exitCode = report.decision === "GO" ? 0 : 1;
