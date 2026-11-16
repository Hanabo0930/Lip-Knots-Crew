import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const dependency = createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT ?? process.cwd(), 'package.json'));
const ts = dependency('typescript');
const { HttpsError } = dependency('firebase-functions/v2/https');
const { Timestamp } = dependency('firebase-admin/firestore');
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const companyId = 'synthetic-company', staffId = 'synthetic-staff', uid = 'synthetic-user';
const email = 'synthetic-staff@example.invalid';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const profilePath = 'staffProfiles/' + staffId, indexPath = 'emailIndex/' + hash(email);
const identityPath = 'authIdentities/' + uid;
const adminUid = 'synthetic-admin';
const authTime = 1_790_000_000;

function setup(existing = true) {
  const records = new Map([
    [profilePath, { companyId, displayName: 'Synthetic Same Name', emails: [email], active: true, ...(existing ? { authUids: [uid] } : {}) }],
    ['staffProfiles/same-company', { companyId, displayName: 'Synthetic Same Name', active: true }],
    ['staffProfiles/foreign', { companyId: 'another-company', displayName: 'Synthetic Same Name', active: true }],
    [indexPath, { companyId, staffId, active: true }],
    ...(existing ? [[identityPath, { companyId, staffId, emailHash: hash(email), active: true }]] : []),
    ['deviceSessions/old-device', { companyId, staffId, uid, active: true }],
  ]);
  const state = {
    clock: 1_790_000_000_000, stopped: false, commits: [], lostReply: false,
    liveAdmin: { uid: adminUid, disabled: false, emailVerified: true, customClaims: { role: 'admin', companyId } },
    liveStaff: existing ? { uid, disabled: false, emailVerified: true, email, customClaims: { role: 'staff', companyId, staffId } } : null,
  };
  const versions = new Map([...records.keys()].map(key => [key, Timestamp.fromMillis(++state.clock)]));
  const replace = (key, change) => {
    records.set(key, { ...records.get(key), ...change });
    versions.set(key, Timestamp.fromMillis(++state.clock));
  };
  const get = async ref => ({
    exists: records.has(ref.path), updateTime: versions.get(ref.path), data: () => records.get(ref.path),
  });
  let tail = Promise.resolve();
  const db = {
    collection: collection => ({ doc: id => ({ path: collection + '/' + id }) }),
    runTransaction(fn, options) {
      const task = tail.then(async () => {
        const writes = [];
        const result = await fn({
          get,
          update: (ref, data) => writes.push([ref.path, data, true]),
          set: (ref, data) => writes.push([ref.path, data, false]),
        });
        if (options?.readOnly) assert.equal(writes.length, 0);
        if (!writes.length) return result;
        for (const [key, data, merging] of writes) {
          if (merging) assert.ok(records.has(key));
          else assert.equal(records.has(key), false);
          replace(key, data);
        }
        state.commits.push(writes.map(([key]) => key));
        if (state.lostReply) { state.lostReply = false; throw Error('synthetic commit response lost'); }
        return result;
      });
      tail = task.catch(() => {});
      return task;
    },
  };
  const auth = {
    getUser: async requestedUid => {
      assert.equal(requestedUid, adminUid);
      return state.liveAdmin;
    },
    getUserByEmail: async requestedEmail => {
      assert.equal(requestedEmail, email);
      state.onLookup?.();
      if (!state.liveStaff) throw Object.assign(Error('synthetic not found'), { code: 'auth/user-not-found' });
      return state.liveStaff;
    },
  };
  const mocked = {
    './firebase': { db, auth },
    'firebase-admin/firestore': { Timestamp, FieldValue: { serverTimestamp: () => Timestamp.fromMillis(++state.clock) } },
    'firebase-functions/v2/https': { HttpsError, onCall: callback => callback },
    'firebase-functions/params': { defineString: () => ({ value: () => state.configuredAdminEmail ?? 'admin@example.invalid' }) },
    './system-safety': { getProductionOperationalState: async () => ({ operational: !state.stopped }) },
  };
  const modules = new Map();
  const load = id => {
    if (mocked[id]) return mocked[id];
    if (!id.startsWith('./')) return dependency(id);
    if (modules.has(id)) return modules.get(id);
    assert.match(id, /^\.\/[a-z-]+$/);
    const exports = {};
    modules.set(id, exports);
    runInNewContext(compile(fs.readFileSync('functions/src/' + id.slice(2) + '.ts', 'utf8')), { exports, require: load });
    return exports;
  };
  const admin = { uid: adminUid, token: { companyId, role: 'admin', auth_time: authTime } };
  const call = (data, caller = admin) => load('./devices').adminStaffDeviceAuthentication({ auth: caller, data });
  return {
    records, state, replace, admin, call,
    preview: () => call({ action: 'preview', staffId }),
    enable: operationId => call({ action: 'enable', staffId, operationId }),
    legacyAuthorized: () => load('./staff-session').readActiveStaffProfile({ get }, companyId, staffId, uid, authTime),
  };
}

const cases = [];
async function check(name, test) { await test(); cases.push(name); }
await check('read-only preview, one staff switch, same UID, pre-existing grant invalidated', async () => {
  const h = setup();
  await h.legacyAuthorized();
  const preview = await h.preview();
  assert.deepEqual([preview.status, preview.mode, preview.staffId, preview.email], ['eligible', 'existing_login', staffId, email]);
  assert.equal(h.state.commits.length, 0);
  const otherBefore = h.records.get('staffProfiles/same-company');
  const foreignBefore = h.records.get('staffProfiles/foreign');
  const deviceBefore = h.records.get('deviceSessions/old-device');
  const identityBefore = h.records.get(identityPath);
  const result = await h.enable(preview.operationId);
  assert.deepEqual([result.status, result.operationId], ['enabled', preview.operationId]);
  assert.equal(h.records.get(profilePath).deviceBoundAuthRequired, true);
  assert.ok(h.records.get(profilePath).deviceBoundAuthEnabledAt instanceof Timestamp);
  assert.equal(h.records.get(identityPath), identityBefore);
  assert.equal(h.records.get('deviceSessions/old-device'), deviceBefore);
  assert.equal(h.records.get('staffProfiles/same-company'), otherBefore);
  assert.equal(h.records.get('staffProfiles/foreign'), foreignBefore);
  assert.equal(h.state.commits.length, 1);
  assert.equal(h.state.commits[0].length, 2);
  assert.match(h.state.commits[0][1], /^auditLogs\/device_auth_/);
  await assert.rejects(h.legacyAuthorized(), { code:'permission-denied' });
});
await check('new staff switch does not create a Firebase account or an identity', async () => {
  const h = setup(false);
  const preview = await h.preview();
  assert.deepEqual([preview.status, preview.mode], ['eligible', 'first_login']);
  await h.enable(preview.operationId);
  assert.equal(h.state.liveStaff, null);
  assert.equal(h.records.has(identityPath), false);
  assert.equal(h.records.has('staffLoginEnrollments/' + staffId), false);
});
await check('lost reply is read back and same operation never changes data twice', async () => {
  const h = setup();
  const { operationId } = await h.preview();
  h.state.lostReply = true;
  await assert.rejects(h.enable(operationId), /synthetic commit response lost/);
  const observed = await h.preview();
  assert.deepEqual([observed.status, observed.operationId], ['enabled', operationId]);
  assert.equal((await h.enable(operationId)).status, 'enabled');
  await assert.rejects(h.enable('f'.repeat(64)), { code:'aborted' });
  assert.equal(h.state.commits.length, 1);
});
for (const [name, change] of [
  ['same name in another company', h => h.call({ action: 'preview', staffId: 'foreign' })],
  ['staff without administrator role', h => h.call({ action: 'preview', staffId }, { ...h.admin, token: { ...h.admin.token, role: 'staff' } })],
  ['stale administrator company', h => { h.state.liveAdmin.customClaims.companyId = 'another-company'; return h.preview(); }],
  ['revoked administrator', h => { h.state.liveAdmin.tokensValidAfterTime = new Date((authTime + 1) * 1_000).toISOString(); return h.preview(); }],
  ['request invents another company', h => h.call({ action: 'preview', staffId, companyId: 'another-company' })],
  ['request invents staff path', h => h.call({ action: 'preview', staffId: 'a/b' })],
]) {
  await check(name, async () => {
    const h = setup();
    await assert.rejects(change(h));
    assert.equal(h.state.commits.length, 0);
  });
}
for (const [name, change] of [
  ['disabled profile', h => h.replace(profilePath, { active: false })],
  ['more than one registered address', h => h.replace(profilePath, { emails: [email, 'second@example.invalid'] })],
  ['more than one UID', h => h.replace(profilePath, { authUids: [uid, 'another-uid'] })],
  ['index changes staff', h => h.replace(indexPath, { staffId: 'same-company' })],
  ['identity belongs to another staff', h => h.replace(identityPath, { staffId: 'same-company' })],
  ['identity has old device grant history', h => h.replace(identityPath, { deviceCredentials: {} })],
  ['Firebase UID differs from link', h => { h.state.liveStaff.uid = 'another-uid'; }],
  ['Firebase account is disabled', h => { h.state.liveStaff.disabled = true; }],
  ['configured admin address cannot be switched', h => { h.state.configuredAdminEmail = email; }],
]) {
  await check(name, async () => {
    const h = setup();
    change(h);
    assert.equal((await h.preview()).status, 'ineligible');
    assert.equal(h.state.commits.length, 0);
  });
}
await check('existing Firebase account without a known roster UID is held', async () => {
  const h = setup(false);
  h.state.liveStaff = { uid, email };
  assert.equal((await h.preview()).status, 'ineligible');
  assert.equal(h.state.commits.length, 0);
});
for (const [name, mutate, code] of [
  ['preview revision changes during concurrently read account', h => { h.state.onLookup = () => h.replace(profilePath, { active: false }); }, 'aborted'],
  ['company is stopped at commit', h => { h.state.stopped = true; }, 'failed-precondition'],
]) {
  await check(name, async () => {
    const h = setup();
    const { operationId } = await h.preview();
    mutate(h);
    await assert.rejects(h.enable(operationId), { code });
    assert.equal(h.state.commits.length, 0);
  });
}

const app = fs.readFileSync('apps/admin/src/App.tsx', 'utf8');
const start = app.indexOf('  async function reviewStaffDeviceAuthentication(');
const end = app.indexOf('  async function revokeStaffDevices(', start);
assert.ok(start > 0 && end > start);
const appCode = compile(app.slice(start, end));
function screen() {
  const token = 'a'.repeat(64);
  const state = { calls: [], reports: [], confirmations: [], failWriteReply: false, persisted: false };
  const profile = { id: staffId, displayName: 'Synthetic Same Name' };
  const eligible = { status:'eligible', staffId, email, operationId: token, mode:'existing_login' };
  const sandbox = {
    firebaseConfigured:true, functions:{}, auth:{ currentUser:{ uid:adminUid } }, adminSessionReady:true,
    staffDeviceProfileRef:{current:profile}, staffDeviceStatus:'ready', staffDeviceVersionRef:{current:1},
    operationLocksRef:{current:new Map()}, setOperationKeys:()=>{}, staffDeviceAuthPlan:null, window:{
      confirm: text => { state.confirmations.push(text); return !state.cancel; },
    },
    setStaffDeviceAuthPlan: value => { sandbox.staffDeviceAuthPlan = value; },
    setStaffDeviceAuthMessage: message => { if (message) state.reports.push(message); },
    httpsCallable: (_functions, name) => async input => {
      assert.equal(name, 'adminStaffDeviceAuthentication');
      state.calls.push(input.action);
      assert.equal(input.staffId, staffId);
      if (input.action === 'enable') {
        assert.equal(input.operationId, token);
        state.persisted = true;
        state.onEnable?.();
        if (state.failWriteReply) throw Error('synthetic network failure');
      }
      if (state.persisted) return { data:{ status:'enabled', staffId, operationId:token } };
      return { data:state.wrongTarget ? { ...eligible, staffId:'someone-else' } : eligible };
    },
  };
  runInNewContext(appCode, sandbox);
  return { state, sandbox, act: enable => sandbox.reviewStaffDeviceAuthentication(enable) };
}
await check('screen matches staff and operation ID and reads back a lost reply', async () => {
  const h = screen();
  await h.act();
  assert.equal(h.sandbox.staffDeviceAuthPlan.staffId, staffId);
  h.state.failWriteReply = true;
  await Promise.all([h.act(true), h.act(true)]);
  assert.deepEqual(h.state.calls, ['preview','enable','preview']);
  assert.equal(h.state.confirmations.length, 1);
  assert.match(h.state.confirmations[0], /synthetic-staff@example\.invalid/);
  assert.equal(h.sandbox.staffDeviceAuthPlan.status, 'enabled');
});
await check('screen refuses a cancelled or a mismatched preview', async () => {
  const h = screen();
  h.state.wrongTarget = true;
  await h.act();
  assert.equal(h.sandbox.staffDeviceAuthPlan, null);
  await h.act(true);
  h.state.wrongTarget = false;
  await h.act();
  h.state.cancel = true;
  await h.act(true);
  assert.deepEqual(h.state.calls, ['preview','preview']);
});
await check('screen ignores an in-flight result after an administrator changes', async () => {
  const h = screen();
  await h.act();
  h.state.onEnable = () => h.sandbox.auth.currentUser = { uid:'different-admin' };
  await h.act(true);
  assert.deepEqual(h.state.calls, ['preview','enable']);
  assert.equal(h.sandbox.staffDeviceAuthPlan, null);
});
console.log(JSON.stringify({ passed: cases.length, cases, actualCloud: false }));
