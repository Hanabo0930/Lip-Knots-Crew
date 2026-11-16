"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.splitNgCompanies = splitNgCompanies;
exports.observeStaffNgCell = observeStaffNgCell;
exports.mergeStaffNg = mergeStaffNg;
exports.staffNgRevision = staffNgRevision;
exports.checkStaffNg = checkStaffNg;
exports.makeStaffApplicationCheck = makeStaffApplicationCheck;
exports.assertStaffApplicationCheck = assertStaffApplicationCheck;
exports.staffReservationNotificationCurrent = staffReservationNotificationCurrent;
const node_crypto_1 = require("node:crypto");
const HEX = /^[a-f0-9]{64}$/, MASTER = 'マスターデータ';
function canonical(x) { if (x === null || ['string', 'boolean', 'number'].includes(typeof x))
    return JSON.stringify(x); if (Array.isArray(x))
    return '[' + x.map(canonical).join(',') + ']'; return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}'; }
const hash = (x) => (0, node_crypto_1.createHash)('sha256').update(canonical(x)).digest('hex');
function need(ok, code) { if (!ok)
    throw Object.assign(Error(code), { code }); }
// Only the documented delimiters are interpreted. No unverified NFKC,
// case-folding, fullwidth conversion, or free-text inference is performed.
function splitNgCompanies(value) { return [...new Set(value.split(/[ \u3000、,\/\r\n\t]+/u).map(s => s.trim()).filter(Boolean))].sort(); }
function observeStaffNgCell(sheetName, header, row, rangeEndIndex) {
    const raw = row[10], present = sheetName === MASTER && rangeEndIndex >= 10 && typeof header[10] === 'string' && header[10].trim() === 'NG会社';
    const text = raw == null ? '' : typeof raw === 'string' ? raw : null;
    const valid = present && text !== null && !/^#(?:N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!|ERROR!)$/u.test(text.trim());
    return { state: valid ? 'OBSERVED' : 'UNVERIFIED', keywords: valid ? splitNgCompanies(text) : [], cellHash: hash([present, text]) };
}
function body(ng) { return [ng.schema, ng.companyId, ng.staffId, ng.authority, ng.state, ng.keywords, ng.sourceHash]; }
function mergeStaffNg(rows, companyId, staffId) {
    const masters = rows.filter(r => r.sourceRef.sheetName === MASTER), known = masters.length > 0 && masters.every(r => r.ngCompanyObservation?.state === 'OBSERVED');
    const sets = masters.map(r => JSON.stringify(r.ngCompanyObservation?.keywords ?? []));
    const state = !known ? 'UNVERIFIED' : new Set(sets).size !== 1 ? 'CONFLICT' : 'OBSERVED';
    const keywords = state === 'OBSERVED' ? masters[0].ngCompanyObservation.keywords : [];
    // Row hints do not change eligibility when the same staff master is sorted.
    const sourceHash = hash(masters.map(r => [r.sourceRef.spreadsheetId, MASTER, 'K', r.ngCompanyObservation?.cellHash ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    const value = { schema: 'LK_STAFF_NG_V1', companyId, staffId, authority: 'MASTER_K', state, keywords, sourceHash };
    return { ...value, revision: hash(body(value)) };
}
function staffNgRevision(staff, companyId, staffId) {
    const ng = staff.ngCompanies;
    need(staff.sourceMissing !== true && ng?.schema === 'LK_STAFF_NG_V1' && ng.companyId === companyId && ng.staffId === staffId && ng.authority === 'MASTER_K' && ng.state === 'OBSERVED' && Array.isArray(ng.keywords) && ng.keywords.every(k => typeof k === 'string' && k.length > 0) && JSON.stringify(ng.keywords) === JSON.stringify(splitNgCompanies(ng.keywords.join(' '))) && HEX.test(ng.sourceHash) && HEX.test(ng.revision) && hash(body(ng)) === ng.revision, 'STAFF_NG_UNVERIFIED');
    return ng.revision;
}
function checkStaffNg(staff, job, companyId, staffId) {
    const ngRevision = staffNgRevision(staff, companyId, staffId), keys = ['clientName', 'storeName', 'makerName'];
    const values = keys.map(k => typeof job[k] === 'string' ? job[k] : null), keywords = staff.ngCompanies.keywords;
    if (keywords.length)
        need(values.every(v => typeof v === 'string'), 'STAFF_NG_TARGET_UNVERIFIED');
    for (let i = 0; i < keys.length; i++)
        if (keywords.some(k => values[i]?.includes(k)))
            throw Object.assign(Error('STAFF_NG_MATCH'), { code: 'STAFF_NG_MATCH', target: keys[i] });
    return { ngRevision, targetsHash: hash(values) };
}
function makeStaffApplicationCheck(staff, job, input) {
    const checks = checkStaffNg(staff, job, input.companyId, input.staffId), value = { schema: 'LK_STAFF_APPLICATION_CHECK_V1', ...input, ...checks };
    return { ...value, hash: hash(value) };
}
function assertStaffApplicationCheck(queue, job, staff, queueId) {
    const q = queue.staffApplicationCheck, j = job.staffApplicationCheck;
    if (q === undefined && j === undefined)
        return null; // Older assignments retain their business workflow, without new reservation proof.
    need(q && j && hash(q) === hash(j), 'STAFF_APPLICATION_CHECK_CHANGED');
    const { hash: checksum, ...value } = q;
    need(q.schema === 'LK_STAFF_APPLICATION_CHECK_V1' && checksum === hash(value) && q.companyId === queue.companyId && q.companyId === job.companyId && q.staffId === queue.actorStaffId && q.staffId === job.assignedStaffId && q.uid === queue.actorUid && q.uid === job.assignedUid && q.jobId === queue.jobId && q.dateKey === queue.dateKey && q.dateKey === job.dateKey && q.assignedRevision === job.revision && job.assignmentSheetWrite?.queueId === queueId, 'STAFF_APPLICATION_CHECK_CHANGED');
    const current = checkStaffNg(staff, job, q.companyId, q.staffId);
    need(current.ngRevision === q.ngRevision && current.targetsHash === q.targetsHash, 'STAFF_APPLICATION_CHECK_CHANGED');
    return q;
}
// Delivery must still refer to this assignment and this verified reservation.
function staffReservationNotificationCurrent(data, job) {
    const info = data.data, r = job?.staffReservation, a = job?.staffApplicationCheck;
    return !!job && data.category === 'staff_reservation_confirmed' && typeof info?.jobId === 'string' && !info.jobId.includes('/') && HEX.test(info.staffReservationProofHash ?? '') && data.route === '/shifts/' + info.jobId && data.targetRole === undefined && data.targetUid === undefined && data.targetStaffId === job.assignedStaffId && data.companyId === job.companyId && job.status === 'assigned' && job.cancelled !== true && job.sourceMissing !== true && job.assignmentUnresolved !== true && job.mailIntakeReviewRequired !== true && job.pendingSourceWrite !== true && job.adminEditSheetWrite?.pending !== true && r?.schema === 'LK_STAFF_RESERVATION_V1' && r.state === 'CONFIRMED' && r.jobId === info.jobId && r.companyId === data.companyId && r.staffId === job.assignedStaffId && typeof job.assignedUid === 'string' && r.uid === job.assignedUid && r.dateKey === job.dateKey && r.assignedRevision === job.revision && r.queueId === job.assignmentSheetWrite?.queueId && HEX.test(r.sourceRevision ?? '') && r.sourceProofHash === info.staffReservationProofHash && HEX.test(r.applicationCheckHash ?? '') && r.applicationCheckHash === a?.hash && HEX.test(r.ngRevision ?? '') && r.ngRevision === a?.ngRevision;
}
//# sourceMappingURL=staff-ng.js.map