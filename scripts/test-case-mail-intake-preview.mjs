import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareCaseMailIntakePreview as preview, runPreviewCli } from "./case-mail-intake-preview.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const startedAt = "2026-09-18T00:00:00+09:00";
const fields = ["実施日：2026/10/10", "クライアント：合成取引先", "店舗：合成店舗",
  "メーカー：合成メーカー", "メニュー：試食", "入店時間：09:30", "実施時間：10:00～18:00", "人数：1名"].join("\n");
function fixture(body = fields, from = "client@example.invalid") {
  const bytes = Buffer.from(body);
  return { companyId: "synthetic-company", startedAt, rawMessage: {
    id: "synthetic-mail", threadId: "synthetic-thread", internalDate: String(Date.parse("2026-09-18T01:00:00Z")),
    payload: { partId: "0", mimeType: "text/plain", headers: [
      { name: "From", value: from }, { name: "To", value: "info@lipknots.com" }, { name: "Subject", value: "新規手配依頼" },
    ], body: { size: bytes.length, data: bytes.toString("base64url") } },
  }, documents: [] };
}
function attach(input, extraction, partId = "1") {
  const bytes = Buffer.from("synthetic-original-" + partId);
  extraction = { version: 1, complete: true, ...clone(extraction), bytes: bytes.length, sha256: sha(bytes) };
  const message = input.rawMessage;
  if (!message.payload.parts) {
    const body = { ...message.payload, headers: [] };
    message.payload = { partId: "root", mimeType: "multipart/mixed", headers: message.payload.headers, parts: [body] };
  }
  message.payload.parts.push({ partId, filename: "synthetic." + extraction.format,
    mimeType: extraction.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: { size: bytes.length, attachmentId: "synthetic-" + partId } });
  input.documents.push({ partId, contentBase64: bytes.toString("base64"), extraction });
  return input;
}
function progressFixture() {
  const w = (text, x, top) => ({ text, x0: x, x1: x + 30, top, bottom: top + 8 });
  return attach(fixture("", "client@cs-progress.co.jp"), { format: "pdf", pageCount: 2,
    pages: [1, 2].map(number => ({ number, width: 840, height: 595,
      text: "スケジュール連絡表 プログレスホールディングス", words: [
        w("[開始]26/10/10(土)", 10, 60), w("[終了]26/10/10(土)", 10, 75), w("[10日]09:30～18:00", 10, 100),
        w("[ストア店名]合成店舗" + number, 100, 60), w("[メーカー]合成メーカー", 380, 60),
        w("[メニュー]試食", 380, 100), w("[器材]器具", 610, 60),
      ] })),
  });
}
// 旧資産の既知45列書式を合成データだけで再現する。
const aeonHeaders = ["ライン番号", "案件番号", "発注番号", "発注日", "発注額", "エリア", "都道府県", "店舗番号", "店舗名", "展開外",
  "デモ日", "メーカー名", "商品名", "デモ実施場所", "勤務開始時間", "勤務終了時間", "調理有無", "電気備品", "試食有無", "写真必須",
  "必須研修", "性別", "セールス備考", "●協力会社名", "実働時間", "基本料金", "交通費", "遠隔地", "繁忙日加算", "検便検査費",
  "通信費", "書類発送費", "他請求科目1", "他請求費用1", "他請求科目2", "他請求費用2", "他請求科目3", "他請求費用3",
  "●手配可否", "常時使用する従業員100人以下(個人を含む)", "自社スタッフor協力会社", "案件受領確認者名", "受領確認日", "依頼変更", "備考"];
function aeonFixture() {
  const row = aeonHeaders.map(header => ({
    "ライン番号": "1", "案件番号": "synthetic-order", "店舗名": "合成店舗", "デモ日": "2026/10/10",
    "メーカー名": "合成メーカー", "商品名": "試食", "勤務開始時間": "10:00", "勤務終了時間": "18:00",
  })[header] ?? "");
  return attach(fixture("添付の発注書をお願いします。", "client@aeondemos.com"),
    { format: "xlsx", sheets: [{ name: "依頼表", rows: [aeonHeaders, row] }] });
}
let count = 0;
function test(name, run) { run(); count++; console.log("成功: " + name); }
function review(input) {
  const result = preview(input);
  assert.equal(result.state, "REVIEW");
  assert.ok(result.issues.length || result.candidates.some(candidate => candidate.issues.length));
  assert.ok(result.candidates.every(candidate => candidate.state === "REVIEW" && candidate.creatable === false));
  return result;
}
test("本文を既存Crew入力へ変換し、未登録・下書き・送信無効を維持", () => {
  const input = fixture(fields + "\n請求単価：18,000円\n備考：PRIVATE_MEMO_SYNTHETIC"), before = clone(input);
  const out = preview(input), job = out.candidates[0].input;
  assert.equal(out.state, "PREVIEW_READY");
  assert.equal(out.dispatch, "disabled"); assert.equal(out.persisted, false);
  assert.equal(out.sourceAuthenticationVerified, false); assert.equal(out.extractionIndependentlyVerified, false);
  assert.equal(out.duplicateCheckPerformed, false); assert.equal(out.registrationRequired, true);
  assert.equal(out.candidates[0].creatable, false);
  assert.deepEqual(job, { workDate: "2026-10-10", clientName: "合成取引先", storeName: "合成店舗",
    storeAddress: "", storeNearestStation: "", makerName: "合成メーカー", menuName: "試食", entryTime: "09:30",
    workTime: "10:00~18:00", subcontractorName: "", slots: 1, basePay: null, publicationMode: "draft", publishAt: null });
  assert.ok(!JSON.stringify(job).includes("PRIVATE_MEMO"));
  assert.equal(out.candidates[0].sourceValues.bill, 18000); assert.equal(out.candidates[0].sourceValues.memo, "PRIVATE_MEMO_SYNTHETIC");
  assert.deepEqual(input, before);
});
test("NFKCと欠員数既定1を既存規則で引き継ぐ", () => {
  const out = preview(fixture(fields.replace("合成店舗", "　店舗Ａ　").replace("\n人数：1名", "")));
  assert.equal(out.state, "PREVIEW_READY"); assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].input.storeName, "店舗A");
});
test("2名を1名枠へ分け、同内容の別行も統合しない", () => {
  const out = preview(fixture(fields.replace("人数：1名", "人数：2名") + "\n---\n" + fields));
  assert.equal(out.state, "PREVIEW_READY"); assert.equal(out.candidates.length, 3);
  assert.equal(new Set(out.candidates.map(x => x.provisionalKey)).size, 3);
  assert.deepEqual(out.candidates.map(x => x.unitIndex), [0, 1, 0]);
  assert.ok(out.candidates.every(x => x.input.slots === 1));
});
test("再解析は同一結果、内容変更は指紋で区別し別メール/会社は別候補", () => {
  const input = fixture(), first = preview(input), repeat = preview(input);
  assert.deepEqual(first, repeat);
  const edited = preview(fixture(fields.replace("合成メーカー", "別メーカー")));
  assert.equal(first.candidates[0].provisionalKey, edited.candidates[0].provisionalKey);
  assert.notEqual(first.candidates[0].candidateFingerprint, edited.candidates[0].candidateFingerprint);
  input.rawMessage.id = "another-mail"; assert.notEqual(preview(input).candidates[0].provisionalKey, first.candidates[0].provisionalKey);
  input.rawMessage.id = "synthetic-mail"; input.companyId = "another-company";
  assert.notEqual(preview(input).candidates[0].provisionalKey, first.candidates[0].provisionalKey);
});
for (const [name, text] of [
  ["未確定メーカー", fields.replace("合成メーカー", "未定")],
  ["メーカー欠落", fields.replace("メーカー：合成メーカー\n", "")],
  ["実在しない日付", fields.replace("2026/10/10", "2026/02/30")],
  ["対象月より前", fields.replace("2026/10/10", "2026/09/30")],
  ["人数0", fields.replace("人数：1名", "人数：0")],
  ["人数上限超過", fields.replace("人数：1名", "人数：101")],
  ["人数不明", fields.replace("人数：1名", "人数：調整")],
  ["勤務時間欠落", fields.replace("実施時間：10:00～18:00\n", "")],
  ["未知項目", fields + "\nスタッフ給与：99999"],
  ["未知の本文", "画像だけで依頼します"],
  ["社内公開指示", fields + "\n公開方法：immediate"],
]) test(name + "をREVIEWに保持", () => review(fixture(text)));
for (const subject of ["変更依頼", "取消依頼", "差し替え依頼"]) test(subject + "を新規登録可能にしない", () => {
  const input = fixture(); input.rawMessage.payload.headers[2].value = subject; review(input);
});
test("一つの不完全行があればメール全体を確認待ちにする", () => {
  const out = review(fixture(fields + "\n---\n" + fields.replace("合成メーカー", "未定")));
  assert.equal(out.candidates.length, 2);
});
for (const [name, mutate, reason] of [
  ["開始前", x => x.startedAt = "2026-09-19T00:00:00Z", "BEFORE_START"],
  ["処理済み", x => x.processedIds = ["synthetic-mail"], "ALREADY_PROCESSED"],
  ["別受信箱", x => x.rawMessage.payload.headers[1].value = "other@example.invalid", "NOT_CLIENT_INBOX"],
]) test(name + "は候補を作らない", () => {
  const input = fixture(); mutate(input); const out = preview(input);
  assert.equal(out.state, "SKIPPED"); assert.equal(out.reason, reason); assert.equal(out.candidates.length, 0);
});
for (const [name, mutate] of [
  ["不正受信日時", x => x.rawMessage.internalDate = "invalid"],
  ["二重From", x => x.rawMessage.payload.headers.push({ name: "From", value: "other@example.invalid" })],
  ["本文バイト欠落", x => x.rawMessage.payload.body.size++],
  ["不正開始日時", x => x.startedAt = "invalid"],
]) test(name + "は確認待ち", () => { const input = fixture(); mutate(input); review(input); });
test("プログレス既知PDFの全ページと9:30入店/10時開始を接続", () => {
  const out = preview(progressFixture());
  assert.equal(out.state, "PREVIEW_READY"); assert.equal(out.candidates.length, 2);
  assert.deepEqual(out.candidates.map(x => x.source.page), [1, 2]);
  assert.ok(out.candidates.every(x => x.input.entryTime === "09:30" && x.input.workTime === "10:00~18:00"));
});
test("汎用PDFのページ別出典を維持", () => {
  const input = attach(fixture("添付の依頼書をお願いします。"), { format: "pdf", pageCount: 2,
    pages: [{ number: 1, text: fields }, { number: 2, text: fields }] });
  const out = preview(input);
  assert.equal(out.state, "PREVIEW_READY"); assert.equal(out.candidates.length, 2);
  assert.equal(new Set(out.candidates.map(x => x.provisionalKey)).size, 2);
});
for (const [name, mutate] of [
  ["添付不足", x => x.documents = []],
  ["余分な抽出結果", x => x.documents.push(clone(x.documents[0]))],
  ["別partId", x => x.documents[0].partId = "other"],
  ["SHA不一致", x => x.documents[0].extraction.sha256 = "0".repeat(64)],
  ["サイズ不一致", x => x.documents[0].extraction.bytes++],
  ["取得実体の差替え", x => x.documents[0].contentBase64 = Buffer.from("changed").toString("base64")],
  ["base64不正", x => x.documents[0].contentBase64 += "!"],
  ["全文未完", x => x.documents[0].extraction.complete = false],
  ["ページ欠落", x => x.documents[0].extraction.pages.pop()],
  ["PDF列崩れ", x => x.documents[0].extraction.pages[0].words.pop()],
  ["不明形式", x => x.rawMessage.payload.parts[1].mimeType = "application/zip"],
  ["埋込実体相違", x => x.rawMessage.payload.parts[1].body.data = Buffer.from("wrong").toString("base64url")],
]) test(name + "を部分成功にしない", () => { const input = progressFixture(); mutate(input); review(input); });
test("イオン既知45列XLSXからCrew下書き入力へ接続", () => {
  assert.equal(aeonHeaders.length, 45);
  const out = preview(aeonFixture());
  assert.equal(out.state, "PREVIEW_READY");
  assert.equal(out.candidates[0].input.clientName, "イオンデモ");
  assert.equal(out.candidates[0].source.rowNumber, 2);
  assert.equal(out.candidates[0].source.ruleId, "aeon-order-xlsx-v1");
});
for (const [name, mutate] of [
  ["依頼変更", sheet => sheet.rows[1][aeonHeaders.indexOf("依頼変更")] = "日付変更"],
  ["未知シート", sheet => sheet.name = "未知書式"],
  ["列重複", sheet => sheet.rows[0][1] = "ライン番号"],
  ["未確定商品", sheet => sheet.rows[1][aeonHeaders.indexOf("商品名")] = "未定"],
]) test("XLSX " + name + "は確認待ち", () => {
  const input = aeonFixture(); mutate(input.documents[0].extraction.sheets[0]); review(input);
});
test("返信済みXLSX行を新規案件候補として扱わない", () => {
  const input = aeonFixture(); input.documents[0].extraction.sheets[0].rows[1][aeonHeaders.indexOf("●手配可否")] = "可";
  assert.equal(review(input).candidates.length, 0);
});
test("不明な抽出構造は例外を漏らさずREVIEWへ", () => {
  const input = aeonFixture(); input.documents[0].extraction.sheets = null; review(input);
});
test("人数展開前に1000枠上限を適用する", () => {
  const input = fixture(Array(11).fill(fields.replace("人数：1名", "人数：100名")).join("\n---\n"));
  const out = review(input);
  assert.equal(out.candidates.length, 0);
  assert.match(out.issues.join(), /1000枠/);
});
test("会社入力不正と過大入力は拒否", () => {
  for (const companyId of [null, 123, "", "../other"]) assert.throws(() => preview({ ...fixture(), companyId }));
  const input = fixture("x".repeat(8 * 1024 * 1024)); assert.throws(() => preview(input), /8MiB/);
});
test("移植7ファイルは固定版と一致し通信・書込依存を含まない", () => {
  const root = new URL("../functions/case-mail-runtime/", import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL("provenance.json", root)));
  assert.equal(manifest.files.length, 7);
  const entries = manifest.files.map(item => {
    const bytes = fs.readFileSync(new URL(item.name, root)); assert.equal(sha(bytes), item.sha256);
    for (const match of bytes.toString("utf8").matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      assert.ok(match[1] === "node:crypto" || manifest.files.some(file => "./" + file.name === match[1]));
    }
    return item.name + ":" + item.sha256;
  });
  assert.equal(sha(entries.join("\n")), manifest.closureSha256);
});
test("CLIは新規ローカル成果物だけを作り、上書きと本文ログ出力を防ぐ", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lkc-mail-preview-"));
  try {
    const inputPath = path.join(dir, "input.json"), outputPath = path.join(dir, "preview.json");
    const { rawMessage, documents } = fixture(fields + "\n備考：PRIVATE_MEMO_SYNTHETIC");
    fs.writeFileSync(inputPath, JSON.stringify({ rawMessage, documents }));
    const before = fs.readFileSync(inputPath);
    const args = ["--input", inputPath, "--out", outputPath, "--company-id", "synthetic-company", "--started-at", startedAt];
    const cli = fileURLToPath(new URL("./case-mail-intake-preview.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { state: "PREVIEW_READY", candidates: 1, persisted: false, dispatch: "disabled" });
    assert.ok(!result.stdout.includes("PRIVATE_MEMO")); assert.ok(!result.stdout.includes("example.invalid"));
    const saved = fs.readFileSync(outputPath);
    assert.throws(() => runPreviewCli(args), /EEXIST/); assert.deepEqual(fs.readFileSync(outputPath), saved);
    assert.deepEqual(fs.readFileSync(inputPath), before);
    assert.throws(() => runPreviewCli([...args, "--send", "true"]));
    assert.throws(() => runPreviewCli([...args, "--company-id", "another"]));
    const sameFileArgs = [...args]; sameFileArgs[3] = inputPath;
    assert.throws(() => runPreviewCli(sameFileArgs), /EEXIST/);
    assert.deepEqual(fs.readFileSync(inputPath), before);
  } finally { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); }
});
console.log("合成検査完了: " + count + "条件（実メール・DB・Sheets未使用）");
