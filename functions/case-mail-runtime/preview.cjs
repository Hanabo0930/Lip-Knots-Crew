'use strict';
const { createHash } = require('node:crypto');
const mail = require('./mail-source.cjs'), generic = require('./generic-request.cjs');
const progress = require('./progress-request.cjs'), core = require('./core.js');
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const hash = value => createHash("sha256").update(value).digest("hex");
const fingerprint = value => hash(core.canonical(value));
const clone = value => JSON.parse(JSON.stringify(value));
const unique = values => [...new Set(values)];
const ensure = (condition, message) => { if (!condition) throw Error(message); };


function createCaseMailPreview(normalizeJobInput, crewInputVersion) {
function checkedDocuments(message, documents) {
  ensure(Array.isArray(documents), "添付抽出結果を配列で指定してください。");
  ensure(documents.length === message.attachments.length, "すべての添付と抽出結果を一対一で確認してください。");
  const seen = new Set();
  return documents.map(document => {
    ensure(document && typeof document.partId === "string" && !seen.has(document.partId), "添付の出典位置が不正または重複しています。");
    seen.add(document.partId);
    const attachment = message.attachments.find(item => item.partId === document.partId);
    ensure(attachment, "メールに存在しない添付の抽出結果です。");
    const encoded = document.contentBase64;
    ensure(typeof encoded === "string" && encoded.length > 0, "元添付のバイト列が未取得です。");
    const bytes = Buffer.from(encoded, "base64");
    ensure(bytes.toString("base64") === encoded, "元添付のbase64が不正です。");
    ensure(bytes.length === attachment.size, "元添付の取得サイズが一致しません。");
    if (attachment.data !== null) {
      ensure(typeof attachment.data === "string" && bytes.toString("base64url") === attachment.data.replace(/=+$/, ""), "メール内添付と取得した実体が一致しません。");
    }
    const extraction = document.extraction;
    const sha256 = hash(bytes);
    ensure(extraction && extraction.sha256 === sha256 && extraction.bytes === bytes.length, "元添付と抽出結果の指紋・サイズが一致しません。");
    ensure(extraction.complete === true, "添付の全文抽出が未完了です。");
    ensure((attachment.mimeType === "application/pdf" && extraction.format === "pdf") ||
      (attachment.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" && extraction.format === "xlsx"),
    "未対応の添付形式です。");
    attachment.sha256 = sha256;
    return { partId: document.partId, sha256, extraction };
  });
}

function mapCandidate(candidate, companyId, message) {
  const values = candidate.values;
  const issues = [...candidate.issues];
  try { core.date(values.day); } catch { issues.push("存在する実施日を確認してください。"); }
  if (values.day < "2026-10-01") issues.push("2026年10月より前の案件は対象外です。");
  const count = values.headcount;
  const countValid = Number.isSafeInteger(count) && count >= 1 && count <= 100;
  if (!countValid) issues.push("人数を1〜100名で確認してください。");
  const normalized = normalizeJobInput({
    workDate: values.day, clientName: values.client, storeName: values.store,
    makerName: values.maker, menuName: values.product, entryTime: values.plannedArrival,
    workTime: values.time ? values.time + (values.timePlanned ? "（予定）" : "") : "",
    slots: 1, basePay: null, publicationMode: "draft", publishAt: null,
  });
  issues.push(...normalized.errors);
  const source = candidate.source;
  // 候補の比較用キー。永続的な案件ID・操作ID・重複防止台帳の代わりにはしない。
  const sourcePosition = [source.part, source.sheet ?? null, source.rowNumber ?? source.index,
    source.page ?? null, source.block ?? null];
  return Array.from({ length: countValid ? count : 1 }, (_, unitIndex) => ({
    provisionalKey: fingerprint([companyId, message.id, sourcePosition, values.day ?? null, unitIndex]),
    candidateFingerprint: fingerprint({ source, values, unitIndex }),
    unitIndex, source: clone(source), sourceValues: clone(values),
    input: clone(normalized.value), issues: unique(issues), state: "REVIEW", creatable: false,
  }));
}

/** full形式の保存メールと抽出済み資料だけを解析する。認証・登録・送信は行わない。 */
function prepareCaseMailIntakePreview(input) {
  ensure(input && typeof input.companyId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(input.companyId), "会社IDを明示してください。");
  const encoded = JSON.stringify(input);
  ensure(Buffer.byteLength(encoded) <= MAX_INPUT_BYTES, "ローカルプレビュー入力は8MiB以内で指定してください。");
  const { companyId, rawMessage, documents = [], startedAt, processedIds = [] } = JSON.parse(encoded);
  const output = {
    version: 1, kind: "case-mail.intake-preview", companyId, state: "REVIEW", issues: [], candidates: [],
    checkMethod: "local-synthetic-or-saved-input", sourceAuthenticationVerified: false,
    extractionIndependentlyVerified: false, duplicateCheckPerformed: false,
    registrationRequired: true, persisted: false, dispatch: "disabled",
    parserVersion: 1, crewInputVersion,
  };
  let message;
  try { message = mail.normalize(rawMessage); }
  catch { output.issues.push("メール全体の形式・本文・ヘッダー・出典を確認してください。"); return output; }
  output.source = { messageId: message.id, fingerprint: message.fingerprint,
    receivedAt: message.receivedAt, bodyPartIds: message.bodyParts.map(part => part.partId), attachments: [] };
  let eligibility;
  try { eligibility = mail.gate(message, { startedAt, processedIds }); }
  catch { output.issues.push("受信開始日時・処理済みIDの形式を確認してください。"); return output; }
  if (eligibility !== "ELIGIBLE") {
    output.state = "SKIPPED"; output.reason = eligibility; return output;
  }
  let extracted;
  try { extracted = checkedDocuments(message, documents); }
  catch (error) { output.issues.push(error.message); return output; }
  output.source.attachments = message.attachments.map(({ partId, size, sha256 }) => ({ partId, size, sha256 }));
  output.source.contentFingerprint = fingerprint({ fingerprint: message.fingerprint, attachments: output.source.attachments });
  const useProgress = message.from.endsWith("@cs-progress.co.jp") && message.attachments.some(item => item.mimeType === "application/pdf");
  let analysis;
  try { analysis = (useProgress ? progress : generic).analyze(message, extracted, { startedAt, processedIds }); }
  catch { output.issues.push("未対応または不完全な本文・添付構造です。原文を確認してください。"); return output; }
  output.rule = analysis.rule;
  output.issues.push(...analysis.issues);
  if (analysis.structuralComplete === false) output.issues.push("本文・添付の読み取りが未完了です。");
  if (analysis.candidates.length > 1000) { output.issues.push("候補がローカルプレビューの上限1000枠を超えています。"); return output; }
  const totalSlots = analysis.candidates.reduce((total, candidate) => {
    const count = candidate.values.headcount;
    return total + (Number.isSafeInteger(count) && count >= 1 && count <= 100 ? count : 1);
  }, 0);
  if (totalSlots > 1000) {
    output.issues.push("人数展開後の候補がローカルプレビューの上限1000枠を超えています。"); return output;
  }
  output.candidates = analysis.candidates.flatMap(candidate => mapCandidate(candidate, companyId, message));
  const keys = output.candidates.map(candidate => candidate.provisionalKey);
  if (new Set(keys).size !== keys.length) output.issues.push("候補の出典位置が重複しています。");
  if (!output.candidates.length) output.issues.push("案件を読み取れていません。");
  const ready = analysis.state === "CANDIDATES_READY" && output.issues.length === 0 &&
    output.candidates.every(candidate => candidate.issues.length === 0);
  output.state = ready ? "PREVIEW_READY" : "REVIEW";
  output.issues = unique(output.issues);
  // 一部だけを登録可能と誤認しないよう、メール全体の確認待ちを全枠に反映する。
  for (const candidate of output.candidates) candidate.state = output.state;
  return output;
}


return prepareCaseMailIntakePreview;
}
module.exports = { createCaseMailPreview, MAX_INPUT_BYTES };