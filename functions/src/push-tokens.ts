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
import { assertDeviceAuthentication } from "./device-authentication";
import {
  normalizePushFailureReason,
  type PushFailureReason,
} from "./push-delivery";

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

const PushStatusSchema = z.object({
  queueId: z.string().regex(/^nq_[a-f0-9]{36}$/).optional(),
});

const TERMINAL_PUSH_STATUSES = new Set([
  "completed",
  "partial",
  "no_tokens",
  "error",
  "paused_global",
]);

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
  if (staffId && (!input.deviceSessionId.trim() || /[\/\\\u0000-\u001f\u007f]/.test(input.deviceSessionId))) {
    throw new HttpsError("permission-denied", "端末登録を確認できません。再読み込みしてください。");
  }
  const tokenHash = hashToken(input.token);
  const ref = db.collection("pushTokens").doc(tokenHash);
  await db.runTransaction(async (tx) => {
    if (staffId) {
      const [profile, device] = await Promise.all([
        tx.get(db.collection("staffProfiles").doc(staffId)),
        tx.get(db.collection("deviceSessions").doc(input.deviceSessionId)),
      ]);
      if (!profile.exists || profile.data()?.active !== true || profile.data()?.companyId !== companyId) {
        throw new HttpsError("permission-denied", "利用停止中です。");
      }
      const registered = device.data();
      if (!device.exists || registered?.active !== true || registered.companyId !== companyId
        || registered.staffId !== staffId || registered.uid !== session.uid) {
        throw new HttpsError("permission-denied", "端末登録を確認できません。再ログインしてください。");
      }
      assertDeviceAuthentication(registered, session.token.auth_time);
    }
    tx.set(ref, {
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
  });

  return { registered: true, tokenId: tokenHash };
});

export const unregisterPushToken = onCall(async (request) => {
  const session = requireAuth(request);
  const input = RemoveSchema.parse(request.data ?? {});
  const tokenHash = hashToken(input.token);
  const ref = db.collection("pushTokens").doc(tokenHash);
  const companyId = companyFromClaims(session.token);
  const role = session.token.role;
  if (role !== "staff" && role !== "admin") {
    throw new HttpsError("permission-denied", "通知情報が一致しません。");
  }
  const staffId = role === "staff" ? staffFromClaims(session.token) : null;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { removed: true };
    if (snap.data()?.uid !== session.uid || snap.data()?.companyId !== companyId
      || snap.data()?.role !== role || (role === "staff" && snap.data()?.staffId !== staffId)) {
      throw new HttpsError("permission-denied", "通知情報が一致しません。");
    }
    if (snap.data()?.active === false) return { removed: true };
    tx.update(ref, {
      active: false,
      removedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { removed: true };
  });
});

export const getPushStatus = onCall(async (request) => {
  const session = requireAuth(request);
  const input = PushStatusSchema.parse(request.data ?? {});
  const companyId = companyFromClaims(session.token);
  const role = session.token.role;
  if (role !== "staff" && role !== "admin") {
    throw new HttpsError("permission-denied", "通知状態を確認できません。");
  }
  const staffId = role === "staff" ? staffFromClaims(session.token) : null;
  if (staffId) {
    const profile = await db.collection("staffProfiles").doc(staffId).get();
    if (!profile.exists || profile.data()?.companyId !== companyId || profile.data()?.active !== true) {
      throw new HttpsError("permission-denied", "通知状態を確認できません。");
    }
  }
  const base = db.collection("pushTokens")
    .where("companyId", "==", companyId)
    .where("uid", "==", session.uid)
    .where("active", "==", true);
  const visible: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  // 既存の会社/UID/active索引を使い、旧役割の登録で20件が埋まっても先へ進みます。
  while (visible.length < 20) {
    let query = base.limit(20);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      const current = doc.data();
      if (current.role === role && (role !== "staff" || current.staffId === staffId)) {
        visible.push(doc);
        if (visible.length === 20) break;
      }
    }
    if (page.size < 20) break;
    cursor = page.docs[page.docs.length - 1];
  }
  const response: {
    enabled: boolean;
    tokens: { id: string; deviceSessionId: string; platform: string }[];
    test?: {
      queueId: string;
      status: string;
      finished: boolean;
      successCount: number;
      failureCount: number;
      invalidTokenCount: number;
      failureReason: PushFailureReason;
    };
  } = {
    enabled: visible.length > 0,
    tokens: visible.map((doc) => ({
      id: doc.id,
      deviceSessionId: doc.data().deviceSessionId ?? "",
      platform: doc.data().platform ?? "",
    })),
  };

  if (!input.queueId) return response;

  const queue = await db.collection("notificationQueue").doc(input.queueId).get();
  if (!queue.exists) {
    throw new HttpsError("not-found", "通知テストを確認できません。");
  }
  const data = queue.data() ?? {};
  if (
    data.companyId !== companyId ||
    data.data?.requestedByUid !== session.uid ||
    (role === "staff"
      ? data.category !== "push_test" || data.targetStaffId !== staffId
      : data.category !== "push_test_admin" || data.targetRole !== "admin")
  ) {
    throw new HttpsError("permission-denied", "通知テストを確認できません。");
  }
  const status = String(data.status ?? "queued");
  response.test = {
    queueId: input.queueId,
    status,
    finished: TERMINAL_PUSH_STATUSES.has(status),
    successCount: Number(data.successCount ?? 0),
    failureCount: Number(data.failureCount ?? 0),
    invalidTokenCount: Number(data.invalidTokenCount ?? 0),
    failureReason: normalizePushFailureReason(data.failureReason),
  };
  return response;
});

export const sendTestPush = onCall(async (request) => {
  const session = requireAuth(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const role = String(session.token.role ?? "");
  let result: { queued: boolean; queueId: string };
  if (role === "staff") {
    result = await enqueueNotification({
      companyId,
      targetStaffId: staffFromClaims(session.token),
      title: "通知テスト",
      body: "Lip Knots Crewから通知を受け取れます。",
      route: "/",
      category: "push_test",
      dedupeKey: `${session.uid}_${Date.now()}`,
      bypassQuietHours: true,
      data: { requestedByUid: session.uid },
    });
  } else if (role === "admin") {
    result = await enqueueNotification({
      companyId,
      targetRole: "admin",
      title: "管理者通知テスト",
      body: "Lip Knots Crewの管理通知を受け取れます。",
      route: "/",
      category: "push_test_admin",
      dedupeKey: `${session.uid}_${Date.now()}`,
      bypassQuietHours: true,
      data: { requestedByUid: session.uid },
    });
  } else {
    throw new HttpsError("permission-denied", "通知テストを実行できません。");
  }
  return result;
});

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
