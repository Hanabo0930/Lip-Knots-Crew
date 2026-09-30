"use strict";
const generic = require("./generic-request.cjs");
const REVIEW_ISSUE = "本文の複合書式から読み取れた項目です。年・取引先・勤務条件を原文で確認してください。";
const DATE = "(?:20\\d{2}(?:[/.\\-]\\d{1,2}[/.\\-]\\d{1,2}|年\\d{1,2}月\\d{1,2}日)|\\d{1,2}(?:/\\d{1,2}|月\\d{1,2}日))";
const CLOCK = "(?:[01]?\\d|2[0-3]):[0-5]\\d";
const COMBINED = new RegExp("^(?:実施日|勤務日|日付|日時|日程)\\s*:\\s*(" + DATE + ")(?:\\([月火水木金土日](?:曜(?:日)?)?\\))?\\s*(" + CLOCK + ")\\s*入店\\s*(" + CLOCK + ")\\s*[~〜～-]\\s*(" + CLOCK + ")$");
function analyze(message, documents, options) {
  const original = generic.analyze(message, documents, options);
  // 受信済み原文は変えず、未対応の新規本文だけを確認用に解釈する。
  if (original.state !== "REVIEW" || message.attachments.length || message.issues.length ||
      message.from.endsWith("@lipknots.com") || /^(?:re|fw|fwd)\s*:/i.test(message.subject.trim()) ||
      /取消|中止|キャンセル|変更|訂正|修正|差替|差し替え|追加/.test(message.subject + "\n" + message.body)) return original;
  let matched = false;
  const lines = message.body.normalize("NFKC").split(/\r?\n/);
  const body = lines.flatMap(line => {
    const match = COMBINED.exec(line.trim());
    if (!match) return [line];
    matched = true;
    return ["実施日：" + match[1], "入店時間：" + match[2], "実施時間：" + match[3] + "～" + match[4]];
  });
  if (!matched) return original;
  const transformed = body.map(line => line.replace(/^\s*(?:企画|商材)\s*:/, "業務内容：")).join("\n");
  const result = generic.analyze({ ...message, body: transformed }, documents, options);
  // 年の推定・人数条件の省略・自動登録は行わない。明記された項目だけを確認画面へ渡す。
  return { ...result, state: "REVIEW", structuralComplete: false,
    issues: [...new Set([...original.issues, ...result.issues, REVIEW_ISSUE])],
    rule: { id: "combined-body-review-v1", version: 1 },
    candidates: result.candidates.map(candidate => ({ ...candidate,
      source: { ...candidate.source, ruleId: "combined-body-review-v1", ruleVersion: 1 },
      issues: [...new Set([...candidate.issues, REVIEW_ISSUE])] })) };
}
module.exports = { analyze, REVIEW_ISSUE };
