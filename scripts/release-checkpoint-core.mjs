import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, posix, relative, resolve, sep } from "node:path";
import { verifySmokeEvidence } from "./staging-smoke-core.mjs";

const excludedDirectoryNames = new Set([
  ".firebase",
  ".git",
  ".staging-setup-backups",
  "node_modules",
  "release-evidence",
  "rollback-restores",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function toPosix(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join("/");
}

export function isSensitiveOrGeneratedPath(path) {
  const normalized = path.split("\\").join("/");
  const parts = normalized.split("/");
  const name = parts.at(-1) ?? "";
  if (parts.some((part) => excludedDirectoryNames.has(part))) return true;
  if (parts.some((part) => /^test.*-lib$/u.test(part))) return true;
  if (normalized === ".firebaserc") return true;
  if (normalized === "config/staging-setup.json") return true;
  if (normalized === "config/staging-smoke.json") return true;
  if (normalized.startsWith("config/environments/")) return true;
  if (name.startsWith(".env") && !name.endsWith(".example")) return true;
  if (/^(firebase|firestore|ui)-debug\.log$/u.test(name)) return true;
  if (name === ".DS_Store" || name.endsWith(".local") || name.endsWith(".zip")) return true;
  return false;
}

function assertSafeRelativePath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path === ".." ||
    path.startsWith("../") ||
    path.includes("/../")
  ) {
    throw new Error(`unsafe checkpoint path: ${String(path)}`);
  }
}

export async function collectCheckpointFiles(root) {
  const absoluteRoot = resolve(root);
  const files = [];

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      const path = toPosix(absoluteRoot, absolutePath);
      if (isSensitiveOrGeneratedPath(path)) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`symbolic link is not allowed: ${path}`);
      }
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        files.push({ path, absolutePath });
      }
    }
  }

  await walk(absoluteRoot);
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function validateReleaseId(releaseId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{5,119}$/u.test(releaseId)) {
    throw new Error("releaseIdは英数字・ピリオド・ハイフン・アンダースコアの6～120文字にしてください。");
  }
}

export async function createReleaseCheckpoint({
  root,
  checkpointDirectory,
  releaseId,
  environment = "staging",
  firebaseProjectId,
  createdAt = new Date().toISOString(),
}) {
  const absoluteRoot = resolve(root);
  const absoluteCheckpoint = resolve(checkpointDirectory);
  validateReleaseId(releaseId);
  if (environment !== "staging") throw new Error("checkpoint environmentはstaging固定です。");
  if (!firebaseProjectId || /[\r\n\0]/u.test(firebaseProjectId)) {
    throw new Error("firebaseProjectIdが不正です。");
  }
  if (existsSync(absoluteCheckpoint)) throw new Error("checkpoint directory already exists");

  const packageJson = JSON.parse(await readFile(resolve(absoluteRoot, "package.json"), "utf8"));
  const firebaseJson = JSON.parse(await readFile(resolve(absoluteRoot, "firebase.json"), "utf8"));
  const sourceFiles = await collectCheckpointFiles(absoluteRoot);
  await mkdir(resolve(absoluteCheckpoint, "source"), { recursive: true, mode: 0o700 });

  const files = [];
  for (const source of sourceFiles) {
    assertSafeRelativePath(source.path);
    const bytes = await readFile(source.absolutePath);
    const destination = resolve(absoluteCheckpoint, "source", source.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source.absolutePath, destination);
    const copied = await readFile(destination);
    if (sha256(copied) !== sha256(bytes)) throw new Error(`checkpoint copy verification failed: ${source.path}`);
    files.push({ path: source.path, sha256: sha256(bytes), sizeBytes: bytes.byteLength });
  }

  const manifest = {
    schemaVersion: 1,
    releaseId,
    releaseVersion: packageJson.version,
    environment,
    firebaseProjectId,
    createdAt,
    deploymentScope: ["functions", "firestore", "storage", "hosting"],
    runtime: firebaseJson.functions?.runtime ?? null,
    secretFilesIncluded: false,
    fileCount: files.length,
    totalSizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    files,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(resolve(absoluteCheckpoint, "checkpoint.json"), manifestText, { encoding: "utf8", mode: 0o600 });
  await writeFile(resolve(absoluteCheckpoint, "checkpoint.sha256"), `${sha256(manifestText)}  checkpoint.json\n`, { encoding: "utf8", mode: 0o600 });

  const evidence = `# Staging deployment evidence\n\n- Release ID: ${releaseId}\n- Version: ${packageJson.version}\n- Firebase Project ID: ${firebaseProjectId}\n- Created: ${createdAt}\n- Runtime: ${manifest.runtime}\n- Files: ${manifest.fileCount}\n- Secret files included: No\n- Scope: ${manifest.deploymentScope.join(", ")}\n\nThe checkpoint must pass \`npm run rollback:staging:verify -- --checkpoint <path>\` before use.\n`;
  await writeFile(resolve(absoluteCheckpoint, "DEPLOYMENT_EVIDENCE.md"), evidence, { encoding: "utf8", mode: 0o600 });

  const rollbackPlan = `# Staging rollback plan\n\n1. Verify this checkpoint.\n2. Restore it into a new empty directory.\n3. Add staging secrets from the approved secure source.\n4. Run \`npm ci\` and \`npm run release:staging\`.\n5. Confirm the Firebase Project ID is ${firebaseProjectId}.\n6. Deploy the approved scope only after human confirmation.\n7. Record the deployment result and retain incident evidence.\n\nThis checkpoint never overwrites the current project.\n`;
  await writeFile(resolve(absoluteCheckpoint, "ROLLBACK_PLAN.md"), rollbackPlan, { encoding: "utf8", mode: 0o600 });

  return { checkpointDirectory: absoluteCheckpoint, manifest };
}

async function collectSourcePaths(sourceRoot) {
  const paths = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      const path = toPosix(sourceRoot, absolutePath);
      if (entry.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${path}`);
      if (entry.isDirectory()) await walk(absolutePath);
      if (entry.isFile()) paths.push(path);
    }
  }
  if (existsSync(sourceRoot)) await walk(sourceRoot);
  return paths.sort((left, right) => left.localeCompare(right, "en"));
}

export async function verifyReleaseCheckpoint(checkpointDirectory) {
  const errors = [];
  const absoluteCheckpoint = resolve(checkpointDirectory);
  let manifest;
  let manifestText;
  let deploymentResult = null;
  let smokeReport = null;
  try {
    manifestText = await readFile(resolve(absoluteCheckpoint, "checkpoint.json"), "utf8");
    manifest = JSON.parse(manifestText);
  } catch (error) {
    return { errors: [`checkpoint.jsonを読み込めません: ${error.message}`], manifest: null };
  }

  if (manifest.schemaVersion !== 1) errors.push("schemaVersionが不正です。");
  if (manifest.environment !== "staging") errors.push("environmentがstagingではありません。");
  if (manifest.secretFilesIncluded !== false) errors.push("secretFilesIncludedがfalseではありません。");
  try { validateReleaseId(manifest.releaseId); } catch (error) { errors.push(error.message); }
  if (!Array.isArray(manifest.files)) errors.push("filesが配列ではありません。");

  try {
    const checksumLine = await readFile(resolve(absoluteCheckpoint, "checkpoint.sha256"), "utf8");
    if (checksumLine !== `${sha256(manifestText)}  checkpoint.json\n`) {
      errors.push("checkpoint.jsonのSHA-256が一致しません。");
    }
  } catch (error) {
    errors.push(`checkpoint.sha256を読み込めません: ${error.message}`);
  }

  const listedPaths = [];
  if (Array.isArray(manifest.files)) {
    for (const file of manifest.files) {
      try { assertSafeRelativePath(file.path); } catch (error) { errors.push(error.message); continue; }
      if (isSensitiveOrGeneratedPath(file.path)) {
        errors.push(`checkpointに禁止パスがあります: ${file.path}`);
        continue;
      }
      listedPaths.push(file.path);
      const sourcePath = resolve(absoluteCheckpoint, "source", file.path);
      try {
        const bytes = await readFile(sourcePath);
        if (bytes.byteLength !== file.sizeBytes) errors.push(`size不一致: ${file.path}`);
        if (sha256(bytes) !== file.sha256) errors.push(`SHA-256不一致: ${file.path}`);
      } catch (error) {
        errors.push(`checkpoint file missing: ${file.path} (${error.message})`);
      }
    }
  }
  if (new Set(listedPaths).size !== listedPaths.length) errors.push("filesに重複パスがあります。");
  if (manifest.fileCount !== listedPaths.length) errors.push("fileCountが一致しません。");

  try {
    const actualPaths = await collectSourcePaths(resolve(absoluteCheckpoint, "source"));
    const expectedPaths = [...listedPaths].sort((left, right) => left.localeCompare(right, "en"));
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      errors.push("source内のファイル一覧がmanifestと一致しません。");
    }
  } catch (error) {
    errors.push(error.message);
  }

  const resultPath = resolve(absoluteCheckpoint, "deployment-result.json");
  const resultChecksumPath = resolve(absoluteCheckpoint, "deployment-result.sha256");
  if (existsSync(resultPath) || existsSync(resultChecksumPath)) {
    try {
      const resultText = await readFile(resultPath, "utf8");
      const result = JSON.parse(resultText);
      deploymentResult = result;
      const checksumLine = await readFile(resultChecksumPath, "utf8");
      if (checksumLine !== `${sha256(resultText)}  deployment-result.json\n`) {
        errors.push("deployment-result.jsonのSHA-256が一致しません。");
      }
      if (result.schemaVersion !== 1) errors.push("deployment result schemaVersionが不正です。");
      if (result.releaseId !== manifest.releaseId) errors.push("deployment resultのreleaseIdが一致しません。");
      if (result.firebaseProjectId !== manifest.firebaseProjectId) {
        errors.push("deployment resultのFirebase Project IDが一致しません。");
      }
      errors.push(...validateResultInput(result).map((error) => `deployment result: ${error}`));
    } catch (error) {
      errors.push(`deployment resultを検証できません: ${error.message}`);
    }
  }

  const smokePaths = ["smoke-report.json", "GO_NO_GO.md", "smoke-evidence.sha256"]
    .map((name) => resolve(absoluteCheckpoint, name));
  if (smokePaths.some(existsSync)) {
    const verifiedSmoke = await verifySmokeEvidence(absoluteCheckpoint);
    errors.push(...verifiedSmoke.errors);
    smokeReport = verifiedSmoke.report;
    if (smokeReport) {
      if (smokeReport.releaseId !== manifest.releaseId) errors.push("smoke reportのreleaseIdが一致しません。");
      if (smokeReport.firebaseProjectId !== manifest.firebaseProjectId) {
        errors.push("smoke reportのFirebase Project IDが一致しません。");
      }
      if (deploymentResult && smokeReport.deploymentStatus !== deploymentResult.status) {
        errors.push("smoke reportのdeployment statusが一致しません。");
      }
    }
  }

  return { errors: [...new Set(errors)], manifest, deploymentResult, smokeReport };
}

export async function restoreReleaseCheckpoint({ checkpointDirectory, destination }) {
  const verified = await verifyReleaseCheckpoint(checkpointDirectory);
  if (verified.errors.length) throw new Error(`checkpoint verification failed: ${verified.errors.join(" / ")}`);
  const absoluteDestination = resolve(destination);
  if (existsSync(absoluteDestination)) {
    const entries = await readdir(absoluteDestination);
    if (entries.length) throw new Error("restore destination must be empty");
  } else {
    await mkdir(absoluteDestination, { recursive: true, mode: 0o700 });
  }

  for (const file of verified.manifest.files) {
    assertSafeRelativePath(file.path);
    const source = resolve(checkpointDirectory, "source", file.path);
    const destinationPath = resolve(absoluteDestination, file.path);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(source, destinationPath);
  }
  const ready = `# Rollback restore ready\n\nRelease: ${verified.manifest.releaseId}\nVersion: ${verified.manifest.releaseVersion}\nTarget: ${verified.manifest.firebaseProjectId}\n\nSecrets were not restored. Add approved staging configuration, run verification, then obtain human approval before deployment.\n`;
  await writeFile(resolve(absoluteDestination, "ROLLBACK_READY.md"), ready, { encoding: "utf8", mode: 0o600 });
  return verified.manifest;
}

function validateResultInput(input) {
  const errors = [];
  if (!new Set(["succeeded", "failed", "rolled_back"]).has(input.status)) errors.push("statusが不正です。");
  for (const [key, max] of [["operator", 120], ["notes", 1000]]) {
    const value = input[key] ?? "";
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\0]/u.test(value)) {
      errors.push(`${key}が不正です。`);
    }
  }
  if (!Array.isArray(input.releaseRefs) || !input.releaseRefs.length) {
    errors.push("releaseRefsを1件以上指定してください。");
  } else if (input.releaseRefs.some((value) => typeof value !== "string" || !value.trim() || /[\r\n\0]/u.test(value))) {
    errors.push("releaseRefsが不正です。");
  }
  if (Number.isNaN(Date.parse(input.recordedAt))) errors.push("recordedAtが不正です。");
  return errors;
}

export async function recordDeploymentResult({ checkpointDirectory, input, replace = false }) {
  const verified = await verifyReleaseCheckpoint(checkpointDirectory);
  if (verified.errors.length) throw new Error(`checkpoint verification failed: ${verified.errors.join(" / ")}`);
  const errors = validateResultInput(input);
  if (errors.length) throw new Error(errors.join(" / "));
  const output = resolve(checkpointDirectory, "deployment-result.json");
  if (existsSync(output) && !replace) throw new Error("deployment result already exists");
  const result = {
    schemaVersion: 1,
    releaseId: verified.manifest.releaseId,
    firebaseProjectId: verified.manifest.firebaseProjectId,
    ...input,
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  await writeFile(output, text, { encoding: "utf8", mode: 0o600 });
  await writeFile(resolve(checkpointDirectory, "deployment-result.sha256"), `${sha256(text)}  deployment-result.json\n`, { encoding: "utf8", mode: 0o600 });
  return result;
}
