import assert from "node:assert/strict";
import {
  buildSafeDraft,
  columnToLetter,
  detectShiftHeader,
  detectStaffHeader,
  extractSpreadsheetId,
  monthlySheets,
  nextMonthName,
  normalizeMonthName,
  previousMonthSheet,
} from "../src/setup-wizard-core";

const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz123456789";
assert.equal(extractSpreadsheetId(id), id);
assert.equal(
  extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`),
  id
);
assert.equal(columnToLetter(0), "A");
assert.equal(columnToLetter(26), "AA");

const shiftRows: unknown[][] = [
  ["Lip Knots シフト表"],
  ["実施日", "スタッフ名", "", "", "", "", "体温", "着時刻", "", "クライアント名", "店舗名", "メーカー名", "メニュー名", "入店時間", "実施時間", "外注名"],
];
const shift = detectShiftHeader(shiftRows);
assert.equal(shift.headerRow, 2);
assert.equal(shift.columns.workDate, "A");
assert.equal(shift.columns.clientName, "J");
assert.deepEqual(shift.missingRequired, []);

const staffRows: unknown[][] = [
  ["No", "名前", "", "", "", "", "自宅都道府県", "", "", "", "", "", "", "", "", "最寄り駅", "生年月日", "", "メールアドレス", "電話番号"],
];
const staff = detectStaffHeader(staffRows);
assert.equal(staff.headerRow, 1);
assert.equal(staff.columns.displayName, "B");
assert.equal(staff.columns.email, "S");

assert.deepEqual(monthlySheets([
  { title:"2026.10" }, { title:"メモ" }, { title:"2026.2" }, { title:"2026.7", hidden:true },
]), ["2026.2", "2026.10"]);
assert.equal(previousMonthSheet("2026.8", ["2026.5","2026.7"]), "2026.7");
assert.equal(nextMonthName("2026.12"), "2027.1");
assert.equal(normalizeMonthName("2026年8月"), "2026.8");

const draft = buildSafeDraft({
  companyId:"lipknots",
  shiftSpreadsheetId:id,
  staffSpreadsheetId:id,
  shiftHeader:shift,
  staffHeader:staff,
  idColumn:"ZZ",
});
assert.equal((draft.safety as {allEnabled:boolean}).allEnabled, false);
assert.equal(
  (draft.shiftImportConfig as {enabled:boolean}).enabled,
  false
);
assert.equal(
  (draft.shiftMapping as {rowCreation:{enabled:boolean}}).rowCreation.enabled,
  false
);

console.log("setup wizard core tests passed");
