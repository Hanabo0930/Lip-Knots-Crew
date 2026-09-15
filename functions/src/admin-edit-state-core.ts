import { clientInputKeys, staffInputKeys, normalizeMoneyRecord } from "./job-management-core";
import { columnToNumber } from "./sheet-write-core";

export const adminEditTextKeys = ["clientName", "storeName", "makerName", "menuName", "entryTime", "workTime", "subcontractorName", "staffName"] as const;
export const adminEditMoneyKeys: readonly string[] = [...clientInputKeys, ...staffInputKeys];
export const adminEditKeys: readonly string[] = [...adminEditTextKeys, ...adminEditMoneyKeys];
export type EditSourceSnapshot = {
  version: 1; companyId: string; jobId: string; identity: string; readStartedAtMs: number;
  columns: Record<string, string>; values: Record<string, string>;
};
export function editSourceIdentity(job: Record<string, unknown>): string {
  const source = job.sheetRef as Record<string, unknown> | undefined;
  return JSON.stringify([job.companyId ?? null, job.caseId ?? null, job.dateKey ?? null,
    source?.spreadsheetId ?? null, source?.sheetId ?? null, source?.sheetName ?? null]);
}

/** 取込済みの行から編集可能な項目だけを保持し、メール・電話・事前連絡の値は複製しない。 */
export function captureEditSource(job: Record<string, unknown>, row: unknown[], columns: Record<string, unknown>, endColumn: string, readStartedAtMs = Date.now()): EditSourceSnapshot {
  const capturedColumns: Record<string, string> = {}, values: Record<string, string> = {};
  const end = columnToNumber(endColumn);
  for (const key of adminEditKeys) {
    const rawColumn = columns[key];
    if (typeof rawColumn !== "string" || !/^[A-Z]{1,3}$/i.test(rawColumn)) continue;
    const column = rawColumn.toUpperCase(), index = columnToNumber(column) - 1;
    // 未読の列を空欄と推測しない。
    if (index >= end) continue;
    const value = row[index];
    if (value != null && !["string", "number", "boolean"].includes(typeof value)) continue;
    capturedColumns[key] = column;
    values[key] = String(value ?? "");
  }
  if (typeof job.companyId !== "string" || typeof job.jobId !== "string") throw new Error("編集用の原本識別がありません");
  return { version: 1, companyId: job.companyId, jobId: job.jobId,
    identity: editSourceIdentity(job), readStartedAtMs, columns: capturedColumns, values };
}

export function selectEditSourceColumns(importColumns: Record<string, unknown>, mapping: Record<string, unknown> | undefined, spreadsheetId: string): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  for (const key of adminEditTextKeys) if (typeof importColumns[key] === "string") columns[key] = importColumns[key];
  if (mapping?.spreadsheetId === spreadsheetId && mapping.columns && typeof mapping.columns === "object") {
    const configured = mapping.columns as Record<string, unknown>;
    for (const key of adminEditMoneyKeys) if (typeof configured[key] === "string") columns[key] = configured[key];
  }
  return columns;
}

export function adminEditValueMatches(key: string, actual: unknown, expected: unknown): boolean {
  if (adminEditMoneyKeys.includes(key)) {
    const a = normalizeMoneyRecord({ [key]: actual }, adminEditMoneyKeys);
    const b = normalizeMoneyRecord({ [key]: expected }, adminEditMoneyKeys);
    return !a.errors.length && !b.errors.length && a.values[key] === b.values[key];
  }
  const text = (value: unknown) => String(value ?? "").normalize("NFKC").trim();
  return text(actual) === text(expected);
}

export function adminEditContext(job: Record<string, unknown>): string {
  return JSON.stringify([editSourceIdentity(job), job.assignedStaffId ?? null, job.assignedStaffName ?? null,
    job.status ?? null, job.cancelled === true, job.sourceMissing === true, job.assignmentUnresolved === true]);
}
export function currentAdminEditValues(job: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    if (!adminEditKeys.includes(key)) throw new Error("編集できない原本項目です");
    if (key === "staffName") values[key] = job.assignedStaffName ?? "";
    else if ((clientInputKeys as readonly string[]).includes(key)) values[key] = (job.clientChargeInputs as Record<string, unknown> | undefined)?.[key] ?? null;
    else if ((staffInputKeys as readonly string[]).includes(key)) values[key] = (job.staffPaymentInputs as Record<string, unknown> | undefined)?.[key] ?? null;
    else values[key] = job[key] ?? "";
  }
  return values;
}
export function editProjection(job: Record<string, unknown>, keys: string[]): string {
  const values = currentAdminEditValues(job, [...keys].sort());
  return JSON.stringify(values);
}
export type AdminEditIntent = {
  confirmedAtMs?: number; queueId: string | null; revision: number; actorUid: string; context: string; projection: string; pending: boolean;
  updates: Record<string, unknown>; expected: Record<string, { mode: "exact"; value: string }>;
  columns: Record<string, string>; missingSourceFields: string[];
};
export function prepareAdminEditIntent(input: {
  jobId: string; previous: Record<string, unknown>; next: Record<string, unknown>; requested: Record<string, unknown>;
  source?: EditSourceSnapshot; mapping?: Record<string, unknown>; enabled: boolean;
  queueId: string; revision: number; actorUid: string;
}): AdminEditIntent {
  const previous = input.previous.adminEditSheetWrite as AdminEditIntent | undefined;
  let updates = { ...input.requested };
  if (previous?.pending === true) {
    if (previous.context !== adminEditContext(input.previous) || previous.projection !== editProjection(input.previous, Object.keys(previous.updates))) {
      throw new Error("未反映の編集後に担当・案件内容が変わっています。元の変更内容を確認してください。");
    }
    updates = { ...previous.updates, ...updates };
  }
  const keys = Object.keys(updates);
  if (!keys.length || keys.some(key => !adminEditKeys.includes(key))) throw new Error("原本の編集項目が不正です。");
  const source = input.source, columns: Record<string, string> = {}, expected: AdminEditIntent["expected"] = {};
  const missing: string[] = [];
  const mapping = input.mapping?.columns as Record<string, unknown> | undefined;
  const operations = input.mapping?.operations as Record<string, { values?: string[] }> | undefined;
  if (source && (source.version !== 1 || source.companyId !== input.previous.companyId || source.jobId !== input.jobId || source.identity !== editSourceIdentity(input.previous))) {
    throw new Error("編集前の原本が別の案件・勤務日・タブを参照しています。");
  }
  for (const key of keys) {
    const column = source?.columns[key];
    if (!source || !column || !Object.hasOwn(source.values, key)) { missing.push(key); continue; }
    if (input.enabled && (mapping?.[key] !== column || !operations?.["job.admin_edit"]?.values?.includes(key))) {
      throw new Error("編集項目の列設定が原本確認時と一致しません。");
    }
    const value = source.values[key]!;
    if (previous?.pending === true && Object.hasOwn(previous.updates, key)) {
      const original = previous.expected[key];
      if (!original || (!adminEditValueMatches(key, value, original.value) && !adminEditValueMatches(key, value, previous.updates[key]))) {
        throw new Error("未反映の編集に対する原本値が変わっています。変更前後を確認してください。");
      }
    }
    columns[key] = column;
    expected[key] = { mode: "exact", value };
  }
  if (input.enabled && missing.length) throw new Error("編集前の原本値がありません。シフト取込と列設定を確認してください。");
  if (new Set(Object.values(columns)).size !== Object.keys(columns).length) throw new Error("異なる編集項目が同じ列を参照しています。");
  if (input.previous.sourceMissing === true || input.previous.assignmentUnresolved === true || input.previous.applicationUnconfirmed === true) {
    throw new Error("原本との手配照合を完了してから編集してください。");
  }
  return { queueId: input.enabled ? input.queueId : null, revision: input.revision, actorUid: input.actorUid,
    context: adminEditContext(input.next), projection: editProjection(input.next, keys), pending: true,
    updates, expected, columns, missingSourceFields: missing };
}

export function assertAdminEditCurrent(queueId: string, queue: Record<string, any>, job: Record<string, any>, mapping: Record<string, any>): void {
  if (queue.operation !== "job.admin_edit") return;
  const intent = job.adminEditSheetWrite as AdminEditIntent | undefined;
  if (!intent || intent.queueId !== queueId || intent.context !== adminEditContext(job) ||
      intent.projection !== editProjection(job, Object.keys(intent.updates)) || intent.actorUid !== queue.actorUid ||
      queue.dateKey !== job.dateKey || queue.idempotencyKey !== `job.admin_edit:${queue.jobId}:${queueId}` ||
      job.sourceMissing === true || job.assignmentUnresolved === true || job.applicationUnconfirmed === true) {
    throw new Error("管理者の編集・担当・勤務日が更新されています。最新の変更内容を確認してください。");
  }
  const stable = (value: Record<string, unknown> | undefined) => JSON.stringify(Object.entries(value ?? {}).sort(([a],[b]) => a.localeCompare(b)));
  if (stable(queue.updates) !== stable(intent.updates) || stable(queue.expected) !== stable(intent.expected) || Object.keys(queue.styles ?? {}).length || intent.missingSourceFields.length) {
    throw new Error("管理者編集の内容または変更前の確認値が現在の依頼と一致しません。");
  }
  const keys = Object.keys(intent.updates);
  if (!keys.length || keys.some(key => !adminEditKeys.includes(key) || intent.expected[key]?.mode !== "exact" ||
      !intent.columns[key] || mapping.columns?.[key] !== intent.columns[key]) ||
      new Set(keys.map(key => intent.columns[key])).size !== keys.length) throw new Error("管理者編集の列と確認条件が不正です。");
  if (Object.hasOwn(intent.updates, "staffName")) {
    if (intent.updates.staffName === "" ? Boolean(job.assignedStaffId) : job.status !== "assigned" || job.cancelled === true || queue.actorStaffId !== job.assignedStaffId) {
      throw new Error("担当変更の現在状態を確認できません。");
    }
  }
}

export function importedEditConfirmation(previous: Record<string, any> | undefined, incoming: Record<string, any>): boolean | null {
  const intent = previous?.adminEditSheetWrite as AdminEditIntent | undefined;
  if (!intent) return null;
  const source = incoming.editSourceSnapshot as EditSourceSnapshot | undefined;
  const current = intent.context === adminEditContext(previous!) && intent.projection === editProjection(previous!, Object.keys(intent.updates));
  const matches = current && source?.identity === editSourceIdentity(previous!) && Object.entries(intent.updates).every(([key,value]) =>
    source.columns[key] === intent.columns[key] && Object.hasOwn(source.values,key) && adminEditValueMatches(key,source.values[key],value));
  // 書戻し中に取得した古い表を、完了後の案件へ反映しない。
  if (!matches && !intent.pending && (!Number.isFinite(source?.readStartedAtMs) ||
      !Number.isFinite(intent.confirmedAtMs) || source!.readStartedAtMs <= intent.confirmedAtMs!)) {
    throw new Error("編集の完了前に読み始めた原本です。最新の表を再読込してください。");
  }
  if (intent.pending && !matches) throw new Error("管理者の未反映の編集とシフト表が一致しません。編集内容を保持して取込を停止しました。");
  return Boolean(matches);
}
export function sourceMoneyInputs(source: EditSourceSnapshot | undefined) {
  if (!source) return {};
  const result: Record<string, Record<string, number | null>> = {};
  for (const [group, keys] of [["clientChargeInputs", clientInputKeys], ["staffPaymentInputs", staffInputKeys]] as const) {
    const raw = Object.fromEntries(keys.filter(key => Object.hasOwn(source.values,key)).map(key => [key,source.values[key]]));
    const parsed = normalizeMoneyRecord(raw, keys);
    if (Object.keys(parsed.values).length) result[group] = parsed.values;
  }
  return result;
}

/** 取込で画面の編集対象が変わった場合は、古い画面の保存を拒否できる版を進める。 */
export function importedEditRevision(previous: Record<string, unknown> | undefined, next: Record<string, unknown>): number {
  if (!previous) return 0;
  const revision = previous.revision ?? 0;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new Error("案件の保存版を確認できません。");
  const changed = adminEditContext(previous) !== adminEditContext(next) || editProjection(previous, [...adminEditKeys]) !== editProjection(next, [...adminEditKeys]);
  return revision + (changed ? 1 : 0);
}