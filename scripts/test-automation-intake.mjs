import assert from "node:assert/strict";
import {harness,companyId,staffId,jobId,workDate} from "./automation-intake-test-harness.mjs";
const results=[];
async function test(name,fn){try{await fn();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:error.stack});}}
const state=h=>JSON.stringify([...h.records]);
await test("receipt persisted without assignment; old campaign follows new app policy",async()=>{
 const h=harness();h.appMode();const r=await h.receive();
 assert.equal(r.route,"review");assert.equal(r.intakeOwner,"app");assert.equal(r.assignmentPerformed,false);
 assert.equal(h.list("automationApplicationReceipts").length,1);assert.equal(h.list("automationApplications").length,1);
 assert.equal(h.list("sheetSyncQueue").length,0);assert.equal(h.records.get(h.paths.job).status,"open");
 assert.ok(!JSON.stringify(r).includes("applicantPersonKey"));
});
await test("simultaneous copies commit one receipt and candidate",async()=>{
 const h=harness();const out=await Promise.all([h.receive(),h.receive(),h.receive()]);
 assert.equal(out.filter(r=>!r.duplicate).length,1);assert.equal(h.list("automationApplicationReceipts").length,1);
 assert.equal(h.list("automationApplications")[0].revision,1);assert.ok(h.attempts>3);
});
await test("different replies preserve two histories and one candidate; stale view rejected",async()=>{
 const h=harness();h.appMode();await h.receive();const previous=h.list("automationApplications")[0];
 await h.receive({...h.incoming,sourceRecordId:"synthetic-reply-2"});
 assert.equal(h.list("automationApplicationReceipts").length,2);assert.equal(h.list("automationApplications").length,1);
 const before=state(h);await assert.rejects(h.apply(previous),{code:"failed-precondition"});assert.equal(state(h),before);
});
await test("same receipt content replacement rejected with no writes",async()=>{
 const h=harness();await h.receive();const before=state(h);
 await assert.rejects(h.receive({...h.incoming,applicantPersonKey:"b".repeat(64)}),{code:"already-exists"});assert.equal(state(h),before);
});
await test("commit failure saves neither record; lost acknowledgement replays once",async()=>{
 const h=harness();const before=state(h);h.failCommit=true;await assert.rejects(h.receive());assert.equal(state(h),before);
 h.failCommit=false;h.loseResponse=true;await assert.rejects(h.receive());const after=state(h);
 assert.equal((await h.receive()).duplicate,true);assert.equal(state(h),after);
});
for(const [name,change]of [
 ["no authentication",h=>h.admin=null],["staff producer",h=>h.admin={...h.admin,token:{companyId,role:"staff",staffId}}],
 ["disabled principal",h=>h.records.get(h.paths.sender).active=false],
 ["foreign principal",h=>h.records.get(h.paths.sender).companyId="foreign"],
 ["wrong producer",h=>h.records.get(h.paths.sender).producerId="foreign"],
 ["unverified campaign",h=>h.records.get(h.paths.campaign).verification="pending"],
 ["missing policy",h=>h.records.delete(h.paths.policy)],
 ["foreign binding",h=>h.records.get(h.paths.binding).companyId="foreign"],
])await test(name+" rejects without persistence",async()=>{
 const h=harness();change(h);const before=state(h);await assert.rejects(h.receive(h.incoming,h.admin));assert.equal(state(h),before);
});
for(const [name,change]of [
 ["unverified person",h=>h.records.get(h.paths.person).verification="pending"],
 ["disabled profile",h=>h.records.get(h.paths.staff).active=false],
 ["cancelled job",h=>h.records.get(h.paths.job).cancelled=true],
 ["unpublished job",h=>h.records.get(h.paths.job).publishable=false],
 ["changed job revision",h=>h.records.get(h.paths.job).revision=1],
 ["changed binding revision",h=>{h.records.get(h.paths.binding).revision="binding-2";h.records.get(h.paths.bindingOwner).revision="binding-2";}],
])await test(name+" retains hold history without candidate",async()=>{
 const h=harness();change(h);const r=await h.receive();assert.equal(r.route,"hold");
 assert.equal(h.list("automationApplicationReceipts").length,1);assert.equal(h.list("automationApplications").length,0);
});
await test("real apply handler atomically assigns receipt candidate and ordinary sheet queue",async()=>{
 const h=harness();h.appMode();await h.receive();const candidate=h.list("automationApplications")[0];const r=await h.apply(candidate);
 assert.equal(r.ok,true);assert.equal(h.list("automationApplications")[0].status,"assigned");
 assert.equal(h.records.get(h.paths.lock).jobId,jobId);assert.equal(h.list("sheetSyncQueue").length,1);
 assert.equal(h.list("notificationQueue").length,2);assert.equal(h.records.get(h.paths.job).applicationUnconfirmed,true);
 assert.equal(h.records.get(h.paths.job).assignmentSheetWrite.queueId,h.list("sheetSyncQueue")[0].id);
 const before=state(h);await h.apply(candidate);assert.equal(state(h),before);
});
for(const [name,change]of [
 ["legacy owner",h=>h.records.get(h.paths.policy).phase="mail_bridge"],
 ["changed person proof",h=>h.records.get(h.paths.person).revision="person-2"],
 ["revoked person",h=>h.records.get(h.paths.person).active=false],
 ["revoked sender",h=>h.records.get(h.paths.sender).active=false],
 ["changed sender proof",h=>h.records.get(h.paths.sender).revision="principal-2"],
 ["changed content",h=>h.records.get(h.paths.job).revision=1],
 ["changed campaign",h=>h.records.get(h.paths.campaign).campaign.sourceHash="f".repeat(64)],
 ["same-day conflict",h=>h.records.set(h.paths.lock,{companyId,staffId,dateKey:workDate,jobId:"another-job",active:true})],
])await test("acceptance rechecks "+name,async()=>{
 const h=harness();h.appMode();await h.receive();const candidate=h.list("automationApplications")[0];change(h);
 const before=state(h);await assert.rejects(h.apply(candidate));assert.equal(state(h),before);
});
await test("another staff cannot claim candidate",async()=>{
 const h=harness();h.appMode();await h.receive();const candidate=h.list("automationApplications")[0];
 h.records.set("staffProfiles/other-staff",{companyId,active:true,displayName:"Other Synthetic Staff"});
 const before=state(h);await assert.rejects(h.apply(candidate,"other-request",{uid:"other-user",token:{companyId,role:"staff",staffId:"other-staff"}}),{code:"permission-denied"});assert.equal(state(h),before);
});
await test("normal app and mail confirmation race produces exactly one assignment",async()=>{
 const h=harness();h.appMode();await h.receive();const candidate=h.list("automationApplications")[0];
 const out=await Promise.allSettled([h.apply(candidate),h.apply(null,"normal-request")]);
 assert.equal(out.filter(x=>x.status==="fulfilled").length,1);assert.equal(h.list("sheetSyncQueue").length,1);assert.equal(h.list("notificationQueue").length,2);
});
await test("profile revoked at commit retries and refuses all assignment writes",async()=>{
 const h=harness();h.appMode();await h.receive();const candidate=h.list("automationApplications")[0];let changed=false;
 h.beforeCommit=({writes})=>{if(!changed&&writes.some(w=>w.ref.path.startsWith("sheetSyncQueue/"))){changed=true;h.records.get(h.paths.staff).active=false;}};
 await assert.rejects(h.apply(candidate),{code:"permission-denied"});assert.equal(h.list("sheetSyncQueue").length,0);
 assert.equal(h.list("automationApplications")[0].status,"review");assert.equal(h.records.get(h.paths.job).status,"open");
});
await test("same request ID cannot switch to an unrelated mail candidate",async()=>{
 const h=harness();await h.apply(null);const before=state(h);
 await assert.rejects(h.apply({id:"f".repeat(64),revision:1}),{code:"failed-precondition"});assert.equal(state(h),before);
});
await test("receipt identity cannot include raw email, names or arbitrary job selectors",async()=>{
 const h=harness();for(const patch of [{email:"synthetic@example.invalid"},{staffId:"other"},{jobId:"other"}]){
 const before=state(h);await assert.rejects(h.receive({...h.incoming,...patch}));assert.equal(state(h),before);}
});
console.log(JSON.stringify({scope:"local-synthetic-actual-intake-and-apply-transactions",results,passed:results.filter(r=>r.ok).length,total:results.length,realFirestore:false,realSending:false},null,2));
process.exitCode=results.every(r=>r.ok)?0:1;

