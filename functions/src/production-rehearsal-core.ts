import { createHash } from "node:crypto";

export type ProductionRehearsalPlanInput = {
  releaseId: string;
  sourceProjectId: string;
  restoreProjectId: string;
  backupBucket: string;
  maxRtoMinutes: number;
  maxRpoMinutes: number;
};

export type ProductionRehearsalPhase = {
  order: number;
  key: "freeze" | "backup" | "restore" | "validate" | "migration" | "rollback" | "final_review";
  label: string;
  requires: string[];
};

export type ProductionRehearsalMetrics = {
  freezeConfirmed: boolean;
  firestoreExportComplete: boolean;
  storageManifestComplete: boolean;
  authExportComplete: boolean;
  sourceDocumentCount: number;
  sourceStorageObjectCount: number;
  sourceAuthUserCount: number;
  sourceSnapshotSha256: string;
  restoreComplete: boolean;
  restoredDocumentCount: number;
  restoredStorageObjectCount: number;
  restoredAuthUserCount: number;
  restoredSnapshotSha256: string;
  securityRulesDeployed: boolean;
  indexesReady: boolean;
  sampleMismatchCount: number;
  permissionProbeFailures: number;
  smokeFailures: number;
  migrationDryRunComplete: boolean;
  plannedMigrationCount: number;
  dryRunAppliedCount: number;
  migrationDiffCount: number;
  rollbackComplete: boolean;
  rollbackRtoMinutes: number;
  rollbackDataLossMinutes: number;
  postRollbackSmokeFailures: number;
  evidenceRefs: string[];
};

export type ProductionRehearsalCheck = {
  key: string;
  label: string;
  passed: boolean;
  actual: string | number | boolean;
  required: string;
};

export type ProductionRehearsalGate = {
  eligible: boolean;
  checks: ProductionRehearsalCheck[];
  blockers: ProductionRehearsalCheck[];
  normalizedEvidenceRefs: string[];
  fingerprint: string;
};

export function buildProductionRehearsalPlan(input: ProductionRehearsalPlanInput): {
  phases: ProductionRehearsalPhase[];
  fingerprint: string;
} {
  validatePlan(input);
  const phases: ProductionRehearsalPhase[] = [
    { order: 1, key: "freeze", label: "変更凍結・対象固定", requires: ["releaseId", "sourceProjectId", "restoreProjectId"] },
    { order: 2, key: "backup", label: "Firestore・Storage・Authバックアップ", requires: ["firestoreExport", "storageManifest", "authExport", "sourceSnapshotSha256"] },
    { order: 3, key: "restore", label: "隔離プロジェクトへ復元", requires: ["restoreComplete", "securityRules", "indexes"] },
    { order: 4, key: "validate", label: "件数・ハッシュ・権限・smoke検算", requires: ["countMatch", "sha256Match", "permissionProbe", "smoke"] },
    { order: 5, key: "migration", label: "移行dry-run", requires: ["migrationDryRun", "migrationDiffZero"] },
    { order: 6, key: "rollback", label: "切戻し・RTO/RPO計測", requires: ["rollbackComplete", "rto", "rpo", "postRollbackSmoke"] },
    { order: 7, key: "final_review", label: "証跡固定・公開ゲート連携", requires: ["evidenceRefs", "fingerprint"] },
  ];
  const fingerprint = createHash("sha256").update(JSON.stringify({ input, phases })).digest("hex");
  return { phases, fingerprint };
}

export function evaluateProductionRehearsal(
  plan: ProductionRehearsalPlanInput,
  metrics: ProductionRehearsalMetrics
): ProductionRehearsalGate {
  validatePlan(plan);
  validateMetrics(metrics);
  const normalizedEvidenceRefs = [...new Set(metrics.evidenceRefs.map((value) => value.trim()).filter(Boolean))].sort();
  const checks: ProductionRehearsalCheck[] = [
    check("freeze", "変更凍結", metrics.freezeConfirmed, "確認済み"),
    check("firestore_backup", "Firestore export", metrics.firestoreExportComplete, "完了"),
    check("storage_backup", "Storage manifest", metrics.storageManifestComplete, "完了"),
    check("auth_backup", "Auth export", metrics.authExportComplete, "完了"),
    check("source_hash", "元snapshot SHA-256", /^[a-f0-9]{64}$/u.test(metrics.sourceSnapshotSha256), "64桁SHA-256", metrics.sourceSnapshotSha256 ? "設定済み" : "未設定"),
    check("restore", "隔離環境への復元", metrics.restoreComplete, "完了"),
    check("rules", "Security Rules復元", metrics.securityRulesDeployed, "完了"),
    check("indexes", "Firestore index ready", metrics.indexesReady, "READY"),
    check("document_count", "Firestore件数一致", metrics.restoredDocumentCount === metrics.sourceDocumentCount, `${metrics.sourceDocumentCount}件`, metrics.restoredDocumentCount),
    check("storage_count", "Storage件数一致", metrics.restoredStorageObjectCount === metrics.sourceStorageObjectCount, `${metrics.sourceStorageObjectCount}件`, metrics.restoredStorageObjectCount),
    check("auth_count", "Auth件数一致", metrics.restoredAuthUserCount === metrics.sourceAuthUserCount, `${metrics.sourceAuthUserCount}件`, metrics.restoredAuthUserCount),
    check("snapshot_hash", "復元snapshot SHA-256一致", metrics.restoredSnapshotSha256 === metrics.sourceSnapshotSha256 && /^[a-f0-9]{64}$/u.test(metrics.restoredSnapshotSha256), "完全一致", metrics.restoredSnapshotSha256 === metrics.sourceSnapshotSha256 ? "一致" : "不一致"),
    check("sample_diff", "標本データ差異", metrics.sampleMismatchCount === 0, "0件", metrics.sampleMismatchCount),
    check("permission_probe", "権限probe失敗", metrics.permissionProbeFailures === 0, "0件", metrics.permissionProbeFailures),
    check("smoke", "復元後smoke失敗", metrics.smokeFailures === 0, "0件", metrics.smokeFailures),
    check("migration_dry_run", "移行dry-run", metrics.migrationDryRunComplete, "完了"),
    check("migration_count", "dry-run適用予定件数", metrics.dryRunAppliedCount === metrics.plannedMigrationCount, `${metrics.plannedMigrationCount}件`, metrics.dryRunAppliedCount),
    check("migration_diff", "移行差異", metrics.migrationDiffCount === 0, "0件", metrics.migrationDiffCount),
    check("rollback", "切戻し", metrics.rollbackComplete, "完了"),
    check("rto", "切戻しRTO", metrics.rollbackRtoMinutes <= plan.maxRtoMinutes, `${plan.maxRtoMinutes}分以内`, metrics.rollbackRtoMinutes),
    check("rpo", "切戻しデータ損失", metrics.rollbackDataLossMinutes <= plan.maxRpoMinutes, `${plan.maxRpoMinutes}分以内`, metrics.rollbackDataLossMinutes),
    check("rollback_smoke", "切戻し後smoke失敗", metrics.postRollbackSmokeFailures === 0, "0件", metrics.postRollbackSmokeFailures),
    check("evidence", "演習証跡", normalizedEvidenceRefs.length >= 7, "7件以上", normalizedEvidenceRefs.length),
  ];
  const blockers = checks.filter((item) => !item.passed);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    plan,
    metrics: { ...metrics, evidenceRefs: normalizedEvidenceRefs },
    checks,
  })).digest("hex");
  return { eligible: blockers.length === 0, checks, blockers, normalizedEvidenceRefs, fingerprint };
}

function check(key: string, label: string, passed: boolean, required: string, actual: string | number | boolean = passed): ProductionRehearsalCheck {
  return { key, label, passed, actual, required };
}

function validatePlan(input: ProductionRehearsalPlanInput): void {
  if (!input.releaseId.trim() || !input.sourceProjectId.trim() || !input.restoreProjectId.trim() || !input.backupBucket.trim()) {
    throw new Error("production rehearsal plan is incomplete");
  }
  if (input.sourceProjectId === input.restoreProjectId) throw new Error("restore project must be isolated");
  if (!Number.isFinite(input.maxRtoMinutes) || input.maxRtoMinutes <= 0 || !Number.isFinite(input.maxRpoMinutes) || input.maxRpoMinutes < 0) {
    throw new Error("production rehearsal recovery objectives are invalid");
  }
}

function validateMetrics(metrics: ProductionRehearsalMetrics): void {
  const counts = [
    metrics.sourceDocumentCount, metrics.sourceStorageObjectCount, metrics.sourceAuthUserCount,
    metrics.restoredDocumentCount, metrics.restoredStorageObjectCount, metrics.restoredAuthUserCount,
    metrics.sampleMismatchCount, metrics.permissionProbeFailures, metrics.smokeFailures,
    metrics.plannedMigrationCount, metrics.dryRunAppliedCount, metrics.migrationDiffCount,
    metrics.postRollbackSmokeFailures,
  ];
  if (counts.some((value) => !Number.isInteger(value) || value < 0)) throw new Error("production rehearsal counters are invalid");
  if (![metrics.rollbackRtoMinutes, metrics.rollbackDataLossMinutes].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("production rehearsal recovery measurements are invalid");
  }
  if (!Array.isArray(metrics.evidenceRefs) || metrics.evidenceRefs.length > 40) throw new Error("production rehearsal evidence is invalid");
}
