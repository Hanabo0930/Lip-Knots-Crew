// Read only the response already returned by a rejected Storage request. No
// network client, credentials, retry or permission inference belongs here.
const retained = new WeakMap();
const BODY_LIMIT = 8 * 1024, METADATA_LIMIT = 16 * 1024 * 1024;
const globalReasons = Object.freeze({
  forbidden: 'STORAGE_FORBIDDEN',
  insufficientPermissions: 'STORAGE_INSUFFICIENT_PERMISSIONS',
  accountDisabled: 'STORAGE_ACCOUNT_DISABLED',
  countryBlocked: 'STORAGE_COUNTRY_BLOCKED',
  objectUnderActiveHold: 'STORAGE_ACTIVE_HOLD',
  retentionPolicyNotMet: 'STORAGE_RETENTION_NOT_MET',
  sslRequired: 'STORAGE_SSL_REQUIRED',
  UserProjectAccessDenied: 'STORAGE_REQUESTER_PROJECT_DENIED',
  UserProjectAccountProblem: 'STORAGE_REQUESTER_PROJECT_ACCOUNT_PROBLEM',
});
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const summary = (captureStatus, reasonCodes = [], objectCreatePermissionMentioned = false) => Object.freeze({
  captureStatus, reasonCodes: Object.freeze(reasonCodes), objectCreatePermissionMentioned,
  // A provider reason does not establish missing roles, inheritance or deny.
  causeEstablished: false,
});
const unavailable = () => summary('UNAVAILABLE');
function discard(body) {
  // Disposal must not replace a known rejection or wait forever on a bad body.
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {}
}
function project(value) {
  const error = value?.error;
  if (!plain(value) || !plain(error) || error.code !== 403
    || (error.errors !== undefined && (!Array.isArray(error.errors) || error.errors.length > 16))
    || (error.details !== undefined && (!Array.isArray(error.details) || error.details.length > 16))) return unavailable();
  const codes = new Set(); let objectCreatePermissionMentioned = false;
  for (const item of error.errors ?? []) {
    if (plain(item) && item.domain === 'global' && Object.hasOwn(globalReasons, item.reason)) codes.add(globalReasons[item.reason]);
  }
  for (const item of error.details ?? []) {
    if (!plain(item) || item['@type'] !== 'type.googleapis.com/google.rpc.ErrorInfo') continue;
    let code;
    if (item.domain === 'global' && Object.hasOwn(globalReasons, item.reason)) code = globalReasons[item.reason];
    else if (item.domain === 'storage.googleapis.com' && item.reason === 'IAM_PERMISSION_DENIED') code = 'IAM_PERMISSION_DENIED';
    else if (item.domain === 'googleapis.com' && item.reason === 'ORG_RESTRICTION_VIOLATION') code = 'ORG_RESTRICTION_VIOLATION';
    if (code) {
      codes.add(code);
      if (['STORAGE_FORBIDDEN', 'STORAGE_INSUFFICIENT_PERMISSIONS', 'IAM_PERMISSION_DENIED'].includes(code)
        && plain(item.metadata) && item.metadata.permission === 'storage.objects.create') objectCreatePermissionMentioned = true;
    }
  }
  return summary('STRUCTURED_RESPONSE', [...codes].sort(), objectCreatePermissionMentioned);
}
async function readStorage403(response, counters) {
  const encoding = response.headers.get('content-encoding'), declared = response.headers.get('content-length');
  if ((encoding && encoding !== 'identity')
    || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')
    || (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > BODY_LIMIT))
    || counters.metadataBytes >= METADATA_LIMIT) {
    discard(response.body); return unavailable();
  }
  let reader, timer, combined; const chunks = []; let bytes = 0, complete = false;
  try {
    reader = response.body?.getReader();
    if (!reader) return unavailable();
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('DIAGNOSTIC_TIMEOUT')), 1000); });
    for (let reads = 0; reads < 64; reads++) {
      const {done, value} = await Promise.race([reader.read(), deadline]);
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) return unavailable();
      bytes += value.byteLength; counters.metadataBytes += value.byteLength;
      if (bytes > BODY_LIMIT || counters.metadataBytes > METADATA_LIMIT) return unavailable();
      chunks.push(Buffer.from(value));
    }
    if (!complete || (declared !== null && Number(declared) !== bytes)) return unavailable();
    combined = Buffer.concat(chunks);
    return project(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(combined)));
  } catch { return unavailable(); }
  finally {
    clearTimeout(timer);
    discard(reader ?? response.body);
    combined?.fill(0); for (const chunk of chunks) chunk.fill(0);
  }
}

export async function uploadHttpRejection(response, counters, {captureStorage403 = false} = {}) {
  const error = Error('UPLOAD_REFRESH_HTTP_REJECTED'); error.httpStatus = response.status;
  if (captureStorage403 && response.status === 403) {
    // Brand the projection privately. Callers cannot add raw error properties
    // and have them copied into a public result by the runner.
    try { retained.set(error, await readStorage403(response, counters)); }
    catch { discard(response.body); retained.set(error, unavailable()); }
  } else discard(response.body);
  return error;
}

export function uploadHttpFailureSummary(error) { return retained.get(error); }
