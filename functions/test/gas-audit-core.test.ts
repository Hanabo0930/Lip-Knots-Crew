import { auditGasSources } from "../src/gas-audit-core";
function ok(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}
const report = auditGasSources([{
  filename: "Code.gs",
  source: `
function createInvoice() {
  const sheet = SpreadsheetApp.getActive().getSheetByName("2026.7");
  const value = sheet.getRange(2, 19).getValue();
  sheet.getRange("AA2").setFormula("=SUM(S2:Z2)");
  const pdf = DriveApp.getFileById("x").getAs("application/pdf");
  GmailApp.sendEmail("a@example.com", "請求書", "本文", {attachments:[pdf]});
}
`,
}]);
ok(report.findings.some((item) => item.category === "numeric_column"), "numeric_column missing");
ok(report.findings.some((item) => item.category === "hardcoded_a1"), "hardcoded_a1 missing");
ok(report.findings.some((item) => item.category === "formula_write"), "formula_write missing");
ok(report.findings.some((item) => item.category === "pdf_export"), "pdf_export missing");
ok(report.findings.some((item) => item.category === "mail_send"), "mail_send missing");
ok(report.findings.some((item) => item.category === "lock_missing"), "lock_missing missing");
console.log("gas audit core tests passed");
