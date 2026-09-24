import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const PROJECT = "lip-knots-crew-staging", REGION = "asia-northeast1";
export const RETRY_WORKER = "retrySafeSheetWrites";
const OLD_WORKER = "processSafeSheetWrite";

// 停止判定だけを模倣した別処理を通さない。変更時は全ソースをレビューして更新する。
// onSchedule・キュー・先頭return・停止値・リージョン・exportを含む承認候補の固定版。
export const retryWorkerSourcePins = Object.freeze({
  "functions/src/safe-sheet-writes.ts": "b16fd323c4d11f98b08d39fba6882aca15766b6de6d2174131e6f53c72cf8f94",
  "functions/src/sheet-write-control.ts": "a57db6a895c42ed58655a42ae67d84754fb679c2f0751d11b5b65edff0387f08",
  "functions/src/index.ts": "db18f0954b0e80ec6aefa9de223b510346f0c776334eb1c045c75f6cdaa99c43"
});

export function assertRetryWorkerSource(readSource) {
  for (const [file, expected] of Object.entries(retryWorkerSourcePins)) {
    let source;
    try { source = readSource(file); } catch { throw Error("RETRY_WORKER_SOURCE_MISSING"); }
    if (typeof source !== "string" || createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex") !== expected) {
      throw Error("RETRY_WORKER_SOURCE_NOT_REVIEWED");
    }
  }
}

export function assertSheetWorkerRecovery(plan, sourceDirectory) {
  if (!Array.isArray(plan.functions)) throw Error("SHEET_WORKER_SCOPE_INVALID");
  // 稼働中の旧処理には入口と旧実行の静止証明が必要。この復旧経路では扱わない。
  if (plan.functions.includes(OLD_WORKER)) throw Error("SHEET_WORKER_QUIESCENCE_REQUIRED");
  if (!plan.functions.includes(RETRY_WORKER)) return;
  if (plan.project !== PROJECT || plan.region !== REGION || plan.functions.length !== 1) {
    throw Error("RETRY_WORKER_SINGLE_STAGING_TARGET_REQUIRED");
  }
  assertRetryWorkerSource(file => fs.readFileSync(path.join(sourceDirectory, file), "utf8"));
  const directory = path.join(sourceDirectory, "functions"), expectedFile = ".env." + PROJECT;
  let entries, contents;
  try {
    entries = fs.readdirSync(directory);
    contents = fs.readFileSync(path.join(directory, expectedFile), "utf8");
  } catch { throw Error("SHEET_WORKER_PAUSE_CONFIG_MISSING"); }
  // Firebaseが併読するdotenvや別alias設定を候補へ混ぜない。
  if (entries.some(name => (name === ".env" || name.startsWith(".env.")) && name !== expectedFile && !name.endsWith(".example"))) {
    throw Error("SHEET_WORKER_AMBIGUOUS_DOTENV");
  }
  const required = {
    APP_ENVIRONMENT: "staging", EXPECTED_FIREBASE_PROJECT_ID: PROJECT,
    LKC_SHEET_WRITE_MODE: "paused", LKC_NOTIFICATION_DELIVERY_MODE: "paused",
  };
  for (const [key, value] of Object.entries(required)) {
    const rows = contents.split(/\r?\n/).filter(line => new RegExp("^\\s*(?:export\\s+)?" + key + "\\s*=").test(line));
    if (rows.length !== 1 || rows[0] !== key + "=" + value) throw Error("SHEET_WORKER_PAUSE_CONFIG_INVALID");
  }
}
