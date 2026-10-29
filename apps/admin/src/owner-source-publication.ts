export type OwnerPublicationWrite = { pending: boolean; state: string; queueId?: string; intentHash?: string };
export type OwnerPublicationSource = { jobId: string; caseId?: string; sourceRevision: string; sourceState?: string; region?: string };
export type OwnerPublicationResult = { sourcePublication?: { state?: string; operationId?: string; reason?: string }; updated?: string[]; blocked?: string[] };
export function ownerPublicationGeneration(job: { id: string; revision?: number; caseListPublicationWrite?: OwnerPublicationWrite }) {
  const revision = job.revision, intentHash = job.caseListPublicationWrite?.intentHash;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 || typeof intentHash !== "string" || !/^[a-f0-9]{64}$/.test(intentHash)) throw new Error("原本反映依頼の確認版を取得できません。案件一覧を更新してから操作してください。");
  return { expectedRevisions: { [job.id]: revision }, expectedIntentHash: intentHash };
}
export function ownerPublicationPending(job: { caseListPublicationWrite?: OwnerPublicationWrite }): boolean {
  const write = job.caseListPublicationWrite;
  return Boolean(write && (write.pending !== false || !["PUBLISHED", "REVOKED"].includes(write.state)));
}
export function ownerPublicationStatus(job: { caseListPublicationWrite?: OwnerPublicationWrite }): string {
  const write = job.caseListPublicationWrite;
  if (!write) return "";
  if (write.state === "HELD") return "原本の公開は保留中";
  if (write.state === "REVOKED" && write.pending === false) return "原本反映依頼は取り下げ済み";
  return ownerPublicationPending(job) ? "原本の公開・照合待ち" : "";
}
export function ownerPublicationSourceMode(source: OwnerPublicationSource): "source-transition" | "existing-publication" {
  if (source.sourceState === "確認待ち" && source.region === "") return "source-transition";
  if (source.sourceState === "募集中" && typeof source.region === "string" && source.region.trim() === source.region && source.region.length > 0 && source.region.length <= 100) return "existing-publication";
  throw new Error("案件リストの状態・地域が対応範囲と一致しません。対象案件の原本を確認してください。");
}
export function ownerPublicationRegion(value: string): string {
  if (!value || value !== value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("募集する地域を、前後の空白や改行を含めず入力してください。");
  return value;
}
export function ownerPublicationReview(value: unknown, expected: { jobId: string; caseId: string; region: string }) {
  const result = value as { sourcePublication?: { state?: string; reviewPlanHash?: string; review?: { jobId?: string; caseId?: string; sourceStateBefore?: string; sourceStateAfter?: string; regionBefore?: string; regionAfter?: string } } } | null;
  const publication = result?.sourcePublication, review = publication?.review;
  if (typeof expected.caseId !== "string" || !/^LKCASE_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expected.caseId) || publication?.state !== "REVIEW_READY" || typeof publication.reviewPlanHash !== "string" || !/^[a-f0-9]{64}$/.test(publication.reviewPlanHash) || !review ||
    review.sourceStateBefore !== "確認待ち" || review.sourceStateAfter !== "募集中" || review.regionBefore !== "" || review.regionAfter !== expected.region ||
    (review.jobId !== undefined && review.jobId !== expected.jobId) || review.caseId !== expected.caseId) throw new Error("原本の変更予定を照合できません。依頼せずに停止しました。案件を取り込み直してください。");
  return { reviewPlanHash: publication.reviewPlanHash, sourceStateBefore: review.sourceStateBefore, sourceStateAfter: review.sourceStateAfter, regionBefore: review.regionBefore, regionAfter: review.regionAfter };
}
export function ownerPublicationResultMessage(value: unknown, jobId: string): { message: string; published: boolean } {
  const result = value as OwnerPublicationResult | null;
  const state = result?.sourcePublication?.state;
  if (state === "PUBLISHED" && Array.isArray(result?.updated) && result.updated.length === 1 && result.updated[0] === jobId && Array.isArray(result.blocked) && result.blocked.length === 0) {
    return { message: "原本の状態・地域の反映と照合が終わり、この案件の募集を開始しました。", published: true };
  }
  if (state === "REVOKED") return { message: ownerPublicationRevokeMessage(result), published: false };
  if (state === "AWAITING_SOURCE_ACK") return { message: "この1件の原本変更を依頼しました。原本への反映・照合が終わるまで募集開始と募集文への掲載は確認待ちです。案件一覧の「原本の公開結果を確認」で確認してください。", published: false };
  if (state === "HELD") return { message: "原本の公開を保留しました。募集は開始していません。案件一覧で状態を確認してください。", published: false };
  throw new Error("原本の公開結果を確認できません。募集開始済みとは扱わず、案件一覧の「原本の公開結果を確認」で確認してください。");
}
export function ownerPublicationRevokeMessage(value: unknown): string {
  const result = value as OwnerPublicationResult | null;
  if (result?.sourcePublication?.state === "REVOKED" && Array.isArray(result.updated) && result.updated.length === 0 && Array.isArray(result.blocked) && result.blocked.length === 0) {
    return "原本反映依頼を取り下げました。案件は非公開のままです。取消済みの案件は取消を維持します。";
  }
  if (result?.sourcePublication?.state === "HELD") return "原本反映依頼の取り下げを保留しました。原本への反映状況を確認するまで、案件は非公開のままです。";
  throw new Error("原本反映依頼の取り下げ結果を確認できません。案件一覧を更新して、依頼の状態を確認してください。");
}
