import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

type UploadGrant = {
  storagePath: string;
  size: number;
  contentType: string;
  contentSha256: string | null;
  expiresAt: Timestamp;
};
type GrantFile = Pick<UploadGrant, "storagePath" | "size" | "contentType"> & { fileId: string; contentSha256?: string };
const GRANT_TTL_MS = 60 * 60 * 1000;
const MAX_OPEN_GRANTS = 160;

function grantField(fileId: string): string {
  if (!/^file_[a-f0-9-]+$/i.test(fileId)) {
    throw new HttpsError("failed-precondition", "提出先の許可記録を確認できません。");
  }
  return "submissionUploadGrants." + fileId;
}

function uploadGrants(identity: FirebaseFirestore.DocumentData | undefined): Record<string, UploadGrant> {
  const saved = identity?.submissionUploadGrants;
  if (saved === undefined) return {};
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
    throw new HttpsError("failed-precondition", "提出先の許可記録を確認できません。");
  }
  return saved;
}

/** Update the same identity already read for staff access in this transaction. */
export function grantSubmissionUploads(
  tx: Pick<FirebaseFirestore.Transaction, "update">,
  identityRef: FirebaseFirestore.DocumentReference,
  identity: FirebaseFirestore.DocumentData | undefined,
  files: readonly GrantFile[],
  now: Timestamp,
): void {
  const existing = uploadGrants(identity);
  const live = new Set<string>();
  const updates: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {};
  for (const [fileId, grant] of Object.entries(existing)) {
    if (grant?.expiresAt instanceof Timestamp && grant.expiresAt.toMillis() > now.toMillis()) live.add(fileId);
    else updates[grantField(fileId)] = FieldValue.delete();
  }
  const expiresAt = Timestamp.fromMillis(now.toMillis() + GRANT_TTL_MS);
  for (const { fileId, storagePath, size, contentType, contentSha256 = null } of files) {
    const current = existing[fileId];
    if (live.has(fileId) && current?.storagePath === storagePath && current.size === size &&
        current.contentType === contentType && current.contentSha256 === contentSha256) continue;
    updates[grantField(fileId)] = { storagePath, size, contentType, contentSha256, expiresAt };
    live.add(fileId);
  }
  if (live.size > MAX_OPEN_GRANTS) {
    throw new HttpsError("resource-exhausted", "送信待ちのファイルが多いため、新しい提出先を準備できません。提出履歴を確認してください。");
  }
  if (Object.keys(updates).length) tx.update(identityRef, updates);
}

export function revokeSubmissionUpload(
  tx: Pick<FirebaseFirestore.Transaction, "update">,
  identityRef: FirebaseFirestore.DocumentReference,
  identity: FirebaseFirestore.DocumentData | undefined,
  fileId: string,
  storagePath: string,
): void {
  const existing = uploadGrants(identity);
  if (existing[fileId]?.storagePath !== storagePath) return;
  tx.update(identityRef, { [grantField(fileId)]: FieldValue.delete() });
}
