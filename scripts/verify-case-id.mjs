import { createHash } from "node:crypto";

function hashText(value, length = 24) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}
function canonical(value) {
  return value.normalize("NFKC").replace(/[\s　]+/g, "").trim().toLowerCase();
}
function make(input) {
  const fingerprint = [
    canonical(input.dateKey), canonical(input.clientName),
    canonical(input.storeName), canonical(input.workTime)
  ].join("|");
  const key = [
    canonical(input.companyId), input.spreadsheetId, canonical(input.sheetName),
    fingerprint, String(input.occurrence)
  ].join("|");
  const hash = hashText(key);
  return `LKC-${input.dateKey.replaceAll("-", "")}-${hash.slice(0,10).toUpperCase()}`;
}
const a = make({companyId:"lipknots",spreadsheetId:"sheet",sheetName:"2026.7",dateKey:"2026-07-20",clientName:"A社",storeName:"イオン船橋",workTime:"10:00～18:00",occurrence:1});
const b = make({companyId:"lipknots",spreadsheetId:"sheet",sheetName:"2026.7",dateKey:"2026-07-20",clientName:"A社",storeName:"イオン船橋",workTime:"10:00～18:00",occurrence:1});
if (a !== b) throw new Error("案件IDが安定していません");
console.log("case-id deterministic check passed:", a);
