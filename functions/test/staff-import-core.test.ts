import assert from "node:assert/strict";
import { createStaffId, splitEmails } from "../src/staff-identity";
import { mergeStaffRows, parseStaffSheet } from "../src/staff-parser";
import { StaffImportConfig } from "../src/staff-import-types";

const config: StaffImportConfig = {
  companyId: "lipknots",
  enabled: true,
  scheduleEnabled: false,
  spreadsheetId: "staff_sheet_test_1234567890",
  activeSheets: ["マスタ", "東北"],
  excludedSheets: ["抹消"],
  sheetAreas: {
    "マスタ": "首都圏・北関東",
    "東北": "東北",
  },
  headerRow: 1,
  dataStartRow: 2,
  maxRowsPerSheet: 5000,
  readRangeEndColumn: "T",
  maxSheetsPerRun: 10,
  markMissingInactive: false,
  revokeRemovedEmailSessions: true,
  configVersion: "0.3",
  columns: {
    displayName: "B",
    homePrefecture: "G",
    nearestStation: "P",
    birthDate: "Q",
    email: "S",
    phone: "T",
  },
};

assert.deepEqual(
  splitEmails("A@example.com、b@example.com\nA@example.com"),
  ["a@example.com", "b@example.com"]
);
assert.equal(
  createStaffId("lipknots", "山田花子"),
  createStaffId("lipknots", "山田 花子")
);

const master: unknown[][] = [
  ["No", "名前", "", "", "", "", "自宅都道府県", "", "", "", "", "", "", "", "", "最寄り駅", "生年月日", "", "メールアドレス", "電話番号"],
  ["1", "山田花子", "", "", "", "", "千葉県", "", "", "", "", "", "", "", "", "津田沼駅", "1980/1/2", "", "first@example.com", "090-1111-2222"],
  ["2", "山田花子", "", "", "", "", "千葉県", "", "", "", "", "", "", "", "", "津田沼駅", "1980/1/2", "", "second@example.com", "090-1111-2222"],
  ["3", "佐藤美香", "", "", "", "", "東京都", "", "", "", "", "", "", "", "", "新宿駅", "1975/4/5", "", "invalid-email", "080-3333-4444"],
];
const tohoku: unknown[][] = [
  ["No", "名前", "", "", "", "", "自宅都道府県", "", "", "", "", "", "", "", "", "最寄り駅", "生年月日", "", "メールアドレス", "電話番号"],
  ["1", "鈴木智子", "", "", "", "", "宮城県", "", "", "", "", "", "", "", "", "仙台駅", "1968/6/7", "", "tohoku@example.com", "070-5555-6666"],
];

const masterParsed = parseStaffSheet(config.spreadsheetId, "マスタ", master, config);
const tohokuParsed = parseStaffSheet(config.spreadsheetId, "東北", tohoku, config);
const merged = mergeStaffRows([...masterParsed.rows, ...tohokuParsed.rows]);

assert.equal(merged.profiles.length, 3);
const yamada = merged.profiles.find((profile) => profile.displayName === "山田花子");
assert.ok(yamada);
assert.deepEqual(yamada.emails, ["first@example.com", "second@example.com"]);
assert.deepEqual(yamada.areaLabels, ["首都圏・北関東"]);
assert.equal(yamada.phone, "09011112222");

const sato = merged.profiles.find((profile) => profile.displayName === "佐藤美香");
assert.ok(sato);
assert.equal(sato.emails.length, 0);
assert.deepEqual(sato.invalidEmails, ["invalid-email"]);

const suzuki = merged.profiles.find((profile) => profile.displayName === "鈴木智子");
assert.ok(suzuki);
assert.deepEqual(suzuki.areaLabels, ["東北"]);

console.log("staff parser tests passed");
