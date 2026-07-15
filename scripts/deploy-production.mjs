import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  buildProductionDeploymentPlan,
  createApprovalDraft,
  createRollbackPlan,
  productionReleaseId,
  runDeploymentWithExecutor,
  sha256,
  validateProductionApproval,
} from "./production-deploy-core.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const exampleMode = args.includes("--examples");
const prepareMode = args.includes("--prepare");
const applyMode = args.includes("--apply");
const validateMode = args.includes("--validate-approval");
const configPath = resolve(root, valueAfter("--config") ?? (exampleMode ? "config-samples/production-deploy.example.json" : "config/production-deploy.json"));
const approvalPath = resolve(root, valueAfter("--approval") ?? (exampleMode ? "config-samples/production-deploy-approval.example.json" : "config/production-deploy-approval.json"));

if ([prepareMode, applyMode, validateMode].filter(Boolean).length > 1) fail("--prepare・--apply・--validate-approvalは同時指定できません。");
if (!existsSync(configPath)) fail(`設定ファイルがありません: ${relative(root, configPath)}`);
if (!exampleMode && process.platform !== "win32" && (statSync(configPath).mode & 0o077) !== 0) fail("本番デプロイ設定の権限が広すぎます。chmod 600を実行してください。");
const config = await readJson(configPath, "デプロイ設定");
const packageJson = await readJson(resolve(root, "package.json"), "package.json");
if (packageJson.version !== productionReleaseId.slice(1)) fail(`package versionは${productionReleaseId.slice(1)}が必須です。`);
let plan;
try { plan = buildProductionDeploymentPlan(config, { allowPlaceholders: exampleMode }); }
catch (error) { fail(`デプロイ計画が不正です: ${error instanceof Error ? error.message : String(error)}`); }

printPlan(plan);
if (!prepareMode && !applyMode && !validateMode) {
  console.log("PRODUCTION DEPLOY PREVIEW: PASS / 外部変更なし");
  process.exit(0);
}

if (prepareMode) {
  if (exampleMode) fail("サンプル設定から実承認ファイルは作成できません。");
  const draft = createApprovalDraft(plan);
  await safeWriteJson(resolve(root, "release-evidence/production/deployment-plan.json"), plan);
  if (existsSync(approvalPath) && !args.includes("--replace-approval")) fail("承認JSONが既にあります。置換する場合は--replace-approvalを指定してください。");
  await safeWriteJson(approvalPath, draft, 0o600);
  console.log(`APPROVAL DRAFT: ${relative(root, approvalPath)}`);
  console.log("承認者・変更票・直前checkpoint・rollback元・5確認を入力し、期限を更新してください。まだデプロイしていません。");
  process.exit(0);
}

if (!existsSync(approvalPath)) fail(`承認JSONがありません: ${relative(root, approvalPath)}`);
if (!exampleMode && process.platform !== "win32" && (statSync(approvalPath).mode & 0o077) !== 0) fail("承認JSONの権限が広すぎます。chmod 600を実行してください。");
const approval = await readJson(approvalPath, "承認JSON");
const allowedApproverEmails = await readApproverEmails();
if (!exampleMode && allowedApproverEmails.length === 0) fail("functions/.env.productionにEXECUTIVE_APPROVER_EMAILSがありません。");
const validation = validateProductionApproval(approval, plan, { allowedApproverEmails });
if (!validation.valid) fail(`PRODUCTION APPROVAL: BLOCKED (${validation.errors.join(" / ")})`);
console.log(`PRODUCTION APPROVAL: PASS approver=${approval.approvedByEmail} ticket=${approval.changeTicketId}`);
if (validateMode) process.exit(0);

if (Number(process.versions.node.split(".")[0]) !== 22) fail(`実デプロイはNode 22限定です。現在: ${process.versions.node}`);
const confirmFingerprint = valueAfter("--confirm");
if (!confirmFingerprint || confirmFingerprint !== plan.fingerprint) fail("--confirmに64文字の計画指紋を完全一致で指定してください。");
for (const path of ["apps/staff/dist/index.html", "apps/admin/dist/index.html", "functions/lib/index.js", ".firebaserc", "firebase.json", "firestore.rules", "storage.rules"]) {
  if (!existsSync(resolve(root, path))) fail(`本番成果物がありません: ${path}`);
}
const evidenceRoot = resolve(root, "release-evidence/production");
await mkdir(evidenceRoot, { recursive: true });
const executor = async (step) => {
  const result = spawnSync(step.executable, step.args, { cwd: root, encoding: "utf8", shell: false, maxBuffer: 10 * 1024 * 1024 });
  return { code: typeof result.status === "number" ? result.status : 1, stdout: result.stdout ?? "", stderr: result.error ? `${result.stderr ?? ""}\n${result.error.message}` : result.stderr ?? "" };
};
const httpProbe = async (check) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(check.url, { signal: controller.signal, redirect: "follow", headers: { "user-agent": `Lip-Knots-Production-Smoke/${productionReleaseId}` } });
    clearTimeout(timer);
    const body = await response.text();
    const markerReady = body.includes("Lip Knots Crew");
    return { code: response.ok && markerReady ? 0 : 1, stdout: JSON.stringify({ url: check.url, status: response.status, markerReady }), stderr: response.ok && markerReady ? "" : `HTTP ${response.status} またはアプリmarker不一致` };
  } catch (error) { return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }; }
};

let result;
try {
  result = await runDeploymentWithExecutor({ plan, approval, confirmFingerprint, executor, httpProbe, allowedApproverEmails });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const evidenceBase = {
  schemaVersion: 1,
  releaseId: plan.releaseId,
  projectId: plan.projectId,
  planFingerprint: plan.fingerprint,
  approvedByEmail: approval.approvedByEmail,
  changeTicketId: approval.changeTicketId,
  ...result,
};
const evidence = { ...evidenceBase, fingerprint: sha256(evidenceBase) };
await safeWriteJson(resolve(evidenceRoot, "deployment-result.json"), evidence);
if (result.status !== "succeeded") {
  await safeWriteJson(resolve(evidenceRoot, "rollback-plan.json"), createRollbackPlan({ plan, approval, failedStageKey: result.failedStageKey }));
  fail(`PRODUCTION DEPLOY: FAILED stage=${result.failedStageKey} / rollback-plan.jsonを確認してください。`);
}
console.log(`PRODUCTION DEPLOY: SUCCEEDED release=${plan.releaseId} project=${plan.projectId}`);
console.log("証跡: release-evidence/production/deployment-result.json");

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  if (!args[index + 1] || args[index + 1].startsWith("--")) fail(`${flag}の値がありません。`);
  return args[index + 1];
}

async function readJson(path, label) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { fail(`${label}が不正です: ${error instanceof Error ? error.message : String(error)}`); }
}

async function safeWriteJson(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  await rename(temporary, path);
}

async function readApproverEmails() {
  const path = resolve(root, "functions/.env.production");
  if (!existsSync(path)) return exampleMode ? ["executive@example.jp"] : [];
  const source = await readFile(path, "utf8");
  const line = source.split(/\r?\n/u).find((value) => value.startsWith("EXECUTIVE_APPROVER_EMAILS="));
  return line ? line.slice("EXECUTIVE_APPROVER_EMAILS=".length).split(",").map((value) => value.trim()).filter(Boolean) : [];
}

function printPlan(value) {
  console.log(`RELEASE: ${value.releaseId}`);
  console.log(`PROJECT: ${value.projectId}`);
  console.log(`PLAN FINGERPRINT: ${value.fingerprint}`);
  value.stages.forEach((stage, index) => console.log(`${index + 1}. ${stage.label} [${stage.args[2]}]`));
  console.log("失敗時は即停止し、後続stageを実行しません。");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
