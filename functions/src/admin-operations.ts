import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { z } from "zod";
import { db } from "./firebase";
import { companyFromClaims, requireAdmin, requestId } from "./utils";
import { assertProductionOperational } from "./system-safety";
import { applicationConfirmationIdentity } from "./assignment-preparation-core";
const caseListPrivate = (): typeof import("./case-list-private-ref") => require("./case-list-private-ref");
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
  action: z.enum(["note", "reconcile-case-list", "select-case-list-monthly"]).default("note"),
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
        canReconcile: data.operation === "case_list.assign" && !manualTransferPending || ["job.cancel", "job.cancel.v2"].includes(data.operation) && ["LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V1", "LK_CASE_LIST_SOURCE_CANCEL_CAPTURE_V2"].includes(data.caseListCancellation?.schema) && data.writeVerificationRequired === true,
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

export const acknowledgeSheetWriteIssue = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
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
    // The worker rechecks executive identity and current authority. Owner mode
    // only reads Sheets and may settle metadata after exact verified images.
    const worker: typeof import("./case-list-monthly-worker") = require("./case-list-monthly-worker");
    return worker.reconcileCaseListMonthlyAssignment(ref, session.uid, session.token);
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
  const jobData = rawJob.caseListSource ? await caseListPrivate().resolveCaseListPrivateFinancialJob(companyId, input.jobId, rawJob) : rawJob;
  const linkRef = rawJob.caseListSource ? await caseListPrivate().locateCaseListPrivateSheetRow(jobData.sheetRef) : jobData.sheetRef;
  const currentValues = {
    transportation: numberOrNull(jobData.expenses?.transportation),
    purchase8: numberOrNull(jobData.expenses?.purchase8),
    purchase10: numberOrNull(jobData.expenses?.purchase10),
    netPrintCost: numberOrNull(jobData.expenses?.netPrintCost),
    postageCost: numberOrNull(jobData.expenses?.postageCost),
  };

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
    writeBlockedReason: rawJob.caseListSource ? CASE_LIST_EXPENSE_HOLD : expenseMailHoldReason(jobData),
    reviewVersion: expenseReviewVersion(companyId, input.jobId, job, draft),
    ...(rawJob.caseListSource ? { reviewVersion: expenseReviewVersion(companyId, input.jobId, job, draft, jobData) } : {}),
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
  const job = rawJob.caseListSource ? await caseListPrivate().resolveCaseListPrivateFinancialJob(companyId, input.jobId, rawJob) : rawJob;
  const ref = db.collection("expenseReviews").doc(input.jobId);
  await db.runTransaction(async (tx) => {
    const [currentJob, currentReview] = await Promise.all([
      tx.get(db.collection("jobs").doc(input.jobId)), tx.get(ref),
    ]);
    const privateCurrent = currentJob.data()?.caseListSource ? await caseListPrivate().resolveCaseListPrivateFinancialJob(companyId, input.jobId, currentJob.data()!, tx) : undefined;
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

export const completeExpenseReview = onCall(async (request) => {
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
    // The existing expense writer/finalizer uses public job amounts. Keep this
    // route held until a private-aware completion path can verify its result.
    await db.runTransaction(async tx => {
      const [currentJob, review] = await Promise.all([tx.get(db.collection("jobs").doc(input.jobId)), tx.get(db.collection("expenseReviews").doc(input.jobId))]);
      if (!currentJob.exists || currentJob.data()?.companyId !== companyId) throw new HttpsError("not-found", "案件が見つかりません。");
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
});

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
