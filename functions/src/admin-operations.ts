import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { z } from "zod";
import { db } from "./firebase";
import { companyFromClaims, requireAdmin, requestId } from "./utils";
import { assertProductionOperational } from "./system-safety";
import { applicationConfirmationIdentity } from "./assignment-preparation-core";
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
});

const QueueActionSchema = z.object({
  queueId: z.string().min(1),
  note: z.string().max(1000).default(""),
});

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

  const jobIds = [...new Set(snap.docs.map((doc) => String(doc.data().jobId ?? "")).filter(Boolean))];
  const jobs = await getDocuments("jobs", jobIds);

  return {
    count: snap.size,
    issues: snap.docs.map((doc) => {
      const data = doc.data();
      const job = jobs.get(String(data.jobId ?? ""));
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
        canRetry: canManuallyRetrySheetWrite({
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
    }),
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
    if (!canManuallyRetrySheetWrite({ status: String(data.status ?? ""), errorType: String(data.errorType ?? ""), writeVerificationRequired: data.writeVerificationRequired })) {
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
  const input = QueueActionSchema.parse(request.data ?? {});
  const ref = db.collection("sheetSyncQueue").doc(input.queueId);
  const auditRef = db.collection("auditLogs").doc();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.companyId !== companyId) {
      throw new HttpsError("not-found", "書込エラーが見つかりません。");
    }
    const data = snap.data()!;
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

  const jobData = job.data()!;
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
      sheetUrl: buildSheetUrl(jobData),
    },
    currentValues,
    writeBlockedReason: expenseMailHoldReason(jobData),
    reviewVersion: expenseReviewVersion(companyId, input.jobId, job, draft),
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

  const job = await requireCompanyJob(companyId, input.jobId);
  const ref = db.collection("expenseReviews").doc(input.jobId);
  await db.runTransaction(async (tx) => {
    const [currentJob, currentReview] = await Promise.all([
      tx.get(db.collection("jobs").doc(input.jobId)), tx.get(ref),
    ]);
    assertExpenseWriteContext(companyId, input.jobId, job, currentJob, currentReview);
    assertExpenseReviewVersion(input.expectedVersion, companyId, input.jobId, currentJob, currentReview);
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
  return { url: buildSheetUrl(job) };
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

function expenseReviewVersion(companyId: string, jobId: string, job: FirebaseFirestore.DocumentSnapshot, review: FirebaseFirestore.DocumentSnapshot): string {
  // 確認版は認可の代用ではない。所属照合後、同じtransactionで現在版を比較する。
  return createHash("sha256").update(JSON.stringify([
    companyId, jobId, expenseWriteContext(job.data() ?? {}),
    expenseVersionValue(job.updateTime ?? null), review.exists,
    expenseVersionValue(review.updateTime ?? null), expenseVersionValue(review.data() ?? null),
  ])).digest("hex");
}

function assertExpenseReviewVersion(expected: string | undefined, companyId: string, jobId: string, job: FirebaseFirestore.DocumentSnapshot, review: FirebaseFirestore.DocumentSnapshot): void {
  // 旧Crew案件の互換性は維持。受信案件では表示版を省略できない。
  if (job.data()?.mailIntake && expected === undefined) {
    throw new HttpsError("failed-precondition", "受信案件の経費確認版がありません。経費を読み直してください。", { reason: "case_mail_expense_version_required" });
  }
  if (expected !== undefined && expected !== expenseReviewVersion(companyId, jobId, job, review)) {
    throw new HttpsError("failed-precondition", "経費確認が別の操作で更新されました。再読込して確認してください。");
  }
}

function expenseWriteContext(job: FirebaseFirestore.DocumentData): string {
  return JSON.stringify([
    expenseSheetWriteContext(job),
    ...["transportation", "purchase8", "purchase10", "netPrintCost", "postageCost"].map(key => numberOrNull(job.expenses?.[key])),
    job.sheetRef?.spreadsheetId ?? null, job.sheetRef?.sheetId ?? null, job.sheetRef?.currentRow ?? null,
  ]);
}

function assertExpenseWriteContext(
  companyId: string,
  jobId: string,
  expectedJob: FirebaseFirestore.DocumentData,
  currentJob: FirebaseFirestore.DocumentSnapshot,
  review: FirebaseFirestore.DocumentSnapshot
): void {
  const job = currentJob.data();
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
