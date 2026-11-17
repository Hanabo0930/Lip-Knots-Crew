import {existsSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {validatePlan} from './validate-staging-scope.mjs';
import {authenticatedUploadRefreshAPI, uploadRefreshReader} from './run-upload-source-refresh.mjs';
import {UPLOAD_REFRESH_SCOPE as scope, assertUploadRefreshBeforeImages, assertUploadAcceptanceChange,
  uploadAcceptanceImage, uploadExactEventFilterValue} from './upload-source-refresh-contract.mjs';
import {project, bucket, company, caseId, uid, staffId, jobId, driveRoot, submissionId, files,
  ruleFilename, rulesFor, modeVariable, sourceGenerations} from './staging-upload-acceptance-manifest.mjs';

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
  requireCheck(opening ? env.LKC_CONFIRMATION === 'TEST_LKC_STAGING_ONE_SYNTHETIC_UPLOAD_CASE'
    : env.LKC_TRANSFER_MODE_REQUESTED === 'paused' && !env.LKC_ACCEPTANCE_EXPIRY
      && env.LKC_CONFIRMATION === 'RESTORE_LKC_STAGING_UPLOAD_PAUSED',
    'UPLOAD_ACCEPTANCE_CONFIRMATION_REJECTED');
  if (opening) rulesFor(env.LKC_ACCEPTANCE_EXPIRY);
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

function cloud(token) {
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
  async function update(name, before, next) {
    requireCheck(scope.functions.includes(name) && ['acceptance', 'paused'].includes(next), 'UPLOAD_ACCEPTANCE_PATCH_SCOPE_REJECTED');
    const target = functionRef(name);
    // No source object, build config, trigger or IAM is included in this write.
    const body = {name: target, serviceConfig: {environmentVariables: {
      ...before.fn.serviceConfig.environmentVariables, [modeVariable]: next,
    }}};
    let operation = await json(functionsAPI + target + '?updateMask=serviceConfig.environmentVariables', {method: 'PATCH', body});
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
  return {...reader, json, update, doc: path => json(firestore + '/' + path, {absent: true})};
}

async function companyRows(api, collection) {
  const found = await api.json(firestore + ':runQuery', {method: 'POST', body: {structuredQuery: {
    from: [{collectionId: collection}], where: {fieldFilter: {field: {fieldPath: 'companyId'},
      op: 'EQUAL', value: {stringValue: company}}}, limit: 16,
  }}});
  const rows = found.flatMap(row => row.document ? [row.document] : []);
  requireCheck(rows.length < 16, 'UPLOAD_ACCEPTANCE_FIXTURE_QUERY_LIMIT');
  return rows;
}

async function verifyRules(api, expiry) {
  const expected = rulesFor(expiry);
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

function images(pair, requirePaused = false) {
  return Object.fromEntries(scope.functions.map(name => [
    name, uploadAcceptanceImage(pair[name], name, requirePaused ? 'paused' : mode(pair[name])),
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
      && scalar(saved[i], 'completionCounted') === true && scalar(saved[i], 'storagePath') === file.storagePath
      && scalar(saved[i], 'contentSha256') === file.contentSha256 && typeof scalar(saved[i], 'verifiedUploadBytes') === 'string'
      && typeof scalar(saved[i], 'driveFileId') === 'string')
    && new Set(saved.map(doc => scalar(doc, 'driveFileId'))).size === files.length,
  'UPLOAD_ACCEPTANCE_COMPLETION_MISMATCH');
  return true;
}

export async function runWindow(api, {preflight, waitForReceipt, mark, report = console.log}) {
  const before = await api.readPair();
  const baseline = images(before, true);
  await preflight(before);
  mark();
  let verified = false;
  try {
    // Finalizer first. The callable can start a receipt only after it is ready.
    for (const name of [...scope.functions].reverse()) {
      const fresh = await api.readPair();
      const observed = images(fresh);
      for (const peer of scope.functions) assertUploadAcceptanceChange(baseline[peer], observed[peer], peer);
      requireCheck(mode(fresh[name]) === 'paused', 'UPLOAD_ACCEPTANCE_UNEXPECTED_LIVE_MODE');
      await api.update(name, fresh[name], 'acceptance');
    }
    const current = await api.readPair();
    for (const name of scope.functions) {
      assertUploadAcceptanceChange(baseline[name], uploadAcceptanceImage(current[name], name, 'acceptance'), name);
    }
    await waitForReceipt();
    verified = true;
  } finally {
    const after = await restorePaused(api, report);
    for (const name of scope.functions) assertUploadAcceptanceChange(baseline[name], after[name], name);
  }
  return verified;
}

export async function restorePaused(api, report = console.log) {
  // Stop the callable first. Re-read after an ambiguous provider reply and
  // consider only an ACTIVE, fully routed Function for any recovery write.
  for (const name of scope.functions) {
    try {
      const current = (await api.readPair())[name];
      const prior = uploadAcceptanceImage(current, name, mode(current));
      if (mode(current) === 'paused') continue;
      await api.update(name, current, 'paused');
      const observed = (await api.readPair())[name];
      assertUploadAcceptanceChange(prior, uploadAcceptanceImage(observed, name, 'paused'), name);
    } catch (error) {
      report('UPLOAD_ACCEPTANCE_RESTORE_RECHECK=' + name + ':' + safeError(error));
    }
  }
  const paused = images(await api.readPair(), true);
  report('UPLOAD_ACCEPTANCE_BOTH_PAUSED=VERIFIED');
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
  const api = cloud(token);
  if (!opening || action === 'recover') {
    await restorePaused(api);
    return;
  }
  const expiry = env.LKC_ACCEPTANCE_EXPIRY;
  await runWindow(api, {
    async preflight(before) {
      assertUploadRefreshBeforeImages(before, await api.readBucket());
      requireCheck(scope.functions.every(name => before[name].fn.buildConfig.sourceProvenance.resolvedStorageSource.generation
        === sourceGenerations[name]) && uploadExactEventFilterValue(before.finalizeStagedUpload.fn.eventTrigger?.eventFilters, 'bucket') === bucket,
      'UPLOAD_ACCEPTANCE_SOURCE_OR_BUCKET_NOT_APPROVED');
      requireCheck(Date.parse(expiry) - Date.now() >= 9 * 60_000, 'UPLOAD_ACCEPTANCE_EXPIRY_TOO_SOON');
      await Promise.all([verifyRules(api, expiry), verifyFixture(api)]);
    },
    async waitForReceipt() {
      await verifyRules(api, expiry);
      const deadline = Math.min(Date.now() + maxWindow, Date.parse(expiry) - 30_000);
      console.log('UPLOAD_ACCEPTANCE_WINDOW=READY');
      while (Date.now() < deadline) {
        if (await verifyCompleted(api)) return;
        await delay(3000);
      }
      throw Error('UPLOAD_ACCEPTANCE_RECEIPT_TIMEOUT');
    },
    mark() { writeFileSync(marker, 'started\n', {mode: 0o600, flag: 'wx'}); },
  });
  console.log('UPLOAD_ACCEPTANCE_ONE_CASE=PASS');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
}
