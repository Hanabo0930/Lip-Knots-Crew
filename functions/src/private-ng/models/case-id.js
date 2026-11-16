"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashText = hashText;
exports.createCaseIdentity = createCaseIdentity;
exports.createJobIdFromPersistedCaseId = createJobIdFromPersistedCaseId;
exports.isValidPersistedCaseId = isValidPersistedCaseId;
const node_crypto_1 = require("node:crypto");
function canonical(value) {
    return value
        .normalize("NFKC")
        .replace(/[\s　]+/g, "")
        .trim()
        .toLowerCase();
}
function hashText(value, length = 24) {
    return (0, node_crypto_1.createHash)("sha256").update(value, "utf8").digest("hex").slice(0, length);
}
/**
 * シートへ案件ID列を書き込めるまでは、案件の比較的安定した情報と同一枠内の順番から
 * 内部IDを生成します。スタッフ名・単価・手当・メーカー・メニューはID材料に含めないため、
 * 手配や金額変更ではIDが変わりません。
 */
function createCaseIdentity(input) {
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
function createJobIdFromPersistedCaseId(companyId, persistedCaseId) {
    return `job_${hashText(`${canonical(companyId)}|${canonical(persistedCaseId)}`, 24)}`;
}
function isValidPersistedCaseId(value) {
    return /^[A-Za-z0-9][A-Za-z0-9_-]{5,80}$/.test(value.trim());
}
//# sourceMappingURL=case-id.js.map