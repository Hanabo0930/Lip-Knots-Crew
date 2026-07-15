import { createHash } from "node:crypto";

export type CaseIdentityInput = {
  companyId: string;
  spreadsheetId: string;
  sheetName: string;
  dateKey: string;
  clientName: string;
  storeName: string;
  workTime: string;
  occurrence: number;
};

function canonical(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .trim()
    .toLowerCase();
}

export function hashText(value: string, length = 24): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

/**
 * シートへ案件ID列を書き込めるまでは、案件の比較的安定した情報と同一枠内の順番から
 * 内部IDを生成します。スタッフ名・単価・手当・メーカー・メニューはID材料に含めないため、
 * 手配や金額変更ではIDが変わりません。
 */
export function createCaseIdentity(input: CaseIdentityInput): {
  jobId: string;
  caseId: string;
  sourceIdentityKey: string;
  identityFingerprint: string;
} {
  const identityFingerprint = [
    canonical(input.dateKey),
    canonical(input.clientName),
    canonical(input.storeName),
    canonical(input.workTime),
  ].join("|");

  const sourceIdentityKey = [
    canonical(input.companyId),
    input.spreadsheetId,
    canonical(input.sheetName),
    identityFingerprint,
    String(input.occurrence),
  ].join("|");

  const hash = hashText(sourceIdentityKey, 24);
  const ymd = input.dateKey.replace(/-/g, "");

  return {
    jobId: `job_${hash}`,
    caseId: `LKC-${ymd}-${hash.slice(0, 10).toUpperCase()}`,
    sourceIdentityKey,
    identityFingerprint,
  };
}

export function createJobIdFromPersistedCaseId(
  companyId: string,
  persistedCaseId: string
): string {
  return `job_${hashText(`${canonical(companyId)}|${canonical(persistedCaseId)}`, 24)}`;
}

export function isValidPersistedCaseId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{5,80}$/.test(value.trim());
}
