import { projectListIncludesProject, sanitizeCommandResult, sha256, stableJson } from "./production-deploy-core.mjs";

export const productionAcceptanceReleaseId = "v5.6.0";
const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const shaPattern = /^[a-f0-9]{64}$/u;

export function validateProductionAcceptanceConfig(config, { allowPlaceholders = false } = {}) {
  const errors = [];
  if (config?.schemaVersion !== 1) errors.push("schemaVersion");
  if (config?.releaseId !== productionAcceptanceReleaseId) errors.push("releaseId");
  if (!projectPattern.test(String(config?.projectId ?? ""))) errors.push("projectId");
  if (!Number.isInteger(config?.requiredPasses) || config.requiredPasses < 2 || config.requiredPasses > 6) errors.push("requiredPasses");
  if (!Number.isInteger(config?.minimumSpacingMinutes) || config.minimumSpacingMinutes < 1 || config.minimumSpacingMinutes > 30) errors.push("minimumSpacingMinutes");
  if (!Number.isInteger(config?.acceptanceDeadlineMinutes) || config.acceptanceDeadlineMinutes < 15 || config.acceptanceDeadlineMinutes > 120) errors.push("acceptanceDeadlineMinutes");
  if (!Array.isArray(config?.requiredFunctions) || config.requiredFunctions.length < 5 || new Set(config.requiredFunctions).size !== config.requiredFunctions.length) errors.push("requiredFunctions");
  for (const value of config?.requiredFunctions ?? []) if (!/^[A-Za-z][A-Za-z0-9_-]{2,100}$/u.test(String(value))) errors.push("requiredFunctionName");
  const sites = [config?.hostingSites?.staff, config?.hostingSites?.admin];
  if (sites.some((value) => !/^[a-z0-9][a-z0-9-]{2,62}$/u.test(String(value ?? ""))) || new Set(sites).size !== 2) errors.push("hostingSites");
  for (const key of ["staffAppUrl", "adminAppUrl", "loginGatewayUrl", "driveFilePreviewUrl"]) {
    const value = String(config?.urls?.[key] ?? "");
    try { if (new URL(value).protocol !== "https:") errors.push(key); }
    catch { errors.push(key); }
    if (!allowPlaceholders && /YOUR_|REPLACE_ME|example\.com/iu.test(value)) errors.push(`${key}Placeholder`);
  }
  if (new Set(Object.values(config?.urls ?? {})).size !== 4) errors.push("urlsUnique");
  if (containsSecret(config)) errors.push("secretInConfig");
  return [...new Set(errors)];
}

function containsSecret(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value)) {
    if (/private.?key|service.?account|client.?secret|access.?token|refresh.?token|password/iu.test(key) && String(item ?? "").trim()) return true;
    if (item && typeof item === "object" && containsSecret(item)) return true;
  }
  return false;
}

export function buildProductionAcceptancePlan(config, { allowPlaceholders = false, releaseIdOverride = null } = {}) {
  const errors = validateProductionAcceptanceConfig(config, { allowPlaceholders });
  if (errors.length) throw new Error(errors.join(" / "));
  const releaseId = releaseIdOverride ?? config.releaseId;
  if (!/^v\d+\.\d+\.\d+$/u.test(String(releaseId))) throw new Error("releaseIdOverride");
  const plan = {
    schemaVersion: 1,
    releaseId,
    projectId: config.projectId,
    requiredPasses: config.requiredPasses,
    minimumSpacingMinutes: config.minimumSpacingMinutes,
    acceptanceDeadlineMinutes: config.acceptanceDeadlineMinutes,
    checks: [
      firebaseCheck("project_access", "対象Projectアクセス", ["projects:list", "--json", "--non-interactive"], { projectId: config.projectId }),
      firebaseCheck("functions_inventory", "必須Functions一覧", ["functions:list", "--project", config.projectId, "--json"], { requiredFunctions: config.requiredFunctions }),
      firebaseCheck("hosting_inventory", "Staff・Admin Hosting一覧", ["hosting:sites:list", "--project", config.projectId, "--json"], { requiredSites: [config.hostingSites.staff, config.hostingSites.admin] }),
      httpCheck("staff_app", "Staffアプリ", config.urls.staffAppUrl, [200], "Lip Knots Crew", true),
      httpCheck("staff_manifest", "Staff PWA manifest", new URL("/manifest.webmanifest", config.urls.staffAppUrl).toString(), [200], "Lip Knots Crew", false),
      httpCheck("admin_app", "Adminアプリ", config.urls.adminAppUrl, [200], "Lip Knots Crew", true),
      httpCheck("admin_manifest", "Admin PWA manifest", new URL("/manifest.webmanifest", config.urls.adminAppUrl).toString(), [200], "Lip Knots Crew Admin", false),
      httpCheck("login_gateway", "Login Gateway拒否応答", config.urls.loginGatewayUrl, [400], "Lip Knots Crew", false),
      httpCheck("drive_preview", "Drive Preview拒否応答", config.urls.driveFilePreviewUrl, [400], "Invalid preview token", false),
    ],
  };
  return { ...plan, fingerprint: sha256(plan) };
}

function firebaseCheck(key, label, args, expected) {
  return { key, label, kind: "firebase", executable: "firebase", args, expected };
}

function httpCheck(key, label, url, statuses, marker, requireSecurityHeaders) {
  return { key, label, kind: "http", url, expected: { statuses, marker, requireSecurityHeaders } };
}

export function validateDeploymentEvidence(evidence, plan, { now = new Date() } = {}) {
  const errors = [];
  if (evidence?.schemaVersion !== 1) errors.push("schemaVersion");
  if (evidence?.status !== "succeeded") errors.push("deploymentStatus");
  if (evidence?.releaseId !== plan.releaseId) errors.push("releaseId");
  if (evidence?.projectId !== plan.projectId) errors.push("projectId");
  if (!shaPattern.test(String(evidence?.planFingerprint ?? ""))) errors.push("planFingerprint");
  const requiredKeys = ["project_access", "rules_and_storage", "functions", "hosting", "functions_inventory", "hosting_inventory", "staff_https", "admin_https"];
  const results = new Map((evidence?.results ?? []).map((item) => [item?.key, item]));
  for (const key of requiredKeys) if (Number(results.get(key)?.code) !== 0) errors.push(`deploymentResult.${key}`);
  const completedAt = Date.parse(String(evidence?.completedAt ?? ""));
  const ageMinutes = (new Date(now).getTime() - completedAt) / 60_000;
  if (!Number.isFinite(completedAt)) errors.push("completedAt");
  else if (ageMinutes < -1) errors.push("completedAtFuture");
  else if (ageMinutes > plan.acceptanceDeadlineMinutes) errors.push("acceptanceDeadlineExceeded");
  return { valid: errors.length === 0, errors: [...new Set(errors)], completedAt: Number.isFinite(completedAt) ? new Date(completedAt).toISOString() : null, ageMinutes: Number.isFinite(ageMinutes) ? Math.max(0, Math.round(ageMinutes * 10) / 10) : null };
}

export function validateRollbackEvidence(evidence, plan, { now = new Date() } = {}) {
  const errors = [];
  if (evidence?.schemaVersion !== 1) errors.push("schemaVersion");
  if (evidence?.status !== "rollback_succeeded") errors.push("rollbackStatus");
  if (evidence?.knownGoodReleaseId !== plan.releaseId) errors.push("knownGoodReleaseId");
  if (evidence?.projectId !== plan.projectId) errors.push("projectId");
  if (!shaPattern.test(String(evidence?.rollbackPlanFingerprint ?? ""))) errors.push("rollbackPlanFingerprint");
  const requiredKeys = ["project_access", "known_good_rules", "known_good_functions", "staff_hosting_clone", "admin_hosting_clone", "functions_inventory", "hosting_inventory", "staff_https", "admin_https"];
  const results = new Map((evidence?.results ?? []).map((item) => [item?.key, item]));
  for (const key of requiredKeys) if (Number(results.get(key)?.code) !== 0) errors.push(`rollbackResult.${key}`);
  const completedAt = Date.parse(String(evidence?.completedAt ?? ""));
  const ageMinutes = (new Date(now).getTime() - completedAt) / 60_000;
  if (!Number.isFinite(completedAt)) errors.push("completedAt");
  else if (ageMinutes < -1) errors.push("completedAtFuture");
  else if (ageMinutes > plan.acceptanceDeadlineMinutes) errors.push("acceptanceDeadlineExceeded");
  return { valid: errors.length === 0, errors: [...new Set(errors)], completedAt: Number.isFinite(completedAt) ? new Date(completedAt).toISOString() : null, ageMinutes: Number.isFinite(ageMinutes) ? Math.max(0, Math.round(ageMinutes * 10) / 10) : null };
}

export function parseInventoryNames(result) {
  try {
    const parsed = typeof result?.stdout === "string" ? JSON.parse(result.stdout) : result?.stdout;
    const root = parsed?.result ?? parsed;
    const names = [];
    walk(root, names);
    return [...new Set(names)];
  } catch { return []; }
}

function walk(value, names) {
  if (Array.isArray(value)) { value.forEach((item) => walk(item, names)); return; }
  if (!value || typeof value !== "object") return;
  for (const key of ["id", "name", "functionName", "site", "siteId", "projectId"]) if (typeof value[key] === "string") names.push(value[key]);
  for (const item of Object.values(value)) if (item && typeof item === "object") walk(item, names);
}

export function evaluateAcceptanceCheck(check, rawResult) {
  if (check.kind === "firebase") {
    const safe = sanitizeCommandResult(rawResult);
    if (safe.code !== 0) return { passed: false, actual: `exit ${safe.code}`, evidence: safe };
    if (check.key === "project_access") return { passed: projectListIncludesProject(safe, check.expected.projectId), actual: check.expected.projectId, evidence: safe };
    const names = parseInventoryNames(safe);
    const required = check.expected.requiredFunctions ?? check.expected.requiredSites ?? [];
    const missing = required.filter((name) => !names.some((actual) => actual === name || actual.endsWith(`/${name}`)));
    return { passed: missing.length === 0, actual: missing.length ? `missing: ${missing.join(",")}` : `${required.length}/${required.length}`, evidence: { code: safe.code, inventoryCount: names.length, matchedCount: required.length - missing.length } };
  }
  const status = Number(rawResult?.status ?? 0);
  const headers = Object.fromEntries(Object.entries(rawResult?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const body = String(rawResult?.body ?? "").slice(0, 20_000);
  const statusReady = check.expected.statuses.includes(status);
  const markerReady = body.includes(check.expected.marker);
  const requiredHeaders = ["x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy", "strict-transport-security"];
  const missingHeaders = check.expected.requireSecurityHeaders ? requiredHeaders.filter((key) => !headers[key]) : [];
  let finalOriginReady = true;
  try { if (rawResult?.finalUrl) finalOriginReady = new URL(rawResult.finalUrl).origin === new URL(check.url).origin; } catch { finalOriginReady = false; }
  const headerStatus = check.expected.requireSecurityHeaders ? `${requiredHeaders.length - missingHeaders.length}/${requiredHeaders.length}` : "n/a";
  return { passed: statusReady && markerReady && missingHeaders.length === 0 && finalOriginReady, actual: `HTTP ${status} / marker=${markerReady} / headers=${headerStatus}`, evidence: { code: statusReady && markerReady && missingHeaders.length === 0 && finalOriginReady ? 0 : 1, status, markerReady, missingHeaders, finalUrl: String(rawResult?.finalUrl ?? check.url), headers: Object.fromEntries(requiredHeaders.filter((key) => headers[key]).map((key) => [key, headers[key]])) } };
}

export async function runProductionAcceptance({ plan, deploymentEvidence, executor, httpProbe, now = new Date(), evidenceKind = "deployment" }) {
  const recovery = evidenceKind === "rollback";
  const deployment = recovery ? validateRollbackEvidence(deploymentEvidence, plan, { now }) : validateDeploymentEvidence(deploymentEvidence, plan, { now });
  if (!deployment.valid) throw new Error(`${recovery ? "rollback" : "デプロイ"}証跡が無効です: ${deployment.errors.join(", ")}`);
  const checks = [];
  for (const check of plan.checks) {
    const raw = check.kind === "http" ? await httpProbe(check) : await executor(check);
    const evaluated = evaluateAcceptanceCheck(check, raw);
    checks.push({ key: check.key, label: check.label, ...evaluated });
  }
  const passed = checks.every((check) => check.passed);
  const report = { schemaVersion: 1, releaseId: plan.releaseId, projectId: plan.projectId, acceptancePlanFingerprint: plan.fingerprint, deploymentPlanFingerprint: recovery ? deploymentEvidence.rollbackPlanFingerprint : deploymentEvidence.planFingerprint, deploymentCompletedAt: deployment.completedAt, sourceKind: recovery ? "rollback" : "deployment", observedAt: new Date(now).toISOString(), passed, checks };
  return { ...report, fingerprint: sha256(report) };
}

export function updateAcceptanceLedger(previousLedger, report, plan) {
  const previousRuns = Array.isArray(previousLedger?.runs) && previousLedger?.releaseId === plan.releaseId && previousLedger?.deploymentPlanFingerprint === report.deploymentPlanFingerprint ? previousLedger.runs : [];
  const runs = [...previousRuns, report].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)).slice(-20);
  const failure = runs.find((run) => run.passed !== true);
  const spacedPasses = [];
  for (const run of runs.filter((item) => item.passed)) {
    const previous = spacedPasses.at(-1);
    if (!previous || Date.parse(run.observedAt) - Date.parse(previous.observedAt) >= plan.minimumSpacingMinutes * 60_000) spacedPasses.push(run);
  }
  const status = failure ? "rollback_required" : spacedPasses.length >= plan.requiredPasses ? "accepted" : "observing";
  const ledger = { schemaVersion: 1, releaseId: plan.releaseId, projectId: plan.projectId, deploymentPlanFingerprint: report.deploymentPlanFingerprint, acceptancePlanFingerprint: plan.fingerprint, status, requiredPasses: plan.requiredPasses, validPasses: spacedPasses.length, nextEligibleAt: status === "observing" ? new Date(Date.parse(spacedPasses.at(-1)?.observedAt ?? report.observedAt) + plan.minimumSpacingMinutes * 60_000).toISOString() : null, failedCheckKeys: failure ? failure.checks.filter((check) => !check.passed).map((check) => check.key) : [], runs };
  return { ...ledger, fingerprint: sha256(ledger) };
}

export function acceptancePlanSummary(plan) {
  return stableJson({ releaseId: plan.releaseId, projectId: plan.projectId, fingerprint: plan.fingerprint, checks: plan.checks.map((check) => check.key) });
}
