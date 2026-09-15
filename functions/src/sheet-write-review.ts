import { Buffer } from "node:buffer";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { companyFromClaims, requireAdmin } from "./utils";

const DocumentId = z.string().min(1).max(1500).refine(value =>
  Buffer.byteLength(value, "utf8") <= 1500 && !value.includes("/") && value !== "." && value !== "..",
"依頼番号の形式が正しくありません。");
const QuerySchema = z.object({
  expectedCompanyId: z.string().min(1).max(1500),
  expectedActorUid: z.string().min(1).max(128),
  cursor: DocumentId.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

// 更新日時がない旧依頼も含める。本文、書込値、原本ID、本人IDそのものは返さない。
const Fields = [
  "companyId", "status", "jobId", "operation", "createdAt", "updatedAt", "retryAt",
  "errorType", "writeVerificationRequired", "actorUid", "actorStaffId", "dateKey", "idempotencyKey",
];
type Presence = "recorded" | "missing" | "invalid";
function textPresence(value: unknown): Presence {
  return value === undefined || value === null || value === "" ? "missing"
    : typeof value === "string" && value.trim().length > 0 ? "recorded" : "invalid";
}
function recordedText(value: unknown, maxBytes: number): string | null {
  return textPresence(value) === "recorded" && typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= maxBytes ? value : null;
}
function recordedTime(value: unknown) {
  if (value === undefined || value === null) return { state: "missing" as Presence, value: null };
  if (!(value instanceof Timestamp)) return { state: "invalid" as Presence, value: null };
  return { state: "recorded" as Presence, value: value.toDate().toISOString() };
}

export const listSheetWriteReviewRecords = onCall(async request => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const parsed = QuerySchema.safeParse(request.data ?? {});
  if (!parsed.success) throw new HttpsError("invalid-argument", "取得条件を確認してください。");
  const input = parsed.data;
  if (input.expectedCompanyId !== companyId || input.expectedActorUid !== session.uid) {
    throw new HttpsError("permission-denied", "ログイン情報が変更されています。確認画面を開き直してください。");
  }
  let query = db.collection("sheetSyncQueue")
    .where("companyId", "==", companyId)
    .orderBy(FieldPath.documentId(), "asc")
    .select(...Fields)
    .limit(input.limit + 1);
  if (input.cursor !== undefined) query = query.startAfter(input.cursor);
  const page = await query.get();
  const records = page.docs.slice(0, input.limit).map(doc => {
    const data = doc.data();
    if (data.companyId !== companyId) throw new HttpsError("internal", "取得した依頼の所属を確認できません。");
    const updatedAt = recordedTime(data.updatedAt);
    const retryAt = recordedTime(data.retryAt);
    const status = recordedText(data.status, 80);
    const jobId = recordedText(data.jobId, 1500);
    const writeVerificationRequired = data.errorType === "verification_required" ||
      (data.writeVerificationRequired !== undefined && data.writeVerificationRequired !== false);
    const reviewReasons: string[] = [];
    if (updatedAt.state !== "recorded") reviewReasons.push("updated_at_" + updatedAt.state);
    if (!jobId) reviewReasons.push("job_id_unavailable");
    if (!status) reviewReasons.push("status_unavailable");
    if (writeVerificationRequired) reviewReasons.push("write_verification_required");
    if ((status === "retry_wait" || status === "processing") && retryAt.state !== "recorded") {
      reviewReasons.push("retry_at_" + retryAt.state);
    }
    return {
      id: doc.id, jobId, status, operation: recordedText(data.operation, 120),
      createdAt: recordedTime(data.createdAt), updatedAt, retryAt,
      writeVerificationRequired, sourceWriteVerified: false as const, reviewReasons,
      // 記録の有無だけ。本人・勤務日・原本・操作の正しさは照合していない。
      recordedEvidence: {
        actor: textPresence(data.actorUid), staff: textPresence(data.actorStaffId),
        workDate: textPresence(data.dateKey), operationKey: textPresence(data.idempotencyKey),
      },
    };
  });
  return {
    companyId, actorUid: session.uid, reviewMode: "metadata_only" as const,
    sourceWriteVerified: false as const, consistentSnapshot: false as const,
    limit: input.limit, records,
    nextCursor: page.docs.length > input.limit ? records.at(-1)!.id : null,
  };
});
