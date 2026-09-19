'use strict';
const { createHash } = require('node:crypto');
const mail = require('./mail-source.cjs'), core = require('./core.js');
function createCaseMailAnalyzer(prepareCaseMailIntakePreview) {
const hash = value => createHash("sha256").update(value).digest("hex");
// 保存プレビューを受け取らず、サーバー側取得境界のメール/添付から既存解析を実行する。
// 取得・抽出の実装は内部providerが所有する。
function analyzeFetchedCaseMail(source, context) {
  if (!source || Object.keys(source).some(key => !["rawMessage", "documents"].includes(key))) throw Error("取得形式が不正です。");
  const message = mail.normalize(source.rawMessage);
  const preview = prepareCaseMailIntakePreview({ ...source, ...context });
  const bodyPart = message.bodyParts.length === 1 ? message.bodyParts[0] : null;
  const parts = [
    ...(bodyPart ? [{ partId: "body:" + bodyPart.partId, sha256: hash(Buffer.from(bodyPart.text, "utf8")) }] : []),
    ...preview.source.attachments.map(part => ({ partId: "attachment:" + part.partId, sha256: part.sha256 })),
  ];
  const issues = [...preview.issues];
  if (preview.candidates.length > 200) issues.push("ATOMIC_INTAKE_LIMIT");
  const candidates = preview.candidates.length > 200 ? [] : preview.candidates.map(candidate => {
    const sourcePart = candidate.source;
    const partId = sourcePart.part === "body" && bodyPart ? "body:" + bodyPart.partId : sourcePart.part;
    const part = parts.find(part => part.partId === partId);
    if (!part) throw Error("取得済み出典と解析位置が一致しません。");
    return {
      source: { partId, rowKey: JSON.stringify([sourcePart.sheet ?? null, sourcePart.rowNumber ?? sourcePart.index,
        sourcePart.page ?? null, sourcePart.block ?? null]), unitIndex: candidate.unitIndex, sha256: part.sha256 },
      input: candidate.input, sourceValues: candidate.sourceValues, parserSource: sourcePart,
    };
  });
  return {
    messageId: message.id, receivedAt: message.receivedAt,
    sourceFingerprint: preview.source.contentFingerprint ?? hash(core.canonical({ message,
      documents: source.documents ?? [] })),
    state: preview.state === "SKIPPED" ? "skipped" : preview.state === "PREVIEW_READY" && !issues.length ? "ready" : "review",
    structuralComplete: preview.state === "PREVIEW_READY", issues, parts, candidates,
  };
}

return analyzeFetchedCaseMail;
}
module.exports = { createCaseMailAnalyzer };