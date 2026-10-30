import type { DiagnosticReport } from "./diagnostics";

export function formatDiagnosticReport(report: DiagnosticReport): string {
  const checkedAt = new Date(typeof report.checkedAt === "string" && report.checkedAt.trim() ? report.checkedAt : NaN);
  const checkedAtLabel = Number.isFinite(checkedAt.getTime()) ? checkedAt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) + "（日本時間）" : "確認中";
  const summary = report.summary === "pass" ? "PASS" : report.summary === "warn" ? "要確認" : "エラーあり";
  const lines = report.checks.map((check) => {
    const mark = check.level === "pass" ? "OK" : check.level === "warn" ? "確認" : "NG";
    return `[${mark}] ${check.label}: ${check.detail}`;
  });
  return [
    "Lip Knots Crew かんたん診断",
    `総合結果: ${summary}`,
    `確認日時: ${checkedAtLabel}`,
    ...lines,
  ].join("\n");
}
