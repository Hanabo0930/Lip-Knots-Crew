import assert from "node:assert/strict";
import {
  buildInsertPlan,
  buildRowFingerprint,
  cloneConditionalRuleForRow,
  columnToIndex,
  conditionalRulesCoveringTemplate,
  formulaVerification,
  gridRangeCoversRow,
  indexToColumn,
  isDataRow,
  missingConditionalRulesForRows,
  monthSheetName,
  validationVerification,
} from "../src/sheet-row-creation-core";

assert.equal(monthSheetName("2026-08-03"), "2026.8");
assert.equal(columnToIndex("A"), 0);
assert.equal(columnToIndex("AA"), 26);
assert.equal(indexToColumn(26), "AA");

assert.equal(isDataRow({
  rowNumber: 10,
  workDate: "8/1",
  clientName: "A社",
  storeName: "イオン",
  workTime: "10～18",
}), true);
assert.equal(isDataRow({
  rowNumber: 11,
  workDate: "",
  clientName: "",
  storeName: "",
  workTime: "",
}), false);

const plan = buildInsertPlan([
  { rowNumber: 2, workDate: "8/1", clientName: "A社", storeName: "X", workTime: "10～18" },
  { rowNumber: 3, workDate: "8/2", clientName: "A社", storeName: "Y", workTime: "10～18" },
  { rowNumber: 4, workDate: "", clientName: "", storeName: "", workTime: "" },
], 3, {
  dataStartRow: 2,
  maxRows: 1000,
  rowEndColumn: "ZZ",
  templateFormulaColumns: ["AA"],
  requiredValidationColumns: ["B"],
});
assert.equal(plan.templateRow, 3);
assert.equal(plan.insertBeforeRow, 4);
assert.deepEqual(plan.insertedRows, [4, 5, 6]);

assert.equal(gridRangeCoversRow({ startRowIndex: 1, endRowIndex: 5 }, 5), true);
assert.equal(gridRangeCoversRow({ startRowIndex: 1, endRowIndex: 5 }, 6), false);

const rule = {
  ranges: [{ sheetId: 1, startRowIndex: 1, endRowIndex: 4 }],
  booleanRule: { condition: { type: "CUSTOM_FORMULA" } },
};
assert.equal(conditionalRulesCoveringTemplate([rule], 3).length, 1);
assert.equal(missingConditionalRulesForRows([rule], [rule], [5]).length, 1);
const cloned = cloneConditionalRuleForRow(rule, 1, 5, 702);
assert.equal(cloned.ranges?.[0]?.startRowIndex, 4);
assert.equal(cloned.ranges?.[0]?.endColumnIndex, 702);

assert.deepEqual(formulaVerification({ AA: "=SUM(A1:A2)", AJ: "" }, ["AA", "AJ"]), [
  "AJ列へ数式が継承されていません。",
]);
assert.deepEqual(validationVerification({ B: true, BC: false }, ["B", "BC"]), [
  "BC列へ入力規則が継承されていません。",
]);

assert.equal(buildRowFingerprint({
  workDate: "2026-08-01",
  clientName: " A社 ",
  storeName: "イオン",
  workTime: "10～18",
  caseId: "LKC-1",
}), "2026-08-01|a社|イオン|10~18|lkc-1");

console.log("sheet row creation core tests passed");
