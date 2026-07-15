export type FinalRetentionDecision =
  | "KEEP_CURRENT"
  | "KEEP_EVIDENCE"
  | "ARCHIVE"
  | "DELETE_CANDIDATE";

export type FinalRetentionInput = {
  filename: string;
  category:
    | "current_source"
    | "old_source"
    | "audit_evidence"
    | "manual"
    | "temporary"
    | "dependency"
    | "secret"
    | "duplicate";
  deployedVersion?: boolean;
  neededForRestore?: boolean;
  containsSecret?: boolean;
  duplicateHash?: boolean;
};

export function finalRetentionDecision(
  item: FinalRetentionInput
): {
  decision: FinalRetentionDecision;
  folder: string;
  reason: string;
} {
  if (item.containsSecret || item.category === "secret") {
    return {
      decision: "DELETE_CANDIDATE",
      folder: "99_削除候補",
      reason: "秘密情報は通常のDriveへ保存しません。",
    };
  }

  if (item.duplicateHash || item.category === "duplicate") {
    return {
      decision: "DELETE_CANDIDATE",
      folder: "99_削除候補",
      reason: "同一内容の重複ファイルです。",
    };
  }

  if (item.category === "current_source" || item.deployedVersion) {
    return {
      decision: "KEEP_CURRENT",
      folder: "01_現行最新版",
      reason: "現在の本番または次回開発の基点です。",
    };
  }

  if (
    item.category === "audit_evidence" ||
    item.category === "manual"
  ) {
    return {
      decision: "KEEP_EVIDENCE",
      folder: "05_監査・移行",
      reason: "導入判断・監査・復旧の証拠です。",
    };
  }

  if (
    item.category === "old_source" ||
    item.neededForRestore
  ) {
    return {
      decision: "ARCHIVE",
      folder: "02_旧バージョン",
      reason: "差分比較と復旧のため保管します。",
    };
  }

  if (
    item.category === "temporary" ||
    item.category === "dependency"
  ) {
    return {
      decision: "DELETE_CANDIDATE",
      folder: "99_削除候補",
      reason: "再生成可能な一時物または依存物です。",
    };
  }

  return {
    decision: "ARCHIVE",
    folder: "02_旧バージョン",
    reason: "判断保留のため旧資料として保管します。",
  };
}
