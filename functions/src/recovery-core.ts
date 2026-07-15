export type RecoveryLevel = "L1" | "L2" | "L3";

export type RecoveryInput = {
  appAvailable: boolean;
  firestoreAvailable: boolean;
  sheetsAvailable: boolean;
  writeQueueHealthy: boolean;
  authAvailable: boolean;
  dataMismatchDetected: boolean;
};

export type RecoveryDecision = {
  level: RecoveryLevel;
  freezeWrites: boolean;
  fallbackMode: "normal" | "read_only" | "spreadsheet_manual" | "full_stop";
  actions: string[];
};

export function decideRecovery(input: RecoveryInput): RecoveryDecision {
  if (!input.firestoreAvailable || !input.authAvailable) {
    return {
      level: "L3",
      freezeWrites: true,
      fallbackMode: "spreadsheet_manual",
      actions: [
        "アプリの書込を停止",
        "スタッフへ障害案内",
        "シフト表の手動運用へ切替",
        "監査ログと最終正常時刻を保存",
      ],
    };
  }

  if (!input.sheetsAvailable || !input.writeQueueHealthy || input.dataMismatchDetected) {
    return {
      level: "L2",
      freezeWrites: true,
      fallbackMode: "read_only",
      actions: [
        "スプシ書込を停止",
        "応募・提出の受付はFirestoreへ保持",
        "復旧後に安全キューを再処理",
        "差異比較と案件IDの整合性を確認",
      ],
    };
  }

  if (!input.appAvailable) {
    return {
      level: "L1",
      freezeWrites: false,
      fallbackMode: "spreadsheet_manual",
      actions: [
        "管理者はスプシ運用を継続",
        "スタッフへLINE等の代替連絡",
        "復旧後にアプリへ再同期",
      ],
    };
  }

  return {
    level: "L1",
    freezeWrites: false,
    fallbackMode: "normal",
    actions: ["通常運用を継続"],
  };
}
