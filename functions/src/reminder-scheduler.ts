import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db } from "./firebase";
import { enqueueNotification } from "./notification-core";
import { getProductionOperationalState } from "./system-safety";
import {
  addTokyoDays,
  isWithinMinuteWindow,
  submissionDeadline,
  timestampMinusMinutes,
  tokyoParts,
} from "./notification-time";

type NotificationSettings = {
  enabled?: boolean;
  preContactThreeDaysHour?: number;
  quietStartHour?: number;
  quietEndHour?: number;
  importantAnnouncementHour?: number;
  printReminderDays?: number;
};

type JobData = {
  companyId?: string;
  assignedStaffId?: string;
  assignedStaffName?: string;
  status?: string;
  dateKey?: string;
  storeName?: string;
  cancelled?: boolean;
  preContact?: { temperature?: unknown; arrivalTime?: unknown } | null;
  submissionStatus?: {
    report?: { completed?: boolean };
    salesFloor?: { completed?: boolean; clientSubmitted?: boolean; lipKnotsSubmitted?: boolean };
  };
  netPrint?: {
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
  const from = addTokyoDays(today, -3);
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
    if (!job.assignedStaffId || !job.dateKey || job.cancelled === true) continue;
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
  const complete = Boolean(
    job.preContact?.temperature !== undefined &&
    job.preContact?.temperature !== "" &&
    job.preContact?.arrivalTime
  );
  if (complete || !job.dateKey || !job.assignedStaffId) return;

  const today = tokyoParts(now).dateKey;
  const store = job.storeName ?? "店舗";
  const workDate = job.dateKey;
  const d3Hour = settings.preContactThreeDaysHour ?? 9;

  if (
    workDate === addTokyoDays(today, 3) &&
    isWithinMinuteWindow(now, d3Hour, 0)
  ) {
    await enqueueNotification({
      companyId,
      targetStaffId: job.assignedStaffId,
      title: "事前連絡を送ってください",
      body: `${workDate} ${store}の事前連絡を送れます。`,
      route: `/shifts/${jobId}/precontact`,
      category: "precontact_reminder",
      dedupeKey: `${jobId}_d3`,
    });
  }

  if (workDate === addTokyoDays(today, 1)) {
    for (const reminder of [{ hour: 8, key: "d1_0800" }, { hour: 12, key: "d1_1200" }]) {
      if (isWithinMinuteWindow(now, reminder.hour, 0)) {
        await enqueueNotification({
          companyId,
          targetStaffId: job.assignedStaffId,
          title: "事前連絡が未送信です",
          body: `${store}の体温と到着予定時刻を、15:00までに送ってください。`,
          route: `/shifts/${jobId}/precontact`,
          category: "precontact_reminder",
          dedupeKey: `${jobId}_${reminder.key}`,
        });
      }
    }

    if (isWithinMinuteWindow(now, 15, 0)) {
      await db.collection("jobs").doc(jobId).set({
        preContactLate: true,
        preContactLateDetectedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      await enqueueNotification({
        companyId,
        targetRole: "admin",
        title: "事前連絡の締切超過",
        body: `${job.assignedStaffName ?? "スタッフ"} / ${store}`,
        route: `/admin/jobs/${jobId}`,
        category: "precontact_late",
        dedupeKey: `${jobId}_late`,
      });
    }
  }
}

async function scheduleSubmissions(
  companyId: string,
  jobId: string,
  job: JobData,
  now: Date
): Promise<void> {
  if (!job.dateKey || !job.assignedStaffId) return;
  const deadline = submissionDeadline(job.dateKey);
  const reminder = timestampMinusMinutes(deadline, 15);
  const nowMs = now.getTime();
  const within = (target: Timestamp) =>
    nowMs >= target.toMillis() && nowMs < target.toMillis() + 5 * 60_000;
  const store = job.storeName ?? "店舗";

  const reportComplete = job.submissionStatus?.report?.completed === true;
  const sales = job.submissionStatus?.salesFloor;
  const salesComplete = Boolean(
    sales?.completed || sales?.clientSubmitted || sales?.lipKnotsSubmitted
  );

  if (within(reminder)) {
    if (!salesComplete) {
      await enqueueNotification({
        companyId,
        targetStaffId: job.assignedStaffId,
        title: "売場画像が未提出です",
        body: `${store}の提出期限まで15分です。`,
        route: `/submissions/${jobId}/sales-floor`,
        category: "submission_reminder",
        dedupeKey: `${jobId}_sales_floor_15m`,
      });
    }
    if (!reportComplete) {
      await enqueueNotification({
        companyId,
        targetStaffId: job.assignedStaffId,
        title: "報告書が未提出です",
        body: `${store}の提出期限まで15分です。`,
        route: `/submissions/${jobId}/report`,
        category: "submission_reminder",
        dedupeKey: `${jobId}_report_15m`,
      });
    }
  }

  if (within(deadline)) {
    for (const item of [
      { missing: !salesComplete, label: "売場画像", type: "sales-floor" },
      { missing: !reportComplete, label: "報告書", type: "report" },
    ]) {
      if (!item.missing) continue;
      await enqueueNotification({
        companyId,
        targetStaffId: job.assignedStaffId,
        title: `${item.label}の提出期限を過ぎました`,
        body: `${store}の${item.label}を提出してください。`,
        route: `/submissions/${jobId}/${item.type}`,
        category: "submission_overdue",
        dedupeKey: `${jobId}_${item.type}_overdue`,
      });
      await enqueueNotification({
        companyId,
        targetRole: "admin",
        title: `${item.label}が未提出です`,
        body: `${job.assignedStaffName ?? "スタッフ"} / ${store}`,
        route: `/admin/jobs/${jobId}`,
        category: "submission_overdue",
        dedupeKey: `${jobId}_${item.type}_admin_overdue`,
      });
    }
  }
}

async function schedulePrintReminder(
  companyId: string,
  jobId: string,
  job: JobData,
  settings: NotificationSettings,
  now: Date
): Promise<void> {
  const items = job.netPrint?.items ?? [];
  const unprinted = items.filter((item) => item.number && item.printed !== true);
  const updatedAt = job.netPrint?.updatedAt;
  if (!job.assignedStaffId || !updatedAt || !unprinted.length) return;
  const reminderDays = settings.printReminderDays ?? 3;
  const dueAt = updatedAt.toMillis() + reminderDays * 24 * 60 * 60 * 1000;
  if (now.getTime() < dueAt || now.getTime() >= dueAt + 5 * 60_000) return;

  await enqueueNotification({
    companyId,
    targetStaffId: job.assignedStaffId,
    title: "ネットプリントが未印刷です",
    body: `${unprinted.length}件の資料をできるだけ早く印刷してください。`,
    route: `/shifts/${jobId}/netprint`,
    category: "netprint_unprinted",
    dedupeKey: `${jobId}_${updatedAt.toMillis()}_d${reminderDays}`,
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
