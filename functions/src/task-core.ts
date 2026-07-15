import { submissionDeadline } from "./notification-time";

export type TaskPriority = "overdue" | "urgent" | "normal";
export type TaskKind =
  | "precontact"
  | "netprint"
  | "sales_floor"
  | "report"
  | "resubmission";

export type TaskJob = {
  id: string;
  dateKey: string;
  storeName: string;
  cancelled?: boolean;
  status?: string;
  preContact?: { temperature?: unknown; arrivalTime?: unknown } | null;
  netPrint?: { items?: Array<{ id?: string; number?: string; printed?: boolean }> };
  submissionStatus?: {
    report?: { completed?: boolean };
    salesFloor?: { completed?: boolean; clientSubmitted?: boolean; lipKnotsSubmitted?: boolean };
  };
};

export type OpenResubmission = {
  id: string;
  jobId: string;
  type: "report" | "sales_floor";
  reasons: string[];
  note?: string;
  createdAtMs: number;
  storeName?: string;
};

export type StaffTask = {
  id: string;
  jobId: string;
  kind: TaskKind;
  title: string;
  body: string;
  actionRoute: string;
  dueAtMs: number | null;
  availableAtMs: number | null;
  priority: TaskPriority;
  sortKey: number;
  metadata?: Record<string, unknown>;
};

export function deriveStaffTasks(input: {
  jobs: TaskJob[];
  resubmissions: OpenResubmission[];
  nowMs: number;
}): StaffTask[] {
  const tasks: StaffTask[] = [];
  for (const job of input.jobs) {
    if (job.cancelled || job.status !== "assigned") continue;
    const workStart = tokyoMidnightMs(job.dateKey);
    const preAvailable = workStart - 3 * 24 * 60 * 60 * 1000;
    const preDue = workStart - 9 * 60 * 60 * 1000; // 前日15:00 JST
    const preComplete = Boolean(
      job.preContact?.temperature !== undefined &&
      job.preContact?.temperature !== "" &&
      job.preContact?.arrivalTime
    );
    if (!preComplete && input.nowMs >= preAvailable) {
      tasks.push(makeTask({
        id: `${job.id}_precontact`, jobId: job.id, kind: "precontact",
        title: "事前連絡を送ってください",
        body: `${job.dateKey} ${job.storeName} / 体温と到着予定時刻`,
        actionRoute: `/shifts/${job.id}/precontact`,
        dueAtMs: preDue, availableAtMs: preAvailable, nowMs: input.nowMs,
      }));
    }

    const unprinted = (job.netPrint?.items ?? []).filter(
      (item) => item.number && item.printed !== true
    );
    if (unprinted.length) {
      tasks.push(makeTask({
        id: `${job.id}_netprint`, jobId: job.id, kind: "netprint",
        title: "ネットプリントを印刷してください",
        body: `${job.storeName} / 未印刷 ${unprinted.length}件`,
        actionRoute: `/shifts/${job.id}/netprint`,
        dueAtMs: workStart - 24 * 60 * 60 * 1000,
        availableAtMs: null, nowMs: input.nowMs,
        metadata: { unprintedCount: unprinted.length },
      }));
    }

    const deadline = submissionDeadline(job.dateKey).toMillis();
    const sales = job.submissionStatus?.salesFloor;
    const salesComplete = Boolean(
      sales?.completed || sales?.clientSubmitted || sales?.lipKnotsSubmitted
    );
    if (!salesComplete && input.nowMs >= workStart) {
      tasks.push(makeTask({
        id: `${job.id}_sales_floor`, jobId: job.id, kind: "sales_floor",
        title: "売場画像を提出してください",
        body: `${job.storeName} / クライアント提出済みでも完了にできます`,
        actionRoute: `/submissions/${job.id}/sales-floor`,
        dueAtMs: deadline, availableAtMs: workStart, nowMs: input.nowMs,
      }));
    }
    if (job.submissionStatus?.report?.completed !== true && input.nowMs >= workStart) {
      tasks.push(makeTask({
        id: `${job.id}_report`, jobId: job.id, kind: "report",
        title: "報告書を提出してください",
        body: `${job.storeName} / 写真またはPDF`,
        actionRoute: `/submissions/${job.id}/report`,
        dueAtMs: deadline, availableAtMs: workStart, nowMs: input.nowMs,
      }));
    }
  }

  for (const request of input.resubmissions) {
    tasks.push({
      id: `resubmission_${request.id}`,
      jobId: request.jobId,
      kind: "resubmission",
      title: request.type === "report" ? "報告書を再送してください" : "売場画像を再送してください",
      body: [request.storeName ?? "", ...request.reasons, request.note ?? ""].filter(Boolean).join(" / "),
      actionRoute: `/resubmissions/${request.id}`,
      dueAtMs: null,
      availableAtMs: request.createdAtMs,
      priority: "urgent",
      sortKey: -1,
      metadata: { requestId: request.id, type: request.type },
    });
  }

  return tasks.sort((a, b) => {
    const rank = { overdue: 0, urgent: 1, normal: 2 } as const;
    return rank[a.priority] - rank[b.priority] || a.sortKey - b.sortKey || a.title.localeCompare(b.title, "ja");
  });
}

function makeTask(input: {
  id: string; jobId: string; kind: TaskKind; title: string; body: string;
  actionRoute: string; dueAtMs: number | null; availableAtMs: number | null;
  nowMs: number; metadata?: Record<string, unknown>;
}): StaffTask {
  const due = input.dueAtMs;
  const priority: TaskPriority = due !== null && input.nowMs > due
    ? "overdue"
    : due !== null && due - input.nowMs <= 24 * 60 * 60 * 1000
      ? "urgent"
      : "normal";
  return {
    id: input.id, jobId: input.jobId, kind: input.kind,
    title: input.title, body: input.body, actionRoute: input.actionRoute,
    dueAtMs: due, availableAtMs: input.availableAtMs, priority,
    sortKey: due ?? Number.MAX_SAFE_INTEGER,
    metadata: input.metadata,
  };
}

function tokyoMidnightMs(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00+09:00`).getTime();
}
