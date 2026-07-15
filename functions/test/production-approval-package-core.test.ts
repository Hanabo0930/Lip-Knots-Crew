import { generateKeyPairSync } from "node:crypto";
import {
  canonicalJson,
  createSignedProductionApprovalPackage,
  inspectSignedProductionApprovalPackage,
  ProductionApprovalPayload,
  SignedProductionApprovalPackage,
} from "../src/production-approval-package-core";
import { evaluateProductionRelease, ProductionReleaseGateInput } from "../src/production-release-core";

function equal(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(message);
}

const pair = generateKeyPairSync("ed25519");
const otherPair = generateKeyPairSync("ed25519");
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
const otherPublicKey = otherPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const now = Date.UTC(2026, 6, 14, 6, 0, 0);
const releaseGateInput: ProductionReleaseGateInput = {
  stagedRolloutStatus: "completed", targetCount: 40, currentWave: 3, deliveredCount: 40,
  criticalAlertCount: 0, monitorFailureCount: 0, inviteFailureCount: 0, lastHealthAction: "continue",
  manual: { backupVerified: true, restoreTestPassed: true, gasHighCriticalZero: true, stagingSmokeGo: true, legalApproved: true, productionSecretsConfigured: true, cloudMonitoringReady: true, domainTlsReady: true, migrationPlanReady: true, rollbackPlanReady: true },
  evidenceRefs: ["backup", "restore", "gas", "smoke", "legal", "monitoring", "rollback"],
};
const releaseFingerprint = evaluateProductionRelease(releaseGateInput).fingerprint;
const payload: ProductionApprovalPayload = {
  packageId: "approval_12345678901234567890", sourceEnvironment: "staging", sourceProjectId: "lkc-staging", targetProjectId: "lkc-production",
  companyId: "lipknots", stagedRolloutId: "rollout-1", releaseId: "v3.4.0", releaseGateInput, releaseFingerprint,
  rehearsalFingerprint: "a".repeat(64), submittedBy: "submitter-uid", executiveApprovedBy: "executive-uid", executiveApprovedEmail: "president@example.com",
  issuedAtMs: now, expiresAtMs: now + 30 * 60 * 1000,
};
const signed = createSignedProductionApprovalPackage(payload, privateKey, "lkc-key-v1");
const options = { publicKeyPem: publicKey, expectedKeyId: "lkc-key-v1", expectedTargetProjectId: "lkc-production", expectedCompanyId: "lipknots", nowMs: now + 1000 };

equal(inspectSignedProductionApprovalPackage(signed, options).eligible, true, "valid signed package was blocked");
equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }), "canonical JSON is not deterministic");
equal(canonicalJson(JSON.parse('{"__proto__":{"admin":true},"a":1}')), '{"__proto__":{"admin":true},"a":1}', "prototype key was not canonicalized safely");
equal(inspectSignedProductionApprovalPackage(signed, { ...options, publicKeyPem: otherPublicKey }).eligible, false, "wrong public key passed");
equal(inspectSignedProductionApprovalPackage({ ...signed, keyId: "wrong-key" }, options).eligible, false, "wrong key id passed");
equal(inspectSignedProductionApprovalPackage({ ...signed, algorithm: "RSA" as "Ed25519" }, options).eligible, false, "wrong algorithm passed");
equal(inspectSignedProductionApprovalPackage({ ...signed, schemaVersion: 2 as 1 }, options).eligible, false, "wrong schema passed");
equal(inspectSignedProductionApprovalPackage({ ...signed, signature: "bad" }, options).eligible, false, "invalid signature passed");
equal(inspectSignedProductionApprovalPackage(signed, { ...options, expectedTargetProjectId: "other-production" }).eligible, false, "wrong target passed");
equal(inspectSignedProductionApprovalPackage(signed, { ...options, expectedCompanyId: "other-company" }).eligible, false, "wrong company passed");
equal(inspectSignedProductionApprovalPackage(signed, { ...options, nowMs: payload.expiresAtMs + 1 }).eligible, false, "expired package passed");

function resign(next: ProductionApprovalPayload): SignedProductionApprovalPackage {
  return createSignedProductionApprovalPackage(next, privateKey, "lkc-key-v1");
}

equal(inspectSignedProductionApprovalPackage(resign({ ...payload, issuedAtMs: now, expiresAtMs: now + 31 * 60 * 1000 }), options).eligible, false, "long TTL passed");
equal(inspectSignedProductionApprovalPackage(resign({ ...payload, issuedAtMs: now + 3 * 60 * 1000, expiresAtMs: now + 20 * 60 * 1000 }), options).eligible, false, "future issue time passed");
equal(inspectSignedProductionApprovalPackage(resign({ ...payload, sourceProjectId: "lkc-production" }), options).eligible, false, "same source and target passed");
equal(inspectSignedProductionApprovalPackage(resign({ ...payload, rehearsalFingerprint: "b".repeat(64) }), options).eligible, true, "valid rehearsal fingerprint was blocked");

let blockedGateRejected = false;
try {
  const blocked = { ...releaseGateInput, criticalAlertCount: 1 };
  createSignedProductionApprovalPackage({ ...payload, releaseGateInput: blocked, releaseFingerprint: evaluateProductionRelease(blocked).fingerprint }, privateKey, "lkc-key-v1");
} catch {
  blockedGateRejected = true;
}
equal(blockedGateRejected, true, "blocked release gate was signed");

const tampered = JSON.parse(JSON.stringify(signed)) as SignedProductionApprovalPackage;
tampered.payload.releaseId = "tampered";
equal(inspectSignedProductionApprovalPackage(tampered, options).eligible, false, "tampered payload passed");
const tamperedGate = JSON.parse(JSON.stringify(signed)) as SignedProductionApprovalPackage;
tamperedGate.payload.releaseGateInput.deliveredCount = 39;
equal(inspectSignedProductionApprovalPackage(tamperedGate, options).eligible, false, "tampered gate passed");
equal(inspectSignedProductionApprovalPackage(null, options).eligible, false, "null package passed");
equal(inspectSignedProductionApprovalPackage({}, options).eligible, false, "empty package passed");
equal(inspectSignedProductionApprovalPackage({ ...signed, payload: { ...signed.payload, packageId: "short" } }, options).eligible, false, "short package id passed");

console.log("production approval package tests passed (21 cases)");
