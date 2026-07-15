import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { sha256 } from "./production-deploy-core.mjs";
import { buildProductionRollbackPlan, createRollbackApprovalDraft, runProductionRollback, validateRollbackApproval } from "./production-rollback-core.mjs";

const root = process.cwd(); const args = process.argv.slice(2); const exampleMode = args.includes("--examples"); const prepareMode = args.includes("--prepare"); const applyMode = args.includes("--apply"); const validateMode = args.includes("--validate-approval");
const configPath = resolve(root, valueAfter("--config") ?? (exampleMode ? "config-samples/production-rollback.example.json" : "config/production-rollback.json"));
const requestPath = resolve(root, valueAfter("--request") ?? (exampleMode ? "config-samples/production-rollback-request.example.json" : "config/production-rollback-request.json"));
const approvalPath = resolve(root, valueAfter("--approval") ?? "config/production-rollback-approval.json");
const triggerPath = resolve(root, valueAfter("--trigger") ?? "release-evidence/production/rollback-trigger.json");
const deploymentPath = resolve(root, valueAfter("--deployment-evidence") ?? "release-evidence/production/deployment-result.json");
if ([prepareMode, applyMode, validateMode].filter(Boolean).length > 1) fail("--prepare・--apply・--validate-approvalは同時指定できません。");
for (const [path, label] of [[configPath, "rollback設定"], [requestPath, "rollback request"]]) if (!existsSync(path)) fail(`${label}がありません: ${relative(root, path)}`);
if (!exampleMode && process.platform !== "win32") for (const path of [configPath, requestPath]) if ((statSync(path).mode & 0o077) !== 0) fail(`${relative(root, path)}の権限が広すぎます。chmod 600を実行してください。`);
const packageJson = await readJson(resolve(root, "package.json"), "package.json"); if (packageJson.version !== "5.6.0") fail("package versionは5.6.0が必須です。");
const config = await readJson(configPath, "rollback設定"); const request = await readJson(requestPath, "rollback request");
let trigger; let deploymentEvidence; let bundleInspection;
if (exampleMode) {
  trigger = { schemaVersion: 1, releaseId: "v5.6.0", projectId: config.projectId, acceptanceLedgerFingerprint: "a".repeat(64), acceptancePlanFingerprint: "d".repeat(64), deploymentPlanFingerprint: "b".repeat(64), failedCheckKeys: ["staff_app"] };
  deploymentEvidence = { schemaVersion: 1, status: "succeeded", releaseId: "v5.6.0", projectId: config.projectId, planFingerprint: "b".repeat(64), approvedByEmail: "deployer@example.jp", results: ["project_access", "rules_and_storage", "functions", "hosting", "functions_inventory", "hosting_inventory", "staff_https", "admin_https"].map((key) => ({ key, code: 0 })) };
  bundleInspection = { valid: true, releaseId: request.knownGoodReleaseId, projectId: config.projectId, fingerprint: "c".repeat(64) };
} else {
  for (const [path, label] of [[triggerPath, "rollback trigger"], [deploymentPath, "デプロイ証跡"]]) if (!existsSync(path)) fail(`${label}がありません: ${relative(root, path)}`);
  trigger = await readJson(triggerPath, "rollback trigger"); deploymentEvidence = await readJson(deploymentPath, "デプロイ証跡"); bundleInspection = await inspectKnownGoodBundle(config, request);
}
let plan; try { plan = buildProductionRollbackPlan({ config, request, trigger, bundleInspection, deploymentEvidence }); } catch (error) { fail(`rollback計画が不正です: ${error instanceof Error ? error.message : String(error)}`); }
printPlan(plan);
if (!prepareMode && !applyMode && !validateMode) { console.log("PRODUCTION ROLLBACK PREVIEW: PASS / 外部変更なし"); process.exit(0); }
if (exampleMode) fail("サンプル設定から実rollbackは準備・実行できません。");
if (prepareMode) {
  await safeWriteJson(resolve(root, "release-evidence/production/rollback-execution-plan.json"), plan);
  if (existsSync(approvalPath) && !args.includes("--replace-approval")) fail("rollback承認JSONが既にあります。置換は--replace-approvalを指定してください。");
  await safeWriteJson(approvalPath, createRollbackApprovalDraft(plan));
  console.log(`ROLLBACK APPROVAL DRAFT: ${relative(root, approvalPath)}`); console.log("別承認者・変更票・15分期限・6確認を入力してください。まだrollbackしていません。"); process.exit(0);
}
if (!existsSync(approvalPath)) fail(`rollback承認JSONがありません: ${relative(root, approvalPath)}`);
if (process.platform !== "win32" && (statSync(approvalPath).mode & 0o077) !== 0) fail("rollback承認JSONの権限が広すぎます。chmod 600を実行してください。");
const approval = await readJson(approvalPath, "rollback承認JSON"); const allowedApproverEmails = await readApproverEmails(); if (!allowedApproverEmails.length) fail("functions/.env.productionにEXECUTIVE_APPROVER_EMAILSがありません。");
const validation = validateRollbackApproval(approval, plan, { allowedApproverEmails }); if (!validation.valid) fail(`PRODUCTION ROLLBACK APPROVAL: BLOCKED (${validation.errors.join(" / ")})`);
console.log(`PRODUCTION ROLLBACK APPROVAL: PASS approver=${approval.approvedByEmail}`); if (validateMode) process.exit(0);
if (Number(process.versions.node.split(".")[0]) !== 22) fail(`実rollbackはNode 22限定です。現在: ${process.versions.node}`);
const confirm = valueAfter("--confirm"); const typed = valueAfter("--typed"); if (confirm !== plan.fingerprint) fail("--confirmにrollback計画指紋を完全一致で指定してください。"); if (typed !== "ROLLBACK_PRODUCTION") fail("--typed ROLLBACK_PRODUCTIONが必須です。");
const executor = async (step) => { const cwd = step.cwdRelative ? resolve(root, step.cwdRelative) : root; const result = spawnSync(step.executable, step.args, { cwd, encoding: "utf8", shell: false, maxBuffer: 10 * 1024 * 1024 }); return { code: typeof result.status === "number" ? result.status : 1, stdout: result.stdout ?? "", stderr: result.error ? `${result.stderr ?? ""}\n${result.error.message}` : result.stderr ?? "" }; };
const httpProbe = async (check) => { try { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000); const response = await fetch(check.url, { signal: controller.signal, redirect: "manual", headers: { "cache-control": "no-cache", "user-agent": "Lip-Knots-Production-Rollback/v5.6.0" } }); clearTimeout(timer); const body = await response.text(); const ready = response.status === 200 && body.includes("Lip Knots Crew"); return { code: ready ? 0 : 1, stdout: JSON.stringify({ url: check.url, status: response.status, markerReady: ready }), stderr: ready ? "" : "rollback後HTTPS確認失敗" }; } catch (error) { return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }; } };
let result; try { result = await runProductionRollback({ plan, approval, confirmFingerprint: confirm, typedConfirmation: typed, executor, httpProbe, allowedApproverEmails }); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
await safeWriteJson(resolve(root, "release-evidence/production/rollback-result.json"), result);
if (result.status !== "rollback_succeeded") fail(`PRODUCTION ROLLBACK: FAILED LOCKED stage=${result.failedStageKey}`);
console.log(`PRODUCTION ROLLBACK: SUCCEEDED ${plan.releaseId} → ${plan.knownGoodReleaseId}`); console.log("緊急停止は維持してください。既知正常版で受入検査を3回やり直すまで解除禁止です。");

async function inspectKnownGoodBundle(valueConfig, valueRequest) {
  const allowedRoot = resolve(root, valueConfig.rollbackSourceRoot); const bundleRoot = resolve(root, valueRequest.bundleRelativePath); if (!(bundleRoot === allowedRoot || bundleRoot.startsWith(`${allowedRoot}${sep}`))) fail("known-good bundleがrollbackSourceRoot外です。");
  const realAllowed = await realpath(allowedRoot).catch(() => allowedRoot); const realBundle = await realpath(bundleRoot).catch(() => ""); if (!realBundle || !(realBundle === realAllowed || realBundle.startsWith(`${realAllowed}${sep}`))) fail("known-good bundleの実体パスが不正です。");
  const manifestPath = resolve(bundleRoot, "rollback-manifest.json"); if (!existsSync(manifestPath)) fail("rollback-manifest.jsonがありません。"); const manifest = await readJson(manifestPath, "rollback manifest");
  const required = ["firebase.rollback.json", "firestore.rules", "firestore.indexes.json", "storage.rules", "functions/package.json", "functions/lib/index.js"]; const errors = [];
  if (manifest.schemaVersion !== 1 || manifest.releaseId !== valueRequest.knownGoodReleaseId || manifest.projectId !== valueConfig.projectId) errors.push("manifest metadata");
  const files = manifest.files && typeof manifest.files === "object" && !Array.isArray(manifest.files) ? manifest.files : {};
  const manifestPaths = Object.keys(files).sort();
  for (const path of required) if (!manifestPaths.includes(path)) errors.push(`${path}:manifest`);
  for (const path of manifestPaths) {
    const allowed = ["firebase.rollback.json", "firestore.rules", "firestore.indexes.json", "storage.rules", "functions/package.json"].includes(path) || path.startsWith("functions/lib/");
    if (!allowed || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) { errors.push(`${path}:path`); continue; }
    const absolute = resolve(bundleRoot, path); if (!absolute.startsWith(`${bundleRoot}${sep}`) || !existsSync(absolute)) { errors.push(path); continue; }
    const info = await lstat(absolute); if (!info.isFile() || info.isSymbolicLink()) { errors.push(`${path}:type`); continue; }
    const actual = createHash("sha256").update(await readFile(absolute)).digest("hex"); if (files[path] !== actual) errors.push(`${path}:sha256`);
  }
  const actualPaths = await collectBundlePaths(bundleRoot, bundleRoot);
  const expectedPaths = [...manifestPaths, "rollback-manifest.json"].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) errors.push("bundle file inventory");
  const canonicalFiles = Object.fromEntries(manifestPaths.map((path) => [path, files[path]]));
  const canonical = { schemaVersion: manifest.schemaVersion, releaseId: manifest.releaseId, projectId: manifest.projectId, files: canonicalFiles };
  const fingerprint = sha256(canonical); if (manifest.fingerprint !== fingerprint) errors.push("manifest fingerprint");
  return { valid: errors.length === 0, errors: [...new Set(errors)], releaseId: manifest.releaseId, projectId: manifest.projectId, fingerprint };
}
async function collectBundlePaths(directory, bundleRoot) { const output = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const absolute = resolve(directory, entry.name); if (!absolute.startsWith(`${bundleRoot}${sep}`)) fail("known-good bundle内にpath escapeがあります。"); if (entry.isSymbolicLink()) fail(`known-good bundle内のsymlinkは禁止です: ${relative(bundleRoot, absolute)}`); if (entry.isDirectory()) output.push(...await collectBundlePaths(absolute, bundleRoot)); else if (entry.isFile()) output.push(relative(bundleRoot, absolute).split(sep).join("/")); else fail(`known-good bundle内の特殊fileは禁止です: ${relative(bundleRoot, absolute)}`); } return output.sort(); }
function valueAfter(flag) { const index = args.indexOf(flag); if (index < 0) return null; if (!args[index + 1] || args[index + 1].startsWith("--")) fail(`${flag}の値がありません。`); return args[index + 1]; }
async function readJson(path, label) { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { fail(`${label}が不正です: ${error instanceof Error ? error.message : String(error)}`); } }
async function safeWriteJson(path, value) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.tmp-${process.pid}`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
async function readApproverEmails() { const path = resolve(root, "functions/.env.production"); if (!existsSync(path)) return []; const line = (await readFile(path, "utf8")).split(/\r?\n/u).find((value) => value.startsWith("EXECUTIVE_APPROVER_EMAILS=")); return line ? line.slice("EXECUTIVE_APPROVER_EMAILS=".length).split(",").map((value) => value.trim()).filter(Boolean) : []; }
function printPlan(value) { console.log(`ROLLBACK: ${value.releaseId} → ${value.knownGoodReleaseId}`); console.log(`PROJECT: ${value.projectId}`); console.log(`ROLLBACK FINGERPRINT: ${value.fingerprint}`); value.stages.forEach((stage, index) => console.log(`${index + 1}. ${stage.label}`)); console.log("失敗時は緊急停止を維持し、後続stageを実行しません。"); }
function fail(message) { console.error(message); process.exit(1); }
