import assert from "node:assert/strict";
import {harness,companyId,staffId,jobId,workDate} from "./automation-intake-test-harness.mjs";
let serial=0;
const input=(kind,fields={},expectedRevision=null)=>({kind,requestId:"synthetic-registry-"+(++serial),expectedRevision,
 evidenceRecordId:"synthetic-source-proof",confirmedAgainstSource:true,...fields});
const snapshot=h=>JSON.stringify([...h.records]);
const clearRegistry=h=>{for(const path of [...h.records.keys()])if(path.startsWith("automation"))h.records.delete(path);};
const bindingInput=(h,changes={})=>input("binding",{jobId,jobRevision:0,fixedCaseId:"synthetic-fixed",assignment:null,...changes},h.records.get(h.paths.binding)?.revision??null);
const personInput=(h,changes={})=>input("person",{staffId,personKey:"a".repeat(64),active:true,...changes},h.records.get(h.paths.personOwner)?.revision??null);
const results=[];
async function test(name,fn){try{await fn();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:error.stack});}}
await test("new binding creates both mapping and unique owner without changing app ID",async()=>{
 const h=harness();h.records.delete(h.paths.binding);h.records.delete(h.paths.bindingOwner);
 const beforeJob=JSON.stringify(h.records.get(h.paths.job)),r=await h.registry(bindingInput(h));
 assert.equal(h.records.get(h.paths.binding).revision,r.revision);assert.equal(h.records.get(h.paths.bindingOwner).revision,r.revision);
 assert.equal(h.records.get(h.paths.binding).jobId,jobId);assert.equal(JSON.stringify(h.records.get(h.paths.job)),beforeJob);
 assert.equal(h.list("automationRegistryEvents")[0].verificationMethod,"admin-source-confirmation");
});
await test("same source fixed ID cannot be assigned to two jobs concurrently",async()=>{
 const h=harness();h.records.delete(h.paths.binding);h.records.delete(h.paths.bindingOwner);
 h.records.set("jobs/other-job",{...h.records.get(h.paths.job),caseId:"other-case"});
 const out=await Promise.allSettled([h.registry(bindingInput(h)),h.registry(input("binding",{jobId:"other-job",jobRevision:0,fixedCaseId:"synthetic-fixed",assignment:null}))]);
 assert.equal(out.filter(x=>x.status==="fulfilled").length,1);assert.equal(h.list("automationBindings").length,1);
 assert.equal(h.list("automationBindingOwners").length,1);assert.equal(h.list("automationRegistryEvents").length,1);
});
await test("old binding confirmation loses race without overwriting winner",async()=>{
 const h=harness();const old=bindingInput(h);const out=await Promise.allSettled([h.registry(old),h.registry({...old,requestId:"another-request"})]);
 assert.equal(out.filter(x=>x.status==="fulfilled").length,1);assert.equal(h.list("automationRegistryEvents").length,1);
});
await test("lost acknowledgement replays saved revision, changed payload cannot reuse request",async()=>{
 const h=harness();const request=bindingInput(h);h.loseResponse=true;await assert.rejects(h.registry(request));const saved=snapshot(h);
 const r=await h.registry(request);assert.equal(r.duplicate,true);assert.equal(snapshot(h),saved);
 await assert.rejects(h.registry({...request,evidenceRecordId:"different-proof"}),{code:"already-exists"});assert.equal(snapshot(h),saved);
});
await test("commit failure saves neither owner, binding nor audit; retry recovers",async()=>{
 const h=harness();h.records.delete(h.paths.binding);h.records.delete(h.paths.bindingOwner);const request=bindingInput(h),before=snapshot(h);
 h.failCommit=true;await assert.rejects(h.registry(request));assert.equal(snapshot(h),before);
 h.failCommit=false;await h.registry(request);assert.equal(h.list("automationBindings").length,1);assert.equal(h.list("automationRegistryEvents").length,1);
});
for(const [name,patch]of [["job revision",{jobRevision:1}],["fixed ID swap",{fixedCaseId:"different-fixed"}],["unmatched assignment",{assignment:{staffId,personKey:"a".repeat(64),proofEpoch:"epoch-1"}}]])
 await test("binding rejects "+name,async()=>{const h=harness(),before=snapshot(h);await assert.rejects(h.registry(bindingInput(h,patch)));assert.equal(snapshot(h),before);});
for(const [name,change]of [
 ["foreign job",h=>h.records.get(h.paths.job).companyId="foreign"],
 ["missing source",h=>h.records.get(h.paths.job).sourceMissing=true],
 ["changed app identity",h=>h.records.get(h.paths.job).caseId="new-case"],
 ["changed ownership revision",h=>h.records.get(h.paths.bindingOwner).revision="unexpected"],
 ["broken stored revision",h=>delete h.records.get(h.paths.binding).revision],
])await test("binding verifies "+name,async()=>{const h=harness();change(h);const before=snapshot(h);await assert.rejects(h.registry(bindingInput(h)));assert.equal(snapshot(h),before);});
await test("assigned binding requires current verified person and one owner",async()=>{
 const h=harness();Object.assign(h.records.get(h.paths.job),{status:"assigned",assignedStaffId:staffId});
 const request=bindingInput(h,{assignment:{staffId,personKey:"a".repeat(64),proofEpoch:"synthetic-epoch"}});
 await h.registry(request);assert.equal(h.records.get(h.paths.binding).assignment.staffId,staffId);
 h.records.get(h.paths.personOwner).active=false;const before=snapshot(h);await assert.rejects(h.registry(bindingInput(h,{assignment:request.assignment})));assert.equal(snapshot(h),before);
});
await test("source change during confirmation causes transaction retry and rejects stale job",async()=>{
 const h=harness();let changed=false;
 h.beforeCommit=({writes})=>{if(!changed&&writes.some(w=>w.ref.path===h.paths.binding)){changed=true;h.records.get(h.paths.job).revision=1;}};
 await assert.rejects(h.registry(bindingInput(h)));assert.equal(h.list("automationRegistryEvents").length,0);
 assert.equal(h.records.get(h.paths.binding).revision,"binding-1");
});
await test("one person key cannot be attached to another staff",async()=>{
 const h=harness();h.records.set("staffProfiles/other-staff",{companyId,active:true,displayName:"Other"});
 const before=snapshot(h);await assert.rejects(h.registry(input("person",{staffId:"other-staff",personKey:"a".repeat(64),active:true})));
 assert.equal(snapshot(h),before);
});
await test("person key rotation retires old proof and rejects its old mail receipt",async()=>{
 const h=harness();await h.receive();const r=await h.registry(personInput(h,{personKey:"b".repeat(64)}));
 assert.equal(h.records.get(h.paths.person).active,false);assert.equal(h.records.get(h.paths.personOwner).personKey,"b".repeat(64));
 const next=h.records.get("automationPeople/"+h.key(companyId,"b".repeat(64)));assert.equal(next.revision,r.revision);assert.equal(next.active,true);
 const held=await h.receive({...h.incoming,sourceRecordId:"old-person-reply"});assert.equal(held.route,"hold");
});
await test("same staff cannot acquire two current person keys in a race",async()=>{
 const h=harness();const out=await Promise.allSettled([h.registry(personInput(h,{personKey:"b".repeat(64)})),h.registry(personInput(h,{personKey:"c".repeat(64)}))]);
 assert.equal(out.filter(x=>x.status==="fulfilled").length,1);assert.equal(h.list("automationPeople").filter(x=>x.active).length,1);
});
await test("inactive staff cannot get active proof but may be disabled",async()=>{
 const h=harness();h.records.get(h.paths.staff).active=false;const before=snapshot(h);
 await assert.rejects(h.registry(personInput(h)));assert.equal(snapshot(h),before);
 await h.registry(personInput(h,{active:false}));assert.equal(h.records.get(h.paths.person).active,false);assert.equal(h.records.get(h.paths.personOwner).active,false);
});
await test("routing switch requires both source shutdown and old reply continuity",async()=>{
 const h=harness();for(const fields of [{},{sourceMailCreationStopped:true},{oldRepliesRetained:true}]){
 const before=snapshot(h);await assert.rejects(h.registry(input("routing",{phase:"app",...fields},"policy-1")));assert.equal(snapshot(h),before);}
 const r=await h.registry(input("routing",{phase:"app",sourceMailCreationStopped:true,oldRepliesRetained:true},"policy-1"));
 assert.equal(h.records.get(h.paths.policy).noticeOwner,"notice_control");assert.equal(h.records.get(h.paths.policy).revision,r.revision);
 assert.equal((await h.receive()).intakeOwner,"app");
 const before=snapshot(h);await assert.rejects(h.registry(input("routing",{phase:"mail_bridge"},r.revision)));assert.equal(snapshot(h),before);
});
await test("principal can only register the current authenticated admin, and may disable intake",async()=>{
 const h=harness();const r=await h.registry(input("principal",{producerId:"synthetic-producer",active:false},"principal-1"));
 assert.equal(h.records.get(h.paths.sender).uid,h.admin.uid);assert.equal(h.records.get(h.paths.sender).revision,r.revision);
 const before=snapshot(h);await assert.rejects(h.receive(),{code:"permission-denied"});assert.equal(snapshot(h),before);
 await assert.rejects(h.registry(input("principal",{producerId:"other-producer",active:true},r.revision)));
});
for(const [name,auth]of [["missing",null],["staff",{uid:"synthetic-user",token:{companyId,role:"staff",staffId}}]])
 await test("registry rejects "+name+" auth",async()=>{const h=harness(),before=snapshot(h);await assert.rejects(h.registry(bindingInput(h),auth));assert.equal(snapshot(h),before);});
await test("missing source confirmation and extra self-declared verified fields rejected",async()=>{
 const h=harness();for(const patch of [{confirmedAgainstSource:false},{evidenceRecordId:""},{verification:"verified"},{companyId:"foreign"}]){
 const before=snapshot(h);await assert.rejects(h.registry({...bindingInput(h),...patch}));assert.equal(snapshot(h),before);}
});
await test("registry -> verified campaign fixture -> mail receipt -> staff assignment",async()=>{
 const h=harness();clearRegistry(h);
 await h.registry(input("principal",{producerId:"synthetic-producer",active:true}));
 await h.registry(personInput(h));await h.registry(bindingInput(h));
 const policyResult=await h.registry(input("routing",{phase:"mail_bridge"}));
 const binding=h.records.get(h.paths.binding),job=h.records.get(h.paths.job),policy=h.records.get(h.paths.policy);
 const campaign=h.core.prepareCaseMailCampaign({companyId,policy,sourceValidation:{ok:true,reasons:[]},
 draft:{state:"PREVIEW",operationId:"registered-campaign",area:"normal",cases:[{id:binding.fixedCaseId,day:workDate}]},
 records:[{binding,job:{...job,id:jobId},revision:"0"}]});
 h.records.set("automationCampaigns/"+campaign.operationKey,{companyId,producerId:"synthetic-producer",verification:"verified",evidenceRecordId:"synthetic-campaign-proof",campaign});
 await h.registry(input("routing",{phase:"app",sourceMailCreationStopped:true,oldRepliesRetained:true},policyResult.revision));
 const receipt=await h.receive({...h.incoming,campaignKey:campaign.operationKey});assert.equal(receipt.route,"review");
 const candidate=h.list("automationApplications")[0];await h.apply(candidate);
 assert.equal(h.list("automationApplications")[0].status,"assigned");assert.equal(h.list("sheetSyncQueue").length,1);
});

await test("registration read returns current revisions and only selected business fields",async()=>{
 const h=harness();h.records.get(h.paths.job).privatePayroll="DO_NOT_RETURN";h.records.get(h.paths.staff).email="DO_NOT_RETURN";
 const before=snapshot(h);
 for(const data of [{kind:"binding",jobId},{kind:"person",staffId},{kind:"principal"},{kind:"routing"}]){
   const result=await h.registryRead(data);assert.equal(result.ok,true);assert.ok(result.record.revision);
   assert.ok(!JSON.stringify(result).includes("DO_NOT_RETURN"));
 }
 assert.equal(snapshot(h),before);
});
await test("registration read does not disclose other companies or permit staff access",async()=>{
 const h=harness();h.records.set("jobs/foreign-job",{companyId:"foreign",caseId:"foreign-case"});
 await assert.rejects(h.registryRead({kind:"binding",jobId:"foreign-job"}));
 await assert.rejects(h.registryRead({kind:"routing"},h.staff),{code:"permission-denied"});
 await assert.rejects(h.registryRead({kind:"principal",uid:"someone-else"}));
});
await test("person owner with another staff ID cannot confirm an assigned binding",async()=>{
 const h=harness();Object.assign(h.records.get(h.paths.job),{status:"assigned",assignedStaffId:staffId});
 h.records.get(h.paths.personOwner).staffId="other-staff";
 const before=snapshot(h);await assert.rejects(h.registry(bindingInput(h,{assignment:{staffId,personKey:"a".repeat(64),proofEpoch:"epoch-1"}})));
 assert.equal(snapshot(h),before);
});


await test("未確定の登録を中止し、旧要求の再送を拒否する",async()=>{
 const h=harness(),request=bindingInput(h),original=JSON.stringify(h.records.get(h.paths.binding));
 const result=await h.registryCancel(request);assert.equal(result.outcome,"cancelled");
 const before=snapshot(h);await assert.rejects(h.registry(request),error=>error.code==="failed-precondition"&&error.details?.reason==="registry_attempt_cancelled");
 assert.equal(snapshot(h),before);assert.equal(JSON.stringify(h.records.get(h.paths.binding)),original);
 assert.equal((await h.registryCancel(request)).outcome,"cancelled");assert.equal(snapshot(h),before);
});
await test("保存応答を失った登録は中止せず、保存済みの結果を返す",async()=>{
 const h=harness(),request=bindingInput(h);h.loseResponse=true;await assert.rejects(h.registry(request));
 const before=snapshot(h),result=await h.registryCancel(request);assert.equal(result.outcome,"committed");
 assert.equal(result.revision,h.records.get(h.paths.binding).revision);assert.equal(snapshot(h),before);
});
await test("登録と中止の競合は片方に確定し、登録内容を巻き戻さない",async()=>{
 for(const reverse of [false,true]){
  const h=harness(),request=bindingInput(h),before=JSON.stringify(h.records.get(h.paths.binding));
  const out=await Promise.allSettled(reverse?[h.registryCancel(request),h.registry(request)]:[h.registry(request),h.registryCancel(request)]);
  const cancellation=out[reverse?0:1],save=out[reverse?1:0];assert.equal(cancellation.status,"fulfilled");
  if(cancellation.value.outcome==="committed"){assert.equal(save.status,"fulfilled");assert.equal(cancellation.value.revision,save.value.revision);}
  else{assert.equal(save.status,"rejected");assert.equal(JSON.stringify(h.records.get(h.paths.binding)),before);}
  assert.equal(h.list("automationRegistryEvents").length,1);
 }
});
await test("中止の応答消失を再確認し、新要求の保存を許可",async()=>{
 const h=harness(),request=bindingInput(h);h.loseResponse=true;await assert.rejects(h.registryCancel(request));
 assert.equal((await h.registryCancel(request)).outcome,"cancelled");
 assert.equal((await h.registry({...request,requestId:"synthetic-fresh-request"})).ok,true);
});
await test("中止に別内容・別権限・不正な状態を流用しない",async()=>{
 const h=harness(),request=bindingInput(h);await h.registryCancel(request);const before=snapshot(h);
 await assert.rejects(h.registryCancel({...request,evidenceRecordId:"other"}),{code:"already-exists"});
 await assert.rejects(h.registryCancel(request,h.staff),{code:"permission-denied"});assert.equal(snapshot(h),before);
 const event=h.list("automationRegistryEvents")[0];h.records.get("automationRegistryEvents/"+event.id).status="unknown";
 await assert.rejects(h.registryCancel(request),{code:"failed-precondition"});await assert.rejects(h.registry(request),{code:"failed-precondition"});
});


await test("画面が確認した会社・管理者を保存と中止・読取に照合する",async()=>{
 const h=harness(),request=bindingInput(h),before=snapshot(h);
 for(const context of [{expectedCompanyId:"other",expectedActorUid:h.admin.uid},{expectedCompanyId:companyId,expectedActorUid:"other"},{expectedCompanyId:companyId}]){
  await assert.rejects(h.registry({...request,...context}),{code:"permission-denied"});
  await assert.rejects(h.registryCancel({...request,...context}),{code:"permission-denied"});
  await assert.rejects(h.registryRead({kind:"principal",...context}),{code:"permission-denied"});
 }
 assert.equal(snapshot(h),before);
});
await test("所属照合の追加で旧要求の再確認ハッシュを変えない",async()=>{
 const h=harness(),request=bindingInput(h),saved=await h.registry(request);
 const context={expectedCompanyId:companyId,expectedActorUid:h.admin.uid};
 assert.equal((await h.registry({...request,...context})).revision,saved.revision);
 assert.equal((await h.registryCancel({...request,...context})).outcome,"committed");
 assert.equal((await h.registryRead({kind:"binding",jobId,...context})).record.revision,saved.revision);
 assert.equal(h.list("automationRegistryEvents").length,1);
});

console.log(JSON.stringify({scope:"actual-registry-intake-and-assignment-synthetic-transactions",results,passed:results.filter(r=>r.ok).length,total:results.length,realCloud:false},null,2));
process.exitCode=results.every(r=>r.ok)?0:1;
