import {existsSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {validatePlan} from './validate-staging-scope.mjs';
import {authenticatedUploadRefreshAPI, uploadRefreshReader} from './run-upload-source-refresh.mjs';
import {UPLOAD_REFRESH_SCOPE as scope, assertUploadRefreshBeforeImages, assertUploadAcceptanceChange,
  uploadAcceptanceImage, uploadExactEventFilterValue} from './upload-source-refresh-contract.mjs';
import {project, bucket, company, caseId, uid, staffId, jobId, driveRoot, submissionId, files, issuedNonce,
  ruleFilename, rulesFor, modeVariable, sourceArchiveSha256, sourceArchiveBytes} from './staging-upload-acceptance-manifest.mjs';
import {loadConfirmation, tunedConfirmation, tunedRestoreConfirmation, loadId, tunedLoadId, loadRules, loadWindowMs, clients, tunedClients, phases, phasePlan, progressPath, tunedProgressPath,
  getStageDocuments, submissionPaths, assertCompletedWave} from './staging-upload-load-plan.mjs';
import {loadCapacityPatch, normalizeLoadCapacity} from './staging-upload-load-capacity.mjs';

const repository = 'Hanabo0930/Lip-Knots-Crew';
const prefix = 'projects/' + project + '/locations/' + scope.region;
const functionsAPI = 'https://cloudfunctions.googleapis.com/v2/';
const firestore = 'https://firestore.googleapis.com/v1/projects/' + project + '/databases/(default)/documents';
const rulesAPI = 'https://firebaserules.googleapis.com/v1/';
const release = 'projects/' + project + '/releases/firebase.storage/' + bucket;
const authLookup = 'https://identitytoolkit.googleapis.com/v1/projects/' + project + '/accounts:lookup';
const functionRef = name => prefix + '/functions/' + name;
const mode = record => record?.fn?.serviceConfig?.environmentVariables?.[modeVariable];
const requireCheck = (condition, code) => { if (!condition) throw Error(code); };
const safeError = error => /^UPLOAD_(ACCEPTANCE|REFRESH)_[A-Z_0-9]+$/.test(error?.message)
  ? error.message : 'UPLOAD_ACCEPTANCE_EXECUTION_FAILED';
const maxWindow = 4 * 60_000;

export function validateContext(env, action) {
  const opening = env.LKC_TRANSFER_MODE_REQUESTED === 'acceptance';
  // GitHub serializes the existing unquoted YAML choice `off` as `false`.
  const gasDisabled = ['off', 'false'].includes(env.LKC_GAS_SYNC_MODE);
  validatePlan({mode: 'functions-upload-acceptance', project: env.LKC_PROJECT_ID, region: env.LKC_REGION,
    sourceRef: env.LKC_SOURCE_REF, functions: env.LKC_FUNCTIONS, confirmation: env.LKC_CONFIRMATION});
  requireCheck(env.GITHUB_REPOSITORY === repository && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_RUN_ATTEMPT === '1'
    && env.GITHUB_WORKFLOW_REF === repository + '/.github/workflows/staging-functions-deploy.yml@refs/heads/main'
    && ['guard', 'upload-acceptance'].includes(env.GITHUB_JOB)
    && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && env.LKC_OPERATION === 'upload-acceptance-mode'
    && !env.LKC_UPLOAD_WRITE_CONFIRMATION && !env.LKC_UPLOAD_PRIVACY_CONFIRMATION
    && gasDisabled, 'UPLOAD_ACCEPTANCE_PROTECTED_CONTEXT_REQUIRED');
  requireCheck(opening ? ['TEST_LKC_STAGING_ONE_SYNTHETIC_UPLOAD_CASE', loadConfirmation, tunedConfirmation].includes(env.LKC_CONFIRMATION)
    : env.LKC_TRANSFER_MODE_REQUESTED === 'paused' && !env.LKC_ACCEPTANCE_EXPIRY
      && ['RESTORE_LKC_STAGING_UPLOAD_PAUSED', tunedRestoreConfirmation].includes(env.LKC_CONFIRMATION),
    'UPLOAD_ACCEPTANCE_CONFIRMATION_REJECTED');
  if (opening) {
    if ([loadConfirmation, tunedConfirmation].includes(env.LKC_CONFIRMATION)) {
      loadRules(env.LKC_ACCEPTANCE_EXPIRY, env.LKC_CONFIRMATION === tunedConfirmation);
    } else rulesFor(env.LKC_ACCEPTANCE_EXPIRY);
  }
  requireCheck(action === 'validate' || (env.GITHUB_JOB === 'upload-acceptance'
    && env.LKC_VERIFIED_SOURCE_SHA === env.GITHUB_SHA && ['run', 'recover'].includes(action)),
  'UPLOAD_ACCEPTANCE_EXECUTION_CONTEXT_REQUIRED');
  return opening;
}

const scalar = (doc, key) => {
  const field = doc?.fields?.[key];
  return field?.stringValue ?? field?.booleanValue ?? (field?.integerValue === undefined ? undefined : Number(field.integerValue));
};
const docId = doc => doc?.name?.split('/').at(-1);

function cloud(token, tuned = false) {
  async function json(url, {method = 'GET', body, absent = false} = {}) {
    const response = await fetch(url, {method, signal: AbortSignal.timeout(15_000), redirect: 'error',
      headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache',
        'X-Goog-User-Project': project},
      body: body === undefined ? undefined : JSON.stringify(body)});
    if (response.status === 404 && absent) return null;
    requireCheck(response.ok, 'UPLOAD_ACCEPTANCE_HTTP_' + response.status);
    const payload = await response.text();
    requireCheck(Buffer.byteLength(payload) <= 512 * 1024, 'UPLOAD_ACCEPTANCE_RESPONSE_TOO_LARGE');
    return JSON.parse(payload);
  }
  const base = authenticatedUploadRefreshAPI({getRequestHeaders: async () => ({Authorization: 'Bearer ' + token})});
  const reader = uploadRefreshReader({request(url, options) {
    requireCheck(options === undefined || options.readOnlyPost === true, 'UPLOAD_ACCEPTANCE_READ_ONLY_API_REQUIRED');
    return base.request(url, options);
  }});
  const verifiedGenerations = new Map();
  async function readPair({verifyContent = true} = {}) {
    const pair = await reader.readPair();
    if (!verifyContent) return pair;
    for (const name of scope.functions) {
      const record = pair[name];
      const ref = record.fn.buildConfig?.sourceProvenance?.resolvedStorageSource;
      requireCheck(ref?.bucket === scope.bucket && ref.object === name + '/function-source.zip'
        && /^[1-9][0-9]{0,19}$/.test(ref.generation ?? '') && +record.object.size === sourceArchiveBytes,
      'UPLOAD_ACCEPTANCE_SOURCE_METADATA_MISMATCH');
      const key = ref.object + '#' + ref.generation;
      if (!verifiedGenerations.has(key)) {
        requireCheck(verifiedGenerations.size < 8, 'UPLOAD_ACCEPTANCE_SOURCE_READ_LIMIT');
        const url = 'https://storage.googleapis.com/storage/v1/b/' + scope.bucket + '/o/' + encodeURIComponent(ref.object)
          + '?alt=media&generation=' + ref.generation + '&ifGenerationMatch=' + ref.generation;
        const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(30_000),
          headers: {Authorization: 'Bearer ' + token, 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache'}});
        const length = response.headers.get('content-length');
        requireCheck(response.ok && (length === null || Number(length) === sourceArchiveBytes)
          && [null, 'identity'].includes(response.headers.get('content-encoding')), 'UPLOAD_ACCEPTANCE_SOURCE_CONTENT_UNVERIFIED');
        const digest = createHash('sha256');
        let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          requireCheck(bytes <= sourceArchiveBytes, 'UPLOAD_ACCEPTANCE_SOURCE_CONTENT_UNVERIFIED');
          digest.update(chunk);
        }
        requireCheck(bytes === sourceArchiveBytes && digest.digest('hex') === sourceArchiveSha256,
          'UPLOAD_ACCEPTANCE_SOURCE_CONTENT_UNVERIFIED');
        verifiedGenerations.set(key, sourceArchiveSha256);
      }
      record.sourceArchiveSha256 = verifiedGenerations.get(key);
    }
    return pair;
  }
  async function update(name, before, next) {
    requireCheck(scope.functions.includes(name) && ['acceptance', 'paused'].includes(next), 'UPLOAD_ACCEPTANCE_PATCH_SCOPE_REJECTED');
    const target = functionRef(name);
    const profile = tuned ? loadCapacityPatch(before, name, next) : {mask: '', additions: {}};
    const body = {name: target, serviceConfig: {...profile.additions, environmentVariables: {
      ...before.fn.serviceConfig.environmentVariables, [modeVariable]: next,
    }}};
    let operation = await json(functionsAPI + target + '?updateMask=serviceConfig.environmentVariables' + profile.mask, {method: 'PATCH', body});
    const operationName = operation?.name;
    const pattern = new RegExp('^' + prefix + '/operations/[a-zA-Z0-9_-]+$');
    requireCheck(pattern.test(operationName ?? ''), 'UPLOAD_ACCEPTANCE_OPERATION_UNVERIFIED');
    const deadline = Date.now() + 6 * 60_000;
    for (;;) {
      requireCheck(operation.name === operationName && operation.metadata?.target === target,
        'UPLOAD_ACCEPTANCE_OPERATION_UNVERIFIED');
      if (operation.done === true) {
        requireCheck(!operation.error && operation.response?.name === target, 'UPLOAD_ACCEPTANCE_OPERATION_FAILED');
        return;
      }
      requireCheck(Date.now() < deadline, 'UPLOAD_ACCEPTANCE_OPERATION_PENDING');
      await delay(5000);
      operation = await json(functionsAPI + operationName);
    }
  }
  return {...reader, readPair, json, update, doc: path => json(firestore + '/' + path, {absent: true})};
}

async function companyRows(api, collection, limit = 16, selected = []) {
  const found = await api.json(firestore + ':runQuery', {method: 'POST', body: {structuredQuery: {
    from: [{collectionId: collection}], where: {fieldFilter: {field: {fieldPath: 'companyId'},
      op: 'EQUAL', value: {stringValue: company}}}, limit,
    ...(selected.length ? {select: {fields: selected.map(fieldPath => ({fieldPath}))}} : {}),
  }}});
  const rows = found.flatMap(row => row.document ? [row.document] : []);
  requireCheck(rows.length < limit, 'UPLOAD_ACCEPTANCE_FIXTURE_QUERY_LIMIT');
  return rows;
}

async function verifyRules(api, expiry, ruleTemplate = rulesFor) {
  const expected = ruleTemplate(expiry);
  requireCheck(Date.now() + 45_000 < Date.parse(expiry) && Date.parse(expiry) - Date.now() <= 45 * 60_000,
    'UPLOAD_ACCEPTANCE_EXPIRY_OUTSIDE_WINDOW');
  const current = await api.json(rulesAPI + release);
  requireCheck(current.name === release && new RegExp('^projects/' + project + '/rulesets/[a-f0-9-]{36}$').test(current.rulesetName ?? ''),
    'UPLOAD_ACCEPTANCE_RULE_RELEASE_UNVERIFIED');
  const rules = await api.json(rulesAPI + current.rulesetName);
  requireCheck(rules.name === current.rulesetName && rules.source?.files?.length === 1
    && rules.source.files[0].name === ruleFilename && rules.source.files[0].content === expected,
    'UPLOAD_ACCEPTANCE_RULE_SOURCE_MISMATCH');
}

async function verifyLoadFixture(api, tuned) {
  const expectedClients = tuned ? tunedClients : clients;
  const run = tuned ? tunedLoadId : loadId;
  const markerPath = tuned ? tunedProgressPath : progressPath;
  const activeFields = ['active', 'staffId', 'loadRun', 'revokedAt', 'submissionUploadGrants', 'deviceBoundAuthRequired'];
  const [identities, profiles, jobs, previous, drive, mapping, progress] = await Promise.all([
    companyRows(api, 'authIdentities', 401, activeFields), companyRows(api, 'staffProfiles', 651, activeFields),
    companyRows(api, 'jobs', 651, ['status', 'cancelled', 'assignedStaffId', 'dateKey', 'caseId', 'loadRun',
      'revision', 'mailIntake', 'sourceMissing', 'applicationUnconfirmed', 'assignmentUnresolved', 'clientName']),
    companyRows(api, 'submissions', 601, ['status', 'uid', 'staffId', 'jobId']), api.doc('companies/' + company + '/settings/drive'),
    api.doc('companies/' + company + '/sheetMappings/shift'), api.doc(markerPath),
  ]);
  const active = rows => new Map(rows.filter(doc => scalar(doc, 'active') === true).map(doc => [docId(doc), doc]));
  const staff = active(profiles), linked = active(identities);
  const byJob = new Map();
  for (const job of jobs) {
    const assignee = scalar(job, 'assignedStaffId');
    if (!staff.has(assignee) || scalar(job, 'status') !== 'assigned' || scalar(job, 'cancelled') === true) continue;
    requireCheck(!byJob.has(assignee), 'UPLOAD_ACCEPTANCE_LOAD_DUPLICATE_ASSIGNMENT');
    byJob.set(assignee, job);
  }
  const ids = new Set(phases.flatMap(phase => phasePlan(phase, tuned).map(plan => plan.submissionId)));
  requireCheck(staff.size === expectedClients.length && linked.size === expectedClients.length && byJob.size === expectedClients.length
    && previous.every(doc => !ids.has(docId(doc)))
    && scalar(drive, 'rootFolderId') === driveRoot
    && (!mapping || (scalar(mapping, 'enabled') === false && !scalar(mapping, 'spreadsheetId')))
    && scalar(progress, 'loadRun') === run && scalar(progress, 'state') === 'ready',
  'UPLOAD_ACCEPTANCE_LOAD_FIXTURE_MISMATCH');
  const dateKey = scalar(progress, 'dateKey');
  requireCheck(/^\d{4}-\d\d-\d\d$/.test(dateKey ?? ''), 'UPLOAD_ACCEPTANCE_LOAD_FIXTURE_MISMATCH');
  const incomplete = previous.filter(doc => scalar(doc, 'status') !== 'completed');
  if (tuned) {
    const oldPlans = phasePlan(50), byId = new Map(oldPlans.map(plan => [plan.submissionId, plan]));
    requireCheck(incomplete.length === 50 && incomplete.every(doc => {
      const plan = byId.get(docId(doc));
      return plan && scalar(doc, 'staffId') === plan.staffId && scalar(doc, 'uid') === plan.uid
        && scalar(doc, 'jobId') === plan.jobId && !staff.has(plan.staffId)
        && scalar(linked.get(plan.uid), 'staffId') !== plan.staffId;
    }), 'UPLOAD_ACCEPTANCE_LOAD_OLD_RECEIPT_SCOPE');
    const saved = await getStageDocuments(api.json, submissionPaths(oldPlans, true));
    for (const plan of oldPlans) {
      const file = saved.get('submissions/' + plan.submissionId + '/files/' + plan.fileId);
      requireCheck(file && !scalar(file, 'driveFileId') && scalar(file, 'completionCounted') !== true
        && issuedNonce(plan, scalar(file, 'storagePath')), 'UPLOAD_ACCEPTANCE_LOAD_OLD_RECEIPT_SCOPE');
    }
  } else requireCheck(incomplete.length === 0, 'UPLOAD_ACCEPTANCE_LOAD_INCOMPLETE_RECEIPT');
  for (const client of expectedClients) {
    const identity = linked.get(client.uid), profile = staff.get(client.staffId), job = byJob.get(client.staffId);
    requireCheck([identity, profile, job].every(doc => scalar(doc, 'loadRun') === run)
      && scalar(identity, 'staffId') === client.staffId && !identity.fields?.revokedAt && !identity.fields?.submissionUploadGrants
      && scalar(profile, 'deviceBoundAuthRequired') !== true && docId(job) === client.jobId
      && scalar(job, 'caseId') === run + '-' + client.number && scalar(job, 'dateKey') === dateKey
      && scalar(job, 'clientName') === run && scalar(job, 'revision') === 0 && !job.fields?.mailIntake
      && !['sourceMissing', 'applicationUnconfirmed', 'assignmentUnresolved'].some(key => scalar(job, key) === true),
    'UPLOAD_ACCEPTANCE_LOAD_FIXTURE_MISMATCH');
  }
  await Promise.all(Array.from({length: 3}, async (_, i) => {
    const group = expectedClients.slice(i * 100, (i + 1) * 100);
    const list = await api.json(authLookup, {method: 'POST', body: {localId: group.map(client => client.uid)}});
    const accounts = new Map((list.users ?? []).map(account => [account.localId, account]));
    requireCheck(accounts.size === group.length && group.every(client => {
      const account = accounts.get(client.uid);
      return account?.email === client.email && !account.disabled
        && isDeepStrictEqual(JSON.parse(account.customAttributes ?? '{}'), client.claims);
    }), 'UPLOAD_ACCEPTANCE_LOAD_ACCOUNT_MISMATCH');
  }));
  await verifySheetWorkers(api);
}

async function verifySheetWorkers(api) {
  const workers = await Promise.all(['processSafeSheetWrite', 'retrySafeSheetWrites']
    .map(name => api.json(functionsAPI + functionRef(name), {absent: true})));
  for (const worker of workers) {
    if (!worker) continue;
    const env = worker.serviceConfig?.environmentVariables;
    requireCheck(worker.state === 'ACTIVE' && env?.APP_ENVIRONMENT === 'staging'
      && [undefined, 'paused'].includes(env.LKC_SHEET_WRITE_MODE), 'UPLOAD_ACCEPTANCE_SHEET_WORKER_NOT_PAUSED');
  }
}

async function waitForLoad(api, expiry, tuned) {
  const deadline = Math.min(Date.now() + loadWindowMs, Date.parse(expiry) - 45_000);
  while (Date.now() < deadline) {
    const marker = await api.doc(tuned ? tunedProgressPath : progressPath);
    requireCheck(scalar(marker, 'loadRun') === (tuned ? tunedLoadId : loadId), 'UPLOAD_ACCEPTANCE_LOAD_PROGRESS_MISMATCH');
    const state = scalar(marker, 'state');
    if (state === 'done') {
      requireCheck(scalar(marker, 'completed') === 450, 'UPLOAD_ACCEPTANCE_LOAD_PROGRESS_MISMATCH');
      const plan = phases.flatMap(phase => phasePlan(phase, tuned));
      const docs = await getStageDocuments(api.json, submissionPaths(plan, true));
      requireCheck(assertCompletedWave(plan, docs).size === 450, 'UPLOAD_ACCEPTANCE_LOAD_COMPLETION_MISMATCH');
      return;
    }
    requireCheck(state !== 'stopped', 'UPLOAD_ACCEPTANCE_LOAD_STOPPED');
    await delay(5000);
  }
  throw Error('UPLOAD_ACCEPTANCE_LOAD_TIMEOUT');
}

async function verifyFixture(api) {
  const [identities, profiles, jobs, submissions, drive, auth, sheetWorker, retryWorker] = await Promise.all([
    companyRows(api, 'authIdentities'), companyRows(api, 'staffProfiles'), companyRows(api, 'jobs'),
    companyRows(api, 'submissions'), api.doc('companies/' + company + '/settings/drive'),
    api.json(authLookup, {method: 'POST', body: {localId: [uid]}}),
    api.json(functionsAPI + functionRef('processSafeSheetWrite'), {absent: true}),
    api.json(functionsAPI + functionRef('retrySafeSheetWrites'), {absent: true}),
  ]);
  const active = rows => rows.filter(doc => scalar(doc, 'active') === true);
  const assignment = jobs.filter(doc => scalar(doc, 'status') === 'assigned' && scalar(doc, 'cancelled') !== true);
  const [identity] = active(identities), [profile] = active(profiles), [job] = assignment;
  const account = auth.users?.[0];
  const claims = JSON.parse(account?.customAttributes ?? '{}');
  requireCheck(active(identities).length === 1 && active(profiles).length === 1 && assignment.length === 1
    && docId(identity) === uid && scalar(identity, 'staffId') === staffId
    && !identity.fields?.revokedAt && !identity.fields?.submissionUploadGrants
    && docId(profile) === staffId && scalar(profile, 'deviceBoundAuthRequired') !== true
    && docId(job) === jobId && scalar(job, 'caseId') === caseId && scalar(job, 'assignedStaffId') === staffId
    && /^\d{4}-\d\d-\d\d$/.test(scalar(job, 'dateKey') ?? '') && scalar(job, 'revision') === 0
    && !job.fields?.mailIntake
    && !['sourceMissing', 'applicationUnconfirmed', 'assignmentUnresolved'].some(key => scalar(job, key) === true)
    && submissions.every(doc => scalar(doc, 'status') === 'completed' && docId(doc) !== submissionId)
    && scalar(drive, 'rootFolderId') === driveRoot && auth.users?.length === 1 && account?.localId === uid
    && !account.disabled && isDeepStrictEqual(claims, {companyId: company, staffId, role: 'staff', crewStagingCase: caseId}),
  'UPLOAD_ACCEPTANCE_FIXTURE_MISMATCH');
  for (const worker of [sheetWorker, retryWorker]) {
    if (!worker) continue;
    const env = worker.serviceConfig?.environmentVariables;
    requireCheck(worker.state === 'ACTIVE' && env?.APP_ENVIRONMENT === 'staging'
      && [undefined, 'paused'].includes(env.LKC_SHEET_WRITE_MODE), 'UPLOAD_ACCEPTANCE_SHEET_WORKER_NOT_PAUSED');
  }
}

function checkedImage(record, name, expected, options) {
  const image = uploadAcceptanceImage(record, name, expected, options);
  return options?.tuned ? normalizeLoadCapacity(image, name, expected) : image;
}

function images(pair, requirePaused = false, options) {
  return Object.fromEntries(scope.functions.map(name => [
    name, checkedImage(pair[name], name, requirePaused ? 'paused' : mode(pair[name]), options),
  ]));
}

async function verifyCompleted(api) {
  const parent = await api.doc('submissions/' + submissionId);
  if (scalar(parent, 'status') === 'error') throw Error('UPLOAD_ACCEPTANCE_TRANSFER_FAILED');
  if (scalar(parent, 'jobStatusApplied') !== true) return false;
  const [job, ...saved] = await Promise.all([
    api.doc('jobs/' + jobId), ...files.map(file => api.doc('submissions/' + submissionId + '/files/' + file.fileId)),
  ]);
  const report = job?.fields?.submissionStatus?.mapValue?.fields?.report?.mapValue?.fields;
  requireCheck(scalar(parent, 'companyId') === company && scalar(parent, 'uid') === uid
    && scalar(parent, 'staffId') === staffId && scalar(parent, 'jobId') === jobId
    && scalar(parent, 'type') === 'report' && scalar(parent, 'status') === 'completed'
    && scalar(parent, 'totalFiles') === files.length && scalar(parent, 'completedFiles') === files.length
    && report?.completed?.booleanValue === true
    && files.every((file, i) => scalar(saved[i], 'status') === 'completed'
      && scalar(saved[i], 'completionCounted') === true && issuedNonce(file, scalar(saved[i], 'storagePath'))
      && scalar(saved[i], 'contentSha256') === file.contentSha256 && typeof scalar(saved[i], 'verifiedUploadBytes') === 'string'
      && typeof scalar(saved[i], 'driveFileId') === 'string')
    && new Set(saved.map(doc => scalar(doc, 'driveFileId'))).size === files.length,
  'UPLOAD_ACCEPTANCE_COMPLETION_MISMATCH');
  return true;
}

export async function runWindow(api, {preflight, waitForReceipt, mark, report = console.log, tuned = false}) {
  const before = await api.readPair();
  const baseline = images(before, true, {tuned});
  await preflight(before);
  mark();
  let verified = false;
  try {
    // Finalizer first. The callable can start a receipt only after it is ready.
    for (const name of [...scope.functions].reverse()) {
      const fresh = await api.readPair();
      const observed = images(fresh, false, {tuned});
      for (const peer of scope.functions) assertUploadAcceptanceChange(baseline[peer], observed[peer], peer);
      requireCheck(mode(fresh[name]) === 'paused', 'UPLOAD_ACCEPTANCE_UNEXPECTED_LIVE_MODE');
      await api.update(name, fresh[name], 'acceptance');
    }
    const current = await api.readPair();
    for (const name of scope.functions) {
      assertUploadAcceptanceChange(baseline[name], checkedImage(current[name], name, 'acceptance', {tuned}), name);
    }
    await waitForReceipt();
    verified = true;
  } finally {
    await restorePaused(api, report, tuned);
    const after = images(await api.readPair(), true, {tuned});
    for (const name of scope.functions) assertUploadAcceptanceChange(baseline[name], after[name], name);
  }
  return verified;
}

export async function restorePaused(api, report = console.log, tuned = false) {
  // Stop the callable first. Re-read after an ambiguous provider reply and
  // consider only an ACTIVE, fully routed Function for any recovery write.
  const restoreImage = {requireHash: false, tuned};
  const readPair = () => api.readPair({verifyContent: false});
  for (const name of scope.functions) {
    try {
      const current = (await readPair())[name];
      uploadAcceptanceImage(current, name, mode(current), restoreImage);
      if (mode(current) === 'paused') {
        if (!tuned) continue;
        const {additions, mask} = loadCapacityPatch(current, name, 'paused');
        const currentConfig = current.fn.serviceConfig;
        if (!mask || Object.entries(additions).every(([key, value]) => currentConfig[key] === value)) continue;
      }
      await api.update(name, current, 'paused');
      uploadAcceptanceImage((await readPair())[name], name, 'paused', restoreImage);
    } catch (error) {
      report('UPLOAD_ACCEPTANCE_RESTORE_RECHECK=' + name + ':' + safeError(error));
    }
  }
  const current = await readPair();
  images(current, true, {requireHash: false});
  report('UPLOAD_ACCEPTANCE_BOTH_PAUSED=VERIFIED');
  const paused = images(current, true, restoreImage);
  if (tuned) report('UPLOAD_ACCEPTANCE_ORIGINAL_CAPACITY=VERIFIED');
  return paused;
}

async function main() {
  const env = process.env;
  const action = process.argv[2];
  const opening = validateContext(env, action);
  if (action === 'validate') return;
  const marker = env.RUNNER_TEMP + '/lkc-upload-acceptance-started';
  if (action === 'recover' && !existsSync(marker)) return;
  let token = '';
  for await (const chunk of process.stdin) {
    token += chunk;
    requireCheck(token.length <= 8192, 'UPLOAD_ACCEPTANCE_AUTH_INVALID');
  }
  token = token.trim();
  requireCheck(/^[a-zA-Z0-9_.-]{32,8192}$/.test(token), 'UPLOAD_ACCEPTANCE_AUTH_INVALID');
  const tuned = [tunedConfirmation, tunedRestoreConfirmation].includes(env.LKC_CONFIRMATION);
  const api = cloud(token, tuned);
  if (!opening || action === 'recover') {
    await restorePaused(api, console.log, tuned);
    return;
  }
  const expiry = env.LKC_ACCEPTANCE_EXPIRY;
  const isLoad = [loadConfirmation, tunedConfirmation].includes(env.LKC_CONFIRMATION);
  const ruleTemplate = isLoad ? deadline => loadRules(deadline, tuned) : rulesFor;
  await runWindow(api, {
    tuned,
    async preflight(before) {
      assertUploadRefreshBeforeImages(before, await api.readBucket());
      requireCheck(uploadExactEventFilterValue(before.finalizeStagedUpload.fn.eventTrigger?.eventFilters, 'bucket') === bucket,
      'UPLOAD_ACCEPTANCE_SOURCE_OR_BUCKET_NOT_APPROVED');
      requireCheck(Date.parse(expiry) - Date.now() >= (isLoad ? 22 : 9) * 60_000, 'UPLOAD_ACCEPTANCE_EXPIRY_TOO_SOON');
      await Promise.all([verifyRules(api, expiry, ruleTemplate), isLoad ? verifyLoadFixture(api, tuned) : verifyFixture(api)]);
    },
    async waitForReceipt() {
      await verifyRules(api, expiry, ruleTemplate);
      const deadline = Math.min(Date.now() + maxWindow, Date.parse(expiry) - 30_000);
      console.log('UPLOAD_ACCEPTANCE_WINDOW=READY');
      if (isLoad) return waitForLoad(api, expiry, tuned);
      while (Date.now() < deadline) {
        if (await verifyCompleted(api)) return;
        await delay(3000);
      }
      throw Error('UPLOAD_ACCEPTANCE_RECEIPT_TIMEOUT');
    },
    mark() { writeFileSync(marker, 'started\n', {mode: 0o600, flag: 'wx'}); },
  });
  console.log(isLoad ? 'UPLOAD_ACCEPTANCE_LOAD_450=PASS' : 'UPLOAD_ACCEPTANCE_ONE_CASE=PASS');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
}
