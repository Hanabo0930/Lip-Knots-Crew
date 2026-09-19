import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lkc-mail-package-"));
const root = path.join(temporary, "functions"), runtime = path.join(root, "case-mail-runtime"), lib = path.join(root, "lib");
fs.mkdirSync(runtime, { recursive: true }); fs.mkdirSync(lib);
const copied = [];
try {
  const sourceRuntime = fileURLToPath(new URL("../functions/case-mail-runtime/", import.meta.url));
  for (const name of fs.readdirSync(sourceRuntime)) {
    const destination = path.join(runtime, name); fs.copyFileSync(path.join(sourceRuntime, name), destination); copied.push(destination);
  }
  for (const name of ["case-mail-gmail.js", "job-management-core.js", "case-id.js"]) {
    const destination = path.join(lib, name); fs.copyFileSync(new URL("../functions/lib/" + name, import.meta.url), destination); copied.push(destination);
  }
  const compiled = path.join(lib, "case-mail-gmail.js"), localRequire = createRequire(compiled), exports = {};
  let savedConfig;
  runInNewContext(fs.readFileSync(compiled, "utf8"), {
    exports,
    require: name => name === "./case-mail-intake" ? {
      createCaseMailReceiver: (config, provider) => { savedConfig = config; return async request =>
        provider.parse(await provider.fetch({ ...request, mailbox: config.mailbox }), { companyId: config.companyId, startedAt: config.startedAt }); },
    } : localRequire(name),
  });
  const config = { companyId: "synthetic-company", uid: "synthetic-ingester", producerId: "synthetic-producer",
    principalRevision: "principal-1", mailbox: "info@lipknots.com", startedAt: "2026-09-18T00:00:00+09:00" };
  const text = ["実施日：2026/10/10", "クライアント：合成取引先", "店舗：合成店舗", "メーカー：合成メーカー",
    "メニュー：試食", "入店時間：09:30", "実施時間：10:00～18:00", "人数：1名"].join("\n"), bytes = Buffer.from(text);
  const rawMessage = { id: "synthetic-mail", threadId: "synthetic-thread", internalDate: String(Date.parse("2026-09-18T01:00:00Z")),
    payload: { partId: "0", mimeType: "text/plain", headers: [
      { name: "From", value: "client@example.invalid" }, { name: "To", value: "info@lipknots.com" }, { name: "Subject", value: "新規依頼" },
    ], body: { size: bytes.length, data: bytes.toString("base64url") } } };
  const receive = exports.createGmailCaseMailReceiver(config, {
    obtainGmailAccessToken: async () => "synthetic-token",
    obtainExtractorCredentials: async () => { throw Error("本文だけの試験で抽出は呼ばない"); },
    fetchImpl: async url => new Response(JSON.stringify(String(url).endsWith("/profile") ? { emailAddress: config.mailbox } : rawMessage)),
  });
  const out = await receive({ messageId: "synthetic-mail" });
  assert.equal(savedConfig.companyId, config.companyId); assert.equal(out.state, "ready"); assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].input.publicationMode, "draft");
  assert.equal(fs.existsSync(path.join(temporary, "scripts")), false);
  console.log("Functions配布範囲の隔離検査: 成功（コンパイル済み入口＋共用解析、通信・保存は模擬）");
} finally {
  for (const file of copied) fs.unlinkSync(file);
  fs.rmdirSync(runtime); fs.rmdirSync(lib); fs.rmdirSync(root); fs.rmdirSync(temporary);
}
