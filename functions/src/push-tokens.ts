import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import {
  companyFromClaims,
  requireAuth,
  staffFromClaims,
} from "./utils";
import { enqueueNotification } from "./notification-core";
import { assertProductionOperational } from "./system-safety";

const TokenSchema = z.object({
  token: z.string().min(30).max(4096),
  deviceSessionId: z.string().max(160).default(""),
  permission: z.enum(["granted", "denied", "default"]).default("granted"),
  userAgent: z.string().max(500).default(""),
  platform: z.string().max(100).default(""),
});

const RemoveSchema = z.object({
  token: z.string().min(30).max(4096),
});

export const registerPushToken = onCall(async (request) => {
  const session = requireAuth(request);
  const input = TokenSchema.parse(request.data ?? {});
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const role = String(session.token.role ?? "");
  if (role !== "staff" && role !== "admin") {
    throw new HttpsError("permission-denied", "通知を登録できません。");
  }

  const staffId = role === "staff" ? staffFromClaims(session.token) : null;
  if (staffId) {
    const profile = await db.collection("staffProfiles").doc(staffId).get();
    if (!profile.exists || profile.data()?.active !== true) {
      throw new HttpsError("permission-denied", "利用停止中です。");
    }
  }

  const tokenHash = hashToken(input.token);
  await db.collection("pushTokens").doc(tokenHash).set({
    companyId,
    uid: session.uid,
    role,
    staffId,
    token: input.token,
    tokenHash,
    deviceSessionId: input.deviceSessionId,
    permission: input.permission,
    userAgent: input.userAgent,
    platform: input.platform,
    active: input.permission === "granted",
    lastSeenAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { registered: true, tokenId: tokenHash };
});

export const unregisterPushToken = onCall(async (request) => {
  const session = requireAuth(request);
  const input = RemoveSchema.parse(request.data ?? {});
  const tokenHash = hashToken(input.token);
  const ref = db.collection("pushTokens").doc(tokenHash);
  const snap = await ref.get();
  if (!snap.exists) return { removed: true };
  if (snap.data()?.uid !== session.uid) {
    throw new HttpsError("permission-denied", "通知情報が一致しません。");
  }
  await ref.set({
    active: false,
    removedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { removed: true };
});

export const getPushStatus = onCall(async (request) => {
  const session = requireAuth(request);
  const snap = await db.collection("pushTokens")
    .where("uid", "==", session.uid)
    .where("active", "==", true)
    .limit(20)
    .get();
  return {
    enabled: !snap.empty,
    tokens: snap.docs.map((doc) => ({
      id: doc.id,
      deviceSessionId: doc.data().deviceSessionId ?? "",
      platform: doc.data().platform ?? "",
    })),
  };
});

export const sendTestPush = onCall(async (request) => {
  const session = requireAuth(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const role = String(session.token.role ?? "");
  if (role === "staff") {
    await enqueueNotification({
      companyId,
      targetStaffId: staffFromClaims(session.token),
      title: "通知テスト",
      body: "Lip Knots Crewから通知を受け取れます。",
      route: "/",
      category: "push_test",
      dedupeKey: `${session.uid}_${Date.now()}`,
      bypassQuietHours: true,
    });
  } else if (role === "admin") {
    await enqueueNotification({
      companyId,
      targetRole: "admin",
      title: "管理者通知テスト",
      body: "Lip Knots Crewの管理通知を受け取れます。",
      route: "/",
      category: "push_test_admin",
      dedupeKey: `${session.uid}_${Date.now()}`,
      bypassQuietHours: true,
    });
  } else {
    throw new HttpsError("permission-denied", "通知テストを実行できません。");
  }
  return { queued: true };
});

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
