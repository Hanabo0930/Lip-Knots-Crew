import { db } from "./firebase";
import { createReadOnlySheetsClient } from "./sheet-reader";
import { HttpsError } from "firebase-functions/v2/https";
import { configuredCaseListSource, hashCaseList, inspectCaseList, type Cell } from "./case-list-source-core";

type StaffIdentity = { staffId: string; identityVerified: boolean };
type Options = { includeDependencies?: boolean; resolveStaff?: (name: string) => StaffIdentity | null };
type NativeRead = { request: { spreadsheetId: string; ranges: string[]; includeGridData: boolean; fields: string }; response: unknown };
type CompactRow = { row: number; cells: Cell[]; knownColumns: number[]; fullWritable: boolean; caseId?: string; fixedId?: string; staffId?: string; staffIdentityVerified?: boolean };
type CompactTable = { sheetId: number; title: string; rowCount: number; columnCount: number; headers: string[]; rows: CompactRow[]; isolated?: boolean };
type CompactSnapshot = {
  spreadsheetId: string; isolated: false; source: CompactTable; months: CompactTable[]; dependencyHash: string;
  catalog: ReturnType<typeof inspectCaseList>["jobs"][number]["source"];
  coverage: Record<string, unknown>; rawRows: Cell[][]; rawLedgerRows: Cell[][];
  selectedRows: { source: number; ledger: number | null; destinations: Array<{ sheetId: number; row: number }> };
};
const compact = require("../src/case-list-monthly-compact.cjs") as {
  VALUE_FIELDS: string[]; FULL_FIELDS: string[];
  createIndexRanges(metadata: unknown): string[];
  createDependencyPlans(metadata: unknown): Array<{ title: string; range: string }>;
  createDependencyEvidence(input: { metadata: unknown; reads: NativeRead[]; title: string }): Record<string, unknown>;
  inspectCompactIndex(input: { metadata: unknown; indexReads: NativeRead[]; caseId: string }): { fullRanges: string[]; ledgerRange: string | null };
  createCompactSnapshot(input: { metadata: unknown; indexReads: NativeRead[]; fullReads: NativeRead[]; valueReads: NativeRead[]; caseId: string; includeDependencies: boolean; dependencyEvidence: Record<string, unknown>[]; resolveStaff: (name: string) => StaffIdentity | null }): CompactSnapshot;
};
const METADATA_FIELDS = "spreadsheetId,properties.timeZone,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))";
export type GasTransferMonthRead = {
  spreadsheetId: string; sheetId: number; title: string; rowCount: number; columnCount: number;
  rowData: Array<{ values?: Array<Record<string, any>> }>;
};
const cellFields = (fields: string[]): string => `spreadsheetId,properties.timeZone,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData.values(${fields.join(",")})))`;
function stopped(reason: string): never { throw new HttpsError("failed-precondition", "案件リストと月別の固定ID・読取範囲・構造を確認できません。元の値を保持して停止しました。", { reason }); }
function checked<T>(task: () => T): T {
  try { return task(); }
  catch (error) { stopped(error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "COMPACT_SNAPSHOT_INVALID"); }
}

/** Read only the global identity/structure indexes and selected full rows.
 * Unknown cells remain explicitly unknown; this is not a full-book snapshot.
 * Physical source/ledger rows come from fresh ID indexes, never row hints.
 * A fresh read does not make Sheets and Firestore one atomic transaction.
 */
export async function readCaseListMonthlySnapshot(companyId: string, caseId: string, options: Options = {}): Promise<CompactSnapshot & { observedAt: string }> {
  if (!companyId || companyId.includes("/") || !/^LKCASE_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(caseId)) stopped("COMPACT_REQUEST_INVALID");
  const config = (await db.collection("sheetImportConfigs").doc(companyId).get()).data();
  if (!config || config.companyId !== companyId || config.caseListEnabled !== true) stopped("COMPACT_CONFIG_DISABLED");
  const spreadsheetId = checked(() => configuredCaseListSource(config.spreadsheetId).spreadsheetId);
  const sheets = await createReadOnlySheetsClient();
  const metadata = (await sheets.spreadsheets.get({ spreadsheetId, fields: METADATA_FIELDS })).data;
  if (metadata.spreadsheetId !== spreadsheetId) stopped("COMPACT_CONFIG_RESPONSE_BOOK_MISMATCH");
  const read = async (ranges: string[], fields: string[]): Promise<NativeRead> => {
    const request = { spreadsheetId, ranges, includeGridData: true, fields: cellFields(fields) };
    const response = (await sheets.spreadsheets.get(request)).data;
    return { request, response };
  };
  const indexRead = await read(checked(() => compact.createIndexRanges(metadata)), compact.VALUE_FIELDS);
  const plan = checked(() => compact.inspectCompactIndex({ metadata, indexReads: [indexRead], caseId }));
  const includeDependencies = options.includeDependencies === true;
  const dependencyPlans = includeDependencies ? checked(() => compact.createDependencyPlans(metadata)) : [];
  const [fullRead, valueRead] = await Promise.all([
    read(plan.fullRanges, compact.FULL_FIELDS),
    plan.ledgerRange ? read([plan.ledgerRange], compact.VALUE_FIELDS) : Promise.resolve(null),
  ]);
  const dependencyEvidence: Record<string, unknown>[] = [];
  for (const plan of dependencyPlans) {
    const evidenceRead = await read([plan.range], compact.VALUE_FIELDS);
    dependencyEvidence.push(checked(() => compact.createDependencyEvidence({ metadata, reads: [evidenceRead], title: plan.title })));
  }
  const snapshot = checked(() => compact.createCompactSnapshot({ metadata, indexReads: [indexRead], fullReads: [fullRead], valueReads: valueRead ? [valueRead] : [], caseId, includeDependencies, dependencyEvidence, resolveStaff: options.resolveStaff ?? (() => null) }));
  const observedAt = new Date().toISOString();
  // Reuse the existing authority implementation on selected evidence only.
  // Global ID uniqueness was separately proven by the complete compact index.
  const selected = checked(() => inspectCaseList(snapshot.rawRows, snapshot.rawLedgerRows, observedAt, spreadsheetId)).jobs.find(job => job.caseId === caseId);
  if (!selected || hashCaseList(selected.source) !== hashCaseList(snapshot.catalog)) stopped("COMPACT_AUTHORITY_IMPLEMENTATION_MISMATCH");
  return { ...snapshot, catalog: selected.source, observedAt };
}

/** Use the exact GAS monthRows read profile without inventing trailing rows.
 * Cross-check every field consumed by monthRows against the complete compact
 * identity/layout indexes. A concurrent change holds selection; it is not a
 * reason to discard an original request or create a replacement receipt.
 */
export async function readGasTransferMonthPlan(snapshot: CompactSnapshot, dateKey: string): Promise<GasTransferMonthRead> {
  const title = dateKey.slice(0, 4) + "." + Number(dateKey.slice(5, 7));
  const matches = snapshot.months.filter(m => m.title === title), month = matches[0];
  if (matches.length !== 1 || !month || month.rowCount < 2) stopped("GAS_MONTH_TARGET_REQUIRED");
  configuredCaseListSource(snapshot.spreadsheetId);
  const range = "'" + title.replace(/'/g, "''") + "'!A2:O" + month.rowCount;
  const sheets = await createReadOnlySheetsClient();
  const response = (await sheets.spreadsheets.get({ spreadsheetId: snapshot.spreadsheetId, ranges: [range], includeGridData: true,
    fields: cellFields(["effectiveValue", "userEnteredValue"]) })).data;
  const sheet = response.sheets?.[0], shape = sheet?.properties, blocks = sheet?.data;
  if (response.spreadsheetId !== snapshot.spreadsheetId || response.properties?.timeZone !== "Asia/Tokyo" ||
    response.sheets?.length !== 1 || shape?.sheetId !== month.sheetId || shape.title !== month.title ||
    shape.gridProperties?.rowCount !== month.rowCount || shape.gridProperties?.columnCount !== month.columnCount ||
    blocks?.length !== 1 || (blocks[0]!.startRow ?? 0) !== 1 || (blocks[0]!.startColumn ?? 0) !== 0) stopped("GAS_MONTH_RESPONSE_SCOPE_CHANGED");
  const rowData = blocks![0]!.rowData ?? [];
  if (!Array.isArray(rowData) || rowData.length > month.rowCount - 1) stopped("GAS_MONTH_RESPONSE_ROWS_INVALID");
  const byRow = new Map(month.rows.map(row => [row.row, row]));
  const fields = (c: { userEnteredValue?: unknown; effectiveValue?: unknown } | null | undefined) => [c?.userEnteredValue ?? {}, c?.effectiveValue ?? {}];
  for (let i = 0; i < month.rowCount - 1; i++) {
    const cells = rowData[i]?.values ?? [], indexed = byRow.get(i + 2);
    if (!Array.isArray(cells) || cells.length > 15 || !indexed ||
      cells.some(c => !c || typeof c !== "object" || Array.isArray(c) || c.effectiveValue?.errorValue)) stopped("GAS_MONTH_RESPONSE_CELLS_INVALID");
    for (const col of [0, 1, 9, 10, 11, 12, 13, 14]) {
      if (!indexed!.knownColumns.includes(col) || hashCaseList(fields(cells[col])) !== hashCaseList(fields(indexed!.cells[col]))) stopped("GAS_MONTH_INDEX_CHANGED");
    }
  }
  return { spreadsheetId: snapshot.spreadsheetId, sheetId: month.sheetId, title: month.title,
    rowCount: month.rowCount, columnCount: month.columnCount, rowData };
}

/** Read-only external-origin reconciliation. Unlike the native reader this
 * proves Source absence; native callers retain their original strict path. */
export async function readArchivedCaseListSnapshot(companyId: string, caseId: string) {
  if (!companyId || companyId.includes("/") || !/^LKCASE_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(caseId)) stopped("ARCHIVED_REQUEST_INVALID");
  const config = (await db.collection("sheetImportConfigs").doc(companyId).get()).data();
  if (!config || config.companyId !== companyId || config.caseListEnabled !== true) stopped("ARCHIVED_CONFIG_DISABLED");
  const spreadsheetId = configuredCaseListSource(config.spreadsheetId).spreadsheetId, sheets = await createReadOnlySheetsClient();
  const readStartedAt = Date.now();
  const metadata = (await sheets.spreadsheets.get({ spreadsheetId, fields: METADATA_FIELDS })).data;
  if (metadata.spreadsheetId !== spreadsheetId) stopped("ARCHIVED_BOOK_MISMATCH");
  const read = async (ranges: string[]) => {
    const request = { spreadsheetId, ranges, includeGridData: true, fields: cellFields([...compact.FULL_FIELDS, "effectiveFormat"]) };
    const response = (await sheets.spreadsheets.get(request)).data;
    return { request, response };
  };
  const indexRequest = { spreadsheetId, ranges: checked(() => compact.createIndexRanges(metadata)), includeGridData: true, fields: cellFields(compact.VALUE_FIELDS) };
  const indexRead = { request: indexRequest, response: (await sheets.spreadsheets.get(indexRequest)).data };
  const archive = compact as unknown as {
    inspectArchivedCompactIndex(input: unknown): { fullRanges: string[] };
    createArchivedCompactSnapshot(input: unknown): Record<string, any>;
  };
  const plan = checked(() => archive.inspectArchivedCompactIndex({ metadata, indexReads: [indexRead], caseId }));
  const fullRead = await read(plan.fullRanges);
  const snapshot = checked(() => archive.createArchivedCompactSnapshot({ metadata, indexReads: [indexRead], fullReads: [fullRead], caseId }));
  return { ...snapshot, readStartedAt, observedAt: Date.now() };
}

