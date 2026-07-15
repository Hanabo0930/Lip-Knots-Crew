import { createHash } from "node:crypto";

export const productionReleaseId = "v5.6.0";
export const productionDeployScopes = ["firestore", "storage", "functions", "hosting:staff", "hosting:admin"];
export const approvalAcknowledgementKeys = [
  "backupVerified",
  "previousSourceCheckpointVerified",
  "rulesRollbackLimitationAccepted",
  "emergencyLockOwnerAssigned",
  "hostingRollbackOwnerAssigned",
];

const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const ticketPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,79}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stable(value));
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

export function validateProductionDeployConfig(config, { allowPlaceholders = false } = {}) {
  const errors = [];
  if (config?.appEnvironment !== "production") errors.push("appEnvironmentはproduction固定です。");
  if (!projectPattern.test(String(config?.projectId ?? ""))) errors.push("projectIdがFirebase Project ID形式ではありません。");
  if (Number(config?.expectedNodeMajor) !== 22) errors.push("expectedNodeMajorは22固定です。");
  const actualScopes = Array.isArray(config?.deployScope) ? config.deployScope : [];
  const expectedScopes = [...productionDeployScopes].sort();
  if (stableJson([...actualScopes].sort()) !== stableJson(expectedScopes)) errors.push("deployScopeは本番5スコープと完全一致させてください。");
  for (const [key, label] of [["staffAppUrl", "staffAppUrl"], ["adminAppUrl", "adminAppUrl"]]) {
    const value = String(config?.[key] ?? "");
    if (!value) errors.push(`${label}がありません。`);
    else {
      try { if (new URL(value).protocol !== "https:") errors.push(`${label}はHTTPSが必須です。`); }
      catch { errors.push(`${label}がURLとして不正です。`); }
    }
    if (!allowPlaceholders && /YOUR_|REPLACE_ME|example\.com/iu.test(value)) errors.push(`${label}にサンプル値が残っています。`);
  }
  if (config?.staffAppUrl && config.staffAppUrl === config.adminAppUrl) errors.push("staffAppUrlとadminAppUrlは分離してください。");
  if (containsForbiddenSecret(config)) errors.push("デプロイ設定に秘密値を保存できません。");
  return [...new Set(errors)];
}

function containsForbiddenSecret(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value)) {
    if (/private.?key|service.?account|client.?secret|access.?token|refresh.?token|password/iu.test(key) && String(item ?? "").trim()) return true;
    if (item && typeof item === "object" && containsForbiddenSecret(item)) return true;
  }
  return false;
}

export function buildProductionDeploymentPlan(config, { releaseId = productionReleaseId, allowPlaceholders = false } = {}) {
  const errors = validateProductionDeployConfig(config, { allowPlaceholders });
  if (errors.length) throw new Error(errors.join(" / "));
  const projectId = config.projectId;
  const plan = {
    schemaVersion: 1,
    releaseId,
    projectId,
    deployScope: [...productionDeployScopes],
    stages: [
      stage("rules_and_storage", "Firestore Rules・indexes・Storage Rules", "firestore,storage", projectId),
      stage("functions", "Cloud Functions", "functions", projectId),
      stage("hosting", "Staff・Admin Hosting", "hosting:staff,hosting:admin", projectId),
    ],
    prechecks: [command("project_access", "Firebase認証・Projectアクセス", ["projects:list", "--json", "--non-interactive"])],
    postchecks: [
      command("functions_inventory", "Functions配備一覧", ["functions:list", "--project", projectId, "--json"]),
      command("hosting_inventory", "Hosting site一覧", ["hosting:sites:list", "--project", projectId, "--json"]),
      { key: "staff_https", label: "Staff HTTPS smoke", kind: "http", url: config.staffAppUrl },
      { key: "admin_https", label: "Admin HTTPS smoke", kind: "http", url: config.adminAppUrl },
    ],
    failurePolicy: "STOP_IMMEDIATELY_AND_WRITE_ROLLBACK_PLAN",
  };
  return { ...plan, fingerprint: sha256(plan) };
}

function stage(key, label, only, projectId) {
  return command(key, label, ["deploy", "--only", only, "--project", projectId, "--non-interactive", "--json"]);
}

function command(key, label, args) {
  return { key, label, kind: "firebase", executable: "firebase", args };
}

export function createApprovalDraft(plan, now = new Date()) {
  const approvedAt = new Date(now);
  const expiresAt = new Date(approvedAt.getTime() + 30 * 60 * 1000);
  return {
    schemaVersion: 1,
    releaseId: plan.releaseId,
    projectId: plan.projectId,
    planFingerprint: plan.fingerprint,
    deployScope: [...plan.deployScope],
    approvedByEmail: "APPROVER_EMAIL",
    changeTicketId: "CHANGE-TICKET-ID",
    approvedAt: approvedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    previousSourceCheckpointId: "PREVIOUS-SOURCE-CHECKPOINT-ID",
    hostingRollbackSource: "PREVIOUS_HOSTING_VERSION_OR_CHANNEL",
    acknowledgements: Object.fromEntries(approvalAcknowledgementKeys.map((key) => [key, false])),
  };
}

export function validateProductionApproval(approval, plan, { now = new Date(), allowedApproverEmails = [] } = {}) {
  const errors = [];
  if (approval?.schemaVersion !== 1) errors.push("schemaVersion");
  if (approval?.releaseId !== plan.releaseId) errors.push("releaseId");
  if (approval?.projectId !== plan.projectId) errors.push("projectId");
  if (!sha256Pattern.test(String(approval?.planFingerprint ?? "")) || approval?.planFingerprint !== plan.fingerprint) errors.push("planFingerprint");
  if (stableJson([...(approval?.deployScope ?? [])].sort()) !== stableJson([...plan.deployScope].sort())) errors.push("deployScope");
  const approver = String(approval?.approvedByEmail ?? "").trim().toLowerCase();
  if (!emailPattern.test(approver)) errors.push("approvedByEmail");
  if (allowedApproverEmails.length && !allowedApproverEmails.map((value) => value.trim().toLowerCase()).includes(approver)) errors.push("approverNotAllowed");
  if (!ticketPattern.test(String(approval?.changeTicketId ?? ""))) errors.push("changeTicketId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{2,119}$/u.test(String(approval?.previousSourceCheckpointId ?? ""))) errors.push("previousSourceCheckpointId");
  if (String(approval?.hostingRollbackSource ?? "").trim().length < 3) errors.push("hostingRollbackSource");
  const approvedAt = Date.parse(String(approval?.approvedAt ?? ""));
  const expiresAt = Date.parse(String(approval?.expiresAt ?? ""));
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(approvedAt)) errors.push("approvedAt");
  if (!Number.isFinite(expiresAt)) errors.push("expiresAt");
  if (Number.isFinite(approvedAt) && approvedAt > nowMs + 60_000) errors.push("approvedAtFuture");
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) errors.push("approvalExpired");
  if (Number.isFinite(approvedAt) && Number.isFinite(expiresAt) && (expiresAt <= approvedAt || expiresAt - approvedAt > 30 * 60 * 1000)) errors.push("approvalWindow");
  for (const key of approvalAcknowledgementKeys) if (approval?.acknowledgements?.[key] !== true) errors.push(`acknowledgements.${key}`);
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function projectListIncludesProject(result, projectId) {
  if (!result || Number(result.code) !== 0) return false;
  try {
    const parsed = typeof result.stdout === "string" ? JSON.parse(result.stdout) : result.stdout;
    const values = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.result) ? parsed.result : Array.isArray(parsed?.projects) ? parsed.projects : [];
    return values.some((item) => [item?.projectId, item?.id, item?.project_id].includes(projectId));
  } catch { return false; }
}

export function sanitizeCommandResult(result) {
  const sanitize = (value) => String(value ?? "")
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|authorization|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*)[^\s,"'}]+/giu, "$1[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [REDACTED]")
    .slice(0, 8_000);
  return { code: Number(result?.code ?? 1), stdout: sanitize(result?.stdout), stderr: sanitize(result?.stderr) };
}

export function createRollbackPlan({ plan, approval, failedStageKey = "unknown", generatedAt = new Date().toISOString() }) {
  return {
    schemaVersion: 1,
    releaseId: plan.releaseId,
    projectId: plan.projectId,
    planFingerprint: plan.fingerprint,
    failedStageKey,
    generatedAt,
    immediateActions: [
      "本番アプリの全体停止スイッチを作動し、変更を凍結する。",
      "release-evidence/production の証跡を保全し、インシデント担当へ連携する。",
    ],
    recovery: [
      { target: "Hosting", action: `Firebase Consoleで直前版へrollback、または記録済みソースからhosting:cloneを実行: ${approval?.hostingRollbackSource ?? "未記録"}` },
      { target: "Functions", action: `直前のソースcheckpointをcheckoutして再deploy: ${approval?.previousSourceCheckpointId ?? "未記録"}` },
      { target: "Firestore・Storage Rules", action: "Firebase CLIにはRules releaseのrollbackがないため、既知正常版のRulesを再deployする。" },
    ],
    forbidden: ["承認指紋を再利用しない", "失敗stageより後を手動で続行しない", "証跡へ秘密値を貼り付けない"],
  };
}

export async function runDeploymentWithExecutor({ plan, approval, confirmFingerprint, executor, httpProbe, allowedApproverEmails = [], now = new Date() }) {
  if (confirmFingerprint !== plan.fingerprint) throw new Error("確認指紋が完全一致しません。");
  const validation = validateProductionApproval(approval, plan, { now, allowedApproverEmails });
  if (!validation.valid) throw new Error(`承認が無効です: ${validation.errors.join(", ")}`);
  const startedAt = new Date(now).toISOString();
  const results = [];
  const precheck = plan.prechecks[0];
  const accessResult = sanitizeCommandResult(await executor(precheck));
  results.push({ key: precheck.key, phase: "precheck", ...accessResult });
  if (!projectListIncludesProject(accessResult, plan.projectId)) return failed("project_access", "Firebase認証またはProjectアクセスを確認できません。", results);
  for (const stage of plan.stages) {
    const result = sanitizeCommandResult(await executor(stage));
    results.push({ key: stage.key, phase: "deploy", ...result });
    if (result.code !== 0) return failed(stage.key, `${stage.label}で停止しました。`, results);
  }
  for (const check of plan.postchecks) {
    const raw = check.kind === "http" ? await httpProbe(check) : await executor(check);
    const result = sanitizeCommandResult(raw);
    results.push({ key: check.key, phase: "postcheck", ...result });
    if (result.code !== 0) return failed(check.key, `${check.label}で停止しました。`, results);
  }
  return { status: "succeeded", startedAt, completedAt: new Date().toISOString(), failedStageKey: null, message: "全stageと事後確認に合格しました。", results };

  function failed(failedStageKey, message, currentResults) {
    return { status: "failed", startedAt, completedAt: new Date().toISOString(), failedStageKey, message, results: currentResults };
  }
}
