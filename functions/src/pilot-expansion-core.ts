import { createHash } from "node:crypto";

export type PilotExpansionAutomated = {
  pilotCompleted: boolean;
  participantCount: number;
  durationDays: number;
  inviteFailures: number;
  healthRunCount: number;
  expectedHealthRuns: number;
  monitoringCoveragePct: number;
  monitorFailureCount: number;
  criticalAlertCount: number;
  watchAlertCount: number;
  lastHealthAction: "continue" | "watch" | "pause" | "missing";
};

export type PilotOutcomeInput = {
  totalCases: number;
  completedCases: number;
  moneyDiffYen: number;
  doubleBookings: number;
  mailTargetDiff: number;
  pdfDiff: number;
  manualQueue: number;
  supportCases: number;
  evidenceRefs: string[];
  notes: string;
};

export type PilotExpansionCheck = {
  key: string;
  label: string;
  passed: boolean;
  blocking: boolean;
  actual: string | number | boolean;
  required: string;
};

export type PilotExpansionGate = {
  eligible: boolean;
  completionRatePct: number;
  checks: PilotExpansionCheck[];
  blockers: PilotExpansionCheck[];
  warnings: PilotExpansionCheck[];
  fingerprint: string;
};

export function evaluatePilotExpansion(
  automated: PilotExpansionAutomated,
  outcome: PilotOutcomeInput
): PilotExpansionGate {
  validateAutomated(automated);
  validateOutcome(outcome);
  const completionRatePct = outcome.totalCases > 0
    ? Math.round(outcome.completedCases / outcome.totalCases * 10_000) / 100
    : 0;
  const checks: PilotExpansionCheck[] = [
    check("pilot_completed", "3〜5名パイロット完了", automated.pilotCompleted, true, "完了済み"),
    check(
      "participant_count",
      "参加者数",
      automated.participantCount >= 3 && automated.participantCount <= 5,
      true,
      "3〜5名",
      automated.participantCount
    ),
    check("duration", "実施期間", automated.durationDays >= 7, true, "7日以上", automated.durationDays),
    check("invite_failures", "配布失敗", automated.inviteFailures === 0, true, "0件", automated.inviteFailures),
    check("health_runs", "監視run", automated.healthRunCount > 0, true, "1件以上", automated.healthRunCount),
    check("monitor_coverage", "5分監視coverage", automated.monitoringCoveragePct >= 90, true, "90%以上", automated.monitoringCoveragePct),
    check("monitor_failures", "監視処理失敗", automated.monitorFailureCount === 0, true, "0件", automated.monitorFailureCount),
    check("critical_alerts", "PAUSE判定", automated.criticalAlertCount === 0, true, "0件", automated.criticalAlertCount),
    check("last_health", "最終監視状態", automated.lastHealthAction === "continue", true, "CONTINUE", automated.lastHealthAction),
    check("case_volume", "検証案件数", outcome.totalCases >= 10, true, "10件以上", outcome.totalCases),
    check("completion_rate", "完了率", completionRatePct >= 95, true, "95%以上", completionRatePct),
    check("money_diff", "請求・給与差額", outcome.moneyDiffYen === 0, true, "0円", outcome.moneyDiffYen),
    check("double_booking", "ダブルブッキング", outcome.doubleBookings === 0, true, "0件", outcome.doubleBookings),
    check("mail_diff", "メール対象差異", outcome.mailTargetDiff === 0, true, "0件", outcome.mailTargetDiff),
    check("pdf_diff", "PDF差異", outcome.pdfDiff === 0, true, "0件", outcome.pdfDiff),
    check("manual_queue", "手動確認キュー", outcome.manualQueue === 0, true, "0件", outcome.manualQueue),
    check("evidence", "証拠参照", outcome.evidenceRefs.length > 0, true, "1件以上", outcome.evidenceRefs.length),
    check("support_cases", "サポート問合せ", outcome.supportCases <= 5, false, "5件以下", outcome.supportCases),
    check("watch_alerts", "WATCH判定", automated.watchAlertCount === 0, false, "0件", automated.watchAlertCount),
  ];
  const blockers = checks.filter((item) => item.blocking && !item.passed);
  const warnings = checks.filter((item) => !item.blocking && !item.passed);
  const canonical = {
    automated,
    outcome: {
      ...outcome,
      evidenceRefs: [...outcome.evidenceRefs].sort((left, right) => left.localeCompare(right, "en")),
    },
    completionRatePct,
    checks: checks.map(({ key, passed, blocking, actual, required }) => ({
      key,
      passed,
      blocking,
      actual,
      required,
    })),
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
  return {
    eligible: blockers.length === 0,
    completionRatePct,
    checks,
    blockers,
    warnings,
    fingerprint,
  };
}

function check(
  key: string,
  label: string,
  passed: boolean,
  blocking: boolean,
  required: string,
  actual: string | number | boolean = passed
): PilotExpansionCheck {
  return { key, label, passed, blocking, actual, required };
}

function validateAutomated(input: PilotExpansionAutomated): void {
  const numeric = [
    input.participantCount,
    input.durationDays,
    input.inviteFailures,
    input.healthRunCount,
    input.expectedHealthRuns,
    input.monitoringCoveragePct,
    input.monitorFailureCount,
    input.criticalAlertCount,
    input.watchAlertCount,
  ];
  if (numeric.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("pilot expansion automated metrics are invalid");
  }
  if (input.monitoringCoveragePct > 100) {
    throw new Error("pilot expansion monitoring coverage is invalid");
  }
}

function validateOutcome(input: PilotOutcomeInput): void {
  const numeric = [
    input.totalCases,
    input.completedCases,
    input.moneyDiffYen,
    input.doubleBookings,
    input.mailTargetDiff,
    input.pdfDiff,
    input.manualQueue,
    input.supportCases,
  ];
  if (numeric.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("pilot outcome metrics are invalid");
  }
  if (input.completedCases > input.totalCases) {
    throw new Error("pilot completed cases exceed total cases");
  }
  if (
    !Array.isArray(input.evidenceRefs) ||
    input.evidenceRefs.length > 20 ||
    input.evidenceRefs.some((value) => !value || value.length > 500 || /[\r\n\0]/u.test(value))
  ) {
    throw new Error("pilot evidence refs are invalid");
  }
  if (typeof input.notes !== "string" || input.notes.length > 2000 || /[\0]/u.test(input.notes)) {
    throw new Error("pilot notes are invalid");
  }
}
