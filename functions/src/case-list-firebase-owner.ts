import { HttpsError } from "firebase-functions/v2/https";

type Data = Record<string, any>;
type Session = { uid: string; token: Data };
const { principalStateHash, markFirebaseOwnerVerified } = require("../src/case-list-owner-authorization.cjs") as {
  principalStateHash(user: Data): string;
  markFirebaseOwnerVerified<T extends Data>(actor: T): T;
};
export type FirebaseOwnerPolicy = { projectId?: string; actualProjectId?: string; companyId?: string; ownerUid?: string; executiveEmails: string[] };
export type FirebaseOwnerPorts = {
  now(): number;
  verifyFirebaseIdentity(token: string, checkRevoked: true): Promise<Data>;
  readFirebaseUserByGoogleSubject(subject: string): Promise<Data>;
};
const PROJECT = "lip-knots-crew-staging", ID = /^[A-Za-z0-9_-]{1,200}$/;
const email = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";
const seconds = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const object = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
function need(value: unknown, code: string): asserts value {
  if (!value) throw new HttpsError("permission-denied", "本人・会社・権限の照合を保留しました。", { code });
}
export function firebaseOwnerPolicy(env: NodeJS.ProcessEnv = process.env): FirebaseOwnerPolicy {
  return { projectId: env.EXPECTED_FIREBASE_PROJECT_ID, actualProjectId: env.GCLOUD_PROJECT ?? env.GCP_PROJECT,
    companyId: env.DEFAULT_COMPANY_ID, ownerUid: env.LKC_GAS_SYNC_OWNER_UID,
    executiveEmails: (env.EXECUTIVE_APPROVER_EMAILS ?? "").split(",").map(email).filter(Boolean) };
}
// Reuses the existing Admin SDK verifier and the already reviewed current-user /
// MFA observation adapter. No new credential, scope, identity, role, or storage.
// This candidate is local only; no real MFA lookup is authorized or performed.
export function createFirebaseOwnerPorts(): FirebaseOwnerPorts {
  need(!process.env.FIREBASE_AUTH_EMULATOR_HOST, "FIREBASE_OWNER_EMULATOR_UNSUPPORTED");
  const { auth } = require("./firebase") as typeof import("./firebase");
  const { createGasIdentityRuntimePorts } = require("./case-list-gas-handoff") as typeof import("./case-list-gas-handoff");
  const identity = createGasIdentityRuntimePorts();
  return { now: () => Date.now(), verifyFirebaseIdentity: (token, checkRevoked) => auth.verifyIdToken(token, checkRevoked),
    readFirebaseUserByGoogleSubject: async subject => await identity.readFirebaseUserByGoogleSubject(subject) as Data };
}
/** Only the existing callable supplies Session. Neither request.data nor Google
 * claims can manufacture it. Firebase and GAS Google tokens remain distinct.
 */
export async function withFirebaseOwnerCallable<T>(request: Data, session: Session,
  operation: (owner: Data, beforeCommit: () => Promise<void>) => Promise<T>,
  policy: FirebaseOwnerPolicy = firebaseOwnerPolicy(), suppliedPorts?: FirebaseOwnerPorts): Promise<T> {
  need(policy.projectId === PROJECT && policy.actualProjectId === PROJECT && ID.test(policy.companyId ?? "") &&
    ID.test(policy.ownerUid ?? "") && policy.executiveEmails.length > 0 && policy.executiveEmails.length <= 20 &&
    policy.executiveEmails.every(value => value === email(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)), "FIREBASE_OWNER_CONFIG_REQUIRED");
  need(session?.uid === policy.ownerUid && session.token?.role === "admin" && session.token.companyId === policy.companyId,
    "FIREBASE_OWNER_CALLABLE_SCOPE_CHANGED");
  const authorization = request.rawRequest?.headers?.authorization;
  const raw: unknown = request.rawRequest?.rawHeaders;
  need(typeof authorization === "string" && authorization.length <= 16384 &&
    /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization), "FIREBASE_OWNER_BEARER_REQUIRED");
  if (raw !== undefined) need(Array.isArray(raw) && raw.filter((x, i) => i % 2 === 0 && String(x).toLowerCase() === "authorization").length === 1,
    "FIREBASE_OWNER_BEARER_REQUIRED");
  const ports = suppliedPorts ?? createFirebaseOwnerPorts();
  async function current(): Promise<Data> {
    const start = Math.floor(ports.now() / 1000);
    let claims: Data;
    try { claims = await ports.verifyFirebaseIdentity(authorization.slice(7), true); }
    catch { throw new HttpsError("permission-denied", "Firebase本人認証を確認できません。", { code: "FIREBASE_OWNER_TOKEN_INVALID" }); }
    need(object(claims) && claims.aud === PROJECT && claims.iss === "https://securetoken.google.com/" + PROJECT &&
      claims.uid === session.uid && claims.sub === session.uid, "FIREBASE_OWNER_IDENTITY_CHANGED");
    need(seconds(claims.iat) && seconds(claims.exp) && claims.iat <= start + 30 && claims.exp > start &&
      claims.exp > claims.iat && claims.exp - claims.iat <= 3600, "FIREBASE_OWNER_TOKEN_TIME_INVALID");
    need(seconds(claims.auth_time) && claims.auth_time <= claims.iat, "FIREBASE_OWNER_AUTH_TIME_REQUIRED");
    const firebase = claims.firebase, subjects = firebase?.identities?.["google.com"];
    need(object(firebase) && firebase.sign_in_provider === "google.com" && !Object.hasOwn(firebase, "tenant") &&
      !Object.hasOwn(firebase, "sign_in_second_factor") && Array.isArray(subjects) && subjects.length === 1 &&
      typeof subjects[0] === "string" && /^[0-9]{1,255}$/.test(subjects[0]), "FIREBASE_OWNER_GOOGLE_LINK_REQUIRED");
    need(claims.role === "admin" && claims.companyId === policy.companyId && claims.email_verified === true &&
      email(claims.email) === email(session.token.email) && policy.executiveEmails.includes(email(claims.email)), "FIREBASE_OWNER_CLAIMS_CHANGED");
    let user: Data;
    try { user = await ports.readFirebaseUserByGoogleSubject(subjects[0]); }
    catch { throw new HttpsError("permission-denied", "現在の本人権限を確認できません。", { code: "FIREBASE_OWNER_AUTHORITY_UNAVAILABLE" }); }
    need(object(user) && user.uid === session.uid && user.disabled === false && user.emailVerified === true &&
      email(user.email) === email(claims.email) && user.tenantId === null, "FIREBASE_OWNER_ACCOUNT_CHANGED");
    const links = Array.isArray(user.providerData) ? user.providerData.filter((x: Data) => x?.providerId === "google.com") : [];
    need(links.length === 1 && links[0].uid === subjects[0], "FIREBASE_OWNER_GOOGLE_LINK_REQUIRED");
    need(user.customClaims?.role === "admin" && user.customClaims.companyId === policy.companyId, "FIREBASE_OWNER_AUTHORITY_CHANGED");
    need(user.mfaState === "NONE", "FIREBASE_OWNER_MFA_UNVERIFIED_OR_ENROLLED");
    const now = ports.now();
    need(seconds(user.validSinceMs) && seconds(user.observedAt) && user.observedAt <= now && now - user.observedAt < 30000,
      "FIREBASE_OWNER_AUTHORITY_STALE");
    need(claims.auth_time * 1000 >= user.validSinceMs, "FIREBASE_OWNER_REVOKED");
    need(claims.exp > Math.floor(now / 1000), "FIREBASE_OWNER_TOKEN_TIME_INVALID");
    return markFirebaseOwnerVerified({ uid: user.uid, sub: user.uid, companyId: policy.companyId, role: "admin", email: email(user.email), email_verified: true,
      identityExpiresAt: claims.exp * 1000, authorityObservedAt: user.observedAt, principalStateHash: principalStateHash(user) });
  }
  const owner = await current();
  const beforeCommit = async () => { const next = await current(); need(next.uid === owner.uid && next.companyId === owner.companyId &&
    next.email === owner.email && next.principalStateHash === owner.principalStateHash, "FIREBASE_OWNER_SESSION_CHANGED"); };
  const result = await operation(owner, beforeCommit);
  await beforeCommit();
  return result;
}
