export function submissionDraftKey(owner: string, jobId: string, type: string, requestId = ""): string {
  return owner && jobId ? JSON.stringify(["v2", owner, jobId, type, requestId || "normal"]) : "";
}
