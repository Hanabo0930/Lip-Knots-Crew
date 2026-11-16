'use strict';
// Async old-journal-shaped private proposal. No SDK, credentials or route.
// Every owned() invocation MUST supply a fresh unpredictable owner nonce.
const {hash} = require('./case-list-gas-handoff-core.cjs');
const need = (x, code) => {if (!x) throw Object.assign(new Error(code), {code});};
const same = (a, b) => a?.uid === b?.uid && a?.companyId === b?.companyId;
function createAsyncJournal({transport, getCurrentActor}) {
  need(transport && typeof transport.execute === 'function' && typeof getCurrentActor === 'function', 'JOURNAL_PORT_REQUIRED');
  const capabilities = new Map(), usedOwners = new Set();
  const identity = async () => {const a = await getCurrentActor(); need(a && typeof a.uid === 'string' && typeof a.companyId === 'string', 'JOURNAL_IDENTITY_REQUIRED'); return {uid: a.uid, companyId: a.companyId};};
  const checkIdentity = async a => {need(same(a, await identity()), 'JOURNAL_IDENTITY_CHANGED');};
  const keyFor = (key, owner) => key + '\u0000' + owner;
  async function mutation(request, actor) {
    const changed = await transport.execute({...request, actor});
    await checkIdentity(actor);
    need(changed?.value, 'JOURNAL_READBACK_CHANGED');
    const l = changed.value.lease;
    const expectedLease = request.action === 'release' ? undefined : {owner: l?.owner, fence: l?.fence, epoch: l?.epoch, version: changed.value.version};
    const readback = await transport.execute({action: 'read', key: request.key, actor, expectedLease});
    await checkIdentity(actor);
    need(changed?.value && readback?.value && hash(changed.value) === hash(readback.value), 'JOURNAL_READBACK_CHANGED');
    return {value: readback.value, created: changed.created};
  }
  return Object.freeze({
    async read(key) {const actor = await identity(), out = await transport.execute({action: 'read', key, actor}); await checkIdentity(actor); return out.value;},
    async acquire(key, actor, owner, initial) {
      need(typeof owner === 'string' && !usedOwners.has(owner), 'JOURNAL_OWNER_REUSED'); usedOwners.add(owner);
      const current = await identity(); need(same(actor, current), 'JOURNAL_IDENTITY_CHANGED');
      const out = await mutation({action: 'acquire', key, owner, initial}, current), lease = out.value.lease;
      need(lease?.owner === owner, 'JOURNAL_READBACK_CHANGED');
      capabilities.set(keyFor(key, owner), {fence: lease.fence, epoch: lease.epoch, version: out.value.version});
      return {...out.value, created: out.created};
    },
    async save(key, owner, payload) {
      const cap = capabilities.get(keyFor(key, owner)); need(cap, 'JOURNAL_CAPABILITY_REQUIRED');
      const actor = await identity(), out = await mutation({action: 'save', key, owner, payload, capability: {...cap}}, actor);
      capabilities.set(keyFor(key, owner), {...cap, version: out.value.version}); return out.value;
    },
    async renew(key, owner) {
      const cap = capabilities.get(keyFor(key, owner)); need(cap, 'JOURNAL_CAPABILITY_REQUIRED');
      const actor = await identity(), out = await mutation({action: 'renew', key, owner, capability: {...cap}}, actor);
      capabilities.set(keyFor(key, owner), {...cap, version: out.value.version}); return out.value;
    },
    async release(key, owner) {
      const cap = capabilities.get(keyFor(key, owner)); need(cap, 'JOURNAL_CAPABILITY_REQUIRED');
      const actor = await identity(), out = await mutation({action: 'release', key, owner, capability: {...cap}}, actor);
      capabilities.delete(keyFor(key, owner)); return out.value;
    },
  });
}
module.exports = {createAsyncJournal};
