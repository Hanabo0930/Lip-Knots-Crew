import {createHash} from 'node:crypto';

export const project = 'lip-knots-crew-staging';
export const bucket = project + '.firebasestorage.app';
export const company = 'lkc-transfer-acceptance-20260908';
export const caseId = 'CREW-STAGING-20261116-01';
export const uid = 'crew-staging-20261116-01-staff';
export const staffId = uid + '-profile';
export const jobId = 'crew-staging-20261116-01-job';
export const driveRoot = '1UIrK62YaXUDtK8H2rvJcZV5nkej30vk0';
export const clientRequestId = '3fe324a0-72d8-4468-914b-793661160001';
export const ruleFilename = 'storage.rules';
export const modeVariable = 'LKC_SUBMISSION_TRANSFER_MODE';
// The protected source refresh verified this same ZIP for both functions.
export const sourceArchiveSha256 = '770c19665eeeab2956176b73e7ff17cf8608458dd60d8603f68cbb60385089fa';
export const sourceArchiveBytes = 1894962;

const sha = value => createHash('sha256').update(value).digest('hex');
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7YQAAAAASUVORK5CYII=';
export const submissionId = 'submission_' + sha(JSON.stringify([company, staffId, uid, clientRequestId]));
export const files = Object.freeze(['synthetic-report-1.png', 'synthetic-report-2.png'].map((originalName, index) => {
  const bytes = Buffer.from(image, 'base64');
  const fileId = 'file_' + sha(submissionId + '|' + index).slice(0, 32);
  return Object.freeze({originalName, contentType: 'image/png', size: bytes.length, contentSha256: sha(bytes),
    fileId, storagePath: ['staging', company, uid, submissionId, fileId, originalName].join('/'), data: image});
}));

export function rulesFor(expiry) {
  const valid = typeof expiry === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(expiry)
    && Number.isFinite(Date.parse(expiry)) && new Date(expiry).toISOString() === expiry;
  if (!valid) throw Error('UPLOAD_ACCEPTANCE_EXPIRY_INVALID');
  const matches = files.map(file => [
    '(objectPath == ' + JSON.stringify(file.storagePath),
    ' && request.resource.size == ' + file.size,
    ' && request.resource.contentType == ' + JSON.stringify(file.contentType),
    ' && request.resource.metadata.lkcContentSha256 == ' + JSON.stringify(file.contentSha256) + ')',
  ].join('')).join(' ||\n          ');
  return [
    "rules_version = '2';",
    'service firebase.storage {',
    '  match /b/{bucket}/o {',
    '    match /staging/{companyId}/{uid}/{submissionId}/{fileId}/{fileName} {',
    '      function exactFile() {',
    '        let objectPath = "staging/" + companyId + "/" + uid + "/" + submissionId + "/" + fileId + "/" + fileName;',
    '        return ' + matches + ';',
    '      }',
    '      allow create: if bucket == ' + JSON.stringify(bucket),
    '        && request.time < timestamp.value(' + Date.parse(expiry) + ')',
    '        && request.auth != null && request.auth.uid == ' + JSON.stringify(uid),
    '        && request.auth.token.companyId == ' + JSON.stringify(company),
    '        && request.auth.token.role == "staff" && request.auth.token.staffId == ' + JSON.stringify(staffId),
    '        && request.auth.token.crewStagingCase == ' + JSON.stringify(caseId),
    '        && exactFile();',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}
