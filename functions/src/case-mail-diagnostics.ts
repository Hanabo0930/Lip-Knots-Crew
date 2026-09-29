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
