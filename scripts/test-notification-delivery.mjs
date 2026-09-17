import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setup } from './notification-test-harness.mjs';

let cases = 0;
for (const via of ['trigger', 'schedule']) {
  const h = setup(), { queueId } = await h.enqueue();
  h.setTime('2026-09-11T22:00:00+09:00');
  await (via === 'trigger' ? h.trigger(queueId) : h.tick());
  assert.equal(h.state.sent.length, 0, via + ': delayed notification must not send at night');
  assert.equal(h.document(queueId).status, 'queued');
  assert.equal(h.document(queueId).quietDeferred, true);
  assert.equal(h.document(queueId).attempts, 0);
  assert.equal(h.document(queueId).deliverAt.toMillis(), Date.parse('2026-09-12T07:00:00+09:00'));
  h.setTime('2026-09-12T06:59:59+09:00'); await h.trigger(queueId); assert.equal(h.state.sent.length, 0);
  h.setTime('2026-09-12T07:00:00+09:00'); await h.tick(); await h.trigger(queueId); await h.tick();
  assert.equal(h.state.sent.length, 1); assert.equal(h.document(queueId).status, 'completed'); cases++;
}
for (const bypass of [true, false, undefined, 'true']) {
  const h = setup('2026-09-11T23:00:00+09:00');
  const { queueId } = await h.enqueue({ bypassQuietHours: bypass });
  const values = h.core.queueDocumentData({ ...h.input, bypassQuietHours: bypass });
  assert.equal(values.bypassQuietHours, bypass === true);
  await h.trigger(queueId); assert.equal(h.state.sent.length, bypass === true ? 1 : 0); cases++;
}
for (const category of ['general', 'job_cancelled', 'urgent_job', 'submission_overdue', 'precontact_late', 'upload_error']) {
  const h = setup(), { queueId } = await h.enqueue({ category });
  delete h.document(queueId).bypassQuietHours;
  h.setTime('2026-09-12T01:00:00+09:00'); await h.trigger(queueId);
  assert.equal(h.state.sent.length, 0, category); assert.equal(h.document(queueId).quietDeferred, true); cases++;
}
for (const [target, tokenField, expected] of [[{ targetStaffId: 'staff-a' }, 'staffId', 'staff-a'], [{ targetStaffId: undefined, targetRole: 'admin' }, 'role', 'admin'], [{ targetStaffId: undefined, targetUid: 'uid-a' }, 'uid', 'uid-a']]) {
  const h = setup('2026-09-11T12:00:00+09:00'); h.state.records.clear();
  for (const [id, companyId, value, active] of [['target', 'company-a', expected, true], ['duplicate', 'company-a', expected, true], ['foreign', 'company-b', expected, true], ['other', 'company-a', 'other', true], ['inactive', 'company-a', expected, false]]) h.state.records.set('pushTokens/' + id, { companyId, [tokenField]: value, active, token: id === 'duplicate' ? 'target' : id });
  const { queueId } = await h.enqueue(target); assert.equal((await h.enqueue(target)).queued, false);
  await h.trigger(queueId); await h.trigger(queueId); await h.tick();
  assert.deepEqual(h.state.sent.map(item => item.tokens), [['target']]); cases++;
}
{
  const h = setup(), { queueId } = await h.enqueue(); h.state.failSend = true;
  await h.trigger(queueId); assert.equal(h.document(queueId).status, 'queued');
  h.state.failSend = false; h.setTime('2026-09-11T22:01:00+09:00'); await h.tick();
  assert.equal(h.state.sent.length, 1); assert.equal(h.document(queueId).quietDeferred, true);
  h.setTime('2026-09-12T07:00:00+09:00'); await h.tick(); assert.equal(h.state.sent.length, 2); cases++;
}
{
  const h = setup('2026-09-11T23:00:00+09:00');
  const first = await h.enqueue(), second = await h.enqueue({ dedupeKey: 'second' });
  h.setTime('2026-09-12T07:00:00+09:00'); await h.tick(); await h.tick();
  assert.equal(h.state.sent.length, 1); assert.equal(h.state.sent[0].data.category, 'quiet_digest');
  assert.equal(h.document(first.queueId).status, 'bundled'); assert.equal(h.document(second.queueId).status, 'bundled'); cases++;
}

const failures = [];
for (const phase of ['before-read', 'after-read']) {
  for (const status of ['completed', 'partial', 'no_tokens', 'error', 'bundled', 'paused_global', 'sending']) {
    const h = setup('2026-09-11T12:00:00+09:00'), { queueId } = await h.enqueue();
    const replay = h.event(queueId);
    const previous = { ...h.document(queueId), status, successCount: 3, leaseToken: 'other-worker', pauseReason: 'original' };
    const change = () => h.state.records.set('notificationQueue/' + queueId, previous);
    if (phase === 'before-read') change(); else h.state.onOperational = change;
    h.state.operational = false;
    await replay();
    try {
      assert.deepEqual(h.document(queueId), previous, phase + '/' + status + ': replay must preserve current notification');
      assert.equal(h.state.sent.length, 0);
    } catch (error) { failures.push(error.message); }
    cases++;
  }
}
{
  const h = setup('2026-09-11T12:00:00+09:00'), { queueId } = await h.enqueue();
  h.state.operational = false; await h.trigger(queueId);
  assert.equal(h.document(queueId).status, 'paused_global'); assert.equal(h.document(queueId).attempts, 0);
  assert.equal(h.state.sent.length, 0); cases++;
}
{
  const h = setup('2026-09-11T23:00:00+09:00'), { queueId } = await h.enqueue({ category: 'production_global_kill_switch', bypassQuietHours: true });
  h.state.operational = false; await h.trigger(queueId);
  assert.equal(h.document(queueId).status, 'completed'); assert.equal(h.state.sent.length, 1); cases++;
}
assert.equal(failures.length, 0, failures.join('\n'));


for (const bypass of [false, true]) {
  const h = setup(), { queueId } = await h.enqueue({ bypassQuietHours: bypass });
  h.state.onResolve = () => h.setTime('2026-09-11T22:00:00+09:00');
  await h.trigger(queueId);
  assert.equal(h.state.sent.length, bypass ? 1 : 0, 'token lookup crosses quiet boundary');
  if (!bypass) {
    assert.equal(h.document(queueId).status, 'queued');
    delete h.state.onResolve; h.setTime('2026-09-12T07:00:00+09:00'); await h.tick();
    assert.equal(h.state.sent.length, 1); assert.equal(h.document(queueId).status, 'completed');
  }
  cases++;
}
for (const mode of ['normal', 'second-chunk-fails', 'mixed-failure', 'recipients-change']) {
  const h = setup(); h.state.records.clear();
  for (let i = 0; i < 501; i++) h.state.records.set('pushTokens/token-' + String(i).padStart(4, '0'), { companyId: 'company-a', staffId: 'staff-a', active: true, token: 'synthetic-' + i });
  const { queueId } = await h.enqueue();
  if (mode === 'second-chunk-fails') {
    h.state.onSend = () => { if (h.state.sent.length === 2) { h.state.failSend = true; h.setTime('2026-09-11T22:00:00+09:00'); } };
  } else h.state.onSend = () => h.setTime('2026-09-11T22:00:00+09:00');
  if (mode === 'mixed-failure') h.state.response = count => ({ successCount: count - 1, failureCount: 1, responses: Array.from({ length: count }, (_, i) => i === 0 ? { success: false, error: { code: 'messaging/registration-token-not-registered' } } : { success: true }) });
  await h.trigger(queueId);
  assert.equal(h.state.sent.length, mode === 'second-chunk-fails' ? 2 : 1, 'no later chunk during quiet hours');
  assert.equal(h.document(queueId).status, 'queued');
  assert.equal(h.document(queueId).successCount, mode === 'mixed-failure' ? 499 : 500);
  assert.equal(h.document(queueId).processedTokenHashes.length, 500);
  assert.ok(h.document(queueId).processedTokenHashes.every(value => /^[a-f0-9]{64}$/.test(value)));
  assert.ok(!JSON.stringify(h.document(queueId)).includes('synthetic-499'));
  delete h.state.onSend; delete h.state.response; h.state.failSend = false;
  if (mode === 'recipients-change') {
    h.state.records.get('pushTokens/token-0500').active = false;
    h.state.records.set('pushTokens/new-token', { companyId: 'company-a', staffId: 'staff-a', active: true, token: 'synthetic-new' });
  }
  if (mode !== 'second-chunk-fails') {
    await h.enqueue({ dedupeKey: 'other-one' }); await h.enqueue({ dedupeKey: 'other-two' });
  }
  h.setTime('2026-09-12T07:00:00+09:00'); await h.tick(); await h.tick();
  const original = h.state.sent.filter(item => item.data.category !== 'quiet_digest');
  const last = original.at(-1);
  assert.deepEqual(last.tokens, [mode === 'recipients-change' ? 'synthetic-new' : 'synthetic-500']);
  assert.equal(original.filter(item => item.tokens.includes('synthetic-1')).length, 1, 'confirmed first chunk must not repeat');
  assert.equal(h.document(queueId).status, mode === 'mixed-failure' ? 'partial' : 'completed');
  assert.equal(h.document(queueId).successCount, mode === 'mixed-failure' ? 500 : 501);
  assert.equal(h.document(queueId).failureCount, mode === 'mixed-failure' ? 1 : 0);
  const dispatchMetrics = h.state.metrics.filter(item => item[2] === 'notification_dispatch');
  assert.equal(dispatchMetrics.reduce((sum, item) => sum + item[1].notificationAttempts, 0), mode === 'second-chunk-fails' ? 501 : mode === 'mixed-failure' ? 1001 : 1002);
  if (mode === 'mixed-failure') { assert.equal(h.document(queueId).failureReason, 'invalid_token'); assert.equal(h.document(queueId).invalidTokenCount, 1); assert.equal(h.state.records.get('pushTokens/token-0000').active, false); }
  cases++;
}


{
  const h = setup(); h.state.records.clear();
  for (let i = 0; i < 501; i++) h.state.records.set('pushTokens/token-' + String(i).padStart(4, '0'), { companyId: 'company-a', staffId: 'staff-a', active: true, token: 'synthetic-' + i });
  const { queueId } = await h.enqueue(); h.state.onSend = () => h.setTime('2026-09-11T22:00:00+09:00');
  await h.trigger(queueId); delete h.state.onSend;
  h.state.records.get('pushTokens/token-0500').companyId = 'company-b';
  h.setTime('2026-09-12T07:00:00+09:00'); await h.tick();
  assert.equal(h.state.sent.length, 1); assert.equal(h.document(queueId).status, 'completed');
  assert.equal(h.document(queueId).successCount, 500); cases++;
}
for (const phase of ['resolve', 'send']) {
  for (const fail of [false, true]) {
    const h = setup('2026-09-11T12:00:00+09:00'), { queueId } = await h.enqueue();
    const replacement = { ...h.document(queueId), status: 'sending', leaseToken: 'replacement', successCount: 12 };
    const change = () => { h.state.records.set('notificationQueue/' + queueId, replacement); h.state.failSend = fail; };
    if (phase === 'resolve') h.state.onResolve = change; else h.state.onSend = change;
    await h.trigger(queueId);
    assert.deepEqual(h.document(queueId), replacement, 'old worker must not update another lease');
    assert.equal(h.state.sent.length, phase === 'resolve' ? 0 : 1); cases++;
  }
}


const digestFailures = [];
for (const mode of ['completed', 'sending', 'partial', 'error', 'bundled', 'paused_global', 'deleted', 'progress', 'future', 'quiet-cleared', 'company-changed', 'target-changed']) {
  const h = setup('2026-09-11T23:00:00+09:00');
  const first = await h.enqueue(), second = await h.enqueue({ dedupeKey: 'second' }), third = await h.enqueue({ dedupeKey: 'third' });
  h.state.onDeferred = () => {
    delete h.state.onDeferred;
    const doc = h.document(first.queueId);
    if (mode === 'deleted') h.state.records.delete('notificationQueue/' + first.queueId);
    else if (mode === 'progress') doc.processedTokenHashes = [crypto.createHash('sha256').update('synthetic-target').digest('hex')];
    else if (mode === 'future') doc.deliverAt = h.Timestamp.fromMillis(Date.parse('2026-09-13T07:00:00+09:00'));
    else if (mode === 'quiet-cleared') doc.quietDeferred = false;
    else if (mode === 'company-changed') doc.companyId = 'company-b';
    else if (mode === 'target-changed') doc.targetStaffId = 'staff-b';
    else doc.status = mode;
  };
  h.setTime('2026-09-12T07:00:00+09:00'); await h.tick();
  try {
    const digest = [...h.state.records.values()].find(doc => doc.category === 'quiet_digest');
    assert.deepEqual(digest.bundledQueueIds.slice().sort(), [second.queueId, third.queueId].sort(), mode);
    assert.equal(digest.body, '2件のお知らせ・対応事項があります。');
    if (mode === 'deleted') assert.equal(h.document(first.queueId), undefined);
    else if (['completed', 'sending', 'partial', 'error', 'bundled', 'paused_global'].includes(mode)) assert.equal(h.document(first.queueId).status, mode);
    else assert.notEqual(h.document(first.queueId).status, 'bundled');
  } catch (error) { digestFailures.push(mode + ': ' + error.message); }
  cases++;
}
{
  const h = setup('2026-09-11T23:00:00+09:00');
  await h.enqueue(); await h.enqueue({ dedupeKey: 'second' });
  h.setTime('2026-09-12T07:00:00+09:00'); await h.tick();
  const oldDigest = [...h.state.records.values()].find(doc => doc.category === 'quiet_digest');
  const oldIds = oldDigest.bundledQueueIds.slice();
  h.setTime('2026-09-11T23:00:00+09:00');
  const lateA = await h.enqueue({ dedupeKey: 'late-a' }), lateB = await h.enqueue({ dedupeKey: 'late-b' });
  h.setTime('2026-09-12T07:01:00+09:00'); await h.tick(); await h.tick();
  try {
    assert.equal(h.state.sent.length, 2, 'later group must not vanish into an already sent digest');
    const digests = [...h.state.records.values()].filter(doc => doc.category === 'quiet_digest');
    assert.equal(digests.length, 2);
    assert.deepEqual(oldDigest.bundledQueueIds, oldIds);
    assert.notEqual(h.document(lateA.queueId).bundledInto, h.document(oldIds[0]).bundledInto);
    assert.equal(h.document(lateA.queueId).bundledInto, h.document(lateB.queueId).bundledInto);
  } catch (error) { digestFailures.push(error.message); }
  cases++;
}
assert.equal(digestFailures.length, 0, digestFailures.join('\n'));


{
  const h = setup('2026-09-11T23:00:00+09:00');
  await h.enqueue(); await h.enqueue({ dedupeKey: 'second' });
  h.setTime('2026-09-12T07:00:00+09:00');
  await Promise.all([h.tick(), h.tick()]);
  assert.equal([...h.state.records.values()].filter(doc => doc.category === 'quiet_digest').length, 1);
  assert.equal(h.state.sent.length, 1); assert.ok(h.state.transactionRetries > 0); cases++;
}
{
  const h = setup('2026-09-11T23:00:00+09:00');
  const first = await h.enqueue(), second = await h.enqueue({ dedupeKey: 'second' }), third = await h.enqueue({ dedupeKey: 'third' });
  h.state.onBeforeCommit = async writes => {
    if (!writes.some(([, data]) => data.category === 'quiet_digest')) return;
    delete h.state.onBeforeCommit; await h.trigger(first.queueId);
  };
  h.setTime('2026-09-12T07:00:00+09:00'); await h.tick();
  const digest = [...h.state.records.values()].find(doc => doc.category === 'quiet_digest');
  assert.deepEqual(digest.bundledQueueIds.slice().sort(), [second.queueId, third.queueId].sort());
  assert.equal(h.document(first.queueId).status, 'completed');
  assert.equal(h.state.sent.length, 2); assert.ok(h.state.transactionRetries > 0); cases++;
}
{
  const h = setup('2026-09-11T23:00:00+09:00'); h.state.records.clear();
  for (const [companyId, targetStaffId, prefix] of [['a|staff:b', 'c', 'first'], ['a', 'b|staff:c', 'second']]) {
    h.state.records.set('pushTokens/' + prefix, { companyId, staffId: targetStaffId, active: true, token: prefix });
    await h.enqueue({ companyId, targetStaffId, dedupeKey: prefix + '-1' });
    await h.enqueue({ companyId, targetStaffId, dedupeKey: prefix + '-2' });
  }
  h.setTime('2026-09-12T07:00:00+09:00'); await h.tick();
  assert.deepEqual(h.state.sent.map(item => item.tokens).sort(), [['first'], ['second']]);
  const digests = [...h.state.records.values()].filter(doc => doc.category === 'quiet_digest');
  assert.equal(digests.length, 2); assert.ok(digests.every(doc => doc.bundledQueueIds.length === 2)); cases++;
}

console.log(JSON.stringify({ cases, passed: true, realPush: false, cloudChanges: false, syntheticTransactionConflictsVerified: true, realSdkConcurrencyVerified: false }));
