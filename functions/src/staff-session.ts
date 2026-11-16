import { HttpsError } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase";


type StaffSessionOptions = {
  requireIdentity?: boolean;
  deviceClaims?: Readonly<Record<string, unknown>>;
};

export const staffDeviceSessionIdPattern = /^device_[0-9a-f]{28}$/;
export const staffDeviceGenerationPattern = /^[0-9a-f]{48}$/;


export type StaffDeviceCredential = Readonly<{ crewDeviceSession: string; crewDeviceGeneration: string }>;

export function readStaffDeviceCredential(value: unknown): StaffDeviceCredential | null {
  if (value == null || typeof value !== "object") return null;
  const { crewDeviceSession, crewDeviceGeneration } = value as Record<string, unknown>;
  return typeof crewDeviceSession === "string" && staffDeviceSessionIdPattern.test(crewDeviceSession) &&
    typeof crewDeviceGeneration === "string" && staffDeviceGenerationPattern.test(crewDeviceGeneration)
    ? { crewDeviceSession, crewDeviceGeneration } : null;
}

function hasCurrentDeviceCredential(
  staff: FirebaseFirestore.DocumentData,
  identity: FirebaseFirestore.DocumentData | undefined,
  claims: Readonly<Record<string, unknown>>,
): boolean {
  const required = staff.deviceBoundAuthRequired === true ||
    Object.hasOwn(claims, "crewDeviceSession") || Object.hasOwn(claims, "crewDeviceGeneration");
  if (!required) return true;
  const grant = readStaffDeviceCredential(claims);
  const credentials = identity?.deviceCredentials;
  return grant !== null && credentials != null && typeof credentials === "object" && !Array.isArray(credentials) &&
    Object.hasOwn(credentials, grant.crewDeviceSession) && credentials[grant.crewDeviceSession] === grant.crewDeviceGeneration;
}

/** Enforce the live staff scope and retained revocation time for Admin SDK callables. */
export async function readActiveStaffProfile(
  tx: Pick<FirebaseFirestore.Transaction, "get">,
  companyId: string,
  staffId: string,
  uid: string,
  authTime: unknown,
  options: StaffSessionOptions = {},
): Promise<FirebaseFirestore.DocumentData> {
  return (await readActiveStaffSession(tx, companyId, staffId, uid, authTime, options)).staff;
}

export async function readActiveStaffSession(
  tx: Pick<FirebaseFirestore.Transaction, "get">,
  companyId: string,
  staffId: string,
  uid: string,
  authTime: unknown,
  { requireIdentity = false, deviceClaims = {} }: StaffSessionOptions = {},
): Promise<{ staff: FirebaseFirestore.DocumentData; identity: FirebaseFirestore.DocumentData | undefined; revokedAt: Timestamp | null }> {
  const denied = () => new HttpsError("permission-denied", "現在のスタッフ権限を確認できません。");
  if ([staffId, uid].some(id => !id.trim() || id.includes("/"))) throw denied();
  const [profile, identity] = await Promise.all([
    tx.get(db.collection("staffProfiles").doc(staffId)),
    tx.get(db.collection("authIdentities").doc(uid)),
  ]);
  const staff = profile.data(), linked = identity.data();
  if (staff?.active !== true || staff.companyId !== companyId ||
      (requireIdentity && !identity.exists) ||
      (identity.exists && (linked?.active !== true || linked.companyId !== companyId || linked.staffId !== staffId))) {
    throw denied();
  }
  if (!hasCurrentDeviceCredential(staff, linked, deviceClaims)) throw denied();
  const revokedAt = linked?.revokedAt;
  if (revokedAt != null && (!(revokedAt instanceof Timestamp) || typeof authTime !== "number" ||
      !Number.isSafeInteger(authTime) || authTime < 0 || authTime > 253402300799 ||
      authTime < revokedAt.seconds || (authTime === revokedAt.seconds && revokedAt.nanoseconds > 0))) {
    throw denied();
  }
  return { staff, identity: linked, revokedAt: revokedAt instanceof Timestamp ? revokedAt : null };
}
