import assert from "node:assert/strict";
import {
  buildJobCsv,
  clientInputKeys,
  normalizeJobInput,
  isValidPublicationDateTime,
  normalizeMoneyRecord,
  resolvePublication,
} from "../src/job-management-core";

const valid = normalizeJobInput({
  workDate: "2026-08-01",
  clientName: "A社",
  storeName: "イオン船橋",
  storeAddress: " ｃｈｉｂａ県船橋市山手1-1-8 ",
  storeNearestStation: " 新船橋駅 ",
  makerName: "〇〇食品",
  menuName: "ヨーグルト試食",
  entryTime: "9:45",
  workTime: "10:00～18:00",
  subcontractorName: "",
  slots: 3,
  basePay: 10000,
  publicationMode: "draft",
  publishAt: null,
});
assert.deepEqual(valid.errors, []);
assert.equal(valid.value.slots, 3);
assert.equal(valid.value.storeAddress, "chiba県船橋市山手1-1-8");
assert.equal(valid.value.storeNearestStation, "新船橋駅");

const invalid = normalizeJobInput({
  workDate: "2026/08/01",
  clientName: "",
  storeName: "",
  makerName: "",
  menuName: "",
  workTime: "",
  slots: 21,
  publicationMode: "scheduled",
  publishAt: null,
});
assert.ok(invalid.errors.length >= 7);

const blocked = resolvePublication({
  requestedMode: "immediate",
  publishAt: null,
  sourceReady: false,
  nowIso: "2026-07-13T00:00:00Z",
});
assert.equal(blocked.status, "draft");
assert.equal(blocked.blockedReason, "sheet_source_not_ready");

const scheduled = resolvePublication({
  requestedMode: "scheduled",
  publishAt: "2026-07-20T00:00:00Z",
  sourceReady: true,
  nowIso: "2026-07-13T00:00:00Z",
});
assert.equal(scheduled.status, "scheduled");

const money = normalizeMoneyRecord({
  invoiceBase: "15,000円",
  invoiceOther: null,
}, clientInputKeys);
assert.deepEqual(money.errors, []);
assert.equal(money.values.invoiceBase, 15000);
assert.equal(money.values.invoiceOther, null);

const rejected = normalizeMoneyRecord({ secretTotal: 999 }, clientInputKeys);
assert.equal(rejected.errors.length, 1);

const csv = buildJobCsv([{
  workDate: "2026-08-01",
  clientName: 'A"社',
  storeName: "イオン船橋",
  makerName: "〇〇食品",
  menuName: "試食",
  workTime: "10:00～18:00",
  assignedStaffName: "山田花子",
  status: "assigned",
  invoice: 15000,
  payment: 10000,
  grossProfit: 5000,
}]);
assert.ok(csv.startsWith("\uFEFF"));
assert.ok(csv.includes('"A""社"'));

console.log("job management core tests passed");

for (const workDate of ["2026-02-30", "1900-02-29", "2026-04-31", "2026-00-10", "2026-13-01", "2026-01-00", "0000-01-01"]) {
  assert.ok(normalizeJobInput({...valid.value, workDate}).errors.length > 0, workDate);
}
for (const workDate of ["2000-02-29", "2028-02-29", "2026-01-31", "0099-01-01"]) {
  assert.deepEqual(normalizeJobInput({...valid.value, workDate}).errors, [], workDate);
}
for (const value of ["2026-02-30T09:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T09:60:00Z", "2026-01-01T09:00:60Z", "2026-01-01T09:00:00+24:00", "2026-01-01T09:00:00+09:60", "2026-01-01", "invalid"]) {
  assert.equal(isValidPublicationDateTime(value), false, value);
  assert.ok(normalizeJobInput({...valid.value, publicationMode: "scheduled", publishAt: value}).errors.length > 0, value);
}
for (const value of ["2028-02-29T09:00:00Z", "2026-01-01T09:00", "2026-01-01T09:00:01.123Z", "2026-01-01T09:00:00+09:00", "2026-01-01T09:00:00-05:30"]) {
  assert.equal(isValidPublicationDateTime(value), true, value);
  assert.deepEqual(normalizeJobInput({...valid.value, publicationMode: "scheduled", publishAt: value}).errors, [], value);
}
console.log("calendar and publication date validation: 24 boundary cases passed");
