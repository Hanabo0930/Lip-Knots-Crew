import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setup } from './notification-test-harness.mjs';

const results = [];
const test = async (name, run) => {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); }
};
const hash = token => createHash('sha256').update(token).digest('hex');
const progressRetry = '2026-09-11T21:59:30+09:00';
const morning = '2026-09-12T07:00:00+09:00';
const hold = (record, tokenHashes) => {
  assert.equal(record.status, 'error');
  assert.equal(record.deliveryVerificationRequired, true);
  assert.match(record.dispatchIntent.operationId, /^[a-f0-9]{64}$/);
  assert.deepEqual(record.dispatchIntent.tokenHashes, tokenHashes);
  assert.equal(record.failureReason, 'unknown');
  assert(!JSON.stringify(record).includes('synthetic-target'));
};

for (const category of [
  'precontact_reminder', 'precontact_late', 'submission_reminder', 'submission_overdue',
  'netprint_unprinted', 'netprint_updated', 'resubmission_request',
]) {
  await test('legacy reminder without bound context / ' + category, async () => {
    const h = setup(); const q = await h.enqueue({ category });
    await h.trigger(q.queueId);
    assert.equal(h.state.sent.length, 0);
    assert.equal(h.document(q.queueId).status, 'superseded');
    assert.equal(h.document(q.queueId).attempts, 0);
  });
}

await test('morning digest excludes the legacy reminder but retains the verified task', async () => {
  const h = setup('2026-09-11T23:00:00+09:00');
  h.state.records.set('jobs/job-a', {
    companyId: 'company-a', assignedStaffId: 'staff-a', status: 'assigned', dateKey: '2026-09-12', revision: 1,
  });
  await h.enqueue({ category: 'precontact_reminder', dedupeKey: 'legacy' });
  await h.enqueue({
    category: 'precontact_reminder', dedupeKey: 'current', route: '/shifts/job-a/precontact',
    reminderContext: { version: 1, jobId: 'job-a', staffId: 'staff-a', dateKey: '2026-09-12', revision: 1, kind: 'precontact' },
  });
  h.setTime(morning);
  await h.tick();
  assert.equal(h.state.sent.length, 1);
  assert.equal(h.state.sent[0].data.body, '1件のお知らせ・対応事項があります。');
});

await test('a transient error before external dispatch still retries safely', async () => {
  const h = setup(); const q = await h.enqueue();
  h.state.onResolve = () => { delete h.state.onResolve; throw new Error('synthetic token query failure'); };
  await h.trigger(q.queueId);
  assert.equal(h.document(q.queueId).status, 'queued');
  assert.equal(h.document(q.queueId).dispatchIntent, undefined);
  assert.equal(h.state.sent.length, 0);
  h.setTime(morning);
  await h.tick();
  assert.equal(h.state.sent.length, 1);
  assert.equal(h.document(q.queueId).status, 'completed');
});

await test('a lost dispatch-intent commit response cannot result in an outbound call', async () => {
  const h = setup(); const q = await h.enqueue();
  h.state.onAfterCommit = writes => {
    if (!writes.some(([, value]) => value.dispatchIntent)) return;
    delete h.state.onAfterCommit;
    throw new Error('synthetic unknown commit outcome');
  };
  await h.trigger(q.queueId);
  hold(h.document(q.queueId), [hash('synthetic-target')]);
  h.setTime(morning); await h.tick(); await h.trigger(q.queueId);
  assert.equal(h.state.sent.length, 0);
});

await test('a missing receipt row is held before any retransmission', async () => {
  const h = setup(); const q = await h.enqueue();
  h.state.response = () => ({ successCount: 0, failureCount: 0, responses: [] });
  await h.trigger(q.queueId);
  hold(h.document(q.queueId), [hash('synthetic-target')]);
  h.setTime(morning); await h.tick();
  assert.equal(h.state.sent.length, 1);
});

await test('FCM accepted the call but the progress write failed', async () => {
  const h = setup(); const q = await h.enqueue();
  h.state.onBeforeCommit = writes => {
    if (!writes.some(([, value]) => value.processedTokenHashes)) return;
    delete h.state.onBeforeCommit;
    throw new Error('synthetic failure before progress was saved');
  };
  await h.trigger(q.queueId);
  hold(h.document(q.queueId), [hash('synthetic-target')]);
  const operationId = h.document(q.queueId).dispatchIntent.operationId;
  // A changed status alone is not proof of a failed dispatch.
  h.document(q.queueId).status = 'queued';
  h.document(q.queueId).quietDeferred = true;
  h.setTime(morning); await h.tick(); await h.trigger(q.queueId);
  assert.equal(h.state.sent.length, 1);
  assert.equal(h.document(q.queueId).dispatchIntent.operationId, operationId);
  hold(h.document(q.queueId), [hash('synthetic-target')]);
});

await test('saved per-token progress survives an acknowledgement loss without another call', async () => {
  const h = setup(); const q = await h.enqueue();
  h.state.onAfterCommit = writes => {
    if (!writes.some(([, value]) => value.processedTokenHashes)) return;
    delete h.state.onAfterCommit;
    throw new Error('synthetic readback error after persisted progress');
  };
  await h.trigger(q.queueId);
  assert.deepEqual(h.document(q.queueId).processedTokenHashes, [hash('synthetic-target')]);
  assert.equal(h.document(q.queueId).dispatchIntent, null);
  assert.equal(h.document(q.queueId).status, 'queued');
  h.setTime(morning); await h.tick();
  assert.equal(h.state.sent.length, 1);
  assert.equal(h.document(q.queueId).status, 'completed');
});

await test('simultaneous event, scheduled dispatch and replay acquire only one intent', async () => {
  const h = setup(progressRetry); const q = await h.enqueue();
  let seenIntent = false;
  h.state.onSend = () => {
    const intent = h.document(q.queueId).dispatchIntent;
    assert.deepEqual(intent.tokenHashes, [hash('synthetic-target')]);
    seenIntent = true;
  };
  await Promise.all([h.trigger(q.queueId), h.tick(), h.trigger(q.queueId)]);
  assert.equal(seenIntent, true);
  assert.equal(h.state.sent.length, 1);
  assert.equal(h.document(q.queueId).status, 'completed');
  assert.equal(h.document(q.queueId).dispatchIntent, null);
});

await test('crossing quiet hours after intent persistence defers an unstarted call', async () => {
  const h = setup(); const q = await h.enqueue();
  h.state.onAfterCommit = writes => {
    if (!writes.some(([, value]) => value.dispatchIntent)) return;
    delete h.state.onAfterCommit;
    h.setTime('2026-09-11T22:00:00+09:00');
  };
  await h.trigger(q.queueId);
  assert.equal(h.state.sent.length, 0);
  assert.equal(h.document(q.queueId).dispatchIntent, null);
  assert.equal(h.document(q.queueId).status, 'queued');
  h.setTime(morning); await h.tick();
  assert.equal(h.state.sent.length, 1);
});

await test('the staff test-status endpoint exposes the hold only to the original tester', async () => {
  const h = setup();
  const { sendTestPush, getPushStatus } = h.load('./push-tokens');
  const claims = { companyId: 'company-a', staffId: 'staff-a', role: 'staff', auth_time: Date.parse('2026-09-11T20:00:00+09:00')/1000 };
  h.state.records.set('authIdentities/uid-a', { companyId: 'company-a', staffId: 'staff-a', active: true });
  Object.assign(h.state.records.get('pushTokens/target'), { uid: 'uid-a', role: 'staff' });
  const q = await sendTestPush({auth:{uid:'uid-a',token:claims}});
  h.state.failSend = true; await h.trigger(q.queueId);
  const request = uid => ({ auth: { uid, token: claims }, data: { queueId: q.queueId } });
  const { test } = await getPushStatus(request('uid-a'));
  assert.equal(test.deliveryVerificationRequired, true);
  assert.equal(test.finished, true); assert.equal(test.status, 'error');
  await assert.rejects(getPushStatus(request('uid-other')), error => error.code === 'permission-denied');
});

const passed = results.filter(r => r.passed).length;
console.log(JSON.stringify({ passed, total: results.length, results, scope: 'actual worker with synthetic Firestore and FCM boundaries', externalMessages: 0 }));
process.exitCode = passed === results.length ? 0 : 1;
