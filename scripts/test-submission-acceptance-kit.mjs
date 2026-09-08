import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createSubmissionAcceptanceKit, evaluateSubmissionAcceptanceEvidence, STAGING_DRIVE_PARENT } from './submission-acceptance-kit.mjs';
const now = Date.parse('2026-09-09T00:00:00Z');
const kit = createSubmissionAcceptanceKit({ driveRootId: 'synthetic-isolated-root' });
assert.equal(kit.seedDocuments.length, 8); assert.equal(kit.absencePaths.length, 12);
assert.ok(kit.seedDocuments.every(doc => doc.precondition.exists === false));
assert.equal(kit.seedDocuments.find(doc => doc.path.startsWith('jobs/')).data.sheetRef, undefined);
assert.ok(kit.files.every(file => file.size === Buffer.byteLength(file.content) && file.size <= 1024 && file.storagePath.startsWith(kit.storagePrefix)));
const counts = Object.fromEntries(['notificationQueue', 'pushTokens', 'sheetSyncQueue', 'jobs', 'staffProfiles', 'submissions'].map(collection => [collection, { companyId: kit.companyId, count: 0 }]));
const evidence = { project: kit.project, kitFingerprint: kit.fingerprint, readAt: new Date(now).toISOString(), drive: { parentId: STAGING_DRIVE_PARENT, rootName: kit.companyId, rootFolderId: kit.drive.rootFolderId, runtimeCanAddChildren: true, runtimeIdentity: '740154137290-compute@developer.gserviceaccount.com' }, storage: { bucket: kit.storageBucket, prefix: kit.storagePrefix, empty: true }, documents: kit.absencePaths.map(path => ({ path, exists: false })), counts };
let cases = 1;
const ready = evaluateSubmissionAcceptanceEvidence(kit, evidence, now);assert.equal(ready.preflightChecksPassed, true);assert.equal(ready.cloudExecutionAuthorized, false);
for (const mutate of [e=>e.project='other',e=>e.kitFingerprint='other',e=>e.readAt='invalid',e=>e.readAt=new Date(now+1).toISOString(),e=>e.readAt=new Date(now-600001).toISOString(),e=>e.drive.parentId='other',e=>e.drive.rootName='other',e=>e.drive.rootFolderId='other',e=>e.drive.runtimeCanAddChildren=false,e=>e.drive.runtimeIdentity='operator',e=>e.storage.empty=false,e=>e.storage.bucket='other',e=>e.storage.prefix='staging/',e=>e.documents[0]=null,e=>e.documents.pop(),e=>e.documents[0].exists=true,e=>e.documents[1]=e.documents[0],...Object.keys(counts).flatMap(key=>[e=>e.counts[key].count=1,e=>e.counts[key].companyId='other'])]) {
 const changed=structuredClone(evidence);mutate(changed);assert.equal(evaluateSubmissionAcceptanceEvidence(kit,changed,now).preflightChecksPassed,false);cases++;
}
for(const id of [STAGING_DRIVE_PARENT,'../escape','short','root/child',12345678901234567]){assert.throws(()=>createSubmissionAcceptanceKit({driveRootId:id}));cases++;}
const changed=structuredClone(kit);changed.seedDocuments[0].precondition.exists=true;assert.throws(()=>evaluateSubmissionAcceptanceEvidence(changed,evidence,now));cases++;
assert.equal(evaluateSubmissionAcceptanceEvidence(createSubmissionAcceptanceKit(),null,now).preflightChecksPassed,false);cases++;
assert.equal(evaluateSubmissionAcceptanceEvidence(kit,evidence,NaN).preflightChecksPassed,false);cases++;

const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(),'lkc-acceptance-test-')), 'kit');
const command = fileURLToPath(new URL('./prepare-submission-acceptance-kit.mjs', import.meta.url));
assert.equal(spawnSync(process.execPath,[command,'--output',output],{encoding:'utf8'}).status,0);cases++;
const manifestBefore = fs.readFileSync(path.join(output,'kit.json'),'utf8');
const prepared=JSON.parse(manifestBefore);assert.deepEqual(prepared,createSubmissionAcceptanceKit());
for(const file of prepared.files)assert.equal(fs.readFileSync(path.join(output,file.originalName),'utf8'),file.content);
assert.notEqual(spawnSync(process.execPath,[command,'--output',output],{encoding:'utf8'}).status,0);assert.equal(fs.readFileSync(path.join(output,'kit.json'),'utf8'),manifestBefore);cases++;
assert.notEqual(spawnSync(process.execPath,[command,'--apply'],{encoding:'utf8'}).status,0);cases++;

console.log(JSON.stringify({cases,passed:true,cloudChanges:false}));
