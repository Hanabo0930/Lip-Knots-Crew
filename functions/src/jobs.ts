import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "./firebase";
import {
  companyFromClaims,
  dateKeyFromIso,
  requireAdmin,
  requireAuth,
  staffFromClaims,
} from "./utils";
import { queueDocumentData } from "./notification-core";
import { assertProductionOperational } from "./system-safety";

const ApplySchema = z.object({
  jobId: z.string().min(1),
  requestId: z.string().min(8).max(120),
});

export const applyToJob = onCall(async (request) => {
  const session = requireAuth(request);
  if (session.token.role !== "staff") {
    throw new HttpsError("permission-denied", "スタッフのみ応募できます。");
  }

  const input = ApplySchema.parse(request.data);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const staffId = staffFromClaims(session.token);

  const jobRef = db.collection("jobs").doc(input.jobId);
  const staffRef = db.collection("staffProfiles").doc(staffId);
  const idempotencyRef = db.collection("idempotencyKeys")
    .doc(`${session.uid}_${input.requestId}`);

  const result = await db.runTransaction(async (tx) => {
    const idempotencySnap = await tx.get(idempotencyRef);
    if (idempotencySnap.exists) {
      return idempotencySnap.data()?.result ?? { ok: true, duplicate: true };
    }

    const [jobSnap, staffSnap] = await Promise.all([
      tx.get(jobRef),
      tx.get(staffRef),
    ]);

    if (!jobSnap.exists || !staffSnap.exists) {
      throw new HttpsError("not-found", "案件またはスタッフ情報が見つかりません。");
    }

    const job = jobSnap.data() as Record<string, unknown>;
    const staff = staffSnap.data() as Record<string, unknown>;

    if (job.companyId !== companyId || staff.companyId !== companyId) {
      throw new HttpsError("permission-denied", "会社情報が一致しません。");
    }
    if (staff.active !== true) {
      throw new HttpsError("permission-denied", "利用停止中です。");
    }
    if (job.status !== "open" || job.assignedStaffId) {
      throw new HttpsError(
        "already-exists",
        "申し訳ありません。この案件は先に他のスタッフで確定しました。"
      );
    }
    if (job.recruitmentStopped === true || job.cancelled === true) {
      throw new HttpsError("failed-precondition", "この案件は募集を終了しています。");
    }

    const workDate = dateKeyFromIso(String(job.dateKey));
    const lockId = `${companyId}_${staffId}_${workDate}`;
    const lockRef = db.collection("staffDayLocks").doc(lockId);
    const lockSnap = await tx.get(lockRef);

    if (lockSnap.exists && lockSnap.data()?.active === true) {
      throw new HttpsError("failed-precondition", "この日はシフトが確定済みです。");
    }

    const displayName = String(staff.displayName ?? "");
    const now = Timestamp.now();

    tx.update(jobRef, {
      status: "assigned",
      assignedStaffId: staffId,
      assignedStaffName: displayName,
      assignedUid: session.uid,
      assignedAt: now,
      applicationUnconfirmed: true,
      updatedAt: now,
    });

    tx.set(lockRef, {
      companyId,
      staffId,
      dateKey: workDate,
      jobId: input.jobId,
      active: true,
      createdAt: now,
    });

    const queueRef = db.collection("sheetSyncQueue").doc();
    tx.set(queueRef, {
      companyId,
      jobId: input.jobId,
      operation: "job.assign",
      updates: { staffName: displayName },
      status: "pending",
      attempts: 0,
      idempotencyKey: `job.assign:${input.jobId}:${input.requestId}`,
      expected: { staffName: { mode: "blank" } },
      actorUid: session.uid,
      actorStaffId: staffId,
      createdAt: now,
    });

    const staffNotificationRef = db.collection("notificationQueue").doc();
    tx.set(staffNotificationRef, queueDocumentData({
      companyId,
      targetStaffId: staffId,
      title: "応募が確定しました",
      body: `${String(job.workDate ?? workDate)} ${String(job.storeName ?? "")}`,
      route: `/shifts/${input.jobId}`,
      category: "job_assigned",
      dedupeKey: `${input.jobId}_${staffId}_assigned`,
    }));

    const adminNotificationRef = db.collection("notificationQueue").doc();
    tx.set(adminNotificationRef, queueDocumentData({
      companyId,
      targetRole: "admin",
      title: "新しいアプリ応募があります",
      body: `${displayName} / ${String(job.storeName ?? "")}`,
      route: `/admin/jobs/${input.jobId}`,
      category: "job_application_admin",
      dedupeKey: `${input.jobId}_${staffId}_admin`,
    }));

    const response = { ok: true, jobId: input.jobId, assignedAt: now.toDate().toISOString() };
    tx.set(idempotencyRef, {
      uid: session.uid,
      companyId,
      result: response,
      expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
      createdAt: now,
    });

    return response;
  });

  return result;
});

const CancelSchema = z.object({
  jobId: z.string().min(1),
  reason: z.string().min(1).max(500),
});

export const adminCancelJob = onCall(async (request) => {
  const session = requireAdmin(request);
  const input = CancelSchema.parse(request.data);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const jobRef = db.collection("jobs").doc(input.jobId);

  await db.runTransaction(async (tx) => {
    const jobSnap = await tx.get(jobRef);
    if (!jobSnap.exists) {
      throw new HttpsError("not-found", "案件が見つかりません。");
    }
    const job = jobSnap.data() as Record<string, unknown>;
    if (job.companyId !== companyId) {
      throw new HttpsError("permission-denied", "会社情報が一致しません。");
    }

    const now = Timestamp.now();
    tx.update(jobRef, {
      status: "cancelled",
      cancelled: true,
      cancellationReason: input.reason,
      cancelledAt: now,
      updatedAt: now,
    });

    if (typeof job.assignedStaffId === "string" && job.assignedStaffId) {
      const lockId = `${companyId}_${job.assignedStaffId}_${job.dateKey}`;
      tx.set(db.collection("staffDayLocks").doc(lockId), {
        active: false,
        releasedAt: now,
        releaseReason: "job.cancelled",
      }, { merge: true });
    }

    tx.set(db.collection("sheetSyncQueue").doc(), {
      companyId,
      jobId: input.jobId,
      operation: "job.cancel",
      updates: {
        cancelled: true,
        cancellationReason: input.reason,
      },
      status: "pending",
      idempotencyKey: `job.cancel:${input.jobId}:${now.toMillis()}`,
      actorUid: session.uid,
      attempts: 0,
      createdAt: now,
    });

    if (typeof job.assignedStaffId === "string" && job.assignedStaffId) {
      tx.set(db.collection("notificationQueue").doc(), queueDocumentData({
        companyId,
        targetStaffId: job.assignedStaffId,
        title: "案件がキャンセルになりました",
        body: input.reason,
        route: `/shifts/${input.jobId}`,
        category: "job_cancelled",
        dedupeKey: `${input.jobId}_cancelled`,
      }));
    }
  });

  return { ok: true };
});
