import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const guard=read('scripts/automation/check-function-auth-guards.mjs').replace(/^import .*;\n/gm,'');
const modules={applyToJob:'jobs',getMyTasks:'staff-tasks',listMyMailApplications:'automation-intake',setSalesFloorClientSubmitted:'submission-status',submitPreContact:'precontact'};
const sources=Object.fromEntries([...Object.values(modules),'staff-session','case-list-source','case-list-source-core'].map(m=>['functions/src/'+m+'.ts',read('functions/src/'+m+'.ts')]));
let cases=0;
function run(name,change) {
 const files={...sources};change?.(files);
 const lines=[],process={argv:['node','guard','--functions',name,'--require-pass'],exitCode:0,exit:code=>{throw Error('Unexpected exit '+code);}};
 runInNewContext(guard,{process,console:{log:x=>lines.push(x),error:x=>lines.push(x)},execFileSync:(cmd,args)=>{
  assert.equal(cmd,'git');assert.equal(args[0],'show');const p=args[1].slice(args[1].indexOf(':')+1);assert.ok(Object.hasOwn(files,p),p);return files[p];
 }},{timeout:3000});
 return {passed:lines.includes('SOURCE_GUARD_STATUS=PASS'),exitCode:process.exitCode};
}
function reject(name,before,after,wholeFile) {
 const p=wholeFile??'functions/src/'+modules[name]+'.ts',source=sources[p];
 const start=wholeFile?0:source.indexOf('export const '+name+' ='),end=wholeFile?source.length:source.indexOf('\n});',start)+4;
 const block=source.slice(start,end);assert.ok(block.includes(before),name+': '+before);
 assert.deepEqual(run(name,files=>{files[p]=source.slice(0,start)+block.replace(before,after)+source.slice(end);}),{passed:false,exitCode:1},name+': '+before);cases++;
}
reject('setSalesFloorClientSubmitted','assertCaseMailSubmissionRevision(job, input.expectedRevision);','');
for(const name of Object.keys(modules)) {
 assert.deepEqual(run(name),{passed:true,exitCode:0},name);cases++;
 reject(name,'requireAuth(request)','unverified(request)');
 reject(name,'companyFromClaims(session.token)','request.data.companyId');
 reject(name,'staffFromClaims(session.token)','request.data.staffId');
 if(!['getMyTasks','listMyMailApplications'].includes(name))reject(name,'await assertProductionOperational(companyId);','');
}
const mutations={
 applyToJob:[
  ['job.mailIntakeReviewRequired === true', 'false'],
  ['job.mailTargetHold != null', 'false'],
  ['revision: nextAssignmentRevision(job)','revision: 0'],
  ['session.token.role !== "staff"','false'],
  ['previous?.uid !== session.uid || previous?.companyId !== companyId','false'],
  ['previous.staffId !== staffId','false'],
  ['if (job.companyId !== companyId)','if (false)'],
  ['job.status !== "open" || job.assignedStaffId','false'],
  ['job.sourceMissing === true || job.assignmentUnresolved === true || job.applicationUnconfirmed === true || job.publishable !== true','false'],
  ['lockSnap.exists && (lockSnap.data()?.active === true || (caseListChecked && lockSnap.data()?.active !== false))','false'],
  ['await readMailApplicationForAssignment(tx,','await unverifiedApplication(tx,'],
  ['tx.set(idempotencyRef,','await idempotencyRef.set('],
  ['staffApplicationQueueKey(session.uid, input.requestId)','staffApplicationQueueKey(input.uid, input.requestId)'],
  ['if (!previous) throw new HttpsError','if (false) throw new HttpsError'],
  ['tx.create(queueRef,','await queueRef.set('],
  ['requestId: input.requestId, assignedAt: response.assignedAt, ...receiptBinding','requestId: input.jobId, assignedAt: response.assignedAt, ...receiptBinding'],
 ],
 getMyTasks:[
  ['job.sourceMissing !== true','true'],
  ['job.applicationUnconfirmed !== true','true'],
  ['job.assignmentUnresolved !== true','true'],
  ['.where("assignedStaffId", "==", staffId)',''],
  ['.where("status", "==", "assigned")',''],
  ['.where("staffId", "==", staffId)',''],
  ['.limit(2000)','.limit(100000)'],
  ['snapshot.exists && data?.companyId === companyId && data?.assignedStaffId === staffId','snapshot.exists'],
  ['job?.status === "assigned" && job.cancelled !== true','true'],
 ],
 listMyMailApplications:[
  ['session.token.role !== "staff"','false'],
  ['.where("staffId","==",staffId)',''],
  ['.limit(26)','.limit(2600)'],
  ['await readActiveStaffProfile(tx, companyId, staffId, session.uid, session.token.auth_time, { requireIdentity: true, deviceClaims: session.token });',''],
  ['policy.phase !== "app"','false'],
  ['candidate.companyId !== companyId || candidate.staffId !== staffId','false'],
  ['jobData && jobData.companyId !== companyId','false'],
  ['await readMailApplicationForAssignment(reader,','await unverifiedApplication(reader,'],
 ],
 setSalesFloorClientSubmitted:[
  ['assertSubmissionReadiness(job);',''],
  ['job.companyId !== companyId || job.assignedStaffId !== staffId','job.companyId !== companyId'],
  ['job.cancelled === true || job.status === "cancelled"','false'],
  ['current?.clientSubmitted === input.submitted && current.completed === (input.submitted || lipKnotsSubmitted)','false'],
  ['"submissionStatus.salesFloor.completed": input.submitted || lipKnotsSubmitted','"submissionStatus.salesFloor.completed": input.submitted'],
  ['tx.set(queueRef,','await nonAtomicQueueWrite('],
  ['identity: submissionSheetWriteIdentity(job)','identity: "unverified"'],
  ['operationId: queueRef.id','operationId: "old"'],
  ['pending: true','pending: false'],
 ],
 submitPreContact:[
  ['job.companyId !== companyId || job.assignedStaffId !== staffId','job.companyId !== companyId'],
  ['!workDate.success || (input.dateKey !== undefined && input.dateKey !== workDate.data)','!workDate.success'],
  ['if(job.sourceMissing===true)','if(false)'],
  ['if(job.applicationUnconfirmed===true)','if(false)'],
  ['if(job.assignmentUnresolved===true)','if(false)'],
  ['await readAutomationJobContext(tx,companyId,input.jobId,job)','null'],
  ['!context?.binding.assignment || matchesAutomationPreContactProof(context,previous,previous?.automationProof)','false'],
  ['tx.set(queueRef,','await queueRef.set('],
 ],
};
reject("applyToJob", "deviceClaims: session.token", "deviceClaims: {}");
reject("listMyMailApplications", "deviceClaims: session.token", "deviceClaims: {}");
reject("setSalesFloorClientSubmitted", "deviceClaims: session.token", "deviceClaims: {}");
reject("submitPreContact", "deviceClaims: session.token", "deviceClaims: {}");
for(const [name,pairs]of Object.entries(mutations))for(const [before,after]of pairs)reject(name,before,after);
for(const name of ['applyToJob','listMyMailApplications'])for(const [before,after]of [
 ['parsed.data.companyId !== input.companyId || parsed.data.staffId !== input.staffId ||',''],
 ['candidate.revision !== input.revision','false'],
 ['currentSender.data.producerId !== savedReceipt.producerId || currentSender.data.revision !== savedReceipt.principalRevision','false'],
 ['context.person.revision !== candidate.personRevision || context.selected.workDate !== candidate.workDate','false'],
])reject(name,before,after,'functions/src/automation-intake.ts');
for(const name of Object.keys(modules))for(const check of ['staff?.active !== true','staff.companyId !== companyId','authTime === revokedAt.seconds && revokedAt.nanoseconds > 0']){
 reject(name,check,'false','functions/src/staff-session.ts');
}
const config=JSON.parse(read('config/automation/staging-safety.json'));
assert.ok(Object.keys(modules).every(name=>config.allowedFunctions.includes(name)));cases++;
console.log(JSON.stringify({staffJourneyAuthGuardTests:cases,functions:Object.keys(modules),cloudOperations:false}));


reject("applyToJob", 'await readMailPublication(tx, input.jobId, job, input.expectedJobRevision, new Date(), "apply")', '({})');
reject("applyToJob", 'confirmed.context !== checked.confirmation.context', 'false');
reject("applyToJob", '(previous.expectedJobRevision ?? null) !== (input.expectedJobRevision ?? null)', 'false');
console.log("受信応募ガード追加3条件成功");

reject("submitPreContact", "if(caseMailPreparationHeld(job))throw", "if(false)throw");
reject("submitPreContact", "input.expectedRevision !== job.revision", "false");
console.log("受信案件の事前連絡ガード追加2条件成功");

reject("getMyTasks", "!caseMailPreparationHeld(job)", "true");
for(const [before,after] of [["if (request.data?.applicationReceiptLookup !== undefined)","if (false)"],["request.data.applicationReceiptLookup, companyId, staffId, session.uid, session.token","request.data.applicationReceiptLookup, companyId, staffId, request.data.uid, session.token"],["ApplicationReceiptLookupSchema.safeParse(attempts)","({success:true,data:attempts})"],["await assertProductionOperational(companyId);",""],["saved?.uid === uid && saved.companyId === companyId","saved?.uid === uid"],["saved.staffId === staffId && saved.result?.ok === true","saved.result?.ok === true"],["saved.result.jobId === jobId","true"],["const snapshot = await tx.get(db.collection(\"idempotencyKeys\").doc(uid + \"_\" + requestId));","const snapshot = await tx.get(db.collection(\"idempotencyKeys\").doc(requestId));"],["return Promise.all(input.data.map","await tx.update(db.collection('unsafe').doc('change'),{}); return Promise.all(input.data.map"],["  });\n  return { receipts };","  }, { readOnly: true });\n  return { receipts };"],["token.auth_time, { requireIdentity: true, deviceClaims: token }","token.auth_time, { requireIdentity: false, deviceClaims: token }"],["deviceClaims: token","deviceClaims: {}"]])reject("getMyTasks",before,after,"functions/src/staff-tasks.ts");
reject("getMyTasks","staffApplicationQueueKey(uid, requestId)","staffApplicationQueueKey(requestId, requestId)","functions/src/staff-tasks.ts");
reject("getMyTasks","snapshot.exists ? snapshot.data() :","snapshot.data() ??","functions/src/staff-tasks.ts");
console.log("受信保留中のタスクガード追加1条件成功");

