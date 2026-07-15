import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { buildProductionAcceptancePlan, runProductionAcceptance, updateAcceptanceLedger } from "./production-acceptance-core.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const exampleMode = args.includes("--examples");
const runMode = args.includes("--run");
const recoveryMode = args.includes("--after-rollback");
const configPath = resolve(root, valueAfter("--config") ?? (exampleMode ? "config-samples/production-acceptance.example.json" : "config/production-acceptance.json"));
const evidencePath = resolve(root, valueAfter("--deployment-evidence") ?? (recoveryMode ? "release-evidence/production/rollback-result.json" : "release-evidence/production/deployment-result.json"));
const ledgerPath = resolve(root, valueAfter("--ledger") ?? (recoveryMode ? "release-evidence/production/rollback-acceptance-ledger.json" : "release-evidence/production/acceptance-ledger.json"));

if (!existsSync(configPath)) fail(`受入設定がありません: ${relative(root, configPath)}`);
if (recoveryMode && (!runMode || exampleMode)) fail("--after-rollbackは実復旧受入の--runと同時指定してください。");
if (!exampleMode && process.platform !== "win32" && (statSync(configPath).mode & 0o077) !== 0) fail("受入設定の権限が広すぎます。chmod 600を実行してください。");
const config = await readJson(configPath, "受入設定");
const packageJson = await readJson(resolve(root, "package.json"), "package.json");
if (packageJson.version !== "5.6.0") fail("package versionは5.6.0が必須です。");
let sourceEvidence = null;
if (recoveryMode) {
  if (!existsSync(evidencePath)) fail(`成功済みrollback証跡がありません: ${relative(root, evidencePath)}`);
  sourceEvidence = await readJson(evidencePath, "rollback証跡");
}
let plan;
try { plan = buildProductionAcceptancePlan(config, { allowPlaceholders: exampleMode, releaseIdOverride: recoveryMode ? sourceEvidence?.knownGoodReleaseId : null }); }
catch (error) { fail(`受入計画が不正です: ${error instanceof Error ? error.message : String(error)}`); }
printPlan(plan);
if (!runMode) {
  console.log("PRODUCTION ACCEPTANCE PREVIEW: PASS / 外部通信なし");
  process.exit(0);
}
if (exampleMode) fail("サンプル設定で実受入検査は実行できません。");
if (Number(process.versions.node.split(".")[0]) !== 22) fail(`実受入検査はNode 22限定です。現在: ${process.versions.node}`);
if (!existsSync(evidencePath)) fail(`デプロイ証跡がありません: ${relative(root, evidencePath)}`);
const deploymentEvidence = sourceEvidence ?? await readJson(evidencePath, "デプロイ証跡");
const executor = async (check) => {
  const result = spawnSync(check.executable, check.args, { cwd: root, encoding: "utf8", shell: false, maxBuffer: 10 * 1024 * 1024 });
  return { code: typeof result.status === "number" ? result.status : 1, stdout: result.stdout ?? "", stderr: result.error ? `${result.stderr ?? ""}\n${result.error.message}` : result.stderr ?? "" };
};
const httpProbe = async (check) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(check.url, { signal: controller.signal, redirect: "manual", headers: { "cache-control": "no-cache", "user-agent": "Lip-Knots-Production-Acceptance/v5.6.0" } });
    clearTimeout(timer);
    return { status: response.status, finalUrl: response.url, headers: Object.fromEntries(response.headers.entries()), body: (await response.text()).slice(0, 20_000) };
  } catch (error) { return { status: 0, finalUrl: check.url, headers: {}, body: error instanceof Error ? error.message : String(error) }; }
};
let report;
try { report = await runProductionAcceptance({ plan, deploymentEvidence, executor, httpProbe, evidenceKind: recoveryMode ? "rollback" : "deployment" }); }
catch (error) { fail(error instanceof Error ? error.message : String(error)); }
const previousLedger = existsSync(ledgerPath) ? await readJson(ledgerPath, "受入台帳") : null;
const ledger = updateAcceptanceLedger(previousLedger, report, plan);
await safeWriteJson(resolve(root, `release-evidence/production/acceptance-run-${report.observedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`), report);
await safeWriteJson(ledgerPath, ledger);
if (ledger.status === "rollback_required") {
  if (recoveryMode) fail(`PRODUCTION RECOVERY ACCEPTANCE: FAILED LOCKED (${ledger.failedCheckKeys.join(", ")})`);
  await safeWriteJson(resolve(root, "release-evidence/production/rollback-trigger.json"), { schemaVersion: 1, releaseId: ledger.releaseId, projectId: ledger.projectId, deploymentPlanFingerprint: ledger.deploymentPlanFingerprint, acceptancePlanFingerprint: ledger.acceptancePlanFingerprint, acceptanceLedgerFingerprint: ledger.fingerprint, failedCheckKeys: ledger.failedCheckKeys, triggeredAt: report.observedAt });
  fail(`PRODUCTION ACCEPTANCE: ROLLBACK REQUIRED (${ledger.failedCheckKeys.join(", ")})`);
}
if (ledger.status === "accepted") console.log(`${recoveryMode ? "PRODUCTION RECOVERY ACCEPTANCE" : "PRODUCTION ACCEPTANCE"}: ACCEPTED ${ledger.validPasses}/${ledger.requiredPasses}`);
else console.log(`${recoveryMode ? "PRODUCTION RECOVERY ACCEPTANCE" : "PRODUCTION ACCEPTANCE"}: OBSERVING ${ledger.validPasses}/${ledger.requiredPasses} / next=${ledger.nextEligibleAt}`);
console.log(`証跡: ${relative(root, ledgerPath)} fingerprint=${ledger.fingerprint}`);

function valueAfter(flag) { const index = args.indexOf(flag); if (index < 0) return null; if (!args[index + 1] || args[index + 1].startsWith("--")) fail(`${flag}の値がありません。`); return args[index + 1]; }
async function readJson(path, label) { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { fail(`${label}が不正です: ${error instanceof Error ? error.message : String(error)}`); } }
async function safeWriteJson(path, value) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.tmp-${process.pid}`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
function printPlan(value) { console.log(`ACCEPTANCE RELEASE: ${value.releaseId}`); console.log(`PROJECT: ${value.projectId}`); console.log(`ACCEPTANCE FINGERPRINT: ${value.fingerprint}`); value.checks.forEach((check, index) => console.log(`${index + 1}. ${check.label}`)); console.log(`${value.requiredPasses}回合格 / ${value.minimumSpacingMinutes}分間隔 / ${value.acceptanceDeadlineMinutes}分以内`); }
function fail(message) { console.error(message); process.exit(1); }
