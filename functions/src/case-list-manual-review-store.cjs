'use strict';
// Private transaction-port proposal only. No SDK initialization, network, route,
// live data or credentials. The caller must independently verify current auth,
// displayed values and the authoritative source; this is a concurrency guard.
const crypto = require('node:crypto');
const {hash} = require('./case-list-gas-handoff-core.cjs');
const {missingFormalManualFields} = require('./case-list-manual-confirmation.cjs');
const need = (ok, code) => {if (!ok) throw Object.assign(new Error(code), {code});};
const clone = x => JSON.parse(JSON.stringify(x));
const ID = /^[A-Za-z0-9_-]{1,128}$/, REVIEW = /^[a-f0-9]{48}$/, HEX = /^[a-f0-9]{64}$/;
const CASE = /^LKCASE_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
// Deliberately separate, synthetic-only namespaces: never point a guard at an
// existing A1/monthly operation or use this proposal to pre-create one.
const REVIEW_NAMESPACE = 'lkcSyntheticReviewViewsV1', GUARD_NAMESPACE = 'lkcSyntheticReviewCaseGuardsV1';
const caseKey = (companyId, id) => crypto.createHash('sha256').update(JSON.stringify(['LK_REVIEW_CASE_GUARD_V1', companyId, id.toLowerCase()])).digest('hex');
const fenceHash = token => crypto.createHash('sha256').update(token).digest('hex');

function validateBody(body) {
  need(['LK_CREW_MANUAL_SEND_VIEW_PROPOSAL_V1','LK_CREW_OWNER_SEND_VIEW_V1'].includes(body?.schema) && ID.test(body.actorUid ?? '') && ID.test(body.companyId ?? '') &&
    Array.isArray(body.cases) && body.cases.length >= 1 && body.cases.length <= 5, 'REVIEW_BODY_INVALID');
  const ids = body.cases.map(v => v?.caseId?.toLowerCase());
  need(body.cases.every(v => CASE.test(v?.caseId ?? '') && v.companyId === body.companyId && v.actorUid === body.actorUid && v.approvalCreated === false && v.confirmedFields === null && v.input && v.display) &&
    new Set(ids).size === ids.length, 'REVIEW_CASES_INVALID');
  if(body.schema==='LK_CREW_OWNER_SEND_VIEW_V1')need(body.cases.every(v=>['SOURCE_MANUAL','CREW_APPLICATION'].includes(v.origin)),'REVIEW_CASE_ORIGIN_REQUIRED');
  const mail = body.mail?.review, selection = mail?.selection;
  need((mail?.confirmedSend === undefined || mail.confirmedSend === false) && HEX.test(mail?.version ?? '') && Array.isArray(selection) && selection.length === ids.length &&
    new Set(selection.map(x => x?.id?.toLowerCase())).size === ids.length &&
    selection.every(x => {const v = body.cases.find(y => y.caseId.toLowerCase() === x?.id?.toLowerCase()); return v && x.date === v.display.date;}), 'REVIEW_MAIL_CASES_CHANGED');
  return ids;
}
function validateFormal(body, update) {
  need(update?.state === 'DISPATCHING' && update.actorUid === body.actorUid && update.companyId === body.companyId &&
    Array.isArray(update.formal) && update.formal.length === body.cases.length, 'FORMAL_BINDING_INVALID');
  const ids = update.formal.map(x => x?.caseId?.toLowerCase());
  need(new Set(ids).size === ids.length, 'FORMAL_BINDING_INVALID');
  for (const view of body.cases) {
    const f = update.formal.find(x => x?.caseId?.toLowerCase() === view.caseId.toLowerCase());
    need(f && f.actorUid === body.actorUid && f.companyId === body.companyId && f.displayHash === update.displayHash &&
      f.confirmationIntent === 'CONFIRM_DISPLAYED_AND_SEND' && f.input?.clientNameUpConfirmed === false &&
      missingFormalManualFields(f.input?.manualConfirmation).length === 0, 'FORMAL_BINDING_INVALID');
    const baseInput = {...f.input}; delete baseInput.clientNameUpConfirmed; delete baseInput.manualConfirmation;
    need(hash(baseInput) === hash(view.input) && f.input.manualConfirmation.payOffer.dailyWageJPY === view.display.dailyWageJPY, 'FORMAL_BINDING_INVALID');
  }
}

// Same public create/read/claim/finish shape as the isolated formal core.
// `runTransaction` must atomically read/write all refs and retry on conflict.
// No side effects or random generation occur inside its retriable callback.
function createReviewStorePort({isolatedProposal, runTransaction, reviewRef, guardRef, now, viewMaxAgeMs}) {
  need(isolatedProposal === true && typeof runTransaction === 'function' && typeof reviewRef === 'function' && typeof guardRef === 'function' &&
    typeof now === 'function' && Number.isSafeInteger(viewMaxAgeMs) && viewMaxAgeMs > 0, 'REVIEW_STORE_CONFIG_REQUIRED');
  const issued = new Map();
  const review = id => {need(REVIEW.test(id ?? ''), 'REVIEW_ID_INVALID'); const ref = reviewRef(id); need(ref?.id === id && ref.path === REVIEW_NAMESPACE + '/' + id, 'REVIEW_REF_MISMATCH'); return ref;};
  const guard = key => {const ref = guardRef(key); need(ref?.id === key && ref.path === GUARD_NAMESPACE + '/' + key, 'GUARD_REF_MISMATCH'); return ref;};
  const caseKeys = body => validateBody(body).map(id => caseKey(body.companyId, id)).sort();
  return Object.freeze({
    async create(id, value) {
      const ref = review(id); validateBody(value?.body);
      need(value.state === 'VIEW_ONLY' && value.result === null && Number.isSafeInteger(value.createdAt) && HEX.test(value.displayHash ?? '') && hash(value.body) === value.displayHash, 'REVIEW_CREATE_INVALID');
      await runTransaction(async tx => {const snap = await tx.get(ref); need(!snap.exists, 'REVIEW_ID_COLLISION'); tx.set(ref, clone(value));});
    },
    async read(id) {
      const ref = review(id); return runTransaction(async tx => {const snap = await tx.get(ref); if (!snap.exists) return null; const value = clone(snap.data()); delete value.claimFenceHash; return value;}, {readOnly: true});
    },
    async claim(id, update) {
      const ref = review(id), token = crypto.randomBytes(32).toString('hex'), fingerprint = fenceHash(token);
      const accepted = await runTransaction(async tx => {
        const snap = await tx.get(ref); if (!snap.exists) return false; const value = snap.data();
        if (value.state !== 'VIEW_ONLY' || value.body?.actorUid !== update?.actorUid || value.body?.companyId !== update?.companyId || value.displayHash !== update?.displayHash) return false;
        need(HEX.test(value.displayHash ?? '') && hash(value.body) === value.displayHash, 'REVIEW_CHANGED');
        const keys = caseKeys(value.body); validateFormal(value.body, update);
        const checkTime = () => {const at = now(); need(Number.isSafeInteger(at) && Number.isSafeInteger(update.at) && Number.isSafeInteger(value.createdAt) &&
          at >= value.createdAt && at - value.createdAt < viewMaxAgeMs && update.at >= value.createdAt && update.at <= at && at - update.at < 30000, 'REVIEW_VIEW_EXPIRED');};
        checkTime();
        const refs = keys.map(guard), existing = await Promise.all(refs.map(r => tx.get(r)));
        if (existing.some(s => s.exists)) return false;
        checkTime();
        // Distinct child guards, never an A1/parent operation record.
        for (const g of refs) tx.set(g, {schema: 'LK_REVIEW_CASE_GUARD_V1', reviewId: id, fenceHash: fingerprint, state: 'DISPATCHING'});
        tx.set(ref, {...clone(value), ...clone(update), claimFenceHash: fingerprint});
        return true;
      });
      if (accepted) issued.set(id, {token, fingerprint});
      return accepted;
    },
    async finish(id, state, result) {
      const ref = review(id), permit = issued.get(id);
      need(permit && ['RESULT_OBSERVED', 'RESULT_UNKNOWN'].includes(state) && (state === 'RESULT_UNKNOWN' ? result === null : result && typeof result === 'object' && !Array.isArray(result)), 'REVIEW_FINISH_FENCE_REQUIRED');
      await runTransaction(async tx => {
        const snap = await tx.get(ref); need(snap.exists, 'REVIEW_STATE_CHANGED'); const value = snap.data();
        need(value.state === 'DISPATCHING' && value.claimFenceHash === permit.fingerprint && hash(value.body) === value.displayHash, 'REVIEW_STATE_CHANGED');
        const refs = caseKeys(value.body).map(guard), current = await Promise.all(refs.map(r => tx.get(r)));
        need(current.every(s => s.exists && s.data().reviewId === id && s.data().fenceHash === permit.fingerprint && s.data().state === 'DISPATCHING'), 'REVIEW_FINISH_FENCE_CHANGED');
        for (const g of refs) tx.set(g, {schema: 'LK_REVIEW_CASE_GUARD_V1', reviewId: id, fenceHash: permit.fingerprint, state});
        tx.set(ref, {...value, state, result: clone(result)});
      });
      issued.delete(id);
    },
  });
}
module.exports = {createReviewStorePort, caseKey, REVIEW_NAMESPACE, GUARD_NAMESPACE};
