import { createHash } from "node:crypto";
import { z } from "zod";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./firebase";
import { requireCaseListExecutive } from "./case-list-source";
import { readCaseListMonthlySnapshot } from "./case-list-monthly-reader";
import { hashCaseList } from "./case-list-source-core";
import { prepareCaseListPublicationPlan, ownerPublicationPolicyHash } from "./case-list-publication-core";
import { caseListPublicationPending } from "./case-list-publication-state";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const confirmation = z.object({ expectedSourceRevision: hash, confirmedRegion: z.string().min(1).max(100),
  confirmedFields: z.object({ arrival: z.literal(true), execution: z.literal(true), headcount: z.literal(true), dateMode: z.literal(true), payOffer: z.literal(true), vacancy: z.literal(true) }).strict(),
  payOffer: z.object({ dailyWageJPY: z.number().int().min(1).max(1000000), travelExpenses: z.literal("全額支給"), communicationExpenses: z.literal("全額支給") }).strict(),
  sourceReview: z.object({ headcountPerSlot: z.literal(1), reviewedIssues: z.array(z.string().max(1000)).max(100), resolutionNote: z.string().min(3).max(2000) }).strict().optional(),
}).strict();
const Schema = z.object({ jobIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)).length(1), action: z.enum(["publish", "stop"]),
  expectedRevisions: z.record(z.string(), z.number().int().min(0)).optional(), expectedSourceRevisions: z.record(z.string(), hash).optional(),
  caseListConfirmations: z.record(z.string(), confirmation).optional(),
  sourceTransition: z.object({ phase: z.enum(["preview", "request", "reconcile", "revoke"]), reviewPlanHash: hash.optional(), requestKey: hash.optional(), expectedIntentHash: hash.optional() }).strict(),
}).strict();
function need(ok: unknown, message: string): asserts ok { if (!ok) throw new HttpsError("failed-precondition", message); }
export async function updateCaseListSourcePublication(raw: unknown, companyId: string, actorUid: string, token: Record<string, unknown>) {
  requireCaseListExecutive(token);
  need(token.companyId === companyId && (token.uid ?? token.sub) === actorUid, "公開を確認する会社・実行者が一致しません。");
  const input = Schema.parse(raw), jobId = input.jobIds[0]!, jobRef = db.collection("jobs").doc(jobId);
  need(input.sourceTransition.phase === "revoke" ? input.action === "stop" : input.action === "publish", "原本反映の操作を確認してください。");
  const current = (await jobRef.get()).data();
  need(current?.companyId === companyId && (["revoke", "reconcile"].includes(input.sourceTransition.phase) ? current.caseListPublicationWrite : current.caseListSource), "案件リストの対象を確認できません。");
  const expectedGenerationRevision = input.expectedRevisions?.[jobId];
  const expectedIntentHash = input.sourceTransition.expectedIntentHash;
  if (["revoke", "reconcile"].includes(input.sourceTransition.phase)) need(Number.isSafeInteger(expectedGenerationRevision) && current.revision === expectedGenerationRevision &&
    typeof expectedIntentHash === "string" && current.caseListPublicationWrite?.intentHash === expectedIntentHash, "原本反映依頼の確認版が変わりました。一覧を更新して対象を選び直してください。");
  if (["revoke", "reconcile"].includes(input.sourceTransition.phase) && current.caseListPublicationWrite?.pending === false && current.caseListPublicationWrite?.state === "REVOKED") {
    const id = current.caseListPublicationWrite.queueId;
    need(/^[a-f0-9]{64}$/.test(id ?? ""), "反映依頼の識別子を確認できません。");
    const opRef = db.collection("caseListMonthlyOperations").doc(createHash("sha256").update(companyId + "|" + id).digest("hex"));
    const [q, revoked, started] = await Promise.all([db.collection("sheetSyncQueue").doc(id).get(), opRef.collection("events").doc("REVOKED").get(), opRef.collection("events").doc("WRITE_STARTED").get()]);
    const queue = q.data(), proof = revoked.data();
    need(queue?.companyId === companyId && queue.jobId === jobId && queue.status === "cancelled" && queue.operation === "case_list.publish" && hashCaseList(queue.caseListPublication) === current.caseListPublicationWrite.intentHash && proof?.companyId === companyId && proof.queueId === id && proof.payloadHash === hashCaseList(proof.payload) && proof.payload?.schema === "LK_CASE_LIST_PUBLICATION_REVOCATION_V1" && proof.payload.stage === "REVOKED" && proof.payload.companyId === companyId && proof.payload.jobId === jobId && proof.payload.queueId === id && proof.payload.afterWriteStarted === false && proof.payload.captureHash === current.caseListPublicationWrite.intentHash && !started.exists, "取り下げ記録の照合を完了できません。");
    return { updated: [], blocked: [], sourcePublication: { state: "REVOKED", operationId: id } };
  }
  if (input.sourceTransition.phase === "revoke") {
    need(caseListPublicationPending(current) && /^[a-f0-9]{64}$/.test(current.caseListPublicationWrite.queueId ?? ""), "取り下げる原本反映依頼がありません。");
    const queueRef = db.collection("sheetSyncQueue").doc(current.caseListPublicationWrite.queueId);
    const opRef = db.collection("caseListMonthlyOperations").doc(createHash("sha256").update(companyId + "|" + queueRef.id).digest("hex"));
    return db.runTransaction(async tx => {
      const [j, q, op, requested, started, ack, revoked] = await Promise.all([tx.get(jobRef), tx.get(queueRef), tx.get(opRef), tx.get(opRef.collection("events").doc("REQUESTED")), tx.get(opRef.collection("events").doc("WRITE_STARTED")), tx.get(opRef.collection("events").doc("ACK")), tx.get(opRef.collection("events").doc("REVOKED"))]);
      const job = j.data(), queue = q.data(), capture = queue?.caseListPublication, intentHash = capture && hashCaseList(capture);
      need(job?.companyId === companyId && queue?.companyId === companyId && queue.jobId === jobId && queue.operation === "case_list.publish" && capture?.companyId === companyId && capture.jobId === jobId && capture.queueId === queueRef.id &&
        job.revision === expectedGenerationRevision && job.caseListPublicationWrite?.queueId === queueRef.id && job.caseListPublicationWrite?.intentHash === expectedIntentHash && expectedIntentHash === intentHash && op.data()?.companyId === companyId && op.data()?.jobId === jobId && op.data()?.queueId === queueRef.id && op.data()?.captureHash === intentHash && requested.data()?.companyId === companyId && requested.data()?.queueId === queueRef.id && requested.data()?.payloadHash === intentHash && hashCaseList(requested.data()?.payload) === intentHash && !ack.exists, "原本反映依頼の記録が変わりました。照合を保留しました。");
      need(Number.isSafeInteger(job.revision) && job.revision >= 0, "案件の確認版がありません。");
      const now = Timestamp.now(), uncertain = started.exists;
      const event = { schema: "LK_CASE_LIST_PUBLICATION_REVOCATION_V1", stage: "REVOKED", companyId, jobId, queueId: queueRef.id, operationId: queueRef.id, caseId: capture.caseId, captureHash: intentHash, actorUid, afterWriteStarted: uncertain };
      if (!revoked.exists) tx.create(opRef.collection("events").doc("REVOKED"), { companyId, queueId: queueRef.id, payload: event, payloadHash: hashCaseList(event), createdAt: now });
      tx.update(jobRef, { caseListPublicationWrite: { ...job.caseListPublicationWrite, pending: uncertain, state: uncertain ? "HELD_REVOKED" : "REVOKED" },
        status: job.cancelled === true || job.status === "cancelled" ? "cancelled" : job.assignedStaffId ? "assigned" : "stopped", publishable: false, sourceReady: false, recruitmentStopped: true, revision: job.revision + 1, updatedAt: now });
      tx.set(queueRef, { status: uncertain ? "blocked" : "cancelled", errorType: uncertain ? "verification_required" : "owner_revoked", writeVerificationRequired: uncertain, retryAt: null, updatedAt: now }, { merge: true });
      tx.set(opRef, { status: uncertain ? "held_revoked" : "revoked", updatedAt: now }, { merge: true });
      return { updated: [], blocked: uncertain ? [jobId] : [], sourcePublication: { state: uncertain ? "HELD" : "REVOKED", operationId: queueRef.id } };
    });
  }
  if (input.sourceTransition.phase === "reconcile") {
    need(current.caseListPublicationWrite && /^[a-f0-9]{64}$/.test(current.caseListPublicationWrite.queueId ?? ""), "原本反映の確認対象がありません。");
    // Bind the API request again immediately before handing off to the
    // worker. Its own transactions fence later races; this read-only fence
    // rejects an A-pane that already points at a newer B generation.
    await db.runTransaction(async tx => {
      const latest = (await tx.get(jobRef)).data();
      need(latest?.companyId === companyId && latest.revision === expectedGenerationRevision && latest.caseListPublicationWrite?.intentHash === expectedIntentHash && latest.caseListPublicationWrite?.queueId === current.caseListPublicationWrite.queueId, "原本反映依頼の対象世代が変わりました。一覧を更新してください。");
    }, { readOnly: true });
    const worker: typeof import("./case-list-publication-worker") = require("./case-list-publication-worker");
    const outcome = await worker.processCaseListPublication(db.collection("sheetSyncQueue").doc(current.caseListPublicationWrite.queueId), undefined, { actorUid, token });
    const after = (await jobRef.get()).data();
    const published = after?.companyId === companyId && after.caseListPublicationWrite?.intentHash === expectedIntentHash && after.caseListPublicationWrite?.queueId === current.caseListPublicationWrite.queueId && after.caseListPublicationWrite?.pending === false && after.caseListPublicationWrite?.state === "PUBLISHED" && after.status === "open" && after.publishable === true && after.cancelled !== true;
    return { updated: published ? [jobId] : [], blocked: published ? [] : [jobId], sourcePublication: { state: published ? "PUBLISHED" : "HELD", reason: outcome.reason ?? null } };
  }
  if (caseListPublicationPending(current)) return { updated: [], blocked: [jobId], sourcePublication: { state: "AWAITING_SOURCE_ACK", operationId: current.caseListPublicationWrite.queueId } };
  const review = input.caseListConfirmations?.[jobId], revision = input.expectedRevisions?.[jobId], expectedSourceRevision = input.expectedSourceRevisions?.[jobId];
  need(review && Number.isSafeInteger(revision) && review.expectedSourceRevision === expectedSourceRevision, "現在の条件を一件ずつ確認してください。");
  const snapshot = await readCaseListMonthlySnapshot(companyId, current.caseId);
  let plan: ReturnType<typeof prepareCaseListPublicationPlan>;
  try { plan = prepareCaseListPublicationPlan({ snapshot, companyId, jobId, job: current, confirmation: review, expectedJobRevision: revision!, expectedSourceRevision: expectedSourceRevision!, nowISO: new Date().toISOString() }); }
  catch { throw new HttpsError("failed-precondition", "この案件の原本状態・地域・日程・未手配・支給条件を確認できません。元の値を保持しました。"); }
  if (input.sourceTransition.phase === "preview") return { updated: [], blocked: [], sourcePublication: { state: "REVIEW_READY", reviewPlanHash: plan.reviewPlanHash, review: {
    caseId: plan.caseId, sourceStateBefore: "確認待ち", sourceStateAfter: "募集中", regionBefore: "", regionAfter: review.confirmedRegion, ...plan.jobFields,
  } } };
  need(input.sourceTransition.reviewPlanHash === plan.reviewPlanHash && input.sourceTransition.requestKey === plan.reviewPlanHash, "確認した原本・条件が変わりました。もう一度確認してください。");
  const operationId = hashCaseList({ companyId, jobId, reviewPlanHash: plan.reviewPlanHash }), queueRef = db.collection("sheetSyncQueue").doc(operationId);
  // The operation collection's existing convention hashes plain company|queue.
  const actualOperationRef = db.collection("caseListMonthlyOperations").doc(createHash("sha256").update(companyId + "|" + queueRef.id).digest("hex"));
  return db.runTransaction(async tx => {
    const [jobSnap, configSnap, queueSnap, leaseSnap] = await Promise.all([tx.get(jobRef), tx.get(db.collection("sheetImportConfigs").doc(companyId)), tx.get(queueRef), tx.get(db.collection("caseListSyncLocks").doc(companyId))]);
    const job = jobSnap.data(), config = configSnap.data(), queued = queueSnap.data();
    need(job?.companyId === companyId && config?.companyId === companyId && config.caseListEnabled === true && config.caseListAssignmentsEnabled === true && config.spreadsheetId === snapshot.spreadsheetId, "原本の連携設定が変わりました。");
    if (queued) {
      need(queued.companyId === companyId && queued.jobId === jobId && queued.caseListPublication?.reviewPlanHash === plan.reviewPlanHash, "同じ依頼キーの内容が一致しません。");
      return { updated: [], blocked: [jobId], sourcePublication: { state: "AWAITING_SOURCE_ACK", operationId: queueRef.id } };
    }
    need(!caseListPublicationPending(job) && job.revision === revision && job.cancelled !== true && !job.assignedStaffId && job.caseListSource?.sourceRevision === expectedSourceRevision, "案件の状態が変わりました。再確認してください。");
    need(!(leaseSnap.data()?.activeUntil instanceof Timestamp && leaseSnap.data()!.activeUntil.toMillis() > Date.now()), "案件リストの別処理が進行しています。");
    try {
      const latest = prepareCaseListPublicationPlan({ snapshot, companyId, jobId, job, confirmation: review, expectedJobRevision: revision!, expectedSourceRevision: expectedSourceRevision!, nowISO: new Date().toISOString() });
      need(latest.reviewPlanHash === plan.reviewPlanHash, "案件・原本の確認内容が変わりました。");
    } catch { throw new HttpsError("failed-precondition", "案件の状態・担当・原本との対応が変わりました。再確認してください。"); }
    const now = Timestamp.now(), createdAtMs = now.toMillis();
    const capture = { schema: "LK_CASE_LIST_PUBLICATION_CAPTURE_V1", companyId, jobId, queueId: queueRef.id, actorUid, caseId: plan.caseId,
      source: job.caseListSource, beforeJobRevision: revision!, queuedJobRevision: revision! + 1, confirmedRegion: review.confirmedRegion, confirmation: review,
      conditionsHash: hashCaseList(review), ownerPolicyHash: ownerPublicationPolicyHash(process.env.EXECUTIVE_APPROVER_EMAILS ?? ""), createdAtMs, expiresAtMs: createdAtMs + 10 * 60_000, reviewPlanHash: plan.reviewPlanHash, requestKey: plan.reviewPlanHash };
    const captureHash = hashCaseList(capture);
    tx.create(actualOperationRef, { schema: "LK_CASE_LIST_PUBLICATION_OPERATION_V1", companyId, jobId, queueId: queueRef.id, captureHash, status: "queued", createdAt: now });
    tx.create(actualOperationRef.collection("events").doc("REQUESTED"), { companyId, queueId: queueRef.id, payload: capture, payloadHash: captureHash, createdAt: now });
    tx.create(queueRef, { operation: "case_list.publish", companyId, jobId, actorUid, status: "pending", idempotencyKey: `case_list.publish:${jobId}:${plan.reviewPlanHash}`, caseListPublication: capture, updates: {}, expected: {}, styles: {}, createdAt: now, updatedAt: now });
    tx.update(jobRef, { caseListPublicationWrite: { queueId: queueRef.id, intentHash: captureHash, pending: true, state: "AWAITING_SOURCE_ACK" }, status: "draft", publishable: false, sourceReady: false, recruitmentStopped: true, revision: revision! + 1, updatedAt: now });
    return { updated: [], blocked: [], sourcePublication: { state: "AWAITING_SOURCE_ACK", operationId: queueRef.id } };
  });
}
