import { caseListPublicationPending } from "./case-list-publication-state";
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
  const caseList = job.caseListSource && typeof job.caseListSource === "object" ? job.caseListSource as Record<string, unknown> : null;
  return JSON.stringify([job.caseId ?? null, job.assignedStaffId ?? null, job.assignedStaffName ?? null,
    job.dateKey ?? null, job.workDate ?? null, caseList ? caseList.bindingHash ?? null : sheet.spreadsheetId ?? null, sheet.sheetId ?? null, sheet.sheetName ?? null,
    ...(job.mailIntake ? [job.mailIntakeHold ?? null] : []), ...(job.mailTargetHold != null ? [job.mailTargetHold] : [])]);
}

/** Source-linked cancellation keeps its owned day lock until a later source read. */
export function cancellationSourceLinked(job: Record<string, unknown>): boolean {
  const source = job.source && typeof job.source === "object" ? job.source as Record<string, unknown> : {};
  let caseListLinked = false;
  if (job.caseListSource != null) {
    const linked = job.caseListSource && typeof job.caseListSource === "object" && !Array.isArray(job.caseListSource)
      ? job.caseListSource as Record<string, unknown> : {};
    const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    // Pending Source C already contains a name before a monthly sheetRef exists.
    // Never release its lock by mistaking that absence for an unlinked job.
    caseListLinked = linked.version === 1 && linked.sheetId === 2026101601 &&
      typeof job.caseId === "string" && /^LKCASE_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(job.caseId) &&
      linked.caseId === job.caseId && [linked.sourceRevision, linked.rowRevision, linked.ledgerRevision, linked.bindingHash].every(hash) &&
      !Object.hasOwn(linked, "spreadsheetId");
    if (!caseListLinked || source.type != null && (source.type !== "case_list" || source.sheetId !== linked.sheetId || source.bindingHash !== linked.bindingHash)) {
      throw new Error("案件リストの取消元を確認できません。勤務枠と履歴を保持して停止しました。");
    }
  }
  return caseListLinked || job.sheetRef != null || source.type === "google_sheets_readonly" || job.mailIntake != null || job.adminCreated === true;
}

export function cancellationSourceAckFields(job: Record<string, unknown>, ownsLock: boolean,
  requestedAtMs: number, expectedJobRevision: number, capture?: Record<string, unknown> | null): Record<string, unknown> {
  const unassigned = isUnassignedSourceCancellation(capture) && sourceCancellationUnassigned(job) &&
    capture!.companyId === job.companyId && capture!.caseId === job.caseId && capture!.identity === cancellationSheetWriteIdentity(job) &&
    capture!.beforeJobRevision === job.revision && capture!.cancelledJobRevision === expectedJobRevision;
  return (ownsLock || unassigned) && cancellationSourceLinked(job) ? { sourceAckVersion: 1, sourceAckPending: true,
    sourceAckRequestedAtMs: requestedAtMs, sourceAckJobRevision: expectedJobRevision } : {};
}

/** A distinct server-owned mode; a malformed assigned V1 is never unassigned. */
export function isUnassignedSourceCancellation(value: unknown): boolean {
  const capture = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return capture.schema === "LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V2" && capture.assignmentMode === "UNASSIGNED_SOURCE";
}
export function sourceCancellationUnassigned(job: Record<string, any>): boolean {
  return job.assignedStaffId == null && job.assignedUid == null && (job.assignedStaffName == null || job.assignedStaffName === "") &&
    (job.rawStaffName == null || job.rawStaffName === "") && job.assignmentSheetWrite == null && job.caseListManualPending == null &&
    job.caseListManualSelection == null && job.sheetRef == null && job.caseListMonthlyAck == null && job.applicationUnconfirmed !== true && job.assignmentUnresolved !== true;
}
export function sourceCancellationPublicationPointer(job: Record<string, any>): Record<string, unknown> | null {
  const pointer = job.caseListPublicationWrite;
  return pointer && typeof pointer === "object" && !Array.isArray(pointer)
    ? Object.fromEntries(["queueId", "intentHash", "pending", "state", "ackHash"].filter(key => Object.hasOwn(pointer, key)).map(key => [key, pointer[key]])) : null;
}

/** Server-captured before cancellation clears the current assignment pointer.
 * This is evidence to inspect; it never authorizes a Source write by itself. */
export function captureCaseListSourceCancellation(job: Record<string, any>, jobId: string, queueId: string,
  actorUid: string, cancelledJobRevision: number): Record<string, unknown> | null {
  if (!job.caseListSource || job.sheetRef != null) return null;
  if (job.cancelled === true && job.cancellationSheetWrite?.caseListCancellation) {
    throw new Error("案件リストの取消結果を確認中です。結果の照合が終わるまで取消内容を変更できません。");
  }
  if (sourceCancellationUnassigned(job)) {
    const publicationPointer = sourceCancellationPublicationPointer(job);
    if (caseListPublicationPending(job) || job.sourceMissing === true || job.pendingSourceWrite === true || job.adminEditSheetWrite?.pending === true || job.sourceCancellationClosed === true || job.cancellationSheetWrite != null ||
      !(job.status === "draft" && publicationPointer == null && job.publishable !== true ||
        job.status === "open" && publicationPointer?.state === "PUBLISHED" ||
        ["draft", "stopped"].includes(job.status) && publicationPointer?.state === "REVOKED")) {
      throw new Error("未割当案件の公開反映・取下げ・担当の状態を先に照合してください。取消指示は保存していません。");
    }
    return { schema: "LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V2", assignmentMode: "UNASSIGNED_SOURCE", companyId: job.companyId ?? null, jobId, queueId, actorUid,
      caseId: job.caseId ?? null, staffId: null, staffName: null, assignedUid: null, dateKey: job.dateKey ?? null, workDate: job.workDate ?? null,
      beforeJobRevision: job.revision ?? null, cancelledJobRevision, beforeStatus: job.status, identity: cancellationSheetWriteIdentity(job),
      source: Object.fromEntries(["version", "sheetId", "caseId", "sourceRevision", "rowRevision", "ledgerRevision", "bindingHash"].filter(key => Object.hasOwn(job.caseListSource, key)).map(key => [key, job.caseListSource[key]])),
      priorAssignment: null, manualPending: null, ownerSelected: false, publicationPointer };
  }
  if (job.assignedStaffId == null) throw new Error("未割当案件の担当・手配状態を確認できません。取消指示は保存していません。");
  const pick = (value: any, keys: string[]) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) : null;
  return {
    schema: "LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V1", companyId: job.companyId ?? null, jobId, queueId, actorUid,
    caseId: job.caseId ?? null, staffId: job.assignedStaffId ?? null, staffName: job.assignedStaffName ?? null,
    assignedUid: job.assignedUid ?? null, dateKey: job.dateKey ?? null, workDate: job.workDate ?? null,
    beforeJobRevision: job.revision ?? null, cancelledJobRevision, identity: cancellationSheetWriteIdentity(job),
    source: pick(job.caseListSource, ["version", "sheetId", "caseId", "sourceRevision", "rowRevision", "ledgerRevision", "bindingHash"]),
    priorAssignment: pick(job.assignmentSheetWrite, ["operation", "queueId", "identity", "sourceRevision", "assignedJobRevision", "pending"]),
    manualPending: pick(job.caseListManualPending, ["observationHash", "sourceRevision", "staffId", "dateKey", "canonicalStaffName"]),
    ownerSelected: job.caseListManualSelection != null || job.caseListMonthlyAck != null,
  };
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

/** Fresh Source readback for an imported manual name cancelled before owner
 * selection. This does not authorize or perform a Source/monthly write.
 * Selected/unknown monthly execution must keep its lock for a separate review. */
export function importedCaseListCancellationSourceAck(old: Record<string, any> | undefined,
  incoming: { schema: "LK_CASE_LIST_CANCEL_SOURCE_READ_V1"; companyId: string; jobId: string; caseId: string;
    dateKey: string; workDate: string; source: Record<string, any>; rowCells: Record<string, any>[];
    queue: Record<string, any>; dayLock: Record<string, any> | null | undefined },
  readStartedAtMs: number, hash: (value: unknown) => string): boolean {
  if (!old) return false;
  const saved = old.cancellationSheetWrite;
  // Native cancellation owns its immutable full-CellData before-image. The
  // legacy value-only importer must not bypass its strict after-image proof.
  if (saved && Object.hasOwn(saved, "caseListCancellation")) return false;
  if (saved?.sourceAckPending !== true || !old?.caseListManualPending || old.sheetRef != null ||
    old.caseListManualSelection != null || old.assignmentSheetWrite != null) return false;
  const refuse = (): never => { throw new Error("取消後の案件リストで氏名空欄・取消・同じ案件と勤務枠を確認できません。勤務枠を保持しました。"); };
  const source = old.caseListSource, pending = old.caseListManualPending, next = incoming.source;
  const queue = incoming.queue, day = incoming.dayLock, row = incoming.rowCells;
  const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (!cancellationSourceLinked(old) || !source || incoming.schema !== "LK_CASE_LIST_CANCEL_SOURCE_READ_V1" ||
    old.cancelled !== true || old.status !== "cancelled" || old.sourceCancellationClosed !== true ||
    typeof old.assignedStaffId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(old.assignedStaffId) || typeof old.assignedStaffName !== "string" || !old.assignedStaffName.trim() || old.assignedUid != null ||
    saved.sourceAckVersion !== 1 || typeof saved.queueId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(saved.queueId) ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(incoming.jobId) || typeof old.cancelledBy !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(old.cancelledBy) ||
    !["job.cancel", "job.cancel.v2"].includes(saved.operation) ||
    !Number.isSafeInteger(saved.sourceAckRequestedAtMs) || saved.sourceAckRequestedAtMs < 0 ||
    !Number.isSafeInteger(readStartedAtMs) || readStartedAtMs <= saved.sourceAckRequestedAtMs ||
    saved.sourceAckJobRevision !== old.revision || !Number.isSafeInteger(old.revision) ||
    saved.identity !== cancellationSheetWriteIdentity(old) ||
    old.companyId !== incoming.companyId || old.caseId !== incoming.caseId || old.dateKey !== incoming.dateKey || old.workDate !== incoming.workDate ||
    pending.staffId !== old.assignedStaffId || pending.dateKey !== old.dateKey || pending.sourceRevision !== source.sourceRevision || !digest(pending.observationHash) ||
    next?.version !== 1 || next.sheetId !== 2026101601 || next.caseId !== old.caseId || next.bindingHash !== source.bindingHash || next.ledgerRevision !== source.ledgerRevision ||
    ![next.sourceRevision, next.rowRevision, next.ledgerRevision, next.bindingHash].every(digest) || Object.hasOwn(next, "spreadsheetId") ||
    next.sourceRevision === source.sourceRevision || next.rowRevision === source.rowRevision ||
    queue?.id !== saved.queueId || queue.companyId !== old.companyId || queue.jobId !== incoming.jobId || queue.operation !== saved.operation ||
    queue.idempotencyKey !== `${saved.operation}:${incoming.jobId}:${saved.queueId}` || queue.actorUid !== old.cancelledBy ||
    queue.updates?.cancelled !== true || queue.updates?.cancellationReason !== old.cancellationReason ||
    !day || day.active !== true || day.companyId !== old.companyId || day.staffId !== old.assignedStaffId || day.dateKey !== old.dateKey || day.jobId !== incoming.jobId ||
    !Array.isArray(row) || row.length !== 65 || row.some(cell => !cell || typeof cell !== "object" || Array.isArray(cell) || cell.$unknown === true) ||
    row[60]?.userEnteredValue?.stringValue !== old.caseId || row[60]?.effectiveValue?.stringValue !== old.caseId) refuse();
  const nativeBoolean = (cell: Record<string, any>) => Object.keys(cell.userEnteredValue ?? {}).length === 1 &&
    typeof cell.userEnteredValue.boolValue === "boolean" && Object.keys(cell.effectiveValue ?? {}).length === 1 && cell.effectiveValue.boolValue === cell.userEnteredValue.boolValue;
  const blank = (value: Record<string, unknown>) => Object.keys(value).every(key => key === "stringValue") &&
    (value.stringValue === undefined || typeof value.stringValue === "string" && !value.stringValue.trim());
  // BL is the canonical Source cancellation flag. Legacy A is unrelated to
  // cancellation and cannot acknowledge it or prevent a valid BL readback.
  if (!nativeBoolean(row[63]!) || row[63]!.userEnteredValue.boolValue !== true ||
    !blank(row[2]!.userEnteredValue ?? {}) || !blank(row[2]!.effectiveValue ?? {})) refuse();
  const dateValue = Object.hasOwn(row[1]!.userEnteredValue ?? {}, "formulaValue") ? row[1]!.effectiveValue : row[1]!.userEnteredValue;
  const nativeDate = typeof dateValue?.numberValue === "number" && Number.isInteger(dateValue.numberValue) && dateValue.numberValue >= 0 && dateValue.numberValue < 2958466
    ? new Date(Date.UTC(1899, 11, 30) + dateValue.numberValue * 86400000).toISOString().slice(0, 10) : dateValue?.stringValue;
  if (nativeDate !== old.dateKey || next.rowRevision !== hash({ schema: "LK_CASE_CONTENT_REVISION_V1", jobId: old.caseId,
    cells: row.map(cell => ({ userEnteredValue: cell.userEnteredValue ?? {}, effectiveValue: cell.effectiveValue ?? {} })) }) ||
    next.sourceRevision !== hash({ schema: "LK_CASE_LIST_AUTHORITY_REVISION_V1", caseId: old.caseId, rowRevision: next.rowRevision, ledgerRevision: next.ledgerRevision })) refuse();
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

