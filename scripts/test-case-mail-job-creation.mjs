import assert from "node:assert/strict";
import { harness, clone, plain, companyId, Timestamp } from "./case-mail-test-harness.mjs";
let count = 0;
async function test(name, run) { try { await run(); count++; console.log("成功: " + name); } catch (error) { error.message = name + ": " + error.message; throw error; } }
const state = h => JSON.stringify([...h.records]);
await test("案件・受信元・操作・候補・監査・既存キューを原子保存", async () => {
  const h = harness(), out = await h.create(), job = h.records.get("jobs/" + out.jobIds[0]);
  assert.equal(h.commits.length, 1); assert.equal(h.commits[0].length, 7);
  for (const name of ["jobs", "jobGroups", "sheetRowCreateQueue", "caseMailJobSources", "caseMailJobCreates", "auditLogs"]) assert.equal(h.list(name).length, 1);
  assert.equal(job.status, "draft"); assert.equal(job.publishable, false); assert.equal(job.basePay, null);
  assert.equal(job.requestedPublicationMode, "draft"); assert.equal(out.replayed, false);
  assert.equal(h.records.get(h.paths.candidate).status, "linked"); assert.equal(h.records.get(h.paths.candidate).revision, 2);
  assert.equal(job.caseId, "LKC-ADMIN-20261010-00000001");
  assert.equal(out.jobIds[0], h.load("./case-id").createJobIdFromPersistedCaseId(companyId, job.caseId));
});
await test("同一操作の再送で案件・監査・行作成キューを増やさない", async () => {
  const h = harness(), first = await h.create(), before = state(h), out = await h.create();
  assert.equal(out.replayed, true); assert.deepEqual(plain(out.jobIds), plain(first.jobIds)); assert.equal(state(h), before);
});
await test("別操作IDでも同じ受信元を再作成しない", async () => {
  const h = harness(), first = await h.create(), command = clone(h.command); command.mailIntake.operationId = "retry-operation";
  const before = state(h), out = await h.create(command);
  assert.equal(out.replayed, true); assert.deepEqual(plain(out.jobIds), plain(first.jobIds)); assert.equal(state(h), before);
});
await test("同時実行を再読して1案件に収束", async () => {
  const h = harness(), command = clone(h.command); command.mailIntake.operationId = "parallel-operation";
  const results = await Promise.all([h.create(), h.create(command)]);
  assert.deepEqual(plain(results[0].jobIds), plain(results[1].jobIds));
  assert.equal(h.list("jobs").length, 1); assert.equal(h.list("auditLogs").length, 1); assert.ok(h.attempts >= 3);
});
await test("コミット応答喪失後の同一操作で結果を回収", async () => {
  const h = harness(); h.loseResponse = true; await assert.rejects(h.create(), /lost response/);
  const before = state(h), out = await h.create(); assert.equal(out.replayed, true); assert.equal(state(h), before);
});
await test("コミット失敗なら案件・対応・監査・キューが残らない", async () => {
  const h = harness(), before = state(h); h.failCommit = true; await assert.rejects(h.create(), /before commit/);
  assert.equal(state(h), before); h.failCommit = false; await h.create(); assert.equal(h.list("jobs").length, 1);
});
await test("作成後の担当・取消を再送で巻き戻さない", async () => {
  const h = harness(), first = await h.create(), job = h.records.get("jobs/" + first.jobIds[0]);
  Object.assign(job, { status: "cancelled", cancelled: true, assignedStaffId: "synthetic-staff" });
  h.records.get(h.paths.candidate).status = "cancelled"; const before = state(h);
  assert.equal((await h.create()).replayed, true); assert.equal(state(h), before);
});
for (const [name, mutate] of [
  ["会社違いの受信", h => h.records.get(h.paths.receipt).companyId = "other"],
  ["会社違いの候補", h => h.records.get(h.paths.candidate).companyId = "other"],
  ["別受信元", h => h.records.get(h.paths.candidate).messageId = "other"],
  ["原文指紋違い", h => h.records.get(h.paths.candidate).sourceFingerprint = "c".repeat(64)],
  ["出典SHA違い", h => h.records.get(h.paths.candidate).source.sha256 = "c".repeat(64)],
  ["候補対応欠落", h => h.records.get(h.paths.receipt).candidateIds = ["other"]],
  ["候補重複", h => h.records.get(h.paths.receipt).candidateIds.push("candidate-1")],
  ["受信版変更", h => h.records.get(h.paths.receipt).revision++],
  ["候補版変更", h => h.records.get(h.paths.candidate).revision++],
  ["受信確認待ち", h => h.records.get(h.paths.receipt).status = "review"],
  ["候補確認待ち", h => h.records.get(h.paths.candidate).status = "review"],
  ["取消候補", h => h.records.get(h.paths.candidate).status = "cancelled"],
  ["変更メール", h => h.records.get(h.paths.receipt).kind = "change"],
  ["未検証受信", h => h.records.get(h.paths.receipt).verification = "preview"],
  ["添付不完全", h => h.records.get(h.paths.receipt).structuralComplete = false],
  ["実行者停止", h => h.records.get(h.paths.principal).active = false],
  ["実行者版変更", h => h.records.get(h.paths.principal).revision = "new"],
  ["別会社の実行者", h => h.records.get(h.paths.principal).companyId = "other"],
  ["未有効", h => delete h.records.get(h.paths.feature).caseMailJobCreationEnabled],
  ["実在しない日付", h => h.records.get(h.paths.candidate).input.workDate = "2026-02-30"],
  ["対象月より前", h => h.records.get(h.paths.candidate).input.workDate = "2026-09-30"],
  ["給与持込み", h => h.records.get(h.paths.candidate).input.basePay = 10000],
  ["即時公開持込み", h => h.records.get(h.paths.candidate).input.publicationMode = "immediate"],
  ["人数枠未分割", h => h.records.get(h.paths.candidate).input.slots = 2],
]) await test(name + "を保存前に拒否", async () => {
  const h = harness(); mutate(h); const before = state(h); await assert.rejects(h.create()); assert.equal(state(h), before);
});
for (const user of [null, { uid: "staff", token: { companyId, role: "staff" } }, { uid: "admin", token: { role: "admin" } }]) {
  await test("認証・管理者・会社claim必須", async () => { const h = harness(), before = state(h); await assert.rejects(h.create(h.command, user)); assert.equal(state(h), before); });
}
await test("プレビューJSON/任意案件値を受信登録の根拠にできない", async () => {
  const h = harness(), before = state(h);
  await assert.rejects(h.create({ ...h.command, ...h.input }));
  h.records.delete(h.paths.receipt); const missing = state(h); await assert.rejects(h.create()); assert.equal(state(h), missing);
  assert.ok(before.includes("ready"));
});
for (const target of ["receipt", "candidate", "principal", "feature"]) await test("transaction中の" + target + "変更を再照合", async () => {
  const h = harness(); let changed = false;
  h.beforeCommit = () => { if (changed) return; changed = true; const data = h.records.get(h.paths[target]);
    if (target === "feature") data.caseMailJobCreationEnabled = false;
    else if (target === "principal") data.active = false; else data.revision++;
  };
  await assert.rejects(h.create()); assert.equal(h.list("jobs").length, 0); assert.equal(h.list("auditLogs").length, 0);
});
await test("同じ原文位置の日付変更を別案件として増やさない", async () => {
  const h = harness(); await h.create();
  const candidate = h.records.get(h.paths.candidate); candidate.input.workDate = "2026-10-11"; candidate.status = "ready"; candidate.revision = 3;
  const command = clone(h.command); command.mailIntake.operationId = "changed"; command.mailIntake.expectedRevision = 3;
  const before = state(h); await assert.rejects(h.create(command)); assert.equal(state(h), before);
});
await test("同じ原文位置の別候補を追加しない", async () => {
  const h = harness(); await h.create(); const candidate = clone(h.records.get(h.paths.candidate)); candidate.status = "ready"; candidate.revision = 1;
  h.records.set("caseMailIntakeCandidates/candidate-2", candidate); h.records.get(h.paths.receipt).candidateIds.push("candidate-2");
  const command = clone(h.command); command.mailIntake.candidateId = "candidate-2"; command.mailIntake.operationId = "alias";
  await assert.rejects(h.create(command)); assert.equal(h.list("jobs").length, 1);
});
await test("別人数枠は別案件、同一内容の別行も別案件", async () => {
  const h = harness(); await h.create();
  for (let n = 1; n <= 2; n++) {
    const candidate = clone(h.records.get(h.paths.candidate)); candidate.status = "ready"; candidate.revision = 1;
    if (n === 1) candidate.source.unitIndex = 1; else candidate.source.rowKey = "row-2";
    const candidateId = "candidate-" + (n + 1); h.records.set("caseMailIntakeCandidates/" + candidateId, candidate);
    h.records.get(h.paths.receipt).candidateIds.push(candidateId);
    const command = clone(h.command); command.mailIntake.candidateId = candidateId; command.mailIntake.operationId = "unit-" + n;
    await h.create(command);
  }
  assert.equal(h.list("jobs").length, 3); assert.equal(new Set(h.list("jobs").map(job => job.caseId)).size, 3);
});
await test("Firestoreのフィールド順が変わっても同一操作を回収", async () => {
  const h = harness(); await h.create(); const saved = h.list("caseMailJobCreates")[0];
  h.records.get(saved.path).command = Object.fromEntries(Object.entries(saved.command).reverse());
  assert.equal((await h.create()).replayed, true); assert.equal(h.list("jobs").length, 1);
});
await test("同じ操作IDを別確認版へ流用しない", async () => {
  const h = harness(); await h.create(); const command = clone(h.command); command.mailIntake.expectedRevision++;
  await assert.rejects(h.create(command)); assert.equal(h.list("jobs").length, 1);
});
await test("登録済み案件が失われた場合は再作成しない", async () => {
  const h = harness(), out = await h.create(); h.records.delete("jobs/" + out.jobIds[0]); const before = state(h);
  await assert.rejects(h.create()); assert.equal(state(h), before);
});
await test("行作成未設定ならCrew下書きだけを保存", async () => {
  const h = harness(); h.records.get(h.paths.feature).adminJobCreationSourceReady = false; const out = await h.create();
  assert.equal(out.rowCreationQueued, false); assert.equal(h.list("sheetRowCreateQueue").length, 0);
  assert.equal(h.list("jobs")[0].sourceCreationStatus, "disabled");
});
await test("従来の手動作成の人数・単価・監査を維持", async () => {
  const h = harness(), out = await h.create({ ...h.input, slots: 2, basePay: 12000 });
  assert.equal(out.jobIds.length, 2); assert.equal(h.list("caseMailJobCreates").length, 0);
  assert.deepEqual(h.list("jobs").map(job => job.slotNumber), [1, 2]);
  assert.ok(h.list("jobs").every(job => job.basePay === 12000 && !job.mailIntake));
  assert.equal(h.list("auditLogs").length, 1); assert.equal(h.list("sheetRowCreateQueue").length, 1);
});
await test("固定IDの実シフトパーサーが同じCrew案件IDを返す", async () => {
  const h = harness(), out = await h.create(), job = h.list("jobs")[0], row = Array(55).fill("");
  row[0] = "2026-10-10"; row[9] = job.clientName; row[10] = job.storeName; row[11] = job.makerName;
  row[12] = job.menuName; row[13] = job.entryTime; row[14] = job.workTime; row[54] = job.caseId;
  const parsed = h.load("./shift-parser").parseShiftSheet("synthetic-sheet", "2026.10", [[], row], {
    companyId, headerRow: 1, dataStartRow: 2, columns: { workDate: "A", staffName: "B", clientName: "J", storeName: "K",
      makerName: "L", menuName: "M", entryTime: "N", workTime: "O", caseId: "BC", basePayColumns: [] },
  });
  assert.equal(parsed.jobs.length, 1); assert.equal(parsed.jobs[0].jobId, out.jobIds[0]);
});
await test("受信案件はsourceReadyだけでは募集できず原本照合が必要", async () => {
  const h = harness(), out = await h.create(), job = h.records.get("jobs/" + out.jobIds[0]);
  assert.equal((await h.publish({ jobIds: out.jobIds, action: "publish" })).blocked.length, 1);
  h.records.get("jobs/" + out.jobIds[0]).sourceReady = true;
  assert.equal((await h.publish({ jobIds: out.jobIds, action: "schedule", publishAt: "2099-01-01T00:00:00Z" })).blocked.length, 1);
  assert.equal((await h.publish({ jobIds: out.jobIds, action: "publish", expectedRevisions: { [out.jobIds[0]]: job.revision } })).blocked.length, 1);
  assert.equal(h.records.get("jobs/" + out.jobIds[0]).status, "draft");
});
await test("受信案件はスケジューラーから募集開始しない", async () => {
  const h = harness(), out = await h.create(), job = h.records.get("jobs/" + out.jobIds[0]);
  Object.assign(job, { status: "scheduled", sourceReady: true, scheduledPublishAt: Timestamp.fromMillis(1) });
  await h.schedule(); assert.equal(h.records.get("jobs/" + out.jobIds[0]).publishable, false);
  assert.notEqual(h.records.get("jobs/" + out.jobIds[0]).status, "open");
});
console.log("受信案件作成: " + count + "条件成功（SDK境界の合成試験、外部アクセスなし）");
