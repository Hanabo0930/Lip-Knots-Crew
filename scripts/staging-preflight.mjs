import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const exampleMode = process.argv.includes("--examples");
const selfTestMode = process.argv.includes("--self-test");

const paths = exampleMode
  ? {
      firebaserc: ".firebaserc.example",
      environment: "config-samples/environments/staging.json",
      staff: "apps/staff/.env.staging.example",
      admin: "apps/admin/.env.staging.example",
      functions: "functions/.env.staging.example",
    }
  : {
      firebaserc: ".firebaserc",
      environment: "config/environments/staging.json",
      staff: "apps/staff/.env.staging",
      admin: "apps/admin/.env.staging",
      functions: "functions/.env.staging",
    };

function parseEnv(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readJson(relativePath, errors) {
  const absolutePath = resolve(root, relativePath);
  if (!existsSync(absolutePath)) {
    errors.push(`${relativePath} がありません。サンプルをコピーして実値へ置換してください。`);
    return {};
  }
  try {
    return JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    errors.push(`${relativePath} のJSONが不正です: ${error.message}`);
    return {};
  }
}

function readEnv(relativePath, errors) {
  const absolutePath = resolve(root, relativePath);
  if (!existsSync(absolutePath)) {
    errors.push(`${relativePath} がありません。サンプルをコピーして実値へ置換してください。`);
    return {};
  }
  return parseEnv(readFileSync(absolutePath, "utf8"));
}

function hasPlaceholder(value) {
  return /YOUR_|REPLACE_ME|example\.com/iu.test(String(value ?? ""));
}

function requireValue(values, key, label, errors) {
  const value = String(values?.[key] ?? "").trim();
  if (!value) errors.push(`${label}: ${key} が未設定です。`);
  return value;
}

function requireHttps(value, label, errors) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") errors.push(`${label} はHTTPSが必須です。`);
  } catch {
    errors.push(`${label} がURLとして不正です。`);
  }
}

function validateClientEnv(env, label, stagingProject, allowPlaceholders, errors) {
  const requiredKeys = [
    "VITE_APP_ENVIRONMENT",
    "VITE_EXPECTED_FIREBASE_PROJECT_ID",
    "VITE_FUNCTIONS_REGION",
    "VITE_FIREBASE_API_KEY",
    "VITE_FIREBASE_AUTH_DOMAIN",
    "VITE_FIREBASE_PROJECT_ID",
    "VITE_FIREBASE_STORAGE_BUCKET",
    "VITE_FIREBASE_MESSAGING_SENDER_ID",
    "VITE_FIREBASE_APP_ID",
    "VITE_USE_EMULATORS",
    "VITE_FIREBASE_VAPID_KEY",
  ];
  for (const key of requiredKeys) requireValue(env, key, label, errors);

  if (env.VITE_APP_ENVIRONMENT !== "staging") {
    errors.push(`${label}: VITE_APP_ENVIRONMENT は staging 固定です。`);
  }
  if (env.VITE_USE_EMULATORS !== "false") {
    errors.push(`${label}: stagingではVITE_USE_EMULATORS=falseが必須です。`);
  }
  if (env.VITE_FUNCTIONS_REGION !== "asia-northeast1") {
    errors.push(`${label}: Functions regionはasia-northeast1で統一してください。`);
  }
  if (env.VITE_FIREBASE_PROJECT_ID !== stagingProject) {
    errors.push(`${label}: Firebase Project IDが.firebasercのstagingと一致しません。`);
  }
  if (env.VITE_EXPECTED_FIREBASE_PROJECT_ID !== stagingProject) {
    errors.push(`${label}: expected Project IDが.firebasercのstagingと一致しません。`);
  }
  if (
    env.VITE_FIREBASE_AUTH_DOMAIN &&
    !env.VITE_FIREBASE_AUTH_DOMAIN.includes(stagingProject)
  ) {
    errors.push(`${label}: Auth Domainがstaging Project IDと一致しません。`);
  }
  if (
    env.VITE_FIREBASE_STORAGE_BUCKET &&
    !env.VITE_FIREBASE_STORAGE_BUCKET.includes(stagingProject)
  ) {
    errors.push(`${label}: Storage Bucketがstaging Project IDと一致しません。`);
  }
  if (!allowPlaceholders) {
    for (const key of requiredKeys) {
      if (hasPlaceholder(env[key])) errors.push(`${label}: ${key} がサンプル値のままです。`);
    }
  }
}

function validateConfiguration(data, { allowPlaceholders }) {
  const errors = [];
  const { firebaserc, environment, staff, admin, functions } = data;
  const projects = firebaserc.projects ?? {};

  if (Object.hasOwn(projects, "default")) {
    errors.push(".firebasercにdefault aliasを置けません。明示的な環境名を使用してください。");
  }
  const developmentProject = requireValue(projects, "development", ".firebaserc projects", errors);
  const stagingProject = requireValue(projects, "staging", ".firebaserc projects", errors);
  const productionProject = requireValue(projects, "production", ".firebaserc projects", errors);
  const uniqueProjects = new Set([developmentProject, stagingProject, productionProject].filter(Boolean));
  if (uniqueProjects.size !== 3) {
    errors.push("development・staging・productionのFirebase Project IDはすべて分離してください。");
  }

  for (const [projectId, label] of [
    [stagingProject, "staging"],
    [productionProject, "production"],
  ]) {
    const hosting = firebaserc.targets?.[projectId]?.hosting;
    if (!Array.isArray(hosting?.staff) || hosting.staff.length !== 1) {
      errors.push(`.firebaserc: ${label}のstaff hosting targetを1件指定してください。`);
    }
    if (!Array.isArray(hosting?.admin) || hosting.admin.length !== 1) {
      errors.push(`.firebaserc: ${label}のadmin hosting targetを1件指定してください。`);
    }
  }

  if (environment.environment !== "staging") {
    errors.push("環境設定のenvironmentはstaging固定です。");
  }
  if (environment.firebaseProjectId !== stagingProject) {
    errors.push("環境設定のFirebase Project IDが.firebasercのstagingと一致しません。");
  }
  requireHttps(environment.appBaseUrl ?? "", "staging appBaseUrl", errors);
  if (!environment.spreadsheetId) errors.push("staging spreadsheetIdが未設定です。");
  if (!environment.backupBucket) errors.push("staging backupBucketが未設定です。");
  if (environment.stripeMode === "live") errors.push("stagingでStripe liveを使用できません。");
  if (environment.emailMode === "live") errors.push("stagingで実メール送信を使用できません。");
  if (environment.pushMode === "live") errors.push("stagingで本番Pushを使用できません。");
  if (environment.errorReportingEnabled !== true) {
    errors.push("stagingのerrorReportingEnabledはtrueが必須です。");
  }

  validateClientEnv(staff, "staff .env.staging", stagingProject, allowPlaceholders, errors);
  validateClientEnv(admin, "admin .env.staging", stagingProject, allowPlaceholders, errors);
  if (staff.VITE_FIREBASE_PROJECT_ID !== admin.VITE_FIREBASE_PROJECT_ID) {
    errors.push("staffとadminのFirebase Project IDが一致しません。");
  }

  const functionRequiredKeys = [
    "APP_ENVIRONMENT",
    "EXPECTED_FIREBASE_PROJECT_ID",
    "ADMIN_EMAILS",
    "DEFAULT_COMPANY_ID",
    "STAFF_APP_URL",
    "ADMIN_APP_URL",
    "MAIL_FROM",
    "PUBLIC_LOGIN_GATEWAY_URL",
    "FILE_PREVIEW_GATEWAY_URL",
  ];
  for (const key of functionRequiredKeys) {
    requireValue(functions, key, "functions .env.staging", errors);
  }
  if (functions.APP_ENVIRONMENT !== "staging") {
    errors.push("functions .env.staging: APP_ENVIRONMENTはstaging固定です。");
  }
  if (functions.EXPECTED_FIREBASE_PROJECT_ID !== stagingProject) {
    errors.push("Functionsのexpected Project IDが.firebasercのstagingと一致しません。");
  }
  for (const key of [
    "STAFF_APP_URL",
    "ADMIN_APP_URL",
    "PUBLIC_LOGIN_GATEWAY_URL",
    "FILE_PREVIEW_GATEWAY_URL",
  ]) {
    requireHttps(functions[key] ?? "", `functions ${key}`, errors);
  }
  for (const key of ["PUBLIC_LOGIN_GATEWAY_URL", "FILE_PREVIEW_GATEWAY_URL"]) {
    if (functions[key] && !functions[key].includes(stagingProject)) {
      errors.push(`functions ${key} がstaging Project IDを参照していません。`);
    }
  }

  if (!allowPlaceholders) {
    const strictValues = [
      ...Object.values(projects),
      environment.firebaseProjectId,
      environment.appBaseUrl,
      environment.spreadsheetId,
      environment.backupBucket,
      ...functionRequiredKeys.map((key) => functions[key]),
    ];
    if (strictValues.some(hasPlaceholder)) {
      errors.push("staging設定にサンプル値（YOUR_ / example.com）が残っています。");
    }
  }

  return errors;
}

function loadConfiguration(errors) {
  return {
    firebaserc: readJson(paths.firebaserc, errors),
    environment: readJson(paths.environment, errors),
    staff: readEnv(paths.staff, errors),
    admin: readEnv(paths.admin, errors),
    functions: readEnv(paths.functions, errors),
  };
}

function selfTest() {
  const safe = {
    firebaserc: {
      projects: {
        development: "crew-dev",
        staging: "crew-staging",
        production: "crew-production",
      },
      targets: {
        "crew-staging": { hosting: { staff: ["staff-stg"], admin: ["admin-stg"] } },
        "crew-production": { hosting: { staff: ["staff-prod"], admin: ["admin-prod"] } },
      },
    },
    environment: {
      environment: "staging",
      firebaseProjectId: "crew-staging",
      appBaseUrl: "https://staging.lipknots.test",
      spreadsheetId: "sheet-staging",
      stripeMode: "test",
      emailMode: "capture",
      pushMode: "test",
      backupBucket: "crew-staging-backup",
      errorReportingEnabled: true,
    },
    staff: {
      VITE_APP_ENVIRONMENT: "staging",
      VITE_EXPECTED_FIREBASE_PROJECT_ID: "crew-staging",
      VITE_FUNCTIONS_REGION: "asia-northeast1",
      VITE_FIREBASE_API_KEY: "staging-key",
      VITE_FIREBASE_AUTH_DOMAIN: "crew-staging.firebaseapp.com",
      VITE_FIREBASE_PROJECT_ID: "crew-staging",
      VITE_FIREBASE_STORAGE_BUCKET: "crew-staging.firebasestorage.app",
      VITE_FIREBASE_MESSAGING_SENDER_ID: "12345",
      VITE_FIREBASE_APP_ID: "staff-app",
      VITE_USE_EMULATORS: "false",
      VITE_FIREBASE_VAPID_KEY: "staging-vapid",
    },
    admin: {},
    functions: {
      APP_ENVIRONMENT: "staging",
      EXPECTED_FIREBASE_PROJECT_ID: "crew-staging",
      ADMIN_EMAILS: "admin@lipknots.test",
      DEFAULT_COMPANY_ID: "lipknots-staging",
      STAFF_APP_URL: "https://staff-staging.lipknots.test",
      ADMIN_APP_URL: "https://admin-staging.lipknots.test",
      MAIL_FROM: "staging@lipknots.test",
      PUBLIC_LOGIN_GATEWAY_URL: "https://asia-northeast1-crew-staging.cloudfunctions.net/loginGateway",
      FILE_PREVIEW_GATEWAY_URL: "https://asia-northeast1-crew-staging.cloudfunctions.net/driveFilePreview",
    },
  };
  safe.admin = { ...safe.staff, VITE_FIREBASE_APP_ID: "admin-app" };

  const safeErrors = validateConfiguration(safe, { allowPlaceholders: false });
  if (safeErrors.length) return [`自己診断の安全設定が不合格です: ${safeErrors.join(" / ")}`];

  const cases = [
    {
      name: "本番Project混入",
      mutate: (value) => { value.staff.VITE_FIREBASE_PROJECT_ID = "crew-production"; },
      expected: "Firebase Project ID",
    },
    {
      name: "Emulator混入",
      mutate: (value) => { value.admin.VITE_USE_EMULATORS = "true"; },
      expected: "VITE_USE_EMULATORS=false",
    },
    {
      name: "Stripe live混入",
      mutate: (value) => { value.environment.stripeMode = "live"; },
      expected: "Stripe live",
    },
    {
      name: "Functions環境違い",
      mutate: (value) => { value.functions.APP_ENVIRONMENT = "production"; },
      expected: "APP_ENVIRONMENT",
    },
    {
      name: "default alias混入",
      mutate: (value) => { value.firebaserc.projects.default = "crew-staging"; },
      expected: "default alias",
    },
  ];
  const failures = [];
  for (const testCase of cases) {
    const candidate = structuredClone(safe);
    testCase.mutate(candidate);
    const errors = validateConfiguration(candidate, { allowPlaceholders: false });
    if (!errors.some((error) => error.includes(testCase.expected))) {
      failures.push(`${testCase.name}を検出できませんでした。`);
    }
  }
  return failures;
}

const errors = [];
const loaded = loadConfiguration(errors);
if (!errors.length) {
  errors.push(...validateConfiguration(loaded, { allowPlaceholders: exampleMode }));
}
if (selfTestMode) errors.push(...selfTest());

if (errors.length) {
  console.error(`STAGING PREFLIGHT: FAIL (${errors.length})`);
  errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  process.exit(1);
}

const projectId = loaded.firebaserc.projects?.staging ?? "example";
console.log(`STAGING PREFLIGHT: PASS project=${projectId}`);
if (selfTestMode) console.log("STAGING PREFLIGHT SELF-TEST: PASS (5 rejection cases)");
