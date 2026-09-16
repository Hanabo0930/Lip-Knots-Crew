import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const guard=read('scripts/automation/check-function-auth-guards.mjs').replace(/^import .*;\n/gm,'');
const modules={getSheetWriteIssues:'admin-operations',getOperationsDashboard:'analytics',getStaffPerformance:'analytics',createAdminJobGroup:'job-management',updateJobPublication:'job-management',adminEditJobInputs:'job-management',generateJobExport:'job-management',updateNetPrintNumbers:'netprint',adminSetJobCancellation:'analytics',adminRestoreCancelledJob:'analytics'};
const sources=Object.fromEntries(Object.values(modules).map(m=>['functions/src/'+m+'.ts',read('functions/src/'+m+'.ts')]));
let cases=0;
function run(name,change){const files={...sources};change?.(files);const lines=[],process={argv:['node','guard','--functions',name,'--require-pass'],exitCode:0,exit:code=>{throw Error('Unexpected exit '+code);}};
 runInNewContext(guard,{process,console:{log:x=>lines.push(x),error:x=>lines.push(x)},execFileSync:(cmd,args)=>{assert.equal(cmd,'git');assert.equal(args[0],'show');const p=args[1].slice(args[1].indexOf(':')+1);assert.ok(Object.hasOwn(files,p));return files[p];}},{timeout:3000});
 return {passed:lines.includes('SOURCE_GUARD_STATUS=PASS'),exitCode:process.exitCode};
}
function reject(name,before,after,whole=false){const p='functions/src/'+modules[name]+'.ts',source=sources[p],start=whole?0:source.indexOf('export const '+name+' ='),marker=name==='generateJobExport'?'\n);':'\n});',end=whole?source.length:source.indexOf(marker,start)+marker.length;
 const block=source.slice(start,end);assert.ok(block.includes(before),name+': mutation target '+before);
 assert.deepEqual(run(name,files=>{files[p]=source.slice(0,start)+block.replace(before,after)+source.slice(end);}),{passed:false,exitCode:1},name+': '+before);cases++;
}
for(const name of Object.keys(modules)){
 assert.deepEqual(run(name),{passed:true,exitCode:0},name);cases++;
 reject(name,'requireAdmin(request)','unverified(request)');
 reject(name,'companyFromClaims(session.token)','request.data.companyId');
 if(['getSheetWriteIssues','getOperationsDashboard','getStaffPerformance'].includes(name))reject(name,'const session = requireAdmin(request);','await db.collection("bad").add({}); const session = requireAdmin(request);');
 else reject(name,'await assertProductionOperational(companyId);','');
}
const mutations={
 getSheetWriteIssues:[['.where("companyId", "==", companyId)',''],['job?.companyId === companyId','true'],['sourceWriteVerified: false','sourceWriteVerified: true']],
 getOperationsDashboard:[['.where("companyId", "==", companyId)',''],['.limit(15001)','.limit(15000)'],['snapshot.size > 15000','false']],
 getStaffPerformance:[['profile.data()?.companyId !== companyId','false'],['.where("assignedStaffId", "==", input.staffId)',''],['snapshot.size > 10000','false']],
 createAdminJobGroup:[['const sourceReady = false;','const sourceReady = true;'],['normalizeJobInput(parsed)','unchecked(parsed)'],['await nativeJobSourceEnabled(companyId)','true'],['batch.set(jobRef,','await jobRef.set(']],
 updateJobPublication:[['await tx.getAll(...refs)','await db.getAll(...refs)'],['snap.data()?.companyId !== companyId','false'],['job.cancelled === true || job.status === "cancelled"','false'],['if (job.assignedStaffId) {','if (false) {'],['tx.set(snap.ref,','await snap.ref.set(']],
 adminEditJobInputs:[['jobSnap.data()?.companyId !== companyId','false'],['input.revision !== undefined && input.revision !== currentRevision','false'],['targetLock.active && targetLock.jobId !== input.jobId','false'],['oldLockRef && ownsOldLock','oldLockRef'],['prepareAdminEditIntent({','uncheckedIntent({'],['expected: intent.expected','expected: {}'],['staffSnap.data()?.active !== true','false']],
 generateJobExport:[['.where("companyId", "==", companyId)',''],['.limit(5001)','.limit(5000)'],['snap.size > 5000','false'],['actorUid: session.uid','actorUid: input.uid']],
 updateNetPrintNumbers:[['job.companyId !== companyId','false'],['previous.writeIdentity !== identity','false'],['expected = baseline as typeof expected;','expected = {} as typeof expected;'],['old.printedContext === identity','true'],['tx.create(queueRef,','await queueRef.create(']],
 adminSetJobCancellation:[['jobSnap.data()?.companyId !== companyId','false'],['lock.companyId === companyId','true'],['lock.jobId === input.jobId','true'],['lockRef && ownsActiveLock','lockRef'],['treatment && !ownsActiveLock','treatment && false']],
 adminRestoreCancelledJob:[['jobSnap.data()?.companyId !== companyId','false'],['staffSnap.data()?.companyId !== companyId','false'],['currentLock.staffId !== assignedStaffId','false'],['lockSnap.data()?.jobId !== input.jobId','false'],['job.cancelled !== true && job.status !== "cancelled"','false']],
};
for(const [name,pairs]of Object.entries(mutations))for(const [before,after]of pairs)reject(name,before,after);
reject('generateJobExport','from: z.iso.date(),','from: z.string(),',true);
reject('createAdminJobGroup','feature.data()?.adminJobCreationSourceReady === true','true',true);
assert.ok(Object.keys(modules).every(name=>JSON.parse(read('config/automation/staging-safety.json')).allowedFunctions.includes(name)));cases++;
console.log(JSON.stringify({adminCoreAuthGuardTests:cases,functions:Object.keys(modules),cloudOperations:false}));