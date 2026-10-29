import type { Job } from "./App";

export const recruitmentSubjects = ["【案件メール】", "【何とか埋めたい案件】", "【緊急案件】", "【着ぐるみ有：案件メール】"] as const;
export type RecruitmentDraft = { purpose: "recruitment-draft"; subject: string; body: string; caseCount: number; region: string; validatedAt: string; dispatch: "disabled" };
export function recruitmentDraftCandidate(job: Job): boolean {
  return Boolean(job.caseListSource && /^[a-f0-9]{64}$/.test(job.caseListSource.sourceRevision) && Number.isSafeInteger(job.revision) && Number(job.revision) >= 0 &&
    job.status === "open" && job.publishable === true && job.sourceReady === true && !job.sheetRef && !job.caseListManualPending && job.recruitmentStopped !== true && job.cancelled !== true && !job.assignedStaffId && !job.assignedStaffName &&
    job.sourceMissing !== true && job.assignmentUnresolved !== true && job.applicationUnconfirmed !== true && job.pendingSourceWrite !== true && job.adminEditSheetWrite?.pending !== true && job.assignmentSheetWrite?.pending !== true && job.cancellationSheetWrite?.sourceAckPending !== true &&
    typeof job.region === "string" && job.region.trim() === job.region && job.region.length > 0 && job.region.length <= 100);
}
export function recruitmentDraftRequest(jobs: Job[], ids: string[], region: string, subject: string, notice: string) {
  if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length) throw new Error("募集文に掲載する案件を1〜20件選択してください。");
  if (!region || region !== region.trim() || region.length > 100) throw new Error("募集する地域を選択してください。");
  if (!(recruitmentSubjects as readonly string[]).includes(subject) || notice.length > 4000) throw new Error("件名・お知らせを確認してください。");
  const selections = ids.map(id => {
    const matches = jobs.filter(job => job.id === id), job = matches[0];
    if (matches.length !== 1 || !job || !recruitmentDraftCandidate(job) || job.region !== region) throw new Error("選択した案件の募集状態・地域・確認版が変わりました。選び直してください。");
    return { jobId: job.id, expectedJobRevision: job.revision!, expectedSourceRevision: job.caseListSource!.sourceRevision };
  });
  return { purpose: "recruitment-draft" as const, region, subject, notice, selections };
}
export function parseRecruitmentDraft(value: unknown, request: ReturnType<typeof recruitmentDraftRequest>): RecruitmentDraft {
  const result = value as Partial<RecruitmentDraft> | null;
  if (!result || result.purpose !== "recruitment-draft" || result.dispatch !== "disabled" || result.region !== request.region || result.subject !== request.subject ||
    typeof result.body !== "string" || !result.body.trim() || result.body.length > 1000000 || result.caseCount !== request.selections.length ||
    typeof result.validatedAt !== "string" || !Number.isFinite(Date.parse(result.validatedAt))) throw new Error("募集文の確認結果を読み取れません。もう一度作成してください。");
  return { purpose: "recruitment-draft", subject: result.subject, body: result.body, caseCount: result.caseCount, region: result.region, validatedAt: result.validatedAt, dispatch: "disabled" };
}
