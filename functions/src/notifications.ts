import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, messaging } from "./firebase";
import { notificationDeliveryPaused } from "./notification-core";
import { applyQuietHours, tokyoParts } from "./notification-time";
import { getProductionOperationalState } from "./system-safety";
import { parseOperationalReminder, operationalReminderIsCurrent } from "./operational-reminder";
import { incrementProductionMetrics } from "./production-metrics";
import {
  classifyPushFailureCodes,
  isInvalidPushTokenCode,
} from "./push-delivery";

type QueueData = {
  companyId: string;
  targetStaffId?: string;
  targetRole?: "admin";
  targetUid?: string;
  title: string;
  body: string;
  route?: string;
  category?: string;
  reminderContext?: unknown;
  bundledQueueIds?: string[];
  bundledInto?: string;
  status?: string;
  deliverAt?: Timestamp;
  quietDeferred?: boolean;
  bypassQuietHours?: boolean;
  data?: Record<string, string>;
  attempts?: number;
  processedTokenHashes?: string[];
  successCount?: number;
  failureCount?: number;
  invalidTokenCount?: number;
  failureCodeCounts?: Record<string, number>;
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
    if (notificationDeliveryPaused()) return;
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
    if (notificationDeliveryPaused()) return;
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
  if (notificationDeliveryPaused()) return;
  const pending = await ref.get();
  if (!pending.exists) return;
  const pendingData = pending.data() as QueueData;
  const state = await getProductionOperationalState(pendingData.companyId);
  const leaseToken = db.collection("_ids").doc().id;
  const data = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = snap.data() as QueueData;
    if (current.status !== "queued") return null;
    // 古いイベントや別workerの完了を、運用停止の記録で巻き戻さないようにします。
    const emergencyControlNotice = current.category === "production_global_kill_switch";
    if (!state.operational && !emergencyControlNotice) {
      tx.update(ref, {
        status: "paused_global",
        pauseReason: state.reason,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return null;
    }

    if ((current.deliverAt?.toMillis() ?? 0) > Date.now() + 5_000) return null;

    // 作成時から配信までに22時をまたぐ場合も、通常通知を翌朝へ保留します。
    const timing = applyQuietHours(Timestamp.now());
    if (current.bypassQuietHours !== true && timing.quietDeferred) {
      tx.update(ref, {
        deliverAt: timing.deliverAt,
        quietDeferred: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return null;
    }

    const content = await currentReminderContent(current, ref.id, reference => tx.get(reference));
    if (!content) {
      tx.update(ref, { status: "superseded", supersededReason: "reminder_no_longer_current", completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return null;
    }
    tx.update(ref, {
      ...content,
      status: "sending",
      leaseToken,
      attempts: FieldValue.increment(1),
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ...current, ...content };
  });

  if (!data) return;

  try {
    const processed = new Set(data.processedTokenHashes ?? []);
    const tokens = (await resolveTokens(data))
      .filter((item) => !processed.has(pushTokenHash(item.token)));
    if (!tokens.length && !processed.size) {
      await incrementProductionMetrics(data.companyId,{notificationAttempts:1,notificationFailures:1},"notification_no_tokens");
      await updateLeasedQueue(ref, leaseToken, {
        status: "no_tokens",
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    let successCount = data.successCount ?? 0;
    let failureCount = data.failureCount ?? 0;
    let invalidTokenCount = data.invalidTokenCount ?? 0;
    const failureCodeCounts: Record<string, number> = { ...data.failureCodeCounts };

    for (let index = 0; index < tokens.length; index += 500) {
      const current = await ref.get();
      if (current.data()?.status !== "sending" || current.data()?.leaseToken !== leaseToken) return;
      // 一覧読込や前の送信応答を待つ間に22時をまたいだら、未処理端末を翌朝へ回します。
      const timing = applyQuietHours(Timestamp.now());
      if (data.bypassQuietHours !== true && timing.quietDeferred) {
        await updateLeasedQueue(ref, leaseToken, {
          status: "queued",
          deliverAt: timing.deliverAt,
          quietDeferred: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return;
      }
      // FCMとの間を一括取引にはできないため、各送信直前にも再確認する。
      const content = await currentReminderContent(data, ref.id, reference => reference.get());
      if (!content) {
        await updateLeasedQueue(ref, leaseToken, { status: "superseded", supersededReason: "reminder_no_longer_current", completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
        return;
      }
      const chunk = tokens.slice(index, index + 500);
      const result = await messaging.sendEachForMulticast({
        tokens: chunk.map((item) => item.token),
        data: {
          title: data.title,
          body: content.body ?? data.body,
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
      const invalidTokenIds: string[] = [];
      result.responses.forEach((response, responseIndex) => {
        const code = response.error?.code ?? "";
        if (!response.success) {
          const safeCode = code || "messaging/unknown-error";
          failureCodeCounts[safeCode] = (failureCodeCounts[safeCode] ?? 0) + 1;
        }
        if (!response.success && isInvalidPushTokenCode(code)) {
          const item = chunk[responseIndex];
          if (item) invalidTokenIds.push(item.id);
        }
      });
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
      invalidTokenCount += invalidTokenIds.length;
      chunk.forEach((item) => processed.add(pushTokenHash(item.token)));
      // 生のPushトークンはキューへ複製せず、応答確認済みの端末をハッシュで記録します。
      const saved = await updateLeasedQueue(ref, leaseToken, {
        ...content,
        processedTokenHashes: [...processed],
        successCount,
        failureCount,
        invalidTokenCount,
        failureCodeCounts,
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (!saved) return;
      await incrementProductionMetrics(data.companyId,{notificationAttempts:chunk.length,notificationFailures:result.failureCount},"notification_dispatch");
    }

    await updateLeasedQueue(ref, leaseToken, {
      status: failureCount > 0 ? "partial" : "completed",
      successCount,
      failureCount,
      invalidTokenCount,
      failureReason: classifyPushFailureCodes(Object.keys(failureCodeCounts)),
      failureCodeCounts,
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    await incrementProductionMetrics(data.companyId,{notificationAttempts:1,notificationFailures:1},"notification_dispatch_error");
    const snap = await ref.get();
    const attempts = Number(snap.data()?.attempts ?? 1);
    const retry = attempts < 5;
    const saved = await updateLeasedQueue(ref, leaseToken, {
      status: retry ? "queued" : "error",
      deliverAt: retry
        ? Timestamp.fromMillis(Date.now() + Math.min(30, 2 ** attempts) * 60_000)
        : snap.data()?.deliverAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      failedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (saved && !retry) throw error;
  }
}

async function currentReminderContent(
  data: QueueData, queueId: string,
  read: (ref: FirebaseFirestore.DocumentReference) => Promise<FirebaseFirestore.DocumentSnapshot>
): Promise<{ body?: string } | null> {
  if (data.category === "quiet_digest") {
    const ids = data.bundledQueueIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 300 || ids.some(id => typeof id !== "string" || !id || id.includes("/")) || new Set(ids).size !== ids.length) return null;
    let count = 0;
    for (const id of ids) {
      const child = (await read(db.collection("notificationQueue").doc(id))).data() as QueueData | undefined;
      if (!child || child.status !== "bundled" || child.bundledInto !== queueId || child.category === "quiet_digest" || notificationGroupKey(child) !== notificationGroupKey(data)) continue;
      if (await currentReminderContent(child, id, read)) count++;
    }
    return count ? { body: count + "件のお知らせ・対応事項があります。" } : null;
  }
  // 旧通知には当時の担当・版がない。推測で補完せず、旧キューの点検は再開前の運用条件とする。
  if (data.reminderContext === undefined) return {};
  const context = parseOperationalReminder(data.reminderContext);
  if (!context || (data.targetStaffId ? data.targetStaffId !== context.staffId : data.targetRole !== "admin") || data.targetUid) return null;
  const job = await read(db.collection("jobs").doc(context.jobId));
  const current = job.data();
  if (!operationalReminderIsCurrent(context, data.companyId, current)) return null;
  if (context.kind === "assignment-receipt") {
    const staff = data.targetStaffId === context.staffId && data.category === "job_assigned" && data.route === "/shifts/" + context.jobId;
    const admin = data.targetRole === "admin" && data.category === "job_application_admin" && data.route === "/admin/jobs/" + context.jobId;
    if (!staff && !admin) return null;
  }
  if (context.kind === "resubmission") {
    if (data.category !== "resubmission_request" || data.targetStaffId !== context.staffId || data.route !== "/resubmissions/" + context.requestId) return null;
    const request = (await read(db.collection("resubmissionRequests").doc(context.requestId!))).data();
    if (!request || request.companyId !== data.companyId || request.staffId !== context.staffId || request.jobId !== context.jobId || request.type !== context.requestType || request.status !== "open") return null;
  }
  if (context.kind === "netprint") {
    const items = current?.netPrint?.items as Array<{ number?: string; printed?: boolean }>;
    return { body: items.filter(item => item.number && item.printed !== true).length + "件の資料をできるだけ早く印刷してください。" };
  }
  return {};
}

async function updateLeasedQueue(
  ref: FirebaseFirestore.DocumentReference,
  leaseToken: string,
  values: Record<string, unknown>
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.status !== "sending" || snap.data()?.leaseToken !== leaseToken) {
      return false;
    }
    tx.update(ref, values);
    return true;
  });
}

function pushTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
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
    // 一部端末への配信済み通知は、まとめると既送端末へ再通知するため個別再開します。
    if (data.processedTokenHashes?.length) continue;
    const key = notificationGroupKey(data);
    const current = groups.get(key) ?? [];
    current.push(doc);
    groups.set(key, current);
  }

  for (const [key, docs] of groups.entries()) {
    if (docs.length <= 1) continue;
    await db.runTransaction(async (tx) => {
      // 一覧は古くなり得るため、配信状態・時刻・宛先を同じtransactionで再確認します。
      const latest = await Promise.all(docs.map((doc) => tx.get(doc.ref)));
      const eligible = latest.filter((doc) => {
        const current = doc.data() as QueueData | undefined;
        return doc.exists && current?.status === "queued"
          && current.quietDeferred === true
          && !current.processedTokenHashes?.length
          && (current.deliverAt?.toMillis() ?? Infinity) <= now.toMillis()
          && notificationGroupKey(current) === key;
      });
      if (eligible.length <= 1) return;
      const sample = eligible[0]!.data() as QueueData;
      const queueIds = eligible.map((doc) => doc.id).sort();
      // 同日でも後から到着した別の集合は、既存の送信済みまとめに吸収しません。
      const dedupeKey = JSON.stringify([key, tokyoParts(now.toDate()).dateKey, queueIds]);
      const digestId = createHash("sha256").update(dedupeKey, "utf8").digest("hex").slice(0, 36);
      const digestRef = db.collection("notificationQueue").doc("digest_" + digestId);
      const existing = await tx.get(digestRef);
      if (existing.exists) return;
      tx.create(digestRef, {
        companyId: sample.companyId,
        ...(sample.targetStaffId ? { targetStaffId: sample.targetStaffId } : {}),
        ...(sample.targetRole ? { targetRole: sample.targetRole } : {}),
        ...(sample.targetUid ? { targetUid: sample.targetUid } : {}),
        title: "未確認の通知があります",
        body: eligible.length + "件のお知らせ・対応事項があります。",
        route: "/",
        category: "quiet_digest",
        dedupeKey,
        status: "queued",
        deliverAt: now,
        quietDeferred: false,
        bundledQueueIds: queueIds,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
      eligible.forEach((doc) => tx.update(doc.ref, {
        status: "bundled",
        bundledInto: digestRef.id,
        completedAt: now,
        updatedAt: now,
      }));
    });
  }
}

function notificationGroupKey(data: QueueData): string {
  return JSON.stringify([
    data.companyId, data.targetStaffId ?? null,
    data.targetRole ?? null, data.targetUid ?? null,
  ]);
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
