import assert from "node:assert/strict";
import {targetResolutionFixture} from "./case-mail-target-resolution-harness.mjs";
import {clone,companyId} from "./case-mail-test-harness.mjs";
const results=[],filter=process.argv[2];
async function test(name,run){if(filter&&!name.includes(filter))return;try{await run();results.push({name,passed:true});console.log("成功: "+name);}catch(e){results.push({name,passed:false,error:e.stack});console.error("失敗: "+name+"\n"+e.stack);}}
const protectedKeys=["mailIntake","mailIntakeHold","mailReview","caseId","assignedStaffId","assignedStaffName","cancellationFinancialTreatment","expenses","basePay","makerName","menuConditions"];
for(const options of [{assigned:true},{assigned:false},{kind:"cancel"},{native:true,assigned:false}])await test("編集・取消・原本再取込から解除 "+JSON.stringify(options),async()=>{
 const h=await targetResolutionFixture(options),before=clone(h.job()),n=h.writes.length,locks=clone(h.list("staffDayLocks"));
 const view=(await h.targetPreview()).resolution;assert.equal(view.canResolve,true,view.issue);await h.resolveTarget();
 assert.equal(h.job().mailTargetHold,undefined);assert.equal(h.job().mailIntakeReviewRequired,false);assert.equal(h.job().publishable,false);assert.equal(h.job().recruitmentStopped,true);
 for(const k of protectedKeys)assert.deepEqual(h.job()[k],before[k],k);
 assert.equal(h.writes.length,n);assert.deepEqual(h.list("staffDayLocks"),locks);assert.equal((await h.targetPreview()).state,"resolved");
 await h.reimport();assert.equal(h.job().publishable,false);assert.equal(h.job().recruitmentStopped,true);
});
await test("応答喪失・同時再送は解除1回",async()=>{const h=await targetResolutionFixture(),cmd=await h.resolutionCommand();h.loseResponse=true;await assert.rejects(h.resolveTarget(cmd));const before=JSON.stringify([...h.records]);assert.ok((await Promise.all([h.resolveTarget(cmd),h.resolveTarget(cmd)])).every(x=>x.replayed));assert.equal(JSON.stringify([...h.records]),before);});
await test("保存失敗は3記録を一括維持",async()=>{const h=await targetResolutionFixture(),cmd=await h.resolutionCommand(),before=JSON.stringify([...h.records]);h.failCommit=true;await assert.rejects(h.resolveTarget(cmd));assert.equal(JSON.stringify([...h.records]),before);});
for(const patch of [{expectedCompanyId:"other"},{expectedActorUid:"other"},{reviewVersion:"a".repeat(64)},{confirmed:false},{note:""},{jobId:"missing"},{extra:true}])await test("入力拒否 "+JSON.stringify(patch),async()=>{const h=await targetResolutionFixture(),cmd={...await h.resolutionCommand(),...patch},before=JSON.stringify([...h.records]);await assert.rejects(h.resolveTarget(cmd));assert.equal(JSON.stringify([...h.records]),before);});
for(const auth of [null,{uid:"staff",token:{role:"staff",companyId}},{uid:"other",token:{role:"admin",companyId:"other"}}])await test("権限拒否 "+JSON.stringify(auth),async()=>{const h=await targetResolutionFixture(),cmd=await h.resolutionCommand(),before=JSON.stringify([...h.records]);await assert.rejects(h.resolveTarget(cmd,auth));assert.equal(JSON.stringify([...h.records]),before);});
for(const key of ["stale-source","source-values","pending","lock","proposal","principal","origin-owner","previous-state"])await test("解除条件不足 "+key,async()=>{
 const h=await targetResolutionFixture();
 if(key==="stale-source")h.source().readStartedAtMs=0;
 if(key==="source-values")h.source().values.makerName="不一致";
 if(key==="pending")h.job().pendingSourceWrite=true;
 if(key==="lock")h.lock().jobId="other";
 if(key==="proposal")h.records.get("caseMailIntakeCandidates/"+h.targetCandidateId).input.makerName="別条件";
 if(key==="principal")h.records.get(h.paths.principal).active=false;
 if(key==="origin-owner")h.records.get("caseMailJobSources/"+h.job().mailIntake.sourceKey).companyId="other";
 if(key==="previous-state")delete h.job().mailTargetHold.previousReviewRequired;
 await assert.rejects(h.resolveTarget());assert.ok(h.job().mailTargetHold);
});
for(const key of ["job","receipt","source","lock","origin"])await test("保存競合 "+key,async()=>{
 const h=await targetResolutionFixture(),cmd=await h.resolutionCommand();let once=false;
 h.beforeCommit=({writes})=>{if(once||!writes.some(w=>w.data.action==="caseMail.target.resolve"))return;once=true;
 if(key==="job")h.job().revision++;if(key==="receipt")h.records.get("caseMailIntakeReceipts/"+h.targetReceiptId).revision++;
 if(key==="source")h.source().values.makerName="競合";if(key==="lock")h.lock().jobId="other";if(key==="origin")h.records.get(h.paths.receipt).revision++;};
 await assert.rejects(h.resolveTarget(cmd));assert.ok(h.job().mailTargetHold);assert.equal(h.list("auditLogs").filter(x=>x.action==="caseMail.target.resolve").length,0);
});
await test("元メールの未解決保留を残す",async()=>{const h=await targetResolutionFixture();await h.receiveChange();await h.reimport();const original=clone(h.job().mailIntakeHold);assert.equal((await h.targetPreview()).resolution.originReviewRequired,true);await h.resolveTarget();assert.equal(h.job().mailIntakeReviewRequired,true);assert.deepEqual(h.job().mailIntakeHold,original);assert.equal(h.job().mailTargetHold,undefined);});
await test("元メール解決済みの記録を保持",async()=>{const h=await targetResolutionFixture({ready:false});await h.receiveChange();await h.applyChange();
 // 両メールが同じ現在条件を求める状態。元メールの確認記録は保留前に完了した履歴として用意する。
 const receipt=h.records.get(h.paths.receipt);h.job().mailReview={receiptId:h.job().mailIntake.receiptId,candidateId:h.job().mailIntake.candidateId,receiptRevision:receipt.revision,analysisHash:receipt.heldAnalysisHash,reviewVersion:"a".repeat(64)};
 h.records.get("caseMailIntakeCandidates/"+h.targetCandidateId).input.storeName=h.job().storeName;
 await h.edit({makerName:h.input.makerName});await h.runEdit();await h.reimport();await h.resolveTarget();assert.equal(h.job().mailIntakeReviewRequired,false);assert.equal(h.job().mailReview.reviewVersion,"a".repeat(64));
});
await test("解除後の再解析で再保留・古い解除不可",async()=>{const h=await targetResolutionFixture(),cmd=await h.resolutionCommand();await h.resolveTarget(cmd);await h.receiveTarget({sourceFingerprint:"e".repeat(64)});assert.equal(h.job().mailIntakeReviewRequired,true);assert.equal(h.job().mailTargetHold.receiptRevision,2);await assert.rejects(h.resolveTarget(cmd));await h.reimport();assert.equal((await h.targetPreview()).resolution.canResolve,true);await h.resolveTarget();assert.equal(h.list("auditLogs").filter(x=>x.action==="caseMail.target.resolve").length,2);});
await test("解除後の不完全な再解析は解除しない",async()=>{const h=await targetResolutionFixture();await h.resolveTarget();await h.receiveTarget({structuralComplete:false});await h.reimport();assert.equal((await h.targetPreview()).resolution.canResolve,false);await assert.rejects(h.resolveTarget());});
await test("解除監査が欠けた再解析は全体失敗",async()=>{const h=await targetResolutionFixture();await h.resolveTarget();for(const [p,v]of h.records)if(v.action==="caseMail.target.resolve")h.records.delete(p);const before=JSON.stringify([...h.records]);await assert.rejects(h.receiveTarget({sourceFingerprint:"e".repeat(64)}));assert.equal(JSON.stringify([...h.records]),before);});
await test("取消の原本表示・金銭処理が不足したら維持",async()=>{const h=await targetResolutionFixture({kind:"cancel"});h.job().cancellationFinancialTreatment=null;await assert.rejects(h.resolveTarget());assert.ok(h.job().mailTargetHold);});
console.log(JSON.stringify({passed:results.filter(x=>x.passed).length,total:results.length,results,cloudAccess:false},null,2));if(results.some(x=>!x.passed))process.exitCode=1;
