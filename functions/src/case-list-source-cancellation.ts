import { createHash, randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { google } from "googleapis";
import { db } from "./firebase";
import { createJobIdFromPersistedCaseId } from "./case-id";
import { cancellationSheetWriteIdentity, isUnassignedSourceCancellation, sourceCancellationUnassigned, sourceCancellationPublicationPointer } from "./sheet-write-core";
import { caseListPublicationPending } from "./case-list-publication-state";
import { assertExecutive, canonical, configuredCaseListSource, hashCaseList, publicCaseListSource, caseListBindingHash } from "./case-list-source-core";
import { readCaseListMonthlySnapshot } from "./case-list-monthly-reader";
import { assertKnownCaseListContinuation } from "./case-list-monthly-worker";
import { getProductionOperationalState } from "./system-safety";
import { cancellationReasonLabels, cancellationTreatmentLabels } from "./analytics-core";

type Data = FirebaseFirestore.DocumentData;
type Ref = FirebaseFirestore.DocumentReference;
type Tx = FirebaseFirestore.Transaction;
type Snapshot = Awaited<ReturnType<typeof readCaseListMonthlySnapshot>>;
const core = require("../src/case-list-monthly-controller.cjs") as { assertSnapshotCoverage(snapshot: unknown, caseId: string, services: { sha256(text: string): string }): void };
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const HASH = /^[a-f0-9]{64}$/;
const CASE = /^LKCASE_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WRITABLE = ["userEnteredValue", "note", "userEnteredFormat", "dataValidation", "textFormatRuns", "chipRuns"];
const STAGES = ["SOURCE_MANUAL_OBSERVED", "SOURCE_INTENT", "SOURCE_DISPATCHED", "SOURCE_PROJECTED", "INTENT", "MONTHLY_DISPATCHED", "SOURCE_UNKNOWN", "UNKNOWN", "SOURCE_DEFERRED", "DEFERRED", "SOURCE_WRITE_STARTED", "MONTHLY_WRITE_STARTED", "ACCEPTED"];
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const object = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function need(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(reason); }
const writable = (cells: Data[]) => cells.map(cell => Object.fromEntries(WRITABLE.filter(key => Object.hasOwn(cell, key)).map(key => [key, cell[key]])));
const fingerprint = (queue: Data): string => hashCaseList({ companyId: queue.companyId ?? null, jobId: queue.jobId ?? null, operation: queue.operation ?? null,
  actorUid: queue.actorUid ?? null, idempotencyKey: queue.idempotencyKey ?? null, updates: queue.updates ?? {}, expected: queue.expected ?? {}, styles: queue.styles ?? {}, caseListCancellation: queue.caseListCancellation ?? null });
function nativeString(cell: Data, value: string): boolean { return canonical(cell.userEnteredValue ?? {}) === canonical({ stringValue: value }) && canonical(cell.effectiveValue ?? {}) === canonical({ stringValue: value }); }
function nativeBool(cell: Data, value: boolean): boolean { return canonical(cell.userEnteredValue ?? {}) === canonical({ boolValue: value }) && canonical(cell.effectiveValue ?? {}) === canonical({ boolValue: value }); }
function blank(cell: Data): boolean {
  return [cell.userEnteredValue ?? {}, cell.effectiveValue ?? {}].every(value => Object.keys(value).every(key => key === "stringValue") && (value.stringValue === undefined || value.stringValue === ""));
}
function dateValue(cell: Data): string {
  const value = Object.hasOwn(cell.userEnteredValue ?? {}, "formulaValue") ? cell.effectiveValue : cell.userEnteredValue;
  return typeof value?.numberValue === "number" && Number.isInteger(value.numberValue) && value.numberValue >= 0 && value.numberValue < 2958466
    ? new Date(Date.UTC(1899, 11, 30) + value.numberValue * 86400000).toISOString().slice(0, 10) : value?.stringValue ?? "";
}

/** Current server documents only. A capture is an immutable pointer to proof,
 * never permission to ignore a selected or uncertain monthly operation. */
export function assertCaseListSourceCancellationAuthority(queueId: string, queue: Data, job: Data, config: Data, mapping: Data, day: Data, staff: Data, ownerReadOnly = false): { capture: Data; spreadsheetId: string } {
  const capture = object(queue.caseListCancellation), saved = object(job.cancellationSheetWrite), source = object(job.caseListSource);
  const unassigned = isUnassignedSourceCancellation(capture);
  need(ID.test(queueId) && ["job.cancel", "job.cancel.v2"].includes(queue.operation) && ID.test(queue.companyId ?? "") && ID.test(queue.jobId ?? "") && ID.test(queue.actorUid ?? ""), "SOURCE_CANCEL_QUEUE_INVALID");
  need((unassigned ? capture.staffId === null && capture.staffName === null && capture.assignedUid === null && capture.priorAssignment === null && capture.manualPending === null && ["draft", "open", "stopped"].includes(capture.beforeStatus) : capture.schema === "LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V1" && ID.test(capture.staffId ?? "") && typeof capture.staffName === "string" && capture.staffName.trim()) && capture.queueId === queueId && capture.jobId === queue.jobId && capture.companyId === queue.companyId && capture.actorUid === queue.actorUid &&
    CASE.test(capture.caseId ?? "") &&
    /^2026-(?:11|12)-\d{2}$/.test(capture.dateKey ?? "") && new Date(capture.dateKey + "T00:00:00Z").toISOString().slice(0, 10) === capture.dateKey && capture.workDate === capture.dateKey &&
    Number.isSafeInteger(capture.beforeJobRevision) && capture.beforeJobRevision >= 0 && capture.cancelledJobRevision === capture.beforeJobRevision + 1 &&
    capture.ownerSelected === false && canonical(saved.caseListCancellation ?? null) === canonical(capture), "SOURCE_CANCEL_CAPTURE_INVALID");
  need(config.companyId === queue.companyId && config.caseListEnabled === true && (ownerReadOnly || config.caseListAssignmentsEnabled === true) && mapping.enabled === true, "SOURCE_CANCEL_WRITER_DISABLED");
  const spreadsheetId = configuredCaseListSource(config.spreadsheetId).spreadsheetId;
  need(mapping.spreadsheetId === spreadsheetId && job.companyId === queue.companyId && job.caseId === capture.caseId && createJobIdFromPersistedCaseId(queue.companyId, capture.caseId) === queue.jobId &&
    source.version === 1 && source.sheetId === 2026101601 && source.caseId === capture.caseId && !Object.hasOwn(source, "spreadsheetId") &&
    [source.sourceRevision, source.rowRevision, source.ledgerRevision, source.bindingHash].every(value => typeof value === "string" && HASH.test(value)) && source.bindingHash === caseListBindingHash(spreadsheetId) &&
    canonical(source) === canonical(capture.source) && job.sheetRef == null && job.caseListManualSelection == null && job.assignmentSheetWrite == null, "SOURCE_CANCEL_JOB_BINDING_CHANGED");
  need(job.status === "cancelled" && job.cancelled === true && job.sourceCancellationClosed === true && job.sourceMissing !== true && job.revision === capture.cancelledJobRevision &&
    (unassigned ? sourceCancellationUnassigned(job) && !caseListPublicationPending(job) && canonical(sourceCancellationPublicationPointer(job)) === canonical(capture.publicationPointer) : job.assignedStaffId === capture.staffId && job.assignedStaffName === capture.staffName && (job.assignedUid ?? null) === capture.assignedUid) && job.dateKey === capture.dateKey && job.workDate === capture.workDate &&
    job.cancelledBy === capture.actorUid && job.publishable === false && job.recruitmentStopped === true && saved.queueId === queueId && saved.operation === queue.operation &&
    saved.identity === capture.identity && saved.identity === cancellationSheetWriteIdentity(job) && saved.sourceAckVersion === 1 && saved.sourceAckPending === true && saved.sourceAckJobRevision === job.revision &&
    Number.isSafeInteger(saved.sourceAckRequestedAtMs) && saved.sourceAckRequestedAtMs >= 0 && queue.idempotencyKey === `${queue.operation}:${queue.jobId}:${queueId}` &&
    queue.updates?.cancelled === true && queue.updates?.cancellationReason === job.cancellationReason && typeof job.cancellationReason === "string" && job.cancellationReason.trim() && Object.keys(queue.styles ?? {}).length === 0,
  "SOURCE_CANCEL_JOB_CHANGED");
  const expected: Data = { cancelled: true, cancellationReason: job.cancellationReason };
  if (queue.operation === "job.cancel.v2") {
    const reason = job.cancellationReasonCategory as keyof typeof cancellationReasonLabels, treatment = job.cancellationFinancialTreatment as keyof typeof cancellationTreatmentLabels;
    need(Object.hasOwn(cancellationReasonLabels, reason) && Object.hasOwn(cancellationTreatmentLabels, treatment), "SOURCE_CANCEL_REASON_CHANGED");
    expected.cancellationReasonCategory = cancellationReasonLabels[reason]; expected.cancellationFinancialTreatment = cancellationTreatmentLabels[treatment];
  }
  need(canonical(queue.updates ?? {}) === canonical(expected) && canonical(queue.expected ?? {}) === "{}", "SOURCE_CANCEL_REQUEST_CHANGED");
  if (!unassigned) need(day?.active === true && day.companyId === queue.companyId && day.jobId === queue.jobId && day.staffId === capture.staffId && day.dateKey === capture.dateKey &&
    staff?.companyId === queue.companyId && staff.active === true && typeof staff.displayName === "string" && staff.displayName.trim(), "SOURCE_CANCEL_STAFF_OR_DAY_LOCK_CHANGED");
  return { capture, spreadsheetId };
}

/** Nullable authority is deliberately limited to one ordinary single-day slot.
 * Headcount proof must be present in the current native metadata, even when a
 * historical publication was approved; unsupported shapes remain held. */
function assertUnassignedShape(cells: Data[], capture: Data): void {
  const text = (cell: Data) => cell.effectiveValue?.stringValue ?? cell.userEnteredValue?.stringValue ?? "";
  let metadata: Data = {}; try { metadata = JSON.parse(text(cells[62]!)); } catch { /* held below */ }
  need(blank(cells[2]!) && !(cells[2]!.chipRuns?.length) && ["単日", "SINGLE"].includes(text(cells[58]!)) && blank(cells[59]!) &&
    metadata.schema === "LKCM1_CASE_META_V1" && metadata.headcountConfirmed === true &&
    !/研修|OJT|ラウンダー|出口調査|グレイス|グレース/i.test([text(cells[10]!), text(cells[11]!), text(cells[13]!), text(cells[16]!)].join(" ")) &&
    text(cells[55]!) === (capture.publicationPointer?.state === "PUBLISHED" ? "募集中" : "確認待ち"), "SOURCE_CANCEL_UNASSIGNED_SHAPE_UNSUPPORTED");
}

/** Only C and BL are writable. Everything else is compared as full writable
 * CellData, so formulas, manually entered fees, notes and formatting survive.
 * UNASSIGNED_SOURCE only writes BL; its blank C CellData is preserved exactly. */
export function assertCaseListSourceCancellationImage(snapshot: Snapshot, capture: Data, expectedCatalog: Data, before?: Data[]): { row: number; cells: Data[] } {
  need(snapshot.spreadsheetId === expectedCatalog.spreadsheetId && snapshot.isolated === false, "SOURCE_CANCEL_SNAPSHOT_BOOK_CHANGED");
  core.assertSnapshotCoverage(snapshot, capture.caseId, { sha256: sha });
  const rows = snapshot.source.rows.filter(row => row.caseId === capture.caseId);
  need(rows.length === 1 && rows[0]!.row >= 2 && rows[0]!.cells.length === 65 && rows[0]!.fullWritable === true, "SOURCE_CANCEL_ROW_NOT_UNIQUE");
  const row = rows[0]!, cells = row.cells as Data[];
  need(nativeString(cells[60]!, capture.caseId) && dateValue(cells[1]!) === capture.dateKey && snapshot.catalog.ledgerRevision === expectedCatalog.ledgerRevision &&
    snapshot.months.every(month => month.rows.every(item => item.fixedId?.toLowerCase() !== capture.caseId.toLowerCase())), "SOURCE_CANCEL_MONTHLY_OR_ID_CONFLICT");
  const ledger = snapshot.rawLedgerRows.slice(3).filter(item => item[0]?.userEnteredValue?.stringValue === capture.caseId);
  need(ledger.length === 1, "SOURCE_CANCEL_LEDGER_REQUIRED");
  const text = (cell: Data | undefined) => cell?.effectiveValue?.stringValue ?? cell?.userEnteredValue?.stringValue ?? "";
  let metadata: Data = {}; try { metadata = JSON.parse(String(text(ledger[0]![19]))); } catch { /* held below */ }
  need(metadata.schema === "LK_HISTORY_CORE_SNAPSHOT_V1" && metadata.caseId === capture.caseId && metadata.monthly == null &&
    ["未手配", "未手配・募集継続"].includes(String(text(ledger[0]![8]))) && !text(ledger[0]![9]) && !text(ledger[0]![10]), "SOURCE_CANCEL_LEDGER_ASSIGNED_OR_ENDED");
  const unassigned = isUnassignedSourceCancellation(capture);
  if (unassigned) assertUnassignedShape(cells, capture);
  if (!before) {
    need(canonical(snapshot.catalog) === canonical(expectedCatalog) && (unassigned ? blank(cells[2]!) : nativeString(cells[2]!, capture.staffName)) && nativeBool(cells[63]!, false), "SOURCE_CANCEL_PREIMAGE_CHANGED");
  } else {
    need(before.length === 65 && blank(cells[2]!) && nativeBool(cells[63]!, true), "SOURCE_CANCEL_AFTERIMAGE_NOT_VERIFIED");
    const actual = writable(cells), expected = copy(before);
    // Clearing C may be returned by Google as an omitted value or empty text.
    if (!unassigned) { delete actual[2]!.userEnteredValue; delete expected[2]!.userEnteredValue; }
    expected[63] = { ...expected[63], userEnteredValue: { boolValue: true } };
    need(canonical(actual) === canonical(expected), "SOURCE_CANCEL_UNRELATED_CELLDATA_CHANGED");
  }
  return { row: row.row, cells };
}

/** Rehashed private history must still prove the same native before-image. */
export function assertCaseListSourceCancellationIntent(intent: Data, capture: Data, expectedCatalog: Data): void {
  need(intent.schema === "LK_CASE_LIST_SOURCE_CANCEL_INTENT_V1" && intent.stage === "INTENT" && intent.captureHash === hashCaseList(capture) && intent.companyId === capture.companyId && intent.jobId === capture.jobId && intent.queueId === capture.queueId && intent.caseId === capture.caseId &&
    intent.spreadsheetId === expectedCatalog.spreadsheetId && canonical(intent.expectedCatalog) === canonical(expectedCatalog) && Array.isArray(intent.sourceBefore) && intent.sourceBefore.length === 65 && Array.isArray(intent.sourceBeforeValues) && intent.sourceBeforeValues.length === 65 &&
    intent.sourceBefore.every((cell: Data, index: number) => cell && typeof cell === "object" && !Array.isArray(cell) && Object.keys(cell).every(key => WRITABLE.includes(key)) && canonical(cell.userEnteredValue ?? {}) === canonical(intent.sourceBeforeValues[index]?.userEnteredValue ?? {})) &&
    intent.sourceBeforeValues.every((cell: Data) => cell && typeof cell === "object" && !Array.isArray(cell) && Object.keys(cell).every(key => ["userEnteredValue", "effectiveValue"].includes(key))) &&
    hashCaseList({ schema: "LK_CASE_CONTENT_REVISION_V1", jobId: capture.caseId, cells: intent.sourceBeforeValues }) === expectedCatalog.rowRevision &&
    (isUnassignedSourceCancellation(capture) ? blank(intent.sourceBeforeValues[2]) : nativeString(intent.sourceBeforeValues[2], capture.staffName)) && nativeBool(intent.sourceBeforeValues[63], false) && nativeString(intent.sourceBeforeValues[60], capture.caseId) && dateValue(intent.sourceBeforeValues[1]) === capture.dateKey,
  "SOURCE_CANCEL_INTENT_PREIMAGE_INVALID");
}

/** A terminal public pointer alone never authorizes cancellation. Re-read its
 * immutable private generation on every authorization and before the ACK. */
async function assertUnassignedPublication(tx: Tx, queue: Data, capture: Data): Promise<void> {
  const pointer = capture.publicationPointer;
  if (pointer == null) { need(capture.beforeStatus === "draft", "SOURCE_CANCEL_PUBLICATION_REQUIRED"); return; }
  need(ID.test(pointer.queueId ?? "") && HASH.test(pointer.intentHash ?? "") && pointer.pending === false && ["PUBLISHED", "REVOKED"].includes(pointer.state), "SOURCE_CANCEL_PUBLICATION_POINTER_INVALID");
  const ref = db.collection("caseListMonthlyOperations").doc(sha(queue.companyId + "|" + pointer.queueId));
  const [qSnap, opSnap, ...records] = await Promise.all([tx.get(db.collection("sheetSyncQueue").doc(pointer.queueId)), tx.get(ref),
    ...["REQUESTED", "INTENT", "WRITE_STARTED", "ACK", "REVOKED"].map(stage => tx.get(ref.collection("events").doc(stage)))]);
  const q = qSnap.data(), op = opSnap.data(), events: Data = {};
  for (const [index, stage] of ["REQUESTED", "INTENT", "WRITE_STARTED", "ACK", "REVOKED"].entries()) {
    const record = records[index]!.data();
    if (!record) continue;
    need(record.companyId === queue.companyId && record.queueId === pointer.queueId && record.payloadHash === hashCaseList(record.payload), "SOURCE_CANCEL_PUBLICATION_EVENT_INVALID");
    events[stage] = record.payload;
  }
  const pub = object(q?.caseListPublication), pubHash = hashCaseList(pub);
  need(q && op && q.operation === "case_list.publish" && q.companyId === queue.companyId && q.jobId === queue.jobId &&
    pub.schema === "LK_CASE_LIST_PUBLICATION_CAPTURE_V1" && pub.companyId === queue.companyId && pub.jobId === queue.jobId && pub.queueId === pointer.queueId && pub.caseId === capture.caseId &&
    pub.actorUid === q.actorUid && ID.test(pub.actorUid ?? "") && pubHash === pointer.intentHash && canonical(events.REQUESTED) === canonical(pub) &&
    HASH.test(pub.reviewPlanHash ?? "") && pub.requestKey === pub.reviewPlanHash && pub.conditionsHash === hashCaseList(pub.confirmation) &&
    Number.isSafeInteger(pub.beforeJobRevision) && pub.beforeJobRevision >= 0 && pub.queuedJobRevision === pub.beforeJobRevision + 1 &&
    capture.beforeJobRevision >= pub.queuedJobRevision && q.idempotencyKey === `case_list.publish:${queue.jobId}:${pub.requestKey}` &&
    canonical(q.updates ?? {}) === "{}" && canonical(q.expected ?? {}) === "{}" && canonical(q.styles ?? {}) === "{}" &&
    op.schema === "LK_CASE_LIST_PUBLICATION_OPERATION_V1" && op.companyId === queue.companyId && op.jobId === queue.jobId && op.queueId === pointer.queueId && op.captureHash === pubHash,
  "SOURCE_CANCEL_PUBLICATION_GENERATION_INVALID");
  for (const stage of ["INTENT", "WRITE_STARTED", "ACK", "REVOKED"]) if (events[stage]) need(events[stage].stage === stage && events[stage].operationId === pointer.queueId && events[stage].caseId === capture.caseId && events[stage].captureHash === pubHash, "SOURCE_CANCEL_PUBLICATION_EVENT_SCOPE");
  if (pointer.state === "PUBLISHED") {
    const intent = events.INTENT, ack = events.ACK, plan = object(intent?.plan), withoutHash = { ...plan }; delete withoutHash.reviewPlanHash;
    need(capture.beforeStatus === "open" && q.status === "completed" && op.status === "completed" && !events.REVOKED &&
      intent?.schema === "LK_CASE_LIST_PUBLICATION_INTENT_V1" && intent.companyId === queue.companyId && intent.jobId === queue.jobId && intent.queueId === pointer.queueId &&
      plan.schema === "LK_CASE_LIST_PUBLICATION_PLAN_V1" && plan.companyId === queue.companyId && plan.jobId === queue.jobId && plan.caseId === capture.caseId &&
      plan.reviewPlanHash === pub.reviewPlanHash && hashCaseList(withoutHash) === pub.reviewPlanHash &&
      events.WRITE_STARTED?.intentHash === hashCaseList(intent) && ack?.schema === "LK_CASE_LIST_PUBLICATION_ACK_V1" && ack.intentHash === hashCaseList(intent) &&
      pointer.ackHash === hashCaseList(ack) && op.acceptedAckHash === pointer.ackHash && canonical(ack.postSource) === canonical(capture.source) &&
      canonical(publicCaseListSource(plan.postCatalog)) === canonical(capture.source) && canonical(publicCaseListSource(plan.preCatalog)) === canonical(pub.source), "SOURCE_CANCEL_PUBLICATION_ACK_INVALID");
  } else {
    const revoked = events.REVOKED;
    need(["draft", "stopped"].includes(capture.beforeStatus) && q.status === "cancelled" && op.status === "revoked" && !events.WRITE_STARTED && !events.ACK &&
      revoked?.schema === "LK_CASE_LIST_PUBLICATION_REVOCATION_V1" && revoked.companyId === queue.companyId && revoked.jobId === queue.jobId && revoked.queueId === pointer.queueId &&
      revoked.afterWriteStarted === false && canonical(pub.source) === canonical(capture.source), "SOURCE_CANCEL_PUBLICATION_REVOCATION_UNCERTAIN");
  }
}

/** Invoked by the existing queue worker after its pause/claim boundary. The
 * owner reconciliation entrypoint never constructs a Google write client. */
export async function processCaseListSourceCancellation(queueRef: Ref, claimedQueue?: Data, owner?: { actorUid: string; token: Data }): Promise<Data> {
  const initial = (await queueRef.get()).data();
  if (!initial?.caseListCancellation || !["job.cancel", "job.cancel.v2"].includes(initial.operation)) return { status: "UNRELATED_OPERATION" };
  if (!owner && initial.status !== "processing") return { status: "QUEUE_NOT_PROCESSING", snapshotReads: 0, nativeBatches: 0 };
  if (owner) {
    assertExecutive(owner.token, process.env.EXECUTIVE_APPROVER_EMAILS ?? "");
    need(owner.token.companyId === initial.companyId && (owner.token.uid ?? owner.token.sub) === owner.actorUid && ID.test(owner.actorUid), "SOURCE_CANCEL_RECONCILIATION_ACTOR_INVALID");
  }
  const claimToken = owner ? randomUUID() : claimedQueue?.claimToken;
  need(typeof claimToken === "string" && ID.test(initial.companyId ?? "") && ID.test(initial.jobId ?? ""), "SOURCE_CANCEL_CLAIM_INVALID");
  const jobRef = db.collection("jobs").doc(initial.jobId), configRef = db.collection("sheetImportConfigs").doc(initial.companyId), mapRef = db.doc(`companies/${initial.companyId}/sheetMappings/shift`);
  const syncRef = db.collection("caseListSyncLocks").doc(initial.companyId), operationRef = db.collection("caseListMonthlyOperations").doc(sha(initial.companyId + "|" + queueRef.id));
  const beforeFingerprint = fingerprint(initial), deadline = Date.now() + 50_000;
  let acquired = false, started = false, nativeBatches = 0, snapshotReads = 0;
  async function readTrusted(tx: Tx, claimed: boolean) {
    const [queueSnap, jobSnap, configSnap, mapSnap, leaseSnap, operationSnap, privateRef] = await Promise.all([tx.get(queueRef), tx.get(jobRef), tx.get(configRef), tx.get(mapRef), tx.get(syncRef), tx.get(operationRef), tx.get(db.collection("caseListSheetRefs").doc(initial!.jobId))]);
    const queue = queueSnap.data(), job = jobSnap.data(), config = configSnap.data(), mapping = mapSnap.data(), lease = leaseSnap.data(), operation = operationSnap.data();
    need(queue && job && config && mapping && fingerprint(queue) === beforeFingerprint && !privateRef.exists, "SOURCE_CANCEL_TRUSTED_DOCUMENT_CHANGED");
    const c = object(queue.caseListCancellation);
    const unassigned = isUnassignedSourceCancellation(c);
    need((unassigned || ID.test(c.staffId ?? "")) && typeof c.dateKey === "string" && /^2026-(?:11|12)-\d{2}$/.test(c.dateKey), "SOURCE_CANCEL_STAFF_ID_INVALID");
    const dayRef = unassigned ? null : db.collection("staffDayLocks").doc(`${queue.companyId}_${c.staffId}_${c.dateKey}`);
    const actorSnap = await tx.get(db.collection("authIdentities").doc(queue.actorUid));
    const actor = actorSnap.data();
    need(!actorSnap.exists || actor?.active === true && actor.companyId === queue.companyId, "SOURCE_CANCEL_ACTOR_REVOKED");
    const [daySnap, staffSnap] = unassigned ? [null, null] : await Promise.all([tx.get(dayRef!), tx.get(db.collection("staffProfiles").doc(c.staffId))]);
    const checked = assertCaseListSourceCancellationAuthority(queueRef.id, queue, job, config, mapping, object(daySnap?.data()), object(staffSnap?.data()), !!owner);
    let expectedCatalog: Data;
    if (unassigned) {
      await assertUnassignedPublication(tx, queue, c);
      expectedCatalog = { ...c.source, spreadsheetId: checked.spreadsheetId }; delete expectedCatalog.bindingHash;
    } else if (c.manualPending) {
      need(c.priorAssignment == null && c.assignedUid == null && canonical(c.manualPending) === canonical(job.caseListManualPending ?? null), "SOURCE_CANCEL_MANUAL_CAPTURE_CHANGED");
      const observed = (await tx.get(db.collection("caseListManualObservations").doc(queue.jobId))).data(), pending = c.manualPending;
      need(observed?.schema === "LK_CASE_LIST_MANUAL_OBSERVATION_V1" && observed.origin === "SOURCE_MANUAL" && observed.companyId === queue.companyId && observed.jobId === queue.jobId && observed.caseId === c.caseId &&
        observed.selected === false && observed.clientNameUpConfirmed === false && observed.observationHash === pending.observationHash && HASH.test(pending.observationHash ?? "") &&
        observed.staffId === c.staffId && observed.sourceStaffName === c.staffName && observed.dateKey === c.dateKey && observed.canonicalStaffName === staffSnap?.data()?.displayName &&
        pending.staffId === c.staffId && pending.dateKey === c.dateKey && pending.sourceRevision === c.source.sourceRevision && canonical(observed.source) === canonical(c.source), "SOURCE_CANCEL_MANUAL_OBSERVATION_CHANGED");
      expectedCatalog = { ...c.source, spreadsheetId: checked.spreadsheetId }; delete expectedCatalog.bindingHash;
    } else {
      const prior = object(c.priorAssignment);
      need(job.caseListManualPending == null && prior.operation === "case_list.assign" && ID.test(prior.queueId ?? "") && prior.pending !== false && prior.identity === c.identity && prior.assignedJobRevision === c.beforeJobRevision && ID.test(c.assignedUid ?? ""), "SOURCE_CANCEL_APP_CAPTURE_INVALID");
      const priorRef = db.collection("caseListMonthlyOperations").doc(sha(queue.companyId + "|" + prior.queueId));
      const [assignmentSnap, priorOperationSnap, ...events] = await Promise.all([tx.get(db.collection("sheetSyncQueue").doc(prior.queueId)), tx.get(priorRef), ...STAGES.map(stage => tx.get(priorRef.collection("events").doc(stage)))]);
      const assignmentQueue = assignmentSnap.data(), priorOperation = priorOperationSnap.data(), records = Object.fromEntries(STAGES.map((stage, index) => [stage, events[index]!.data()]));
      need(assignmentQueue && priorOperation && assignmentQueue.companyId === queue.companyId && assignmentQueue.jobId === queue.jobId && assignmentQueue.status === "blocked" && assignmentQueue.errorType === "owner_transfer_required" &&
        assignmentQueue.writeVerificationRequired === false && assignmentQueue.caseListPhase?.phase === "MONTHLY_PREPARE" && priorOperation.ownerTransferSelection == null &&
        !["INTENT", "MONTHLY_DISPATCHED", "SOURCE_UNKNOWN", "UNKNOWN", "SOURCE_DEFERRED", "DEFERRED", "MONTHLY_WRITE_STARTED", "ACCEPTED"].some(stage => records[stage]), "SOURCE_CANCEL_SELECTED_OR_UNKNOWN_MONTHLY_OPERATION");
      const a = object(assignmentQueue.caseListAssignment);
      need(a.schema === "LK_CASE_LIST_ASSIGN_V1" && !a.origin && a.queueId === prior.queueId && a.operationId === prior.queueId && a.companyId === queue.companyId && a.jobId === queue.jobId && a.sourceCaseId === c.caseId &&
        a.staffId === c.staffId && a.staffName === c.staffName && a.dateKey === c.dateKey && a.assignedJobRevision === c.beforeJobRevision && assignmentQueue.actorUid === c.assignedUid &&
        a.sourceRevision === c.source.sourceRevision && a.sourceRowRevision === c.source.rowRevision && a.sourceLedgerRevision === c.source.ledgerRevision && prior.sourceRevision === c.source.sourceRevision,
      "SOURCE_CANCEL_PRIOR_ASSIGNMENT_CHANGED");
      need(assertKnownCaseListContinuation(prior.queueId, assignmentQueue, priorOperation, records, checked.spreadsheetId) === "MONTHLY_PREPARE", "SOURCE_CANCEL_PRIOR_PHASE_CHANGED");
      expectedCatalog = copy(records.SOURCE_PROJECTED!.payload.postCatalog);
      need(expectedCatalog.spreadsheetId === checked.spreadsheetId && expectedCatalog.caseId === c.caseId && expectedCatalog.sheetId === 2026101601 && expectedCatalog.ledgerRevision === c.source.ledgerRevision, "SOURCE_CANCEL_PROJECTED_CATALOG_CHANGED");
    }
    if (claimed) need(queue.status === "processing" && queue.claimToken === claimToken && queue.retryAt instanceof Timestamp && queue.retryAt.toMillis() > Date.now() &&
      lease?.tokenId === claimToken && lease?.activeUntil instanceof Timestamp && lease.activeUntil.toMillis() > Date.now() && operation?.claimToken === claimToken && operation?.captureHash === hashCaseList(c) && operation.queueFingerprint === beforeFingerprint,
    "SOURCE_CANCEL_LEASE_CHANGED");
    return { queue, job, capture: c, spreadsheetId: checked.spreadsheetId, expectedCatalog, lease, operation, dayRef };
  }
  async function authorize() {
    need((await getProductionOperationalState(initial!.companyId)).operational, "SOURCE_CANCEL_GLOBAL_STOPPED");
    return db.runTransaction(tx => readTrusted(tx, true));
  }
  async function event(tx: Tx, stage: string): Promise<Data | undefined> {
    const value = (await tx.get(operationRef.collection("events").doc(stage))).data();
    if (!value) return undefined;
    need(value.companyId === initial!.companyId && value.queueId === queueRef.id && value.payloadHash === hashCaseList(value.payload) && value.payload.stage === stage && value.payload.captureHash === hashCaseList(initial!.caseListCancellation), "SOURCE_CANCEL_JOURNAL_INTEGRITY");
    return value.payload;
  }
  try {
    need((await getProductionOperationalState(initial.companyId)).operational, "SOURCE_CANCEL_GLOBAL_STOPPED");
    const trusted = await db.runTransaction(async tx => {
      const current = await readTrusted(tx, false), intent = await event(tx, "INTENT"), dispatch = await event(tx, "WRITE_STARTED"), ack = await event(tx, "ACK");
      if (dispatch) started = true;
      need(!ack && (!current.operation || current.operation.schema === "LK_CASE_LIST_SOURCE_CANCEL_OPERATION_V1" && current.operation.captureHash === hashCaseList(current.capture) && current.operation.queueFingerprint === beforeFingerprint), "SOURCE_CANCEL_OPERATION_CHANGED");
      need(!(current.lease?.activeUntil instanceof Timestamp && current.lease.activeUntil.toMillis() > Date.now()), "SOURCE_CANCEL_COMPANY_LEASE_ACTIVE");
      if (owner) {
        need(current.queue.status !== "completed" && (!(current.queue.retryAt instanceof Timestamp) || current.queue.retryAt.toMillis() <= Date.now()) && intent && dispatch && dispatch.intentHash === hashCaseList(intent), "SOURCE_CANCEL_READONLY_PROOF_REQUIRED");
      } else {
        need(claimedQueue && fingerprint(claimedQueue) === beforeFingerprint && current.queue.status === "processing" && current.queue.claimToken === claimToken && current.queue.writeVerificationRequired !== true && current.queue.errorType !== "verification_required" && !dispatch, "SOURCE_CANCEL_UNKNOWN_REQUIRES_RECONCILIATION");
      }
      const until = Timestamp.fromMillis(Date.now() + 10 * 60_000), now = Timestamp.now();
      tx.set(queueRef, { status: "processing", claimToken, retryAt: until, updatedAt: now }, { merge: true });
      tx.set(syncRef, { tokenId: claimToken, activeUntil: until, actorUid: owner?.actorUid ?? current.queue.actorUid, kind: "source.cancel", queueId: queueRef.id });
      tx.set(operationRef, { schema: "LK_CASE_LIST_SOURCE_CANCEL_OPERATION_V1", companyId: current.queue.companyId, jobId: current.queue.jobId, queueId: queueRef.id, caseId: current.capture.caseId,
        captureHash: hashCaseList(current.capture), queueFingerprint: beforeFingerprint, claimToken, status: "processing", updatedAt: now }, { merge: true });
      return { ...current, intent, dispatch };
    });
    acquired = true; started = !!trusted.dispatch;
    const read = async () => { need(++snapshotReads <= 3, "SOURCE_CANCEL_SNAPSHOT_BUDGET"); await authorize(); return readCaseListMonthlySnapshot(initial.companyId, trusted.capture.caseId, {}); };
    let intent = trusted.intent;
    if (!owner) {
      const snapshot = await read(), before = assertCaseListSourceCancellationImage(snapshot, trusted.capture, trusted.expectedCatalog);
      const next = { schema: "LK_CASE_LIST_SOURCE_CANCEL_INTENT_V1", stage: "INTENT", companyId: initial.companyId, jobId: initial.jobId, queueId: queueRef.id, caseId: trusted.capture.caseId,
        captureHash: hashCaseList(trusted.capture), spreadsheetId: trusted.spreadsheetId, expectedCatalog: copy(trusted.expectedCatalog), sourceRowHint: before.row, sourceBefore: writable(before.cells), sourceBeforeValues: before.cells.map(cell => ({ userEnteredValue: cell.userEnteredValue ?? {}, effectiveValue: cell.effectiveValue ?? {} })) };
      need(Buffer.byteLength(canonical(next), "utf8") < 850_000, "SOURCE_CANCEL_JOURNAL_TOO_LARGE");
      if (intent) need(canonical(intent) === canonical(next), "SOURCE_CANCEL_PREPARED_IMAGE_CHANGED");
      else {
        intent = next;
        await db.runTransaction(async tx => { await readTrusted(tx, true); need(!(await event(tx, "INTENT")), "SOURCE_CANCEL_INTENT_EXISTS"); tx.create(operationRef.collection("events").doc("INTENT"), { companyId: initial.companyId, queueId: queueRef.id, payload: next, payloadHash: hashCaseList(next), createdAt: Timestamp.now() }); });
      }
      assertCaseListSourceCancellationIntent(intent, trusted.capture, trusted.expectedCatalog);
      const preflight = await read(), latest = assertCaseListSourceCancellationImage(preflight, trusted.capture, intent.expectedCatalog);
      need(canonical(writable(latest.cells)) === canonical(intent.sourceBefore), "SOURCE_CANCEL_NATIVE_PREIMAGE_CHANGED");
      need(deadline - Date.now() - 8_000 >= 2_000, "SOURCE_CANCEL_TIME_BUDGET");
      const dispatch = { stage: "WRITE_STARTED", captureHash: hashCaseList(trusted.capture), intentHash: hashCaseList(intent), queueId: queueRef.id, caseId: trusted.capture.caseId };
      // A lost metadata commit response may still have durably marked STARTED.
      // Keep the result-verification hold conservative before dispatch.
      started = true;
      await db.runTransaction(async tx => { await readTrusted(tx, true); need(!(await event(tx, "WRITE_STARTED")), "SOURCE_CANCEL_ALREADY_STARTED"); const saved = await event(tx, "INTENT"); need(saved && hashCaseList(saved) === dispatch.intentHash, "SOURCE_CANCEL_INTENT_CHANGED"); tx.create(operationRef.collection("events").doc("WRITE_STARTED"), { companyId: initial.companyId, queueId: queueRef.id, payload: dispatch, payloadHash: hashCaseList(dispatch), createdAt: Timestamp.now() }); });
      started = true;
      await authorize();
      const timeout = Math.min(30_000, deadline - Date.now() - 8_000); need(timeout >= 2_000, "SOURCE_CANCEL_TIME_BUDGET");
      const sheets = google.sheets({ version: "v4", auth: new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] }) });
      need(++nativeBatches === 1, "SOURCE_CANCEL_NATIVE_BUDGET");
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: trusted.spreadsheetId, requestBody: { requests: [
        ...(isUnassignedSourceCancellation(trusted.capture) ? [] : [{ updateCells: { range: { sheetId: 2026101601, startRowIndex: latest.row - 1, endRowIndex: latest.row, startColumnIndex: 2, endColumnIndex: 3 }, rows: [{ values: [{}] }], fields: "userEnteredValue" } }]),
        { updateCells: { range: { sheetId: 2026101601, startRowIndex: latest.row - 1, endRowIndex: latest.row, startColumnIndex: 63, endColumnIndex: 64 }, rows: [{ values: [{ userEnteredValue: { boolValue: true } }] }], fields: "userEnteredValue" } },
      ] } }, { retry: false, retryConfig: { retry: 0, noResponseRetries: 0, httpMethodsToRetry: [] }, timeout });
    }
    need(intent, "SOURCE_CANCEL_READBACK_INTENT_INVALID");
    assertCaseListSourceCancellationIntent(intent, trusted.capture, trusted.expectedCatalog);
    const readStartedAtMs = Date.now();
    need(readStartedAtMs > trusted.job.cancellationSheetWrite.sourceAckRequestedAtMs, "SOURCE_CANCEL_READBACK_NOT_FRESH");
    const after = await read(); assertCaseListSourceCancellationImage(after, trusted.capture, intent.expectedCatalog, intent.sourceBefore);
    const postSource = publicCaseListSource(after.catalog);
    await db.runTransaction(async tx => {
      const current = await readTrusted(tx, true), savedIntent = await event(tx, "INTENT"), savedDispatch = await event(tx, "WRITE_STARTED"), savedAck = await event(tx, "ACK");
      need(!savedAck && savedIntent && savedDispatch && savedDispatch.intentHash === hashCaseList(savedIntent) && hashCaseList(savedIntent) === hashCaseList(intent), "SOURCE_CANCEL_READBACK_PROOF_CHANGED");
      const now = Timestamp.now(), proof = { readStartedAtMs, confirmedAtMs: now.toMillis(), runId: queueRef.id, originalRevision: current.job.revision, originalIdentity: current.job.cancellationSheetWrite.identity,
        staffId: current.capture.staffId, dateKey: current.capture.dateKey, origin: isUnassignedSourceCancellation(current.capture) ? "UNASSIGNED_SOURCE" : current.capture.manualPending ? "SOURCE_MANUAL" : "CREW_QUEUE", sourceRevision: postSource.sourceRevision, nativeIntentHash: hashCaseList(savedIntent) };
      const ack = { schema: "LK_CASE_LIST_SOURCE_CANCEL_ACK_V1", stage: "ACK", captureHash: hashCaseList(current.capture), intentHash: hashCaseList(savedIntent), postSource, proof };
      tx.create(operationRef.collection("events").doc("ACK"), { companyId: initial.companyId, queueId: queueRef.id, payload: ack, payloadHash: hashCaseList(ack), createdAt: now });
      tx.update(jobRef, { rawStaffName: "", caseListSource: postSource, cancellationSheetWrite: { ...current.job.cancellationSheetWrite, sourceAckPending: false, sourceAckProof: proof }, publishable: false, recruitmentStopped: true, updatedAt: now });
      if (current.dayRef) tx.set(current.dayRef, { active: false, releasedAt: now, releaseReason: "cancelled-source-confirmed", updatedAt: now }, { merge: true });
      tx.set(queueRef, { status: "completed", retryAt: null, writeVerificationRequired: false, sourceCancellationAckHash: hashCaseList(ack), completedAt: now, updatedAt: now }, { merge: true });
      tx.set(operationRef, { status: "completed", acceptedAckHash: hashCaseList(ack), completedAt: now, updatedAt: now }, { merge: true });
      tx.set(db.collection("sheetWriteIdempotency").doc(sha(initial.companyId + "|" + initial.idempotencyKey)), { companyId: initial.companyId, queueId: queueRef.id, status: "completed", completedAt: now }, { merge: true });
    });
    return { status: "SOURCE_CANCELLATION_READBACK_VERIFIED", snapshotReads, nativeBatches };
  } catch (error) {
    const reason = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "SOURCE_CANCEL_HELD";
    await db.runTransaction(async tx => {
      const current = (await tx.get(queueRef)).data();
      if (!current || current.status !== "processing" || current.claimToken !== claimToken || fingerprint(current) !== beforeFingerprint) return;
      tx.set(queueRef, { status: "blocked", errorType: started ? "verification_required" : "blocked", writeVerificationRequired: started,
        retryAt: null, caseListCancellationReason: reason, errorMessage: "案件リストの取消結果を確認してください。担当履歴と勤務枠を保持し、自動再書込を停止しました。", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      if (acquired) tx.set(operationRef, { status: "held", heldReason: reason, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
    return { status: "HELD", reason, snapshotReads, nativeBatches };
  } finally {
    if (acquired) await db.runTransaction(async tx => { if ((await tx.get(syncRef)).data()?.tokenId === claimToken) tx.delete(syncRef); });
  }
}
