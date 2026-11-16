'use strict';
// Injectable SDK-shaped transaction port only. No Firebase app, network,
// credentials, registration, real policy authority or production route.
const {transition} = require('./case-list-gas-journal-core.cjs');
const JOURNAL_NAMESPACE = 'lkcSyntheticAsyncJournalV1', POLICY_NAMESPACE = 'lkcSyntheticAsyncPolicyV1';
function createFirestoreTransactionTransport({isolatedProposal, runTransaction, journalRef, policyRef, now}) {
  if (isolatedProposal !== true || typeof runTransaction !== 'function' || typeof journalRef !== 'function' || typeof policyRef !== 'function' || typeof now !== 'function') throw new Error('JOURNAL_PORT_REQUIRED');
  return Object.freeze({async execute(request) {
    const r = journalRef(request.key), p = policyRef(request.actor?.companyId);
    if (r?.id !== request.key || r.path !== JOURNAL_NAMESPACE + '/' + request.key || p?.id !== request.actor?.companyId || p.path !== POLICY_NAMESPACE + '/' + request.actor.companyId) throw new Error('JOURNAL_NAMESPACE_MISMATCH');
    return runTransaction(async tx => {
      const policy = await tx.get(p), journal = await tx.get(r);
      if (!policy.exists) throw Object.assign(new Error('JOURNAL_POLICY_CLOSED'), {code: 'JOURNAL_POLICY_CLOSED'});
      const out = transition(request, journal.exists ? journal.data() : null, policy.data(), now());
      if (out.write) tx.set(r, out.value);
      return {value: out.value, created: out.created};
    }, request.action === 'read' ? {readOnly: true} : undefined);
  }});
}
module.exports = {createFirestoreTransactionTransport, JOURNAL_NAMESPACE, POLICY_NAMESPACE};
