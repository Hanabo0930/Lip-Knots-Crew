export type PilotStage = "preflight" | "staff_3_5" | "staff_30_50" | "full";

export type PilotMetric = {
  key: string;
  label: string;
  value: number;
  threshold: number;
  direction: "max" | "min" | "equal";
  blocking: boolean;
};

export type PilotReadinessResult = {
  ready: boolean;
  stage: PilotStage;
  failures: PilotMetric[];
  warnings: PilotMetric[];
};

export type PilotMonitoringSnapshot = {
  sheetWriteBlocked: number;
  sheetWriteDeadLetters: number;
  rowCreationBlocked: number;
  rowCreationDeadLetters: number;
  manualInterventions: number;
  notificationErrors: number;
  inviteFailures: number;
  retryingQueues: number;
  unactivatedParticipants: number;
  inactiveParticipants: number;
};

export type PilotMonitoringThresholds = Record<keyof PilotMonitoringSnapshot, number>;

export type PilotOperationalAlert = {
  key: keyof PilotMonitoringSnapshot;
  label: string;
  value: number;
  threshold: number;
  severity: "critical" | "warning";
};

export type PilotMonitoringResult = {
  action: "continue" | "watch" | "pause";
  healthy: boolean;
  alerts: PilotOperationalAlert[];
  fingerprint: string;
};

const monitoringDefinitions: Array<{
  key: keyof PilotMonitoringSnapshot;
  label: string;
  severity: "critical" | "warning";
}> = [
  { key: "sheetWriteBlocked", label: "スプシ書込ブロック", severity: "critical" },
  { key: "sheetWriteDeadLetters", label: "スプシ書込dead letter", severity: "critical" },
  { key: "rowCreationBlocked", label: "行追加ブロック", severity: "critical" },
  { key: "rowCreationDeadLetters", label: "行追加dead letter", severity: "critical" },
  { key: "manualInterventions", label: "手動確認キュー", severity: "critical" },
  { key: "notificationErrors", label: "通知配信エラー", severity: "critical" },
  { key: "inviteFailures", label: "パイロット招待失敗", severity: "critical" },
  { key: "retryingQueues", label: "再試行中キュー", severity: "warning" },
  { key: "unactivatedParticipants", label: "未ログイン参加者", severity: "warning" },
  { key: "inactiveParticipants", label: "利用停止参加者", severity: "critical" },
];

export function evaluatePilotReadiness(
  stage: PilotStage,
  metrics: PilotMetric[]
): PilotReadinessResult {
  const failures: PilotMetric[] = [];
  const warnings: PilotMetric[] = [];

  for (const metric of metrics) {
    const pass =
      metric.direction === "max" ? metric.value <= metric.threshold :
      metric.direction === "min" ? metric.value >= metric.threshold :
      metric.value === metric.threshold;

    if (!pass && metric.blocking) failures.push(metric);
    if (!pass && !metric.blocking) warnings.push(metric);
  }

  return {
    ready: failures.length === 0,
    stage,
    failures,
    warnings,
  };
}

export function defaultPilotMetrics(): PilotMetric[] {
  return [
    { key:"write_errors", label:"スプシ書込エラー", value:0, threshold:0, direction:"equal", blocking:true },
    { key:"money_diff", label:"請求・給与差額", value:0, threshold:0, direction:"equal", blocking:true },
    { key:"double_booking", label:"ダブルブッキング", value:0, threshold:0, direction:"equal", blocking:true },
    { key:"mail_diff", label:"メール送信対象差異", value:0, threshold:0, direction:"equal", blocking:true },
    { key:"pdf_diff", label:"PDF差異", value:0, threshold:0, direction:"equal", blocking:true },
    { key:"manual_queue", label:"手動確認キュー", value:0, threshold:0, direction:"equal", blocking:true },
    { key:"completion_rate", label:"スタッフ完了率", value:100, threshold:95, direction:"min", blocking:false },
    { key:"support_cases", label:"サポート問合せ", value:0, threshold:5, direction:"max", blocking:false },
  ];
}

export function defaultPilotMonitoringThresholds(): PilotMonitoringThresholds {
  return {
    sheetWriteBlocked: 0,
    sheetWriteDeadLetters: 0,
    rowCreationBlocked: 0,
    rowCreationDeadLetters: 0,
    manualInterventions: 0,
    notificationErrors: 0,
    inviteFailures: 0,
    retryingQueues: 2,
    unactivatedParticipants: 0,
    inactiveParticipants: 0,
  };
}

export function evaluatePilotMonitoring(
  snapshot: PilotMonitoringSnapshot,
  thresholds: PilotMonitoringThresholds = defaultPilotMonitoringThresholds()
): PilotMonitoringResult {
  const alerts: PilotOperationalAlert[] = [];

  for (const definition of monitoringDefinitions) {
    const value = snapshot[definition.key];
    const threshold = thresholds[definition.key];
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(threshold) || threshold < 0) {
      throw new Error(`pilot monitoring value is invalid: ${definition.key}`);
    }
    if (value > threshold) {
      alerts.push({
        ...definition,
        value,
        threshold,
      });
    }
  }

  const action = alerts.some((alert) => alert.severity === "critical")
    ? "pause"
    : alerts.length ? "watch" : "continue";
  const fingerprint = [
    action,
    ...alerts
      .map((alert) => `${alert.key}:${alert.value}>${alert.threshold}`)
      .sort((left, right) => left.localeCompare(right, "en")),
  ].join("|");

  return {
    action,
    healthy: action === "continue",
    alerts,
    fingerprint,
  };
}
