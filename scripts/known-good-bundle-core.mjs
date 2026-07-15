import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { sha256 } from "./production-deploy-core.mjs";

export const rollbackBundleBasePaths = ["firestore.rules", "firestore.indexes.json", "storage.rules", "functions/package.json"];

export function validateKnownGoodBundleInput({ releaseId, projectId, packageJson, firebaseJson }) {
  const errors = [];
  if (!/^v\d+\.\d+\.\d+$/u.test(String(releaseId ?? ""))) errors.push("releaseId");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(String(projectId ?? ""))) errors.push("projectId");
  if (`v${packageJson?.version}` !== releaseId) errors.push("packageVersion");
  if (firebaseJson?.functions?.source !== "functions") errors.push("functionsSource");
  if (firebaseJson?.firestore?.rules !== "firestore.rules" || firebaseJson?.firestore?.indexes !== "firestore.indexes.json") errors.push("firestoreConfig");
  if (firebaseJson?.storage?.rules !== "storage.rules") errors.push("storageConfig");
  return [...new Set(errors)];
}

export function renderRollbackFirebaseConfig(firebaseJson) {
  return {
    functions: { source: "functions", runtime: firebaseJson?.functions?.runtime ?? "nodejs22" },
    firestore: { rules: "firestore.rules", indexes: "firestore.indexes.json" },
    storage: { rules: "storage.rules" },
  };
}

export async function collectKnownGoodBundleFiles(sourceRoot) {
  const files = [...rollbackBundleBasePaths];
  const libRoot = resolve(sourceRoot, "functions/lib");
  files.push(...await collect(libRoot, sourceRoot));
  return [...new Set(files)].sort();
}

async function collect(directory, sourceRoot) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (!absolute.startsWith(`${resolve(sourceRoot)}${sep}`)) throw new Error("source path escape");
    if (entry.isSymbolicLink()) throw new Error(`symlink is not allowed: ${entry.name}`);
    if (entry.isDirectory()) output.push(...await collect(absolute, sourceRoot));
    else if (entry.isFile()) output.push(absolute.slice(resolve(sourceRoot).length + 1).split(sep).join("/"));
  }
  return output;
}

export async function inspectBundleSource(sourceRoot, { releaseId, projectId }) {
  const packageJson = JSON.parse(await readFile(resolve(sourceRoot, "package.json"), "utf8"));
  const firebaseJson = JSON.parse(await readFile(resolve(sourceRoot, "firebase.json"), "utf8"));
  const errors = validateKnownGoodBundleInput({ releaseId, projectId, packageJson, firebaseJson });
  const paths = errors.length ? [] : await collectKnownGoodBundleFiles(sourceRoot);
  if (!paths.includes("functions/lib/index.js")) errors.push("functionsBuild");
  for (const path of paths) { const info = await lstat(resolve(sourceRoot, path)); if (!info.isFile() || info.isSymbolicLink()) errors.push(`${path}:type`); }
  return { valid: errors.length === 0, errors: [...new Set(errors)], releaseId, projectId, sourceVersion: packageJson?.version ?? "", firebaseRollback: renderRollbackFirebaseConfig(firebaseJson), paths };
}

export async function buildRollbackManifest({ sourceRoot, releaseId, projectId, paths, firebaseRollback }) {
  const files = {};
  files["firebase.rollback.json"] = hashBytes(`${JSON.stringify(firebaseRollback, null, 2)}\n`);
  for (const path of paths) files[path] = hashBytes(await readFile(resolve(sourceRoot, path)));
  const manifest = { schemaVersion: 1, releaseId, projectId, createdAt: new Date().toISOString(), files };
  const canonical = { schemaVersion: 1, releaseId, projectId, files };
  return { ...manifest, fingerprint: sha256(canonical) };
}

function hashBytes(value) { return createHash("sha256").update(value).digest("hex"); }
