export type RegressionArea =
  | "billing"
  | "payroll"
  | "pdf"
  | "email"
  | "sheet"
  | "trigger";

export type RegressionCase = {
  id: string;
  area: RegressionArea;
  title: string;
  blocking: boolean;
  expected: string;
  evidenceRequired: string[];
};

export type RegressionResult = {
  caseId: string;
  status: "not_run" | "passed" | "failed" | "blocked";
  actual: string;
  evidence: string[];
  note: string;
};

export function defaultRegressionCases(): RegressionCase[] {
  return [
    c("billing-total", "billing", "請求合計が旧版と一致", true, "差額0円", ["旧版CSV", "新版CSV"]),
    c("billing-tax", "billing", "課税・税込・非課税区分が一致", true, "差異0件", ["比較表"]),
    c("payroll-total", "payroll", "給与支給額が旧版と一致", true, "差額0円", ["旧版給与", "新版給与"]),
    c("payroll-staff", "payroll", "スタッフ別支払対象が一致", true, "差異0人", ["対象者一覧"]),
    c("invoice-pdf", "pdf", "請求書PDFが一致", true, "ページ・金額・宛名差異0", ["旧PDF", "新PDF"]),
    c("payroll-pdf", "pdf", "給与明細PDFが一致", true, "ページ・金額・氏名差異0", ["旧PDF", "新PDF"]),
    c("mail-recipient", "email", "メール送信対象が一致", true, "差異0件", ["送信対象CSV"]),
    c("mail-duplicate", "email", "二重送信されない", true, "同じキーは1回だけ", ["送信台帳"]),
    c("sheet-formula", "sheet", "数式が維持される", true, "差異0セル", ["数式比較CSV"]),
    c("sheet-validation", "sheet", "入力規則が維持される", true, "差異0セル", ["入力規則比較"]),
    c("sheet-format", "sheet", "条件付き書式・保護範囲が一致", true, "差異0件", ["書式比較"]),
    c("trigger-test", "trigger", "検証環境で本番トリガーが動かない", true, "本番送信0件", ["トリガー一覧"]),
  ];
}

export function summarizeRegression(
  cases: RegressionCase[],
  results: RegressionResult[]
): {
  ready: boolean;
  passed: number;
  failed: number;
  blocked: number;
  notRun: number;
  blockingFailures: string[];
} {
  const byId = new Map(results.map((result) => [result.caseId, result]));
  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let notRun = 0;
  const blockingFailures: string[] = [];

  for (const item of cases) {
    const status = byId.get(item.id)?.status ?? "not_run";
    if (status === "passed") passed++;
    if (status === "failed") failed++;
    if (status === "blocked") blocked++;
    if (status === "not_run") notRun++;
    if (item.blocking && status !== "passed") blockingFailures.push(item.id);
  }

  return {
    ready: blockingFailures.length === 0,
    passed,
    failed,
    blocked,
    notRun,
    blockingFailures,
  };
}

function c(
  id: string,
  area: RegressionArea,
  title: string,
  blocking: boolean,
  expected: string,
  evidenceRequired: string[]
): RegressionCase {
  return { id, area, title, blocking, expected, evidenceRequired };
}
