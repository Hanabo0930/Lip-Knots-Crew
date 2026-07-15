import { randomUUID } from "node:crypto";
import { defineSecret, defineString } from "firebase-functions/params";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { enqueueNotification } from "./notification-core";
import {
  createSignedProductionApprovalPackage,
  inspectSignedProductionApprovalPackage,
  ProductionApprovalPayload,
  SignedProductionApprovalPackage,
} from "./production-approval-package-core";
import { evaluateProductionRelease, ProductionManualChecks, ProductionReleaseGateInput } from "./production-release-core";
import { companyFromClaims, normalizeEmail, requireAdmin, requestId } from "./utils";

const approvalSigningPrivateKey = defineSecret("APPROVAL_PACKAGE_SIGNING_PRIVATE_KEY");
const approvalVerifyPublicKey = defineSecret("APPROVAL_PACKAGE_VERIFY_PUBLIC_KEY");
const approvalKeyId = defineString("APPROVAL_PACKAGE_KEY_ID", { default: "lkc-production-approval-ed25519-v1" });
const productionProjectId = defineString("PRODUCTION_FIREBASE_PROJECT_ID", { default: "" });

const ExportSchema = z.object({ stagedRolloutId: z.string().min(1).max(160) });
const ImportSchema = z.object({ packageText: z.string().min(100).max(150_000) });

type StagedRolloutRecord = {
  companyId?: string; releaseId?: string; status?: string; targetCount?: number; currentWave?: number;
  deliveredCount?: number; criticalAlertCount?: number; monitorFailureCount?: number; inviteFailureCount?: number;
  lastHealth?: { action?: string };
};

type ProductionReviewRecord = {
  companyId?: string; status?: string; manual?: ProductionManualChecks; evidenceRefs?: string[];
  fingerprint?: string; submittedBy?: string; executiveApprovedBy?: string; executiveApprovedEmail?: string;
  rehearsalFingerprint?: string;
};

export const exportProductionApprovalPackage = onCall(
  { secrets: [approvalSigningPrivateKey] },
  async (request) => {
    assertRuntime("staging");
    const session = requireAdmin(request);
    const companyId = companyFromClaims(session.token);
    const input = ExportSchema.parse(request.data ?? {});
    const sourceProjectId = String(process.env.EXPECTED_FIREBASE_PROJECT_ID ?? "").trim();
    const targetProjectId = productionProjectId.value().trim();
    if (!sourceProjectId || !targetProjectId || sourceProjectId === targetProjectId) {
      throw new HttpsError("failed-precondition", "stagingとproductionのProject IDを分離して設定してください。");
    }
    const [rolloutSnap, reviewSnap, certificationSnap] = await Promise.all([
      db.collection("stagedRollouts").doc(input.stagedRolloutId).get(),
      db.collection("productionReleaseReviews").doc(input.stagedRolloutId).get(),
      db.collection("productionRehearsalCertifications").doc(input.stagedRolloutId).get(),
    ]);
    if (!rolloutSnap.exists || rolloutSnap.data()?.companyId !== companyId || !reviewSnap.exists || reviewSnap.data()?.companyId !== companyId) {
      throw new HttpsError("not-found", "署名対象の段階配布・公開審査が見つかりません。");
    }
    const rollout = rolloutSnap.data() as StagedRolloutRecord;
    const review = reviewSnap.data() as ProductionReviewRecord;
    if (review.status !== "approved_pending_enable" || !review.manual || !review.evidenceRefs || !review.fingerprint || !review.submittedBy || !review.executiveApprovedBy || !review.executiveApprovedEmail) {
      throw new HttpsError("failed-precondition", "社長承認済みの公開審査だけを署名できます。");
    }
    const rehearsalFingerprint = String(review.rehearsalFingerprint ?? "");
    if (!certificationSnap.exists || certificationSnap.data()?.status !== "completed" || certificationSnap.data()?.companyId !== companyId || certificationSnap.data()?.fingerprint !== rehearsalFingerprint) {
      throw new HttpsError("failed-precondition", "公開審査と一致する復元演習証跡がありません。");
    }
    const releaseGateInput = gateInput(rollout, review.manual, review.evidenceRefs);
    const gate = evaluateProductionRelease(releaseGateInput);
    if (!gate.eligible || gate.fingerprint !== review.fingerprint) {
      throw new HttpsError("failed-precondition", "発行直前の公開ゲート再判定に失敗しました。");
    }
    const issuedAtMs = Date.now();
    const payload: ProductionApprovalPayload = {
      packageId: `approval_${randomUUID()}`,
      sourceEnvironment: "staging",
      sourceProjectId,
      targetProjectId,
      companyId,
      stagedRolloutId: input.stagedRolloutId,
      releaseId: String(rollout.releaseId ?? ""),
      releaseGateInput,
      releaseFingerprint: gate.fingerprint,
      rehearsalFingerprint,
      submittedBy: review.submittedBy,
      executiveApprovedBy: review.executiveApprovedBy,
      executiveApprovedEmail: normalizeEmail(review.executiveApprovedEmail),
      issuedAtMs,
      expiresAtMs: issuedAtMs + 30 * 60 * 1000,
    };
    let signedPackage: SignedProductionApprovalPackage;
    try {
      signedPackage = createSignedProductionApprovalPackage(
        payload,
        approvalSigningPrivateKey.value(),
        approvalKeyId.value()
      );
    } catch (error) {
      console.error("production_approval_package_sign_failed", error);
      throw new HttpsError("failed-precondition", "承認パッケージ署名鍵を確認してください。");
    }
    const now = Timestamp.now();
    await db.runTransaction(async (tx) => {
      tx.create(db.collection("productionApprovalPackageExports").doc(payload.packageId), {
        companyId,
        stagedRolloutId: input.stagedRolloutId,
        releaseId: payload.releaseId,
        targetProjectId,
        keyId: signedPackage.keyId,
        releaseFingerprint: payload.releaseFingerprint,
        rehearsalFingerprint,
        signedPackage,
        status: "issued",
        issuedBy: session.uid,
        issuedAt: now,
        expiresAtMs: payload.expiresAtMs,
      });
      tx.set(db.collection("auditLogs").doc(), {
        companyId,
        actorUid: session.uid,
        action: "production_approval_package.issued",
        packageId: payload.packageId,
        stagedRolloutId: input.stagedRolloutId,
        targetProjectId,
        keyId: signedPackage.keyId,
        releaseFingerprint: payload.releaseFingerprint,
        requestId: requestId("production_approval_package"),
        createdAt: now,
      });
    });
    return {
      approvalPackageId: payload.packageId,
      packageText: JSON.stringify(signedPackage, null, 2),
      expiresAt: new Date(payload.expiresAtMs).toISOString(),
      releaseFingerprint: payload.releaseFingerprint,
    };
  }
);

export const importProductionApprovalPackage = onCall(
  { secrets: [approvalVerifyPublicKey] },
  async (request) => {
    assertRuntime("production");
    const session = requireAdmin(request);
    const companyId = companyFromClaims(session.token);
    const input = ImportSchema.parse(request.data ?? {});
    let candidate: unknown;
    try {
      candidate = JSON.parse(input.packageText);
    } catch {
      throw new HttpsError("invalid-argument", "承認パッケージJSONを解析できません。");
    }
    const expectedTargetProjectId = String(process.env.EXPECTED_FIREBASE_PROJECT_ID ?? "").trim();
    if (!expectedTargetProjectId) {
      throw new HttpsError("failed-precondition", "production Project IDが設定されていません。");
    }
    const inspection = inspectSignedProductionApprovalPackage(candidate, {
      publicKeyPem: approvalVerifyPublicKey.value(),
      expectedKeyId: approvalKeyId.value(),
      expectedTargetProjectId,
      expectedCompanyId: companyId,
      nowMs: Date.now(),
    });
    if (!inspection.eligible) {
      throw new HttpsError(
        "failed-precondition",
        `署名付き承認パッケージを拒否しました：${inspection.blockers.map((item) => item.label).join(" / ")}`
      );
    }
    const signedPackage = candidate as SignedProductionApprovalPackage;
    const payload = signedPackage.payload;
    const packageRef = db.collection("productionApprovalPackages").doc(payload.packageId);
    const controlRef = db.collection("productionControls").doc(companyId);
    const now = Timestamp.now();
    await db.runTransaction(async (tx) => {
      const [existing, control] = await Promise.all([tx.get(packageRef), tx.get(controlRef)]);
      if (existing.exists) {
        throw new HttpsError("already-exists", "この承認パッケージは受理済みです。再利用できません。");
      }
      if (control.data()?.emergencyLock === true) {
        throw new HttpsError("failed-precondition", "全体停止ロック後は承認パッケージを受理できません。");
      }
      const pendingId = String(control.data()?.pendingApprovalPackageId ?? "");
      const pending = pendingId ? await tx.get(db.collection("productionApprovalPackages").doc(pendingId)) : null;
      if (pending?.exists && pending.data()?.status === "ready_to_enable" && Number(pending.data()?.expiresAtMs ?? 0) >= Date.now()) {
        throw new HttpsError("already-exists", "有効化待ちの承認パッケージが既にあります。");
      }
      if (pending?.exists && pending.data()?.status === "ready_to_enable") {
        tx.set(pending.ref, { status: "expired", expiredAt: now, updatedAt: now }, { merge: true });
      }
      tx.create(packageRef, {
        companyId,
        status: "ready_to_enable",
        signedPackage,
        payloadFingerprint: inspection.payloadFingerprint,
        releaseFingerprint: inspection.releaseFingerprint,
        sourceProjectId: payload.sourceProjectId,
        targetProjectId: payload.targetProjectId,
        stagedRolloutId: payload.stagedRolloutId,
        releaseId: payload.releaseId,
        executiveApprovedEmail: payload.executiveApprovedEmail,
        keyId: signedPackage.keyId,
        issuedAtMs: payload.issuedAtMs,
        expiresAtMs: payload.expiresAtMs,
        importedBy: session.uid,
        importedByEmail: normalizeEmail(String(session.token.email ?? "")),
        importedAt: now,
        updatedAt: now,
      });
      tx.set(controlRef, {
        companyId,
        pendingApprovalPackageId: payload.packageId,
        updatedAt: now,
      }, { merge: true });
      tx.set(db.collection("auditLogs").doc(), {
        companyId,
        actorUid: session.uid,
        action: "production_approval_package.imported",
        packageId: payload.packageId,
        sourceProjectId: payload.sourceProjectId,
        releaseFingerprint: payload.releaseFingerprint,
        payloadFingerprint: inspection.payloadFingerprint,
        requestId: requestId("production_approval_package"),
        createdAt: now,
      });
    });
    await notifyAdmins(companyId, "署名付き本番承認を受理しました", "承認者とは別の管理者が30分以内に本番有効化を実行してください。", payload.packageId);
    return {
      approvalPackageId: payload.packageId,
      status: "ready_to_enable",
      releaseId: payload.releaseId,
      expiresAt: new Date(payload.expiresAtMs).toISOString(),
      releaseFingerprint: payload.releaseFingerprint,
    };
  }
);

function gateInput(rollout: StagedRolloutRecord, manual: ProductionManualChecks, evidenceRefs: string[]): ProductionReleaseGateInput {
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

function assertRuntime(expected: "staging" | "production"): void {
  if ((process.env.APP_ENVIRONMENT ?? "development") !== expected) {
    throw new HttpsError("failed-precondition", `この操作は${expected}環境だけで実行できます。`);
  }
}

async function notifyAdmins(companyId: string, title: string, body: string, dedupeKey: string): Promise<void> {
  try {
    await enqueueNotification({ companyId, targetRole: "admin", title, body, route: "/", category: "production_approval_package", dedupeKey });
  } catch (error) {
    console.error("production_approval_package_notification_failed", error);
  }
}
