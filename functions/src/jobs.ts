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
import { tokyoParts } from "./notification-time";
import { cancellationSheetWriteIdentity } from "./sheet-write-core";
import { mailPreparationContext, applicationConfirmationIdentity, assignmentPreparationPatch, nextAssignmentRevision, resetApplicationConfirmation } from "./assignment-preparation-core";
import { assertProductionOperational } from "./system-safety";
import { readMailApplicationForAssignment } from "./automation-intake";
import { readMailPublication } from "./case-mail-publication";

const ApplySchema = z.object({
  jobId: z.string().min(1),
  requestId: z.string().min(8).max(120),
  expectedJobRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  mailApplicationId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  mailApplicationRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).refine(value => (value.mailApplicationId === undefined) === (value.mailApplicationRevision === undefined), {
  message: "メール応募の確認版が必要です。",
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

  const queueRef = db.collection("sheetSyncQueue").doc();
  const result = await db.runTransaction(async (tx) => {
    const idempotencySnap = await tx.get(idempotencyRef);
    if (idempotencySnap.exists) {
      const previous = idempotencySnap.data();
      if (previous?.uid !== session.uid || previous?.companyId !== companyId) {
        throw new HttpsError("permission-denied", "応募記録の所属情報が一致しません。");
      }
      if (previous.staffId !== staffId) {
        throw new HttpsError("failed-precondition", "前回の応募者を確認できません。「シフト」で確定状況を確認してください。");
      }
      if ((previous.mailApplicationId ?? null) !== (input.mailApplicationId ?? null)) {
        throw new HttpsError("failed-precondition", "前回と異なる応募候補です。確定状況を確認してください。");
      }
      if ((previous.expectedJobRevision ?? null) !== (input.expectedJobRevision ?? null) ||
          (previous.mailApplicationRevision !== undefined && previous.mailApplicationRevision !== (input.mailApplicationRevision ?? null))) {
        throw new HttpsError("failed-precondition", "前回と異なる確認版です。「シフト」で確定状況を確認してください。");
      }
      const response = previous.result;
      if (response?.ok !== true || response.jobId !== input.jobId ||
          typeof response.assignedAt !== "string" || !Number.isFinite(Date.parse(response.assignedAt))) {
        throw new HttpsError("failed-precondition", "前回の応募結果を確認できません。「シフト」で確定状況を確認してください。");
      }
      return { ok: true, jobId: input.jobId, assignedAt: response.assignedAt };
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
    if (job.recruitmentStopped === true || job.cancelled === true || job.mailIntakeReviewRequired === true || job.mailTargetHold != null) {
      throw new HttpsError("failed-precondition", "この案件は募集を終了しています。");
    }

    if (job.sourceMissing === true || job.assignmentUnresolved === true || job.applicationUnconfirmed === true || job.publishable !== true) {
      throw new HttpsError("failed-precondition", "募集内容の公開・取込・手配確認が完了していません。シフトを更新してください。");
    }
    if (job.mailIntake) {
      const checked = await readMailPublication(tx, input.jobId, job, input.expectedJobRevision, new Date(), "apply");
      const confirmed = job.mailPublication as Record<string, unknown> | undefined;
      if (checked.issue || !checked.confirmation || !confirmed ||
          confirmed.context !== checked.confirmation.context ||
          confirmed.receiptRevision !== checked.confirmation.receiptRevision ||
          confirmed.candidateRevision !== checked.confirmation.candidateRevision) {
        throw new HttpsError("failed-precondition", checked.issue || "募集内容が更新されました。一覧を更新して確認してください。",
          { reason: "case_mail_job_changed", accepted: false, jobId: input.jobId, requestId: input.requestId, expectedJobRevision: input.expectedJobRevision ?? null });
      }
    }
    const workDate = dateKeyFromIso(String(job.dateKey));
    if (workDate < tokyoParts(new Date()).dateKey) {
      throw new HttpsError("failed-precondition", "この案件は実施日を過ぎているため応募できません。");
    }
    const lockId = `${companyId}_${staffId}_${workDate}`;
    const lockRef = db.collection("staffDayLocks").doc(lockId);
    const lockSnap = await tx.get(lockRef);

    if (lockSnap.exists && lockSnap.data()?.active === true) {
      throw new HttpsError("failed-precondition", "この日はシフトが確定済みです。");
    }

    if (typeof staff.displayName !== "string" || !staff.displayName.trim()) {
      throw new HttpsError("failed-precondition", "スタッフ氏名を確認できません。管理者へ確認してください。");
    }
    const mailApplicationRef = input.mailApplicationId
      ? await readMailApplicationForAssignment(tx, {
        companyId, staffId, jobId: input.jobId, applicationId: input.mailApplicationId,
        revision: input.mailApplicationRevision!,
      }) : null;
    const displayName = staff.displayName;
    const now = Timestamp.now();

    tx.update(jobRef, {
      revision: nextAssignmentRevision(job),
      status: "assigned",
      assignedStaffId: staffId,
      assignedStaffName: displayName,
      assignedUid: session.uid,
      assignedAt: now,
      ...assignmentPreparationPatch(job, { ...job, assignedStaffId: staffId, assignedStaffName: displayName }),
      assignmentSheetWrite: { queueId: queueRef.id, identity: cancellationSheetWriteIdentity({ ...job, assignedStaffId: staffId, assignedStaffName: displayName }),
        ...(job.mailIntake ? { confirmation: applicationConfirmationIdentity({ ...job, status: "assigned", assignedStaffId: staffId, assignedStaffName: displayName }) } : {}) },
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

    tx.set(queueRef, {
      companyId,
      jobId: input.jobId,
      operation: "job.assign",
      dateKey: workDate,
      updates: { staffName: displayName },
      status: "pending",
      attempts: 0,
      idempotencyKey: `job.assign:${input.jobId}:${queueRef.id}`,
      expected: { staffName: { mode: "blank" } },
      actorUid: session.uid,
      actorStaffId: staffId,
      createdAt: now,
    });

    const receiptContext = job.mailIntake ? { version: 1 as const, kind: "assignment-receipt" as const,
      jobId: input.jobId, staffId, dateKey: workDate, revision: nextAssignmentRevision(job),
      assignmentOperationId: queueRef.id, assignedAtMs: now.toMillis(), assignmentContext: mailPreparationContext({ ...job, status: "assigned", assignedStaffId: staffId, assignedStaffName: displayName }) } : undefined;
    const staffNotificationRef = db.collection("notificationQueue").doc();
    tx.set(staffNotificationRef, queueDocumentData({
      companyId,
      targetStaffId: staffId,
      title: "応募を受け付けました",
      body: `${String(job.workDate ?? workDate)} ${String(job.storeName ?? "")} / シフトで担当の確認状況を確認してください。`,
      route: `/shifts/${input.jobId}`,
      category: "job_assigned",
      ...(receiptContext ? {reminderContext:receiptContext} : {}),
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
      ...(receiptContext ? {reminderContext:receiptContext} : {}),
      dedupeKey: `${input.jobId}_${staffId}_admin`,
    }));

    const response = { ok: true, jobId: input.jobId, assignedAt: now.toDate().toISOString() };
    if (mailApplicationRef) tx.update(mailApplicationRef, {
      status: "assigned", assignedAt: now, assignedUid: session.uid, updatedAt: now,
      assignmentRequestId: input.requestId, sheetQueueId: queueRef.id,
    });
    tx.set(idempotencyRef, {
      expectedJobRevision: input.expectedJobRevision ?? null,
      mailApplicationRevision: input.mailApplicationRevision ?? null,
      mailApplicationId: input.mailApplicationId ?? null,
      uid: session.uid,
      companyId,
      staffId,
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
  const queueRef = db.collection("sheetSyncQueue").doc();

  await db.runTransaction(async (tx) => {
    const jobSnap = await tx.get(jobRef);
    if (!jobSnap.exists) {
      throw new HttpsError("not-found", "案件が見つかりません。");
    }
    const job = jobSnap.data() as Record<string, unknown>;
    if (job.companyId !== companyId) {
      throw new HttpsError("permission-denied", "会社情報が一致しません。");
    }

    // 取消対象の枠だけを解除する。別案件への再応募後の再取消でも、その勤務枠を保持する。
    const lockRef = typeof job.assignedStaffId === "string" && job.assignedStaffId
      ? db.collection("staffDayLocks").doc(`${companyId}_${job.assignedStaffId}_${job.dateKey}`)
      : null;
    const lockSnap = lockRef ? await tx.get(lockRef) : null;
    const lock = lockSnap?.data();
    const ownsActiveLock = lock?.active === true &&
      lock.jobId === input.jobId &&
      lock.companyId === companyId &&
      lock.staffId === job.assignedStaffId &&
      lock.dateKey === job.dateKey;

    if (job.cancelled === true && job.status === "cancelled" && job.cancellationReason === input.reason && !ownsActiveLock) return;
    const now = Timestamp.now();
    tx.update(jobRef, {
      ...resetApplicationConfirmation(),
      revision: nextAssignmentRevision(job),
      status: "cancelled",
      cancelled: true,
      assignmentSheetWrite: null,
      cancellationReason: input.reason,
      publishable: false,
      appOverride: { type: "cancel", active: true, createdAt: now },
      cancellationSheetWrite: { queueId: queueRef.id, operation: "job.cancel", identity: cancellationSheetWriteIdentity(job) },
      cancelledAt: now,
      updatedAt: now,
    });

    if (lockRef && ownsActiveLock) {
      tx.set(lockRef, {
        active: false,
        releasedAt: now,
        releaseReason: "job.cancelled",
      }, { merge: true });
    }

    tx.set(queueRef, {
      companyId,
      jobId: input.jobId,
      operation: "job.cancel",
      updates: {
        cancelled: true,
        cancellationReason: input.reason,
      },
      status: "pending",
      idempotencyKey: `job.cancel:${input.jobId}:${queueRef.id}`,
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
