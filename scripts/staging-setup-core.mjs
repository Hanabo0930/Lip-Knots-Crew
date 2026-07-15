const requiredFirebaseKeys = [
  "developmentProjectId",
  "stagingProjectId",
  "productionProjectId",
  "stagingStaffHostingSite",
  "stagingAdminHostingSite",
  "productionStaffHostingSite",
  "productionAdminHostingSite",
  "webApiKey",
  "authDomain",
  "storageBucket",
  "messagingSenderId",
  "staffAppId",
  "adminAppId",
  "vapidKey",
  "functionsRegion",
];

const requiredApplicationKeys = [
  "appBaseUrl",
  "staffAppUrl",
  "adminAppUrl",
  "spreadsheetId",
  "backupBucket",
  "defaultCompanyId",
  "mailFrom",
];

export const stagingOutputPaths = [
  ".firebaserc",
  "config/environments/staging.json",
  "config/staging-smoke.json",
  "apps/staff/.env.staging",
  "apps/admin/.env.staging",
  "functions/.env.staging",
];

export function hasSetupPlaceholder(value) {
  return /YOUR_|REPLACE_ME|example\.com/iu.test(String(value ?? ""));
}

function requireSafeString(values, key, label, errors) {
  const value = values?.[key];
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label}.${key} が未設定です。`);
    return "";
  }
  if (/[\r\n\0]/u.test(value)) {
    errors.push(`${label}.${key} に改行またはNULL文字を使用できません。`);
  }
  if (value !== value.trim()) {
    errors.push(`${label}.${key} の先頭・末尾に空白を使用できません。`);
  }
  return value.trim();
}

function requireHttps(value, label, errors) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") errors.push(`${label} はHTTPSが必須です。`);
  } catch {
    errors.push(`${label} がURLとして不正です。`);
  }
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

export function validateStagingSetup(config, { allowPlaceholders = false } = {}) {
  const errors = [];
  if (config?.version !== 1) errors.push("versionは1が必須です。");
  const firebase = config?.firebase ?? {};
  const application = config?.application ?? {};

  for (const key of requiredFirebaseKeys) {
    requireSafeString(firebase, key, "firebase", errors);
  }
  for (const key of requiredApplicationKeys) {
    requireSafeString(application, key, "application", errors);
  }

  const projectIds = [
    firebase.developmentProjectId,
    firebase.stagingProjectId,
    firebase.productionProjectId,
  ].filter(Boolean);
  if (new Set(projectIds).size !== 3) {
    errors.push("development・staging・productionのProject IDはすべて分離してください。");
  }
  if (!allowPlaceholders) {
    for (const [key, projectId] of [
      ["developmentProjectId", firebase.developmentProjectId],
      ["stagingProjectId", firebase.stagingProjectId],
      ["productionProjectId", firebase.productionProjectId],
    ]) {
      if (projectId && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(projectId)) {
        errors.push(`firebase.${key} がFirebase Project ID形式ではありません。`);
      }
    }
  }

  const hostingSites = [
    firebase.stagingStaffHostingSite,
    firebase.stagingAdminHostingSite,
    firebase.productionStaffHostingSite,
    firebase.productionAdminHostingSite,
  ].filter(Boolean);
  if (new Set(hostingSites).size !== 4) {
    errors.push("staging・productionのHosting siteはstaff/adminを含めすべて分離してください。");
  }
  if (firebase.staffAppId && firebase.staffAppId === firebase.adminAppId) {
    errors.push("staffAppIdとadminAppIdは分離してください。");
  }
  if (firebase.functionsRegion !== "asia-northeast1") {
    errors.push("functionsRegionはasia-northeast1固定です。");
  }
  if (
    firebase.authDomain &&
    firebase.stagingProjectId &&
    !firebase.authDomain.includes(firebase.stagingProjectId)
  ) {
    errors.push("authDomainがstaging Project IDと一致しません。");
  }
  if (
    firebase.storageBucket &&
    firebase.stagingProjectId &&
    !firebase.storageBucket.includes(firebase.stagingProjectId)
  ) {
    errors.push("storageBucketがstaging Project IDと一致しません。");
  }

  for (const [key, label] of [
    ["appBaseUrl", "application.appBaseUrl"],
    ["staffAppUrl", "application.staffAppUrl"],
    ["adminAppUrl", "application.adminAppUrl"],
  ]) {
    if (application[key]) requireHttps(application[key], label, errors);
  }
  if (application.appBaseUrl && application.staffAppUrl && application.appBaseUrl !== application.staffAppUrl) {
    errors.push("appBaseUrlとstaffAppUrlは同一にしてください。");
  }

  const adminEmails = application.adminEmails;
  if (!Array.isArray(adminEmails) || !adminEmails.length) {
    errors.push("application.adminEmailsを1件以上指定してください。");
  } else {
    adminEmails.forEach((email, index) => {
      if (typeof email !== "string" || !isEmail(email) || /[\r\n\0]/u.test(email)) {
        errors.push(`application.adminEmails[${index}] が不正です。`);
      }
    });
  }
  if (application.mailFrom && !isEmail(application.mailFrom)) {
    errors.push("application.mailFromがメールアドレスとして不正です。");
  }

  if (!allowPlaceholders) {
    const values = [
      ...requiredFirebaseKeys.map((key) => firebase[key]),
      ...requiredApplicationKeys.map((key) => application[key]),
      ...(Array.isArray(adminEmails) ? adminEmails : []),
    ];
    if (values.some(hasSetupPlaceholder)) {
      errors.push("設定にサンプル値（YOUR_ / example.com）が残っています。");
    }
  }

  return [...new Set(errors)];
}

function envFile(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

export function renderStagingFiles(config) {
  const { firebase, application } = config;
  const projectId = firebase.stagingProjectId;
  const region = firebase.functionsRegion;
  const clientBase = {
    VITE_APP_ENVIRONMENT: "staging",
    VITE_EXPECTED_FIREBASE_PROJECT_ID: projectId,
    VITE_FUNCTIONS_REGION: region,
    VITE_FIREBASE_API_KEY: firebase.webApiKey,
    VITE_FIREBASE_AUTH_DOMAIN: firebase.authDomain,
    VITE_FIREBASE_PROJECT_ID: projectId,
    VITE_FIREBASE_STORAGE_BUCKET: firebase.storageBucket,
    VITE_FIREBASE_MESSAGING_SENDER_ID: firebase.messagingSenderId,
  };

  const files = new Map();
  files.set(".firebaserc", `${JSON.stringify({
    projects: {
      development: firebase.developmentProjectId,
      staging: projectId,
      production: firebase.productionProjectId,
    },
    targets: {
      [projectId]: {
        hosting: {
          staff: [firebase.stagingStaffHostingSite],
          admin: [firebase.stagingAdminHostingSite],
        },
      },
      [firebase.productionProjectId]: {
        hosting: {
          staff: [firebase.productionStaffHostingSite],
          admin: [firebase.productionAdminHostingSite],
        },
      },
    },
  }, null, 2)}\n`);

  files.set("config/environments/staging.json", `${JSON.stringify({
    environment: "staging",
    firebaseProjectId: projectId,
    appBaseUrl: application.appBaseUrl,
    spreadsheetId: application.spreadsheetId,
    stripeMode: "test",
    emailMode: "capture",
    pushMode: "test",
    backupBucket: application.backupBucket,
    errorReportingEnabled: true,
  }, null, 2)}\n`);

  files.set("config/staging-smoke.json", `${JSON.stringify({
    schemaVersion: 1,
    environment: "staging",
    staffBaseUrl: application.staffAppUrl,
    adminBaseUrl: application.adminAppUrl,
    forbiddenHosts: [
      `${firebase.productionStaffHostingSite}.web.app`,
      `${firebase.productionAdminHostingSite}.web.app`,
    ],
    requestTimeoutMs: 10000,
    retries: 2,
    staffHtmlMarkers: ["<div id=\"root\"></div>"],
    adminHtmlMarkers: ["<div id=\"root\"></div>"],
    staffManifestName: "Lip Knots Crew",
    adminManifestName: "Lip Knots Crew Admin",
    serviceWorkerMarker: "self",
  }, null, 2)}\n`);

  files.set("apps/staff/.env.staging", envFile({
    ...clientBase,
    VITE_FIREBASE_APP_ID: firebase.staffAppId,
    VITE_USE_EMULATORS: "false",
    VITE_FIREBASE_VAPID_KEY: firebase.vapidKey,
  }));
  files.set("apps/admin/.env.staging", envFile({
    ...clientBase,
    VITE_FIREBASE_APP_ID: firebase.adminAppId,
    VITE_USE_EMULATORS: "false",
    VITE_FIREBASE_VAPID_KEY: firebase.vapidKey,
  }));
  files.set("functions/.env.staging", envFile({
    APP_ENVIRONMENT: "staging",
    EXPECTED_FIREBASE_PROJECT_ID: projectId,
    ADMIN_EMAILS: application.adminEmails.join(","),
    DEFAULT_COMPANY_ID: application.defaultCompanyId,
    STAFF_APP_URL: application.staffAppUrl,
    ADMIN_APP_URL: application.adminAppUrl,
    MAIL_FROM: application.mailFrom,
    PUBLIC_LOGIN_GATEWAY_URL: `https://${region}-${projectId}.cloudfunctions.net/loginGateway`,
    FILE_PREVIEW_GATEWAY_URL: `https://${region}-${projectId}.cloudfunctions.net/driveFilePreview`,
  }));

  return files;
}
