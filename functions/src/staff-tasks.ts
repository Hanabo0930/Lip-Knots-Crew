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
      .where("status", "in", ["open", "submitted"])
      .limit(100)
      .get(),
  ]);

  const jobs: TaskJob[] = jobsSnap.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<TaskJob, "id">),
  }));
  const jobMap = new Map(jobs.map((job) => [job.id, job]));
  const resubmissions: OpenResubmission[] = requestsSnap.docs
    .filter((doc) => doc.data().status === "open")
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
