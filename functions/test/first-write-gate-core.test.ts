import { evaluateFirstWriteGate } from "../src/first-write-gate-core";
function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected=${String(expected)} actual=${String(actual)}`);
  }
}
const base = {
  targetSpreadsheetId: "copy_abcdefghijklmnopqrstuvwxyz",
  verifiedSpreadsheetId: "copy_abcdefghijklmnopqrstuvwxyz",
  productionSpreadsheetId: "prod_abcdefghijklmnopqrstuvwxyz",
  gasAuditGrade: "A",
  gasBlockers: 0,
  formulaDifferenceCount: 0,
  validationDifferenceCount: 0,
  conditionalFormatDifferenceCount: 0,
  protectedRangeDifferenceCount: 0,
  billingDifferenceYen: 0,
  payrollDifferenceYen: 0,
  pdfDifferenceCount: 0,
  mailRecipientDifferenceCount: 0,
  unresolvedManualInterventions: 0,
  writeMappingEnabled: true,
  rowCreationEnabled: true,
  monthCreationEnabled: true,
  explicitConfirmation: "検証コピーへ初回書込",
};
equal(evaluateFirstWriteGate(base).allowed, true, "valid gate should pass");
equal(evaluateFirstWriteGate({
  ...base,
  targetSpreadsheetId: base.productionSpreadsheetId,
  gasBlockers: 1,
}).allowed, false, "production/blocker gate should fail");
console.log("first write gate core tests passed");
