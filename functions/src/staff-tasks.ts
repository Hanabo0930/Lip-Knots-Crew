import { caseMailPreparationHeld } from "./case-mail-preparation-core";
import { Timestamp } from "firebase-admin/firestore";
import { onCall } from "firebase-functions/v2/https";
import { db } from "./firebase";
import { deriveStaffTasks, OpenResubmission, TaskJob } from "./task-core";
import { addTokyoDays, tokyoParts } from "./notification-time";
import { companyFromClaims, requireAuth, staffFromClaims } from "./utils";

export const getMyTasks = onCall(async (request) => {
  const session = requireAuth(request);
  const companyId = companyFromClaims(session.token);
  const staffId = staffFromClaims(session.token);
  const today = tokyoParts(new Date()).dateKey;
  const from = addTokyoDays(today, -90);
  const through = addTokyoDays(today, 365);

  const [jobsSnap, requestsSnap] = await Promise.all([
    db.collection("jobs")
      .where("companyId", "==", companyId)
      .where("assignedStaffId", "==", staffId)
      .where("dateKey", ">=", from)
      .where("dateKey", "<=", through)
      .limit(2000)
      .get(),
    db.collection("resubmissionRequests")
      .where("companyId", "==", companyId)
      .where("staffId", "==", staffId)
      .where("status", "==", "open")
      .limit(100)
      .get(),
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
    const snapshots = await db.getAll(...missingIds.map(id => db.collection("jobs").doc(id)));
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
});
