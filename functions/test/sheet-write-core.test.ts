import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { expectedMatches, validateMutation, valuesEquivalent, columnToNumber, cancellationSourceLinked, cancellationSourceAckFields, cancellationSheetWriteIdentity, importedCaseListCancellationSourceAck } from "../src/sheet-write-core";
const mapping={columns:{staffName:"B",temperature:"G"},operations:{"job.assign":{values:["staffName"]},"precontact.submit":{values:["temperature"]}}};
assert.deepEqual(validateMutation(mapping,"job.assign",{staffName:"山田花子"}),[]);
assert.equal(validateMutation(mapping,"job.assign",{temperature:"36.2"}).length,1);
assert.equal(expectedMatches("",{mode:"blank"}),true);
assert.equal(expectedMatches("山田花子",{mode:"exact",value:"山田 花子"}),true);
assert.equal(valuesEquivalent(" 9：30 ","9:30"),true);
assert.equal(columnToNumber("BB"),54);
console.log("safe sheet write core tests passed");

const pendingCase = { caseId: "LKCASE_00000000-0000-0000-0000-000000000001", caseListSource: {
  version: 1, sheetId: 2026101601, caseId: "LKCASE_00000000-0000-0000-0000-000000000001",
  sourceRevision: "1".repeat(64), rowRevision: "2".repeat(64), ledgerRevision: "3".repeat(64), bindingHash: "4".repeat(64),
} };
assert.equal(cancellationSourceLinked(pendingCase), true);
assert.deepEqual(cancellationSourceAckFields(pendingCase, true, 123, 4),
  { sourceAckVersion: 1, sourceAckPending: true, sourceAckRequestedAtMs: 123, sourceAckJobRevision: 4 });
for (const patch of [{ version: 2 }, { sheetId: 99 }, { caseId: "other" }, { sourceRevision: "invalid" },
  { bindingHash: null }, { spreadsheetId: "must-stay-private" }]) {
  assert.throws(() => cancellationSourceLinked({ ...pendingCase, caseListSource: { ...pendingCase.caseListSource, ...patch } }));
}
assert.throws(() => cancellationSourceLinked({ ...pendingCase, source: { type: "case_list", sheetId: 2026101601, bindingHash: "5".repeat(64) } }));
assert.equal(cancellationSourceLinked({}), false);
console.log("Pending CaseList cancellation retains Source ACK lock; malformed or conflicting Source bindings hold.");


const canonicalRead = (value: any): string => value && typeof value === "object"
  ? Array.isArray(value) ? "[" + value.map(canonicalRead).join(",") + "]"
    : "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalRead(value[key])).join(",") + "}"
  : JSON.stringify(value);
const hashRead = (value: unknown): string => createHash("sha256").update(canonicalRead(value)).digest("hex");
const literalCell = (value: string | boolean) => {
  const data = typeof value === "boolean" ? { boolValue: value } : { stringValue: value };
  return { userEnteredValue: data, effectiveValue: { ...data } };
};
const cancelledPending: Record<string, any> = { ...pendingCase, companyId: "company", dateKey: "2026-11-20", workDate: "2026-11-20",
  status: "cancelled", cancelled: true, assignedStaffId: "staff", assignedStaffName: "raw-alias", assignedUid: null,
  revision: 4, sourceCancellationClosed: true, cancellationReason: "owner cancellation", cancelledBy: "owner",
  caseListManualPending: { staffId: "staff", dateKey: "2026-11-20", sourceRevision: pendingCase.caseListSource.sourceRevision, observationHash: "6".repeat(64) },
};
cancelledPending.cancellationSheetWrite = { queueId: "cancel-queue", operation: "job.cancel", identity: cancellationSheetWriteIdentity(cancelledPending),
  sourceAckVersion: 1, sourceAckPending: true, sourceAckRequestedAtMs: 123, sourceAckJobRevision: 4 };
const sourceRow: Record<string, any>[] = Array.from({ length: 65 }, () => ({}));
sourceRow[0] = literalCell(true); sourceRow[1] = literalCell("2026-11-20");
sourceRow[60] = literalCell(pendingCase.caseId); sourceRow[63] = literalCell(false);
const readObservation = { schema: "LK_CASE_LIST_CANCEL_SOURCE_READ_V1" as const, companyId: "company", jobId: "job-one", caseId: pendingCase.caseId,
  dateKey: "2026-11-20", workDate: "2026-11-20", source: { ...pendingCase.caseListSource }, rowCells: sourceRow,
  queue: { id: "cancel-queue", companyId: "company", jobId: "job-one", operation: "job.cancel", idempotencyKey: "job.cancel:job-one:cancel-queue", actorUid: "owner", updates: { cancelled: true, cancellationReason: "owner cancellation" } },
  dayLock: { companyId: "company", staffId: "staff", jobId: "job-one", dateKey: "2026-11-20", active: true },
};
const hashObservation = (read: typeof readObservation) => {
  read.source.rowRevision = hashRead({ schema: "LK_CASE_CONTENT_REVISION_V1", jobId: read.caseId,
    cells: read.rowCells.map(cell => ({ userEnteredValue: cell.userEnteredValue ?? {}, effectiveValue: cell.effectiveValue ?? {} })) });
  read.source.sourceRevision = hashRead({ schema: "LK_CASE_LIST_AUTHORITY_REVISION_V1", caseId: read.caseId,
    rowRevision: read.source.rowRevision, ledgerRevision: read.source.ledgerRevision });
};
hashObservation(readObservation);
assert.equal(importedCaseListCancellationSourceAck(cancelledPending, readObservation, 124, hashRead), true);
assert.equal(importedCaseListCancellationSourceAck({ ...cancelledPending, caseListManualSelection: { queueId: "selected" } }, readObservation, 124, hashRead), false);
assert.equal(importedCaseListCancellationSourceAck({ ...cancelledPending, sheetRef: { currentRow: 2 } }, readObservation, 124, hashRead), false);
for (const change of [
  (r: typeof readObservation) => { r.rowCells[0] = literalCell(false); },
  (r: typeof readObservation) => { r.rowCells[2] = literalCell("remaining raw-alias"); },
  (r: typeof readObservation) => { r.rowCells[2] = { userEnteredValue: { formulaValue: '=IF(TRUE,"", "alias")' }, effectiveValue: { stringValue: "" } }; },
  (r: typeof readObservation) => { r.rowCells[60] = literalCell("other-case"); },
  (r: typeof readObservation) => { r.rowCells[1] = literalCell("2026-11-21"); },
  (r: typeof readObservation) => { r.dayLock.jobId = "another-job"; },
  (r: typeof readObservation) => { r.dayLock.active = false; },
  (r: typeof readObservation) => { r.queue.id = "stale-queue"; },
  (r: typeof readObservation) => { r.queue.actorUid = "other-owner"; },
  (r: typeof readObservation) => { r.source.bindingHash = "7".repeat(64); },
]) {
  const next = JSON.parse(JSON.stringify(readObservation)); change(next); hashObservation(next);
  assert.throws(() => importedCaseListCancellationSourceAck(cancelledPending, next, 124, hashRead));
}
assert.throws(() => importedCaseListCancellationSourceAck(cancelledPending, readObservation, 123, hashRead));
assert.throws(() => importedCaseListCancellationSourceAck({ ...cancelledPending, revision: 5 }, readObservation, 124, hashRead));
const blOnly = JSON.parse(JSON.stringify(readObservation)); blOnly.rowCells[0] = literalCell(false); blOnly.rowCells[63] = literalCell(true); hashObservation(blOnly);
assert.equal(importedCaseListCancellationSourceAck(cancelledPending, blOnly, 124, hashRead), true);
console.log("Fresh preselection manual Source cancellation ACK validates literal cancellation/blank name, raw alias history, case/day/queue/lock identity and hashes; selected monthly work stays held.");
