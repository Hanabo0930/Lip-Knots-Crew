import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
const read=rel=>fs.readFileSync(new URL('../../'+rel,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const guard=read('scripts/automation/check-function-auth-guards.mjs').replace(/^import .*;\n/gm,'');
const files={
 getExpenseReview:'admin-operations',saveExpenseReviewDraft:'admin-operations',completeExpenseReview:'admin-operations',getJobSheetLink:'admin-operations',
 markNetPrintPrinted:'netprint',adminCancelJob:'jobs',duplicateAdminJob:'job-management',
};
const sources=Object.fromEntries(Object.values(files).map(file=>[file,read('functions/src/'+file+'.ts')]));
let cases=0;
function run(name,source=sources[files[name]]) {
 const lines=[],process={argv:['node','guard','--functions',name,'--require-pass'],exitCode:0,exit:code=>{throw Error('unexpected exit '+code);}};
 runInNewContext(guard,{process,console:{log:x=>lines.push(x),error:x=>lines.push(x)},execFileSync:(cmd,args)=>{
  assert.equal(cmd,'git');assert.equal(args[0],'show');assert.equal(args[1].split(':').at(-1),'functions/src/'+files[name]+'.ts');return source;
 }},{timeout:3000});
 return {passed:lines.includes('SOURCE_GUARD_STATUS=PASS'),exitCode:process.exitCode};
}
function reject(name,before,after,whole=false) {
 const source=sources[files[name]],start=source.indexOf('export const '+name+' ='),next=source.indexOf('\nexport const ',start+1),end=next<0?source.length:next;
 const block=whole?source:source.slice(start,end);
 assert.ok(block.includes(before),name+': missing mutation target '+before);
 const changed=block.replace(before,after);
 assert.deepEqual(run(name,whole?changed:source.slice(0,start)+changed+source.slice(end)),{passed:false,exitCode:1},name+': '+before);cases++;
}
for(const name of Object.keys(files)) {
 assert.deepEqual(run(name),{passed:true,exitCode:0},name);cases++;
 reject(name,name==='markNetPrintPrinted'?'requireAuth(request)':'requireAdmin(request)','unverified(request)');
 reject(name,'companyFromClaims(session.token)','request.data.companyId');
 reject(name,'from "./utils"','from "./other"',true);
 if(!['getExpenseReview','getJobSheetLink'].includes(name)) reject(name,'await assertProductionOperational(companyId);','');
}
const mutations={
 getExpenseReview:[
  ['JobSchema.parse(request.data ?? {})','request.data'],
  ['!job.exists || job.data()?.companyId !== companyId','!job.exists'],
  ['draft.data()?.companyId !== companyId || draft.data()?.jobId !== input.jobId','false'],
  ['reviewVersion: expenseReviewVersion(companyId, input.jobId, job, draft)','reviewVersion: null'],
 ],
 saveExpenseReviewDraft:[
  ['DraftSchema.parse(request.data ?? {})','request.data'],
  ['await requireCompanyJob(companyId, input.jobId)','{}'],
  ['await db.runTransaction(async (tx) =>','await nonAtomic(async (tx) =>'],
  ['assertExpenseWriteContext(companyId, input.jobId, job, currentJob, currentReview);',''],
  ['assertExpenseReviewVersion(input.expectedVersion, companyId, input.jobId, currentJob, currentReview);',''],
  ['normalizeExpenseInput(input.values)','input.values'],
  ['updatedBy: session.uid','updatedBy: input.uid'],
 ],
 completeExpenseReview:[
  ['CompleteSchema.parse(request.data ?? {})','request.data'],
  ['await requireCompanyJob(companyId, input.jobId)','{}'],
  ['await db.runTransaction(async (tx) =>','await nonAtomic(async (tx) =>'],
  ['assertExpenseWriteContext(companyId, input.jobId, job, currentJob, existingReview);',''],
  ['assertExpenseReviewVersion(input.expectedVersion, companyId, input.jobId, currentJob, existingReview);',''],
  ['!Number.isSafeInteger(previousRevision) || previousRevision < 0 || previousRevision >= Number.MAX_SAFE_INTEGER','false'],
  ['tx.set(queueRef,','await queueRef.set('],
  ['actorUid: session.uid','actorUid: input.actorUid'],
  ['completedBy: session.uid','completedBy: input.uid'],
 ],
 getJobSheetLink:[
  ['JobSchema.parse(request.data ?? {})','request.data'],
  ['await requireCompanyJob(companyId, input.jobId)','{}'],
  ['return { url: buildSheetUrl(job) };','await job.update({}); return { url: buildSheetUrl(job) };'],
 ],
 markNetPrintPrinted:[
  ['staffFromClaims(session.token)','request.data.staffId'],
  ['PrintSchema.parse(request.data ?? {})','request.data'],
  ['await db.runTransaction(async (tx) =>','await nonAtomic(async (tx) =>'],
  ['job.companyId !== companyId || job.assignedStaffId !== staffId','job.companyId !== companyId'],
  ['job.cancelled === true || job.status === "cancelled"','false'],
  ['job.status !== "assigned"','false'],
  ['job.sourceMissing === true || job.assignmentUnresolved === true || job.applicationUnconfirmed === true','false'],
  ['!day.success || (input.dateKey !== undefined && input.dateKey !== day.data)','!day.success'],
  ['targets.length > 1','false'],
  ['target.printedContext === identity && target.printedByStaffId === staffId && target.printedForDate === day.data','true'],
  ['tx.create(queueRef,','await queueRef.create('],
  ['actorStaffId:staffId','actorStaffId:input.staffId'],
 ],
 adminCancelJob:[
  ['CancelSchema.parse(request.data)','request.data'],
  ['await db.runTransaction(async (tx) =>','await nonAtomic(async (tx) =>'],
  ['job.companyId !== companyId','false'],
  ['lock.jobId === input.jobId &&',''],
  ['lock.companyId === companyId &&',''],
  ['lock.staffId === job.assignedStaffId &&',''],
  ['lock.dateKey === job.dateKey','true'],
  ['if (lockRef && ownsActiveLock)','if (lockRef)'],
  ['tx.set(queueRef,','await queueRef.set('],
  ['targetStaffId: job.assignedStaffId','targetStaffId: input.staffId'],
 ],
 duplicateAdminJob:[
  ['DuplicateSchema.parse(request.data ?? {})','request.data'],
  ['await requireCompanyJob(companyId, input.sourceJobId)','{}'],
  ['normalizeJobInput(createData)','createData'],
  ['await nativeJobSourceEnabled(companyId)','true'],
  ['const sourceReady = false;','const sourceReady = true;'],
  ['createdBy: session.uid','createdBy: input.uid'],
  ['if (rowQueueRef)','if (true)'],
  ['await batch.commit();',''],
  ['stageAudit(batch, companyId, session.uid, "job.group.duplicate",','stageAudit(batch, input.companyId, session.uid, "job.group.duplicate",'],
 ],
};
for(const [name,pairs]of Object.entries(mutations))for(const [before,after]of pairs)reject(name,before,after);
for(const name of ['saveExpenseReviewDraft','completeExpenseReview']){
 reject(name,'!currentJob.exists || job?.companyId !== companyId','!currentJob.exists',true);
 reject(name,'expenseWriteContext(job) !== expenseWriteContext(expectedJob)','false',true);
 reject(name,'review.data()?.companyId !== companyId || review.data()?.jobId !== jobId','false',true);
}
for(const name of ['saveExpenseReviewDraft','completeExpenseReview','getJobSheetLink','duplicateAdminJob'])
 reject(name,'const snap = await db.collection("jobs").doc(jobId).get();\n  if (!snap.exists || snap.data()?.companyId !== companyId)','const snap = await db.collection("jobs").doc(jobId).get();\n  if (!snap.exists)',true);
for(const before of ['feature.data()?.adminJobCreationSourceReady === true','mapping.data()?.enabled === true','mapping.data()?.rowCreation?.enabled === true'])
 reject('duplicateAdminJob',before,'true',true);
const allowed=JSON.parse(read('config/automation/staging-safety.json')).allowedFunctions;
assert.ok(Object.keys(files).every(name=>allowed.includes(name)));cases++;
reject('duplicateAdminJob','stageAudit(batch, companyId, session.uid, "job.group.duplicate",','stageAudit(db.batch(), companyId, session.uid, "job.group.duplicate",');
reject('duplicateAdminJob','stageAudit(batch, companyId, session.uid, "job.group.duplicate",','await batch.commit(); stageAudit(batch, companyId, session.uid, "job.group.duplicate",');
reject('duplicateAdminJob','batch.create(db.collection("auditLogs").doc(),','batch.set(db.collection("auditLogs").doc(),',true);
reject('duplicateAdminJob','    companyId,\n    actorUid,\n    action,\n    detail,','    companyId: "other",\n    actorUid,\n    action,\n    detail,',true);
console.log(JSON.stringify({businessRecoveryAuthGuardTests:cases,functions:Object.keys(files),cloudOperations:false}));

