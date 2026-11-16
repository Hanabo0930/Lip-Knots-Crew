import assert from "node:assert/strict";
import { harness, companyId } from "./case-mail-test-harness.mjs";

const jobId = "synthetic-location-job";
const path = "jobs/" + jobId;
const revision = 7;
const originalAddress = "架空県試験町1番地";
const newAddress = "架空県試験町2番地";
const originalStation = "旧合成駅";
const newStation = "新合成駅";
const locationFields = { storeAddress: newAddress, storeNearestStation: newStation };
const cases = [];

function fixture() {
  const h = harness();
  const job = {
    companyId, revision, caseId: "synthetic-case", caseListSource: { sourceRevision: "synthetic-source" },
    assignedStaffId: "synthetic-staff", status: "assigned", dateKey: "2026-11-15",
    storeName: "合成店舗", storeAddress: originalAddress, storeNearestStation: originalStation,
    sheetRef: { spreadsheetId: "synthetic-sheet", sheetName: "合成月別", rowNumber: 5 },
  };
  h.records.set(path, job);
  const { adminEditCaseListLocation, adminEditJobInputs } = h.load("./job-management");
  const run = (fields = locationFields, at = revision, auth = h.auth, locationRevision = 0) =>
    adminEditCaseListLocation({ auth, data: { jobId, fields, revision: at, locationRevision } });
  const legacy = fields => adminEditJobInputs({ auth: h.auth, data: { jobId, fields, revision } });
  return { h, job, run, legacy, read: () => h.records.get(path) };
}

async function test(name, execute) {
  try {
    await execute();
    cases.push({ name, passed: true });
  } catch (error) {
    cases.push({ name, passed: false, message: error.stack });
  }
}

await test("save the imported case location to Crew and read it back without a sheet queue", async () => {
  const { h, job, run, read } = fixture();
  const result = await run();
  assert.equal(result.revision, revision);
  assert.equal(result.locationRevision, 1);
  assert.equal(read().revision, revision);
  assert.equal(read().locationRevision, 1);
  assert.equal(read().storeAddress, newAddress);
  assert.equal(read().storeNearestStation, newStation);
  for (const key of ["caseListSource", "caseId", "sheetRef", "assignedStaffId", "dateKey", "status"]) {
    assert.equal(JSON.stringify(read()[key]), JSON.stringify(job[key]), key);
  }
  assert.equal(h.list("sheetSyncQueue").length, 0);
  assert.equal(h.list("auditLogs").length, 1);
  assert.equal(h.list("auditLogs")[0].detail.fields.join(","), "storeAddress,storeNearestStation");
  assert.equal(h.commits.flat().length, 2);
});

await test("other company, staff and mixed edits are refused before writing", async () => {
  const f = fixture();
  const before = JSON.stringify([...f.h.records]);
  await assert.rejects(() => f.run({ ...locationFields, assignedStaffId: "different-staff" }), { name: "ZodError" });
  await assert.rejects(() => f.run(locationFields, revision, { uid: "staff", token: { companyId, role: "staff" } }), { code: "permission-denied" });
  assert.equal(JSON.stringify([...f.h.records]), before);
  f.h.records.set(path, { ...f.job, companyId: "foreign-company" });
  await assert.rejects(() => f.run(), { code: "not-found" });
  assert.equal(f.h.commits.length, 0);
});

await test("a concurrent location update prevents the old version from overwriting the address", async () => {
  const f = fixture();
  f.h.beforeCommit = ({ reads }) => {
    assert.ok(reads.has(path));
    f.h.beforeCommit = null;
    f.h.records.set(path, { ...f.job, locationRevision: 1, storeAddress: "架空県試験町3番地" });
  };
  await assert.rejects(() => f.run(), { code: "aborted" });
  assert.equal(f.h.attempts, 2);
  assert.equal(f.read().storeAddress, "架空県試験町3番地");
  assert.equal(f.read().storeNearestStation, originalStation);
  assert.equal(f.h.commits.length, 0);
});

await test("recover a lost answer by checking Crew and refuse replay with the old revision", async () => {
  const f = fixture();
  f.h.loseResponse = true;
  await assert.rejects(() => f.run(), /synthetic lost response/u);
  assert.equal(f.read().revision, revision);
  assert.equal(f.read().locationRevision, 1);
  assert.equal(f.read().storeAddress, newAddress);
  assert.equal(f.read().storeNearestStation, newStation);
  await assert.rejects(() => f.run(), { code: "aborted" });
  assert.equal(f.h.list("auditLogs").length, 1);
  assert.equal(f.h.list("sheetSyncQueue").length, 0);
});

await test("the existing entry rejects a linked job and keeps the normal edit for an unlinked job", async () => {
  const f = fixture();
  await assert.rejects(() => f.legacy(locationFields), { code: "failed-precondition" });
  assert.equal(f.h.commits.length, 0);
  f.h.records.set(path, { ...f.job, caseListSource: undefined });
  await assert.rejects(() => f.run(), { code: "failed-precondition" });
  assert.equal(f.h.commits.length, 0);
  assert.equal((await f.legacy(locationFields)).revision, revision + 1);
  assert.equal(f.read().storeAddress, newAddress);
  assert.equal(f.read().locationRevision, undefined);
});

await test("an intervening assignment edition prevents an otherwise fresh location edit", async () => {
  const f = fixture();
  f.h.records.set(path, { ...f.job, revision: revision + 1, assignedStaffId: "next-staff" });
  await assert.rejects(() => f.run(), { code: "aborted" });
  assert.equal(f.read().storeAddress, originalAddress);
  assert.equal(f.h.commits.length, 0);
});

await test("the same administrator can make another location edit using the saved edition", async () => {
  const f = fixture();
  const first = await f.run();
  const second = await f.run({ storeNearestStation: "次の合成駅" }, first.revision, f.h.auth, first.locationRevision);
  assert.equal(second.revision, revision);
  assert.equal(second.locationRevision, 2);
  assert.equal(f.read().storeAddress, newAddress);
  assert.equal(f.read().storeNearestStation, "次の合成駅");
});

await test("invalid candidate editions or unexpected fields never write", async () => {
  const f = fixture();
  const { adminEditCaseListLocation } = f.h.load("./job-management");
  await assert.rejects(() => adminEditCaseListLocation({ auth: f.h.auth, data: { jobId, revision, fields: locationFields } }), { name: "ZodError" });
  await assert.rejects(() => f.run({}), { name: "ZodError" });
  f.h.records.set(path, { ...f.job, locationRevision: null });
  await assert.rejects(() => f.run(), { code: "failed-precondition" });
  assert.equal(f.h.commits.length, 0);
});

console.log(JSON.stringify({ total: cases.length, passed: cases.filter(test => test.passed).length,
  cases, synthetic: true, realWrites: 0, externalRequests: 0 }, null, 2));
if (cases.some(test => !test.passed)) process.exitCode = 1;
