import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const requireDependency = createRequire(process.env.LKC_TEST_DEPENDENCY_ROOT ? path.join(process.env.LKC_TEST_DEPENDENCY_ROOT, 'package.json') : import.meta.url);
const ts = requireDependency('typescript');
const { z } = requireDependency('zod');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const companyId = 'synthetic-company';
const staffId = 'synthetic-staff';
const dateKey = '2026-09-20';
const lockPath = `staffDayLocks/${companyId}_${staffId}_${dateKey}`;
const ownLock = { companyId, staffId, dateKey, jobId: 'old-job', active: true };
let passed = 0;
for (const moduleName of ['jobs', 'analytics']) {
  const source = fs.readFileSync(new URL(`../functions/src/${moduleName}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  function setup(lock, jobPatch = {}) {
    const records = new Map([['jobs/old-job', { companyId, assignedStaffId: staffId, dateKey, status: 'assigned', ...jobPatch }]]);
    if (lock) records.set(lockPath, { ...lock });
    let generated = 0;
    const committed = [];
    const reads = [];
    const ref = (collection, id) => ({ path: `${collection}/${id ?? `generated-${++generated}`}` });
    const db = { collection: (name) => ({ doc: (id) => ref(name, id) }), runTransaction: async (callback) => {
      const pending = [];
      const result = await callback({
        get: async (reference) => {
          assert.equal(pending.length, 0, 'Firestore reads must precede every transaction write');
          reads.push(reference.path);
          return { exists: records.has(reference.path), data: () => records.get(reference.path) };
        },
        update: (reference, data) => pending.push({ path: reference.path, data, merge: true }),
        set: (reference, data, options) => pending.push({ path: reference.path, data, merge: options?.merge === true }),
      });
      for (const entry of pending) records.set(entry.path, entry.merge ? { ...records.get(entry.path), ...entry.data } : entry.data);
      committed.push(...pending);
      return result;
    } };
    const mocks = {
      'firebase-functions/v2/https': { onCall: (handler) => handler, HttpsError },
      'firebase-admin/firestore': { FieldValue: {}, Timestamp: { now: () => ({ toMillis: () => 1234 }) } },
      zod: { z }, './firebase': { db },
      './utils': { requireAdmin: (request) => { if (request.auth?.token.role !== 'admin') throw new HttpsError('permission-denied', 'admin required'); return request.auth; }, companyFromClaims: (token) => token.companyId },
      './analytics-core': { cancellationReasonLabels: { other: 'その他' }, cancellationTreatmentLabels: { neither: 'なし' } },
      './notification-core': { queueDocumentData: (input) => input },
      './system-safety': { assertProductionOperational: async () => {} },
    };
    const exports = {};
    runInNewContext(compiled, { exports, require: (name) => { assert.ok(Object.hasOwn(mocks, name), `Unexpected import ${name}`); return mocks[name]; } }, { timeout: 3000 });
    const cancel = (role = 'admin') => exports[moduleName === 'jobs' ? 'adminCancelJob' : 'adminSetJobCancellation']({ auth: { uid: 'synthetic-admin', token: { companyId, role } }, data: { jobId: 'old-job', reason: '合成取消', reasonCategory: 'other', financialTreatment: 'neither' } });
    return { records, committed, reads, cancel };
  }
  for (const [label, lock, release] of [
    ['own active lock', ownLock, true],
    ['another job lock', { ...ownLock, jobId: 'new-job' }, false],
    ['missing lock', null, false],
    ['missing owner', { companyId, staffId, dateKey, active: true }, false],
    ['other company', { ...ownLock, companyId: 'other' }, false],
    ['other staff', { ...ownLock, staffId: 'other' }, false],
    ['other date', { ...ownLock, dateKey: '2026-09-21' }, false],
    ['inactive lock', { ...ownLock, active: false }, false],
  ]) {
    const test = setup(lock);
    await test.cancel();
    assert.equal(test.records.get('jobs/old-job').cancelled, true, label);
    assert.equal(test.committed.filter(item => item.path === lockPath).length, release ? 1 : 0, label);
    if (release) assert.equal(test.records.get(lockPath).active, false, label);
    else assert.deepEqual(test.records.get(lockPath), lock ?? undefined, label);
    assert.equal(test.committed.filter(item => item.path.startsWith('sheetSyncQueue/')).length, 1);
    assert.equal(test.committed.filter(item => item.path.startsWith('notificationQueue/')).length, 1);
    passed++;
  }
  {
    const test = setup(ownLock);
    await test.cancel();
    test.records.set(lockPath, { ...ownLock, jobId: 'new-job' });
    const before = test.committed.length;
    await test.cancel();
    assert.equal(test.records.get(lockPath).active, true, 'recancelling old job must retain newly assigned shift');
    assert.equal(test.records.get(lockPath).jobId, 'new-job');
    assert.equal(test.committed.slice(before).filter(item => item.path === lockPath).length, 0);
    passed++;
  }
  for (const [patch, role] of [[{ companyId: 'other' }, 'admin'], [{}, 'staff']]) {
    const test = setup(ownLock, patch);
    await assert.rejects(test.cancel(role), { code: moduleName === 'analytics' && patch.companyId ? 'not-found' : 'permission-denied' });
    assert.equal(test.committed.length, 0);
    assert.equal(test.records.get(lockPath).active, true);
    passed++;
  }
  {
    const test = setup(ownLock, { assignedStaffId: null });
    await test.cancel();
    assert.deepEqual(test.reads, ['jobs/old-job']);
    assert.deepEqual(test.records.get(lockPath), ownLock);
    passed++;
  }
}
console.log(`Cancellation lock ownership: ${passed} cases passed (SDK mocks; no external writes).`);
