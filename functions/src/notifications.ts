import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, messaging } from "./firebase";
import { isPushTest, notificationDeliveryPaused, readPushTestRecipient, type PushTestRecipient, type StaffPushTestRequest } from "./notification-core";
import { readActiveStaffProfile, readStaffDeviceCredential } from "./staff-session";
import { assertDeviceAuthentication } from "./device-authentication";
import { applyQuietHours, submissionDeadline, tokyoParts } from "./notification-time";
import { getProductionOperationalState, type ProductionOperationalState } from "./system-safety";
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
  testRequest?: StaffPushTestRequest;
  attempts?: number;
  leaseToken?: string | null;
  startedAt?: Timestamp;
  dispatchProtocol?: string;
  processedTokenHashes?: string[];
  successCount?: number;
  failureCount?: number;
  invalidTokenCount?: number;
  failureCodeCounts?: Record<string, number>;
  dispatchIntent?: { operationId: string; tokenHashes: string[]; preparedAt: Timestamp } | null;
  deliveryVerificationRequired?: boolean;
};

const DISPATCH_CONTENT_FIELDS = ["category", "title", "body", "route", "data", "reminderContext",
  "bundledQueueIds", "deliverAt", "bypassQuietHours"] as const;

const TOKEN_BINDING_FIELDS = ["token", "companyId", "staffId", "uid", "role", "deviceSessionId",
  "crewDeviceSession", "crewDeviceGeneration", "registeredAuthTime"] as const;
type TokenRecord = {
  id: string;
  token: string;
  binding: FirebaseFirestore.DocumentData;
};

const REMINDERS_WITH_REQUIRED_CONTEXT = new Set([
  "precontact_reminder", "precontact_late", "submission_reminder", "submission_overdue",
  "netprint_unprinted", "netprint_updated", "resubmission_request",
]);

const MAX_QUIET_DIGEST_MEMBERS = 1000;
const DISPATCH_LEASE_MS = 10 * 60_000;
const DISPATCH_PROTOCOL = "checkpoint_v1";
const MAX_DISPATCH_ATTEMPTS = 5;

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
    try {
      await recoverInterruptedNotifications(now);
    } catch (error) {
      console.error("Interrupted notification recovery scan failed", { error });
    }

    const query = db.collection("notificationQueue")
      .where("status", "==", "queued")
      .where("deliverAt", "<=", now)
      .orderBy("deliverAt", "asc")
      .limit(100);

    let due = await query.get();
    // Morning recovery also works after the first five minutes if the earlier run was interrupted.
    if (parts.hour >= 7 && parts.hour < 22 &&
        ((parts.hour === 7 && parts.minute < 5) || due.docs.some(doc => isQuietDigestMember(doc.data() as QueueData)))) {
      try {
        await bundleQuietNotifications(now);
        due = await query.get();
      } catch (error) {
        console.error("Quiet notification scan failed", { error });
      }
    }
    for (const doc of due.docs) {
      if (isQuietDigestMember(doc.data() as QueueData)) continue;
      try {
        await dispatchQueueDocument(doc.ref);
      } catch (error) {
        console.error("Scheduled notification dispatch failed", { queueId: doc.id, error });
      }
    }
  }
);

function dispatchLeaseExpiresAt(data: QueueData): number | null {
  return data.startedAt instanceof Timestamp ? data.startedAt.toMillis() + DISPATCH_LEASE_MS : null;
}

async function recoverInterruptedNotifications(now: Timestamp): Promise<void> {
  const cutoff = Timestamp.fromMillis(now.toMillis() - DISPATCH_LEASE_MS);
  const stale = await db.collection("notificationQueue")
    .where("status", "==", "sending")
    .where("startedAt", "<=", cutoff)
    .orderBy("startedAt", "asc")
    .limit(100)
    .get();

  for (const doc of stale.docs) {
    const observed = doc.data() as QueueData;
    try {
      await db.runTransaction(async tx => {
        const current = (await tx.get(doc.ref)).data() as QueueData | undefined;
        if (current?.status !== "sending" || current.leaseToken !== observed.leaseToken ||
            !(observed.startedAt instanceof Timestamp) || !(current.startedAt instanceof Timestamp) ||
            !current.startedAt.isEqual(observed.startedAt) || current.startedAt.toMillis() > cutoff.toMillis()) return;
        // Previous worker versions may send without saving a dispatch intent.
        const attempts = current.attempts;
        if (current.dispatchProtocol !== DISPATCH_PROTOCOL || !current.leaseToken ||
            typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 1 || needsDeliveryVerification(current)) {
          tx.update(doc.ref, deliveryVerificationHold());
          return;
        }
        if (attempts >= MAX_DISPATCH_ATTEMPTS) {
          tx.update(doc.ref, {
            status: "error",
            errorMessage: "送信前の処理が繰り返し中断されたため、再試行を停止しました。",
            failedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          return;
        }
        const deliverAt = current.deliverAt instanceof Timestamp && current.deliverAt.toMillis() > now.toMillis() ? current.deliverAt : now;
        tx.update(doc.ref, {
          status: "queued", leaseToken: null, deliverAt, updatedAt: FieldValue.serverTimestamp(),
        });
      });
    } catch (error) {
      console.error("Interrupted notification recovery failed", { queueId: doc.id, error });
    }
  }
}

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
    if (current.status !== "queued" || current.companyId !== pendingData.companyId) return null;
    if (needsDeliveryVerification(current)) {
      tx.update(ref, deliveryVerificationHold());
      return null;
    }
    // A delayed creation event cannot claim a member before its digest is prepared.
    if (isQuietDigestMember(current)) return null;
    // 古いイベントや別workerの完了を、運用停止の記録で巻き戻さないようにします。
    const emergencyControlNotice = current.category === "production_global_kill_switch";
    if (!state.operational && !emergencyControlNotice) {
      tx.update(ref, notificationPause(state.reason));
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

    const content = await currentReminderContent(current, ref.id, tx);
    if (!content) {
      tx.update(ref, { status: "superseded", supersededReason: "reminder_no_longer_current", completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return null;
    }
    tx.update(ref, {
      ...content,
      status: "sending",
      leaseToken,
      dispatchProtocol: DISPATCH_PROTOCOL,
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

    let successCount = data.successCount ?? 0;
    let failureCount = data.failureCount ?? 0;
    let invalidTokenCount = data.invalidTokenCount ?? 0;
    const failureCodeCounts: Record<string, number> = { ...data.failureCodeCounts };

    for (let index = 0; index < tokens.length; index += 500) {
      const chunk = tokens.slice(index, index + 500);
      const prepared = await prepareNotificationChunk(ref, leaseToken, data, state, chunk);
      if (!prepared) return;
      if (prepared.kind === "skipped") continue;
      const { notification, expiresAt, emergencyControlNotice } = prepared;
      if (Date.now() >= expiresAt) return;
      const dispatch = await checkDispatchReadiness(
        ref, leaseToken, prepared.operationId, notification, state, emergencyControlNotice, prepared.recipients,
      );
      if (!dispatch || Date.now() >= expiresAt) return;
      if (dispatch.kind === "skipped") continue;
      const { content, operationId, recipients } = dispatch;
      // 最後のDB処理を待つ間に22時を過ぎた場合、この端末分の送信は未着手として繰り越す。
      const timing = applyQuietHours(Timestamp.now());
      if (notification.bypassQuietHours !== true && timing.quietDeferred) {
        await updateLeasedQueue(ref, leaseToken, {
          status: "queued",
          dispatchIntent: null,
          deliverAt: timing.deliverAt,
          quietDeferred: true,
          updatedAt: FieldValue.serverTimestamp(),
        }, operationId);
        return;
      }
      const sendAt = Date.now();
      if (content.validUntilMs !== undefined && sendAt >= content.validUntilMs) {
        await updateLeasedQueue(ref, leaseToken, {
          status: "superseded",
          supersededReason: "reminder_no_longer_current",
          dispatchIntent: null,
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, operationId);
        return;
      }
      const result = await messaging.sendEachForMulticast({
        tokens: recipients.map((item) => item.token),
        data: {
          ...(isPushTest(notification.category) ? {} : stringData(notification.data)),
          title: notification.title,
          body: content.body ?? notification.body,
          route: notification.route ?? "/",
          category: notification.category ?? "general",
          crewAudienceCompanyId: notification.companyId,
          crewAudienceStaffId: notification.targetStaffId ?? "",
          crewAudienceUid: notification.targetUid ?? "",
        },
        webpush: {
          headers: {
            Urgency: urgentForCategory(notification.category) ? "high" : "normal",
            ...(content.validUntilMs !== undefined ? { TTL: String(Math.floor((content.validUntilMs - sendAt) / 1000)) } : {}),
          },
          fcmOptions: { link: notification.route ?? "/" },
        },
      });
      if (result.responses.length !== recipients.length || result.responses.filter(response => response.success).length !== result.successCount ||
          result.successCount + result.failureCount !== recipients.length) {
        throw new Error("通知サービスから全端末分の応答を確認できませんでした。");
      }

      successCount += result.successCount;
      failureCount += result.failureCount;
      const invalidTokens: TokenRecord[] = [];
      result.responses.forEach((response, responseIndex) => {
        const code = response.error?.code ?? "";
        if (!response.success) {
          const safeCode = code || "messaging/unknown-error";
          failureCodeCounts[safeCode] = (failureCodeCounts[safeCode] ?? 0) + 1;
        }
        if (!response.success && isInvalidPushTokenCode(code)) {
          const item = recipients[responseIndex];
          if (item) invalidTokens.push(item);
        }
      });
      invalidTokenCount += await invalidateCurrentPushTokens(ref, leaseToken, operationId, invalidTokens);
      recipients.forEach((item) => processed.add(pushTokenHash(item.token)));
      // 生のPushトークンはキューへ複製せず、応答確認済みの端末をハッシュで記録します。
      const saved = await updateLeasedQueue(ref, leaseToken, {
        ...content,
        dispatchIntent: null,
        lastDispatchOperationId: operationId,
        processedTokenHashes: [...processed],
        successCount,
        failureCount,
        invalidTokenCount,
        failureCodeCounts,
        updatedAt: FieldValue.serverTimestamp(),
      }, operationId);
      if (!saved) return;
      await incrementProductionMetrics(data.companyId,{notificationAttempts:recipients.length,notificationFailures:result.failureCount},"notification_dispatch");
    }


    if (!processed.size) {
      await incrementProductionMetrics(data.companyId,{notificationAttempts:1,notificationFailures:1},"notification_no_tokens");
      await updateLeasedQueue(ref, leaseToken, {
        status: "no_tokens",
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
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
    if (needsDeliveryVerification(snap.data() as QueueData | undefined)) {
      await updateLeasedQueue(ref, leaseToken, deliveryVerificationHold());
      return;
    }
    const attempts = Number(snap.data()?.attempts ?? 1);
    const retry = attempts < MAX_DISPATCH_ATTEMPTS;
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

function needsDeliveryVerification(data: QueueData | undefined): boolean {
  return data?.deliveryVerificationRequired === true || data?.dispatchIntent != null;
}

function isQuietDigestMember(data: QueueData): boolean {
  // Already handled tokens and existing digests must keep their original receipt history.
  return data.quietDeferred === true && data.bypassQuietHours !== true && data.category !== "quiet_digest" &&
    !data.processedTokenHashes?.length && !needsDeliveryVerification(data);
}

function deliveryVerificationHold() {
  return {
    status: "error",
    deliveryVerificationRequired: true,
    failureReason: "unknown",
    errorMessage: "通知サービスへの送信結果を確認できません。自動再送は停止しています。",
    failedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function productionPauseReason(
  current: ProductionOperationalState, original: ProductionOperationalState,
): string | null {
  if (!current.operational) return current.reason;
  if (original.enforced && (!current.enforced || !Number.isSafeInteger(current.generation) ||
      current.generation !== original.generation)) return "production_control_changed";
  return null;
}

function notificationPause(reason: string) {
  return { status: "paused_global", pauseReason: reason, updatedAt: FieldValue.serverTimestamp() };
}

async function checkDispatchReadiness(
  ref: FirebaseFirestore.DocumentReference, leaseToken: string, operationId: string,
  notification: QueueData, originalState: ProductionOperationalState, emergencyControlNotice: boolean,
  recipients: TokenRecord[],
) {
  return db.runTransaction(async tx => {
    const current = (await tx.get(ref)).data() as QueueData | undefined;
    if (current?.status !== "sending" || current.leaseToken !== leaseToken ||
        current.dispatchIntent?.operationId !== operationId || current.deliveryVerificationRequired === true) return null;
    if (notificationGroupKey(current) !== notificationGroupKey(notification) ||
        !DISPATCH_CONTENT_FIELDS.every(field => isDeepStrictEqual(current[field], notification[field]))) {
      tx.update(ref, { status: "superseded", supersededReason: "notification_content_changed",
        dispatchIntent: null, completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return null;
    }
    const registrations = await tx.getAll(...recipients.map(item => db.collection("pushTokens").doc(item.id)));
    const verifiedRecipients = await currentPushDevices(tx, recipients.flatMap((item, index) => {
      const binding = registrations[index]?.data();
      return matchesPushRecipient(item, binding) && matchesTestPushRecipient(current, binding) ? [{ ...item, binding }] : [];
    }));
    const test = isPushTest(current.category);
    if (test) {
      const recipient = readPushTestRecipient(current);
      const expected = readPushTestRecipient(notification);
      if (verifiedRecipients.length !== recipients.length || !recipient || !expected || recipient.uid !== expected.uid ||
          recipient.staff?.staffId !== expected.staff?.staffId || recipient.staff?.authTime !== expected.staff?.authTime ||
          recipient.staff?.deviceCredential?.crewDeviceSession !== expected.staff?.deviceCredential?.crewDeviceSession ||
          recipient.staff?.deviceCredential?.crewDeviceGeneration !== expected.staff?.deviceCredential?.crewDeviceGeneration ||
          !await testRecipientStillActive(current.companyId, recipient, tx)) {
        tx.update(ref, { status: "superseded", supersededReason: "test_requester_no_longer_current",
          dispatchIntent: null, completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
        return null;
      }
    }
    if (!emergencyControlNotice) {
      const currentState = await getProductionOperationalState(current.companyId, tx);
      const reason = productionPauseReason(currentState, originalState);
      if (reason !== null) {
        tx.update(ref, { ...notificationPause(reason), dispatchIntent: null });
        return null;
      }
    }
    // 送信予定を記録した後に変わった案件・提出状態を再確認する。
    const content = test ? {} : await currentReminderContent(current, ref.id, tx);
    if (!content) {
      tx.update(ref, { status: "superseded", supersededReason: "reminder_no_longer_current",
        dispatchIntent: null, completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return null;
    }
    if (!verifiedRecipients.length) {
      tx.update(ref, { dispatchIntent: null, updatedAt: FieldValue.serverTimestamp() });
      return { kind: "skipped" } as const;
    }
    if (verifiedRecipients.length === recipients.length) {
      return { kind: "ready", content, operationId, recipients: verifiedRecipients } as const;
    }
    // 配信対象と結果確認用の記録を一致させてから、対象の端末だけに送信する。
    const dispatchIntent = buildDispatchIntent(leaseToken, verifiedRecipients);
    tx.update(ref, { dispatchIntent });
    return { kind: "ready", content, operationId: dispatchIntent.operationId, recipients: verifiedRecipients } as const;
  });
}

async function prepareNotificationChunk(
  ref: FirebaseFirestore.DocumentReference, leaseToken: string, original: QueueData,
  originalState: ProductionOperationalState, chunk: TokenRecord[],
) {
  return db.runTransaction(async tx => {
    const notification = (await tx.get(ref)).data() as QueueData | undefined;
    if (notification?.status !== "sending" || notification.leaseToken !== leaseToken) return null;
    const expiresAt = dispatchLeaseExpiresAt(notification);
    if (expiresAt === null) return null;
    if (needsDeliveryVerification(notification)) {
      tx.update(ref, deliveryVerificationHold());
      return null;
    }
    const sameTarget = notificationGroupKey(notification) === notificationGroupKey(original);
    const content = sameTarget ? await currentReminderContent(notification, ref.id, tx) : null;
    const timing = applyQuietHours(Timestamp.now());
    if (notification.bypassQuietHours !== true && timing.quietDeferred) {
      tx.update(ref, {
        status: "queued", deliverAt: timing.deliverAt, quietDeferred: true, updatedAt: FieldValue.serverTimestamp(),
      });
      return null;
    }
    if (!content) {
      tx.update(ref, { status: "superseded", supersededReason: "reminder_no_longer_current", completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return null;
    }
    if (Date.now() >= expiresAt) return null;
    const emergencyControlNotice = original.category === "production_global_kill_switch" && notification.category === original.category;
    if (!emergencyControlNotice) {
      const currentState = await getProductionOperationalState(notification.companyId, tx);
      const reason = productionPauseReason(currentState, originalState);
      if (reason !== null) {
        tx.update(ref, notificationPause(reason));
        return null;
      }
    }
    const snapshots = await tx.getAll(...chunk.map(item => db.collection("pushTokens").doc(item.id)));
    const recipients = await currentPushDevices(tx, chunk.flatMap((item, index) => {
      const binding = snapshots[index]?.data();
      return matchesPushRecipient(item, binding) && matchesTestPushRecipient(notification, binding) ? [{ ...item, binding }] : [];
    }));
    if (!recipients.length) return { kind: "skipped" } as const;
    // 後続の処理が停止しても、結果が不明な端末へ再送させないために先に記録する。
    const dispatchIntent = buildDispatchIntent(leaseToken, recipients);
    tx.update(ref, { dispatchIntent });
    return { kind: "ready", notification, operationId: dispatchIntent.operationId, recipients, expiresAt, emergencyControlNotice } as const;
  });
}

async function currentReminderContent(
  data: QueueData, queueId: string,
  tx: Pick<FirebaseFirestore.Transaction, "get" | "getAll">
): Promise<{ body?: string; validUntilMs?: number } | null> {
  if (isPushTest(data.category)) {
    const recipient = readPushTestRecipient(data);
    return recipient && await testRecipientStillActive(data.companyId, recipient, tx) ? {} : null;
  }
  if (data.category === "quiet_digest") {
    const ids = data.bundledQueueIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_QUIET_DIGEST_MEMBERS ||
        ids.some(id => typeof id !== "string" || !id || id.includes("/")) || new Set(ids).size !== ids.length) return null;
    const children = await tx.getAll(...ids.map(id => db.collection("notificationQueue").doc(id)));
    const key = notificationGroupKey(data);
    let count = 0;
    for (let offset = 0; offset < children.length; offset += 25) {
      const valid = await Promise.all(children.slice(offset, offset + 25).map(async doc => {
        const child = doc.data() as QueueData | undefined;
        return child && child.status === "bundled" && child.bundledInto === queueId && child.category !== "quiet_digest" &&
          notificationGroupKey(child) === key && await currentReminderContent(child, doc.id, tx);
      }));
      count += valid.filter(Boolean).length;
    }
    return count ? { body: count + "件のお知らせ・対応事項があります。" } : null;
  }
  if (data.category === 'staff_reservation_confirmed' || data.data && Object.hasOwn(data.data, 'staffReservationProofHash')) {
    const jobId=data.data?.jobId;
    if(typeof jobId!=='string'||!jobId||jobId.includes('/'))return null;
    const current=(await tx.get(db.collection('jobs').doc(jobId))).data();
    return (require('./staff-ng') as typeof import('./staff-ng')).staffReservationNotificationCurrent(data,current) ? {} : null;
  }
  // 旧催促には当時の担当・版がないため、現在の案件と照合できる通知だけを配信する。
  if (data.reminderContext === undefined) return REMINDERS_WITH_REQUIRED_CONTEXT.has(data.category ?? "") ? null : {};
  const context = parseOperationalReminder(data.reminderContext);
  if (!context || (data.targetStaffId ? data.targetStaffId !== context.staffId : data.targetRole !== "admin") || data.targetUid) return null;
  const job = await tx.get(db.collection("jobs").doc(context.jobId));
  const current = job.data();
  if (!operationalReminderIsCurrent(context, data.companyId, current)) return null;
  if (data.category === "submission_reminder") {
    if (context.kind !== "report" && context.kind !== "sales-floor") return null;
    const deadline = submissionDeadline(context.dateKey);
    if (!deadline || deadline.toMillis() <= Date.now()) return null;
    const { hour, minute } = tokyoParts(new Date(deadline.toMillis()));
    const clock = String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
    return { body: (current?.storeName ?? "店舗") + "の提出期限は" + clock + "です。", validUntilMs: deadline.toMillis() };
  }
  if (context.kind === "assignment-receipt") {
    const staff = data.targetStaffId === context.staffId && data.category === "job_assigned" && data.route === "/shifts/" + context.jobId;
    const admin = data.targetRole === "admin" && data.category === "job_application_admin" && data.route === "/admin/jobs/" + context.jobId;
    if (!staff && !admin) return null;
  }
  if (context.kind === "resubmission") {
    if (data.category !== "resubmission_request" || data.targetStaffId !== context.staffId || data.route !== "/resubmissions/" + context.requestId) return null;
    const request = (await tx.get(db.collection("resubmissionRequests").doc(context.requestId!))).data();
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
  values: Record<string, unknown>,
  operationId?: string,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data() as QueueData | undefined;
    if (current?.status !== "sending" || current.leaseToken !== leaseToken ||
        (operationId !== undefined && current.dispatchIntent?.operationId !== operationId)) {
      return false;
    }
    tx.update(ref, values);
    return true;
  });
}

function buildDispatchIntent(leaseToken: string, recipients: TokenRecord[]) {
  const tokenHashes = recipients.map(item => pushTokenHash(item.token));
  const operationId = createHash("sha256").update(JSON.stringify([leaseToken, tokenHashes]), "utf8").digest("hex");
  return { operationId, tokenHashes, preparedAt: Timestamp.now() };
}

function pushTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function matchesPushRecipient(
  expected: TokenRecord, current: FirebaseFirestore.DocumentData | undefined,
): current is FirebaseFirestore.DocumentData {
  return current?.active === true && TOKEN_BINDING_FIELDS.every(field => current[field] === expected.binding[field]);
}

function samePushRegistration(expected: TokenRecord, current: FirebaseFirestore.DocumentData | undefined): boolean {
  if (!matchesPushRecipient(expected, current)) return false;
  const updatedAt = expected.binding.updatedAt;
  return updatedAt === undefined ? current.updatedAt === undefined
    : updatedAt instanceof Timestamp && current.updatedAt instanceof Timestamp && current.updatedAt.isEqual(updatedAt);
}

async function invalidateCurrentPushTokens(
  queueRef: FirebaseFirestore.DocumentReference, leaseToken: string, operationId: string, items: TokenRecord[],
): Promise<number> {
  if (!items.length) return 0;
  return db.runTransaction(async tx => {
    const queue = (await tx.get(queueRef)).data();
    if (queue?.status !== "sending" || queue.leaseToken !== leaseToken ||
        queue.dispatchIntent?.operationId !== operationId) return 0;
    const refs = items.map(item => db.collection("pushTokens").doc(item.id));
    const current = await tx.getAll(...refs);
    let invalidated = 0;
    for (const [index, snapshot] of current.entries()) {
      const item = items[index];
      if (!item || !samePushRegistration(item, snapshot.data())) continue;
      tx.update(snapshot.ref, {
        active: false,
        invalidatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      invalidated++;
    }
    return invalidated;
  });
}

async function testRecipientStillActive(
  companyId: string, recipient: PushTestRecipient, tx: Pick<FirebaseFirestore.Transaction, "get">,
): Promise<boolean> {
  if (!recipient.staff) return true;
  try {
    await readActiveStaffProfile(tx, companyId, recipient.staff.staffId, recipient.uid, recipient.staff.authTime, {
      requireIdentity: true, deviceClaims: recipient.staff.deviceCredential,
    });
    return true;
  } catch (error) {
    if (error instanceof HttpsError && error.code === "permission-denied") return false;
    throw error;
  }
}

function matchesTestPushRecipient(data: QueueData, binding: FirebaseFirestore.DocumentData): boolean {
  if (!isPushTest(data.category)) return true;
  const recipient = readPushTestRecipient(data);
  if (!recipient || binding.uid !== recipient.uid) return false;
  if (!recipient.staff) return binding.role === "admin";
  const credential = recipient.staff.deviceCredential;
  return binding.role === "staff" && binding.staffId === recipient.staff.staffId &&
    (!credential || (binding.deviceSessionId === credential.crewDeviceSession &&
      binding.crewDeviceSession === credential.crewDeviceSession && binding.crewDeviceGeneration === credential.crewDeviceGeneration));
}


function pushScopeId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\/\\\u0000-\u001f\u007f]/.test(value);
}

function hasPushDeviceCredential(binding: FirebaseFirestore.DocumentData): boolean {
  return binding.crewDeviceSession != null || binding.crewDeviceGeneration != null;
}

async function currentPushDevices(
  tx: Pick<FirebaseFirestore.Transaction, "getAll">, recipients: TokenRecord[],
): Promise<TokenRecord[]> {
  const staffIds = new Set<string>();
  for (const { binding } of recipients) {
    if (binding.role !== "admin" && pushScopeId(binding.staffId)) staffIds.add(binding.staffId);
  }
  if (!staffIds.size) return recipients.filter(({ binding }) => !hasPushDeviceCredential(binding));
  const profileRefs = [...staffIds].map(id => db.collection("staffProfiles").doc(id));
  const profiles = new Map((await tx.getAll(...profileRefs)).map(snap => [snap.id, snap.data()]));
  const candidates = recipients.filter(({ binding }) => {
    if (binding.role === "admin") return !hasPushDeviceCredential(binding);
    const profile = profiles.get(binding.staffId);
    return profile?.companyId !== binding.companyId || profile?.active !== false;
  });
  const bound = candidates.filter(({ binding }) => {
    if (binding.role === "admin") return false;
    const profile = profiles.get(binding.staffId);
    return hasPushDeviceCredential(binding) ||
      (profile?.companyId === binding.companyId && profile?.deviceBoundAuthRequired === true);
  });
  if (!bound.length) return candidates;
  const boundIds = new Set(bound.map(item => item.id));
  const accountIds = new Set<string>(), deviceIds = new Set<string>();
  const checked = new Map<string, NonNullable<ReturnType<typeof readStaffDeviceCredential>>>();
  for (const { id, binding } of bound) {
    const credential = readStaffDeviceCredential(binding);
    if (!credential || binding.role !== "staff" || !pushScopeId(binding.uid) || !pushScopeId(binding.staffId) ||
        binding.deviceSessionId !== credential.crewDeviceSession) continue;
    accountIds.add(binding.uid);
    deviceIds.add(credential.crewDeviceSession);
    checked.set(id, credential);
  }
  if (!checked.size) return candidates.filter(item => !boundIds.has(item.id));
  const [identities, devices] = await Promise.all([
    tx.getAll(...[...accountIds].map(id => db.collection("authIdentities").doc(id))),
    tx.getAll(...[...deviceIds].map(id => db.collection("deviceSessions").doc(id))),
  ]);
  const identityMap = new Map(identities.map(item => [item.id, item.data()]));
  const deviceMap = new Map(devices.map(item => [item.id, item.data()]));
  return candidates.filter(({ id, binding }) => {
    if (!boundIds.has(id)) return true;
    const credential = checked.get(id);
    if (!credential) return false;
    const profile = profiles.get(binding.staffId);
    const identity = identityMap.get(binding.uid);
    const device = deviceMap.get(credential.crewDeviceSession);
    if (profile?.active !== true || profile.companyId !== binding.companyId || identity?.active !== true || device?.active !== true ||
        identity.companyId !== binding.companyId || identity.staffId !== binding.staffId ||
        device.companyId !== binding.companyId || device.staffId !== binding.staffId || device.uid !== binding.uid ||
        device.credentialGeneration !== credential.crewDeviceGeneration ||
        identity.deviceCredentials?.[credential.crewDeviceSession] !== credential.crewDeviceGeneration) return false;
    const authTime = binding.registeredAuthTime;
    if (!Number.isSafeInteger(authTime) || authTime < 0 || authTime > 253402300799) return false;
    try {
      assertDeviceAuthentication(device, authTime);
    } catch (error) {
      if (error instanceof HttpsError && error.code === "permission-denied") return false;
      throw error;
    }
    const cutoff = identity.revokedAt;
    return cutoff == null || (cutoff instanceof Timestamp && (authTime > cutoff.seconds || (authTime === cutoff.seconds && cutoff.nanoseconds === 0)));
  });
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
    const binding = doc.data();
    const { token } = binding;
    if (typeof token === "string" && token && matchesTestPushRecipient(data, binding)) unique.set(token, { id: doc.id, token, binding });
  }
  return [...unique.values()];
}

async function bundleQuietNotifications(now: Timestamp): Promise<void> {
  const query = db.collection("notificationQueue")
    .where("status", "==", "queued")
    .where("quietDeferred", "==", true)
    .where("deliverAt", "<=", now)
    .orderBy("deliverAt", "asc")
    .limit(300);

  // Gather every page before releasing any individual notice for delivery.
  const groups = new Map<string, FirebaseFirestore.DocumentReference[]>();
  let page = await query.get();
  while (!page.empty) {
    for (const doc of page.docs) {
      const data = doc.data() as QueueData;
      if (!isQuietDigestMember(data)) continue;
      const key = notificationGroupKey(data);
      const current = groups.get(key) ?? [];
      current.push(doc.ref);
      groups.set(key, current);
    }
    const last = page.docs.at(-1);
    if (page.size < 300 || !last) break;
    page = await query.startAfter(last).get();
  }

  const day = tokyoParts(now.toDate()).dateKey;
  for (const [key, refs] of groups) {
    // Keep the digest document within size limits, including unusually long legacy IDs.
    const longestId = refs.reduce((length, ref) => Math.max(length, ref.id.length), 1);
    const maxSize = Math.min(MAX_QUIET_DIGEST_MEMBERS, Math.floor(200_000 / longestId));
    const size = Math.ceil(refs.length / Math.ceil(refs.length / maxSize));
    for (let offset = 0; offset < refs.length; offset += size) {
      try {
        await saveQuietDigest(now, day, key, refs.slice(offset, offset + size));
      } catch (error) {
        // Members whose transaction failed stay deferred and remain eligible on the next run.
        console.error("Quiet notification digest failed", { error });
      }
    }
  }
}

async function saveQuietDigest(now: Timestamp, day: string, key: string, refs: FirebaseFirestore.DocumentReference[]) {
  await db.runTransaction(async tx => {
    const latest = await tx.getAll(...refs);
    const eligible = latest.filter(doc => {
      const current = doc.data() as QueueData | undefined;
      return current?.status === "queued" && isQuietDigestMember(current) &&
        (current.deliverAt?.toMillis() ?? Infinity) <= now.toMillis() && notificationGroupKey(current) === key;
    });
    const first = eligible[0];
    if (!first) return;
    if (eligible.length === 1) {
      tx.update(first.ref, { quietDeferred: false, updatedAt: now });
      return;
    }

    const sample = first.data() as QueueData;
    const queueIds = eligible.map(doc => doc.id).sort();
    const digestKey = createHash("sha256").update(JSON.stringify([key, day, queueIds]), "utf8").digest("hex");
    const digestRef = db.collection("notificationQueue").doc("digest_" + digestKey.slice(0, 36));
    if ((await tx.get(digestRef)).exists) return;
    tx.create(digestRef, {
      companyId: sample.companyId,
      ...(sample.targetStaffId ? { targetStaffId: sample.targetStaffId } : {}),
      ...(sample.targetRole ? { targetRole: sample.targetRole } : {}),
      ...(sample.targetUid ? { targetUid: sample.targetUid } : {}),
      title: "未確認の通知があります",
      body: eligible.length + "件のお知らせ・対応事項があります。",
      route: "/",
      category: "quiet_digest",
      dedupeKey: digestKey,
      status: "queued",
      deliverAt: now,
      quietDeferred: false,
      bundledQueueIds: queueIds,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    for (const doc of eligible) {
      tx.update(doc.ref, { status: "bundled", bundledInto: digestRef.id, completedAt: now, updatedAt: now });
    }
  });
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
