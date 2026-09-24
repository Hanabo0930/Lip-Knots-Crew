import { caseMailPreparationHeld, type CaseMailPreparation } from "./case-mail-preparation-core";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db } from "./firebase";
import { enqueueNotification, notificationDeliveryPaused, notificationQueueId, queueDocumentData, type QueueNotificationInput } from "./notification-core";
import { getProductionOperationalState } from "./system-safety";
import { SUBMISSION_BUSINESS_DAY_SEARCH_LIMIT } from "./japan-business-day";
import {
  addTokyoDays,
  isWithinMinuteWindow,
  submissionDeadline,
  timestampMinusMinutes,
  tokyoParts,
} from "./notification-time";

import type { ReminderKind } from "./operational-reminder";

type NotificationSettings = {
  enabled?: boolean;
  preContactThreeDaysHour?: number;
  quietStartHour?: number;
  quietEndHour?: number;
  importantAnnouncementHour?: number;
  printReminderDays?: number;
};

type JobData = CaseMailPreparation & {
  preContactNeedsReview?: boolean;
  revision?: number;
  companyId?: string;
  assignedStaffId?: string;
  assignedStaffName?: string;
  status?: string;
  dateKey?: string;
  storeName?: string;
  cancelled?: boolean;
  sourceMissing?: boolean;
  applicationUnconfirmed?: boolean;
  assignmentUnresolved?: boolean;
  preContact?: { temperature?: unknown; arrivalTime?: unknown } | null;
  submissionStatus?: {
    report?: { completed?: boolean };
    salesFloor?: { completed?: boolean; clientSubmitted?: boolean; lipKnotsSubmitted?: boolean };
  };
  netPrint?: {
    writeOperationId?: string;
    updatedAt?: Timestamp;
    items?: Array<{ number?: string; printed?: boolean }>;
  };
};

export const scheduleOperationalReminders = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Tokyo",
    timeoutSeconds: 540,
    memory: "2GiB",
    maxInstances: 1,
  },
  async () => {
    if (notificationDeliveryPaused()) return;
    const now = new Date();
    const settingsSnap = await db.collection("notificationSettings")
      .where("enabled", "==", true)
      .limit(20)
      .get();

    for (const settingDoc of settingsSnap.docs) {
      const settings = settingDoc.data() as NotificationSettings;
      try {
        await processCompanyReminders(settingDoc.id, settings, now);
      } catch (error) {
        console.error("Operational reminder scheduling failed", {
          companyId: settingDoc.id,
          error,
        });
      }
    }
  }
);

async function processCompanyReminders(
  companyId: string,
  settings: NotificationSettings,
  now: Date
): Promise<void> {
  if (!(await getProductionOperationalState(companyId)).operational) return;
  const parts = tokyoParts(now);
  const today = parts.dateKey;
  const from = addTokyoDays(today, -SUBMISSION_BUSINESS_DAY_SEARCH_LIMIT);
  const through = addTokyoDays(today, 60);
  const jobsSnap = await db.collection("jobs")
    .where("companyId", "==", companyId)
    .where("status", "==", "assigned")
    .where("dateKey", ">=", from)
    .where("dateKey", "<=", through)
    .limit(10000)
    .get();

  for (const jobDoc of jobsSnap.docs) {
    const job = jobDoc.data() as JobData;
    if (!job.assignedStaffId || !job.dateKey || job.cancelled === true || job.sourceMissing === true ||
        job.applicationUnconfirmed === true || job.assignmentUnresolved === true || caseMailPreparationHeld(job)) continue;
    await schedulePreContact(companyId, jobDoc.id, job, settings, now);
    await scheduleSubmissions(companyId, jobDoc.id, job, now);
    await schedulePrintReminder(companyId, jobDoc.id, job, settings, now);
  }

  const announcementHour = settings.importantAnnouncementHour ?? 9;
  if (isWithinMinuteWindow(now, announcementHour, 0)) {
    await scheduleImportantAnnouncements(companyId, today);
  }
}

async function schedulePreContact(
  companyId: string,
  jobId: string,
  job: JobData,
  settings: NotificationSettings,
  now: Date
): Promise<void> {
  if (job.sourceMissing === true || job.applicationUnconfirmed === true || job.assignmentUnresolved === true || caseMailPreparationHeld(job)) return;
  const complete = job.preContactNeedsReview !== true && Boolean(
    job.preContact?.temperature !== undefined &&
    job.preContact?.temperature !== "" &&
    job.preContact?.arrivalTime
  );
  if (complete || !job.dateKey || !job.assignedStaffId) return;

  const today = tokyoParts(now).dateKey;
  const workDate = job.dateKey;
  const d3Hour = settings.preContactThreeDaysHour ?? 9;
  if (workDate === addTokyoDays(today, 3) && isWithinMinuteWindow(now, d3Hour, 0)) {
    await enqueueCurrentPreContact(companyId, jobId, job, "d3");
  }
  if (workDate === addTokyoDays(today, 1)) {
    for (const reminder of [{ hour: 8, key: "d1_0800" }, { hour: 12, key: "d1_1200" }] as const) {
      if (isWithinMinuteWindow(now, reminder.hour, 0)) {
        await enqueueCurrentPreContact(companyId, jobId, job, reminder.key);
      }
    }
    if (isWithinMinuteWindow(now, 15, 0)) {
      await enqueueCurrentPreContact(companyId, jobId, job, "late");
    }
  }
}

type PreContactSlot = "d3" | "d1_0800" | "d1_1200" | "late";

function withReminderContext(input: QueueNotificationInput, jobId: string, job: JobData, kind: ReminderKind): QueueNotificationInput {
  const context = { version: 1 as const, jobId, staffId: job.assignedStaffId!, dateKey: job.dateKey!, revision: job.revision ?? 0, kind,
    ...(kind === "netprint" ? { printUpdatedAtMs: job.netPrint!.updatedAt!.toMillis(),
      ...(job.netPrint?.writeOperationId ? { printWriteOperationId: job.netPrint.writeOperationId } : {}) } : {}) };
  return { ...input, reminderContext: context, dedupeKey: input.dedupeKey + "_" + JSON.stringify(context) };
}

function preContactNotificationInput(
  companyId: string, jobId: string, job: JobData, slot: PreContactSlot
): QueueNotificationInput {
  const store = job.storeName ?? "店舗";
  if (slot === "late") {
    return withReminderContext({
      companyId, targetRole: "admin", title: "事前連絡の締切超過",
      body: `${job.assignedStaffName ?? "スタッフ"} / ${store}`,
      route: `/admin/jobs/${jobId}`, category: "precontact_late", dedupeKey: `${jobId}_late`,
    }, jobId, job, "precontact");
  }
  return withReminderContext({
    companyId, targetStaffId: job.assignedStaffId!,
    title: slot === "d3" ? "事前連絡を送ってください" : "事前連絡が未送信です",
    body: slot === "d3" ? `${job.dateKey} ${store}の事前連絡を送れます。`
      : `${store}の体温と到着予定時刻を、15:00までに送ってください。`,
    route: `/shifts/${jobId}/precontact`, category: "precontact_reminder", dedupeKey: `${jobId}_${slot}`,
  }, jobId, job, "precontact");
}

async function enqueueCurrentPreContact(
  companyId: string, jobId: string, expected: JobData, slot: PreContactSlot
): Promise<void> {
  if (!expected.assignedStaffId || !expected.dateKey) return;
  const jobRef = db.collection("jobs").doc(jobId);
  const queueRef = db.collection("notificationQueue").doc(
    notificationQueueId(preContactNotificationInput(companyId, jobId, expected, slot))
  );
  await db.runTransaction(async (tx) => {
    const currentSnap = await tx.get(jobRef);
    const queued = await tx.get(queueRef);
    if (!currentSnap.exists || queued.exists) return;
    const current = currentSnap.data() as JobData;
    if (current.companyId !== companyId || current.status !== "assigned" || current.cancelled === true ||
        current.assignedStaffId !== expected.assignedStaffId || current.dateKey !== expected.dateKey ||
        !sameReminderRevision(current, expected) ||
        current.sourceMissing === true || current.applicationUnconfirmed === true || current.assignmentUnresolved === true || caseMailPreparationHeld(current)) return;
    if (current.preContactNeedsReview !== true && current.preContact?.temperature !== undefined && current.preContact.temperature !== "" && current.preContact.arrivalTime) return;
    // 案件の現在値と予約を同じ取引で確認し、遅延記録だけを先に残さない。
    tx.create(queueRef, {
      ...queueDocumentData(preContactNotificationInput(companyId, jobId, current, slot)),
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    if (slot === "late") {
      tx.set(jobRef, { preContactLate: true, preContactLateDetectedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
  });
}

function sameReminderRevision(current: JobData, expected: JobData): boolean {
  const revision = current.revision ?? 0;
  return Number.isSafeInteger(revision) && revision >= 0 && revision === (expected.revision ?? 0);
}

async function enqueueCurrentJobReminder(
  companyId: string, jobId: string, expected: JobData, kind: ReminderKind,
  build: (current: JobData) => QueueNotificationInput | null
): Promise<void> {
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(db.collection("jobs").doc(jobId));
    if (!snapshot.exists) return;
    const current = snapshot.data() as JobData;
    if (current.companyId !== companyId || current.status !== "assigned" || current.cancelled === true ||
        !current.assignedStaffId || current.assignedStaffId !== expected.assignedStaffId ||
        current.dateKey !== expected.dateKey || !sameReminderRevision(current, expected) ||
        current.sourceMissing === true || current.applicationUnconfirmed === true || current.assignmentUnresolved === true || caseMailPreparationHeld(current)) return;
    const candidate = build(current);
    if (!candidate) return;
    const input = withReminderContext(candidate, jobId, current, kind);
    const queueRef = db.collection("notificationQueue").doc(notificationQueueId(input));
    if ((await tx.get(queueRef)).exists) return;
    tx.create(queueRef, {
      ...queueDocumentData(input), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

async function scheduleSubmissions(
  companyId: string, jobId: string, job: JobData, now: Date
): Promise<void> {
  if (!job.dateKey || !job.assignedStaffId) return;
  const deadline = submissionDeadline(job.dateKey);
  if (!deadline) return;
  const nowMs = now.getTime();
  const within = (target: Timestamp) => nowMs >= target.toMillis() && nowMs < target.toMillis() + 5 * 60_000;
  const early = within(timestampMinusMinutes(deadline, 15));
  if (!early && !within(deadline)) return;
  for (const type of ["sales-floor", "report"] as const) {
    for (const admin of early ? [false] : [false, true]) {
      await enqueueCurrentJobReminder(companyId, jobId, job, type, (current) => {
        const sales = current.submissionStatus?.salesFloor;
        if (type === "report" ? current.submissionStatus?.report?.completed === true
          : Boolean(sales?.completed || sales?.clientSubmitted || sales?.lipKnotsSubmitted)) return null;
        const label = type === "report" ? "報告書" : "売場画像";
        const store = current.storeName ?? "店舗";
        return {
          companyId, ...(admin ? { targetRole: "admin" as const } : { targetStaffId: current.assignedStaffId! }),
          title: early || admin ? label + "が未提出です" : label + "の提出期限を過ぎました",
          body: admin ? (current.assignedStaffName ?? "スタッフ") + " / " + store
            : early ? store + "の提出期限まで15分です。" : store + "の" + label + "を提出してください。",
          route: admin ? "/admin/jobs/" + jobId : "/submissions/" + jobId + "/" + type,
          category: early ? "submission_reminder" : "submission_overdue",
          dedupeKey: jobId + "_" + (early && type === "sales-floor" ? "sales_floor" : type)
            + (early ? "_15m" : admin ? "_admin_overdue" : "_overdue"),
        };
      });
    }
  }
}

async function schedulePrintReminder(
  companyId: string, jobId: string, job: JobData, settings: NotificationSettings, now: Date
): Promise<void> {
  const updatedAt = job.netPrint?.updatedAt;
  if (!job.assignedStaffId || !updatedAt) return;
  const reminderDays = settings.printReminderDays ?? 3;
  const dueAt = updatedAt.toMillis() + reminderDays * 24 * 60 * 60 * 1000;
  if (now.getTime() < dueAt || now.getTime() >= dueAt + 5 * 60_000) return;
  await enqueueCurrentJobReminder(companyId, jobId, job, "netprint", (current) => {
    if (current.netPrint?.updatedAt?.toMillis() !== updatedAt.toMillis() ||
        (current.netPrint?.writeOperationId ?? null) !== (job.netPrint?.writeOperationId ?? null)) return null;
    const unprinted = (current.netPrint?.items ?? []).filter(item => item.number && item.printed !== true);
    if (!unprinted.length) return null;
    return {
      companyId, targetStaffId: current.assignedStaffId!, title: "ネットプリントが未印刷です",
      body: unprinted.length + "件の資料をできるだけ早く印刷してください。",
      route: "/shifts/" + jobId + "/netprint", category: "netprint_unprinted",
      dedupeKey: jobId + "_" + updatedAt.toMillis() + "_d" + reminderDays,
    };
  });
}

async function scheduleImportantAnnouncements(
  companyId: string,
  today: string
): Promise<void> {
  const announcements = await db.collection("announcements")
    .where("companyId", "==", companyId)
    .where("important", "==", true)
    .where("active", "==", true)
    .limit(100)
    .get();

  for (const announcement of announcements.docs) {
    const data = announcement.data() as {
      title?: string;
      targetAll?: boolean;
      targetStaffIds?: string[];
    };
    const staffIds = data.targetAll
      ? await activeStaffIds(companyId)
      : [...new Set(data.targetStaffIds ?? [])];

    const receipts = await getReceiptSet(announcement.id, staffIds);
    for (const staffId of staffIds) {
      if (receipts.has(staffId)) continue;
      await enqueueNotification({
        companyId,
        targetStaffId: staffId,
        title: "重要なお知らせを確認してください",
        body: data.title ?? "未確認の重要なお知らせがあります。",
        route: `/announcements/${announcement.id}`,
        category: "important_announcement",
        dedupeKey: `${announcement.id}_${staffId}_${today}`,
      });
    }
  }
}

async function activeStaffIds(companyId: string): Promise<string[]> {
  const snap = await db.collection("staffProfiles")
    .where("companyId", "==", companyId)
    .where("active", "==", true)
    .limit(2000)
    .get();
  return snap.docs.map((doc) => doc.id);
}

async function getReceiptSet(
  announcementId: string,
  staffIds: string[]
): Promise<Set<string>> {
  const confirmed = new Set<string>();
  for (let index = 0; index < staffIds.length; index += 250) {
    const refs = staffIds.slice(index, index + 250).map((staffId) =>
      db.collection("announcementReceipts").doc(`${announcementId}_${staffId}`)
    );
    if (!refs.length) continue;
    const snaps = await db.getAll(...refs);
    snaps.forEach((snap) => {
      if (snap.exists && snap.data()?.confirmedAt) {
        confirmed.add(String(snap.data()?.staffId ?? ""));
      }
    });
  }
  return confirmed;
}
