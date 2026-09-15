import { HttpsError } from "firebase-functions/v2/https";
import { getProductionOperationalState } from "./system-safety";
import type { TransferSource } from "./drive-transfer";

export async function submissionTransferPaused(companyId: string): Promise<boolean> {
  // 未設定は既存動作を維持。不正な設定は実行を許可しない。
  const mode = process.env.LKC_SUBMISSION_TRANSFER_MODE ?? "active";
  if (mode !== "active") return true;
  return !(await getProductionOperationalState(companyId)).operational;
}

export function assertPausedTransferSource(saved: unknown, source: TransferSource): void {
  if (saved === undefined) return;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
    throw new HttpsError("failed-precondition", "停止時の転送元を照合できません。");
  }
  const record = saved as Record<string, unknown>;
  const keys: (keyof TransferSource)[] = ["bucket", "path", "generation", "size", "contentType", "md5"];
  if (Object.keys(record).length !== keys.length || keys.some(key => record[key] !== source[key])) {
    throw new HttpsError("failed-precondition", "停止時と転送元の世代・内容が一致しません。");
  }
}
