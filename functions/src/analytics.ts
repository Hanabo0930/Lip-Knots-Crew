import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { queueDocumentData } from "./notification-core";
import {
  buildMonthlyDashboard,
  buildStaffPerformance,
  cancellationReasonLabels,
  cancellationTreatmentLabels,
  CancellationFinancialTreatment,
  CancellationReasonCategory,
} from "./analytics-core";
import { companyFromClaims, requireAdmin } from "./utils";
import { assertProductionOperational } from "./system-safety";

const MonthSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});

const StaffPerformanceSchema = z.object({
  staffId: z.string().min(1),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const CancellationSchema = z.object({
  jobId: z.string().min(1),
  reasonCategory: z.enum([
    "maker",
    "client",
    "already_staffed",
    "store",
    "weather",
    "other",
  ]),
  reasonNote: z.string().max(1000).default(""),
  financialTreatment: z.enum([
    "invoice_and_pay",
    "invoice_only",
    "pay_only",
    "neither",
  ]),
});

const RestoreSchema = z.object({
  jobId: z.string().min(1),
  note: z.string().max(1000).default(""),
});

export const getOperationsDashboard = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = MonthSchema.parse(request.data ?? {});
  const from = `${input.month}-01`;
  const through = nextMonthDateKey(input.month);

  const snapshot = await db.collection("jobs")
    .where("companyId", "==", companyId)
    .where("dateKey", ">=", from)
    .where("dateKey", "<", through)
    .limit(15000)
    .get();

  const jobs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  return buildMonthlyDashboard(jobs, input.month, tokyoToday());
});

export const getStaffPerformance = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = StaffPerformanceSchema.parse(request.data ?? {});
  if (input.from > input.through) {
    throw new HttpsError("invalid-argument", "期間の開始日と終了日を確認してください。");
  }

  const profile = await db.collection("staffProfiles").doc(input.staffId).get();
  if (!profile.exists || profile.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "スタッフが見つかりません。");
  }

  const snapshot = await db.collection("jobs")
    .where("companyId", "==", companyId)
    .where("assignedStaffId", "==", input.staffId)
    .where("dateKey", ">=", input.from)
    .where("dateKey", "<=", input.through)
    .limit(10000)
    .get();

  const jobs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  return {
    profile: {
      id: profile.id,
      displayName: profile.data()?.displayName ?? "",
      rank: profile.data()?.rank ?? "A",
      areaLabels: profile.data()?.areaLabels ?? [],
      nearestStation: profile.data()?.nearestStation ?? "",
    },
    performance: buildStaffPerformance(
      jobs,
      input.staffId,
      input.from,
      input.through,
      tokyoToday()
    ),
  };
});

export const adminSetJobCancellation = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const input = CancellationSchema.parse(request.data ?? {});
  const jobRef = db.collection("jobs").doc(input.jobId);

  await db.runTransaction(async (tx) => {
    const jobSnap = await tx.get(jobRef);
    if (!jobSnap.exists || jobSnap.data()?.companyId !== companyId) {
      throw new HttpsError("not-found", "案件が見つかりません。");
    }

    const job = jobSnap.data() as Record<string, unknown>;
    const now = Timestamp.now();
    const reasonCategory = input.reasonCategory as CancellationReasonCategory;
    const treatment = input.financialTreatment as CancellationFinancialTreatment;
    const reasonLabel = cancellationReasonLabels[reasonCategory];
    const reason = input.reasonNote.trim()
      ? `${reasonLabel}：${input.reasonNote.trim()}`
      : reasonLabel;

    tx.set(jobRef, {
      status: "cancelled",
      cancelled: true,
      cancellationReasonCategory: reasonCategory,
      cancellationReason: reason,
      cancellationReasonNote: input.reasonNote.trim(),
      cancellationFinancialTreatment: treatment,
      cancellationFinancialTreatmentLabel: cancellationTreatmentLabels[treatment],
      cancelledAt: now,
      cancelledBy: session.uid,
      preCancellationStatus: job.status ?? "assigned",
      appOverride: { type: "cancel", active: true, createdAt: now },
      updatedAt: now,
    }, { merge: true });

    if (typeof job.assignedStaffId === "string" && job.assignedStaffId) {
      const lockId = `${companyId}_${job.assignedStaffId}_${job.dateKey}`;
      tx.set(db.collection("staffDayLocks").doc(lockId), {
        active: false,
        releasedAt: now,
        releaseReason: "job.cancelled",
        jobId: input.jobId,
      }, { merge: true });

      tx.set(db.collection("notificationQueue").doc(), queueDocumentData({
        companyId,
        targetStaffId: job.assignedStaffId,
        title: "案件がキャンセルになりました",
        body: reason,
        route: `/shifts/${input.jobId}`,
        category: "job_cancelled",
        dedupeKey: `${input.jobId}_cancelled_${now.toMillis()}`,
      }));
    }

    tx.set(db.collection("sheetSyncQueue").doc(), {
      companyId,
      jobId: input.jobId,
      operation: "job.cancel.v2",
      updates: {
        cancelled: true,
        cancellationReason: reason,
        cancellationReasonCategory: reasonLabel,
        cancellationFinancialTreatment: cancellationTreatmentLabels[treatment],
      },
      expected: {},
      status: "pending",
      attempts: 0,
      idempotencyKey: `job.cancel.v2:${input.jobId}:${now.toMillis()}`,
      actorUid: session.uid,
      createdAt: now,
      updatedAt: now,
    });

    tx.set(db.collection("auditLogs").doc(), {
      companyId,
      actorUid: session.uid,
      action: "job.cancel.manage",
      jobId: input.jobId,
      reasonCategory,
      reason,
      financialTreatment: treatment,
      createdAt: now,
    });
  });

  return { ok: true };
});

export const adminRestoreCancelledJob = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const input = RestoreSchema.parse(request.data ?? {});
  const jobRef = db.collection("jobs").doc(input.jobId);

  await db.runTransaction(async (tx) => {
    const jobSnap = await tx.get(jobRef);
    if (!jobSnap.exists || jobSnap.data()?.companyId !== companyId) {
      throw new HttpsError("not-found", "案件が見つかりません。");
    }
    const job = jobSnap.data() as Record<string, unknown>;
    if (job.cancelled !== true && job.status !== "cancelled") {
      throw new HttpsError("failed-precondition", "この案件はキャンセル状態ではありません。");
    }

    const assignedStaffId = typeof job.assignedStaffId === "string"
      ? job.assignedStaffId
      : "";
    const assignedStaffName = typeof job.assignedStaffName === "string"
      ? job.assignedStaffName
      : "";
    const dateKey = String(job.dateKey ?? "");
    const now = Timestamp.now();
    let restoredStatus = "open";

    if (assignedStaffId && dateKey) {
      const lockId = `${companyId}_${assignedStaffId}_${dateKey}`;
      const lockRef = db.collection("staffDayLocks").doc(lockId);
      const lockSnap = await tx.get(lockRef);
      if (
        lockSnap.exists &&
        lockSnap.data()?.active === true &&
        lockSnap.data()?.jobId !== input.jobId
      ) {
        throw new HttpsError(
          "failed-precondition",
          "このスタッフは同日に別の有効なシフトがあります。復帰前に確認してください。"
        );
      }
      tx.set(lockRef, {
        companyId,
        staffId: assignedStaffId,
        dateKey,
        jobId: input.jobId,
        active: true,
        restoredAt: now,
        source: "job.restore",
      }, { merge: true });
      restoredStatus = "assigned";
    }

    tx.set(jobRef, {
      status: restoredStatus,
      cancelled: false,
      recruitmentStopped: false,
      cancellationReasonCategory: FieldValue.delete(),
      cancellationReason: FieldValue.delete(),
      cancellationReasonNote: FieldValue.delete(),
      cancellationFinancialTreatment: FieldValue.delete(),
      cancellationFinancialTreatmentLabel: FieldValue.delete(),
      cancelledAt: FieldValue.delete(),
      cancelledBy: FieldValue.delete(),
      restoredAt: now,
      restoredBy: session.uid,
      restoreNote: input.note.trim() || FieldValue.delete(),
      publishable: restoredStatus === "open",
      appOverride: { type: "restore", active: true, createdAt: now },
      updatedAt: now,
    }, { merge: true });

    tx.set(db.collection("sheetSyncQueue").doc(), {
      companyId,
      jobId: input.jobId,
      operation: "job.restore",
      updates: {
        cancelled: false,
        cancellationReason: "",
        cancellationReasonCategory: "",
        cancellationFinancialTreatment: "",
      },
      expected: {},
      status: "pending",
      attempts: 0,
      idempotencyKey: `job.restore:${input.jobId}:${now.toMillis()}`,
      actorUid: session.uid,
      createdAt: now,
      updatedAt: now,
    });

    if (assignedStaffId) {
      tx.set(db.collection("notificationQueue").doc(), queueDocumentData({
        companyId,
        targetStaffId: assignedStaffId,
        title: "キャンセルが解除されました",
        body: `${String(job.workDate ?? dateKey)} ${String(job.storeName ?? "")} / ${assignedStaffName}`,
        route: `/shifts/${input.jobId}`,
        category: "job_restored",
        dedupeKey: `${input.jobId}_restored_${now.toMillis()}`,
      }));
    }

    tx.set(db.collection("auditLogs").doc(), {
      companyId,
      actorUid: session.uid,
      action: "job.cancel.restore",
      jobId: input.jobId,
      restoredStatus,
      note: input.note.trim(),
      createdAt: now,
    });
  });

  return { ok: true };
});

function nextMonthDateKey(month: string): string {
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const value = Number(monthText);
  if (value === 12) return `${year + 1}-01-01`;
  return `${year}-${String(value + 1).padStart(2, "0")}-01`;
}

function tokyoToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
