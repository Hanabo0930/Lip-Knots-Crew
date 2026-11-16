'use strict';
// Pure, isolated transition. A transport must commit it atomically with its
// policy read. This is not a source of verified Firebase identities.
const {hash} = require('./case-list-gas-handoff-core.cjs');
const HEX = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9_-]{1,128}$/;
const need = (x, code) => {if (!x) throw Object.assign(new Error(code), {code});};
const clone = x => JSON.parse(JSON.stringify(x));
const SECRET_KEYS = new Set(['authorization', 'idtoken', 'accesstoken', 'refreshtoken', 'bearer', 'credential', 'privatekey', 'jwt']);
function rejectCredentialKeys(value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {for (const item of value) rejectCredentialKeys(item); return;}
  for (const [key, item] of Object.entries(value)) {
    need(!SECRET_KEYS.has(key.replace(/[-_]/g, '').toLowerCase()), 'JOURNAL_CREDENTIAL_FIELD_FORBIDDEN');
    rejectCredentialKeys(item);
  }
}
function validatePolicy(policy, actor) {
  need(actor && ID.test(actor.uid ?? '') && ID.test(actor.companyId ?? ''), 'JOURNAL_IDENTITY_REQUIRED');
  need(policy && policy.companyId === actor.companyId && policy.mode === 'active' && Number.isSafeInteger(policy.epoch) && policy.epoch > 0 &&
    Array.isArray(policy.allowedUids) && policy.allowedUids.includes(actor.uid), 'JOURNAL_POLICY_CLOSED');
}
function validateDeadline(payload) {
  const first = payload?.firstPreparedAt, end = payload?.deadlineAt;
  if (first === undefined && end === undefined) return;
  need(Number.isSafeInteger(first) && Number.isSafeInteger(end) && end - first === 180000, 'JOURNAL_DEADLINE_INVALID');
}
function validateRecord(r, key) {
  if (r === null) return;
  need(r?.schema === 'LK_CREW_ASYNC_JOURNAL_PROPOSAL_V1' && r.key === key && Number.isSafeInteger(r.version) && r.version >= 1 &&
    Number.isSafeInteger(r.lastFence) && r.lastFence >= 1 && r.payload && hash(r.payload) === r.payloadHash &&
    (!r.lease || (ID.test(r.lease.owner ?? '') && Number.isSafeInteger(r.lease.fence) && r.lease.fence === r.lastFence &&
      Number.isSafeInteger(r.lease.epoch) && Number.isSafeInteger(r.lease.expiresAt))), 'JOURNAL_CORRUPT');
  validateDeadline(r.payload);
}
function transition(q, prior, policy, now) {
  need(HEX.test(q?.key ?? '') && Number.isSafeInteger(now) && now > 0, 'JOURNAL_INPUT_INVALID');
  validatePolicy(policy, q.actor); validateRecord(prior, q.key);
  if (q.action === 'read') {
    if (prior) need(prior.payload.actorUid === q.actor.uid && prior.payload.companyId === q.actor.companyId, 'JOURNAL_OWNER_CHANGED');
    if (prior?.lease && prior.lease.expiresAt > now) need(prior.lease.epoch === policy.epoch, 'JOURNAL_POLICY_EPOCH_CHANGED');
    if (q.expectedLease) {
      const l = prior?.lease, e = q.expectedLease;
      need(l && l.owner === e.owner && l.fence === e.fence && l.epoch === e.epoch && prior.version === e.version && policy.epoch === e.epoch,
        'JOURNAL_FENCE_OR_VERSION_CHANGED');
      need(l.expiresAt > now, 'JOURNAL_LEASE_LOST');
    }
    return {write: false, value: prior ? clone(prior) : null};
  }
  need(ID.test(q.owner ?? '') && q.owner.length >= 8, 'JOURNAL_OWNER_INVALID');
  if (q.action === 'acquire') {
    const created = !prior;
    if (created) {
      need(q.initial && q.initial.actorUid === q.actor.uid && q.initial.companyId === q.actor.companyId &&
        (!Object.hasOwn(q.initial, 'key') || q.initial.key === q.key), 'JOURNAL_OWNER_CHANGED');
      validateDeadline(q.initial); rejectCredentialKeys(q.initial);
    } else {
      need(prior.payload.actorUid === q.actor.uid && prior.payload.companyId === q.actor.companyId, 'JOURNAL_OWNER_CHANGED');
      need(!prior.lease || prior.lease.expiresAt <= now, 'JOURNAL_LEASE_ACTIVE');
    }
    const fence = (prior?.lastFence ?? 0) + 1;
    need(Number.isSafeInteger(fence) && Number.isSafeInteger((prior?.version ?? 0) + 1) && Number.isSafeInteger(now + 20000), 'JOURNAL_COUNTER_EXHAUSTED');
    const payload = clone(created ? q.initial : prior.payload);
    const next = {schema: 'LK_CREW_ASYNC_JOURNAL_PROPOSAL_V1', key: q.key, version: (prior?.version ?? 0) + 1,
      payload, payloadHash: hash(payload), lastFence: fence, lease: {owner: q.owner, fence, epoch: policy.epoch, expiresAt: now + 20000}};
    return {write: true, value: next, created};
  }
  need(['save', 'renew', 'release'].includes(q.action) && prior, 'JOURNAL_OPERATION_INVALID');
  const l = prior.lease, cap = q.capability;
  need(prior.payload.actorUid === q.actor.uid && prior.payload.companyId === q.actor.companyId, 'JOURNAL_OWNER_CHANGED');
  need(cap && l && l.owner === q.owner && l.fence === cap.fence && l.epoch === cap.epoch && prior.version === cap.version &&
    policy.epoch === cap.epoch, 'JOURNAL_FENCE_OR_VERSION_CHANGED');
  if (q.action !== 'release') need(l.expiresAt > now, 'JOURNAL_LEASE_LOST');
  need(Number.isSafeInteger(prior.version + 1) && Number.isSafeInteger(now + 20000), 'JOURNAL_COUNTER_EXHAUSTED');
  const next = clone(prior); next.version++;
  if (q.action === 'save') {
    need(q.payload && q.payload.actorUid === prior.payload.actorUid && q.payload.companyId === prior.payload.companyId &&
      (!Object.hasOwn(q.payload, 'key') || q.payload.key === q.key), 'JOURNAL_OWNER_CHANGED');
    validateDeadline(q.payload); rejectCredentialKeys(q.payload);
    if (prior.payload.firstPreparedAt !== undefined) need(q.payload.firstPreparedAt === prior.payload.firstPreparedAt && q.payload.deadlineAt === prior.payload.deadlineAt, 'JOURNAL_DEADLINE_CHANGED');
    next.payload = clone(q.payload); next.payloadHash = hash(next.payload);
  } else if (q.action === 'renew') next.lease.expiresAt = now + 20000;
  else next.lease = null;
  return {write: true, value: next};
}
module.exports = {transition, validateRecord};
