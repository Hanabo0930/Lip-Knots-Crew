import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const dependency = createRequire(process.env.LKC_TEST_DEPENDENCY_ROOT ? path.join(process.env.LKC_TEST_DEPENDENCY_ROOT, 'package.json') : import.meta.url);
const ts = dependency('typescript');
const source = fs.readFileSync(process.env.LKC_TEST_IMPORT_SOURCE ?? new URL('../functions/src/shift-import.ts', import.meta.url), 'utf8');
const start = source.indexOf('async function writeJobsAndLocks(');
const end = source.indexOf('async function acquireSyncLock(', start);
assert.ok(start >= 0 && end > start);
const code = ts.transpileModule(source.slice(start, end) + '\nexports.writeJobsAndLocks = writeJobsAndLocks;', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const deleted = '__synthetic_delete__';
const companyId = 'synthetic-company', staffId = 'staff-a', dateKey = '2026-09-20';
const lockPath = (staff = staffId, date = dateKey) => `staffDayLocks/${companyId}_${staff}_${date}`;
const ownLock = (patch = {}) => ({ companyId, staffId, dateKey, jobId: 'job-a', active: true, ...patch });
const oldJob = (patch = {}) => ({ companyId, assignedStaffId: staffId, dateKey, status: 'assigned', cancelled: false, ...patch });
const incoming = (patch = {}) => ({
  jobId: 'job-a', caseId: 'case-a', companyId, sourceIdentityKey: 'synthetic-source', identityFingerprint: 'synthetic-fingerprint', sourceOccurrence: 1,
  dateKey, workDate: dateKey, assignedStaffName: 'Staff A', rawStaffName: 'Staff A', status: 'assigned', cancelled: false,
  clientName: 'Synthetic', rawClientName: 'Synthetic', storeName: 'Synthetic', makerName: '', menuName: '', menuConditions: [], entryTime: '', workTime: '', subcontractorName: '', materialStatus: '', publishable: false, recruitmentStopped: false, cancellationReason: '', basePay: null,
  financials: { clientChargeTotal: null, clientChargeAdditionsTotal: null, staffPaymentTotal: null, subcontractorTotal: null },
  expenses: { transportation: null, purchase8: null, purchase10: null, netPrintCost: null, postageCost: null }, preContact: null,
  sheetRef: { spreadsheetId: 'synthetic-sheet', sheetId: 1, sheetName: '2099.1', currentRow: 2, headerRow: 1 }, importWarnings: [], ...patch,
});
const names = new Map([['StaffA', staffId], ['StaffB', 'staff-b']]);
function harness(entries = [], options = {}) {
  const records = new Map(entries.map(([key, value]) => [key, structuredClone(value)]));
  const commits = [], attempts = [];
  let retried = false;
  const snapshot = (ref) => ({ id: ref.id, exists: records.has(ref.path), data: () => structuredClone(records.get(ref.path)) });
  const validate = (value) => { assert.notEqual(value, undefined, 'undefined Firestore field'); if (value && typeof value === 'object') for (const child of Object.values(value)) validate(child); };
  const apply = (pending) => {
    for (const item of pending) validate(item.data);
    for (const item of pending) {
      const value = { ...(item.merge ? records.get(item.path) : {}), ...structuredClone(item.data) };
      for (const [key, field] of Object.entries(value)) if (field === deleted) delete value[key];
      records.set(item.path, value);
    }
    commits.push(pending);
  };
  const createWriter = (pending) => ({ set: (ref, data, options) => pending.push({ path: ref.path, data: structuredClone(data), merge: options?.merge === true }) });
  const db = {
    collection: (name) => ({ doc: (id) => ({ id, path: `${name}/${id}` }) }),
    getAll: async (...refs) => refs.map(snapshot),
    batch: () => { const pending = []; return { ...createWriter(pending), commit: async () => apply(pending) }; },
    runTransaction: async (callback) => {
      for (;;) {
        const pending = [], reads = [];
        attempts.push({ pending, reads });
        const result = await callback({ ...createWriter(pending), getAll: async (...refs) => {
          assert.equal(pending.length, 0, 'All transaction reads must precede writes');
          reads.push(...refs.map(ref => ref.path));
          if (options.missingReadCollection && refs.some(ref => ref.path.startsWith(options.missingReadCollection + '/'))) return [];
          return refs.map(snapshot);
        } });
        if (options.beforeRetry && !retried) { retried = true; options.beforeRetry(records); continue; }
        if (options.failCommit) throw new Error('synthetic commit failure');
        apply(pending); return result;
      }
    },
  };
  const exports = {};
  runInNewContext(code, { exports, db, HttpsError, Timestamp: { now: () => 12345 }, FieldValue: { delete: () => deleted }, normalizeName: name => name.normalize('NFKC').replace(/[\s　]+/g, '').trim() }, { timeout: 3000 });
  return { records, commits, attempts, run: (jobs, index = names) => exports.writeJobsAndLocks(jobs, index, 'synthetic-run') };
}
const baseEntries = () => [['jobs/job-a', oldJob()], [lockPath(), ownLock()]];
let passed = 0;
async function test(label, callback) { try { await callback(); passed++; } catch (error) { error.message = `${label}: ${error.message}`; throw error; } }
await test('cancellation must retain another job lock', async () => {
  const other = ownLock({ jobId: 'job-b' });
  const h = harness([['jobs/job-a', oldJob()], [lockPath(), other]]);
  assert.equal(await h.run([incoming({ status: 'cancelled', cancelled: true })]), 1);
  assert.deepEqual(h.records.get(lockPath()), other);
  assert.equal(h.records.get('jobs/job-a').cancelled, true);
});
await test('own cancellation releases only own lock', async () => {
  const h = harness(baseEntries());
  assert.equal(await h.run([incoming({ status: 'cancelled', cancelled: true })]), 2);
  assert.equal(h.records.get(lockPath()).active, false);
});
await test('date change releases old date and acquires new date atomically', async () => {
  const h = harness(baseEntries());
  assert.equal(await h.run([incoming({ dateKey: '2026-09-21', workDate: '2026-09-21' })]), 3);
  assert.equal(h.records.get(lockPath()).active, false);
  assert.equal(h.records.get(lockPath(staffId, '2026-09-21')).active, true);
  assert.equal(h.commits.length, 1);
});
await test('staff change releases old staff', async () => {
  const h = harness(baseEntries()); await h.run([incoming({ assignedStaffName: 'Staff B' })]);
  assert.equal(h.records.get(lockPath()).active, false);
  assert.equal(h.records.get(lockPath('staff-b')).jobId, 'job-a');
});
await test('same assignment uses unique lock read', async () => {
  const h = harness(baseEntries()); assert.equal(await h.run([incoming()]), 2);
  assert.equal(h.attempts[0].reads.filter(value => value === lockPath()).length, 1);
});
await test('new lock collision preserves job and old lock', async () => {
  const entries = [...baseEntries(), [lockPath('staff-b'), ownLock({ staffId: 'staff-b', jobId: 'job-b' })]];
  const h = harness(entries);
  await assert.rejects(h.run([incoming({ assignedStaffName: 'Staff B' })]), { code: 'failed-precondition' });
  assert.equal(h.commits.length, 0); assert.deepEqual([...h.records], entries);
});
await test('inactive matching-tenant lock can be reused', async () => {
  const h = harness([[lockPath(), ownLock({ jobId: 'job-b', active: false })]]);
  await h.run([incoming()]); assert.equal(h.records.get(lockPath()).jobId, 'job-a');
});
for (const patch of [{ companyId: 'other' }, { staffId: 'other' }, { dateKey: '2099-01-01' }, { active: undefined }, { jobId: undefined }]) {
  await test(`ambiguous destination ${JSON.stringify(patch)}`, async () => {
    const h = harness([['jobs/job-a', oldJob()], [lockPath(), ownLock(patch)]]);
    await assert.rejects(h.run([incoming()]), { code: 'failed-precondition' }); assert.equal(h.commits.length, 0);
  });
}
await test('missing old lock is not fabricated', async () => {
  const h = harness([['jobs/job-a', oldJob()]]); await h.run([incoming({ cancelled: true, status: 'cancelled' })]);
  assert.equal(h.records.has(lockPath()), false);
});
await test('foreign old lock remains untouched on cancellation', async () => {
  const lock = ownLock({ companyId: 'other' }); const h = harness([['jobs/job-a', oldJob()], [lockPath(), lock]]);
  await h.run([incoming({ cancelled: true, status: 'cancelled' })]); assert.deepEqual(h.records.get(lockPath()), lock);
});
await test('existing foreign-company job rejects import', async () => {
  const h = harness([['jobs/job-a', oldJob({ companyId: 'other' })]]);
  await assert.rejects(h.run([incoming()]), { code: 'permission-denied' }); assert.equal(h.commits.length, 0);
});
await test('missing old date prevents unsafe movement', async () => {
  const h = harness([['jobs/job-a', oldJob({ dateKey: null })]]);
  await assert.rejects(h.run([incoming()]), { code: 'failed-precondition' }); assert.equal(h.commits.length, 0);
});
await test('preserve app cancellation while sheet lags', async () => {
  const override = { type: 'cancel', active: true };
  const h = harness([['jobs/job-a', oldJob({ cancelled: true, status: 'cancelled', appOverride: override })], [lockPath(), ownLock({ active: false })]]);
  await h.run([incoming()]); assert.equal(h.records.get('jobs/job-a').cancelled, true); assert.deepEqual(h.records.get('jobs/job-a').appOverride, override);
  assert.equal(h.records.get(lockPath()).active, false);
});
await test('matching sheet cancellation clears app override', async () => {
  const h = harness([['jobs/job-a', oldJob({ cancelled: true, status: 'cancelled', appOverride: { type: 'cancel', active: true } })]]);
  await h.run([incoming({ cancelled: true, status: 'cancelled' })]); assert.equal('appOverride' in h.records.get('jobs/job-a'), false);
});
await test('preserve app restore while sheet lags', async () => {
  const h = harness([['jobs/job-a', oldJob({ appOverride: { type: 'restore', active: true } })], [lockPath(), ownLock()]]);
  await h.run([incoming({ cancelled: true, status: 'cancelled' })]); assert.equal(h.records.get('jobs/job-a').cancelled, false); assert.equal(h.records.get(lockPath()).active, true);
});
for (const patch of [{ assignedStaffName: '', status: 'open' }, { assignedStaffName: 'Staff B' }, { dateKey: '2026-09-21' }]) {
  await test(`pending application survives stale sheet ${JSON.stringify(patch)}`, async () => {
    const h = harness([['jobs/job-a', oldJob({ applicationUnconfirmed: true })], [lockPath(), ownLock()]]);
    await assert.rejects(h.run([incoming(patch)]), { code: 'failed-precondition' }); assert.equal(h.commits.length, 0);
  });
}
await test('matching sheet acknowledges application without freeing its lock', async () => {
  const h = harness([['jobs/job-a', oldJob({ applicationUnconfirmed: true })], [lockPath(), ownLock()]]);
  await h.run([incoming()]); assert.equal(h.records.get('jobs/job-a').applicationUnconfirmed, false); assert.equal(h.records.get(lockPath()).active, true);
});
await test('explicit cancellation outranks pending application', async () => {
  const h = harness([['jobs/job-a', oldJob({ applicationUnconfirmed: true })], [lockPath(), ownLock()]]);
  await h.run([incoming({ cancelled: true, status: 'cancelled' })]); assert.equal(h.records.get(lockPath()).active, false);
});
await test('retry sees concurrent application and discards stale writes', async () => {
  const h = harness([['jobs/job-a', oldJob({ status: 'open', assignedStaffId: null })]], { beforeRetry: records => {
    records.set('jobs/job-a', oldJob({ applicationUnconfirmed: true })); records.set(lockPath(), ownLock());
  } });
  await assert.rejects(h.run([incoming({ assignedStaffName: '', status: 'open' })]), { code: 'failed-precondition' });
  assert.equal(h.attempts.length, 2); assert.equal(h.commits.length, 0); assert.equal(h.records.get(lockPath()).active, true);
});
await test('retry sees destination taken by another job', async () => {
  const h = harness([], { beforeRetry: records => records.set(lockPath(), ownLock({ jobId: 'job-b' })) });
  await assert.rejects(h.run([incoming()]), { code: 'failed-precondition' }); assert.equal(h.commits.length, 0); assert.equal(h.records.has('jobs/job-a'), false);
});
await test('successful retry counts committed writes only', async () => {
  const h = harness([], { beforeRetry: () => {} }); assert.equal(await h.run([incoming()]), 2); assert.equal(h.attempts.length, 2); assert.equal(h.commits.length, 1);
});
await test('failed commit leaves all three documents unchanged', async () => {
  const entries = baseEntries(); const h = harness(entries, { failCommit: true });
  await assert.rejects(h.run([incoming({ dateKey: '2026-09-21' })]), /synthetic commit failure/); assert.deepEqual([...h.records], entries);
});
await test('duplicate job IDs fail before any write', async () => {
  const h = harness(); await assert.rejects(h.run([incoming(), incoming()]), { code: 'failed-precondition' }); assert.equal(h.commits.length, 0);
});
await test('duplicate staff-day inside chunk fails atomically', async () => {
  const h = harness(); await assert.rejects(h.run([incoming(), incoming({ jobId: 'job-b' })]), { code: 'failed-precondition' }); assert.equal(h.commits.length, 0);
});
for (const count of [0, 1, 25, 26, 351]) {
  await test(`chunk boundary ${count}`, async () => {
    const jobs = Array.from({ length: count }, (_, index) => incoming({ jobId: `job-${index}`, assignedStaffName: `Staff${index}` }));
    const index = new Map(jobs.map((job, id) => [job.assignedStaffName, `staff-${id}`]));
    const h = harness(); assert.equal(await h.run(jobs, index), count * 2); assert.equal(h.commits.length, Math.ceil(count / 25));
    for (const commit of h.commits) { assert.ok(commit.length <= 75); for (const item of commit.filter(item => item.path.startsWith('jobs/'))) assert.ok(commit.some(lock => lock.data.jobId === item.path.slice(5))); }
  });
}
await test('later chunk conflict retains earlier complete chunks only', async () => {
  const jobs = Array.from({ length: 27 }, (_, index) => incoming({ jobId: `job-${index}`, assignedStaffName: `Staff${index}` }));
  const index = new Map(jobs.map((job, id) => [job.assignedStaffName, `staff-${id}`]));
  const h = harness([[lockPath('staff-25'), ownLock({ staffId: 'staff-25', jobId: 'occupied' })]]);
  await assert.rejects(h.run(jobs, index), { code: 'failed-precondition' }); assert.equal(h.commits.length, 1);
  assert.equal(h.records.has('jobs/job-24'), true); assert.equal(h.records.has('jobs/job-25'), false); assert.equal(h.records.has('jobs/job-26'), false);
});
for (const collection of ['jobs', 'staffDayLocks']) {
  await test(`incomplete ${collection} read stops before writes`, async () => {
    const entries = baseEntries();
    const h = harness(entries, { missingReadCollection: collection });
    await assert.rejects(h.run([incoming()]), { code: 'internal' });
    assert.equal(h.commits.length, 0); assert.deepEqual([...h.records], entries);
  });
}
const configStart = source.indexOf('const ColumnSchema =');
const configEnd = source.indexOf('type ImportMode =', configStart);
const loaderStart = source.indexOf('async function loadConfig(');
const loaderEnd = source.indexOf('async function buildStaffNameIndex(', loaderStart);
assert.ok(configStart >= 0 && configEnd > configStart && loaderStart >= 0 && loaderEnd > loaderStart);
const configCode = ts.transpileModule(source.slice(configStart, configEnd) + source.slice(loaderStart, loaderEnd) + '\nexports.loadConfig = loadConfig;', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const validConfig = { enabled: false, spreadsheetId: 'synthetic-spreadsheet', columns: { workDate: 'A', staffName: 'B', clientName: 'J', storeName: 'K', makerName: 'L', menuName: 'M', workTime: 'O' } };
for (const [label, saved, shouldReject] of [
  ['foreign company setting', { ...validConfig, companyId: 'other-company' }, true],
  ['matching company setting', { ...validConfig, companyId }, false],
  ['legacy setting without company field', validConfig, false],
  ['missing setting', null, true],
  ['invalid setting', { companyId, enabled: true }, true],
]) {
  await test(label, async () => {
    const exports = {};
    runInNewContext(configCode, { exports, HttpsError, z: dependency('zod').z, db: { collection: name => {
      assert.equal(name, 'sheetImportConfigs'); return { doc: id => {
        assert.equal(id, companyId); return { get: async () => ({ exists: saved !== null, data: () => saved }) };
      } };
    } } }, { timeout: 3000 });
    if (shouldReject) await assert.rejects(exports.loadConfig(companyId), { code: 'failed-precondition' });
    else assert.equal((await exports.loadConfig(companyId)).companyId, companyId);
  });
}
console.log(`Shift import transaction: ${passed} cases passed (SDK boundary mocks; no external writes).`);
