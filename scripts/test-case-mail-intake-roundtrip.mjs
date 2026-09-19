import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { harness, clone, plain, companyId } from "./case-mail-test-harness.mjs";
import { analyzeFetchedCaseMail } from "./case-mail-intake-adapter.mjs";

const startedAt = "2026-09-18T00:00:00+09:00";
const fields = ["実施日：2026/10/10", "クライアント：合成取引先", "店舗：合成店舗",
  "メーカー：合成メーカー", "メニュー：試食", "入店時間：09:30", "実施時間：10:00～18:00", "人数：1名"].join("\n");
function fixture(body = fields, messageId = "synthetic-mail") {
  const bytes = Buffer.from(body);
  return { rawMessage: { id: messageId, threadId: "synthetic-thread", internalDate: String(Date.parse("2026-09-18T01:00:00Z")),
    payload: { partId: "0", mimeType: "text/plain", headers: [
      { name: "From", value: "client@example.invalid" }, { name: "To", value: "info@lipknots.com" },
      { name: "Subject", value: "新規手配依頼" },
    ], body: { size: bytes.length, data: bytes.toString("base64url") } } }, documents: [] };
}
function setup(source = fixture()) {
  const h = harness(); h.records.delete(h.paths.receipt); h.records.delete(h.paths.candidate);
  h.records.get(h.paths.feature).caseMailIntakeEnabled = true;
  const config = { companyId, uid: "synthetic-ingester", producerId: "synthetic-producer",
    principalRevision: "principal-1", mailbox: "info@lipknots.com", startedAt };
  let fetches = 0;
  const provider = {
    fetch: async request => { fetches++; assert.equal(request.mailbox, "info@lipknots.com"); return clone(source); },
    parse: analyzeFetchedCaseMail,
  };
  const receiver = () => h.load("./case-mail-intake").createCaseMailReceiver(config, provider);
  Object.assign(h, { config, provider, receiver, source, fetches: () => fetches,
    receive: () => receiver()({ messageId: source.rawMessage.id }),
    createFrom: (result, index = 0, operationId = "synthetic-operation-" + index) => h.create({ mailIntake: {
      receiptId: result.receiptId, candidateId: result.candidateIds[index], expectedReceiptRevision: result.revision,
      expectedRevision: 1, operationId,
    } }),
  });
  return h;
}
const state = h => JSON.stringify([...h.records]);
let count = 0;
async function test(name, run) { try { await run(); count++; console.log("成功: " + name); } catch (error) { error.message = name + ": " + error.message; throw error; } }

await test("既存本文解析→受信候補保存→既存管理案件作成を一往復", async () => {
  const h = setup(), received = await h.receive();
  assert.equal(received.status, "ready"); assert.equal(received.candidateIds.length, 1);
  const candidate = h.list("caseMailIntakeCandidates")[0];
  assert.equal(candidate.source.partId, "body:0"); assert.match(candidate.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(candidate.sourceValues.store, "合成店舗"); assert.equal(candidate.parserSource.part, "body");
  const created = await h.createFrom(received), job = h.list("jobs")[0];
  assert.equal(job.status, "draft"); assert.equal(job.sourceReady, false); assert.equal(job.publishable, false);
  assert.equal(job.basePay, null); assert.equal(job.workDate, "2026-10-10");
  assert.deepEqual(plain(created.jobIds), [job.path.split("/")[1]]);
  assert.equal(h.list("auditLogs").length, 2); assert.equal(h.list("sheetRowCreateQueue").length, 1);
});
await test("受信記録・全候補・監査が同じ保存に含まれる", async () => {
  const h = setup(fixture(fields.replace("人数：1名", "人数：2名") + "\n---\n" + fields));
  const out = await h.receive();
  assert.equal(out.candidateIds.length, 3);
  assert.equal(h.commits.filter(writes => writes.length).length, 1);
  assert.equal(h.commits.at(-1).length, 5);
  for (let i = 0; i < 3; i++) await h.createFrom(out, i);
  assert.equal(h.list("jobs").length, 3); assert.equal(new Set(h.list("jobs").map(job => job.caseId)).size, 3);
});
await test("同一メールの再取得で候補ID・確認版・linkedを保持", async () => {
  const h = setup(), first = await h.receive(); await h.createFrom(first);
  const before = state(h), second = await h.receive();
  assert.equal(second.replayed, true); assert.deepEqual(plain(second.candidateIds), plain(first.candidateIds));
  assert.equal(state(h), before); await h.createFrom(second); assert.equal(h.list("jobs").length, 1);
});
await test("同一受信の同時保存は一つに収束", async () => {
  const h = setup(), result = await Promise.all([h.receive(), h.receive()]);
  assert.deepEqual(plain(result[0].candidateIds), plain(result[1].candidateIds));
  assert.equal(h.list("caseMailIntakeReceipts").length, 1); assert.equal(h.list("caseMailIntakeCandidates").length, 1);
  assert.equal(h.list("auditLogs").length, 1); assert.ok(result.some(item => item.replayed));
});
await test("保存応答の喪失後に受信結果を回収", async () => {
  const h = setup(); h.beforeCommit = ({ writes }) => { if (writes.length) h.loseResponse = true; };
  await assert.rejects(h.receive(), /lost response/); h.beforeCommit = null;
  const before = state(h), result = await h.receive(); assert.equal(result.replayed, true); assert.equal(state(h), before);
});
await test("受信保存失敗は全候補と監査を残さない", async () => {
  const h = setup(), before = state(h);
  h.beforeCommit = ({ writes }) => { if (writes.length) h.failCommit = true; };
  await assert.rejects(h.receive(), /before commit/); assert.equal(state(h), before);
});
for (const [name, mutate] of [
  ["実行者停止", h => h.records.get(h.paths.principal).active = false],
  ["実行者会社違い", h => h.records.get(h.paths.principal).companyId = "other"],
  ["実行者版違い", h => h.records.get(h.paths.principal).revision = "new"],
  ["producer違い", h => h.records.get(h.paths.principal).producerId = "other"],
  ["未有効", h => delete h.records.get(h.paths.feature).caseMailIntakeEnabled],
]) await test(name + "は取得前に拒否", async () => {
  const h = setup(); mutate(h); const before = state(h); await assert.rejects(h.receive());
  assert.equal(h.fetches(), 0); assert.equal(state(h), before);
});
await test("取得中の実行者停止を保存時に再確認", async () => {
  const h = setup(), fetch = h.provider.fetch;
  h.provider.fetch = async request => { const out = await fetch(request); h.records.get(h.paths.principal).active = false; return out; };
  await assert.rejects(h.receive()); assert.equal(h.list("caseMailIntakeReceipts").length, 0);
});
await test("コミット前の受信停止で再読して保存拒否", async () => {
  const h = setup(); h.beforeCommit = ({ writes }) => { if (writes.length) h.records.get(h.paths.feature).caseMailIntakeEnabled = false; };
  await assert.rejects(h.receive()); assert.equal(h.list("caseMailIntakeReceipts").length, 0);
});
await test("クライアントのcompanyId・解析プレビュー持込みを拒否", async () => {
  const h = setup();
  for (const key of ["companyId", "preview", "verification", "candidates", "rawMessage"]) {
    await assert.rejects(h.receiver()({ messageId: "synthetic-mail", [key]: "forged" }));
  }
  assert.equal(h.fetches(), 0); assert.equal(h.list("caseMailIntakeReceipts").length, 0);
});
await test("取得ID不一致を保存前に拒否", async () => {
  const h = setup(); await assert.rejects(h.receiver()({ messageId: "other-message" }));
  assert.equal(h.list("caseMailIntakeReceipts").length, 0);
});
await test("開始前・別受信箱は保存しない", async () => {
  for (const change of [
    source => source.rawMessage.internalDate = String(Date.parse("2026-09-01T00:00:00Z")),
    source => source.rawMessage.payload.headers.find(header => header.name === "To").value = "other@example.invalid",
  ]) {
    const source = fixture(); change(source); const h = setup(source), before = state(h), out = await h.receive();
    assert.equal(out.status, "skipped"); assert.equal(state(h), before);
  }
});
await test("未知の形式・変更依頼は確認待ちで案件作成不可", async () => {
  for (const body of ["内容を確認してください。", "取消をお願いします。\n" + fields, fields.replace("メーカー：合成メーカー\n", "")]) {
    const h = setup(fixture(body)), out = await h.receive(); assert.equal(out.status, "review");
    if (out.candidateIds.length) await assert.rejects(h.createFrom(out));
    assert.equal(h.list("jobs").length, 0);
  }
});
await test("一部不明でもメール全体を確認待ち", async () => {
  const h = setup(fixture(fields + "\n---\n" + fields.replace("実施時間：10:00～18:00\n", ""))), out = await h.receive();
  assert.equal(out.status, "review"); assert.ok(h.list("caseMailIntakeCandidates").every(c => c.status === "review"));
  for (let i = 0; i < out.candidateIds.length; i++) await assert.rejects(h.createFrom(out, i));
});
await test("同じメールの内容変更で旧候補と作成済み案件を上書きしない", async () => {
  const h = setup(), first = await h.receive(); await h.createFrom(first);
  const jobs = JSON.stringify(h.list("jobs")), candidates = JSON.stringify(h.list("caseMailIntakeCandidates"));
  Object.assign(h.source, fixture(fields.replace("2026/10/10", "2026/10/11")));
  const changed = await h.receive(); assert.equal(changed.status, "review"); assert.equal(changed.revision, 2);
  const saved=h.list("jobs")[0], original=JSON.parse(jobs)[0];
  for (const key of ["caseId","workDate","storeName","groupId","mailIntake"]) assert.deepEqual(plain(saved[key]),plain(original[key]));
  assert.equal(saved.publishable,false);assert.equal(saved.recruitmentStopped,true);assert.equal(saved.mailIntakeReviewRequired,true);
  const currentCandidates=h.list("caseMailIntakeCandidates"), originalCandidates=JSON.parse(candidates);
  for(const [index,current] of currentCandidates.entries()){const {heldChange,updatedAt,...immutable}=current;const {updatedAt:oldUpdatedAt,...previous}=originalCandidates[index];assert.deepEqual(plain(immutable),previous);assert.equal(heldChange.revision,2);assert.equal(heldChange.input.workDate,"2026-10-11");}
  await assert.rejects(h.createFrom(changed, 0, "new-operation"));
  const before = state(h), retry = await h.receive(); assert.equal(retry.replayed, true); assert.equal(state(h), before);
});
await test("減枠を再受信しても旧候補を削除せず未作成分も保留", async () => {
  const h = setup(fixture(fields.replace("人数：1名", "人数：2名"))), first = await h.receive();
  Object.assign(h.source, fixture()); const changed = await h.receive();
  assert.equal(changed.status, "review"); assert.equal(h.list("caseMailIntakeCandidates").length, 2);
  await assert.rejects(h.createFrom(first)); assert.equal(h.list("jobs").length, 0);
});
await test("別メールの同日同店は確認待ち", async () => {
  const h = setup(), first = await h.receive();
  h.source.rawMessage.id = "second-mail";
  const second = await h.receive(); assert.equal(second.status, "review");
  assert.ok(h.records.get("caseMailIntakeReceipts/" + second.receiptId).issues.includes("SAME_DAY_STORE_REVIEW"));
  await h.createFrom(first); await assert.rejects(h.createFrom(second, 0, "second-operation"));
  assert.equal(h.list("jobs").length, 1);
});
await test("別メール同時受信でも両方をreadyにしない", async () => {
  const h = setup(), secondSource = fixture(fields, "second-mail");
  const second = h.load("./case-mail-intake").createCaseMailReceiver(h.config, { ...h.provider, fetch: async () => secondSource });
  const results = await Promise.all([h.receive(), second({ messageId: "second-mail" })]);
  assert.deepEqual(results.map(item => item.status).sort(), ["ready", "review"]);
});
await test("同名店舗の表記揺れと既存取消案件も確認待ち", async () => {
  const h = setup(); h.records.set("jobs/old", { companyId, workDate: "2026-10-10", storeName: " 合成 店舗 ", cancelled: true });
  assert.equal((await h.receive()).status, "review"); assert.equal(h.list("jobs").length, 1);
});
await test("別会社または別日の同店は混同しない", async () => {
  const h = setup();
  h.records.set("jobs/other-company", { companyId: "other", workDate: "2026-10-10", storeName: "合成店舗" });
  h.records.set("jobs/other-day", { companyId, workDate: "2026-10-11", storeName: "合成店舗" });
  assert.equal((await h.receive()).status, "ready");
});
await test("受信後に追加された別案件を作成直前に検知", async () => {
  const h = setup(), out = await h.receive();
  h.records.set("jobs/late", { companyId, workDate: "2026-10-10", storeName: "合成店舗" });
  await assert.rejects(h.createFrom(out), /同日/); assert.equal(h.list("jobs").length, 1);
});
await test("照合中に別案件が増えたら再読して確認待ち", async () => {
  const h = setup(); let inserted = false;
  h.beforeCommit = ({ writes }) => { if (writes.length && !inserted) { inserted = true;
    h.records.set("jobs/concurrent", { companyId, workDate: "2026-10-10", storeName: "合成店舗" }); } };
  assert.equal((await h.receive()).status, "review");
});
await test("照合上限を超えた日は重複なしと扱わない", async () => {
  const h = setup();
  for (let i = 0; i < 201; i++) h.records.set("jobs/existing-" + i, { companyId, workDate: "2026-10-10", storeName: "別店" + i });
  assert.equal((await h.receive()).status, "review");
});
await test("一括保存上限超えは候補の部分成功を作らない", async () => {
  const h = setup(fixture([fields, fields, fields].map(body => body.replace("人数：1名", "人数：100名")).join("\n---\n")));
  const out = await h.receive(); assert.equal(out.status, "review"); assert.equal(out.candidateIds.length, 0);
  assert.ok(h.records.get("caseMailIntakeReceipts/" + out.receiptId).issues.includes("ATOMIC_INTAKE_LIMIT"));
});
await test("保存済み受信会社の改変を上書きしない", async () => {
  const h = setup(), out = await h.receive(); h.records.get("caseMailIntakeReceipts/" + out.receiptId).companyId = "other";
  const before = state(h); await assert.rejects(h.receive()); assert.equal(state(h), before);
});
await test("候補IDの既存文書を上書きしない", async () => {
  const h = setup(), analysis = analyzeFetchedCaseMail(h.source, h.config), c = analysis.candidates[0];
  const id = h.key("case-mail-candidate", companyId, "synthetic-mail", c.source.partId, c.source.rowKey, c.source.unitIndex);
  h.records.set("caseMailIntakeCandidates/" + id, { companyId: "other" });
  const before = state(h); await assert.rejects(h.receive()); assert.equal(state(h), before);
});
function pdfFixture() {
  const source = fixture("添付の依頼書をお願いします。"), bytes = Buffer.from("synthetic-pdf-original");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const body = { ...source.rawMessage.payload, headers: [] };
  source.rawMessage.payload = { partId: "root", mimeType: "multipart/mixed", headers: source.rawMessage.payload.headers, parts: [body,
    { partId: "1", filename: "synthetic.pdf", mimeType: "application/pdf", body: { size: bytes.length, attachmentId: "synthetic-attachment" } }] };
  source.documents = [{ partId: "1", contentBase64: bytes.toString("base64"), extraction: { version: 1, format: "pdf",
    sha256, bytes: bytes.length, complete: true, pageCount: 2, pages: [{ number: 1, text: fields }, { number: 2, text: fields }] } }];
  return source;
}
await test("PDFのページ別出典・添付SHAを保持して既存案件へ接続", async () => {
  const h = setup(pdfFixture()), out = await h.receive(); assert.equal(out.status, "ready"); assert.equal(out.candidateIds.length, 2);
  const candidates = h.list("caseMailIntakeCandidates"); assert.equal(new Set(candidates.map(c => c.source.rowKey)).size, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(candidates[i].source.partId, "attachment:1"); assert.equal(candidates[i].source.sha256, h.source.documents[0].extraction.sha256);
    await h.createFrom(out, i);
  }
  assert.equal(h.list("jobs").length, 2);
});
await test("添付実体と抽出結果の不一致は確認待ち", async () => {
  const source = pdfFixture(); source.documents[0].extraction.sha256 = "0".repeat(64);
  const h = setup(source), out = await h.receive(); assert.equal(out.status, "review"); assert.equal(out.candidateIds.length, 0);
  assert.equal(h.list("jobs").length, 0);
});
await test("解析出典のSHA不一致は登録可能にしない", async () => {
  const h = setup(); h.provider.parse = (source, context) => { const out = analyzeFetchedCaseMail(source, context); out.candidates[0].source.sha256 = "0".repeat(64); return out; };
  const out = await h.receive(); assert.equal(out.status, "review"); await assert.rejects(h.createFrom(out));
});
await test("候補出典の二重採番を保存前に拒否", async () => {
  const h = setup(); h.provider.parse = (source, context) => { const out = analyzeFetchedCaseMail(source, context); out.candidates.push(clone(out.candidates[0])); return out; };
  const before = state(h); await assert.rejects(h.receive()); assert.equal(state(h), before);
});
console.log("メール受信一往復: " + count + "条件成功（合成provider・SDK境界、実メール/実DBなし）");
