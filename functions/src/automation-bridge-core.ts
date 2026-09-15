import { createHash } from "node:crypto";
import { z } from "zod";

// 通信や永続化を持たない連携境界。認証・対応表の承認は接続アダプターの責務。
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
});
const instant = z.string().refine(value => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
});
const assignment = z.object({
  staffId: id, personKey: z.string().regex(/^[a-f0-9]{64}$/), proofEpoch: id,
}).strict();
export const AutomationBindingSchema = z.object({
  version: z.literal(1),
  companyId: id, jobId: id, appCaseId: id,
  spreadsheetId: id, fixedCaseId: id, workDate: day,
  // 担当交代・再手配（同じ人への復帰を含む）でも新しい版を発行する。
  revision: id,
  assignment: assignment.nullable(),
}).strict();
export type AutomationBinding = z.infer<typeof AutomationBindingSchema>;

const JobSchema = z.object({
  id, companyId: id, caseId: id, dateKey: day,
  status: z.enum(["open", "assigned", "stopped", "cancelled", "draft", "archived"]),
  assignedStaffId: id.nullish(),
  cancelled: z.boolean().optional(),
  publishable: z.boolean().optional(),
  recruitmentStopped: z.boolean().optional(),
  sourceMissing: z.boolean().optional(),
  assignmentUnresolved: z.boolean().optional(),
  applicationUnconfirmed: z.boolean().optional(),
  preContactNeedsReview: z.boolean().optional(),
  sheetRef: z.object({ spreadsheetId: id }),
});
const PreContactSchema = z.object({
  temperature: z.number().min(34).max(42),
  arrivalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  submittedAt: instant,
}).strict();

function same(actual: unknown, expected: unknown, reason: string): void {
  if (actual !== expected) throw new Error(reason);
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function scopedBinding(companyId: string, input: unknown): AutomationBinding {
  const binding = AutomationBindingSchema.parse(input);
  same(binding.companyId, id.parse(companyId), "連携先の会社が一致しません");
  return binding;
}

/** 対応表を登録する前に、同じ外部案件が複数のアプリ案件へ結び付かないか検査する。 */
export function validateAutomationBindings(companyId: string, input: unknown): AutomationBinding[] {
  const bindings = z.array(AutomationBindingSchema).max(100000).parse(input);
  const jobs = new Set<string>();
  const external = new Set<string>();
  for (const candidate of bindings) {
    const binding = scopedBinding(companyId, candidate);
    const externalKey = JSON.stringify([binding.spreadsheetId, binding.fixedCaseId]);
    if (jobs.has(binding.jobId) || external.has(externalKey)) {
      throw new Error("同じ案件に複数の連携対応があります");
    }
    jobs.add(binding.jobId);
    external.add(externalKey);
  }
  return bindings;
}
export function prepareAutomationHandoff(input: {
  companyId: string; binding: unknown; job: unknown; revision: string;
  preContact?: unknown;
}) {
  const binding = scopedBinding(input.companyId, input.binding);
  const job = JobSchema.parse(input.job);
  same(job.companyId, binding.companyId, "案件の会社が一致しません");
  same(job.id, binding.jobId, "案件IDが一致しません");
  same(job.caseId, binding.appCaseId, "アプリの案件番号が一致しません");
  same(job.sheetRef.spreadsheetId, binding.spreadsheetId, "元シフト表が一致しません");
  same(job.dateKey, binding.workDate, "勤務日が変更されています");
  same(job.assignedStaffId ?? null, binding.assignment?.staffId ?? null, "担当スタッフが変更されています");
  if (job.sourceMissing || job.status === "archived" || job.assignmentUnresolved || job.applicationUnconfirmed) {
    throw new Error("案件の取込または手配の照合が完了していません");
  }
  const cancelled = job.cancelled === true || job.status === "cancelled";
  const assigned = job.status === "assigned" && binding.assignment !== null;
  if (!cancelled && job.status === "assigned" && !assigned) throw new Error("担当の本人識別が未確認です");
  // シフトG/Hの入力事実。出発・入店という実行事実やメール送信済みの証拠ではない。
  const preContact = input.preContact == null ? null : PreContactSchema.parse(input.preContact);
  if (preContact && (!assigned || cancelled || job.preContactNeedsReview === true)) throw new Error("この案件の事前連絡を連携できません");
  const snapshot = {
    contractVersion: 1 as const,
    kind: "job.snapshot" as const,
    binding,
    revision: id.parse(input.revision),
    status: cancelled ? "cancelled" : job.status,
    recruitmentEligible: !cancelled && job.status === "open" && job.publishable === true && job.recruitmentStopped !== true && binding.assignment === null,
    noticeEligible: !cancelled && assigned && job.preContactNeedsReview !== true,
    preContact,
  };
  return {
    ...snapshot,
    operationKey: digest(["job.snapshot", binding.companyId, binding.jobId, binding.revision, snapshot.revision]),
    payloadHash: digest(snapshot),
    dispatch: "disabled" as const,
  };
}

export const AutomationReceiptSchema = z.object({
  contractVersion: z.literal(1),
  companyId: id, jobId: id, bindingRevision: id,
  spreadsheetId: id, fixedCaseId: id, workDate: day,
  assignment: assignment.nullable(),
  kind: z.enum(["case.import", "recruitment.mail", "notice.departure", "notice.entry"]),
  operationId: id,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["imported", "planned", "sending", "sent", "unknown", "stopped", "failed"]),
  observedAt: instant,
  sourceRecordId: id,
}).strict().superRefine((value, context) => {
  if ((value.kind === "case.import") !== (value.status === "imported")) {
    context.addIssue({code: "custom", message: "案件取込とメール送信の状態を混同できません"});
  }
  if (value.kind.startsWith("notice.") && value.assignment === null) {
    context.addIssue({code: "custom", message: "出発・入店連絡にはスタッフ本人識別が必要です"});
  }
});
export type AutomationReceipt = z.infer<typeof AutomationReceiptSchema>;

function verifyReceipt(binding: AutomationBinding, input: unknown): AutomationReceipt {
  const receipt = AutomationReceiptSchema.parse(input);
  for (const key of ["companyId", "jobId", "spreadsheetId", "fixedCaseId", "workDate"] as const) {
    same(receipt[key], binding[key], "連絡結果の案件対応が一致しません");
  }
  same(receipt.bindingRevision, binding.revision, "古い案件対応の連絡結果です");
  same(digest(receipt.assignment), digest(binding.assignment), "古い担当または本人入力証跡の連絡結果です");
  return receipt;
}

/** 送信を実行しない状態照合。結果不明・再配信は自動再送の根拠にしない。 */
export function reconcileAutomationReceipt(input: {
  companyId: string; binding: unknown; incoming: unknown; current?: unknown;
}) {
  const binding = scopedBinding(input.companyId, input.binding);
  const incoming = verifyReceipt(binding, input.incoming);
  const current = input.current == null ? null : verifyReceipt(binding, input.current);
  const result = (disposition: "accepted" | "duplicate" | "stale", receipt: AutomationReceipt) => ({
    disposition, receipt, automaticRetryAllowed: false as const,
  });
  if (!current) return result("accepted", incoming);
  same(incoming.kind, current.kind, "異なる連絡種別の履歴です");
  same(incoming.operationId, current.operationId, "異なる送信処理の履歴です");
  if (incoming.sequence < current.sequence) return result("stale", current);
  if (incoming.sequence === current.sequence) {
    same(digest(incoming), digest(current), "同じ版に異なる連絡結果があります");
    return result("duplicate", current);
  }
  if (current.status === "sent" &&
      (incoming.status !== "sent" || incoming.sourceRecordId !== current.sourceRecordId)) {
    throw new Error("送信済みの証跡を上書きできません");
  }
  if (["unknown", "sending", "stopped", "failed"].includes(current.status) &&
      ["planned", "sending"].includes(incoming.status) && incoming.status !== current.status) {
    throw new Error("既存の送信処理を自動で再開できません");
  }
  return result("accepted", incoming);
}
