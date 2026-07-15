import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase";
import { applyQuietHours } from "./notification-time";

export type NotificationTarget =
  | { targetStaffId: string; targetRole?: never; targetUid?: never }
  | { targetRole: "admin"; targetStaffId?: never; targetUid?: never }
  | { targetUid: string; targetStaffId?: never; targetRole?: never };

export type QueueNotificationInput = NotificationTarget & {
  companyId: string;
  title: string;
  body: string;
  route?: string;
  category: string;
  dedupeKey: string;
  preferredAt?: Timestamp;
  bypassQuietHours?: boolean;
  data?: Record<string, string>;
};

export async function enqueueNotification(
  input: QueueNotificationInput
): Promise<{ queued: boolean; queueId: string }> {
  const preferred = input.preferredAt ?? Timestamp.now();
  const timing = input.bypassQuietHours
    ? { deliverAt: preferred, quietDeferred: false }
    : applyQuietHours(preferred);
  const targetKey = "targetStaffId" in input
    ? `staff:${input.targetStaffId}`
    : "targetRole" in input
      ? `role:${input.targetRole}`
      : `uid:${input.targetUid}`;
  const queueId = `nq_${hashText(
    `${input.companyId}|${targetKey}|${input.category}|${input.dedupeKey}`,
    36
  )}`;
  const ref = db.collection("notificationQueue").doc(queueId);

  const queued = await db.runTransaction(async (tx) => {
    const old = await tx.get(ref);
    if (old.exists) return false;
    tx.create(ref, {
      companyId: input.companyId,
      ...targetFields(input),
      title: input.title,
      body: input.body,
      route: input.route ?? "/",
      category: input.category,
      dedupeKey: input.dedupeKey,
      data: input.data ?? {},
      status: "queued",
      deliverAt: timing.deliverAt,
      quietDeferred: timing.quietDeferred,
      attempts: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });

  return { queued, queueId };
}

export function queueDocumentData(input: QueueNotificationInput) {
  const preferred = input.preferredAt ?? Timestamp.now();
  const timing = input.bypassQuietHours
    ? { deliverAt: preferred, quietDeferred: false }
    : applyQuietHours(preferred);
  return {
    companyId: input.companyId,
    ...targetFields(input),
    title: input.title,
    body: input.body,
    route: input.route ?? "/",
    category: input.category,
    dedupeKey: input.dedupeKey,
    data: input.data ?? {},
    status: "queued",
    deliverAt: timing.deliverAt,
    quietDeferred: timing.quietDeferred,
    attempts: 0,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };
}

function targetFields(input: QueueNotificationInput): Record<string, string> {
  if (typeof input.targetStaffId === "string") {
    return { targetStaffId: input.targetStaffId };
  }
  if (input.targetRole === "admin") {
    return { targetRole: input.targetRole };
  }
  if (typeof input.targetUid === "string") {
    return { targetUid: input.targetUid };
  }
  throw new Error("通知先が指定されていません。");
}

function hashText(value: string, length: number): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}
