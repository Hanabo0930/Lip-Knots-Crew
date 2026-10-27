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
