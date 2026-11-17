import test from 'node:test';
import assert from 'node:assert/strict';
import {clients, phases, phasePlan, loadRules, assertCompletedWave, submissionPaths} from './staging-upload-load-plan.mjs';
import {company, files} from './staging-upload-acceptance-manifest.mjs';

test('STAGING active transfer load has separate accounts and a fixed receipt for every wave', () => {
  assert.equal(clients.length, 300);
  const rows = phases.flatMap(phasePlan);
  assert.deepEqual(phases.map(count => phasePlan(count).length), [50, 100, 300]);
  assert.equal(new Set(rows.map(row => row.submissionId)).size, 450);
  assert.equal(new Set(rows.map(row => row.fileId)).size, 450);
  assert.equal(new Set(rows.map(row => row.uid)).size, 300);
  assert.equal(new Set(clients.map(client => client.jobId)).size, 300);
  assert.equal(submissionPaths(rows, true).length, 900);
  assert.ok(clients.every(client => JSON.stringify(client.claims).length < 1000
    && client.email.endsWith('@example.invalid')));
  assert.throws(() => phasePlan(301), /LOAD_PHASE_INVALID/);
});

test('STAGING load Rules bind creates to signed-in run, receipt, file and expiry', () => {
  const good = loadRules('2026-11-17T14:00:00.000Z');
  assert.equal((good.match(/allow /g) ?? []).length, 1);
  for (const marker of ['allow create', 'request.auth.uid == uid', 'crewLoadRun', 'crewLoadS2',
    'crewLoadF2', 'request.resource.metadata.lkcContentSha256', 'timestamp.value']) assert.ok(good.includes(marker));
  assert.throws(() => loadRules('2026-02-31T14:00:00.000Z'), /EXPIRY_INVALID/);
});

const firestore = fields => ({fields: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name,
  typeof value === 'boolean' ? {booleanValue: value} : typeof value === 'number' ? {integerValue: String(value)}
    : {stringValue: value}]))});
function complete(plan, i) {
  return [
    firestore({companyId: company, jobId: plan.jobId, staffId: plan.staffId, uid: plan.uid, type: 'report',
      status: 'completed', totalFiles: 1, completedFiles: 1, jobStatusApplied: true}),
    firestore({completionCounted: true, status: 'completed', verifiedUploadBytes: 'fixture-proof',
      contentSha256: files[0].contentSha256, storagePath: plan.pathPrefix + '0'.repeat(32) + '-' + plan.originalName,
      driveFileId: 'drive-fixture-file-' + i}),
  ];
}
test('only independently verified transfers count and duplicate Drive IDs stop the load', () => {
  const plans = phasePlan(50);
  const docs = new Map(submissionPaths(plans, true).map((path, i) => [path, complete(plans[i >> 1], i >> 1)[i % 2]]));
  assert.equal(assertCompletedWave(plans, docs).size, 50);
  docs.get(submissionPaths(plans, true)[3]).fields.driveFileId = {stringValue: 'drive-fixture-file-0'};
  assert.throws(() => assertCompletedWave(plans, docs), /COMPLETION_MISMATCH/);
});
