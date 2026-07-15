import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { buildRollbackManifest, inspectBundleSource } from "./known-good-bundle-core.mjs";

const root = process.cwd(); const args = process.argv.slice(2); const sourceArgument = valueAfter("--source"); const releaseId = valueAfter("--release"); const projectId = valueAfter("--project"); const writeMode = args.includes("--write");
if (!sourceArgument || !releaseId || !projectId) fail("--source・--release・--projectが必須です。");
const sourceRoot = await realpath(resolve(root, sourceArgument)).catch(() => ""); if (!sourceRoot) fail("既知正常ソースがありません。");
let inspection; try { inspection = await inspectBundleSource(sourceRoot, { releaseId, projectId }); } catch (error) { fail(`既知正常ソースを検査できません: ${error instanceof Error ? error.message : String(error)}`); }
if (!inspection.valid) fail(`KNOWN-GOOD BUNDLE: BLOCKED (${inspection.errors.join(" / ")})`);
const manifest = await buildRollbackManifest({ sourceRoot, releaseId, projectId, paths: inspection.paths, firebaseRollback: inspection.firebaseRollback });
console.log(`KNOWN-GOOD RELEASE: ${releaseId}`); console.log(`PROJECT: ${projectId}`); console.log(`FILES: ${inspection.paths.length + 1}`); console.log(`BUNDLE FINGERPRINT: ${manifest.fingerprint}`);
if (!writeMode) { console.log("KNOWN-GOOD BUNDLE PREVIEW: PASS / 保存なし"); process.exit(0); }
const destination = resolve(root, `rollback-sources/${releaseId}`); if (existsSync(destination)) fail(`保存先が既にあります: ${relative(root, destination)}`);
for (const path of inspection.paths) { const target = resolve(destination, path); await mkdir(dirname(target), { recursive: true }); await copyFile(resolve(sourceRoot, path), target); }
await safeWrite(resolve(destination, "firebase.rollback.json"), `${JSON.stringify(inspection.firebaseRollback, null, 2)}\n`); await safeWrite(resolve(destination, "rollback-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`KNOWN-GOOD BUNDLE: WROTE ${relative(root, destination)}`); console.log("Git・配布ZIP対象外です。改ざん防止保管し、rollback requestへ同じpathを指定してください。");

function valueAfter(flag) { const index = args.indexOf(flag); return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : null; }
async function safeWrite(path, content) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.tmp-${process.pid}`; await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
function fail(message) { console.error(message); process.exit(1); }
