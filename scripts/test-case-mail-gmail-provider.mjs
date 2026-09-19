import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { harness, clone, companyId } from "./case-mail-test-harness.mjs";
import providerRuntime from "../functions/case-mail-runtime/provider.cjs";

const origin = providerRuntime.EXTRACTOR_ORIGIN, startedAt = "2026-09-18T00:00:00+09:00";
const fields = ["実施日：2026/10/10", "クライアント：合成取引先", "店舗：合成店舗",
  "メーカー：合成メーカー", "メニュー：試食", "入店時間：09:30", "実施時間：10:00～18:00", "人数：1名"].join("\n");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function mail(body = fields) {
  const bytes = Buffer.from(body);
  return { id: "synthetic-mail", threadId: "synthetic-thread", internalDate: String(Date.parse("2026-09-18T01:00:00Z")),
    payload: { partId: "0", mimeType: "text/plain", headers: [
      { name: "From", value: "client@example.invalid" }, { name: "To", value: "info@lipknots.com" },
      { name: "Subject", value: "新規手配依頼" },
    ], body: { size: bytes.length, data: bytes.toString("base64url") } } };
}
function setup({ format, bytes, extraction, inline = false } = {}) {
  const h = harness(), raw = mail(format ? "添付の依頼書をお願いします。" : fields);
  h.records.delete(h.paths.receipt); h.records.delete(h.paths.candidate);
  h.records.get(h.paths.feature).caseMailIntakeEnabled = true;
  const config = { companyId, uid: "synthetic-ingester", producerId: "synthetic-producer", principalRevision: "principal-1",
    mailbox: "info@lipknots.com", startedAt };
  if (format) {
    if (format === "xlsx") raw.payload.headers.find(h => h.name === "From").value = "client@aeondemos.com";
    bytes ??= Buffer.from(format === "pdf" ? "%PDF-synthetic-test" : [80, 75, 3, 4, 1]);
    const body = { ...raw.payload, headers: [] };
    raw.payload = { partId: "root", mimeType: "multipart/mixed", headers: raw.payload.headers, parts: [body,
      { partId: "1", filename: "request." + format,
        mimeType: format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: { size: bytes.length, ...(inline ? { data: bytes.toString("base64url") } : { attachmentId: "synthetic-attachment" }) } }] };
    extraction ??= { version: 1, format, sha256: digest(bytes), bytes: bytes.length, complete: true,
      pageCount: 1, pages: [{ number: 1, text: fields }] };
  }
  const calls = [], tokenContexts = [], extractorContexts = [];
  const server = { raw, profile: "info@lipknots.com", status: 200, extraction, bytes,
    attachmentSize: bytes?.length, attachmentData: bytes?.toString("base64url"), extractorStatus: 200, extractorHeaders: {},
    tokenError: false, extractorError: false, secret: "s".repeat(43), idToken: "header.payload.signature" };
  const fetchImpl = async (url, options) => {
    const target = new URL(url); calls.push({ url: target.href, ...options });
    if (target.origin === "https://gmail.googleapis.com") {
      assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer synthetic-access-token");
      assert.ok(!options.body);
      if (server.status !== 200) return response({ error: "SYNTHETIC_PRIVATE_DETAIL" }, server.status);
      if (target.pathname.endsWith("/profile")) return response({ emailAddress: server.profile });
      if (target.pathname.endsWith("/attachments/synthetic-attachment")) return response({ size: server.attachmentSize, data: server.attachmentData });
      assert.equal(target.searchParams.get("format"), "full");
      return response(clone(server.raw));
    }
    assert.equal(target.origin, origin); assert.ok(["/v1/pdf", "/v1/xlsx"].includes(target.pathname));
    assert.equal(options.method, "POST"); assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer " + server.secret);
    assert.equal(options.headers["X-Serverless-Authorization"], "Bearer " + server.idToken);
    assert.ok(!Object.values(options.headers).some(value => value.includes("synthetic-access-token")));
    assert.equal(digest(options.body), digest(server.bytes));
    if (server.extractorError) throw Error("SYNTHETIC_PRIVATE_DETAIL");
    return response(server.extraction, server.extractorStatus, server.extractorHeaders);
  };
  const dependencies = {
    obtainGmailAccessToken: async context => { tokenContexts.push(context); if (server.tokenError) throw Error("SYNTHETIC_PRIVATE_DETAIL"); return "synthetic-access-token"; },
    obtainExtractorCredentials: async context => { extractorContexts.push(context); return { secret: server.secret, idToken: server.idToken }; },
    fetchImpl,
  };
  const receiver = () => h.load("./case-mail-gmail").createGmailCaseMailReceiver(config, dependencies);
  return Object.assign(h, { server, calls, tokenContexts, extractorContexts, config, dependencies, receiver,
    receive: () => receiver()({ messageId: raw.id }),
    createFrom: (out, index = 0) => h.create({ mailIntake: { receiptId: out.receiptId, candidateId: out.candidateIds[index],
      expectedReceiptRevision: out.revision, expectedRevision: 1, operationId: "provider-operation-" + index } }),
  });
}
let count = 0;
async function test(name, run) { try { await run(); count++; console.log("成功: " + name); } catch (error) { error.message = name + ": " + error.message; throw error; } }
await test("Gmail profile/本文→既存解析→受信保存→Crew案件の一往復", async () => {
  const h = setup(), out = await h.receive(); assert.equal(out.status, "ready"); await h.createFrom(out);
  assert.equal(h.list("jobs").length, 1); assert.equal(h.list("jobs")[0].status, "draft");
  assert.equal(h.calls.length, 2); assert.equal(h.tokenContexts.length, 1); assert.equal(h.extractorContexts.length, 0);
  assert.equal(h.tokenContexts[0].companyId, companyId); assert.equal(h.tokenContexts[0].uid, "synthetic-ingester");
  assert.equal(h.tokenContexts[0].scope, "https://www.googleapis.com/auth/gmail.readonly");
  assert.equal(Object.isFrozen(h.tokenContexts[0]), true);
});
await test("PDF取得→固定抽出先→SHA照合→候補保存", async () => {
  const h = setup({ format: "pdf" }), out = await h.receive(); assert.equal(out.status, "ready"); await h.createFrom(out);
  assert.equal(h.calls.length, 4); assert.equal(h.tokenContexts.length, 1);
  assert.equal(h.extractorContexts[0].audience, origin); assert.equal(h.extractorContexts[0].companyId, companyId);
  assert.equal(h.list("caseMailIntakeCandidates")[0].source.sha256, digest(h.server.bytes));
});
await test("inline添付は再取得せず同じ原本を抽出", async () => {
  const h = setup({ format: "pdf", inline: true }); assert.equal((await h.receive()).status, "ready");
  assert.ok(h.calls.every(call => !call.url.includes("/attachments/")));
});
await test("別の認証受信箱なら本文・添付・抽出へ進まない", async () => {
  const h = setup({ format: "pdf" }); h.server.profile = "other@example.invalid";
  await assert.rejects(h.receive(), /受信箱/); assert.equal(h.calls.length, 1); assert.equal(h.extractorContexts.length, 0);
});
await test("実行者停止・機能無効は資格情報取得前に拒否", async () => {
  for (const mode of ["principal", "feature"]) {
    const h = setup();
    if (mode === "principal") h.records.get(h.paths.principal).active = false;
    else h.records.get(h.paths.feature).caseMailIntakeEnabled = false;
    await assert.rejects(h.receive()); assert.equal(h.tokenContexts.length, 0); assert.equal(h.calls.length, 0);
  }
});
await test("会社・URL・認証の外部持込みを拒否", async () => {
  for (const key of ["companyId", "mailbox", "extractorOrigin", "accessToken", "preview"]) {
    const h = setup(); await assert.rejects(h.receiver()({ messageId: "synthetic-mail", [key]: "forged" }));
    assert.equal(h.calls.length, 0); assert.equal(h.tokenContexts.length, 0);
  }
});
await test("開始前メールは添付も抽出も呼ばない", async () => {
  const h = setup({ format: "pdf" }); h.server.raw.internalDate = String(Date.parse("2026-09-01T00:00:00Z"));
  assert.equal((await h.receive()).status, "skipped"); assert.equal(h.calls.length, 2); assert.equal(h.extractorContexts.length, 0);
});
await test("取得したメールIDが違えば保存しない", async () => {
  const h = setup(); h.dependencies.fetchImpl = async (url, options) => {
    if (String(url).endsWith("/profile")) return response({ emailAddress: "info@lipknots.com" });
    return response({ ...h.server.raw, id: "other" });
  };
  await assert.rejects(h.receive()); assert.equal(h.list("caseMailIntakeReceipts").length, 0);
});
for (const status of [302, 401, 403, 429, 500]) await test("Gmail HTTP " + status + "を成功扱いせず本文を漏らさない", async () => {
  const h = setup(); h.server.status = status;
  await assert.rejects(h.receive(), error => !error.message.includes("SYNTHETIC_PRIVATE_DETAIL"));
  assert.equal(h.list("caseMailIntakeReceipts").length, 0);
});
await test("トークン取得例外を秘匿して停止", async () => {
  const h = setup(); h.server.tokenError = true;
  await assert.rejects(h.receive(), error => !error.message.includes("SYNTHETIC_PRIVATE_DETAIL"));
  assert.equal(h.calls.length, 0);
});
await test("添付サイズ・base64破損を抽出前に拒否", async () => {
  for (const change of [h => h.server.attachmentSize++, h => h.server.attachmentData = "not/base64"]) {
    const h = setup({ format: "pdf" }); change(h); await assert.rejects(h.receive()); assert.equal(h.extractorContexts.length, 0);
  }
});
await test("MIMEと実体の食い違いを抽出前に拒否", async () => {
  const h = setup({ format: "pdf" }); h.server.raw.payload.parts[1].mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  await assert.rejects(h.receive(), /実体/); assert.equal(h.extractorContexts.length, 0);
});
for (const field of ["sha256", "bytes", "format"]) await test("抽出結果の" + field + "不一致で候補を保存しない", async () => {
  const h = setup({ format: "pdf" }); h.server.extraction[field] = field === "bytes" ? 0 : "wrong";
  await assert.rejects(h.receive()); assert.equal(h.list("caseMailIntakeReceipts").length, 0);
});
await test("抽出不完全はメール全体をreviewにする", async () => {
  const h = setup({ format: "pdf" }); h.server.extraction.complete = false;
  const out = await h.receive(); assert.equal(out.status, "review"); assert.equal(out.candidateIds.length, 0);
});
for (const status of [302, 401, 429, 500]) await test("抽出HTTP " + status + "は再送せず停止", async () => {
  const h = setup({ format: "pdf" }); h.server.extractorStatus = status;
  await assert.rejects(h.receive(), error => !error.message.includes("SYNTHETIC_PRIVATE_DETAIL"));
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1); assert.equal(h.list("caseMailIntakeReceipts").length, 0);
});
await test("抽出応答上限・通信エラーを秘匿して停止", async () => {
  for (const change of [h => h.server.extractorHeaders["content-length"] = String(41 * 1024 * 1024), h => h.server.extractorError = true]) {
    const h = setup({ format: "pdf" }); change(h);
    await assert.rejects(h.receive(), error => !error.message.includes("SYNTHETIC_PRIVATE_DETAIL"));
    assert.equal(h.list("caseMailIntakeReceipts").length, 0);
  }
});
await test("抽出用資格情報の不正値を送信しない", async () => {
  for (const change of [h => h.server.secret = "short", h => h.server.idToken = "token\r\nforged"]) {
    const h = setup({ format: "pdf" }); change(h); await assert.rejects(h.receive());
    assert.equal(h.calls.filter(call => call.method === "POST").length, 0);
  }
});
await test("取得後の受信実行者停止は保存時に拒否", async () => {
  const h = setup({ format: "pdf" }), fetch = h.dependencies.fetchImpl;
  h.dependencies.fetchImpl = async (url, options) => { const result = await fetch(url, options);
    if (options.method === "POST") h.records.get(h.paths.principal).active = false; return result; };
  await assert.rejects(h.receive()); assert.equal(h.list("caseMailIntakeReceipts").length, 0);
});
await test("再取得・再抽出でも候補と案件を増やさない", async () => {
  const h = setup({ format: "pdf" }), first = await h.receive(); await h.createFrom(first);
  const second = await h.receive(); assert.equal(second.replayed, true); await h.createFrom(second);
  assert.equal(h.list("jobs").length, 1); assert.equal(h.list("caseMailIntakeCandidates").length, 1);
});
await test("添付合計超過は添付取得・抽出前に止める", async () => {
  const h = setup({ format: "pdf" }), attachment = h.server.raw.payload.parts[1];
  attachment.body.size = 4 * 1024 * 1024;
  h.server.raw.payload.parts.push({ ...clone(attachment), partId: "2", body: { ...attachment.body, attachmentId: "second" } });
  await assert.rejects(h.receive(), /添付合計/);
  assert.equal(h.calls.length, 2); assert.equal(h.extractorContexts.length, 0); assert.equal(h.list("caseMailIntakeReceipts").length, 0);
});
const python = process.env.CASE_MAIL_TEST_PYTHON;
assert.ok(python, "CASE_MAIL_TEST_PYTHONにローカル検証用Pythonを指定してください。");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lkc-mail-provider-test-"));
try {
  const run = spawnSync(python, [fileURLToPath(new URL("./case-mail-extraction/make-test-fixtures.py", import.meta.url)), temp],
    { encoding: "utf8", timeout: 60000, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" } });
  assert.equal(run.status, 0, "合成ファイルの生成/既存Python抽出に失敗: " + run.stderr);
  for (const format of ["pdf", "xlsx"]) await test("実体のある合成" + format.toUpperCase() + "を既存Python抽出→HTTP境界→Crew案件へ接続", async () => {
    const bytes = fs.readFileSync(path.join(temp, "request." + format));
    const extraction = JSON.parse(fs.readFileSync(path.join(temp, format + "-extraction.json"), "utf8"));
    assert.equal(extraction.complete, true); assert.equal(extraction.sha256, digest(bytes));
    const h = setup({ format, bytes, extraction }), out = await h.receive();
    assert.equal(out.status, "ready"); assert.equal(out.candidateIds.length, format === "pdf" ? 2 : 1);
    for (let index = 0; index < out.candidateIds.length; index++) await h.createFrom(out, index);
    assert.equal(h.list("jobs").length, out.candidateIds.length);
  });
} finally {
  for (const file of ["request.pdf", "request.xlsx", "pdf-extraction.json", "xlsx-extraction.json"]) {
    const filename = path.join(temp, file); if (fs.existsSync(filename)) fs.unlinkSync(filename);
  }
  fs.rmdirSync(temp);
}
await test("取り込んだ取得・抽出資産のSHAと既存依存版を固定", async () => {
  const root = new URL("./case-mail-extraction/", import.meta.url), provenance = JSON.parse(fs.readFileSync(new URL("provenance.json", root), "utf8"));
  for (const record of provenance.files) {
    const file = record.name === "read-mail.cjs" ? new URL("../functions/case-mail-runtime/read-mail.cjs", import.meta.url) : new URL(record.name, root);
    assert.equal(digest(fs.readFileSync(file)), record.sha256);
  }
});
console.log("Gmail・添付provider接続: " + count + "条件成功（通信は模擬、合成PDF/XLSXは実抽出、クラウド操作なし）");
