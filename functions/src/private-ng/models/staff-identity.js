"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeStaffName = normalizeStaffName;
exports.createStaffId = createStaffId;
exports.normalizePhone = normalizePhone;
exports.splitEmails = splitEmails;
exports.isValidEmail = isValidEmail;
const case_id_1 = require("./case-id");
function normalizeStaffName(value) {
    return value
        .normalize("NFKC")
        .replace(/[\s　]+/g, "")
        .trim();
}
function createStaffId(companyId, displayName) {
    const normalizedName = normalizeStaffName(displayName);
    return `staff_${(0, case_id_1.hashText)(`${companyId}|${normalizedName}`, 24)}`;
}
function normalizePhone(value) {
    return value
        .normalize("NFKC")
        .replace(/[^\d+]/g, "")
        .trim();
}
function splitEmails(value) {
    const candidates = value
        .normalize("NFKC")
        .split(/[\s　,，、;；\n\r]+/u)
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean);
    return [...new Set(candidates)];
}
function isValidEmail(value) {
    if (value.length > 254)
        return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}
//# sourceMappingURL=staff-identity.js.map