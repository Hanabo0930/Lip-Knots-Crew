"use strict";
const MIME = Object.freeze({ pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
const REVIEW_ISSUE = "添付の申告形式と実体が異なるため確認してください。";
function detectedFormat(bytes) {
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  return bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4 ? "xlsx" : null;
}
function resolveAttachmentFormat(descriptor, detected) {
  const mime = detected === "pdf" || detected === "xlsx" ? MIME[detected] : null;
  if (!mime) throw Error("添付の実体をPDFまたはExcelとして確認できません。");
  if (descriptor.mimeType === mime) return { format: detected, mime, reviewRequired: false };
  const extension = typeof descriptor.filename === "string" ? /\.([^.\/\\]+)$/.exec(descriptor.filename)?.[1].toLowerCase() : null;
  // メール側の申告だけが異なる場合。抽出先での形式・全文・SHA照合も必須にし、自動登録しない。
  if (extension !== detected || !["application/octet-stream", ...Object.values(MIME)].includes(descriptor.mimeType)) {
    throw Error("添付の実体・拡張子・申告形式を照合できません。");
  }
  return { format: detected, mime, reviewRequired: true };
}
module.exports = { detectedFormat, resolveAttachmentFormat, REVIEW_ISSUE };
