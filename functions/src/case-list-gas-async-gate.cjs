// ISOLATED NODE EXECUTION ONLY: await injected guards and storage; not deployable GAS.
'use strict';
// Unregistered/unadopted proposal. All business I/O and authorization ports are explicit.
const crypto = require('node:crypto');
const { withFreshPrincipal, hash } = require('./case-list-gas-handoff-core.cjs');
const copy = x => JSON.parse(JSON.stringify(x)), need = (v, c) => { if (!v)
    throw Object.assign(Error(c), { code: c }); };
const CASE = /^LKCASE_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i, HEX = /^[a-f0-9]{64}$/;
function createBatchGate(s) {
    need(s.isolatedProposal === true, 'PROPOSAL_DISABLED');
    for (const name of ['readEligible', 'sendReviewed', 'observeMail', 'protectSelection', 'persistContinuation', 'checkProtected', 'prepareAgain', 'complete', 'reconcile', 'observeAccepted', 'currentBoundary', 'operational', 'point', 'groupDigest'])
        need(typeof s[name] === 'function', 'PROPOSAL_PORT_REQUIRED');
    const inFlight = new Set(), auth = (authorization, fn) => withFreshPrincipal(s.auth, authorization, async (actor, fresh) => { need(await s.operational(actor.companyId) === true, 'GLOBAL_STOPPED'); fresh(); return fn(actor, fresh); });
    const scopedAuth = (authorization, r, fn) => auth(authorization, async (actor, fresh) => { need(actor.uid === r.actorUid && actor.companyId === r.companyId, 'OPERATION_OWNER_CHANGED'); return fn(actor, fresh); });
    const authFailure = error => /^(HANDOFF_|AUTHORITY_EXPIRED|OPERATION_OWNER_CHANGED|GLOBAL_STOPPED)/.test(error.code ?? '');
    const deadline = r => need(Number.isSafeInteger(r.firstPreparedAt) && r.deadlineAt - r.firstPreparedAt === 180000 && r.firstPreparedAt <= s.now() && s.now() < r.deadlineAt, 'ORIGINAL_PREPARATION_EXPIRED');
    async function record(key, owner) { const r = await s.journal.read(key); need(r?.lease?.owner === owner && r.lease.expiresAt > s.now(), 'JOURNAL_LEASE_LOST'); return r.payload; }
    async function save(key, r, owner) { await s.journal.save(key, owner, r); need(hash(await record(key, owner)) === hash(r), 'JOURNAL_READBACK_REQUIRED'); return r; }
    async function boundary(key, actor, stage, ids, owner) { let r = await record(key, owner); deadline(r); need(actor.identityExpiresAt > s.now() && s.now() - actor.authorityObservedAt < 30000, 'AUTHORITY_EXPIRED'); need(s.currentBoundary(copy(r), copy(actor), stage, ids) === true, 'CURRENT_BOUNDARY_HOLD'); r = await record(key, owner); deadline(r); need(actor.identityExpiresAt > s.now() && actor.authorityObservedAt <= s.now() && s.now() - actor.authorityObservedAt < 30000, 'AUTHORITY_EXPIRED'); }
    function summary(key, r) { const accepted = r.items.filter(x => x.state === 'ACKED').map(x => x.caseId), pending = r.items.filter(x => x.state !== 'ACKED').map(x => x.caseId); return { key, status: pending.length ? (accepted.length ? 'PARTIAL' : 'HOLD') : 'COMPLETED', acceptedCaseIds: accepted, pendingCaseIds: pending, items: r.items.map(({ caseId, queueId, state, mailState, code }) => ({ caseId, queueId, state, mailState, code })), mailRetried: false }; }
    async function owned(authorization, key, initial, fn) { need(!inFlight.has(key), 'OPERATION_BUSY'); inFlight.add(key); const owner = crypto.randomUUID(); try {
        return await auth(authorization, async (actor) => { const lease = await s.journal.acquire(key, actor, owner, initial); try {
            await fn(actor, lease.created, owner);
            const before = await record(key, owner);
            await scopedAuth(authorization, before, async () => { });
            const after = await record(key, owner);
            need(hash(before) === hash(after), 'RESULT_CHANGED_DURING_AUTH');
            return summary(key, after);
        }
        finally {
            await s.journal.release(key, owner);
        } });
    }
    finally {
        inFlight.delete(key);
    } }
    async function finish(authorization, key, owner) {
        let r = await record(key, owner);
        const items = r.items;
        // Accepted records are observed read-only even after the original business deadline.
        for (const item of items)
            if (item.binding && ['ACKED', 'ACK_UNVERIFIED', 'TRANSFER_UNKNOWN', 'TRANSFER_OBSERVED', 'ACCEPTANCE_UNKNOWN'].includes(item.state)) {
                const wasAccepted = ['ACKED', 'ACK_UNVERIFIED'].includes(item.state);
                try {
                    const out = await scopedAuth(authorization, r, async (actor, fresh) => { const value = await s.observeAccepted(copy(item), copy(r), actor); fresh(); return value; });
                    await scopedAuth(authorization, r, async () => { });
                    if (out?.status === 'EXTERNAL_ALREADY_ACCEPTED' && out.queueId === item.queueId) {
                        item.state = 'ACKED';
                        item.code = '';
                        r = await save(key, r, owner);
                    }
                    else if (wasAccepted) {
                        item.state = 'ACK_UNVERIFIED';
                        item.code = 'ACCEPTED_OBSERVATION_REQUIRED';
                        r = await save(key, r, owner);
                    }
                }
                catch (error) {
                    if (authFailure(error))
                        throw error;
                    if (wasAccepted) {
                        item.state = 'ACK_UNVERIFIED';
                        item.code = 'ACCEPTED_OBSERVATION_REQUIRED';
                        r = await save(key, r, owner);
                    }
                }
            }
        if (r.items.some(x => x.state === 'ACK_UNVERIFIED'))
            return summary(key, r);
        if (r.items.every(x => x.state === 'ACKED'))
            return summary(key, r);
        if (!r.prepared) {
            for (const i of r.items)
                if (i.state !== 'ACKED')
                    i.code = 'NAMEUP_PREPARATION_UNRESOLVED';
            return summary(key, await save(key, r, owner));
        }
        try {
            deadline(r);
        }
        catch {
            for (const i of r.items)
                if (i.state !== 'ACKED')
                    i.code = 'ORIGINAL_PREPARATION_EXPIRED';
            return summary(key, await save(key, r, owner));
        }
        // Observe each durable mail receipt independently. READY/PENDING/SENDING never cause a resend.
        for (const item of r.items)
            if (item.state !== 'ACKED') {
                item.mailState = 'MAIL_OBSERVATION_PENDING';
                delete item.sent;
                try {
                    const observation = await scopedAuth(authorization, r, async (actor, fresh) => { const out = await s.observeMail(copy(item), copy(r), actor); fresh(); return out; });
                    deadline(r);
                    if (observation.state === 'SENT_VERIFIED') {
                        const p = r.prepared.cases.find(x => x.id === item.caseId);
                        need(p && p.nameUpDigest === observation.digest && /^[a-z0-9_-]{1,160}$/i.test(observation.messageId), 'SENT_BINDING_CHANGED');
                        need(r.nameUpReturned === true && r.nameUpReturnedSentIds?.includes(item.caseId), 'SENT_SAVE_RESULT_UNCONFIRMED');
                        item.mailState = 'SENT_VERIFIED';
                        item.sent = observation;
                        item.code = '';
                    }
                    else {
                        need(['MAIL_NOT_PREPARED', 'MAIL_NOT_STARTED', 'MAIL_READY_UNSENT', 'MAIL_SENDING_UNKNOWN', 'MAIL_DRAFT_UNKNOWN'].includes(observation.state), 'MAIL_OBSERVATION_INVALID');
                        item.mailState = observation.state;
                        item.code = observation.state;
                    }
                }
                catch (error) {
                    item.mailState = 'MAIL_OBSERVATION_HOLD';
                    delete item.sent;
                    item.code = error.code ?? 'MAIL_OBSERVATION_HOLD';
                    if (authFailure(error)) {
                        await save(key, r, owner);
                        throw error;
                    }
                }
            }
        r = await save(key, r, owner);
        // Protect all verified-sent original A1/A2 records before any monthly/Source operation.
        for (const item of r.items)
            if (item.state !== 'ACKED' && item.mailState === 'SENT_VERIFIED' && !item.binding) {
                try {
                    deadline(r);
                    item.state = 'PROTECTION_UNKNOWN';
                    r = await save(key, r, owner);
                    s.point('BEFORE_PROTECTION', { key, caseId: item.caseId });
                    const result = await scopedAuth(authorization, r, async (actor, fresh) => { const out = await s.protectSelection(copy(item), copy(r), actor, async () => { await record(key, owner); deadline(r); }); fresh(); deadline(r); return out; });
                    s.point('AFTER_PROTECTION', { key, caseId: item.caseId });
                    const b = result.binding;
                    need(b.caseId === item.caseId && b.queueId === item.queueId && b.companyId === r.companyId && b.selectedBy === r.actorUid && b.gas.nameUpExpected === r.prepared.cases.find(x => x.id === item.caseId)?.expected, 'ORIGINAL_BINDING_CHANGED');
                    item.binding = b;
                    if (result.eligible)
                        item.eligible = result.eligible;
                    item.state = 'PROTECTED';
                    item.code = '';
                    r = await save(key, r, owner);
                }
                catch (error) {
                    item.code = error.code ?? 'PROTECTION_HOLD';
                    r = await save(key, r, owner);
                    if (authFailure(error))
                        throw error;
                }
            }
        let priorTransferHeld = false;
        for (const item of r.items) {
            if (item.state === 'ACKED')
                continue;
            if (priorTransferHeld) {
                item.code = 'WAITING_FOR_PRIOR_TRANSFER';
                r = await save(key, r, owner);
                continue;
            }
            if (!item.binding || item.mailState !== 'SENT_VERIFIED') {
                if (['TRANSFER_UNKNOWN', 'TRANSFER_OBSERVED', 'ACCEPTANCE_UNKNOWN'].includes(item.state))
                    priorTransferHeld = true;
                continue;
            }
            try {
                deadline(r);
                await s.journal.renew(key, owner);
                await scopedAuth(authorization, r, async (actor, fresh) => { await s.persistContinuation(copy(item), copy(r), actor, async () => { await record(key, owner); deadline(r); }); fresh(); deadline(r); const out = await s.checkProtected(copy(item), copy(r), actor, authorization); fresh(); need(out?.status === 'ORIGINAL_AND_SENT_OBSERVED' && out.businessEnabled === false, 'PROTECTED_READBACK_REQUIRED'); });
                if (!['TRANSFER_UNKNOWN', 'TRANSFER_OBSERVED', 'ACCEPTANCE_UNKNOWN'].includes(item.state)) {
                    await scopedAuth(authorization, r, async (actor, fresh) => { deadline(r); const prepared = await s.prepareAgain(copy(item), copy(r), actor); fresh(); deadline(r); const p = prepared.cases?.[0], old = r.prepared.cases.find(x => x.id === item.caseId); need(prepared.cases.length === 1 && p.id === old.id && p.expected === old.expected && p.nameUpDigest === old.nameUpDigest && ['date', 'staff', 'client', 'store'].every(k => p[k] === old[k]), 'REPREPARATION_CHANGED'); need(Date.parse(prepared.preparedAt) >= item.binding.selectedAt && Date.parse(prepared.preparedAt) < r.deadlineAt, 'REPREPARATION_TIME_INVALID'); await boundary(key, actor, 'BEFORE_TRANSFER', [item.caseId], owner); item.state = 'TRANSFER_UNKNOWN'; r = await save(key, r, owner); s.point('BEFORE_COMPLETE', { key, caseId: item.caseId }); const out = await s.complete(prepared, [item.caseId], async (stage) => await boundary(key, actor, stage, [item.caseId], owner)); fresh(); s.point('AFTER_COMPLETE', { key, caseId: item.caseId }); if (out?.completed?.some(x => x.id === item.caseId) && !out.pending?.length)
                        item.state = 'TRANSFER_OBSERVED'; r = await save(key, r, owner); });
                }
                await scopedAuth(authorization, r, async (actor, fresh) => { deadline(r); const known = await s.observeAccepted(copy(item), copy(r), actor); fresh(); if (known?.status === 'EXTERNAL_ALREADY_ACCEPTED' && known.queueId === item.queueId) {
                    item.state = 'ACKED';
                    item.code = '';
                    r = await save(key, r, owner);
                    return;
                } need(known?.status === 'EXTERNAL_ACCEPTANCE_NOT_OBSERVED' && known.queueId === item.queueId, 'ACCEPTANCE_OBSERVATION_REQUIRED'); await boundary(key, actor, 'BEFORE_ACCEPTANCE', [item.caseId], owner); item.state = 'ACCEPTANCE_UNKNOWN'; r = await save(key, r, owner); s.point('BEFORE_ACCEPTANCE', { key, caseId: item.caseId }); const out = await s.reconcile(copy(item), copy(r), actor, async () => { await record(key, owner); deadline(r); }); fresh(); need(['EXTERNAL_READBACK_VERIFIED', 'EXTERNAL_ALREADY_ACCEPTED'].includes(out.status) && out.queueId === item.queueId, 'ACCEPTANCE_PENDING'); s.point('AFTER_ACCEPTANCE', { key, caseId: item.caseId }); item.state = 'ACKED'; item.code = ''; r = await save(key, r, owner); });
            }
            catch (error) {
                item.code = error.code ?? 'TRANSFER_OR_ACCEPTANCE_HOLD';
                r = await save(key, r, owner);
                if (authFailure(error))
                    throw error;
                priorTransferHeld = ['TRANSFER_UNKNOWN', 'TRANSFER_OBSERVED', 'ACCEPTANCE_UNKNOWN'].includes(item.state);
            }
        }
        return summary(key, r);
    }
    async function begin(authorization, review) {
        need(review && Object.keys(review).sort().join('|') === 'confirmedSend|selection|version' && review.confirmedSend === true && HEX.test(review.version) && Array.isArray(review.selection) && review.selection.length >= 1 && review.selection.length <= 5, 'REVIEW_REQUIRED');
        need(review.selection.every(x => CASE.test(x?.id ?? '') && HEX.test(x.version ?? '') && /^20\d\d-\d\d-\d\d$/.test(x.date ?? '')) && new Set(review.selection.map(x => x.id)).size === review.selection.length, 'REVIEW_SELECTION_INVALID');
        const key = hash([review.version, review.selection.map(({ id, version, date }) => [id, version, date])]);
        if (await s.journal.read(key))
            return resume(authorization, key);
        const initial = await auth(authorization, async (actor, fresh) => { const eligible = await s.readEligible(review.selection, actor); fresh(); need(eligible.length === review.selection.length && new Set(eligible.map(e => e.caseId)).size === eligible.length && new Set(eligible.map(e => e.queueId)).size === eligible.length && eligible.every(e => e.queueId && e.companyId === actor.companyId && (e.a1Verified === true || e.manualPrepared === true) && review.selection.some(x => x.id === e.caseId && x.date === e.dateKey)), 'ORIGINAL_OR_MANUAL_PREPARATION_REQUIRED'); return { schema: 'LK_CREW_BATCH_GATE_PROPOSAL_V1', key, phase: 'MAIL_STARTED', nameUpReturned: false, actorUid: actor.uid, companyId: actor.companyId, review: copy(review), items: eligible.map(e => ({ caseId: e.caseId, queueId: e.queueId, eligible: e, state: 'MAIL_NOT_VERIFIED', mailState: 'NOT_OBSERVED', code: '' })) }; });
        return owned(authorization, key, initial, async (actor, created, owner) => {
            if (!created)
                return finish(authorization, key, owner);
            let r = await record(key, owner);
            const callbacks = { prepared: async (prepared, groups) => { need(prepared.actor === actor.email && prepared.cases.length >= 1 && prepared.cases.length <= 5 && new Set(prepared.cases.map(p => p.id)).size === prepared.cases.length && prepared.cases.every(p => r.items.some(i => i.caseId === p.id && i.eligible.dateKey === p.date && i.eligible.staffName === p.staff && i.eligible.client === p.client && i.eligible.store === p.store)), 'PREPARED_ORIGINAL_CHANGED'); const grouped = groups.flatMap(g => g.cases.map(c => c.id)); need(grouped.length === prepared.cases.length && new Set(grouped).size === grouped.length && prepared.cases.every(p => grouped.includes(p.id) && p.nameUpDigest === s.groupDigest(groups.find(g => g.cases.some(c => c.id === p.id)))), 'PREPARED_GROUP_CHANGED'); const first = Date.parse(prepared.preparedAt); need(Number.isSafeInteger(first) && first <= s.now() && s.now() - first < 30000, 'PREPARATION_TIME_INVALID'); r = { ...r, prepared: copy(prepared), groups: copy(groups), firstPreparedAt: first, deadlineAt: first + 180000 }; r = await save(key, r, owner); await boundary(key, actor, 'BEFORE_DRAFT', prepared.cases.map(x => x.id), owner); }, beforeDraft: async (group, stage) => { need(r.groups.some(g => hash(g) === hash(group)), 'DRAFT_GROUP_CHANGED'); need(['BEFORE_DRAFT_RECEIPT', 'BEFORE_GMAIL_DRAFT'].includes(stage), 'DRAFT_STAGE_INVALID'); await boundary(key, actor, stage, group.cases.map(x => x.id), owner); }, beforeSend: async (group) => { need(r.groups.some(g => hash(g) === hash(group)), 'SEND_GROUP_CHANGED'); await boundary(key, actor, 'BEFORE_GMAIL_SEND', group.cases.map(x => x.id), owner); }, sent: async (prepared, ids) => { need(hash(prepared) === hash(r.prepared) && new Set(ids).size === ids.length && ids.every(id => r.items.some(i => i.caseId === id)), 'SENT_SUBSET_INVALID'); r.phase = 'MAIL_OBSERVED'; r = await save(key, r, owner); return { completed: [], pending: ids.map(id => ({ id, reason: 'CREW_BATCH_GATE_PENDING' })) }; } };
            try {
                s.point('BEFORE_NAMEUP', { key });
                const mail = await s.sendReviewed(copy(review), callbacks);
                r = await record(key, owner);
                r.nameUpReturned = true;
                r.nameUpReturnedSentIds = (mail.sent ?? []).flatMap(group => group.ids ?? []);
                r.mailPending = copy(mail.pending ?? []);
                r = await save(key, r, owner);
                s.point('AFTER_NAMEUP', { key });
            }
            catch (error) {
                r = await record(key, owner);
                r.mailError = error.code ?? 'NAMEUP_RESULT_UNKNOWN';
                r = await save(key, r, owner);
            }
            return finish(authorization, key, owner);
        });
    }
    async function resume(authorization, key) { return owned(authorization, key, null, (_actor, _created, owner) => finish(authorization, key, owner)); }
    return Object.freeze({ begin, resume });
}
module.exports = { createBatchGate };
