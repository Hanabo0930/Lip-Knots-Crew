import {
  environmentFingerprint,
  validateEnvironmentConfig,
} from "../src/environment-config-core";

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(message);
}

const staging = {
  environment: "staging" as const,
  firebaseProjectId: "crew-staging",
  appBaseUrl: "https://staging.example.com",
  spreadsheetId: "copy_sheet",
  stripeMode: "test" as const,
  emailMode: "capture" as const,
  pushMode: "test" as const,
  backupBucket: null,
  errorReportingEnabled: true,
};
equal(validateEnvironmentConfig(staging).length, 0, "stagingが不正です。");

const badProduction = {
  ...staging,
  environment: "production" as const,
  stripeMode: "test" as const,
  backupBucket: null,
  errorReportingEnabled: false,
};
equal(
  validateEnvironmentConfig(badProduction).length >= 3,
  true,
  "本番の危険設定を見逃しています。"
);
equal(environmentFingerprint(staging).startsWith("env_"), true, "fingerprint");
console.log("environment config core tests passed");
