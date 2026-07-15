import assert from "node:assert/strict";
import {
  buildMonthCreationPlan,
  compactColumnRanges,
  compareFormulaSamples,
  compareMonthMetadata,
  formulaSampleRows,
  normalizeMonth,
} from "../src/month-sheet-core";

assert.equal(normalizeMonth("2026年8月"), "2026.8");
assert.deepEqual(compactColumnRanges(["A","B","D","E","F","AA"]), [
  ["A","B"],["D","F"],["AA","AA"],
]);

const plan = buildMonthCreationPlan({
  targetMonth:"2026.8",
  sheets:[
    {title:"2026.6",sheetId:6,rowCount:1000,columnCount:100,conditionalFormatCount:2,protectedRangeCount:1},
    {title:"2026.7",sheetId:7,rowCount:1000,columnCount:100,conditionalFormatCount:2,protectedRangeCount:1},
  ],
  mutableColumns:["A","B","J","K","AA","AB","ZZ"],
  formulaColumns:["AA"],
  dataStartRow:2,
  maxRows:1000,
});
assert.equal(plan.sourceMonth,"2026.7");
assert.equal(plan.sourceSheetId,7);
assert.deepEqual(plan.inputColumns,["A","B","J","K","AB","ZZ"]);
assert.ok(plan.clearRanges.includes("'2026.8'!A2:B1000"));

assert.deepEqual(formulaSampleRows(2,100,5),[2,27,51,76,100]);
assert.deepEqual(compareMonthMetadata(
  {conditionalFormatCount:2,protectedRangeCount:1,rowCount:100,columnCount:50},
  {conditionalFormatCount:2,protectedRangeCount:1,rowCount:100,columnCount:50},
),[]);
assert.equal(compareMonthMetadata(
  {conditionalFormatCount:2,protectedRangeCount:1,rowCount:100,columnCount:50},
  {conditionalFormatCount:1,protectedRangeCount:1,rowCount:100,columnCount:50},
).length,1);
assert.deepEqual(compareFormulaSamples(
  {AA2:"=SUM(A2:Z2)",AJ2:"=SUM(AB2:AI2)"},
  {AA2:"=SUM(A2:Z2)",AJ2:"=SUM(AB2:AI2)"},
),[]);

console.log("month sheet core tests passed");
