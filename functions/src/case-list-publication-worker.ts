import { createHash, randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { google } from "googleapis";
import { db } from "./firebase";
import { createJobIdFromPersistedCaseId } from "./case-id";
import { assertExecutive, canonical, configuredCaseListSource, hashCaseList, publicCaseListSource } from "./case-list-source-core";
import { readCaseListMonthlySnapshot } from "./case-list-monthly-reader";
import { prepareCaseListPublicationPlan, assertCaseListPublicationReadback, ownerPublicationPolicyHash } from "./case-list-publication-core";
import { stageVerifiedCaseListPublication } from "./case-list-publication-finalizer";
import { sheetWriteExecutionPaused } from "./sheet-write-control";
import { getProductionOperationalState } from "./system-safety";

type Data = FirebaseFirestore.DocumentData;
type Ref = FirebaseFirestore.DocumentReference;
type Tx = FirebaseFirestore.Transaction;
type Plan = ReturnType<typeof prepareCaseListPublicationPlan>;
const adapter = require("../src/case-list-monthly-adapter.cjs") as {
  createGoogleSheetsMutationAdapter(options: { spreadsheetId: string; hash(text: string): string; readSnapshot(): Promise<unknown>; transport: { batchUpdate(body: { spreadsheetId: string; requests: unknown[] }): Promise<unknown> } }): { applySourcePublication(intent: Data): Promise<unknown> };
};
const ID = /^[A-Za-z0-9_-]{1,200}$/, HASH = /^[a-f0-9]{64}$/;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function need(ok: unknown, code: string): asserts ok { if (!ok) throw Error(code); }
const fingerprint = (q: Data) => hashCaseList({ companyId: q.companyId ?? null, jobId: q.jobId ?? null, actorUid: q.actorUid ?? null, operation: q.operation ?? null,
  idempotencyKey: q.idempotencyKey ?? null, updates: q.updates ?? {}, expected: q.expected ?? {}, styles: q.styles ?? {}, caseListPublication: q.caseListPublication ?? null });
function nativeEnabled() { return !sheetWriteExecutionPaused() && process.env.LKC_CASE_LIST_PUBLICATION_MODE === "active"; }

/** Existing queue continuation only. Default pause is checked before claiming
 * or consuming publication events; reconciliation never creates a write SDK. */
export async function processCaseListPublication(queueRef: Ref, claimedQueue?: Data, owner?: { actorUid: string; token: Data }): Promise<Data> {
  if (!owner && !nativeEnabled()) return { state: "AWAITING_SOURCE_ACK", status: "PUBLICATION_PAUSED", snapshotReads: 0, nativeBatches: 0 };
  if (owner) {
    assertExecutive(owner.token, process.env.EXECUTIVE_APPROVER_EMAILS ?? "");
    need(ID.test(owner.actorUid) && (owner.token.uid ?? owner.token.sub) === owner.actorUid, "PUBLICATION_OWNER_IDENTITY_INVALID");
  }
  const initial = (await queueRef.get()).data();
  if (!initial || initial.operation !== "case_list.publish") return { state: "HELD", reason: "UNRELATED_OPERATION", snapshotReads: 0, nativeBatches: 0 };
  need(ID.test(initial.companyId ?? "") && ID.test(initial.jobId ?? "") && ID.test(initial.actorUid ?? "") && ID.test(queueRef.id), "PUBLICATION_QUEUE_IDENTITY_INVALID");
  if (owner) need(owner.token.companyId === initial.companyId, "PUBLICATION_OWNER_COMPANY_INVALID");
  if (initial.status === "completed") return { state: "PUBLISHED", status: "ALREADY_COMPLETED", snapshotReads: 0, nativeBatches: 0 };
  if (!owner && (!claimedQueue || initial.status !== "processing")) return { state: "AWAITING_SOURCE_ACK", status: "QUEUE_NOT_PROCESSING", snapshotReads: 0, nativeBatches: 0 };
  const capture = initial.caseListPublication, captureHash = hashCaseList(capture ?? null), queueFingerprint = fingerprint(initial);
  const claimToken = owner ? randomUUID() : claimedQueue!.claimToken;
  need(typeof claimToken === "string" && claimToken, "PUBLICATION_CLAIM_INVALID");
  const operationRef = db.collection("caseListMonthlyOperations").doc(sha(initial.companyId + "|" + queueRef.id));
  const jobRef = db.collection("jobs").doc(initial.jobId), configRef = db.collection("sheetImportConfigs").doc(initial.companyId);
  const mappingRef = db.collection("companies").doc(initial.companyId).collection("sheetMappings").doc("shift");
  const syncRef = db.collection("caseListSyncLocks").doc(initial.companyId);
  const deadline = Date.now() + 50_000;
  let acquired = false, started = false, nativeBatches = 0, snapshotReads = 0;
  async function event(tx: Tx, stage: string): Promise<Data | undefined> {
    const record = (await tx.get(operationRef.collection("events").doc(stage))).data();
    if (!record) return undefined;
    const payload = record.payload;
    need(record.companyId === initial!.companyId && record.queueId === queueRef.id && record.payloadHash === hashCaseList(payload), "PUBLICATION_EVENT_INTEGRITY");
    if (stage === "REQUESTED") need(canonical(payload) === canonical(capture), "PUBLICATION_REQUEST_CHANGED");
    else need(payload.stage === stage && payload.operationId === queueRef.id && payload.caseId === capture.caseId && payload.captureHash === captureHash, "PUBLICATION_EVENT_SCOPE");
    return payload;
  }
  async function trusted(tx: Tx, claimed: boolean) {
    const [queueSnap, jobSnap, configSnap, mapSnap, leaseSnap, operationSnap, actorSnap, privateSnap, revokedSnap] = await Promise.all([
      tx.get(queueRef), tx.get(jobRef), tx.get(configRef), tx.get(mappingRef), tx.get(syncRef), tx.get(operationRef),
      tx.get(db.collection("authIdentities").doc(initial!.actorUid)), tx.get(db.collection("caseListSheetRefs").doc(initial!.jobId)), tx.get(operationRef.collection("events").doc("REVOKED")),
    ]);
    const queue = queueSnap.data(), job = jobSnap.data(), config = configSnap.data(), mapping = mapSnap.data(), lease = leaseSnap.data(), operation = operationSnap.data(), actor = actorSnap.data();
    need(!revokedSnap.exists, "PUBLICATION_INTENT_REVOKED");
    need(queue && job && config && mapping && operation && fingerprint(queue) === queueFingerprint && !privateSnap.exists, "PUBLICATION_TRUSTED_DOCUMENT_CHANGED");
    need(capture?.schema === "LK_CASE_LIST_PUBLICATION_CAPTURE_V1" && capture.companyId === initial!.companyId && capture.jobId === initial!.jobId && capture.queueId === queueRef.id && capture.actorUid === initial!.actorUid && ID.test(capture.actorUid) &&
      createJobIdFromPersistedCaseId(capture.companyId, capture.caseId) === capture.jobId && Number.isSafeInteger(capture.beforeJobRevision) && capture.beforeJobRevision >= 0 && capture.queuedJobRevision === capture.beforeJobRevision + 1 &&
      HASH.test(capture.reviewPlanHash ?? "") && capture.requestKey === capture.reviewPlanHash && capture.conditionsHash === hashCaseList(capture.confirmation) && capture.ownerPolicyHash === ownerPublicationPolicyHash(process.env.EXECUTIVE_APPROVER_EMAILS ?? "") && capture.confirmedRegion === capture.confirmation?.confirmedRegion &&
      Number.isSafeInteger(capture.createdAtMs) && Number.isSafeInteger(capture.expiresAtMs) && capture.createdAtMs <= Date.now() && capture.expiresAtMs > Date.now() && capture.expiresAtMs - capture.createdAtMs <= 10 * 60_000,
    "PUBLICATION_CAPTURE_INVALID_OR_EXPIRED");
    need(operation.schema === "LK_CASE_LIST_PUBLICATION_OPERATION_V1" && operation.companyId === capture.companyId && operation.jobId === capture.jobId && operation.queueId === queueRef.id && operation.captureHash === captureHash,
    "PUBLICATION_OPERATION_CHANGED");
    need(Object.keys(queue.updates ?? {}).length === 0 && Object.keys(queue.expected ?? {}).length === 0 && Object.keys(queue.styles ?? {}).length === 0 && queue.idempotencyKey === `case_list.publish:${queue.jobId}:${capture.requestKey}`, "PUBLICATION_NATIVE_REQUEST_CHANGED");
    need(config.companyId === capture.companyId && config.caseListEnabled === true && config.caseListAssignmentsEnabled === true && mapping.enabled === true, "PUBLICATION_WRITER_DISABLED");
    const spreadsheetId = configuredCaseListSource(config.spreadsheetId).spreadsheetId;
    need(mapping.spreadsheetId === spreadsheetId && job.companyId === capture.companyId && job.caseId === capture.caseId && canonical(job.caseListSource) === canonical(capture.source) && job.revision === capture.queuedJobRevision &&
      job.status === "draft" && job.cancelled !== true && job.publishable === false && job.recruitmentStopped === true && job.sourceReady === false && !job.assignedStaffId && !job.assignedStaffName && !job.sheetRef && !job.caseListManualPending && !job.assignmentSheetWrite &&
      job.sourceMissing !== true && job.assignmentUnresolved !== true && job.applicationUnconfirmed !== true && job.adminEditSheetWrite?.pending !== true && job.cancellationSheetWrite?.sourceAckPending !== true &&
      job.caseListPublicationWrite?.queueId === queueRef.id && job.caseListPublicationWrite.intentHash === captureHash && job.caseListPublicationWrite.pending === true,
    "PUBLICATION_JOB_CHANGED_OR_REVOKED");
    need(!actorSnap.exists || actor?.active === true && actor.companyId === capture.companyId, "PUBLICATION_ACTOR_REVOKED");
    need(await event(tx, "REQUESTED"), "PUBLICATION_REQUEST_EVENT_MISSING");
    if (claimed) need(queue.status === "processing" && queue.claimToken === claimToken && queue.retryAt instanceof Timestamp && queue.retryAt.toMillis() > Date.now() &&
      lease && lease.tokenId === claimToken && lease.activeUntil instanceof Timestamp && lease.activeUntil.toMillis() > Date.now() && operation.claimToken === claimToken, "PUBLICATION_LEASE_CHANGED");
    return { queue, job, config, mapping, lease, operation, spreadsheetId };
  }
  async function authorize() {
    if (!owner) need(nativeEnabled(), "PUBLICATION_PAUSED");
    need((await getProductionOperationalState(initial!.companyId)).operational, "PUBLICATION_GLOBAL_STOPPED");
    return db.runTransaction(tx => trusted(tx, true));
  }
  try {
    need((await getProductionOperationalState(initial.companyId)).operational, "PUBLICATION_GLOBAL_STOPPED");
    const current = await db.runTransaction(async tx => {
      const current = await trusted(tx, false), intent = await event(tx, "INTENT"), dispatch = await event(tx, "WRITE_STARTED"), ack = await event(tx, "ACK");
      if (dispatch) started = true;
      need(!ack && !(current.lease?.activeUntil instanceof Timestamp && current.lease.activeUntil.toMillis() > Date.now()), "PUBLICATION_COMPANY_LEASE_ACTIVE");
      if (owner) need(intent && dispatch && dispatch.intentHash === hashCaseList(intent) && current.queue.status !== "completed", "PUBLICATION_READONLY_PROOF_REQUIRED");
      else need(claimedQueue && fingerprint(claimedQueue) === queueFingerprint && current.queue.status === "processing" && current.queue.claimToken === claimToken && current.queue.writeVerificationRequired !== true && current.queue.errorType !== "verification_required" && !dispatch, "PUBLICATION_UNKNOWN_REQUIRES_RECONCILIATION");
      const now = Timestamp.now(), until = Timestamp.fromMillis(Date.now() + 10 * 60_000);
      tx.set(queueRef, { status: "processing", claimToken, retryAt: until, updatedAt: now }, { merge: true });
      tx.set(syncRef, { tokenId: claimToken, activeUntil: until, actorUid: owner?.actorUid ?? capture.actorUid, kind: "source.publish", queueId: queueRef.id });
      tx.set(operationRef, { claimToken, status: "processing", queueFingerprint, updatedAt: now }, { merge: true });
      return { ...current, intent, dispatch };
    });
    acquired = true; started = !!current.dispatch;
    const read = async () => { need(++snapshotReads <= 3, "PUBLICATION_SNAPSHOT_BUDGET"); await authorize(); return readCaseListMonthlySnapshot(initial.companyId, capture.caseId, {}); };
    let intent = current.intent;
    if (!owner) {
      const snapshot = await read();
      const plan = prepareCaseListPublicationPlan({ snapshot, companyId: initial.companyId, jobId: initial.jobId,
        job: { ...current.job, revision: capture.beforeJobRevision, caseListPublicationWrite: null }, confirmation: capture.confirmation,
        expectedJobRevision: capture.beforeJobRevision, expectedSourceRevision: capture.source.sourceRevision, nowISO: new Date().toISOString() });
      need(plan.reviewPlanHash === capture.reviewPlanHash && canonical(publicCaseListSource(plan.preCatalog)) === canonical(capture.source), "PUBLICATION_PLAN_CHANGED");
      const next = { schema: "LK_CASE_LIST_PUBLICATION_INTENT_V1", stage: "INTENT", companyId: initial.companyId, jobId: initial.jobId, queueId: queueRef.id,
        operationId: queueRef.id, caseId: capture.caseId, spreadsheetId: current.spreadsheetId, captureHash, plan };
      need(Buffer.byteLength(canonical(next), "utf8") < 850_000, "PUBLICATION_INTENT_TOO_LARGE");
      if (intent) need(canonical(intent) === canonical(next), "PUBLICATION_PREPARED_IMAGE_CHANGED");
      else {
        intent = next;
        await db.runTransaction(async tx => { await trusted(tx, true); need(!(await event(tx, "INTENT")), "PUBLICATION_INTENT_EXISTS"); tx.create(operationRef.collection("events").doc("INTENT"), { companyId: initial.companyId, queueId: queueRef.id, payload: next, payloadHash: hashCaseList(next), createdAt: Timestamp.now() }); });
      }
      const sheets = google.sheets({ version: "v4", auth: new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] }) });
      const mutation = adapter.createGoogleSheetsMutationAdapter({ spreadsheetId: current.spreadsheetId, hash: sha, readSnapshot: read, transport: { batchUpdate: async body => {
        await authorize(); need(nativeBatches === 0 && body.spreadsheetId === current.spreadsheetId && body.requests.length === 1, "PUBLICATION_NATIVE_BUDGET");
        need(deadline - Date.now() - 8_000 >= 2_000, "PUBLICATION_TIME_BUDGET");
        const dispatch = { stage: "WRITE_STARTED", operationId: queueRef.id, caseId: capture.caseId, captureHash, intentHash: hashCaseList(intent) };
        started = true; // Unknown metadata commit response must never permit a POST retry.
        await db.runTransaction(async tx => { await trusted(tx, true); need(!(await event(tx, "WRITE_STARTED")), "PUBLICATION_ALREADY_STARTED"); const saved = await event(tx, "INTENT"); need(saved && hashCaseList(saved) === dispatch.intentHash, "PUBLICATION_INTENT_CHANGED"); tx.create(operationRef.collection("events").doc("WRITE_STARTED"), { companyId: initial.companyId, queueId: queueRef.id, payload: dispatch, payloadHash: hashCaseList(dispatch), createdAt: Timestamp.now() }); });
        await authorize();
        const timeout = Math.min(30_000, deadline - Date.now() - 8_000); need(timeout >= 2_000, "PUBLICATION_TIME_BUDGET");
        nativeBatches++;
        return sheets.spreadsheets.batchUpdate({ spreadsheetId: body.spreadsheetId, requestBody: { requests: body.requests as never[] } }, { retry: false, retryConfig: { retry: 0, noResponseRetries: 0, httpMethodsToRetry: [] }, timeout });
      } } });
      await mutation.applySourcePublication(intent);
    }
    need(intent?.schema === "LK_CASE_LIST_PUBLICATION_INTENT_V1" && intent.captureHash === captureHash && intent.plan?.reviewPlanHash === capture.reviewPlanHash, "PUBLICATION_READBACK_INTENT_INVALID");
    const readStartedAtMs = Date.now(), snapshot = await read();
    const check = assertCaseListPublicationReadback(snapshot, intent.plan as Plan);
    await db.runTransaction(async tx => {
      const latest = await trusted(tx, true), savedIntent = await event(tx, "INTENT"), dispatch = await event(tx, "WRITE_STARTED"), priorAck = await event(tx, "ACK");
      need(!priorAck && savedIntent && dispatch && dispatch.intentHash === hashCaseList(savedIntent) && hashCaseList(savedIntent) === hashCaseList(intent), "PUBLICATION_READBACK_PROOF_CHANGED");
      const now = Timestamp.now(), ack = { schema: "LK_CASE_LIST_PUBLICATION_ACK_V1", stage: "ACK", operationId: queueRef.id, caseId: capture.caseId, captureHash, intentHash: hashCaseList(savedIntent), readStartedAtMs, confirmedAtMs: now.toMillis(), reconciledBy: owner?.actorUid ?? null, postSource: publicCaseListSource(check.source) };
      stageVerifiedCaseListPublication(tx, jobRef, check, capture.actorUid, now, initial.companyId);
      tx.update(jobRef, { caseListSource: publicCaseListSource(check.source), caseListPublicationWrite: { ...latest.job.caseListPublicationWrite, pending: false, state: "PUBLISHED", ackHash: hashCaseList(ack) } });
      tx.create(operationRef.collection("events").doc("ACK"), { companyId: initial.companyId, queueId: queueRef.id, payload: ack, payloadHash: hashCaseList(ack), createdAt: now });
      tx.set(queueRef, { status: "completed", retryAt: null, writeVerificationRequired: false, completedAt: now, updatedAt: now }, { merge: true });
      tx.set(operationRef, { status: "completed", acceptedAckHash: hashCaseList(ack), completedAt: now, updatedAt: now }, { merge: true });
      tx.set(db.collection("sheetWriteIdempotency").doc(sha(initial.companyId + "|" + initial.idempotencyKey)), { companyId: initial.companyId, queueId: queueRef.id, status: "completed", completedAt: now }, { merge: true });
    });
    return { state: "PUBLISHED", status: "SOURCE_PUBLICATION_READBACK_VERIFIED", snapshotReads, nativeBatches };
  } catch (error) {
    const reason = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "PUBLICATION_HELD";
    await db.runTransaction(async tx => {
      const queue = (await tx.get(queueRef)).data(), job = (await tx.get(jobRef)).data();
      if (!queue || queue.status !== "processing" || queue.claimToken !== claimToken || fingerprint(queue) !== queueFingerprint) return;
      tx.set(queueRef, { status: "blocked", errorType: started ? "verification_required" : "blocked", writeVerificationRequired: started, retryAt: null,
        caseListPublicationReason: reason, errorMessage: "原本の公開状態・地域の反映を確認してください。非公開を保ち、自動再書込を停止しました。", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      if (job?.caseListPublicationWrite?.queueId === queueRef.id && job.caseListPublicationWrite.intentHash === captureHash && job.caseListPublicationWrite.pending === true && job.revision === capture.queuedJobRevision && job.caseListPublicationWrite.state !== "HELD_REVOKED") tx.update(jobRef, { caseListPublicationWrite: { ...job.caseListPublicationWrite, state: "HELD", reason }, publishable: false, recruitmentStopped: true, sourceReady: false });
      if (acquired) tx.set(operationRef, { status: "held", heldReason: reason, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
    return { state: "HELD", reason, snapshotReads, nativeBatches };
  } finally {
    if (acquired) await db.runTransaction(async tx => { if ((await tx.get(syncRef)).data()?.tokenId === claimToken) tx.delete(syncRef); });
  }
}
