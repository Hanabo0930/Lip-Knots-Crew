
import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { readStaffDeviceCredential, type StaffDeviceCredential } from "./staff-session";

type RecordData = FirebaseFirestore.DocumentData;
const issuedName = /^(?:device_[0-9a-f]{28}-[0-9a-f]{48}-)?[a-f0-9]{32}-/;

function devicePrefix(credential: StaffDeviceCredential | null): string {
  return credential ? credential.crewDeviceSession + "-" + credential.crewDeviceGeneration + "-" : "";
}

export function freshStagingPath(base: string, credential: StaffDeviceCredential | null = null): string {
  const slash = base.lastIndexOf("/");
  return base.slice(0, slash + 1) + devicePrefix(credential) + randomBytes(16).toString("hex") + "-" + base.slice(slash + 1);
}

function stagedName(path: string, base: string): string | null {
  const slash = base.lastIndexOf("/");
  const prefix = base.slice(0, slash + 1);
  if (!path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length);
  const issued = issuedName.exec(name);
  return issued && name.slice(issued[0].length) === base.slice(slash + 1) ? issued[0] : null;
}

export function matchesUploadCredential(file: RecordData, credential: StaffDeviceCredential | null): boolean {
  if (file.uploadDeviceCredential == null) return credential === null;
  const saved = readStaffDeviceCredential(file.uploadDeviceCredential);
  return saved !== null && credential !== null && devicePrefix(saved) === devicePrefix(credential);
}

export function matchesReceiptPath(file: RecordData, base: string): boolean {
  const path = file.storagePath;
  if (file.baseStoragePath === undefined) return file.uploadDeviceCredential == null && path === base;
  if (file.baseStoragePath !== base || typeof path !== "string") return false;
  const issued = stagedName(path, base);
  const grant = readStaffDeviceCredential(file.uploadDeviceCredential);
  if (file.uploadDeviceCredential != null && !grant) return false;
  return issued !== null && issued.slice(0, -33) === devicePrefix(grant);
}

export function priorReceiptPath(file: RecordData, path: string): boolean {
  const base = file.baseStoragePath;
  return path !== file.storagePath && typeof base === "string" && matchesReceiptPath(file, base) &&
    (path === base || stagedName(path, base) !== null);
}

export function pathIssuedAfter(file: RecordData, cutoff: Timestamp): boolean {
  const issued = file.uploadPathIssuedAt;
  return typeof file.baseStoragePath === "string" && matchesReceiptPath(file, file.baseStoragePath) &&
    issued instanceof Timestamp && (issued.seconds > cutoff.seconds ||
      (issued.seconds === cutoff.seconds && issued.nanoseconds > cutoff.nanoseconds));
}

export function mayFinalizePendingUpload(file: RecordData, identity: RecordData | undefined, generationKey: string, requireDevice = false): boolean {
  if (!identity || identity.companyId !== file.companyId || identity.staffId !== file.staffId) return false;
  const cutoff = identity.revokedAt;
  if (cutoff != null && !(cutoff instanceof Timestamp)) return false;
  if (file.authorizedStagedKey !== undefined) {
    return (identity.active === true || cutoff instanceof Timestamp) && file.authorizedStagedKey === generationKey;
  }
  if (requireDevice || file.uploadDeviceCredential != null) {
    const saved = readStaffDeviceCredential(file.uploadDeviceCredential);
    if (!saved || typeof file.baseStoragePath !== "string" || !matchesReceiptPath(file, file.baseStoragePath) ||
        identity.deviceCredentials?.[saved.crewDeviceSession] !== saved.crewDeviceGeneration) return false;
  }
  if (cutoff == null) return identity.active === true;
  return identity.active === true && pathIssuedAfter(file, cutoff);
}
