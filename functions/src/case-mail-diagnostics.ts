/** 外部応答・本文を保持せず、固定の診断区分だけを伝える。 */
export type CaseMailAuthReason = "gmail_signing_failed" | "gmail_delegation_denied" |
  "gmail_token_exchange_failed" | "gmail_token_invalid" | "extractor_auth_failed";
export class CaseMailAuthFailure extends Error {
  constructor(readonly reason: CaseMailAuthReason) {
    super("案件メールの認証設定を確認してください。");
    this.name = "CaseMailAuthFailure";
  }
}
const reasons = new Set<CaseMailAuthReason>(["gmail_signing_failed", "gmail_delegation_denied",
  "gmail_token_exchange_failed", "gmail_token_invalid", "extractor_auth_failed"]);
export function caseMailFailureReason(error: unknown): CaseMailAuthReason | "receive_failed" {
  return error instanceof CaseMailAuthFailure && reasons.has(error.reason) ? error.reason : "receive_failed";
}

// 外部の例外・本文・識別子は保持せず、サーバー内で確定した工程だけを渡す。
const processingPhases = ["receiver_guard", "fetch", "gmail_auth", "mailbox", "message_read", "message_validation",
  "attachment_read", "attachment_validation", "extractor_auth", "attachment_extraction", "extraction_validation",
  "analysis", "analysis_validation", "candidate_validation", "persistence"] as const;
export type CaseMailProcessingPhase = typeof processingPhases[number];
const phases = new Set<string>(processingPhases);
export class CaseMailProcessingFailure extends Error {
  constructor(readonly phase: CaseMailProcessingPhase) {
    super("案件メールの処理工程を確認してください。");
    this.name = "CaseMailProcessingFailure";
  }
}
export function caseMailFailurePhase(error: unknown): CaseMailProcessingPhase | undefined {
  return error instanceof CaseMailProcessingFailure && phases.has(error.phase) ? error.phase : undefined;
}
export function sanitizeCaseMailProcessingError(error: unknown, phase: CaseMailProcessingPhase): Error {
  const reason = caseMailFailureReason(error);
  if (reason !== "receive_failed") return new CaseMailAuthFailure(reason);
  return new CaseMailProcessingFailure(caseMailFailurePhase(error) ?? (phases.has(phase) ? phase : "fetch"));
}
