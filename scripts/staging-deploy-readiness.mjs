import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const exampleMode = process.argv.includes("--examples");
const selfTestMode = process.argv.includes("--self-test");

function readJson(path, errors) {
  try {
    return JSON.parse(readFileSync(resolve(root, path), "utf8"));
  } catch (error) {
    errors.push(`${path}を読み込めません: ${error.message}`);
    return {};
  }
}

function latestMtime(directory, extensions) {
  if (!existsSync(directory)) return 0;
  let latest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) latest = Math.max(latest, latestMtime(path, extensions));
    if (entry.isFile() && extensions.has(extname(entry.name))) {
      latest = Math.max(latest, statSync(path).mtimeMs);
    }
  }
  return latest;
}

function hasFunctionsPredeployBuild(predeploy) {
  if (!Array.isArray(predeploy)) return false;
  const accepted = new Set([
    "npm run build -w @lkc/functions",
    'npm --prefix "$RESOURCE_DIR" run build',
  ]);
  return predeploy.some((command) => {
    if (typeof command !== "string") return false;
    const normalized = command.trim().replace(/\s+/gu, " ");
    return accepted.has(normalized);
  });
}

function loadModel(errors) {
  const rootPackage = readJson("package.json", errors);
  const staffPackage = readJson("apps/staff/package.json", errors);
  const adminPackage = readJson("apps/admin/package.json", errors);
  const functionsPackage = readJson("functions/package.json", errors);
  const firebase = readJson("firebase.json", errors);
  const requiredFiles = ["firestore.rules", "firestore.indexes.json", "storage.rules"];
  const builds = [
    {
      label: "staff",
      artifact: "apps/staff/dist/index.html",
      sourceDirectory: "apps/staff/src",
      sourceExtras: ["apps/staff/vite.config.ts", "apps/staff/package.json"],
      assetDirectory: "apps/staff/dist/assets",
    },
    {
      label: "admin",
      artifact: "apps/admin/dist/index.html",
      sourceDirectory: "apps/admin/src",
      sourceExtras: ["apps/admin/vite.config.ts", "apps/admin/package.json"],
      assetDirectory: "apps/admin/dist/assets",
    },
    {
      label: "functions",
      artifact: "functions/lib/index.js",
      sourceDirectory: "functions/src",
      sourceExtras: ["functions/package.json", "functions/tsconfig.json"],
    },
  ].map((build) => {
    const artifactPath = resolve(root, build.artifact);
    const sourceLatest = Math.max(
      latestMtime(resolve(root, build.sourceDirectory), new Set([".ts", ".tsx"])),
      ...build.sourceExtras.map((path) => existsSync(resolve(root, path)) ? statSync(resolve(root, path)).mtimeMs : 0)
    );
    let entryChunks = 0;
    if (build.assetDirectory && existsSync(resolve(root, build.assetDirectory))) {
      entryChunks = readdirSync(resolve(root, build.assetDirectory))
        .filter((name) => /^index-.*\.js$/u.test(name)).length;
    }
    return {
      ...build,
      exists: existsSync(artifactPath),
      artifactMtime: existsSync(artifactPath) ? statSync(artifactPath).mtimeMs : 0,
      sourceLatest,
      entryChunks,
    };
  });
  return {
    rootPackage,
    packages: { staffPackage, adminPackage, functionsPackage },
    firebase,
    requiredFiles: requiredFiles.map((path) => ({ path, exists: existsSync(resolve(root, path)) })),
    builds,
  };
}

function validateModel(model, { requireBuilds = true } = {}) {
  const errors = [];
  const version = model.rootPackage.version;
  for (const [name, pkg] of Object.entries(model.packages)) {
    if (pkg.version !== version) errors.push(`${name}のversionがrootと一致しません。`);
  }
  if (model.rootPackage.engines?.node !== "22") errors.push("root engines.nodeは22が必須です。");
  if (model.packages.functionsPackage.engines?.node !== "22") {
    errors.push("Functions engines.nodeは22が必須です。");
  }
  if (model.firebase.functions?.runtime !== "nodejs22") {
    errors.push("firebase.jsonのFunctions runtimeはnodejs22が必須です。");
  }
  const predeploy = model.firebase.functions?.predeploy ?? [];
  if (!hasFunctionsPredeployBuild(predeploy)) {
    errors.push("Functions predeploy buildがありません。");
  }

  const hosting = Array.isArray(model.firebase.hosting) ? model.firebase.hosting : [];
  for (const [target, publicDirectory] of [
    ["staff", "apps/staff/dist"],
    ["admin", "apps/admin/dist"],
  ]) {
    const config = hosting.find((item) => item.target === target);
    if (!config) {
      errors.push(`Hosting target ${target} がありません。`);
      continue;
    }
    if (config.public !== publicDirectory) {
      errors.push(`Hosting ${target} のpublic directoryが不正です。`);
    }
    const rewrites = Array.isArray(config.rewrites) ? config.rewrites : [];
    if (!rewrites.some((item) => item.source === "**" && item.destination === "/index.html")) {
      errors.push(`Hosting ${target} のSPA rewriteがありません。`);
    }
  }

  for (const file of model.requiredFiles) {
    if (!file.exists) errors.push(`${file.path} がありません。`);
  }
  if (requireBuilds) {
    for (const build of model.builds) {
      if (!build.exists) {
        errors.push(`${build.label}のビルド成果物がありません。`);
        continue;
      }
      if (build.sourceLatest > build.artifactMtime + 1) {
        errors.push(`${build.label}のビルド成果物がソースより古いです。`);
      }
      if (build.assetDirectory && build.entryChunks !== 1) {
        errors.push(`${build.label}のentry chunkが${build.entryChunks}件あります。旧資産を削除してください。`);
      }
    }
  }
  return errors;
}

function selfTest(model) {
  const cases = [
    ["runtime mismatch", (value) => { value.firebase.functions.runtime = "nodejs20"; }, "runtime"],
    ["public mismatch", (value) => { value.firebase.hosting[0].public = "public"; }, "public directory"],
    ["missing admin", (value) => { value.firebase.hosting = value.firebase.hosting.filter((item) => item.target !== "admin"); }, "target admin"],
    ["version mismatch", (value) => { value.packages.staffPackage.version = "0.0.0"; }, "version"],
    ["missing rules", (value) => { value.requiredFiles[0].exists = false; }, "firestore.rules"],
    ["stale build", (value) => { value.builds[0].sourceLatest = value.builds[0].artifactMtime + 10_000; }, "ソースより古い"],
    ["missing predeploy", (value) => { value.firebase.functions.predeploy = ["npm run lint"]; }, "Functions predeploy build"],
  ];
  const failures = [];
  for (const [name, mutate, expected] of cases) {
    const candidate = structuredClone(model);
    mutate(candidate);
    const errors = validateModel(candidate);
    if (!errors.some((error) => error.includes(expected))) failures.push(`${name}を検出できませんでした。`);
  }
  return { failures, count: cases.length };
}

const errors = [];
const warnings = [];
const model = loadModel(errors);
if (!errors.length) errors.push(...validateModel(model));

let selfTestCount = 0;
if (selfTestMode && !errors.length) {
  const result = selfTest(model);
  errors.push(...result.failures);
  selfTestCount = result.count;
}

if (!exampleMode) {
  const firebaseCli = spawnSync("firebase", ["--version"], { encoding: "utf8" });
  if (firebaseCli.error?.code === "ENOENT") {
    errors.push("Firebase CLIがありません。firebase-toolsを導入してください。");
  } else if (firebaseCli.status !== 0) {
    errors.push("Firebase CLIを実行できません。");
  }
}
if (Number(process.versions.node.split(".")[0]) !== 22) {
  warnings.push(`診断実行Nodeは${process.versions.node}です。デプロイ・CIはNode 22を使用してください。`);
}

if (errors.length) {
  console.error(`STAGING DEPLOY READINESS: FAIL (${errors.length})`);
  errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  warnings.forEach((warning) => console.error(`WARN. ${warning}`));
  process.exit(1);
}

console.log(`STAGING DEPLOY READINESS: PASS version=${model.rootPackage.version}`);
console.log("DEPLOY SCOPE: functions,firestore,storage,hosting");
if (selfTestMode) console.log(`DEPLOY READINESS SELF-TEST: PASS (${selfTestCount} rejection cases)`);
warnings.forEach((warning) => console.log(`WARN. ${warning}`));
