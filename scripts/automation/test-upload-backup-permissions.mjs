import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticatedUploadRefreshAPI, inspectUploadBackupPermissions,
  UPLOAD_BACKUP_PERMISSION_NAMES} from './run-upload-source-refresh.mjs';

const permissions = ['storage.buckets.get', 'storage.buckets.getIamPolicy',
  'storage.buckets.update', 'storage.buckets.setIamPolicy'];
const endpoint = 'https://storage.googleapis.com/storage/v1/b/gcf-v2-sources-740154137290-asia-northeast1/iam/testPermissions';
const privateValue = 'synthetic-private-permission-error';
function harness(response, {status = 200, fail = false} = {}) {
  const requests = [];
  const api = authenticatedUploadRefreshAPI({getRequestHeaders: async () => ({authorization: 'Bearer synthetic-only'})}, async (value, options) => {
    const url = new URL(value);
    assert.equal(url.origin + url.pathname, endpoint);
    assert.deepEqual([...url.searchParams.keys()], permissions.map(() => 'permissions'));
    assert.deepEqual(url.searchParams.getAll('permissions'), permissions);
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    assert.equal(options.redirect, 'error');
    requests.push({method: options.method, endpoint: url.origin + url.pathname});
    if (fail) throw Error(privateValue);
    return new Response(JSON.stringify(response), {status, headers: {'content-type': 'application/json'}});
  });
  return {api, requests};
}

test('backup permission self-test uses one exact read and no write or source acquisition', async () => {
  assert.deepEqual(UPLOAD_BACKUP_PERMISSION_NAMES, permissions);
  const h = harness({kind: 'storage#testIamPermissionsResponse', permissions});
  const result = await inspectUploadBackupPermissions(h.api);
  assert.equal(result.status, 'VERIFIED_CALLER_PERMISSIONS');
  assert.equal(result.privacyUpdatePermissionsPresent, true);
  assert.deepEqual(result.permissions, Object.fromEntries(permissions.map(p => [p, true])));
  assert.equal(h.requests.length, 1); assert.equal(h.api.counters.requests, 1);
  assert.equal(h.api.counters.writesAttempted, 0); assert.equal(h.api.counters.mediaBytes, 0);
  assert.equal(h.api.counters.lastRequestKind, 'backup-bucket-permission-self-test');
  assert.doesNotMatch(JSON.stringify(result), /Bearer|synthetic-only|authorization/);
});

for (const missing of permissions) test('backup permission self-test distinguishes missing ' + missing, async () => {
  const h = harness({kind: 'storage#testIamPermissionsResponse', permissions: permissions.filter(p => p !== missing)});
  const result = await inspectUploadBackupPermissions(h.api);
  assert.equal(result.status, 'VERIFIED_CALLER_PERMISSIONS');
  assert.equal(result.permissions[missing], false);
  assert.equal(result.privacyUpdatePermissionsPresent, !['storage.buckets.update', 'storage.buckets.setIamPolicy'].includes(missing));
  assert.equal(h.requests.length, 1); assert.equal(h.api.counters.writesAttempted, 0);
});

test('backup permission self-test accepts the documented empty permission response', async () => {
  const h = harness({kind: 'storage#testIamPermissionsResponse'});
  const result = await inspectUploadBackupPermissions(h.api);
  assert.equal(result.status, 'VERIFIED_CALLER_PERMISSIONS');
  assert.deepEqual(result.permissions, Object.fromEntries(permissions.map(p => [p, false])));
  assert.equal(result.privacyUpdatePermissionsPresent, false);
});

for (const response of [null, {}, {kind: 'other', permissions},
  {kind: 'storage#testIamPermissionsResponse', permissions: null},
  {kind: 'storage#testIamPermissionsResponse', permissions: 'storage.buckets.update'},
  {kind: 'storage#testIamPermissionsResponse', permissions: [permissions[0], permissions[0]]},
  {kind: 'storage#testIamPermissionsResponse', permissions: ['storage.buckets.delete']},
  {kind: 'storage#testIamPermissionsResponse', permissions: ['*']},
  {kind: 'storage#testIamPermissionsResponse', permissions, unexpected: privateValue}]) {
  test('backup permission self-test refuses malformed or out-of-scope permission evidence ' + JSON.stringify(response), async () => {
    const h = harness(response); const result = await inspectUploadBackupPermissions(h.api);
    assert.equal(result.status, 'UNVERIFIED'); assert.equal(Object.hasOwn(result, 'permissions'), false);
    assert.equal(result.reason, 'UPLOAD_REFRESH_BACKUP_PERMISSIONS_UNVERIFIED');
    assert.equal(h.requests.length, 1); assert.equal(h.api.counters.writesAttempted, 0);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(privateValue));
  });
}

for (const scenario of [{status: 403}, {status: 404}, {fail: true}]) {
  test('backup permission self-test leaves transport failure unverified ' + JSON.stringify(scenario), async () => {
    const h = harness({error: {message: privateValue}}, scenario);
    const result = await inspectUploadBackupPermissions(h.api);
    assert.equal(result.status, 'UNVERIFIED'); assert.equal(Object.hasOwn(result, 'permissions'), false);
    if (scenario.status) assert.equal(result.httpStatus, scenario.status);
    else assert.equal(Object.hasOwn(result, 'httpStatus'), false);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(privateValue));
    assert.equal(h.requests.length, 1); assert.equal(h.api.counters.writesAttempted, 0);
  });
}

test('backup permission transport cannot expand the target, permissions or HTTP method', async () => {
  let fetches = 0;
  const api = authenticatedUploadRefreshAPI({getRequestHeaders: async () => ({})}, async () => {fetches++; assert.fail('Out-of-scope network call');});
  const query = new URLSearchParams(); for (const permission of permissions) query.append('permissions', permission);
  const fixed = endpoint + '?' + query;
  for (const [url, options] of [
    [endpoint.replace('740154137290', '123') + '?' + query, {}],
    [fixed + '&permissions=storage.buckets.delete', {}],
    [endpoint + '?permissions=storage.buckets.update', {}],
    [fixed + '&userProject=other', {}], [fixed, {method: 'POST', readOnlyPost: true}],
    [fixed, {body: {permissions}}], [fixed, {media: true}],
  ]) await assert.rejects(api.request(url, options), /UPLOAD_REFRESH_HTTP_SCOPE_REJECTED/);
  assert.equal(fetches, 0); assert.equal(api.counters.requests, 0); assert.equal(api.counters.writesAttempted, 0);
});
