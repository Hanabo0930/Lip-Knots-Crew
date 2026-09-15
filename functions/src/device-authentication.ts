import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

/** 失効記録を残したまま、新しいログインだけに端末の再利用を許可します。 */
export function assertDeviceAuthentication(
  device: FirebaseFirestore.DocumentData,
  authTime: unknown
): void {
  if (device.active === true && device.revokedAt == null) return;
  const revokedAt = device.revokedAt;
  if (!(revokedAt instanceof Timestamp)
    || typeof authTime !== "number" || !Number.isSafeInteger(authTime) || authTime <= 0
    || !Number.isSafeInteger(authTime * 1000)
    || authTime * 1000 <= revokedAt.toMillis()) {
    throw new HttpsError("permission-denied", "この端末はログアウトされています。再ログインしてください。");
  }
}
