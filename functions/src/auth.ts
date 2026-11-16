import { defineString } from "firebase-functions/params";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { auth, db } from "./firebase";
import { readActiveStaffProfile } from "./staff-session";
import {
  companyFromClaims,
  emailHash,
  normalizeEmail,
  requireAdmin,
  requireAuth,
  staffFromClaims,
} from "./utils";

const adminEmails = defineString("ADMIN_EMAILS", { default: "info@lipknots.com" });
const defaultCompanyId = defineString("DEFAULT_COMPANY_ID", { default: "lipknots" });

const BootstrapSchema = z.object({
  refreshDirectory: z.boolean().optional(),
});

function serializeField(value: unknown): unknown {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  return value;
}

function serializeDocument(data: FirebaseFirestore.DocumentData): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = serializeField(value);
  }
  return result;
}

function formatWorkDate(raw: FirebaseFirestore.DocumentData): string {
  const rawWorkDate = raw.workDate;
  if (rawWorkDate instanceof Timestamp) {
    return rawWorkDate.toDate().toLocaleDateString("ja-JP", {
      month: "numeric",
      day: "numeric",
      weekday: "short",
    });
  }
  if (typeof rawWorkDate === "string") {
    return rawWorkDate;
  }
  return String(raw.dateKey ?? "");
}

function customClaimsMatch(
  current: Record<string, unknown> | undefined,
  expected: Record<string, string>,
): boolean {
  if (!current) return false;
  const currentKeys = Object.keys(current).sort();
  const expectedKeys = Object.keys(expected).sort();
  return currentKeys.length === expectedKeys.length
    && currentKeys.every((key, index) => key === expectedKeys[index])
    && expectedKeys.every((key) => current[key] === expected[key]);
}

async function fetchAdminDirectory(companyId: string) {
  const [jobsSnap, staffSnap] = await Promise.all([
    db.collection("jobs")
      .where("companyId", "==", companyId)
      .orderBy("workDate", "asc")
      .limit(100)
      .get(),
    db.collection("staffProfiles")
      .where("companyId", "==", companyId)
      .orderBy("displayName", "asc")
      .limit(500)
      .get(),
  ]);

  const jobs = jobsSnap.docs.map((doc) => {
    const raw = doc.data();
    return {
      id: doc.id,
      ...serializeDocument(raw),
      workDate: formatWorkDate(raw),
    };
  });

  const staff = staffSnap.docs.map((doc) => ({
    id: doc.id,
    ...serializeDocument(doc.data()),
  }));

  return { jobs, staff };
}

export const bootstrapSession = onCall(async (request) => {
  const input = BootstrapSchema.parse(request.data ?? {});

  if (input.refreshDirectory) {
    const session = requireAdmin(request);
    const companyId = companyFromClaims(session.token);
    return {
      refreshToken: false,
      ...(await fetchAdminDirectory(companyId)),
    };
  }

  const session = requireAuth(request);
  const user = await auth.getUser(session.uid);
  const validSince = user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : null;
  const authTime = session.token.auth_time;
  if (user.disabled || (validSince !== null &&
      (!Number.isFinite(validSince) || typeof authTime !== "number" || !Number.isSafeInteger(authTime) ||
        authTime * 1000 < validSince))) {
    throw new HttpsError("permission-denied", "ログインが失効しています。もう一度ログインしてください。");
  }
  const email = normalizeEmail(user.email ?? "");

  if (!email || !user.emailVerified) {
    throw new HttpsError("failed-precondition", "確認済みメールアドレスが必要です。");
  }


  if (Object.hasOwn(session.token, "crewDeviceSession") || Object.hasOwn(session.token, "crewDeviceGeneration")) {
    if (session.token.role !== "staff") throw new HttpsError("permission-denied", "スタッフの認証を確認できません。");
    const companyId = companyFromClaims(session.token);
    const staffId = staffFromClaims(session.token);
    await db.runTransaction(async (tx) => {
      const profile = await readActiveStaffProfile(tx, companyId, staffId, session.uid, authTime, {
        requireIdentity: true, deviceClaims: session.token,
      });
      const index = (await tx.get(db.collection("emailIndex").doc(emailHash(email)))).data();
      if (profile.deviceBoundAuthRequired !== true || index?.active !== true ||
          index.companyId !== companyId || index.staffId !== staffId) {
        throw new HttpsError("permission-denied", "スタッフの認証を確認できません。");
      }
    }, { readOnly: true });
    return { role: "staff", companyId, staffId, refreshToken: false };
  }

  const admins = adminEmails.value()
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);

  if (admins.includes(email)) {
    const claims = {
      role: "admin",
      companyId: defaultCompanyId.value(),
    };
    await auth.setCustomUserClaims(session.uid, claims);
    await db.collection("auditLogs").add({
      companyId: claims.companyId,
      actorUid: session.uid,
      action: "session.bootstrap.admin",
      createdAt: FieldValue.serverTimestamp(),
    });
    return {
      role: "admin",
      companyId: claims.companyId,
      refreshToken: true,
      ...(await fetchAdminDirectory(claims.companyId)),
    };
  }

  const normalizedEmailHash = emailHash(email);
  const unavailable = () => new HttpsError("permission-denied", "このアカウントは利用停止中です。");
  const claims = await db.runTransaction(async (tx) => {
    const indexSnap = await tx.get(db.collection("emailIndex").doc(normalizedEmailHash));
    if (!indexSnap.exists) {
      throw new HttpsError("permission-denied", "登録済みスタッフのメールではありません。");
    }

    const index = indexSnap.data() as {
      companyId: string;
      staffId: string;
      active: boolean;
    };
    if (index.active !== true || [index.companyId, index.staffId].some(value =>
      typeof value !== "string" || !value.trim() || /[\/\\\u0000-\u001f\u007f]/.test(value))) {
      throw unavailable();
    }

    const profileRef = db.collection("staffProfiles").doc(index.staffId);
    const identityRef = db.collection("authIdentities").doc(session.uid);
    const [profileSnap, identitySnap] = await Promise.all([tx.get(profileRef), tx.get(identityRef)]);
    if (!profileSnap.exists || profileSnap.data()?.active !== true || profileSnap.data()?.companyId !== index.companyId || profileSnap.data()?.deviceBoundAuthRequired === true) {
      throw unavailable();
    }

    // 失効済みの登録を復帰できるのは、同じ会社・本人が失効後に再認証した場合だけ。
    if (identitySnap.exists) {
      const identity = identitySnap.data();
      if (identity?.companyId !== index.companyId || identity.staffId !== index.staffId) {
        throw unavailable();
      }
      const { active, revokedAt } = identity;
      if ((active !== true && (active !== false || revokedAt == null)) ||
          (revokedAt != null && (!(revokedAt instanceof Timestamp) || typeof authTime !== "number" ||
            !Number.isSafeInteger(authTime) || authTime < revokedAt.seconds ||
            (authTime === revokedAt.seconds && revokedAt.nanoseconds > 0)))) {
        throw new HttpsError("permission-denied", "ログインが失効しています。もう一度ログインしてください。");
      }
    }

    tx.set(profileRef, {
      lastLoginAt: FieldValue.serverTimestamp(),
      authUids: FieldValue.arrayUnion(session.uid),
    }, { merge: true });
    tx.set(identityRef, {
      companyId: index.companyId,
      staffId: index.staffId,
      email,
      emailHash: normalizedEmailHash,
      active: true,
      lastLoginAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return { role: "staff", companyId: index.companyId, staffId: index.staffId } as const;
  });

  const refreshToken = !customClaimsMatch(user.customClaims, claims);
  if (refreshToken) await auth.setCustomUserClaims(session.uid, claims);
  return { ...claims, refreshToken };
});
