import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
const read=rel=>fs.readFileSync(new URL('../../'+rel,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const guard=read('scripts/automation/check-function-auth-guards.mjs').replace(/^import .*;\n/gm,'');
const source={
 'functions/src/uploads.ts':read('functions/src/uploads.ts'),
 'functions/src/submission-transfer-control.ts':read('functions/src/submission-transfer-control.ts'),
};
function run(change,name='finalizeStagedUpload'){
 const files={...source};change?.(files);const lines=[];
 const process={argv:['node','guard','--functions',name,'--require-pass'],exitCode:0,exit:code=>{throw Error('unexpected exit '+code);}};
 runInNewContext(guard,{process,console:{log:text=>lines.push(text),error:text=>lines.push(text)},
  execFileSync:(cmd,args)=>{assert.equal(cmd,'git');assert.equal(args[0],'show');const name=args[1].slice(args[1].indexOf(':')+1);assert.ok(Object.hasOwn(files,name));return files[name];}},{timeout:3000});
 return {passed:lines.includes('SOURCE_GUARD_STATUS=PASS'),exitCode:process.exitCode};
}
assert.equal(run().passed,true);
let passed=1;
for(const change of [
 files=>files['functions/src/submission-transfer-control.ts']=files['functions/src/submission-transfer-control.ts'].replace('return !(await getProductionOperationalState(companyId)).operational;','return false;'),
 files=>files['functions/src/submission-transfer-control.ts']=files['functions/src/submission-transfer-control.ts'].replace('if (mode !== "active" && !acceptanceOnly) return true;','if (mode === "paused") return true;'),
 ...[
  'mode === "acceptance"',
  'process.env.APP_ENVIRONMENT === "staging"',
  'process.env.EXPECTED_FIREBASE_PROJECT_ID === "lip-knots-crew-staging"',
  'companyId === "lkc-transfer-acceptance-20260908"',
 ].map(condition=>files=>{const p='functions/src/submission-transfer-control.ts';assert.ok(files[p].includes(condition));files[p]=files[p].replace(condition,'true');}),
 files=>{const p='functions/src/submission-transfer-control.ts';files[p]=files[p].replace('&& companyId ===','|| companyId ===');},
 files=>files['functions/src/submission-transfer-control.ts']=files['functions/src/submission-transfer-control.ts'].replace('from "./system-safety"','from "./other"'),
 files=>files['functions/src/uploads.ts']=files['functions/src/uploads.ts'].replaceAll('if (await submissionTransferPaused(companyId))','if (submissionTransferPaused(companyId))'),
 files=>files['functions/src/uploads.ts']=files['functions/src/uploads.ts'].replace('from "./submission-transfer-control"','from "./other"'),
]){
 const result=run(change);assert.equal(result.passed,false);assert.equal(result.exitCode,1);passed++;
}
assert.equal(run(files=>{const p='functions/src/submission-transfer-control.ts';files[p]=files[p].replace(/const acceptanceOnly =[\s\S]*?if \(mode !== "active" && !acceptanceOnly\) return true;/,'if (mode !== "active") return true;');}).passed,true);passed++;

assert.deepEqual(run(undefined,'createUploadSession'),{passed:true,exitCode:0});passed++;
const uploadsPath='functions/src/uploads.ts',start=source[uploadsPath].indexOf('export const createUploadSession ='),end=source[uploadsPath].indexOf('\nexport const finalizeStagedUpload');
const entryBlock=source[uploadsPath].slice(start,end);
for(const [before,after] of [
 ['requireAuth(request)','unverified(request)'],
 ['CreateSchema.parse(request.data)','request.data'],
 ['companyFromClaims(session.token)','request.data.companyId'],
 ['staffFromClaims(session.token)','request.data.staffId'],
 ['if (await submissionTransferPaused(companyId)) throw','if (false) throw'],
 ['(input.purpose === "replacement") !== Boolean(input.resubmissionRequestId)','false'],
 ['await db.runTransaction(async (tx) =>','await nonAtomic(async (tx) =>'],
 ['job.companyId !== companyId || job.assignedStaffId !== staffId','job.companyId !== companyId'],
 ['job.cancelled === true || job.status === "cancelled"','false'],
 ['job.status !== "assigned"','false'],
 ['resubmission?.companyId !== companyId ||',''],
 ['resubmission?.staffId !== staffId ||',''],
 ['resubmission?.jobId !== input.jobId ||',''],
 ['resubmission?.type !== input.type ||',''],
 ['resubmission?.status !== "open"','false'],
 ['resubmission.sourceFileId && input.files.length !== 1','false'],
 ['tx.create(submissionRef,','await submissionRef.create('],
 ['uid: session.uid','uid: input.uid'],
 ['completedFiles: 0','completedFiles: 1'],
 ['tx.create(submissionRef.collection("files").doc(record.fileId),','await nonAtomicFileCreate('],
 ['submissionId: submissionRef.id','submissionId: input.submissionId'],
 ['storagePath: record.storagePath','storagePath: input.storagePath'],
]) {
 assert.ok(entryBlock.includes(before),before);
 assert.deepEqual(run(files=>{files[uploadsPath]=files[uploadsPath].slice(0,start)+entryBlock.replace(before,after)+files[uploadsPath].slice(end);},'createUploadSession'),{passed:false,exitCode:1},before);passed++;
}
for(const [before,after] of [
 ['from "./utils"','from "./other"'],
 ['size: z.number().int().positive().max(50 * 1024 * 1024)','size: z.number()'],
 ['})).min(1).max(20)','})).min(1)'],
 ['value === "application/pdf" || /^image\\/[^\\s/;]+$/.test(value)','true'],
]) {
 assert.ok(source[uploadsPath].includes(before),before);
 assert.deepEqual(run(files=>{files[uploadsPath]=files[uploadsPath].replace(before,after);},'createUploadSession'),{passed:false,exitCode:1},before);passed++;
}

console.log(JSON.stringify({transferAuthGuardTests:passed}));
