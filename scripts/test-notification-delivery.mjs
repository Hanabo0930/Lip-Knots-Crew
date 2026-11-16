import "./test-operational-reminder-delivery.mjs";
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
  await h.trigger(queueId); assert.equal(h.document(queueId).status, 'error');
  assert.equal(h.document(queueId).deliveryVerificationRequired, true);
  assert.match(h.document(queueId).dispatchIntent.operationId, /^[a-f0-9]{64}$/);
  h.state.failSend = false; h.setTime('2026-09-11T22:01:00+09:00'); await h.tick();
  assert.equal(h.state.sent.length, 1);
  h.setTime('2026-09-12T07:00:00+09:00'); await h.tick(); assert.equal(h.state.sent.length, 1); cases++;
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
  assert.equal(h.document(queueId).status, mode === 'second-chunk-fails' ? 'error' : 'queued');
  assert.equal(h.document(queueId).successCount, mode === 'mixed-failure' ? 499 : 500);
  assert.equal(h.document(queueId).processedTokenHashes.length, 500);
  assert.ok(h.document(queueId).processedTokenHashes.every(value => /^[a-f0-9]{64}$/.test(value)));
  assert.ok(!JSON.stringify(h.document(queueId)).includes('synthetic-499'));
  delete h.state.onSend; delete h.state.response; h.state.failSend = false;
  if (mode === 'second-chunk-fails') {
    assert.equal(h.document(queueId).deliveryVerificationRequired, true);
    assert.deepEqual(h.document(queueId).dispatchIntent.tokenHashes,
      [crypto.createHash('sha256').update('synthetic-500').digest('hex')]);
    h.setTime('2026-09-12T07:00:00+09:00'); await h.tick(); await h.trigger(queueId);
    assert.equal(h.state.sent.length, 2, 'do not retransmit the uncertain 501st token');
    assert.equal(h.document(queueId).successCount, 500);
    cases++;
    continue;
  }
  if (mode === 'recipients-change') {
    h.state.records.get('pushTokens/token-0500').active = false;
    h.state.records.set('pushTokens/new-token', { companyId: 'company-a', staffId: 'staff-a', active: true, token: 'synthetic-new' });
  }
  await h.enqueue({ dedupeKey: 'other-one' }); await h.enqueue({ dedupeKey: 'other-two' });
  h.setTime('2026-09-12T07:00:00+09:00'); await h.tick(); await h.tick();
  const original = h.state.sent.filter(item => item.data.category !== 'quiet_digest');
  const last = original.at(-1);
  assert.deepEqual(last.tokens, [mode === 'recipients-change' ? 'synthetic-new' : 'synthetic-500']);
  assert.equal(original.filter(item => item.tokens.includes('synthetic-1')).length, 1, 'confirmed first chunk must not repeat');
  assert.equal(h.document(queueId).status, mode === 'mixed-failure' ? 'partial' : 'completed');
  assert.equal(h.document(queueId).successCount, mode === 'mixed-failure' ? 500 : 501);
  assert.equal(h.document(queueId).failureCount, mode === 'mixed-failure' ? 1 : 0);
  const dispatchMetrics = h.state.metrics.filter(item => item[2] === 'notification_dispatch');
  assert.equal(dispatchMetrics.reduce((sum, item) => sum + item[1].notificationAttempts, 0), mode === 'mixed-failure' ? 1001 : 1002);
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
    delete h.state.onBeforeCommit;
    await h.trigger(first.queueId);
    assert.equal(h.state.sent.length, 0, 'a delayed event cannot claim an unresolved quiet member');
    // Model an old worker that committed before this candidate's grouping transaction.
    h.document(first.queueId).status = 'completed';
  };
  h.setTime('2026-09-12T07:00:00+09:00'); await h.tick();
  const digest = [...h.state.records.values()].find(doc => doc.category === 'quiet_digest');
  assert.deepEqual(digest.bundledQueueIds.slice().sort(), [second.queueId, third.queueId].sort());
  assert.equal(h.document(first.queueId).status, 'completed');
  assert.equal(h.state.sent.length, 1); assert.ok(h.state.transactionRetries > 0); cases++;
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


const quietRecovery = [];
const digestRecords = h => [...h.state.records.entries()].filter(([path,doc])=>path.startsWith('notificationQueue/')&&doc.category==='quiet_digest');
const seedQuiet = async (h, count, key, targets={})=>{
 const ids=[];
 for(let index=0;index<count;index++){
  const item=await h.enqueue({dedupeKey:key+'-'+index,...targets});
  ids.push(item.queueId);
 }
 return ids;
};

{
 const h=setup('2026-09-11T23:00:00+09:00');
 const first=await seedQuiet(h,620,'many');
 const second=await seedQuiet(h,5,'foreign',{companyId:'company-b'});
 h.state.records.set('pushTokens/foreign',{companyId:'company-b',staffId:'staff-a',active:true,token:'synthetic-foreign'});
 h.setTime('2026-09-12T07:00:00+09:00');
 await h.trigger(first[0]);assert.equal(h.state.sent.length,0);
 await Promise.all([h.tick(),h.tick()]);await h.tick();
 assert.deepEqual(h.state.sent.map(x=>[x.tokens[0],x.data.body]).sort(),[
  ['synthetic-foreign','5件のお知らせ・対応事項があります。'],['synthetic-target','620件のお知らせ・対応事項があります。'],
 ]);
 assert.equal(digestRecords(h).length,2);
 for(const [ids,companyId] of [[first,'company-a'],[second,'company-b']]){
  const digest=digestRecords(h).find(([,doc])=>doc.companyId===companyId)[1];
  assert.deepEqual(digest.bundledQueueIds.slice().sort(),ids.slice().sort());
  assert.ok(ids.every(id=>h.document(id).status==='bundled'));
 }
 quietRecovery.push('625 across three pages, 620 consolidated once and company isolation');
}
{
 const h=setup('2026-09-11T23:00:00+09:00'),ids=await seedQuiet(h,302,'lookup-fails');
 h.state.suppressExpectedErrors=true;
 h.state.onQuery=query=>{if(query.name==='notificationQueue'&&query.after)throw Error('synthetic second page unavailable');};
 h.setTime('2026-09-12T07:00:00+09:00');await h.tick();await h.trigger(ids[0]);
 assert.equal(h.state.sent.length,0);assert.equal(digestRecords(h).length,0);
 assert.ok(ids.every(id=>h.document(id).status==='queued'&&h.document(id).quietDeferred===true));
 delete h.state.onQuery;
 h.setTime('2026-09-12T07:08:00+09:00');await h.tick();
 assert.equal(h.state.sent.length,1);
 assert.equal(h.state.sent[0].data.body,'302件のお知らせ・対応事項があります。');
 quietRecovery.push('page failure sends none, recovered after the initial morning window');
}
{
 const h=setup('2026-09-11T23:00:00+09:00');
 const ids=await seedQuiet(h,3,'commit-reply-lost');
 h.state.suppressExpectedErrors=true;
 h.state.onAfterCommit=writes=>{
  if(writes.some(([,data])=>data.category==='quiet_digest')){
   delete h.state.onAfterCommit;throw Error('synthetic digest commit acknowledgement lost');
  }
 };
 h.setTime('2026-09-12T07:00:00+09:00');await h.tick();await h.tick();
 assert.equal(h.state.sent.length,1);assert.equal(digestRecords(h).length,1);
 assert.ok(ids.every(id=>h.document(id).status==='bundled'));
 quietRecovery.push('commit acknowledgement loss neither duplicates the digest nor releases its originals');
}
{
 const h=setup('2026-09-11T23:00:00+09:00');
 const ids=await seedQuiet(h,3,'commit-not-saved');
 await seedQuiet(h,2,'another-recipient',{companyId:'company-b'});
 h.state.records.set('pushTokens/foreign',{companyId:'company-b',staffId:'staff-a',active:true,token:'synthetic-foreign'});
 h.state.suppressExpectedErrors=true;
 h.state.onBeforeCommit=writes=>{
  if(writes.some(([,data])=>data.category==='quiet_digest'&&data.companyId==='company-a'))throw Error('synthetic digest write rejected');
 };
 h.setTime('2026-09-12T07:00:00+09:00');await h.tick();
 assert.deepEqual(h.state.sent.map(x=>x.tokens[0]),['synthetic-foreign']);
 assert.ok(ids.every(id=>h.document(id).status==='queued'&&h.document(id).quietDeferred===true));
 delete h.state.onBeforeCommit;
 await h.tick();await h.tick();
 assert.deepEqual(h.state.sent.map(x=>x.tokens[0]),['synthetic-foreign','synthetic-target']);
 quietRecovery.push('a failed recipient group stays deferred while the other group proceeds');
}
{
 const h=setup('2026-09-11T23:00:00+09:00');
 await seedQuiet(h,2,'older-digest');
 h.state.suppressExpectedErrors=true;
 h.state.onRead=path=>{if(path.startsWith('notificationQueue/digest_'))throw Error('synthetic digest read failed');};
 h.setTime('2026-09-12T07:00:00+09:00');await h.tick();
 // The first failed read is before the write in an in-memory transaction. Retry grouping normally.
 delete h.state.onRead;
 h.state.onResolve=()=>{h.setTime('2026-09-12T22:00:00+09:00');};
 await h.tick();
 const [originalPath,originalDigest]=digestRecords(h)[0];
 assert.equal(originalDigest.status,'queued');assert.equal(originalDigest.quietDeferred,true);
 assert.equal(h.state.sent.length,0);
 await seedQuiet(h,2,'new-for-next-morning');
 delete h.state.onResolve;
 h.setTime('2026-09-13T07:00:00+09:00');await h.tick();await h.tick();
 assert.equal(h.state.sent.length,2);
 assert.equal(h.state.records.get(originalPath).status,'completed');
 assert.equal(digestRecords(h).length,2);
 assert.ok(digestRecords(h).every(([,doc])=>doc.bundledQueueIds.length===2));
 quietRecovery.push('an existing digest deferred at night is not nested into another digest');
}
{
 const h=setup('2026-09-11T23:00:00+09:00'),ids=await seedQuiet(h,1001,'very-large');
 h.setTime('2026-09-12T07:00:00+09:00');await h.tick();await h.tick();
 const digests=digestRecords(h).map(([,doc])=>doc);
 assert.equal(digests.length,2);
 assert.deepEqual(digests.flatMap(doc=>doc.bundledQueueIds).sort(),ids.slice().sort());
 assert.deepEqual(h.state.sent.map(x=>x.data.body).sort(),[
  '500件のお知らせ・対応事項があります。','501件のお知らせ・対応事項があります。',
 ]);
 quietRecovery.push('oversized group bounded with no missing or duplicate children');
}


const recipientBindingCases = [];
for (const change of ['inactive', 'company', 'staff', 'uid', 'role', 'device', 'token', 'same-owner-refresh', 'removed']) {
  const h = setup('2026-09-11T12:00:00+09:00');
  const path = 'pushTokens/target';
  const original = {
    ...h.state.records.get(path), uid: 'synthetic-user', role: 'staff', deviceSessionId: 'device-before',
    updatedAt: h.Timestamp.fromMillis(Date.parse('2026-09-11T11:00:00+09:00')),
  };
  h.state.records.set(path, original);
  const { queueId } = await h.enqueue();
  let changed = false;
  h.state.onBeforeCommit = writes => {
    if (changed || !writes.some(([, values]) => values.dispatchIntent?.operationId)) return;
    changed = true;
    const next = { ...original };
    if (change === 'inactive') next.active = false;
    if (change === 'company') next.companyId = 'company-b';
    if (change === 'staff') next.staffId = 'staff-b';
    if (change === 'uid') next.uid = 'synthetic-other-user';
    if (change === 'role') next.role = 'admin';
    if (change === 'device') next.deviceSessionId = 'device-after';
    if (change === 'token') next.token = 'new-synthetic-token';
    if (change === 'same-owner-refresh') next.updatedAt = h.Timestamp.now();
    if (change === 'removed') h.state.records.delete(path);
    else h.state.records.set(path, next);
  };
  await h.trigger(queueId); await h.tick();
  assert.equal(changed, true, change);
  assert.ok(h.state.transactionRetries > 0, change + ': the registration change must invalidate the pending transaction');
  const sameOwner = change === 'same-owner-refresh';
  assert.equal(h.state.sent.length, sameOwner ? 1 : 0, change + ': check the current recipient');
  assert.equal(h.document(queueId).status, sameOwner ? 'completed' : 'no_tokens');
  assert.equal(h.document(queueId).dispatchIntent ?? null, null);
  recipientBindingCases.push('before FCM / ' + change);
}
{
  const h = setup('2026-09-11T12:00:00+09:00');
  h.state.records.clear();
  for (let i = 0; i < 502; i++) h.state.records.set('pushTokens/device-' + String(i).padStart(4, '0'), {
    companyId: 'company-a', staffId: 'staff-a', uid: 'uid-a', role: 'staff', active: true, token: 'synthetic-' + i,
  });
  const { queueId } = await h.enqueue();
  h.state.onSend = () => {
    if (h.state.sent.length === 1) h.state.records.get('pushTokens/device-0500').companyId = 'company-b';
  };
  await h.trigger(queueId); await h.tick();
  assert.deepEqual(h.state.sent.map(send => send.tokens.length), [500, 1]);
  assert.deepEqual(h.state.sent[1].tokens, ['synthetic-501']);
  assert.equal(h.document(queueId).successCount, 501);
  assert.equal(h.document(queueId).processedTokenHashes.length, 501);
  assert.equal(h.document(queueId).processedTokenHashes.includes(crypto.createHash('sha256').update('synthetic-500').digest('hex')), false);
  recipientBindingCases.push('between FCM chunks / moved company skipped, active recipient delivered');
}
for (const change of ['company', 'new-registration', 'removed', 'unchanged', 'lease-replaced']) {
  const h = setup('2026-09-11T12:00:00+09:00');
  const path = 'pushTokens/target';
  const before = {
    ...h.state.records.get(path), uid: 'uid-a', updatedAt: h.Timestamp.fromMillis(Date.parse('2026-09-11T11:00:00+09:00')),
  };
  h.state.records.set(path, before);
  const { queueId } = await h.enqueue();
  h.state.onSend = () => {
    if (change === 'removed') h.state.records.delete(path);
    if (change === 'company') h.state.records.set(path, { ...before, companyId: 'company-b' });
    if (change === 'new-registration') h.state.records.set(path, { ...before, updatedAt: h.Timestamp.now() });
    if (change === 'lease-replaced') h.state.records.set('notificationQueue/' + queueId, { ...h.document(queueId), leaseToken: 'new-worker' });
  };
  h.state.response = () => ({
    successCount: 0, failureCount: 1, responses: [{ success: false, error: { code: 'messaging/registration-token-not-registered' } }],
  });
  await h.trigger(queueId); await h.tick();
  const current = h.state.records.get(path);
  if (change === 'removed') assert.equal(current, undefined, 'an old FCM response must not recreate a removed registration');
  else assert.equal(current.active, change !== 'unchanged', change);
  if (change === 'company') assert.equal(current.companyId, 'company-b');
  if (change === 'lease-replaced') {
    assert.equal(h.document(queueId).leaseToken, 'new-worker');
    assert.equal(h.document(queueId).status, 'sending');
    assert.equal(h.document(queueId).failureCount, undefined);
  } else {
    assert.equal(h.document(queueId).invalidTokenCount, change === 'unchanged' ? 1 : 0);
    assert.equal(h.document(queueId).status, 'partial');
    assert.equal(h.document(queueId).failureCount, 1);
  }
  assert.equal(h.state.sent.length, 1);
  recipientBindingCases.push('after FCM / ' + change);
}


const interruptedDeliveryCases = [];
const leaseTime = '2026-09-11T12:00:00+09:00';
const staleTime = '2026-09-11T11:50:00+09:00';
const operationId = 'a'.repeat(64);
function interruptedQueue(h, queueId, override = {}) {
  const values = h.document(queueId);
  Object.assign(values, {
    status: 'sending', leaseToken: 'prior-worker', dispatchProtocol: 'checkpoint_v1',
    startedAt: h.Timestamp.fromMillis(Date.parse(staleTime)), attempts: 1, ...override,
  });
  return values;
}
for (const mode of ['checkpoint', 'earlier-result-unknown', 'legacy']) {
  const h = setup(leaseTime), { queueId } = await h.enqueue();
  const marker = { operationId, tokenHashes: ['b'.repeat(64)], preparedAt: h.Timestamp.fromMillis(Date.parse(staleTime)) };
  const current = interruptedQueue(h, queueId, mode === 'checkpoint' ? { dispatchIntent: marker }
    : mode === 'earlier-result-unknown' ? { deliveryVerificationRequired: true } : { dispatchProtocol: undefined });
  await h.tick(); await h.trigger(queueId); await h.tick();
  const final = h.document(queueId);
  assert.equal(h.state.sent.length, 0, mode);
  assert.equal(final.status, 'error');
  assert.equal(final.deliveryVerificationRequired, true);
  assert.deepEqual(final.dispatchIntent, current.dispatchIntent);
  assert.equal(final.attempts, 1);
  interruptedDeliveryCases.push('unknown must hold / ' + mode);
}
{
  const h = setup(leaseTime), { queueId } = await h.enqueue();
  interruptedQueue(h, queueId, { startedAt: h.Timestamp.fromMillis(Date.parse(staleTime) + 1) });
  await h.tick();
  assert.equal(h.document(queueId).status, 'sending');
  assert.equal(h.state.sent.length, 0);
  h.setTime('2026-09-11T12:00:01+09:00');
  await h.tick(); await h.trigger(queueId); await h.tick();
  assert.equal(h.document(queueId).status, 'completed');
  assert.equal(h.state.sent.length, 1);
  assert.equal(h.document(queueId).attempts, 2);
  interruptedDeliveryCases.push('fresh lease untouched, proven pre-send interruption resumed once');
}
{
  const h = setup(leaseTime), { queueId } = await h.enqueue();
  const processed = crypto.createHash('sha256').update('synthetic-target').digest('hex');
  interruptedQueue(h, queueId, { processedTokenHashes: [processed], successCount: 1, lastDispatchOperationId: operationId, dispatchIntent: null });
  h.state.records.set('pushTokens/to-do', { companyId: 'company-a', staffId: 'staff-a', active: true, token: 'next-synthetic' });
  await h.tick(); await h.trigger(queueId);
  assert.deepEqual(h.state.sent.map(x => x.tokens), [['next-synthetic']]);
  assert.equal(h.document(queueId).successCount, 2);
  assert.equal(h.document(queueId).processedTokenHashes.length, 2);
  assert.equal(h.document(queueId).status, 'completed');
  interruptedDeliveryCases.push('continue after a confirmed checkpoint without repeating previously handled devices');
}
{
  const h = setup(leaseTime), { queueId } = await h.enqueue();
  interruptedQueue(h, queueId, { attempts: 5 });
  await h.tick(); await h.tick();
  assert.equal(h.state.sent.length, 0);
  const final = h.document(queueId);
  assert.equal(final.status, 'error');
  assert.equal(final.deliveryVerificationRequired, undefined);
  assert.equal(final.attempts, 5);
  interruptedDeliveryCases.push('attempt limit preserves a terminal error');
}
{
  const h = setup(leaseTime), { queueId } = await h.enqueue();
  interruptedQueue(h, queueId);
  let changed = false;
  h.state.onRead = path => {
    if (path !== 'notificationQueue/' + queueId || changed) return;
    changed = true;
    Object.assign(h.document(queueId), { leaseToken: 'new-worker', startedAt: h.Timestamp.now() });
  };
  await h.tick();
  assert.equal(changed, true);
  assert.ok(h.state.transactionRetries > 0);
  assert.equal(h.document(queueId).leaseToken, 'new-worker');
  assert.equal(h.document(queueId).status, 'sending');
  assert.equal(h.state.sent.length, 0);
  interruptedDeliveryCases.push('old snapshot cannot reclaim a replaced lease');
}
{
  const h = setup(leaseTime, { APP_ENVIRONMENT: 'staging', LKC_NOTIFICATION_DELIVERY_MODE: 'paused' });
  const { queueId } = await h.enqueue();
  interruptedQueue(h, queueId);
  const before = JSON.stringify([...h.state.records]);
  const reads = h.state.queryReads;
  await h.tick();
  assert.equal(h.state.queryReads, reads);
  assert.equal(JSON.stringify([...h.state.records]), before);
  assert.equal(h.state.sent.length, 0);
  interruptedDeliveryCases.push('paused worker leaves recovery and delivery idle');
}
{
  const h = setup(leaseTime), { queueId } = await h.enqueue();
  interruptedQueue(h, queueId);
  h.setTime('2026-09-11T22:05:00+09:00'); await h.tick();
  assert.equal(h.state.sent.length, 0);
  assert.equal(h.document(queueId).status, 'queued');
  assert.equal(h.document(queueId).deliverAt.toMillis(), Date.parse('2026-09-12T07:00:00+09:00'));
  h.setTime('2026-09-12T07:00:00+09:00'); await h.tick(); await h.tick();
  assert.equal(h.state.sent.length, 1);
  interruptedDeliveryCases.push('retry follows the existing quiet-hours policy');
}
{
  const h = setup(leaseTime), { queueId } = await h.enqueue();
  h.state.suppressExpectedErrors = true;
  h.state.onQuery = ({name,order}) => {
    if (name === 'notificationQueue' && order?.[0] === 'startedAt') throw Error('synthetic recovery index unavailable');
  };
  await h.tick();
  assert.equal(h.state.errors.filter(([message]) => message === 'Interrupted notification recovery scan failed').length, 1);
  assert.equal(h.document(queueId).status, 'completed');
  assert.equal(h.state.sent.length, 1);
  interruptedDeliveryCases.push('recovery query failure leaves ordinary due delivery working');
}
{
  const h = setup(leaseTime), { queueId } = await h.enqueue();
  h.state.onAfterCommit = writes => {
    if (writes.some(([, values]) => values.dispatchIntent?.operationId)) h.setTime('2026-09-11T12:10:00+09:00');
  };
  await h.trigger(queueId);
  assert.equal(h.state.sent.length, 0);
  assert.match(h.document(queueId).dispatchIntent.operationId, /^[a-f0-9]{64}$/);
  await h.tick(); await h.trigger(queueId); await h.tick();
  assert.equal(h.document(queueId).deliveryVerificationRequired, true);
  assert.equal(h.state.sent.length, 0);
  interruptedDeliveryCases.push('an expired worker cannot send after resuming behind a committed intent');
}


const operationalStopCases = [];
const stopTime = '2026-09-11T12:00:00+09:00';
function productionFixture() {
  const h = setup(stopTime, { APP_ENVIRONMENT: 'production' }, false, true);
  const path = 'productionControls/company-a';
  h.state.records.set(path, { productionEnabled: true, emergencyLock: false, generation: 1 });
  const stop = () => h.state.records.set(path, { productionEnabled: false, emergencyLock: true, generation: 2 });
  return { h, path, stop };
}
for (const change of ['after-token-lookup', 'during-preparation', 'after-intent', 'generation-changed']) {
  const { h, path, stop } = productionFixture();
  const { queueId } = await h.enqueue();
  let changed = false;
  const transition = writes => {
    if (changed || !writes.some(([, values]) => values.dispatchIntent?.operationId)) return;
    changed = true;
    if (change === 'generation-changed') {
      h.state.records.set(path, { productionEnabled: true, emergencyLock: false, generation: 3 });
    } else stop();
  };
  if (change === 'after-token-lookup') h.state.onResolve = stop;
  if (change === 'during-preparation') h.state.onBeforeCommit = transition;
  if (change === 'after-intent' || change === 'generation-changed') h.state.onAfterCommit = transition;
  await h.trigger(queueId); await h.tick(); await h.trigger(queueId);
  const final = h.document(queueId);
  assert.equal(h.state.sent.length, 0, change);
  assert.equal(final.status, 'paused_global');
  assert.equal(final.pauseReason, change === 'generation-changed' ? 'production_control_changed' : 'emergency_lock');
  assert.equal(final.dispatchIntent ?? null, null);
  assert.equal(final.deliveryVerificationRequired, undefined);
  if (change === 'during-preparation') assert.ok(h.state.transactionRetries > 0);
  operationalStopCases.push(change);
}
{
  const { h, stop } = productionFixture();
  h.state.records.delete('pushTokens/target');
  for (let i = 0; i < 501; i++) h.state.records.set('pushTokens/device-' + String(i).padStart(4, '0'), {
    companyId: 'company-a', staffId: 'staff-a', active: true, token: 'synthetic-' + i,
  });
  const { queueId } = await h.enqueue();
  h.state.onSend = stop;
  await h.trigger(queueId); await h.tick();
  assert.deepEqual(h.state.sent.map(message => message.tokens.length), [500]);
  const final = h.document(queueId);
  assert.equal(final.status, 'paused_global');
  assert.equal(final.successCount, 500);
  assert.equal(final.processedTokenHashes.length, 500);
  assert.match(final.lastDispatchOperationId, /^[a-f0-9]{64}$/);
  assert.equal(final.dispatchIntent ?? null, null);
  operationalStopCases.push('between chunks, confirmed results preserved');
}
{
  const { h, stop } = productionFixture();
  stop();
  const { queueId } = await h.enqueue({ category: 'production_global_kill_switch', bypassQuietHours: true });
  await h.trigger(queueId); await h.tick();
  assert.equal(h.state.sent.length, 1);
  assert.equal(h.document(queueId).status, 'completed');
  operationalStopCases.push('existing emergency notice exception still works');
}
{
  const { h, path } = productionFixture();
  const { queueId } = await h.enqueue();
  h.state.onRead = file => {
    if (file === path && h.document(queueId).dispatchIntent?.operationId) throw Error('synthetic unreadable control');
  };
  await h.trigger(queueId); await h.tick();
  const final = h.document(queueId);
  assert.equal(h.state.sent.length, 0);
  assert.equal(final.status, 'error');
  assert.equal(final.deliveryVerificationRequired, true);
  assert.match(final.dispatchIntent.operationId, /^[a-f0-9]{64}$/);
  operationalStopCases.push('unreadable control preserves the unresolved intent');
}
{
  const { h, stop } = productionFixture();
  const { queueId } = await h.enqueue();
  let replaced = false;
  h.state.onAfterCommit = writes => {
    if (replaced || !writes.some(([, values]) => values.dispatchIntent?.operationId)) return;
    replaced = true;
    stop();
    h.document(queueId).dispatchIntent.operationId = 'e'.repeat(64);
  };
  await h.trigger(queueId); await h.tick();
  const final = h.document(queueId);
  assert.equal(replaced, true);
  assert.equal(h.state.sent.length, 0);
  assert.equal(final.dispatchIntent.operationId, 'e'.repeat(64));
  assert.equal(final.status, 'sending');
  operationalStopCases.push('replaced operation is never sent or cleared');
}


const accountTestCases = [];
const accountTestAt = '2026-09-11T12:00:00+09:00';
const staffAuthTime = Date.parse('2026-09-11T11:00:00+09:00') / 1000;
function pushAccountFixture(role) {
  const h = setup(accountTestAt);
  const companyId = 'company-a', uid = 'uid-a', staffId = 'staff-a';
  const token = role === 'staff' ? { companyId, role, staffId, auth_time: staffAuthTime } : { companyId, role };
  h.state.records.set('authIdentities/'+uid, { companyId, staffId, active: true });
  h.state.records.delete('pushTokens/target');
  const record = { companyId, uid, role, staffId: role === 'staff' ? staffId : null, active: true };
  for (const [name, override] of [
    ['owner', {}], ['owner-tablet', {}], ['other-user', { uid: 'uid-b' }],
    ['other-company', { companyId: 'company-b' }], ['other-role', { role: role === 'staff' ? 'admin' : 'staff' }],
    ['inactive', { active: false }],
    ...(role === 'staff' ? [['other-staff', { staffId: 'staff-b' }]] : []),
  ]) h.state.records.set('pushTokens/'+name, { ...record, ...override, token: 'synthetic-'+name });
  const { sendTestPush, getPushStatus } = h.load('./push-tokens');
  const auth = { uid, token };
  return { h, auth, send: () => sendTestPush({ auth, data: { targetUid: 'uid-b', targetRole: 'admin' } }), getPushStatus };
}
for (const role of ['staff','admin']) {
  const {h,auth,send,getPushStatus}=pushAccountFixture(role);
  const {queueId}=await send();
  await h.trigger(queueId); await h.tick();
  assert.deepEqual(h.state.sent.map(v=>v.tokens),[['synthetic-owner','synthetic-owner-tablet']],role);
  const queue=h.document(queueId);
  assert.equal(queue.targetUid,auth.uid);assert.equal(queue.targetStaffId,undefined);assert.equal(queue.targetRole,undefined);
  assert.equal(h.state.sent[0].data.requestedByUid,undefined);
  assert.equal((await getPushStatus({auth,data:{queueId}})).test.successCount,2);
  await assert.rejects(getPushStatus({auth:{...auth,uid:'uid-b'},data:{queueId}}),{code:'permission-denied'});
  accountTestCases.push('only the requesting account and compatible devices / '+role);
}
for (const role of ['staff','admin']) {
  const {h,auth,getPushStatus}=pushAccountFixture(role);
  const target=role==='staff'?{targetStaffId:'staff-a'}:{targetStaffId:undefined,targetRole:'admin'};
  const {queueId}=await h.enqueue({...target,category:role==='staff'?'push_test':'push_test_admin',data:{requestedByUid:auth.uid}});
  await h.trigger(queueId);await h.tick();
  assert.equal(h.state.sent.length,0);assert.equal(h.document(queueId).status,'superseded');
  const status=(await getPushStatus({auth,data:{queueId}})).test;
  assert.equal(status.finished,true);assert.equal(status.status,'error');
  accountTestCases.push('pending legacy broad test retired / '+role);
}
{
  const {h}=pushAccountFixture('admin');
  const {queueId}=await h.enqueue({targetStaffId:undefined,targetRole:'admin',category:'regular_announcement'});
  await h.trigger(queueId);
  assert.deepEqual(h.state.sent[0].tokens,['synthetic-other-user','synthetic-owner','synthetic-owner-tablet']);
  accountTestCases.push('ordinary company admin notification retains its configured group');
}
for (const phase of ['before-request','before-delivery','after-intent']) {
  const {h,send}=pushAccountFixture('staff');
  const revoke=()=>h.state.records.get('authIdentities/uid-a').revokedAt=h.Timestamp.fromMillis((staffAuthTime+1)*1000);
  if(phase==='before-request'){
    revoke();await assert.rejects(send(),{code:'permission-denied'});
    assert.equal([...h.state.records.keys()].filter(name=>name.startsWith('notificationQueue/')).length,0);
  }else{
    const {queueId}=await send();
    if(phase==='before-delivery')revoke();
    else h.state.onAfterCommit=writes=>{if(writes.some(([,values])=>values.dispatchIntent?.operationId))revoke();};
    await h.trigger(queueId);await h.tick();
    assert.equal(h.document(queueId).status,'superseded');
    assert.equal(h.document(queueId).dispatchIntent??null,null);
  }
  assert.equal(h.state.sent.length,0);
  accountTestCases.push('revoked staff session / '+phase);
}
{
  const {h,send}=pushAccountFixture('admin');
  const {queueId}=await send();
  h.document(queueId).data.requestedByUid='uid-b';
  await h.trigger(queueId);
  assert.equal(h.state.sent.length,0);assert.equal(h.document(queueId).status,'superseded');
  accountTestCases.push('mismatched server-side owner held');
}


{
  const {h,send}=pushAccountFixture('admin');
  const {queueId}=await send();
  h.state.onAfterCommit=writes=>{
    if(writes.some(([,values])=>values.dispatchIntent?.operationId)){
      h.state.records.get('pushTokens/owner').uid='uid-b';
    }
  };
  await h.trigger(queueId);await h.tick();
  assert.equal(h.state.sent.length,0);assert.equal(h.document(queueId).status,'superseded');
  assert.equal(h.document(queueId).dispatchIntent,null);
  accountTestCases.push('registration moved after intent, test cancelled without delivery');
}

console.log(JSON.stringify({ cases, quietRecovery, recipientBindingCases, interruptedDeliveryCases, operationalStopCases, accountTestCases, passed: true, realPush: false, cloudChanges: false, syntheticTransactionConflictsVerified: true, realSdkConcurrencyVerified: false }));


const finalRecipientChecks = [];
async function finalRecipientCase(name, run) {
  try {
    await run();
    finalRecipientChecks.push({ name, passed: true });
  } catch (error) {
    finalRecipientChecks.push({ name, passed: false, error: error.message });
  }
}
function afterIntent(h, change) {
  let pending;
  h.state.onAfterCommit = writes => {
    const intent = writes.find(([, values]) => values.dispatchIntent?.operationId)?.[1].dispatchIntent;
    if (pending || !intent) return;
    pending = intent;
    change();
  };
  return () => assert.ok(pending, 'change must occur after the initial intent has committed');
}
for (const [name, values] of Object.entries({
  inactive: { active: false },
  company: { companyId: 'company-b' },
  staff: { staffId: 'staff-b' },
  account: { uid: 'uid-b' },
  role: { role: 'admin' },
  session: { deviceSessionId: 'device-b' },
  token: { token: 'new-synthetic-token' },
  removed: null,
  unchangedOwner: {},
})) {
  await finalRecipientCase('ordinary notification after intent / ' + name, async () => {
    const h = setup('2026-09-11T12:00:00+09:00');
    const path = 'pushTokens/target';
    const original = { ...h.state.records.get(path), uid: 'uid-a', role: 'staff', deviceSessionId: 'device-a' };
    h.state.records.set(path, original);
    const { queueId } = await h.enqueue();
    const confirmed = afterIntent(h, () => {
      if (values === null) h.state.records.delete(path);
      else h.state.records.set(path, { ...original, ...values, updatedAt: h.Timestamp.now() });
    });
    const retained = name === 'unchangedOwner';
    await h.trigger(queueId);
    await h.tick();
    confirmed();
    assert.equal(h.state.sent.length, retained ? 1 : 0);
    assert.equal(h.document(queueId).status, retained ? 'completed' : 'no_tokens');
    assert.equal(h.document(queueId).dispatchIntent ?? null, null);
  });
}

for (const outcome of ['success', 'fcm response lost', 'narrowed intent response lost']) {
  await finalRecipientCase('mixed recipients after intent / ' + outcome, async () => {
    const h = setup('2026-09-11T12:00:00+09:00');
    const keeper = 'synthetic-still-current';
    h.state.records.set('pushTokens/still-current', {
      companyId: 'company-a', staffId: 'staff-a', uid: 'uid-a', role: 'staff', active: true, token: keeper,
    });
    const { queueId } = await h.enqueue();
    const writes = [];
    h.state.onAfterCommit = updates => {
      const intent = updates.find(([, values]) => values.dispatchIntent?.operationId)?.[1].dispatchIntent;
      if (!intent) return;
      writes.push({ operationId: intent.operationId, tokenHashes: Array.from(intent.tokenHashes) });
      if (writes.length === 1) {
        h.state.records.get('pushTokens/target').companyId = 'company-b';
      } else if (outcome === 'narrowed intent response lost') {
        throw new Error('synthetic acknowledgment lost after narrowed intent committed');
      }
    };
    const keepHash = crypto.createHash('sha256').update(keeper).digest('hex');
    h.state.onSend = () => {
      assert.equal(writes.length, 2);
      assert.deepEqual(h.document(queueId).dispatchIntent.tokenHashes, [keepHash]);
    };
    h.state.failSend = outcome === 'fcm response lost';
    await h.trigger(queueId);
    await h.tick();
    await h.trigger(queueId);
    const result = h.document(queueId);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].tokenHashes.length, 2);
    assert.deepEqual(writes[1].tokenHashes, [keepHash]);
    assert.notEqual(writes[0].operationId, writes[1].operationId);
    assert.deepEqual(h.state.sent.map(item => item.tokens), outcome === 'narrowed intent response lost' ? [] : [[keeper]]);
    if (outcome === 'success') {
      assert.equal(result.status, 'completed');
      assert.equal(result.successCount, 1);
      assert.deepEqual(result.processedTokenHashes, [keepHash]);
      assert.equal(result.lastDispatchOperationId, writes[1].operationId);
      assert.equal(result.dispatchIntent, null);
    } else {
      assert.equal(result.status, 'error');
      assert.equal(result.deliveryVerificationRequired, true);
      assert.equal(result.dispatchIntent.operationId, writes[1].operationId);
      assert.deepEqual(result.dispatchIntent.tokenHashes, [keepHash]);
    }
  });
}
console.log(JSON.stringify({
  total: finalRecipientChecks.length, passed: finalRecipientChecks.filter(result => result.passed).length, results: finalRecipientChecks,
}));
if (finalRecipientChecks.some(result => !result.passed)) process.exitCode = 1;


function boundPushFixture() {
  const h = setup('2026-09-11T12:00:00+09:00');
  const companyId = 'company-a', staffId = 'staff-a', uid = 'uid-a';
  const authTime = Math.floor(h.Timestamp.now().toMillis() / 1000);
  const auth = {
    companyId, staffId, role: 'staff', auth_time: authTime,
  };
  const device = (hex) => ({
    sessionId: 'device_' + hex.repeat(28), generation: hex.repeat(48), token: 'synthetic-device-token-' + hex.repeat(20),
  });
  const a = device('a'), b = device('b');
  h.state.records.set('staffProfiles/' + staffId, { companyId, active: true, deviceBoundAuthRequired: true });
  const identity = { companyId, staffId, active: true, deviceCredentials: {} };
  h.state.records.set('authIdentities/' + uid, identity);
  for (const client of [a, b]) {
    identity.deviceCredentials[client.sessionId] = client.generation;
    client.auth = { uid, token: { ...auth, crewDeviceSession: client.sessionId, crewDeviceGeneration: client.generation } };
    h.state.records.set('deviceSessions/' + client.sessionId, {
      companyId, staffId, uid, active: true, credentialGeneration: client.generation,
    });
  }
  // 端末認証を必須にする前の登録だけが残っている状態も再現する。
  h.state.records.set('pushTokens/target', {
    companyId, staffId, uid, role: 'staff', active: true, token: 'synthetic-legacy-token',
  });
  const { registerPushToken, unregisterPushToken, getPushStatus, sendTestPush } = h.load('./push-tokens');
  return {
    h, a, b,
    register: (actor, target = actor) => registerPushToken({
      auth: actor.auth, data: { token: target.token, deviceSessionId: target.sessionId },
    }),
    remove: (actor, target = actor) => unregisterPushToken({ auth: actor.auth, data: { token: target.token } }),
    status: (actor, queueId) => getPushStatus({ auth: actor.auth, data: { queueId } }),
    test: (actor) => sendTestPush({ auth: actor.auth, data: {} }),
    revoke: (client) => {
      const record = h.state.records.get('deviceSessions/' + client.sessionId);
      record.active = false;
      identity.deviceCredentials[client.sessionId] = null;
    },
    legacy: { auth: { uid, token: auth } },
  };
}

const devicePushChecks = [];
async function devicePushCase(name, run) {
  await run();
  devicePushChecks.push(name);
}
await devicePushCase('notification registration and status only see the signed device', async () => {
  const f = boundPushFixture();
  await assert.rejects(f.register(f.a, f.b), { code: 'permission-denied' });
  await assert.rejects(f.register(f.legacy, f.a), { code: 'permission-denied' });
  await f.register(f.a);
  await f.register(f.b);
  assert.deepEqual(Array.from((await f.status(f.a)).tokens, r => r.deviceSessionId), [f.a.sessionId]);
  assert.deepEqual(Array.from((await f.status(f.b)).tokens, r => r.deviceSessionId), [f.b.sessionId]);
  await assert.rejects(f.remove(f.a, f.b), { code: 'permission-denied' });
  await f.remove(f.a);
  assert.equal((await f.status(f.a)).enabled, false);
  assert.equal((await f.status(f.b)).enabled, true);
  f.revoke(f.a);
  for (const action of [() => f.register(f.a), () => f.remove(f.a, f.b), () => f.status(f.a), () => f.test(f.a)]) {
    await assert.rejects(action(), { code: 'permission-denied' });
  }
  assert.equal((await f.status(f.b)).enabled, true);
});

await devicePushCase('regular notification excludes old and inconsistently bound registrations', async () => {
  const f = boundPushFixture();
  await f.register(f.a);
  const { tokenId } = await f.register(f.b);
  f.h.state.records.get('pushTokens/' + tokenId).deviceSessionId = f.a.sessionId;
  const { queueId } = await f.h.enqueue();
  await f.h.trigger(queueId);
  assert.deepEqual(f.h.state.sent.map(item => item.tokens), [[f.a.token]]);
});

for (const disconnect of ['before-intent', 'after-intent']) {
  await devicePushCase('revoked tablet is excluded / ' + disconnect, async () => {
    const f = boundPushFixture();
    await f.register(f.a);
    await f.register(f.b);
    const { queueId } = await f.h.enqueue();
    if (disconnect === 'before-intent') f.revoke(f.a);
    else f.h.state.onAfterCommit = writes => {
      if (writes.some(([, values]) => values.dispatchIntent?.operationId)) f.revoke(f.a);
    };
    const expectedHash = crypto.createHash('sha256').update(f.b.token).digest('hex');
    f.h.state.onSend = () => assert.deepEqual(f.h.document(queueId).dispatchIntent.tokenHashes, [expectedHash]);
    await f.h.trigger(queueId);
    await f.h.tick();
    assert.deepEqual(f.h.state.sent.map(item => item.tokens), [[f.b.token]]);
    const row = f.h.document(queueId);
    assert.equal(row.status, 'completed');
    assert.deepEqual(row.processedTokenHashes, [expectedHash]);
    assert.equal(row.dispatchIntent, null);
  });
}

await devicePushCase('test push is scoped to the requesting device and its result stays private', async () => {
  const f = boundPushFixture();
  await f.register(f.a);
  await f.register(f.b);
  const { queueId } = await f.test(f.a);
  const other = await f.test(f.b);
  assert.notEqual(queueId, other.queueId);
  await f.h.trigger(queueId);
  assert.deepEqual(f.h.state.sent.map(item => item.tokens), [[f.a.token]]);
  assert.equal(f.h.state.sent[0].data.crewDeviceGeneration, undefined);
  assert.equal((await f.status(f.a, queueId)).test.successCount, 1);
  await assert.rejects(f.status(f.b, queueId), { code: 'permission-denied' });
});

await devicePushCase('test push never falls back to another device after the requester is stopped', async () => {
  const f = boundPushFixture();
  await f.register(f.a);
  await f.register(f.b);
  const { queueId } = await f.test(f.a);
  const checkIntent = afterIntent(f.h, () => f.revoke(f.a));
  await f.h.trigger(queueId);
  checkIntent();
  assert.equal(f.h.state.sent.length, 0);
  assert.equal(f.h.document(queueId).status, 'superseded');
  assert.equal(f.h.document(queueId).dispatchIntent, null);
});

await devicePushCase('malformed test device grant is held', async () => {
  const f = boundPushFixture();
  await f.register(f.a);
  const { queueId } = await f.test(f.a);
  f.h.document(queueId).testRequest.deviceCredential.crewDeviceGeneration = 'malformed';
  await f.h.trigger(queueId);
  assert.equal(f.h.state.sent.length, 0);
  assert.equal(f.h.document(queueId).status, 'superseded');
});
console.log(JSON.stringify({ devicePushChecks, passed: devicePushChecks.length, realPush: false }));
