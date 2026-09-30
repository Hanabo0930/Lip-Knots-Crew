"use strict";
const generic = require("./generic-request.cjs");
const REVIEW_ISSUE = "本文の複合書式から読み取れた項目です。年・取引先・勤務条件を原文で確認してください。";
const DATE = "(?:20\\d{2}(?:[/.\\-]\\d{1,2}[/.\\-]\\d{1,2}|年\\d{1,2}月\\d{1,2}日)|\\d{1,2}(?:/\\d{1,2}|月\\d{1,2}日))";
const CLOCK = "(?:[01]?\\d|2[0-3]):[0-5]\\d";
const COMBINED = new RegExp("^(?:実施日|勤務日|日付|日時|日程)\\s*:\\s*(" + DATE + ")(?:\\([月火水木金土日](?:曜(?:日)?)?\\))?\\s*(" + CLOCK + ")\\s*入店\\s*(" + CLOCK + ")\\s*[~〜～-]\\s*(" + CLOCK + ")$");
const QUOTE_ISSUE = "引用返信を含みます。今回の依頼範囲を確認してください";
const UNSAFE = /取消|中止|キャンセル|変更|訂正|修正|差替|差し替え|追加|不要|手配済|募集終了|不可能|できません|見送り/;
function quotedReview(message, documents, options, original) {
  if (message.attachments.length || message.from.endsWith("@lipknots.com") ||
      message.issues.some(issue => issue !== QUOTE_ISSUE) || UNSAFE.test(message.subject + "\n" + message.body)) return original;
  const lines = message.body.split(/\r?\n/), quoted = lines.map((line, index) => ({line, index})).filter(item => /^\s*>/.test(item.line));
  if (!quoted.length || quoted.some(item => /^\s*>\s*>/.test(item.line))) return original;
  const first = quoted[0].index, last = quoted.at(-1).index;
  // 一つの引用ブロックだけを扱い、途中や末尾の新しい条件を読み飛ばさない。
  if (lines.slice(first,last+1).some(line => line.trim() && !/^\s*>/.test(line)) || lines.slice(last+1).some(line => line.trim())) return original;
  const current = lines.slice(0,first).join("\n").normalize("NFKC");
  if (!/手配[^\n。]{0,16}(?:可能|お願い)/.test(current) ||
      /(?:実施日|勤務日|日付|日時|日程|入店|入店時間|入店時刻|勤務時間|実施時間|店舗|店舗名|勤務先|メーカー|商品メーカー|メニュー|業務内容|商品・業務内容|企画|商材|人数|必要人数|募集人数|クライアント|取引先|依頼元|請求単価|請求額|備考|注意事項)\s*[:：]|\d{1,4}\s*(?:年|月|[/.：:-])\s*\d{1,2}|\d+\s*(?:名|人|円)/.test(current)) return original;
  const body = quoted.map(item => item.line.replace(/^\s*> ?/, "")).join("\n");
  const result = generic.analyze({...message,body},documents,options);
  if (!result.candidates.some(candidate => Object.keys(candidate.values).some(key => key !== "headcount"))) return original;
  const issue = `引用部分（本文${first+1}〜${last+1}行）からの参考値です。今回の依頼として有効か、元メール全体を確認してください。`;
  return {...result,state:"REVIEW",structuralComplete:false,
    issues:[...new Set([...original.issues,...result.issues,issue])],rule:{id:"quoted-body-review-v1",version:1},
    candidates:result.candidates.map(candidate => ({...candidate,
      source:{...candidate.source,ruleId:"quoted-body-review-v1",ruleVersion:1,quoteDepth:1,quoteStartLine:first+1,quoteEndLine:last+1},
      issues:[...new Set([...candidate.issues,issue])]}))};
}
function analyze(message, documents, options) {
  const original = generic.analyze(message, documents, options);
  if (original.state === "REVIEW" && message.issues.includes(QUOTE_ISSUE)) {
    return quotedReview(message, documents, options, original);
  }
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
