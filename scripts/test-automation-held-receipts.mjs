import assert from "node:assert/strict";
import {harness,companyId,staffId,jobId} from "./automation-intake-test-harness.mjs";
const clone=value=>JSON.parse(JSON.stringify(value));
const state=h=>JSON.stringify([...h.records]);
let count=0;
async function test(name,fn){try{await fn();count++;console.log("PASS "+name);}catch(error){throw Error(name,{cause:error});}}
async function fixture({resolve=true,personKey,legacy=false}={}){
 const h=harness();h.appMode();h.records.get(h.paths.person).verification="pending";
 const incoming=personKey===undefined?h.incoming:{...h.incoming,applicantPersonKey:personKey};
 const received=await h.receive(incoming),path="automationApplicationReceipts/"+received.receiptKey;
 if(legacy)delete h.records.get(path).revision;
 if(resolve)h.records.get(h.paths.person).verification="verified";
 const read={expectedCompanyId:companyId,expectedActorUid:h.admin.uid,receiptKey:received.receiptKey};
 const snapshot=await h.readHeld(read);
 const input={...read,requestId:"review-request",expectedReceiptRevision:snapshot.receiptRevision,
   expectedReviewRevision:snapshot.reviewRevision,evidenceRecordId:"synthetic-recheck-proof",confirmedAgainstSource:true};
 return {h,path,read,snapshot,input};
}
await test("resolved proof returns original held receipt to staff confirmation without assignment",async()=>{
 const {h,path,snapshot,input}=await fixture();assert.equal(snapshot.route,"hold");assert.equal(snapshot.current.route,"review");
 const before=clone(h.records.get(path)),job=clone(h.records.get(h.paths.job));
 const out=await h.recheckHeld(input);assert.equal(out.route,"review");assert.equal(out.assignmentPerformed,false);assert.equal(out.dispatch,"disabled");
 const saved=h.records.get(path);assert.deepEqual(saved.incoming,before.incoming);assert.equal(JSON.stringify(saved.createdAt),JSON.stringify(before.createdAt));
 assert.equal(saved.receivedBy,before.receivedBy);assert.equal(saved.revision,2);assert.equal(saved.lastReviewEvidenceRecordId,input.evidenceRecordId);
 assert.deepEqual(h.records.get(h.paths.job),job);assert.equal(h.list("sheetSyncQueue").length,0);assert.equal(h.list("notificationQueue").length,0);
 const list=await h.listApplications();assert.equal(list.items.length,1);assert.equal(list.items[0].state,"ready");
 const candidate=h.list("automationApplications")[0];await h.apply(candidate);assert.equal(h.records.get(h.paths.job).assignedStaffId,staffId);
});
await test("unresolved proof remains held with prior reasons kept in review history",async()=>{
 const {h,path,input}=await fixture({resolve:false});const original=clone(h.records.get(path));
 const out=await h.recheckHeld(input);assert.equal(out.route,"hold");assert.equal(out.applicationId,null);
 assert.equal(h.list("automationApplications").length,0);assert.deepEqual(h.records.get(path).incoming,original.incoming);
 assert.deepEqual(h.list("automationReceiptReviewEvents")[0].previousReasons,original.reasons);
});
await test("null identity cannot infer a staff member or accept an arbitrary selector",async()=>{
 const {h,input,snapshot}=await fixture({personKey:null});assert.equal(snapshot.hasApplicantIdentity,false);assert.equal(snapshot.current.route,"hold");
 await assert.rejects(h.recheckHeld({...input,staffId}));const out=await h.recheckHeld(input);assert.equal(out.route,"hold");assert.equal(h.list("automationApplications").length,0);
});
await test("old receipt has explicit revision zero and can be manually reviewed",async()=>{
 const {h,path,input,snapshot}=await fixture({legacy:true});assert.equal(snapshot.receiptRevision,0);
 await h.recheckHeld(input);assert.equal(h.records.get(path).revision,1);
});
await test("lost response replays the saved outcome after later job changes",async()=>{
 const {h,path,input}=await fixture();h.loseResponse=true;await assert.rejects(h.recheckHeld(input),/response lost/);
 h.records.get(h.paths.job).revision=99;const before=state(h);
 const out=await h.recheckHeld(clone(input));assert.equal(out.duplicate,true);assert.equal(out.route,"review");assert.equal(state(h),before);
 assert.equal(h.records.get(path).revision,2);assert.equal(h.list("automationReceiptReviewEvents").length,1);
});
await test("failed commit leaves original hold and no partial candidate or review event",async()=>{
 const {h,input}=await fixture();h.failCommit=true;const before=state(h);await assert.rejects(h.recheckHeld(input),/commit failure/);assert.equal(state(h),before);
 h.failCommit=false;await h.recheckHeld(input);assert.equal(h.list("automationApplications").length,1);
});
await test("same request cannot substitute its source evidence",async()=>{
 const {h,input}=await fixture();await h.recheckHeld(input);const before=state(h);
 await assert.rejects(h.recheckHeld({...input,evidenceRecordId:"other-proof"}),{code:"already-exists"});assert.equal(state(h),before);
});
await test("parallel copy of the same review creates one candidate revision",async()=>{
 const {h,path,input}=await fixture();const out=await Promise.all([h.recheckHeld(input),h.recheckHeld(clone(input))]);
 assert.equal(out.filter(row=>row.duplicate).length,1);assert.equal(h.records.get(path).revision,2);assert.equal(h.list("automationApplications")[0].revision,1);
 assert.equal(h.list("automationReceiptReviewEvents").length,1);
});
await test("different review requests against one receipt revision have one winner",async()=>{
 const {h,path,input}=await fixture();const out=await Promise.allSettled([h.recheckHeld(input),h.recheckHeld({...input,requestId:"second-review"})]);
 assert.equal(out.filter(row=>row.status==="fulfilled").length,1);assert.equal(h.records.get(path).revision,2);
 assert.equal(h.list("automationReceiptReviewEvents").length,1);
});
await test("receipt already in review does not start a second recovery operation",async()=>{
 const {h,read,input}=await fixture();await h.recheckHeld(input);const out=await h.readHeld(read);
 assert.equal(out.route,"review");assert.equal(out.reviewRevision,null);assert.equal(out.current,null);
 const before=state(h);await assert.rejects(h.recheckHeld({...input,requestId:"new-review"}),{code:"aborted"});assert.equal(state(h),before);
});
await test("existing same-staff candidate is versioned and previous confirmation becomes stale",async()=>{
 const {h,input}=await fixture();await h.receive({...h.incoming,sourceRecordId:"second-reply"});
 const previous=h.list("automationApplications")[0];await h.recheckHeld(input);
 const next=h.list("automationApplications")[0];assert.equal(h.list("automationApplications").length,1);assert.equal(next.revision,previous.revision+1);
 const before=state(h);await assert.rejects(h.apply(previous),{code:"failed-precondition"});assert.equal(state(h),before);
});
await test("review under legacy mail ownership cannot bypass staff app cutover",async()=>{
 const {h,read,input}=await fixture();h.records.get(h.paths.policy).phase="mail_bridge";
 const latest=await h.readHeld(read);const out=await h.recheckHeld({...input,expectedReviewRevision:latest.reviewRevision});
 assert.equal(out.intakeOwner,"legacy_mail");const candidate=h.list("automationApplications")[0];
 await assert.rejects(h.apply(candidate),{code:"failed-precondition"});assert.equal(h.records.get(h.paths.job).status,"open");
});
for(const [name,auth]of [["missing",null],["staff",{uid:"staff-user",token:{companyId,role:"staff",staffId}}]])
 await test("read and review require admin: "+name,async()=>{
 const {h,read,input}=await fixture();const before=state(h);await assert.rejects(h.readHeld(read,auth));await assert.rejects(h.recheckHeld(input,auth));assert.equal(state(h),before);
 });
for(const [name,change]of [
 ["company",(_h,_path,input)=>{input.expectedCompanyId="other-company";}],
 ["actor",(_h,_path,input)=>{input.expectedActorUid="other-admin";}],
 ["unconfirmed source",(_h,_path,input)=>{input.confirmedAgainstSource=false;}],
 ["missing evidence",(_h,_path,input)=>{input.evidenceRecordId="";}],
 ["stale receipt revision",(_h,_path,input)=>{input.expectedReceiptRevision=0;}],
 ["stale review token",(_h,_path,input)=>{input.expectedReviewRevision="f".repeat(64);}],
 ["principal changed",(h)=>{h.records.get(h.paths.sender).revision="principal-next";}],
 ["principal revoked",(h)=>{h.records.get(h.paths.sender).active=false;}],
 ["person proof changed",(h)=>{h.records.get(h.paths.person).revision="person-next";h.records.get(h.paths.personOwner).revision="person-next";}],
 ["person owner changed",(h)=>{h.records.get(h.paths.personOwner).active=false;}],
 ["staff deactivated",(h)=>{h.records.get(h.paths.staff).active=false;}],
 ["job revision changed",(h)=>{h.records.get(h.paths.job).revision=1;}],
 ["job cancellation",(h)=>{h.records.get(h.paths.job).cancelled=true;}],
 ["policy changed",(h)=>{h.records.get(h.paths.policy).revision="policy-next";}],
 ["phase changed without revision",(h)=>{h.records.get(h.paths.policy).phase="mail_bridge";}],
 ["binding changed",(h)=>{h.records.get(h.paths.binding).revision="binding-next";h.records.get(h.paths.bindingOwner).revision="binding-next";}],
 ["receipt original ID replaced",(h,path)=>{h.records.get(path).incoming.sourceRecordId="different-original";}],
 ["foreign receipt",(h,path)=>{h.records.get(path).companyId="other-company";}],
 ["unknown receipt route",(h,path)=>{h.records.get(path).route="sent";}],
 ["hold with candidate ID",(h,path)=>{h.records.get(path).applicationId="f".repeat(64);}],
 ])await test("changed confirmation rejects without recovery writes: "+name,async()=>{
 const {h,path,input}=await fixture();change(h,path,input);const before=state(h);
 await assert.rejects(h.recheckHeld(input));assert.equal(state(h),before);assert.equal(h.list("automationReceiptReviewEvents").length,0);
 });
for(const [name,change]of [
 ["person owner",(h)=>{h.records.get(h.paths.personOwner).active=false;}],
 ["job content",(h)=>{h.records.get(h.paths.job).revision=1;}],
 ["principal",(h)=>{h.records.get(h.paths.sender).revision="principal-next";}],
 ])await test("commit conflict rechecks "+name+" before saving",async()=>{
 const {h,path,input}=await fixture();let changed=false;
 h.beforeCommit=({writes})=>{if(!changed&&writes.some(row=>row.ref.path.startsWith("automationReceiptReviewEvents/"))){changed=true;change(h);}};
 await assert.rejects(h.recheckHeld(input));assert.equal(h.records.get(path).route,"hold");assert.equal(h.records.get(path).revision,1);
 assert.equal(h.list("automationApplications").length,0);assert.equal(h.list("automationReceiptReviewEvents").length,0);assert.ok(h.attempts>=3);
 });
await test("changed source person during an unresolved hold invalidates original review",async()=>{
 const {h,path,input}=await fixture({resolve:false});
 h.records.get(path).incoming.applicantPersonKey="b".repeat(64);
 const before=state(h);await assert.rejects(h.recheckHeld(input),{code:"aborted"});assert.equal(state(h),before);
});
await test("saved recovery result with another receipt key is not returned as success",async()=>{
 const {h,input}=await fixture();await h.recheckHeld(input);
 const event=h.records.get("automationReceiptReviewEvents/"+h.key(companyId,h.admin.uid,input.requestId));event.result.receiptKey="f".repeat(64);
 const before=state(h);await assert.rejects(h.recheckHeld(input));assert.equal(state(h),before);
});
await test("held list is scoped, bounded to 25, and pages without duplicating records",async()=>{
 const {h,path,input}=await fixture({resolve:false});
 for(let n=0;n<30;n++)await h.receive({...h.incoming,sourceRecordId:"page-reply-"+n});
 const base=clone(h.records.get(path));h.records.set("automationApplicationReceipts/"+"f".repeat(64),{...base,companyId:"foreign"});
 h.records.set("automationApplicationReceipts/"+"e".repeat(64),{...base,route:"review"});
 const args={expectedCompanyId:companyId,expectedActorUid:h.admin.uid},before=state(h);h.readCounts.clear();
 const first=await h.listHeld(args);assert.equal(first.items.length,25);assert.ok(first.nextCursor);
 const second=await h.listHeld({...args,cursor:first.nextCursor});assert.equal(second.items.length,6);assert.equal(second.nextCursor,null);
 assert.equal(new Set([...first.items,...second.items].map(row=>row.receiptKey)).size,31);assert.equal(state(h),before);
 for(const row of first.items){assert.equal(Object.hasOwn(row,"applicantPersonKey"),false);assert.equal(Object.hasOwn(row,"receivedBy"),false);}
 assert.equal(h.readCounts.get("query:automationApplicationReceipts"),2);
 assert.equal(h.readCounts.has(h.paths.job),false);
});
await test("empty held list is distinct from a failed query",async()=>{
 const {h,path}=await fixture();h.records.delete(path);const args={expectedCompanyId:companyId,expectedActorUid:h.admin.uid};
 const empty=await h.listHeld(args);assert.equal(empty.items.length,0);assert.equal(empty.nextCursor,null);
 h.failRead="query:automationApplicationReceipts";await assert.rejects(h.listHeld(args),/read failure/);
});
await test("held list rejects wrong owner, invalid cursor and unexpected selectors",async()=>{
 const {h}=await fixture(),args={expectedCompanyId:companyId,expectedActorUid:h.admin.uid},before=state(h);
 for(const patch of [{expectedCompanyId:"foreign"},{expectedActorUid:"other"},{cursor:"bad"},{staffId}])await assert.rejects(h.listHeld({...args,...patch}));
 await assert.rejects(h.listHeld(args,h.staff));await assert.rejects(h.listHeld(args,null));assert.equal(state(h),before);
});
await test("a corrupt held receipt causes a visible read error instead of a shortened successful list",async()=>{
 const {h,path}=await fixture();h.records.get(path).incoming.sourceRecordId="replaced";
 await assert.rejects(h.listHeld({expectedCompanyId:companyId,expectedActorUid:h.admin.uid}));
});
await test("reviewed receipt leaves held list and retains source history",async()=>{
 const {h,path,input}=await fixture(),original=clone(h.records.get(path).incoming);
 await h.recheckHeld(input);assert.equal((await h.listHeld({expectedCompanyId:companyId,expectedActorUid:h.admin.uid})).items.length,0);
 assert.deepEqual(h.records.get(path).incoming,original);
});

await test("cancellation blocks a delayed review without changing original hold",async()=>{
 const {h,path,input}=await fixture(),original=state(h),record=clone(h.records.get(path));
 const cancelled=await h.cancelHeld(input);assert.equal(cancelled.outcome,"cancelled");
 await assert.rejects(h.recheckHeld(input),error=>error.code==="failed-precondition"&&JSON.stringify(error.details)===JSON.stringify({reason:"held_review_cancelled",requestId:input.requestId,receiptKey:input.receiptKey,accepted:false}));
 assert.deepEqual(clone(h.records.get(path)),record);assert.equal(h.list("automationApplications").length,0);
 const after=state(h);assert.equal((await h.cancelHeld(input)).outcome,"cancelled");assert.equal(state(h),after);
});
await test("cancellation after committed review returns saved result without rollback",async()=>{
 const {h,path,input}=await fixture();const result=await h.recheckHeld(input),before=state(h);
 const out=await h.cancelHeld(input);assert.equal(out.outcome,"committed");assert.equal(out.result.receiptRevision,result.receiptRevision);
 assert.equal(h.records.get(path).route,"review");assert.equal(state(h),before);
});
await test("cancel acknowledgement loss and reopening retain the same tombstone",async()=>{
 const {h,input}=await fixture();h.loseResponse=true;await assert.rejects(h.cancelHeld(input),/response lost/);
 const out=await h.cancelHeld(clone(input));assert.equal(out.outcome,"cancelled");
 await assert.rejects(h.recheckHeld(input));assert.equal(h.list("automationReceiptReviewEvents").length,1);
});
await test("cancellation race resolves either committed or cancelled, never two outcomes",async()=>{
 const {h,path,input}=await fixture();const outcomes=await Promise.allSettled([h.recheckHeld(input),h.cancelHeld(input)]);
 const cancellation=outcomes[1];assert.equal(cancellation.status,"fulfilled");
 const event=h.list("automationReceiptReviewEvents")[0];
 if(cancellation.value.outcome==="committed"){assert.equal(event.status,"committed");assert.equal(h.records.get(path).route,"review");}
 else{assert.equal(event.status,"cancelled");assert.equal(h.records.get(path).route,"hold");assert.equal(h.list("automationApplications").length,0);}
});
await test("cancel scope and request payload remain bound to the original review",async()=>{
 const {h,input}=await fixture();await h.recheckHeld(input);const before=state(h);
 for(const changed of [{...input,evidenceRecordId:"other-proof"},{...input,expectedCompanyId:"other-company"},{...input,expectedActorUid:"other-admin"}])await assert.rejects(h.cancelHeld(changed));
 await assert.rejects(h.cancelHeld(input,h.staff));await assert.rejects(h.cancelHeld(input,null));assert.equal(state(h),before);
});
await test("older completed events remain readable but unknown event state is rejected",async()=>{
 const {h,input}=await fixture();await h.recheckHeld(input);const event=h.records.get("automationReceiptReviewEvents/"+h.key(companyId,h.admin.uid,input.requestId));
 delete event.status;assert.equal((await h.cancelHeld(input)).outcome,"committed");
 event.status="unknown";await assert.rejects(h.cancelHeld(input));await assert.rejects(h.recheckHeld(input));
});

console.log("Held receipt review passed: "+count+" conditions; original receipts retained, no external systems used.");
