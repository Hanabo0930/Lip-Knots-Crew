import assert from "node:assert/strict";
import { createCaseIdentity } from "../src/case-id";
import { parseDateKey, parseMoney, parseShiftSheet } from "../src/shift-parser";
import { ShiftImportConfig } from "../src/shift-import-types";

const config: ShiftImportConfig = {
  companyId: "lipknots",
  enabled: true,
  spreadsheetId: "spreadsheet_test_1234567890",
  monthlySheetPattern: "^\\d{4}\\.\\d{1,2}$",
  importFrom: "2025.10",
  importThrough: null,
  headerRow: 1,
  dataStartRow: 2,
  maxRowsPerSheet: 10000,
  readRangeEndColumn: "BB",
  maxSheetsPerRun: 36,
  scheduleEnabled: false,
  markMissingAsArchived: false,
  configVersion: "0.2",
  columns: {
    workDate: "A",
    staffName: "B",
    temperature: "G",
    arrivalTime: "H",
    clientName: "J",
    storeName: "K",
    makerName: "L",
    menuName: "M",
    entryTime: "N",
    workTime: "O",
    subcontractorName: "P",
    materialStatus: "R",
    basePayColumns: ["S", "T", "U", "V", "W", "X", "Y", "Z"],
    clientChargeTotal: "AA",
    staffPaymentTotal: "AR",
    subcontractorTotal: "BB",
  },
};

assert.equal(parseDateKey("7/15", "2026.7"), "2026-07-15");
assert.equal(parseDateKey("2026/7/15", "2026.7"), "2026-07-15");
assert.equal(parseMoney("￥10,000"), 10000);
assert.equal(parseMoney(""), null);

const first = createCaseIdentity({
  companyId: "lipknots",
  spreadsheetId: "sheet1",
  sheetName: "2026.7",
  dateKey: "2026-07-20",
  clientName: "A社",
  storeName: "イオン船橋",
  workTime: "10:00～18:00",
  occurrence: 1,
});
const second = createCaseIdentity({
  companyId: "lipknots",
  spreadsheetId: "sheet1",
  sheetName: "2026.7",
  dateKey: "2026-07-20",
  clientName: "A社",
  storeName: "イオン船橋",
  workTime: "10:00～18:00",
  occurrence: 1,
});
assert.equal(first.jobId, second.jobId);

const rows: unknown[][] = [
  ["実施日", "スタッフ名", "", "", "", "", "体温", "着時刻", "", "クライアント名", "店舗名", "メーカー名", "メニュー名", "入店時間", "実施時間", "外注名", "", "資料", "単価"],
  ["7/20", "", "", "", "", "", "", "", "", "A社", "イオン船橋", "〇〇乳業", "ヨーグルト試食（50代まで）", "9:45", "10:00～18:00", "", "", "発送準備中", "10,000"],
  ["7/20", "山田花子", "", "", "", "", "36.2", "9:30", "", "A社", "イオン船橋", "〇〇乳業", "ヨーグルト試食", "9:45", "10:00～18:00", "", "", "", "10,000"],
  ["7/21", "佐藤花子（キャンセル）", "", "", "", "", "", "", "", "A社", "イオン津田沼", "〇〇食品", "試食", "9:45", "10:00～18:00", "", "", "", "10,000"],
  ["7/21", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
];

const parsed = parseShiftSheet(config.spreadsheetId, "2026.7", rows, config);
assert.equal(parsed.jobs.length, 3);
assert.equal(parsed.summary.counts.open, 1);
assert.equal(parsed.summary.counts.assigned, 1);
assert.equal(parsed.summary.counts.cancelled, 1);
assert.deepEqual(parsed.jobs[0]?.menuConditions, ["50代まで"]);
assert.equal(parsed.jobs[0]?.materialStatus, "発送準備中");
assert.equal(parsed.jobs[2]?.assignedStaffName, "佐藤花子");

console.log("shift parser tests passed");
