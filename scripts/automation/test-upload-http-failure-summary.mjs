import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadHttpRejection, uploadHttpFailureSummary} from './upload-http-failure-summary.mjs';
import {authenticatedUploadRefreshAPI} from './run-upload-source-refresh.mjs';

const privateValue = 'synthetic-private-principal-policy-token-and-resource';
const counters = () => ({metadataBytes: 0});
const payload = (overrides = {}) => ({error: {code: 403, message: privateValue, ...overrides}});
const response = value => new Response(JSON.stringify(value), {status: 403, headers: {'content-type': 'application/json; charset=UTF-8'}});
async function capture(value) {
  const count = counters(), body = response(value);
  const error = await uploadHttpRejection(body, count, {captureStorage403: true});
  assert.equal(error.message, 'UPLOAD_REFRESH_HTTP_REJECTED'); assert.equal(error.httpStatus, 403);
  return {error, count, summary: uploadHttpFailureSummary(error)};
}
const detail = (domain = 'storage.googleapis.com', reason = 'IAM_PERMISSION_DENIED') => ({
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo', domain, reason,
  metadata: {permission: 'storage.objects.create', resource: privateValue, error_info_id: privateValue}, message: privateValue,
});

test('Storage 403 keeps only fixed reason enums and the exact permission boolean', async () => {
  const value = payload({errors: [{domain: 'global', reason: 'forbidden', message: privateValue}], details: [detail()]});
  const got = await capture(value);
  assert.deepEqual(got.summary, {captureStatus: 'STRUCTURED_RESPONSE', reasonCodes: ['IAM_PERMISSION_DENIED', 'STORAGE_FORBIDDEN'],
    objectCreatePermissionMentioned: true, causeEstablished: false});
  assert.equal(got.count.metadataBytes, Buffer.byteLength(JSON.stringify(value)));
  assert.doesNotMatch(JSON.stringify(got.summary), /synthetic-private|metadata|resource|error_info_id|message/);
  assert.ok(Object.isFrozen(got.summary)); assert.ok(Object.isFrozen(got.summary.reasonCodes));
});

test('documented REST ErrorInfo and organization restrictions remain distinct', async () => {
  assert.equal((await capture(payload({details: [detail('global', 'forbidden')]}))).summary.objectCreatePermissionMentioned, true);
  const org = await capture(payload({details: [detail('googleapis.com', 'ORG_RESTRICTION_VIOLATION')]}));
  assert.deepEqual(org.summary.reasonCodes, ['ORG_RESTRICTION_VIOLATION']);
  assert.equal(org.summary.objectCreatePermissionMentioned, false);
  assert.equal(org.summary.causeEstablished, false);
});

test('unknown domains, arbitrary reasons, messages, permissions and ErrorInfo lookalikes never escape', async () => {
  const info = detail(); info.metadata.permission = privateValue;
  const got = await capture(payload({errors: [{domain: 'global', reason: privateValue}, {domain: privateValue, reason: 'forbidden'}],
    details: [info, detail(privateValue), {...detail(), '@type': privateValue}, {...detail(), reason: privateValue}]}));
  assert.deepEqual(got.summary.reasonCodes, ['IAM_PERMISSION_DENIED']);
  assert.equal(got.summary.objectCreatePermissionMentioned, false);
  assert.doesNotMatch(JSON.stringify(got.summary), /synthetic-private/);
  assert.deepEqual((await capture(payload())).summary.reasonCodes, []);
});

for (const value of [null, [], {}, {error: null}, {error: {code: 401}}, {error: {code: '403'}},
  payload({errors: {reason: 'forbidden'}}), payload({details: 'private'}), payload({details: Array(17).fill(detail())})]) {
  test('malformed error envelopes preserve known HTTP status without claiming a reason ' + JSON.stringify(value), async () => {
    const got = await capture(value); assert.equal(got.summary.captureStatus, 'UNAVAILABLE');
    assert.deepEqual(got.summary.reasonCodes, []); assert.equal(got.summary.causeEstablished, false);
  });
}

for (const [name, body, headers] of [
  ['HTML', privateValue, {'content-type': 'text/html'}],
  ['malformed JSON', '{' + privateValue, {'content-type': 'application/json'}],
  ['non UTF-8', new Uint8Array([255]), {'content-type': 'application/json'}],
  ['compressed body', '{}', {'content-type': 'application/json', 'content-encoding': 'gzip'}],
  ['oversized declared body', '{}', {'content-type': 'application/json', 'content-length': '8193'}],
  ['invalid length', '{}', {'content-type': 'application/json', 'content-length': 'not-a-number'}],
  ['wrong length', '{}', {'content-type': 'application/json', 'content-length': '3'}],
  ['oversized streaming body', 'x'.repeat(8193), {'content-type': 'application/json'}],
]) test('bounded response capture rejects ' + name + ' without losing HTTP rejection', async () => {
  const got = await uploadHttpRejection(new Response(body, {status: 403, headers}), counters(), {captureStorage403: true});
  assert.equal(got.httpStatus, 403); assert.equal(uploadHttpFailureSummary(got).captureStatus, 'UNAVAILABLE');
});

test('a fragmented response is counted and projected once, while exhausted metadata budget stops capture', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload({details: [detail()]})));
  let pulls = 0;
  const stream = new ReadableStream({pull(controller) {
    if (pulls === bytes.length) return controller.close();
    controller.enqueue(bytes.subarray(pulls, Math.min(pulls + 32, bytes.length))); pulls = Math.min(pulls + 32, bytes.length);
  }});
  const count = counters(), r = new Response(stream, {status: 403, headers: {'content-type': 'application/json'}});
  const got = await uploadHttpRejection(r, count, {captureStorage403: true});
  assert.equal(uploadHttpFailureSummary(got).objectCreatePermissionMentioned, true); assert.equal(count.metadataBytes, bytes.length);
  const nearLimit = {metadataBytes: 16 * 1024 * 1024 - 1};
  const stopped = await uploadHttpRejection(response(payload()), nearLimit, {captureStorage403: true});
  assert.equal(uploadHttpFailureSummary(stopped).captureStatus, 'UNAVAILABLE');
});

test('a body that fails, never settles or refuses cancellation cannot replace a known HTTP rejection', {timeout: 5000}, async () => {
  const failing = new ReadableStream({start(controller) { controller.error(Error(privateValue)); }});
  const failed = await uploadHttpRejection(new Response(failing, {status: 403, headers: {'content-type': 'application/json'}}), counters(), {captureStorage403: true});
  assert.equal(failed.httpStatus, 403); assert.equal(uploadHttpFailureSummary(failed).captureStatus, 'UNAVAILABLE');
  const hanging = new ReadableStream({pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); }});
  const timed = await uploadHttpRejection(new Response(hanging, {status: 403, headers: {'content-type': 'application/json'}}), counters(), {captureStorage403: true});
  assert.equal(timed.httpStatus, 403); assert.equal(uploadHttpFailureSummary(timed).captureStatus, 'UNAVAILABLE');
  const badCancel = {status: 412, body: {cancel() { throw Error(privateValue); }}};
  assert.equal((await uploadHttpRejection(badCancel, counters())).httpStatus, 412);
});

test('an exact 8 KiB JSON response is accepted without exposing its padding', async () => {
  const json = JSON.stringify(payload({details: [detail()]}));
  const body = json + ' '.repeat(8192 - Buffer.byteLength(json)), count = counters();
  const result = await uploadHttpRejection(new Response(body, {status: 403, headers: {'content-type': 'application/json', 'content-length': '8192'}}), count, {captureStorage403: true});
  assert.equal(uploadHttpFailureSummary(result).objectCreatePermissionMentioned, true); assert.equal(count.metadataBytes, 8192);
});

test('diagnostic bytes exhausting the metadata budget block any subsequent request before fetch', async () => {
  let calls = 0;
  const api = authenticatedUploadRefreshAPI({getRequestHeaders: async () => ({})}, async () => {calls++; return response(payload());});
  api.counters.metadataBytes = 16 * 1024 * 1024 - 1;
  const url = 'https://storage.googleapis.com/storage/v1/b/gcf-v2-sources-740154137290-asia-northeast1';
  await assert.rejects(api.request(url), error => error.httpStatus === 403 && uploadHttpFailureSummary(error).captureStatus === 'UNAVAILABLE');
  await assert.rejects(api.request(url), /RESPONSE_TOO_LARGE/);
  assert.equal(calls, 1); assert.equal(api.counters.requests, 1); assert.equal(api.counters.writesAttempted, 0);
});

test('unbranded caller errors cannot inject data into retained summaries', async () => {
  assert.equal(uploadHttpFailureSummary(Object.assign(Error(privateValue), {httpFailure: {message: privateValue}})), undefined);
  assert.equal(uploadHttpFailureSummary(await uploadHttpRejection(response(payload()), counters())), undefined);
});

test('real transport retains the fixed projection, with one failed create and no retry or follow-up request', async () => {
  let calls = 0;
  const api = authenticatedUploadRefreshAPI({getRequestHeaders: async () => ({authorization: 'Bearer ' + privateValue})}, async () => {
    calls++; return response(payload({details: [detail()]}));
  });
  const url = 'https://storage.googleapis.com/upload/storage/v1/b/gcf-v2-sources-740154137290-asia-northeast1/o'
    + '?uploadType=media&name=' + encodeURIComponent('lkc-upload-source-refresh/123456/' + 'a'.repeat(40) + '/createUploadSession.zip') + '&ifGenerationMatch=0';
  let rejected;
  try { await api.request(url, {method: 'POST', body: Buffer.from('synthetic-zip')}); } catch (error) { rejected = error; }
  assert.equal(rejected.httpStatus, 403); assert.equal(uploadHttpFailureSummary(rejected).objectCreatePermissionMentioned, true);
  await assert.rejects(api.request(url, {method: 'POST', body: Buffer.from('synthetic-zip')}), /MUTATION_ALREADY_ATTEMPTED/);
  assert.equal(calls, 1); assert.equal(api.counters.requests, 1); assert.equal(api.counters.writesAttempted, 1); assert.equal(api.counters.mediaBytes, 0);
  assert.equal(api.counters.lastRequestKind, 'private-object-create'); assert.ok(api.counters.metadataBytes > 0);
});
