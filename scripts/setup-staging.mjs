import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  renderStagingFiles,
  stagingOutputPaths,
  validateStagingSetup,
} from "./staging-setup-core.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const writeMode = args.includes("--write");
const replaceMode = args.includes("--replace");
const exampleMode = args.includes("--examples");
const configIndex = args.indexOf("--config");
const configPath = resolve(
  root,
  configIndex >= 0 ? (args[configIndex + 1] ?? "") : "config/staging-setup.json"
);

if (configIndex >= 0 && !args[configIndex + 1]) {
  console.error("--configのパスがありません。");
  process.exit(1);
}
if (writeMode && exampleMode) {
  console.error("サンプル値を実ファイルへ書き込むことはできません。");
  process.exit(1);
}
if (replaceMode && !writeMode) {
  console.error("--replaceは--writeと同時に使用してください。");
  process.exit(1);
}
if (!existsSync(configPath)) {
  console.error(`設定ファイルがありません: ${relative(root, configPath)}`);
  process.exit(1);
}
if (!exampleMode && (statSync(configPath).mode & 0o077) !== 0) {
  console.error("設定ファイルの権限が広すぎます。chmod 600を実行してください。");
  process.exit(1);
}

let config;
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  console.error(`設定JSONが不正です: ${error.message}`);
  process.exit(1);
}

const errors = validateStagingSetup(config, { allowPlaceholders: exampleMode });
if (errors.length) {
  console.error(`STAGING SETUP: FAIL (${errors.length})`);
  errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  process.exit(1);
}

const rendered = renderStagingFiles(config);
if (
  rendered.size !== stagingOutputPaths.length ||
  stagingOutputPaths.some((path) => !rendered.has(path))
) {
  console.error("生成対象ファイルが不足しています。");
  process.exit(1);
}

if (!writeMode) {
  console.log(`STAGING SETUP PREVIEW: PASS (${rendered.size} files)`);
  stagingOutputPaths.forEach((path, index) => console.log(`${index + 1}. ${path}`));
  console.log("実値は表示していません。--write指定時だけ保存します。");
  process.exit(0);
}

const existing = stagingOutputPaths.filter((path) => existsSync(resolve(root, path)));
if (existing.length && !replaceMode) {
  console.error("既存設定があります。置換する場合は--replaceを指定してください。");
  existing.forEach((path, index) => console.error(`${index + 1}. ${path}`));
  process.exit(1);
}

if (existing.length) {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupRoot = resolve(root, ".staging-setup-backups", timestamp);
  for (const path of existing) {
    const backupPath = resolve(backupRoot, path);
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(resolve(root, path), backupPath);
  }
  console.log(`既存設定${existing.length}件をGit管理対象外のローカルバックアップ領域へ退避しました。`);
}

for (const [path, content] of rendered) {
  const target = resolve(root, path);
  const temporary = `${target}.tmp-${process.pid}`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

console.log(`STAGING SETUP: WROTE ${rendered.size} files`);
console.log("秘密値は表示していません。続けてpreflightを実行してください。");
