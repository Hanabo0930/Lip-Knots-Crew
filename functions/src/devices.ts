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

  const profile = await db.collection("staffProfiles").doc(staffId).get();
  if (!profile.exists || profile.data()?.active !== true) {
    throw new HttpsError("permission-denied", "このアカウントは利用停止中です。");
  }

  const sessionId = `device_${hashText(
    `${companyId}|${staffId}|${session.uid}|${input.deviceId}`,
    28
  )}`;
  const ref = db.collection("deviceSessions").doc(sessionId);
  const old = await ref.get();

  await ref.set({
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

  return { sessionId, active: true };
});

export const heartbeatDeviceSession = onCall(async (request) => {
  const session = requireAuth(request);
  await assertProductionOperational(companyFromClaims(session.token));
  const staffId = staffFromClaims(session.token);
  const input = DeviceSchema.parse(request.data ?? {});
  const ref = db.collection("deviceSessions").doc(input.sessionId);
  const snap = await ref.get();

  if (
    !snap.exists ||
    snap.data()?.uid !== session.uid ||
    snap.data()?.staffId !== staffId
  ) {
    throw new HttpsError("permission-denied", "端末情報を確認できません。");
  }
  if (snap.data()?.active !== true) {
    throw new HttpsError("permission-denied", "この端末はログアウトされています。");
  }

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
  const staffId = staffFromClaims(session.token);
  const input = DeviceSchema.parse(request.data ?? {});
  const ref = db.collection("deviceSessions").doc(input.sessionId);
  const snap = await ref.get();

  if (!snap.exists || snap.data()?.staffId !== staffId) {
    throw new HttpsError("not-found", "端末が見つかりません。");
  }

  await ref.set({
    active: false,
    revokedAt: FieldValue.serverTimestamp(),
    revokedBy: session.uid,
    revokeReason: "staff.self",
  }, { merge: true });

  return { revoked: true };
});

export const revokeAllMyDevices = onCall(async (request) => {
  const session = requireAuth(request);
  const staffId = staffFromClaims(session.token);
  const profile = await db.collection("staffProfiles").doc(staffId).get();
  const authUids = Array.isArray(profile.data()?.authUids)
    ? profile.data()?.authUids.map((value: unknown) => String(value))
    : [];

  await revokeAllSessions(staffId, authUids, session.uid, "staff.self_all");
  return { revoked: true, count: authUids.length };
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
      ? profile.data()?.authUids.map((value: unknown) => String(value))
      : [];
    await revokeAllSessions(
      input.staffId,
      authUids,
      session.uid,
      "admin.all_devices"
    );
    return { revoked: true, mode: "all", count: authUids.length };
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

  await deviceRef.set({
    active: false,
    revokedAt: FieldValue.serverTimestamp(),
    revokedBy: session.uid,
    revokeReason: "admin.single_device",
  }, { merge: true });

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

async function revokeAllSessions(
  staffId: string,
  authUids: string[],
  actorUid: string,
  reason: string
): Promise<void> {
  const devices = await db.collection("deviceSessions")
    .where("staffId", "==", staffId)
    .get();
  const batch = db.batch();
  for (const device of devices.docs) {
    batch.set(device.ref, {
      active: false,
      revokedAt: FieldValue.serverTimestamp(),
      revokedBy: actorUid,
      revokeReason: reason,
    }, { merge: true });
  }
  if (!devices.empty) await batch.commit();

  for (const uid of [...new Set(authUids)]) {
    try {
      await auth.revokeRefreshTokens(uid);
      await db.collection("authIdentities").doc(uid).set({
        active: false,
        revokedAt: FieldValue.serverTimestamp(),
        revokeReason: reason,
      }, { merge: true });
    } catch (error) {
      console.error("Failed to revoke Firebase session", { uid, error });
    }
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
