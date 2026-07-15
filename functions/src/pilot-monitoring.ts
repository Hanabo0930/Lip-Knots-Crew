import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { z } from "zod";
import { db } from "./firebase";
import { sendLoginInviteBatch } from "./login-links";
import { gmailServiceAccountJson } from "./mail-sender";
import { enqueueNotification } from "./notification-core";
import {
  defaultPilotMonitoringThresholds,
  evaluatePilotMonitoring,
  PilotMonitoringSnapshot,
  PilotMonitoringThresholds,
} from "./pilot-rollout-core";
import { companyFromClaims, requireAdmin } from "./utils";

const StartPilotSchema = z.object({
  staffIds: z.array(z.string().min(1).max(160)).min(3).max(5)
    .refine((ids) => new Set(ids).size === ids.length, "参加者が重複しています。"),
  releaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{5,119}$/),
  durationDays: z.number().int().min(1).max(14).default(7),
  subject: z.string().min(1).max(150),
  introText: z.string().max(3000).default(""),
  alertCooldownMinutes: z.number().int().min(5).max(180).default(30),
});

const StopPilotSchema = z.object({
  reason: z.string().min(1).max(500),
});

type PilotRolloutData = {
  companyId: string;
  releaseId: string;
  participantIds: string[];
  participantCount: number;
  inviteBatchId?: string;
  status: "preparing" | "active" | "blocked" | "stopped" | "review_required" |
    "expansion_review_pending" | "expansion_blocked" | "expansion_approved" | "expansion_rejected";
  startedAt?: Timestamp;
  endsAt?: Timestamp;
  activationGraceUntil?: Timestamp;
  monitoringThresholds?: Partial<PilotMonitoringThresholds>;
  alertCooldownMinutes?: number;
  lastHealth?: {
    action?: "continue" | "watch" | "pause";
    fingerprint?: string;
    observedAt?: Timestamp;
    alerts?: Array<{ key?: string; label?: string; value?: number; threshold?: number; severity?: string }>;
  };
  lastAlertAt?: Timestamp;
  lastAlertFingerprint?: string;
};

export const startPilotRollout = onCall(
  {
    secrets: [gmailServiceAccountJson],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (request) => {
    assertStagingRuntime();
    const session = requireAdmin(request);
    const companyId = companyFromClaims(session.token);
    const input = StartPilotSchema.parse(request.data ?? {});
    const controlRef = db.collection("pilotRolloutControls").doc(companyId);
    await assertEligibleParticipants(companyId, input.staffIds);
    await assertPilotSafetyGate(companyId);
    const rolloutRef = db.collection("pilotRollouts").doc();
    const now = Timestamp.now();
    const base = {
      companyId,
      releaseId: input.releaseId,
      participantIds: input.staffIds,
      participantCount: input.staffIds.length,
      durationDays: input.durationDays,
      alertCooldownMinutes: input.alertCooldownMinutes,
      monitoringThresholds: defaultPilotMonitoringThresholds(),
      environment: "staging",
      createdBy: session.uid,
      createdAt: now,
      updatedAt: now,
    };

    await db.runTransaction(async (tx) => {
      const control = await tx.get(controlRef);
      const activeRolloutId = String(control.data()?.activeRolloutId ?? "");
      const preparingRolloutId = String(control.data()?.preparingRolloutId ?? "");
      const reservationExpiresAt = control.data()?.reservationExpiresAt as Timestamp | undefined;
      if (activeRolloutId || (
        preparingRolloutId &&
        reservationExpiresAt &&
        reservationExpiresAt.toMillis() > now.toMillis()
      )) {
        throw new HttpsError("already-exists", "進行中または配布準備中のパイロットがあります。");
      }
      tx.create(rolloutRef, {
        ...base,
        status: "preparing",
        reservationExpiresAt: Timestamp.fromMillis(now.toMillis() + 15 * 60 * 1000),
      });
      tx.set(controlRef, {
        companyId,
        preparingRolloutId: rolloutRef.id,
        reservationExpiresAt: Timestamp.fromMillis(now.toMillis() + 15 * 60 * 1000),
        updatedAt: now,
      }, { merge: true });
    });

    let invites: Awaited<ReturnType<typeof sendLoginInviteBatch>>;
    try {
      invites = await sendLoginInviteBatch({
        companyId,
        actorUid: session.uid,
        staffIds: input.staffIds,
        subject: input.subject,
        introText: input.introText,
        source: "pilot_rollout",
      });
    } catch (error) {
      const failedAt = Timestamp.now();
      const batch = db.batch();
      batch.set(rolloutRef, {
        status: "blocked",
        blockedReason: "invite_batch_failed",
        blockedAt: failedAt,
        updatedAt: failedAt,
      }, { merge: true });
      batch.set(controlRef, {
        preparingRolloutId: null,
        reservationExpiresAt: null,
        updatedAt: failedAt,
      }, { merge: true });
      await batch.commit();
      await notifyAdmins({
        companyId,
        title: "パイロット配布処理を停止しました",
        body: "配布処理を完了できませんでした。ログと招待batchを確認してください。",
        category: "pilot_batch_failed",
        dedupeKey: rolloutRef.id,
        urgent: true,
      });
      console.error("pilot_invite_batch_failed", {
        rolloutId: rolloutRef.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new HttpsError("internal", "パイロット配布処理を完了できませんでした。");
    }

    if (invites.failedStaff > 0 || invites.successStaff !== input.staffIds.length) {
      const batch = db.batch();
      batch.set(rolloutRef, {
        ...base,
        inviteBatchId: invites.batchId,
        status: "blocked",
        blockedReason: "invite_delivery_failed",
        inviteSummary: {
          successStaff: invites.successStaff,
          failedStaff: invites.failedStaff,
        },
      }, { merge: true });
      batch.set(controlRef, {
        preparingRolloutId: null,
        reservationExpiresAt: null,
        updatedAt: Timestamp.now(),
      }, { merge: true });
      await batch.commit();
      await notifyAdmins({
        companyId,
        title: "パイロット配布を停止しました",
        body: `招待成功${invites.successStaff}名・失敗${invites.failedStaff}名。再開前に配信結果を確認してください。`,
        category: "pilot_blocked",
        dedupeKey: rolloutRef.id,
        urgent: true,
      });
      return {
        rolloutId: rolloutRef.id,
        status: "blocked",
        participantCount: input.staffIds.length,
        successStaff: invites.successStaff,
        failedStaff: invites.failedStaff,
      };
    }

    const endsAt = Timestamp.fromMillis(now.toMillis() + input.durationDays * 86_400_000);
    const activationGraceUntil = Timestamp.fromMillis(now.toMillis() + 24 * 60 * 60 * 1000);
    const batch = db.batch();
    batch.set(rolloutRef, {
      ...base,
      inviteBatchId: invites.batchId,
      status: "active",
      startedAt: now,
      endsAt,
      activationGraceUntil,
      inviteSummary: {
        successStaff: invites.successStaff,
        failedStaff: invites.failedStaff,
      },
      lastHealth: null,
    });
    batch.set(controlRef, {
      companyId,
      activeRolloutId: rolloutRef.id,
      preparingRolloutId: null,
      reservationExpiresAt: null,
      releaseId: input.releaseId,
      updatedAt: now,
    }, { merge: true });
    batch.set(db.collection("auditLogs").doc(), {
      companyId,
      actorUid: session.uid,
      action: "pilot.rollout.started",
      rolloutId: rolloutRef.id,
      releaseId: input.releaseId,
      participantCount: input.staffIds.length,
      inviteBatchId: invites.batchId,
      createdAt: now,
    });
    await batch.commit();
    await notifyAdmins({
      companyId,
      title: "3〜5名パイロットを開始しました",
      body: `${input.staffIds.length}名へ配布済み。5分間隔の自動監視を開始しました。`,
      category: "pilot_started",
      dedupeKey: rolloutRef.id,
    });

    return {
      rolloutId: rolloutRef.id,
      status: "active",
      participantCount: input.staffIds.length,
      successStaff: invites.successStaff,
      failedStaff: 0,
      endsAt: endsAt.toDate().toISOString(),
    };
  }
);

export const getPilotRolloutStatus = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const control = await db.collection("pilotRolloutControls").doc(companyId).get();
  const activeRolloutId = String(control.data()?.activeRolloutId ?? "");
  let rollout = activeRolloutId
    ? await db.collection("pilotRollouts").doc(activeRolloutId).get()
    : null;
  if (!rollout?.exists) {
    const latest = await db.collection("pilotRollouts")
      .where("companyId", "==", companyId)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
    rollout = latest.docs[0] ?? null;
  }
  if (!rollout?.exists || rollout.data()?.companyId !== companyId) return { rollout: null };
  const data = rollout.data() as PilotRolloutData;
  return {
    rollout: {
      rolloutId: rollout.id,
      releaseId: data.releaseId,
      status: data.status,
      participantCount: data.participantCount,
      startedAt: iso(data.startedAt),
      endsAt: iso(data.endsAt),
      lastHealth: data.lastHealth ? {
        action: data.lastHealth.action ?? "continue",
        observedAt: iso(data.lastHealth.observedAt),
        alerts: data.lastHealth.alerts ?? [],
      } : null,
    },
  };
});

export const stopPilotRollout = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = StopPilotSchema.parse(request.data ?? {});
  const controlRef = db.collection("pilotRolloutControls").doc(companyId);
  const control = await controlRef.get();
  const rolloutId = String(control.data()?.activeRolloutId ?? "");
  if (!rolloutId) return { stopped: false };
  const rolloutRef = db.collection("pilotRollouts").doc(rolloutId);
  const rollout = await rolloutRef.get();
  if (!rollout.exists || rollout.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "進行中のパイロットが見つかりません。");
  }
  const now = Timestamp.now();
  const batch = db.batch();
  batch.set(rolloutRef, {
    status: "stopped",
    stoppedReason: input.reason,
    stoppedBy: session.uid,
    stoppedAt: now,
    updatedAt: now,
  }, { merge: true });
  batch.set(controlRef, {
    activeRolloutId: null,
    updatedAt: now,
  }, { merge: true });
  batch.set(db.collection("auditLogs").doc(), {
    companyId,
    actorUid: session.uid,
    action: "pilot.rollout.stopped",
    rolloutId,
    reason: input.reason,
    createdAt: now,
  });
  await batch.commit();
  await notifyAdmins({
    companyId,
    title: "パイロットを停止しました",
    body: input.reason,
    category: "pilot_stopped",
    dedupeKey: rolloutId,
    urgent: true,
  });
  return { stopped: true, rolloutId };
});

export const monitorPilotHealth = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Tokyo",
    timeoutSeconds: 300,
    memory: "1GiB",
    maxInstances: 1,
  },
  async () => {
    const active = await db.collection("pilotRollouts")
      .where("status", "==", "active")
      .limit(20)
      .get();
    for (const rollout of active.docs) {
      try {
        await monitorOneRollout(rollout.ref, rollout.data() as PilotRolloutData);
      } catch (error) {
        const observedAt = Timestamp.now();
        await db.collection("pilotAlerts").add({
          companyId: String(rollout.data().companyId ?? ""),
          rolloutId: rollout.id,
          releaseId: String(rollout.data().releaseId ?? ""),
          action: "pause",
          recovery: false,
          monitorFailure: true,
          errorCode: "monitor_execution_failed",
          observedAt,
        });
        console.error("pilot_monitor_failed", {
          rolloutId: rollout.id,
          error: error instanceof Error ? error.message : String(error),
        });
        await notifyAdmins({
          companyId: String(rollout.data().companyId ?? ""),
          title: "パイロット監視処理でエラーが発生しました",
          body: "安全のためPAUSE扱いにし、Cloud Functionsログを確認してください。",
          category: "pilot_monitor_failed",
          dedupeKey: `${rollout.id}_${Math.floor(Date.now() / 1_800_000)}`,
          urgent: true,
        });
      }
    }
  }
);

async function monitorOneRollout(
  rolloutRef: FirebaseFirestore.DocumentReference,
  rollout: PilotRolloutData
): Promise<void> {
  const now = Timestamp.now();
  if (rollout.endsAt && rollout.endsAt.toMillis() <= now.toMillis()) {
    const controlRef = db.collection("pilotRolloutControls").doc(rollout.companyId);
    const batch = db.batch();
    batch.set(rolloutRef, {
      status: "review_required",
      completedAt: now,
      updatedAt: now,
    }, { merge: true });
    batch.set(controlRef, { activeRolloutId: null, updatedAt: now }, { merge: true });
    await batch.commit();
    await notifyAdmins({
      companyId: rollout.companyId,
      title: "パイロット期間が終了しました",
      body: "次段階へ進めず、請求・給与・PDF・メール差異を集計してください。",
      category: "pilot_review_required",
      dedupeKey: rolloutRef.id,
      urgent: true,
    });
    return;
  }

  const [
    sheetWriteBlocked,
    sheetWriteDeadLetters,
    rowCreationBlocked,
    rowCreationDeadLetters,
    sheetRetrying,
    rowRetrying,
    rowManual,
    monthManual,
    notificationErrors,
    inviteFailures,
    participantState,
  ] = await Promise.all([
    countCompanyStatus("sheetSyncQueue", rollout.companyId, ["blocked"]),
    countCompanyStatus("sheetSyncQueue", rollout.companyId, ["dead_letter"]),
    countCompanyStatus("sheetRowCreateQueue", rollout.companyId, ["blocked"]),
    countCompanyStatus("sheetRowCreateQueue", rollout.companyId, ["dead_letter"]),
    countCompanyStatus("sheetSyncQueue", rollout.companyId, ["retry_wait"]),
    countCompanyStatus("sheetRowCreateQueue", rollout.companyId, ["retry_wait"]),
    countCompanyStatus("sheetRowManualInterventions", rollout.companyId, ["open"]),
    countCompanyStatus("monthSheetManualInterventions", rollout.companyId, ["open"]),
    countCompanyStatus("notificationQueue", rollout.companyId, ["error"], rollout.startedAt),
    countInviteFailures(rollout.inviteBatchId ?? ""),
    participantStatus(rollout.participantIds),
  ]);

  const graceActive = Boolean(
    rollout.activationGraceUntil && rollout.activationGraceUntil.toMillis() > now.toMillis()
  );
  const snapshot: PilotMonitoringSnapshot = {
    sheetWriteBlocked,
    sheetWriteDeadLetters,
    rowCreationBlocked,
    rowCreationDeadLetters,
    manualInterventions: rowManual + monthManual,
    notificationErrors,
    inviteFailures,
    retryingQueues: sheetRetrying + rowRetrying,
    unactivatedParticipants: graceActive ? 0 : participantState.unactivated,
    inactiveParticipants: participantState.inactive,
  };
  const thresholds = normalizeThresholds(rollout.monitoringThresholds);
  const result = evaluatePilotMonitoring(snapshot, thresholds);
  const previous = rollout.lastHealth;
  const runRef = db.collection("pilotHealthRuns").doc();
  const update: Record<string, unknown> = {
    lastHealth: {
      ...result,
      observedAt: now,
    },
    updatedAt: now,
  };
  await runRef.set({
    companyId: rollout.companyId,
    rolloutId: rolloutRef.id,
    releaseId: rollout.releaseId,
    snapshot,
    thresholds,
    ...result,
    observedAt: now,
  });

  const cooldownMs = Math.max(5, rollout.alertCooldownMinutes ?? 30) * 60_000;
  const alertExpired = !rollout.lastAlertAt || now.toMillis() - rollout.lastAlertAt.toMillis() >= cooldownMs;
  const changed = rollout.lastAlertFingerprint !== result.fingerprint;
  const recovery = result.action === "continue" && previous?.action && previous.action !== "continue";
  const shouldAlert = result.action !== "continue" && (changed || alertExpired);

  if (shouldAlert || recovery) {
    const alertRef = db.collection("pilotAlerts").doc();
    await alertRef.set({
      companyId: rollout.companyId,
      rolloutId: rolloutRef.id,
      releaseId: rollout.releaseId,
      action: result.action,
      recovery,
      alerts: result.alerts,
      fingerprint: result.fingerprint,
      observedAt: now,
    });
    await notifyAdmins({
      companyId: rollout.companyId,
      title: recovery
        ? "パイロット監視が正常へ戻りました"
        : result.action === "pause" ? "パイロット PAUSE判定" : "パイロット WATCH判定",
      body: recovery
        ? "自動監視10項目が正常です。拡大は手動承認まで行いません。"
        : result.alerts.map((alert) => `${alert.label} ${alert.value}件`).join(" / "),
      category: recovery ? "pilot_recovered" : `pilot_${result.action}`,
      dedupeKey: alertRef.id,
      urgent: result.action === "pause",
    });
    update.lastAlertAt = now;
    update.lastAlertFingerprint = result.fingerprint;
  }
  await rolloutRef.set(update, { merge: true });

  const log = {
    rolloutId: rolloutRef.id,
    releaseId: rollout.releaseId,
    action: result.action,
    alertKeys: result.alerts.map((alert) => alert.key),
  };
  if (result.action === "pause") console.error("pilot_health_pause", log);
  else if (result.action === "watch") console.warn("pilot_health_watch", log);
  else console.info("pilot_health_continue", log);
}

async function assertEligibleParticipants(companyId: string, staffIds: string[]): Promise<void> {
  const refs = staffIds.map((id) => db.collection("staffProfiles").doc(id));
  const profiles = await db.getAll(...refs);
  const invalid = profiles.filter((profile) => {
    const data = profile.data();
    const emails = Array.isArray(data?.emails) ? data.emails.filter(Boolean) : [];
    return !profile.exists || data?.companyId !== companyId || data?.active !== true || !emails.length;
  });
  if (invalid.length) {
    throw new HttpsError(
      "failed-precondition",
      "参加者は同一企業の有効スタッフで、メールアドレス登録済みである必要があります。"
    );
  }
}

async function assertPilotSafetyGate(companyId: string): Promise<void> {
  const [
    feature,
    mapping,
    shiftConfig,
    staffConfig,
    sheetBlocked,
    sheetDead,
    rowBlocked,
    rowDead,
    rowManual,
    monthManual,
  ] = await Promise.all([
    db.collection("companyFeatureSettings").doc(companyId).get(),
    db.doc(`companies/${companyId}/sheetMappings/shift`).get(),
    db.collection("sheetImportConfigs").doc(companyId).get(),
    db.collection("staffImportConfigs").doc(companyId).get(),
    countCompanyStatus("sheetSyncQueue", companyId, ["blocked"]),
    countCompanyStatus("sheetSyncQueue", companyId, ["dead_letter"]),
    countCompanyStatus("sheetRowCreateQueue", companyId, ["blocked"]),
    countCompanyStatus("sheetRowCreateQueue", companyId, ["dead_letter"]),
    countCompanyStatus("sheetRowManualInterventions", companyId, ["open"]),
    countCompanyStatus("monthSheetManualInterventions", companyId, ["open"]),
  ]);
  const mappingData = mapping.data();
  const safe =
    feature.data()?.adminJobCreationSourceReady === true &&
    mapping.exists &&
    mappingData?.enabled === true &&
    mappingData?.rowCreation?.enabled === true &&
    Boolean(mappingData?.idColumn && mappingData?.columns?.caseId) &&
    shiftConfig.data()?.enabled === true &&
    staffConfig.data()?.enabled === true &&
    sheetBlocked + sheetDead + rowBlocked + rowDead + rowManual + monthManual === 0;
  if (!safe) {
    throw new HttpsError(
      "failed-precondition",
      "本番導入チェックまたは未解決キューが不合格です。すべて解消してから開始してください。"
    );
  }
}

async function countCompanyStatus(
  collection: string,
  companyId: string,
  statuses: string[],
  since?: Timestamp
): Promise<number> {
  if (!statuses.length) return 0;
  let query: FirebaseFirestore.Query = db.collection(collection)
    .where("companyId", "==", companyId)
    .where("status", statuses.length === 1 ? "==" : "in", statuses.length === 1 ? statuses[0]! : statuses);
  if (since) query = query.where("createdAt", ">=", since);
  query = query.limit(101);
  return (await query.get()).size;
}

async function countInviteFailures(batchId: string): Promise<number> {
  if (!batchId) return 1;
  const snap = await db.collection("loginInviteDeliveries")
    .where("batchId", "==", batchId)
    .where("status", "==", "failed")
    .limit(101)
    .get();
  return snap.size;
}

async function participantStatus(staffIds: string[]): Promise<{ unactivated: number; inactive: number }> {
  const refs = staffIds.map((id) => db.collection("staffProfiles").doc(id));
  const profiles = refs.length ? await db.getAll(...refs) : [];
  return {
    unactivated: profiles.filter((profile) => !profile.exists || !profile.data()?.lastLoginAt).length,
    inactive: profiles.filter((profile) => !profile.exists || profile.data()?.active !== true).length,
  };
}

function normalizeThresholds(input?: Partial<PilotMonitoringThresholds>): PilotMonitoringThresholds {
  const defaults = defaultPilotMonitoringThresholds();
  for (const key of Object.keys(defaults) as Array<keyof PilotMonitoringThresholds>) {
    const value = input?.[key];
    if (Number.isFinite(value) && Number(value) >= 0) defaults[key] = Number(value);
  }
  return defaults;
}

async function notifyAdmins(input: {
  companyId: string;
  title: string;
  body: string;
  category: string;
  dedupeKey: string;
  urgent?: boolean;
}): Promise<void> {
  try {
    await enqueueNotification({
      companyId: input.companyId,
      targetRole: "admin",
      title: input.title,
      body: input.body.slice(0, 500),
      route: "/",
      category: input.category,
      dedupeKey: input.dedupeKey,
      bypassQuietHours: input.urgent === true,
    });
  } catch (error) {
    console.error("pilot_admin_notification_failed", {
      category: input.category,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function assertStagingRuntime(): void {
  const environment = process.env.APP_ENVIRONMENT ?? "development";
  if (environment !== "staging") {
    throw new HttpsError("failed-precondition", "パイロット配布はstaging環境だけで実行できます。");
  }
}

function iso(value?: Timestamp): string | null {
  return value ? value.toDate().toISOString() : null;
}
