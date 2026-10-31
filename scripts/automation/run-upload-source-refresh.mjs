import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {validatePlan} from './validate-staging-scope.mjs';
import {UPLOAD_REFRESH_SCOPE as S, assertUploadRefreshBeforeImages,
  prepareUploadSourceRefresh, runUploadRefreshTransaction, bindUploadSourceVerification,
  bindUploadFailedSource, uploadVerifiedSources} from './upload-source-refresh-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = `projects/${S.project}/locations/${S.region}`;
const CF = 'https://cloudfunctions.googleapis.com/v2/';
const STORAGE = 'https://storage.googleapis.com';
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
    backupBucket: {publicAccessPrevention: ['enforced', 'inherited'].includes(bucket?.iamConfiguration?.publicAccessPrevention)
      ? bucket.iamConfiguration.publicAccessPrevention : 'UNVERIFIED',
    uniformBucketLevelAccess: bucket?.iamConfiguration?.uniformBucketLevelAccess?.enabled === true,
    parentScope: ['folder', 'organization'].includes(bucket?.project?.parent?.type) ? bucket.project.parent.type
      : bucket?.project?.parent ? 'UNVERIFIED' : 'none'}, sourceMediaRead: false};
}

// One request, bounded response, no redirects and no mutation retries. The
// inherited ADC/WIF identity supplies headers; credentials are never displayed.
export function authenticatedUploadRefreshAPI(auth, fetchImpl = fetch) {
  const counters = {requests: 0, metadataBytes: 0, mediaBytes: 0, writesAttempted: 0};
  const seenMutations = new Set(), counts = {uploads: 0, copies: 0, config: 0, patches: 0, media: 0};
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
    const policyRead = readOnlyPost && method === 'POST' && url.hostname === 'cloudresourcemanager.googleapis.com'
      && url.pathname === `/v1/projects/${S.project}:getIamPolicy`
      && isDeepStrictEqual(body, {options: {requestedPolicyVersion: 3}});
    const patch = method === 'PATCH' && url.hostname === 'cloudfunctions.googleapis.com' && exactFunction
      && url.search === '?updateMask=buildConfig.source' && body?.name === url.pathname.slice(4)
      && Object.keys(body).sort().join(',') === 'buildConfig,name'
      && Object.keys(body.buildConfig ?? {}).join(',') === 'source'
      && Object.keys(body.buildConfig.source ?? {}).join(',') === 'storageSource'
      && body.buildConfig.source.storageSource?.bucket === S.bucket
      && /^[1-9][0-9]{0,19}$/.test(body.buildConfig.source.storageSource.generation ?? '')
      && destination.test(body.buildConfig.source.storageSource.object ?? '');
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
    need(read || policyRead || patch || upload || copyRequest, 'UPLOAD_REFRESH_HTTP_SCOPE_REJECTED');
    counters.lastRequestKind = policyRead ? 'project-policy' : patch ? 'function-source-update' : upload ? 'private-object-create'
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
    if (patch || upload || copyRequest) {
      const mutationKey = method + ':' + url.href + (patch ? ':' + JSON.stringify(body.buildConfig.source) : '');
      need(!seenMutations.has(mutationKey), 'UPLOAD_REFRESH_MUTATION_ALREADY_ATTEMPTED'); seenMutations.add(mutationKey);
      if (patch) need(++counts.patches <= 4, 'UPLOAD_REFRESH_MUTATION_LIMIT');
      if (copyRequest) need(++counts.copies <= 2, 'UPLOAD_REFRESH_MUTATION_LIMIT');
      if (upload) need(url.searchParams.get('name').endsWith('.zip') ? ++counts.uploads <= 2 : ++counts.config <= 1,
        'UPLOAD_REFRESH_MUTATION_LIMIT');
    }
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
    if (method !== 'GET' && !readOnlyPost) counters.writesAttempted++;
    let response;
    try { response = await fetchImpl(url, {method, headers, body: data, redirect: 'error', signal: AbortSignal.timeout(45000)}); }
    catch { fail('UPLOAD_REFRESH_HTTP_OUTCOME_UNKNOWN'); }
    if (!response.ok) {
      await response.body?.cancel();
      const error = Error('UPLOAD_REFRESH_HTTP_REJECTED'); error.httpStatus = response.status; throw error;
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
  async function readBucket() {
    const bucket = await get(`${STORAGE}/storage/v1/b/${S.bucket}`);
    bucket.policy = policy(await get(`${STORAGE}/storage/v1/b/${S.bucket}/iam?optionsRequestedPolicyVersion=3`));
    bucket.project = await get(`https://cloudresourcemanager.googleapis.com/v1/projects/${S.project}`);
    bucket.projectPolicy = policy(await api.request(`https://cloudresourcemanager.googleapis.com/v1/projects/${S.project}:getIamPolicy`,
      {method: 'POST', body: {options: {requestedPolicyVersion: 3}}, readOnlyPost: true}));
    return bucket;
  }
  return {readPair, readBucket};
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
      api = authenticatedUploadRefreshAPI(await new GoogleAuth({scopes: ['https://www.googleapis.com/auth/cloud-platform']}).getClient());
    }
    const reader = uploadRefreshReader(api), before = await reader.readPair(), bucket = await reader.readBucket();
    result.preflight = uploadRefreshPreflightSummary(before, bucket);
    assertUploadRefreshBeforeImages(before, bucket);
    if (!env.LKC_UPLOAD_WRITE_CONFIRMATION) {
      result = {...result, status: 'UPLOAD_SOURCE_PREFLIGHT_VERIFIED', sourceRefreshPreflightVerified: true,
        environment: dependencies.api ? 'isolated-test' : 'staging-read-only'};
      return result;
    }
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lkc-upload-source-refresh-')); fs.chmodSync(temporary, 0o700);
    const environment = Object.fromEntries(S.functions.map(name => [name, before[name].fn.serviceConfig.environmentVariables]));
    const packages = JSON.parse(execFileSync('python3', [path.join(HERE, 'package-upload-source-refresh.py'), '--root', root, '--output', temporary],
      {input: JSON.stringify(environment), encoding: 'utf8', maxBuffer: 65536, stdio: ['pipe', 'pipe', 'pipe']}));
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
  } finally {
    for (const buffer of privateBuffers) buffer.fill(0);
    try { if (temporary) fs.rmSync(temporary, {recursive: true, force: true}); result.cleanup = 'DONE'; }
    catch { result.cleanup = 'FAILED'; }
    result.cloudWritesAttempted = !dependencies.api && Boolean(api?.counters.writesAttempted);
    result.requests = api?.counters.requests ?? 0; result.mediaBytes = api?.counters.mediaBytes ?? 0;
    if (api?.counters.lastRequestKind) result.lastRequestKind = api.counters.lastRequestKind;
    result.sourceSha = env.LKC_VERIFIED_SOURCE_SHA ?? null;
    result.functions = S.functions;
    // The only artifact is this bounded result. Full settings, manifests and
    // package bytes remain private or in the reviewed private bucket.
    if (env.GITHUB_WORKSPACE) fs.writeFileSync(path.join(env.GITHUB_WORKSPACE, 'upload-source-refresh-result.json'), JSON.stringify(result) + '\n', {mode: 0o600});
  }
  return result;
}
