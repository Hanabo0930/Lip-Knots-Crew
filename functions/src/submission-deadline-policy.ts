import { submissionDeadline, SUBMISSION_DEADLINE_RULE_VERSION } from "./notification-time";
import { JAPAN_HOLIDAY_CALENDAR_VERSION } from "./japan-business-day";

export type SubmissionDeadlinePolicy = {
  ruleVersion: string;
  calendarVersion: string | null;
  workDate: string | null;
  dueAtMs: number | null;
  status: "known" | "unavailable" | "unrecorded";
};

export function createSubmissionDeadlinePolicy(workDate: unknown): SubmissionDeadlinePolicy {
  const dateKey = typeof workDate === "string" ? workDate : null;
  const deadline = dateKey ? submissionDeadline(dateKey) : null;
  return {
    ruleVersion: SUBMISSION_DEADLINE_RULE_VERSION,
    calendarVersion: JAPAN_HOLIDAY_CALENDAR_VERSION,
    workDate: dateKey,
    dueAtMs: deadline?.toMillis() ?? null,
    status: deadline ? "known" : "unavailable",
  };
}

// 保存時の版を使い、現在の休日表から過去の期限を再計算しない。
export function readSubmissionDeadlinePolicy(value: unknown): SubmissionDeadlinePolicy {
  const unknown: SubmissionDeadlinePolicy = {
    ruleVersion: "legacy-unrecorded", calendarVersion: null,
    workDate: null, dueAtMs: null, status: "unrecorded",
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknown;
  const policy = value as Partial<SubmissionDeadlinePolicy>;
  if (typeof policy.ruleVersion !== "string" || !policy.ruleVersion.trim() ||
      typeof policy.calendarVersion !== "string" || !policy.calendarVersion.trim() ||
      typeof policy.workDate !== "string") return unknown;
  if (policy.status === "unavailable" && policy.dueAtMs === null) {
    return { ruleVersion: policy.ruleVersion, calendarVersion: policy.calendarVersion,
      workDate: policy.workDate, dueAtMs: null, status: "unavailable" };
  }
  if (policy.status !== "known" || !Number.isSafeInteger(policy.dueAtMs) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(policy.workDate)) return unknown;
  const work = new Date(policy.workDate + "T00:00:00+09:00").getTime();
  const dueAtMs = policy.dueAtMs as number;
  const date = new Date(dueAtMs + 9 * 60 * 60 * 1000);
  if (!Number.isFinite(work) || new Date(work + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) !== policy.workDate ||
      !Number.isFinite(date.getTime()) ||
      dueAtMs <= work || dueAtMs - work > 15 * 24 * 60 * 60 * 1000 ||
      date.getUTCHours() !== 11 || date.getUTCMinutes() !== 0 ||
      date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) return unknown;
  return { ruleVersion: policy.ruleVersion, calendarVersion: policy.calendarVersion,
    workDate: policy.workDate, dueAtMs, status: "known" };
}
