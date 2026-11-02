import test from 'node:test';
import './test-upload-backup-permissions.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {UPLOAD_REFRESH_SCOPE as S, UPLOAD_PUBLIC_ACCESS_CONSTRAINT, uploadEffectivePublicAccessPreventionEnforced, prepareUploadSourceRefresh, uploadBackupRequests,
  verifyUploadBackups, uploadSourceOnlyPatch, runUploadRefreshTransaction,
  uploadExactEventFilterValue, uploadStorageTriggerDestinationSummary} from './upload-source-refresh-contract.mjs';
import {validateUploadRefreshContext, authenticatedUploadRefreshAPI, writeUploadRefreshObject, runUploadSourceRefresh,
  uploadRefreshCloudOwner, enforceUploadBackupPrivacy, UPLOAD_BACKUP_PRIVACY_CONFIRMATION,
  uploadRefreshStorageTriggerSummary, uploadRefreshPreflightSummary} from './run-upload-source-refresh.mjs';
import {validatePlan} from './validate-staging-scope.mjs';
const copy = value => structuredClone(value), prefix = `projects/${S.project}/locations/${S.region}`;
const privateValue = 'synthetic-private-value-do-not-publish';
const emptyPolicy = () => ({etag: 'synthetic-policy-etag', version: 1, bindings: []});
function fixture() {
  const before = {}, replacements = {};
  for (const name of S.functions) {
    const env = {APP_ENVIRONMENT: 'staging', EXPECTED_FIREBASE_PROJECT_ID: S.project,
      LKC_SUBMISSION_TRANSFER_MODE: 'paused', LKC_NOTIFICATION_DELIVERY_MODE: 'paused',
      LKC_SHEET_WRITE_MODE: 'paused', EXTRA_PRIVATE_SETTING: privateValue};
    const ref = {bucket: S.bucket, object: `old/${name}/source.zip`, generation: '17'};
    const revision = name.toLowerCase() + '-00006-test';
    const fn = {name: `${prefix}/functions/${name}`, environment: 'GEN_2', state: 'ACTIVE', updateTime: '2026-10-01T01:00:00Z',
      labels: {preserve: 'existing'}, buildConfig: {runtime: 'nodejs22', entryPoint: name,
        source: {storageSource: ref}, sourceProvenance: {resolvedStorageSource: ref}, build: 'old-build',
        environmentVariables: {GOOGLE_NODE_RUN_SCRIPTS: '', PRIVATE_BUILD_SETTING: privateValue}},
      serviceConfig: {service: `${prefix}/services/${name.toLowerCase()}`, revision,
        uri: `https://${name.toLowerCase()}-synthetic-an.a.run.app`, serviceAccountEmail: 'existing@example.invalid',
        environmentVariables: env, secretEnvironmentVariables: [{key: 'EXTRA_SECRET', secret: 'synthetic', version: '2'}],
        availableMemory: '512Mi', timeoutSeconds: 300, allTrafficOnLatestRevision: true}};
    const service = {apiVersion: 'serving.knative.dev/v1', kind: 'Service', metadata: {name: name.toLowerCase(),
      namespace: S.projectNumber, annotations: {'run.googleapis.com/invoker-iam-disabled': name === S.functions[0] ? 'true' : 'false'}},
      spec: {template: {metadata: {annotations: {preserved: 'yes'}}, spec: {serviceAccountName: fn.serviceConfig.serviceAccountEmail,
        containers: [{image: 'image-old', env: Object.entries(env).map(([name, value]) => ({name, value})),
          resources: {limits: {memory: '512Mi', cpu: '1'}}}]}}, traffic: [{latestRevision: true, percent: 100}]},
      status: {latestReadyRevisionName: revision, latestCreatedRevisionName: revision,
        conditions: [{type: 'Ready', status: 'True'}], traffic: [{revisionName: revision, percent: 100}], url: fn.serviceConfig.uri}};
    let trigger = null;
    if (name === 'finalizeStagedUpload') {
      fn.eventTrigger = {trigger: `${prefix}/triggers/existing-finalizer`, eventType: 'google.cloud.storage.object.v1.finalized',
        eventFilters: [{attribute: 'bucket', value: 'synthetic-submissions-bucket'}], serviceAccountEmail: 'existing@example.invalid'};
      trigger = {name: fn.eventTrigger.trigger, uid: 'existing-trigger-uid', serviceAccount: 'existing@example.invalid',
        eventFilters: [{attribute: 'bucket', value: 'synthetic-submissions-bucket'},
          {attribute: 'type', value: fn.eventTrigger.eventType}],
        destination: {cloudRun: {service: name.toLowerCase(), region: S.region}}};
    }
    before[name] = {fn, service, policy: emptyPolicy(), functionPolicy: emptyPolicy(), trigger,
      object: {bucket: ref.bucket, name: ref.object, generation: ref.generation, size: '128',
        md5Hash: Buffer.alloc(16, 1).toString('base64'), crc32c: Buffer.alloc(4, 2).toString('base64')}};
    replacements[name] = {bucket: S.bucket,
      object: `lkc-upload-source-refresh/123456/${'a'.repeat(40)}/${name}.zip`, generation: '29'};
  }
  return {sourceSha: 'a'.repeat(40), runId: '123456', runAttempt: 1, before, replacements,
    replacementHashes: Object.fromEntries(S.functions.map(name => [name, 'c'.repeat(64)])),
    replacementObjects: Object.fromEntries(S.functions.map(name => [name, {bucket: S.bucket, name: replacements[name].object,
      generation: replacements[name].generation, size: '128', md5Hash: Buffer.alloc(16, 3).toString('base64'), crc32c: Buffer.alloc(4, 4).toString('base64')}])),
    bucket: {name: S.bucket, projectNumber: S.projectNumber, location: S.region.toUpperCase(),
      iamConfiguration: {uniformBucketLevelAccess: {enabled: true}, publicAccessPrevention: 'enforced'},
      policy: emptyPolicy(), project: {projectId: S.project, projectNumber: S.projectNumber, lifecycleState: 'ACTIVE'},
      projectPolicy: emptyPolicy()}};
}
const triggerCheckNames = ['functionEventTypeMatches', 'functionTriggerInScope', 'singleFunctionBucketFilter',
  'functionBucketSeparateFromSource', 'triggerRecordPresent', 'triggerNameMatches', 'triggerUidPresent',
  'destinationServiceMatches', 'destinationRegionMatches', 'bucketFilterMatches', 'eventTypeFilterMatches',
  'triggerServiceAccountMatches', 'invokerIamCheckEnabled'];
for (const kind of ['cloudRun', 'cloudFunction', 'cloudFunctionProjectNumber']) test('documented exact destination accepted and raw record retained: ' + kind, async () => {
  const f = fixture(), record = f.before.finalizeStagedUpload;
  if (kind !== 'cloudRun') record.trigger.destination = {cloudFunction: kind === 'cloudFunction' ? record.fn.name
    : record.fn.name.replace('/' + S.project + '/', '/' + S.projectNumber + '/')};
  const expectedKind = kind === 'cloudRun' ? 'cloudRun' : 'cloudFunction';
  const snapshot = copy(f.before), owner = simulatedOwner(f);
  assert.deepEqual(uploadStorageTriggerDestinationSummary(record.trigger.destination),
    {kind: expectedKind, serviceMatches: true, regionMatches: true});
  assert.ok(Object.values(uploadRefreshStorageTriggerSummary(record)).every(value => value === true));
  assert.equal(uploadRefreshPreflightSummary(f.before, f.bucket).storageTriggerDestinationType, expectedKind);
  const plan = prepareUploadSourceRefresh(f);
  assert.deepEqual(f.before, snapshot);
  const result = await runUploadRefreshTransaction(plan, owner);
  assert.equal(result.status, 'SOURCE_ONLY_CONTRACT_VERIFIED');
  assert.equal(JSON.stringify(result).includes('example.invalid'), false);
});
for (const [label, destination] of [
  ['wrong project', {cloudFunction: 'projects/other/locations/' + S.region + '/functions/finalizeStagedUpload'}],
  ['wrong project number', {cloudFunction: 'projects/999999999999/locations/' + S.region + '/functions/finalizeStagedUpload'}],
  ['wrong region', {cloudFunction: 'projects/' + S.project + '/locations/other/functions/finalizeStagedUpload'}],
  ['wrong function', {cloudFunction: prefix + '/functions/createUploadSession'}],
  ['service resource is not a function', {cloudFunction: prefix + '/services/finalizestagedupload'}],
  ['missing function name', {cloudFunction: ''}],
  ['mixed union', {cloudFunction: prefix + '/functions/finalizeStagedUpload', cloudRun: {service: 'finalizestagedupload', region: S.region}}],
  ['other union', {workflow: prefix + '/workflows/finalizeStagedUpload'}],
  ['unknown union', {futureDestination: privateValue}],
  ['malformed Run target', {cloudRun: null}],
  ['missing target', undefined],
]) test('reject unsupported or mismatched destination without exposing its value: ' + label, () => {
  const f = fixture(); f.before.finalizeStagedUpload.trigger.destination = destination;
  const summary = uploadStorageTriggerDestinationSummary(destination);
  assert.deepEqual(summary, {kind: Object.hasOwn(destination ?? {}, 'cloudFunction') && label !== 'mixed union'
    ? 'cloudFunction' : label === 'malformed Run target' ? 'cloudRun' : 'UNVERIFIED', serviceMatches: false, regionMatches: false});
  assert.throws(() => prepareUploadSourceRefresh(f), /UPLOAD_REFRESH_STORAGE_TRIGGER_NOT_VERIFIED/);
  assert.equal(JSON.stringify(summary).includes(privateValue), false);
});
test('actual REST EventFilter arrays match in either order and preserve raw trigger records', () => {
  const f = fixture(), record = f.before.finalizeStagedUpload;
  record.trigger.eventFilters.reverse();
  const before = copy(f.before);
  assert.equal(uploadExactEventFilterValue(record.trigger.eventFilters, 'bucket'), 'synthetic-submissions-bucket');
  assert.doesNotThrow(() => prepareUploadSourceRefresh(f));
  assert.ok(Object.values(uploadRefreshStorageTriggerSummary(record)).every(value => value === true));
  assert.deepEqual(f.before, before);
});
test('literal filter reader rejects malformed, missing and ambiguous REST filters', () => {
  const valid = {attribute: 'bucket', value: 'synthetic-submissions-bucket'};
  for (const filters of [undefined, null, {}, {bucket: valid.value}, [], [null], [valid, {...valid, value: ''}],
    [{...valid, value: ''}], [{...valid, value: 42}], [{...valid, operator: 'path_pattern'}],
    [{...valid, operator: 'unknown'}]]) assert.equal(uploadExactEventFilterValue(filters, 'bucket'), undefined);
  assert.equal(uploadExactEventFilterValue([{...valid, operator: ''}], 'bucket'), valid.value);
});
test('Storage trigger diagnostics expose only fixed boolean checks without private configuration', () => {
  const f = fixture();
  Object.assign(f.before.finalizeStagedUpload.trigger, {privateValue, futurePrivateSetting: {value: privateValue}});
  const snapshot = copy(f.before);
  const summary = uploadRefreshStorageTriggerSummary(f.before.finalizeStagedUpload);
  assert.deepEqual(Object.keys(summary), triggerCheckNames);
  assert.ok(Object.values(summary).every(value => value === true));
  assert.deepEqual(uploadRefreshPreflightSummary(f.before, f.bucket).storageTrigger, summary);
  assert.deepEqual(f.before, snapshot);
  assert.doesNotMatch(JSON.stringify(summary), /example\.invalid|synthetic-submissions-bucket|existing-finalizer|synthetic-private|futurePrivateSetting/);
  assert.ok(Object.values(uploadRefreshStorageTriggerSummary(undefined)).every(value => typeof value === 'boolean'));
  assert.doesNotThrow(() => prepareUploadSourceRefresh(f));
});
for (const [label, check, mutate] of [
  ['missing event', 'functionEventTypeMatches', r => delete r.fn.eventTrigger],
  ['wrong event type', 'functionEventTypeMatches', r => r.fn.eventTrigger.eventType = 'other'],
  ['foreign trigger', 'functionTriggerInScope', r => r.fn.eventTrigger.trigger = 'projects/other/triggers/private'],
  ['missing bucket filter', 'singleFunctionBucketFilter', r => r.fn.eventTrigger.eventFilters = []],
  ['duplicate bucket filter', 'singleFunctionBucketFilter', r => r.fn.eventTrigger.eventFilters.push(copy(r.fn.eventTrigger.eventFilters[0]))],
  ['source bucket', 'functionBucketSeparateFromSource', r => {
    r.fn.eventTrigger.eventFilters[0].value = S.bucket; r.trigger.eventFilters[0].value = S.bucket;
  }],
  ['missing trigger', 'triggerRecordPresent', r => r.trigger = null],
  ['trigger name mismatch', 'triggerNameMatches', r => r.trigger.name += '-other'],
  ['missing trigger UID', 'triggerUidPresent', r => delete r.trigger.uid],
  ['destination service mismatch', 'destinationServiceMatches', r => r.trigger.destination.cloudRun.service = 'other'],
  ['destination region mismatch', 'destinationRegionMatches', r => r.trigger.destination.cloudRun.region = 'other'],
  ['bucket filter mismatch', 'bucketFilterMatches', r => r.trigger.eventFilters[0].value = 'other'],
  ['event type filter mismatch', 'eventTypeFilterMatches', r => r.trigger.eventFilters[1].value = 'other'],
  ['non-REST filter map', 'bucketFilterMatches', r => r.trigger.eventFilters = {
    bucket: 'synthetic-submissions-bucket', type: r.fn.eventTrigger.eventType}],
  ['duplicate Eventarc bucket filter', 'bucketFilterMatches', r => r.trigger.eventFilters.push(copy(r.trigger.eventFilters[0]))],
  ['duplicate Eventarc type filter', 'eventTypeFilterMatches', r => r.trigger.eventFilters.push(copy(r.trigger.eventFilters[1]))],
  ['pattern Eventarc bucket filter', 'bucketFilterMatches', r => r.trigger.eventFilters[0].operator = 'match-path-pattern'],
  ['pattern Function bucket filter', 'functionBucketSeparateFromSource', r => r.fn.eventTrigger.eventFilters[0].operator = 'match-path-pattern'],
  ['missing trigger principal', 'triggerServiceAccountMatches', r => delete r.fn.eventTrigger.serviceAccountEmail],
  ['overlong trigger principal', 'triggerServiceAccountMatches', r => r.fn.eventTrigger.serviceAccountEmail = 'a'.repeat(2049)],
  ['control character in trigger principal', 'triggerServiceAccountMatches', r => r.fn.eventTrigger.serviceAccountEmail += String.fromCharCode(0)],
  ['trigger principal mismatch', 'triggerServiceAccountMatches', r => r.trigger.serviceAccount = 'other@example.invalid'],
  ['Invoker IAM disabled', 'invokerIamCheckEnabled', r => r.service.metadata.annotations['run.googleapis.com/invoker-iam-disabled'] = 'true'],
]) test('Storage trigger diagnostic retains contract rejection: ' + label, () => {
  const f = fixture(); mutate(f.before.finalizeStagedUpload);
  const summary = uploadRefreshStorageTriggerSummary(f.before.finalizeStagedUpload);
  assert.equal(summary[check], false);
  assert.deepEqual(Object.keys(summary), triggerCheckNames);
  assert.ok(Object.values(summary).every(value => typeof value === 'boolean'));
  assert.throws(() => prepareUploadSourceRefresh(f), /UPLOAD_REFRESH_STORAGE_TRIGGER_NOT_VERIFIED/);
});
function receipts(requests) {
  return requests.map((r, i) => ({bucket: r.destination.bucket, name: r.destination.object, generation: String(100 + i),
    size: r.expectedSize, md5Hash: r.expectedMd5, ...(r.expectedCrc32c ? {crc32c: r.expectedCrc32c} : {})}));
}
function simulatedOwner(input, {failAt = 0, partialFailure = false, unknownAt = 0, restoreUnknown = false,
  driftAfterUpdate, badBackup = false, readMutation} = {}) {
  let current = copy(input.before), update = 0, restore = 0, read = 0;
  const calls = [];
  function apply(patch, state = 'ACTIVE') {
    const name = patch.name.split('/').at(-1), record = current[name];
    record.fn.buildConfig.source = copy(patch.body.buildConfig.source);
    record.fn.buildConfig.sourceProvenance.resolvedStorageSource = copy(patch.body.buildConfig.source.storageSource);
    record.fn.buildConfig.build = 'new-build'; record.fn.state = state;
    const revision = name.toLowerCase() + '-000' + (7 + update + restore) + '-next';
    record.fn.serviceConfig.revision = revision; record.fn.updateTime = '2026-10-31T10:00:00Z';
    record.service.status.latestReadyRevisionName = record.service.status.latestCreatedRevisionName = revision;
    record.service.status.traffic[0].revisionName = revision;
    record.service.spec.template.spec.containers[0].image = 'generated-new-image';
  }
  return {calls,
    readPair: async () => { read++; readMutation?.(current, read); return copy(current); },
    saveBackups: async requests => { calls.push('backup'); const result = receipts(requests); if (badBackup) result[1].md5Hash = 'wrong'; return result; },
    updateOne: async patch => {
      update++; calls.push('update:' + patch.name.split('/').at(-1));
      assert.equal(patch.updateMask, 'buildConfig.source');
      assert.deepEqual(Object.keys(patch.body).sort(), ['buildConfig', 'name']);
      if (update === unknownAt) throw Error(privateValue);
      if (update === failAt) { if (partialFailure) apply(patch, 'FAILED'); return {status: 'failed'}; }
      apply(patch); driftAfterUpdate?.(current, update); return {status: 'succeeded'};
    },
    restoreOne: async patch => { restore++; calls.push('restore:' + patch.name.split('/').at(-1));
      assert.match(patch.body.buildConfig.source.storageSource.object, /^lkc-upload-source-backups\//);
      if (restoreUnknown) return {status: 'unknown'}; apply(patch); return {status: 'succeeded'};
    },
  };
}
test('private plans never serialize settings, config bodies or backup payloads', () => {
  const plan = prepareUploadSourceRefresh(fixture());
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(privateValue));
  assert.equal(plan.executionReady, false); assert.equal(plan.backupObjects, 3);
  assert.throws(() => uploadBackupRequests({...plan}), /PLAN_REQUIRED/);
  assert.throws(() => uploadSourceOnlyPatch(plan, S.functions[0], true), /BACKUPS_REQUIRED/);
  const requests = uploadBackupRequests(plan);
  assert.match(requests[2].body, new RegExp(privateValue));
  assert.ok(requests.every(r => r.ifGenerationMatch === '0'));
  assert.ok(requests.slice(0, 2).every(r => r.ifSourceGenerationMatch === '17'));
});
for (const [label, mutate] of [
  ['missing peer', f => delete f.before.finalizeStagedUpload],
  ['additional function', f => f.before.other = copy(f.before.createUploadSession)],
  ['rerun', f => f.runAttempt = 2], ['foreign source SHA', f => f.sourceSha = 'main'],
  ['unverified mode', f => delete f.before.createUploadSession.fn.serviceConfig.environmentVariables.LKC_SUBMISSION_TRANSFER_MODE],
  ['active notification', f => f.before.createUploadSession.fn.serviceConfig.environmentVariables.LKC_NOTIFICATION_DELIVERY_MODE = 'active'],
  ['wrong runtime', f => f.before.createUploadSession.fn.buildConfig.runtime = 'nodejs24'],
  ['build defaults', f => delete f.before.createUploadSession.fn.buildConfig.environmentVariables.GOOGLE_NODE_RUN_SCRIPTS],
  ['public service', f => f.before.finalizeStagedUpload.policy.bindings.push({role: 'roles/run.invoker', members: ['allUsers']})],
  ['public Function', f => f.before.createUploadSession.functionPolicy.bindings.push({role: 'roles/cloudfunctions.invoker', members: ['allAuthenticatedUsers']})],
  ['public project', f => f.bucket.projectPolicy.bindings.push({role: 'roles/viewer', members: ['allUsers']})],
  ['unknown inherited policy', f => { f.bucket.project.parent = {type: 'organization', id: '123'}; f.bucket.iamConfiguration.publicAccessPrevention = 'inherited'; }],
  ['wrong project metadata', f => f.bucket.project.projectId = 'other'],
  ['unverified private bucket', f => f.bucket.iamConfiguration.publicAccessPrevention = 'UNVERIFIED'],
  ['legacy object ACLs', f => f.bucket.iamConfiguration.uniformBucketLevelAccess.enabled = false],
  ['wrong source generation', f => f.before.createUploadSession.object.generation = '18'],
  ['oversize source', f => f.before.createUploadSession.object.size = String(S.sourceBytes + 1)],
  ['corrupt source checksum', f => f.before.createUploadSession.object.md5Hash = 'not-a-checksum'],
  ['different Run environment', f => f.before.createUploadSession.service.spec.template.spec.containers[0].env[0].value = 'production'],
  ['missing Run variable', f => f.before.createUploadSession.service.spec.template.spec.containers[0].env.pop()],
  ['unready revision', f => f.before.createUploadSession.service.status.latestReadyRevisionName = 'other'],
  ['public finalizer', f => f.before.finalizeStagedUpload.service.metadata.annotations['run.googleapis.com/invoker-iam-disabled'] = 'true'],
  ['wrong event bucket', f => f.before.finalizeStagedUpload.trigger.eventFilters[0].value = 'other'],
  ['source writes would trigger finalizer', f => { f.before.finalizeStagedUpload.fn.eventTrigger.eventFilters[0].value = S.bucket; f.before.finalizeStagedUpload.trigger.eventFilters[0].value = S.bucket; }],
  ['changed trigger principal', f => f.before.finalizeStagedUpload.trigger.serviceAccount = 'other@example.invalid'],
  ['mutable secret alias', f => f.before.createUploadSession.fn.serviceConfig.secretEnvironmentVariables[0].version = 'latest'],
  ['unbounded private snapshot', f => f.before.createUploadSession.fn.description = 'x'.repeat(S.configBytes)],
]) test('reject before planning writes: ' + label, () => { const f = fixture(); mutate(f); assert.throws(() => prepareUploadSourceRefresh(f), /UPLOAD_REFRESH_/); });
const enforcedPolicy = () => ({constraint: UPLOAD_PUBLIC_ACCESS_CONSTRAINT, booleanPolicy: {enforced: true}});
for (const type of ['organization', 'folder']) test('inherited public access prevention requires an effective project policy: ' + type, () => {
  const f = fixture(); f.bucket.project.parent = {type, id: '123'};
  f.bucket.iamConfiguration.publicAccessPrevention = 'inherited';
  f.bucket.effectivePublicAccessPrevention = enforcedPolicy();
  assert.equal(prepareUploadSourceRefresh(f).executionReady, false);
});
test('explicit bucket enforcement does not require ancestor reads', () => {
  const f = fixture(); f.bucket.project.parent = {type: 'organization', id: '123'};
  assert.equal(prepareUploadSourceRefresh(f).executionReady, false);
});
for (const [label, mutate] of [
  ['false', p => p.booleanPolicy.enforced = false], ['missing boolean', p => delete p.booleanPolicy],
  ['empty boolean', p => p.booleanPolicy = {}], ['wrong constraint', p => p.constraint = 'constraints/other'],
  ['conditional', p => p.booleanPolicy.condition = 'unverified'], ['unknown field', p => p.future = true],
  ['restore default', p => p.restoreDefault = {}], ['nonzero version', p => p.version = 1],
  ['uncomputed policy', p => p.etag = 'direct-policy-etag'],
]) test('reject unverifiable effective policy: ' + label, () => {
  const f = fixture(), policy = enforcedPolicy(); mutate(policy);
  assert.equal(uploadEffectivePublicAccessPreventionEnforced(policy), false);
  f.bucket.project.parent = {type: 'organization', id: '123'};
  f.bucket.iamConfiguration.publicAccessPrevention = 'inherited'; f.bucket.effectivePublicAccessPrevention = policy;
  assert.throws(() => prepareUploadSourceRefresh(f), /EFFECTIVE_PUBLIC_ACCESS_PREVENTION_NOT_VERIFIED/);
});
test('preserve absent sheet mode with the actual fail-closed application helper; never create a setting', () => {
  const module = new URL('../../functions/src/sheet-write-control.ts', import.meta.url).href;
  const script = `import {sheetWriteExecutionPaused} from ${JSON.stringify(module)};
    const results=[];for(const mode of [null,'paused','active','','unknown','acceptance']){
      delete process.env.LKC_SHEET_WRITE_MODE;if(mode!==null)process.env.LKC_SHEET_WRITE_MODE=mode;
      results.push([mode,sheetWriteExecutionPaused()]);}console.log(JSON.stringify(results));`;
  const actual = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', script],
    {env: {}, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']}));
  assert.deepEqual(actual, [[null,true],['paused',true],['active',false],['',true],['unknown',true],['acceptance',true]]);
  const f = fixture();
  for (const name of S.functions) {
    delete f.before[name].fn.serviceConfig.environmentVariables.LKC_SHEET_WRITE_MODE;
    f.before[name].service.spec.template.spec.containers[0].env = f.before[name].service.spec.template.spec.containers[0].env.filter(e => e.name !== 'LKC_SHEET_WRITE_MODE');
  }
  assert.doesNotMatch(uploadBackupRequests(prepareUploadSourceRefresh(f))[2].body, /LKC_SHEET_WRITE_MODE/);
});
for (const value of ['active', 'acceptance', '', 'unknown']) test('reject a present unsafe sheet mode: ' + JSON.stringify(value), () => {
  const f = fixture(); f.before.createUploadSession.fn.serviceConfig.environmentVariables.LKC_SHEET_WRITE_MODE = value;
  f.before.createUploadSession.service.spec.template.spec.containers[0].env.find(e => e.name === 'LKC_SHEET_WRITE_MODE').value = value;
  assert.throws(() => prepareUploadSourceRefresh(f), /PAUSE_NOT_VERIFIED/);
});
test('an absent Function sheet mode cannot be inferred from a present Run value', () => {
  const f = fixture(); delete f.before.createUploadSession.fn.serviceConfig.environmentVariables.LKC_SHEET_WRITE_MODE;
  assert.throws(() => prepareUploadSourceRefresh(f), /FUNCTION_SERVICE_ENV_MISMATCH/);
});
test('effective policy transport reads only the exact project constraint and never counts a write', async () => {
  let calls = 0;
  const api = authenticatedUploadRefreshAPI({getRequestHeaders: async () => ({authorization:'synthetic'})}, async () => {
    calls++; return new Response(JSON.stringify(enforcedPolicy()));
  });
  const url = `https://cloudresourcemanager.googleapis.com/v1/projects/${S.project}:getEffectiveOrgPolicy`;
  assert.deepEqual(await api.request(url, {method:'POST', body:{constraint:UPLOAD_PUBLIC_ACCESS_CONSTRAINT}, readOnlyPost:true}), enforcedPolicy());
  assert.equal(api.counters.writesAttempted, 0); assert.equal(api.counters.lastRequestKind, 'project-effective-public-access');
  for (const [target, body, method = 'POST'] of [
    [url.replace('projects/' + S.project, 'organizations/123'), {constraint:UPLOAD_PUBLIC_ACCESS_CONSTRAINT}],
    [url.replace(S.project,'other-project'), {constraint:UPLOAD_PUBLIC_ACCESS_CONSTRAINT}],
    [url,{constraint:'constraints/other'}], [url,{constraint:UPLOAD_PUBLIC_ACCESS_CONSTRAINT, update:true}],
    [url+'?extra=1',{constraint:UPLOAD_PUBLIC_ACCESS_CONSTRAINT}], [url,{constraint:UPLOAD_PUBLIC_ACCESS_CONSTRAINT},'GET'],
    [url.replace('getEffectiveOrgPolicy','setOrgPolicy'),{constraint:UPLOAD_PUBLIC_ACCESS_CONSTRAINT}],
  ]) await assert.rejects(api.request(target,{method,body,readOnlyPost:true}), /HTTP_SCOPE_REJECTED/);
  assert.equal(calls,1);
});
test('a caller cannot disguise a source PATCH as a read-only POST in write accounting', async () => {
  const f=fixture(), patch=uploadSourceOnlyPatch(prepareUploadSourceRefresh(f),S.functions[0]);
  const api=authenticatedUploadRefreshAPI({getRequestHeaders:async()=>({authorization:'synthetic'})},async()=>new Response('{}'));
  await api.request(`https://cloudfunctions.googleapis.com/v2/${patch.name}?updateMask=buildConfig.source`,
    {method:'PATCH',body:patch.body,readOnlyPost:true});
  assert.equal(api.counters.writesAttempted,1);
});
test('source-only patches contain no environment, auth, trigger, runtime or resource changes', () => {
  const plan = prepareUploadSourceRefresh(fixture());
  for (const name of S.functions) {
    const p = uploadSourceOnlyPatch(plan, name);
    assert.equal(p.updateMask, 'buildConfig.source');
    assert.deepEqual(p.body, {name: `${prefix}/functions/${name}`, buildConfig: {source: {storageSource: fixture().replacements[name]}}});
  }
});
test('backups are checked in order, with immutable generations and actual byte checksums', () => {
  const plan = prepareUploadSourceRefresh(fixture()), good = receipts(uploadBackupRequests(plan));
  assert.equal(verifyUploadBackups(plan, good), true);
  for (const modify of [r => r.reverse(), r => r.pop(), r => r[0].generation = '', r => r[0].md5Hash = 'wrong',
    r => r[1].size = '0', r => r[0].crc32c = 'wrong', r => r[2].contentEncoding = 'gzip']) {
    const bad = copy(good); modify(bad); assert.throws(() => verifyUploadBackups(plan, bad), /UPLOAD_REFRESH_/);
  }
});
test('isolated successful pair does not claim a cloud deployment', async () => {
  const f = fixture(), plan = prepareUploadSourceRefresh(f), owner = simulatedOwner(f);
  const result = await runUploadRefreshTransaction(plan, owner);
  assert.equal(result.status, 'SOURCE_ONLY_CONTRACT_VERIFIED'); assert.equal(result.deployedFunctionsVerified, false);
  assert.deepEqual(owner.calls, ['backup', 'update:createUploadSession', 'update:finalizeStagedUpload']);
  await assert.rejects(runUploadRefreshTransaction(plan, owner), /ALREADY_CONSUMED/);
});
for (const failAt of [1, 2]) for (const partialFailure of [false, true])
  test(`known failure ${failAt}, partial=${partialFailure}: restore only attempted updates from pinned backups`, async () => {
    const f = fixture(), owner = simulatedOwner(f, {failAt, partialFailure});
    const result = await runUploadRefreshTransaction(prepareUploadSourceRefresh(f), owner);
    assert.equal(result.status, 'PAIR_RESTORE_VERIFIED'); assert.equal(result.updates, failAt);
    assert.equal(result.restores, failAt - (partialFailure ? 0 : 1));
    if (partialFailure && failAt === 2) assert.deepEqual(owner.calls.slice(-2), ['restore:finalizeStagedUpload', 'restore:createUploadSession']);
  });
for (const unknownAt of [1, 2]) test('unknown mutation outcome stops without retry/restore: ' + unknownAt, async () => {
  const f = fixture(), owner = simulatedOwner(f, {unknownAt});
  const result = await runUploadRefreshTransaction(prepareUploadSourceRefresh(f), owner);
  assert.equal(result.reason, 'UPLOAD_REFRESH_OPERATION_OUTCOME_UNKNOWN'); assert.equal(result.updates, unknownAt);
  assert.equal(result.restores, 0); assert.doesNotMatch(JSON.stringify(result), new RegExp(privateValue));
});
test('unknown rollback outcome stops the other rollback', async () => {
  const f = fixture(), owner = simulatedOwner(f, {failAt: 2, partialFailure: true, restoreUnknown: true});
  const result = await runUploadRefreshTransaction(prepareUploadSourceRefresh(f), owner);
  assert.equal(result.reason, 'UPLOAD_REFRESH_RESTORE_OUTCOME_UNKNOWN'); assert.equal(result.restores, 1);
});
test('unverified backup stops before the first Function update', async () => {
  const f = fixture(), owner = simulatedOwner(f, {badBackup: true});
  const result = await runUploadRefreshTransaction(prepareUploadSourceRefresh(f), owner);
  assert.equal(result.reason, 'UPLOAD_REFRESH_BACKUP_NOT_VERIFIED'); assert.equal(result.updates, 0);
});
for (const [label, mutate] of [
  ['secret version', p => p.createUploadSession.fn.serviceConfig.secretEnvironmentVariables[0].version = 'latest'],
  ['resource limit', p => p.createUploadSession.service.spec.template.spec.containers[0].resources.limits.memory = '2Gi'],
  ['Invoker', p => p.createUploadSession.service.metadata.annotations['run.googleapis.com/invoker-iam-disabled'] = 'false'],
  ['future unknown field', p => p.createUploadSession.fn.futureConfig = {enabled: true}],
  ['equivalent destination representation', p => p.finalizeStagedUpload.trigger.destination = {cloudFunction: p.finalizeStagedUpload.fn.name}],
  ['untouched peer revision', p => p.finalizeStagedUpload.fn.serviceConfig.revision = 'finalizestagedupload-00123-other'],
]) test('drift stops further writes rather than overwriting it: ' + label, async () => {
  const f = fixture(), owner = simulatedOwner(f, {driftAfterUpdate: mutate});
  const result = await runUploadRefreshTransaction(prepareUploadSourceRefresh(f), owner);
  assert.equal(result.status, 'STOPPED_SAFELY'); assert.equal(result.updates, 1); assert.equal(result.restores, 0);
});
const context = () => ({LKC_PROJECT_ID: S.project, LKC_REGION: S.region, LKC_SOURCE_REF: 'main',
  LKC_FUNCTIONS: S.functions.join(','), LKC_CONFIRMATION: 'REFRESH_LKC_STAGING_UPLOAD_SOURCE_PRESERVE',
  LKC_TRANSFER_MODE_REQUESTED: 'preserve', LKC_OPERATION: 'upload-source-refresh',
  LKC_UPLOAD_WRITE_CONFIRMATION: 'APPLY_LKC_STAGING_UPLOAD_SOURCE_REFRESH',
  GITHUB_REPOSITORY: 'Hanabo0930/Lip-Knots-Crew', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_JOB: 'deploy', GITHUB_WORKFLOW_REF: 'Hanabo0930/Lip-Knots-Crew/.github/workflows/staging-functions-deploy.yml@refs/heads/main',
  GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40), LKC_VERIFIED_SOURCE_SHA: 'a'.repeat(40)});
test('only the exact protected existing workflow and main pair can execute', () => {
  assert.doesNotThrow(() => validateUploadRefreshContext(context()));
  for (const [key, value] of Object.entries({LKC_PROJECT_ID: 'other', LKC_REGION: 'us-central1', LKC_SOURCE_REF: 'automation/other',
    LKC_FUNCTIONS: 'createUploadSession', LKC_CONFIRMATION: 'DEPLOY_LKC_STAGING_FUNCTIONS', LKC_TRANSFER_MODE_REQUESTED: 'active',
    GITHUB_REF: 'refs/heads/other', GITHUB_JOB: 'guard', GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ATTEMPT: '2', GITHUB_WORKFLOW_REF: 'other'}))
    assert.throws(() => validateUploadRefreshContext({...context(), [key]: value}));
  assert.throws(() => validatePlan({mode: 'functions-upload-source-refresh', functions: S.functions.join(',') + ',bootstrapSession',
    confirmation: context().LKC_CONFIRMATION}));
});
test('bucket privacy confirmation is separate, exact and cannot enable source refresh writes', () => {
  assert.doesNotThrow(() => validateUploadRefreshContext({...context(), LKC_UPLOAD_WRITE_CONFIRMATION: '',
    LKC_UPLOAD_PRIVACY_CONFIRMATION: UPLOAD_BACKUP_PRIVACY_CONFIRMATION}));
  for (const value of ['true', 'enforced', UPLOAD_BACKUP_PRIVACY_CONFIRMATION + ' '])
    assert.throws(() => validateUploadRefreshContext({...context(), LKC_UPLOAD_WRITE_CONFIRMATION: '',
      LKC_UPLOAD_PRIVACY_CONFIRMATION: value}), /PRIVACY_CONFIRMATION_REJECTED/);
  assert.throws(() => validateUploadRefreshContext({...context(), LKC_UPLOAD_PRIVACY_CONFIRMATION: UPLOAD_BACKUP_PRIVACY_CONFIRMATION}),
    /PRIVACY_CONFIRMATION_REJECTED/);
});
function privacyFixture() {
  const bucket = copy(fixture().bucket);
  Object.assign(bucket, {metageneration: '42', etag: 'private-etag-42', updated: '2026-11-01T00:00:00Z',
    labels: {preserve: privateValue}, unknownFutureSetting: {preserve: true}});
  bucket.project.parent = {type: 'organization', id: '123'};
  bucket.iamConfiguration.publicAccessPrevention = 'inherited';
  return bucket;
}
function privacyOwner({before = privacyFixture(), changeFresh, changeAfter, failPatch} = {}) {
  let reads = 0, patches = 0, current = copy(before);
  return {counts: () => ({reads, patches}), reader: {readBucket: async options => {
    assert.deepEqual(options, {skipEffectivePublicAccessPrevention: true});
    reads++; if (reads === 2) changeFresh?.(current); if (reads === 3) changeAfter?.(current);
    return copy(current);
  }}, api: {request: async (value, options) => {
    patches++;
    assert.equal(String(value), `https://storage.googleapis.com/storage/v1/b/${S.bucket}?ifMetagenerationMatch=42`);
    assert.deepEqual(options, {method: 'PATCH', body: {iamConfiguration: {publicAccessPrevention: 'enforced'}}});
    if (failPatch) throw failPatch;
    current.iamConfiguration.publicAccessPrevention = 'enforced'; current.metageneration = '43';
    current.etag = 'private-etag-43'; current.updated = '2026-11-01T00:01:00Z'; return copy(current);
  }}};
}
test('approved bucket privacy update preserves all unknown metadata and policies and emits only a bounded summary', async () => {
  const owner = privacyOwner(), result = await enforceUploadBackupPrivacy(owner.api, owner.reader);
  assert.deepEqual(result, {summary: {status: 'ENFORCED_AND_VERIFIED', changed: true}});
  assert.deepEqual(owner.counts(), {reads: 3, patches: 1});
  assert.doesNotMatch(JSON.stringify(result), /private-etag|unknownFutureSetting|synthetic-private|bindings/);
});
test('an already enforced bucket is verified without a write', async () => {
  const before = privacyFixture(); before.iamConfiguration.publicAccessPrevention = 'enforced';
  const owner = privacyOwner({before});
  assert.deepEqual(await enforceUploadBackupPrivacy(owner.api, owner.reader), {summary: {status: 'ALREADY_ENFORCED', changed: false}});
  assert.deepEqual(owner.counts(), {reads: 1, patches: 0});
});
for (const [label, mutate] of [
  ['bucket', b => b.name = 'other'], ['project number', b => b.projectNumber = '123'],
  ['region', b => b.location = 'US'], ['UBLA', b => b.iamConfiguration.uniformBucketLevelAccess.enabled = false],
  ['missing generation', b => delete b.metageneration], ['bad generation', b => b.metageneration = '0'],
  ['project identity', b => b.project.projectId = 'other'], ['inactive project', b => b.project.lifecycleState = 'DELETE_REQUESTED'],
  ['unknown privacy', b => b.iamConfiguration.publicAccessPrevention = 'unknown'],
]) test('bucket privacy precondition rejects ' + label + ' without a write', async () => {
  const before = privacyFixture(); mutate(before); const owner = privacyOwner({before});
  await assert.rejects(enforceUploadBackupPrivacy(owner.api, owner.reader), /PRIVACY_BUCKET_NOT_VERIFIED/);
  assert.equal(owner.counts().patches, 0);
});
test('bucket privacy drift before PATCH stops without writing', async () => {
  const owner = privacyOwner({changeFresh: b => b.unknownFutureSetting.preserve = false});
  await assert.rejects(enforceUploadBackupPrivacy(owner.api, owner.reader), /PRIVACY_BEFORE_IMAGE_DRIFT/);
  assert.equal(owner.counts().patches, 0);
});
for (const status of [403, 409, 412, null]) test('bucket privacy rejection or unknown result never repeats PATCH: ' + status, async () => {
  const error = Object.assign(Error(status ? 'UPLOAD_REFRESH_HTTP_REJECTED' : 'UPLOAD_REFRESH_HTTP_OUTCOME_UNKNOWN'),
    status ? {httpStatus: status} : {});
  const owner = privacyOwner({failPatch: error});
  await assert.rejects(enforceUploadBackupPrivacy(owner.api, owner.reader), error);
  assert.equal(owner.counts().patches, 1);
});
for (const [label, mutate] of [
  ['not enforced', b => b.iamConfiguration.publicAccessPrevention = 'inherited'],
  ['generation drift', b => b.metageneration = '44'], ['unknown setting', b => b.unknownFutureSetting.preserve = false],
  ['bucket policy', b => b.policy.etag = 'changed'], ['project policy', b => b.projectPolicy.bindings.push({role: 'other', members: []})],
]) test('bucket privacy readback detects ' + label + ' without undo or retry', async () => {
  const owner = privacyOwner({changeAfter: mutate});
  await assert.rejects(enforceUploadBackupPrivacy(owner.api, owner.reader), /PRIVACY_(READBACK_NOT_VERIFIED|OTHER_SETTINGS_CHANGED)/);
  assert.equal(owner.counts().patches, 1);
});
test('bucket PATCH transport requires the explicit capability and exact field, target and conflict guard', async () => {
  const url = `https://storage.googleapis.com/storage/v1/b/${S.bucket}?ifMetagenerationMatch=42`;
  const body = {iamConfiguration: {publicAccessPrevention: 'enforced'}};
  let calls = 0;
  const auth = {getRequestHeaders: async () => ({authorization: 'synthetic'})};
  const fake = async () => {calls++; return new Response('{}');};
  const normal = authenticatedUploadRefreshAPI(auth, fake);
  await assert.rejects(normal.request(url, {method: 'PATCH', body}), /HTTP_SCOPE_REJECTED/);
  const enabled = authenticatedUploadRefreshAPI(auth, fake, {allowBackupPrivacyEnforcement: true});
  for (const [target, patchBody] of [
    [url.replace(S.bucket, 'another-bucket'), body], [url.split('?')[0], body],
    [url + '&predefinedAcl=private', body], [url.replace('42', '0'), body],
    [url, {iamConfiguration: {publicAccessPrevention: 'inherited'}}],
    [url, {iamConfiguration: {publicAccessPrevention: 'enforced', uniformBucketLevelAccess: {enabled: true}}}],
    [url, {...body, labels: {unexpected: 'yes'}}],
  ]) await assert.rejects(enabled.request(target, {method: 'PATCH', body: patchBody}), /HTTP_SCOPE_REJECTED/);
  assert.equal(calls, 0);
  await enabled.request(url, {method: 'PATCH', body, readOnlyPost: true});
  assert.equal(calls, 1); assert.equal(enabled.counters.writesAttempted, 1);
  await assert.rejects(enabled.request(url.replace('42', '43'), {method: 'PATCH', body}), /MUTATION_LIMIT/);
  assert.equal(calls, 1);
});
test('invalid source identity cannot leak a private value into the bounded result', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lkc-invalid-source-context-'));
  try {
    const api={counters:{requests:0,writesAttempted:0,mediaBytes:0},request:async()=>assert.fail('NETWORK_FORBIDDEN')};
    const result=await runUploadSourceRefresh({...context(),LKC_VERIFIED_SOURCE_SHA:privateValue,GITHUB_WORKSPACE:root},{api});
    assert.equal(result.sourceSha,null);assert.equal(result.cloudWritesAttempted,false);
    assert.doesNotMatch(fs.readFileSync(path.join(root,'upload-source-refresh-result.json'),'utf8'),new RegExp(privateValue));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('authenticated transport redacts private errors, refuses redirects and bounds bodies without retries', async () => {
  let calls = 0;
  const api = authenticatedUploadRefreshAPI({getRequestHeaders: async () => ({authorization: 'Bearer ' + privateValue})}, async (url, options) => {
    calls++; assert.equal(options.redirect, 'error'); throw Error(privateValue);
  });
  const validUpload = `https://storage.googleapis.com/upload/storage/v1/b/${S.bucket}/o?uploadType=media&name=${encodeURIComponent('lkc-upload-source-refresh/123456/' + 'a'.repeat(40) + '/createUploadSession.zip')}&ifGenerationMatch=0`;
  await assert.rejects(api.request(validUpload, {method: 'POST', body: Buffer.from('zip')}), /HTTP_OUTCOME_UNKNOWN/);
  assert.equal(calls, 1);
  await assert.rejects(api.request('https://evil.invalid/path'), /HTTP_SCOPE_REJECTED/);
  const big = authenticatedUploadRefreshAPI({getRequestHeaders: async () => ({})}, async () => new Response('x'.repeat(S.configBytes + 1)));
  await assert.rejects(big.request(`https://storage.googleapis.com/storage/v1/b/${S.bucket}`), /RESPONSE_TOO_LARGE/);
});
test('transport has no IAM, Run, trigger, deletion or unpinned media mutation route', async () => {
  let calls = 0;
  const api = authenticatedUploadRefreshAPI({getRequestHeaders: async () => {calls++; return {};}}, async () => assert.fail('NETWORK_FORBIDDEN'));
  for (const [url, options] of [
    [`https://run.googleapis.com/v2/${prefix}/services/createuploadsession:setIamPolicy`, {method: 'POST', body: {}}],
    [`https://run.googleapis.com/v2/${prefix}/services/createuploadsession`, {method: 'PATCH', body: {}}],
    [`https://eventarc.googleapis.com/v1/${prefix}/triggers/existing-finalizer`, {method: 'DELETE'}],
    [`https://cloudfunctions.googleapis.com/v2/${prefix}/functions/createUploadSession?updateMask=serviceConfig`, {method: 'PATCH', body: {}}],
    [`https://storage.googleapis.com/storage/v1/b/${S.bucket}/o/old.zip?alt=media`, {}],
  ]) await assert.rejects(api.request(url, options), /UPLOAD_REFRESH_/);
  assert.equal(calls, 0);
});
test('workspace ADC dependency resolves in canonical CI without loading credentials', {skip: process.env.GITHUB_ACTIONS !== 'true'}, () => {
  const require = createRequire(new URL('../../package.json', import.meta.url));
  assert.equal(typeof require('google-auth-library').GoogleAuth, 'function');
});
test('fixed object writer refuses overwrite, foreign paths and wrong uploaded-byte receipts', async () => {
  const calls = [], api = {request: async (url, options) => {
    calls.push({url: String(url), options}); return {bucket: S.bucket, name: 'wrong', generation: '44', size: '3', md5Hash: 'wrong'};
  }};
  const dest = {bucket: S.bucket, object: 'lkc-upload-source-refresh/123456/' + 'a'.repeat(40) + '/createUploadSession.zip'};
  await assert.rejects(writeUploadRefreshObject(api, dest, Buffer.from('zip')), /NEW_OBJECT_INVALID/);
  assert.equal(new URL(calls[0].url).searchParams.get('ifGenerationMatch'), '0');
  await assert.rejects(writeUploadRefreshObject(api, {...dest, object: '../other'}, Buffer.from('zip')), /DESTINATION_REJECTED/);
});
test('owner emits only a source field mask and does not repeat an unknown PATCH', async () => {
  const f = fixture(), plan = prepareUploadSourceRefresh(f), calls = [];
  const api = {request: async (url, options) => {
    calls.push({url: String(url), options}); throw Error(privateValue);
  }};
  const owner = uploadRefreshCloudOwner(api, {readBucket: async () => copy(f.bucket), readPair: async () => copy(f.before)}, f.bucket);
  assert.deepEqual(await owner.updateOne(uploadSourceOnlyPatch(plan, S.functions[0])), {status: 'unknown'});
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, 'PATCH');
  assert.equal(new URL(calls[0].url).searchParams.get('updateMask'), 'buildConfig.source');
});
test('the existing workflow owns the route and private data is never selected as an artifact', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/staging-functions-deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /- upload-source-refresh/);
  assert.match(workflow, /path: upload-source-refresh-result\.json/);
  assert.doesNotMatch(workflow, /path:.*(?:lkc-upload-source-refresh-|before-images|\.env\.)/);
  const runner = fs.readFileSync(new URL('./run-staging-firebase-deploy.cjs', import.meta.url), 'utf8');
  assert.ok(runner.indexOf('UPLOAD_SOURCE_REFRESH_ROUTE_REQUIRED') < runner.indexOf('resolveCli();'));
  const shell = fs.readFileSync(new URL('./deploy-staging-functions.sh', import.meta.url), 'utf8');
  assert.ok(shell.indexOf('functions-upload-source-refresh') < shell.indexOf('npx --yes'));
});

for (const scenario of ['success', 'managed-success', 'second-failure', 'managed-second-failure', 'unknown-second', 'private-bucket-unverified', 'read-only-preflight', 'trigger-mismatch-preflight', 'function-destination-preflight', 'inherited-private-preflight', 'organization-enforced-preflight', 'organization-unverified-preflight', 'organization-policy-forbidden-preflight', 'privacy-enforce-preflight', 'privacy-already-enforced-preflight', 'privacy-conflict-preflight', 'privacy-unknown-preflight', 'privacy-after-drift-preflight'])
  test('isolated existing-runner integration: ' + scenario, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lkc-refresh-integration-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const files = {'apps/admin/src/case-mail-release.json': '{"enabled":false}', 'functions/package.json': '{"main":"lib/index.js"}',
      'functions/package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}',
      'functions/lib/index.js': 'exports.synthetic = true;', 'functions/lib/uploads.js': 'exports.synthetic = true;',
      'functions/lib/uploads.js.map': '{"version":3}', 'functions/src/uploads.ts': 'export const synthetic = true;',
      'functions/case-mail-runtime/core.cjs': 'module.exports = {};', 'functions/tsconfig.json': '{}'};
    for (const [name, body] of Object.entries(files)) {const file = path.join(root, name); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, body);}
    const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
    git(['init', '--initial-branch=automation/upload-refresh-isolation']); git(['add', '--all']);
    git(['-c', 'user.name=Isolated test', '-c', 'user.email=isolated@example.invalid', 'commit', '-m', 'Synthetic source']);
    const f = fixture(), pair = copy(f.before), objects = new Map(), bodies = new Map(), mutations = [];
    let generation = 200, patches = 0, probes = 0;
    const privacyOperation = scenario.startsWith('privacy-');
    if (privacyOperation) {
      Object.assign(f.bucket, {metageneration: '42', updated: '2026-11-01T00:00:00Z', etag: 'private-etag', labels: {preserve: privateValue}});
      f.bucket.project.parent = {type: 'organization', id: '123'};
      if (scenario !== 'privacy-already-enforced-preflight') f.bucket.iamConfiguration.publicAccessPrevention = 'inherited';
    }
    const configKeys = ['ADMIN_EMAILS', 'EXECUTIVE_APPROVER_EMAILS', 'PRODUCTION_FIREBASE_PROJECT_ID', 'APPROVAL_PACKAGE_KEY_ID',
      'DEFAULT_COMPANY_ID', 'STAFF_APP_URL', 'ADMIN_APP_URL', 'MAIL_FROM', 'GMAIL_DELEGATED_USER', 'PUBLIC_LOGIN_GATEWAY_URL', 'FILE_PREVIEW_GATEWAY_URL'];
    for (const name of S.functions) {
      for (const key of configKeys) pair[name].fn.serviceConfig.environmentVariables[key] = 'synthetic-' + key;
      pair[name].service.spec.template.spec.containers[0].env = Object.entries(pair[name].fn.serviceConfig.environmentVariables).map(([name, value]) => ({name, value}));
      objects.set(pair[name].object.name + '#' + pair[name].object.generation, copy(pair[name].object));
    }
    if (scenario === 'trigger-mismatch-preflight') pair.finalizeStagedUpload.trigger.destination.cloudRun.service = 'other';
    if (scenario === 'function-destination-preflight') pair.finalizeStagedUpload.trigger.destination =
      {cloudFunction: pair.finalizeStagedUpload.fn.name};
    if (scenario === 'private-bucket-unverified') f.bucket.iamConfiguration.publicAccessPrevention = 'UNVERIFIED';
    if (scenario === 'inherited-private-preflight') f.bucket.iamConfiguration.publicAccessPrevention = 'inherited';
    if (scenario.startsWith('organization-')) {
      f.bucket.iamConfiguration.publicAccessPrevention = 'inherited'; f.bucket.project.parent = {type:'organization',id:'123'};
      f.bucket.effectivePublicAccessPrevention = enforcedPolicy();
      if (scenario === 'organization-unverified-preflight') f.bucket.effectivePublicAccessPrevention.booleanPolicy.enforced = false;
      for (const name of S.functions) {
        delete pair[name].fn.serviceConfig.environmentVariables.LKC_SHEET_WRITE_MODE;
        pair[name].service.spec.template.spec.containers[0].env = pair[name].service.spec.template.spec.containers[0].env.filter(e => e.name !== 'LKC_SHEET_WRITE_MODE');
      }
    }
    const json = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
    const fakeFetch = async (value, options) => {
      const url = new URL(value), method = options.method, p = url.pathname;
      assert.equal(options.redirect, 'error');
      if (method === 'GET' && url.hostname === 'storage.googleapis.com' && p === `/storage/v1/b/${S.bucket}/iam/testPermissions`) {
        const permissions = ['storage.buckets.get', 'storage.buckets.getIamPolicy', 'storage.buckets.update', 'storage.buckets.setIamPolicy'];
        assert.deepEqual(url.searchParams.getAll('permissions'), permissions);
        assert.equal(options.body, undefined);
        return json({kind: 'storage#testIamPermissionsResponse', permissions});
      }
      if (method === 'GET' && url.hostname === 'storage.googleapis.com' && p === `/storage/v1/b/${S.bucket}`) {
        const {policy, project, projectPolicy, effectivePublicAccessPrevention, ...bucket} = f.bucket; return json(bucket);
      }
      if (method === 'PATCH' && url.hostname === 'storage.googleapis.com' && p === `/storage/v1/b/${S.bucket}`) {
        assert.equal(url.search, '?ifMetagenerationMatch=42');
        assert.deepEqual(JSON.parse(options.body), {iamConfiguration: {publicAccessPrevention: 'enforced'}});
        mutations.push({method, path: p, kind: 'bucket-privacy'});
        if (scenario === 'privacy-conflict-preflight') return new Response('', {status: 412});
        f.bucket.iamConfiguration.publicAccessPrevention = 'enforced'; f.bucket.metageneration = '43';
        if (scenario === 'privacy-after-drift-preflight') f.bucket.labels.unexpected = 'drift';
        if (scenario === 'privacy-unknown-preflight') throw Error(privateValue);
        const {policy, project, projectPolicy, ...bucket} = f.bucket; return json(bucket);
      }
      if (url.hostname === 'cloudresourcemanager.googleapis.com' && p.endsWith(':getEffectiveOrgPolicy')) {
        assert.equal(method,'POST'); assert.deepEqual(JSON.parse(options.body),{constraint:UPLOAD_PUBLIC_ACCESS_CONSTRAINT});
        return scenario === 'organization-policy-forbidden-preflight' ? new Response('',{status:403}) : json(f.bucket.effectivePublicAccessPrevention);
      }
      if (url.hostname === 'cloudresourcemanager.googleapis.com') return json(method === 'GET' ? f.bucket.project : f.bucket.projectPolicy);
      if (method === 'GET' && p === `/storage/v1/b/${S.bucket}/iam`) return json(f.bucket.policy);
      if (method === 'GET' && p.endsWith(':getIamPolicy')) return json(emptyPolicy());
      if (method === 'GET' && url.hostname === `${S.region}-run.googleapis.com`) {
        const name = S.functions.find(n => n.toLowerCase() === p.split('/').at(-1)); return json(pair[name].service);
      }
      if (method === 'GET' && url.hostname === 'eventarc.googleapis.com') return json(pair.finalizeStagedUpload.trigger);
      if (method === 'GET' && url.hostname === 'cloudfunctions.googleapis.com') return json(pair[p.split('/').at(-1)].fn);
      if (method === 'GET' && url.hostname === 'storage.googleapis.com' && p.includes('/o/')) {
        const name = decodeURIComponent(p.split('/o/')[1]), key = name + '#' + url.searchParams.get('generation');
        assert.ok(objects.has(key));
        return url.searchParams.get('alt') === 'media' ? new Response(Buffer.from(bodies.get(key))) : json(objects.get(key));
      }
      if (method === 'POST' && p.startsWith('/upload/')) {
        const name = url.searchParams.get('name'), buffer = Buffer.from(options.body), info = {bucket: S.bucket, name,
          generation: String(++generation), size: String(buffer.length), md5Hash: createHash('md5').update(buffer).digest('base64'),
          crc32c: Buffer.alloc(4, 3).toString('base64')};
        assert.equal(url.searchParams.get('ifGenerationMatch'), '0');
        objects.set(name + '#' + info.generation, info); bodies.set(name + '#' + info.generation, buffer);
        mutations.push({method, path: p, name}); return json(info);
      }
      if (method === 'POST' && p.includes('/copyTo/')) {
        const parts = p.split('/o/'), old = objects.get(decodeURIComponent(parts[1].split('/copyTo/')[0]) + '#' + url.searchParams.get('sourceGeneration'));
        const info = {...old, name: decodeURIComponent(parts[2]), generation: String(++generation)};
        objects.set(info.name + '#' + info.generation, info); mutations.push({method, path: p}); return json(info);
      }
      if (method === 'PATCH') {
        patches++; const body = JSON.parse(options.body), name = body.name.split('/').at(-1), record = pair[name];
        assert.equal(url.searchParams.get('updateMask'), 'buildConfig.source');
        assert.deepEqual(Object.keys(body).sort(), ['buildConfig', 'name']);
        record.fn.buildConfig.source = copy(body.buildConfig.source);
        record.fn.buildConfig.sourceProvenance.resolvedStorageSource = copy(body.buildConfig.source.storageSource);
        if (scenario.startsWith('managed-')) {
          const requested = body.buildConfig.source.storageSource, oldKey = requested.object + '#' + requested.generation;
          const object = {...objects.get(oldKey), name: name + '/function-source.zip', generation: String(++generation)};
          objects.set(object.name + '#' + object.generation, object);
          if (bodies.has(oldKey)) bodies.set(object.name + '#' + object.generation, Buffer.from(bodies.get(oldKey)));
          record.fn.buildConfig.sourceProvenance.resolvedStorageSource = {bucket: S.bucket, object: object.name, generation: object.generation};
        }
        const revision = name.toLowerCase() + '-00' + (100 + patches) + '-ready';
        record.fn.serviceConfig.revision = revision; record.fn.updateTime = '2026-10-31T10:00:00Z';
        record.service.status.latestReadyRevisionName = record.service.status.latestCreatedRevisionName = revision;
        record.service.status.traffic[0].revisionName = revision;
        record.service.spec.template.spec.containers[0].image = 'generated-image-' + patches;
        mutations.push({method, name, source: copy(body.buildConfig.source.storageSource)});
        if (scenario === 'unknown-second' && patches === 2) throw Error(privateValue);
        const failed = scenario.endsWith('second-failure') && patches === 2;
        record.fn.state = failed ? 'FAILED' : 'ACTIVE';
        return json({name: `${prefix}/operations/op-${patches}`, metadata: {target: body.name}, done: true,
          ...(failed ? {error: {code: 13, message: privateValue}} : {response: record.fn})});
      }
      assert.fail('Unexpected isolated request: ' + method + ' ' + p);
    };
    const api = authenticatedUploadRefreshAPI({getRequestHeaders: async () => ({authorization: 'Bearer synthetic-only'})}, fakeFetch,
      {allowBackupPrivacyEnforcement: privacyOperation});
    const env = {...context(), GITHUB_SHA: git(['rev-parse', 'HEAD']), LKC_VERIFIED_SOURCE_SHA: git(['rev-parse', 'HEAD']), LKC_SOURCE_DIRECTORY: root, GITHUB_WORKSPACE: root};
    if (scenario.endsWith('preflight')) env.LKC_UPLOAD_WRITE_CONFIRMATION = '';
    if (privacyOperation) env.LKC_UPLOAD_PRIVACY_CONFIRMATION = UPLOAD_BACKUP_PRIVACY_CONFIRMATION;
    const result = await runUploadSourceRefresh(env, {api, fetch: async (url, options) => {
      probes++; assert.equal(url.hostname, 'createuploadsession-synthetic-an.a.run.app');
      assert.deepEqual(JSON.parse(options.body), {data: {}});
      assert.equal(options.headers.authorization, undefined); return new Response('', {status: 401});
    }});
    assert.equal(result.cleanup, 'DONE'); assert.equal(result.deployedFunctionsVerified, false);
    assert.equal(result.cloudWritesAttempted, false);
    if (!env.LKC_UPLOAD_WRITE_CONFIRMATION && !env.LKC_UPLOAD_PRIVACY_CONFIRMATION) {
      assert.equal(result.backupBucketPermissions.status, 'VERIFIED_CALLER_PERMISSIONS');
      assert.equal(result.backupBucketPermissions.privacyUpdatePermissionsPresent, true);
    } else assert.equal(Object.hasOwn(result, 'backupBucketPermissions'), false);
    const artifact = fs.readFileSync(path.join(root, 'upload-source-refresh-result.json'), 'utf8');
    assert.doesNotMatch(artifact, new RegExp(privateValue)); assert.doesNotMatch(artifact, /secretEnvironmentVariables|PRIVATE_BUILD_SETTING/);
    if (privacyOperation) {
      assert.equal(patches, 0); assert.equal(probes, 0); assert.equal(result.mediaBytes, 0);
      assert.ok(mutations.every(m => m.kind === 'bucket-privacy'));
      if (['privacy-conflict-preflight', 'privacy-unknown-preflight', 'privacy-after-drift-preflight'].includes(scenario)) {
        assert.equal(result.status, 'STOPPED_SAFELY'); assert.equal(mutations.length, 1);
        assert.equal(result.backupPrivacyEnforcement.status, 'REQUESTED_RESULT_UNVERIFIED');
        assert.equal(result.reason, scenario === 'privacy-conflict-preflight' ? 'UPLOAD_REFRESH_HTTP_REJECTED'
          : scenario === 'privacy-unknown-preflight' ? 'UPLOAD_REFRESH_HTTP_OUTCOME_UNKNOWN' : 'UPLOAD_REFRESH_PRIVACY_OTHER_SETTINGS_CHANGED');
        if (scenario === 'privacy-conflict-preflight') assert.equal(result.httpStatus, 412);
      } else {
        assert.equal(result.status, 'UPLOAD_SOURCE_PREFLIGHT_VERIFIED'); assert.equal(result.sourceRefreshPreflightVerified, true);
        const changed = scenario !== 'privacy-already-enforced-preflight';
        assert.deepEqual(result.backupPrivacyEnforcement, {status: changed ? 'ENFORCED_AND_VERIFIED' : 'ALREADY_ENFORCED', changed});
        assert.equal(mutations.length, changed ? 1 : 0);
      }
    } else if (scenario === 'trigger-mismatch-preflight') {
      assert.equal(result.status, 'STOPPED_SAFELY');
      assert.equal(result.reason, 'UPLOAD_REFRESH_STORAGE_TRIGGER_NOT_VERIFIED');
      assert.equal(result.preflight.storageTrigger.destinationServiceMatches, false);
      assert.ok(Object.entries(result.preflight.storageTrigger).every(([key, value]) =>
        key === 'destinationServiceMatches' || value === true));
      assert.equal(patches, 0); assert.equal(probes, 0); assert.equal(mutations.length, 0); assert.equal(result.mediaBytes, 0);
    } else if (['organization-unverified-preflight','organization-policy-forbidden-preflight'].includes(scenario)) {
      assert.equal(result.status, 'STOPPED_SAFELY');
      assert.equal(result.reason, scenario === 'organization-unverified-preflight'
        ? 'UPLOAD_REFRESH_EFFECTIVE_PUBLIC_ACCESS_PREVENTION_NOT_VERIFIED' : 'UPLOAD_REFRESH_HTTP_REJECTED');
      if (scenario === 'organization-policy-forbidden-preflight') assert.equal(result.httpStatus,403);
      assert.equal(patches,0); assert.equal(probes,0); assert.equal(mutations.length,0); assert.equal(result.mediaBytes,0);
    } else if (scenario.endsWith('preflight')) {
      assert.equal(result.status, 'UPLOAD_SOURCE_PREFLIGHT_VERIFIED'); assert.equal(result.sourceRefreshPreflightVerified, true);
      assert.equal(result.preflight.storageTriggerDestinationType, scenario === 'function-destination-preflight' ? 'cloudFunction' : 'cloudRun');
      assert.ok(Object.values(result.preflight.storageTrigger).every(value => value === true));
      assert.equal(patches, 0); assert.equal(probes, 0); assert.equal(mutations.length, 0); assert.equal(result.mediaBytes, 0);
    } else if (scenario.endsWith('success')) {
      assert.equal(result.status, 'SOURCE_ONLY_CONTRACT_VERIFIED'); assert.equal(patches, 2); assert.equal(probes, 1);
      assert.equal(result.deployedPackageBytesVerified, true); assert.equal(result.unauthenticatedRejectionVerified, true);
      assert.equal(mutations.filter(m => m.method === 'POST').length, 5);
    } else if (scenario.endsWith('second-failure')) {
      assert.equal(result.status, 'PAIR_RESTORE_VERIFIED'); assert.equal(patches, 4); assert.equal(probes, 0);
      assert.ok(mutations.filter(m => m.method === 'PATCH').slice(-2).every(m => m.source.object.startsWith('lkc-upload-source-backups/')));
    } else if (scenario === 'unknown-second') {
      assert.equal(result.reason, 'UPLOAD_REFRESH_OPERATION_OUTCOME_UNKNOWN'); assert.equal(patches, 2); assert.equal(probes, 0);
    } else {
      assert.equal(result.reason, 'UPLOAD_REFRESH_PRIVATE_BUCKET_NOT_VERIFIED'); assert.equal(mutations.length, 0);
    }
  });


