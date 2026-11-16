import assert from 'node:assert/strict';
import { staffRevocationCases } from './fixtures/staff-revocation-cases.mjs';

export function staffEmulatorToken(project, uid, now, claims) {
  assert.match(project, /^demo-lkc-accept-[a-z0-9]+$/);
  const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');
  // A JWT string keeps auth_time absent in the case that tests its absence.
  // The SDK's object form supplies a default tied to iat.
  const token = {
    iss: 'https://securetoken.google.com/' + project, aud: project,
    iat: now, exp: now + 3600, sub: uid, user_id: uid,
    firebase: { sign_in_provider: 'custom', identities: {} },
    ...claims,
  };
  return encode({ alg: 'none', typ: 'JWT' }) + '.' + encode(token) + '.';
}

// Run only within the reviewed local-emulator Client SDK harness.
// The runner owns project isolation, SDK initialization, assertions, and cleanup.
export async function runStaffRevocationClientCases({ seed, adminStore, client, read, list, test }) {
  const project = seed.projectId;
  assert.match(project, /^demo-lkc-accept-[a-z0-9]+$/);
  const staffId = 'staff-revocation', companyId = 'company-a';
  const now = Math.floor(Date.now() / 1000);
  const cases = staffRevocationCases((s, n) => new adminStore.Timestamp(s, n), now - 60);
  const personal = { companyId, staffId };
  const batch = seed.batch();
  const fixtures = {
    ['staffProfiles/' + staffId]: { companyId, active: true },
    'jobs/revocation-own': { companyId, assignedStaffId: staffId, status: 'assigned' },
    'tasks/revocation-own': personal,
    'submissions/revocation-own': personal,
    'submissions/revocation-own/files/example': personal,
    'resubmissionRequests/revocation-own': personal,
    'announcementReceipts/revocation-own': personal,
    'deviceSessions/revocation-own': personal,
  };
  for (const [path, data] of Object.entries(fixtures)) batch.set(seed.doc(path), data);
  for (const [i, scenario] of cases.entries()) {
    if (scenario.identity) batch.set(seed.doc('authIdentities/revocation-user-' + i), scenario.identity);
  }
  await batch.commit();

  const claims = { role: 'staff', companyId, staffId };
  const createClient = (name, uid, authClaims) =>
    client(name, staffEmulatorToken(project, uid, now, { ...claims, ...authClaims }));
  const clients = cases.map((scenario, i) =>
    createClient('staff-revocation-' + i, 'revocation-user-' + i, scenario.claims));
  for (const [i, scenario] of cases.entries()) {
    const db = clients[i];
    for (const path of Object.keys(fixtures)) {
      await test('staff revocation / ' + scenario.name + ' / ' + path, async () => {
        if (scenario.allowed) assert.equal((await read(db, path)).exists(), true);
        else await assert.rejects(read(db, path), error => error.code === 'permission-denied');
      });
    }
    await test('staff revocation / ' + scenario.name + ' / scoped shift query', async () => {
      const query = list(db, 'jobs', ['companyId', companyId], ['assignedStaffId', staffId], ['status', 'assigned']);
      if (scenario.allowed) assert.deepEqual((await query).docs.map(doc => doc.id), ['revocation-own']);
      else await assert.rejects(query, error => error.code === 'permission-denied');
    });
  }

  // Keep the UID and identity document identical through the loss and recovery
  // of access, while the old client's token is refreshed without a new sign-in.
  const uid = 'same-uid-revocation', identity = seed.doc('authIdentities/' + uid);
  const old = createClient('staff-revocation-same-uid-old', uid, cases[4].claims);
  const renewed = createClient('staff-revocation-same-uid-new', uid, cases[7].claims);
  await test('staff revocation / same UID active, stopped, reactivated', async () => {
    await identity.set({ companyId, staffId, active: true });
    assert.equal((await read(old, 'jobs/revocation-own')).exists(), true);
    await identity.update({ active: false, revokedAt: cases[4].identity.revokedAt });
    await assert.rejects(read(old, 'jobs/revocation-own'), error => error.code === 'permission-denied');
    await identity.update({ active: true });
    await assert.rejects(read(old, 'jobs/revocation-own'), error => error.code === 'permission-denied');
    assert.equal((await read(renewed, 'jobs/revocation-own')).exists(), true);
  });
}


export const deviceBoundRuleCasePrefix = 'device-bound Rules / ';

export async function runDeviceBoundRuleCases({ seed, client, read, list, test, update }) {
  const project = seed.projectId;
  assert.match(project, /^demo-lkc-accept-[a-z0-9]+$/);
  const companyId = 'company-device-bound', staffId = 'staff-device-bound', uid = 'uid-device-bound';
  const identity = seed.doc('authIdentities/' + uid);
  const profile = seed.doc('staffProfiles/' + staffId);
  const jobPath = 'jobs/device-bound-own', otherPath = 'jobs/device-bound-other';
  const a = 'device_' + 'a'.repeat(28), b = 'device_' + 'b'.repeat(28);
  const first = 'a'.repeat(48), second = 'b'.repeat(48), rotated = 'c'.repeat(48);
  const claims = { role: 'staff', companyId, staffId, auth_time: Math.floor(Date.now() / 1000) };
  const createClient = (name, tokenClaims) => client(name, staffEmulatorToken(project, uid, claims.auth_time, { ...claims, ...tokenClaims }));
  const unbound = createClient('device-bound-legacy', {});
  const deviceA = createClient('device-bound-a', { crewDeviceSession: a, crewDeviceGeneration: first });
  const deviceB = createClient('device-bound-b', { crewDeviceSession: b, crewDeviceGeneration: second });
  const wrong = createClient('device-bound-a-wrong', { crewDeviceSession: a, crewDeviceGeneration: rotated });
  const partial = createClient('device-bound-a-partial', { crewDeviceSession: a });
  const renewed = createClient('device-bound-b-renewed', { crewDeviceSession: b, crewDeviceGeneration: rotated });
  const denied = action => assert.rejects(action, error => error.code === 'permission-denied');
  const allowed = async db => assert.equal((await read(db, jobPath)).exists(), true);
  const listAssigned = db => list(db, 'jobs', ['companyId', companyId], ['assignedStaffId', staffId], ['status', 'assigned']);
  const check = (name, operation) => test(deviceBoundRuleCasePrefix + name, operation);

  const initial = seed.batch();
  initial.set(profile, { companyId, active: true });
  initial.set(identity, { companyId, staffId, active: true });
  initial.set(seed.doc(jobPath), { companyId, assignedStaffId: staffId, status: 'assigned' });
  initial.set(seed.doc(otherPath), { companyId, assignedStaffId: 'different-staff', status: 'assigned' });
  initial.set(seed.doc('submissions/device-bound-own'), { companyId, staffId, jobId: 'device-bound-own' });
  await initial.commit();

  await check('legacy session can read before enabling the device policy', () => allowed(unbound));
  const transition = seed.batch();
  transition.update(profile, { deviceBoundAuthRequired: true });
  transition.update(identity, { deviceCredentials: { [a]: first, [b]: second } });
  await transition.commit();

  await check('same UID without the new device claims cannot read or list after switching', async () => {
    await denied(read(unbound, jobPath));
    await denied(listAssigned(unbound));
  });
  await check('two current devices can read the same assignment and submission', async () => {
    for (const db of [deviceA, deviceB]) {
      await allowed(db);
      assert.deepEqual((await listAssigned(db)).docs.map(doc => doc.id), ['device-bound-own']);
      assert.equal((await read(db, 'submissions/device-bound-own')).exists(), true);
    }
  });
  await check('partially present and wrong-generation claims are rejected', async () => {
    await denied(read(partial, jobPath));
    await denied(read(wrong, jobPath));
  });
  await check('an authenticated device cannot read a different staff member assignment', () => denied(read(deviceA, otherPath)));
  await check('a staff device cannot change the stored device credential or opt out', async () => {
    await denied(update(deviceA, 'authIdentities/' + uid, { ['deviceCredentials.' + a]: rotated }));
    await denied(update(deviceA, 'staffProfiles/' + staffId, { deviceBoundAuthRequired: false }));
  });
  await identity.update({ ['deviceCredentials.' + a]: null });
  await check('stopping A denies A while the same UID on B can still read', async () => {
    await denied(read(deviceA, jobPath));
    await allowed(deviceB);
  });
  await identity.update({ ['deviceCredentials.' + b]: rotated });
  await check('only the renewed generation of device B can read', async () => {
    await denied(read(deviceB, jobPath));
    await allowed(renewed);
  });
  await identity.update({ active: false });
  await check('disabling the shared identity denies the remaining current device', () => denied(read(renewed, jobPath)));
}
