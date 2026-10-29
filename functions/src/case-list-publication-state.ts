/** Durable intent barrier outlives a worker lease, expiry and unknown result. */
export function caseListPublicationPending(job: Record<string, any>): boolean {
  const state = job.caseListPublicationWrite;
  return state != null && (state.pending !== false || !["PUBLISHED", "REVOKED"].includes(state.state));
}
