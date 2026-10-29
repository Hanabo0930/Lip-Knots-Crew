import { z } from "zod";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./firebase";
import { readCaseListPublication, requireCaseListExecutive } from "./case-list-source";

// This is the existing, unchanged LK_RM_CORE_V1 formatter extracted from the
// recruitment GAS. Future GAS source is assembled from this same module by
// scripts/build-recruitment-gas.mjs; no second formatting algorithm is kept.
const formatter = require("../src/recruitment-mail-core.cjs") as {
  subjects(): string[];
  compose(cases: Record<string, unknown>[], request: { subject: string; notice: string }): {
    subject: string; body: string; caseCount: number; warnings: unknown[];
  };
};
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const DraftSchema = z.object({
  purpose: z.literal("recruitment-draft"),
  region: z.string().min(1).max(100).refine(value => value === value.trim()),
  subject: z.string().refine(value => formatter.subjects().includes(value)),
  notice: z.string().max(4000).default(""),
  selections: z.array(z.object({
    jobId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    expectedJobRevision: z.number().int().min(0),
    expectedSourceRevision: hash,
  }).strict()).min(1).max(20),
}).strict();

/** Public text preview only. No publication, queue, export log or mail send. */
export async function generateCaseListRecruitmentDraft(raw: unknown, companyId: string, token: Record<string, unknown>) {
  requireCaseListExecutive(token);
  const input = DraftSchema.parse(raw);
  if (new Set(input.selections.map(selection => selection.jobId)).size !== input.selections.length) throw new HttpsError("invalid-argument", "掲載する案件が重複しています。");
  const refs = input.selections.map(selection => db.collection("jobs").doc(selection.jobId));
  return db.runTransaction(async tx => {
    const snapshots = await tx.getAll(...refs);
    const publicCases: Record<string, unknown>[] = [];
    const caseIds = new Set<string>();
    for (const [index, selection] of input.selections.entries()) {
      const snap = snapshots[index];
      const job = snap?.data();
      if (!snap?.exists || !job || job.companyId !== companyId) throw new HttpsError("not-found", "選択した案件を確認できません。一覧を更新してください。");
      if (!job.caseListSource || job.status !== "open" || job.publishable !== true || job.sourceReady !== true || job.recruitmentStopped === true || job.cancelled === true || job.assignedStaffId || job.assignedStaffName || job.sheetRef || job.pendingSourceWrite === true || job.adminEditSheetWrite?.pending === true || job.assignmentSheetWrite?.pending === true || job.cancellationSheetWrite?.sourceAckPending === true || job.sourceMissing === true || job.assignmentUnresolved === true || job.applicationUnconfirmed === true || job.caseListManualPending) throw new HttpsError("failed-precondition", "未手配・募集開始済みの案件だけを掲載できます。一覧を更新してください。");
      if (typeof job.caseId !== "string" || caseIds.has(job.caseId.toLowerCase())) throw new HttpsError("failed-precondition", "募集枠の固定IDが重複または未確認です。");
      caseIds.add(job.caseId.toLowerCase());
      // Reads the private approval from Firestore, fresh Source/ledger and
      // existing monthly linkage. Caller JSON never supplies a public record
      // or an approval. The same publication validator is used by applyToJob.
      const checked = await readCaseListPublication(tx, companyId, selection.jobId, job, selection.expectedJobRevision, selection.expectedSourceRevision);
      if (checked.recruitmentTextHoldReasons.length) throw new HttpsError("failed-precondition", "この案件には別途確認が必要な募集条件があります。注意事項・支給条件・案件種別を確認してから掲載してください。");
      const approval = checked.approval as typeof checked.approval & { confirmedRegion?: string };
      if (job.caseListPublication?.sourceRevision !== checked.source.sourceRevision || approval.confirmedRegion !== input.region || checked.candidate.region !== input.region) throw new HttpsError("failed-precondition", "現在の原本の地域・募集条件を社長が確認してから募集文を作成してください。");
      const candidate = checked.candidate;
      const pay = candidate.payOffer as { dailyWageJPY: number; travelExpenses: string; communicationExpenses: string };
      // Deliberate whitelist. Never spread job, approval, finance, source
      // provenance, staff names or private Q/memo/ledger fields into text.
      publicCases.push({ date: candidate.date, client: candidate.client, store: candidate.store,
        manufacturer: candidate.manufacturer, menu: candidate.menu, arrival: candidate.arrival,
        execution: candidate.execution, basePay: pay.dailyWageJPY,
        allowances: [], notes: [], consecutiveDates: [] });
    }
    let composed: ReturnType<typeof formatter.compose>;
    try { composed = formatter.compose(publicCases, { subject: input.subject, notice: input.notice }); }
    catch { throw new HttpsError("failed-precondition", "募集文の公開項目を確認できません。案件の条件を確認してください。"); }
    // No silent omission: a partial selection must never look ready to send.
    if (composed.caseCount !== input.selections.length || composed.warnings.length) throw new HttpsError("failed-precondition", "選択した全案件の募集文を確認できません。案件の条件を確認してください。");
    return { purpose: "recruitment-draft" as const, subject: composed.subject, body: composed.body,
      caseCount: composed.caseCount, region: input.region, validatedAt: new Date().toISOString(), dispatch: "disabled" as const };
  }, { readOnly: true });
}
