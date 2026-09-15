import { createHash } from "node:crypto";
import { z } from "zod";
import { AutomationBindingSchema, prepareAutomationHandoff, validateAutomationBindings } from "./automation-bridge-core";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + "T00:00:00Z");
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
});
export const RecruitmentRoutingSchema = z.object({
  version: z.literal(1), companyId: id, revision: id,
  phase: z.enum(["mail_bridge", "app"]),
  // 出発・入店連絡は案件メールの移行とは別に維持する。
  noticeOwner: z.literal("notice_control"),
}).strict();
const campaignCase = z.object({
  jobId: id, appCaseId: id, fixedCaseId: id, spreadsheetId: id,
  workDate: day, bindingRevision: id, jobRevision: id,
}).strict();
export const CampaignSchema = z.object({
  contractVersion: z.literal(1), kind: z.literal("recruitment.campaign"),
  companyId: id, policyRevision: id, sourceOperationId: id,
  area: z.enum(["normal", "tohoku"]), cases: z.array(campaignCase).min(1).max(10000),
  operationKey: hash, sourceHash: hash, payloadHash: hash, dispatch: z.literal("disabled"),
}).strict();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).filter(key => record[key] !== undefined).sort()
      .map(key => JSON.stringify(key) + ":" + canonical(record[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function same(a: unknown, b: unknown, message: string): void { if (a !== b) throw new Error(message); }
function routing(companyId: string, input: unknown) {
  const policy = RecruitmentRoutingSchema.parse(input);
  same(policy.companyId, id.parse(companyId), "受付設定の会社が一致しません");
  return policy;
}
function campaignKey(campaign: { companyId: string; policyRevision: string; sourceOperationId: string; area: string }) {
  return digest(["recruitment.campaign", campaign.companyId, campaign.policyRevision, campaign.sourceOperationId, campaign.area]);
}

/** 保存先・内容の整合と全募集枠の一意性を検査する。原本の真正性は別途照合が必要。 */
export function validateCaseMailCampaign(input:unknown) {
  const campaign=CampaignSchema.parse(input);
  same(campaign.operationKey,campaignKey(campaign),"募集の識別キーが一致しません");
  const {operationKey:_key,payloadHash:_hash,...content}=campaign;
  same(campaign.payloadHash,digest(content),"募集内容の保存版が一致しません");
  const jobs=new Set<string>(),external=new Set<string>();
  for(const row of campaign.cases) {
    if(jobs.has(row.jobId)||external.has(row.fixedCaseId)) throw new Error("募集内の案件IDが重複しています");
    jobs.add(row.jobId);external.add(row.fixedCaseId);
  }
  return campaign;
}


/** 自動化側の最新validateDraft成功後、サーバーの対応表と案件を照合する。通信・送信は行わない。 */
export function prepareCaseMailCampaign(input: {
  companyId: string; policy: unknown; draft: unknown; sourceValidation: unknown;
  records: { binding: unknown; job: unknown; revision: string }[];
}) {
  const policy = routing(input.companyId, input.policy);
  if (policy.phase !== "mail_bridge") throw new Error("募集メールの新規作成はアプリ移行により停止しています");
  z.object({ ok: z.literal(true), reasons: z.array(z.string()).length(0) }).parse(input.sourceValidation);
  const draft = z.object({
    state: z.literal("PREVIEW"), operationId: id, area: z.enum(["normal", "tohoku"]),
    cases: z.array(z.object({ id, day }).passthrough()).min(1).max(10000),
  }).passthrough().parse(input.draft);
  const bindings = validateAutomationBindings(input.companyId, input.records.map(record => record.binding));
  const byExternal = new Map<string, number | null>();
  bindings.forEach((binding, index) => byExternal.set(binding.fixedCaseId, byExternal.has(binding.fixedCaseId) ? null : index));
  const seen = new Set<string>();
  const cases = draft.cases.map(row => {
    if (seen.has(row.id)) throw new Error("募集内の固定案件IDが重複しています");
    seen.add(row.id);
    const index = byExternal.get(row.id);
    if (index == null) throw new Error("募集案件の対応表が未確認または複数の元表に一致します");
    const binding = bindings[index]!;
    same(row.day, binding.workDate, "募集の勤務日が変更されています");
    const record = input.records[index]!;
    const state = prepareAutomationHandoff({ companyId: input.companyId, binding, job: record.job, revision: record.revision });
    if (!state.recruitmentEligible) throw new Error("アプリ側で募集できない案件が含まれています");
    return { jobId: binding.jobId, appCaseId: binding.appCaseId, fixedCaseId: binding.fixedCaseId,
      spreadsheetId: binding.spreadsheetId, workDate: binding.workDate,
      bindingRevision: binding.revision, jobRevision: state.revision };
  });
  const campaign = { contractVersion: 1 as const, kind: "recruitment.campaign" as const,
    companyId: policy.companyId, policyRevision: policy.revision,
    sourceOperationId: draft.operationId, area: draft.area, cases,
    sourceHash: digest(draft), dispatch: "disabled" as const };
  return CampaignSchema.parse({ ...campaign, operationKey: campaignKey(campaign), payloadHash: digest(campaign) });
}

export const RecruitmentApplicationSchema = z.object({
  contractVersion: z.literal(1), kind: z.literal("recruitment.application"),
  companyId: id, campaignKey: hash, sourceRecordId: id,
  fixedCaseId: id, workDate: day,
  applicantPersonKey: hash.nullable(),
}).strict();
const ApplicantSchema = z.object({ companyId: id, staffId: id, personKey: hash, active: z.boolean() }).strict();
const CurrentJobSchema = z.object({
  id, companyId: id, caseId: id, dateKey: day, sheetRef: z.object({ spreadsheetId: id }),
  status: z.string(), assignedStaffId: id.nullish(), cancelled: z.boolean().optional(),
  publishable: z.boolean().optional(), recruitmentStopped: z.boolean().optional(),
  sourceMissing: z.boolean().optional(), assignmentUnresolved: z.boolean().optional(), applicationUnconfirmed: z.boolean().optional(),
});

/** 旧募集への遅い返信も現在の窓口へ回収する。受信は担当確定・送信成功を意味しない。 */
export function reconcileCaseMailApplication(input: {
  companyId: string; policy: unknown; campaign: unknown; incoming: unknown; current?: unknown;
  binding: unknown; job: unknown; verifiedApplicant?: unknown; today: string;
}) {
  const policy = routing(input.companyId, input.policy);
  const campaign = validateCaseMailCampaign(input.campaign);
  const receipt = RecruitmentApplicationSchema.parse(input.incoming);
  same(campaign.companyId, policy.companyId, "募集の会社が一致しません");
  same(receipt.companyId, policy.companyId, "応募の会社が一致しません");

  same(receipt.campaignKey, campaign.operationKey, "応募元の募集が一致しません");
  const matches = campaign.cases.filter(item => item.fixedCaseId === receipt.fixedCaseId && item.workDate === receipt.workDate);
  if (matches.length !== 1) throw new Error("応募先の募集枠が未確認または重複しています");
  const target = matches[0]!;
  const binding = AutomationBindingSchema.parse(input.binding);
  same(binding.companyId, policy.companyId, "対応表の会社が一致しません");
  for (const key of ["jobId", "appCaseId", "fixedCaseId", "spreadsheetId"] as const) same(binding[key], target[key], "応募先の案件対応が一致しません");
  const job = CurrentJobSchema.parse(input.job);
  same(job.companyId, policy.companyId, "応募先の会社が一致しません");
  same(job.id, binding.jobId, "応募先の案件が一致しません");
  same(job.caseId, binding.appCaseId, "応募先のアプリ案件番号が一致しません");
  same(job.sheetRef.spreadsheetId, binding.spreadsheetId, "応募先の元表が一致しません");
  const receiptKey = digest(["mail.application", receipt.companyId, receipt.sourceRecordId, receipt.fixedCaseId, receipt.workDate]);
  let disposition: "accepted" | "duplicate" = "accepted";
  if (input.current != null) {
    const current = RecruitmentApplicationSchema.parse(input.current);
    same(digest(["mail.application", current.companyId, current.sourceRecordId, current.fixedCaseId, current.workDate]), receiptKey, "異なる応募受信の履歴です");
    same(digest(current), digest(receipt), "同じ受信記録に異なる応募内容があります");
    disposition = "duplicate";
  }
  const reasons: string[] = [];
  if (binding.revision !== target.bindingRevision || binding.workDate !== target.workDate || job.dateKey !== target.workDate) reasons.push("案件の担当または勤務日が変更されています");
  if (job.status !== "open" || job.assignedStaffId || binding.assignment || job.cancelled || job.recruitmentStopped || job.publishable !== true || job.sourceMissing || job.assignmentUnresolved || job.applicationUnconfirmed) reasons.push("現在の案件は応募可能な状態ではありません");
  if (target.workDate < day.parse(input.today)) reasons.push("受付対象の勤務日を過ぎています");
  const applicant = input.verifiedApplicant == null ? null : ApplicantSchema.parse(input.verifiedApplicant);
  if (!applicant || !applicant.active || applicant.companyId !== policy.companyId || applicant.personKey !== receipt.applicantPersonKey) reasons.push("応募者の本人確認が完了していません");
  return {
    disposition, receipt, receiptKey, jobId: binding.jobId,
    // メールとアプリの受付を結合する際、同一スタッフ・案件の取引内で一意に確保する。
    applicationKey: reasons.length || !applicant ? null : digest(["application", policy.companyId, binding.jobId, target.workDate, applicant.staffId]),
    intakeOwner: policy.phase === "app" ? "app" as const : "legacy_mail" as const,
    route: reasons.length ? "hold" as const : "review" as const,
    policyRevision: policy.revision, fromPreviousPolicy: campaign.policyRevision !== policy.revision,
    reasons, assignmentPerformed: false as const, dispatch: "disabled" as const,
  };
}
