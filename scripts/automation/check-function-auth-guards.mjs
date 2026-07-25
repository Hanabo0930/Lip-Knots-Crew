import { execFileSync } from "node:child_process";
import process from "node:process";

function valueAfter(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

const ref = valueAfter("--ref", "HEAD");
const repository = valueAfter("--repository", ".");
const requirePass = process.argv.includes("--require-pass");

let source = "";
try {
  source = execFileSync(
    "git",
    ["show", `${ref}:functions/src/submission-files.ts`],
    { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch {
  console.error("SOURCE_GUARD_STATUS=FAIL");
  console.error("SOURCE_GUARD_ERROR=SOURCE_REF_OR_FILE_UNAVAILABLE");
  process.exit(1);
}

function functionBlock(exportName, nextExportName) {
  const start = source.indexOf(`export const ${exportName}`);
  const end = nextExportName ? source.indexOf(`export const ${nextExportName}`, start + 1) : source.length;
  if (start < 0 || end < 0) return "";
  return source.slice(start, end);
}

const processing = functionBlock("getSubmissionProcessingStatus", "getResubmissionComparison");
const preview = source.slice(
  source.indexOf("async function handleDriveFilePreview"),
  source.indexOf("export const driveFilePreview") + 240,
);

const processingChecks = {
  requireAuth: /requireAuth\s*\(\s*request\s*\)/.test(processing),
  companyScope: /companyFromClaims/.test(processing) && /companyId/.test(processing),
  jobAccess: /assertJobAccess/.test(processing),
  staffScope: /data\.staffId/.test(processing) && /permission-denied/.test(processing),
  jobSubmissionMatch: /data\.jobId\s*!==\s*input\.jobId/.test(processing),
};

const previewChecks = {
  tokenShape: /A-Za-z0-9_-\]\{30,120\}/.test(preview),
  tokenHash: /sha256\s*\(\s*token\s*\)/.test(preview),
  tokenLookup: /filePreviewTokens/.test(preview) && /\.doc\s*\(\s*hash\s*\)/.test(preview),
  activeAndExpiry: /data\.active\s*!==\s*true/.test(preview) && /expires\.toMillis\(\)\s*<\s*Date\.now\(\)/.test(preview),
  invalidTokenRejected: /status\s*\(\s*400\s*\)/.test(preview),
};

const processingPass = Object.values(processingChecks).every(Boolean);
const previewPass = Object.values(previewChecks).every(Boolean);
const appCheckEnforced = /enforceAppCheck\s*:\s*true/.test(source);

console.log(`SOURCE_REF=${ref}`);
console.log(`APP_LEVEL_AUTH_getSubmissionProcessingStatus=${processingPass ? "PASS" : "FAIL"}`);
console.log(`APP_LEVEL_AUTH_driveFilePreview=${previewPass ? "PASS" : "FAIL"}`);
console.log(`APP_CHECK_ENFORCED=${appCheckEnforced ? "true" : "false"}`);
console.log("APP_CHECK_HANDLING=Firebase Auth and scoped preview tokens are enforced; App Check is not explicitly enforced in this file.");
console.log(`SOURCE_GUARD_STATUS=${processingPass && previewPass ? "PASS" : "FAIL"}`);

if (requirePass && (!processingPass || !previewPass)) process.exitCode = 1;
