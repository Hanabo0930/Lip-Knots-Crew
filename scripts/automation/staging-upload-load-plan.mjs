import {createHash} from 'node:crypto';
import {bucket, company, files, project, issuedNonce} from './staging-upload-acceptance-manifest.mjs';

export const loadConfirmation = 'TEST_LKC_STAGING_UPLOAD_LOAD_50_100_300';
export const tunedConfirmation = 'TEST_LKC_STAGING_UPLOAD_LOAD_TUNED_50_100_300';
export const tunedRestoreConfirmation = 'RESTORE_LKC_STAGING_TUNED_UPLOAD_PAUSED';
export const loadId = 'CREW-STAGING-LOAD-20261117';
export const tunedLoadId = loadId + '-B';
export const phases = Object.freeze([50, 100, 300]);
export const loadWindowMs = 12 * 60_000;
export const progressPath = 'companies/' + company + '/settings/' + loadId;
export const tunedProgressPath = 'companies/' + company + '/settings/' + tunedLoadId;
export const sample = files[0];
export const database = 'projects/' + project + '/databases/(default)/documents';
const hash = value => createHash('sha256').update(value).digest('hex');
function requestId(run, index, phase) {
  const value = hash(JSON.stringify([run, index, phase]));
  return value.slice(0, 8) + '-' + value.slice(8, 12) + '-4' + value.slice(13, 16)
    + '-8' + value.slice(17, 20) + '-' + value.slice(20, 32);
}
function createClients(run, suffix) {
  return Object.freeze(Array.from({length: phases.at(-1)}, (_, index) => {
  const number = String(index + 1).padStart(3, '0');
  const uid = 'crew-staging-load-20261117-' + number;
  const staffId = uid + suffix + '-profile';
  const jobId = uid + suffix + '-job';
  const claims = {companyId: company, staffId, role: 'staff', crewLoadRun: run};
  const plans = {};
  for (const [slot, count] of phases.entries()) {
    if (index >= count) continue;
    const clientRequestId = requestId(run, index, count);
    const submissionId = 'submission_' + hash(JSON.stringify([company, staffId, uid, clientRequestId]));
    const fileId = 'file_' + hash(submissionId + '|0').slice(0, 32);
    claims['crewLoadS' + slot] = submissionId;
    claims['crewLoadF' + slot] = fileId;
    plans[count] = Object.freeze({uid, staffId, jobId, clientRequestId, submissionId, fileId,
      originalName: 'synthetic-active-load.png',
      pathPrefix: ['staging', company, uid, submissionId, fileId, ''].join('/')});
  }
  return Object.freeze({number, uid, staffId, jobId, email: uid + '@example.invalid',
    claims: Object.freeze(claims), plans: Object.freeze(plans)});
  }));
}
export const clients = createClients(loadId, '');
export const tunedClients = createClients(tunedLoadId, '-b');

export function phasePlan(phase, tuned = false) {
  if (!phases.includes(phase)) throw Error('UPLOAD_ACCEPTANCE_LOAD_PHASE_INVALID');
  return (tuned === true ? tunedClients : clients).slice(0, phase).map(client => client.plans[phase]);
}

export function loadRules(expiry, tuned = false) {
  const time = Date.parse(expiry);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(expiry) || !Number.isFinite(time)
    || new Date(time).toISOString() !== expiry) throw Error('UPLOAD_ACCEPTANCE_EXPIRY_INVALID');
  const slots = phases.map((_, i) => 'slot("crewLoadS' + i + '", "crewLoadF' + i + '")').join(' || ');
  return [
    "rules_version = '2';", "service firebase.storage {", "  match /b/{bucket}/o {",
    "    match /staging/{companyId}/{uid}/{submissionId}/{fileId}/{fileName} {",
    "      function slot(submissionClaim, fileClaim) {",
    "        return submissionClaim in request.auth.token && fileClaim in request.auth.token",
    "          && request.auth.token[submissionClaim] == submissionId && request.auth.token[fileClaim] == fileId;",
    "      }",
    '      allow create: if bucket == ' + JSON.stringify(bucket) + ' && companyId == ' + JSON.stringify(company),
    '        && request.time < timestamp.value(' + time + ') && request.auth != null && request.auth.uid == uid',
    '        && uid.matches("crew-staging-load-20261117-(00[1-9]|0[1-9][0-9]|[12][0-9]{2}|300)")',
    '        && request.auth.token.role == "staff" && request.auth.token.companyId == companyId',
    '        && request.auth.token.staffId == uid + ' + JSON.stringify(tuned ? '-b-profile' : '-profile')
      + ' && request.auth.token.crewLoadRun == ' + JSON.stringify(tuned ? tunedLoadId : loadId),
    '        && fileName.matches("[a-f0-9]{32}-synthetic-active-load[.]png") && (' + slots + ')',
    '        && request.resource.size == ' + sample.size + ' && request.resource.contentType == ' + JSON.stringify(sample.contentType),
    '        && request.resource.metadata.lkcContentSha256 == ' + JSON.stringify(sample.contentSha256) + ';',
    '    }', '  }', '}', '',
  ].join('\n');
}

export function scalar(doc, key) {
  const field = doc?.fields?.[key];
  return field?.stringValue ?? field?.booleanValue ?? (field?.integerValue === undefined ? undefined : Number(field.integerValue));
}

export async function getStageDocuments(api, paths) {
  if (new Set(paths).size !== paths.length || paths.length > 1400) throw Error('UPLOAD_ACCEPTANCE_LOAD_READ_SCOPE');
  const docs = new Map();
  for (let from = 0; from < paths.length; from += 80) {
    const requested = paths.slice(from, from + 80).map(path => database + '/' + path);
    const result = await api('https://firestore.googleapis.com/v1/' + database + ':batchGet',
      {method: 'POST', body: {documents: requested}});
    for (const row of result) {
      const ref = row.found?.name ?? row.missing;
      if (!requested.includes(ref) || docs.has(ref.slice(database.length + 1))) throw Error('UPLOAD_ACCEPTANCE_LOAD_READ_SCOPE');
      docs.set(ref.slice(database.length + 1), row.found ?? null);
    }
  }
  if (docs.size !== paths.length) throw Error('UPLOAD_ACCEPTANCE_LOAD_READ_COUNT');
  return docs;
}

export function submissionPaths(plans, withFiles) {
  return plans.flatMap(plan => {
    const parent = 'submissions/' + plan.submissionId;
    return withFiles ? [parent, parent + '/files/' + plan.fileId] : [parent];
  });
}

export function completePlan(plan, parent, file) {
  return scalar(parent, 'companyId') === company && scalar(parent, 'jobId') === plan.jobId
    && scalar(parent, 'staffId') === plan.staffId && scalar(parent, 'uid') === plan.uid
    && scalar(parent, 'type') === 'report' && scalar(parent, 'status') === 'completed'
    && scalar(parent, 'totalFiles') === 1 && scalar(parent, 'completedFiles') === 1
    && scalar(parent, 'jobStatusApplied') === true && scalar(file, 'completionCounted') === true
    && scalar(file, 'status') === 'completed' && typeof scalar(file, 'verifiedUploadBytes') === 'string'
    && scalar(file, 'contentSha256') === sample.contentSha256
    && Boolean(issuedNonce(plan, scalar(file, 'storagePath')))
    && /^[a-zA-Z0-9_-]{8,}$/.test(scalar(file, 'driveFileId') ?? '');
}

export function assertCompletedWave(plans, docs, seenDriveIds = new Set()) {
  for (const plan of plans) {
    const parent = 'submissions/' + plan.submissionId;
    const file = docs.get(parent + '/files/' + plan.fileId);
    const driveId = scalar(file, 'driveFileId');
    if (!completePlan(plan, docs.get(parent), file) || seenDriveIds.has(driveId)) {
      throw Error('UPLOAD_ACCEPTANCE_LOAD_COMPLETION_MISMATCH');
    }
    seenDriveIds.add(driveId);
  }
  return seenDriveIds;
}
