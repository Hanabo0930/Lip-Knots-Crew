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
} from "./pilot-rollout-core";
import {
  buildStagedWavePlan,
  evaluateNextStagedWave,
  StagedRolloutGateInput,
  StagedWave,
} from "./staged-rollout-core";
import { companyFromClaims, requireAdmin, requestId } from "./utils";

const CreateSchema = z.object({
  pilotRolloutId: z.string().min(1).max(160),
  staffIds: z.array(z.string().min(1).max(160)).min(30).max(50)
    .refine((ids) => new Set(ids).size === ids.length, "参加者が重複しています。"),
  subject: z.string().min(1).max(150),
  introText: z.string().max(3000).default(""),
  observationHours: z.number().int().min(12).max(72).default(24),
  requiredContinueRuns: z.number().int().min(6).max(36).default(12),
});

const GetSchema = z.object({
  stagedRolloutId: z.string().min(1).max(160).optional(),
});

const RolloutSchema = z.object({
  stagedRolloutId: z.string().min(1).max(160),
});

const StopSchema = RolloutSchema.extend({
  reason: z.string().min(1).max(500),
});

type StagedRolloutRecord = {
  companyId: string;
  pilotRolloutId: string;
  releaseId: string;
  approvalFingerprint: string;
  participantIds: string[];
  targetCount: number;
  wavePlan: StagedWave[];
  subject: string;
  introText: string;
  observationHours: number;
  requiredContinueRuns: number;
  status: "ready" | "wave_preparing" | "observing" | "paused" | "stopped" | "completed";
  currentWave: number;
  deliveredCount: number;
  consecutiveContinueRuns: number;
  criticalAlertCount: number;
  monitorFailureCount: number;
  inviteFailureCount: number;
  waveBatchIds?: string[];
  currentWaveStartedAt?: Timestamp;
  lastHealth?: {
    action?: "continue" | "watch" | "pause";
    observedAt?: Timestamp;
    alerts?: Array<{ key?: string; label?: string; value?: number; threshold?: number; severity?: string }>;
    fingerprint?: string;
  };
  lastAlertAt?: Timestamp;
  lastAlertFingerprint?: string;
  waveReservationToken?: string;
  createdAt?: Timestamp;
};

type ApprovalRecord = {
  companyId?: string;
  rolloutId?: string;
  releaseId?: string;
  scope?: string;
  fingerprint?: string;
  stagedRolloutId?: string;
};

export const createStagedRollout = onCall(async (request) => {
  assertStagingRuntime();
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = CreateSchema.parse(request.data ?? {});
  await assertEligibleParticipants(companyId, input.staffIds);
  const rolloutRef = db.collection("stagedRollouts").doc();
  const pilotRef = db.collection("pilotRollouts").doc(input.pilotRolloutId);
  const approvalRef = db.collection("pilotExpansionApprovals").doc(input.pilotRolloutId);
  const controlRef = db.collection("stagedRolloutControls").doc(companyId);
  const now = Timestamp.now();
  const wavePlan = buildStagedWavePlan(input.staffIds.length);

  await db.runTransaction(async (tx) => {
    const [pilot, approval, control] = await Promise.all([
      tx.get(pilotRef),
      tx.get(approvalRef),
      tx.get(controlRef),
    ]);
    const approvalData = approval.data() as ApprovalRecord | undefined;
    if (!pilot.exists || pilot.data()?.companyId !== companyId || pilot.data()?.status !== "expansion_approved") {
      throw new HttpsError("failed-precondition", "承認済みの3〜5名パイロットが必要です。");
    }
    if (!approval.exists || approvalData?.companyId !== companyId || approvalData.scope !== "staff_30_50" ||
        !approvalData.fingerprint || approvalData.fingerprint !== pilot.data()?.expansionGateFingerprint) {
      throw new HttpsError("failed-precondition", "有効な30〜50名移行承認がありません。");
    }
    if (approvalData.stagedRolloutId) {
      throw new HttpsError("already-exists", "この承認は段階配布に使用済みです。");
    }
    if (control.data()?.activeRolloutId) {
      throw new HttpsError("already-exists", "進行中の30〜50名段階配布があります。");
    }
    tx.create(rolloutRef, {
      companyId,
      pilotRolloutId: input.pilotRolloutId,
      releaseId: String(approvalData.releaseId ?? pilot.data()?.releaseId ?? ""),
      approvalFingerprint: approvalData.fingerprint,
      participantIds: input.staffIds,
      targetCount: input.staffIds.length,
      wavePlan,
      subject: input.subject,
      introText: input.introText,
      observationHours: input.observationHours,
      requiredContinueRuns: input.requiredContinueRuns,
      status: "ready",
      currentWave: 0,
      deliveredCount: 0,
      consecutiveContinueRuns: 0,
      criticalAlertCount: 0,
      monitorFailureCount: 0,
      inviteFailureCount: 0,
      waveBatchIds: [],
      environment: "staging",
      createdBy: session.uid,
      createdAt: now,
      updatedAt: now,
    });
    tx.set(approvalRef, { stagedRolloutId: rolloutRef.id, stagedRolloutCreatedAt: now }, { merge: true });
    tx.set(controlRef, { companyId, activeRolloutId: rolloutRef.id, updatedAt: now }, { merge: true });
    tx.set(db.collection("auditLogs").doc(), {
      companyId,
      actorUid: session.uid,
      action: "staged_rollout.created",
      stagedRolloutId: rolloutRef.id,
      pilotRolloutId: input.pilotRolloutId,
      targetCount: input.staffIds.length,
      waveSizes: wavePlan.map((wave) => wave.size),
      approvalFingerprint: approvalData.fingerprint,
      requestId: requestId("staged_rollout"),
      createdAt: now,
    });
  });

  await notifyAdmins({
    companyId,
    title: "30〜50名段階配布を準備しました",
    body: `${input.staffIds.length}名を${wavePlan.map((wave) => wave.size).join("→")}名の3waveで配布します。初回waveは手動開始です。`,
    category: "staged_rollout_created",
    dedupeKey: rolloutRef.id,
  });
  return { stagedRolloutId: rolloutRef.id, status: "ready", targetCount: input.staffIds.length, wavePlan };
});

export const getStagedRolloutStatus = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = GetSchema.parse(request.data ?? {});
  const snap = await findStagedRollout(companyId, input.stagedRolloutId);
  if (!snap) return { rollout: null };
  const data = snap.data() as StagedRolloutRecord;
  const approval = await db.collection("pilotExpansionApprovals").doc(data.pilotRolloutId).get();
  const gate = gateFor(data, approvalValid(approval.data() as ApprovalRecord | undefined, companyId, snap.id), Date.now());
  return { rollout: safeRollout(snap.id, data, gate) };
});

export const releaseNextStagedWave = onCall(
  { secrets: [gmailServiceAccountJson], timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    assertStagingRuntime();
    const session = requireAdmin(request);
    const companyId = companyFromClaims(session.token);
    const input = RolloutSchema.parse(request.data ?? {});
    const rolloutRef = db.collection("stagedRollouts").doc(input.stagedRolloutId);
    const approvalRef = db.collection("pilotExpansionApprovals");
    const reservationToken = requestId("wave");
    const reserved = await db.runTransaction(async (tx) => {
      const current = await tx.get(rolloutRef);
      if (!current.exists || current.data()?.companyId !== companyId) {
        throw new HttpsError("not-found", "段階配布が見つかりません。");
      }
      const data = current.data() as StagedRolloutRecord;
      const approval = await tx.get(approvalRef.doc(data.pilotRolloutId));
      const gate = gateFor(data, approvalValid(approval.data() as ApprovalRecord | undefined, companyId, current.id), Date.now());
      if (!gate.allowed || !gate.nextWave) {
        throw new HttpsError("failed-precondition", `次waveを開始できません：${gate.blockers.map((item) => item.label).join(" / ")}`);
      }
      tx.set(rolloutRef, {
        status: "wave_preparing",
        waveReservationToken: reservationToken,
        waveGateFingerprint: gate.fingerprint,
        waveReservedBy: session.uid,
        waveReservedAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      }, { merge: true });
      return { data, gate };
    });
    const wave = reserved.gate.nextWave!;
    const waveStaffIds = reserved.data.participantIds.slice(wave.startOffset, wave.startOffset + wave.size);
    let invites: Awaited<ReturnType<typeof sendLoginInviteBatch>>;
    try {
      invites = await sendLoginInviteBatch({
        companyId,
        actorUid: session.uid,
        staffIds: waveStaffIds,
        subject: reserved.data.subject,
        introText: reserved.data.introText,
        source: `staged_rollout_wave_${wave.waveNumber}`,
        shouldContinue: async () => {
          const current = await rolloutRef.get();
          return current.data()?.status === "wave_preparing" && current.data()?.waveReservationToken === reservationToken;
        },
      });
    } catch (error) {
      await pauseAfterWaveFailure(rolloutRef, reserved.data, companyId, wave, reservationToken, "invite_batch_failed", 1);
      throw new HttpsError("internal", "wave配布処理に失敗し、段階配布をPAUSEしました。");
    }

    const now = Timestamp.now();
    const success = !invites.aborted && invites.failedStaff === 0 && invites.successStaff === wave.size;
    const waveRef = db.collection("stagedRolloutWaves").doc(`${input.stagedRolloutId}_${wave.waveNumber}`);
    await db.runTransaction(async (tx) => {
      const current = await tx.get(rolloutRef);
      if (!current.exists) throw new HttpsError("not-found", "段階配布が見つかりません。");
      const currentData = current.data() as StagedRolloutRecord;
      const reservationStillActive = currentData.status === "wave_preparing" && currentData.waveReservationToken === reservationToken;
      tx.set(waveRef, {
        companyId,
        stagedRolloutId: input.stagedRolloutId,
        waveNumber: wave.waveNumber,
        plannedCount: wave.size,
        successStaff: invites.successStaff,
        failedStaff: invites.failedStaff,
        cancelledStaff: invites.cancelledStaff,
        batchId: invites.batchId,
        status: success && reservationStillActive ? "observing" : invites.aborted ? "aborted" : "paused",
        gateFingerprint: reserved.gate.fingerprint,
        startedBy: session.uid,
        startedAt: now,
      });
      if (success && reservationStillActive) {
        tx.set(rolloutRef, {
          status: "observing",
          currentWave: wave.waveNumber,
          deliveredCount: wave.cumulativeCount,
          currentWaveStartedAt: now,
          consecutiveContinueRuns: 0,
          lastHealth: null,
          waveBatchIds: FieldValue.arrayUnion(invites.batchId),
          waveReservationToken: null,
          updatedAt: now,
        }, { merge: true });
      } else if (reservationStillActive) {
        tx.set(rolloutRef, {
          status: "paused",
          deliveredCount: currentData.deliveredCount + invites.successStaff,
          inviteFailureCount: currentData.inviteFailureCount + Math.max(1, invites.failedStaff + invites.cancelledStaff),
          pausedReason: invites.aborted ? "wave_cancelled" : "wave_invite_failed",
          pausedAt: now,
          waveBatchIds: FieldValue.arrayUnion(invites.batchId),
          waveReservationToken: null,
          updatedAt: now,
        }, { merge: true });
      } else {
        tx.set(rolloutRef, {
          deliveredCount: currentData.deliveredCount + invites.successStaff,
          inviteFailureCount: currentData.inviteFailureCount + invites.failedStaff,
          waveBatchIds: FieldValue.arrayUnion(invites.batchId),
          lastWaveFinishedAfterStop: true,
          updatedAt: now,
        }, { merge: true });
      }
      tx.set(db.collection("auditLogs").doc(), {
        companyId,
        actorUid: session.uid,
        action: success && reservationStillActive ? "staged_rollout.wave_released" : "staged_rollout.wave_interrupted",
        stagedRolloutId: input.stagedRolloutId,
        waveNumber: wave.waveNumber,
        plannedCount: wave.size,
        successStaff: invites.successStaff,
        failedStaff: invites.failedStaff,
        cancelledStaff: invites.cancelledStaff,
        batchId: invites.batchId,
        requestId: requestId("staged_rollout"),
        createdAt: now,
      });
    });

    if (!success) {
      await notifyAdmins({
        companyId,
        title: "段階配布waveを停止しました",
        body: `wave ${wave.waveNumber}：成功${invites.successStaff}名・失敗${invites.failedStaff}名・中止${invites.cancelledStaff}名。自動再開しません。`,
        category: "staged_rollout_wave_paused",
        dedupeKey: `${input.stagedRolloutId}_${wave.waveNumber}`,
        urgent: true,
      });
      return { status: invites.aborted ? "stopped" : "paused", waveNumber: wave.waveNumber, ...invites };
    }
    await notifyAdmins({
      companyId,
      title: `段階配布 wave ${wave.waveNumber} を開始しました`,
      body: `${wave.size}名へ配布済み。${reserved.data.observationHours}時間の5分監視後に次waveを判定します。`,
      category: "staged_rollout_wave_started",
      dedupeKey: `${input.stagedRolloutId}_${wave.waveNumber}`,
    });
    return { status: "observing", waveNumber: wave.waveNumber, deliveredCount: wave.cumulativeCount, ...invites };
  }
);

export const stopStagedRollout = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = StopSchema.parse(request.data ?? {});
  const rolloutRef = db.collection("stagedRollouts").doc(input.stagedRolloutId);
  const controlRef = db.collection("stagedRolloutControls").doc(companyId);
  const now = Timestamp.now();
  const stopped = await db.runTransaction(async (tx) => {
    const rollout = await tx.get(rolloutRef);
    if (!rollout.exists || rollout.data()?.companyId !== companyId) {
      throw new HttpsError("not-found", "段階配布が見つかりません。");
    }
    const status = String(rollout.data()?.status ?? "");
    if (["stopped", "completed"].includes(status)) return false;
    tx.set(rolloutRef, {
      status: "stopped",
      stoppedReason: input.reason,
      stoppedBy: session.uid,
      stoppedAt: now,
      waveReservationToken: null,
      updatedAt: now,
    }, { merge: true });
    tx.set(controlRef, { activeRolloutId: null, updatedAt: now }, { merge: true });
    tx.set(db.collection("auditLogs").doc(), {
      companyId,
      actorUid: session.uid,
      action: "staged_rollout.stopped",
      stagedRolloutId: input.stagedRolloutId,
      previousStatus: status,
      reason: input.reason,
      requestId: requestId("staged_rollout"),
      createdAt: now,
    });
    return true;
  });
  if (stopped) await notifyAdmins({
    companyId,
    title: "30〜50名段階配布を停止しました",
    body: input.reason,
    category: "staged_rollout_stopped",
    dedupeKey: input.stagedRolloutId,
    urgent: true,
  });
  return { stopped };
});

export const monitorStagedRolloutHealth = onSchedule(
  { schedule: "every 5 minutes", timeZone: "Asia/Tokyo", timeoutSeconds: 300, memory: "1GiB", maxInstances: 1 },
  async () => {
    const active = await db.collection("stagedRollouts").where("status", "==", "observing").limit(20).get();
    for (const rollout of active.docs) {
      try {
        await monitorOneStagedRollout(rollout.ref, rollout.data() as StagedRolloutRecord);
      } catch (error) {
        await pauseForMonitorFailure(rollout.ref, rollout.data() as StagedRolloutRecord, error);
      }
    }
  }
);

async function monitorOneStagedRollout(
  rolloutRef: FirebaseFirestore.DocumentReference,
  rollout: StagedRolloutRecord
): Promise<void> {
  const now = Timestamp.now();
  const deliveredIds = rollout.participantIds.slice(0, rollout.deliveredCount);
  const elapsedHours = rollout.currentWaveStartedAt
    ? (now.toMillis() - rollout.currentWaveStartedAt.toMillis()) / 3_600_000
    : 0;
  const [
    sheetWriteBlocked, sheetWriteDeadLetters, rowCreationBlocked, rowCreationDeadLetters,
    sheetRetrying, rowRetrying, rowManual, monthManual, notificationErrors,
    inviteFailures, participantState,
  ] = await Promise.all([
    countCompanyStatus("sheetSyncQueue", rollout.companyId, ["blocked"]),
    countCompanyStatus("sheetSyncQueue", rollout.companyId, ["dead_letter"]),
    countCompanyStatus("sheetRowCreateQueue", rollout.companyId, ["blocked"]),
    countCompanyStatus("sheetRowCreateQueue", rollout.companyId, ["dead_letter"]),
    countCompanyStatus("sheetSyncQueue", rollout.companyId, ["retry_wait"]),
    countCompanyStatus("sheetRowCreateQueue", rollout.companyId, ["retry_wait"]),
    countCompanyStatus("sheetRowManualInterventions", rollout.companyId, ["open"]),
    countCompanyStatus("monthSheetManualInterventions", rollout.companyId, ["open"]),
    countCompanyStatus("notificationQueue", rollout.companyId, ["error"], rollout.currentWaveStartedAt),
    countInviteFailures(rollout.waveBatchIds ?? []),
    participantStatus(deliveredIds),
  ]);
  const snapshot: PilotMonitoringSnapshot = {
    sheetWriteBlocked,
    sheetWriteDeadLetters,
    rowCreationBlocked,
    rowCreationDeadLetters,
    manualInterventions: rowManual + monthManual,
    notificationErrors,
    inviteFailures,
    retryingQueues: sheetRetrying + rowRetrying,
    unactivatedParticipants: elapsedHours >= rollout.observationHours ? participantState.unactivated : 0,
    inactiveParticipants: participantState.inactive,
  };
  const result = evaluatePilotMonitoring(snapshot, defaultPilotMonitoringThresholds());
  const runRef = db.collection("stagedRolloutHealthRuns").doc();
  await runRef.set({
    companyId: rollout.companyId,
    stagedRolloutId: rolloutRef.id,
    waveNumber: rollout.currentWave,
    snapshot,
    ...result,
    observedAt: now,
  });
  const previous = rollout.lastHealth;
  const nextStreak = result.action === "continue" ? rollout.consecutiveContinueRuns + 1 : 0;
  let nextStatus: StagedRolloutRecord["status"] = result.action === "pause" ? "paused" : "observing";
  if (result.action === "continue" && elapsedHours >= rollout.observationHours && nextStreak >= rollout.requiredContinueRuns) {
    nextStatus = rollout.currentWave >= rollout.wavePlan.length ? "completed" : "ready";
  }
  const update: Record<string, unknown> = {
    status: nextStatus,
    consecutiveContinueRuns: nextStreak,
    lastHealth: { ...result, observedAt: now },
    inviteFailureCount: Math.max(rollout.inviteFailureCount, inviteFailures),
    criticalAlertCount: rollout.criticalAlertCount + (result.action === "pause" ? 1 : 0),
    updatedAt: now,
  };
  if (nextStatus === "paused") {
    update.pausedReason = "health_pause";
    update.pausedAt = now;
  }
  if (nextStatus === "completed") update.completedAt = now;

  const changed = rollout.lastAlertFingerprint !== result.fingerprint;
  const alertExpired = !rollout.lastAlertAt || now.toMillis() - rollout.lastAlertAt.toMillis() >= 30 * 60_000;
  const recovery = result.action === "continue" && previous?.action === "watch";
  if ((result.action !== "continue" && (changed || alertExpired)) || recovery) {
    const alertRef = db.collection("stagedRolloutAlerts").doc();
    await alertRef.set({
      companyId: rollout.companyId,
      stagedRolloutId: rolloutRef.id,
      waveNumber: rollout.currentWave,
      action: result.action,
      recovery,
      alerts: result.alerts,
      fingerprint: result.fingerprint,
      observedAt: now,
    });
    await notifyAdmins({
      companyId: rollout.companyId,
      title: recovery ? "段階配布監視が正常へ戻りました" : `段階配布 ${result.action.toUpperCase()}判定`,
      body: recovery ? "連続CONTINUEの再計測を開始します。" : result.alerts.map((alert) => `${alert.label} ${alert.value}件`).join(" / "),
      category: recovery ? "staged_rollout_recovered" : `staged_rollout_${result.action}`,
      dedupeKey: alertRef.id,
      urgent: result.action === "pause",
    });
    update.lastAlertAt = now;
    update.lastAlertFingerprint = result.fingerprint;
  }
  const updateBatch = db.batch();
  updateBatch.set(rolloutRef, update, { merge: true });
  if (nextStatus === "completed") {
    updateBatch.set(db.collection("stagedRolloutControls").doc(rollout.companyId), {
      activeRolloutId: null,
      updatedAt: now,
    }, { merge: true });
  }
  await updateBatch.commit();

  if (nextStatus === "ready") {
    await notifyAdmins({
      companyId: rollout.companyId,
      title: "次の段階配布waveを開始できます",
      body: `${rollout.observationHours}時間の観察と連続${rollout.requiredContinueRuns}回CONTINUEを満たしました。開始は管理画面で手動実行してください。`,
      category: "staged_rollout_next_ready",
      dedupeKey: `${rolloutRef.id}_${rollout.currentWave}`,
    });
  } else if (nextStatus === "completed") {
    await notifyAdmins({
      companyId: rollout.companyId,
      title: "30〜50名段階配布が完了しました",
      body: `${rollout.targetCount}名への3wave配布と最終観察が完了しました。`,
      category: "staged_rollout_completed",
      dedupeKey: rolloutRef.id,
    });
  }
}

async function pauseAfterWaveFailure(
  rolloutRef: FirebaseFirestore.DocumentReference,
  rollout: StagedRolloutRecord,
  companyId: string,
  wave: StagedWave,
  reservationToken: string,
  reason: string,
  failures: number
): Promise<void> {
  const now = Timestamp.now();
  const current = await rolloutRef.get();
  if (current.data()?.status === "wave_preparing" && current.data()?.waveReservationToken === reservationToken) {
    await rolloutRef.set({
      status: "paused",
      inviteFailureCount: rollout.inviteFailureCount + failures,
      pausedReason: reason,
      pausedAt: now,
      waveReservationToken: null,
      updatedAt: now,
    }, { merge: true });
  }
  await db.collection("stagedRolloutAlerts").add({
    companyId,
    stagedRolloutId: rolloutRef.id,
    waveNumber: wave.waveNumber,
    action: "pause",
    inviteFailure: true,
    reason,
    observedAt: now,
  });
}

async function pauseForMonitorFailure(
  rolloutRef: FirebaseFirestore.DocumentReference,
  rollout: StagedRolloutRecord,
  error: unknown
): Promise<void> {
  const now = Timestamp.now();
  await rolloutRef.set({
    status: "paused",
    monitorFailureCount: rollout.monitorFailureCount + 1,
    pausedReason: "monitor_execution_failed",
    pausedAt: now,
    lastHealth: { action: "pause", observedAt: now, alerts: [] },
    updatedAt: now,
  }, { merge: true });
  await db.collection("stagedRolloutAlerts").add({
    companyId: rollout.companyId,
    stagedRolloutId: rolloutRef.id,
    waveNumber: rollout.currentWave,
    action: "pause",
    monitorFailure: true,
    reason: "monitor_execution_failed",
    observedAt: now,
  });
  console.error("staged_rollout_monitor_failed", {
    stagedRolloutId: rolloutRef.id,
    error: error instanceof Error ? error.message : String(error),
  });
  await notifyAdmins({
    companyId: rollout.companyId,
    title: "段階配布監視処理をPAUSEしました",
    body: "監視処理失敗を検知しました。自動再開しません。Cloud Functionsログを確認してください。",
    category: "staged_rollout_monitor_failed",
    dedupeKey: `${rolloutRef.id}_${rollout.currentWave}`,
    urgent: true,
  });
}

function gateFor(data: StagedRolloutRecord, validApproval: boolean, nowMs: number) {
  const hoursObserved = data.currentWaveStartedAt
    ? Math.max(0, nowMs - data.currentWaveStartedAt.toMillis()) / 3_600_000
    : 0;
  const action = data.lastHealth?.action ?? "missing";
  const input: StagedRolloutGateInput = {
    approvalValid: validApproval,
    status: data.status,
    targetCount: data.targetCount,
    currentWave: data.currentWave,
    deliveredCount: data.deliveredCount,
    observationHoursRequired: data.observationHours,
    hoursObserved,
    requiredContinueRuns: data.requiredContinueRuns,
    consecutiveContinueRuns: data.consecutiveContinueRuns,
    criticalAlerts: data.criticalAlertCount,
    monitorFailures: data.monitorFailureCount,
    inviteFailures: data.inviteFailureCount,
    lastHealthAction: action,
  };
  return evaluateNextStagedWave(input);
}

function approvalValid(data: ApprovalRecord | undefined, companyId: string, stagedRolloutId: string): boolean {
  return Boolean(data && data.companyId === companyId && data.scope === "staff_30_50" &&
    data.fingerprint && data.stagedRolloutId === stagedRolloutId);
}

function safeRollout(id: string, data: StagedRolloutRecord, gate: ReturnType<typeof evaluateNextStagedWave>) {
  return {
    stagedRolloutId: id,
    pilotRolloutId: data.pilotRolloutId,
    releaseId: data.releaseId,
    status: data.status,
    targetCount: data.targetCount,
    wavePlan: data.wavePlan,
    currentWave: data.currentWave,
    deliveredCount: data.deliveredCount,
    observationHours: data.observationHours,
    requiredContinueRuns: data.requiredContinueRuns,
    consecutiveContinueRuns: data.consecutiveContinueRuns,
    criticalAlertCount: data.criticalAlertCount,
    monitorFailureCount: data.monitorFailureCount,
    inviteFailureCount: data.inviteFailureCount,
    currentWaveStartedAt: iso(data.currentWaveStartedAt),
    lastHealth: data.lastHealth ? {
      action: data.lastHealth.action ?? "missing",
      observedAt: iso(data.lastHealth.observedAt),
      alerts: data.lastHealth.alerts ?? [],
    } : null,
    gate,
  };
}

async function findStagedRollout(companyId: string, stagedRolloutId?: string) {
  if (stagedRolloutId) {
    const snap = await db.collection("stagedRollouts").doc(stagedRolloutId).get();
    return snap.exists && snap.data()?.companyId === companyId ? snap : null;
  }
  const control = await db.collection("stagedRolloutControls").doc(companyId).get();
  const activeId = String(control.data()?.activeRolloutId ?? "");
  if (activeId) {
    const active = await db.collection("stagedRollouts").doc(activeId).get();
    if (active.exists && active.data()?.companyId === companyId) return active;
  }
  const latest = await db.collection("stagedRollouts").where("companyId", "==", companyId)
    .orderBy("createdAt", "desc").limit(1).get();
  return latest.docs[0] ?? null;
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
    throw new HttpsError("failed-precondition", "参加者は同一企業の有効スタッフで、メールアドレス登録済みである必要があります。");
  }
}

async function countCompanyStatus(
  collection: string,
  companyId: string,
  statuses: string[],
  since?: Timestamp
): Promise<number> {
  let query: FirebaseFirestore.Query = db.collection(collection)
    .where("companyId", "==", companyId)
    .where("status", statuses.length === 1 ? "==" : "in", statuses.length === 1 ? statuses[0]! : statuses);
  if (since) query = query.where("createdAt", ">=", since);
  return (await query.limit(101).get()).size;
}

async function countInviteFailures(batchIds: string[]): Promise<number> {
  const counts = await Promise.all(batchIds.map(async (batchId) => {
    const snap = await db.collection("loginInviteDeliveries").where("batchId", "==", batchId)
      .where("status", "==", "failed").limit(101).get();
    return snap.size;
  }));
  return counts.reduce((sum, value) => sum + value, 0);
}

async function participantStatus(staffIds: string[]): Promise<{ inactive: number; unactivated: number }> {
  const refs = staffIds.map((id) => db.collection("staffProfiles").doc(id));
  const profiles = refs.length ? await db.getAll(...refs) : [];
  return {
    inactive: profiles.filter((profile) => !profile.exists || profile.data()?.active !== true).length,
    unactivated: profiles.filter((profile) => !profile.exists || !profile.data()?.lastLoginAt).length,
  };
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
    console.error("staged_rollout_notification_failed", {
      category: input.category,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function assertStagingRuntime(): void {
  if ((process.env.APP_ENVIRONMENT ?? "development") !== "staging") {
    throw new HttpsError("failed-precondition", "30〜50名段階配布はstaging環境だけで実行できます。");
  }
}

function iso(value?: Timestamp): string | null {
  return value instanceof Timestamp ? value.toDate().toISOString() : null;
}
