import { assertSubmissionCounters, assertSubmissionOwner } from "./submission-integrity";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { companyFromClaims, requireAuth, staffFromClaims } from "./utils";
import { submissionDeadline } from "./notification-time";
import { assertProductionOperational } from "./system-safety";

const ClientSubmittedSchema = z.object({
  jobId: z.string().min(1),
  submitted: z.boolean(),
});

export const setSalesFloorClientSubmitted = onCall(async (request) => {
  const session = requireAuth(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const staffId = staffFromClaims(session.token);
  const input = ClientSubmittedSchema.parse(request.data ?? {});
  const jobRef = db.collection("jobs").doc(input.jobId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) throw new HttpsError("not-found", "案件が見つかりません。");
    const job = snap.data() as Record<string, unknown>;
    if (job.companyId !== companyId || job.assignedStaffId !== staffId) {
      throw new HttpsError("permission-denied", "この案件を変更できません。");
    }
    const now = Timestamp.now();
    const lipKnotsSubmitted =
      (job.submissionStatus as { salesFloor?: { lipKnotsSubmitted?: boolean } } | undefined)
        ?.salesFloor?.lipKnotsSubmitted === true;
    tx.update(jobRef, {
      "submissionStatus.salesFloor.clientSubmitted": input.submitted,
      "submissionStatus.salesFloor.clientSubmittedAt": input.submitted ? now : FieldValue.delete(),
      "submissionStatus.salesFloor.completed": input.submitted || lipKnotsSubmitted,
      updatedAt: now,
    });
    const statusValue = input.submitted && lipKnotsSubmitted ? "直＋リップ" : input.submitted ? "直" : lipKnotsSubmitted ? "リップ" : "";
    tx.set(db.collection("sheetSyncQueue").doc(), {
      companyId, jobId: input.jobId, operation:"submission.sales_floor",
      updates:{ salesFloorSubmitted:statusValue }, status:"pending", attempts:0,
      idempotencyKey:`salesfloor.client:${input.jobId}:${now.toMillis()}`, actorUid:session.uid, actorStaffId:staffId, createdAt:now,
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
  await db.runTransaction(async (tx) => {
    const submissionRef = db.collection("submissions").doc(input.submissionId);
    const [snap, submission] = await Promise.all([tx.get(jobRef), tx.get(submissionRef)]);
    const data = submission.data();
    if (!data || data.jobId !== input.jobId || data.type !== input.type) throw new HttpsError("failed-precondition", "提出と完了対象の案件が一致しません。");
    assertSubmissionCounters(data);
    assertSubmissionOwner(data, snap.data());
    if (data.status !== "completed" || data.completedFiles !== data.totalFiles) throw new HttpsError("failed-precondition", "すべてのファイルの転送完了を確認できません。");
    if (data.jobStatusApplied === true) return;
    const job = snap.data() as {
      dateKey?: string;
      submissionStatus?: {
        report?: { firstCompletedAt?: Timestamp; latestCompletedAt?: Timestamp; lateFirstSubmission?: boolean };
        salesFloor?: { firstCompletedAt?: Timestamp; latestCompletedAt?: Timestamp; lateFirstSubmission?: boolean; clientSubmitted?: boolean };
      };
    };
    const deadline = job.dateKey ? submissionDeadline(job.dateKey) : null;
    const key = input.type === "report" ? "report" : "salesFloor";
    const previous = job.submissionStatus?.[key];
    const firstCompletedAt = previous?.firstCompletedAt instanceof Timestamp && previous.firstCompletedAt.toMillis() < input.submittedAt.toMillis()
      ? previous.firstCompletedAt : input.submittedAt;
    const latestCompletedAt = previous?.latestCompletedAt instanceof Timestamp && previous.latestCompletedAt.toMillis() > input.submittedAt.toMillis()
      ? previous.latestCompletedAt : input.submittedAt;
    const lateFirstSubmission = deadline ? firstCompletedAt.toMillis() > deadline.toMillis() : previous?.lateFirstSubmission === true;

    const basePath = `submissionStatus.${key}`;
    const update: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {
      [`${basePath}.completed`]: true,
      [`${basePath}.lipKnotsSubmitted`]: true,
      [`${basePath}.firstCompletedAt`]: firstCompletedAt,
      [`${basePath}.latestCompletedAt`]: latestCompletedAt,
      [`${basePath}.lateFirstSubmission`]: lateFirstSubmission,
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
    tx.set(db.collection("sheetSyncQueue").doc(), {
      companyId: String(data.companyId), jobId: input.jobId, operation, updates,
      status:"pending", attempts:0, idempotencyKey:`submission:${input.type}:${input.jobId}:${input.submittedAt.toMillis()}`, createdAt:input.submittedAt,
    });
  });
}
