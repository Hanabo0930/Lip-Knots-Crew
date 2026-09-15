import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
const read=rel=>fs.readFileSync(new URL('../../'+rel,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const guard=read('scripts/automation/check-function-auth-guards.mjs').replace(/^import .*;\n/gm,'');
const original=read('functions/src/admin-operations.ts');
const start=original.indexOf('export const confirmApplication =');
const end=original.indexOf('\nexport const ',start+1);
assert.ok(start>=0&&end>start);
const block=original.slice(start,end);
function run(source=original){
 const lines=[],process={argv:['node','guard','--functions','confirmApplication','--require-pass'],exitCode:0,exit:code=>{throw Error('unexpected exit '+code);}};
 runInNewContext(guard,{process,console:{log:x=>lines.push(x),error:x=>lines.push(x)},execFileSync:(cmd,args)=>{
  assert.equal(cmd,'git');assert.equal(args[0],'show');assert.equal(args[1].split(':').at(-1),'functions/src/admin-operations.ts');return source;
 }},{timeout:3000});
 return {passed:lines.includes('SOURCE_GUARD_STATUS=PASS'),exitCode:process.exitCode};
}
assert.equal(run().passed,true);let passed=1;
for(const [before,after] of [
 ['requireAdmin(request)','requireAuth(request)'],
 ['companyFromClaims(session.token)','request.data.companyId'],
 ['await assertProductionOperational(companyId);',''],
 ['JobSchema.parse(request.data ?? {})','request.data'],
 ['db.collection("jobs").doc(input.jobId)','db.collection("jobs").doc(request.data.target)'],
 ['!job.exists || job.data()?.companyId !== companyId','!job.exists'],
 ['await db.runTransaction(async (tx) =>','await nonAtomic(async (tx) =>'],
 ['const current = await tx.get(ref);','const current = job;'],
 ['!current.exists || current.data()?.companyId !== companyId','!current.exists'],
 ['data.status !== "assigned" || (data.assignedStaffId ?? null) !== (job.data()?.assignedStaffId ?? null)','data.status !== "assigned"'],
 ['if (data.applicationAdminConfirmed === true) return;',''],
 ['applicationAdminConfirmedBy: session.uid','applicationAdminConfirmedBy: input.uid'],
 ['db.collection("auditLogs").doc()','db.collection("other").doc()'],
 ['tx.set(auditRef,','await auditRef.set('],
 ['actorUid: session.uid','actorUid: input.actorUid'],
]){
 assert.ok(block.includes(before),before);
 const result=run(original.slice(0,start)+block.replace(before,after)+original.slice(end));
 assert.deepEqual(result,{passed:false,exitCode:1},before);passed++;
}
for(const [before,after] of [['from "./utils"','from "./other"'],['from "./system-safety"','from "./other"']]){
 assert.ok(original.includes(before));assert.deepEqual(run(original.replace(before,after)),{passed:false,exitCode:1});passed++;
}
const config=JSON.parse(read('config/automation/staging-safety.json'));
assert.equal(config.allowedFunctions.includes('confirmApplication'),false,'Audit support must not silently grant deployment permission');passed++;
console.log(JSON.stringify({confirmApplicationAuthGuardTests:passed,deploymentAllowlistExpanded:false,cloudOperations:false}));
