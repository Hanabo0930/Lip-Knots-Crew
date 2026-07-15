import {
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import {
  evaluateProductionRelease,
  ProductionReleaseGateInput,
} from "./production-release-core";

export const PRODUCTION_APPROVAL_SCHEMA_VERSION = 1 as const;
export const PRODUCTION_APPROVAL_ALGORITHM = "Ed25519" as const;
export const PRODUCTION_APPROVAL_MAX_TTL_MS = 30 * 60 * 1000;
export const PRODUCTION_APPROVAL_CLOCK_SKEW_MS = 2 * 60 * 1000;

export type ProductionApprovalPayload = {
  packageId: string;
  sourceEnvironment: "staging";
  sourceProjectId: string;
  targetProjectId: string;
  companyId: string;
  stagedRolloutId: string;
  releaseId: string;
  releaseGateInput: ProductionReleaseGateInput;
  releaseFingerprint: string;
  rehearsalFingerprint: string;
  submittedBy: string;
  executiveApprovedBy: string;
  executiveApprovedEmail: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

export type SignedProductionApprovalPackage = {
  schemaVersion: typeof PRODUCTION_APPROVAL_SCHEMA_VERSION;
  algorithm: typeof PRODUCTION_APPROVAL_ALGORITHM;
  keyId: string;
  payload: ProductionApprovalPayload;
  signature: string;
};

export type ApprovalPackageCheck = {
  key: string;
  label: string;
  passed: boolean;
  actual: string | number | boolean;
  required: string;
};

export type ApprovalPackageInspection = {
  eligible: boolean;
  checks: ApprovalPackageCheck[];
  blockers: ApprovalPackageCheck[];
  payloadFingerprint: string;
  releaseFingerprint: string;
};

export type ApprovalPackageInspectionOptions = {
  publicKeyPem: string;
  expectedKeyId: string;
  expectedTargetProjectId: string;
  expectedCompanyId: string;
  nowMs: number;
  maxTtlMs?: number;
  clockSkewMs?: number;
};

export function createSignedProductionApprovalPackage(
  payload: ProductionApprovalPayload,
  privateKeyPem: string,
  keyId: string
): SignedProductionApprovalPackage {
  assertPayloadShape(payload);
  if (!keyId.trim()) throw new Error("approval package key id is required");
  const gate = evaluateProductionRelease(payload.releaseGateInput);
  if (!gate.eligible || gate.fingerprint !== payload.releaseFingerprint) {
    throw new Error("approval package release gate is not eligible");
  }
  const signature = cryptoSign(null, Buffer.from(canonicalJson(payload)), privateKeyPem).toString("base64");
  return {
    schemaVersion: PRODUCTION_APPROVAL_SCHEMA_VERSION,
    algorithm: PRODUCTION_APPROVAL_ALGORITHM,
    keyId: keyId.trim(),
    payload,
    signature,
  };
}

export function inspectSignedProductionApprovalPackage(
  input: unknown,
  options: ApprovalPackageInspectionOptions
): ApprovalPackageInspection {
  const candidate = asCandidate(input);
  const payload = candidate?.payload;
  const maxTtlMs = options.maxTtlMs ?? PRODUCTION_APPROVAL_MAX_TTL_MS;
  const clockSkewMs = options.clockSkewMs ?? PRODUCTION_APPROVAL_CLOCK_SKEW_MS;
  let gateEligible = false;
  let recalculatedFingerprint = "";
  if (payload) {
    try {
      assertPayloadShape(payload);
      const gate = evaluateProductionRelease(payload.releaseGateInput);
      gateEligible = gate.eligible;
      recalculatedFingerprint = gate.fingerprint;
    } catch {
      gateEligible = false;
    }
  }
  const signatureValid = Boolean(candidate && payload && verifySignature(candidate, options.publicKeyPem));
  const ttl = payload ? payload.expiresAtMs - payload.issuedAtMs : -1;
  const checks: ApprovalPackageCheck[] = [
    check("schema", "署名形式", candidate?.schemaVersion === PRODUCTION_APPROVAL_SCHEMA_VERSION, "schemaVersion 1", candidate?.schemaVersion ?? "missing"),
    check("algorithm", "署名アルゴリズム", candidate?.algorithm === PRODUCTION_APPROVAL_ALGORITHM, "Ed25519", candidate?.algorithm ?? "missing"),
    check("key_id", "署名鍵ID", candidate?.keyId === options.expectedKeyId, options.expectedKeyId, candidate?.keyId ?? "missing"),
    check("signature", "電子署名", signatureValid, "VALID", signatureValid ? "VALID" : "INVALID"),
    check("package_id", "パッケージID", Boolean(payload && /^[A-Za-z0-9_-]{20,160}$/u.test(payload.packageId)), "20〜160文字", payload?.packageId ?? "missing"),
    check("source_environment", "発行元環境", payload?.sourceEnvironment === "staging", "staging", payload?.sourceEnvironment ?? "missing"),
    check("project_isolation", "Project分離", Boolean(payload && payload.sourceProjectId !== payload.targetProjectId), "source≠target", payload ? `${payload.sourceProjectId}→${payload.targetProjectId}` : "missing"),
    check("target_project", "対象production Project", payload?.targetProjectId === options.expectedTargetProjectId, options.expectedTargetProjectId, payload?.targetProjectId ?? "missing"),
    check("company", "企業境界", payload?.companyId === options.expectedCompanyId, options.expectedCompanyId, payload?.companyId ?? "missing"),
    check("release_gate", "本番公開ゲート", gateEligible, "ELIGIBLE", gateEligible ? "ELIGIBLE" : "BLOCKED"),
    check("release_fingerprint", "公開判定fingerprint", Boolean(payload && /^[a-f0-9]{64}$/u.test(payload.releaseFingerprint) && payload.releaseFingerprint === recalculatedFingerprint), "再計算一致", payload?.releaseFingerprint ?? "missing"),
    check("rehearsal_fingerprint", "復元演習fingerprint", Boolean(payload && /^[a-f0-9]{64}$/u.test(payload.rehearsalFingerprint)), "SHA-256", payload?.rehearsalFingerprint ?? "missing"),
    check("identity", "承認者識別", Boolean(payload && payload.submittedBy && payload.executiveApprovedBy && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(payload.executiveApprovedEmail)), "提出者・承認者・メール", payload?.executiveApprovedEmail ?? "missing"),
    check("issued_at", "発行時刻", Boolean(payload && Number.isSafeInteger(payload.issuedAtMs) && payload.issuedAtMs <= options.nowMs + clockSkewMs), "未来時刻でない", payload?.issuedAtMs ?? -1),
    check("ttl", "有効期間", ttl > 0 && ttl <= maxTtlMs, `1〜${Math.floor(maxTtlMs / 60000)}分`, ttl),
    check("not_expired", "有効期限", Boolean(payload && payload.expiresAtMs >= options.nowMs), "期限内", payload?.expiresAtMs ?? -1),
  ];
  const blockers = checks.filter((item) => !item.passed);
  return {
    eligible: blockers.length === 0,
    checks,
    blockers,
    payloadFingerprint: payload ? sha256(canonicalJson(payload)) : "",
    releaseFingerprint: payload?.releaseFingerprint ?? "",
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function verifySignature(candidate: SignedProductionApprovalPackage, publicKeyPem: string): boolean {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(candidate.signature)) return false;
    const signature = Buffer.from(candidate.signature, "base64");
    if (signature.length !== 64) return false;
    return cryptoVerify(null, Buffer.from(canonicalJson(candidate.payload)), publicKeyPem, signature);
  } catch {
    return false;
  }
}

function asCandidate(input: unknown): SignedProductionApprovalPackage | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Partial<SignedProductionApprovalPackage>;
  if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) return null;
  return value as SignedProductionApprovalPackage;
}

function assertPayloadShape(payload: ProductionApprovalPayload): void {
  const ids = [
    payload.packageId,
    payload.sourceProjectId,
    payload.targetProjectId,
    payload.companyId,
    payload.stagedRolloutId,
    payload.releaseId,
    payload.submittedBy,
    payload.executiveApprovedBy,
    payload.executiveApprovedEmail,
  ];
  if (payload.sourceEnvironment !== "staging" || ids.some((value) => typeof value !== "string" || !value.trim() || value.length > 320)) {
    throw new Error("approval package payload identity is invalid");
  }
  if (!Number.isSafeInteger(payload.issuedAtMs) || !Number.isSafeInteger(payload.expiresAtMs)) {
    throw new Error("approval package timestamps are invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(payload.releaseFingerprint) || !/^[a-f0-9]{64}$/u.test(payload.rehearsalFingerprint)) {
    throw new Error("approval package fingerprints are invalid");
  }
  canonicalJson(payload);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON cannot contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) throw new Error("canonical JSON cannot contain undefined");
      output[key] = canonicalize(source[key]);
    }
    return output;
  }
  throw new Error("canonical JSON contains an unsupported value");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function check(
  key: string,
  label: string,
  passed: boolean,
  required: string,
  actual: string | number | boolean
): ApprovalPackageCheck {
  return { key, label, passed, required, actual };
}
