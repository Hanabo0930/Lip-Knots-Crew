import { execFileSync } from "node:child_process";
import process from "node:process";

function valueAfter(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

function parseCsv(value) {
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const ref = valueAfter("--ref", "HEAD");
const repository = valueAfter("--repository", ".");
const requirePass = process.argv.includes("--require-pass");
const requestedFunctions = parseCsv(
  valueAfter("--functions", "requestStaffLoginLink,getSubmissionProcessingStatus,driveFilePreview"),
);
const supportedFunctions = new Set([
  "bootstrapSession",
  "getSubmissionTimeline",
  "requestStaffLoginLink",
  "getSubmissionProcessingStatus",
  "getResubmissionComparison",
  "driveFilePreview",
  "finalizeStagedUpload",
]);

if (
  requestedFunctions.length === 0
  || new Set(requestedFunctions).size !== requestedFunctions.length
  || requestedFunctions.some((name) => !supportedFunctions.has(name))
) {
  console.error("SOURCE_GUARD_STATUS=FAIL");
  console.error("SOURCE_GUARD_ERROR=FUNCTION_LIST_NOT_SUPPORTED");
  process.exit(1);
}

const sourceCache = new Map();
function sourceFile(path) {
  if (sourceCache.has(path)) return sourceCache.get(path);
  try {
    const source = execFileSync(
      "git",
      ["show", `${ref}:${path}`],
      { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    sourceCache.set(path, source);
    return source;
  } catch {
    console.error("SOURCE_GUARD_STATUS=FAIL");
    console.error(`SOURCE_GUARD_ERROR=SOURCE_REF_OR_FILE_UNAVAILABLE:${path}`);
    process.exit(1);
  }
}

function functionBlock(source, exportName) {
  const start = source.indexOf(`export const ${exportName}`);
  if (start < 0) return "";
  const remaining = source.slice(start + 1);
  const nextOffset = remaining.search(/\nexport const [A-Za-z0-9_]+/);
  const end = nextOffset < 0 ? source.length : start + 1 + nextOffset;
  return source.slice(start, end);
}

function checkBootstrapSession() {
  const source = sourceFile("functions/src/auth.ts");
  const bootstrap = functionBlock(source, "bootstrapSession");
  const checks = {
    authenticated: /requireAuth\s*\(\s*request\s*\)/.test(bootstrap),
    verifiedEmail: /user\.emailVerified/.test(bootstrap),
    adminAllowlist: /admins\.includes\s*\(\s*email\s*\)/.test(bootstrap),
    refreshRequiresAdmin:
      /if\s*\(\s*input\.refreshDirectory\s*\)[\s\S]*?requireAdmin\s*\(\s*request\s*\)/.test(bootstrap),
    refreshCompanyScope:
      /companyFromClaims\s*\(\s*session\.token\s*\)/.test(bootstrap)
      && /fetchAdminDirectory\s*\(\s*companyId\s*\)/.test(bootstrap),
    initialCompanyScope:
      /companyId\s*:\s*defaultCompanyId\.value\s*\(\s*\)/.test(bootstrap)
      && /fetchAdminDirectory\s*\(\s*claims\.companyId\s*\)/.test(bootstrap),
    directoryCompanyQueries:
      /async function fetchAdminDirectory\s*\(\s*companyId\s*:\s*string\s*\)/.test(source)
      && (source.match(/\.where\s*\(\s*"companyId"\s*,\s*"=="\s*,\s*companyId\s*\)/g) ?? []).length === 2,
    noClientCompanyScope: !/input\.companyId/.test(bootstrap),
  };
  return Object.values(checks).every(Boolean);
}

function checkRequestStaffLoginLink() {
  const source = sourceFile("functions/src/login-links.ts");
  const block = functionBlock(source, "requestStaffLoginLink");
  const rateLimitStart = source.indexOf("async function enforceLoginRateLimit");
  const rateLimit = rateLimitStart < 0 ? "" : source.slice(rateLimitStart);
  const checks = {
    strictEmailInput:
      /RequestLoginSchema\.safeParse\s*\(\s*request\.data\s*\?\?\s*\{\}\s*\)/.test(block)
      && /z\.string\(\)\.email\(\)\.max\(254\)/.test(source),
    normalizedEmail: /normalizeEmail\s*\(\s*input\.data\.email\s*\)/.test(block),
    hashedDirectoryLookup:
      /emailIndex/.test(block)
      && /\.doc\s*\(\s*emailHash\s*\(\s*email\s*\)\s*\)/.test(block),
    activeStaffGate:
      /indexSnap\.exists/.test(block)
      && /index\?\.active/.test(block)
      && /profileSnap\.data\(\)\?\.active\s*===\s*true/.test(block),
    operationalGate: /assertProductionOperational\s*\(\s*index\.companyId\s*\)/.test(block),
    rateLimited:
      /enforceLoginRateLimit\s*\(\s*email\s*\)/.test(block)
      && /minuteCount\s*>=\s*1\s*\|\|\s*hourCount\s*>=\s*5/.test(rateLimit)
      && /resource-exhausted/.test(rateLimit),
    enumerationResistantResponse:
      /accepted\s*:\s*true/.test(block)
      && /登録済みのメールアドレスの場合/.test(block),
    mailSecretScoped: /secrets\s*:\s*\[gmailServiceAccountJson\]/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkSubmissionTimeline() {
  const source = sourceFile("functions/src/submission-files.ts");
  const block = functionBlock(source, "getSubmissionTimeline");
  return [
    /requireAuth\s*\(\s*request\s*\)/,
    /companyFromClaims\s*\(\s*session\.token\s*\)/,
    /assertJobAccess\s*\(\s*input\.jobId\s*,\s*companyId/,
  ].every((pattern) => pattern.test(block));
}

function checkSubmissionProcessingStatus() {
  const source = sourceFile("functions/src/submission-files.ts");
  const block = functionBlock(source, "getSubmissionProcessingStatus");
  const checks = {
    requireAuth: /requireAuth\s*\(\s*request\s*\)/.test(block),
    companyScope: /companyFromClaims/.test(block) && /companyId/.test(block),
    jobAccess: /assertJobAccess/.test(block),
    staffScope: /data\.staffId/.test(block) && /permission-denied/.test(block),
    jobSubmissionMatch: /data\.jobId\s*!==\s*input\.jobId/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkResubmissionComparison() {
  const source = sourceFile("functions/src/submission-files.ts");
  const block = functionBlock(source, "getResubmissionComparison");
  const checks = {
    requireAuth: /requireAuth\s*\(\s*request\s*\)/.test(block),
    companyScope: /companyFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    documentScope: /snap\.data\(\)\?\.companyId\s*!==\s*companyId/.test(block),
    staffScope: /session\.token\.role\s*!==\s*"admin"[\s\S]*data\.staffId\s*!==\s*staffId/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkDriveFilePreview() {
  const source = sourceFile("functions/src/submission-files.ts");
  const handlerStart = source.indexOf("async function handleDriveFilePreview");
  const handler = handlerStart < 0 ? "" : source.slice(handlerStart);
  const block = `${handler}\n${functionBlock(source, "driveFilePreview")}`;
  const checks = {
    tokenShape: /A-Za-z0-9_-\]\{30,120\}/.test(block),
    tokenHash: /sha256\s*\(\s*token\s*\)/.test(block),
    tokenLookup: /filePreviewTokens/.test(block) && /\.doc\s*\(\s*hash\s*\)/.test(block),
    activeAndExpiry:
      /data\.active\s*!==\s*true/.test(block)
      && /expires\.toMillis\(\)\s*<\s*Date\.now\(\)/.test(block),
    invalidTokenRejected: /status\s*\(\s*400\s*\)/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkFinalizeStagedUpload() {
  const source = sourceFile("functions/src/uploads.ts");
  const block = functionBlock(source, "finalizeStagedUpload");
  const checks = {
    storageEventOnly: /onObjectFinalized\s*\(/.test(block),
    stagingPathOnly: /parts\[0\]\s*!==\s*"staging"/.test(block),
    completeIdentity: /!companyId\s*\|\|\s*!uid\s*\|\|\s*!submissionId\s*\|\|\s*!fileId/.test(block),
    metadataScope: /meta\.uid\s*!==\s*uid\s*\|\|\s*meta\.companyId\s*!==\s*companyId/.test(block),
    operationalGate: /getProductionOperationalState\s*\(\s*companyId\s*\)/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

const checkers = {
  bootstrapSession: checkBootstrapSession,
  requestStaffLoginLink: checkRequestStaffLoginLink,
  getSubmissionTimeline: checkSubmissionTimeline,
  getSubmissionProcessingStatus: checkSubmissionProcessingStatus,
  getResubmissionComparison: checkResubmissionComparison,
  driveFilePreview: checkDriveFilePreview,
  finalizeStagedUpload: checkFinalizeStagedUpload,
};

const results = requestedFunctions.map((name) => ({
  name,
  passed: checkers[name](),
}));
const allPass = results.every(({ passed }) => passed);
const loadedSource = [...sourceCache.values()].join("\n");
const appCheckEnforced = /enforceAppCheck\s*:\s*true/.test(loadedSource);

console.log(`SOURCE_REF=${ref}`);
console.log(`SOURCE_GUARD_FUNCTIONS=${requestedFunctions.join(",")}`);
for (const { name, passed } of results) {
  console.log(`APP_LEVEL_AUTH_${name}=${passed ? "PASS" : "FAIL"}`);
}
console.log(`APP_CHECK_ENFORCED=${appCheckEnforced ? "true" : "false"}`);
console.log("APP_CHECK_HANDLING=Firebase Auth, company boundaries, scoped preview tokens, or storage-event identity checks are enforced by function type.");
console.log(`SOURCE_GUARD_STATUS=${allPass ? "PASS" : "FAIL"}`);

if (requirePass && !allPass) process.exitCode = 1;
