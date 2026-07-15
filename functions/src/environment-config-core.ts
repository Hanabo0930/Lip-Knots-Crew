export type EnvironmentName = "development" | "staging" | "production";

export type EnvironmentConfig = {
  environment: EnvironmentName;
  firebaseProjectId: string;
  appBaseUrl: string;
  spreadsheetId?: string | null;
  stripeMode: "disabled" | "test" | "live";
  emailMode: "disabled" | "capture" | "live";
  pushMode: "disabled" | "test" | "live";
  backupBucket?: string | null;
  errorReportingEnabled: boolean;
};

export function validateEnvironmentConfig(
  config: EnvironmentConfig
): string[] {
  const errors: string[] = [];
  if (!config.firebaseProjectId.trim()) {
    errors.push("Firebase Project IDがありません。");
  }

  try {
    const url = new URL(config.appBaseUrl);
    if (url.protocol !== "https:" && config.environment !== "development") {
      errors.push("検証・本番URLはHTTPSが必須です。");
    }
  } catch {
    errors.push("アプリURLが不正です。");
  }

  if (config.environment === "production") {
    if (config.stripeMode === "test") {
      errors.push("本番環境でStripe testを使用できません。");
    }
    if (config.emailMode === "capture") {
      errors.push("本番環境でメールcaptureを使用できません。");
    }
    if (!config.backupBucket) {
      errors.push("本番バックアップ先がありません。");
    }
    if (!config.errorReportingEnabled) {
      errors.push("本番エラー監視が無効です。");
    }
  } else {
    if (config.stripeMode === "live") {
      errors.push("開発・検証環境でStripe liveを使用できません。");
    }
    if (config.emailMode === "live") {
      errors.push("開発・検証環境で実メール送信を使用できません。");
    }
    if (config.pushMode === "live") {
      errors.push("開発・検証環境で本番Pushを使用できません。");
    }
  }

  return errors;
}

export function environmentFingerprint(
  config: EnvironmentConfig
): string {
  const value = [
    config.environment,
    config.firebaseProjectId,
    config.appBaseUrl,
    config.spreadsheetId ?? "",
    config.stripeMode,
    config.emailMode,
    config.pushMode,
    config.backupBucket ?? "",
    config.errorReportingEnabled,
  ].join("|");

  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `env_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
