import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { z } from "zod";
import { db } from "./firebase";
import { companyFromClaims, requireAdmin, requestId } from "./utils";
import { assertProductionOperational } from "./system-safety";
import {
  buildExpenseExpected,
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

const DraftSchema = z.object({
  jobId: z.string().min(1),
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
    .where("status", "in", ["blocked", "dead_letter", "retry_wait"])
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
        canRetry: canManuallyRetrySheetWrite({
          status: String(data.status ?? ""),
          errorType: String(data.errorType ?? ""),
        }),
        job: job ? {
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
  const snap = await ref.get();

  if (!snap.exists || snap.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "書込エラーが見つかりません。");
  }

  const data = snap.data()!;
  if (!canManuallyRetrySheetWrite({
    status: String(data.status ?? ""),
    errorType: String(data.errorType ?? ""),
  })) {
    throw new HttpsError(
      "failed-precondition",
      "競合は自動再試行できません。スプシの現在値を確認してください。"
    );
  }

  await ref.set({
    status: "pending",
    attempts: 0,
    manualRetryCount: FieldValue.increment(1),
    manualRetryBy: session.uid,
    manualRetryNote: input.note,
    updatedAt: FieldValue.serverTimestamp(),
    retryAt: FieldValue.delete(),
  }, { merge: true });

  await db.collection("auditLogs").add({
    companyId,
    actorUid: session.uid,
    action: "sheet.issue.retry",
    queueId: ref.id,
    note: input.note,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { retried: true };
});

export const acknowledgeSheetWriteIssue = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = QueueActionSchema.parse(request.data ?? {});
  const ref = db.collection("sheetSyncQueue").doc(input.queueId);
  const snap = await ref.get();

  if (!snap.exists || snap.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "書込エラーが見つかりません。");
  }

  await ref.set({
    status: "acknowledged",
    acknowledgedBy: session.uid,
    acknowledgedNote: input.note,
    acknowledgedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await db.collection("auditLogs").add({
    companyId,
    actorUid: session.uid,
    action: "sheet.issue.acknowledge",
    queueId: ref.id,
    note: input.note,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { acknowledged: true };
});

export const confirmApplication = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const input = JobSchema.parse(request.data ?? {});
  const ref = db.collection("jobs").doc(input.jobId);
  const job = await ref.get();

  if (!job.exists || job.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "案件が見つかりません。");
  }
  if (job.data()?.status !== "assigned") {
    throw new HttpsError(
      "failed-precondition",
      "手配済み案件だけ確認済みにできます。"
    );
  }

  await ref.set({
    applicationAdminConfirmed: true,
    applicationAdminConfirmedBy: session.uid,
    applicationAdminConfirmedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await db.collection("auditLogs").add({
    companyId,
    actorUid: session.uid,
    action: "application.confirm",
    jobId: input.jobId,
    createdAt: FieldValue.serverTimestamp(),
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
      workDate: jobData.workDate ?? jobData.dateKey ?? "",
      clientName: jobData.clientName ?? "",
      storeName: jobData.storeName ?? "",
      makerName: jobData.makerName ?? "",
      assignedStaffName: jobData.assignedStaffName ?? "",
      sheetUrl: buildSheetUrl(jobData),
    },
    currentValues,
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
  await ref.set({
    companyId,
    jobId: input.jobId,
    staffId: job.assignedStaffId ?? null,
    values: parsed.values,
    note: input.note,
    status: "draft",
    updatedBy: session.uid,
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { saved: true, status: "draft" };
});

export const completeExpenseReview = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const input = CompleteSchema.parse(request.data ?? {});
  const parsed = normalizeExpenseInput(input.values);

  if (parsed.errors.length) {
    throw new HttpsError("invalid-argument", parsed.errors.join(" / "));
  }

  const job = await requireCompanyJob(companyId, input.jobId);
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
    const existingReview = await tx.get(reviewRef);
    const revision = Number(existingReview.data()?.revision ?? 0) + 1;
    const expected = input.confirmExistingValues
      ? Object.fromEntries(Object.keys(currentValues).map((key) => [key, { mode: "any" }]))
      : buildExpenseExpected(currentValues);

    tx.set(queueRef, {
      companyId,
      jobId: input.jobId,
      operation: "expense.review",
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
    sheetUrl: buildSheetUrl(job),
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
    await reviewRef.set({
      status: status === "completed" ? "completed" : "error",
      sheetWriteStatus: status,
      sheetWriteError: queue.errorMessage ?? null,
      sheetRow: queue.resolvedRow ?? null,
      finalizedAt: status === "completed"
        ? FieldValue.serverTimestamp()
        : null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    if (status === "completed" && queue.jobId) {
      await db.collection("jobs").doc(String(queue.jobId)).set({
        expenses: queue.updates ?? {},
        expenseReviewStatus: "completed",
        expenseReviewedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }
);

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
