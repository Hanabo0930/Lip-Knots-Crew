import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {harness,companyId,staffId,jobId,workDate} from "./automation-intake-test-harness.mjs";
const copy=value=>JSON.parse(JSON.stringify(value));
let passed=0;
async function test(name,fn){try{await fn();passed++;console.log("PASS "+name);}catch(error){throw Error(name,{cause:error});}}
function fixture(){
 const h=harness(),campaign=copy(h.records.get(h.paths.campaign).campaign);
 h.records.delete(h.paths.campaign);
 const input={expectedCompanyId:companyId,expectedActorUid:h.admin.uid,requestId:"campaign-request",
   expectedPrincipalRevision:"principal-1",evidenceRecordId:"synthetic-source-proof",confirmedAgainstSource:true,campaign};
 return {h,input};
}
const unchanged=h=>JSON.stringify([...h.records]);
const canonical=value=>Array.isArray(value)?"["+value.map(canonical).join(",")+"]":value!==null&&typeof value==="object"?"{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+canonical(value[key])).join(",")+"}":JSON.stringify(value);
function digest(value){return createHash("sha256").update(canonical(value)).digest("hex");}
function resign(campaign){
 campaign.operationKey=digest(["recruitment.campaign",campaign.companyId,campaign.policyRevision,campaign.sourceOperationId,campaign.area]);
 const {operationKey,payloadHash,...body}=campaign;campaign.payloadHash=digest(body);return campaign;
}
async function blocked(change,code){
 const {h,input}=fixture();change(h,input);const before=unchanged(h);
 await assert.rejects(h.registerCampaign(input),code?{code}:undefined);
 assert.equal(unchanged(h),before);assert.equal(h.list("automationCampaignRegistrationEvents").length,0);
}
await test("register and read confirmed source without sending or changing jobs",async()=>{
 const {h,input}=fixture(),before=copy(h.records.get(h.paths.job));
 const out=await h.registerCampaign(input);
 assert.equal(out.campaignKey,input.campaign.operationKey);assert.equal(out.caseCount,1);assert.equal(out.duplicate,false);
 assert.equal(out.dispatch,"disabled");assert.equal(out.verificationMethod,"admin-source-confirmation");
 assert.deepEqual(h.records.get(h.paths.job),before);
 const saved=h.records.get(h.paths.campaign);assert.equal(saved.evidenceRecordId,input.evidenceRecordId);
 assert.equal(saved.verifiedBy,h.admin.uid);assert.equal(h.list("automationCampaignOwners").length,1);
 assert.equal(h.list("automationCampaignRegistrationEvents").length,1);assert.equal(h.commits.at(-1).length,3);
 const read=await h.readCampaign({expectedCompanyId:companyId,expectedActorUid:h.admin.uid,campaignKey:out.campaignKey});
 assert.equal(read.record.sourceHash,input.campaign.sourceHash);assert.equal(read.record.registrationRevision,out.registrationRevision);
 assert.ok(!JSON.stringify(saved).includes("@"));assert.equal(h.list("notifications").length,0);
});
await test("actual registration to mail receipt and existing staff assignment after cutover",async()=>{
 const {h,input}=fixture();await h.registerCampaign(input);h.appMode();
 const received=await h.receive();assert.equal(received.route,"review");assert.equal(received.intakeOwner,"app");
 const candidate=h.list("automationApplications")[0];await h.apply(candidate);
 assert.equal(h.records.get(h.paths.job).assignedStaffId,staffId);
 assert.equal(h.records.get(h.paths.lock).jobId,jobId);
 assert.equal(h.list("automationApplications")[0].status,"assigned");
});
await test("lost acknowledgement replays after cutover and changed job without a new campaign",async()=>{
 const {h,input}=fixture();h.loseResponse=true;await assert.rejects(h.registerCampaign(input),/response lost/);
 const revision=h.records.get(h.paths.campaign).registrationRevision;h.appMode();h.records.get(h.paths.job).revision=9;
 const out=await h.registerCampaign(copy(input));assert.equal(out.registrationRevision,revision);assert.equal(out.duplicate,true);
 assert.equal(h.list("automationCampaigns").length,1);assert.equal(h.commits.at(-1).length,0);
});
await test("same request cannot change proof or campaign",async()=>{
 const {h,input}=fixture();await h.registerCampaign(input);const before=unchanged(h);
 await assert.rejects(h.registerCampaign({...input,evidenceRecordId:"changed-proof"}),{code:"already-exists"});
 assert.equal(unchanged(h),before);
});
await test("simultaneous identical requests have one persisted campaign",async()=>{
 const {h,input}=fixture();const results=await Promise.all([h.registerCampaign(input),h.registerCampaign(copy(input))]);
 assert.equal(results.filter(row=>row.duplicate).length,1);assert.equal(results[0].registrationRevision,results[1].registrationRevision);
 assert.equal(h.list("automationCampaignRegistrationEvents").length,1);assert.equal(h.list("automationCampaignOwners").length,1);
});
await test("two request IDs reuse exact campaign while preserving first source evidence",async()=>{
 const {h,input}=fixture();const out=await Promise.all([h.registerCampaign(input),h.registerCampaign({...input,requestId:"second-request",evidenceRecordId:"second-source-proof"})]);
 assert.equal(out.filter(row=>row.duplicate).length,1);assert.equal(h.list("automationCampaigns").length,1);
 assert.equal(h.list("automationCampaignRegistrationEvents").length,2);
});
await test("same source operation with edited content cannot overwrite saved campaign",async()=>{
 const {h,input}=fixture();const other=copy(input);other.requestId="second-request";
 other.campaign.sourceHash="b".repeat(64);resign(other.campaign);
 const results=await Promise.allSettled([h.registerCampaign(input),h.registerCampaign(other)]);
 assert.equal(results.filter(row=>row.status==="fulfilled").length,1);assert.equal(h.list("automationCampaigns").length,1);
});
await test("source operation cannot be reused under another policy revision",async()=>{
 const {h,input}=fixture();await h.registerCampaign(input);
 h.records.get(h.paths.policy).revision="policy-next";const next=copy(input);next.requestId="second-request";
 next.campaign.policyRevision="policy-next";resign(next.campaign);
 const before=unchanged(h);await assert.rejects(h.registerCampaign(next),{code:"already-exists"});assert.equal(unchanged(h),before);
});
await test("normal and tohoku operations remain independent",async()=>{
 const {h,input}=fixture();await h.registerCampaign(input);const next=copy(input);next.requestId="tohoku-request";next.campaign.area="tohoku";resign(next.campaign);
 await h.registerCampaign(next);assert.equal(h.list("automationCampaigns").length,2);assert.equal(h.list("automationCampaignOwners").length,2);
});
for(const [name,auth]of [["missing",null],["staff",{uid:"staff-user",token:{companyId,role:"staff",staffId}}]])
 await test("requires admin auth: "+name,async()=>{const {h,input}=fixture();const before=unchanged(h);await assert.rejects(h.registerCampaign(input,auth));assert.equal(unchanged(h),before);});
for(const [name,change,code]of [
 ["confirmed company changed",(_h,x)=>{x.expectedCompanyId="other-company";},"permission-denied"],
 ["confirmed actor changed",(_h,x)=>{x.expectedActorUid="other-admin";},"permission-denied"],
 ["campaign company differs",(_h,x)=>{x.campaign.companyId="other-company";resign(x.campaign);},"permission-denied"],
 ["missing confirmation",(_h,x)=>{x.confirmedAgainstSource=false;}],
 ["unknown request field",(_h,x)=>{x.sendMail=true;}],
 ["stale principal",(h,_x)=>{h.records.get(h.paths.sender).revision="principal-next";},"permission-denied"],
 ["inactive principal",(h,_x)=>{h.records.get(h.paths.sender).active=false;},"permission-denied"],
 ["foreign principal",(h,_x)=>{h.records.get(h.paths.sender).companyId="other-company";}],
 ["unregistered principal",(h,_x)=>{h.records.delete(h.paths.sender);},"permission-denied"],
 ["app cutover rejects new registration",(h,_x)=>{h.appMode();}],
 ["changed policy revision",(h,_x)=>{h.records.get(h.paths.policy).revision="changed-policy";}],
 ["missing binding owner",(h,_x)=>{h.records.delete(h.paths.bindingOwner);}],
 ["owner belongs to another job",(h,_x)=>{h.records.get(h.paths.bindingOwner).jobId="other-job";}],
 ["owner version differs",(h,_x)=>{h.records.get(h.paths.bindingOwner).revision="changed";}],
 ["binding version differs",(h,_x)=>{h.records.get(h.paths.binding).revision="changed";}],
 ["job content revision differs",(h,_x)=>{h.records.get(h.paths.job).revision=1;}],
 ["job company differs",(h,_x)=>{h.records.get(h.paths.job).companyId="other-company";}],
 ["job fixed reference differs",(h,_x)=>{h.records.get(h.paths.job).caseId="other-case";}],
 ["job cancelled",(h,_x)=>{h.records.get(h.paths.job).cancelled=true;}],
 ["job assigned",(h,_x)=>{h.records.get(h.paths.job).status="assigned";h.records.get(h.paths.job).assignedStaffId=staffId;}],
 ["job is not published",(h,_x)=>{h.records.get(h.paths.job).publishable=false;}],
 ["job source missing",(h,_x)=>{h.records.get(h.paths.job).sourceMissing=true;}],
 ["job application unconfirmed",(h,_x)=>{h.records.get(h.paths.job).applicationUnconfirmed=true;}],
 ["binding day differs",(h,_x)=>{h.records.get(h.paths.binding).workDate="2099-09-21";}],
 ["past work date",(h,x)=>{x.campaign.cases[0].workDate="2000-01-01";resign(x.campaign);h.records.get(h.paths.binding).workDate="2000-01-01";h.records.get(h.paths.job).dateKey="2000-01-01";}],
 ["payload hash tampered",(_h,x)=>{x.campaign.payloadHash="f".repeat(64);}],
 ["operation key tampered",(_h,x)=>{x.campaign.operationKey="f".repeat(64);}],
 ["duplicate job in well-hashed campaign",(_h,x)=>{x.campaign.cases.push({...x.campaign.cases[0],fixedCaseId:"other-fixed"});resign(x.campaign);}],
 ["duplicate external ID in well-hashed campaign",(_h,x)=>{x.campaign.cases.push({...x.campaign.cases[0],jobId:"other-job"});resign(x.campaign);}],
 ["101 cases rejected before transaction",(_h,x)=>{x.campaign.cases=Array.from({length:101},(_,n)=>({...x.campaign.cases[0],jobId:"job-"+n,fixedCaseId:"fixed-"+n}));resign(x.campaign);}],
 ])await test(name,()=>blocked(change,code));
await test("100 current cases are all checked once and saved as one bounded campaign",async()=>{
 const {h,input}=fixture(),base=copy(input.campaign.cases[0]),job=copy(h.records.get(h.paths.job)),binding=copy(h.records.get(h.paths.binding));
 input.campaign.cases=Array.from({length:100},(_,n)=>({...base,jobId:"job-"+n,appCaseId:"case-"+n,fixedCaseId:"fixed-"+n}));
 for(const target of input.campaign.cases){
  h.records.set("jobs/"+target.jobId,{...job,caseId:target.appCaseId});
  h.records.set("automationBindings/"+h.key(companyId,target.jobId),{...binding,jobId:target.jobId,appCaseId:target.appCaseId,fixedCaseId:target.fixedCaseId});
  h.records.set("automationBindingOwners/"+h.key(companyId,target.spreadsheetId,target.fixedCaseId),{companyId,jobId:target.jobId,spreadsheetId:target.spreadsheetId,fixedCaseId:target.fixedCaseId,revision:target.bindingRevision});
 }
 resign(input.campaign);const out=await h.registerCampaign(input);assert.equal(out.caseCount,100);
 for(const target of input.campaign.cases)assert.equal(h.readCounts.get("jobs/"+target.jobId),1);
 assert.equal(h.commits.at(-1).length,3);
 assert.ok(Buffer.byteLength(JSON.stringify(h.records.get("automationCampaigns/"+out.campaignKey)))<256000);
});
await test("failed commit creates neither campaign nor owner nor operation record",async()=>{
 const {h,input}=fixture();h.failCommit=true;const before=unchanged(h);await assert.rejects(h.registerCampaign(input),/commit failure/);assert.equal(unchanged(h),before);
 h.failCommit=false;await h.registerCampaign(input);assert.equal(h.list("automationCampaigns").length,1);
});
for(const [name,change]of [
 ["job revision",h=>{h.records.get(h.paths.job).revision=1;}],
 ["routing cutover",h=>h.appMode()],
 ["sender revocation",h=>{h.records.get(h.paths.sender).active=false;}],
 ["binding reassignment",h=>{h.records.get(h.paths.binding).revision="binding-next";}],
 ])await test("transaction rechecks "+name+" before persisting",async()=>{
 const {h,input}=fixture();let changed=false;h.beforeCommit=({writes})=>{if(!changed&&writes.length){changed=true;change(h);}};
 await assert.rejects(h.registerCampaign(input));assert.equal(h.list("automationCampaigns").length,0);
 assert.equal(h.list("automationCampaignOwners").length,0);assert.equal(h.list("automationCampaignRegistrationEvents").length,0);
 assert.ok(h.attempts>=2);
});
await test("legacy campaign without registration ownership cannot be adopted implicitly",async()=>{
 const {h,input}=fixture();h.records.set(h.paths.campaign,{companyId,producerId:"synthetic-producer",verification:"verified",evidenceRecordId:"legacy-proof",campaign:input.campaign});
 const before=unchanged(h);await assert.rejects(h.registerCampaign(input));assert.equal(unchanged(h),before);
});
await test("read is scoped and does not expose arbitrary campaign contents",async()=>{
 const {h,input}=fixture();await h.registerCampaign(input);const read={expectedCompanyId:companyId,expectedActorUid:h.admin.uid,campaignKey:input.campaign.operationKey};
 await assert.rejects(h.readCampaign({...read,expectedCompanyId:"other-company"}),{code:"permission-denied"});
 await assert.rejects(h.readCampaign(read,h.staff));
 const missing=await h.readCampaign({...read,campaignKey:"f".repeat(64)});assert.equal(missing.record,null);
 h.records.get(h.paths.campaign).companyId="other-company";await assert.rejects(h.readCampaign(read));
});
for(const field of ["campaignKey","caseCount"])await test("inconsistent saved result fails closed: "+field,async()=>{
 const {h,input}=fixture();await h.registerCampaign(input);h.records.get(h.paths.campaign)[field]=field==="caseCount"?99:"f".repeat(64);
 const before=unchanged(h);await assert.rejects(h.registerCampaign({...input,requestId:"new-request"}));
 await assert.rejects(h.readCampaign({expectedCompanyId:companyId,expectedActorUid:h.admin.uid,campaignKey:input.campaign.operationKey}));
 assert.equal(unchanged(h),before);
});

await test("preview reads current cases and principal without any write or verification claim",async()=>{
 const {h,input}=fixture(),before=unchanged(h),out=await h.previewCampaign({expectedCompanyId:companyId,expectedActorUid:h.admin.uid,campaign:input.campaign});
 assert.equal(out.expectedPrincipalRevision,"principal-1");assert.equal(out.alreadyRegistered,false);
 assert.equal(out.registeredResult,null);assert.equal(out.evidenceRecordId,null);assert.equal(out.cases[0].fixedCaseId,input.campaign.cases[0].fixedCaseId);
 assert.equal(out.dispatch,"disabled");assert.equal(out.campaignKey,input.campaign.operationKey);assert.equal(out.payloadHash,input.campaign.payloadHash);
 assert.equal(unchanged(h),before);assert.ok(h.commits.every(writes=>writes.length===0));assert.equal(h.readCounts.get(h.paths.job),1);
});
for(const [name,change]of [
 ["job changed",h=>{h.records.get(h.paths.job).revision=1;}],
 ["owner changed",h=>{h.records.get(h.paths.bindingOwner).jobId="other";}],
 ["sender inactive",h=>{h.records.get(h.paths.sender).active=false;}],
 ["sender invalid",h=>{h.records.get(h.paths.sender).revision="bad/path";}],
 ["app cutover",h=>h.appMode()],
 ["missing policy",h=>h.records.delete(h.paths.policy)],
 ["missing binding",h=>h.records.delete(h.paths.binding)],
 ["foreign job",h=>{h.records.get(h.paths.job).companyId="other";}],
 ])await test("preview fails without writes: "+name,async()=>{
 const {h,input}=fixture();change(h);const before=unchanged(h);
 await assert.rejects(h.previewCampaign({expectedCompanyId:companyId,expectedActorUid:h.admin.uid,campaign:input.campaign}));assert.equal(unchanged(h),before);
});
await test("preview and cancel require matching authenticated company and admin",async()=>{
 for(const method of ["previewCampaign","cancelCampaign"]){
  const {h,input}=fixture(),data=method==="previewCampaign"?{expectedCompanyId:companyId,expectedActorUid:h.admin.uid,campaign:input.campaign}:input;
  for(const auth of [null,h.staff])await assert.rejects(h[method](data,auth));
  for(const patch of [{expectedCompanyId:"other"},{expectedActorUid:"other"}])await assert.rejects(h[method]({...data,...patch}),{code:"permission-denied"});
  assert.equal(h.list("automationCampaignRegistrationEvents").length,0);assert.equal(h.list("automationCampaigns").length,0);
 }
});
await test("confirmed preview becomes stale on job or principal change before registration",async()=>{
 for(const field of ["job","sender"]){
  const {h,input}=fixture(),preview=await h.previewCampaign({expectedCompanyId:companyId,expectedActorUid:h.admin.uid,campaign:input.campaign});
  input.expectedPrincipalRevision=preview.expectedPrincipalRevision;
  h.records.get(h.paths[field]).revision=field==="job"?1:"principal-next";
  await assert.rejects(h.registerCampaign(input));assert.equal(h.list("automationCampaignRegistrationEvents").length,0);
 }
});
await test("identical registered preview shows original evidence after cutover without claiming current availability",async()=>{
 const {h,input}=fixture();const saved=await h.registerCampaign(input);h.appMode();h.records.get(h.paths.job).revision=99;
 const before=unchanged(h),out=await h.previewCampaign({expectedCompanyId:companyId,expectedActorUid:h.admin.uid,campaign:input.campaign});
 assert.equal(out.alreadyRegistered,true);assert.equal(out.registeredResult.registrationRevision,saved.registrationRevision);
 assert.equal(out.evidenceRecordId,input.evidenceRecordId);assert.equal(out.cases[0].storeName,null);assert.equal(unchanged(h),before);
});
await test("preview rejects collision or missing registration ownership",async()=>{
 for(const kind of ["collision","owner"]){
  const {h,input}=fixture();await h.registerCampaign(input);
  if(kind==="collision"){input.campaign.sourceHash="b".repeat(64);resign(input.campaign);}
  else for(const key of [...h.records.keys()])if(key.startsWith("automationCampaignOwners/"))h.records.delete(key);
  const before=unchanged(h);await assert.rejects(h.previewCampaign({expectedCompanyId:companyId,expectedActorUid:h.admin.uid,campaign:input.campaign}));assert.equal(unchanged(h),before);
 }
});
await test("cancel persists a tombstone and rejects delayed registration even after data changes",async()=>{
 const {h,input}=fixture();const out=await h.cancelCampaign(input);assert.equal(out.outcome,"cancelled");
 assert.equal(out.requestId,input.requestId);assert.equal(out.campaignKey,input.campaign.operationKey);assert.equal(out.result,null);
 h.appMode();h.records.get(h.paths.sender).active=false;
 const replay=await h.cancelCampaign(copy(input));assert.equal(replay.outcome,"cancelled");
 await assert.rejects(h.registerCampaign(input),error=>error.details?.reason==="campaign_registration_cancelled"&&error.details?.accepted===false);
 assert.equal(h.list("automationCampaigns").length,0);assert.equal(h.list("automationCampaignOwners").length,0);assert.equal(h.list("automationCampaignRegistrationEvents").length,1);
});
await test("lost cancel acknowledgement recovers the same persisted cancellation",async()=>{
 const {h,input}=fixture();h.loseResponse=true;await assert.rejects(h.cancelCampaign(input),/response lost/);
 assert.equal((await h.cancelCampaign(input)).outcome,"cancelled");await assert.rejects(h.registerCampaign(input));
 assert.equal(h.list("automationCampaignRegistrationEvents").length,1);
});
await test("cancel of committed or legacy committed operation reports success without rollback",async()=>{
 for(const legacy of [false,true]){
  const {h,input}=fixture(),registered=await h.registerCampaign(input);
  if(legacy)for(const value of h.records.values())if(value.inputHash)delete value.status;
  const before=unchanged(h),out=await h.cancelCampaign(input);assert.equal(out.outcome,"committed");
  assert.equal(out.result.registrationRevision,registered.registrationRevision);assert.equal(unchanged(h),before);
  assert.equal((await h.registerCampaign(input)).registrationRevision,registered.registrationRevision);
 }
});
await test("cancel rejects changed proof, altered campaign, foreign record and unknown status",async()=>{
 for(const mode of ["proof","campaign","foreign","status"]){
  const {h,input}=fixture();await h.cancelCampaign(input);
  const next=copy(input);
  if(mode==="proof")next.evidenceRecordId="other";
  if(mode==="campaign"){next.campaign.sourceHash="b".repeat(64);resign(next.campaign);}
  if(mode==="foreign")for(const value of h.records.values())if(value.inputHash)value.companyId="other";
  if(mode==="status")for(const value of h.records.values())if(value.inputHash)value.status="unknown";
  const before=unchanged(h);await assert.rejects(h.cancelCampaign(next));assert.equal(unchanged(h),before);
 }
});
await test("registration and cancellation races settle on exactly one durable outcome",async()=>{
 for(const cancelFirst of [false,true]){
  const {h,input}=fixture();
  const outcomes=await Promise.allSettled(cancelFirst?[h.cancelCampaign(input),h.registerCampaign(input)]:[h.registerCampaign(input),h.cancelCampaign(input)]);
  const final=await h.cancelCampaign(input);assert.equal(h.list("automationCampaignRegistrationEvents").length,1);
  if(final.outcome==="committed"){assert.equal(h.list("automationCampaigns").length,1);assert.equal((await h.registerCampaign(input)).registrationRevision,final.result.registrationRevision);}
  else {assert.equal(h.list("automationCampaigns").length,0);assert.equal(h.list("automationCampaignOwners").length,0);await assert.rejects(h.registerCampaign(input));}
  assert.ok(outcomes.some(row=>row.status==="fulfilled"));
 }
});
await test("failed cancel commit leaves no tombstone and a new registration can proceed",async()=>{
 const {h,input}=fixture();h.failCommit=true;const before=unchanged(h);await assert.rejects(h.cancelCampaign(input));assert.equal(unchanged(h),before);
 h.failCommit=false;await h.registerCampaign(input);assert.equal(h.list("automationCampaigns").length,1);
});

await test("replayed registration and cancellation reject corrupted committed case count",async()=>{
 const {h,input}=fixture();await h.registerCampaign(input);
 for(const value of h.records.values())if(value.inputHash)value.caseCount=99;
 const before=unchanged(h);await assert.rejects(h.registerCampaign(input));await assert.rejects(h.cancelCampaign(input));assert.equal(unchanged(h),before);
});
console.log("Campaign registration passed: "+passed+" conditions; synthetic SDK boundaries, no cloud access.");

