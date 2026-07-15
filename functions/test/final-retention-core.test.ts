import { finalRetentionDecision } from "../src/final-retention-core";

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(message);
}

equal(
  finalRetentionDecision({
    filename: "v2.0.zip",
    category: "current_source",
  }).decision,
  "KEEP_CURRENT",
  "現行版"
);
equal(
  finalRetentionDecision({
    filename: "v1.9.zip",
    category: "old_source",
  }).decision,
  "ARCHIVE",
  "旧版"
);
equal(
  finalRetentionDecision({
    filename: "node_modules",
    category: "dependency",
  }).decision,
  "DELETE_CANDIDATE",
  "依存物"
);
equal(
  finalRetentionDecision({
    filename: "service-account.json",
    category: "secret",
    containsSecret: true,
  }).decision,
  "DELETE_CANDIDATE",
  "秘密情報"
);
console.log("final retention core tests passed");
