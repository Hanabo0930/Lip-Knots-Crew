import {
  compareAuditFindings,
  remediationProgress,
  markdownAuditReport,
} from "../src/gas-remediation-core";
function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(message);
}
const before = {
  blockers: 2, score: 60,
  findings: [
    { id:"a", risk:"high", title:"A" },
    { id:"b", risk:"critical", title:"B" },
  ],
};
const after = {
  blockers: 1, score: 80,
  findings: [
    { id:"b", risk:"critical", title:"B" },
    { id:"c", risk:"medium", title:"C" },
  ],
};
const delta = compareAuditFindings(before, after);
equal(delta.resolved[0], "a", "解消項目が違います。");
equal(delta.newlyDetected[0], "c", "新規項目が違います。");
equal(delta.blockerDelta, -1, "blocker差分が違います。");
const progress = remediationProgress(before.findings, [
  { findingId:"a", status:"fixed", owner:"", note:"" },
]);
equal(progress.resolved, 1, "進捗集計が違います。");
equal(progress.blockersOpen, 1, "未解決blockerが違います。");
const markdown = markdownAuditReport({
  title:"テスト", grade:"B", score:80, blockers:1,
  findings:[{
    filename:"Code.gs", line:10, risk:"high", title:"固定列",
    evidence:'getRange("AA2")', recommendation:"修正", affectedColumns:["AA"],
  }],
});
equal(markdown.includes("Code.gs"), true, "Markdownにファイル名がありません。");
console.log("gas remediation core tests passed");
