import assert from "node:assert/strict";
import fs from "node:fs";
import {runInNewContext} from "node:vm";
const read=p=>fs.readFileSync(new URL("../../"+p,import.meta.url),"utf8").replace(/\r\n/g,"\n");
const guard=read("scripts/automation/check-function-auth-guards.mjs").replace(/^import .*;\n/gm,"");
const modules={
getAutomationRegistry:"automation-registry",saveAutomationRegistry:"automation-registry",cancelAutomationRegistryAttempt:"automation-registry",
listHeldMailApplications:"automation-intake",getHeldMailApplication:"automation-intake",recheckHeldMailApplication:"automation-intake",cancelHeldMailApplicationReview:"automation-intake",
previewCaseMailCampaignRegistration:"automation-campaigns",registerCaseMailCampaign:"automation-campaigns",cancelCaseMailCampaignRegistration:"automation-campaigns",
getCaseMailImportSnapshot:"automation-import-snapshot",listAutomationNoticeReceipts:"automation-notice-receipts",getAutomationNoticeHandoff:"automation-notice-handoff",
receiveCaseMailApplication:"automation-intake",receiveAutomationNoticeReceipt:"automation-notice-receipts"};
const sources=Object.fromEntries(Object.values(modules).map(m=>["functions/src/"+m+".ts",read("functions/src/"+m+".ts")]));
let cases=0;
function run(name,change){
 const files={...sources};change?.(files);const lines=[],process={argv:["node","guard","--functions",name,"--require-pass"],exitCode:0,exit:code=>{throw Error("Unexpected exit "+code);}};
 runInNewContext(guard,{process,console:{log:x=>lines.push(x),error:x=>lines.push(x)},execFileSync:(cmd,args)=>{assert.equal(cmd,"git");const p=args[1].slice(args[1].indexOf(":")+1);assert.ok(Object.hasOwn(files,p));return files[p];}},{timeout:3000});
 return {passed:lines.includes("SOURCE_GUARD_STATUS=PASS"),exitCode:process.exitCode};
}
function reject(name,before,after,whole=false){
 const p="functions/src/"+modules[name]+".ts",source=sources[p],start=whole?0:source.indexOf("export const "+name),end=whole?source.length:source.indexOf("\n});",start)+4;
 const block=source.slice(start,end);assert.ok(block.includes(before),name+": missing mutation "+before);
 assert.deepEqual(run(name,files=>{files[p]=source.slice(0,start)+block.replace(before,after)+source.slice(end);}),{passed:false,exitCode:1},name+": "+before);cases++;
}
const readOnly=["getAutomationRegistry","listHeldMailApplications","getHeldMailApplication","previewCaseMailCampaignRegistration","getCaseMailImportSnapshot","listAutomationNoticeReceipts","getAutomationNoticeHandoff"];
for(const name of Object.keys(modules)){
 assert.deepEqual(run(name),{passed:true,exitCode:0},name);cases++;
 reject(name,"requireAdmin(request)","unverified(request)");
 reject(name,"companyFromClaims(session.token)","request.data.companyId");
 reject(name,"requireAdmin(request)","(await db.collection('bad').add({}),requireAdmin(request))");
 if(!["getAutomationRegistry","getHeldMailApplication","listHeldMailApplications"].includes(name))reject(name,"await assertProductionOperational(companyId);","");
 if(readOnly.includes(name))reject(name,"return db.runTransaction","tx.set(unsafe, {}); return db.runTransaction");
}
for(const [name,before,after,whole]of [
 ["saveAutomationRegistry","event.inputHash !== inputHash","false"],
 ["saveAutomationRegistry","unchanged(old, input.expectedRevision);",""],
 ["cancelAutomationRegistryAttempt",'event.status === "cancelled"',"false"],
 ["getAutomationRegistry","value.companyId !== companyId","false",true],
 ["getAutomationRegistry","input.expectedActorUid!==uid","false",true],
 ["listHeldMailApplications",'.where("companyId","==",companyId)',""],
 ["listHeldMailApplications",'.where("route","==","hold")',""],
 ["getHeldMailApplication","requireReviewScope(input,companyId,session.uid);",""],
 ["recheckHeldMailApplication","held.reviewRevision!==input.expectedReviewRevision","false"],
 ["recheckHeldMailApplication",'existing?.status!=="assigned"',"true"],
 ["cancelHeldMailApplicationReview","previous.actorUid!==session.uid","false"],
 ["registerCaseMailCampaign","checkEvent(event,input,session.uid,inputHash);",""],
 ["registerCaseMailCampaign","input.expectedPrincipalRevision)","undefined)"],
 ["cancelCaseMailCampaignRegistration","checkContext(input,companyId,session.uid);",""],
 ["previewCaseMailCampaignRegistration",'dispatch:"disabled"','dispatch:"enabled"'],
 ["registerCaseMailCampaign","sender.revision!==expectedPrincipalRevision","false",true],
 ["getCaseMailImportSnapshot","ownerSnap.id!==automationRecordKey(companyId,owner.spreadsheetId,target.fixedCaseId)","false"],
 ["getCaseMailImportSnapshot","binding.revision!==owner.revision","false"],
 ["getCaseMailImportSnapshot","input.targets.companyId!==companyId","false"],
 ["getAutomationNoticeHandoff","job.applicationUnconfirmed===true","false"],
 ["getAutomationNoticeHandoff","matchesAutomationPreContactProof(context,rawContact,rawContact?.automationProof)","true"],
 ["getAutomationNoticeHandoff","deliveryVerified:false","deliveryVerified:true"],
 ["listAutomationNoticeReceipts","event.currentSequenceAtReceipt!==row.current.sequence","false"],
 ["listAutomationNoticeReceipts",'.where("companyId","==",companyId)',""],
 ["receiveCaseMailApplication","incoming.companyId !== companyId","false"],
 ["receiveCaseMailApplication","previous.producerId !== sender.producerId","false"],
 ["receiveCaseMailApplication",'existing?.status !== "assigned"',"true"],
 ["receiveCaseMailApplication","personOwner.revision === matchedPerson.revision","true",true],
 ["receiveAutomationNoticeReceipt","previous.receivedBy!==session.uid","false"],
 ["receiveAutomationNoticeReceipt","oldEvent.inputHash!==inputHash","false"],
 ["receiveAutomationNoticeReceipt",'context.reason!=="aligned"',"false"],
 ["receiveAutomationNoticeReceipt","deliveryVerified:false","deliveryVerified:true"],
])reject(name,before,after,whole);
const allowed=JSON.parse(read("config/automation/staging-safety.json")).allowedFunctions;
assert.ok(Object.keys(modules).every(n=>allowed.includes(n)));cases++;
console.log(JSON.stringify({externalHandoffAuthGuardTests:cases,functions:Object.keys(modules),cloudOperations:false}));