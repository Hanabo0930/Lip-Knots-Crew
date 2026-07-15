import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createReleaseCheckpoint } from "./release-checkpoint-core.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const exampleMode = args.includes("--examples");
const dryRun = args.includes("--dry-run");
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? "") : fallback;
};

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const firebasercPath = resolve(root, exampleMode ? ".firebaserc.example" : ".firebaserc");
const environmentPath = resolve(root, exampleMode ? "config-samples/environments/staging.json" : "config/environments/staging.json");
if (!existsSync(firebasercPath) || !existsSync(environmentPath)) {
  console.error("staging設定がありません。setupとpreflightを先に実行してください。");
  process.exit(1);
}
const firebaserc = JSON.parse(await readFile(firebasercPath, "utf8"));
const environment = JSON.parse(await readFile(environmentPath, "utf8"));
const projectId = firebaserc.projects?.staging;
if (!projectId || environment.firebaseProjectId !== projectId) {
  console.error("staging Project IDが一致しません。");
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[-:.]/gu, "").replace("Z", "Z");
const releaseId = value("--release-id", `v${packageJson.version}-${timestamp}`);
const outputRoot = resolve(root, value("--output", "release-evidence/staging"));
const defaultEvidenceRoot = resolve(root, "release-evidence");
if (
  (outputRoot === root || outputRoot.startsWith(`${root}${sep}`)) &&
  outputRoot !== defaultEvidenceRoot &&
  !outputRoot.startsWith(`${defaultEvidenceRoot}${sep}`)
) {
  console.error("project内の出力先はrelease-evidence配下だけ使用できます。");
  process.exit(1);
}
const checkpointDirectory = resolve(outputRoot, releaseId);

if (dryRun || exampleMode) {
  console.log("RELEASE CHECKPOINT PREVIEW: PASS");
  console.log(`version=${packageJson.version}`);
  console.log("environment=staging");
  console.log("secretFilesIncluded=false");
  console.log("実Project IDと秘密値は表示していません。");
  process.exit(0);
}

const created = await createReleaseCheckpoint({
  root,
  checkpointDirectory,
  releaseId,
  environment: "staging",
  firebaseProjectId: projectId,
});
console.log(`RELEASE CHECKPOINT: CREATED ${created.manifest.releaseId}`);
console.log(`files=${created.manifest.fileCount} secretFilesIncluded=false`);
console.log(`path=${created.checkpointDirectory}`);
