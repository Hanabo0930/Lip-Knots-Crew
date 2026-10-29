import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const guard=read('scripts/automation/check-function-auth-guards.mjs').replace(/^import .*;\n/gm,'');
const paths=['jobs','job-management','case-list-source','case-list-source-core','automation-intake','admin-operations','case-list-monthly-worker','case-list-publication','case-list-publication-finalizer','case-list-publication-core'];
const sources=Object.fromEntries(paths.map(p=>['functions/src/'+p+'.ts',read('functions/src/'+p+'.ts')]));
let cases=0;
function run(name,mutate){
 const files={...sources};mutate?.(files);
 const lines=[],process={argv:['node','guard','--functions',name,'--require-pass'],exitCode:0,exit:c=>{throw Error('Unexpected exit '+c);}};
 runInNewContext(guard,{process,console:{log:x=>lines.push(x),error:x=>lines.push(x)},execFileSync:(command,args)=>{assert.equal(command,'git');assert.equal(args[0],'show');const path=args[1].slice(args[1].indexOf(':')+1);assert.ok(Object.hasOwn(files,path),'Unexpected source read '+path);return files[path];}},{timeout:3000});
 return {passed:lines.includes('SOURCE_GUARD_STATUS=PASS'),exitCode:process.exitCode};
}
function reject(name,module,before,after){const path='functions/src/'+module+'.ts';assert.ok(sources[path].includes(before),'Missing mutation '+before);assert.deepEqual(run(name,files=>{files[path]=files[path].replace(before,after);}),{passed:false,exitCode:1},name+': '+before);cases++;}
for(const name of ['updateJobPublication','applyToJob']){assert.deepEqual(run(name),{passed:true,exitCode:0},name);cases++;}
for(const [before,after] of [
 ['requireCaseListExecutive(session.token as Record<string, unknown>)','uncheckedExecutive(session.token as Record<string, unknown>)'],
 ['snap.data()?.companyId === companyId && snap.data()?.caseListSource','snap.data()?.caseListSource'],
 ['confirmation.expectedSourceRevision !== input.expectedSourceRevisions?.[snap.id]','false'],
 ['input.expectedRevisions?.[snap.id], input.expectedSourceRevisions?.[snap.id], confirmation, session.uid','input.expectedRevisions?.[snap.id], input.expectedSourceRevisions?.[snap.id], confirmation, "untrusted-actor"'],
 ['if (job.caseListSource && !caseListCheck)','if (false)'],
 ['input.expectedRevisions?.[snap.id] !== pendingJob.revision','false'],

 ['if (job.caseListSource && input.action === "schedule")','if (false)'],
 ['if (caseListCheck) {','if (true) {'],
 ['caseListCheck, session.uid, now, companyId','caseListCheck, session.uid, now, input.companyId'],
 ['finalizer.stageVerifiedCaseListPublication(tx, snap.ref, caseListCheck','finalizer.stageVerifiedCaseListPublication(tx, snap.ref, input.confirmation'],
 ['if (publication.blockedReason) blocked.push(snap.id);','tx.set(db.collection("unexpected").doc(snap.id), {}); if (publication.blockedReason) blocked.push(snap.id);'],
]) reject('updateJobPublication','job-management',before,after);
for(const [before,after] of [
 ['caseListChecked = await caseListSourceModule().readCaseListPublication(tx, companyId, input.jobId, job, input.expectedJobRevision, input.expectedSourceRevision);','caseListChecked = request.data.caseListChecked;'],
 ['(previous.expectedSourceRevision ?? null) !== (input.expectedSourceRevision ?? null)','false'],
 ['(caseListChecked && lockSnap.data()?.active !== false)','false'],
 ['operation: caseListChecked ? "case_list.assign" : "job.assign"','operation: caseListChecked ? "job.assign" : "job.assign"'],
 ['`${caseListChecked ? "case_list.assign" : "job.assign"}:${input.jobId}:${queueRef.id}`','`job.assign:${input.jobId}:${queueRef.id}`'],
 ['sourceCaseId: caseListChecked.source.caseId','sourceCaseId: input.jobId'],
 ['sourceLedgerRevision: caseListChecked.source.ledgerRevision','sourceLedgerRevision: input.expectedSourceRevision'],
 ['preMonthlyContentHash: caseListChecked.preMonthlyContentHash','preMonthlyContentHash: "unverified"'],
 ['expectedSourceRevision: input.expectedSourceRevision ?? null,','expectedSourceRevision: null,'],
 ['actorUid: session.uid,\n      actorStaffId: staffId,','actorUid: "untrusted",\n      actorStaffId: staffId,'],
]) reject('applyToJob','jobs',before,after);
for(const [before,after]of [
 ['expectedJobRevision !== job.revision','false'],
 ['entry.source.sourceRevision !== expectedSourceRevision','false'],
 ['savedDocument?.companyId === companyId && savedDocument.jobId === jobId','true'],
 ['assertCaseListJobBinding(companyId, jobId, job, entry.source, createJobIdFromPersistedCaseId)','uncheckedBinding(companyId, jobId, job, entry.source, createJobIdFromPersistedCaseId)'],
 ['Object.entries(jobFields).some(([key, value]) => job[key] !== value)','false'],
 ['job.basePay !== (candidate.payOffer as { dailyWageJPY: number }).dailyWageJPY','false'],
 ['hashCaseList(job.publicPayOffer) !== hashCaseList(candidate.payOffer)','false'],
])for(const name of ['updateJobPublication','applyToJob'])reject(name,'case-list-source',before,after);
for(const [before,after] of [
 ['job.companyId !== companyId || job.caseId !== source.caseId','false'],
 ['jobId !== createJobId(companyId, source.caseId)','false'],
 ['saved?.sourceRevision !== source.sourceRevision','false'],
 ['saved.sheetId !== source.sheetId','false'],
])for(const name of ['updateJobPublication','applyToJob'])reject(name,'case-list-source-core',before,after);
assert.deepEqual(run('getSheetWriteIssues'),{passed:true,exitCode:0});cases++;
reject('getSheetWriteIssues','admin-operations','data.operation !== "case_list.assign" && canManuallyRetrySheetWrite({','canManuallyRetrySheetWrite({');
reject('getSheetWriteIssues','admin-operations','canReconcile: data.operation === "case_list.assign"','canReconcile: true');

for(const [module,before,after] of [
 ['case-list-publication','requireCaseListExecutive(token);',''],
 ['case-list-publication','latest.reviewPlanHash === plan.reviewPlanHash','true'],
 ['case-list-publication','current.revision === expectedGenerationRevision','true'],
 ['case-list-publication','current.caseListPublicationWrite?.intentHash === expectedIntentHash','true'],
 ['case-list-publication','job.revision === expectedGenerationRevision','true'],
 ['case-list-publication','after.caseListPublicationWrite?.intentHash === expectedIntentHash','true'],
 ['case-list-publication','latest.revision === expectedGenerationRevision','true'],
 ['case-list-publication','latest.caseListPublicationWrite?.intentHash === expectedIntentHash','true'],


 ['case-list-publication','status: "draft", publishable: false, sourceReady: false, recruitmentStopped: true','status: "open", publishable: true, sourceReady: true, recruitmentStopped: false'],
 ['case-list-publication-finalizer','{ companyId, jobId: jobRef.id','{ companyId: "other", jobId: jobRef.id'],
 ['case-list-publication-finalizer','...check.approval, actorUid','...input.confirmation, actorUid'],
 ['case-list-publication-core','controller.transferCapability(snapshot, row).supported','true'],
 ['case-list-publication-core','canonical(snapshot.catalog) === canonical(plan.postCatalog)','true'],
]) reject('updateJobPublication',module,before,after);

console.log(JSON.stringify({caseListAuthGuardTests:cases,functions:['updateJobPublication','applyToJob'],scope:'SOURCE_SCANNER_MUTATION_TESTS_ONLY',cloudOperations:false}));
