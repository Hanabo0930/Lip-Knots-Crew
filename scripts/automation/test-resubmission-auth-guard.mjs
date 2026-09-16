import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const guard=read('scripts/automation/check-function-auth-guards.mjs').replace(/^import .*;\n/gm,'');
const modulePath='functions/src/resubmissions.ts',integrityPath='functions/src/submission-integrity.ts';
const source={[modulePath]:read(modulePath),[integrityPath]:read(integrityPath)};
const names=['createResubmissionRequest','getMyResubmissionRequests','getAdminResubmissionRequests','completeResubmissionRequest'];
let passed=0;
function run(name,files=source){
 const lines=[],process={argv:['node','guard','--functions',name,'--require-pass'],exitCode:0,exit:code=>{throw Error('unexpected exit '+code);}};
 runInNewContext(guard,{process,console:{log:x=>lines.push(x),error:x=>lines.push(x)},execFileSync:(cmd,args)=>{
  assert.equal(cmd,'git');assert.equal(args[0],'show');const p=args[1].slice(args[1].indexOf(':')+1);assert.ok(Object.hasOwn(files,p));return files[p];
 }},{timeout:3000});
 return {passed:lines.includes('SOURCE_GUARD_STATUS=PASS'),exitCode:process.exitCode};
}
function reject(name,before,after,file=null){
 const files={...source};let text=files[file??modulePath],start=0,end=text.length;
 if(!file){start=text.indexOf('export const '+name);const next=text.slice(start+1).search(/\nexport (?:const|async function) /);end=next<0?text.length:start+1+next;}
 assert.ok(start>=0&&end>start);
 const block=text.slice(start,end);assert.ok(block.includes(before),name+': '+before);
 files[file??modulePath]=text.slice(0,start)+block.replace(before,after)+text.slice(end);
 assert.deepEqual(run(name,files),{passed:false,exitCode:1},name+': '+before);passed++;
}
for(const name of names){
 assert.deepEqual(run(name),{passed:true,exitCode:0});passed++;
 reject(name,name==='getMyResubmissionRequests'?'requireAuth(request)':'requireAdmin(request)','untrustedSession(request)');
 reject(name,'companyFromClaims(session.token)','request.data.companyId');
 reject(name,'from "./utils"','from "./untrusted"',modulePath);
}
for(const name of ['getMyResubmissionRequests','getAdminResubmissionRequests']){
 reject(name,'.where("companyId","==",companyId)','');
 reject(name,'.where("status","in",["open","submitted"])','');
 reject(name,name==='getMyResubmissionRequests'?'.limit(100)':'.limit(200)','');
 reject(name,'.get()', '.get();await db.collection("other").add({})');
}
reject('getMyResubmissionRequests','staffFromClaims(session.token)','request.data.staffId');
reject('getMyResubmissionRequests','.where("staffId","==",staffId)','');
for(const name of ['createResubmissionRequest','completeResubmissionRequest']){
 reject(name,'await assertProductionOperational(companyId);','');
 reject(name,'from "./system-safety"','from "./untrusted"',modulePath);
 reject(name,'from "./submission-integrity"','from "./untrusted"',modulePath);
}
for(const [before,after] of [
 ['CreateSchema.parse(request.data??{})','request.data'],
 ['!job.exists||job.data()?.companyId!==companyId','!job.exists'],
 ['!current.exists||current.data()?.companyId!==companyId','!current.exists'],
 ['String(current.data()?.assignedStaffId??"")!==staffId','false'],
 ['current.data()?.cancelled===true||current.data()?.status==="cancelled"','false'],
 ['current.data()?.status!=="assigned"','false'],
 ['source.companyId!==companyId||source.jobId!==input.jobId||source.type!==input.type','false'],
 ['assertSubmissionFileIdentity(source,file.data(),input.sourceSubmissionId);',''],
 ['file.data()?.status!=="completed"','false'],
 ['tx.create(ref,','ref.set('],
 ['tx.create(notificationRef,','notificationRef.set('],
 ['createdBy:session.uid','createdBy:input.uid'],
])reject('createResubmissionRequest',before,after);
for(const [before,after] of [
 ['CompleteSchema.parse(request.data ?? {})','request.data'],
 ['!data || data.companyId !== companyId','!data'],
 ['!["submitted", "completed"].includes(String(data.status)) || !data.replacementSubmissionId','false'],
 ['submission.data()?.resubmissionRequestId !== input.requestId','false'],
 ['assertCompletedReplacement(data, submission.data(), String(data.replacementSubmissionId));',''],
 ['if (data.status === "completed") return;',''],
 ['completedBy:session.uid','completedBy:input.uid'],
])reject('completeResubmissionRequest',before,after);
for(const before of [
 'assertReplacementRequest(request, submission, submissionId);',
 'assertSubmissionCounters(submission);',
 'submission.completedFiles !== submission.totalFiles',
 'submission.jobStatusApplied !== true',
])reject('completeResubmissionRequest',before,'false',modulePath);
for(const before of [
 '["companyId", "jobId", "staffId", "type"].some(key => request[key] !== submission[key])',
 '!Number.isInteger(total)',
 '!Number.isInteger(completed)',
 'Number(completed) > Number(total)',
])reject('completeResubmissionRequest',before,'false',integrityPath);
const allowed=JSON.parse(read('config/automation/staging-safety.json')).allowedFunctions;
assert.equal(names.every(name=>allowed.includes(name)),true);passed++;
console.log(JSON.stringify({resubmissionAuthGuardTests:passed,deploymentAllowlistExpanded:true,cloudOperations:false}));
