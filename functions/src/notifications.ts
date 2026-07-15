import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, messaging } from "./firebase";
import { tokyoParts } from "./notification-time";
import { getProductionOperationalState } from "./system-safety";
import { incrementProductionMetrics } from "./production-metrics";

const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

type QueueData = {
  companyId: string;
  targetStaffId?: string;
  targetRole?: "admin";
  targetUid?: string;
  title: string;
  body: string;
  route?: string;
  category?: string;
  status?: string;
  deliverAt?: Timestamp;
  quietDeferred?: boolean;
  data?: Record<string, string>;
  attempts?: number;
};

type TokenRecord = {
  id: string;
  token: string;
};

/**
 * 即時通知は作成トリガーで処理します。未来時刻・静穏時間明けの通知は
 * 1分ごとのスケジューラーが処理します。
 */
export const processNotificationQueue = onDocumentCreated(
  "notificationQueue/{queueId}",
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data() as QueueData;
    if (data.status !== "queued") return;
    const deliverAt = data.deliverAt?.toMillis() ?? Date.now();
    if (deliverAt > Date.now() + 5_000) return;
    await dispatchQueueDocument(snap.ref);
  }
);

export const dispatchDueNotifications = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "Asia/Tokyo",
    timeoutSeconds: 300,
    memory: "1GiB",
    maxInstances: 1,
  },
  async () => {
    const now = Timestamp.now();
    const parts = tokyoParts(now.toDate());

    // 22:00〜7:00に保留した通知は、7:00に1件のまとめ通知へ束ねます。
    if (parts.hour === 7 && parts.minute < 5) {
      await bundleQuietNotifications(now);
    }

    const due = await db.collection("notificationQueue")
      .where("status", "==", "queued")
      .where("deliverAt", "<=", now)
      .orderBy("deliverAt", "asc")
      .limit(100)
      .get();

    for (const doc of due.docs) {
      await dispatchQueueDocument(doc.ref);
    }
  }
);

async function dispatchQueueDocument(
  ref: FirebaseFirestore.DocumentReference
): Promise<void> {
  const pending = await ref.get();
  if (!pending.exists) return;
  const pendingData = pending.data() as QueueData;
  const state = await getProductionOperationalState(pendingData.companyId);
  const emergencyControlNotice = pendingData.category === "production_global_kill_switch";
  if (!state.operational && !emergencyControlNotice) {
    await ref.set({
      status: "paused_global",
      pauseReason: state.reason,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return;
  }
  const leaseToken = db.collection("_ids").doc().id;
  const data = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = snap.data() as QueueData;
    if (current.status !== "queued") return null;
    if ((current.deliverAt?.toMillis() ?? 0) > Date.now() + 5_000) return null;

    tx.update(ref, {
      status: "sending",
      leaseToken,
      attempts: FieldValue.increment(1),
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return current;
  });

  if (!data) return;

  try {
    const tokens = await resolveTokens(data);
    if (!tokens.length) {
      await incrementProductionMetrics(data.companyId,{notificationAttempts:1,notificationFailures:1},"notification_no_tokens");
      await ref.set({
        status: "no_tokens",
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    let successCount = 0;
    let failureCount = 0;
    const invalidTokenIds: string[] = [];

    for (let index = 0; index < tokens.length; index += 500) {
      const chunk = tokens.slice(index, index + 500);
      const result = await messaging.sendEachForMulticast({
        tokens: chunk.map((item) => item.token),
        data: {
          title: data.title,
          body: data.body,
          route: data.route ?? "/",
          category: data.category ?? "general",
          ...stringData(data.data),
        },
        webpush: {
          headers: { Urgency: urgentForCategory(data.category) ? "high" : "normal" },
          fcmOptions: { link: data.route ?? "/" },
        },
      });

      successCount += result.successCount;
      failureCount += result.failureCount;
      result.responses.forEach((response, responseIndex) => {
        const code = response.error?.code ?? "";
        if (!response.success && INVALID_TOKEN_CODES.has(code)) {
          const item = chunk[responseIndex];
          if (item) invalidTokenIds.push(item.id);
        }
      });
    }

    if (invalidTokenIds.length) {
      const batch = db.batch();
      invalidTokenIds.forEach((tokenId) => {
        batch.set(db.collection("pushTokens").doc(tokenId), {
          active: false,
          invalidatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      await batch.commit();
    }

    await ref.set({
      status: failureCount > 0 ? "partial" : "completed",
      successCount,
      failureCount,
      invalidTokenCount: invalidTokenIds.length,
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await incrementProductionMetrics(data.companyId,{notificationAttempts:tokens.length,notificationFailures:failureCount},"notification_dispatch");
  } catch (error) {
    await incrementProductionMetrics(data.companyId,{notificationAttempts:1,notificationFailures:1},"notification_dispatch_error");
    const snap = await ref.get();
    const attempts = Number(snap.data()?.attempts ?? 1);
    const retry = attempts < 5;
    await ref.set({
      status: retry ? "queued" : "error",
      deliverAt: retry
        ? Timestamp.fromMillis(Date.now() + Math.min(30, 2 ** attempts) * 60_000)
        : snap.data()?.deliverAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      failedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (!retry) throw error;
  }
}

async function resolveTokens(data: QueueData): Promise<TokenRecord[]> {
  let query: FirebaseFirestore.Query = db.collection("pushTokens")
    .where("companyId", "==", data.companyId)
    .where("active", "==", true);

  if (data.targetStaffId) {
    query = query.where("staffId", "==", data.targetStaffId);
  } else if (data.targetRole) {
    query = query.where("role", "==", data.targetRole);
  } else if (data.targetUid) {
    query = query.where("uid", "==", data.targetUid);
  } else {
    return [];
  }

  const snap = await query.limit(1000).get();
  const unique = new Map<string, TokenRecord>();
  for (const doc of snap.docs) {
    const token = String(doc.data().token ?? "");
    if (token) unique.set(token, { id: doc.id, token });
  }
  return [...unique.values()];
}

async function bundleQuietNotifications(now: Timestamp): Promise<void> {
  const deferred = await db.collection("notificationQueue")
    .where("status", "==", "queued")
    .where("quietDeferred", "==", true)
    .where("deliverAt", "<=", now)
    .orderBy("deliverAt", "asc")
    .limit(300)
    .get();
  if (deferred.empty) return;

  const groups = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();
  for (const doc of deferred.docs) {
    const data = doc.data() as QueueData;
    const target = data.targetStaffId
      ? `staff:${data.targetStaffId}`
      : data.targetRole
        ? `role:${data.targetRole}`
        : data.targetUid
          ? `uid:${data.targetUid}`
          : "invalid";
    const key = `${data.companyId}|${target}`;
    const current = groups.get(key) ?? [];
    current.push(doc);
    groups.set(key, current);
  }

  for (const [key, docs] of groups.entries()) {
    if (docs.length <= 1) continue;
    const sample = docs[0]?.data() as QueueData | undefined;
    if (!sample) continue;
    const digestRef = db.collection("notificationQueue")
      .doc(`digest_${hashKey(`${key}|${tokyoParts(now.toDate()).dateKey}`)}`);

    await db.runTransaction(async (tx) => {
      const existing = await tx.get(digestRef);
      if (!existing.exists) {
        tx.create(digestRef, {
          companyId: sample.companyId,
          ...(sample.targetStaffId ? { targetStaffId: sample.targetStaffId } : {}),
          ...(sample.targetRole ? { targetRole: sample.targetRole } : {}),
          ...(sample.targetUid ? { targetUid: sample.targetUid } : {}),
          title: "未確認の通知があります",
          body: `${docs.length}件のお知らせ・対応事項があります。`,
          route: "/",
          category: "quiet_digest",
          dedupeKey: `${key}|${tokyoParts(now.toDate()).dateKey}`,
          status: "queued",
          deliverAt: now,
          quietDeferred: false,
          bundledQueueIds: docs.map((doc) => doc.id),
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        });
      }
      docs.forEach((doc) => tx.update(doc.ref, {
        status: "bundled",
        bundledInto: digestRef.id,
        completedAt: now,
        updatedAt: now,
      }));
    });
  }
}

function urgentForCategory(category?: string): boolean {
  return [
    "job_cancelled", "urgent_job", "submission_overdue",
    "precontact_late", "upload_error",
  ].includes(category ?? "");
}

function stringData(data?: Record<string, string>): Record<string, string> {
  if (!data) return {};
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, String(value)])
  );
}

function hashKey(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
