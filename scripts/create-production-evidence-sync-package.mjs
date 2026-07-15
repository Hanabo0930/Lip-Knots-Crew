import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { buildProductionEvidenceSyncPackage } from "./production-evidence-sync-core.mjs";

const root = process.cwd(); const args = process.argv.slice(2); const writeMode = args.includes("--write"); const replaceMode = args.includes("--replace");
const evidenceRoot = resolve(root, valueAfter("--evidence-root") ?? "release-evidence/production"); const outputPath = resolve(root, valueAfter("--output") ?? "release-evidence/production/admin-sync-package.json");
const paths = { deploymentResult: "deployment-result.json", acceptanceLedger: "acceptance-ledger.json", rollbackResult: "rollback-result.json", recoveryAcceptanceLedger: "rollback-acceptance-ledger.json" };
if (!existsSync(resolve(evidenceRoot, paths.deploymentResult))) fail(`デプロイ証跡がありません: ${relative(root, resolve(evidenceRoot, paths.deploymentResult))}`);
const evidence = {};
for (const [key, filename] of Object.entries(paths)) { const path = resolve(evidenceRoot, filename); if (existsSync(path)) evidence[key] = await readJson(path, filename); }
let pkg; try { pkg = buildProductionEvidenceSyncPackage(evidence); } catch (error) { fail(`証跡パッケージを作成できません: ${error instanceof Error ? error.message : String(error)}`); }
console.log(`EVIDENCE RELEASE: ${pkg.releaseId}`); console.log(`PROJECT: ${pkg.projectId}`); console.log(`EVIDENCE FILES: ${Object.keys(pkg.evidence).length}`); console.log(`PACKAGE FINGERPRINT: ${pkg.fingerprint}`);
if (!writeMode) { console.log("PRODUCTION EVIDENCE SYNC PREVIEW: PASS / 保存なし"); process.exit(0); }
if (existsSync(outputPath) && !replaceMode) fail(`同期パッケージが既にあります。置換は--replaceを指定してください: ${relative(root, outputPath)}`);
await safeWrite(outputPath, `${JSON.stringify(pkg, null, 2)}\n`); console.log(`PRODUCTION EVIDENCE SYNC: WROTE ${relative(root, outputPath)}`); console.log("管理画面の本番証跡ライブ指揮盤から、このJSONを同期してください。");

function valueAfter(flag) { const index = args.indexOf(flag); if (index < 0) return null; if (!args[index + 1] || args[index + 1].startsWith("--")) fail(`${flag}の値がありません。`); return args[index + 1]; }
async function readJson(path, label) { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { fail(`${label}が不正です: ${error instanceof Error ? error.message : String(error)}`); } }
async function safeWrite(path, content) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.tmp-${process.pid}`; await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
function fail(message) { console.error(message); process.exit(1); }
