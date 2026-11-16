import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase";
import type { OperationalReminderContext } from "./operational-reminder";
import { applyQuietHours } from "./notification-time";
import { readStaffDeviceCredential, type StaffDeviceCredential } from "./staff-session";

// 定期生成と送信に同じ停止判定を適用し、設定誤りでも処理を進めない。
export function notificationDeliveryPaused(): boolean {
  const mode = process.env.LKC_NOTIFICATION_DELIVERY_MODE;
  if (mode !== undefined && mode !== "active") return true;
  return process.env.APP_ENVIRONMENT === "staging" && mode !== "active";
}

export type NotificationTarget =
  | { targetStaffId: string; targetRole?: never; targetUid?: never }
  | { targetRole: "admin"; targetStaffId?: never; targetUid?: never }
  | { targetUid: string; targetStaffId?: never; targetRole?: never };

export type StaffPushTestRequest = { staffId: string; authTime: number; deviceCredential?: StaffDeviceCredential };
export type PushTestRecipient = { uid: string; staff: StaffPushTestRequest | null };

export function isPushTest(category: unknown): boolean {
  return category === "push_test" || category === "push_test_admin";
}

export function readPushTestRecipient(record: {
  category?: unknown; targetUid?: unknown; targetStaffId?: unknown; targetRole?: unknown;
  data?: { requestedByUid?: unknown }; testRequest?: Partial<StaffPushTestRequest>;
}): PushTestRecipient | null {
  const uid = record.targetUid;
  if (!isPushTest(record.category) || typeof uid !== "string" || !uid.trim() || uid.includes("/") ||
      uid !== record.data?.requestedByUid || record.targetStaffId !== undefined || record.targetRole !== undefined) return null;
  if (record.category === "push_test_admin") return record.testRequest === undefined ? { uid, staff: null } : null;
  const staff = record.testRequest;
  if (typeof staff?.staffId !== "string" || !staff.staffId.trim() || staff.staffId.includes("/") ||
      typeof staff.authTime !== "number" || !Number.isSafeInteger(staff.authTime) || staff.authTime < 0 ||
      staff.authTime > 253402300799) return null;
  const deviceCredential = readStaffDeviceCredential(staff.deviceCredential);
  if (staff.deviceCredential !== undefined && !deviceCredential) return null;
  return { uid, staff: { staffId: staff.staffId, authTime: staff.authTime, ...(deviceCredential ? { deviceCredential } : {}) } };
}

export type QueueNotificationInput = NotificationTarget & {
  testRequest?: StaffPushTestRequest;
  companyId: string;
  title: string;
  body: string;
  route?: string;
  category: string;
  dedupeKey: string;
  reminderContext?: OperationalReminderContext;
  preferredAt?: Timestamp;
  bypassQuietHours?: boolean;
  data?: Record<string, string>;
};

export async function enqueueNotification(
  input: QueueNotificationInput
): Promise<{ queued: boolean; queueId: string }> {
  const preferred = input.preferredAt ?? Timestamp.now();
  const timing = input.bypassQuietHours === true
    ? { deliverAt: preferred, quietDeferred: false }
    : applyQuietHours(preferred);
  const queueId = notificationQueueId(input);
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
      ...(input.testRequest ? { testRequest: input.testRequest } : {}),
      ...(input.reminderContext ? { reminderContext: input.reminderContext } : {}),
      status: "queued",
      deliverAt: timing.deliverAt,
      quietDeferred: timing.quietDeferred,
      bypassQuietHours: input.bypassQuietHours === true,
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
  const timing = input.bypassQuietHours === true
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
    ...(input.testRequest ? { testRequest: input.testRequest } : {}),
      ...(input.reminderContext ? { reminderContext: input.reminderContext } : {}),
    status: "queued",
    deliverAt: timing.deliverAt,
    quietDeferred: timing.quietDeferred,
    bypassQuietHours: input.bypassQuietHours === true,
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

export function notificationQueueId(input: QueueNotificationInput): string {
  const targetKey = "targetStaffId" in input
    ? `staff:${input.targetStaffId}`
    : "targetRole" in input
      ? `role:${input.targetRole}`
      : `uid:${input.targetUid}`;
  return `nq_${hashText(
    `${input.companyId}|${targetKey}|${input.category}|${input.dedupeKey}`,
    36
  )}`;
}
