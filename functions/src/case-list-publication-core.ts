import { createHash } from "node:crypto";
import { createJobIdFromPersistedCaseId } from "./case-id";
import { assertCaseListJobBinding, canonical, configuredCaseListSource, confirmedCaseListCandidate, hashCaseList, inspectCaseList, type CaseListSource } from "./case-list-source-core";

type Data = Record<string, any>;
const controller = require("../src/case-list-monthly-controller.cjs") as {
  assertSnapshotCoverage(snapshot: unknown, caseId: string, services: { sha256(text: string): string }): void;
  transferCapability(snapshot: unknown, row: unknown): { supported: boolean };
  checkPromisedPay(row: unknown, assignment: unknown): void;
};
const WRITABLE = ["userEnteredValue", "note", "userEnteredFormat", "dataValidation", "textFormatRuns", "chipRuns"];
const need = (ok: unknown, reason: string): void => { if (!ok) throw Error(reason); };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const values = (cells: Data[]) => cells.map(cell => ({ userEnteredValue: cell.userEnteredValue ?? {}, effectiveValue: cell.effectiveValue ?? {} }));
const writable = (cells: Data[]) => cells.map(cell => Object.fromEntries(WRITABLE.filter(key => Object.hasOwn(cell, key)).map(key => [key, cell[key]])));
const nativeString = (cell: Data, text: string) => canonical(cell.userEnteredValue ?? {}) === canonical({ stringValue: text }) && canonical(cell.effectiveValue ?? {}) === canonical({ stringValue: text });
const nativeBlank = (cell: Data) => [cell.userEnteredValue ?? {}, cell.effectiveValue ?? {}].every(value => Object.entries(value).every(([key, text]) => key === "stringValue" && text === ""));
function selected(snapshot: Data, caseId: string): Data {
  controller.assertSnapshotCoverage(snapshot, caseId, { sha256: text => createHash("sha256").update(text).digest("hex") });
  const matches = snapshot.source.rows.filter((row: Data) => row.caseId === caseId);
  need(matches.length === 1 && matches[0].fullWritable === true && matches[0].cells.length === 65, "PUBLICATION_SOURCE_COVERAGE_REQUIRED");
  return matches[0];
}
function check(snapshot: Data, confirmation: Data, actorUid: string, nowISO: string) {
  controller.checkPromisedPay(selected(snapshot, snapshot.catalog.caseId), { authority: "CREW_QUEUE", publicPayOffer: confirmation.payOffer });
  const candidate = confirmedCaseListCandidate(snapshot.rawRows, snapshot.rawLedgerRows, snapshot.catalog.caseId, confirmation as any, nowISO, actorUid, snapshot.spreadsheetId);
  const pay = candidate.payOffer as Data;
  return { candidate, jobFields: { dateKey: candidate.date, workDate: candidate.date, clientName: candidate.client, storeName: candidate.store, makerName: candidate.manufacturer, menuName: candidate.menu, entryTime: candidate.arrival, workTime: candidate.execution, region: candidate.region },
    source: snapshot.catalog as CaseListSource, approval: { ...confirmation, actorUid }, observedAt: nowISO, basePay: pay.dailyWageJPY };
}
export function assertPublicationControlValidation(cell: Data, nextValue: string): void {
  if (cell.dataValidation == null) return;
  const condition = cell.dataValidation.condition;
  need(condition?.type === "ONE_OF_LIST" && Array.isArray(condition.values) && condition.values.length > 0 && condition.values.length <= 500 &&
    condition.values.every((value: Data) => typeof value?.userEnteredValue === "string") && condition.values.some((value: Data) => value.userEnteredValue === nextValue), "PUBLICATION_CONTROL_VALIDATION_UNPROVEN");
}
export function prepareCaseListPublicationPlan(input: { snapshot: Data; companyId: string; jobId: string; job: Data; confirmation: Data; expectedJobRevision: number; expectedSourceRevision: string; nowISO: string }) {
  const { snapshot, companyId, jobId, job, confirmation, expectedJobRevision, expectedSourceRevision, nowISO } = input;
  const source = snapshot.catalog as CaseListSource;
  configuredCaseListSource(snapshot.spreadsheetId);
  need(source && source.spreadsheetId === snapshot.spreadsheetId && source.sourceRevision === expectedSourceRevision && job.companyId === companyId && Number.isSafeInteger(expectedJobRevision) && expectedJobRevision === job.revision, "PUBLICATION_REVISION_CHANGED");
  assertCaseListJobBinding(companyId, jobId, job, source, createJobIdFromPersistedCaseId);
  need(["draft", "stopped"].includes(job.status) && job.publishable !== true && job.cancelled !== true && !job.assignedStaffId && !job.assignedStaffName && !job.rawStaffName && !job.sheetRef && !job.caseListManualPending && !job.caseListManualSelection && !job.assignmentSheetWrite && !job.caseListPublicationWrite?.pending && job.pendingSourceWrite !== true && job.adminEditSheetWrite?.pending !== true && job.cancellationSheetWrite?.sourceAckPending !== true && job.sourceMissing !== true && job.assignmentUnresolved !== true && job.applicationUnconfirmed !== true, "PUBLICATION_JOB_NOT_UNASSIGNED_DRAFT");
  const row = selected(snapshot, source.caseId), cells = row.cells as Data[];
  need(nativeString(cells[55]!, "確認待ち") && nativeBlank(cells[56]!) && nativeBlank(cells[2]!), "PUBLICATION_CONTROL_PREIMAGE_REQUIRED");
  const region = confirmation.confirmedRegion;
  need(typeof region === "string" && region.length > 0 && region.length <= 100 && region === region.trim() && !/[\u0000-\u001f\u007f]/.test(region) && confirmation.expectedSourceRevision === source.sourceRevision, "PUBLICATION_REGION_REQUIRED");
  assertPublicationControlValidation(cells[55]!, "募集中");
  assertPublicationControlValidation(cells[56]!, region);
  need(canonical(cells[63]!.userEnteredValue ?? {}) === canonical({ boolValue: false }) && canonical(cells[63]!.effectiveValue ?? {}) === canonical({ boolValue: false }), "PUBLICATION_CANCELLED_OR_UNKNOWN");
  need(controller.transferCapability(snapshot, row).supported, "PUBLICATION_TRANSFER_NOT_SUPPORTED");
  controller.checkPromisedPay(row, { authority: "CREW_QUEUE", publicPayOffer: confirmation.payOffer });
  // Additional public conditions require a separate approved contract. Never
  // discard BM or label-specific AF:AJ amounts when opening a basic offer.
  need(nativeBlank(cells[64]!), "PUBLICATION_PUBLIC_NOTES_UNREVIEWED");
  for (const cell of cells.slice(31, 36)) {
    const raw = Object.hasOwn(cell.userEnteredValue ?? {}, "formulaValue") ? cell.effectiveValue : cell.userEnteredValue;
    need(Object.hasOwn(cell.userEnteredValue ?? {}, "formulaValue") ? raw?.numberValue === 0 : !raw || Object.entries(raw).every(([key, value]) => key === "numberValue" && value === 0 || key === "stringValue" && ["", "0"].includes(String(value))), "PUBLICATION_ADDITIONAL_PAY_UNREVIEWED");
  }
  // Copy only the selected full row. Other catalog rows remain read-only
  // references; preparation must not duplicate the bounded book in memory.
  const projectedRows = [...snapshot.rawRows] as Data[][];
  const targetIndex = projectedRows.findIndex(candidate => candidate[60]?.userEnteredValue?.stringValue === source.caseId);
  need(targetIndex >= 0, "PUBLICATION_SOURCE_ID_REQUIRED");
  const target = copy(projectedRows[targetIndex]!);
  projectedRows[targetIndex] = target;
  for (const [column, text] of [[55, "募集中"], [56, region]] as const) target![column] = { ...target![column], userEnteredValue: { stringValue: text }, effectiveValue: { stringValue: text } };
  const post = inspectCaseList(projectedRows, snapshot.rawLedgerRows, nowISO, snapshot.spreadsheetId).jobs.find(candidate => candidate.caseId === source.caseId)?.source;
  need(post && post.ledgerRevision === source.ledgerRevision, "PUBLICATION_LEDGER_CHANGED");
  const postConfirmation: Data = { ...copy(confirmation), expectedSourceRevision: post!.sourceRevision };
  // The projected copy is preparation only; it is never a native ACK or a
  // live approval. Finalization must run against real post-write reads.
  const prepared = check({ ...snapshot, rawRows: projectedRows, catalog: post }, postConfirmation, "OWNER_PREVIEW_ONLY", nowISO);
  const plan = { schema: "LK_CASE_LIST_PUBLICATION_PLAN_V1", companyId, jobId, caseId: source.caseId, beforeJobRevision: expectedJobRevision,
    preCatalog: copy(source), postCatalog: copy(post!), sourceRowHint: row.row, sourceBefore: writable(cells), sourceBeforeValues: values(cells), postSourceValues: values(target!),
    candidate: prepared.candidate, jobFields: prepared.jobFields, approval: postConfirmation };
  return { ...plan, reviewPlanHash: hashCaseList(plan) };
}
export function assertCaseListPublicationReadback(snapshot: Data, plan: ReturnType<typeof prepareCaseListPublicationPlan>) {
  const { reviewPlanHash, ...unhashed } = plan;
  need(hashCaseList(unhashed) === reviewPlanHash && plan.schema === "LK_CASE_LIST_PUBLICATION_PLAN_V1", "PUBLICATION_PLAN_CHANGED");
  const row = selected(snapshot, plan.caseId), cells = row.cells as Data[];
  need(controller.transferCapability(snapshot, row).supported, "PUBLICATION_READBACK_TRANSFER_NOT_SUPPORTED");
  need(canonical(snapshot.catalog) === canonical(plan.postCatalog) && snapshot.spreadsheetId === plan.preCatalog.spreadsheetId && snapshot.catalog.ledgerRevision === plan.preCatalog.ledgerRevision && canonical(values(cells)) === canonical(plan.postSourceValues), "PUBLICATION_READBACK_CHANGED");
  const afterWritable = writable(cells), expected = copy(plan.sourceBefore);
  expected[55]!.userEnteredValue = { stringValue: "募集中" };
  expected[56]!.userEnteredValue = { stringValue: plan.approval.confirmedRegion };
  need(canonical(afterWritable) === canonical(expected) && nativeString(cells[55]!, "募集中") && nativeString(cells[56]!, plan.approval.confirmedRegion), "PUBLICATION_READBACK_METADATA_CHANGED");
  return check(snapshot, plan.approval, "OWNER_ACK_ONLY", new Date().toISOString());
}

export function ownerPublicationPolicyHash(configured: string): string {
  return hashCaseList(configured.split(",").map(value => value.trim().toLowerCase()).filter(Boolean).sort());
}
