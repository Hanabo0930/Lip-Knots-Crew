import { createHash, randomUUID } from "node:crypto";
import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { google } from "googleapis";
import { db } from "./firebase";
import { createJobIdFromPersistedCaseId } from "./case-id";
import { cancellationSheetWriteIdentity } from "./sheet-write-core";
import { configuredCaseListSource, publicCaseListSource, assertExecutive, hashCaseList, canonical, caseListMonthlyContentHash } from "./case-list-source-core";
import { readCaseListMonthlySnapshot } from "./case-list-monthly-reader";
import { manualOwnerReviewCanProceed } from "./case-list-manual-origin-core";
import { getProductionOperationalState } from "./system-safety";

type Data = FirebaseFirestore.DocumentData;
type Ref = FirebaseFirestore.DocumentReference;
type Tx = FirebaseFirestore.Transaction;
type SourceRevision = { rowRevision: string; ledgerRevision: string; sourceRevision: string };
type PayOffer = { dailyWageJPY: number; travelExpenses: "全額支給"; communicationExpenses: "全額支給" };
type Assignment = {
  schema: "LK_CASE_LIST_ASSIGN_V1" | "LK_CASE_LIST_MANUAL_ASSIGN_V1"; origin?: "SOURCE_MANUAL"; canonicalStaffName?: string; observationHash?: string; ownerConditionsHash?: string; selectorUid?: string; queueId: string; operationId: string;
  companyId: string; jobId: string; sourceCaseId: string; sourceRowRevision: string;
  sourceLedgerRevision: string; sourceRevision: string; preMonthlyContentHash: string;
  expectedJobRevision: number; assignedJobRevision: number; staffId: string; staffName: string; dateKey: string;
};
type Trusted = { queue: Data; job: Data; config: Data; staff: Data; dayLock: Data; approval: Data; assignment: Assignment; spreadsheetId: string; payOffer: PayOffer; ownerTransferSelection: Data };
type CoreResult = { status: string; reason?: string; ack?: Data };
type Phase = "SOURCE_PREPARE" | "SOURCE_APPLY" | "SOURCE_RECONCILE" | "MONTHLY_PREPARE" | "MONTHLY_APPLY" | "MONTHLY_RECONCILE";
type CoreMethod = "prepareSource" | "applySource" | "reconcileSource" | "prepareMonthly" | "applyMonthly" | "reconcile";
const PHASES: Record<Phase, { method: CoreMethod; next?: Phase; proof?: string; success: string[] }> = {
  SOURCE_PREPARE: { method: "prepareSource", next: "SOURCE_APPLY", proof: "SOURCE_INTENT", success: ["SOURCE_INTENT_PREPARED", "SOURCE_INTENT_EXISTS"] },
  SOURCE_APPLY: { method: "applySource", next: "SOURCE_RECONCILE", proof: "SOURCE_DISPATCHED", success: ["SOURCE_WRITE_DISPATCHED"] },
  SOURCE_RECONCILE: { method: "reconcileSource", next: "MONTHLY_PREPARE", proof: "SOURCE_PROJECTED", success: ["SOURCE_ASSIGNMENT_PROJECTED", "SOURCE_ALREADY_PROJECTED"] },
  MONTHLY_PREPARE: { method: "prepareMonthly", next: "MONTHLY_APPLY", proof: "INTENT", success: ["MONTHLY_INTENT_PREPARED", "MONTHLY_INTENT_EXISTS"] },
  MONTHLY_APPLY: { method: "applyMonthly", next: "MONTHLY_RECONCILE", proof: "MONTHLY_DISPATCHED", success: ["MONTHLY_WRITE_DISPATCHED"] },
  MONTHLY_RECONCILE: { method: "reconcile", success: ["MONTHLY_READBACK_VERIFIED", "NO_OP_ALREADY_ACCEPTED"] },
};
const PREVIOUS_PROOF: Partial<Record<Phase, string>> = { SOURCE_APPLY: "SOURCE_INTENT", SOURCE_RECONCILE: "SOURCE_DISPATCHED", MONTHLY_PREPARE: "SOURCE_PROJECTED", MONTHLY_APPLY: "INTENT", MONTHLY_RECONCILE: "MONTHLY_DISPATCHED" };
const PHASE_SCHEMA = "LK_CASE_LIST_PHASE_V1";
type Snapshot = Awaited<ReturnType<typeof readCaseListMonthlySnapshot>>;
const controller = require("../src/case-list-monthly-controller.cjs") as { create(services: Record<string, unknown>): Record<CoreMethod, (request: { operationId: string; caseId: string }) => Promise<CoreResult>> };
const adapter = require("../src/case-list-monthly-adapter.cjs") as { createGoogleSheetsMutationAdapter(input: {
  spreadsheetId: string; transport: { batchUpdate(body: { spreadsheetId: string; requests: Data[] }): Promise<unknown> };
  readSnapshot(): Promise<Snapshot>; hash(text: string): string;
}): { applySourceAssignment(intent: unknown): Promise<unknown>; applyMonthly(intent: unknown): Promise<unknown> } };
const HASH = /^[0-9a-f]{64}$/;
const CASE = /^LKCASE_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const LEASE_MS = 10 * 60_000;
const INVOCATION_MS = 50_000, NATIVE_HEADROOM_MS = 8_000, MAX_NATIVE_TIMEOUT_MS = 30_000;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const object = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
function stop(code: string): never { throw new Error(code); }
function need(ok: unknown, code: string): asserts ok { if (!ok) stop(code); }
function validDate(date: unknown): date is string {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + "T00:00:00Z")) && new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date && date >= "2026-11-01";
}
const isManual = (a: Data): boolean => a.schema === "LK_CASE_LIST_MANUAL_ASSIGN_V1" && a.origin === "SOURCE_MANUAL";
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fingerprint(queue: Data): string {
  return hashCaseList({ companyId: queue.companyId ?? null, jobId: queue.jobId ?? null, operation: queue.operation ?? null, dateKey: queue.dateKey ?? null,
    actorUid: queue.actorUid ?? null, actorStaffId: queue.actorStaffId ?? null, idempotencyKey: queue.idempotencyKey ?? null,
    updates: queue.updates ?? {}, expected: queue.expected ?? {}, styles: queue.styles ?? {}, caseListAssignment: queue.caseListAssignment ?? null });
}
function sourceRevisions(value: Data): SourceRevision {
  need([value.rowRevision, value.ledgerRevision, value.sourceRevision].every(v => typeof v === "string" && HASH.test(v)), "SOURCE_REVISION_INVALID");
  return { rowRevision: value.rowRevision, ledgerRevision: value.ledgerRevision, sourceRevision: value.sourceRevision };
}
function sameRevisions(a: Data, b: Data): boolean { return ["rowRevision", "ledgerRevision", "sourceRevision"].every(key => a[key] === b[key]); }
function publicPayOffer(job: Data): PayOffer {
  const offer = object(job.publicPayOffer);
  need(Number.isSafeInteger(offer.dailyWageJPY) && offer.dailyWageJPY > 0 && offer.dailyWageJPY <= 1_000_000 &&
    offer.travelExpenses === "全額支給" && offer.communicationExpenses === "全額支給" && job.basePay === offer.dailyWageJPY, "PUBLIC_PAY_OFFER_CHANGED");
  return { dailyWageJPY: offer.dailyWageJPY, travelExpenses: "全額支給", communicationExpenses: "全額支給" };
}

/** Pure guard shared by the transaction paths; no caller-supplied trusted flag. */
export function assertCaseListMonthlyAuthority(queueId: string, queue: Data, job: Data, staff: Data, dayLock: Data, config: Data, approval: Data, ownerReadOnly = false): { assignment: Assignment; spreadsheetId: string; payOffer: PayOffer } {
  need(ID.test(queueId) && queue.operation === "case_list.assign" && ID.test(queue.companyId ?? "") && ID.test(queue.jobId ?? "") && ID.test(queue.actorStaffId ?? "") && ID.test(queue.actorUid ?? ""), "QUEUE_IDENTITY_INVALID");
  const a = object(queue.caseListAssignment);
  need((a.schema === "LK_CASE_LIST_ASSIGN_V1" && !a.origin || isManual(a)) && a.queueId === queueId && a.operationId === queueId && a.companyId === queue.companyId && a.jobId === queue.jobId && CASE.test(a.sourceCaseId ?? "") &&
    a.staffId === queue.actorStaffId && a.staffName === queue.updates?.staffName && a.dateKey === queue.dateKey && validDate(a.dateKey) &&
    Number.isSafeInteger(a.expectedJobRevision) && a.expectedJobRevision >= 0 && Number.isSafeInteger(a.assignedJobRevision) && a.assignedJobRevision === a.expectedJobRevision + 1 &&
    [a.sourceRowRevision, a.sourceLedgerRevision, a.sourceRevision, a.preMonthlyContentHash].every(v => typeof v === "string" && HASH.test(v)), "ASSIGNMENT_CONTRACT_INVALID");
  need(config.companyId === queue.companyId && config.caseListEnabled === true && (ownerReadOnly || config.caseListAssignmentsEnabled === true), "CASE_LIST_WRITER_DISABLED");
  const spreadsheetId = configuredCaseListSource(config.spreadsheetId).spreadsheetId;
  const source = object(job.caseListSource), saved = object(job.assignmentSheetWrite);
  need(createJobIdFromPersistedCaseId(queue.companyId, a.sourceCaseId) === queue.jobId && job.companyId === queue.companyId && job.caseId === a.sourceCaseId &&
    source.version === 1 && !Object.hasOwn(source, "spreadsheetId") && source.bindingHash === hashCaseList({ schema: "LK_CASE_LIST_SOURCE_BINDING_V1", spreadsheetId, sheetId: 2026101601 }) && source.sheetId === 2026101601 && source.caseId === a.sourceCaseId &&
    source.rowRevision === a.sourceRowRevision && source.ledgerRevision === a.sourceLedgerRevision && source.sourceRevision === a.sourceRevision,
  "JOB_SOURCE_BINDING_CHANGED");
  need(job.status === "assigned" && job.cancelled !== true && job.sourceMissing !== true && job.assignmentUnresolved !== true && job.applicationUnconfirmed === true &&
    job.assignedStaffId === a.staffId && job.assignedStaffName === a.staffName && (isManual(a) ? job.assignedUid == null : job.assignedUid === queue.actorUid) && job.dateKey === a.dateKey && job.revision === a.assignedJobRevision &&
    saved.operation === "case_list.assign" && saved.queueId === queueId && saved.sourceRevision === a.sourceRevision && saved.assignedJobRevision === a.assignedJobRevision &&
    saved.identity === cancellationSheetWriteIdentity(job), "ASSIGNMENT_JOB_CHANGED");
  need(typeof staff.displayName === "string" && staff.displayName.trim() && staff.displayName === (isManual(a) ? a.canonicalStaffName : a.staffName) && staff.companyId === queue.companyId && staff.active === true &&
    dayLock.companyId === queue.companyId && dayLock.jobId === queue.jobId && dayLock.staffId === a.staffId && dayLock.dateKey === a.dateKey && dayLock.active === true,
  "STAFF_OR_DAY_LOCK_CHANGED");
  need(canonical(queue.updates ?? {}) === canonical({ staffName: a.staffName }) && canonical(queue.expected ?? {}) === canonical({ staffName: isManual(a) ? { mode: "equals", value: a.staffName } : { mode: "blank" } }) &&
    canonical(queue.styles ?? {}) === "{}" && queue.idempotencyKey === `case_list.assign:${queue.jobId}:${queueId}`, "QUEUE_MUTATION_CHANGED");
  const payOffer = publicPayOffer(job), confirmation = object(approval.confirmedFields);
  if (isManual(a)) {
    const body = { ...approval }; delete body.ownerConditionsHash;
    need(approval.schema === "LK_CASE_LIST_MANUAL_CONDITIONS_V1" && approval.companyId === queue.companyId && approval.jobId === queue.jobId && approval.queueId === queueId &&
      approval.expectedSourceRevision === a.sourceRevision && approval.actorUid === queue.actorUid && a.selectorUid === queue.actorUid && ID.test(a.selectorUid ?? "") &&
      approval.staffId === a.staffId && approval.sourceStaffName === a.staffName && approval.canonicalStaffName === a.canonicalStaffName && approval.observationHash === a.observationHash &&
      HASH.test(a.observationHash ?? "") && HASH.test(a.ownerConditionsHash ?? "") && approval.ownerConditionsHash === a.ownerConditionsHash && hashCaseList(body) === a.ownerConditionsHash &&
      ["arrival", "execution", "headcount", "dateMode", "payOffer"].every(key => confirmation[key] === true) && !Object.hasOwn(confirmation, "vacancy") &&
      hashCaseList(approval.payOffer) === hashCaseList(payOffer) && job.caseListManualSelection?.queueId === queueId && job.caseListManualSelection?.ownerConditionsHash === a.ownerConditionsHash,
    "MANUAL_OWNER_APPROVAL_CHANGED");
  } else need(approval.companyId === queue.companyId && approval.jobId === queue.jobId && approval.expectedSourceRevision === a.sourceRevision && typeof approval.actorUid === "string" && approval.actorUid.trim() &&
    ["arrival", "execution", "headcount", "dateMode", "payOffer", "vacancy"].every(key => confirmation[key] === true) &&
    hashCaseList(approval.payOffer) === hashCaseList(payOffer) && job.caseListPublication?.sourceRevision === a.sourceRevision, "OWNER_APPROVAL_CHANGED");
  return { assignment: clone(a) as Assignment, spreadsheetId, payOffer };
}

/** Aliases never allocate identities. Every alias must resolve to one existing
 * server-owned company profile, including inactive profiles still on a sheet. */
export function buildCaseListStaffResolver(profiles: Array<{ id: string; data: Data }>): (name: string) => { staffId: string; identityVerified: true } | null {
  const names = new Map<string, Set<string>>();
  const key = (name: string): string => name.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
  for (const profile of profiles) {
    need(ID.test(profile.id) && typeof profile.data.displayName === "string" && profile.data.displayName.trim(), "STAFF_DIRECTORY_INVALID");
    const aliases = profile.data.aliases ?? [];
    need(Array.isArray(aliases) && aliases.length <= 100 && aliases.every(alias => typeof alias === "string" && alias.trim()), "STAFF_ALIASES_INVALID");
    for (const name of [profile.data.displayName, ...aliases] as string[]) {
      const current = names.get(key(name)) ?? new Set<string>(); current.add(profile.id); names.set(key(name), current);
    }
  }
  return name => { const matches = names.get(key(name)); return matches?.size === 1 ? { staffId: [...matches][0]!, identityVerified: true } : null; };
}

function nativeAssignment(a: Assignment, payOffer: PayOffer): Data {
  return { schema: a.schema, authority: isManual(a) ? "SOURCE_MANUAL" : "CREW_QUEUE", queueId: a.queueId, operationId: a.operationId, companyId: a.companyId, jobId: a.jobId, caseId: a.sourceCaseId,
    staffId: a.staffId, staffName: a.staffName, dateKey: a.dateKey, assignedJobRevision: a.assignedJobRevision,
    preCatalog: { rowRevision: a.sourceRowRevision, ledgerRevision: a.sourceLedgerRevision, sourceRevision: a.sourceRevision }, preMonthlyContentHash: a.preMonthlyContentHash,
    publicPayOffer: payOffer, ...(isManual(a) ? { canonicalStaffName: a.canonicalStaffName, observationHash: a.observationHash, ownerConditionsHash: a.ownerConditionsHash } : {}) };
}

/** Only an exact native readback bound to this current assignment can finish it. */
export function assertCaseListMonthlyAck(queueId: string, a: Assignment, payOffer: PayOffer, ack: Data, accepted: Data, intentDocument: Data, spreadsheetId: string): { target: Data; post: SourceRevision; caseIdColumn: "BC" | "BD" } {
  const payload = object(accepted.payload), intent = object(intentDocument.payload), month = object(intent.month), mapped = object(intent.mapped), target = object(ack.target), post = object(ack.postCatalog), pre = object(ack.preCatalog);
  const expectedPre = { rowRevision: a.sourceRowRevision, ledgerRevision: a.sourceLedgerRevision, sourceRevision: a.sourceRevision };
  sourceRevisions(pre); sourceRevisions(post);
  const unhashedIntent: Data = { ...intent, createdAt: 0 }; delete unhashedIntent.planHash;
  need(accepted.companyId === a.companyId && accepted.queueId === queueId && accepted.payloadHash === hashCaseList(payload) &&
    intentDocument.companyId === a.companyId && intentDocument.queueId === queueId && intentDocument.payloadHash === hashCaseList(intent) &&
    intent.stage === "INTENT" && intent.schema === "LK_MONTHLY_INTENT_V5" && intent.spreadsheetId === spreadsheetId && intent.operationId === queueId && intent.caseId === a.sourceCaseId && intent.fixedId === a.sourceCaseId &&
    HASH.test(intent.planHash ?? "") && intent.planHash === hashCaseList(unhashedIntent) && payload.planHash === intent.planHash &&
    intent.sourceContentHash === ack.postMonthlyContentHash && intent.postMonthlyContentHash === ack.postMonthlyContentHash && intent.preMonthlyContentHash === ack.preMonthlyContentHash &&
    canonical(intent.preCatalog) === canonical(ack.preCatalog) && canonical(intent.postCatalog) === canonical(ack.postCatalog) && intent.assignmentHash === hashCaseList(nativeAssignment(a, payOffer)) &&
    [55, 56].includes(month.width) && month.sheetId === target.sheetId && month.title === target.title && mapped.idColumn === month.width &&
    Array.isArray(mapped.business) && mapped.business.length === 54 && mapped.idCell?.userEnteredValue?.stringValue === a.sourceCaseId &&
    payload.stage === "ACCEPTED" && payload.operationId === queueId && payload.caseId === a.sourceCaseId && payload.spreadsheetId === spreadsheetId &&
    payload.sourceContentHash === ack.postMonthlyContentHash && payload.destinationContentHash === target.readbackHash && payload.assignmentHash === hashCaseList(nativeAssignment(a, payOffer)) &&
    canonical(payload.ack) === canonical(ack) &&
    ack.schema === "LK_CASE_LIST_MONTHLY_ACK_V1" && ack.status === "MONTHLY_READBACK_VERIFIED" && ack.spreadsheetId === spreadsheetId && ack.operationId === queueId && ack.queueId === queueId &&
    ack.companyId === a.companyId && ack.jobId === a.jobId && ack.sourceCaseId === a.sourceCaseId && ack.assignedJobRevision === a.assignedJobRevision && ack.staffId === a.staffId && ack.staffName === a.staffName && ack.dateKey === a.dateKey && ack.preserveSource === true &&
    sameRevisions(pre, expectedPre) && pre.version === 1 && post.version === 1 && pre.spreadsheetId === spreadsheetId && post.spreadsheetId === spreadsheetId &&
    pre.caseId === a.sourceCaseId && post.caseId === a.sourceCaseId && pre.sheetId === 2026101601 && post.sheetId === 2026101601 &&
    post.ledgerRevision === pre.ledgerRevision && (isManual(a) ? sameRevisions(post, pre) : post.rowRevision !== pre.rowRevision) && post.sourceRevision === hashCaseList({ schema: "LK_CASE_LIST_AUTHORITY_REVISION_V1", caseId: a.sourceCaseId, rowRevision: post.rowRevision, ledgerRevision: post.ledgerRevision }) &&
    ack.preMonthlyContentHash === a.preMonthlyContentHash && HASH.test(ack.postMonthlyContentHash ?? "") && (isManual(a) ? ack.postMonthlyContentHash === ack.preMonthlyContentHash : ack.postMonthlyContentHash !== ack.preMonthlyContentHash) && HASH.test(ack.financialReadbackHash ?? "") &&
    target.fixedId === a.sourceCaseId && target.title === a.dateKey.slice(0, 4) + "." + Number(a.dateKey.slice(5, 7)) && Number.isInteger(target.sheetId) && target.sheetId >= 0 && Number.isInteger(target.rowHint) && target.rowHint >= 2 && HASH.test(target.readbackHash ?? ""),
  "MONTHLY_ACK_BINDING_INVALID");
  return { target, post: sourceRevisions(post), caseIdColumn: month.width === 56 ? "BD" : "BC" };
}

/** Public jobs carry only source binding hashes. Full book identifiers and the
 * complete native ACK stay in the server-private operation/ref collections. */
export function publicCaseListMonthlyAck(ack: Data, spreadsheetId: string): Data {
  need(ack.spreadsheetId === spreadsheetId, "PUBLIC_ACK_BOOK_MISMATCH");
  const publicCatalog = (value: unknown) => {
    const source = object(value), revisions = sourceRevisions(source);
    need(source.spreadsheetId === spreadsheetId && source.sheetId === 2026101601 && source.caseId === ack.sourceCaseId && source.version === 1, "PUBLIC_ACK_SOURCE_BINDING_INVALID");
    return publicCaseListSource({ version: 1, spreadsheetId, sheetId: source.sheetId, caseId: source.caseId, ...revisions });
  };
  const target = object(ack.target);
  return { schema: ack.schema, status: ack.status, operationId: ack.operationId, queueId: ack.queueId, companyId: ack.companyId, jobId: ack.jobId,
    sourceCaseId: ack.sourceCaseId, bindingHash: hashCaseList({ schema: "LK_CASE_LIST_SOURCE_BINDING_V1", spreadsheetId, sheetId: 2026101601 }),
    preCatalog: publicCatalog(ack.preCatalog), postCatalog: publicCatalog(ack.postCatalog),
    preMonthlyContentHash: ack.preMonthlyContentHash, postMonthlyContentHash: ack.postMonthlyContentHash, assignedJobRevision: ack.assignedJobRevision,
    staffId: ack.staffId, staffName: ack.staffName, dateKey: ack.dateKey,
    target: { sheetId: target.sheetId, title: target.title, fixedId: target.fixedId, rowHint: target.rowHint, readbackHash: target.readbackHash,
      bindingHash: hashCaseList({ schema: "LK_CASE_LIST_SOURCE_BINDING_V1", spreadsheetId, sheetId: target.sheetId }) },
    financialReadbackHash: ack.financialReadbackHash, preserveSource: ack.preserveSource };
}

async function loadResolver(companyId: string) {
  const directory = await db.collection("staffProfiles").where("companyId", "==", companyId).limit(2001).get();
  need(directory.size <= 2000, "STAFF_DIRECTORY_SCOPE_TOO_LARGE");
  return buildCaseListStaffResolver(directory.docs.map(doc => ({ id: doc.id, data: doc.data() })));
}

function checkedEvent(record: Data | undefined, stage: string, queueId: string, queue: Data, spreadsheetId: string): Data {
  const payload = object(record?.payload);
  need(record && record.companyId === queue.companyId && record.queueId === queueId && record.payloadHash === hashCaseList(payload) &&
    payload.stage === stage && payload.operationId === queueId && payload.caseId === queue.caseListAssignment?.sourceCaseId && payload.spreadsheetId === spreadsheetId,
  "CONTINUATION_EVENT_INTEGRITY");
  return payload;
}
function normalizedHash(payload: Data, key: "intentHash" | "planHash"): string {
  const input: Data = { ...payload, createdAt: 0 }; delete input[key]; return hashCaseList(input);
}
function phaseHash(queueId: string, queue: Data, phase: Phase, nonce: string, proofStage: string, proofHash: string): string {
  return hashCaseList({ schema: PHASE_SCHEMA, queueId, companyId: queue.companyId, jobId: queue.jobId, caseId: queue.caseListAssignment?.sourceCaseId,
    assignedJobRevision: queue.caseListAssignment?.assignedJobRevision, queueFingerprint: fingerprint(queue), phase, nonce, proofStage, proofHash });
}
function checkedManualObservation(queueId: string, queue: Data, payOffer: PayOffer, records: Record<string, Data | undefined>, spreadsheetId: string): Data {
  const a = object(queue.caseListAssignment) as Assignment;
  need(isManual(a) && !["SOURCE_INTENT", "SOURCE_PROJECTED", "SOURCE_WRITE_STARTED", "SOURCE_DISPATCHED", "SOURCE_UNKNOWN", "SOURCE_DEFERRED"].some(stage => records[stage]), "MANUAL_SOURCE_WRITE_PROOF_FORBIDDEN");
  const observed = checkedEvent(records.SOURCE_MANUAL_OBSERVED, "SOURCE_MANUAL_OBSERVED", queueId, queue, spreadsheetId), body: Data = { ...observed, createdAt: 0 };
  delete body.observationProofHash;
  const catalog = { version: 1, spreadsheetId, sheetId: 2026101601, caseId: a.sourceCaseId, rowRevision: a.sourceRowRevision, ledgerRevision: a.sourceLedgerRevision, sourceRevision: a.sourceRevision };
  need(observed.schema === "LK_SOURCE_MANUAL_OBSERVED_V1" && observed.observationProofHash === hashCaseList(body) &&
    canonical(observed.assignment) === canonical(nativeAssignment(a, payOffer)) && observed.assignmentHash === hashCaseList(nativeAssignment(a, payOffer)) &&
    canonical(observed.preCatalog) === canonical(catalog) && canonical(observed.postCatalog) === canonical(catalog) &&
    observed.observationHash === a.observationHash && observed.ownerConditionsHash === a.ownerConditionsHash &&
    Array.isArray(observed.sourceSnapshot) && observed.sourceSnapshot.length === 65 && hashCaseList(observed.sourceSnapshot) === a.preMonthlyContentHash &&
    observed.preMonthlyContentHash === a.preMonthlyContentHash && observed.postMonthlyContentHash === a.preMonthlyContentHash &&
    observed.sourceSnapshot[2]?.userEnteredValue?.stringValue === a.staffName && observed.sourceSnapshot[60]?.userEnteredValue?.stringValue === a.sourceCaseId &&
    observed.sourceSnapshot[0]?.userEnteredValue?.boolValue === false && observed.sourceSnapshot[63]?.userEnteredValue?.boolValue === false &&
    observed.sourceSnapshot.every((cell: Data) => cell && !Array.isArray(cell) && Object.keys(cell).every(key => ["userEnteredValue", "note", "userEnteredFormat", "dataValidation", "textFormatRuns", "chipRuns"].includes(key))) && HASH.test(observed.dependencyHash ?? "") &&
    a.sourceRevision === hashCaseList({ schema: "LK_CASE_LIST_AUTHORITY_REVISION_V1", caseId: a.sourceCaseId, rowRevision: a.sourceRowRevision, ledgerRevision: a.sourceLedgerRevision }), "MANUAL_SOURCE_OBSERVATION_INVALID");
  return observed;
}
function assertManualMonthlyProof(queueId: string, queue: Data, payOffer: PayOffer, records: Record<string, Data | undefined>, spreadsheetId: string, requireMonthly: boolean): void {
  const a = object(queue.caseListAssignment) as Assignment, observed = checkedManualObservation(queueId, queue, payOffer, records, spreadsheetId);
  need(!requireMonthly || records.INTENT, "MONTHLY_INTENT_PROOF_REQUIRED");
  if (!records.INTENT) return;
  const intent = checkedEvent(records.INTENT, "INTENT", queueId, queue, spreadsheetId), selected = object(intent.ownerTransfer);
  need(intent.schema === "LK_MONTHLY_INTENT_V5" && intent.planHash === normalizedHash(intent, "planHash") && intent.assignmentHash === observed.assignmentHash &&
    canonical(intent.assignment) === canonical(observed.assignment) && canonical(intent.preCatalog) === canonical(observed.preCatalog) && canonical(intent.postCatalog) === canonical(observed.postCatalog) &&
    intent.preMonthlyContentHash === a.preMonthlyContentHash && intent.sourceContentHash === a.preMonthlyContentHash && intent.postMonthlyContentHash === a.preMonthlyContentHash &&
    canonical(intent.sourceSnapshot) === canonical(observed.sourceSnapshot) && intent.dependencyHash === observed.dependencyHash, "MANUAL_MONTHLY_PROOF_CHAIN_INVALID");
  need(selected.schema === "LK_OWNER_MONTHLY_TRANSFER_V1" && selected.selected === true && selected.clientNameUpConfirmed === true && selected.sourceControlHeader === "キャンセル" &&
    intent.sourceSnapshot[0]?.userEnteredValue?.boolValue === false && selected.operationId === queueId && selected.caseId === a.sourceCaseId && selected.queueFingerprint === fingerprint(queue) &&
    selected.assignmentHash === observed.assignmentHash && selected.sourceContentHash === a.preMonthlyContentHash && selected.sourceRevision === a.sourceRevision &&
    selected.selectedBy === a.selectorUid && Number.isFinite(selected.selectedAt) && selected.selectedAt > 0, "MANUAL_MONTHLY_SELECTION_PROOF_REQUIRED");
  for (const stage of ["MONTHLY_WRITE_STARTED", "MONTHLY_DISPATCHED", "UNKNOWN", "DEFERRED", "ACCEPTED"]) if (records[stage]) {
    need(checkedEvent(records[stage], stage, queueId, queue, spreadsheetId).planHash === intent.planHash, "MONTHLY_DISPATCH_PROOF_CHAIN_INVALID");
  }
}

/** Exact immutable Source-before/only-C-after/projection/monthly-intent
 * lineage. Recovery must not accept a rehashed but inconsistent history. */
export function assertCaseListMonthlyProofChain(queueId: string, queue: Data, payOffer: PayOffer, records: Record<string, Data | undefined>, spreadsheetId: string, requireProjected = false, requireMonthly = false): void {
  if (isManual(object(queue.caseListAssignment))) return assertManualMonthlyProof(queueId, queue, payOffer, records, spreadsheetId, requireMonthly);
  const a = object(queue.caseListAssignment) as Assignment, source = checkedEvent(records.SOURCE_INTENT, "SOURCE_INTENT", queueId, queue, spreadsheetId);
  const before = source.sourceBefore, after = source.expectedSourceAfter, assignment = nativeAssignment(a, payOffer);
  const preCatalog = { version: 1, spreadsheetId, sheetId: 2026101601, caseId: a.sourceCaseId,
    rowRevision: a.sourceRowRevision, ledgerRevision: a.sourceLedgerRevision, sourceRevision: a.sourceRevision };
  need(a.sourceRevision === hashCaseList({ schema: "LK_CASE_LIST_AUTHORITY_REVISION_V1", caseId: a.sourceCaseId, rowRevision: a.sourceRowRevision, ledgerRevision: a.sourceLedgerRevision }) &&
    source.schema === "LK_SOURCE_ASSIGNMENT_INTENT_V1" && source.intentHash === normalizedHash(source, "intentHash") && source.assignmentHash === hashCaseList(assignment) && canonical(source.assignment) === canonical(assignment) &&
    canonical(source.preCatalog) === canonical(preCatalog) && source.preMonthlyContentHash === a.preMonthlyContentHash && Array.isArray(before) && before.length === 65 && hashCaseList(before) === a.preMonthlyContentHash &&
    Array.isArray(after) && after.length === 65 && hashCaseList(after) === source.expectedPostMonthlyContentHash, "SOURCE_PROOF_CHAIN_INVALID");
  const onlyC = clone(before); onlyC[2] = { ...onlyC[2], userEnteredValue: { stringValue: a.staffName } };
  need(canonical(onlyC) === canonical(after), "SOURCE_PROOF_AFTERIMAGE_INVALID");
  for (const stage of ["SOURCE_WRITE_STARTED", "SOURCE_DISPATCHED", "SOURCE_UNKNOWN", "SOURCE_DEFERRED"]) if (records[stage]) {
    const event = checkedEvent(records[stage], stage, queueId, queue, spreadsheetId);
    need(event.intentHash === source.intentHash, "SOURCE_DISPATCH_PROOF_CHAIN_INVALID");
  }
  need(!requireProjected || records.SOURCE_PROJECTED, "SOURCE_PROJECTED_PROOF_REQUIRED");
  if (records.SOURCE_PROJECTED) {
    const projected = checkedEvent(records.SOURCE_PROJECTED, "SOURCE_PROJECTED", queueId, queue, spreadsheetId), post = object(projected.postCatalog);
    sourceRevisions(post);
    need(projected.schema === "LK_SOURCE_ASSIGNMENT_PROJECTED_V1" && projected.intentHash === source.intentHash && projected.assignmentHash === source.assignmentHash &&
      canonical(projected.preCatalog) === canonical(preCatalog) && projected.preMonthlyContentHash === a.preMonthlyContentHash && projected.postMonthlyContentHash === source.expectedPostMonthlyContentHash &&
      post.version === 1 && post.spreadsheetId === spreadsheetId && post.sheetId === 2026101601 && post.caseId === a.sourceCaseId && post.ledgerRevision === a.sourceLedgerRevision && post.rowRevision !== a.sourceRowRevision &&
      post.sourceRevision === hashCaseList({ schema: "LK_CASE_LIST_AUTHORITY_REVISION_V1", caseId: a.sourceCaseId, rowRevision: post.rowRevision, ledgerRevision: post.ledgerRevision }), "PROJECTED_PROOF_CHAIN_INVALID");
  }
  need(!requireMonthly || records.INTENT, "MONTHLY_INTENT_PROOF_REQUIRED");
  if (records.INTENT) {
    need(records.SOURCE_PROJECTED, "MONTHLY_PROJECTION_PROOF_REQUIRED");
    const projected = object(records.SOURCE_PROJECTED?.payload), intent = checkedEvent(records.INTENT, "INTENT", queueId, queue, spreadsheetId);
    need(intent.schema === "LK_MONTHLY_INTENT_V5" && intent.planHash === normalizedHash(intent, "planHash") && intent.assignmentHash === source.assignmentHash && canonical(intent.assignment) === canonical(assignment) &&
      canonical(intent.preCatalog) === canonical(preCatalog) && canonical(intent.postCatalog) === canonical(projected.postCatalog) && intent.preMonthlyContentHash === a.preMonthlyContentHash &&
      intent.sourceContentHash === source.expectedPostMonthlyContentHash && intent.postMonthlyContentHash === source.expectedPostMonthlyContentHash && canonical(intent.sourceSnapshot) === canonical(after), "MONTHLY_PROOF_CHAIN_INVALID");
    const selected = object(intent.ownerTransfer);
    need(selected.schema === "LK_OWNER_MONTHLY_TRANSFER_V1" && selected.selected === true && selected.clientNameUpConfirmed === true &&
      ["キャンセル", "月別転記"].includes(selected.sourceControlHeader) && (selected.sourceControlHeader !== "キャンセル" || intent.sourceSnapshot[0]?.userEnteredValue?.boolValue === false) &&
      selected.operationId === queueId && selected.caseId === a.sourceCaseId && selected.queueFingerprint === fingerprint(queue) && selected.assignmentHash === source.assignmentHash &&
      selected.sourceContentHash === intent.sourceContentHash && selected.sourceRevision === object(intent.postCatalog).sourceRevision && ID.test(selected.selectedBy ?? "") && Number.isFinite(selected.selectedAt) && selected.selectedAt > 0,
    "MONTHLY_SELECTION_PROOF_REQUIRED");
    for (const stage of ["MONTHLY_WRITE_STARTED", "MONTHLY_DISPATCHED", "UNKNOWN", "DEFERRED", "ACCEPTED"]) if (records[stage]) {
      const event = checkedEvent(records[stage], stage, queueId, queue, spreadsheetId);
      need(event.planHash === intent.planHash, "MONTHLY_DISPATCH_PROOF_CHAIN_INVALID");
    }
  }
}

/** A continuation is permission for one already-defined next phase, not a
 * retry of an unknown request. Its proof lives in immutable private events. */
export function assertKnownCaseListContinuation(queueId: string, queue: Data, operation: Data, records: Record<string, Data | undefined>, spreadsheetId: string): Phase {
  const next = object(queue.caseListPhase), phase = next.phase as Phase, a = object(queue.caseListAssignment) as Assignment;
  if (isManual(a)) {
    need(next.schema === PHASE_SCHEMA && ["MONTHLY_PREPARE", "MONTHLY_APPLY", "MONTHLY_RECONCILE"].includes(phase) && ID.test(next.nonce ?? "") &&
      operation.schema === "LK_CASE_LIST_MONTHLY_OPERATION_V1" && operation.companyId === queue.companyId && operation.jobId === queue.jobId && operation.queueId === queueId && operation.caseId === a.sourceCaseId &&
      operation.status === "awaiting_continuation" && operation.phaseState === "ready" && operation.phase === phase && operation.phaseNonce === next.nonce &&
      operation.queueFingerprint === fingerprint(queue) && operation.continuationHash === next.continuationHash && operation.proofStage === next.proofStage && operation.proofHash === next.proofHash &&
      (phase === "MONTHLY_PREPARE" ? next.proofStage === "SOURCE_MANUAL_OBSERVED" : PREVIOUS_PROOF[phase] === next.proofStage) && HASH.test(next.proofHash ?? "") &&
      next.continuationHash === phaseHash(queueId, queue, phase, next.nonce, next.proofStage, next.proofHash), "KNOWN_MANUAL_CONTINUATION_BINDING_REQUIRED");
    need(!records.UNKNOWN && !records.DEFERRED && !(phase === "MONTHLY_APPLY" && records.MONTHLY_WRITE_STARTED), "UNKNOWN_OPERATION_OWNER_RECONCILIATION_REQUIRED");
    const payOffer = object(object(records.SOURCE_MANUAL_OBSERVED?.payload).assignment?.publicPayOffer) as PayOffer;
    assertManualMonthlyProof(queueId, queue, payOffer, records, spreadsheetId, phase !== "MONTHLY_PREPARE");
    need(operation.publicPayOfferHash === hashCaseList(payOffer) && records[next.proofStage]?.payloadHash === next.proofHash, "MANUAL_CONTINUATION_PROOF_CHANGED");
    return phase;
  }
  need(next.schema === PHASE_SCHEMA && Object.hasOwn(PHASES, phase) && phase !== "SOURCE_PREPARE" && ID.test(next.nonce ?? "") &&
    operation.schema === "LK_CASE_LIST_MONTHLY_OPERATION_V1" && operation.companyId === queue.companyId && operation.jobId === queue.jobId && operation.queueId === queueId && operation.caseId === a.sourceCaseId &&
    operation.status === "awaiting_continuation" && operation.phaseState === "ready" && operation.phase === phase && operation.phaseNonce === next.nonce &&
    operation.queueFingerprint === fingerprint(queue) && operation.continuationHash === next.continuationHash && operation.proofStage === next.proofStage && operation.proofHash === next.proofHash &&
    PREVIOUS_PROOF[phase] === next.proofStage && HASH.test(next.proofHash ?? "") && next.continuationHash === phaseHash(queueId, queue, phase, next.nonce, next.proofStage, next.proofHash),
  "KNOWN_CONTINUATION_BINDING_REQUIRED");
  need(!["SOURCE_UNKNOWN", "UNKNOWN", "SOURCE_DEFERRED", "DEFERRED"].some(stage => records[stage]), "UNKNOWN_OPERATION_OWNER_RECONCILIATION_REQUIRED");
  need(!(phase === "SOURCE_APPLY" && records.SOURCE_WRITE_STARTED) && !(phase === "MONTHLY_APPLY" && records.MONTHLY_WRITE_STARTED), "STARTED_OPERATION_OWNER_RECONCILIATION_REQUIRED");
  assertCaseListMonthlyProofChain(queueId, queue, object(records.SOURCE_INTENT?.payload).assignment?.publicPayOffer, records, spreadsheetId,
    ["SOURCE_PROJECTED", "INTENT", "MONTHLY_DISPATCHED"].includes(next.proofStage), ["INTENT", "MONTHLY_DISPATCHED"].includes(next.proofStage));
  const source = checkedEvent(records.SOURCE_INTENT, "SOURCE_INTENT", queueId, queue, spreadsheetId), before = source.sourceBefore, after = source.expectedSourceAfter;
  need(source.schema === "LK_SOURCE_ASSIGNMENT_INTENT_V1" && source.intentHash === normalizedHash(source, "intentHash") &&
    source.assignmentHash === hashCaseList(source.assignment) && source.assignmentHash === hashCaseList(nativeAssignment(a, source.assignment?.publicPayOffer)) && operation.publicPayOfferHash === hashCaseList(source.assignment?.publicPayOffer) &&
    source.preMonthlyContentHash === a.preMonthlyContentHash && sameRevisions(object(source.preCatalog), { rowRevision: a.sourceRowRevision, ledgerRevision: a.sourceLedgerRevision, sourceRevision: a.sourceRevision }) &&
    Array.isArray(before) && before.length === 65 && hashCaseList(before) === a.preMonthlyContentHash && Array.isArray(after) && after.length === 65 && hashCaseList(after) === source.expectedPostMonthlyContentHash,
  "CONTINUATION_SOURCE_INTENT_INVALID");
  const expected = clone(before); expected[2] = { ...expected[2], userEnteredValue: { stringValue: a.staffName } };
  need(canonical(expected) === canonical(after), "CONTINUATION_SOURCE_AFTERIMAGE_INVALID");
  const proof = checkedEvent(records[next.proofStage], next.proofStage, queueId, queue, spreadsheetId);
  need(records[next.proofStage]?.payloadHash === next.proofHash, "CONTINUATION_PROOF_CHANGED");
  if (next.proofStage === "SOURCE_DISPATCHED" || next.proofStage === "SOURCE_PROJECTED") need(proof.intentHash === source.intentHash, "CONTINUATION_SOURCE_INTENT_CHANGED");
  if (["SOURCE_PROJECTED", "INTENT", "MONTHLY_DISPATCHED"].includes(next.proofStage)) {
    const projected = checkedEvent(records.SOURCE_PROJECTED, "SOURCE_PROJECTED", queueId, queue, spreadsheetId);
    need(projected.intentHash === source.intentHash && projected.assignmentHash === source.assignmentHash && projected.preMonthlyContentHash === a.preMonthlyContentHash &&
      projected.postMonthlyContentHash === source.expectedPostMonthlyContentHash, "CONTINUATION_SOURCE_PROJECTION_INVALID");
  }
  if (next.proofStage === "INTENT" || next.proofStage === "MONTHLY_DISPATCHED") {
    const intent = checkedEvent(records.INTENT, "INTENT", queueId, queue, spreadsheetId);
    need(intent.schema === "LK_MONTHLY_INTENT_V5" && intent.planHash === normalizedHash(intent, "planHash") && intent.assignmentHash === source.assignmentHash &&
      intent.preMonthlyContentHash === a.preMonthlyContentHash && intent.sourceContentHash === source.expectedPostMonthlyContentHash && intent.postMonthlyContentHash === source.expectedPostMonthlyContentHash,
    "CONTINUATION_MONTHLY_INTENT_INVALID");
    if (next.proofStage === "MONTHLY_DISPATCHED") need(proof.planHash === intent.planHash, "CONTINUATION_MONTHLY_DISPATCH_CHANGED");
  }
  return phase;
}

async function continuationRecords(tx: Tx, operationRef: Ref): Promise<Record<string, Data | undefined>> {
  const stages = ["SOURCE_MANUAL_OBSERVED", "SOURCE_INTENT", "SOURCE_DISPATCHED", "SOURCE_PROJECTED", "INTENT", "MONTHLY_DISPATCHED", "SOURCE_UNKNOWN", "UNKNOWN", "SOURCE_DEFERRED", "DEFERRED", "SOURCE_WRITE_STARTED", "MONTHLY_WRITE_STARTED", "ACCEPTED"];
  const snapshots = await Promise.all(stages.map(stage => tx.get(operationRef.collection("events").doc(stage))));
  return Object.fromEntries(stages.map((stage, index) => [stage, snapshots[index]!.data()]));
}

/** Called before the legacy paused writer path. Returning true owns only this
 * new operation; disabled/config/global-stop paths leave its queue unchanged. */
async function runCaseListMonthlyAssignment(queueRef: Ref, owner?: { actorUid: string; token: Data }): Promise<Data> {
  const invocationStartedAt = Date.now(), invocationDeadline = invocationStartedAt + INVOCATION_MS;
  const observed = await queueRef.get(), initial = observed.data();
  if (!initial || initial.operation !== "case_list.assign") return { status: "UNRELATED_OPERATION" };
  if (owner) {
    assertExecutive(owner.token, process.env.EXECUTIVE_APPROVER_EMAILS ?? "");
    need(ID.test(owner.actorUid) && owner.token.companyId === initial.companyId && (owner.token.uid ?? owner.token.sub) === owner.actorUid, "OWNER_RECONCILIATION_IDENTITY_INVALID");
    need(initial.status !== "completed", "OWNER_RECONCILIATION_ALREADY_COMPLETED");
    if (initial.errorType === "owner_transfer_required" && initial.caseListPhase?.phase === "MONTHLY_PREPARE") return { status: "OWNER_TRANSFER_SELECTION_REQUIRED", snapshotReads: 0, nativeBatches: 0 };
  } else if (initial.status !== "pending") return { status: "QUEUE_NOT_PENDING" };
  if (!ID.test(initial.companyId ?? "") || !ID.test(initial.jobId ?? "")) return { status: "QUEUE_IDENTITY_INVALID" };
  const configRef = db.collection("sheetImportConfigs").doc(initial.companyId), config = (await configRef.get()).data();
  if (!config || config.companyId !== initial.companyId || config.caseListEnabled !== true || (!owner && config.caseListAssignmentsEnabled !== true)) return { status: "CASE_LIST_WRITER_DISABLED" };
  if (!(await getProductionOperationalState(initial.companyId)).operational) return { status: "GLOBAL_OPERATION_STOPPED" };

  const claimToken = randomUUID(), operationRef = db.collection("caseListMonthlyOperations").doc(sha256(initial.companyId + "|" + queueRef.id));
  const syncLockRef = db.collection("caseListSyncLocks").doc(initial.companyId), jobRef = db.collection("jobs").doc(initial.jobId);
  const approvalRef = db.collection("caseListApprovals").doc(initial.jobId);
  let acquired = false, trusted: Trusted | null = null, phase: Phase = "SOURCE_PREPARE", phaseNonce = randomUUID();
  let snapshotReads = 0, nativeBatches = 0;
  async function readTrusted(tx: Tx, requireClaim: boolean): Promise<Trusted> {
    const [queueSnap, jobSnap, configSnap, approvalSnap, leaseSnap, operationSnap] = await Promise.all([
      tx.get(queueRef), tx.get(jobRef), tx.get(configRef), tx.get(approvalRef), tx.get(syncLockRef), tx.get(operationRef),
    ]);
    const queue = queueSnap.data(), job = jobSnap.data(), currentConfig = configSnap.data(), approval = isManual(object(queueSnap.data()?.caseListAssignment)) ? operationSnap.data()?.manualConditions : approvalSnap.data();
    need(queue && job && currentConfig && approval && queue.companyId === initial!.companyId && queue.jobId === initial!.jobId, "TRUSTED_DOCUMENT_MISSING");
    need(ID.test(queue.actorStaffId ?? "") && ID.test(queue.actorUid ?? "") && validDate(queue.dateKey), "QUEUE_ACTOR_INVALID");
    const [staffSnap, daySnap, identitySnap] = await Promise.all([
      tx.get(db.collection("staffProfiles").doc(queue.actorStaffId)),
      tx.get(db.collection("staffDayLocks").doc(`${queue.companyId}_${queue.actorStaffId}_${queue.dateKey}`)),
      tx.get(db.collection("authIdentities").doc(queue.actorUid)),
    ]);
    const staff = staffSnap.data(), dayLock = daySnap.data(), identity = identitySnap.data();
    need(staff && dayLock && (!identitySnap.exists || identity?.active === true && identity.companyId === queue.companyId && (isManual(object(queue.caseListAssignment)) || identity.staffId === queue.actorStaffId)), "ACTOR_IDENTITY_REVOKED");
    const checked = assertCaseListMonthlyAuthority(queueRef.id, queue, job, staff, dayLock, currentConfig, approval, !!owner);
    if (requireClaim) {
      const lease = leaseSnap.data(), operation = operationSnap.data();
      need(queue.status === "processing" && queue.claimToken === claimToken && queue.retryAt instanceof Timestamp && queue.retryAt.toMillis() > Date.now() &&
        lease?.tokenId === claimToken && lease.activeUntil instanceof Timestamp && lease.activeUntil.toMillis() > Date.now() &&
        operation?.claimToken === claimToken && operation.companyId === queue.companyId && operation.queueId === queueRef.id && operation.jobId === queue.jobId &&
        operation.queueFingerprint === fingerprint(queue) && operation.publicPayOfferHash === hashCaseList(checked.payOffer) && operation.phaseState === "running" &&
        operation.phase === (owner ? "OWNER_RECONCILE" : phase) && operation.phaseNonce === phaseNonce &&
        (owner ? operation.reconciliationActorUid === owner.actorUid : queue.caseListPhase?.phase === phase && queue.caseListPhase?.nonce === phaseNonce), "MONTHLY_LEASE_OR_AUTHORITY_CHANGED");
    }
    const ownerTransferSelection = object(operationSnap.data()?.ownerTransferSelection);
    if (requireClaim && !owner && phase.startsWith("MONTHLY_")) need(ownerTransferSelection.schema === "LK_OWNER_MONTHLY_TRANSFER_V1" &&
      ownerTransferSelection.queueFingerprint === fingerprint(queue) && ownerTransferSelection.selected === true && ownerTransferSelection.clientNameUpConfirmed === true,
    "OWNER_TRANSFER_SELECTION_REQUIRED");
    return { queue, job, config: currentConfig, staff, dayLock, approval, ownerTransferSelection, ...checked };
  }
  async function authorize(): Promise<Trusted> {
    need((await getProductionOperationalState(initial!.companyId)).operational, "GLOBAL_OPERATION_STOPPED");
    return db.runTransaction(tx => readTrusted(tx, true));
  }
  async function hold(reason: string): Promise<void> {
    await db.runTransaction(async tx => {
      const current = (await tx.get(queueRef)).data();
      if (!current || current.claimToken !== claimToken || current.status !== "processing") return;
      tx.set(queueRef, { status: "blocked", errorType: "verification_required", writeVerificationRequired: true, retryAt: null,
        errorMessage: "案件リストと月別シフトの確認が必要です。元のデータを保持し、自動再書込を停止しました。",
        caseListMonthlyReason: /^[A-Z0-9_]{1,100}$/.test(reason) ? reason : "MONTHLY_EXECUTION_HELD", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(operationRef, { status: "held", phaseState: "held", budget: { phase: owner ? "OWNER_RECONCILE" : phase, snapshotReads, nativeBatches, elapsedMs: Math.max(0, Date.now() - invocationStartedAt) }, heldReason: /^[A-Z0-9_]{1,100}$/.test(reason) ? reason : "MONTHLY_EXECUTION_HELD", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
  }
  async function holdUnclaimed(reason: string): Promise<void> {
    if (!(await getProductionOperationalState(initial!.companyId)).operational) return;
    await db.runTransaction(async tx => {
      const [queueSnap, configSnap, operationSnap] = await Promise.all([tx.get(queueRef), tx.get(configRef), tx.get(operationRef)]);
      const current = queueSnap.data(), enabled = configSnap.data();
      if (!current || !enabled || current.status !== "pending" || current.operation !== "case_list.assign" || fingerprint(current) !== fingerprint(initial!) ||
        enabled.companyId !== initial!.companyId || enabled.caseListEnabled !== true || enabled.caseListAssignmentsEnabled !== true) return;
      const priorOperation = operationSnap.exists;
      let knownReady = false;
      if (priorOperation && reason === "ANOTHER_CASE_LIST_OPERATION_ACTIVE") {
        const records = await continuationRecords(tx, operationRef);
        try { assertKnownCaseListContinuation(queueRef.id, current, operationSnap.data()!, records, configuredCaseListSource(enabled.spreadsheetId).spreadsheetId); knownReady = true; } catch { /* held below */ }
      }
      const busy = reason === "ANOTHER_CASE_LIST_OPERATION_ACTIVE" && (!priorOperation || knownReady);
      tx.set(queueRef, { status: busy ? "retry_wait" : "blocked", errorType: busy ? "case_list_prewrite_busy" : priorOperation ? "verification_required" : "conflict",
        writeVerificationRequired: priorOperation && !knownReady, retryAt: busy ? Timestamp.fromMillis(Date.now() + 60_000) : null,
        caseListMonthlyReason: busy ? "CASE_LIST_PREWRITE_BUSY" : /^[A-Z0-9_]{1,100}$/.test(reason) ? reason : "MONTHLY_AUTHORITY_HELD",
        errorMessage: busy ? "別の案件リスト処理が完了するまで待機しています。まだシフト表へ書き込んでいません。" : "現在の手配・原本・確認情報の照合が必要です。自動再書込を停止しました。",
        updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
  }
  try {
    trusted = await db.runTransaction(async tx => {
      const current = await readTrusted(tx, false), lease = (await tx.get(syncLockRef)).data(), operation = (await tx.get(operationRef)).data();
      const records = await continuationRecords(tx, operationRef);
      if (owner) {
        need(!(current.queue.retryAt instanceof Timestamp) || current.queue.retryAt.toMillis() <= Date.now(), "OWNER_RECONCILIATION_LEASE_ACTIVE");
        need(!(lease?.activeUntil instanceof Timestamp) || lease.activeUntil.toMillis() <= Date.now(), "OWNER_RECONCILIATION_LEASE_ACTIVE");
        need(operation?.schema === "LK_CASE_LIST_MONTHLY_OPERATION_V1" && operation.companyId === current.queue.companyId && operation.queueId === queueRef.id &&
          operation.jobId === current.queue.jobId && operation.caseId === current.assignment.sourceCaseId && operation.status !== "completed" &&
          operation.queueFingerprint === fingerprint(current.queue) && operation.publicPayOfferHash === hashCaseList(current.payOffer), "OWNER_OPERATION_BINDING_INVALID");
        // Owner reconciliation is read-only on Google. It can observe unknown
        // after-images, but cannot turn a previous native request into a retry.
        assertCaseListMonthlyProofChain(queueRef.id, current.queue, current.payOffer, records, current.spreadsheetId);
      } else {
        if (current.queue.status !== "pending") return null;
        need(current.queue.writeVerificationRequired !== true && current.queue.errorType !== "verification_required", "PRIOR_WRITE_REQUIRES_RECONCILIATION");
        need(!(lease?.activeUntil instanceof Timestamp) || lease.activeUntil.toMillis() <= Date.now(), "ANOTHER_CASE_LIST_OPERATION_ACTIVE");
        if (operation) {
          phase = assertKnownCaseListContinuation(queueRef.id, current.queue, operation, records, current.spreadsheetId);
          phaseNonce = current.queue.caseListPhase.nonce;
        } else {
          need(!current.queue.caseListPhase && !Object.values(records).some(Boolean), "ORPHAN_OPERATION_PROOF_REQUIRES_RECONCILIATION");
          phase = "SOURCE_PREPARE";
        }
      }
      const deadline = Timestamp.fromMillis(Date.now() + LEASE_MS), now = Timestamp.now();
      const phaseState = { schema: PHASE_SCHEMA, phase: owner ? "OWNER_RECONCILE" : phase, nonce: phaseNonce };
      tx.set(queueRef, { status: "processing", claimToken, retryAt: deadline, attempts: Number(current.queue.attempts ?? 0) + 1, processingStartedAt: now,
        caseListPhase: phaseState }, { merge: true });
      tx.set(syncLockRef, { tokenId: claimToken, activeUntil: deadline, actorUid: owner?.actorUid ?? current.queue.actorUid, kind: "case_list.assign", queueId: queueRef.id });
      const operationState = { schema: "LK_CASE_LIST_MONTHLY_OPERATION_V1", companyId: current.queue.companyId, jobId: current.queue.jobId, queueId: queueRef.id,
        caseId: current.assignment.sourceCaseId, claimToken, queueFingerprint: fingerprint(current.queue), publicPayOfferHash: hashCaseList(current.payOffer),
        status: "processing", phaseState: "running", phase: owner ? "OWNER_RECONCILE" : phase, phaseNonce,
        ...(owner ? { reconciliationActorUid: owner.actorUid } : {}), sourcePreRevision: current.assignment.sourceRevision, updatedAt: now };
      if (operation) tx.set(operationRef, operationState, { merge: true }); else tx.create(operationRef, { ...operationState, createdAt: now });
      return current;
    });
    if (!trusted) return { status: "QUEUE_NOT_PENDING" };
    acquired = true;
    const binding = trusted, spreadsheetId = binding.spreadsheetId;
    async function readSnapshot(): Promise<Snapshot> {
      need(++snapshotReads <= 2, "INVOCATION_SNAPSHOT_BUDGET_EXCEEDED");
      await authorize();
      const resolveStaff = await loadResolver(binding.queue.companyId);
      const snapshot = await readCaseListMonthlySnapshot(binding.queue.companyId, binding.assignment.sourceCaseId, { includeDependencies: true, resolveStaff });
      need(snapshot.spreadsheetId === spreadsheetId && snapshot.isolated === false, "LIVE_SNAPSHOT_BOOK_CHANGED");
      return snapshot;
    }
    async function readEvents(operationId: string): Promise<Data[]> {
      need(operationId === queueRef.id, "JOURNAL_OPERATION_MISMATCH"); await authorize();
      const events = await operationRef.collection("events").limit(33).get(); need(events.size <= 32, "JOURNAL_EVENT_LIMIT");
      return events.docs.map(doc => {
        const value = doc.data(), payload = object(value.payload);
        need(doc.id === payload.stage && value.companyId === binding.queue.companyId && value.queueId === queueRef.id && value.payloadHash === hashCaseList(payload) &&
          payload.operationId === queueRef.id && payload.caseId === binding.assignment.sourceCaseId && payload.spreadsheetId === spreadsheetId, "JOURNAL_EVENT_INTEGRITY");
        return clone(payload);
      });
    }
    async function appendEvent(event: Data): Promise<void> {
      need(typeof event.stage === "string" && /^[A-Z_]{1,40}$/.test(event.stage) && event.operationId === queueRef.id && event.caseId === binding.assignment.sourceCaseId && event.spreadsheetId === spreadsheetId,
        "JOURNAL_EVENT_SCOPE");
      const payload = clone(event), payloadHash = hashCaseList(payload); need(Buffer.byteLength(canonical(payload), "utf8") < 850_000, "JOURNAL_EVENT_TOO_LARGE");
      await db.runTransaction(async tx => {
        await readTrusted(tx, true);
        const ref = operationRef.collection("events").doc(event.stage), prior = await tx.get(ref);
        if (prior.exists) { need(prior.data()?.payloadHash === payloadHash && canonical(prior.data()?.payload) === canonical(payload), "JOURNAL_STAGE_CONFLICT"); return; }
        tx.create(ref, { companyId: binding.queue.companyId, queueId: queueRef.id, payloadHash, payload, createdAt: Timestamp.now() });
        tx.set(operationRef, { lastStage: event.stage, updatedAt: Timestamp.now() }, { merge: true });
      });
    }
    // Owner mode never constructs a Google write client. The only injected
    // mutation callbacks below fail before any transport access.
    const sheets = owner ? null : google.sheets({ version: "v4", auth: new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] }) });
    const mutation = owner ? { applySourceAssignment: async () => stop("OWNER_RECONCILIATION_GOOGLE_WRITE_FORBIDDEN"), applyMonthly: async () => stop("OWNER_RECONCILIATION_GOOGLE_WRITE_FORBIDDEN") } : adapter.createGoogleSheetsMutationAdapter({ spreadsheetId, hash: sha256, readSnapshot, transport: { batchUpdate: async body => {
      need(!owner, "OWNER_RECONCILIATION_GOOGLE_WRITE_FORBIDDEN");
      need(++nativeBatches <= 1, "INVOCATION_NATIVE_BATCH_BUDGET_EXCEEDED");
      await authorize(); need(body.spreadsheetId === spreadsheetId && Array.isArray(body.requests) && body.requests.length >= 1 && body.requests.length <= 3, "NATIVE_MUTATION_SCOPE");
      // Leave metadata headroom within this invocation; the platform default
      // timeout is not extended. Slow reads can only hold, never start a late
      // non-idempotent POST. A timed-out POST remains an unknown write.
      const nativeTimeout = Math.min(MAX_NATIVE_TIMEOUT_MS, invocationDeadline - Date.now() - NATIVE_HEADROOM_MS);
      need(nativeTimeout >= 2_000, "INVOCATION_TIME_BUDGET_EXCEEDED_BEFORE_NATIVE");
      // The portable controller has durably verified its WRITE_STARTED event.
      // The native adapter creates only C or a new monthly row; there is no retry.
      return sheets!.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: body.requests } }, {
        retry: false, retryConfig: { retry: 0, noResponseRetries: 0, httpMethodsToRetry: [] }, timeout: nativeTimeout,
      });
    } } });
    const services = {
      spreadsheetId, sha256, now: () => Date.now(), withLock: async (fn: () => Promise<unknown>) => { await authorize(); return fn(); },
      authorize, readSnapshot, readEvents, appendEvent,
      resolveAssignment: async () => {
        const current = await authorize(), a = current.assignment;
        return nativeAssignment(a, current.payOffer);
      },
      authorizeMonthlyTransfer: async () => clone((await authorize()).ownerTransferSelection),
      ...mutation,
    };
    const core = controller.create(services), request = { operationId: queueRef.id, caseId: binding.assignment.sourceCaseId };
    let result: CoreResult;
    if (owner) {
      const events = await readEvents(queueRef.id);
      if (isManual(binding.assignment)) {
        const records = Object.fromEntries(events.map(payload => [payload.stage, { companyId: binding.queue.companyId, queueId: queueRef.id, payload, payloadHash: hashCaseList(payload) }]));
        checkedManualObservation(queueRef.id, binding.queue, binding.payOffer, records, spreadsheetId);
        const intent = events.find(event => event.stage === "INTENT"), started = events.find(event => event.stage === "MONTHLY_WRITE_STARTED");
        if (!intent || !started) { await hold("OWNER_RESUME_REQUIRED"); return { status: "OWNER_RESUME_REQUIRED", snapshotReads, nativeBatches }; }
        assertManualMonthlyProof(queueRef.id, binding.queue, binding.payOffer, records, spreadsheetId, true);
        result = await core.reconcile(request);
      } else {
      const sourceIntent = events.find(event => event.stage === "SOURCE_INTENT");
      need(sourceIntent && sourceIntent.intentHash === normalizedHash(sourceIntent, "intentHash") && sourceIntent.assignmentHash === hashCaseList(nativeAssignment(binding.assignment, binding.payOffer)), "OWNER_SOURCE_INTENT_INVALID");
      const before = sourceIntent.sourceBefore, after = sourceIntent.expectedSourceAfter;
      need(sourceIntent.preMonthlyContentHash === binding.assignment.preMonthlyContentHash && Array.isArray(before) && before.length === 65 &&
        hashCaseList(before) === binding.assignment.preMonthlyContentHash && Array.isArray(after) && after.length === 65 &&
        hashCaseList(after) === sourceIntent.expectedPostMonthlyContentHash, "OWNER_SOURCE_PREIMAGE_INVALID");
      const onlyC = clone(before); onlyC[2] = { ...onlyC[2], userEnteredValue: { stringValue: binding.assignment.staffName } };
      need(canonical(onlyC) === canonical(after), "OWNER_SOURCE_AFTERIMAGE_INVALID");
      result = await core.reconcileSource(request);
      if (!["SOURCE_ASSIGNMENT_PROJECTED", "SOURCE_ALREADY_PROJECTED"].includes(result.status)) { await hold(result.reason ?? result.status); return { ...result, snapshotReads, nativeBatches }; }
      const monthlyIntent = events.find(event => event.stage === "INTENT"), started = events.find(event => event.stage === "MONTHLY_WRITE_STARTED");
      if (!monthlyIntent || !started) { await hold("OWNER_RESUME_REQUIRED"); return { status: "OWNER_RESUME_REQUIRED", snapshotReads, nativeBatches }; }
      need(monthlyIntent.planHash === normalizedHash(monthlyIntent, "planHash") && started.planHash === monthlyIntent.planHash, "OWNER_MONTHLY_INTENT_INVALID");
      await db.runTransaction(async tx => {
        const current = await readTrusted(tx, true), records = await continuationRecords(tx, operationRef);
        assertCaseListMonthlyProofChain(queueRef.id, current.queue, current.payOffer, records, spreadsheetId, true, true);
      });
      result = await core.reconcile(request);
      }
    } else {
      result = await core[PHASES[phase].method](request);
      if (PHASES[phase].next && PHASES[phase].success.includes(result.status)) {
        const next = PHASES[phase].next!, proofStage = PHASES[phase].proof!, nonce = randomUUID();
        await db.runTransaction(async tx => {
          const current = await readTrusted(tx, true), records = await continuationRecords(tx, operationRef);
          const proof = checkedEvent(records[proofStage], proofStage, queueRef.id, current.queue, spreadsheetId), proofHash = hashCaseList(proof);
          const continuationHash = phaseHash(queueRef.id, current.queue, next, nonce, proofStage, proofHash), now = Timestamp.now();
          const phaseData = { schema: PHASE_SCHEMA, phase: next, nonce, proofStage, proofHash, continuationHash };
          const nextOperation = { schema: "LK_CASE_LIST_MONTHLY_OPERATION_V1", companyId: current.queue.companyId, jobId: current.queue.jobId, queueId: queueRef.id,
            caseId: current.assignment.sourceCaseId, status: "awaiting_continuation", phaseState: "ready", phase: next, phaseNonce: nonce, proofStage, proofHash, continuationHash,
            queueFingerprint: fingerprint(current.queue), publicPayOfferHash: hashCaseList(current.payOffer) };
          // Verify the proof we are about to publish through the same guard used
          // by the next invocation. Pending+phase+own-lease release are atomic.
          assertKnownCaseListContinuation(queueRef.id, { ...current.queue, caseListPhase: phaseData }, nextOperation, records, spreadsheetId);
          const waitForOwner = next === "MONTHLY_PREPARE";
          tx.set(queueRef, { status: waitForOwner ? "blocked" : "pending", caseListPhase: phaseData, retryAt: null, writeVerificationRequired: false,
            errorType: waitForOwner ? "owner_transfer_required" : FieldValue.delete(),
            errorMessage: waitForOwner ? "担当名を案件リストへ反映しました。クライアントへのネームアップ後、対象を選択してシフト表への移行を実行してください。" : FieldValue.delete(),
            caseListMonthlyReason: waitForOwner ? "OWNER_TRANSFER_SELECTION_REQUIRED" : FieldValue.delete(), updatedAt: now }, { merge: true });
          tx.set(operationRef, { ...nextOperation, budget: { phase, snapshotReads, nativeBatches, elapsedMs: Math.max(0, Date.now() - invocationStartedAt) }, updatedAt: now }, { merge: true });
          tx.delete(syncLockRef);
        });
        return { status: next === "MONTHLY_PREPARE" ? "OWNER_TRANSFER_SELECTION_REQUIRED" : "KNOWN_PHASE_READY", completedPhase: phase, nextPhase: next, snapshotReads, nativeBatches };
      }
    }
    if (!["MONTHLY_READBACK_VERIFIED", "NO_OP_ALREADY_ACCEPTED"].includes(result.status) || !result.ack) { await hold(result.reason ?? result.status); return { ...result, snapshotReads, nativeBatches }; }
    const ack = result.ack;
    need((await getProductionOperationalState(binding.queue.companyId)).operational, "GLOBAL_OPERATION_STOPPED_BEFORE_ACK");
    await db.runTransaction(async tx => {
      const current = await readTrusted(tx, true), [eventSnap, intentSnap] = await Promise.all([tx.get(operationRef.collection("events").doc("ACCEPTED")), tx.get(operationRef.collection("events").doc("INTENT"))]);
      const a = current.assignment, accepted = eventSnap.data(), intent = intentSnap.data(); need(accepted && intent, "ACCEPTED_NATIVE_EVENT_REQUIRED");
      const records = await continuationRecords(tx, operationRef);
      assertCaseListMonthlyProofChain(queueRef.id, current.queue, current.payOffer, records, spreadsheetId, true, true);
      const { target, post, caseIdColumn } = assertCaseListMonthlyAck(queueRef.id, a, current.payOffer, ack, accepted, intent, spreadsheetId);
      const privateRef = db.collection("caseListSheetRefs").doc(current.queue.jobId), previousPrivateRef = (await tx.get(privateRef)).data();
      const bindingHash = hashCaseList({ schema: "LK_CASE_LIST_SOURCE_BINDING_V1", spreadsheetId, sheetId: target.sheetId });
      const now = Timestamp.now(), sheetRef = { sheetId: target.sheetId, sheetName: target.title, headerRow: 1, currentRow: target.rowHint, caseId: a.sourceCaseId, caseIdColumn, bindingHash, verifiedAt: now };
      const privateSheetRef = { ...sheetRef, spreadsheetId }, publicSource = publicCaseListSource({ version: 1, spreadsheetId, sheetId: 2026101601, caseId: a.sourceCaseId, ...post });
      if (previousPrivateRef) need(previousPrivateRef.companyId === current.queue.companyId && previousPrivateRef.jobId === current.queue.jobId &&
        previousPrivateRef.sheetRef?.spreadsheetId === spreadsheetId && previousPrivateRef.sheetRef?.sheetId === target.sheetId && previousPrivateRef.sheetRef?.caseId === a.sourceCaseId &&
        previousPrivateRef.acceptedAckHash === hashCaseList(ack), "PRIVATE_MONTHLY_REF_CONFLICT");
      const nextJob = { ...current.job, sheetRef };
      tx.set(privateRef, { companyId: current.queue.companyId, jobId: current.queue.jobId, sheetRef: privateSheetRef, sourceBindingHash: publicSource.bindingHash, acceptedAckHash: hashCaseList(ack), updatedAt: now });
      tx.update(jobRef, { sheetRef, caseListSource: publicSource, applicationUnconfirmed: false,
        assignmentSheetWrite: { ...current.job.assignmentSheetWrite, identity: cancellationSheetWriteIdentity(nextJob), pending: false, confirmedAtMs: now.toMillis(), preSourceRevision: a.sourceRevision, sourceRevision: post.sourceRevision, nativeAck: publicCaseListMonthlyAck(ack, spreadsheetId) },
        sourceReady: true, publishable: false, recruitmentStopped: true, updatedAt: now });
      tx.set(queueRef, { status: "completed", retryAt: null, completedAt: now, updatedAt: now, caseListMonthlyAckHash: hashCaseList(ack), writeVerificationRequired: false }, { merge: true });
      tx.set(operationRef, { status: "completed", phaseState: "completed", budget: { phase: owner ? "OWNER_RECONCILE" : phase, snapshotReads, nativeBatches, elapsedMs: Math.max(0, Date.now() - invocationStartedAt) }, acceptedAckHash: hashCaseList(ack), completedAt: now, updatedAt: now }, { merge: true });
      tx.set(db.collection("sheetWriteIdempotency").doc(sha256(current.queue.companyId + "|" + current.queue.idempotencyKey)), { companyId: current.queue.companyId, queueId: queueRef.id, status: "completed", completedAt: now }, { merge: true });
    });
    return { status: result.status, snapshotReads, nativeBatches };
  } catch (error) {
    if (acquired) await hold(error instanceof Error ? error.message : "MONTHLY_EXECUTION_HELD");
    else if (!owner) await holdUnclaimed(error instanceof Error ? error.message : "MONTHLY_AUTHORITY_HELD");
    // No logging of raw errors, Source cells, staff data or native request bodies.
    return { status: "HELD", reason: error instanceof Error ? error.message : "MONTHLY_EXECUTION_HELD", snapshotReads, nativeBatches };
  } finally {
    if (acquired) await db.runTransaction(async tx => { if ((await tx.get(syncLockRef)).data()?.tokenId === claimToken) tx.delete(syncLockRef); });
  }
}

/** Record one executive-selected case after client name-up. This action never
 * writes Sheets and never selects a different queue or the cancellation box. */
export async function selectCaseListMonthlyTransfer(queueRef: Ref, actorUid: string, token: Data, reviewKey: string, clientNameUpConfirmed: boolean): Promise<Data> {
  assertExecutive(token, process.env.EXECUTIVE_APPROVER_EMAILS ?? "");
  need(ID.test(actorUid) && (token.uid ?? token.sub) === actorUid && HASH.test(reviewKey) && clientNameUpConfirmed === true, "OWNER_TRANSFER_CONFIRMATION_REQUIRED");
  const initial = (await queueRef.get()).data();
  need(initial?.operation === "case_list.assign" && initial.companyId === token.companyId, "OWNER_TRANSFER_COMPANY_MISMATCH");
  need((await getProductionOperationalState(initial.companyId)).operational, "GLOBAL_OPERATION_STOPPED");
  const a = object(initial.caseListAssignment) as Assignment;
  const operationRef = db.collection("caseListMonthlyOperations").doc(sha256(initial.companyId + "|" + queueRef.id));
  const configRef = db.collection("sheetImportConfigs").doc(initial.companyId), config = (await configRef.get()).data();
  need(config && config.companyId === initial.companyId, "OWNER_TRANSFER_CONFIG_REQUIRED");
  const spreadsheetId = configuredCaseListSource(config.spreadsheetId).spreadsheetId;
  const snapshot = await readCaseListMonthlySnapshot(initial.companyId, a.sourceCaseId, { resolveStaff: await loadResolver(initial.companyId) });
  need(snapshot.spreadsheetId === spreadsheetId && snapshot.catalog, "OWNER_TRANSFER_SOURCE_REQUIRED");
  const row = snapshot.source.rows.find(row => row.caseId === a.sourceCaseId);
  need(row && row.cells.length === 65 && typeof row.cells[0]?.userEnteredValue?.boolValue === "boolean", "TRANSFER_CONTROL_INVALID");
  const sourceControlHeader = snapshot.source.headers[0];
  need(typeof sourceControlHeader === "string" && ["キャンセル", "月別転記"].includes(sourceControlHeader) && (sourceControlHeader !== "キャンセル" || row.cells[0].userEnteredValue?.boolValue === false), "SOURCE_CANCELLED_OR_INVALID");
  const selectedContentHash = caseListMonthlyContentHash(row.cells), selectedCatalog = snapshot.catalog, auditRef = db.collection("auditLogs").doc();
  return db.runTransaction(async tx => {
    const [queueSnap, jobSnap, configSnap, approvalSnap, operationSnap, leaseSnap] = await Promise.all([
      tx.get(queueRef), tx.get(db.collection("jobs").doc(initial.jobId)), tx.get(configRef),
      tx.get(db.collection("caseListApprovals").doc(initial.jobId)), tx.get(operationRef), tx.get(db.collection("caseListSyncLocks").doc(initial.companyId)),
    ]);
    const queue = queueSnap.data(), job = jobSnap.data(), currentConfig = configSnap.data(), approval = approvalSnap.data(), operation = operationSnap.data();
    need(queue && job && currentConfig && approval && operation && queue.companyId === token.companyId && fingerprint(queue) === fingerprint(initial), "OWNER_TRANSFER_CHANGED");
    const prior = object(operation.ownerTransferSelection);
    if (prior.schema === "LK_OWNER_MONTHLY_TRANSFER_V1" && prior.reviewKey === reviewKey && prior.selectedBy === actorUid && prior.queueFingerprint === fingerprint(queue) &&
      prior.operationId === queueRef.id && prior.caseId === a.sourceCaseId && prior.selected === true && prior.clientNameUpConfirmed === true && prior.sourceControlHeader === sourceControlHeader &&
      prior.sourceContentHash === selectedContentHash && prior.sourceRevision === selectedCatalog.sourceRevision) return { status: "OWNER_TRANSFER_ALREADY_SELECTED", selected: true, nativeBatches: 0 };
    const [staffSnap, daySnap, identitySnap] = await Promise.all([
      tx.get(db.collection("staffProfiles").doc(queue.actorStaffId)), tx.get(db.collection("staffDayLocks").doc(`${queue.companyId}_${queue.actorStaffId}_${queue.dateKey}`)),
      tx.get(db.collection("authIdentities").doc(queue.actorUid)),
    ]);
    const staff = staffSnap.data(), day = daySnap.data(), identity = identitySnap.data();
    need(staff && day && (!identitySnap.exists || identity?.active === true && identity.companyId === queue.companyId && identity.staffId === queue.actorStaffId), "ACTOR_IDENTITY_REVOKED");
    const trusted = assertCaseListMonthlyAuthority(queueRef.id, queue, job, staff, day, currentConfig, approval);
    need(trusted.spreadsheetId === spreadsheetId && !(leaseSnap.data()?.activeUntil instanceof Timestamp && leaseSnap.data()!.activeUntil.toMillis() > Date.now()), "OWNER_TRANSFER_LEASE_ACTIVE");
    need(queue.status === "blocked" && queue.errorType === "owner_transfer_required" && queue.caseListPhase?.phase === "MONTHLY_PREPARE" && queue.caseListPhase.continuationHash === reviewKey, "OWNER_TRANSFER_REVIEW_CHANGED");
    const records = await continuationRecords(tx, operationRef);
    assertKnownCaseListContinuation(queueRef.id, queue, operation, records, spreadsheetId);
    need(!records.INTENT && !records.MONTHLY_WRITE_STARTED && !records.ACCEPTED, "OWNER_TRANSFER_ALREADY_STARTED");
    const source = checkedEvent(records.SOURCE_INTENT, "SOURCE_INTENT", queueRef.id, queue, spreadsheetId), projected = checkedEvent(records.SOURCE_PROJECTED, "SOURCE_PROJECTED", queueRef.id, queue, spreadsheetId);
    const writable = row.cells.map(cell => Object.fromEntries(["userEnteredValue", "note", "userEnteredFormat", "dataValidation", "textFormatRuns", "chipRuns"].filter(key => Object.hasOwn(cell, key)).map(key => [key, (cell as Data)[key]])));
    need(hashCaseList(writable) === projected.postMonthlyContentHash && canonical(selectedCatalog) === canonical(projected.postCatalog) && snapshot.dependencyHash === source.dependencyHash, "OWNER_TRANSFER_SOURCE_CHANGED");
    const selection = { schema: "LK_OWNER_MONTHLY_TRANSFER_V1", operationId: queueRef.id, caseId: a.sourceCaseId, companyId: queue.companyId, jobId: queue.jobId,
      selected: true, clientNameUpConfirmed: true, sourceControlHeader, selectedBy: actorUid, selectedAt: Date.now(), reviewKey,
      queueFingerprint: fingerprint(queue), assignmentHash: source.assignmentHash, sourceContentHash: selectedContentHash, sourceRevision: selectedCatalog.sourceRevision };
    tx.set(operationRef, { ownerTransferSelection: selection, updatedAt: Timestamp.now() }, { merge: true });
    tx.set(queueRef, { status: "pending", retryAt: null, errorType: FieldValue.delete(), errorMessage: FieldValue.delete(), caseListMonthlyReason: FieldValue.delete(), updatedAt: Timestamp.now() }, { merge: true });
    tx.set(auditRef, { companyId: queue.companyId, actorUid, action: "case-list.monthly.select", queueId: queueRef.id, caseId: a.sourceCaseId, clientNameUpConfirmed: true, reviewKey, createdAt: Timestamp.now() });
    return { status: "OWNER_TRANSFER_SELECTED", selected: true, nativeBatches: 0 };
  });
}

/** Explicit executive selection for a Source C name already entered by the
 * owner. This only registers trusted metadata; Google writes stay in the
 * existing MONTHLY_* worker/adapter and Source C is never written here. */
export async function selectCaseListManualMonthlyTransfer(companyId: string, actorUid: string, token: Data, input: Data): Promise<Data> {
  assertExecutive(token, process.env.EXECUTIVE_APPROVER_EMAILS ?? "");
  need(ID.test(companyId) && ID.test(actorUid) && token.companyId === companyId && (token.uid ?? token.sub) === actorUid, "MANUAL_OWNER_IDENTITY_INVALID");
  need(ID.test(input.jobId ?? "") && HASH.test(input.observationHash ?? "") && HASH.test(input.expectedSourceRevision ?? "") && Number.isSafeInteger(input.expectedJobRevision) && input.expectedJobRevision >= 1 && input.clientNameUpConfirmed === true, "MANUAL_SELECTION_INPUT_INVALID");
  const confirmation = object(input.manualConfirmation), confirmedFields = object(confirmation.confirmedFields), payOffer = object(confirmation.payOffer) as PayOffer;
  need(canonical(confirmedFields) === canonical({ arrival: true, execution: true, headcount: true, dateMode: true, payOffer: true }) &&
    Number.isSafeInteger(payOffer.dailyWageJPY) && payOffer.dailyWageJPY > 0 && payOffer.dailyWageJPY <= 1_000_000 && payOffer.travelExpenses === "全額支給" && payOffer.communicationExpenses === "全額支給", "MANUAL_CONDITIONS_REQUIRED");
  need((await getProductionOperationalState(companyId)).operational, "GLOBAL_OPERATION_STOPPED");
  const requestHash = hashCaseList({ companyId, actorUid, jobId: input.jobId, observationHash: input.observationHash, expectedJobRevision: input.expectedJobRevision, expectedSourceRevision: input.expectedSourceRevision, clientNameUpConfirmed: true, manualConfirmation: confirmation });
  const queueId = "manual_" + sha256(companyId + "|" + input.jobId + "|" + input.observationHash), queueRef = db.collection("sheetSyncQueue").doc(queueId);
  const operationRef = db.collection("caseListMonthlyOperations").doc(sha256(companyId + "|" + queueId));
  const jobRef = db.collection("jobs").doc(input.jobId), observationRef = db.collection("caseListManualObservations").doc(input.jobId), configRef = db.collection("sheetImportConfigs").doc(companyId), syncRef = db.collection("caseListSyncLocks").doc(companyId);
  const [initialJob, initialObservation, initialOperation, initialQueue] = await Promise.all([jobRef.get(), observationRef.get(), operationRef.get(), queueRef.get()]);
  if (initialQueue.exists || initialOperation.exists) {
    need(initialQueue.data()?.companyId === companyId && initialQueue.data()?.jobId === input.jobId && initialOperation.data()?.manualSelectionRequestHash === requestHash && initialOperation.data()?.ownerTransferSelection?.selectedBy === actorUid, "MANUAL_SELECTION_ALREADY_REGISTERED");
    return { status: "OWNER_TRANSFER_ALREADY_SELECTED", selected: true, queueId, nativeBatches: 0 };
  }
  const job = initialJob.data(), observed = initialObservation.data();
  need(job && observed && job.companyId === companyId && observed.companyId === companyId && observed.jobId === input.jobId && observed.observationHash === input.observationHash &&
    observed.schema === "LK_CASE_LIST_MANUAL_OBSERVATION_V1" && observed.state === "blocked_requires_owner_review" && observed.selected === false && ID.test(observed.staffId ?? "") &&
    manualOwnerReviewCanProceed(observed.holdReasons), "MANUAL_OBSERVATION_NOT_READY");
  need(job.revision === input.expectedJobRevision && job.caseId === observed.caseId && job.caseListSource?.sourceRevision === input.expectedSourceRevision && job.sourceMissing !== true && job.cancelled !== true && job.status === "assigned" && job.applicationUnconfirmed === true && job.assignmentUnresolved !== true && !job.assignmentSheetWrite &&
    job.assignedStaffId === observed.staffId && job.assignedStaffName === observed.sourceStaffName && job.assignedUid == null && job.caseListManualPending?.observationHash === input.observationHash &&
    job.caseListManualPending?.sourceRevision === input.expectedSourceRevision && job.caseListManualPending?.staffId === observed.staffId, "MANUAL_JOB_CHANGED");
  const resolver = await loadResolver(companyId);
  const snapshot = await readCaseListMonthlySnapshot(companyId, job.caseId, { includeDependencies: true, resolveStaff: resolver });
  const spreadsheetId = snapshot.spreadsheetId, row = snapshot.source.rows.find(row => row.caseId === job.caseId);
  need(snapshot.isolated === false && row && row.cells.length === 65 && snapshot.catalog && snapshot.catalog.sourceRevision === input.expectedSourceRevision && canonical(publicCaseListSource(snapshot.catalog)) === canonical(observed.source) &&
    row.cells[2]?.userEnteredValue?.stringValue === observed.sourceStaffName && row.cells[2]?.effectiveValue?.stringValue === observed.sourceStaffName && row.staffIdentityVerified === true && row.staffId === observed.staffId && resolver(observed.sourceStaffName)?.staffId === observed.staffId &&
    snapshot.source.headers[0] === "キャンセル" && row.cells[0]?.userEnteredValue?.boolValue === false && row.cells[63]?.userEnteredValue?.boolValue === false, "MANUAL_SOURCE_CHANGED");
  const profileRef = db.collection("staffProfiles").doc(observed.staffId), staff = (await profileRef.get()).data();
  need(staff && staff.companyId === companyId && staff.active === true && typeof staff.displayName === "string" && staff.displayName.trim() && staff.displayName === observed.canonicalStaffName, "MANUAL_STAFF_CHANGED");
  const dateKey = String(observed.dateKey ?? ""), assignedRevision = input.expectedJobRevision + 1;
  need(validDate(dateKey) && job.dateKey === dateKey && hashCaseList(row.cells.map(cell => ({ userEnteredValue: cell.userEnteredValue ?? {}, effectiveValue: cell.effectiveValue ?? {} }))) === observed.observedValuesHash, "MANUAL_SOURCE_CHANGED");
  const conditionsBody = { schema: "LK_CASE_LIST_MANUAL_CONDITIONS_V1", companyId, jobId: input.jobId, queueId, actorUid, expectedSourceRevision: input.expectedSourceRevision, expectedJobRevision: input.expectedJobRevision,
    staffId: observed.staffId, sourceStaffName: observed.sourceStaffName, canonicalStaffName: staff.displayName, observationHash: input.observationHash, confirmedFields, payOffer, selectedAt: Date.now() };
  const ownerConditionsHash = hashCaseList(conditionsBody), manualConditions = { ...conditionsBody, ownerConditionsHash };
  const a: Assignment = { schema: "LK_CASE_LIST_MANUAL_ASSIGN_V1", origin: "SOURCE_MANUAL", selectorUid: actorUid, canonicalStaffName: staff.displayName, observationHash: input.observationHash, ownerConditionsHash,
    queueId, operationId: queueId, companyId, jobId: input.jobId, sourceCaseId: job.caseId, sourceRowRevision: snapshot.catalog.rowRevision, sourceLedgerRevision: snapshot.catalog.ledgerRevision, sourceRevision: snapshot.catalog.sourceRevision,
    preMonthlyContentHash: caseListMonthlyContentHash(row.cells), expectedJobRevision: input.expectedJobRevision, assignedJobRevision: assignedRevision, staffId: observed.staffId, staffName: observed.sourceStaffName, dateKey };
  const native = nativeAssignment(a, payOffer), sourceSnapshot = row.cells.map(cell => Object.fromEntries(["userEnteredValue", "note", "userEnteredFormat", "dataValidation", "textFormatRuns", "chipRuns"].filter(key => Object.hasOwn(cell, key)).map(key => [key, (cell as Data)[key]])));
  const manualEvent: Data = { schema: "LK_SOURCE_MANUAL_OBSERVED_V1", stage: "SOURCE_MANUAL_OBSERVED", spreadsheetId, operationId: queueId, caseId: a.sourceCaseId,
    assignment: native, assignmentHash: hashCaseList(native), preCatalog: snapshot.catalog, postCatalog: snapshot.catalog, preMonthlyContentHash: a.preMonthlyContentHash, postMonthlyContentHash: a.preMonthlyContentHash,
    sourceSnapshot, dependencyHash: snapshot.dependencyHash, observationHash: a.observationHash, ownerConditionsHash, createdAt: Date.now() };
  manualEvent.observationProofHash = hashCaseList({ ...manualEvent, createdAt: 0 });
  const now = Timestamp.now(), nonce = randomUUID(), proofHash = hashCaseList(manualEvent), queue: Data = { companyId, jobId: input.jobId, operation: "case_list.assign", actorUid, actorStaffId: a.staffId, dateKey,
    updates: { staffName: a.staffName }, expected: { staffName: { mode: "equals", value: a.staffName } }, styles: {}, idempotencyKey: `case_list.assign:${input.jobId}:${queueId}`, caseListAssignment: a,
    status: "pending", attempts: 0, retryAt: null, writeVerificationRequired: false, createdAt: now, updatedAt: now };
  const continuationHash = phaseHash(queueId, queue, "MONTHLY_PREPARE", nonce, "SOURCE_MANUAL_OBSERVED", proofHash), phaseData = { schema: PHASE_SCHEMA, phase: "MONTHLY_PREPARE", nonce, proofStage: "SOURCE_MANUAL_OBSERVED", proofHash, continuationHash };
  queue.caseListPhase = phaseData;
  const selection = { schema: "LK_OWNER_MONTHLY_TRANSFER_V1", companyId, jobId: input.jobId, operationId: queueId, caseId: a.sourceCaseId, selected: true, clientNameUpConfirmed: true, sourceControlHeader: "キャンセル",
    selectedBy: actorUid, selectedAt: conditionsBody.selectedAt, reviewKey: continuationHash, queueFingerprint: fingerprint(queue), assignmentHash: hashCaseList(native), sourceContentHash: a.preMonthlyContentHash, sourceRevision: a.sourceRevision };
  const operation: Data = { schema: "LK_CASE_LIST_MONTHLY_OPERATION_V1", companyId, jobId: input.jobId, queueId, caseId: a.sourceCaseId, status: "awaiting_continuation", phaseState: "ready", phase: "MONTHLY_PREPARE", phaseNonce: nonce,
    proofStage: "SOURCE_MANUAL_OBSERVED", proofHash, continuationHash, queueFingerprint: fingerprint(queue), publicPayOfferHash: hashCaseList(payOffer), manualConditions, manualSelectionRequestHash: requestHash, ownerTransferSelection: selection, createdAt: now, updatedAt: now };
  const records = { SOURCE_MANUAL_OBSERVED: { companyId, queueId, payload: manualEvent, payloadHash: proofHash } };
  assertKnownCaseListContinuation(queueId, queue, operation, records, spreadsheetId);
  // Preview invokes only the same controller's validations; no mutation
  // callback or journal persistence is supplied or reachable here.
  const previewCore = (controller as unknown as { create(services: Data): { preview(request: Data): Promise<CoreResult> } }).create({ spreadsheetId, sha256, now: () => Date.now(), authorize: async () => {}, withLock: async (fn: () => Promise<unknown>) => fn(), readSnapshot: async () => snapshot,
    readEvents: async () => [manualEvent], appendEvent: async () => stop("MANUAL_PREVIEW_JOURNAL_WRITE_FORBIDDEN"), applySourceAssignment: async () => stop("MANUAL_PREVIEW_GOOGLE_WRITE_FORBIDDEN"), applyMonthly: async () => stop("MANUAL_PREVIEW_GOOGLE_WRITE_FORBIDDEN"), resolveAssignment: async () => native, authorizeMonthlyTransfer: async () => selection });
  const preview = await previewCore.preview({ operationId: queueId, caseId: a.sourceCaseId });
  need(preview.status === "MONTHLY_PREVIEW_READY", "MANUAL_MONTHLY_PREVIEW_REQUIRED");
  need((await getProductionOperationalState(companyId)).operational, "GLOBAL_OPERATION_STOPPED");
  const dayRef = db.collection("staffDayLocks").doc(`${companyId}_${a.staffId}_${dateKey}`), auditRef = db.collection("auditLogs").doc();
  return db.runTransaction(async tx => {
    const [jobSnap, observationSnap, configSnap, profileSnap, daySnap, queueSnap, operationSnap, leaseSnap] = await Promise.all([tx.get(jobRef), tx.get(observationRef), tx.get(configRef), tx.get(profileRef), tx.get(dayRef), tx.get(queueRef), tx.get(operationRef), tx.get(syncRef)]);
    const currentJob = jobSnap.data(), currentObservation = observationSnap.data(), config = configSnap.data(), currentStaff = profileSnap.data(), day = daySnap.data();
    if (queueSnap.exists || operationSnap.exists) {
      need(queueSnap.data()?.companyId === companyId && queueSnap.data()?.jobId === input.jobId && operationSnap.data()?.manualSelectionRequestHash === requestHash, "MANUAL_SELECTION_ALREADY_REGISTERED");
      return { status: "OWNER_TRANSFER_ALREADY_SELECTED", selected: true, queueId, nativeBatches: 0 };
    }
    need(currentJob && currentObservation && currentStaff && config && canonical(currentJob) === canonical(job) && canonical(currentObservation) === canonical(observed) && canonical(currentStaff) === canonical(staff), "MANUAL_SELECTION_CHANGED");
    need(config.companyId === companyId && config.caseListEnabled === true && config.caseListAssignmentsEnabled === true && configuredCaseListSource(config.spreadsheetId).spreadsheetId === spreadsheetId, "CASE_LIST_WRITER_DISABLED");
    need(!(leaseSnap.data()?.activeUntil instanceof Timestamp && leaseSnap.data()!.activeUntil.toMillis() > Date.now()), "OWNER_TRANSFER_LEASE_ACTIVE");
    need(!day || day.companyId === companyId && day.staffId === a.staffId && day.dateKey === dateKey, "MANUAL_DAY_LOCK_IDENTITY_CHANGED");
    need(day && day.active === true && day.jobId === input.jobId && day.companyId === companyId && day.staffId === a.staffId && day.dateKey === dateKey, "MANUAL_STAFF_DAY_ALREADY_ASSIGNED");
    const nextJob: Data = { ...currentJob, status: "assigned", assignedStaffId: a.staffId, assignedStaffName: a.staffName, assignedUid: null, assignedAt: now, dateKey, revision: assignedRevision, basePay: payOffer.dailyWageJPY, publicPayOffer: payOffer,
      applicationUnconfirmed: true, assignmentUnresolved: false, sourceReady: false, publishable: false, recruitmentStopped: true, caseListManualSelection: { queueId, ownerConditionsHash, observationHash: a.observationHash }, updatedAt: now };
    nextJob.assignmentSheetWrite = { operation: "case_list.assign", queueId, sourceRevision: a.sourceRevision, assignedJobRevision: assignedRevision, identity: cancellationSheetWriteIdentity(nextJob), pending: true };
    const dayLock = { companyId, staffId: a.staffId, jobId: input.jobId, dateKey, active: true, updatedAt: now };
    assertCaseListMonthlyAuthority(queueId, queue, nextJob, currentStaff, dayLock, config, manualConditions);
    tx.update(jobRef, nextJob);
    tx.set(dayRef, dayLock);
    tx.create(queueRef, queue);
    tx.create(operationRef, operation);
    tx.create(operationRef.collection("events").doc("SOURCE_MANUAL_OBSERVED"), { ...records.SOURCE_MANUAL_OBSERVED, createdAt: now });
    tx.set(observationRef, { ...currentObservation, state: "selected", selected: true, clientNameUpConfirmed: true, queueId, selectedBy: actorUid, selectedAt: now, ownerConditionsHash });
    tx.set(auditRef, { companyId, actorUid, action: "case-list.manual.monthly.select", jobId: input.jobId, queueId, observationHash: input.observationHash, clientNameUpConfirmed: true, createdAt: now });
    return { status: "OWNER_TRANSFER_SELECTED", selected: true, queueId, nativeBatches: 0 };
  });
}

/** Each trigger performs one known phase; old operation types keep their pause. */
export async function processCaseListMonthlyAssignment(queueRef: Ref): Promise<boolean> {
  if ((await queueRef.get()).data()?.operation !== "case_list.assign") return false;
  await runCaseListMonthlyAssignment(queueRef);
  return true;
}

/** Original-sheet read-only reconciliation. Exact after-images may finalize
 * immutable proof/ACK metadata; no prepare/apply or Google writer is reachable. */
export async function reconcileCaseListMonthlyAssignment(queueRef: Ref, actorUid: string, token: Data): Promise<Data> {
  return runCaseListMonthlyAssignment(queueRef, { actorUid, token });
}

/** Scheduling can wake preclaim contention and privately proven ready phases.
 * An expired running/unknown stage is always held; no native write is replayed.
 * The old paused queue is neither queried nor resumed by this path. */
export async function retryCaseListMonthlyAssignments(): Promise<void> {
  // A private resumable cursor prevents completed history from starving new
  // work. Each invocation reads at most five 100-document pages of this new
  // operation only; no legacy paused backlog or new compound index is used.
  const enabledConfigs = await db.collection("sheetImportConfigs").where("caseListAssignmentsEnabled", "==", true).limit(101).get();
  if (enabledConfigs.size > 100) return;
  const activeCompanies = new Set<string>();
  for (const doc of enabledConfigs.docs) { const config = doc.data(); if (config.caseListEnabled === true && config.companyId === doc.id && ID.test(doc.id) && (await getProductionOperationalState(doc.id)).operational) activeCompanies.add(doc.id); }
  if (!activeCompanies.size) return;
  const cursorRef = db.collection("caseListMonthlyRetryCursors").doc("global"), now = Timestamp.now();
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const savedCursor = (await cursorRef.get()).data();
    const lastId = savedCursor?.lastDocumentId ?? null;
    need(lastId === null || typeof lastId === "string" && ID.test(lastId), "MONTHLY_RETRY_CURSOR_INVALID");
    let query = db.collection("sheetSyncQueue").where("operation", "==", "case_list.assign").orderBy(FieldPath.documentId()).limit(100);
    if (lastId !== null) query = query.startAfter(lastId);
    const operations = await query.get();
    for (const doc of operations.docs) {
      const data = doc.data();
      const knownPending = data.status === "pending" && data.caseListPhase?.schema === PHASE_SCHEMA;
      if (!activeCompanies.has(data.companyId) || (!knownPending && (!(data.retryAt instanceof Timestamp) || data.retryAt.toMillis() > now.toMillis()))) continue;
      const prewriteBusy = data.status === "retry_wait" && data.errorType === "case_list_prewrite_busy" && data.caseListMonthlyReason === "CASE_LIST_PREWRITE_BUSY" && data.writeVerificationRequired === false;
      const expired = data.status === "processing";
      if ((!prewriteBusy && !expired && !knownPending) || !(await getProductionOperationalState(data.companyId)).operational) continue;
      const configRef = db.collection("sheetImportConfigs").doc(data.companyId), operationRef = db.collection("caseListMonthlyOperations").doc(sha256(data.companyId + "|" + doc.id));
      await db.runTransaction(async tx => {
        const [queueSnap, configSnap, operationSnap] = await Promise.all([tx.get(doc.ref), tx.get(configRef), tx.get(operationRef)]);
        const current = queueSnap.data(), config = configSnap.data();
        if (!current || !config || current.operation !== "case_list.assign" || current.companyId !== data.companyId ||
          config.companyId !== data.companyId || config.caseListEnabled !== true || config.caseListAssignmentsEnabled !== true ||
          (current.status !== "pending" && (!(current.retryAt instanceof Timestamp) || current.retryAt.toMillis() > now.toMillis()))) return;
        if (current.status === "pending") {
          if (!current.caseListPhase || current.writeVerificationRequired === true || !operationSnap.exists) return;
          const records = await continuationRecords(tx, operationRef);
          try { assertKnownCaseListContinuation(doc.id, current, operationSnap.data()!, records, configuredCaseListSource(config.spreadsheetId).spreadsheetId); }
          catch { return; }
          // A phase event may have arrived during a global stop. A new nonce
          // wakes only this already-proven ready phase; no claim is taken here.
          tx.set(doc.ref, { caseListWakeNonce: randomUUID(), updatedAt: now }, { merge: true });
          return;
        }
        if (current.status === "processing") {
          tx.set(doc.ref, { status: "blocked", errorType: "verification_required", writeVerificationRequired: true, retryAt: null,
            caseListMonthlyReason: "EXPIRED_MONTHLY_OPERATION_REQUIRES_RECONCILIATION", errorMessage: "月別連携の結果を確認してください。実行中だった可能性があるため自動再書込は行いません。", updatedAt: now }, { merge: true });
          return;
        }
        if (current.status !== "retry_wait" || current.errorType !== "case_list_prewrite_busy" || current.caseListMonthlyReason !== "CASE_LIST_PREWRITE_BUSY" || current.writeVerificationRequired !== false) return;
        if (operationSnap.exists) {
          const records = await continuationRecords(tx, operationRef);
          try { assertKnownCaseListContinuation(doc.id, current, operationSnap.data()!, records, configuredCaseListSource(config.spreadsheetId).spreadsheetId); }
          catch {
            tx.set(doc.ref, { status: "blocked", errorType: "verification_required", writeVerificationRequired: true, retryAt: null,
              caseListMonthlyReason: "EXISTING_MONTHLY_OPERATION_REQUIRES_RECONCILIATION", updatedAt: now }, { merge: true });
            return;
          }
        }
        tx.set(doc.ref, { status: "pending", retryAt: null, errorType: FieldValue.delete(), caseListMonthlyReason: FieldValue.delete(), errorMessage: FieldValue.delete(), updatedAt: now }, { merge: true });
      });
    }
    const finalId = operations.size === 100 ? operations.docs[operations.docs.length - 1]!.id : null;
    await db.runTransaction(async tx => {
      const current = (await tx.get(cursorRef)).data();
      if ((current?.lastDocumentId ?? null) !== lastId || finalId === lastId) return;
      tx.set(cursorRef, { schema: "LK_CASE_LIST_MONTHLY_RETRY_CURSOR_V1", lastDocumentId: finalId, updatedAt: Timestamp.now() });
    });
    if (operations.size < 100) return;
  }
}
