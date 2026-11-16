import { caseMailPreparationHeld } from "./case-mail-preparation-core";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import { assertProductionOperational } from "./system-safety";
import { db } from "./firebase";
import { deriveStaffTasks, OpenResubmission, TaskJob } from "./task-core";
import { addTokyoDays, tokyoParts } from "./notification-time";
import { companyFromClaims, requireAuth, staffFromClaims } from "./utils";
import { readActiveStaffProfile } from "./staff-session";
import { readStaffApplicationQueueReceipt, staffApplicationQueueKey } from "./assignment-preparation-core";

export const getMyTasks = onCall(async (request) => {
  const session = requireAuth(request);
  if (session.token.role !== "staff") throw new HttpsError("permission-denied", "スタッフのみ一覧を確認できます。");
  const companyId = companyFromClaims(session.token);
  const staffId = staffFromClaims(session.token);
  if (request.data?.applicationReceiptLookup !== undefined) {
    return readApplicationReceipts(request.data.applicationReceiptLookup, companyId, staffId, session.uid, session.token);
  }
  const today = tokyoParts(new Date()).dateKey;
  const from = addTokyoDays(today, -90);
  const through = addTokyoDays(today, 365);

  // 読み取り専用スナップショットは失効前の状態を含み得るため、権限は前後で現在値を照合する。
  const confirmStaffSession = () => db.runTransaction(tx =>
    readActiveStaffProfile(tx, companyId, staffId, session.uid, session.token.auth_time, { requireIdentity: true, deviceClaims: session.token }));
  await confirmStaffSession();
  const result = await db.runTransaction(async tx => {
    const [jobsSnap, requestsSnap] = await Promise.all([
      tx.get(db.collection("jobs")
        .where("companyId", "==", companyId)
        .where("assignedStaffId", "==", staffId)
        .where("status", "==", "assigned")
        .where("dateKey", ">=", from)
        .where("dateKey", "<=", through)
        .limit(2000)),
      tx.get(db.collection("resubmissionRequests")
        .where("companyId", "==", companyId)
        .where("staffId", "==", staffId)
        .where("status", "==", "open")
        .limit(100)),
    ]);

    const jobs: TaskJob[] = jobsSnap.docs.map((doc) => ({
      ...(doc.data() as Omit<TaskJob, "id">),
      id: doc.id,
    }));
    const jobMap = new Map(jobs.map((job) => [job.id, job]));
    const openRequests = requestsSnap.docs.filter(doc => {
      const data = doc.data();
      return data.status === "open" && (data.type === "report" || data.type === "sales_floor") &&
        typeof data.jobId === "string" && data.jobId.length > 0 && !data.jobId.includes("/");
    });
    // 一覧の期間・件数上限に含まれない案件も、再提出の対象なら現在の担当を確認する。
    const missingIds = [...new Set(openRequests.map(doc => String(doc.data().jobId)))].filter(id => !jobMap.has(id));
    if (missingIds.length) {
      const snapshots = await tx.getAll(...missingIds.map(id => db.collection("jobs").doc(id)));
      for (const snapshot of snapshots) {
        const data = snapshot.data();
        if (snapshot.exists && data?.companyId === companyId && data?.assignedStaffId === staffId) {
          jobMap.set(snapshot.id, { ...data, id: snapshot.id } as TaskJob);
        }
      }
    }
    const resubmissions: OpenResubmission[] = openRequests
      .filter(doc => {
        const job = jobMap.get(String(doc.data().jobId));
        return job?.status === "assigned" && job.cancelled !== true &&
          job.sourceMissing !== true && job.applicationUnconfirmed !== true && job.assignmentUnresolved !== true && !caseMailPreparationHeld(job);
      })
      .map((doc) => {
        const data = doc.data();
        const createdAt = data.createdAt as Timestamp | undefined;
        return {
          id: doc.id,
          jobId: String(data.jobId ?? ""),
          type: data.type === "sales_floor" ? "sales_floor" : "report",
          reasons: Array.isArray(data.reasons) ? data.reasons.map(String) : [],
          note: String(data.note ?? ""),
          createdAtMs: createdAt?.toMillis() ?? Date.now(),
          storeName: jobMap.get(String(data.jobId ?? ""))?.storeName,
        };
      });

    const tasks = deriveStaffTasks({ jobs, resubmissions, nowMs: Date.now() });
    return {
      count: tasks.length,
      top: tasks.slice(0, 5),
      tasks,
    };
  }, { readOnly: true });
  await confirmStaffSession();
  return result;
});

const ApplicationReceiptLookupSchema = z.array(z.object({
    jobId: z.string().min(1).max(1500).regex(/^[^/]+$/),
    requestId: z.string().min(8).max(120).regex(/^[^/]+$/),
})).min(1).max(20);

async function readApplicationReceipts(attempts: unknown, companyId: string, staffId: string, uid: string, token: Record<string, unknown>) {
  const input = ApplicationReceiptLookupSchema.safeParse(attempts);
  if (!input.success) {
    throw new HttpsError("invalid-argument", "応募の照会情報を確認できません。");
  }
  await assertProductionOperational(companyId);
  const receipts = await db.runTransaction(async tx => {
    await readActiveStaffProfile(tx, companyId, staffId, uid, token.auth_time, { requireIdentity: true, deviceClaims: token });
    return Promise.all(input.data.map(async ({ jobId, requestId }) => {
      const snapshot = await tx.get(db.collection("idempotencyKeys").doc(uid + "_" + requestId));
      const saved = snapshot.exists ? snapshot.data() : readStaffApplicationQueueReceipt(
        (await tx.get(db.collection("sheetSyncQueue").doc(staffApplicationQueueKey(uid, requestId)))).data(), requestId);
      const accepted = saved?.uid === uid && saved.companyId === companyId &&
        saved.staffId === staffId && saved.result?.ok === true && saved.result.jobId === jobId &&
        typeof saved.result.assignedAt === "string" && Number.isFinite(Date.parse(saved.result.assignedAt));
      return { jobId, requestId, status: accepted ? "accepted" : "not_observed" };
    }));
  });
  return { receipts };
}
