import { onCall, HttpsError } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "./firebase";
import { companyFromClaims, requireAuth, staffFromClaims } from "./utils";
import { assertProductionOperational } from "./system-safety";

const Schema = z.object({
  jobId: z.string().min(1),
  temperature: z.number().min(34).max(42),
  arrivalTime: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/),
});

export const submitPreContact = onCall(async (request) => {
  const session = requireAuth(request);
  const input = Schema.parse(request.data);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const staffId = staffFromClaims(session.token);
  const jobRef = db.collection("jobs").doc(input.jobId);

  await db.runTransaction(async (tx) => {
    const jobSnap = await tx.get(jobRef);
    if (!jobSnap.exists) {
      throw new HttpsError("not-found", "案件が見つかりません。");
    }
    const job = jobSnap.data() as Record<string, unknown>;
    if (job.companyId !== companyId || job.assignedStaffId !== staffId) {
      throw new HttpsError("permission-denied", "この案件へ送信できません。");
    }
    if (job.cancelled === true) {
      throw new HttpsError("failed-precondition", "キャンセル済みの案件です。");
    }

    const now = Timestamp.now();
    const previous = job.preContact ?? null;
    tx.update(jobRef, {
      preContact: {
        temperature: input.temperature,
        arrivalTime: input.arrivalTime,
        submittedAt: now,
        revised: previous !== null,
      },
      updatedAt: now,
    });

    tx.set(db.collection("sheetSyncQueue").doc(), {
      companyId,
      jobId: input.jobId,
      operation: "precontact.submit",
      updates: {
        temperature: input.temperature,
        arrivalTime: input.arrivalTime,
      },
      status: "pending",
      attempts: 0,
      idempotencyKey: `precontact:${input.jobId}:${now.toMillis()}`,
      expected: previous ? {
        temperature: { mode: "exact", value: (previous as { temperature?: unknown }).temperature ?? "" },
        arrivalTime: { mode: "exact", value: (previous as { arrivalTime?: unknown }).arrivalTime ?? "" },
      } : {
        temperature: { mode: "blank" }, arrivalTime: { mode: "blank" },
      },
      actorUid: session.uid,
      actorStaffId: staffId,
      createdAt: now,
    });

    tx.set(db.collection("auditLogs").doc(), {
      companyId,
      actorUid: session.uid,
      actorStaffId: staffId,
      action: previous ? "precontact.revise" : "precontact.submit",
      jobId: input.jobId,
      before: previous,
      after: {
        temperature: input.temperature,
        arrivalTime: input.arrivalTime,
      },
      createdAt: now,
    });
  });

  return { ok: true };
});
