import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const PROJECT = "lip-knots-crew-staging", REGION = "asia-northeast1";
export const RETRY_WORKER = "retrySafeSheetWrites";
const OLD_WORKER = "processSafeSheetWrite";

// 停止判定だけを模倣した別処理を通さない。変更時は全ソースをレビューして更新する。
// 旧処理の停止値・キュー・リージョン・exportは保持する。CaseList 専用の
// 明示opt-in処理だけが旧停止判定の前に進むため、その実行依存も固定する。
// この固定値はソース検査用であり、実行時IAMや本番有効化の承認ではない。
export const retryWorkerSourcePins = Object.freeze({
  "functions/src/safe-sheet-writes.ts": "373f6ad03ba9e5deadc0a4fa4f473b9e31959348c4c71a87cd70365466d56f07",
  "functions/src/sheet-write-control.ts": "a57db6a895c42ed58655a42ae67d84754fb679c2f0751d11b5b65edff0387f08",
  "functions/src/index.ts": "b5258e6842732565b671c33c89e43da117baec7e629bf7654d0dccffebbe1dc9",
  "functions/src/case-list-monthly-worker.ts": "09e6e15c9c18296860417de8dea61bf183392fa27d6287576bdfc6216622e80a",
  "functions/src/case-list-monthly-reader.ts": "7a0cfe841bde8fe9b9e12e41eb4f7b58ff0fbfe14620812cc3fd216bac98021a",
  "functions/src/case-list-source-core.ts": "40eb55c72ed7a861524b48d191e5237e4f31b1d02b03652b3c3893acf53de82c",
  "functions/src/case-list-monthly-controller.cjs": "c96a72462669f38d0ff1af75c6f1f655bb7d9d971daea43ec136fcd697e3d362",
  "functions/src/case-list-monthly-adapter.cjs": "1b46d9854ec9cd428eeed784c32f86a8af3a2f642c1a633b2967d249e5a88821",
  "functions/src/case-list-monthly-compact.cjs": "6d40516a62f7d0d7938b060d229f7e6a142ba174b37e494bcec0a051c8144d87",
  "functions/src/case-list-projection.cjs": "059f39d152981e9e9566c276332f9db7da6442dd99fe3ec12e28c587ff9a3326",
  "functions/src/case-id.ts": "7c03676a32947d8c7a81a8a5b7600c1870ccd2c41b036362bf3e8dd475422d87",
  "functions/src/sheet-write-core.ts": "dd73c7ff9715327b81f61efc6cd703d64e5dd64d651361f45c3a4965a81b28c2",
  "functions/src/system-safety.ts": "25debd6fa931ce85b72f82d4f7e499db99b0054576af0f07a91ffb8917e61ce3",
  "functions/src/sheet-reader.ts": "9362b67e922d89661a26999c4cb44c5394a199635627b69e0de5057a9202dce0"
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
