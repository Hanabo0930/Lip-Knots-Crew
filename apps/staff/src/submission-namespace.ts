// Local candidate generation. Never fall back to, migrate, or clear legacy storage.
export const submissionNamespace = "lkc.submit.g2:";
export const submissionDraftDatabase = "lkc-submission-drafts-g2";
export const submissionAttemptPrefix = submissionNamespace + "attempt.v1:";
export const submittedBindingPrefix = submissionNamespace + "binding.v2:";
export const submittedMarkerKey = (key: string) => submissionNamespace + "submitted:" + key;
export const submissionContextLockKey = (key: string) => submissionNamespace + "context:" + key;
export const isSubmissionAttemptKey = (key: unknown): key is string =>
  typeof key === "string" && key.startsWith(submissionAttemptPrefix) && /^[a-f0-9]{64}:[a-f0-9]{64}$/.test(key.slice(submissionAttemptPrefix.length));
