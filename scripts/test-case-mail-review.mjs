import assert from "node:assert/strict";
import { harness, clone, plain, companyId } from "./case-mail-test-harness.mjs";
function setup() {
  const h = harness(), review = h.load("./case-mail-review");
  const scope = { expectedCompanyId: companyId, expectedActorUid: h.auth.uid };
  return Object.assign(h, { scope,
    reviewList: (data = scope, auth = h.auth) => review.listCaseMailReceipts({ data, auth }),
    reviewRead: (data = { ...scope, receiptId: "receipt-1" }, auth = h.auth) => review.getCaseMailReceipt({ data, auth }),
    scopedCreate: () => h.create({ ...h.command, ...scope }),
  });
}
let count = 0;
async function test(name, work) { try { await work(); count++; console.log("成功: " + name); } catch (error) { error.message = name + ": " + error.message; throw error; } }
for (const method of ["reviewList", "reviewRead"]) {
  for (const [name, auth] of [["未認証", null], ["スタッフ", { uid: "staff", token: { companyId, role: "staff" } }],
    ["会社claimなし", { uid: "admin", token: { role: "admin" } }]]) await test(method + "は" + name + "を拒否", async () => {
    const h = setup(); await assert.rejects(h[method](undefined, auth)); assert.equal(h.commits.length, 0);
  });
  for (const change of [{ expectedCompanyId: "other" }, { expectedActorUid: "other" }, { companyId: "other" }]) {
    await test(method + "で会社・実行者の持込み/切替を拒否", async () => {
      const h = setup(); await assert.rejects(h[method]({ ...h.scope, ...(method === "reviewRead" ? { receiptId: "receipt-1" } : {}), ...change }));
      assert.equal(h.commits.length, 0);
    });
  }
}
await test("一覧に別会社・原文・秘密を含めない", async () => {
  const h = setup(), receipt = h.records.get(h.paths.receipt);
  receipt.rawMessage = "SYNTHETIC_PRIVATE_TEXT"; receipt.credential = "SYNTHETIC_SECRET";
  h.records.set("caseMailIntakeReceipts/other", { ...clone(receipt), companyId: "other" });
  const out = await h.reviewList(); assert.equal(out.items.length, 1); assert.equal(out.items[0].receiptId, "receipt-1");
  assert.ok(!JSON.stringify(out).includes("SYNTHETIC_")); assert.equal(out.nextCursor, null);
});
await test("25件ページ送りは重複・欠落なく会社内に限定", async () => {
  const h = setup(), receipt = h.records.get(h.paths.receipt);
  for (let i = 0; i < 26; i++) h.records.set("caseMailIntakeReceipts/page-" + String(i).padStart(2, "0"), clone(receipt));
  const first = await h.reviewList(), second = await h.reviewList({ ...h.scope, cursor: first.nextCursor });
  assert.equal(first.items.length, 25); assert.equal(second.items.length, 2); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.receiptId)).size, 27);
});
await test("別会社の詳細と不存在は同じ応答", async () => {
  const h = setup(); h.records.set("caseMailIntakeReceipts/other", { ...clone(h.records.get(h.paths.receipt)), companyId: "other" });
  const results = [];
  for (const receiptId of ["other", "missing"]) try { await h.reviewRead({ ...h.scope, receiptId }); } catch (error) { results.push([error.code, error.message]); }
  assert.deepEqual(results[0], results[1]); assert.equal(results[0][0], "not-found");
});
await test("詳細は表示用項目と確認版だけを返す", async () => {
  const h = setup(); Object.assign(h.records.get(h.paths.candidate), { sourceValues: { memo: "SYNTHETIC_PRIVATE" }, parserSource: { excerpt: "SYNTHETIC_PRIVATE" } });
  const out = await h.reviewRead(); assert.equal(out.revision, 1); assert.equal(out.candidates[0].revision, 1);
  assert.equal(out.candidates[0].creatable, true); assert.equal(out.candidates[0].input.storeName, "合成店舗");
  assert.ok(!JSON.stringify(out).includes("SYNTHETIC_PRIVATE")); assert.ok(!Object.hasOwn(out.candidates[0].input, "basePay"));
});
for (const [name, mutate] of [
  ["確認待ち", h => h.records.get(h.paths.receipt).status = "review"],
  ["機能無効", h => h.records.get(h.paths.feature).caseMailJobCreationEnabled = false],
  ["実行者停止", h => h.records.get(h.paths.principal).active = false],
  ["実行者版変更", h => h.records.get(h.paths.principal).revision = "changed"],
  ["取消候補", h => h.records.get(h.paths.candidate).status = "cancelled"],
  ["未検証", h => h.records.get(h.paths.receipt).verification = "preview"],
  ["不完全取得", h => h.records.get(h.paths.receipt).structuralComplete = false],
]) await test(name + "は画面から案件化できない", async () => {
  const h = setup(); mutate(h); assert.equal((await h.reviewRead()).candidates[0].creatable, false); await assert.rejects(h.scopedCreate());
});
for (const [name, mutate] of [
  ["候補の会社違い", h => h.records.get(h.paths.candidate).companyId = "other"],
  ["出典差替え", h => h.records.get(h.paths.candidate).source.sha256 = "c".repeat(64)],
  ["候補欠落", h => h.records.delete(h.paths.candidate)],
  ["候補ID二重", h => h.records.get(h.paths.receipt).candidateIds.push("candidate-1")],
]) await test(name + "の詳細を正常表示しない", async () => {
  const h = setup(); mutate(h); await assert.rejects(h.reviewRead());
});
await test("表示した版から既存案件作成し登録済みへ更新", async () => {
  const h = setup(), view = await h.reviewRead();
  const result = await h.create({ ...h.scope, mailIntake: { receiptId: view.receiptId, candidateId: view.candidates[0].candidateId,
    expectedReceiptRevision: view.revision, expectedRevision: view.candidates[0].revision, operationId: "ui-operation" } });
  const linked = await h.reviewRead(); assert.equal(linked.candidates[0].status, "linked"); assert.equal(linked.candidates[0].creatable, false);
  assert.equal(linked.candidates[0].linkedJobId, result.jobIds[0]); assert.equal(h.list("jobs")[0].status, "draft");
});
await test("確認後の版変更を既存案件作成が拒否", async () => {
  const h = setup(); await h.reviewRead(); h.records.get(h.paths.receipt).revision++;
  await assert.rejects(h.scopedCreate()); assert.equal(h.list("jobs").length, 0);
});
await test("案件化中のログイン切替を保存前に拒否", async () => {
  const h = setup();
  for (const data of [{ ...h.command, ...h.scope, expectedActorUid: "other" }, { ...h.command, expectedCompanyId: companyId },
    { ...h.command, ...h.scope, expectedCompanyId: "other" }]) await assert.rejects(h.create(data));
  assert.equal(h.list("jobs").length, 0);
});
await test("応答喪失後も同じ確認版/操作で作成受領結果を回収", async () => {
  const h = setup(); h.loseResponse = true; await assert.rejects(h.scopedCreate());
  assert.equal((await h.reviewRead()).candidates[0].status, "linked");
  const replay = await h.scopedCreate(); assert.equal(replay.replayed, true); assert.equal(h.list("jobs").length, 1);
});
console.log("受信候補確認API: " + count + "条件成功（認証・会社・版、合成DBのみ）");
