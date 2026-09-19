import assert from "node:assert/strict";
import {targetHoldFixture} from "./case-mail-target-hold-harness.mjs";
import {setupChange} from "./case-mail-change-harness.mjs";
import {companyId,clone,plain,Timestamp} from "./case-mail-test-harness.mjs";
const results=[],filter=process.argv[2];
async function test(name,run){if(filter&&!name.includes(filter))return;try{await run();results.push({name,passed:true});console.log("成功: "+name);}catch(e){results.push({name,passed:false,error:e.stack});console.error("失敗: "+name+"\n"+e.stack);}}
const protectedFields=["companyId","caseId","workDate","dateKey","clientName","storeName","makerName","menuName","entryTime","workTime","basePay","expenses","assignedStaffId","assignedStaffName","cancelled","cancellationFinancialTreatment","mailIntake","mailIntakeHold"];
for(const kind of ["change","cancel"])await test("保留-"+kind,async()=>{
 const h=await targetHoldFixture(null,{assignedStaffId:"staff-1",assignedStaffName:"合成担当",status:"assigned",basePay:12345,expenses:{transportation:500},applicationAdminConfirmed:true});
 h.records.set("staffDayLocks/retained",{companyId,staffId:"staff-1",jobId:h.targetJobId,active:true});const before=clone(h.targetJob()),lock=clone(h.records.get("staffDayLocks/retained"));
 await h.hold({...h.holdCommand,kind});
 for(const key of protectedFields)assert.deepEqual(h.targetJob()[key],before[key],key);
 assert.equal(h.targetJob().status,"assigned");assert.equal(h.targetJob().revision,before.revision+1);assert.equal(h.targetJob().mailIntakeReviewRequired,true);assert.equal(h.targetJob().publishable,false);assert.equal(h.targetJob().recruitmentStopped,true);
 assert.equal(h.targetJob().applicationAdminConfirmed,false);assert.deepEqual(h.records.get("staffDayLocks/retained"),lock);assert.equal(h.list("sheetSyncQueue").length,0);
 assert.equal((await h.targetPreview()).state,"held");assert.equal(h.list("auditLogs").filter(x=>x.action==="caseMail.target.hold").length,1);
});
await test("応答喪失と同時再送は保留1回",async()=>{const h=await targetHoldFixture();h.loseResponse=true;await assert.rejects(h.hold());const before=JSON.stringify([...h.records]);const out=await Promise.all([h.hold(),h.hold()]);assert.ok(out.every(x=>x.replayed));assert.equal(JSON.stringify([...h.records]),before);});
await test("保存失敗は案件と監査を変更しない",async()=>{const h=await targetHoldFixture(),before=JSON.stringify([...h.records]);h.failCommit=true;await assert.rejects(h.hold());assert.equal(JSON.stringify([...h.records]),before);});
for(const patch of [{expectedCompanyId:"other"},{expectedActorUid:"other"},{confirmed:false},{kind:"unknown"},{reviewVersion:"a".repeat(64)},{jobId:"missing"},{candidateId:"missing"},{receiptId:"missing"},{extra:true}])await test("入力拒否-"+JSON.stringify(patch),async()=>{const h=await targetHoldFixture(),before=JSON.stringify([...h.records]);await assert.rejects(h.hold({...h.holdCommand,...patch}));assert.equal(JSON.stringify([...h.records]),before);});
for(const auth of [null,{uid:"staff",token:{companyId,role:"staff"}},{uid:"foreign",token:{companyId:"other",role:"admin"}}])await test("認証拒否-"+JSON.stringify(auth),async()=>{const h=await targetHoldFixture(),before=JSON.stringify([...h.records]);await assert.rejects(h.hold(h.holdCommand,auth));assert.equal(JSON.stringify([...h.records]),before);});
for(const [name,change] of [
 ["案件版",h=>h.targetJob().revision++],["受信版",h=>h.records.get("caseMailIntakeReceipts/"+h.targetReceiptId).revision++],
 ["受信実行者",h=>h.records.get(h.paths.principal).active=false],["機能停止",h=>h.records.get(h.paths.feature).caseMailIntakeEnabled=false],
 ["別会社",h=>h.targetJob().companyId="other"],["別メール保留",h=>h.targetJob().mailTargetHold={receiptId:"other"}],
])await test("古い確認-"+name,async()=>{const h=await targetHoldFixture();change(h);const before=JSON.stringify([...h.records]);await assert.rejects(h.hold());assert.equal(JSON.stringify([...h.records]),before);});
await test("保存競合を再検証",async()=>{const h=await targetHoldFixture();let once=false;h.beforeCommit=({writes})=>{if(!once&&writes.some(w=>w.data.action==="caseMail.target.hold")){once=true;h.targetJob().revision++;}};await assert.rejects(h.hold());assert.equal(h.targetJob().mailTargetHold,undefined);});
await test("公開・予約・応募を保留中に再開できない",async()=>{
 const h=await targetHoldFixture();await h.hold();
 for(const action of ["publish","schedule"]){const result=await h.publish({jobIds:[h.targetJobId],action,...(action==="schedule"?{publishAt:"2099-10-01T00:00:00Z"}:{})});assert.equal(result.updated.length,0);assert.equal(result.blocked.length,1);}
 assert.equal(h.load("./case-mail-preparation-core").caseMailPreparationHeld(h.targetJob()),true);
 assert.throws(()=>h.load("./submission-integrity").assertSubmissionReadiness(h.targetJob()));
});
await test("予約公開中の保留競合で募集を復活させない",async()=>{
 const h=await targetHoldFixture(null,{status:"scheduled",scheduledPublishAt:Timestamp.fromMillis(Date.now()-1000),publishable:false});
 let once=false;h.beforeCommit=async({writes})=>{if(!once&&writes.some(w=>w.data.status==="open")){once=true;await h.hold();}};
 await h.schedule();assert.equal(once,true);assert.equal(h.targetJob().status,"stopped");assert.equal(h.targetJob().publishable,false);assert.equal(h.targetJob().recruitmentStopped,true);
});
await test("通常予約公開の既存動作",async()=>{const h=await targetHoldFixture(null,{status:"scheduled",scheduledPublishAt:Timestamp.fromMillis(Date.now()-1000),publishable:false});await h.schedule();assert.equal(h.targetJob().status,"open");assert.equal(h.targetJob().publishable,true);});
await test("再解析・取消候補消失も保留更新し同内容を二重処理しない",async()=>{
 const h=await targetHoldFixture();await h.hold();const before=clone(h.targetJob()),patch={sourceFingerprint:"e".repeat(64),state:"review",candidates:[],parts:[],issues:["SOURCE_REVIEW"],structuralComplete:false};
 await h.receiveTarget(patch);assert.equal(h.targetJob().mailTargetHold.receiptRevision,2);assert.equal(h.targetJob().revision,before.revision+1);assert.equal((await h.targetPreview()).state,"held");
 for(const key of protectedFields)assert.deepEqual(h.targetJob()[key],before[key],key);
 const saved=JSON.stringify([...h.records]);await h.receiveTarget(patch);assert.equal(JSON.stringify([...h.records]),saved);
});
await test("再解析の不整合監査は原子的に拒否",async()=>{const h=await targetHoldFixture();await h.hold();h.list("auditLogs").filter(x=>x.action==="caseMail.target.confirm").forEach(x=>h.records.get(x.path).binding.jobId="other");const before=JSON.stringify([...h.records]);await assert.rejects(h.receiveTarget({sourceFingerprint:"e".repeat(64)}));assert.equal(JSON.stringify([...h.records]),before);});
await test("メール由来の所有元保持・原本再取込・元保留解除を保護",async()=>{
 const original=await setupChange(false);await original.receiveChange();await original.applyChange();const h=await targetHoldFixture(original),before=clone(h.targetJob()),owners=JSON.stringify(h.list("caseMailJobSources")),writes=h.writes.length;
 await h.hold();assert.deepEqual(h.targetJob().mailIntake,before.mailIntake);assert.deepEqual(h.targetJob().mailIntakeHold,before.mailIntakeHold);assert.equal(JSON.stringify(h.list("caseMailJobSources")),owners);
 await h.reimport();assert.equal(h.targetJob().publishable,false);assert.equal(h.targetJob().recruitmentStopped,true);assert.equal(h.targetJob().mailIntakeReviewRequired,true);
 assert.equal((await h.readChange()).canConfirm,false);await assert.rejects(h.resolveChange());assert.equal(h.writes.length,writes);
});
await test("旧編集キューは保留後に原本へ書かない",async()=>{
 const original=await setupChange(false);await original.edit({makerName:"編集予定"});const h=await targetHoldFixture(original),writes=h.writes.length,queueId=h.targetJob().adminEditSheetWrite.queueId;
 await h.hold();await h.runEdit();assert.equal(h.writes.length,writes);assert.notEqual(h.records.get("sheetSyncQueue/"+queueId).status,"completed");
});

await test("保留の古い受信版を再解析で上書きしない",async()=>{const h=await targetHoldFixture();await h.hold();h.targetJob().mailTargetHold.receiptRevision=99;const before=JSON.stringify([...h.records]);await assert.rejects(h.receiveTarget({sourceFingerprint:"e".repeat(64)}));assert.equal(JSON.stringify([...h.records]),before);});
await test("保留中のスタッフ応募を実APIで拒否",async()=>{for(const native of [false,true]){const original=await setupChange(false);if(native)delete original.job().mailIntake;const h=await targetHoldFixture(original);await h.hold();await assert.rejects(h.apply());assert.equal(h.assignment(),undefined);}});

console.log(JSON.stringify({passed:results.filter(x=>x.passed).length,total:results.length,results,cloudAccess:false},null,2));if(results.some(x=>!x.passed))process.exitCode=1;
