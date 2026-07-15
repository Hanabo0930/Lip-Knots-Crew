export type ArtifactDecision = "keep_current" | "archive" | "keep_evidence" | "delete_candidate";

export type ArtifactRecord = {
  name: string;
  version: string;
  kind: "source_zip" | "test_evidence" | "config" | "documentation" | "secret" | "generated_output";
  isLatest: boolean;
  containsSecrets: boolean;
  referencedByLatest: boolean;
  neededForAudit: boolean;
  ageDays: number;
};

export type ArtifactClassification = ArtifactRecord & {
  decision: ArtifactDecision;
  reason: string;
};

export function classifyArtifacts(records: ArtifactRecord[]): ArtifactClassification[] {
  const latestVersions = new Map<string, string>();
  for (const record of records) {
    if (record.isLatest) latestVersions.set(record.kind, record.version);
  }

  return records.map((record) => {
    if (record.containsSecrets) {
      return {
        ...record,
        decision: "delete_candidate",
        reason: "秘密情報は通常のDriveや配布ZIPへ保存しません。",
      };
    }

    if (record.isLatest && record.kind === "source_zip") {
      return {
        ...record,
        decision: "keep_current",
        reason: "次の開発・復旧の基点となる現行ソースです。",
      };
    }

    if (record.neededForAudit || record.kind === "test_evidence") {
      return {
        ...record,
        decision: "keep_evidence",
        reason: "監査・回帰試験・導入判断の証拠として保存します。",
      };
    }

    if (record.kind === "source_zip" && !record.isLatest) {
      return {
        ...record,
        decision: "archive",
        reason: "復旧・差分比較用の旧版として保管します。",
      };
    }

    if (record.referencedByLatest) {
      return {
        ...record,
        decision: "archive",
        reason: "現行版から参照されるため削除せず保管します。",
      };
    }

    if (record.kind === "generated_output" && record.ageDays > 30) {
      return {
        ...record,
        decision: "delete_candidate",
        reason: "再生成できる一時出力で、30日を超えています。",
      };
    }

    return {
      ...record,
      decision: "archive",
      reason: "現時点では削除せず、旧資料として保管します。",
    };
  });
}

export function driveFolderFor(decision: ArtifactDecision): string {
  if (decision === "keep_current") return "01_現行最新版";
  if (decision === "archive") return "02_旧バージョン";
  if (decision === "keep_evidence") return "05_監査・移行";
  return "99_削除候補";
}
