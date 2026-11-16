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
  // Independently reviewed external readback dependencies; defaults stay read-only.
  "functions/src/case-list-external-core.cjs": "91c8e0024500e66eb24390a2646f9e9f289dcb46ed6bee95d386368feabb1082",
  "functions/src/case-list-external-mode.ts": "6d415de924e5fdfc3e44d00e6e6ee098625c453a6dbf0aa0e962828b38526efb",
  "functions/src/case-list-external-transfer.ts": "20334bc28a4be1f65425fed9adc8c801c9520ef8be02bdb141608cb818a83c10",
  "functions/src/case-list-gas-date-formula.ts": "b9e37bf557d63da36740b94b94f338a9a248512b48e97a3b339ff1e8768ce931",
  "functions/src/case-list-gas-planner.cjs": "07035fe0242d79b9d4d8264b0f8bbcc22cfd4e343932a20d40e42336f85c6ca6",
  "functions/src/case-list-gas-proof.ts": "e9f7de3f9983b84c9e8d62d70fa1b81b7a7788b13f0f1b5502a207b9d0f5a082",
  // Reviewed Source BD/BE continuation: existing queue/lease/transport, both modes default paused.
  "functions/src/case-list-publication-core.ts": "14cd481606974d29c65af44d804eb2199cc3ac220d230be5d9ea4f3f585287ac",
  "functions/src/case-list-publication-finalizer.ts": "fe2773482dc6a79ffe0e416ca4dbf4f3a4ae0821e67ae4c78b88831a0c43f0ac",
  "functions/src/case-list-publication-worker.ts": "a16375e7056ce176cfb54751c2d35cc240458c7413be92d353823fd529798b14",
  // Reviewed durable publication barrier shared by unassigned cancellation capture/native authorization.
  "functions/src/case-list-publication-state.ts": "c2c5a154fb8528acf97667a4c172ca4d9de8c2e34d129497ba172156b2841a83",
  "functions/src/case-list-manual-origin-core.ts": "c4747e7ab535185e3aa10a089385a2240f314eaaeded6247e59277df67a3c3cd",
  "functions/src/safe-sheet-writes.ts": "a99dc707a8fe04f03be70b6579cc22dd3ebbb0e3a35b7b65cbb614e2f1411370",
  // Reviewed native Source cancellation is reachable only after the existing pause/claim boundary.
  "functions/src/case-list-source-cancellation.ts": "85064fe29871716b69eba3e43b2e705c79d5f32d58d95f7659738b80f8497097",
  "functions/src/sheet-write-control.ts": "a57db6a895c42ed58655a42ae67d84754fb679c2f0751d11b5b65edff0387f08",
  "functions/src/index.ts": "b5258e6842732565b671c33c89e43da117baec7e629bf7654d0dccffebbe1dc9",
  "functions/src/case-list-monthly-worker.ts": "2111880a97ce708efc4533291988f8bf4af3537cfe9e250127097304a1974648",
  "functions/src/case-list-monthly-reader.ts": "bb0b7beace411107282b3736bf74057e7073044c8a90221aea80f8f81df1861a",
  "functions/src/case-list-source-core.ts": "f57879a56d30d5e36c85c76a3c370e1c06a442d115dab2a423e6cad96874ce69",
  "functions/src/case-list-monthly-controller.cjs": "d2c82e3e01a09bab126a8b58b4842df12e462234e12d5ee4408f3df029660ca4",
  "functions/src/case-list-monthly-adapter.cjs": "2d56999a4bc6b99424c16ebffd15a2c76d7800b69775906b9c365a99be648845",
  "functions/src/case-list-monthly-compact.cjs": "fc0b67415e64be5f10222266cb51c339e28ac9d9808e3bdd086c1510ac1e3cb5",
  "functions/src/case-list-projection.cjs": "059f39d152981e9e9566c276332f9db7da6442dd99fe3ec12e28c587ff9a3326",
  "functions/src/case-id.ts": "7c03676a32947d8c7a81a8a5b7600c1870ccd2c41b036362bf3e8dd475422d87",
  // Reviewed capture-before-clear and BL-only legacy ACK guard; pure validation, no new I/O.
  "functions/src/sheet-write-core.ts": "fe677879d21187855c208c7ccdc22ffd9968b6f8fb658dd65f9d6dd7d54850af",
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
