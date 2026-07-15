import { scanSourcesForSecrets, redactSource } from "../src/gas-secret-scan-core";
function ok(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}
const files = [{
  filename: "Code.gs",
  source: `
const apiKey = "AIza123456789012345678901234567890";
const email = "staff@example.com";
`,
}];
const report = scanSourcesForSecrets(files);
ok(report.safeToUpload === false, "APIキーで停止しません。");
ok(report.findings.some((item) => item.category === "api_key"), "APIキー未検出");
ok(report.findings.some((item) => item.category === "email"), "メール未検出");
const source = files[0]?.source ?? "";
const redacted = redactSource(source, report.findings, "Code.gs");
ok(redacted.includes("[REDACTED]"), "伏字化されません。");
console.log("gas secret scan core tests passed");
