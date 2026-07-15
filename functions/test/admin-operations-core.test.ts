import assert from "node:assert/strict";
import {
  buildExpenseExpected,
  buildExpenseSheetUpdates,
  canManuallyRetrySheetWrite,
  createSpreadsheetRowUrl,
  normalizeExpenseInput,
} from "../src/admin-operations-core";

const parsed = normalizeExpenseInput({
  transportation: "1,240円",
  purchase8: "500",
  purchase10: "",
  netPrintCost: 120,
  postageCost: null,
});
assert.deepEqual(parsed.errors, []);
assert.deepEqual(parsed.values, {
  transportation: 1240,
  purchase8: 500,
  purchase10: null,
  netPrintCost: 120,
  postageCost: null,
});

assert.deepEqual(buildExpenseSheetUpdates(parsed.values), {
  transportation: 1240,
  purchase8: 500,
  purchase10: "",
  netPrintCost: 120,
  postageCost: "",
});

assert.deepEqual(buildExpenseExpected(parsed.values), {
  transportation: { mode: "exact", value: 1240 },
  purchase8: { mode: "exact", value: 500 },
  purchase10: { mode: "blank" },
  netPrintCost: { mode: "exact", value: 120 },
  postageCost: { mode: "blank" },
});

const invalid = normalizeExpenseInput({ transportation: "-1" });
assert.equal(invalid.errors.length, 1);

assert.equal(
  createSpreadsheetRowUrl({
    spreadsheetId: "13kqsFydcdvKG-87QQD7MnN6OK24DNVmm9LiwR9hlH4I",
    sheetId: 123456,
    row: 42,
    endColumn: "BB",
  }),
  "https://docs.google.com/spreadsheets/d/13kqsFydcdvKG-87QQD7MnN6OK24DNVmm9LiwR9hlH4I/edit#gid=123456&range=A42:BB42"
);

assert.equal(canManuallyRetrySheetWrite({
  status: "dead_letter",
  errorType: "system",
}), true);
assert.equal(canManuallyRetrySheetWrite({
  status: "blocked",
  errorType: "conflict",
}), false);

console.log("admin operations core tests passed");
