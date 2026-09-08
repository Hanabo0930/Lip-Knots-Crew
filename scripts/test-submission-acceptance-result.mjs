import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createSubmissionAcceptanceKit } from './submission-acceptance-kit.mjs';
import { verifySubmissionAcceptanceResult } from './submission-acceptance-result.mjs';

const now = Date.now();
const at = delta => new Date(now + delta).toISOString();
const kit = createSubmissionAcceptanceKit({ driveRootId: 'synthetic-dedicated-root' });
const result = {
  project: kit.project, kitFingerprint: kit.fingerprint, startedAt: at(-3000), readAt: at(-500), listingsComplete: true,
  documents: kit.seedDocuments.map(item => ({ path: item.path, data: structuredClone(item.data) })),
  drive: { folders: [
    { id: kit.drive.rootFolderId, name: kit.companyId, parents: [kit.drive.parentId] },
    { id: 'synthetic-client', name: kit.drive.childFolders[0], parents: [kit.drive.rootFolderId] },
    { id: 'synthetic-month', name: kit.drive.childFolders[1], parents: ['synthetic-client'] },
  ].map(item => ({ ...item, mimeType: 'application/vnd.google-apps.folder', trashed: false })), files: [] },
  storage: [], counts: Object.fromEntries(['notificationQueue', 'pushTokens'].map(name => [name, { companyId: kit.companyId, count: 0 }])),
};
const doc = (r, path) => r.documents.find(item => item.path === path).data;
const submissionPath = `submissions/${kit.submissionId}`;
const filePath = index => `${submissionPath}/files/${kit.files[index].fileId}`;
for (const [index, fixture] of kit.files.entries()) {
  const sequence = index + 1, completedAt = at(-2000 + index * 1000);
  const source = { bucket: kit.storageBucket, path: fixture.storagePath, generation: String(100 + index), size: String(fixture.size), contentType: fixture.contentType, md5: Buffer.from(fixture.md5Base64, 'base64').toString('hex') };
  const sourceKey = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  const plan = { id: `synthetic-drive-file-${index}`, name: `synthetic-${index}.txt`, parentId: 'synthetic-month', sourceKey, sequence };
  Object.assign(doc(result, filePath(index)), { status: 'completed', completionCounted: true, driveTransferPlan: plan, driveFileId: plan.id, driveName: plan.name, sequence, transferCompletedAt: completedAt, completedAt });
  result.drive.files.push({ id: plan.id, name: plan.name, parents: [plan.parentId], size: source.size, mimeType: source.contentType, md5Checksum: source.md5, appProperties: { lkcTransfer: sourceKey }, trashed: false, createdTime: completedAt });
  result.storage.push({ bucket: source.bucket, path: source.path, generation: source.generation, size: source.size, contentType: source.contentType, md5Base64: fixture.md5Base64, exists: false });
}
Object.assign(doc(result, submissionPath), { status: 'completed', completedFiles: 2, jobStatusApplied: true, completedAt: at(-1000) });
doc(result, `jobs/${kit.jobId}`).submissionStatus = { report: { completed: true, lipKnotsSubmitted: true, lateFirstSubmission: true, firstCompletedAt: at(-1000), latestCompletedAt: at(-1000) } };
result.documents.push({ path: kit.indirectWrites.counterPath, data: { value: 2 } }, { path: 'sheetSyncQueue/synthetic-queue', data: { companyId: kit.companyId, jobId: kit.jobId, operation: 'submission.report', updates: { reportSubmitted: '遅延' }, status: 'blocked', errorType: 'blocked', errorMessage: '安全書込がまだ有効化されていません。', attempts: 1, retryAt: null, idempotencyKey: `submission:report:${kit.jobId}:${now - 1000}`, createdAt: at(-1000) } });
const before = JSON.stringify(result);
const valid = verifySubmissionAcceptanceResult(kit, result, now);
assert.deepEqual(valid.issues, []); assert.equal(valid.passed, true); assert.equal(valid.actualCloudAcceptanceVerified, false); assert.equal(valid.cloudExecutionAuthorized, false);
assert.equal(JSON.stringify(result), before);
const queue = r => doc(r, 'sheetSyncQueue/synthetic-queue');
const mutations = [
  ['project', r => r.project = 'other'], ['fingerprint', r => r.kitFingerprint = 'old'],
  ['stale', r => r.readAt = at(-600001)], ['future', r => r.readAt = at(1)], ['reversed-time', r => r.startedAt = at(0)], ['invalid-time', r => r.startedAt = 'invalid'],
  ['missing-document', r => r.documents.pop()], ['extra-document', r => r.documents.push({ path: 'jobs/unexpected', data: {} })], ['null-document', r => r.documents[0] = null], ['duplicate-document', r => r.documents[1] = r.documents[0]],
  ['mapping-enabled', r => doc(r, `companies/${kit.companyId}/sheetMappings/shift`).enabled = true], ['notifications-enabled', r => doc(r, `notificationSettings/${kit.companyId}`).enabled = true],
  ['wrong-company', r => doc(r, submissionPath).companyId = 'other'], ['job-reassigned', r => doc(r, `jobs/${kit.jobId}`).assignedStaffId = 'other'], ['sheet-reference', r => doc(r, `jobs/${kit.jobId}`).sheetRef = {}],
  ['partial-submission', r => doc(r, submissionPath).completedFiles = 1], ['double-count', r => doc(r, kit.indirectWrites.counterPath).value = 3], ['job-not-applied', r => doc(r, submissionPath).jobStatusApplied = false],
  ['stale-error', r => doc(r, submissionPath).errorMessage = 'failed'], ['uncounted-file', r => doc(r, filePath(0)).completionCounted = false], ['wrong-file-job', r => doc(r, filePath(0)).jobId = 'other'],
  ['missing-plan', r => delete doc(r, filePath(0)).driveTransferPlan], ['wrong-generation', r => r.storage[0].generation = '999'], ['unsafe-generation', r => r.storage[0].generation = 100], ['source-left', r => r.storage[0].exists = true],
  ['duplicate-source', r => r.storage[1] = r.storage[0]], ['extra-source', r => r.storage.push(r.storage[0])], ['wrong-bucket', r => r.storage[0].bucket = 'other'],
  ['double-drive-file', r => r.drive.files.push(r.drive.files[0])], ['duplicate-drive-id', r => r.drive.files[1].id = r.drive.files[0].id], ['wrong-content', r => r.drive.files[0].md5Checksum = 'wrong'], ['wrong-size', r => r.drive.files[0].size = '1'], ['trashed-file', r => r.drive.files[0].trashed = true], ['wrong-drive-parent', r => r.drive.files[0].parents = ['outside']], ['wrong-marker', r => r.drive.files[0].appProperties.lkcTransfer = 'wrong'],
  ['wrong-root', r => r.drive.folders[0].parents = ['other']], ['extra-folder', r => r.drive.folders.push(r.drive.folders[0])], ['trashed-folder', r => r.drive.folders[1].trashed = true], ['missing-folder', r => r.drive.folders.pop()],
  ['repeated-sequence', r => { const f = doc(r, filePath(1)); f.sequence = 1; f.driveTransferPlan.sequence = 1; }], ['old-completion', r => doc(r, filePath(0)).completedAt = at(-4000)], ['wrong-final-time', r => doc(r, submissionPath).completedAt = at(-2000)],
  ['queue-pending', r => queue(r).status = 'pending'], ['queue-other-company', r => queue(r).companyId = 'other'], ['queue-wrong-block', r => queue(r).errorMessage = '会社情報が一致しません。'], ['queue-retry', r => queue(r).retryAt = at(1000)], ['queue-wrong-operation', r => queue(r).operation = 'other'], ['queue-duplicate', r => r.documents.push({ path: 'sheetSyncQueue/other', data: structuredClone(queue(r)) })],
  ['notification-created', r => r.counts.notificationQueue.count = 1], ['foreign-count', r => r.counts.pushTokens.companyId = 'other'], ['incomplete-list', r => r.listingsComplete = false],
];
for (const [name, mutate] of mutations) {
  const changed = structuredClone(result); mutate(changed);
  assert.equal(verifySubmissionAcceptanceResult(kit, changed, now).passed, false, name);
}
for (const value of [null, {}, { documents: [null], drive: { files: [null], folders: [null] }, storage: [null] }]) assert.equal(verifySubmissionAcceptanceResult(kit, value, now).passed, false);
assert.equal(verifySubmissionAcceptanceResult(kit, result, NaN).passed, false);
const altered = structuredClone(kit); altered.checks.counterValue = 3;
assert.throws(() => verifySubmissionAcceptanceResult(altered, result, now));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lkc-result-verifier-'));
const kitFile = path.join(temporary, 'kit.json'), resultFile = path.join(temporary, 'result.json');
fs.writeFileSync(kitFile, JSON.stringify(kit)); fs.writeFileSync(resultFile, JSON.stringify(result));
const command = fileURLToPath(new URL('./verify-submission-acceptance-result.mjs', import.meta.url));
const invoke = () => spawnSync(process.execPath, [command, '--kit', kitFile, '--result', resultFile], { encoding: 'utf8' });
assert.equal(invoke().status, 0);
const invalid = structuredClone(result); invalid.storage[0].exists = true; fs.writeFileSync(resultFile, JSON.stringify(invalid));
const failure = invoke(); assert.equal(failure.status, 1); assert.equal(JSON.parse(failure.stdout).passed, false);
assert.notEqual(spawnSync(process.execPath, [command, '--apply'], { encoding: 'utf8' }).status, 0);
console.log(JSON.stringify({ cases: 1 + mutations.length + 3 + 1 + 1 + 3, passed: true, cloudChanges: false }));
