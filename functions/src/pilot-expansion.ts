import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { enqueueNotification } from "./notification-core";
import {
  evaluatePilotExpansion,
  PilotExpansionAutomated,
  PilotOutcomeInput,
} from "./pilot-expansion-core";
import { companyFromClaims, requireAdmin, requestId } from "./utils";

const RolloutSchema = z.object({
  rolloutId: z.string().min(1).max(160).optional(),
});

const OutcomeSchema = z.object({
  rolloutId: z.string().min(1).max(160),
  totalCases: z.number().int().min(0).max(100_000),
  completedCases: z.number().int().min(0).max(100_000),
  moneyDiffYen: z.number().int().min(0).max(1_000_000_000),
  doubleBookings: z.number().int().min(0).max(100_000),
  mailTargetDiff: z.number().int().min(0).max(100_000),
  pdfDiff: z.number().int().min(0).max(100_000),
  manualQueue: z.number().int().min(0).max(100_000),
  supportCases: z.number().int().min(0).max(100_000),
  evidenceRefs: z.array(
    z.string().min(1).max(500).refine((value) => !/[\r\n\0]/u.test(value), "証拠参照が不正です。")
  ).min(1).max(20),
  notes: z.string().max(2000).refine((value) => !/[\0]/u.test(value), "備考が不正です。"),
}).refine((input) => input.completedCases <= input.totalCases, {
  message: "完了件数は検証案件数以下にしてください。",
  path: ["completedCases"],
});

const ApprovalSchema = z.object({
  rolloutId: z.string().min(1).max(160),
  decision: z.enum(["approve", "reject"]),
  note: z.string().min(1).max(1000),
});

type PilotRolloutRecord = {
  companyId?: string;
  releaseId?: string;
  participantIds?: string[];
  participantCount?: number;
  durationDays?: number;
  status?: string;
  startedAt?: Timestamp;
  endsAt?: Timestamp;
  completedAt?: Timestamp;
  inviteSummary?: { failedStaff?: number };
  lastHealth?: { action?: string; observedAt?: Timestamp };
};

type ExpansionReviewRecord = {
  companyId?: string;
  rolloutId?: string;
  releaseId?: string;
  status?: string;
  submittedBy?: string;
  submittedAt?: Timestamp;
  approvedAt?: Timestamp;
  rejectedAt?: Timestamp;
  decisionNote?: string;
  outcome?: PilotOutcomeInput;
  automated?: PilotExpansionAutomated;
  gate?: ReturnType<typeof evaluatePilotExpansion>;
  fingerprint?: string;
};

const REVIEWABLE_STATUSES = new Set([
  "review_required",
  "expansion_blocked",
  "expansion_rejected",
]);
const COMPLETED_STATUSES = new Set([
  "review_required",
  "expansion_review_pending",
  "expansion_blocked",
  "expansion_approved",
  "expansion_rejected",
]);

export const getPilotExpansionReview = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = RolloutSchema.parse(request.data ?? {});
  const rollout = await findRollout(companyId, input.rolloutId);
  if (!rollout) return { rollout: null, automated: null, review: null };
  const data = rollout.data() as PilotRolloutRecord;
  const automated = await collectAutomatedMetrics(rollout.id, data);
  const reviewSnap = await db.collection("pilotExpansionReviews").doc(rollout.id).get();
  const review = reviewSnap.exists ? reviewSnap.data() as ExpansionReviewRecord : null;
  return {
    rollout: {
      rolloutId: rollout.id,
      releaseId: String(data.releaseId ?? ""),
      status: String(data.status ?? "unknown"),
      participantCount: automated.participantCount,
      startedAt: iso(data.startedAt),
      endsAt: iso(data.endsAt),
    },
    automated,
    review: review ? safeReview(review, session.uid) : null,
  };
});

export const submitPilotOutcome = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = OutcomeSchema.parse(request.data ?? {});
  const rolloutRef = db.collection("pilotRollouts").doc(input.rolloutId);
  const rolloutSnap = await rolloutRef.get();
  if (!rolloutSnap.exists || rolloutSnap.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "パイロットが見つかりません。");
  }
  const rollout = rolloutSnap.data() as PilotRolloutRecord;
  if (!REVIEWABLE_STATUSES.has(String(rollout.status ?? ""))) {
    throw new HttpsError("failed-precondition", "このパイロットは結果提出できる状態ではありません。");
  }
  const outcome: PilotOutcomeInput = {
    totalCases: input.totalCases,
    completedCases: input.completedCases,
    moneyDiffYen: input.moneyDiffYen,
    doubleBookings: input.doubleBookings,
    mailTargetDiff: input.mailTargetDiff,
    pdfDiff: input.pdfDiff,
    manualQueue: input.manualQueue,
    supportCases: input.supportCases,
    evidenceRefs: [...new Set(input.evidenceRefs.map((value) => value.trim()).filter(Boolean))],
    notes: input.notes.trim(),
  };
  if (!outcome.evidenceRefs.length) {
    throw new HttpsError("invalid-argument", "証拠参照を1件以上入力してください。");
  }
  const automated = await collectAutomatedMetrics(input.rolloutId, rollout);
  const gate = evaluatePilotExpansion(automated, outcome);
  const now = Timestamp.now();
  const reviewStatus = gate.eligible ? "pending_approval" : "blocked";
  const rolloutStatus = gate.eligible ? "expansion_review_pending" : "expansion_blocked";
  const reviewRef = db.collection("pilotExpansionReviews").doc(input.rolloutId);

  await db.runTransaction(async (tx) => {
    const current = await tx.get(rolloutRef);
    if (!current.exists || current.data()?.companyId !== companyId) {
      throw new HttpsError("not-found", "パイロットが見つかりません。");
    }
    if (!REVIEWABLE_STATUSES.has(String(current.data()?.status ?? ""))) {
      throw new HttpsError("already-exists", "このパイロットには提出済みの結果があります。");
    }
    tx.set(reviewRef, {
      companyId,
      rolloutId: input.rolloutId,
      releaseId: String(rollout.releaseId ?? ""),
      status: reviewStatus,
      outcome,
      automated,
      gate,
      fingerprint: gate.fingerprint,
      submittedBy: session.uid,
      submittedAt: now,
      updatedAt: now,
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      decisionNote: null,
    });
    tx.set(rolloutRef, {
      status: rolloutStatus,
      expansionReviewId: input.rolloutId,
      expansionGateFingerprint: gate.fingerprint,
      updatedAt: now,
    }, { merge: true });
    tx.set(db.collection("auditLogs").doc(), {
      companyId,
      actorUid: session.uid,
      action: "pilot.expansion.outcome_submitted",
      rolloutId: input.rolloutId,
      eligible: gate.eligible,
      blockerKeys: gate.blockers.map((item) => item.key),
      warningKeys: gate.warnings.map((item) => item.key),
      fingerprint: gate.fingerprint,
      requestId: requestId("pilot_expansion"),
      createdAt: now,
    });
  });

  await notifyAdmins({
    companyId,
    title: gate.eligible ? "パイロット結果の別管理者承認が必要です" : "パイロット拡大ゲートを停止しました",
    body: gate.eligible
      ? "30〜50名への移行は、結果提出者とは別の管理者が承認するまでロックされています。"
      : `未達項目：${gate.blockers.map((item) => item.label).join(" / ")}`,
    category: gate.eligible ? "pilot_expansion_review" : "pilot_expansion_blocked",
    dedupeKey: `${input.rolloutId}_${gate.fingerprint}`,
    urgent: !gate.eligible,
  });
  return { reviewStatus, rolloutStatus, gate };
});

export const decidePilotExpansion = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = ApprovalSchema.parse(request.data ?? {});
  const rolloutRef = db.collection("pilotRollouts").doc(input.rolloutId);
  const reviewRef = db.collection("pilotExpansionReviews").doc(input.rolloutId);
  const [rolloutSnap, reviewSnap] = await Promise.all([rolloutRef.get(), reviewRef.get()]);
  if (!rolloutSnap.exists || rolloutSnap.data()?.companyId !== companyId ||
      !reviewSnap.exists || reviewSnap.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "移行審査が見つかりません。");
  }
  const rollout = rolloutSnap.data() as PilotRolloutRecord;
  const review = reviewSnap.data() as ExpansionReviewRecord;
  if (review.status !== "pending_approval" || rollout.status !== "expansion_review_pending") {
    throw new HttpsError("failed-precondition", "承認待ちの移行審査ではありません。");
  }
  if (review.submittedBy === session.uid) {
    throw new HttpsError("permission-denied", "結果提出者とは別の管理者による承認が必要です。");
  }
  if (!review.outcome || !review.fingerprint) {
    throw new HttpsError("failed-precondition", "審査データが不足しています。結果を再提出してください。");
  }
  const automated = await collectAutomatedMetrics(input.rolloutId, rollout);
  const gate = evaluatePilotExpansion(automated, review.outcome);
  if (input.decision === "approve" && (!gate.eligible || gate.fingerprint !== review.fingerprint)) {
    throw new HttpsError(
      "failed-precondition",
      "自動集計値が提出時から変化したか、移行条件を満たしていません。結果を再提出してください。"
    );
  }
  const now = Timestamp.now();
  const approvalRef = db.collection("pilotExpansionApprovals").doc(input.rolloutId);

  await db.runTransaction(async (tx) => {
    const [currentRollout, currentReview] = await Promise.all([
      tx.get(rolloutRef),
      tx.get(reviewRef),
    ]);
    if (currentRollout.data()?.status !== "expansion_review_pending" ||
        currentReview.data()?.status !== "pending_approval" ||
        currentReview.data()?.fingerprint !== review.fingerprint) {
      throw new HttpsError("aborted", "審査状態が更新されました。再読込してください。");
    }
    if (input.decision === "approve") {
      tx.create(approvalRef, {
        companyId,
        rolloutId: input.rolloutId,
        releaseId: String(rollout.releaseId ?? ""),
        scope: "staff_30_50",
        fingerprint: gate.fingerprint,
        submittedBy: review.submittedBy,
        approvedBy: session.uid,
        approvedAt: now,
        note: input.note.trim(),
      });
      tx.set(reviewRef, {
        status: "approved",
        approvedBy: session.uid,
        approvedAt: now,
        decisionNote: input.note.trim(),
        automated,
        gate,
        updatedAt: now,
      }, { merge: true });
      tx.set(rolloutRef, {
        status: "expansion_approved",
        expansionApprovedAt: now,
        expansionApprovalScope: "staff_30_50",
        updatedAt: now,
      }, { merge: true });
    } else {
      tx.set(reviewRef, {
        status: "rejected",
        rejectedBy: session.uid,
        rejectedAt: now,
        decisionNote: input.note.trim(),
        updatedAt: now,
      }, { merge: true });
      tx.set(rolloutRef, {
        status: "expansion_rejected",
        expansionRejectedAt: now,
        updatedAt: now,
      }, { merge: true });
    }
    tx.set(db.collection("auditLogs").doc(), {
      companyId,
      actorUid: session.uid,
      action: input.decision === "approve"
        ? "pilot.expansion.approved"
        : "pilot.expansion.rejected",
      rolloutId: input.rolloutId,
      submitterUid: review.submittedBy,
      fingerprint: review.fingerprint,
      note: input.note.trim(),
      requestId: requestId("pilot_expansion"),
      createdAt: now,
    });
  });

  await notifyAdmins({
    companyId,
    title: input.decision === "approve" ? "30〜50名移行ゲートを承認しました" : "30〜50名移行ゲートを否認しました",
    body: input.decision === "approve"
      ? "承認証跡を保存しました。配布は自動実行されません。"
      : input.note.trim(),
    category: input.decision === "approve" ? "pilot_expansion_approved" : "pilot_expansion_rejected",
    dedupeKey: `${input.rolloutId}_${input.decision}`,
    urgent: input.decision === "reject",
  });
  return { decision: input.decision, rolloutStatus: input.decision === "approve" ? "expansion_approved" : "expansion_rejected" };
});

async function findRollout(companyId: string, rolloutId?: string) {
  if (rolloutId) {
    const snap = await db.collection("pilotRollouts").doc(rolloutId).get();
    return snap.exists && snap.data()?.companyId === companyId ? snap : null;
  }
  const latest = await db.collection("pilotRollouts")
    .where("companyId", "==", companyId)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();
  return latest.docs[0] ?? null;
}

async function collectAutomatedMetrics(
  rolloutId: string,
  rollout: PilotRolloutRecord
): Promise<PilotExpansionAutomated> {
  const [healthRuns, alerts] = await Promise.all([
    db.collection("pilotHealthRuns").where("rolloutId", "==", rolloutId).limit(5000).get(),
    db.collection("pilotAlerts").where("rolloutId", "==", rolloutId).limit(2000).get(),
  ]);
  const startedMs = millis(rollout.startedAt);
  const endMs = millis(rollout.completedAt) || millis(rollout.endsAt) || Date.now();
  const elapsedMs = startedMs ? Math.max(0, endMs - startedMs) : 0;
  const expectedHealthRuns = elapsedMs ? Math.floor(elapsedMs / 300_000) + 1 : 0;
  const monitoringCoveragePct = expectedHealthRuns
    ? Math.min(100, Math.round(healthRuns.size / expectedHealthRuns * 10_000) / 100)
    : 0;
  const alertData = alerts.docs.map((doc) => doc.data());
  const status = String(rollout.status ?? "");
  const storedDuration = Number(rollout.durationDays ?? 0);
  const measuredDuration = elapsedMs / 86_400_000;
  const lastAction = String(rollout.lastHealth?.action ?? "missing");
  return {
    pilotCompleted: COMPLETED_STATUSES.has(status),
    participantCount: Number(rollout.participantCount ?? rollout.participantIds?.length ?? 0),
    durationDays: Math.round(Math.max(storedDuration, measuredDuration) * 100) / 100,
    inviteFailures: Number(rollout.inviteSummary?.failedStaff ?? 1),
    healthRunCount: healthRuns.size,
    expectedHealthRuns,
    monitoringCoveragePct,
    monitorFailureCount: alertData.filter((data) => data.monitorFailure === true).length,
    criticalAlertCount: alertData.filter((data) => data.action === "pause" && data.recovery !== true).length,
    watchAlertCount: alertData.filter((data) => data.action === "watch" && data.recovery !== true).length,
    lastHealthAction: lastAction === "continue" || lastAction === "watch" || lastAction === "pause"
      ? lastAction
      : "missing",
  };
}

function safeReview(review: ExpansionReviewRecord, currentUid: string) {
  return {
    status: review.status ?? "unknown",
    submittedAt: iso(review.submittedAt),
    approvedAt: iso(review.approvedAt),
    rejectedAt: iso(review.rejectedAt),
    decisionNote: review.decisionNote ?? "",
    outcome: review.outcome ?? null,
    automated: review.automated ?? null,
    gate: review.gate ?? null,
    fingerprint: review.fingerprint ?? "",
    currentAdminCanApprove: Boolean(review.submittedBy && review.submittedBy !== currentUid),
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
    console.error("pilot_expansion_notification_failed", {
      category: input.category,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function millis(value?: Timestamp): number {
  return value instanceof Timestamp ? value.toMillis() : 0;
}

function iso(value?: Timestamp): string | null {
  return value instanceof Timestamp ? value.toDate().toISOString() : null;
}
