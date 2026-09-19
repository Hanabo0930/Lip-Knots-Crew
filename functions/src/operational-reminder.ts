import { caseMailPreparationHeld, type CaseMailPreparation } from "./case-mail-preparation-core";
import { mailPreparationContext } from "./assignment-preparation-core";
export type ReminderKind = "assignment-receipt" | "precontact" | "report" | "sales-floor" | "netprint" | "netprint-update" | "resubmission";
export type OperationalReminderContext = {
  version: 1; jobId: string; staffId: string; dateKey: string; revision: number;
  assignedAtMs?: number; assignmentContext?: string; assignmentOperationId?: string;
  kind: ReminderKind; printUpdatedAtMs?: number; printWriteOperationId?: string;
  requestId?: string; requestType?: "report" | "sales_floor";
};
type ReminderJob = CaseMailPreparation & {
  assignmentSheetWrite?: {queueId?:string}; assignedAt?: { toMillis(): number }; preContactNeedsReview?: boolean;
  companyId?: string; assignedStaffId?: string; dateKey?: string; revision?: number;
  status?: string; cancelled?: boolean; sourceMissing?: boolean;
  applicationUnconfirmed?: boolean; assignmentUnresolved?: boolean;
  preContact?: { temperature?: unknown; arrivalTime?: unknown } | null;
  submissionStatus?: { report?: { completed?: boolean }; salesFloor?: { completed?: boolean; clientSubmitted?: boolean; lipKnotsSubmitted?: boolean } };
  netPrint?: { writeOperationId?: string; updatedAt?: { toMillis(): number }; items?: Array<{ number?: string; printed?: boolean }> };
};
export function parseOperationalReminder(value: unknown): OperationalReminderContext | null {
  if (!value || typeof value !== "object") return null;
  const v = value as OperationalReminderContext;
  if ((v.printWriteOperationId !== undefined && (typeof v.printWriteOperationId !== "string" || !v.printWriteOperationId)) || v.version !== 1 || typeof v.jobId !== "string" || !v.jobId || v.jobId.includes("/") ||
      typeof v.staffId !== "string" || !v.staffId || typeof v.dateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.dateKey) ||
      !Number.isSafeInteger(v.revision) || v.revision < 0 || !["assignment-receipt", "precontact", "report", "sales-floor", "netprint", "netprint-update", "resubmission"].includes(v.kind) ||
      ((v.kind === "assignment-receipt") && (!Number.isSafeInteger(v.assignedAtMs) || v.assignedAtMs! < 0 || typeof v.assignmentContext !== "string" || !v.assignmentContext || typeof v.assignmentOperationId !== "string" || !v.assignmentOperationId)) ||
      ((v.kind === "resubmission") && (typeof v.requestId !== "string" || !v.requestId || v.requestId.includes("/") || !["report", "sales_floor"].includes(String(v.requestType)))) ||
      ((v.kind === "netprint" || v.kind === "netprint-update") && (!Number.isSafeInteger(v.printUpdatedAtMs) || v.printUpdatedAtMs! < 0))) return null;
  return v;
}
export function operationalReminderIsCurrent(context: OperationalReminderContext, companyId: string, job: ReminderJob | undefined): boolean {
  if (!job || job.companyId !== companyId || job.status !== "assigned" || job.cancelled === true ||
      job.sourceMissing === true || job.assignmentUnresolved === true || caseMailPreparationHeld(job) ||
      job.assignedStaffId !== context.staffId || job.dateKey !== context.dateKey) return false;
  if (context.kind === "assignment-receipt") return Boolean(job.mailIntake) && job.assignedAt?.toMillis() === context.assignedAtMs &&
    job.assignmentSheetWrite?.queueId === context.assignmentOperationId && mailPreparationContext(job) === context.assignmentContext;
  if (job.applicationUnconfirmed === true || (job.revision ?? 0) !== context.revision) return false;
  if (context.kind === "resubmission") return true; // 依頼の現在状態は配信処理で別途照合する。
  if (context.kind === "precontact") return job.preContactNeedsReview === true || !(job.preContact?.temperature !== undefined && job.preContact.temperature !== "" && job.preContact.arrivalTime);
  if (context.kind === "report") return job.submissionStatus?.report?.completed !== true;
  if (context.kind === "sales-floor") {
    const sales = job.submissionStatus?.salesFloor;
    return !Boolean(sales?.completed || sales?.clientSubmitted || sales?.lipKnotsSubmitted);
  }
  if (job.netPrint?.updatedAt?.toMillis() !== context.printUpdatedAtMs ||
      (job.netPrint?.writeOperationId ?? null) !== (context.printWriteOperationId ?? null)) return false;
  const items = job.netPrint?.items ?? [];
  return (context.kind === "netprint-update" && !items.some(item => Boolean(item.number))) ||
    items.some(item => Boolean(item.number) && item.printed !== true);
}
