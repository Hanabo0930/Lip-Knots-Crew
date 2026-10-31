import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {UPLOAD_REFRESH_SCOPE as S, prepareUploadSourceRefresh, uploadBackupRequests,
  verifyUploadBackups, uploadSourceOnlyPatch, runUploadRefreshTransaction} from './upload-source-refresh-contract.mjs';
import {validateUploadRefreshContext, authenticatedUploadRefreshAPI, writeUploadRefreshObject, runUploadSourceRefresh,
  uploadRefreshCloudOwner} from './run-upload-source-refresh.mjs';
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
        eventFilters: {bucket: 'synthetic-submissions-bucket', type: fn.eventTrigger.eventType},
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
  ['unknown inherited policy', f => f.bucket.project.parent = {type: 'organization', id: '123'}],
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
  ['wrong event bucket', f => f.before.finalizeStagedUpload.trigger.eventFilters.bucket = 'other'],
  ['source writes would trigger finalizer', f => { f.before.finalizeStagedUpload.fn.eventTrigger.eventFilters[0].value = S.bucket; f.before.finalizeStagedUpload.trigger.eventFilters.bucket = S.bucket; }],
  ['changed trigger principal', f => f.before.finalizeStagedUpload.trigger.serviceAccount = 'other@example.invalid'],
  ['mutable secret alias', f => f.before.createUploadSession.fn.serviceConfig.secretEnvironmentVariables[0].version = 'latest'],
  ['unbounded private snapshot', f => f.before.createUploadSession.fn.description = 'x'.repeat(S.configBytes)],
]) test('reject before planning writes: ' + label, () => { const f = fixture(); mutate(f); assert.throws(() => prepareUploadSourceRefresh(f), /UPLOAD_REFRESH_/); });
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

for (const scenario of ['success', 'managed-success', 'second-failure', 'managed-second-failure', 'unknown-second', 'private-bucket-unverified', 'read-only-preflight', 'inherited-private-preflight'])
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
    const configKeys = ['ADMIN_EMAILS', 'EXECUTIVE_APPROVER_EMAILS', 'PRODUCTION_FIREBASE_PROJECT_ID', 'APPROVAL_PACKAGE_KEY_ID',
      'DEFAULT_COMPANY_ID', 'STAFF_APP_URL', 'ADMIN_APP_URL', 'MAIL_FROM', 'GMAIL_DELEGATED_USER', 'PUBLIC_LOGIN_GATEWAY_URL', 'FILE_PREVIEW_GATEWAY_URL'];
    for (const name of S.functions) {
      for (const key of configKeys) pair[name].fn.serviceConfig.environmentVariables[key] = 'synthetic-' + key;
      pair[name].service.spec.template.spec.containers[0].env = Object.entries(pair[name].fn.serviceConfig.environmentVariables).map(([name, value]) => ({name, value}));
      objects.set(pair[name].object.name + '#' + pair[name].object.generation, copy(pair[name].object));
    }
    if (scenario === 'private-bucket-unverified') f.bucket.iamConfiguration.publicAccessPrevention = 'UNVERIFIED';
    if (scenario === 'inherited-private-preflight') f.bucket.iamConfiguration.publicAccessPrevention = 'inherited';
    const json = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
    const fakeFetch = async (value, options) => {
      const url = new URL(value), method = options.method, p = url.pathname;
      assert.equal(options.redirect, 'error');
      if (method === 'GET' && url.hostname === 'storage.googleapis.com' && p === `/storage/v1/b/${S.bucket}`) {
        const {policy, project, projectPolicy, ...bucket} = f.bucket; return json(bucket);
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
    const api = authenticatedUploadRefreshAPI({getRequestHeaders: async () => ({authorization: 'Bearer synthetic-only'})}, fakeFetch);
    const env = {...context(), GITHUB_SHA: git(['rev-parse', 'HEAD']), LKC_VERIFIED_SOURCE_SHA: git(['rev-parse', 'HEAD']), LKC_SOURCE_DIRECTORY: root, GITHUB_WORKSPACE: root};
    if (scenario.endsWith('preflight')) env.LKC_UPLOAD_WRITE_CONFIRMATION = '';
    const result = await runUploadSourceRefresh(env, {api, fetch: async (url, options) => {
      probes++; assert.equal(url.hostname, 'createuploadsession-synthetic-an.a.run.app');
      assert.deepEqual(JSON.parse(options.body), {data: {}});
      assert.equal(options.headers.authorization, undefined); return new Response('', {status: 401});
    }});
    assert.equal(result.cleanup, 'DONE'); assert.equal(result.deployedFunctionsVerified, false);
    assert.equal(result.cloudWritesAttempted, false);
    const artifact = fs.readFileSync(path.join(root, 'upload-source-refresh-result.json'), 'utf8');
    assert.doesNotMatch(artifact, new RegExp(privateValue)); assert.doesNotMatch(artifact, /secretEnvironmentVariables|PRIVATE_BUILD_SETTING/);
    if (scenario.endsWith('preflight')) {
      assert.equal(result.status, 'UPLOAD_SOURCE_PREFLIGHT_VERIFIED'); assert.equal(result.sourceRefreshPreflightVerified, true);
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
