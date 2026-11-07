import { randomUUID, createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase";
import { assertExecutive, hashCaseList, canonical, configuredCaseListSource } from "./case-list-source-core";
import { cancellationSheetWriteIdentity } from "./sheet-write-core";
import { getProductionOperationalState } from "./system-safety";
import { readCaseListMonthlySnapshot, readArchivedCaseListSnapshot, readGasTransferMonthPlan } from "./case-list-monthly-reader";
import { expectedStaffDateFormula } from "./case-list-gas-date-formula";
import { expectedGasTransferProof } from "./case-list-gas-proof";
import { externalTransferMode, assertExternalIntakeEnabled, assertExternalAcceptanceEnabled } from "./case-list-external-mode";

type Data = FirebaseFirestore.DocumentData;
type Ref = FirebaseFirestore.DocumentReference;
type Tx = FirebaseFirestore.Transaction;
const core = require("../src/case-list-external-core.cjs") as {
  createConnection(services: Data): { select(...args: any[]): Promise<Data>; reconcile(...args: any[]): Promise<Data>; resolvePrivateRef(records: Data): Data };
};
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const LEASE_MS = 120_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const need = (ok: unknown, code: string): void => { if (!ok) throw Error(code); };
const worker = () => require("./case-list-monthly-worker") as typeof import("./case-list-monthly-worker");
function normalized(value: any): any {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, normalized(v)]));
  return value;
}
function assertOwner(uid: string, token: Data, companyId: string) {
  assertExecutive(token, process.env.EXECUTIVE_APPROVER_EMAILS ?? "");
  need(ID.test(uid) && token.companyId === companyId && (token.uid ?? token.sub) === uid, "EXTERNAL_OWNER_IDENTITY_INVALID");
}
const sourceHash = (cells: Data[]) => hashCaseList(cells.map(c => [c.userEnteredValue ?? {}, c.effectiveValue ?? {}, c.userEnteredFormat ?? {}, c.note ?? "", c.dataValidation ?? {}, c.textFormatRuns ?? [], c.chipRuns ?? []]));
const ledgerHash = (cells: Data[]) => hashCaseList(cells.map(c => [c.userEnteredValue ?? {}, c.effectiveValue ?? {}]));

async function recordsFor(queueRef: Ref, tx?: Tx): Promise<Data> {
  const get = (r: Ref) => tx ? tx.get(r) : r.get();
  const qs = await get(queueRef), q = qs.data();
  need(q && q.operation === "case_list.assign" && ID.test(q.companyId ?? "") && ID.test(q.jobId ?? ""), "EXTERNAL_QUEUE_INVALID");
  const operationRef = db.collection("caseListMonthlyOperations").doc(sha(q!.companyId + "|" + queueRef.id));
  const [job, config, operation, approval, lease, privateRef] = await Promise.all([
    get(db.collection("jobs").doc(q!.jobId)), get(db.collection("sheetImportConfigs").doc(q!.companyId)),
    get(operationRef), get(db.collection("caseListApprovals").doc(q!.jobId)),
    get(db.collection("caseListSyncLocks").doc(q!.companyId)), get(db.collection("caseListSheetRefs").doc(q!.jobId)),
  ]);
  const j = job.data(), op = operation.data(), a = q!.caseListAssignment;
  need(j && op && config.exists && a && ID.test(a.staffId ?? "") && typeof a.dateKey === "string", "EXTERNAL_RECORDS_REQUIRED");
  const [staff, day, identity] = await Promise.all([
    get(db.collection("staffProfiles").doc(a.staffId)), get(db.collection("staffDayLocks").doc(q!.companyId + "_" + a.staffId + "_" + a.dateKey)),
    get(db.collection("authIdentities").doc(q!.actorUid)),
  ]);
  const stages = ["SOURCE_INTENT", "SOURCE_WRITE_STARTED", "SOURCE_DISPATCHED", "SOURCE_UNKNOWN", "SOURCE_DEFERRED", "SOURCE_PROJECTED",
    "SOURCE_MANUAL_OBSERVED", "INTENT", "MONTHLY_WRITE_STARTED", "MONTHLY_DISPATCHED", "UNKNOWN", "DEFERRED", "ACCEPTED"];
  const snaps = await Promise.all(stages.map(stage => get(operationRef.collection("events").doc(stage))));
  const events: Data = Object.fromEntries(snaps.flatMap((s, i) => s.exists ? [[stages[i]!, s.data()!]] : []));
  const manual = a.origin === "SOURCE_MANUAL", observed = manual ? await get(db.collection("caseListManualObservations").doc(q!.jobId)) : undefined;
  need(op!.schema === "LK_CASE_LIST_MONTHLY_OPERATION_V1" && op!.companyId === q!.companyId && op!.jobId === q!.jobId &&
    op!.queueId === queueRef.id && op!.caseId === j!.caseId, "EXTERNAL_OPERATION_IDENTITY_CHANGED");
  need(!identity.exists || identity.data()?.active === true && identity.data()?.companyId === q!.companyId &&
    (manual || identity.data()?.staffId === a.staffId), "EXTERNAL_ACTOR_IDENTITY_REVOKED");
  need(j!.assignmentSheetWrite?.identity === cancellationSheetWriteIdentity(j!), "EXTERNAL_WRITE_IDENTITY_CHANGED");
  const sourceRecord = manual ? events.SOURCE_MANUAL_OBSERVED : events.SOURCE_INTENT;
  need(sourceRecord, "EXTERNAL_ORIGINAL_SOURCE_RECORD_REQUIRED");
  const originalRequest = manual ? observed?.data() : { kind: "PROTECTED_CREW_QUEUE", queueId: queueRef.id,
    actorUid: q!.actorUid, actorStaffId: q!.actorStaffId, createdAt: q!.createdAt, assignment: a };
  const r: Data = normalized({ jobId: q!.jobId, queueId: queueRef.id, queue: q!, job: j!, staff: staff.data() ?? {}, dayLock: day.data() ?? {},
    config: config.data()!, operation: op!, approval: manual ? op!.manualConditions : approval.data() ?? {},
    originalRequest, originalSourceRecord: sourceRecord, events, privateRef: privateRef.data()?.sheetRef ?? null,
    privateRecord: privateRef.data() ?? null, externalSelection: op!.externalSelection ?? null, externalAcceptance: op!.externalAcceptance ?? null });
  r.nativeMonthlyStarted = Boolean(events.INTENT || events.MONTHLY_WRITE_STARTED || events.MONTHLY_DISPATCHED);
  need(!Object.hasOwn(r.job.assignmentSheetWrite ?? {}, "nativeAck") && !Object.hasOwn(r.queue, "caseListMonthlyAckHash") &&
    !Object.hasOwn(op!, "acceptedAckHash") && !Object.hasOwn(privateRef.data() ?? {}, "acceptedAckHash") &&
    !events.UNKNOWN && !events.DEFERRED, "EXTERNAL_NATIVE_PROOF_MIXED");
  r.nativeAccepted = Boolean(events.ACCEPTED);
  r.lease = lease.data() ?? null;
  if (r.externalAcceptance) {
    const h = r.externalAcceptance.acceptanceHash;
    need(op!.status === "completed" && q!.status === "completed" && !r.nativeMonthlyStarted && !r.nativeAccepted &&
      q!.caseListExternalAcceptanceHash === h && privateRef.data()?.companyId === q!.companyId &&
      privateRef.data()?.jobId === q!.jobId && privateRef.data()?.externalAcceptanceHash === h, "EXTERNAL_ACCEPTANCE_ROOT_CHAIN_CHANGED");
  }
  return r;
}
function authority(queueId: string, r: Data) {
  worker().assertCaseListMonthlyAuthority(queueId, r.queue, r.job, r.staff, r.dayLock, r.config, r.approval);
  worker().assertKnownCaseListContinuation(queueId, r.queue, r.operation, r.events, r.config.spreadsheetId);
  need(r.queue.caseListPhase?.phase === "MONTHLY_PREPARE" && !r.nativeMonthlyStarted && !r.nativeAccepted, "EXTERNAL_ORIGINAL_PHASE_REQUIRED");
}
async function previewFor(r: Data) {
  const readStartedAt = Date.now();
  const snapshot = await readCaseListMonthlySnapshot(r.queue.companyId, r.job.caseId);
  const row = snapshot.source.rows.find(row => row.caseId === r.job.caseId);
  need(row && row.cells.length === 65, "EXTERNAL_SOURCE_ROW_REQUIRED");
  const title = r.job.dateKey.slice(0, 4) + "." + Number(r.job.dateKey.slice(5, 7));
  const month = snapshot.months.filter(m => m.title === title);
  need(month.length === 1 && !snapshot.months.some(m => m.rows.some(row => row.fixedId?.toLowerCase() === r.job.caseId.toLowerCase())), "EXTERNAL_DESTINATION_ALREADY_PRESENT");
  const c = row!.cells as Data[], ledgerCells = snapshot.rawLedgerRows[3] ?? Array.from({ length: 25 }, () => ({}));
  const gasMonth = await readGasTransferMonthPlan(snapshot, r.job.dateKey);
  const proof = expectedGasTransferProof(r, snapshot, gasMonth);
  const scalar = (c: Data) => { const v = c?.effectiveValue ?? c?.userEnteredValue ?? {}; return v.stringValue ?? v.numberValue ?? v.boolValue ?? ""; };
  // The protected SOURCE_INTENT/SOURCE_MANUAL_OBSERVED is checked separately.
  return { readStartedAt, observedAt: Date.now(), spreadsheetId: snapshot.spreadsheetId, sourceCells: c, sourceIds: snapshot.source.rows.map(row => row.caseId).filter(Boolean),
    sourceControlA: scalar(c[0]!), sourceControlBL: scalar(c[63]!), caseId: r.job.caseId, staffName: r.job.assignedStaffName,
    dateKey: r.job.dateKey, crewSourceRevision: r.queue.caseListAssignment.sourceRevision,
    gasPreview: { book: snapshot.spreadsheetId, caseId: r.job.caseId, date: r.job.dateKey, sheetId: month[0]!.sheetId,
      width: month[0]!.columnCount, intentKey: "LK_TRANSFER_V1:" + snapshot.spreadsheetId + ":" + r.job.caseId,
      groupId: null, groupHash: null, sourceHash: sourceHash(c), ledgerHash: ledgerHash(ledgerCells as Data[]),
      approvedProof: proof.approvedProof, checkedProof: proof.checkedProof,
      producerSchema: "LK_NAMEUP_TRANSFER_V1", nameUpExpected: proof.batchFingerprint } };
}

async function runExternal(queueRef: Ref, uid: string, token: Data, select: boolean, input?: Data): Promise<Data> {
  const initial = (await queueRef.get()).data();
  need(initial && initial.operation === "case_list.assign", "EXTERNAL_QUEUE_REQUIRED");
  assertOwner(uid, token, initial!.companyId);
  need((await getProductionOperationalState(initial!.companyId)).operational, "GLOBAL_OPERATION_STOPPED");
  if (select) assertExternalIntakeEnabled();
  else if (externalTransferMode() === "read-only") {
    // Completed receipts remain readable without a lease/write. Pending or
    // unknown records retain their exact original IDs and stay unconfirmed.
    const r = await recordsFor(queueRef);
    need(r.externalAcceptance, "EXTERNAL_TRANSFER_COMPATIBILITY_HOLD");
    await resolveExternalCaseListSheetRef(initial!.companyId, r.jobId, r.job);
    need(r.externalSelection.selectedBy === uid, "COMPLETED_SELECTION_OWNER_CHANGED");
    return { status: "EXTERNAL_ALREADY_ACCEPTED", queueId: queueRef.id,
      acceptanceHash: r.externalAcceptance.acceptanceHash, sourceWrites: 0, monthlyWrites: 0 };
  }
  const syncRef = db.collection("caseListSyncLocks").doc(initial!.companyId), leaseToken = randomUUID();
  await db.runTransaction(async tx => {
    const prior = (await tx.get(syncRef)).data();
    need(!(prior?.activeUntil instanceof Timestamp && prior.activeUntil.toMillis() > Date.now()), "EXTERNAL_COMPANY_LEASE_ACTIVE");
    tx.set(syncRef, { companyId: initial!.companyId, tokenId: leaseToken, activeUntil: Timestamp.fromMillis(Date.now() + LEASE_MS), kind: "EXTERNAL_TRANSFER_READBACK" });
  });
  const ownLease = (r: Data) => {
    const l = r.lease;
    need(l?.tokenId === leaseToken && l.activeUntil instanceof Timestamp && l.activeUntil.toMillis() > Date.now(), "EXTERNAL_COMPANY_LEASE_EXPIRED");
  };
  try {
    const connection = core.createConnection({
      now: () => Date.now(), gasDigest: hashCaseList, expectedDateFormula: expectedStaffDateFormula,
      authorize: (actor: string, auth: Data) => assertOwner(actor, auth, initial!.companyId),
      assertAuthority: authority,
      readProtected: async () => { const r = await recordsFor(queueRef); ownLease(r); r.leaseActive = false; return r; },
      readSheets: async (_queue: string, phase: string) => {
        const r = await recordsFor(queueRef); ownLease(r);
        if (phase === "preview") return previewFor(r);
        return { ...await readArchivedCaseListSnapshot(r.queue.companyId, r.job.caseId), ownerEmail: String(token.email).toLowerCase() };
      },
      transaction: async (_queue: string, fn: (r: Data) => Promise<Data>) => db.runTransaction(async tx => {
        const r = await recordsFor(queueRef, tx); ownLease(r); r.leaseActive = false;
        need((await getProductionOperationalState(initial!.companyId)).operational, "GLOBAL_OPERATION_STOPPED_BEFORE_EXTERNAL_COMMIT");
        const plan = await fn(r); ownLease(r);
        const operationRef = db.collection("caseListMonthlyOperations").doc(sha(r.queue.companyId + "|" + queueRef.id)), now = Timestamp.now();
        if (plan.kind === "SELECT_EXTERNAL") {
          assertExternalIntakeEnabled();
          tx.set(operationRef, { externalSelection: plan.selection, updatedAt: now }, { merge: true });
          tx.set(queueRef, { ...plan.queuePatch, updatedAt: now }, { merge: true });
        } else if (plan.kind === "ACCEPT_EXTERNAL") {
          assertExternalAcceptanceEnabled();
          const next = { ...r.job, ...plan.jobPatch };
          plan.jobPatch.assignmentSheetWrite.identity = cancellationSheetWriteIdentity(next);
          tx.update(db.collection("jobs").doc(r.jobId), { ...plan.jobPatch, updatedAt: now });
          tx.set(db.collection("caseListSheetRefs").doc(r.jobId), { companyId: r.queue.companyId, jobId: r.jobId,
            origin: "OWNER_GAS_RECEIPT", sheetRef: plan.privateRef, sourceBindingHash: r.job.caseListSource.bindingHash,
            externalAcceptanceHash: plan.acceptance.acceptanceHash, updatedAt: now });
          tx.set(queueRef, { ...plan.queuePatch, caseListExternalAcceptanceHash: plan.acceptance.acceptanceHash, completedAt: now, updatedAt: now }, { merge: true });
          tx.set(operationRef, { externalAcceptance: plan.acceptance, status: "completed", phaseState: "completed", completedAt: now, updatedAt: now }, { merge: true });
        }
        return plan;
      }),
    });
    const r = await recordsFor(queueRef); ownLease(r);
    if (select) {
      need(input?.clientNameUpConfirmed === true && input.reviewKey === r.queue.caseListPhase?.continuationHash, "EXTERNAL_EXPLICIT_REVIEW_REQUIRED");
      await connection.select(queueRef.id, uid, token, input);
      return { status: "EXTERNAL_TRANSFER_SELECTED", queueId: queueRef.id, sourceWrites: 0, monthlyWrites: 0 };
    }
    const out = await connection.reconcile(queueRef.id, uid, token);
    return { status: out.kind === "ALREADY_ACCEPTED" ? "EXTERNAL_ALREADY_ACCEPTED" : "EXTERNAL_READBACK_VERIFIED",
      queueId: queueRef.id, acceptanceHash: out.acceptance.acceptanceHash, sourceWrites: 0, monthlyWrites: 0 };
  } finally {
    await db.runTransaction(async tx => { if ((await tx.get(syncRef)).data()?.tokenId === leaseToken) tx.delete(syncRef); });
  }
}
export function selectExternalCaseListMonthlyTransfer(queueRef: Ref, uid: string, token: Data, input: Data) {
  return runExternal(queueRef, uid, token, true, input);
}
export function reconcileExternalCaseListMonthlyTransfer(queueRef: Ref, uid: string, token: Data) {
  return runExternal(queueRef, uid, token, false);
}
export async function resolveExternalCaseListSheetRef(companyId: string, jobId: string, job: Data, tx?: Tx): Promise<any> {
  need(job.companyId === companyId && ID.test(jobId) && ID.test(job.assignmentSheetWrite?.queueId ?? ""), "EXTERNAL_PRIVATE_IDENTITY_INVALID");
  const r = await recordsFor(db.collection("sheetSyncQueue").doc(job.assignmentSheetWrite.queueId), tx);
  need(r.jobId === jobId && canonical(normalized(job)) === canonical(r.job), "EXTERNAL_PRIVATE_JOB_CHANGED");
  const connection = core.createConnection({ authorize: () => {}, assertAuthority: authority, now: () => Date.now(),
    gasDigest: hashCaseList, readProtected: async () => r, readSheets: async () => { throw Error("PRIVATE_READER_NETWORK_FORBIDDEN"); },
    transaction: async () => { throw Error("PRIVATE_READER_WRITE_FORBIDDEN"); } });
  return connection.resolvePrivateRef(r);
}

/** Used only under the existing import lease. This never creates acceptance. */
export async function observeAcceptedExternalImport(companyId: string, jobId: string, job: Data) {
  const queueRef = db.collection("sheetSyncQueue").doc(job.assignmentSheetWrite.queueId);
  const r = await recordsFor(queueRef);
  need(r.jobId === jobId && r.queue.companyId === companyId && canonical(normalized(job)) === canonical(r.job), "EXTERNAL_IMPORT_ASSIGNMENT_CHANGED");
  const snapshot = await readArchivedCaseListSnapshot(companyId, job.caseId);
  const c = core.createConnection({ authorize: () => {}, assertAuthority: authority, now: () => Date.now(), gasDigest: hashCaseList,
    readProtected: async () => r, readSheets: async () => { throw Error("IMPORT_EXTRA_READ_FORBIDDEN"); }, transaction: async () => { throw Error("IMPORT_ACCEPTANCE_WRITE_FORBIDDEN"); } }) as any;
  c.validateAcceptedSnapshot(r, snapshot);
  return { snapshot, selectionHash: r.externalSelection.selectionHash, acceptanceHash: r.externalAcceptance.acceptanceHash };
}
export async function assertAcceptedExternalImport(tx: Tx, companyId: string, jobId: string, job: Data, evidence: Data) {
  const r = await recordsFor(db.collection("sheetSyncQueue").doc(job.assignmentSheetWrite.queueId), tx);
  need(r.jobId === jobId && r.queue.companyId === companyId && canonical(normalized(job)) === canonical(r.job) &&
    r.externalSelection.selectionHash === evidence.selectionHash && r.externalAcceptance.acceptanceHash === evidence.acceptanceHash &&
    Date.now() - evidence.snapshot.readStartedAt <= 60_000 && evidence.snapshot.observedAt <= Date.now(), "EXTERNAL_IMPORT_EVIDENCE_EXPIRED_OR_CHANGED");
  const c = core.createConnection({ authorize: () => {}, assertAuthority: authority, now: () => Date.now(), gasDigest: hashCaseList,
    readProtected: async () => r, readSheets: async () => { throw Error("IMPORT_TRANSACTION_READ_FORBIDDEN"); }, transaction: async () => { throw Error("IMPORT_ACCEPTANCE_WRITE_FORBIDDEN"); } }) as any;
  return c.validateAcceptedSnapshot(r, evidence.snapshot);
}


