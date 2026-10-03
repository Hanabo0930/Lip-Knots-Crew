export type ExpectedValue = { mode:"any"|"blank"|"exact"; value?:unknown };
export type OperationConfig = { values:string[]; styles?:string[] };
export type MappingConfig = { columns:Record<string,string>; operations:Record<string,OperationConfig> };
export function validateMutation(mapping:MappingConfig,operation:string,updates:Record<string,unknown>,styles:Record<string,unknown>={}):string[]{
  const errors:string[]=[]; const op=mapping.operations[operation]; if(!op)return [`未許可の操作です: ${operation}`];
  for(const key of Object.keys(updates)){if(!op.values.includes(key))errors.push(`${operation}では${key}を更新できません`);if(!mapping.columns[key])errors.push(`${key}の列マッピングがありません`);}
  for(const key of Object.keys(styles)){if(!(op.styles??[]).includes(key))errors.push(`${operation}では${key}の書式を変更できません`);if(!mapping.columns[key])errors.push(`${key}の列マッピングがありません`);}
  return errors;
}
export function normalizeComparable(value:unknown):string{return String(value??"").normalize("NFKC").replace(/[\s　]+/g,"").trim();}
export function expectedMatches(current:unknown,expected?:ExpectedValue):boolean{if(!expected||expected.mode==="any")return true;if(expected.mode==="blank")return normalizeComparable(current)==="";return normalizeComparable(current)===normalizeComparable(expected.value);}
export function valuesEquivalent(a:unknown,b:unknown):boolean{return normalizeComparable(a)===normalizeComparable(b);}
export function columnToNumber(column:string):number{let n=0;for(const c of column.toUpperCase()){if(c<"A"||c>"Z")throw new Error(`不正な列: ${column}`);n=n*26+c.charCodeAt(0)-64;}return n;}

// 提出状態の新旧操作を、担当・日付・元タブ・案件版とともに識別する。
export function submissionSheetWriteIdentity(job: Record<string, unknown>): string {
  return JSON.stringify([job.companyId ?? null, cancellationSheetWriteIdentity(job), job.revision ?? 0]);
}

// 取消・復帰の作成時と実行時で、同じ案件・担当・勤務日・元タブを照合する。
export function cancellationSheetWriteIdentity(job: Record<string, unknown>): string {
  const sheet = job.sheetRef && typeof job.sheetRef === "object" ? job.sheetRef as Record<string, unknown> : {};
  return JSON.stringify([job.caseId ?? null, job.assignedStaffId ?? null, job.assignedStaffName ?? null,
    job.dateKey ?? null, job.workDate ?? null, sheet.spreadsheetId ?? null, sheet.sheetId ?? null, sheet.sheetName ?? null,
    ...(job.mailIntake ? [job.mailIntakeHold ?? null] : []), ...(job.mailTargetHold != null ? [job.mailTargetHold] : [])]);
}

/** Source-linked cancellation keeps its owned day lock until a later source read. */
export function cancellationSourceLinked(job: Record<string, unknown>): boolean {
  const source = job.source && typeof job.source === "object" ? job.source as Record<string, unknown> : {};
  return job.sheetRef != null || source.type === "google_sheets_readonly" || job.mailIntake != null || job.adminCreated === true;
}

export function cancellationSourceAckFields(job: Record<string, unknown>, ownsLock: boolean,
  requestedAtMs: number, expectedJobRevision: number): Record<string, unknown> {
  return ownsLock && cancellationSourceLinked(job) ? { sourceAckVersion: 1, sourceAckPending: true,
    sourceAckRequestedAtMs: requestedAtMs, sourceAckJobRevision: expectedJobRevision } : {};
}

export function cancellationSourceAckPending(job: Record<string, unknown>): boolean {
  const intent = job.cancellationSheetWrite as Record<string, unknown> | undefined;
  return intent?.sourceAckPending === true;
}

/** Only the exact cancelled, physically blank source row may release occupancy. */
export function importedCancellationSourceAck(old: Record<string, any> | undefined,
  incoming: { companyId: string; caseId: string; dateKey: string; workDate: string; rawStaffName: string;
    cancelled: boolean; status: string; sheetRef: { spreadsheetId: string; sheetId: number | null;
      sheetName: string; currentRow: number; caseIdColumn?: string } }, readStartedAtMs: number): boolean {
  const saved = old?.cancellationSheetWrite;
  if (saved?.sourceAckVersion === undefined && saved?.sourceAckPending === undefined) return false;
  const refuse = () => { throw new Error("取消後の原本で氏名空欄・取消状態・同じ案件を確認できません。勤務枠を保持して取込を停止しました。"); };
  if (saved?.sourceAckVersion !== 1 || typeof saved.sourceAckPending !== "boolean") refuse();
  if (!saved.sourceAckPending) return false;
  const sheet = old?.sheetRef;
  if (!old || old.cancelled !== true || old.status !== "cancelled" ||
    typeof old.assignedStaffId !== "string" || !old.assignedStaffId ||
    typeof saved.queueId !== "string" || !saved.queueId || !["job.cancel", "job.cancel.v2"].includes(saved.operation) ||
    !Number.isSafeInteger(saved.sourceAckRequestedAtMs) || saved.sourceAckRequestedAtMs < 0 ||
    !Number.isSafeInteger(readStartedAtMs) || readStartedAtMs <= saved.sourceAckRequestedAtMs ||
    !Number.isSafeInteger(saved.sourceAckJobRevision) || saved.sourceAckJobRevision !== old.revision ||
    saved.identity !== cancellationSheetWriteIdentity(old) || old.companyId !== incoming.companyId ||
    typeof old.caseId !== "string" || !old.caseId || old.caseId !== incoming.caseId ||
    old.dateKey !== incoming.dateKey || old.workDate !== incoming.workDate ||
    incoming.cancelled !== true || incoming.status !== "cancelled" || typeof incoming.rawStaffName !== "string" || incoming.rawStaffName.trim() ||
    !sheet || typeof sheet.spreadsheetId !== "string" || !sheet.spreadsheetId ||
    !Number.isSafeInteger(sheet.sheetId) || sheet.sheetId < 0 || typeof sheet.sheetName !== "string" || !sheet.sheetName ||
    sheet.spreadsheetId !== incoming.sheetRef.spreadsheetId || sheet.sheetId !== incoming.sheetRef.sheetId ||
    sheet.sheetName !== incoming.sheetRef.sheetName || sheet.caseIdColumn !== incoming.sheetRef.caseIdColumn ||
    (sheet.caseIdColumn === undefined && (!Number.isSafeInteger(sheet.currentRow) || sheet.currentRow < 1 || sheet.currentRow !== incoming.sheetRef.currentRow))) refuse();
  return true;
}

export class SheetCaseIdColumnError extends Error {}

/** 月別の明示設定だけを適用し、他月の設定や行番号から推測しない。 */
export function resolveSheetCaseIdColumn(defaultColumn: string | undefined, overrides: Record<string, string> | undefined, sheetName: string): string | undefined {
  if (overrides === undefined) return defaultColumn;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides) ||
      Object.entries(overrides).some(([name, column]) => !name.trim() || typeof column !== "string" || !/^[A-Z]{1,3}$/.test(column))) {
    throw new SheetCaseIdColumnError("月別の固定案件ID列設定が不正です。");
  }
  const column = Object.hasOwn(overrides, sheetName) ? overrides[sheetName] : defaultColumn;
  if (!column || !/^[A-Z]{1,3}$/.test(column)) throw new SheetCaseIdColumnError("対象月の固定案件ID列を確認できません。");
  return column;
}

export function extendSheetReadColumn(endColumn: string, caseIdColumn: string | undefined): string {
  return caseIdColumn && columnToNumber(caseIdColumn) > columnToNumber(endColumn) ? caseIdColumn : endColumn;
}

export function resolveSheetCaseIdMapping<T extends { idColumn?: string; caseIdColumnsBySheet?: Record<string, string>; columns: Record<string, string>; rowCreation?: { rowEndColumn?: string } }>(mapping: T, sheetName: string): T {
  if (mapping.caseIdColumnsBySheet === undefined) return mapping;
  const column = resolveSheetCaseIdColumn(mapping.idColumn, mapping.caseIdColumnsBySheet, sheetName)!;
  if (Object.entries(mapping.columns).some(([key, value]) => key !== "caseId" && value.toUpperCase() === column)) {
    throw new SheetCaseIdColumnError("固定案件ID列が業務入力列と重複しています。");
  }
  return { ...mapping, idColumn: column, columns: { ...mapping.columns, caseId: column },
    ...(mapping.rowCreation ? { rowCreation: { ...mapping.rowCreation,
      rowEndColumn: extendSheetReadColumn(mapping.rowCreation.rowEndColumn ?? column, column) } } : {}) };
}

export function assertSheetCaseIdColumn(savedColumn: unknown, currentColumn: string | undefined): void {
  if (savedColumn !== undefined && savedColumn !== currentColumn) {
    throw new SheetCaseIdColumnError("取込時と書戻しの固定案件ID列が一致しません。列設定を確認して再取込してください。");
  }
}
