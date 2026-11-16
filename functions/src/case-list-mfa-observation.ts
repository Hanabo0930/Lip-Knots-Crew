type Data = Record<string, any>;
export type FirebaseMfaState = "NONE" | "ENROLLED" | "UNKNOWN";
// No password material, phone number, TOTP secret or full user export is requested.
export const MFA_LOOKUP_FIELDS = "users(localId,email,emailVerified,disabled,providerUserInfo(providerId,rawId),customAttributes,validSince,tenantId,mfaInfo(mfaEnrollmentId))";
const object = (x: unknown): x is Data => !!x && typeof x === "object" && !Array.isArray(x);
const own = (x: Data, key: string) => Object.prototype.hasOwnProperty.call(x, key);
const identifier = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 1024 && x.trim() === x && !/[\u0000-\u001f\u007f]/.test(x);
const email = (x: unknown) => typeof x === "string" ? x.trim().toLowerCase() : null;
function canonical(x: unknown): string {
  if (x === null || typeof x === "string" || typeof x === "boolean") return JSON.stringify(x);
  if (typeof x === "number" && Number.isFinite(x)) return JSON.stringify(x);
  if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
  if (object(x)) return "{" + Object.keys(x).sort().map(k => JSON.stringify(k) + ":" + canonical(x[k])).join(",") + "}";
  throw Error("MFA_AUTHORITY_UNVERIFIED");
}
function sdkEnrollment(user: Data): FirebaseMfaState | null {
  if (user.multiFactor === undefined) return null;
  if (!object(user.multiFactor) || !Array.isArray(user.multiFactor.enrolledFactors)) return "UNKNOWN";
  const factors = user.multiFactor.enrolledFactors;
  if (!factors.length) return null; // Even an empty SDK list needs the raw observation below.
  return factors.every((f: unknown) => object(f) && identifier(f.uid) && ["phone", "totp"].includes(f.factorId)) ? "ENROLLED" : "UNKNOWN";
}
function rawAuthorityMatches(user: Data, subject: string, raw: Data): boolean {
  if (!identifier(user.uid) || raw.localId !== user.uid || email(user.email) === null || email(raw.email) !== email(user.email)) return false;
  if (typeof raw.emailVerified !== "boolean" || raw.emailVerified !== user.emailVerified) return false;
  const disabled = own(raw, "disabled") ? raw.disabled : false;
  if (typeof disabled !== "boolean" || disabled !== user.disabled) return false;
  if (!Array.isArray(user.providerData) || !Array.isArray(raw.providerUserInfo)) return false;
  const sdkGoogle = user.providerData.filter((p: Data) => p?.providerId === "google.com");
  const rawGoogle = raw.providerUserInfo.filter((p: Data) => p?.providerId === "google.com");
  if (sdkGoogle.length !== 1 || rawGoogle.length !== 1 || sdkGoogle[0].uid !== subject || rawGoogle[0].rawId !== subject) return false;
  let claims: unknown = {};
  if (own(raw, "customAttributes")) {
    if (typeof raw.customAttributes !== "string") return false;
    claims = JSON.parse(raw.customAttributes);
  }
  if (!object(claims) || canonical(claims) !== canonical(user.customClaims ?? {})) return false;
  const tenant = own(raw, "tenantId") ? raw.tenantId : null;
  if (tenant !== null && !identifier(tenant)) return false;
  if (tenant !== (user.tenantId ?? null)) return false;
  let validSince: number | null = null;
  if (own(raw, "validSince")) {
    if (typeof raw.validSince !== "string" || !/^\d+$/.test(raw.validSince)) return false;
    validSince = Number(raw.validSince) * 1000;
    if (!Number.isSafeInteger(validSince)) return false;
  }
  const sdkSince = user.tokensValidAfterTime === undefined ? null : Date.parse(user.tokensValidAfterTime);
  return sdkSince === validSince;
}
/** Successful UserRecord omission alone is ambiguous: SDK13.10 filters unknown
 * and invalid factors too. NONE requires the same-user official lookup response,
 * with the requested repeated MFA field observed as absent/default-empty or [].
 * No observation is persisted and no authentication policy is relaxed.
 */
export async function readFirebaseMfaState(user: Data, subject: string, lookup: () => Promise<unknown>): Promise<FirebaseMfaState> {
  try {
    if (!object(user) || typeof subject !== "string" || !/^[0-9]{1,255}$/.test(subject)) return "UNKNOWN";
    const sdk = sdkEnrollment(user);
    if (sdk !== null) return sdk;
    const response = await lookup();
    if (!object(response) || response.status !== 200 || !object(response.data) || !Array.isArray(response.data.users) || response.data.users.length !== 1) return "UNKNOWN";
    const raw = response.data.users[0];
    if (!object(raw) || !rawAuthorityMatches(user, subject, raw)) return "UNKNOWN";
    if (!own(raw, "mfaInfo")) return "NONE";
    if (!Array.isArray(raw.mfaInfo)) return "UNKNOWN";
    if (!raw.mfaInfo.length) return "NONE";
    return raw.mfaInfo.every((factor: unknown) => object(factor) && identifier(factor.mfaEnrollmentId)) ? "ENROLLED" : "UNKNOWN";
  } catch {
    // Lookup failure, malformed records and mismatched authority remain closed.
    return "UNKNOWN";
  }
}
