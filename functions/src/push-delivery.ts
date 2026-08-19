export const PUSH_FAILURE_REASONS = [
  "none",
  "invalid_token",
  "sender_mismatch",
  "service_auth",
  "rate_limited",
  "temporary",
  "unknown",
] as const;

export type PushFailureReason = typeof PUSH_FAILURE_REASONS[number];

const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/installation-id-not-registered",
]);

const SENDER_MISMATCH_CODES = new Set([
  "messaging/mismatched-credential",
]);

const SERVICE_AUTH_CODES = new Set([
  "messaging/authentication-error",
  "messaging/third-party-auth-error",
]);

const RATE_LIMIT_CODES = new Set([
  "messaging/device-message-rate-exceeded",
  "messaging/message-rate-exceeded",
  "messaging/quota-exceeded",
]);

const TEMPORARY_CODES = new Set([
  "messaging/internal-error",
  "messaging/server-unavailable",
  "messaging/unknown-error",
]);

export function isInvalidPushTokenCode(code: string): boolean {
  return INVALID_TOKEN_CODES.has(code);
}

export function classifyPushFailureCodes(
  codes: Iterable<string>
): PushFailureReason {
  const values = [...codes].filter(Boolean);
  if (!values.length) return "none";
  if (values.some((code) => SENDER_MISMATCH_CODES.has(code))) {
    return "sender_mismatch";
  }
  if (values.some((code) => SERVICE_AUTH_CODES.has(code))) {
    return "service_auth";
  }
  if (values.every((code) => INVALID_TOKEN_CODES.has(code))) {
    return "invalid_token";
  }
  if (values.some((code) => RATE_LIMIT_CODES.has(code))) {
    return "rate_limited";
  }
  if (values.every((code) => TEMPORARY_CODES.has(code))) {
    return "temporary";
  }
  return "unknown";
}

export function normalizePushFailureReason(value: unknown): PushFailureReason {
  const reason = String(value ?? "");
  return (PUSH_FAILURE_REASONS as readonly string[]).includes(reason)
    ? reason as PushFailureReason
    : "unknown";
}
