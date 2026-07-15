import { defineString } from "firebase-functions/params";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { enqueueNotification } from "./notification-core";
import { SignedProductionApprovalPackage } from "./production-approval-package-core";
import { evaluateProductionCutoverEnable } from "./production-cutover-core";
import {
  evaluateProductionRelease,
  ProductionManualChecks,
  ProductionReleaseGateInput,
} from "./production-release-core";
import { companyFromClaims, normalizeEmail, requireAdmin, requestId } from "./utils";
import { incrementProductionMetrics } from "./production-metrics";

const executiveApproverEmails = defineString("EXECUTIVE_APPROVER_EMAILS", {
  default: "info@lipknots.com",
});

const ManualSchema = z.object({
  backupVerified: z.boolean(),
  restoreTestPassed: z.boolean(),
  gasHighCriticalZero: z.boolean(),
  stagingSmokeGo: z.boolean(),
  legalApproved: z.boolean(),
  productionSecretsConfigured: z.boolean(),
  cloudMonitoringReady: z.boolean(),
  domainTlsReady: z.boolean(),
  migrationPlanReady: z.boolean(),
  rollbackPlanReady: z.boolean(),
});

const ReviewSchema = z.object({
  stagedRolloutId: z.string().min(1).max(160),
  manual: ManualSchema,
  evidenceRefs: z.array(
    z.string().min(1).max(500).refine((value) => !/[\r\n\0]/u.test(value), "証跡参照が不正です。")
  ).min(5).max(30),
  note: z.string().max(2000).refine((value) => !/[\0]/u.test(value), "備考が不正です。"),
});

const DecisionSchema = z.object({
  stagedRolloutId: z.string().min(1).max(160),
  decision: z.enum(["approve", "reject"]),
  note: z.string().min(1).max(1000),
});

const EnableSchema = z.object({
  approvalPackageId: z.string().min(20).max(160),
  confirmation: z.literal("ENABLE_PRODUCTION"),
});

const KillSchema = z.object({
  reason: z.string().min(10).max(1000),
  confirmation: z.literal("LOCK_PRODUCTION_IRREVERSIBLY"),
});

type StagedRolloutRecord = {
  companyId?: string;
  releaseId?: string;
  status?: string;
  targetCount?: number;
  currentWave?: number;
  deliveredCount?: number;
  criticalAlertCount?: number;
  monitorFailureCount?: number;
  inviteFailureCount?: number;
  lastHealth?: { action?: string };
  completedAt?: Timestamp;
};

type ProductionReviewRecord = {
  companyId?: string;
  stagedRolloutId?: string;
  releaseId?: string;
  status?: string;
  manual?: ProductionManualChecks;
  evidenceRefs?: string[];
  note?: string;
  submittedBy?: string;
  submittedAt?: Timestamp;
  executiveApprovedBy?: string;
  executiveApprovedAt?: Timestamp;
  executiveRejectedAt?: Timestamp;
  decisionNote?: string;
  enabledBy?: string;
  enabledAt?: Timestamp;
  fingerprint?: string;
  gate?: ReturnType<typeof evaluateProductionRelease>;
};

type ProductionApprovalPackageRecord = {
  companyId?: string;
  status?: string;
  signedPackage?: SignedProductionApprovalPackage;
  payloadFingerprint?: string;
  releaseFingerprint?: string;
  expiresAtMs?: number;
  importedBy?: string;
  importedAt?: Timestamp;
  usedAt?: Timestamp;
};

export const getProductionControlStatus = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const rollout = await findLatestCompletedStagedRollout(companyId);
  const [review, certification, control] = await Promise.all([
    rollout ? db.collection("productionReleaseReviews").doc(rollout.id).get() : Promise.resolve(null),
    rollout ? db.collection("productionRehearsalCertifications").doc(rollout.id).get() : Promise.resolve(null),
    db.collection("productionControls").doc(companyId).get(),
  ]);
  const reviewData = review?.exists ? review.data() as ProductionReviewRecord : null;
  const controlData = control.data() ?? {};
  const currentEmail = normalizeEmail(String(session.token.email ?? ""));
  const isExecutive = executiveEmails().includes(currentEmail);
  const pendingApprovalPackageId = String(controlData.pendingApprovalPackageId ?? "");
  const pendingApprovalSnap = pendingApprovalPackageId
    ? await db.collection("productionApprovalPackages").doc(pendingApprovalPackageId).get()
    : null;
  const pendingApproval = pendingApprovalSnap?.exists && pendingApprovalSnap.data()?.companyId === companyId
    ? pendingApprovalSnap.data() as ProductionApprovalPackageRecord
    : null;
  return {
    environment: process.env.APP_ENVIRONMENT ?? "development",
    stagedRollout: rollout ? safeStagedRollout(rollout.id, rollout.data() as StagedRolloutRecord) : null,
    rehearsalCertified: Boolean(certification?.exists && certification.data()?.companyId === companyId && certification.data()?.status === "completed"),
    rehearsalFingerprint: certification?.exists ? String(certification.data()?.fingerprint ?? "") : "",
    review: reviewData ? safeReview(reviewData, session.uid, isExecutive) : null,
    importedApproval: pendingApproval ? safeImportedApproval(pendingApprovalPackageId, pendingApproval, currentEmail) : null,
    control: {
      productionEnabled: controlData.productionEnabled === true,
      emergencyLock: controlData.emergencyLock === true,
      generation: Number(controlData.generation ?? 0),
      activeStagedRolloutId: String(controlData.activeStagedRolloutId ?? ""),
      activeApprovalPackageId: String(controlData.activeApprovalPackageId ?? ""),
      pendingApprovalPackageId,
      emergencyReason: String(controlData.emergencyReason ?? ""),
      enabledAt: iso(controlData.enabledAt),
      lockedAt: iso(controlData.lockedAt),
    },
  };
});

export const submitProductionReleaseReview = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = ReviewSchema.parse(request.data ?? {});
  const rolloutRef = db.collection("stagedRollouts").doc(input.stagedRolloutId);
  const rolloutSnap = await rolloutRef.get();
  if (!rolloutSnap.exists || rolloutSnap.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "30〜50名段階配布が見つかりません。");
  }
  const rollout = rolloutSnap.data() as StagedRolloutRecord;
  const certification = await db.collection("productionRehearsalCertifications").doc(input.stagedRolloutId).get();
  const certificationValid = Boolean(
    certification.exists && certification.data()?.companyId === companyId &&
    certification.data()?.stagedRolloutId === input.stagedRolloutId &&
    certification.data()?.status === "completed" && certification.data()?.gate?.eligible === true &&
    certification.data()?.fingerprint
  );
  const certifiedManual: ProductionManualChecks = {
    ...input.manual,
    backupVerified: certificationValid,
    restoreTestPassed: certificationValid,
    migrationPlanReady: certificationValid,
    rollbackPlanReady: certificationValid,
  };
  const certifiedEvidence = certificationValid
    ? [
      ...input.evidenceRefs,
      ...(Array.isArray(certification.data()?.evidenceRefs) ? certification.data()!.evidenceRefs : []),
      `rehearsal:${certification.id}`,
    ]
    : input.evidenceRefs;
  const gate = evaluateProductionRelease(gateInput(rollout, certifiedManual, certifiedEvidence));
  const reviewStatus = gate.eligible ? "pending_executive" : "blocked";
  const now = Timestamp.now();
  const reviewRef = db.collection("productionReleaseReviews").doc(input.stagedRolloutId);
  const control = await db.collection("productionControls").doc(companyId).get();
  if (control.data()?.emergencyLock === true) {
    throw new HttpsError("failed-precondition", "全体停止ロック後は再承認できません。新しい復旧リリースが必要です。");
  }
  await db.runTransaction(async (tx) => {
    const current = await tx.get(reviewRef);
    if (current.exists && ["pending_executive", "approved_pending_enable", "enabled"].includes(String(current.data()?.status ?? ""))) {
      throw new HttpsError("already-exists", "この段階配布には進行中または完了済みの公開審査があります。");
    }
    tx.set(reviewRef, {
      companyId,
      stagedRolloutId: input.stagedRolloutId,
      releaseId: String(rollout.releaseId ?? ""),
      status: reviewStatus,
      manual: certifiedManual,
      evidenceRefs: gate.normalizedEvidenceRefs,
      rehearsalCertificationId: certificationValid ? certification.id : null,
      rehearsalFingerprint: certificationValid ? String(certification.data()?.fingerprint ?? "") : null,
      note: input.note.trim(),
      gate,
      fingerprint: gate.fingerprint,
      submittedBy: session.uid,
      submittedAt: now,
      updatedAt: now,
      executiveApprovedBy: null,
      executiveApprovedAt: null,
      enabledBy: null,
      enabledAt: null,
    });
    tx.set(db.collection("auditLogs").doc(), {
      companyId,
      actorUid: session.uid,
      action: "production_release.review_submitted",
      stagedRolloutId: input.stagedRolloutId,
      eligible: gate.eligible,
      blockerKeys: gate.blockers.map((item) => item.key),
      fingerprint: gate.fingerprint,
      requestId: requestId("production_release"),
      createdAt: now,
    });
  });
  await notifyAdmins({
    companyId,
    title: gate.eligible ? "本番公開の社長承認が必要です" : "本番公開ゲートを停止しました",
    body: gate.eligible
      ? "提出者とは別の指定承認者が承認するまで、本番公開はロックされています。"
      : `未達項目：${gate.blockers.map((item) => item.label).join(" / ")}`,
    category: gate.eligible ? "production_release_executive_review" : "production_release_blocked",
    dedupeKey: `${input.stagedRolloutId}_${gate.fingerprint}`,
    urgent: !gate.eligible,
  });
  return { reviewStatus, gate };
});

export const decideProductionReleaseExecutive = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const email = normalizeEmail(String(session.token.email ?? ""));
  if (!email || !executiveEmails().includes(email)) {
    throw new HttpsError("permission-denied", "指定された社長承認アカウントだけが実行できます。");
  }
  const input = DecisionSchema.parse(request.data ?? {});
  const reviewRef = db.collection("productionReleaseReviews").doc(input.stagedRolloutId);
  const rolloutRef = db.collection("stagedRollouts").doc(input.stagedRolloutId);
  const [reviewSnap, rolloutSnap] = await Promise.all([reviewRef.get(), rolloutRef.get()]);
  if (!reviewSnap.exists || reviewSnap.data()?.companyId !== companyId || !rolloutSnap.exists || rolloutSnap.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "本番公開審査が見つかりません。");
  }
  const review = reviewSnap.data() as ProductionReviewRecord;
  if (review.status !== "pending_executive" || !review.manual || !review.evidenceRefs || !review.fingerprint) {
    throw new HttpsError("failed-precondition", "社長承認待ちの審査ではありません。");
  }
  if (review.submittedBy === session.uid) {
    throw new HttpsError("permission-denied", "公開審査の提出者とは別の承認者が必要です。");
  }
  const gate = evaluateProductionRelease(gateInput(rolloutSnap.data() as StagedRolloutRecord, review.manual, review.evidenceRefs));
  if (input.decision === "approve" && (!gate.eligible || gate.fingerprint !== review.fingerprint)) {
    throw new HttpsError("failed-precondition", "提出後に公開条件が変化しました。審査を再提出してください。");
  }
  const now = Timestamp.now();
  await db.runTransaction(async (tx) => {
    const current = await tx.get(reviewRef);
    if (current.data()?.status !== "pending_executive" || current.data()?.fingerprint !== review.fingerprint) {
      throw new HttpsError("aborted", "審査状態が更新されました。再読込してください。");
    }
    tx.set(reviewRef, input.decision === "approve" ? {
      status: "approved_pending_enable",
      executiveApprovedBy: session.uid,
      executiveApprovedEmail: email,
      executiveApprovedAt: now,
      decisionNote: input.note.trim(),
      gate,
      updatedAt: now,
    } : {
      status: "rejected",
      executiveRejectedBy: session.uid,
      executiveRejectedAt: now,
      decisionNote: input.note.trim(),
      updatedAt: now,
    }, { merge: true });
    tx.set(db.collection("auditLogs").doc(), {
      companyId,
      actorUid: session.uid,
      actorEmail: email,
      action: input.decision === "approve" ? "production_release.executive_approved" : "production_release.executive_rejected",
      stagedRolloutId: input.stagedRolloutId,
      fingerprint: review.fingerprint,
      note: input.note.trim(),
      requestId: requestId("production_release"),
      createdAt: now,
    });
  });
  return { status: input.decision === "approve" ? "approved_pending_enable" : "rejected" };
});

export const enableProductionRelease = onCall(async (request) => {
  assertProductionRuntime();
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = EnableSchema.parse(request.data ?? {});
  const packageRef = db.collection("productionApprovalPackages").doc(input.approvalPackageId);
  const controlRef = db.collection("productionControls").doc(companyId);
  const cutoverControlRef = db.collection("productionCutoverControls").doc(companyId);
  const [packageSnap, cutoverControl] = await Promise.all([packageRef.get(), cutoverControlRef.get()]);
  if (!packageSnap.exists || packageSnap.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "受理済みの署名付き承認パッケージが見つかりません。");
  }
  const approval = packageSnap.data() as ProductionApprovalPackageRecord;
  const payload = approval.signedPackage?.payload;
  if (approval.status !== "ready_to_enable" || !payload || approval.releaseFingerprint !== payload.releaseFingerprint || !approval.payloadFingerprint) {
    throw new HttpsError("failed-precondition", "有効化待ちの署名付き承認パッケージではありません。");
  }
  if (Number(approval.expiresAtMs ?? 0) < Date.now()) {
    throw new HttpsError("deadline-exceeded", "承認パッケージの30分有効期限を過ぎました。stagingで再発行してください。");
  }
  const currentEmail = normalizeEmail(String(session.token.email ?? ""));
  if (!currentEmail || currentEmail === normalizeEmail(payload.executiveApprovedEmail)) {
    throw new HttpsError("permission-denied", "社長承認者とは別の管理者アカウントで本番有効化を実行してください。");
  }
  const cutoverRunId = String(cutoverControl.data()?.activeRunId ?? "");
  const cutoverRef = cutoverRunId ? db.collection("productionCutoverRuns").doc(cutoverRunId) : null;
  const cutoverSnap = cutoverRef ? await cutoverRef.get() : null;
  const cutover = cutoverSnap?.data() ?? {};
  if (!cutoverRef || !cutoverSnap?.exists || cutover.companyId !== companyId || cutover.releaseId !== payload.releaseId || cutover.approvalPackageId !== input.approvalPackageId) {
    throw new HttpsError("failed-precondition", "同じRelease・署名承認に紐づく本番切替指揮盤が必要です。");
  }
  const activeCutoverRef = cutoverRef;
  const enableGate=evaluateProductionCutoverEnable({runStatus:String(cutover.status??""),action:String(cutover.gate?.action??""),phase:String(cutover.gate?.phase??""),runReleaseId:String(cutover.releaseId??""),packageReleaseId:payload.releaseId,runApprovalPackageId:String(cutover.approvalPackageId??""),approvalPackageId:input.approvalPackageId,windowStartMs:Number(cutover.windowStartMs??0),nowMs:Date.now()});
  if(!enableGate.allowed)throw new HttpsError("failed-precondition",`本番切替指揮盤を拒否しました：${enableGate.blockers.map(item=>item.label).join(" / ")}`);
  const now = Timestamp.now();
  await db.runTransaction(async (tx) => {
    const [currentPackage, control, currentCutover] = await Promise.all([tx.get(packageRef), tx.get(controlRef), tx.get(activeCutoverRef)]);
    if (control.data()?.emergencyLock === true) {
      throw new HttpsError("failed-precondition", "全体停止ロック後はアプリから再有効化できません。");
    }
    if (control.data()?.pendingApprovalPackageId !== input.approvalPackageId) {
      throw new HttpsError("aborted", "有効化対象の承認パッケージが更新されました。再読込してください。");
    }
    if (currentPackage.data()?.status !== "ready_to_enable" || currentPackage.data()?.payloadFingerprint !== approval.payloadFingerprint) {
      throw new HttpsError("aborted", "承認パッケージは使用済みまたは更新済みです。");
    }
    if (Number(currentPackage.data()?.expiresAtMs ?? 0) < Date.now()) {
      throw new HttpsError("deadline-exceeded", "承認パッケージの有効期限を過ぎました。");
    }
    const currentEnableGate=evaluateProductionCutoverEnable({runStatus:String(currentCutover.data()?.status??""),action:String(currentCutover.data()?.gate?.action??""),phase:String(currentCutover.data()?.gate?.phase??""),runReleaseId:String(currentCutover.data()?.releaseId??""),packageReleaseId:payload.releaseId,runApprovalPackageId:String(currentCutover.data()?.approvalPackageId??""),approvalPackageId:input.approvalPackageId,windowStartMs:Number(currentCutover.data()?.windowStartMs??0),nowMs:Date.now()});
    if (!currentEnableGate.allowed || currentCutover.data()?.gate?.fingerprint !== cutover.gate?.fingerprint) {
      throw new HttpsError("aborted", "指揮盤のGO判定または切替時刻が更新されました。");
    }
    const generation = Number(control.data()?.generation ?? 0) + 1;
    tx.set(controlRef, {
      companyId,
      productionEnabled: true,
      emergencyLock: false,
      generation,
      activeStagedRolloutId: payload.stagedRolloutId,
      activeApprovalPackageId: input.approvalPackageId,
      pendingApprovalPackageId: null,
      activeFingerprint: payload.releaseFingerprint,
      enabledBy: session.uid,
      enabledByEmail: currentEmail,
      enabledAt: now,
      updatedAt: now,
    }, { merge: true });
    tx.set(packageRef, { status: "used", usedBy: session.uid, usedByEmail: currentEmail, usedAt: now, updatedAt: now }, { merge: true });
    tx.set(activeCutoverRef, { status: "monitoring", approvalPackageId: input.approvalPackageId, productionEnabledBy: session.uid, productionEnabledAt: now, updatedAt: now }, { merge: true });
    tx.create(db.collection("productionReleaseAuthorizations").doc(), {
      companyId,
      approvalPackageId: input.approvalPackageId,
      cutoverRunId,
      stagedRolloutId: payload.stagedRolloutId,
      releaseId: payload.releaseId,
      sourceProjectId: payload.sourceProjectId,
      targetProjectId: payload.targetProjectId,
      keyId: approval.signedPackage?.keyId,
      payloadFingerprint: approval.payloadFingerprint,
      fingerprint: payload.releaseFingerprint,
      executiveApprovedBy: payload.executiveApprovedBy,
      executiveApprovedEmail: payload.executiveApprovedEmail,
      enabledBy: session.uid,
      enabledByEmail: currentEmail,
      generation,
      status: "active",
      createdAt: now,
    });
    tx.set(db.collection("auditLogs").doc(), {
      companyId,
      actorUid: session.uid,
      action: "production_release.enabled",
      approvalPackageId: input.approvalPackageId,
      stagedRolloutId: payload.stagedRolloutId,
      fingerprint: payload.releaseFingerprint,
      executiveApprovedBy: payload.executiveApprovedBy,
      executiveApprovedEmail: payload.executiveApprovedEmail,
      generation,
      requestId: requestId("production_release"),
      createdAt: now,
    });
  });
  await notifyAdmins({
    companyId,
    title: "本番公開を有効化しました",
    body: "staging署名・社長承認・別管理者によるproduction最終実行を記録しました。",
    category: "production_release_enabled",
    dedupeKey: input.approvalPackageId,
  });
  return { productionEnabled: true, stagedRolloutId: payload.stagedRolloutId, approvalPackageId: input.approvalPackageId, cutoverRunId };
});

export const activateGlobalKillSwitch = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = KillSchema.parse(request.data ?? {});
  const controlRef = db.collection("productionControls").doc(companyId);
  const now = Timestamp.now();
  const generation = await db.runTransaction(async (tx) => {
    const control = await tx.get(controlRef);
    if (control.data()?.emergencyLock === true) return Number(control.data()?.generation ?? 0);
    const nextGeneration = Number(control.data()?.generation ?? 0) + 1;
    tx.set(controlRef, {
      companyId,
      productionEnabled: false,
      emergencyLock: true,
      generation: nextGeneration,
      emergencyReason: input.reason.trim(),
      lockedBy: session.uid,
      lockedAt: now,
      updatedAt: now,
    }, { merge: true });
    tx.create(db.collection("productionEmergencyEvents").doc(), {
      companyId,
      action: "global_kill_switch_activated",
      reason: input.reason.trim(),
      actorUid: session.uid,
      generation: nextGeneration,
      irreversibleInApp: true,
      createdAt: now,
    });
    tx.set(db.collection("auditLogs").doc(), {
      companyId,
      actorUid: session.uid,
      action: "production_release.global_kill_switch_activated",
      reason: input.reason.trim(),
      generation: nextGeneration,
      requestId: requestId("production_kill_switch"),
      createdAt: now,
    });
    return nextGeneration;
  });
  await incrementProductionMetrics(companyId,{criticalOutageCount:1},"global_kill_switch");
  await notifyAdmins({
    companyId,
    title: "緊急：全体停止スイッチが作動しました",
    body: `${input.reason.trim()}／アプリから解除できません。復旧手順を開始してください。`,
    category: "production_global_kill_switch",
    dedupeKey: String(generation),
    urgent: true,
  });
  return { productionEnabled: false, emergencyLock: true, generation };
});

function gateInput(
  rollout: StagedRolloutRecord,
  manual: ProductionManualChecks,
  evidenceRefs: string[]
): ProductionReleaseGateInput {
  const action = String(rollout.lastHealth?.action ?? "missing");
  return {
    stagedRolloutStatus: String(rollout.status ?? "missing"),
    targetCount: Number(rollout.targetCount ?? 0),
    currentWave: Number(rollout.currentWave ?? 0),
    deliveredCount: Number(rollout.deliveredCount ?? 0),
    criticalAlertCount: Number(rollout.criticalAlertCount ?? 0),
    monitorFailureCount: Number(rollout.monitorFailureCount ?? 0),
    inviteFailureCount: Number(rollout.inviteFailureCount ?? 0),
    lastHealthAction: action === "continue" || action === "watch" || action === "pause" ? action : "missing",
    manual,
    evidenceRefs,
  };
}

async function findLatestCompletedStagedRollout(companyId: string) {
  const latest = await db.collection("stagedRollouts")
    .where("companyId", "==", companyId)
    .where("status", "==", "completed")
    .orderBy("completedAt", "desc")
    .limit(1)
    .get();
  return latest.docs[0] ?? null;
}

function safeStagedRollout(id: string, data: StagedRolloutRecord) {
  return {
    stagedRolloutId: id,
    releaseId: String(data.releaseId ?? ""),
    status: String(data.status ?? "unknown"),
    targetCount: Number(data.targetCount ?? 0),
    currentWave: Number(data.currentWave ?? 0),
    deliveredCount: Number(data.deliveredCount ?? 0),
    criticalAlertCount: Number(data.criticalAlertCount ?? 0),
    monitorFailureCount: Number(data.monitorFailureCount ?? 0),
    inviteFailureCount: Number(data.inviteFailureCount ?? 0),
    lastHealthAction: String(data.lastHealth?.action ?? "missing"),
    completedAt: iso(data.completedAt),
  };
}

function safeReview(review: ProductionReviewRecord, currentUid: string, isExecutive: boolean) {
  return {
    status: String(review.status ?? "unknown"),
    manual: review.manual ?? null,
    evidenceRefs: review.evidenceRefs ?? [],
    note: review.note ?? "",
    decisionNote: review.decisionNote ?? "",
    gate: review.gate ?? null,
    fingerprint: review.fingerprint ?? "",
    submittedAt: iso(review.submittedAt),
    executiveApprovedAt: iso(review.executiveApprovedAt),
    executiveRejectedAt: iso(review.executiveRejectedAt),
    enabledAt: iso(review.enabledAt),
    currentAdminCanExecutiveApprove: Boolean(isExecutive && review.submittedBy && review.submittedBy !== currentUid),
    currentAdminCanEnable: Boolean(review.executiveApprovedBy && review.executiveApprovedBy !== currentUid),
  };
}

function safeImportedApproval(id: string, approval: ProductionApprovalPackageRecord, currentEmail: string) {
  const payload = approval.signedPackage?.payload;
  const expiresAtMs = Number(approval.expiresAtMs ?? payload?.expiresAtMs ?? 0);
  const executiveEmail = normalizeEmail(String(payload?.executiveApprovedEmail ?? ""));
  const status = approval.status === "ready_to_enable" && expiresAtMs < Date.now()
    ? "expired"
    : String(approval.status ?? "unknown");
  return {
    approvalPackageId: id,
    status,
    releaseId: String(payload?.releaseId ?? ""),
    stagedRolloutId: String(payload?.stagedRolloutId ?? ""),
    sourceProjectId: String(payload?.sourceProjectId ?? ""),
    targetProjectId: String(payload?.targetProjectId ?? ""),
    keyId: String(approval.signedPackage?.keyId ?? ""),
    releaseFingerprint: String(payload?.releaseFingerprint ?? ""),
    rehearsalFingerprint: String(payload?.rehearsalFingerprint ?? ""),
    executiveApprovedEmail: executiveEmail,
    issuedAt: expiresAtMs ? new Date(Number(payload?.issuedAtMs ?? 0)).toISOString() : null,
    expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
    importedAt: iso(approval.importedAt),
    usedAt: iso(approval.usedAt),
    currentAdminCanEnable: Boolean(
      status === "ready_to_enable" &&
      expiresAtMs >= Date.now() &&
      currentEmail &&
      currentEmail !== executiveEmail
    ),
  };
}

function executiveEmails(): string[] {
  return executiveApproverEmails.value().split(",").map(normalizeEmail).filter(Boolean);
}

function assertProductionRuntime(): void {
  if ((process.env.APP_ENVIRONMENT ?? "development") !== "production") {
    throw new HttpsError("failed-precondition", "本番有効化はproduction環境だけで実行できます。");
  }
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
    console.error("production_control_notification_failed", {
      category: input.category,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function iso(value: unknown): string | null {
  return value instanceof Timestamp ? value.toDate().toISOString() : null;
}
