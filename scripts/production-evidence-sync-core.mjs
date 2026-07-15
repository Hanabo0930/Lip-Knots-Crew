import { createHash } from "node:crypto";

const allowedKeys = ["deploymentResult", "acceptanceLedger", "rollbackResult", "recoveryAcceptanceLedger"];
const shaPattern = /^[a-f0-9]{64}$/u;

export function sha256(value) { return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex"); }
export function stableJson(value) { return JSON.stringify(stable(value)); }

export function buildProductionEvidenceSyncPackage(evidence, createdAt = new Date().toISOString()) {
  const errors = validateProductionEvidenceInventory(evidence); if (errors.length) throw new Error(errors.join(" / "));
  const deployment = evidence.deploymentResult; const base = { schemaVersion: 1, releaseId: deployment.releaseId, projectId: deployment.projectId, createdAt, evidence };
  return { ...base, fingerprint: sha256(base) };
}

export function validateProductionEvidenceInventory(evidence) {
  const errors = []; const keys = Object.keys(evidence ?? {});
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || !keys.includes("deploymentResult") || keys.some((key) => !allowedKeys.includes(key))) return ["evidenceInventory"];
  const deployment = evidence.deploymentResult;
  if (deployment?.schemaVersion !== 1 || deployment?.releaseId !== "v5.6.0" || deployment?.status !== "succeeded" || !verifyFingerprint(deployment)) errors.push("deploymentResult");
  const acceptance = evidence.acceptanceLedger;
  if (acceptance && (!verifyFingerprint(acceptance) || acceptance.releaseId !== deployment.releaseId || acceptance.projectId !== deployment.projectId || acceptance.deploymentPlanFingerprint !== deployment.planFingerprint)) errors.push("acceptanceLedger");
  const rollback = evidence.rollbackResult;
  if (rollback && (!acceptance || acceptance.status !== "rollback_required" || !verifyFingerprint(rollback) || rollback.releaseId !== deployment.releaseId || rollback.projectId !== deployment.projectId || rollback.acceptanceLedgerFingerprint !== acceptance.fingerprint)) errors.push("rollbackResult");
  const recovery = evidence.recoveryAcceptanceLedger;
  if (recovery && (!rollback || rollback.status !== "rollback_succeeded" || !verifyFingerprint(recovery) || recovery.releaseId !== rollback.knownGoodReleaseId || recovery.projectId !== deployment.projectId || recovery.deploymentPlanFingerprint !== rollback.rollbackPlanFingerprint)) errors.push("recoveryAcceptanceLedger");
  if (containsSecret(evidence)) errors.push("secretDetected");
  return [...new Set(errors)];
}

export function verifyFingerprint(value) { if (!value || typeof value !== "object" || Array.isArray(value) || !shaPattern.test(String(value.fingerprint ?? ""))) return false; const base = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "fingerprint")); return sha256(base) === value.fingerprint; }
function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])); return value; }
function containsSecret(value) { if (typeof value === "string") return /-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]{12,}/iu.test(value); if (Array.isArray(value)) return value.some(containsSecret); if (!value || typeof value !== "object") return false; return Object.entries(value).some(([key, item]) => (/access[_-]?token|refresh[_-]?token|authorization|private[_-]?key|client[_-]?secret/iu.test(key) && String(item ?? "") && String(item) !== "[REDACTED]") || containsSecret(item)); }
