import { defineString } from "firebase-functions/params";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { auth, db } from "./firebase";
import { emailHash, normalizeEmail, requireAuth } from "./utils";

const adminEmails = defineString("ADMIN_EMAILS", { default: "info@lipknots.com" });
const defaultCompanyId = defineString("DEFAULT_COMPANY_ID", { default: "lipknots" });

export const bootstrapSession = onCall(async (request) => {
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
    return { role: "admin", companyId: claims.companyId, refreshToken: true };
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
