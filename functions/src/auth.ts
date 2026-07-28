import { defineString } from "firebase-functions/params";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { auth, db } from "./firebase";
import {
  companyFromClaims,
  emailHash,
  normalizeEmail,
  requireAdmin,
  requireAuth,
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
  const email = normalizeEmail(user.email ?? "");

  if (!email || !user.emailVerified) {
    throw new HttpsError("failed-precondition", "確認済みメールアドレスが必要です。");
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

  const indexSnap = await db.collection("emailIndex").doc(emailHash(email)).get();
  if (!indexSnap.exists) {
    throw new HttpsError("permission-denied", "登録済みスタッフのメールではありません。");
  }

  const index = indexSnap.data() as {
    companyId: string;
    staffId: string;
    active: boolean;
  };

  if (!index.active) {
    throw new HttpsError("permission-denied", "このアカウントは利用停止中です。");
  }

  const profileSnap = await db.collection("staffProfiles").doc(index.staffId).get();
  if (!profileSnap.exists || profileSnap.data()?.active !== true) {
    throw new HttpsError("permission-denied", "このアカウントは利用停止中です。");
  }

  const claims = {
    role: "staff",
    companyId: index.companyId,
    staffId: index.staffId,
  };

  await auth.setCustomUserClaims(session.uid, claims);
  const normalizedEmailHash = emailHash(email);
  await Promise.all([
    db.collection("staffProfiles").doc(index.staffId).set({
      lastLoginAt: FieldValue.serverTimestamp(),
      authUids: FieldValue.arrayUnion(session.uid),
    }, { merge: true }),
    db.collection("authIdentities").doc(session.uid).set({
      companyId: index.companyId,
      staffId: index.staffId,
      email,
      emailHash: normalizedEmailHash,
      active: true,
      lastLoginAt: FieldValue.serverTimestamp(),
    }, { merge: true }),
  ]);

  return { ...claims, refreshToken: true };
});
