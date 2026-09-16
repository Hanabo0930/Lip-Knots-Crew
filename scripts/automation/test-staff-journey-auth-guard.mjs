import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const guard=read('scripts/automation/check-function-auth-guards.mjs').replace(/^import .*;\n/gm,'');
const modules={applyToJob:'jobs',getMyTasks:'staff-tasks',listMyMailApplications:'automation-intake',setSalesFloorClientSubmitted:'submission-status',submitPreContact:'precontact'};
const sources=Object.fromEntries(Object.values(modules).map(m=>['functions/src/'+m+'.ts',read('functions/src/'+m+'.ts')]));
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
for(const name of Object.keys(modules)) {
 assert.deepEqual(run(name),{passed:true,exitCode:0},name);cases++;
 reject(name,'requireAuth(request)','unverified(request)');
 reject(name,'companyFromClaims(session.token)','request.data.companyId');
 reject(name,'staffFromClaims(session.token)','request.data.staffId');
 if(!['getMyTasks','listMyMailApplications'].includes(name))reject(name,'await assertProductionOperational(companyId);','');
}
const mutations={
 applyToJob:[
  ['session.token.role !== "staff"','false'],
  ['previous?.uid !== session.uid || previous?.companyId !== companyId','false'],
  ['previous.staffId !== staffId','false'],
  ['job.companyId !== companyId || staff.companyId !== companyId','job.companyId !== companyId'],
  ['staff.active !== true','false'],
  ['job.status !== "open" || job.assignedStaffId','false'],
  ['job.sourceMissing === true || job.assignmentUnresolved === true || job.applicationUnconfirmed === true || job.publishable !== true','false'],
  ['lockSnap.exists && lockSnap.data()?.active === true','false'],
  ['await readMailApplicationForAssignment(tx,','await unverifiedApplication(tx,'],
  ['tx.set(idempotencyRef,','await idempotencyRef.set('],
 ],
 getMyTasks:[
  ['.where("assignedStaffId", "==", staffId)',''],
  ['.where("staffId", "==", staffId)',''],
  ['.limit(2000)','.limit(100000)'],
  ['snapshot.exists && data?.companyId === companyId && data?.assignedStaffId === staffId','snapshot.exists'],
  ['job?.status === "assigned" && job.cancelled !== true','true'],
 ],
 listMyMailApplications:[
  ['session.token.role !== "staff"','false'],
  ['.where("staffId","==",staffId)',''],
  ['.limit(26)','.limit(2600)'],
  ['staff?.companyId !== companyId || staff.active !== true','false'],
  ['policy.phase !== "app"','false'],
  ['candidate.companyId !== companyId || candidate.staffId !== staffId','false'],
  ['jobData && jobData.companyId !== companyId','false'],
  ['await readMailApplicationForAssignment(reader,','await unverifiedApplication(reader,'],
 ],
 setSalesFloorClientSubmitted:[
  ['job.companyId !== companyId || job.assignedStaffId !== staffId','job.companyId !== companyId'],
  ['job.cancelled === true || job.status === "cancelled"','false'],
  ['current?.clientSubmitted === input.submitted && current.completed === (input.submitted || lipKnotsSubmitted)','false'],
  ['"submissionStatus.salesFloor.completed": input.submitted || lipKnotsSubmitted','"submissionStatus.salesFloor.completed": input.submitted'],
  ['tx.set(db.collection("sheetSyncQueue").doc(),','await nonAtomicQueueWrite('],
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
for(const [name,pairs]of Object.entries(mutations))for(const [before,after]of pairs)reject(name,before,after);
for(const name of ['applyToJob','listMyMailApplications'])for(const [before,after]of [
 ['parsed.data.companyId !== input.companyId || parsed.data.staffId !== input.staffId ||',''],
 ['candidate.revision !== input.revision','false'],
 ['currentSender.data.producerId !== savedReceipt.producerId || currentSender.data.revision !== savedReceipt.principalRevision','false'],
 ['context.person.revision !== candidate.personRevision || context.selected.workDate !== candidate.workDate','false'],
])reject(name,before,after,'functions/src/automation-intake.ts');
const config=JSON.parse(read('config/automation/staging-safety.json'));
assert.ok(Object.keys(modules).every(name=>config.allowedFunctions.includes(name)));cases++;
console.log(JSON.stringify({staffJourneyAuthGuardTests:cases,functions:Object.keys(modules),cloudOperations:false}));

