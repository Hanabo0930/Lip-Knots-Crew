import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {validatePlan} from './validate-staging-scope.mjs';
import {uploadHttpRejection, uploadHttpFailureSummary} from './upload-http-failure-summary.mjs';
import {UPLOAD_REFRESH_SCOPE as S, UPLOAD_PUBLIC_ACCESS_CONSTRAINT, uploadEffectivePublicAccessPreventionEnforced, assertUploadRefreshBeforeImages,
  prepareUploadSourceRefresh, runUploadRefreshTransaction, bindUploadSourceVerification,
  bindUploadFailedSource, uploadVerifiedSources, uploadExactEventFilterValue,
  uploadStorageTriggerDestinationSummary} from './upload-source-refresh-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = `projects/${S.project}/locations/${S.region}`;
const CF = 'https://cloudfunctions.googleapis.com/v2/';
const STORAGE = 'https://storage.googleapis.com';
export const UPLOAD_BACKUP_PRIVACY_CONFIRMATION = 'ENFORCE_LKC_STAGING_UPLOAD_BACKUP_PUBLIC_ACCESS_PREVENTION';
export const UPLOAD_BACKUP_PERMISSION_NAMES = Object.freeze([
  'storage.buckets.get', 'storage.buckets.getIamPolicy',
  'storage.buckets.update', 'storage.buckets.setIamPolicy',
]);
const backupPermissionURL = new URL(`${STORAGE}/storage/v1/b/${S.bucket}/iam/testPermissions`);
for (const permission of UPLOAD_BACKUP_PERMISSION_NAMES) backupPermissionURL.searchParams.append('permissions', permission);
const fail = code => { throw Error(code); };
const need = (condition, code) => { if (!condition) fail(code); };
const sha = data => createHash('sha256').update(data).digest('hex');
const md5 = data => createHash('md5').update(data).digest('base64');
const safeError = error => /^UPLOAD_REFRESH_[A-Z_]+$/.test(error?.message ?? '')
  ? error.message : 'UPLOAD_REFRESH_EXECUTION_FAILED';
const policy = value => ({...value, version: value.version ?? 1, bindings: value.bindings ?? []});
const objectURL = ref => {
  need(ref?.bucket === S.bucket && typeof ref.object === 'string' && /^[1-9][0-9]{0,19}$/.test(ref.generation ?? ''),
    'UPLOAD_REFRESH_OBJECT_REFERENCE_INVALID');
  const url = new URL(`${STORAGE}/storage/v1/b/${S.bucket}/o/${encodeURIComponent(ref.object)}`);
  url.searchParams.set('generation', ref.generation);
  url.searchParams.set('ifGenerationMatch', ref.generation);
  return url;
};

export function validateUploadRefreshContext(env) {
  validatePlan({mode: 'functions-upload-source-refresh', project: env.LKC_PROJECT_ID,
    region: env.LKC_REGION, sourceRef: env.LKC_SOURCE_REF, functions: env.LKC_FUNCTIONS,
    confirmation: env.LKC_CONFIRMATION});
  need(env.GITHUB_REPOSITORY === 'Hanabo0930/Lip-Knots-Crew' && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_JOB === 'deploy'
    && env.GITHUB_WORKFLOW_REF === 'Hanabo0930/Lip-Knots-Crew/.github/workflows/staging-functions-deploy.yml@refs/heads/main'
    && env.LKC_OPERATION === 'upload-source-refresh' && env.LKC_TRANSFER_MODE_REQUESTED === 'preserve'
    && env.GITHUB_RUN_ATTEMPT === '1' && /^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? '')
    && /^[0-9a-f]{40}$/.test(env.LKC_VERIFIED_SOURCE_SHA ?? '') && env.GITHUB_SHA === env.LKC_VERIFIED_SOURCE_SHA,
  'UPLOAD_REFRESH_PROTECTED_CONTEXT_REQUIRED');
  need(!env.LKC_UPLOAD_WRITE_CONFIRMATION || env.LKC_UPLOAD_WRITE_CONFIRMATION === 'APPLY_LKC_STAGING_UPLOAD_SOURCE_REFRESH',
    'UPLOAD_REFRESH_WRITE_CONFIRMATION_REJECTED');
  need(!env.LKC_UPLOAD_PRIVACY_CONFIRMATION || (env.LKC_UPLOAD_PRIVACY_CONFIRMATION === UPLOAD_BACKUP_PRIVACY_CONFIRMATION
    && !env.LKC_UPLOAD_WRITE_CONFIRMATION), 'UPLOAD_REFRESH_PRIVACY_CONFIRMATION_REJECTED');
}

// Diagnose the existing Storage-trigger assertions using the records already
// read by preflight. Only fixed check names and booleans leave memory; this
// neither authorizes a refresh nor replaces the contract validator below.
export function uploadRefreshStorageTriggerSummary(record) {
  const event = record?.fn?.eventTrigger, trigger = record?.trigger;
  const destination = uploadStorageTriggerDestinationSummary(trigger?.destination);
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f]/u.test(value);
  const bucketFilters = Array.isArray(event?.eventFilters)
    ? event.eventFilters.filter(filter => filter?.attribute === 'bucket' && text(filter.value)) : [];
  const bucket = uploadExactEventFilterValue(event?.eventFilters, 'bucket');
  return {
    functionEventTypeMatches: event?.eventType === 'google.cloud.storage.object.v1.finalized',
    functionTriggerInScope: typeof event?.trigger === 'string' && event.trigger.startsWith(`${PREFIX}/triggers/`),
    singleFunctionBucketFilter: bucketFilters.length === 1,
    functionBucketSeparateFromSource: text(bucket) && bucket !== S.bucket,
    triggerRecordPresent: trigger !== null && typeof trigger === 'object' && !Array.isArray(trigger)
      && Object.getPrototypeOf(trigger) === Object.prototype,
    triggerNameMatches: text(event?.trigger) && trigger?.name === event.trigger,
    triggerUidPresent: Boolean(trigger?.uid),
    destinationServiceMatches: destination.serviceMatches,
    destinationRegionMatches: destination.regionMatches,
    bucketFilterMatches: text(bucket) && uploadExactEventFilterValue(trigger?.eventFilters, 'bucket') === bucket,
    eventTypeFilterMatches: text(event?.eventType) && uploadExactEventFilterValue(trigger?.eventFilters, 'type') === event.eventType,
    triggerServiceAccountMatches: text(event?.serviceAccountEmail) && trigger?.serviceAccount === event.serviceAccountEmail,
    invokerIamCheckEnabled: [undefined, 'false'].includes(record?.service?.metadata?.annotations?.['run.googleapis.com/invoker-iam-disabled']),
  };
}

export function uploadRefreshPreflightSummary(before, bucket) {
  const mode = value => value === undefined ? 'UNSET' : ['paused', 'active', 'acceptance'].includes(value) ? value : 'UNVERIFIED';
  return {functions: S.functions.map(name => ({name,
    state: ['ACTIVE', 'FAILED', 'DEPLOYING', 'DELETING'].includes(before[name]?.fn?.state) ? before[name].fn.state : 'UNVERIFIED',
    revision: new RegExp(`^${name.toLowerCase()}-[0-9]+-[a-z0-9]+$`).test(before[name]?.fn?.serviceConfig?.revision ?? '')
      ? before[name].fn.serviceConfig.revision : 'UNVERIFIED',
    modes: Object.fromEntries(['LKC_NOTIFICATION_DELIVERY_MODE', 'LKC_SHEET_WRITE_MODE', 'LKC_SUBMISSION_TRANSFER_MODE']
      .map(key => [key, mode(before[name]?.fn?.serviceConfig?.environmentVariables?.[key])])),
    invokerIamDisabled: ['true', 'false'].includes(before[name]?.service?.metadata?.annotations?.['run.googleapis.com/invoker-iam-disabled'])
      ? before[name].service.metadata.annotations['run.googleapis.com/invoker-iam-disabled'] : 'UNSET'})),
    storageTrigger: uploadRefreshStorageTriggerSummary(before?.finalizeStagedUpload),
    storageTriggerDestinationType: uploadStorageTriggerDestinationSummary(before?.finalizeStagedUpload?.trigger?.destination).kind,
    backupBucket: {publicAccessPrevention: ['enforced', 'inherited'].includes(bucket?.iamConfiguration?.publicAccessPrevention)
      ? bucket.iamConfiguration.publicAccessPrevention : 'UNVERIFIED',
    uniformBucketLevelAccess: bucket?.iamConfiguration?.uniformBucketLevelAccess?.enabled === true,
    effectivePublicAccessPrevention: uploadEffectivePublicAccessPreventionEnforced(bucket?.effectivePublicAccessPrevention)
      ? 'enforced' : bucket?.effectivePublicAccessPrevention === undefined ? 'not-read' : 'UNVERIFIED',
    parentScope: ['folder', 'organization'].includes(bucket?.project?.parent?.type) ? bucket.project.parent.type
      : bucket?.project?.parent ? 'UNVERIFIED' : 'none'}, sourceMediaRead: false};
}

// One read-only self-test with the existing deployment identity. A failed or
// malformed response is unknown, never evidence that a permission is absent.
export async function inspectUploadBackupPermissions(api) {
  try {
    const response = await api.request(backupPermissionURL.href);
    const held = response?.permissions === undefined ? [] : response.permissions;
    need(response?.kind === 'storage#testIamPermissionsResponse'
      && Object.keys(response).every(key => ['kind', 'permissions'].includes(key))
      && Array.isArray(held) && held.length <= UPLOAD_BACKUP_PERMISSION_NAMES.length
      && new Set(held).size === held.length
      && held.every(name => UPLOAD_BACKUP_PERMISSION_NAMES.includes(name)),
    'UPLOAD_REFRESH_BACKUP_PERMISSIONS_UNVERIFIED');
    const permissions = Object.fromEntries(UPLOAD_BACKUP_PERMISSION_NAMES.map(name => [name, held.includes(name)]));
    return {status: 'VERIFIED_CALLER_PERMISSIONS', permissions,
      privacyUpdatePermissionsPresent: permissions['storage.buckets.update'] && permissions['storage.buckets.setIamPolicy']};
  } catch (error) {
    const httpFailure = uploadHttpFailureSummary(error);
    return {status: 'UNVERIFIED', reason: safeError(error),
      ...(Number.isInteger(error?.httpStatus) ? {httpStatus: error.httpStatus} : {}),
      ...(httpFailure ? {httpFailure} : {})};
  }
}

// One request, bounded response, no redirects and no mutation retries. The
// inherited ADC/WIF identity supplies headers; credentials are never displayed.
export function authenticatedUploadRefreshAPI(auth, fetchImpl = fetch, {allowBackupPrivacyEnforcement = false} = {}) {
  const counters = {requests: 0, metadataBytes: 0, mediaBytes: 0, writesAttempted: 0};
  const seenMutations = new Set(), counts = {uploads: 0, copies: 0, config: 0, patches: 0, media: 0, bucketPrivacy: 0};
  const allowed = new Set(['cloudfunctions.googleapis.com', 'run.googleapis.com',
    `${S.region}-run.googleapis.com`, 'eventarc.googleapis.com', 'storage.googleapis.com',
    'cloudresourcemanager.googleapis.com']);
  async function request(value, {method = 'GET', body, media = false, readOnlyPost = false} = {}) {
    const url = new URL(value);
    need(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && allowed.has(url.hostname),
      'UPLOAD_REFRESH_HTTP_SCOPE_REJECTED');
    const functionPath = `/v2/${PREFIX}/functions/`;
    const exactFunction = S.functions.some(name => url.pathname === functionPath + name);
    const destination = /^(lkc-upload-source-(?:refresh|backups))\/[1-9][0-9]{0,19}\/[0-9a-f]{40}\/(createUploadSession\.zip|finalizeStagedUpload\.zip|before-images\.json)$/;
    const read = method === 'GET' && (
      (url.hostname === 'cloudfunctions.googleapis.com' && (exactFunction
        || S.functions.some(name => url.pathname === functionPath + name + ':getIamPolicy')
        || new RegExp(`^/v2/${PREFIX}/operations/[A-Za-z0-9_-]+$`).test(url.pathname)))
      || (url.hostname === 'run.googleapis.com' && S.functions.some(name => url.pathname === `/v2/${PREFIX}/services/${name.toLowerCase()}:getIamPolicy`))
      || (url.hostname === `${S.region}-run.googleapis.com` && S.functions.some(name => url.pathname === `/apis/serving.knative.dev/v1/namespaces/${S.projectNumber}/services/${name.toLowerCase()}`))
      || (url.hostname === 'eventarc.googleapis.com' && new RegExp(`^/v1/${PREFIX}/triggers/[a-z0-9-]+$`).test(url.pathname))
      || (url.hostname === 'storage.googleapis.com' && new RegExp(`^/storage/v1/b/${S.bucket}(?:/iam|/o/[^/]+)?$`).test(url.pathname))
      || (url.hostname === 'cloudresourcemanager.googleapis.com' && url.pathname === `/v1/projects/${S.project}`));
    const policyRead = readOnlyPost && method === 'POST' && !url.search && url.hostname === 'cloudresourcemanager.googleapis.com'
      && url.pathname === `/v1/projects/${S.project}:getIamPolicy`
      && isDeepStrictEqual(body, {options: {requestedPolicyVersion: 3}});
    const effectivePolicyRead = readOnlyPost && method === 'POST' && !url.search && url.hostname === 'cloudresourcemanager.googleapis.com'
      && url.pathname === `/v1/projects/${S.project}:getEffectiveOrgPolicy`
      && isDeepStrictEqual(body, {constraint: UPLOAD_PUBLIC_ACCESS_CONSTRAINT});
    const permissionRead = method === 'GET' && body === undefined && !media && !readOnlyPost
      && url.href === backupPermissionURL.href;
    const patch = method === 'PATCH' && url.hostname === 'cloudfunctions.googleapis.com' && exactFunction
      && url.search === '?updateMask=buildConfig.source' && body?.name === url.pathname.slice(4)
      && Object.keys(body).sort().join(',') === 'buildConfig,name'
      && Object.keys(body.buildConfig ?? {}).join(',') === 'source'
      && Object.keys(body.buildConfig.source ?? {}).join(',') === 'storageSource'
      && body.buildConfig.source.storageSource?.bucket === S.bucket
      && /^[1-9][0-9]{0,19}$/.test(body.buildConfig.source.storageSource.generation ?? '')
      && destination.test(body.buildConfig.source.storageSource.object ?? '');
    const bucketPrivacyPatch = allowBackupPrivacyEnforcement === true && method === 'PATCH'
      && url.hostname === 'storage.googleapis.com' && url.pathname === `/storage/v1/b/${S.bucket}`
      && /^[1-9][0-9]{0,19}$/.test(url.searchParams.get('ifMetagenerationMatch') ?? '')
      && url.search === '?ifMetagenerationMatch=' + url.searchParams.get('ifMetagenerationMatch')
      && isDeepStrictEqual(body, {iamConfiguration: {publicAccessPrevention: 'enforced'}});
    const upload = method === 'POST' && url.hostname === 'storage.googleapis.com'
      && url.pathname === `/upload/storage/v1/b/${S.bucket}/o`
      && url.searchParams.get('uploadType') === 'media' && url.searchParams.get('ifGenerationMatch') === '0'
      && destination.test(url.searchParams.get('name') ?? '');
    const copyParts = url.hostname === 'storage.googleapis.com'
      ? new RegExp(`^/storage/v1/b/${S.bucket}/o/([^/]+)/copyTo/b/${S.bucket}/o/([^/]+)$`).exec(url.pathname) : null;
    const copyRequest = method === 'POST' && copyParts && url.searchParams.get('ifGenerationMatch') === '0'
      && /^[1-9][0-9]{0,19}$/.test(url.searchParams.get('sourceGeneration') ?? '')
      && url.searchParams.get('sourceGeneration') === url.searchParams.get('ifSourceGenerationMatch')
      && destination.test(decodeURIComponent(copyParts[2])) && isDeepStrictEqual(body, {});
    need(read || policyRead || effectivePolicyRead || permissionRead || patch || bucketPrivacyPatch || upload || copyRequest, 'UPLOAD_REFRESH_HTTP_SCOPE_REJECTED');
    counters.lastRequestKind = bucketPrivacyPatch ? 'backup-bucket-public-access-prevention-update'
      : permissionRead ? 'backup-bucket-permission-self-test'
      : effectivePolicyRead ? 'project-effective-public-access' : policyRead ? 'project-policy' : patch ? 'function-source-update' : upload ? 'private-object-create'
      : copyRequest ? 'source-backup-copy' : url.pathname.endsWith(':getIamPolicy') ? 'invoker-policy'
      : url.hostname === 'storage.googleapis.com' ? 'storage-metadata' : url.hostname === 'eventarc.googleapis.com' ? 'event-trigger'
      : url.hostname === 'cloudresourcemanager.googleapis.com' ? 'project-metadata'
      : url.hostname.includes('run.googleapis.com') ? 'run-service' : 'function-or-operation';
    need(!url.searchParams.has('alt') || (media && url.searchParams.get('alt') === 'media'),
      'UPLOAD_REFRESH_MEDIA_SCOPE_REJECTED');
    need(!media || (read && url.hostname === 'storage.googleapis.com' && url.searchParams.get('alt') === 'media'
      && (destination.test(decodeURIComponent(url.pathname.split('/o/')[1] ?? ''))
        || S.functions.some(name => decodeURIComponent(url.pathname.split('/o/')[1] ?? '') === `${name}/function-source.zip`))
      && decodeURIComponent(url.pathname.split('/o/')[1] ?? '').endsWith('.zip') && ++counts.media <= 2),
    'UPLOAD_REFRESH_MEDIA_SCOPE_REJECTED');
    if (patch || bucketPrivacyPatch || upload || copyRequest) {
      const mutationKey = method + ':' + url.href + (patch ? ':' + JSON.stringify(body.buildConfig.source) : '');
      need(!seenMutations.has(mutationKey), 'UPLOAD_REFRESH_MUTATION_ALREADY_ATTEMPTED'); seenMutations.add(mutationKey);
      if (patch) need(++counts.patches <= 4, 'UPLOAD_REFRESH_MUTATION_LIMIT');
      if (bucketPrivacyPatch) need(++counts.bucketPrivacy <= 1, 'UPLOAD_REFRESH_MUTATION_LIMIT');
      if (copyRequest) need(++counts.copies <= 2, 'UPLOAD_REFRESH_MUTATION_LIMIT');
      if (upload) need(url.searchParams.get('name').endsWith('.zip') ? ++counts.uploads <= 2 : ++counts.config <= 1,
        'UPLOAD_REFRESH_MUTATION_LIMIT');
    }
    need(counters.metadataBytes < 16 * 1024 * 1024, 'UPLOAD_REFRESH_RESPONSE_TOO_LARGE');
    need(++counters.requests <= 700, 'UPLOAD_REFRESH_REQUEST_LIMIT');
    let headers;
    try { headers = new Headers(await auth.getRequestHeaders(url.href)); }
    catch { fail('UPLOAD_REFRESH_AUTHENTICATION_UNKNOWN'); }
    headers.set('accept-encoding', 'identity'); headers.set('cache-control', 'no-cache');
    let data;
    if (body !== undefined) {
      data = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
      headers.set('content-type', Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json');
    }
    if (method !== 'GET' && !policyRead && !effectivePolicyRead) counters.writesAttempted++;
    let response;
    try { response = await fetchImpl(url, {method, headers, body: data, redirect: 'error', signal: AbortSignal.timeout(45000)}); }
    catch { fail('UPLOAD_REFRESH_HTTP_OUTCOME_UNKNOWN'); }
    if (!response.ok) {
      throw await uploadHttpRejection(response, counters,
        {captureStorage403: url.hostname === 'storage.googleapis.com' && !media});
    }
    need(!response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity',
      'UPLOAD_REFRESH_HTTP_ENCODING_REJECTED');
    const maximum = media ? S.sourceBytes : S.configBytes;
    const declared = response.headers.get('content-length');
    need(!declared || (/^[0-9]+$/.test(declared) && Number(declared) <= maximum), 'UPLOAD_REFRESH_RESPONSE_TOO_LARGE');
    const chunks = []; let total = 0;
    try {
      for await (const chunk of response.body ?? []) {
        total += chunk.length;
        if (media) counters.mediaBytes += chunk.length; else counters.metadataBytes += chunk.length;
        need(total <= maximum && counters.mediaBytes <= S.totalSourceBytes
          && counters.metadataBytes <= 16 * 1024 * 1024, 'UPLOAD_REFRESH_RESPONSE_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) { fail(safeError(error)); }
    const result = Buffer.concat(chunks);
    if (media) return result;
    try { return JSON.parse(result.toString('utf8')); }
    catch { fail('UPLOAD_REFRESH_JSON_REJECTED'); }
  }
  return {request, counters};
}

export function uploadRefreshReader(api) {
  const get = url => api.request(url);
  async function readPair() {
    const pair = {};
    for (const name of S.functions) {
      const fn = await get(CF + `${PREFIX}/functions/${name}`);
      const service = await get(`https://${S.region}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/${S.projectNumber}/services/${name.toLowerCase()}`);
      const iam = policy(await get(`https://run.googleapis.com/v2/${PREFIX}/services/${name.toLowerCase()}:getIamPolicy?options.requestedPolicyVersion=3`));
      const functionPolicy = policy(await get(CF + `${PREFIX}/functions/${name}:getIamPolicy?options.requestedPolicyVersion=3`));
      let trigger = null;
      if (name === 'finalizeStagedUpload') {
        need(new RegExp(`^${PREFIX}/triggers/[a-z0-9-]+$`).test(fn.eventTrigger?.trigger ?? ''),
          'UPLOAD_REFRESH_STORAGE_TRIGGER_NOT_VERIFIED');
        trigger = await get('https://eventarc.googleapis.com/v1/' + fn.eventTrigger.trigger);
      }
      const ref = fn.buildConfig?.sourceProvenance?.resolvedStorageSource;
      const object = await get(objectURL(ref));
      pair[name] = {fn, service, policy: iam, functionPolicy, trigger, object};
    }
    return pair;
  }
  async function readBucket({skipEffectivePublicAccessPrevention = false} = {}) {
    const bucket = await get(`${STORAGE}/storage/v1/b/${S.bucket}`);
    bucket.policy = policy(await get(`${STORAGE}/storage/v1/b/${S.bucket}/iam?optionsRequestedPolicyVersion=3`));
    bucket.project = await get(`https://cloudresourcemanager.googleapis.com/v1/projects/${S.project}`);
    bucket.projectPolicy = policy(await api.request(`https://cloudresourcemanager.googleapis.com/v1/projects/${S.project}:getIamPolicy`,
      {method: 'POST', body: {options: {requestedPolicyVersion: 3}}, readOnlyPost: true}));
    if (!skipEffectivePublicAccessPrevention && bucket.iamConfiguration?.publicAccessPrevention === 'inherited' && bucket.project?.parent) {
      bucket.effectivePublicAccessPrevention = await api.request(`https://cloudresourcemanager.googleapis.com/v1/projects/${S.project}:getEffectiveOrgPolicy`,
        {method: 'POST', body: {constraint: UPLOAD_PUBLIC_ACCESS_CONSTRAINT}, readOnlyPost: true});
    }
    return bucket;
  }
  return {readPair, readBucket};
}

// The president approved this one bucket setting on 2026-11-01. Use the
// existing protected owner identity, a fresh conflict guard and one PATCH.
// Full before/after metadata and policies stay in memory, never in artifacts.
export async function enforceUploadBackupPrivacy(api, reader) {
  const read = () => reader.readBucket({skipEffectivePublicAccessPrevention: true});
  const validate = bucket => need(bucket?.name === S.bucket && bucket.projectNumber === S.projectNumber
    && bucket.location === S.region.toUpperCase() && bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled === true
    && bucket.project?.projectId === S.project && bucket.project.projectNumber === S.projectNumber
    && bucket.project.lifecycleState === 'ACTIVE' && /^[1-9][0-9]{0,19}$/.test(bucket.metageneration ?? '')
    && ['inherited', 'enforced'].includes(bucket.iamConfiguration.publicAccessPrevention),
  'UPLOAD_REFRESH_PRIVACY_BUCKET_NOT_VERIFIED');
  const before = await read(); validate(before);
  if (before.iamConfiguration.publicAccessPrevention === 'enforced')
    return {summary: {status: 'ALREADY_ENFORCED', changed: false}};
  const fresh = await read(); validate(fresh);
  need(isDeepStrictEqual(fresh, before), 'UPLOAD_REFRESH_PRIVACY_BEFORE_IMAGE_DRIFT');
  const url = new URL(`${STORAGE}/storage/v1/b/${S.bucket}`);
  url.searchParams.set('ifMetagenerationMatch', fresh.metageneration);
  await api.request(url, {method: 'PATCH', body: {iamConfiguration: {publicAccessPrevention: 'enforced'}}});
  const after = await read(); validate(after);
  need(after.iamConfiguration.publicAccessPrevention === 'enforced'
    && BigInt(after.metageneration) === BigInt(fresh.metageneration) + 1n,
  'UPLOAD_REFRESH_PRIVACY_READBACK_NOT_VERIFIED');
  const comparable = bucket => {
    const {metageneration, updated, etag, ...stable} = structuredClone(bucket);
    delete stable.iamConfiguration.publicAccessPrevention;
    return stable;
  };
  need(isDeepStrictEqual(comparable(after), comparable(fresh)), 'UPLOAD_REFRESH_PRIVACY_OTHER_SETTINGS_CHANGED');
  return {summary: {status: 'ENFORCED_AND_VERIFIED', changed: true}};
}

function pinnedObject(metadata) {
  need(metadata?.bucket === S.bucket && typeof metadata.name === 'string' && /^[1-9][0-9]{0,19}$/.test(metadata.generation ?? ''),
    'UPLOAD_REFRESH_NEW_OBJECT_INVALID');
  return {bucket: metadata.bucket, object: metadata.name, generation: metadata.generation};
}
export async function writeUploadRefreshObject(api, destination, body) {
  need(destination.bucket === S.bucket && /^lkc-upload-source-(?:refresh|backups)\/[1-9][0-9]{0,19}\/[0-9a-f]{40}\/(?:createUploadSession\.zip|finalizeStagedUpload\.zip|before-images\.json)$/.test(destination.object),
    'UPLOAD_REFRESH_WRITE_DESTINATION_REJECTED');
  need(Buffer.byteLength(body) <= (destination.object.endsWith('.zip') ? S.sourceBytes : S.configBytes), 'UPLOAD_REFRESH_WRITE_TOO_LARGE');
  const url = new URL(`${STORAGE}/upload/storage/v1/b/${S.bucket}/o`);
  url.search = new URLSearchParams({uploadType: 'media', name: destination.object, ifGenerationMatch: '0'});
  const created = await api.request(url, {method: 'POST', body});
  need(created.bucket === destination.bucket && created.name === destination.object
    && created.size === String(Buffer.byteLength(body)) && created.md5Hash === md5(body), 'UPLOAD_REFRESH_NEW_OBJECT_INVALID');
  const observed = await api.request(objectURL(pinnedObject(created)));
  need(['bucket', 'name', 'generation', 'size', 'md5Hash'].every(key => observed[key] === created[key]),
    'UPLOAD_REFRESH_NEW_OBJECT_INVALID');
  return observed;
}

export function uploadRefreshCloudOwner(api, reader, originalBucket, {plan, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  const backups = new Map();
  async function unchangedBucket() {
    need(isDeepStrictEqual(await reader.readBucket(), originalBucket), 'UPLOAD_REFRESH_BUCKET_CONFIGURATION_CHANGED');
  }
  async function saveBackups(requests) {
    const receipts = [];
    for (const item of requests) {
      await unchangedBucket();
      let result;
      if (item.kind === 'copy-source') {
        need(item.ifGenerationMatch === '0' && item.ifSourceGenerationMatch === item.source.generation
          && item.source.bucket === S.bucket && item.destination.bucket === S.bucket, 'UPLOAD_REFRESH_COPY_SCOPE_REJECTED');
        const url = new URL(`${STORAGE}/storage/v1/b/${S.bucket}/o/${encodeURIComponent(item.source.object)}/copyTo/b/${S.bucket}/o/${encodeURIComponent(item.destination.object)}`);
        url.search = new URLSearchParams({sourceGeneration: item.source.generation,
          ifSourceGenerationMatch: item.source.generation, ifGenerationMatch: '0'});
        const created = await api.request(url, {method: 'POST', body: {}});
        result = await api.request(objectURL(pinnedObject(created)));
      } else {
        need(item.kind === 'private-config' && item.ifGenerationMatch === '0', 'UPLOAD_REFRESH_BACKUP_SCOPE_REJECTED');
        result = await writeUploadRefreshObject(api, item.destination, item.body);
      }
      receipts.push(result); backups.set(result.name + '#' + result.generation, result);
    }
    return receipts;
  }
  async function update(patch, restore) {
    need(S.functions.some(name => patch.name === `${PREFIX}/functions/${name}`)
      && patch.updateMask === 'buildConfig.source' && Object.keys(patch.body).sort().join(',') === 'buildConfig,name'
      && Object.keys(patch.body.buildConfig).join(',') === 'source'
      && Object.keys(patch.body.buildConfig.source).join(',') === 'storageSource'
      && patch.body.name === patch.name, 'UPLOAD_REFRESH_PATCH_SCOPE_REJECTED');
    if (restore) {
      const ref = patch.body.buildConfig.source.storageSource;
      const pinned = backups.get(ref.object + '#' + ref.generation);
      need(pinned && isDeepStrictEqual(await api.request(objectURL(ref)), pinned), 'UPLOAD_REFRESH_BACKUP_CHANGED');
    }
    await unchangedBucket();
    let operation;
    try { operation = await api.request(CF + patch.name + '?updateMask=buildConfig.source', {method: 'PATCH', body: patch.body}); }
    catch (error) {
      if ([400, 403, 404, 409, 412].includes(error.httpStatus)) return {status: 'failed'};
      return {status: 'unknown'};
    }
    need(new RegExp(`^${PREFIX}/operations/[A-Za-z0-9_-]+$`).test(operation?.name ?? '')
      && operation.metadata?.target === patch.name, 'UPLOAD_REFRESH_OPERATION_IDENTITY_UNKNOWN');
    const operationName = operation.name;
    for (let polls = 0; polls <= 120; polls++) {
      if (operation.done === true) {
        if (operation.error) {
          const fn = await api.request(CF + patch.name);
          const ref = fn.buildConfig?.sourceProvenance?.resolvedStorageSource;
          need(fn.name === patch.name, 'UPLOAD_REFRESH_FUNCTION_NOT_VERIFIED');
          const metadata = await api.request(objectURL(ref));
          return {status: 'failed', verifiedFailureSource: bindUploadFailedSource(plan, patch.name.split('/').at(-1), ref, metadata)};
        }
        need(operation.response?.name === patch.name, 'UPLOAD_REFRESH_OPERATION_IDENTITY_UNKNOWN');
        const fn = await api.request(CF + patch.name);
        need(fn.name === patch.name && fn.state === 'ACTIVE', 'UPLOAD_REFRESH_FUNCTION_NOT_VERIFIED');
        const ref = fn.buildConfig?.sourceProvenance?.resolvedStorageSource;
        const name = patch.name.split('/').at(-1);
        let content;
        if (restore) content = await api.request(objectURL(ref));
        else {
          const url = objectURL(ref); url.searchParams.set('alt', 'media');
          content = await api.request(url, {media: true});
        }
        let verifiedSource;
        try { verifiedSource = bindUploadSourceVerification(plan, name, ref, content, restore); }
        finally { if (Buffer.isBuffer(content)) content.fill(0); }
        return {status: 'succeeded', verifiedSource};
      }
      if (polls === 120) return {status: 'unknown'};
      await sleep(5000); operation = await api.request(CF + operationName);
      need(operation.name === operationName && operation.metadata?.target === patch.name, 'UPLOAD_REFRESH_OPERATION_IDENTITY_UNKNOWN');
    }
  }
  return {readPair: reader.readPair, saveBackups,
    updateOne: patch => update(patch, false), restoreOne: patch => update(patch, true)};
}

export async function runUploadSourceRefresh(env = process.env, dependencies = {}) {
  let temporary, result = {status: 'STOPPED_SAFELY', deployedFunctionsVerified: false}, api;
  const privateBuffers = [];
  try {
    validateUploadRefreshContext(env);
    const root = fs.realpathSync(env.LKC_SOURCE_DIRECTORY ?? '');
    const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
    need(git(['rev-parse', 'HEAD']) === env.LKC_VERIFIED_SOURCE_SHA && !git(['diff', 'HEAD', '--name-only']),
      'UPLOAD_REFRESH_SOURCE_COMMIT_MISMATCH');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'functions/package.json'), 'utf8'));
    const locked = JSON.parse(fs.readFileSync(path.join(root, 'functions/package-lock.json'), 'utf8'));
    need(locked.lockfileVersion === 3 && ['dependencies', 'devDependencies', 'engines'].every(key =>
      isDeepStrictEqual(locked.packages?.['']?.[key] ?? {}, manifest[key] ?? {})), 'UPLOAD_REFRESH_STANDALONE_LOCK_REQUIRED');
    const tracked = new Set(git(['ls-files', 'functions']).split('\n'));
    for (const folder of ['src', 'case-mail-runtime']) {
      const visit = directory => { for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
        const file = path.join(directory, item.name);
        if (item.isDirectory()) visit(file);
        else need(item.isFile() && tracked.has(path.relative(root, file).split(path.sep).join('/')),
          'UPLOAD_REFRESH_UNTRACKED_SOURCE_REJECTED');
      }};
      visit(path.join(root, 'functions', folder));
    }
    if (dependencies.api) api = dependencies.api;
    else {
      const require = createRequire(path.join(root, 'package.json'));
      const {GoogleAuth} = require('google-auth-library');
      api = authenticatedUploadRefreshAPI(await new GoogleAuth({scopes: ['https://www.googleapis.com/auth/cloud-platform']}).getClient(), fetch,
        {allowBackupPrivacyEnforcement: env.LKC_UPLOAD_PRIVACY_CONFIRMATION === UPLOAD_BACKUP_PRIVACY_CONFIRMATION});
    }
    const reader = uploadRefreshReader(api);
    if (!env.LKC_UPLOAD_WRITE_CONFIRMATION && !env.LKC_UPLOAD_PRIVACY_CONFIRMATION) {
      result.backupBucketPermissions = await inspectUploadBackupPermissions(api);
    }
    if (env.LKC_UPLOAD_PRIVACY_CONFIRMATION) {
      result.backupPrivacyEnforcement = {status: 'REQUESTED_RESULT_UNVERIFIED', changed: null};
      result.backupPrivacyEnforcement = (await enforceUploadBackupPrivacy(api, reader)).summary;
    }
    const before = await reader.readPair(), bucket = await reader.readBucket();
    result.preflight = uploadRefreshPreflightSummary(before, bucket);
    assertUploadRefreshBeforeImages(before, bucket);
    if (!env.LKC_UPLOAD_WRITE_CONFIRMATION) {
      result = {...result, status: 'UPLOAD_SOURCE_PREFLIGHT_VERIFIED', sourceRefreshPreflightVerified: true,
        environment: dependencies.api ? 'isolated-test' : env.LKC_UPLOAD_PRIVACY_CONFIRMATION
          ? 'staging-bucket-privacy-and-read-only-preflight' : 'staging-read-only'};
      return result;
    }
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lkc-upload-source-refresh-')); fs.chmodSync(temporary, 0o700);
    const packages = JSON.parse(execFileSync('python3', [path.join(HERE, 'package-upload-source-refresh.py'), '--root', root, '--output', temporary],
      {encoding: 'utf8', maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe']}));
    need(isDeepStrictEqual(await reader.readPair(), before), 'UPLOAD_REFRESH_BEFORE_IMAGE_DRIFT');
    const replacements = {}, replacementObjects = {}, localHashes = {};
    for (const name of S.functions) {
      need(packages[name]?.path === path.join(temporary, name + '.zip'), 'UPLOAD_REFRESH_PACKAGE_PATH_REJECTED');
      const buffer = fs.readFileSync(packages[name].path); privateBuffers.push(buffer);
      need(buffer.length <= S.sourceBytes && buffer.length === packages[name].bytes
        && sha(buffer) === packages[name].sha256 && md5(buffer) === packages[name].md5Hash, 'UPLOAD_REFRESH_PACKAGE_CHANGED');
      need(isDeepStrictEqual(await reader.readBucket(), bucket), 'UPLOAD_REFRESH_BUCKET_CONFIGURATION_CHANGED');
      const info = await writeUploadRefreshObject(api, {bucket: S.bucket,
        object: `lkc-upload-source-refresh/${env.GITHUB_RUN_ID}/${env.LKC_VERIFIED_SOURCE_SHA}/${name}.zip`}, buffer);
      replacements[name] = pinnedObject(info); replacementObjects[name] = info; localHashes[name] = packages[name].sha256;
    }
    const plan = prepareUploadSourceRefresh({sourceSha: env.LKC_VERIFIED_SOURCE_SHA, runId: env.GITHUB_RUN_ID,
      runAttempt: 1, before, replacements, bucket, replacementHashes: localHashes, replacementObjects});
    result = await runUploadRefreshTransaction(plan, uploadRefreshCloudOwner(api, reader, bucket, {plan}), dependencies.api ? 'isolated-test' : 'staging-cloud');
    if (result.status === 'SOURCE_ONLY_CONTRACT_VERIFIED') {
      const after = await reader.readPair();
      const verifiedSources = uploadVerifiedSources(plan);
      for (const name of S.functions) {
        const ref = after[name].fn.buildConfig.sourceProvenance.resolvedStorageSource;
        need(isDeepStrictEqual(ref, verifiedSources[name]), 'UPLOAD_REFRESH_SOURCE_CHANGED');
      }
      need(isDeepStrictEqual(await reader.readPair(), after), 'UPLOAD_REFRESH_AFTER_IMAGE_DRIFT');
      const uri = new URL(after.createUploadSession.fn.serviceConfig.uri);
      need(uri.protocol === 'https:' && uri.hostname.endsWith('.run.app') && !uri.username && !uri.password
        && !uri.search && !uri.hash && !uri.port && uri.pathname === '/', 'UPLOAD_REFRESH_PROBE_URI_REJECTED');
      const response = await (dependencies.fetch ?? fetch)(uri, {method: 'POST', redirect: 'error',
        headers: {'content-type': 'application/json'}, body: '{"data":{}}', signal: AbortSignal.timeout(30000)});
      await response.body?.cancel();
      need([401, 403].includes(response.status), 'UPLOAD_REFRESH_UNAUTHENTICATED_REJECTION_NOT_VERIFIED');
      result = {...result, status: dependencies.api ? result.status : 'UPLOAD_SOURCE_REFRESH_VERIFIED',
        deployedPackageBytesVerified: true, unauthenticatedRejectionVerified: true};
    }
  } catch (error) {
    result = {...result, status: 'STOPPED_SAFELY', reason: safeError(error), deployedFunctionsVerified: false};
    if (Number.isInteger(error.httpStatus)) result.httpStatus = error.httpStatus;
    const httpFailure = uploadHttpFailureSummary(error);
    if (httpFailure) result.httpFailure = httpFailure;
  } finally {
    for (const buffer of privateBuffers) buffer.fill(0);
    try { if (temporary) fs.rmSync(temporary, {recursive: true, force: true}); result.cleanup = 'DONE'; }
    catch { result.cleanup = 'FAILED'; }
    result.cloudWritesAttempted = !dependencies.api && Boolean(api?.counters.writesAttempted);
    result.requests = api?.counters.requests ?? 0; result.mediaBytes = api?.counters.mediaBytes ?? 0;
    if (api?.counters.lastRequestKind) result.lastRequestKind = api.counters.lastRequestKind;
    result.sourceSha = /^[0-9a-f]{40}$/.test(env.LKC_VERIFIED_SOURCE_SHA ?? '') ? env.LKC_VERIFIED_SOURCE_SHA : null;
    result.functions = S.functions;
    // The only artifact is this bounded result. Full settings, manifests and
    // package bytes remain private or in the reviewed private bucket.
    if (env.GITHUB_WORKSPACE) fs.writeFileSync(path.join(env.GITHUB_WORKSPACE, 'upload-source-refresh-result.json'), JSON.stringify(result) + '\n', {mode: 0o600});
  }
  return result;
}



