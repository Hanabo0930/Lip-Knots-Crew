import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";

function valueAfter(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

const protectedExactPaths = new Set([
  ".firebaserc",
  "firebase.json",
  "package.json",
  "package-lock.json",
  "functions/package.json",
  "functions/package-lock.json",
]);

const protectedPrefixes = [
  ".github/",
  ".cursor/",
  ".openai/",
  "config/automation/",
  "scripts/automation/",
];

const allowedPrefixes = [
  "apps/staff/",
  "functions/src/",
  "functions/test/",
];

export function classifyChangedPath(filePath) {
  if (
    filePath === ".env"
    || filePath.includes("/.env")
    || filePath.endsWith(".pem")
    || filePath.endsWith(".key")
  ) return "protected";
  if (protectedExactPaths.has(filePath)) return "protected";
  if (protectedPrefixes.some((prefix) => filePath.startsWith(prefix))) return "protected";
  if (allowedPrefixes.some((prefix) => filePath.startsWith(prefix))) return "allowed";
  return "outside-allowlist";
}

export function validateChangedPaths(filePaths) {
  const rejected = filePaths
    .filter(Boolean)
    .map((filePath) => ({ filePath, classification: classifyChangedPath(filePath) }))
    .filter(({ classification }) => classification !== "allowed");
  if (rejected.length) {
    throw new Error(
      `DEPLOY_SOURCE_PATHS_REJECTED:${rejected.map(({ filePath, classification }) => `${filePath}:${classification}`).join(",")}`,
    );
  }
  return filePaths.filter(Boolean);
}

function runSelfTest() {
  assert.equal(classifyChangedPath("functions/src/example.ts"), "allowed");
  assert.equal(classifyChangedPath("apps/staff/src/App.tsx"), "allowed");
  assert.equal(classifyChangedPath(".github/workflows/unsafe.yml"), "protected");
  assert.equal(classifyChangedPath("firebase.json"), "protected");
  assert.equal(classifyChangedPath("functions/.env.staging"), "protected");
  assert.equal(classifyChangedPath("apps/admin/src/App.tsx"), "outside-allowlist");
  assert.deepEqual(validateChangedPaths(["functions/src/example.ts"]), ["functions/src/example.ts"]);
  assert.throws(() => validateChangedPaths(["package.json"]));
  console.log("deploy source integrity tests passed (8 cases)");
}

function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const repository = valueAfter("--repository", ".");
  const base = valueAfter("--base");
  const head = valueAfter("--head", "HEAD");
  if (!base) {
    console.error("DEPLOY_SOURCE_INTEGRITY=FAIL");
    console.error("DEPLOY_SOURCE_ERROR=BASE_REQUIRED");
    process.exit(1);
  }

  let changedPaths;
  try {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", `${base}...${head}`],
      { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    changedPaths = output.split(/\r?\n/).filter(Boolean);
  } catch {
    console.error("DEPLOY_SOURCE_INTEGRITY=FAIL");
    console.error("DEPLOY_SOURCE_ERROR=DIFF_UNAVAILABLE");
    process.exit(1);
  }

  try {
    const accepted = validateChangedPaths(changedPaths);
    console.log("DEPLOY_SOURCE_INTEGRITY=PASS");
    console.log(`DEPLOY_SOURCE_CHANGED_PATHS=${accepted.length}`);
  } catch (error) {
    console.error("DEPLOY_SOURCE_INTEGRITY=FAIL");
    console.error(`DEPLOY_SOURCE_ERROR=${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();

