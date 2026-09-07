import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const dependency = createRequire(process.env.LKC_TEST_DEPENDENCY_ROOT ? path.join(process.env.LKC_TEST_DEPENDENCY_ROOT, 'package.json') : import.meta.url);
const ts = dependency('typescript');
const source = fs.readFileSync(new URL('../functions/src/job-management.ts', import.meta.url), 'utf8');
const schemaStart = source.indexOf('const EditSchema =');
const schemaEnd = source.indexOf('export const createAdminJobGroup', schemaStart);
const handlerStart = source.indexOf('export const adminEditJobInputs');
const handlerEnd = source.indexOf('export const generateJobExport', handlerStart);
assert.ok(schemaStart >= 0 && schemaEnd > schemaStart && handlerStart >= 0 && handlerEnd > handlerStart);
const code = ts.transpileModule(source.slice(schemaStart, schemaEnd) + source.slice(handlerStart, handlerEnd), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const companyId = 'company-a', dateKey = '2026-09-20';
const oldPath = `staffDayLocks/${companyId}_staff-a_${dateKey}`;
const newPath = `staffDayLocks/${companyId}_staff-b_${dateKey}`;
const ownLock = { companyId, staffId: 'staff-a', dateKey, jobId: 'job-a', active: true };
function setup(lock, options = {}) {
  const records = new Map([
    ['jobs/job-a', { companyId, assignedStaffId: 'staff-a', dateKey, status: 'assigned', revision: 1, ...options.job }],
    ['staffProfiles/staff-b', { companyId, active: true, displayName: 'Synthetic B' }],
    ['staffProfiles/staff-a', { companyId, active: true, displayName: 'Synthetic A' }],
  ]);
  if (lock) records.set(oldPath, { ...lock });
  if (options.newLock) records.set(newPath, options.newLock);
  const commits = [], attempts = [], audits = [];
  let retried = false;
  const snapshot = ref => ({ exists: records.has(ref.path), data: () => structuredClone(records.get(ref.path)) });
  const db = {
    collection: name => ({ doc: (id = 'generated') => ({ id, path: `${name}/${id}`, get: async () => { assert.equal(name, 'sheetWriteMappings'); return { exists: false }; } }) }),
    runTransaction: async callback => {
      for (;;) {
        const writes = [], reads = [];
        attempts.push({ writes, reads });
        const result = await callback({
          get: async ref => { assert.equal(writes.length, 0, 'reads must precede all writes'); reads.push(ref.path); return snapshot(ref); },
          set: (ref, data) => writes.push({ path: ref.path, data: structuredClone(data) }),
        });
        if (options.retry && !retried) { retried = true; options.retry(records); continue; }
        for (const write of writes) records.set(write.path, { ...records.get(write.path), ...write.data });
        commits.push(writes); return result;
      }
    },
  };
  const exports = {};
  runInNewContext(code, {
    exports, db, z: dependency('zod').z, HttpsError, onCall: callback => callback,
    requireAdmin: request => { if (request.auth.token.role !== 'admin') throw new HttpsError('permission-denied', 'admin required'); return request.auth; },
    companyFromClaims: token => token.companyId, assertProductionOperational: async () => {},
    Timestamp: { now: () => 12345 }, FieldValue: { delete: () => '__deleted__' },
    normalizeMoneyRecord: () => ({ errors: [], values: {} }), clientInputKeys: [], staffInputKeys: [],
    buildExpected: () => { throw new Error('Unexpected sheet queue'); }, writeAudit: async (...args) => audits.push(args),
  }, { timeout: 3000 });
  return { records, commits, attempts, audits, run: (fields, revision = 1, role = 'admin') => exports.adminEditJobInputs({ auth: { uid: 'synthetic-admin', token: { companyId, role } }, data: { jobId: 'job-a', fields, revision } }) };
}
let passed = 0;
for (const assignedStaffId of [null, 'staff-b']) {
  for (const [name, lock, release] of [
    ['other-job', { ...ownLock, jobId: 'job-b' }, false],
    ['own', ownLock, true], ['missing', null, false], ['inactive', { ...ownLock, active: false }, false],
    ['missing-owner', { active: true }, false], ['foreign-company', { ...ownLock, companyId: 'other' }, false],
    ['foreign-staff', { ...ownLock, staffId: 'other' }, false], ['wrong-date', { ...ownLock, dateKey: '2099-01-01' }, false],
  ]) {
    const test = setup(lock); await test.run({ assignedStaffId });
    const writes = test.commits.flat().filter(write => write.path === oldPath);
    assert.equal(writes.length, release ? 1 : 0, `${name}/${assignedStaffId}`);
    if (release) assert.equal(test.records.get(oldPath).active, false);
    else assert.deepEqual(test.records.get(oldPath), lock ?? undefined);
    if (assignedStaffId) assert.equal(test.records.get(newPath).active, true);
    assert.equal(test.audits.length, 1); passed++;
  }
}
for (const fields of [{ storeAddress: 'Synthetic' }, { assignedStaffId: 'staff-a' }]) {
  const test = setup(ownLock); await test.run(fields);
  assert.equal(test.attempts[0].reads.filter(value => value === oldPath).length, fields.assignedStaffId ? 1 : 0);
  assert.equal(test.records.get(oldPath).active, true); passed++;
}
for (const [revision, role] of [[0, 'admin'], [1, 'staff']]) {
  const test = setup(ownLock); await assert.rejects(test.run({ assignedStaffId: null }, revision, role));
  assert.equal(test.commits.length, 0); assert.equal(test.audits.length, 0); passed++;
}
{
  const test = setup(ownLock, { newLock: { ...ownLock, staffId: 'staff-b', jobId: 'occupied' } });
  await assert.rejects(test.run({ assignedStaffId: 'staff-b' }), { code: 'failed-precondition' });
  assert.equal(test.commits.length, 0); assert.equal(test.records.get(oldPath).active, true); passed++;
}
{
  const other = { ...ownLock, jobId: 'new-job' };
  const test = setup(ownLock, { retry: records => records.set(oldPath, other) });
  await test.run({ assignedStaffId: null }); assert.equal(test.attempts.length, 2);
  assert.deepEqual(test.records.get(oldPath), other); assert.equal(test.commits.length, 1); passed++;
}
{
  const test = setup(ownLock, { job: { dateKey: undefined, workDate: dateKey } });
  await test.run({ assignedStaffId: null }); assert.equal(test.records.get(oldPath).active, false); passed++;
}
console.log(`Admin reassignment lock ownership: ${passed} cases passed (SDK mocks; no external writes).`);