import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { auth, db } from "./firebase";
import {
  companyFromClaims,
  requireAdmin,
  requireAuth,
  requestId,
  staffFromClaims,
} from "./utils";
import { hashText } from "./case-id";
import { assertProductionOperational } from "./system-safety";
import { assertDeviceAuthentication } from "./device-authentication";

const RegisterSchema = z.object({
  deviceId: z.string().min(12).max(120),
  label: z.string().max(100).default(""),
  platform: z.string().max(100).default(""),
  userAgent: z.string().max(500).default(""),
});

const DeviceSchema = z.object({
  sessionId: z.string().min(10),
});

const AdminDevicesSchema = z.object({
  staffId: z.string().min(1),
});

const AdminRevokeSchema = z.object({
  staffId: z.string().min(1),
  sessionId: z.string().optional(),
  allDevices: z.boolean().default(false),
});

export const registerDeviceSession = onCall(async (request) => {
  const session = requireAuth(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const staffId = staffFromClaims(session.token);
  const input = RegisterSchema.parse(request.data ?? {});

  const sessionId = `device_${hashText(
    `${companyId}|${staffId}|${session.uid}|${input.deviceId}`,
    28
  )}`;
  const ref = db.collection("deviceSessions").doc(sessionId);
  await db.runTransaction(async (tx) => {
    const [profile, old] = await Promise.all([
      tx.get(db.collection("staffProfiles").doc(staffId)),
      tx.get(ref),
    ]);
    if (!profile.exists || profile.data()?.companyId !== companyId || profile.data()?.active !== true) {
      throw new HttpsError("permission-denied", "このアカウントは利用停止中です。");
    }
    if (old.exists) {
      const current = old.data()!;
      if (current.companyId !== companyId || current.staffId !== staffId
        || current.uid !== session.uid || current.deviceId !== input.deviceId) {
        throw new HttpsError("permission-denied", "端末情報を確認できません。");
      }
      assertDeviceAuthentication(current, session.token.auth_time);
    }
    tx.set(ref, {
      companyId,
      staffId,
      uid: session.uid,
      deviceId: input.deviceId,
      label: input.label,
      platform: input.platform,
      userAgent: input.userAgent,
      active: true,
      lastSeenAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...(old.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    }, { merge: true });
  });

  return { sessionId, active: true };
});

export const heartbeatDeviceSession = onCall(async (request) => {
  const session = requireAuth(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const staffId = staffFromClaims(session.token);
  const input = DeviceSchema.parse(request.data ?? {});
  const ref = db.collection("deviceSessions").doc(input.sessionId);
  const snap = await ref.get();

  if (
    !snap.exists ||
    snap.data()?.companyId !== companyId ||
    snap.data()?.uid !== session.uid ||
    snap.data()?.staffId !== staffId
  ) {
    throw new HttpsError("permission-denied", "端末情報を確認できません。");
  }
  if (snap.data()?.active !== true) {
    throw new HttpsError("permission-denied", "この端末はログアウトされています。");
  }
  assertDeviceAuthentication(snap.data()!, session.token.auth_time);

  await ref.set({
    lastSeenAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { active: true };
});

export const listMyDevices = onCall(async (request) => {
  const session = requireAuth(request);
  const companyId = companyFromClaims(session.token);
  const staffId = staffFromClaims(session.token);
  const snap = await db.collection("deviceSessions")
    .where("companyId", "==", companyId)
    .where("staffId", "==", staffId)
    .orderBy("lastSeenAt", "desc")
    .limit(30)
    .get();

  return {
    devices: snap.docs.map((doc) => ({
      id: doc.id,
      ...serialize(doc.data()),
    })),
  };
});

export const revokeMyDevice = onCall(async (request) => {
  const session = requireAuth(request);
  const companyId = companyFromClaims(session.token);
  const staffId = staffFromClaims(session.token);
  const input = DeviceSchema.parse(request.data ?? {});
  const ref = db.collection("deviceSessions").doc(input.sessionId);
  const snap = await ref.get();

  if (
    !snap.exists
    || snap.data()?.companyId !== companyId
    || snap.data()?.staffId !== staffId
  ) {
    throw new HttpsError("not-found", "端末が見つかりません。");
  }

  await revokeSingleSession(snap, {
    active: false,
    revokedAt: FieldValue.serverTimestamp(),
    revokedBy: session.uid,
    revokeReason: "staff.self",
  });
  await revokeDevicePushTokens(companyId, staffId, input.sessionId);

  return { revoked: true };
});

export const revokeAllMyDevices = onCall(async (request) => {
  const session = requireAuth(request);
  const companyId = companyFromClaims(session.token);
  const staffId = staffFromClaims(session.token);
  const profile = await db.collection("staffProfiles").doc(staffId).get();
  if (!profile.exists || profile.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "スタッフが見つかりません。");
  }
  const authUids = Array.isArray(profile.data()?.authUids)
    ? profile.data()?.authUids
    : [];

  const count = await revokeAllSessions(
    companyId,
    staffId,
    authUids,
    session.uid,
    "staff.self_all"
  );
  return { revoked: true, count };
});

export const getStaffDevices = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = AdminDevicesSchema.parse(request.data ?? {});
  const profile = await db.collection("staffProfiles").doc(input.staffId).get();

  if (!profile.exists || profile.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "スタッフが見つかりません。");
  }

  const snap = await db.collection("deviceSessions")
    .where("companyId", "==", companyId)
    .where("staffId", "==", input.staffId)
    .orderBy("lastSeenAt", "desc")
    .limit(30)
    .get();

  return {
    staffId: input.staffId,
    displayName: profile.data()?.displayName ?? "",
    devices: snap.docs.map((doc) => ({
      id: doc.id,
      ...serialize(doc.data()),
    })),
  };
});

export const adminRevokeStaffDevices = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = AdminRevokeSchema.parse(request.data ?? {});
  const profile = await db.collection("staffProfiles").doc(input.staffId).get();

  if (!profile.exists || profile.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "スタッフが見つかりません。");
  }

  if (input.allDevices) {
    const authUids = Array.isArray(profile.data()?.authUids)
      ? profile.data()?.authUids
      : [];
    const count = await revokeAllSessions(
      companyId,
      input.staffId,
      authUids,
      session.uid,
      "admin.all_devices"
    );
    return { revoked: true, mode: "all", count };
  }

  if (!input.sessionId) {
    throw new HttpsError("invalid-argument", "端末を指定してください。");
  }

  const deviceRef = db.collection("deviceSessions").doc(input.sessionId);
  const device = await deviceRef.get();
  if (
    !device.exists ||
    device.data()?.staffId !== input.staffId ||
    device.data()?.companyId !== companyId
  ) {
    throw new HttpsError("not-found", "端末が見つかりません。");
  }

  await revokeSingleSession(device, {
    active: false,
    revokedAt: FieldValue.serverTimestamp(),
    revokedBy: session.uid,
    revokeReason: "admin.single_device",
  });
  await revokeDevicePushTokens(companyId, input.staffId, input.sessionId);

  await db.collection("auditLogs").add({
    companyId,
    actorUid: session.uid,
    action: "device.revoke.admin",
    targetStaffId: input.staffId,
    targetDeviceSessionId: input.sessionId,
    requestId: requestId("audit"),
    createdAt: FieldValue.serverTimestamp(),
  });

  return { revoked: true, mode: "single" };
});

async function revokeSingleSession(
  original: FirebaseFirestore.DocumentSnapshot,
  changes: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>
): Promise<void> {
  await db.runTransaction(async (tx) => {
    const latest = await tx.get(original.ref);
    const expected = original.data(), current = latest.data();
    if (!expected || !current || ["companyId", "staffId", "uid", "deviceId", "active", "revokedAt"]
      .some(key => JSON.stringify(current[key]) !== JSON.stringify(expected[key]))) {
      throw new HttpsError("aborted",
        "端末情報が変更されています。端末一覧を再読込してログアウトをやり直してください。");
    }
    tx.update(original.ref, changes);
  });
}
async function revokeAllSessions(
  companyId: string,
  staffId: string,
  authUids: unknown[],
  actorUid: string,
  reason: string
): Promise<number> {
  const targetError = () => new HttpsError("failed-precondition",
    "全端末ログアウトの認証対象を確認できません。端末・認証情報は変更していません。管理者に登録情報の確認を依頼してください。");
  if (!authUids.length || authUids.some(uid => typeof uid !== "string" || !uid.trim()
    || /[\/\\\u0000-\u001f\u007f]/.test(uid))) throw targetError();
  const targetUids = [...new Set(authUids as string[])];
  if (reason === "staff.self_all" && !targetUids.includes(actorUid)) throw targetError();
  // 古いプロフィールのUIDで別所属の認証を解除しないよう、書込前に照合します。
  for (const uid of targetUids) {
    const identity = await db.collection("authIdentities").doc(uid).get();
    if (!identity.exists || identity.data()?.companyId !== companyId
      || identity.data()?.staffId !== staffId) throw targetError();
  }
  const devices = await db.collection("deviceSessions")
    .where("companyId", "==", companyId)
    .where("staffId", "==", staffId)
    .get();
  if (devices.docs.some(device => !targetUids.includes(device.data().uid))) throw targetError();
  let deviceCount = 0;
  for (let index = 0; index < devices.docs.length; index += 400) {
    const chunk = devices.docs.slice(index, index + 400);
    try {
      await db.runTransaction(async (tx) => {
        const latest = await Promise.all(chunk.map(device => tx.get(device.ref)));
        for (const [offset, original] of chunk.entries()) {
          const expected = original.data(), current = latest[offset]?.data();
          if (!current || ["companyId", "staffId", "uid", "deviceId", "active", "revokedAt"]
            .some(key => JSON.stringify(current[key]) !== JSON.stringify(expected[key]))) {
            throw new Error("Revocation device changed");
          }
        }
        for (const device of latest) {
          tx.update(device.ref, {
            active: false,
            revokedAt: FieldValue.serverTimestamp(),
            revokedBy: actorUid,
            revokeReason: reason,
          });
        }
      });
      deviceCount += chunk.length;
    } catch {
      throw new HttpsError("aborted",
        "端末の停止処理を完了できませんでした。端末一覧を再読込して全端末ログアウトを再実行してください。",
        { operation: "revoke-all-sessions", stage: "devices", deviceCount, retryable: true });
    }
  }
  await revokeDevicePushTokens(companyId, staffId);

  let authRevokedCount = 0;
  let authFailedCount = 0;
  let identityFailedCount = 0;
  // 端末のinactiveだけを全面完了とせず、再試行でも全UIDの認証失効を確認します。
  for (const uid of targetUids) {
    const identityRef = db.collection("authIdentities").doc(uid);
    try {
      const latest = await identityRef.get();
      if (!latest.exists || latest.data()?.companyId !== companyId
        || latest.data()?.staffId !== staffId) throw new Error("Revocation identity changed");
      await auth.revokeRefreshTokens(uid);
      authRevokedCount++;
    } catch {
      authFailedCount++;
      continue;
    }
    try {
      await db.runTransaction(async (tx) => {
        const latest = await tx.get(identityRef);
        if (!latest.exists || latest.data()?.companyId !== companyId
          || latest.data()?.staffId !== staffId) throw new Error("Revocation identity changed");
        tx.update(identityRef, {
          active: false,
          revokedAt: FieldValue.serverTimestamp(),
          revokeReason: reason,
        });
      });
    } catch {
      identityFailedCount++;
    }
  }
  if (authFailedCount || identityFailedCount) {
    throw new HttpsError("unavailable",
      "端末と通知の停止は完了しましたが、認証の解除または解除記録の保存が一部完了していません。全端末ログアウトを再実行してください。",
      { operation: "revoke-all-sessions", deviceCount: devices.size, pushRevoked: true,
        authRevokedCount, authFailedCount, identityFailedCount, retryable: true });
  }
  return devices.size;
}

async function revokeDevicePushTokens(
  companyId: string,
  staffId: string,
  deviceSessionId?: string
): Promise<void> {
  const tokens = await db.collection("pushTokens")
    .where("companyId", "==", companyId)
    .where("staffId", "==", staffId)
    .where("active", "==", true)
    .get();
  const targets = tokens.docs.filter((doc) => !deviceSessionId || doc.data().deviceSessionId === deviceSessionId);
  for (let index = 0; index < targets.length; index += 400) {
    const chunk = targets.slice(index, index + 400);
    await db.runTransaction(async (tx) => {
      const latest = await Promise.all(chunk.map((doc) => tx.get(doc.ref)));
      for (const doc of latest) {
        const current = doc.data();
        // 別アカウントへ再登録されたトークンを古い一覧で失効させないよう再確認します。
        if (!doc.exists || current?.active !== true || current.companyId !== companyId
          || current.staffId !== staffId || (deviceSessionId && current.deviceSessionId !== deviceSessionId)) continue;
        tx.update(doc.ref, {
          active: false,
          removedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });
  }
}

function serialize(
  data: FirebaseFirestore.DocumentData
): FirebaseFirestore.DocumentData {
  const result: FirebaseFirestore.DocumentData = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = value instanceof Timestamp
      ? value.toDate().toISOString()
      : value;
  }
  return result;
}
