import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { defineString } from "firebase-functions/params";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { auth, db } from "./firebase";
import {
  companyFromClaims,
  emailHash,
  normalizeEmail,
  requireAdmin,
  requireAuth,
  requestId,
  staffFromClaims,
} from "./utils";
import { hashText } from "./case-id";
import { assertProductionOperational, getProductionOperationalState } from "./system-safety";
import { assertDeviceAuthentication } from "./device-authentication";
import { readActiveStaffProfile, staffDeviceGenerationPattern, staffDeviceSessionIdPattern } from "./staff-session";

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
  assertBoundDeviceTarget(session.token, sessionId);
  const ref = db.collection("deviceSessions").doc(sessionId);
  await db.runTransaction(async (tx) => {
    const [, old] = await Promise.all([
      readActiveStaffProfile(tx, companyId, staffId, session.uid, session.token.auth_time, { requireIdentity: true, deviceClaims: session.token }),
      tx.get(ref),
    ]);
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
  assertBoundDeviceTarget(session.token, input.sessionId);
  const ref = db.collection("deviceSessions").doc(input.sessionId);
  await db.runTransaction(async (tx) => {
    const [, snap] = await Promise.all([
      readActiveStaffProfile(tx, companyId, staffId, session.uid, session.token.auth_time, { requireIdentity: true, deviceClaims: session.token }),
      tx.get(ref),
    ]);
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
    tx.update(ref, { lastSeenAt: FieldValue.serverTimestamp() });
  });

  return { active: true };
});

export const listMyDevices = onCall(async (request) => {
  const session = requireAuth(request);
  if (session.token.role !== "staff") {
    throw new HttpsError("permission-denied", "スタッフ権限を確認できません。");
  }
  const companyId = companyFromClaims(session.token);
  const staffId = staffFromClaims(session.token);
  const query = db.collection("deviceSessions")
    .where("companyId", "==", companyId)
    .where("staffId", "==", staffId)
    .orderBy("lastSeenAt", "desc")
    .limit(30);
  const snap = await db.runTransaction(async (tx) => {
    await readActiveStaffProfile(tx, companyId, staffId, session.uid, session.token.auth_time, { requireIdentity: true, deviceClaims: session.token });
    return tx.get(query);
  }, { readOnly: true });

  return {
    devices: snap.docs.map((doc) => ({
      id: doc.id,
      ...serialize(doc.data()),
    })),
  };
});

export const revokeMyDevice = onCall(async (request) => {
  const session = requireAuth(request);
  if (session.token.role !== "staff") {
    throw new HttpsError("permission-denied", "スタッフ権限を確認できません。");
  }
  const companyId = companyFromClaims(session.token);
  const staffId = staffFromClaims(session.token);
  const input = DeviceSchema.parse(request.data ?? {});
  const ref = db.collection("deviceSessions").doc(input.sessionId);
  await db.runTransaction(async (tx) => {
    const [, snap] = await Promise.all([
      readActiveStaffProfile(tx, companyId, staffId, session.uid, session.token.auth_time, { requireIdentity: true, deviceClaims: session.token }),
      tx.get(ref),
    ]);
    if (
      !snap.exists ||
      snap.data()?.companyId !== companyId ||
      snap.data()?.staffId !== staffId
    ) {
      throw new HttpsError("not-found", "端末が見つかりません。");
    }
    await revokeBoundDeviceCredential(tx, snap);
    tx.update(ref, {
      active: false,
      revokedAt: FieldValue.serverTimestamp(),
      revokedBy: session.uid,
      revokeReason: "staff.self",
    });
  });
  await revokeDevicePushTokens(companyId, staffId, input.sessionId);

  return { revoked: true };
});

export const revokeAllMyDevices = onCall(async (request) => {
  const session = requireAuth(request);
  if (session.token.role !== "staff") {
    throw new HttpsError("permission-denied", "スタッフ権限を確認できません。");
  }
  const companyId = companyFromClaims(session.token);
  const staffId = staffFromClaims(session.token);
  const readCaller = (tx: FirebaseFirestore.Transaction) =>
    readActiveStaffProfile(tx, companyId, staffId, session.uid, session.token.auth_time, { requireIdentity: true, deviceClaims: session.token });
  const profile = await db.runTransaction(readCaller, { readOnly: true });
  const authUids = Array.isArray(profile.authUids) ? [...profile.authUids] : [];

  const count = await revokeAllSessions(
    companyId,
    staffId,
    authUids,
    session.uid,
    "staff.self_all",
    async (tx) => {
      const current = await readCaller(tx);
      if (JSON.stringify(current.authUids) !== JSON.stringify(authUids)) {
        throw new HttpsError("aborted", "端末の認証対象が変更されました。再読み込みしてください。");
      }
    }
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

type StaffDeviceAuthPlan =
  | { status: "eligible"; staffId: string; email: string; operationId: string; mode: "first_login" | "existing_login" }
  | { status: "enabled"; staffId: string; operationId: string | null }
  | { status: "ineligible"; staffId: string };

const ScopedStaffId = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const StaffDeviceAuthSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), staffId: ScopedStaffId }).strict(),
  z.object({ action: z.literal("enable"), staffId: ScopedStaffId, operationId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
const reservedAdminEmails = defineString("ADMIN_EMAILS", { default: "info@lipknots.com" });
const staffDeviceAuthAuditAction = "device.authentication.enable.admin";

export const adminStaffDeviceAuthentication = onCall(async request => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = StaffDeviceAuthSchema.safeParse(request.data);
  if (!input.success) throw new HttpsError("invalid-argument", "操作とスタッフを確認してください。");
  const { staffId } = input.data;
  await requireCurrentDeviceAdmin(session.uid, companyId, session.token.auth_time);
  const profileRef = db.collection("staffProfiles").doc(staffId);
  const receiptRef = db.collection("auditLogs").doc("device_auth_" + hashText(JSON.stringify([companyId, staffId]), 64));
  const inspect = async (tx: Pick<FirebaseFirestore.Transaction, "get">) => {
    const profileSnap = await tx.get(profileRef);
    const profile = profileSnap.data();
    if (profile?.companyId !== companyId) throw new HttpsError("not-found", "スタッフが見つかりません。");
    const receipt = (await tx.get(receiptRef)).data();
    if (receipt && (receipt.companyId !== companyId || receipt.targetStaffId !== staffId ||
        receipt.action !== staffDeviceAuthAuditAction || typeof receipt.operationId !== "string" ||
        !/^[a-f0-9]{64}$/.test(receipt.operationId) || profile.deviceBoundAuthRequired !== true)) {
      throw new HttpsError("failed-precondition", "前回の切替記録を確認できません。");
    }
    if (profile.deviceBoundAuthRequired === true) {
      return { plan: { status: "enabled", staffId, operationId: receipt?.operationId ?? null } as const, uid: null };
    }
    const unavailable = { plan: { status: "ineligible", staffId } as const, uid: null };
    const emails = profile.emails, uids = profile.authUids === undefined ? [] : profile.authUids;
    if (profile.active !== true || !Array.isArray(emails) || emails.length !== 1 ||
        typeof emails[0] !== "string" || !Array.isArray(uids) || uids.length > 1) return unavailable;
    const email = normalizeEmail(emails[0]);
    if (!z.string().email().max(254).safeParse(email).success ||
        reservedAdminEmails.value().split(",").map(normalizeEmail).includes(email)) return unavailable;
    const emailKey = emailHash(email);
    const uid = uids.length ? uids[0] : null;
    if (uids.length && !ScopedStaffId.safeParse(uid).success) return unavailable;

    const indexSnap = await tx.get(db.collection("emailIndex").doc(emailKey));
    const index = indexSnap.data();
    if (index?.active !== true || index.companyId !== companyId || index.staffId !== staffId ||
        !profileSnap.updateTime || !indexSnap.updateTime) return unavailable;
    let identityVersion: FirebaseFirestore.Timestamp | null = null;
    if (uid) {
      const identity = await tx.get(db.collection("authIdentities").doc(uid));
      const linked = identity.data();
      if (linked?.active !== true || linked.companyId !== companyId || linked.staffId !== staffId ||
          linked.emailHash !== emailKey || linked.deviceCredentials !== undefined || !identity.updateTime) return unavailable;
      identityVersion = identity.updateTime;
    } else if ((await tx.get(db.collection("staffLoginEnrollments").doc(staffId))).exists) {
      return unavailable;
    }
    const revisions = [profileSnap.updateTime, indexSnap.updateTime, identityVersion]
      .map(version => version ? [version.seconds, version.nanoseconds] : null);
    const operationId = hashText(JSON.stringify([session.uid, companyId, staffId, emailKey, uid, revisions]), 64);
    return { plan: { status: "eligible", staffId, email, operationId, mode: uid ? "existing_login" : "first_login" } as const, uid };
  };
  const observed = await db.runTransaction(inspect, { readOnly: true });
  const command = input.data;
  if (observed.plan.status === "enabled") {
    if (command.action === "enable" && observed.plan.operationId !== command.operationId) {
      throw new HttpsError("aborted", "他の操作で切替済みです。再確認してください。");
    }
    return observed.plan satisfies StaffDeviceAuthPlan;
  }
  if (command.action === "enable" && (observed.plan.status !== "eligible" || observed.plan.operationId !== command.operationId)) {
    throw new HttpsError("aborted", "対象の状態が変わりました。再確認してください。");
  }
  if (observed.plan.status !== "eligible") return observed.plan satisfies StaffDeviceAuthPlan;
  const eligible = await matchesDeviceAuthAccount(observed.plan.email, observed.uid, companyId, staffId);
  if (command.action === "preview") {
    return (eligible ? observed.plan : { status: "ineligible", staffId }) satisfies StaffDeviceAuthPlan;
  }
  if (!eligible) throw new HttpsError("aborted", "アカウントを再確認してください。");
  return db.runTransaction(async tx => {
    const current = (await inspect(tx)).plan;
    if (current.status === "enabled" && current.operationId === command.operationId) return current;
    if (current.status !== "eligible" || current.operationId !== command.operationId) {
      throw new HttpsError("aborted", "対象の状態が変わりました。再確認してください。");
    }
    if (!(await getProductionOperationalState(companyId, tx)).operational) {
      throw new HttpsError("failed-precondition", "全体停止中は認証方式を切り替えられません。");
    }
    tx.update(profileRef, { deviceBoundAuthRequired: true, deviceBoundAuthEnabledAt: FieldValue.serverTimestamp() });
    tx.set(receiptRef, {
      companyId, actorUid: session.uid, action: staffDeviceAuthAuditAction, targetStaffId: staffId,
      operationId: command.operationId, mode: current.mode, createdAt: FieldValue.serverTimestamp(),
    });
    return { status: "enabled", staffId, operationId: command.operationId } satisfies StaffDeviceAuthPlan;
  });
});

async function requireCurrentDeviceAdmin(uid: string, companyId: string, authTime: unknown): Promise<void> {
  const user = await auth.getUser(uid);
  const cutoff = user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : 0;
  if (user.disabled || !user.emailVerified || user.customClaims?.role !== "admin" ||
      user.customClaims?.companyId !== companyId || typeof authTime !== "number" || !Number.isSafeInteger(authTime) ||
      authTime < 0 || authTime > 253402300799 || !Number.isFinite(cutoff) || authTime * 1000 < cutoff) {
    throw new HttpsError("permission-denied", "現在の管理者権限を確認できません。");
  }
}

async function matchesDeviceAuthAccount(email: string, uid: string | null, companyId: string, staffId: string): Promise<boolean> {
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "auth/user-not-found") return uid === null;
    throw new HttpsError("unavailable", "アカウントを確認できません。");
  }
  return uid !== null && user.uid === uid && user.disabled === false && user.emailVerified === true &&
    normalizeEmail(user.email ?? "") === email && user.customClaims?.role === "staff" &&
    user.customClaims.companyId === companyId && user.customClaims.staffId === staffId;
}

function assertBoundDeviceTarget(token: Record<string, unknown>, sessionId: string): void {
  if (Object.hasOwn(token, "crewDeviceSession") && token.crewDeviceSession !== sessionId) {
    throw new HttpsError("permission-denied", "この端末の認証を確認できません。");
  }
}

async function revokeBoundDeviceCredential(
  tx: FirebaseFirestore.Transaction,
  device: FirebaseFirestore.DocumentSnapshot
): Promise<void> {
  const current = device.data();
  if (!current || !Object.hasOwn(current, "credentialGeneration")) return;
  const { uid, companyId, staffId, credentialGeneration } = current;
  const invalid = () => new HttpsError("aborted", "端末の認証を照合できません。端末一覧を再読み込みしてください。");
  if (typeof uid !== "string" || !uid || uid.includes("/") || !staffDeviceSessionIdPattern.test(device.id) ||
      typeof credentialGeneration !== "string" || !staffDeviceGenerationPattern.test(credentialGeneration)) throw invalid();
  const identityRef = db.collection("authIdentities").doc(uid);
  const linked = (await tx.get(identityRef)).data();
  if (!linked || linked.companyId !== companyId || linked.staffId !== staffId) throw invalid();
  const credentials = linked.deviceCredentials;
  if (credentials == null || typeof credentials !== "object" || Array.isArray(credentials) ||
      !Object.hasOwn(credentials, device.id)) throw invalid();
  if (current.active === false && credentials[device.id] === null) return;
  if (credentials[device.id] !== credentialGeneration) throw invalid();
  tx.update(identityRef, { deviceCredentials: { ...credentials, [device.id]: null } });
}

async function revokeSingleSession(
  original: FirebaseFirestore.DocumentSnapshot,
  changes: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>
): Promise<void> {
  await db.runTransaction(async (tx) => {
    const latest = await tx.get(original.ref);
    const expected = original.data(), current = latest.data();
    if (!expected || !current || ["companyId", "staffId", "uid", "deviceId", "active", "revokedAt", "credentialGeneration"]
      .some(key => JSON.stringify(current[key]) !== JSON.stringify(expected[key]))) {
      throw new HttpsError("aborted",
        "端末情報が変更されています。端末一覧を再読込してログアウトをやり直してください。");
    }
    await revokeBoundDeviceCredential(tx, latest);
    tx.update(original.ref, changes);
  });
}
async function revokeAllSessions(
  companyId: string,
  staffId: string,
  authUids: unknown[],
  actorUid: string,
  reason: string,
  authorize?: (tx: FirebaseFirestore.Transaction) => Promise<void>,
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
  if (!devices.size && authorize) await db.runTransaction(authorize, { readOnly: true });
  let deviceCount = 0;
  for (let index = 0; index < devices.docs.length; index += 400) {
    const chunk = devices.docs.slice(index, index + 400);
    try {
      await db.runTransaction(async (tx) => {
        await authorize?.(tx);
        const latest = await Promise.all(chunk.map(device => tx.get(device.ref)));
        for (const [offset, original] of chunk.entries()) {
          const expected = original.data(), current = latest[offset]?.data();
          if (!current || ["companyId", "staffId", "uid", "deviceId", "active", "revokedAt", "credentialGeneration"]
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
    } catch (error) {
      if (deviceCount === 0 && error instanceof HttpsError) throw error;
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
