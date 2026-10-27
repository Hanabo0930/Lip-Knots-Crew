import { createHash } from "node:crypto";

export type Cell = { userEnteredValue?: Record<string, unknown>; effectiveValue?: Record<string, unknown> };
export type CaseListSource = { version: 1; spreadsheetId: string; sheetId: number; caseId: string; sourceRevision: string; rowRevision: string; ledgerRevision: string };
export type CaseListConfirmation = { expectedSourceRevision: string; confirmedFields: { arrival: true; execution: true; headcount: true; dateMode: true; payOffer: true; vacancy: true }; payOffer: { dailyWageJPY: number; travelExpenses: "全額支給"; communicationExpenses: "全額支給" }; sourceReview?: { headcountPerSlot: 1; reviewedIssues: string[]; resolutionNote: string } };
export type CaseListJob = { caseId: string; source: CaseListSource; fields: Record<string, unknown>; holdReasons: string[]; ledgerLinked: boolean; reviewIssues: string[]; ownerReviewRequired: boolean };
const runtime = require("../src/case-list-projection.cjs") as {
  SOURCE: { sheetId: number; title: string; timeZone: string };
  create(input: { sha256: (text: string) => string; trustedSource: { spreadsheetId: string; sheetId: number; title: string; timeZone: string } }): { inspect(input: unknown): { sourceDigest: string; slots: Array<{ jobId: string; sourceRow: number; revision: string; holdReasons: string[]; publicCandidate: Record<string, unknown> | null }> } };
};
export const CASE_LIST_SOURCE = runtime.SOURCE;
export function configuredCaseListSource(spreadsheetId: unknown) {
  if (typeof spreadsheetId !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(spreadsheetId)) throw new Error("CASE_LIST_TRUSTED_BOOK_REQUIRED");
  return { ...CASE_LIST_SOURCE, spreadsheetId };
}
export const LEDGER_HEADERS = ["固定ID","実施日（保存）","会社（保存）","店舗表示（保存）","メーカー（保存）","内容（保存）","入店（保存）","実施時間（保存）","手配判定","確認済担当","募集の終了理由","確認の根拠","確認者","確認日時","募集期限日（任意）","備考","元Source状態","元取消","元Source担当","業務根拠JSON","元注意事項","内部店舗キー","保存日時","元revision","元Word現行"];
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  throw new Error("CASE_LIST_NON_CANONICAL");
}
export const hashCaseList = (value: unknown): string => createHash("sha256").update(canonical(value), "utf8").digest("hex");
export const caseListMonthlyContentHash = (cells: Cell[]): string => hashCaseList(cells.map(cell => Object.fromEntries(["userEnteredValue", "note", "userEnteredFormat", "dataValidation", "textFormatRuns", "chipRuns"].filter(key => Object.hasOwn(cell, key)).map(key => [key, (cell as Record<string, unknown>)[key]]))));
function value(cell?: Cell): unknown {
  const raw = cell?.userEnteredValue ?? {};
  const v = Object.hasOwn(raw, "formulaValue") ? cell?.effectiveValue ?? {} : raw;
  if (Object.hasOwn(v, "errorValue")) throw new Error("CASE_LIST_CELL_ERROR");
  return Object.values(v)[0] ?? "";
}
const text = (cell?: Cell): string => typeof value(cell) === "string" ? (value(cell) as string).trim() : "";
function date(cell?: Cell): string {
  const raw = value(cell);
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0 && raw < 2958466) return new Date(Date.UTC(1899, 11, 30) + raw * 86400000).toISOString().slice(0, 10);
  return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}
export function assertExecutive(token: Record<string, unknown>, configuredEmails: string): void {
  const emails = configuredEmails.split(",").map(email => email.trim().toLowerCase()).filter(Boolean);
  if (token.role !== "admin" || token.email_verified !== true || typeof token.email !== "string" || !emails.includes(token.email.toLowerCase())) throw new Error("CASE_LIST_EXECUTIVE_REQUIRED");
}
export function inspectCaseList(rows: Cell[][], ledgerRows: Cell[][], nowISO: string, spreadsheetId: string): { jobs: CaseListJob[]; digest: string } {
  const trustedSource = configuredCaseListSource(spreadsheetId);
  const ledgerHeader = Array.isArray(ledgerRows) ? ledgerRows[2] : undefined;
  if (!ledgerHeader || canonical(ledgerHeader.map(text)) !== canonical(LEDGER_HEADERS)) throw new Error("CASE_LIST_LEDGER_HEADERS");
  const ledger = new Map<string, Cell[]>();
  for (const row of ledgerRows.slice(3)) {
    const id = text(row[0]);
    if (!id) { if (row.some(cell => value(cell) !== "")) throw new Error("CASE_LIST_LEDGER_ID_MISSING"); continue; }
    if (ledger.has(id.toLowerCase())) throw new Error("CASE_LIST_LEDGER_DUPLICATE");
    ledger.set(id.toLowerCase(), row);
  }
  const result = runtime.create({ sha256: text => createHash("sha256").update(text, "utf8").digest("hex"), trustedSource }).inspect({ source: trustedSource, rows, nowISO });
  const ids = new Set<string>();
  const jobs = result.slots.map(slot => {
    if (ids.has(slot.jobId.toLowerCase())) throw new Error("CASE_LIST_CASE_ID_COLLISION");
    ids.add(slot.jobId.toLowerCase());
    const row = rows[slot.sourceRow - 1], record = ledger.get(slot.jobId.toLowerCase());
    if (!row) throw new Error("CASE_LIST_SOURCE_ROW_MISSING");
    let sourceMetadata: Record<string, unknown> | null = null;
    try { sourceMetadata = JSON.parse(text(row[62])); } catch { /* Invalid source metadata is held by the projection. */ }
    const rawIssues = sourceMetadata?.issues;
    const reviewIssues = Array.isArray(rawIssues) && rawIssues.every(issue => typeof issue === "string" && issue.length <= 1000) && rawIssues.length <= 100 ? rawIssues as string[] : [];
    const holds = [...slot.holdReasons];
    if (rawIssues !== undefined && (!Array.isArray(rawIssues) || rawIssues.length > 100 || !rawIssues.every(issue => typeof issue === "string" && issue.length <= 1000))) holds.push("SOURCE_REVIEW_ISSUES_INVALID");
    if (!record) holds.push("ASSIGNMENT_LEDGER_RECORD_REQUIRED");
    let linked = false;
    if (record) {
      const status = text(record[8]), name = text(record[9]), reason = text(record[10]);
      if (name || reason || (status && !["未手配", "未手配・募集継続"].includes(status))) holds.push("ASSIGNMENT_LEDGER_HOLD");
      try {
        const metadata = JSON.parse(text(record[19]));
        if (metadata?.schema !== "LK_HISTORY_CORE_SNAPSHOT_V1" || metadata.caseId !== slot.jobId) throw new Error();
        linked = metadata.monthly !== null && metadata.monthly !== undefined;
        if (linked) holds.push("EXISTING_MONTHLY_LINK");
      } catch { holds.push("ASSIGNMENT_LEDGER_METADATA_REQUIRED"); }
    }
    const ledgerRevision = hashCaseList(record ? record.map(cell => ({ userEnteredValue: cell.userEnteredValue ?? {}, effectiveValue: cell.effectiveValue ?? {} })) : null);
    const sourceRevision = hashCaseList({ schema: "LK_CASE_LIST_AUTHORITY_REVISION_V1", caseId: slot.jobId, rowRevision: slot.revision, ledgerRevision });
    const source: CaseListSource = { version: 1, spreadsheetId: trustedSource.spreadsheetId, sheetId: runtime.SOURCE.sheetId, caseId: slot.jobId, sourceRevision, rowRevision: slot.revision, ledgerRevision };
    return { caseId: slot.jobId, source, ledgerLinked: linked, holdReasons: [...new Set(holds)], reviewIssues, ownerReviewRequired: sourceMetadata?.publicEligible !== true || sourceMetadata?.headcountConfirmed !== true, fields: {
      dateKey: date(row[1]), workDate: date(row[1]), clientName: text(row[10]), storeName: text(row[11]), makerName: text(row[12]), menuName: text(row[13]), entryTime: text(row[14]), workTime: text(row[15]), region: text(row[56]),
    } };
  });
  return { jobs, digest: hashCaseList(jobs.map(job => ({ caseId: job.caseId, sourceRevision: job.source.sourceRevision }))) };
}
export function confirmedCaseListCandidate(rows: Cell[][], ledgerRows: Cell[][], caseId: string, confirmation: CaseListConfirmation, nowISO: string, actorUid: string, spreadsheetId: string): Record<string, unknown> {
  const trustedSource = configuredCaseListSource(spreadsheetId);
  const inspected = inspectCaseList(rows, ledgerRows, nowISO, spreadsheetId);
  const job = inspected.jobs.find(job => job.caseId === caseId);
  if (!job || job.source.sourceRevision !== confirmation.expectedSourceRevision || !actorUid.trim()) throw new Error("CASE_LIST_SOURCE_CHANGED");
  if (job.holdReasons.some(reason => /LEDGER|MONTHLY_LINK|SOURCE_REVIEW_ISSUES_INVALID/.test(reason)) || confirmation.confirmedFields?.vacancy !== true) throw new Error("CASE_LIST_ASSIGNMENT_RECONCILIATION_REQUIRED");
  const review = confirmation.sourceReview;
  if (review && (review.headcountPerSlot !== 1 || canonical(review.reviewedIssues) !== canonical(job.reviewIssues) || typeof review.resolutionNote !== "string" || review.resolutionNote.trim().length < 3)) throw new Error("CASE_LIST_SOURCE_REVIEW_CHANGED");
  const output = runtime.create({ sha256: text => createHash("sha256").update(text, "utf8").digest("hex"), trustedSource }).inspect({ source: trustedSource, rows, nowISO, approvals: [{ schema: "LK_CASE_PUBLIC_APPROVAL_V1", jobId: caseId, approved: true, expectedRevision: job.source.rowRevision, ownerApprovalRef: actorUid, confirmedFields: confirmation.confirmedFields, payOffer: confirmation.payOffer, ...(review ? { sourceReview: { ...review, schema: "LK_CASE_SOURCE_REVIEW_V1", expectedRevision: job.source.rowRevision } } : {}) }] });
  const candidate = output.slots.find(slot => slot.jobId === caseId)?.publicCandidate;
  if (!candidate) throw new Error("CASE_LIST_PUBLIC_FIELDS_UNCONFIRMED");
  return candidate;
}
export function assertCaseListJobBinding(companyId: string, jobId: string, job: Record<string, unknown>, source: CaseListSource, createJobId: (companyId: string, caseId: string) => string): void {
  const saved = job.caseListSource as Partial<CaseListSource> | undefined;
  if (job.companyId !== companyId || job.caseId !== source.caseId || jobId !== createJobId(companyId, source.caseId) || saved?.sourceRevision !== source.sourceRevision || saved.spreadsheetId !== source.spreadsheetId || saved.sheetId !== source.sheetId) throw new Error("CASE_LIST_JOB_SOURCE_CHANGED");
}
