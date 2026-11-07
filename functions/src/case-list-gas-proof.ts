import { hashCaseList } from "./case-list-source-core";
import type { GasTransferMonthRead } from "./case-list-monthly-reader";

type Data = Record<string, any>;
const planner = require("../src/case-list-gas-planner.cjs") as {
  dateKey(value: unknown): string | null;
  choosePosition(month: Data, date: string, source: Data): Data;
};
const need = (ok: unknown, code: string): void => { if (!ok) throw Error(code); };
const value = (c: Data | undefined): any => {
  const v = c?.effectiveValue ?? c?.userEnteredValue ?? {};
  need(!v.errorValue, "GAS_PROOF_FORMULA_ERROR");
  return v.numberValue ?? v.stringValue ?? v.boolValue ?? "";
};
const text = (v: unknown): string => String(v ?? "").trim();
const sourceHash = (cells: Data[]) => hashCaseList(cells.map(c => [c.userEnteredValue ?? {}, c.effectiveValue ?? {}, c.userEnteredFormat ?? {}, c.note ?? "", c.dataValidation ?? {}, c.textFormatRuns ?? [], c.chipRuns ?? []]));
const recordHash = (cells: Data[]) => hashCaseList(cells.map(c => [c.userEnteredValue ?? {}, c.effectiveValue ?? {}]));

/** Assemble the actual V17 inspect/proof preimage, not the Crew native plan.
 * Only fresh, unstarted, single-day transfers with an existing ledger row and
 * an existing eligible day block are supported here. Other paths stay held.
 * Preserve the A2:O rowData length: padding a sparse API response changes GAS's
 * monthHash, even when the visible table would look the same.
 */
export function assembleGasTransferPreimage(r: Data, snapshot: Data, read: GasTransferMonthRead): Data {
  need(read && read.spreadsheetId === snapshot.spreadsheetId && snapshot.spreadsheetId === r.config.spreadsheetId, "GAS_PROOF_BOOK_MISMATCH");
  const table = snapshot.months.find((m: Data) => m.sheetId === read.sheetId);
  need(table && table.title === read.title && table.rowCount === read.rowCount && table.columnCount === read.columnCount, "GAS_PROOF_MONTH_READ_REQUIRED");
  const row = snapshot.source.rows.find((row: Data) => row.caseId === r.job.caseId);
  const cells = row?.cells, ledgerCells = snapshot.rawLedgerRows[3];
  need(row?.row === snapshot.selectedRows.source && Array.isArray(cells) && cells.length === 65 &&
    Number.isInteger(snapshot.selectedRows.ledger) && snapshot.selectedRows.ledger >= 4 &&
    Array.isArray(ledgerCells) && ledgerCells.length === 25 && value(ledgerCells[0]) === r.job.caseId, "GAS_PROOF_FULL_PREIMAGE_REQUIRED");
  need(["単日", "SINGLE"].includes(text(value(cells[58]))) && !text(value(cells[59])) &&
    planner.dateKey(value(cells[1])) === r.job.dateKey && text(value(cells[2])) === r.job.assignedStaffName &&
    value(cells[60]) === r.job.caseId && value(cells[0]) === false && value(cells[63]) === false, "GAS_PROOF_SINGLE_CASE_REQUIRED");
  const width = table.columnCount;
  need([55, 56].includes(width) && table.headers[width - 1] === "連絡_固定案件ID" &&
    (width === 55 || table.headers[54] === "") && !snapshot.selectedRows.destinations.length, "GAS_PROOF_NEW_DESTINATION_REQUIRED");
  const index = new Map<number, Data>(table.rows.map((row: Data) => [row.row, row]));
  const rows = read.rowData.map((line, i) => {
    const c = line.values ?? [], v = c.map(value), idRow = index.get(i + 2);
    need(idRow, "GAS_PROOF_ID_INDEX_INCOMPLETE");
    return { row: i + 2, date: v[0] ?? "", staff: v[1] ?? "", client: v[9] ?? "", store: v[10] ?? "",
      maker: v[11] ?? "", product: v[12] ?? "", arrival: v[13] ?? "", execution: v[14] ?? "",
      totalFormula: c[1]?.userEnteredValue?.formulaValue ?? "", id: value(idRow!.cells[width - 1]) };
  });
  const [year, monthNumber] = read.title.split(".");
  const dashboard = rows.filter(row => text(row.date).startsWith(year + "年" + Number(monthNumber) + "月の数字"));
  const boundaryRow = dashboard.length === 1 ? dashboard[0]!.row : null;
  const emptyTemplateRow = boundaryRow === 5 && rows.slice(0, 3).every(row => !row.date && !row.staff && !row.client) &&
    rows[1]?.totalFormula.includes("COUNTIF($A:$A,INDEX($A:$A,ROW()))") ? 2 : null;
  const month = { title: read.title, rows, boundaryRow, emptyTemplateRow, allowTotalRepair: false };
  const position = planner.choosePosition(month, r.job.dateKey, { client: text(value(cells[10])), arrival: value(cells[14]) });
  need(position.insertCount === 1 && !position.totalFormulaAfter, "GAS_PROOF_PRODUCTION_POSITION_REQUIRED");
  return { book: snapshot.spreadsheetId, id: r.job.caseId, date: r.job.dateKey,
    source: { sheetId: snapshot.source.sheetId }, sourceRow: snapshot.selectedRows.source,
    sourceHash: sourceHash(cells), monthSheet: { sheetId: read.sheetId },
    monthHash: hashCaseList([month.rows, month.boundaryRow, false, width]),
    ledgerRow: snapshot.selectedRows.ledger, ledgerHash: recordHash(ledgerCells),
    ledgerValues: ledgerCells.map(value), position, existing: null };
}

export function expectedGasTransferProof(r: Data, snapshot: Data, read: GasTransferMonthRead): { approvedProof: string; checkedProof: string; batchFingerprint: string } {
  const p = assembleGasTransferPreimage(r, snapshot, read);
  const proof = hashCaseList([p.book, p.id, p.date, p.source.sheetId, p.sourceRow, p.sourceHash,
    p.monthSheet.sheetId, p.monthHash, p.ledgerRow, p.ledgerHash, p.position, p.existing]);
  const batchFingerprint = hashCaseList([p.id, p.date, p.monthSheet.sheetId, p.sourceHash,
    p.ledgerValues[0] ? p.ledgerRow : null, p.ledgerHash, null]);
  // execute checks the current proof and then uses that proof as approvedProof
  // for a new intent, including the batch path. Resumed/changed preimages are
  // not inferred from an old receipt here.
  return { approvedProof: proof, checkedProof: proof, batchFingerprint };
}
