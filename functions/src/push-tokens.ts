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
import { enqueueNotification, readPushTestRecipient, type StaffPushTestRequest } from "./notification-core";
import { readActiveStaffProfile, readStaffDeviceCredential, type StaffDeviceCredential } from "./staff-session";
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
  const credential = staffId ? readStaffDeviceCredential(session.token) : null;
  if (staffId && (!input.deviceSessionId.trim() || /[\/\\\u0000-\u001f\u007f]/.test(input.deviceSessionId))) {
    throw new HttpsError("permission-denied", "端末登録を確認できません。再読み込みしてください。");
  }
  const tokenHash = hashToken(input.token);
  const ref = db.collection("pushTokens").doc(tokenHash);
  await db.runTransaction(async (tx) => {
    if (staffId) {
      await readActiveStaffProfile(tx, companyId, staffId, session.uid, session.token.auth_time, { deviceClaims: session.token });
      await verifyPushDevice(tx, companyId, staffId, session.uid, session.token.auth_time, input.deviceSessionId, credential);
    }
    tx.set(ref, {
      companyId,
      uid: session.uid,
      role,
      staffId,
      token: input.token,
      tokenHash,
      deviceSessionId: input.deviceSessionId,
      crewDeviceSession: credential?.crewDeviceSession ?? null,
      crewDeviceGeneration: credential?.crewDeviceGeneration ?? null,
      registeredAuthTime: credential ? session.token.auth_time : null,
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
  const credential = staffId ? readStaffDeviceCredential(session.token) : null;
  return db.runTransaction(async (tx) => {
    if (staffId) {
      await readActiveStaffProfile(tx, companyId, staffId, session.uid, session.token.auth_time, { deviceClaims: session.token });
      if (credential) await verifyPushDevice(tx, companyId, staffId, session.uid, session.token.auth_time, credential.crewDeviceSession, credential);
    }
    const snap = await tx.get(ref);
    if (!snap.exists) return { removed: true };
    if (snap.data()?.uid !== session.uid || snap.data()?.companyId !== companyId
      || snap.data()?.role !== role || (role === "staff" && (snap.data()?.staffId !== staffId || !pushDeviceMatches(snap.data(), credential)))) {
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
  const credential = staffId ? readStaffDeviceCredential(session.token) : null;
  if (staffId) {
    await db.runTransaction(async tx => {
      await readActiveStaffProfile(tx, companyId, staffId, session.uid, session.token.auth_time, { deviceClaims: session.token });
      if (credential) await verifyPushDevice(tx, companyId, staffId, session.uid, session.token.auth_time, credential.crewDeviceSession, credential);
    }, { readOnly: true });
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
      if (current.role === role && (role !== "staff" || (current.staffId === staffId && pushDeviceMatches(current, credential)))) {
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
      deliveryVerificationRequired?: true;
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
  const target = readPushTestRecipient(data);
  const categoryMatches = data.category === (role === "staff" ? "push_test" : "push_test_admin");
  const targetMatches = target ? target.uid === session.uid && (target.staff?.staffId ?? null) === staffId &&
      pushDeviceMatches(target.staff?.deviceCredential, credential)
    : !credential && data.targetUid === undefined && (role === "staff" ? data.targetStaffId === staffId : data.targetRole === "admin");
  if (data.companyId !== companyId || data.data?.requestedByUid !== session.uid || !categoryMatches || !targetMatches) {
    throw new HttpsError("permission-denied", "通知テストを確認できません。");
  }
  const status = data.status === "superseded" ? "error" : String(data.status ?? "queued");
  response.test = {
    queueId: input.queueId,
    status,
    finished: TERMINAL_PUSH_STATUSES.has(status),
    successCount: Number(data.successCount ?? 0),
    failureCount: Number(data.failureCount ?? 0),
    invalidTokenCount: Number(data.invalidTokenCount ?? 0),
    failureReason: normalizePushFailureReason(data.failureReason),
    ...(data.deliveryVerificationRequired === true ? { deliveryVerificationRequired: true } : {}),
  };
  return response;
});

export const sendTestPush = onCall(async (request) => {
  const session = requireAuth(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const role = session.token.role;
  if (role !== "staff" && role !== "admin") {
    throw new HttpsError("permission-denied", "通知テストを実行できません。");
  }
  let testRequest: StaffPushTestRequest | undefined;
  if (role === "staff") {
    const staffId = staffFromClaims(session.token);
    const authTime = session.token.auth_time;
    if (typeof authTime !== "number" || !Number.isSafeInteger(authTime) ||
        authTime < 0 || authTime > 253402300799) {
      throw new HttpsError("permission-denied", "ログイン状態を確認してください。");
    }
    const credential = readStaffDeviceCredential(session.token);
    await db.runTransaction(async tx => {
      await readActiveStaffProfile(tx, companyId, staffId, session.uid, authTime, { requireIdentity: true, deviceClaims: session.token });
      if (credential) await verifyPushDevice(tx, companyId, staffId, session.uid, authTime, credential.crewDeviceSession, credential);
    }, { readOnly: true });
    testRequest = { staffId, authTime, ...(credential ? { deviceCredential: credential } : {}) };
  }
  return enqueueNotification({
    companyId,
    targetUid: session.uid,
    title: role === "staff" ? "通知テスト" : "管理者通知テスト",
    body: role === "staff" ? "Lip Knots Crewから通知を受け取れます。" : "Lip Knots Crewの管理通知を受け取れます。",
    route: "/",
    category: role === "staff" ? "push_test" : "push_test_admin",
    dedupeKey: [session.uid, ...(testRequest?.deviceCredential ? [testRequest.deviceCredential.crewDeviceSession] : []), Date.now()].join("_"),
    bypassQuietHours: true,
    data: { requestedByUid: session.uid },
    ...(testRequest ? { testRequest } : {}),
  });
});

function pushDeviceMatches(
  record: FirebaseFirestore.DocumentData | undefined, credential: StaffDeviceCredential | null,
): boolean {
  if (!credential) return record?.crewDeviceSession == null && record?.crewDeviceGeneration == null;
  return record?.crewDeviceSession === credential.crewDeviceSession &&
    record.crewDeviceGeneration === credential.crewDeviceGeneration;
}

async function verifyPushDevice(
  tx: Pick<FirebaseFirestore.Transaction, "get">, companyId: string, staffId: string, uid: string,
  authTime: unknown, deviceSessionId: string, credential: StaffDeviceCredential | null,
): Promise<void> {
  const fail = () => new HttpsError("permission-denied", "端末登録を確認できません。再ログインしてください。");
  if (credential && (deviceSessionId !== credential.crewDeviceSession || typeof authTime !== "number" ||
      !Number.isSafeInteger(authTime) || authTime < 0 || authTime > 253402300799)) throw fail();
  const registered = (await tx.get(db.collection("deviceSessions").doc(deviceSessionId))).data();
  if (registered?.active !== true || registered.companyId !== companyId || registered.staffId !== staffId ||
      registered.uid !== uid || (credential && registered.credentialGeneration !== credential.crewDeviceGeneration)) throw fail();
  assertDeviceAuthentication(registered, authTime);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
