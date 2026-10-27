import { db } from "./firebase";
import { createReadOnlySheetsClient } from "./sheet-reader";
import { HttpsError } from "firebase-functions/v2/https";
import { CASE_LIST_SOURCE, configuredCaseListSource, hashCaseList, inspectCaseList, type Cell } from "./case-list-source-core";

type StaffIdentity = { staffId: string; identityVerified: boolean };
type ReadOptions = {
  includeDependencies?: boolean;
  resolveStaff?: (name: string) => StaffIdentity | null;
};
type NativeCell = Record<string, unknown>;
type NativeProperties = {
  sheetId?: number | null;
  title?: string | null;
  gridProperties?: { rowCount?: number | null; columnCount?: number | null } | null;
};
type NativeBook = {
  spreadsheetId?: string | null;
  properties?: { timeZone?: string | null } | null;
  sheets?: Array<{
    properties?: NativeProperties | null;
    data?: Array<{ startRow?: number | null; startColumn?: number | null; rowData?: Array<{ values?: NativeCell[] | null }> | null }> | null;
  }> | null;
};
type Bound = { sheetId: number; title: string; rowCount: number; columnCount: number };
type SnapshotRow = { row: number; cells: Cell[]; caseId?: string; fixedId?: string; staffId?: string; staffIdentityVerified?: boolean };
type MonthlySnapshot = {
  spreadsheetId: string;
  isolated: boolean;
  source: { sheetId: number; title: string; rowCount: number; headers: string[]; rows: SnapshotRow[] };
  months: Array<{ sheetId: number; title: string; rowCount: number; headers: string[]; rows: SnapshotRow[]; isolated: boolean }>;
  dependencyHash: string;
  catalog: Record<string, unknown> | null;
};
const adapter = require("../src/case-list-monthly-adapter.cjs") as {
  snapshotFromNative(input: {
    metadata: NativeBook;
    cells: NativeBook & { requestedCellFields: string; requestedRanges: Array<{ sheetId: number; startRow: number; rowCount: number; startColumn: number; columnCount: number }>; requestedMonthTitles: string[] };
    dependencyHash: string;
    catalog: Record<string, unknown>;
    resolveStaff: (name: string) => StaffIdentity | null;
  }): MonthlySnapshot;
};
const CELL_FIELDS = "userEnteredValue,effectiveValue,note,userEnteredFormat,dataValidation,textFormatRuns,chipRuns";
const DEPENDENCY_FIELDS = "userEnteredValue,effectiveValue";
const METADATA_FIELDS = "spreadsheetId,properties.timeZone,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))";
const DEPENDENCIES = ["スタッフマスタ", "各社見積書", "イオンデモ遠方リスト", "ケイ_応募日補助"];
const MONTHS = [
  { title: "2026.11", sheetId: 1773116117, width: 55 },
  { title: "2026.12", sheetId: 434431224, width: 56 },
];
function stopped(code: string): never {
  throw new HttpsError("failed-precondition", "月別連携に必要な原本の構造・固定ID・読取範囲を確認できません。原本を保持して停止しました。", { reason: code });
}
function bounds(book: NativeBook, title: string, sheetId?: number, width?: number, maxRows = 10000): Bound {
  const matches = (book.sheets ?? []).filter(sheet => sheet.properties?.title === title);
  const properties = matches.length === 1 ? matches[0]?.properties : undefined;
  const actualId = properties?.sheetId, rowCount = properties?.gridProperties?.rowCount, columnCount = properties?.gridProperties?.columnCount;
  if (typeof actualId !== "number" || !Number.isInteger(actualId) || actualId < 0 ||
      (sheetId !== undefined && actualId !== sheetId) ||
      typeof rowCount !== "number" || !Number.isInteger(rowCount) || rowCount < 1 || rowCount > maxRows ||
      typeof columnCount !== "number" || !Number.isInteger(columnCount) || columnCount < 1 || columnCount > 100 ||
      (width !== undefined && columnCount !== width)) stopped("MONTHLY_READER_BOUND_MISMATCH");
  return { sheetId: actualId, title, rowCount, columnCount };
}
function assertBook(book: NativeBook, spreadsheetId: string): void {
  if (book.spreadsheetId !== spreadsheetId || book.properties?.timeZone !== "Asia/Tokyo") stopped("MONTHLY_READER_BOOK_MISMATCH");
}
function dense(book: NativeBook, bound: Bound): Cell[][] {
  const current = bounds(book, bound.title, bound.sheetId, bound.columnCount);
  if (current.rowCount !== bound.rowCount) stopped("MONTHLY_READER_STRUCTURE_CHANGED");
  const sheet = (book.sheets ?? []).find(sheet => sheet.properties?.sheetId === bound.sheetId);
  if (!sheet) stopped("MONTHLY_READER_DATA_MISSING");
  const matrix: Cell[][] = Array.from({ length: bound.rowCount }, () => Array.from({ length: bound.columnCount }, () => ({})));
  for (const grid of sheet.data ?? []) {
    const startRow = grid.startRow ?? 0, startColumn = grid.startColumn ?? 0;
    if (!Number.isInteger(startRow) || !Number.isInteger(startColumn) || startRow < 0 || startColumn < 0) stopped("MONTHLY_READER_GRID_OFFSET");
    for (const [r, row] of (grid.rowData ?? []).entries()) {
      const destination = matrix[startRow + r];
      if (!destination) stopped("MONTHLY_READER_GRID_ROW_OUTSIDE_BOUND");
      for (const [c, cell] of (row.values ?? []).entries()) {
        const column = startColumn + c;
        if (column >= bound.columnCount || !cell || typeof cell !== "object" || Array.isArray(cell)) stopped("MONTHLY_READER_GRID_CELL_OUTSIDE_BOUND");
        destination[column] = cell as Cell;
      }
    }
  }
  return matrix;
}
function quote(title: string): string { return "'" + title.replace(/'/g, "''") + "'"; }
function column(index: number): string {
  let result = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
}
const rangeFor = (bound: Bound): string => `${quote(bound.title)}!A1:${column(bound.columnCount)}${bound.rowCount}`;
const cellFields = (fields: string): string => `spreadsheetId,properties.timeZone,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData.values(${fields})))`;

/** Fresh read-only Google snapshot for capability checks and the monthly worker.
 * Full source/ledger/November/December cell metadata remains in memory only.
 * A fresh read does not make Google Sheets and Firestore one transaction.
 */
export async function readCaseListMonthlySnapshot(companyId: string, caseId: string, options: ReadOptions = {}): Promise<MonthlySnapshot & { rawRows: Cell[][]; rawLedgerRows: Cell[][] }> {
  if (!companyId || companyId.includes("/") || !/^LKCASE_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(caseId)) stopped("MONTHLY_READER_REQUEST_INVALID");
  const config = (await db.collection("sheetImportConfigs").doc(companyId).get()).data();
  if (!config || config.companyId !== companyId || config.caseListEnabled !== true) stopped("MONTHLY_READER_CONFIG_DISABLED");
  let spreadsheetId: string;
  try { spreadsheetId = configuredCaseListSource(config.spreadsheetId).spreadsheetId; }
  catch { stopped("MONTHLY_READER_CONFIG_BOOK_INVALID"); }
  const sheets = await createReadOnlySheetsClient();
  const metadataResponse = await sheets.spreadsheets.get({ spreadsheetId, fields: METADATA_FIELDS });
  const metadata = metadataResponse.data as unknown as NativeBook;
  assertBook(metadata, spreadsheetId);
  const source = bounds(metadata, "案件リスト", CASE_LIST_SOURCE.sheetId, 65, 5001);
  const ledger = bounds(metadata, "案件_実績台帳", 2026102605, 25, 5005);
  const months = MONTHS.map(month => bounds(metadata, month.title, month.sheetId, month.width));
  const fullBounds = [source, ledger, ...months];
  const dependencyBounds = options.includeDependencies === true ? DEPENDENCIES.map(title => bounds(metadata, title)) : [];
  const fullRead = sheets.spreadsheets.get({ spreadsheetId, ranges: fullBounds.map(rangeFor), includeGridData: true, fields: cellFields(CELL_FIELDS) });
  const dependencyRead = dependencyBounds.length ? sheets.spreadsheets.get({ spreadsheetId, ranges: dependencyBounds.map(rangeFor), includeGridData: true, fields: cellFields(DEPENDENCY_FIELDS) }) : Promise.resolve(null);
  const [fullResponse, dependencyResponse] = await Promise.all([fullRead, dependencyRead]);
  const cells = fullResponse.data as unknown as NativeBook;
  assertBook(cells, spreadsheetId);
  // Explicit exact bounds distinguish omitted trailing empty cells from a
  // truncated read. Recheck every requested sheet after the metadata read.
  for (const bound of fullBounds) dense(cells, bound);
  const rawRows = dense(cells, source), rawLedgerRows = dense(cells, ledger);
  const inspected = inspectCaseList(rawRows, rawLedgerRows, new Date().toISOString(), spreadsheetId);
  const catalog = inspected.jobs.find(job => job.caseId === caseId)?.source;
  if (!catalog) stopped("MONTHLY_READER_SOURCE_NOT_FOUND");
  let dependencyHash = hashCaseList(null);
  if (dependencyResponse) {
    const dependencyCells = dependencyResponse.data as unknown as NativeBook;
    assertBook(dependencyCells, spreadsheetId);
    dependencyHash = hashCaseList(dependencyBounds.map(bound => ({
      sheetId: bound.sheetId, title: bound.title, rowCount: bound.rowCount, columnCount: bound.columnCount,
      cells: dense(dependencyCells, bound).map(row => row.map(cell => ({ userEnteredValue: cell.userEnteredValue ?? {}, effectiveValue: cell.effectiveValue ?? {} }))),
    })));
  }
  const snapshot = adapter.snapshotFromNative({
    metadata,
    cells: { ...cells, requestedCellFields: CELL_FIELDS, requestedRanges: fullBounds.map(bound => ({ sheetId: bound.sheetId, startRow: 0, rowCount: bound.rowCount, startColumn: 0, columnCount: bound.columnCount })), requestedMonthTitles: MONTHS.map(month => month.title) },
    dependencyHash, catalog,
    resolveStaff: options.resolveStaff ?? (() => null),
  });
  return { ...snapshot, rawRows, rawLedgerRows };
}
