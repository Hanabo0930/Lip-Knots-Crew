import { projectListIncludesProject, sanitizeCommandResult, sha256, stableJson } from "./production-deploy-core.mjs";

export const rollbackAcknowledgementKeys = ["emergencyLockConfirmed", "incidentOwnerAssigned", "acceptanceEvidencePreserved", "knownGoodBundleVerified", "hostingSourcesVerified", "rulesRedeployLimitationAccepted"];
const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const shaPattern = /^[a-f0-9]{64}$/u;
const hostingSourcePattern = /^[a-z0-9][a-z0-9-]{2,62}(?::[A-Za-z0-9_-]{1,80}|@[A-Za-z0-9_-]{1,120})$/u;

export function validateRollbackConfig(config) {
  const errors = [];
  if (config?.schemaVersion !== 1) errors.push("schemaVersion");
  if (config?.releaseId !== "v5.6.0") errors.push("releaseId");
  if (!projectPattern.test(String(config?.projectId ?? ""))) errors.push("projectId");
  if (!/^[A-Za-z0-9._/-]{3,120}$/u.test(String(config?.rollbackSourceRoot ?? "")) || String(config.rollbackSourceRoot).startsWith("/") || String(config.rollbackSourceRoot).includes("..")) errors.push("rollbackSourceRoot");
  if (config?.maxApprovalMinutes !== 15) errors.push("maxApprovalMinutes");
  const sites = [config?.hostingSites?.staff, config?.hostingSites?.admin];
  if (sites.some((value) => !/^[a-z0-9][a-z0-9-]{2,62}$/u.test(String(value ?? ""))) || new Set(sites).size !== 2) errors.push("hostingSites");
  for (const key of ["staffAppUrl", "adminAppUrl"]) { try { if (new URL(config?.urls?.[key]).protocol !== "https:") errors.push(key); } catch { errors.push(key); } }
  return [...new Set(errors)];
}

export function validateRollbackRequest(request, config) {
  const errors = [];
  if (request?.schemaVersion !== 1) errors.push("schemaVersion");
  if (!/^v\d+\.\d+\.\d+$/u.test(String(request?.knownGoodReleaseId ?? "")) || request.knownGoodReleaseId === config.releaseId) errors.push("knownGoodReleaseId");
  if (!/^[A-Za-z0-9._/-]{3,160}$/u.test(String(request?.bundleRelativePath ?? "")) || request.bundleRelativePath.startsWith("/") || request.bundleRelativePath.includes("..")) errors.push("bundleRelativePath");
  if (!String(request?.bundleRelativePath ?? "").startsWith(`${config.rollbackSourceRoot}/`)) errors.push("bundleOutsideRoot");
  if (!hostingSourcePattern.test(String(request?.hostingStaffSource ?? ""))) errors.push("hostingStaffSource");
  if (!hostingSourcePattern.test(String(request?.hostingAdminSource ?? ""))) errors.push("hostingAdminSource");
  if (request?.hostingStaffSource === request?.hostingAdminSource) errors.push("hostingSourcesUnique");
  return [...new Set(errors)];
}

export function buildProductionRollbackPlan({ config, request, trigger, bundleInspection, deploymentEvidence }) {
  const errors = [...validateRollbackConfig(config), ...validateRollbackRequest(request, config)];
  if (trigger?.schemaVersion !== 1 || trigger?.releaseId !== config.releaseId || trigger?.projectId !== config.projectId || !Array.isArray(trigger?.failedCheckKeys) || !trigger.failedCheckKeys.length || !shaPattern.test(String(trigger?.acceptanceLedgerFingerprint ?? "")) || !shaPattern.test(String(trigger?.acceptancePlanFingerprint ?? "")) || !shaPattern.test(String(trigger?.deploymentPlanFingerprint ?? ""))) errors.push("rollbackTrigger");
  const deploymentResults = new Map((deploymentEvidence?.results ?? []).map((item) => [item?.key, item]));
  const requiredDeploymentResults = ["project_access", "rules_and_storage", "functions", "hosting", "functions_inventory", "hosting_inventory", "staff_https", "admin_https"];
  if (deploymentEvidence?.schemaVersion !== 1 || deploymentEvidence?.status !== "succeeded" || deploymentEvidence?.releaseId !== config.releaseId || deploymentEvidence?.projectId !== config.projectId || !emailPattern.test(String(deploymentEvidence?.approvedByEmail ?? "")) || !shaPattern.test(String(deploymentEvidence?.planFingerprint ?? "")) || trigger?.deploymentPlanFingerprint !== deploymentEvidence?.planFingerprint || requiredDeploymentResults.some((key) => Number(deploymentResults.get(key)?.code) !== 0)) errors.push("deploymentEvidence");
  if (!bundleInspection?.valid || bundleInspection?.releaseId !== request?.knownGoodReleaseId || bundleInspection?.projectId !== config.projectId || !shaPattern.test(String(bundleInspection?.fingerprint ?? ""))) errors.push("knownGoodBundle");
  if (errors.length) throw new Error([...new Set(errors)].join(" / "));
  const projectId = config.projectId;
  const plan = {
    schemaVersion: 1,
    releaseId: config.releaseId,
    knownGoodReleaseId: request.knownGoodReleaseId,
    projectId,
    deploymentPlanFingerprint: deploymentEvidence.planFingerprint,
    acceptanceLedgerFingerprint: trigger.acceptanceLedgerFingerprint,
    failedCheckKeys: [...trigger.failedCheckKeys].sort(),
    bundleRelativePath: request.bundleRelativePath,
    bundleFingerprint: bundleInspection.fingerprint,
    deploymentApprovedByEmail: deploymentEvidence.approvedByEmail.toLowerCase(),
    prechecks: [firebaseStep("project_access", "対象Projectアクセス", ["projects:list", "--json", "--non-interactive"], null)],
    stages: [
      firebaseStep("known_good_rules", "既知正常Rules・indexes・Storage", ["deploy", "--only", "firestore,storage", "--project", projectId, "--non-interactive", "--json", "--config", "firebase.rollback.json"], request.bundleRelativePath),
      firebaseStep("known_good_functions", "既知正常Functions", ["deploy", "--only", "functions", "--project", projectId, "--non-interactive", "--json", "--config", "firebase.rollback.json"], request.bundleRelativePath),
      firebaseStep("staff_hosting_clone", "Staff Hosting直前版", ["hosting:clone", request.hostingStaffSource, `${config.hostingSites.staff}:live`, "--project", projectId, "--non-interactive"], null),
      firebaseStep("admin_hosting_clone", "Admin Hosting直前版", ["hosting:clone", request.hostingAdminSource, `${config.hostingSites.admin}:live`, "--project", projectId, "--non-interactive"], null),
    ],
    postchecks: [
      firebaseStep("functions_inventory", "Functions一覧", ["functions:list", "--project", projectId, "--json"], null),
      firebaseStep("hosting_inventory", "Hosting一覧", ["hosting:sites:list", "--project", projectId, "--json"], null),
      { key: "staff_https", label: "Staff HTTPS", kind: "http", url: config.urls.staffAppUrl },
      { key: "admin_https", label: "Admin HTTPS", kind: "http", url: config.urls.adminAppUrl },
    ],
    failurePolicy: "STOP_AND_KEEP_EMERGENCY_LOCK",
  };
  return { ...plan, fingerprint: sha256(plan) };
}

function firebaseStep(key, label, args, cwdRelative) { return { key, label, kind: "firebase", executable: "firebase", args, cwdRelative }; }

export function createRollbackApprovalDraft(plan, now = new Date()) {
  const approvedAt = new Date(now);
  return { schemaVersion: 1, releaseId: plan.releaseId, knownGoodReleaseId: plan.knownGoodReleaseId, projectId: plan.projectId, rollbackPlanFingerprint: plan.fingerprint, acceptanceLedgerFingerprint: plan.acceptanceLedgerFingerprint, bundleFingerprint: plan.bundleFingerprint, approvedByEmail: "ROLLBACK_APPROVER_EMAIL", changeTicketId: "ROLLBACK-CHANGE-TICKET-ID", approvedAt: approvedAt.toISOString(), expiresAt: new Date(approvedAt.getTime() + 15 * 60_000).toISOString(), typedConfirmation: "ROLLBACK_PRODUCTION", acknowledgements: Object.fromEntries(rollbackAcknowledgementKeys.map((key) => [key, false])) };
}

export function validateRollbackApproval(approval, plan, { now = new Date(), allowedApproverEmails = [] } = {}) {
  const errors = [];
  if (approval?.schemaVersion !== 1) errors.push("schemaVersion");
  for (const key of ["releaseId", "knownGoodReleaseId", "projectId", "acceptanceLedgerFingerprint", "bundleFingerprint"]) if (approval?.[key] !== plan[key]) errors.push(key);
  if (approval?.rollbackPlanFingerprint !== plan.fingerprint) errors.push("rollbackPlanFingerprint");
  const approver = String(approval?.approvedByEmail ?? "").trim().toLowerCase();
  if (!emailPattern.test(approver)) errors.push("approvedByEmail");
  if (approver === plan.deploymentApprovedByEmail) errors.push("approverSeparation");
  if (allowedApproverEmails.length && !allowedApproverEmails.map((value) => value.trim().toLowerCase()).includes(approver)) errors.push("approverNotAllowed");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{2,79}$/u.test(String(approval?.changeTicketId ?? ""))) errors.push("changeTicketId");
  const approvedAt = Date.parse(String(approval?.approvedAt ?? "")); const expiresAt = Date.parse(String(approval?.expiresAt ?? "")); const nowMs = new Date(now).getTime();
  if (!Number.isFinite(approvedAt)) errors.push("approvedAt");
  if (!Number.isFinite(expiresAt)) errors.push("expiresAt");
  if (Number.isFinite(approvedAt) && approvedAt > nowMs + 60_000) errors.push("approvedAtFuture");
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) errors.push("approvalExpired");
  if (Number.isFinite(approvedAt) && Number.isFinite(expiresAt) && (expiresAt <= approvedAt || expiresAt - approvedAt > 15 * 60_000)) errors.push("approvalWindow");
  if (approval?.typedConfirmation !== "ROLLBACK_PRODUCTION") errors.push("typedConfirmation");
  for (const key of rollbackAcknowledgementKeys) if (approval?.acknowledgements?.[key] !== true) errors.push(`acknowledgements.${key}`);
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export async function runProductionRollback({ plan, approval, confirmFingerprint, typedConfirmation, executor, httpProbe, allowedApproverEmails = [], now = new Date() }) {
  if (confirmFingerprint !== plan.fingerprint) throw new Error("rollback指紋が完全一致しません。");
  if (typedConfirmation !== "ROLLBACK_PRODUCTION") throw new Error("最終確認語が一致しません。");
  const validation = validateRollbackApproval(approval, plan, { now, allowedApproverEmails });
  if (!validation.valid) throw new Error(`rollback承認が無効です: ${validation.errors.join(", ")}`);
  const results = [];
  const access = sanitizeCommandResult(await executor(plan.prechecks[0]));
  results.push({ key: "project_access", phase: "precheck", ...access });
  if (!projectListIncludesProject(access, plan.projectId)) return failed("project_access", results);
  for (const stage of plan.stages) { const result = sanitizeCommandResult(await executor(stage)); results.push({ key: stage.key, phase: "rollback", ...result }); if (result.code !== 0) return failed(stage.key, results); }
  for (const check of plan.postchecks) { const result = sanitizeCommandResult(check.kind === "http" ? await httpProbe(check) : await executor(check)); results.push({ key: check.key, phase: "postcheck", ...result }); if (result.code !== 0) return failed(check.key, results); }
  const evidence = { schemaVersion: 1, releaseId: plan.releaseId, knownGoodReleaseId: plan.knownGoodReleaseId, projectId: plan.projectId, rollbackPlanFingerprint: plan.fingerprint, acceptanceLedgerFingerprint: plan.acceptanceLedgerFingerprint, status: "rollback_succeeded", startedAt: new Date(now).toISOString(), completedAt: new Date().toISOString(), failedStageKey: null, results };
  return { ...evidence, fingerprint: sha256(evidence) };
  function failed(failedStageKey, currentResults) { const evidence = { schemaVersion: 1, releaseId: plan.releaseId, knownGoodReleaseId: plan.knownGoodReleaseId, projectId: plan.projectId, rollbackPlanFingerprint: plan.fingerprint, acceptanceLedgerFingerprint: plan.acceptanceLedgerFingerprint, status: "rollback_failed_locked", startedAt: new Date(now).toISOString(), completedAt: new Date().toISOString(), failedStageKey, results: currentResults }; return { ...evidence, fingerprint: sha256(evidence) }; }
}

export function rollbackPlanSummary(plan) { return stableJson({ releaseId: plan.releaseId, knownGoodReleaseId: plan.knownGoodReleaseId, projectId: plan.projectId, fingerprint: plan.fingerprint, stages: plan.stages.map((item) => item.key) }); }
