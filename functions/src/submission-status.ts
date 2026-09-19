import { assertSubmissionCounters, assertSubmissionOwner, assertSubmissionReadiness, assertCaseMailSubmissionRevision, caseMailSubmissionContext } from "./submission-integrity";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { companyFromClaims, requireAuth, staffFromClaims } from "./utils";
import { submissionSheetWriteIdentity } from "./sheet-write-core";
import { readSubmissionDeadlinePolicy } from "./submission-deadline-policy";
import { assertProductionOperational } from "./system-safety";

const ClientSubmittedSchema = z.object({
  jobId: z.string().min(1),
  submitted: z.boolean(),
  expectedRevision: z.number().int().nonnegative().optional(),
});

export const setSalesFloorClientSubmitted = onCall(async (request) => {
  const session = requireAuth(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const staffId = staffFromClaims(session.token);
  const input = ClientSubmittedSchema.parse(request.data ?? {});
  const jobRef = db.collection("jobs").doc(input.jobId);
  const queueRef = db.collection("sheetSyncQueue").doc();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) throw new HttpsError("not-found", "案件が見つかりません。");
    const job = snap.data() as Record<string, unknown>;
    if (job.companyId !== companyId || job.assignedStaffId !== staffId) {
      throw new HttpsError("permission-denied", "この案件を変更できません。");
    }
    if (job.cancelled === true || job.status === "cancelled") throw new HttpsError("failed-precondition", "キャンセル済みの案件です。");
    if (job.status !== "assigned") throw new HttpsError("failed-precondition", "確定したシフトだけを変更できます。シフトを更新して確認してください。");
    assertSubmissionReadiness(job);
    assertCaseMailSubmissionRevision(job, input.expectedRevision);
    const current = (job.submissionStatus as { salesFloor?: { lipKnotsSubmitted?: boolean; clientSubmitted?: boolean; completed?: boolean } } | undefined)?.salesFloor;
    const lipKnotsSubmitted = current?.lipKnotsSubmitted === true;
    if (current?.clientSubmitted === input.submitted && current.completed === (input.submitted || lipKnotsSubmitted)) return;
    const now = Timestamp.now();
    tx.update(jobRef, {
      "submissionStatus.salesFloor.clientSubmitted": input.submitted,
      "submissionStatus.salesFloor.clientSubmittedAt": input.submitted ? now : FieldValue.delete(),
      "submissionStatus.salesFloor.completed": input.submitted || lipKnotsSubmitted,
      "submissionStatus.salesFloor.sheetWrite": { operationId: queueRef.id, identity: submissionSheetWriteIdentity(job), ...(job.mailIntake ? { caseMailContext: caseMailSubmissionContext(job) } : {}), pending: true },
      updatedAt: now,
    });
    const statusValue = input.submitted && lipKnotsSubmitted ? "直＋リップ" : input.submitted ? "直" : lipKnotsSubmitted ? "リップ" : "";
    tx.set(queueRef, {
      companyId, jobId: input.jobId, dateKey: job.dateKey, operation:"submission.sales_floor",
      updates:{ salesFloorSubmitted:statusValue }, status:"pending", attempts:0,
      idempotencyKey:`submission.sales_floor:${input.jobId}:${queueRef.id}`, actorUid:session.uid, actorStaffId:staffId, createdAt:now,
    });
  });

  return { ok: true };
});

export async function markSubmissionCompleted(input: {
  submissionId: string;
  jobId: string;
  type: "report" | "sales_floor";
  submittedAt: Timestamp;
}): Promise<void> {
  const jobRef = db.collection("jobs").doc(input.jobId);
  const queueRef = db.collection("sheetSyncQueue").doc();
  await db.runTransaction(async (tx) => {
    const submissionRef = db.collection("submissions").doc(input.submissionId);
    const [snap, submission] = await Promise.all([tx.get(jobRef), tx.get(submissionRef)]);
    const data = submission.data();
    if (!data || data.jobId !== input.jobId || data.type !== input.type) throw new HttpsError("failed-precondition", "提出と完了対象の案件が一致しません。");
    assertSubmissionCounters(data);
    assertSubmissionOwner(data, snap.data());
    if (data.status !== "completed" || data.completedFiles !== data.totalFiles) throw new HttpsError("failed-precondition", "すべてのファイルの転送完了を確認できません。");
    if (data.jobStatusApplied === true) return;
    if (!(data.completedAt instanceof Timestamp) || data.completedAt.toMillis() !== input.submittedAt.toMillis()) throw new HttpsError("failed-precondition", "提出全体の完了時刻が一致しません。");
    const job = snap.data() as {
      dateKey?: string;
      submissionStatus?: {
        report?: { firstCompletedAt?: Timestamp; latestCompletedAt?: Timestamp; lateFirstSubmission?: boolean; deadlinePolicy?: unknown };
        salesFloor?: { firstCompletedAt?: Timestamp; latestCompletedAt?: Timestamp; lateFirstSubmission?: boolean; clientSubmitted?: boolean; deadlinePolicy?: unknown };
      };
    };
    const key = input.type === "report" ? "report" : "salesFloor";
    const previous = job.submissionStatus?.[key];
    const keepsPreviousFirst = previous?.firstCompletedAt instanceof Timestamp && previous.firstCompletedAt.toMillis() <= input.submittedAt.toMillis();
    const firstCompletedAt = keepsPreviousFirst ? previous!.firstCompletedAt! : input.submittedAt;
    const latestCompletedAt = previous?.latestCompletedAt instanceof Timestamp && previous.latestCompletedAt.toMillis() > input.submittedAt.toMillis()
      ? previous.latestCompletedAt : input.submittedAt;
    const deadlinePolicy = readSubmissionDeadlinePolicy(keepsPreviousFirst ? previous?.deadlinePolicy : data.deadlinePolicy);
    const lateFirstSubmission = deadlinePolicy.status === "known" && deadlinePolicy.dueAtMs !== null
      ? firstCompletedAt.toMillis() > deadlinePolicy.dueAtMs
      : keepsPreviousFirst && typeof previous?.lateFirstSubmission === "boolean" ? previous.lateFirstSubmission : undefined;

    const basePath = `submissionStatus.${key}`;
    const update: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {
      [`${basePath}.sheetWrite`]: { operationId: queueRef.id, identity: submissionSheetWriteIdentity(snap.data()!), ...(snap.data()!.mailIntake ? { caseMailContext: caseMailSubmissionContext(snap.data()!) } : {}), pending: true },
      [`${basePath}.completed`]: true,
      [`${basePath}.lipKnotsSubmitted`]: true,
      [`${basePath}.firstCompletedAt`]: firstCompletedAt,
      [`${basePath}.latestCompletedAt`]: latestCompletedAt,
      [`${basePath}.lateFirstSubmission`]: lateFirstSubmission ?? FieldValue.delete(),
      [`${basePath}.deadlinePolicy`]: deadlinePolicy,
      [`${basePath}.deadlineReviewRequired`]: deadlinePolicy.status !== "known" || deadlinePolicy.workDate !== job.dateKey,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (key === "salesFloor") {
      update[`${basePath}.clientSubmitted`] =
        (previous as { clientSubmitted?: boolean } | undefined)?.clientSubmitted === true;
    }
    tx.update(jobRef, update);
    tx.update(submissionRef, { jobStatusApplied: true });
    const operation = input.type === "report" ? "submission.report" : "submission.sales_floor";
    const updates = input.type === "report" ? { reportSubmitted: lateFirstSubmission ? "遅延" : "提出済" } : { salesFloorSubmitted: (previous as { clientSubmitted?: boolean } | undefined)?.clientSubmitted === true ? "直＋リップ" : "リップ" };
    tx.set(queueRef, {
      companyId: String(data.companyId), jobId: input.jobId, dateKey: job.dateKey, actorUid: String(data.uid), actorStaffId: String(data.staffId), operation, updates,
      status:"pending", attempts:0, idempotencyKey:`${operation}:${input.jobId}:${queueRef.id}`, createdAt:input.submittedAt,
    });
  });
}
