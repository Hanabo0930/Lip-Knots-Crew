// Shared operation/context guards. Kept independent of evidence collectors and
// Hosting clients so pure evidence validation never imports mutation code.
const allowedProjectId = "lip-knots-crew-staging";
const allowedRegion = "asia-northeast1";
const allowedRepository = "Hanabo0930/Lip-Knots-Crew";
const workflowPath = ".github/workflows/staging-hosting-promote.yml";
const confirmations = Object.freeze({
  promote: "PROMOTE_LKC_STAGING_HOSTING",
  readiness: "CHECK_LKC_STAGING_HOSTING_READINESS",
  restore: "RESTORE_LKC_STAGING_HOSTING",
});
function requireValue(condition, code) { if (!condition) throw new Error(code); }
export function requireProtectedContext() {
  requireValue(process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REPOSITORY === allowedRepository
    && process.env.GITHUB_REF === "refs/heads/main" && process.env.GITHUB_JOB === "promote"
    && process.env.GITHUB_WORKFLOW_REF === allowedRepository + "/" + workflowPath + "@refs/heads/main", "PROTECTED_WORKFLOW_CONTEXT_REQUIRED");
}
export function validateHostingOperation({operation, eventName, confirmation, projectId, region, sourceRef, runAttempt = 1}) {
  requireValue(projectId === allowedProjectId && region === allowedRegion && sourceRef === "main", "ENVIRONMENT_REJECTED");
  requireValue(Object.hasOwn(confirmations, operation), "OPERATION_REJECTED");
  requireValue(eventName === "workflow_dispatch" || eventName === "workflow_run", "TRIGGER_REJECTED");
  requireValue(eventName !== "workflow_run" || operation === "promote", "MANUAL_OPERATION_REQUIRED");
  requireValue(confirmation === confirmations[operation], "CONFIRMATION_REJECTED");
  requireValue(Number.isSafeInteger(runAttempt) && runAttempt > 0 && (operation === "readiness" || runAttempt === 1),"WORKFLOW_RERUN_REJECTED");
  return operation;
}
