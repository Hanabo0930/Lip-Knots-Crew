import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { z } from "zod";
import { db } from "./firebase";
import { companyFromClaims, requireAdmin, requestId } from "./utils";
import { assertProductionOperational } from "./system-safety";
import { applicationConfirmationIdentity } from "./assignment-preparation-core";
import { completeExternalExpense, traceExternalExpense, type ExternalExpenseAtomicWriter } from "./case-list-external-expense-completion";
const caseListPrivate = (): typeof import("./case-list-private-ref") => require("./case-list-private-ref");
const caseListExternal = (): typeof import("./case-list-external-transfer") => require("./case-list-external-transfer");
const isExternalExpenseJob = (job: FirebaseFirestore.DocumentData) => Boolean(job.caseListSource && job.assignmentSheetWrite?.externalAck);
const CASE_LIST_EXPENSE_HOLD = "この案件の経費確定は保留中です。現在の経費は確認できます。";
import {
  buildExpenseExpected,
  expenseSheetWriteContext,
  expenseMailHoldReason,
  buildExpenseSheetUpdates,
  canManuallyRetrySheetWrite,
  createSpreadsheetRowUrl,
  normalizeExpenseInput,
} from "./admin-operations-core";

const IssueQuerySchema = z.object({
  limit: z.number().int().min(1).max(200).default(100),
  manualCursor: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(),
});

const QueueActionSchema = z.object({
  queueId: z.string().min(1),
  note: z.string().max(1000).default(""),
});

const AcknowledgeQueueSchema = QueueActionSchema.extend({
  action: z.enum(["note", "reconcile-case-list", "select-case-list-monthly", "select-case-list-gas-monthly", "read-case-list-gas-binding"]).default("note"),
  reviewKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  clientNameUpConfirmed: z.literal(true).optional(),
});

const ManualSelectionSchema = z.object({
  action: z.literal("select-case-list-manual-monthly"),
  jobId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  observationHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedJobRevision: z.number().int().min(1),
  expectedSourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
  clientNameUpConfirmed: z.literal(true),
  manualConfirmation: z.object({
    confirmedFields: z.object({ arrival: z.literal(true), execution: z.literal(true), headcount: z.literal(true), dateMode: z.literal(true), payOffer: z.literal(true) }).strict(),
    payOffer: z.object({ dailyWageJPY: z.number().int().min(1).max(1000000), travelExpenses: z.literal("全額支給"), communicationExpenses: z.literal("全額支給") }).strict(),
  }).strict(),
}).strict();

const JobSchema = z.object({
  jobId: z.string().min(1),
});
const ExpenseTraceSchema = z.object({
  jobId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  operationId: z.string().uuid(),
}).strict();
const ExpenseStatusSchema = ExpenseTraceSchema.extend({
  mode: z.literal("confirmation-status"),
  operationId: ExpenseTraceSchema.shape.operationId.optional(),
});

const ApplicationConfirmationSchema = JobSchema.extend({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const DraftSchema = z.object({
  jobId: z.string().min(1),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  values: z.object({
    transportation: z.union([z.number(), z.string(), z.null()]).optional(),
    purchase8: z.union([z.number(), z.string(), z.null()]).optional(),
    purchase10: z.union([z.number(), z.string(), z.null()]).optional(),
    netPrintCost: z.union([z.number(), z.string(), z.null()]).optional(),
    postageCost: z.union([z.number(), z.string(), z.null()]).optional(),
  }),
  note: z.string().max(3000).default(""),
});

const CompleteSchema = DraftSchema.extend({
  confirmExistingValues: z.boolean().default(false),
});

export const getSheetWriteIssues = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = IssueQuerySchema.parse(request.data ?? {});

  const snap = await db.collection("sheetSyncQueue")
    .where("companyId", "==", companyId)
    .where("status", "in", ["blocked", "dead_letter", "retry_wait", "acknowledged", "error", "paused_global"])
    .orderBy("updatedAt", "desc")
    .limit(input.limit)
    .get();

  let manualQuery = db.collection("caseListManualObservations").where("companyId", "==", companyId).orderBy("__name__").limit(input.limit + 1);
  if (input.manualCursor) manualQuery = manualQuery.startAfter(input.manualCursor);
  const manualSnapshot = await manualQuery.get(), manualPage = manualSnapshot.docs.slice(0, input.limit);
  const jobIds = [...new Set([...snap.docs.map((doc) => String(doc.data().jobId ?? "")), ...manualPage.map(doc => doc.id)].filter(Boolean))];
  const jobs = await getDocuments("jobs", jobIds);
  let executive = false;
  try { const core: typeof import("./case-list-source-core") = require("./case-list-source-core"); core.assertExecutive(session.token, process.env.EXECUTIVE_APPROVER_EMAILS ?? ""); executive = true; } catch { /* Other admins cannot select transfers. */ }

  const manualIssues = manualPage.filter(doc => doc.data().state === "blocked_requires_owner_review").map(doc => {
    const observed = doc.data(), job = jobs.get(doc.id), holdReasons = Array.isArray(observed.holdReasons) ? observed.holdReasons : ["MANUAL_OBSERVATION_INVALID"];
    const ready = job?.companyId === companyId && observed.schema === "LK_CASE_LIST_MANUAL_OBSERVATION_V1" && observed.selected === false &&
      observed.source?.sourceRevision === job.caseListSource?.sourceRevision && job.sourceMissing !== true && job.applicationUnconfirmed === true && job.caseListManualPending?.observationHash === observed.observationHash && job.caseListManualPending?.staffId === observed.staffId && job.assignedStaffId === observed.staffId && !job.assignmentSheetWrite && job.cancelled !== true && job.status !== "cancelled" &&
      /^[A-Za-z0-9_-]{1,200}$/.test(observed.staffId ?? "") && (require("./case-list-manual-origin-core") as typeof import("./case-list-manual-origin-core")).manualOwnerReviewCanProceed(holdReasons);
    const offer = job?.publicPayOffer;
    const suggestedPayOffer = offer && Number.isSafeInteger(offer.dailyWageJPY) && offer.dailyWageJPY > 0 && offer.dailyWageJPY <= 1000000 && offer.travelExpenses === "全額支給" && offer.communicationExpenses === "全額支給"
      ? { dailyWageJPY: offer.dailyWageJPY, travelExpenses: "全額支給", communicationExpenses: "全額支給" } : null;
    return { id: doc.id, jobId: doc.id, companyId, operation: "case_list.manual", status: "blocked", errorType: "manual_owner_selection_required", errorMessage: ready ? "シートへの手入力を確認しました。ネームアップ後に勤務条件を確認し、この案件を選択してください。" : "手入力の照合事項が残っています。案件リストとスタッフ名簿を確認してください。",
      attempts: 0, canRetry: false, canReconcile: false, sourceWriteVerified: false, manualSourcePending: true, manualSourceStaffName: typeof observed.sourceStaffName === "string" ? observed.sourceStaffName : "", manualCanonicalStaffName: typeof observed.canonicalStaffName === "string" ? observed.canonicalStaffName : "", manualTransferPending: true, canSelectMonthlyTransfer: executive && ready,
      manualObservationHash: observed.observationHash, manualExpectedJobRevision: job?.revision ?? null, manualExpectedSourceRevision: observed.source?.sourceRevision ?? null, suggestedPayOffer,
      desiredUpdates: {}, beforeValues: {}, updatedAt: serializeTimestamp(observed.observedAt), manualHoldReasons: holdReasons.filter(reason => reason !== "MANUAL_TRANSFER_ADAPTER_NOT_ACTIVATED"),
      job: job?.companyId === companyId ? { workDate: job.workDate ?? job.dateKey ?? "", storeName: job.storeName ?? "", assignedStaffName: observed.canonicalStaffName ?? "", clientName: job.clientName ?? "", makerName: job.makerName ?? "", menuName: job.menuName ?? "", entryTime: job.entryTime ?? "", workTime: job.workTime ?? "" } : null };
  });
  return {
    count: snap.size + manualIssues.length,
    manualNextCursor: manualSnapshot.size > input.limit ? manualPage.at(-1)?.id ?? null : null,
    issues: [...snap.docs.map((doc) => {
      const data = doc.data();
      const job = jobs.get(String(data.jobId ?? ""));
      const manualTransferPending = data.operation === "case_list.assign" && data.status === "blocked" && data.errorType === "owner_transfer_required" && data.caseListPhase?.phase === "MONTHLY_PREPARE";
      const externalSelectionRequired = data.operation === "case_list.assign" && data.errorType === "external_transfer_selection_required";
      const externalSelected = data.operation === "case_list.assign" && data.errorType === "external_transfer_selected";
      const externalReadbackAvailable = !externalSelected || executive &&
        (require("./case-list-external-mode") as typeof import("./case-list-external-mode")).externalTransferMode() !== "read-only";
      return {
        id: doc.id,
        companyId: data.companyId,
        jobId: data.jobId,
        operation: data.operation,
        status: data.status,
        errorType: data.errorType ?? "system",
        errorMessage: data.errorMessage ?? "",
        attempts: data.attempts ?? 0,
        desiredUpdates: data.updates ?? {},
        expected: data.expected ?? {},
        beforeValues: data.beforeValues ?? {},
        updatedAt: serializeTimestamp(data.updatedAt),
        writeVerificationRequired: (data.writeVerificationRequired !== undefined && data.writeVerificationRequired !== false) || data.errorType === "verification_required",
        sourceWriteVerified: false,
        acknowledgedAt: serializeTimestamp(data.acknowledgedAt),
        acknowledgedNote: typeof data.acknowledgedNote === "string" ? data.acknowledgedNote : "",
        sourceCancellation: ["job.cancel", "job.cancel.v2"].includes(data.operation) && ["LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V1", "LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V2"].includes(data.caseListCancellation?.schema),
        canReconcile: data.operation === "case_list.assign" && !manualTransferPending && !externalSelectionRequired && externalReadbackAvailable || ["job.cancel", "job.cancel.v2"].includes(data.operation) && ["LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V1", "LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V2"].includes(data.caseListCancellation?.schema) && data.writeVerificationRequired === true,
        manualTransferPending,
        canSelectMonthlyTransfer: executive && manualTransferPending,
        manualTransferReviewKey: manualTransferPending && /^[a-f0-9]{64}$/.test(data.caseListPhase?.continuationHash ?? "") ? data.caseListPhase.continuationHash : null,
        canRetry: data.operation !== "case_list.assign" && canManuallyRetrySheetWrite({
          status: String(data.status ?? ""),
          errorType: String(data.errorType ?? ""),
          writeVerificationRequired: data.writeVerificationRequired,
        }),
        job: job?.companyId === companyId ? {
          workDate: job.workDate ?? job.dateKey ?? "",
          storeName: job.storeName ?? "",
          assignedStaffName: job.assignedStaffName ?? "",
          clientName: job.clientName ?? "",
        } : null,
      };
    }), ...manualIssues],
  };
});

export const retrySheetWriteIssue = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const input = QueueActionSchema.parse(request.data ?? {});
  const ref = db.collection("sheetSyncQueue").doc(input.queueId);
  const auditRef = db.collection("auditLogs").doc();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.companyId !== companyId) {
      throw new HttpsError("not-found", "書込エラーが見つかりません。");
    }
    const data = snap.data()!;
    if (data.operation === "case_list.assign" || !canManuallyRetrySheetWrite({ status: String(data.status ?? ""), errorType: String(data.errorType ?? ""), writeVerificationRequired: data.writeVerificationRequired })) {
      throw new HttpsError("failed-precondition", "現在の書込状態では再試行できません。再読込して確認してください。");
    }
    tx.update(ref, {
      status: "pending", attempts: 0, manualRetryCount: FieldValue.increment(1),
      manualRetryBy: session.uid, manualRetryNote: input.note,
      updatedAt: FieldValue.serverTimestamp(), retryAt: FieldValue.delete(),
    });
    tx.set(auditRef, {
      companyId, actorUid: session.uid, action: "sheet.issue.retry", queueId: ref.id,
      note: input.note, createdAt: FieldValue.serverTimestamp(),
    });
  });

  return { retried: true };
});

// Existing Firebase callable transport; no new endpoint or token handoff to GAS.
function firebaseExternalOwner<T>(request: any, session: any, operation: (actor: any, beforeCommit: () => Promise<void>) => Promise<T>): Promise<T> {
  const { withFirebaseOwnerCallable } = require("./case-list-firebase-owner") as typeof import("./case-list-firebase-owner");
  return withFirebaseOwnerCallable(request, session, operation);
}

export const acknowledgeSheetWriteIssue = onCall(async (request) => {
  const session = requireAdmin(request);
  if (typeof request.data?.action === "string" && request.data.action.startsWith("staff-ng-")) {
    const {handleStaffNgManagement}=require("./staff-ng-management") as typeof import("./staff-ng-management");
    return handleStaffNgManagement(request,session);
  }
  const companyId = companyFromClaims(session.token);
  if (["preview-case-list-gas-send", "confirm-case-list-gas-send", "observe-case-list-gas-send"].includes(request.data?.action)) {
    const { handleOwnerNameUpReview } = require("./case-list-owner-review-callable") as typeof import("./case-list-owner-review-callable");
    return handleOwnerNameUpReview(request, session);
  }
  if (request.data?.action === "select-case-list-manual-gas-monthly") {
    const externalManualSchema = ManualSelectionSchema.extend({ action: z.literal("select-case-list-manual-gas-monthly") });
    const input = externalManualSchema.parse(request.data);
    return firebaseExternalOwner(request, session, async (owner, beforeCommit) => {
      await assertProductionOperational(companyId);
      const monthly: typeof import("./case-list-monthly-worker") = require("./case-list-monthly-worker");
      const result = await monthly.registerCaseListManualForHandoff(companyId, owner.uid, owner, input, beforeCommit);
      const queueRef = db.collection("sheetSyncQueue").doc(String(result.queueId));
      const queue = (await queueRef.get()).data();
      const external: typeof import("./case-list-external-transfer") = require("./case-list-external-transfer");
      return external.selectExternalCaseListMonthlyTransferForHandoff(queueRef, owner.uid, owner,
        { reviewKey: queue?.caseListPhase?.continuationHash, clientNameUpConfirmed: true }, beforeCommit);
    });
  }
  if (request.data?.action === "select-case-list-manual-monthly") {
    const manualInput = ManualSelectionSchema.parse(request.data);
    await assertProductionOperational(companyId);
    const worker: typeof import("./case-list-monthly-worker") = require("./case-list-monthly-worker");
    try { return await worker.selectCaseListManualMonthlyTransfer(companyId, session.uid, session.token, manualInput); }
    catch (error) {
      const reason = error instanceof Error ? error.message : "";
      if (reason === "CASE_LIST_EXECUTIVE_REQUIRED") throw new HttpsError("permission-denied", "移行対象の確定は責任者のみ実行できます。");
      if (/^(MANUAL_|CASE_LIST_WRITER_DISABLED|OWNER_TRANSFER_LEASE_ACTIVE|GLOBAL_OPERATION_STOPPED)/.test(reason)) throw new HttpsError("failed-precondition", "勤務条件・手入力・スタッフ・取消状態を再確認してください。受付結果が不明な場合は繰り返し実行せず、再読込してください。");
      throw new HttpsError("internal", "移行指示の受付結果を確定できませんでした。繰り返し実行せず、再読込して状態を確認してください。");
    }
  }
  const input = AcknowledgeQueueSchema.parse(request.data ?? {});
  const ref = db.collection("sheetSyncQueue").doc(input.queueId);
  if (input.action === "read-case-list-gas-binding") {
    const external: typeof import("./case-list-external-transfer") = require("./case-list-external-transfer");
    return firebaseExternalOwner(request, session, async (owner) => {
      const binding = await external.readExternalCaseListSelectionBinding(ref, owner.uid, owner);
      return { status: "EXTERNAL_BINDING_READ", queueId: ref.id, binding, sourceWrites: 0, monthlyWrites: 0 };
    });
  }
  if (input.action === "select-case-list-gas-monthly") {
    if (!input.reviewKey || input.clientNameUpConfirmed !== true) throw new HttpsError("invalid-argument", "ネームアップ済みの確認と対象の選択が必要です。");
    return firebaseExternalOwner(request, session, async (owner, beforeCommit) => {
      await assertProductionOperational(companyId);
    const snap = await ref.get();
    if (!snap.exists || snap.data()?.companyId !== companyId || snap.data()?.operation !== "case_list.assign") throw new HttpsError("not-found", "移行対象が見つかりません。");
    const external: typeof import("./case-list-external-transfer") = require("./case-list-external-transfer");
      return external.selectExternalCaseListMonthlyTransferForHandoff(ref, owner.uid, owner, input, beforeCommit);
    });
  }
  if (input.action === "select-case-list-monthly") {
    if (!input.reviewKey || input.clientNameUpConfirmed !== true) throw new HttpsError("invalid-argument", "ネームアップ済みの確認と移行対象の選択が必要です。");
    await assertProductionOperational(companyId);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.data()?.companyId !== companyId) throw new HttpsError("not-found", "移行対象が見つかりません。");
    if (snapshot.data()?.operation !== "case_list.assign") throw new HttpsError("failed-precondition", "この依頼は案件リストからの移行対象ではありません。");
    const worker: typeof import("./case-list-monthly-worker") = require("./case-list-monthly-worker");
    try { return await worker.selectCaseListMonthlyTransfer(ref, session.uid, session.token, input.reviewKey, true); }
    catch (error) {
      const reason = error instanceof Error ? error.message : "";
      if (reason === "CASE_LIST_EXECUTIVE_REQUIRED") throw new HttpsError("permission-denied", "移行対象の確定は責任者のみ実行できます。");
      if (reason === "SOURCE_CANCELLED_OR_INVALID") throw new HttpsError("failed-precondition", "キャンセル扱いの案件は移行できません。案件リストを確認してください。");
      if (["OWNER_TRANSFER_CHANGED", "OWNER_TRANSFER_REVIEW_CHANGED", "OWNER_TRANSFER_SOURCE_CHANGED"].includes(reason)) throw new HttpsError("failed-precondition", "確認中に案件の内容が変わりました。再読込して移行対象を確認してください。");
      if (reason === "OWNER_TRANSFER_LEASE_ACTIVE") throw new HttpsError("failed-precondition", "別の処理が進行中です。再読込して状態を確認してください。");
      if (reason === "GLOBAL_OPERATION_STOPPED") throw new HttpsError("failed-precondition", "現在、移行処理は停止されています。");
      throw new HttpsError("internal", "移行指示の受付結果を確定できませんでした。繰り返し実行せず、再読込して状態を確認してください。");
    }
  }
  if (input.action === "reconcile-case-list") {
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.data()?.companyId !== companyId) throw new HttpsError("not-found", "書込エラーが見つかりません。");
    const data = snapshot.data()!;
    if (["job.cancel", "job.cancel.v2"].includes(data.operation) && ["LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V1", "LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V2"].includes(data.caseListCancellation?.schema)) {
      const cancellation: typeof import("./case-list-source-cancellation") = require("./case-list-source-cancellation");
      return cancellation.processCaseListSourceCancellation(ref, undefined, { actorUid: session.uid, token: session.token });
    }
    if (snapshot.data()?.operation !== "case_list.assign") throw new HttpsError("failed-precondition", "この依頼は保存結果の再照合に対応していません。");
    const reconcileExternal = () => firebaseExternalOwner(request, session, (owner, beforeCommit) => {
        const external: typeof import("./case-list-external-transfer") = require("./case-list-external-transfer");
        return external.reconcileExternalCaseListMonthlyTransferForHandoff(ref, owner.uid, owner, beforeCommit);
      });
    if (data.errorType === "external_transfer_selected" || typeof data.caseListExternalAcceptanceHash === "string") {
      return reconcileExternal();
    }
    // The worker rechecks executive identity and current authority. Owner mode
    // only reads Sheets and may settle metadata after exact verified images.
    const worker: typeof import("./case-list-monthly-worker") = require("./case-list-monthly-worker");
    // The worker rereads the operation and may discover a concurrent external
    // selection. That late branch must enter the same Firebase owner guard.
    return worker.reconcileCaseListMonthlyAssignment(ref, session.uid, session.token, reconcileExternal);
  }
  const auditRef = db.collection("auditLogs").doc();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.companyId !== companyId) {
      throw new HttpsError("not-found", "書込エラーが見つかりません。");
    }
    const data = snap.data()!;
    if (["LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V1", "LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V2"].includes(data.caseListCancellation?.schema)) throw new HttpsError("failed-precondition", "案件リストの取消は確認メモで完了にできません。保存結果を再照合してください。");
    if (data.operation === "case_list.assign") throw new HttpsError("failed-precondition", "案件リストの移行待ちは確認メモで完了にできません。対象を選択して移行してください。");
    if (data.status === "acknowledged") {
      if (data.acknowledgedBy === session.uid && data.acknowledgedNote === input.note) return;
      throw new HttpsError("failed-precondition", "既に確認メモが記録されています。再読込して確認してください。");
    }
    if (!["blocked", "dead_letter", "retry_wait", "error", "paused_global"].includes(String(data.status ?? ""))) {
      throw new HttpsError("failed-precondition", "現在の書込状態では確認済みにできません。再読込して確認してください。");
    }
    tx.update(ref, {
      status: "acknowledged", acknowledgedFromStatus: data.status, acknowledgedBy: session.uid, acknowledgedNote: input.note,
      acknowledgedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(auditRef, {
      companyId, actorUid: session.uid, action: "sheet.issue.acknowledge", queueId: ref.id,
      note: input.note, createdAt: FieldValue.serverTimestamp(),
    });
  });

  return { acknowledged: true, sourceWriteVerified: false };
});

export const confirmApplication = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const input = ApplicationConfirmationSchema.parse(request.data ?? {});
  const ref = db.collection("jobs").doc(input.jobId);
  const job = await ref.get();

  if (!job.exists || job.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "案件が見つかりません。");
  }
  if (job.data()?.status !== "assigned" || job.data()?.cancelled === true || !job.data()?.assignedStaffId ||
      job.data()?.sourceMissing === true || job.data()?.assignmentUnresolved === true ||
      (job.data()?.mailIntake && (job.data()?.mailIntakeReviewRequired === true || job.data()?.pendingSourceWrite === true || job.data()?.adminEditSheetWrite?.pending === true))) {
    throw new HttpsError(
      "failed-precondition",
      "担当者を確認できる有効な手配済み案件だけ確認済みにできます。"
    );
  }

  const auditRef = db.collection("auditLogs").doc();
  await db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    if (!current.exists || current.data()?.companyId !== companyId) {
      throw new HttpsError("not-found", "案件が見つかりません。");
    }
    const data = current.data()!;
    if (data.status !== "assigned" || (data.assignedStaffId ?? null) !== (job.data()?.assignedStaffId ?? null) ||
        (data.revision ?? 0) !== input.expectedRevision ||
        applicationConfirmationIdentity(data) !== applicationConfirmationIdentity(job.data()!)) {
      throw new HttpsError("failed-precondition", "案件の状態・担当・勤務条件が変わりました。再読込して確認してください。");
    }
    if (data.mailIntake && (data.mailIntakeReviewRequired === true || data.pendingSourceWrite === true || data.adminEditSheetWrite?.pending === true)) {
      throw new HttpsError("failed-precondition", "受信内容または原本の変更を確認してから担当確認してください。");
    }
    if (data.applicationAdminConfirmed === true) return;
    tx.update(ref, {
      applicationAdminConfirmed: true,
      applicationAdminConfirmedBy: session.uid,
      applicationAdminConfirmedAt: FieldValue.serverTimestamp(),
      applicationAdminConfirmedRevision: input.expectedRevision,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(auditRef, {
      companyId, actorUid: session.uid, action: "application.confirm",
      jobId: input.jobId, assignedStaffId: data.assignedStaffId, dateKey: data.dateKey ?? null,
      revision: input.expectedRevision, createdAt: FieldValue.serverTimestamp(),
    });
  });

  return { confirmed: true };
});

export const getExpenseReview = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  if (request.data && Object.hasOwn(request.data, "mode")) {
    const {jobId,operationId} = ExpenseStatusSchema.parse(request.data);
    const job = await requireCompanyJob(companyId,jobId);
    // Recorded operations remain traceable after the job loses its source link.
    return {jobId,confirmationOperation:await traceExternalExpense(companyId,jobId,job,operationId)};
  }
  const input = JobSchema.parse(request.data ?? {});
  const [job, draft] = await Promise.all([
    db.collection("jobs").doc(input.jobId).get(),
    db.collection("expenseReviews").doc(input.jobId).get(),
  ]);

  if (!job.exists || job.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "案件が見つかりません。");
  }

  if (draft.exists && (draft.data()?.companyId !== companyId || draft.data()?.jobId !== input.jobId)) {
    throw new HttpsError("failed-precondition", "経費確認と案件の所属情報が一致しません。");
  }

  const rawJob = job.data()!;
  const externalCase = isExternalExpenseJob(rawJob);
  const jobData = externalCase
    ? await caseListExternal().readExternalCaseListExpenses(companyId, input.jobId, rawJob)
    : rawJob.caseListSource ? await caseListPrivate().resolveCaseListPrivateFinancialJob(companyId, input.jobId, rawJob) : rawJob;
  const linkRef = rawJob.caseListSource && !externalCase
    ? await caseListPrivate().locateCaseListPrivateSheetRow(jobData.sheetRef)
    : jobData.sheetRef;
  const currentValues = {
    transportation: numberOrNull(jobData.expenses?.transportation),
    purchase8: numberOrNull(jobData.expenses?.purchase8),
    purchase10: numberOrNull(jobData.expenses?.purchase10),
    netPrintCost: numberOrNull(jobData.expenses?.netPrintCost),
    postageCost: numberOrNull(jobData.expenses?.postageCost),
  };
  let holdReason = rawJob.caseListSource ? CASE_LIST_EXPENSE_HOLD : expenseMailHoldReason(jobData);
  if (externalCase && draft.data()?.status === "confirmation_pending") {
    holdReason = "月別表への反映結果を照合中です。最新の状態は「読込」で確認してください。";
  } else if (externalCase && draft.data()?.status === "completed") {
    holdReason = "この経費は月別表への反映を確認済みです。";
  }

  return {
    job: {
      id: job.id,
      ...(jobData.mailIntake ? { receivedMail: true } : {}),
      workDate: jobData.workDate ?? jobData.dateKey ?? "",
      clientName: jobData.clientName ?? "",
      storeName: jobData.storeName ?? "",
      makerName: jobData.makerName ?? "",
      assignedStaffName: jobData.assignedStaffName ?? "",
      sheetUrl: buildSheetUrl({ ...jobData, sheetRef: linkRef }),
    },
    currentValues,
    writeBlockedReason: holdReason,
    ...(externalCase && !expenseMailHoldReason(jobData) && (!draft.exists || draft.data()?.status === "draft")
      ? { draftAllowedWhileHeld: true } : {}),
    reviewVersion: expenseReviewVersion(companyId, input.jobId, job, draft, rawJob.caseListSource ? jobData : undefined),
    draft: draft.exists ? serializeDocument(draft.data() ?? {}) : null,
  };
});

export const saveExpenseReviewDraft = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const input = DraftSchema.parse(request.data ?? {});
  const parsed = normalizeExpenseInput(input.values);

  if (parsed.errors.length) {
    throw new HttpsError("invalid-argument", parsed.errors.join(" / "));
  }

  const rawJob = await requireCompanyJob(companyId, input.jobId);
  const externalCase = isExternalExpenseJob(rawJob);
  if (externalCase && input.expectedVersion === undefined) {
    throw new HttpsError("failed-precondition", "経費確認版がありません。経費を読み直してください。",
      { reason: "case_list_private_expense_version_required" });
  }
  const job = externalCase
    ? await caseListExternal().readExternalCaseListExpenses(companyId, input.jobId, rawJob)
    : rawJob.caseListSource ? await caseListPrivate().resolveCaseListPrivateFinancialJob(companyId, input.jobId, rawJob) : rawJob;
  const ref = db.collection("expenseReviews").doc(input.jobId);
  await db.runTransaction(async (tx) => {
    const [currentJob, currentReview] = await Promise.all([
      tx.get(db.collection("jobs").doc(input.jobId)), tx.get(ref),
    ]);
    if (externalCase) {
      if (currentReview.exists && currentReview.data()?.status !== "draft") {
        throw new HttpsError("failed-precondition", "確定処理中または履歴のある経費です。現在の状態を確認してください。");
      }
      await caseListExternal().assertExternalExpenseBinding(companyId, input.jobId, rawJob, job, tx);
    }
    const privateCurrent = externalCase ? job : currentJob.data()?.caseListSource
      ? await caseListPrivate().resolveCaseListPrivateFinancialJob(companyId, input.jobId, currentJob.data()!, tx) : undefined;
    if (privateCurrent) {
      assertExpenseWriteContext(companyId, input.jobId, job, currentJob, currentReview, privateCurrent);
      assertExpenseReviewVersion(input.expectedVersion, companyId, input.jobId, currentJob, currentReview, privateCurrent);
    } else {
      assertExpenseWriteContext(companyId, input.jobId, job, currentJob, currentReview);
      assertExpenseReviewVersion(input.expectedVersion, companyId, input.jobId, currentJob, currentReview);
    }
    const now = Timestamp.now();
    tx.set(ref, {
      companyId, jobId: input.jobId, staffId: job.assignedStaffId ?? null,
      values: parsed.values, note: input.note, status: "draft",
      updatedBy: session.uid, updatedAt: now,
      createdAt: currentReview.data()?.createdAt ?? now,
    }, { merge: true });
  });

  return { saved: true, status: "draft" };
});

/** Only for authenticated server callers. The job must already be scope-checked. */
export function completeAuthorizedExternalExpense(
  companyId: string, actorUid: string, job: FirebaseFirestore.DocumentData,
  input: Pick<z.infer<typeof CompleteSchema>, "jobId" | "note" | "expectedVersion"> & { operationId?: string },
  values: ReturnType<typeof normalizeExpenseInput>["values"], writer: ExternalExpenseAtomicWriter,
) {
  if (!isExternalExpenseJob(job) || job.companyId !== companyId || !input.expectedVersion) {
    throw new HttpsError("failed-precondition", "外部連携案件と経費確認版を照合できません。");
  }
  return completeExternalExpense({
    companyId, jobId: input.jobId, job, actorUid, operationId: input.operationId, version: input.expectedVersion,
    values, note: input.note,
    assertReview(currentJob, review, observation) {
      assertExpenseWriteContext(companyId, input.jobId, observation, currentJob, review, observation);
      assertExpenseReviewVersion(input.expectedVersion, companyId, input.jobId, currentJob, review, observation);
    },
  }, writer);
}

export async function readAuthorizedExternalExpense(
  companyId: string, jobId: string, job: FirebaseFirestore.DocumentData,
  readObservation = caseListExternal().readExternalCaseListExpenses,
) {
  if (!isExternalExpenseJob(job) || job.companyId !== companyId) {
    throw new HttpsError("failed-precondition", "外部連携案件を照合できません。");
  }
  const [currentJob, review] = await Promise.all([
    db.collection("jobs").doc(jobId).get(), db.collection("expenseReviews").doc(jobId).get(),
  ]);
  const observation = await readObservation(companyId, jobId, job);
  assertExpenseWriteContext(companyId, jobId, observation, currentJob, review, observation);
  return {
    currentValues: observation.expenses,
    reviewVersion: expenseReviewVersion(companyId, jobId, currentJob, review, observation),
  };
}

export async function handleCompleteExpenseReview(request: CallableRequest, writer?: ExternalExpenseAtomicWriter) {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const input = CompleteSchema.parse(request.data ?? {});
  if (input.confirmExistingValues) {
    throw new HttpsError("failed-precondition", "変更前の経費照合は省略できません。最新の経費を再読込して確認してください。");
  }
  const parsed = normalizeExpenseInput(input.values);

  if (parsed.errors.length) {
    throw new HttpsError("invalid-argument", parsed.errors.join(" / "));
  }

  const job = await requireCompanyJob(companyId, input.jobId);
  if (job.caseListSource) {
    const externalCase = isExternalExpenseJob(job);
    if (externalCase && input.expectedVersion === undefined) {
      throw new HttpsError("failed-precondition", "経費確認版がありません。経費を読み直してください。",
        { reason: "case_list_private_expense_version_required" });
    }
    if (externalCase && writer && input.expectedVersion) {
      if (Object.keys(input.values).length!==Object.keys(parsed.values).length) {
        throw new HttpsError("invalid-argument","空欄を含め、経費5項目の確認値が必要です。");
      }
      return completeAuthorizedExternalExpense(companyId, session.uid, job, input, parsed.values, writer);
    }
    // Keep the deployed entry point held until a writer with the shared
    // concurrency fence is available and its behavior has been verified.
    const externalObservation = externalCase
      ? await caseListExternal().readExternalCaseListExpenses(companyId, input.jobId, job) : undefined;
    await db.runTransaction(async tx => {
      const [currentJob, review] = await Promise.all([tx.get(db.collection("jobs").doc(input.jobId)), tx.get(db.collection("expenseReviews").doc(input.jobId))]);
      if (!currentJob.exists || currentJob.data()?.companyId !== companyId) throw new HttpsError("not-found", "案件が見つかりません。");
      if (externalObservation) {
        await caseListExternal().assertExternalExpenseBinding(companyId, input.jobId, job, externalObservation, tx);
        assertExpenseWriteContext(companyId, input.jobId, externalObservation, currentJob, review, externalObservation);
        assertExpenseReviewVersion(input.expectedVersion, companyId, input.jobId, currentJob, review, externalObservation);
        caseListExternal().planExternalExpenseConfirmation(externalObservation, parsed.values);
        return;
      }
      const currentPrivate = await caseListPrivate().resolveCaseListPrivateFinancialJob(companyId, input.jobId, currentJob.data()!, tx);
      assertExpenseReviewVersion(input.expectedVersion, companyId, input.jobId, currentJob, review, currentPrivate);
    });
    throw new HttpsError("failed-precondition", CASE_LIST_EXPENSE_HOLD, { reason: "case_list_private_expense_completion_held" });
  }
  // URL生成で失敗する案件を、キュー作成後のエラーにしない。
  const sheetUrl = buildSheetUrl(job);
  const currentValues = {
    transportation: numberOrNull(job.expenses?.transportation),
    purchase8: numberOrNull(job.expenses?.purchase8),
    purchase10: numberOrNull(job.expenses?.purchase10),
    netPrintCost: numberOrNull(job.expenses?.netPrintCost),
    postageCost: numberOrNull(job.expenses?.postageCost),
  };

  const queueRef = db.collection("sheetSyncQueue").doc();
  const reviewRef = db.collection("expenseReviews").doc(input.jobId);
  const now = Timestamp.now();

  await db.runTransaction(async (tx) => {
    const [currentJob, existingReview] = await Promise.all([
      tx.get(db.collection("jobs").doc(input.jobId)), tx.get(reviewRef),
    ]);
    assertExpenseWriteContext(companyId, input.jobId, job, currentJob, existingReview);
    assertExpenseReviewVersion(input.expectedVersion, companyId, input.jobId, currentJob, existingReview);
    const previousRevision = existingReview.data()?.revision ?? 0;
    if (!Number.isSafeInteger(previousRevision) || previousRevision < 0 || previousRevision >= Number.MAX_SAFE_INTEGER) {
      throw new HttpsError("failed-precondition", "経費確認の版番号が不正です。");
    }
    const revision = previousRevision + 1;
    const expected = buildExpenseExpected(currentValues);

    tx.set(queueRef, {
      companyId,
      jobId: input.jobId,
      operation: "expense.review",
      ...(currentJob.data()!.mailIntake ? { dateKey: currentJob.data()!.dateKey } : {}),
      updates: buildExpenseSheetUpdates(parsed.values),
      expected,
      status: "pending",
      attempts: 0,
      actorUid: session.uid,
      idempotencyKey: `expense.review:${input.jobId}:${revision}`,
      createdAt: now,
      updatedAt: now,
    });

    tx.set(reviewRef, {
      companyId,
      jobId: input.jobId,
      staffId: job.assignedStaffId ?? null,
      values: parsed.values,
      expectedValues: currentValues,
      writeContext: expenseSheetWriteContext(currentJob.data()!),
      note: input.note,
      status: "queued",
      queueId: queueRef.id,
      revision,
      completedBy: session.uid,
      queuedAt: now,
      updatedAt: now,
      createdAt: existingReview.exists
        ? existingReview.data()?.createdAt ?? now
        : now,
    }, { merge: true });
  });

  return {
    queued: true,
    queueId: queueRef.id,
    sheetUrl,
  };
}

export const completeExpenseReview = onCall(request=>handleCompleteExpenseReview(request));

// Server route only. The regular callable is not connected to a writer.
export async function handleTraceExternalExpense(request: CallableRequest, reader?: Pick<ExternalExpenseAtomicWriter, "readReceipt">) {
  const session=requireAdmin(request);
  const companyId=companyFromClaims(session.token);
  const {jobId,operationId}=ExpenseTraceSchema.parse(request.data??{});
  const job=await requireCompanyJob(companyId,jobId);
  if (!isExternalExpenseJob(job)) throw new HttpsError("not-found","対象の経費操作が見つかりません。");
  return traceExternalExpense(companyId,jobId,job,operationId,reader);
}

export const getJobSheetLink = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = JobSchema.parse(request.data ?? {});
  const job = await requireCompanyJob(companyId, input.jobId);
  if (!job.caseListSource) return { url: buildSheetUrl(job) };
  const privateRef = await caseListPrivate().resolveCaseListPrivateSheetRef(companyId, input.jobId, job);
  const currentRef = await caseListPrivate().locateCaseListPrivateSheetRow(privateRef);
  return { url: buildSheetUrl({ ...job, sheetRef: currentRef }) };
});

export const updateExpenseReviewFromQueue = onDocumentWritten(
  "sheetSyncQueue/{queueId}",
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return;
    const queue = after.data();
    if (!queue || queue.operation !== "expense.review") return;

    const status = String(queue.status ?? "");
    if (!["completed", "blocked", "dead_letter", "acknowledged"].includes(status)) {
      return;
    }

    const reviewQuery = await db.collection("expenseReviews")
      .where("queueId", "==", after.id)
      .limit(1)
      .get();
    if (reviewQuery.empty) return;

    const reviewRef = reviewQuery.docs[0]!.ref;
    if (typeof queue.jobId !== "string" || !queue.jobId) return;
    const jobRef = db.collection("jobs").doc(queue.jobId);
    await db.runTransaction(async (tx) => {
      // 遅延イベントや照合後の再確認・担当変更で、新しい状態を上書きしない。
      const [currentQueue, review, job] = await Promise.all([
        tx.get(after.ref), tx.get(reviewRef), tx.get(jobRef),
      ]);
      const latest = currentQueue.data();
      const currentReview = review.data();
      const currentJob = job.data();
      if (!currentQueue.exists || !review.exists || !job.exists ||
        latest?.operation !== "expense.review" || latest.jobId !== queue.jobId ||
        typeof latest.companyId !== "string" || !latest.companyId ||
        currentReview?.queueId !== after.id || currentReview.jobId !== latest.jobId ||
        currentReview.companyId !== latest.companyId || currentJob?.companyId !== latest.companyId ||
        isExternalExpenseJob(currentJob) ||
        (currentReview.staffId ?? null) !== (currentJob.assignedStaffId ?? null) ||
        !["queued", "error", "completed"].includes(String(currentReview.status ?? ""))) return;
      const currentStatus = String(latest.status ?? "");
      if (!["completed", "blocked", "dead_letter", "acknowledged"].includes(currentStatus)) return;
      // 一度反映済みの完了イベントは、後から取込んだ金額や確認時刻へ再適用しない。
      if (currentReview.status === "completed") return;
      if (currentStatus === "completed" && !expenseCompletionIsCurrent(latest, currentReview, currentJob)) {
        tx.update(reviewRef, {
          status: "error", sheetWriteStatus: "completed",
          sheetWriteError: "原本への書込みは完了していますが、経費・担当・勤務日・書込先の確認情報が変わっています。原本と最新の案件を確認してください。",
          finalizedAt: null, updatedAt: FieldValue.serverTimestamp(),
        });
        return;
      }
      tx.update(reviewRef, {
        status: currentStatus === "completed" ? "completed" : "error",
        sheetWriteStatus: currentStatus,
        sheetWriteError: latest.errorMessage ?? null,
        sheetRow: latest.resolvedRow ?? null,
        finalizedAt: currentStatus === "completed" ? FieldValue.serverTimestamp() : null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (currentStatus === "completed") {
        tx.update(jobRef, {
          expenses: { ...(currentJob.expenses ?? {}), ...(latest.updates ?? {}) },
          expenseReviewStatus: "completed",
          expenseReviewedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });
  }
);



/** 原本書込後から完了通知までに変更があれば、現在の案件へ旧金額を戻さない。 */
function expenseCompletionIsCurrent(queue: FirebaseFirestore.DocumentData, review: FirebaseFirestore.DocumentData, job: FirebaseFirestore.DocumentData): boolean {
  if (expenseMailHoldReason(job) || job.sourceMissing === true || job.assignmentUnresolved === true ||
      review.writeContext !== expenseSheetWriteContext(job) ||
      !Number.isSafeInteger(review.revision) || review.revision < 1 ||
      queue.idempotencyKey !== "expense.review:" + queue.jobId + ":" + review.revision ||
      !review.values || typeof review.values !== "object" || Array.isArray(review.values) ||
      !review.expectedValues || typeof review.expectedValues !== "object" || Array.isArray(review.expectedValues) ||
      Object.keys(queue.styles ?? {}).length) return false;
  const before = normalizeExpenseInput(review.expectedValues);
  const values = normalizeExpenseInput(review.values);
  const current = normalizeExpenseInput(job.expenses ?? {});
  const same = (left: unknown, right: unknown) => JSON.stringify(expenseVersionValue(left)) === JSON.stringify(expenseVersionValue(right));
  return !before.errors.length && !values.errors.length && !current.errors.length &&
    same(before.values, review.expectedValues) && same(values.values, review.values) &&
    same(buildExpenseExpected(before.values), queue.expected ?? {}) &&
    same(buildExpenseSheetUpdates(values.values), queue.updates ?? {}) &&
    // 完了通知に先行して、原本の反映済み金額を取込済みの場合も許可する。
    (same(current.values, before.values) || same(current.values, values.values));
}

function expenseVersionValue(value: unknown): unknown {
  if (value instanceof Timestamp) return ["timestamp", value.seconds, value.nanoseconds];
  if (Array.isArray(value)) return value.map(expenseVersionValue);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, expenseVersionValue(item)])
  );
  return value;
}

function expenseReviewVersion(companyId: string, jobId: string, job: FirebaseFirestore.DocumentSnapshot, review: FirebaseFirestore.DocumentSnapshot, privateJob?: FirebaseFirestore.DocumentData): string {
  // 確認版は認可の代用ではない。所属照合後、同じtransactionで現在版を比較する。
  return createHash("sha256").update(JSON.stringify([
    companyId, jobId, expenseWriteContext(privateJob ?? job.data() ?? {}),
    expenseVersionValue(job.updateTime ?? null), review.exists,
    expenseVersionValue(review.updateTime ?? null), expenseVersionValue(review.data() ?? null),
  ])).digest("hex");
}

function assertExpenseReviewVersion(expected: string | undefined, companyId: string, jobId: string, job: FirebaseFirestore.DocumentSnapshot, review: FirebaseFirestore.DocumentSnapshot, privateJob?: FirebaseFirestore.DocumentData): void {
  if (job.data()?.caseListSource && expected === undefined) {
    throw new HttpsError("failed-precondition", "経費確認版がありません。経費を読み直してください。", { reason: "case_list_private_expense_version_required" });
  }
  // 旧Crew案件の互換性は維持。受信案件では表示版を省略できない。
  if (job.data()?.mailIntake && expected === undefined) {
    throw new HttpsError("failed-precondition", "受信案件の経費確認版がありません。経費を読み直してください。", { reason: "case_mail_expense_version_required" });
  }
  if (expected !== undefined && expected !== expenseReviewVersion(companyId, jobId, job, review, privateJob)) {
    throw new HttpsError("failed-precondition", "経費確認が別の操作で更新されました。再読込して確認してください。");
  }
}

function expenseWriteContext(job: FirebaseFirestore.DocumentData): string {
  return JSON.stringify([
    expenseSheetWriteContext(job),
    ...["transportation", "purchase8", "purchase10", "netPrintCost", "postageCost"].map(key => numberOrNull(job.expenses?.[key])),
    job.sheetRef?.spreadsheetId ?? null, job.sheetRef?.sheetId ?? null, job.sheetRef?.currentRow ?? null,
    ...(job.caseListSource ? [job.caseListFinancialObservationHash ?? null] : []),
  ]);
}

function assertExpenseWriteContext(
  companyId: string,
  jobId: string,
  expectedJob: FirebaseFirestore.DocumentData,
  currentJob: FirebaseFirestore.DocumentSnapshot,
  review: FirebaseFirestore.DocumentSnapshot,
  privateJob?: FirebaseFirestore.DocumentData
): void {
  const job = privateJob ?? currentJob.data();
  if (!currentJob.exists || job?.companyId !== companyId) {
    throw new HttpsError("not-found", "案件が見つかりません。");
  }
  const holdReason = expenseMailHoldReason(job);
  if (holdReason) throw new HttpsError("failed-precondition", holdReason, { reason: "case_mail_expense_pending" });
  if (expenseWriteContext(job) !== expenseWriteContext(expectedJob)) {
    throw new HttpsError("failed-precondition", "案件の担当・経費・書込先が変更されました。再読込して確認してください。");
  }
  if (review.exists && (review.data()?.companyId !== companyId || review.data()?.jobId !== jobId)) {
    throw new HttpsError("failed-precondition", "経費確認と案件の所属情報が一致しません。");
  }
}

async function requireCompanyJob(
  companyId: string,
  jobId: string
): Promise<FirebaseFirestore.DocumentData> {
  const snap = await db.collection("jobs").doc(jobId).get();
  if (!snap.exists || snap.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "案件が見つかりません。");
  }
  return snap.data()!;
}

function buildSheetUrl(job: FirebaseFirestore.DocumentData): string {
  const spreadsheetId = String(job.sheetRef?.spreadsheetId ?? "");
  const sheetId = Number(job.sheetRef?.sheetId ?? 0);
  const row = Number(job.sheetRef?.currentRow ?? 0);
  return createSpreadsheetRowUrl({
    spreadsheetId,
    sheetId,
    row,
    endColumn: "BB",
  });
}

async function getDocuments(
  collectionName: string,
  ids: string[]
): Promise<Map<string, FirebaseFirestore.DocumentData>> {
  const result = new Map<string, FirebaseFirestore.DocumentData>();
  const unique = [...new Set(ids)];
  for (let index = 0; index < unique.length; index += 250) {
    const refs = unique.slice(index, index + 250)
      .map((id) => db.collection(collectionName).doc(id));
    if (!refs.length) continue;
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (snap.exists) result.set(snap.id, snap.data() ?? {});
    }
  }
  return result;
}

function serializeTimestamp(value: unknown): string | null {
  return value instanceof Timestamp ? value.toDate().toISOString() : null;
}

function serializeDocument(
  value: FirebaseFirestore.DocumentData
): FirebaseFirestore.DocumentData {
  const result: FirebaseFirestore.DocumentData = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = item instanceof Timestamp
      ? item.toDate().toISOString()
      : item;
  }
  return result;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
}
