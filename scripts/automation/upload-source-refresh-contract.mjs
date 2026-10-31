import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

// Preparation/verification for the existing Functions owner route. This module
// has no cloud client, CLI entrypoint, credentials or deployment authorization.
export const UPLOAD_REFRESH_SCOPE = Object.freeze({
  project: 'lip-knots-crew-staging', region: 'asia-northeast1',
  projectNumber: '740154137290',
  bucket: 'gcf-v2-sources-740154137290-asia-northeast1',
  functions: Object.freeze(['createUploadSession', 'finalizeStagedUpload']),
  sourceBytes: 10 * 1024 * 1024, totalSourceBytes: 20 * 1024 * 1024,
  configBytes: 512 * 1024,
});
export const UPLOAD_PUBLIC_ACCESS_CONSTRAINT = 'constraints/storage.publicAccessPrevention';
const S = UPLOAD_REFRESH_SCOPE;
const PREFIX = `projects/${S.project}/locations/${S.region}`;
const privatePlans = new WeakMap(), verifiedBackups = new WeakMap(), consumed = new WeakSet();
const sourceReceipts = new WeakMap(), verifiedFinalSources = new WeakMap();
const fail = code => { throw Error(code); };
const requireValue = (condition, code) => { if (!condition) fail(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const clone = value => JSON.parse(JSON.stringify(value));
const stable = value => Array.isArray(value) ? value.map(stable) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const bytes = value => Buffer.from(JSON.stringify(stable(value)) + '\n');
const digest = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('base64');
const omit = (value, keys) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f]/u.test(value);
const base64 = (value, count) => typeof value === 'string' && Buffer.from(value, 'base64').length === count
  && Buffer.from(value, 'base64').toString('base64') === value;
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function state(plan) {
  requireValue(privatePlans.has(plan), 'UPLOAD_REFRESH_PLAN_REQUIRED');
  return privatePlans.get(plan);
}
function paused(env) {
  requireValue(plain(env) && env.APP_ENVIRONMENT === 'staging'
    && env.EXPECTED_FIREBASE_PROJECT_ID === S.project
    && ['LKC_NOTIFICATION_DELIVERY_MODE', 'LKC_SUBMISSION_TRANSFER_MODE']
      .every(key => env[key] === 'paused')
    // The actual sheet-write-control closes on every value except "active".
    // Preserve an absent setting as absent; never fabricate an environment value.
    && (!Object.hasOwn(env, 'LKC_SHEET_WRITE_MODE') || env.LKC_SHEET_WRITE_MODE === 'paused'),
  'UPLOAD_REFRESH_PAUSE_NOT_VERIFIED');
  requireValue(Object.values(env).every(value => typeof value === 'string'), 'UPLOAD_REFRESH_ENV_INVALID');
}
export function uploadEffectivePublicAccessPreventionEnforced(policy) {
  return plain(policy) && policy.constraint === UPLOAD_PUBLIC_ACCESS_CONSTRAINT
    && Object.keys(policy).every(key => ['constraint', 'booleanPolicy', 'version', 'etag', 'updateTime'].includes(key))
    && [undefined, 0].includes(policy.version) && [undefined, ''].includes(policy.etag)
    && (!Object.hasOwn(policy, 'updateTime') || text(policy.updateTime))
    && plain(policy.booleanPolicy) && Object.keys(policy.booleanPolicy).join(',') === 'enforced'
    && policy.booleanPolicy.enforced === true;
}
function source(ref) {
  requireValue(plain(ref) && Object.keys(ref).sort().join(',') === 'bucket,generation,object'
    && ref.bucket === S.bucket && text(ref.object) && !ref.object.startsWith('/')
    && !ref.object.split('/').some(part => ['', '.', '..'].includes(part))
    && !/[\\?#]/u.test(ref.object) && ref.object.endsWith('.zip') && decimal(ref.generation),
  'UPLOAD_REFRESH_PINNED_SOURCE_REQUIRED');
  return ref;
}
function objectMetadata(info, ref) {
  source(ref);
  requireValue(plain(info) && info.bucket === ref.bucket && info.name === ref.object
    && info.generation === ref.generation && decimal(info.size)
    && Number(info.size) <= S.sourceBytes && base64(info.md5Hash, 16) && base64(info.crc32c, 4)
    && !info.contentEncoding && !info.customerEncryption, 'UPLOAD_REFRESH_SOURCE_METADATA_INVALID');
}
function privatePolicy(policy) {
  requireValue(plain(policy) && (text(policy.etag) || (!Object.hasOwn(policy, 'etag')
      && policy.version === 1 && Array.isArray(policy.bindings) && policy.bindings.length === 0))
    && [1, 3].includes(policy.version) && Array.isArray(policy.bindings)
    && policy.bindings.every(binding => plain(binding) && text(binding.role)
      && Array.isArray(binding.members) && binding.members.every(text)
      && !binding.members.some(member => ['allUsers', 'allAuthenticatedUsers'].includes(member))),
  'UPLOAD_REFRESH_PRIVATE_POLICY_REQUIRED');
}
function validateRecord(record, name, active = true) {
  requireValue(plain(record) && plain(record.fn) && plain(record.service), 'UPLOAD_REFRESH_BEFORE_IMAGE_REQUIRED');
  const fn = record.fn, service = record.service, conf = fn.serviceConfig;
  requireValue(fn.name === `${PREFIX}/functions/${name}` && fn.environment === 'GEN_2'
    && (fn.state === 'ACTIVE' || (!active && fn.state === 'FAILED'))
    && fn.buildConfig?.runtime === 'nodejs22' && fn.buildConfig.entryPoint === name
    && fn.buildConfig.environmentVariables?.GOOGLE_NODE_RUN_SCRIPTS === ''
    && plain(conf) && conf.service === `${PREFIX}/services/${name.toLowerCase()}` && conf.allTrafficOnLatestRevision === true
    && new RegExp(`^${name.toLowerCase()}-[0-9]+-[a-z0-9]+$`).test(conf.revision ?? '')
    && text(conf.serviceAccountEmail) && text(fn.updateTime), 'UPLOAD_REFRESH_FUNCTION_NOT_VERIFIED');
  paused(conf.environmentVariables);
  requireValue((conf.secretEnvironmentVariables ?? []).every(item => plain(item) && decimal(item.version))
    && (conf.secretVolumes ?? []).every(volume => plain(volume) && Array.isArray(volume.versions)
      && volume.versions.every(item => plain(item) && decimal(item.version))),
  'UPLOAD_REFRESH_PINNED_SECRET_VERSION_REQUIRED');
  source(fn.buildConfig.sourceProvenance?.resolvedStorageSource);
  requireValue(service.metadata?.name === name.toLowerCase()
    && service.metadata.namespace === S.projectNumber
    && plain(service.metadata.annotations)
    && [undefined, 'true', 'false'].includes(service.metadata.annotations['run.googleapis.com/invoker-iam-disabled'])
    && service.status?.latestReadyRevisionName === conf.revision
    && service.status.latestCreatedRevisionName === conf.revision
    && service.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True')
    && service.status.traffic?.length === 1 && service.status.traffic[0].percent === 100
    && service.status.traffic[0].revisionName === conf.revision
    && service.status.url === conf.uri
    && service.spec?.template?.spec?.serviceAccountName === conf.serviceAccountEmail
    && service.spec.template.spec.containers?.length === 1, 'UPLOAD_REFRESH_SERVICE_NOT_VERIFIED');
  const env = service.spec.template.spec.containers[0].env;
  requireValue(Array.isArray(env) && env.every(e => plain(e) && text(e.name))
    && new Set(env.map(e => e.name)).size === env.length, 'UPLOAD_REFRESH_SERVICE_ENV_INVALID');
  paused(Object.fromEntries(env.map(e => [e.name, e.value])));
  const serviceEnv = Object.fromEntries(env.map(e => [e.name, e.value]));
  requireValue(Object.entries(conf.environmentVariables).every(([key, value]) => serviceEnv[key] === value)
    && Object.hasOwn(conf.environmentVariables, 'LKC_SHEET_WRITE_MODE') === Object.hasOwn(serviceEnv, 'LKC_SHEET_WRITE_MODE'),
    'UPLOAD_REFRESH_FUNCTION_SERVICE_ENV_MISMATCH');
  privatePolicy(record.policy);
  privatePolicy(record.functionPolicy);
  if (name === 'createUploadSession') {
    requireValue(!fn.eventTrigger && record.trigger === null, 'UPLOAD_REFRESH_ENTRY_TRIGGER_INVALID');
  } else {
    const event = fn.eventTrigger;
    requireValue(event?.eventType === 'google.cloud.storage.object.v1.finalized'
      && event.trigger?.startsWith(`${PREFIX}/triggers/`)
      && event.eventFilters?.filter(f => f.attribute === 'bucket' && text(f.value)).length === 1
      && event.eventFilters.find(f => f.attribute === 'bucket').value !== S.bucket
      && plain(record.trigger) && record.trigger.name === event.trigger
      && record.trigger.uid && record.trigger.destination?.cloudRun?.service === name.toLowerCase()
      && record.trigger.destination.cloudRun.region === S.region
      && record.trigger.eventFilters?.bucket === event.eventFilters.find(f => f.attribute === 'bucket').value
      && record.trigger.eventFilters.type === event.eventType
      && text(event.serviceAccountEmail) && record.trigger.serviceAccount === event.serviceAccountEmail
      && [undefined, 'false'].includes(service.metadata.annotations['run.googleapis.com/invoker-iam-disabled']),
    'UPLOAD_REFRESH_STORAGE_TRIGGER_NOT_VERIFIED');
  }
}
// Keep every unrecognized configuration field in the comparison. Only known
// generated outputs are omitted; a new provider field therefore fails closed.
function functionSettings(fn) {
  const value = omit(fn, ['state', 'stateMessages', 'updateTime', 'url']);
  value.buildConfig = omit(fn.buildConfig, ['build', 'source', 'sourceProvenance']);
  value.serviceConfig = omit(fn.serviceConfig, ['revision', 'uri']);
  return value;
}
function serviceSettings(service) {
  const value = omit(service, ['status']);
  value.metadata = omit(service.metadata, ['creationTimestamp', 'resourceVersion', 'generation', 'selfLink', 'uid']);
  value.spec = clone(service.spec);
  value.spec.template.metadata = omit(value.spec.template.metadata, ['name', 'creationTimestamp']);
  value.spec.template.spec.containers = value.spec.template.spec.containers.map(container => omit(container, ['image']));
  // Revision names may change, but the intended traffic policy must not.
  if (value.spec.traffic) value.spec.traffic = value.spec.traffic.map(t => omit(t, ['revisionName']));
  return value;
}
function triggerSettings(trigger) {
  return trigger === null ? null : omit(trigger, ['createTime', 'updateTime', 'etag', 'conditions']);
}
function sameSettings(before, after) {
  return isDeepStrictEqual(functionSettings(before.fn), functionSettings(after.fn))
    && isDeepStrictEqual(serviceSettings(before.service), serviceSettings(after.service))
    && isDeepStrictEqual(omit(before.policy, ['etag']), omit(after.policy, ['etag']))
    && isDeepStrictEqual(omit(before.functionPolicy, ['etag']), omit(after.functionPolicy, ['etag']))
    && isDeepStrictEqual(triggerSettings(before.trigger), triggerSettings(after.trigger));
}
function verifyPair(plan, observed, sources, allowedFailed = []) {
  const p = state(plan);
  requireValue(plain(observed) && Object.keys(observed).sort().join(',') === [...S.functions].sort().join(','),
    'UPLOAD_REFRESH_PAIR_REQUIRED');
  for (const name of S.functions) {
    validateRecord(observed[name], name, !allowedFailed.includes(name));
    requireValue(sameSettings(p.before[name], observed[name]), 'UPLOAD_REFRESH_CONFIGURATION_CHANGED');
    requireValue(isDeepStrictEqual(observed[name].fn.buildConfig.sourceProvenance.resolvedStorageSource, sources[name]),
      'UPLOAD_REFRESH_SOURCE_CHANGED');
  }
}

export function assertUploadRefreshBeforeImages(before, bucket) {
  requireValue(plain(before) && Object.keys(before).sort().join(',') === [...S.functions].sort().join(','),
    'UPLOAD_REFRESH_EXACT_PAIR_REQUIRED');
  requireValue(bucket?.name === S.bucket && bucket.projectNumber === S.projectNumber
    && bucket.location === S.region.toUpperCase() && bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled === true
    && ['enforced', 'inherited'].includes(bucket.iamConfiguration.publicAccessPrevention),
  'UPLOAD_REFRESH_PRIVATE_BUCKET_NOT_VERIFIED');
  privatePolicy(bucket.policy);
  requireValue(bucket.project?.projectId === S.project && bucket.project.projectNumber === S.projectNumber
    && bucket.project.lifecycleState === 'ACTIVE'
    && (!bucket.project.parent || (plain(bucket.project.parent)
      && ['organization', 'folder'].includes(bucket.project.parent.type) && decimal(bucket.project.parent.id))),
  'UPLOAD_REFRESH_PROJECT_OR_INHERITANCE_NOT_VERIFIED');
  privatePolicy(bucket.projectPolicy);
  if (bucket.iamConfiguration.publicAccessPrevention === 'inherited' && bucket.project.parent) {
    requireValue(uploadEffectivePublicAccessPreventionEnforced(bucket.effectivePublicAccessPrevention),
      'UPLOAD_REFRESH_EFFECTIVE_PUBLIC_ACCESS_PREVENTION_NOT_VERIFIED');
  }
  requireValue(bytes({before, bucket}).length <= S.configBytes - 8192, 'UPLOAD_REFRESH_CONFIG_TOO_LARGE');
  let total = 0;
  for (const name of S.functions) {
    validateRecord(before[name], name);
    const ref = before[name].fn.buildConfig.sourceProvenance.resolvedStorageSource;
    objectMetadata(before[name].object, ref); total += Number(before[name].object.size);
  }
  requireValue(total <= S.totalSourceBytes, 'UPLOAD_REFRESH_SOURCE_LIMIT_EXCEEDED');
}
export function prepareUploadSourceRefresh({sourceSha, runId, runAttempt, before, replacements, bucket, replacementHashes, replacementObjects}) {
  requireValue(/^[0-9a-f]{40}$/.test(sourceSha ?? '') && decimal(runId) && runAttempt === 1,
    'UPLOAD_REFRESH_RUN_IDENTITY_INVALID');
  assertUploadRefreshBeforeImages(before, bucket);
  requireValue(plain(replacements) && Object.keys(replacements).sort().join(',') === [...S.functions].sort().join(','),
    'UPLOAD_REFRESH_EXACT_PAIR_REQUIRED');
  requireValue(plain(replacementHashes) && S.functions.every(name => /^[0-9a-f]{64}$/.test(replacementHashes[name] ?? '')),
    'UPLOAD_REFRESH_PACKAGE_HASHES_REQUIRED');
  requireValue(plain(replacementObjects), 'UPLOAD_REFRESH_REPLACEMENT_METADATA_REQUIRED');
  const copyBefore = clone(before), copyNext = clone(replacements), oldSources = {};
  const total = S.functions.reduce((sum, name) => sum + Number(before[name].object.size), 0);
  for (const name of S.functions) {
    const ref = copyBefore[name].fn.buildConfig.sourceProvenance.resolvedStorageSource;
    source(copyNext[name]);
    objectMetadata(replacementObjects[name], copyNext[name]);
    requireValue(copyNext[name].object === `lkc-upload-source-refresh/${runId}/${sourceSha}/${name}.zip`,
      'UPLOAD_REFRESH_REPLACEMENT_SCOPE_INVALID');
    requireValue(!isDeepStrictEqual(ref, copyNext[name]), 'UPLOAD_REFRESH_REPLACEMENT_NOT_NEW');
    oldSources[name] = ref;
  }
  requireValue(total <= S.totalSourceBytes, 'UPLOAD_REFRESH_SOURCE_LIMIT_EXCEEDED');
  const prefix = `lkc-upload-source-backups/${runId}/${sourceSha}/`;
  const manifest = bytes({schema: 1, sourceSha, runId, runAttempt, before: copyBefore, replacements: copyNext, bucket});
  requireValue(manifest.length <= S.configBytes, 'UPLOAD_REFRESH_CONFIG_TOO_LARGE');
  const requests = S.functions.map(name => ({kind: 'copy-source', name,
    source: oldSources[name], destination: {bucket: S.bucket, object: prefix + name + '.zip'},
    ifGenerationMatch: '0', ifSourceGenerationMatch: oldSources[name].generation,
    expectedSize: copyBefore[name].object.size, expectedMd5: copyBefore[name].object.md5Hash,
    expectedCrc32c: copyBefore[name].object.crc32c}));
  requests.push({kind: 'private-config', destination: {bucket: S.bucket, object: prefix + 'before-images.json'},
    ifGenerationMatch: '0', body: manifest.toString('utf8'), expectedSize: String(manifest.length),
    expectedMd5: digest(manifest, 'md5')});
  const plan = Object.freeze({sourceSha, runId, runAttempt, functions: S.functions,
    backupObjects: 3, sourceCopiesBytes: total, configBytes: manifest.length,
    cloudExecuted: false, executionReady: false});
  privatePlans.set(plan, freeze({before: copyBefore, replacements: copyNext, oldSources, requests,
    replacementHashes: clone(replacementHashes), replacementObjects: clone(replacementObjects)}));
  return plan;
}
export function bindUploadSourceVerification(plan, name, ref, content, restore = false) {
  const p = state(plan); source(ref);
  requireValue(S.functions.includes(name) && (ref.object === `${name}/function-source.zip`
    || isDeepStrictEqual(ref, (restore ? verifiedBackups.get(plan) : p.replacements)?.[name])),
  'UPLOAD_REFRESH_MANAGED_SOURCE_SCOPE_INVALID');
  if (restore) {
    objectMetadata(content, ref);
    const old = p.before[name].object;
    requireValue(['size', 'md5Hash', 'crc32c'].every(key => content[key] === old[key]),
      'UPLOAD_REFRESH_RESTORED_BYTES_MISMATCH');
  } else {
    requireValue(Buffer.isBuffer(content) && content.length <= S.sourceBytes
      && createHash('sha256').update(content).digest('hex') === p.replacementHashes[name],
    'UPLOAD_REFRESH_DEPLOYED_BYTES_MISMATCH');
  }
  const receipt = Object.freeze({verified: true});
  sourceReceipts.set(receipt, {plan, name, restore, ref: clone(ref)});
  return receipt;
}
function acceptedSource(plan, name, receipt, restore, execution) {
  const proof = sourceReceipts.get(receipt);
  if (!proof && execution === 'isolated-test') return clone((restore ? verifiedBackups.get(plan) : state(plan).replacements)[name]);
  requireValue(proof?.plan === plan && proof.name === name && proof.restore === restore,
    'UPLOAD_REFRESH_SOURCE_VERIFICATION_REQUIRED');
  return clone(proof.ref);
}
export function uploadVerifiedSources(plan) {
  requireValue(verifiedFinalSources.has(plan), 'UPLOAD_REFRESH_PAIR_NOT_VERIFIED');
  return clone(verifiedFinalSources.get(plan));
}
export function bindUploadFailedSource(plan, name, ref, metadata) {
  const p = state(plan); source(ref); objectMetadata(metadata, ref);
  requireValue(S.functions.includes(name) && (ref.object === `${name}/function-source.zip`
    || [p.oldSources[name], p.replacements[name]].some(old => isDeepStrictEqual(ref, old)))
    && [p.before[name].object, p.replacementObjects[name]].some(old =>
      ['size', 'md5Hash', 'crc32c'].every(key => metadata[key] === old[key])),
  'UPLOAD_REFRESH_UNOWNED_SOURCE_DRIFT');
  const receipt = Object.freeze({verified: true});
  sourceReceipts.set(receipt, {plan, name, failed: true, ref: clone(ref)}); return receipt;
}
export function uploadBackupRequests(plan) { return clone(state(plan).requests); }
export function verifyUploadBackups(plan, receipts) {
  const requests = state(plan).requests;
  requireValue(Array.isArray(receipts) && receipts.length === 3, 'UPLOAD_REFRESH_BACKUP_RECEIPTS_REQUIRED');
  const generations = new Set();
  requests.forEach((request, index) => {
    const info = receipts[index];
    requireValue(plain(info) && info.bucket === request.destination.bucket && info.name === request.destination.object
      && decimal(info.generation) && info.size === request.expectedSize && info.md5Hash === request.expectedMd5
      && (!request.expectedCrc32c || info.crc32c === request.expectedCrc32c)
      && !info.contentEncoding && !info.customerEncryption, 'UPLOAD_REFRESH_BACKUP_NOT_VERIFIED');
    const key = info.name + '#' + info.generation;
    requireValue(!generations.has(key), 'UPLOAD_REFRESH_DUPLICATE_BACKUP'); generations.add(key);
  });
  verifiedBackups.set(plan, Object.fromEntries(S.functions.map((name, index) => [name,
    {bucket: receipts[index].bucket, object: receipts[index].name, generation: receipts[index].generation}])));
  return true;
}
export function uploadSourceOnlyPatch(plan, name, restore = false) {
  const p = state(plan);
  requireValue(S.functions.includes(name), 'UPLOAD_REFRESH_FUNCTION_SCOPE_INVALID');
  if (restore) requireValue(verifiedBackups.has(plan), 'UPLOAD_REFRESH_BACKUPS_REQUIRED_FOR_RESTORE');
  return {name: `${PREFIX}/functions/${name}`, updateMask: 'buildConfig.source',
    body: {name: `${PREFIX}/functions/${name}`, buildConfig: {source: {storageSource:
      clone((restore ? verifiedBackups.get(plan) : p.replacements)[name])}}}};
}

// Callbacks belong to the existing protected Functions deployment route. This
// contract deliberately supplies no network/backup/update implementation. A local
// success is neither a real backup nor permission to execute it in the cloud.
export async function runUploadRefreshTransaction(plan, owner, execution = 'isolated-test') {
  const p = state(plan);
  requireValue(!consumed.has(plan), 'UPLOAD_REFRESH_PLAN_ALREADY_CONSUMED');
  requireValue(['readPair', 'saveBackups', 'updateOne', 'restoreOne'].every(k => typeof owner?.[k] === 'function'),
    'UPLOAD_REFRESH_EXISTING_OWNER_REQUIRED');
  requireValue(['isolated-test', 'staging-cloud'].includes(execution), 'UPLOAD_REFRESH_EXECUTION_INVALID');
  consumed.add(plan);
  let updates = 0, restores = 0, backupAttempted = false;
  const outcome = value => ({...value, updates, restores,
    cloudWritesAttempted: execution === 'staging-cloud' && backupAttempted,
    deployedFunctionsVerified: execution === 'staging-cloud' && value.status === 'SOURCE_ONLY_CONTRACT_VERIFIED',
    environment: execution});
  const stopped = reason => outcome({status: 'STOPPED_SAFELY', reason});
  const expected = clone(p.oldSources), attempted = [];
  try {
    const initial = await owner.readPair();
    requireValue(isDeepStrictEqual(initial, p.before), 'UPLOAD_REFRESH_BEFORE_IMAGE_DRIFT');
    backupAttempted = true;
    verifyUploadBackups(plan, await owner.saveBackups(uploadBackupRequests(plan)));
    let lastPair = await owner.readPair();
    requireValue(isDeepStrictEqual(lastPair, p.before), 'UPLOAD_REFRESH_BEFORE_IMAGE_DRIFT');
    for (const name of S.functions) {
      requireValue(isDeepStrictEqual(await owner.readPair(), lastPair), 'UPLOAD_REFRESH_BEFORE_IMAGE_DRIFT');
      attempted.push(name); updates++;
      let result;
      try { result = await owner.updateOne(uploadSourceOnlyPatch(plan, name)); }
      catch { return stopped('UPLOAD_REFRESH_OPERATION_OUTCOME_UNKNOWN'); }
      if (!['succeeded', 'failed'].includes(result?.status)) return stopped('UPLOAD_REFRESH_OPERATION_OUTCOME_UNKNOWN');
      if (result.status === 'failed') {
        const failed = await owner.readPair();
        // A terminal error may leave the attempted source either old or new.
        // Configuration/auth/trigger drift is not an authorization to overwrite.
        const attemptedSource = failed[name]?.fn?.buildConfig?.sourceProvenance?.resolvedStorageSource;
        const failureProof = sourceReceipts.get(result.verifiedFailureSource);
        requireValue([p.oldSources[name], p.replacements[name]].some(ref => isDeepStrictEqual(ref, attemptedSource))
          || (failureProof?.plan === plan && failureProof.name === name && failureProof.failed
            && isDeepStrictEqual(failureProof.ref, attemptedSource)),
          'UPLOAD_REFRESH_UNOWNED_SOURCE_DRIFT');
        expected[name] = attemptedSource;
        verifyPair(plan, failed, expected, [name]);
        for (const target of [...attempted].reverse()) {
          if (isDeepStrictEqual(expected[target], p.oldSources[target]) && failed[target].fn.state === 'ACTIVE') continue;
          restores++;
          let restored;
          try { restored = await owner.restoreOne(uploadSourceOnlyPatch(plan, target, true)); }
          catch { return stopped('UPLOAD_REFRESH_RESTORE_OUTCOME_UNKNOWN'); }
          if (restored?.status !== 'succeeded') return stopped(restored?.status === 'failed'
            ? 'UPLOAD_REFRESH_RESTORE_FAILED' : 'UPLOAD_REFRESH_RESTORE_OUTCOME_UNKNOWN');
          expected[target] = acceptedSource(plan, target, restored.verifiedSource, true, execution);
          verifyPair(plan, await owner.readPair(), expected, [name]);
        }
        verifyPair(plan, await owner.readPair(), expected);
        return outcome({status: 'PAIR_RESTORE_VERIFIED'});
      }
      expected[name] = acceptedSource(plan, name, result.verifiedSource, false, execution);
      const observed = await owner.readPair();
      for (const peer of S.functions.filter(n => !attempted.includes(n)))
        requireValue(isDeepStrictEqual(observed[peer], p.before[peer]), 'UPLOAD_REFRESH_BEFORE_IMAGE_DRIFT');
      verifyPair(plan, observed, expected);
      lastPair = observed;
    }
    verifiedFinalSources.set(plan, freeze(clone(expected)));
    return outcome({status: 'SOURCE_ONLY_CONTRACT_VERIFIED'});
  } catch (error) {
    return stopped(/^UPLOAD_REFRESH_[A-Z_]+$/.test(error.message) ? error.message : 'UPLOAD_REFRESH_VERIFICATION_UNKNOWN');
  }
}
