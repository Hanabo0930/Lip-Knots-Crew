import assert from "node:assert/strict";
import {targetResolutionFixture} from "./case-mail-target-resolution-harness.mjs";
import {clone,companyId,Timestamp} from "./case-mail-test-harness.mjs";
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

async function resolvedCancellation(options={}){
 const h=await targetResolutionFixture({kind:"cancel",...options});await h.resolveTarget();
 h.evidencePaths={candidate:"caseMailIntakeCandidates/"+h.targetCandidateId,receipt:"caseMailIntakeReceipts/"+h.targetReceiptId};
 const R=h.job().mailTargetReview;
 h.evidencePaths.audit="auditLogs/"+h.key("case-mail-target-resolution",R.companyId,R.receiptId,R.candidateId,R.receiptRevision,R.analysisHash);
 return h;
}
async function unchangedRefusal(h){const before=JSON.stringify([...h.records]);await assert.rejects(h.reimport(),{code:"failed-precondition"});assert.equal(JSON.stringify([...h.records]),before);}
await test("取消履歴: 正規解除後の反復・他案件lock・元proof保持",async()=>{
 const h=await resolvedCancellation(),before=clone(h.job()),proof=clone(before.cancellationSheetWrite);
 const helper=h.load("./cancellation-history-retention-core");
 assert.equal(helper.cancellationHistoricalTargetRead(before,{...before,jobId:h.jobId}).auditId,h.evidencePaths.audit.slice("auditLogs/".length));
 const lockPath="staffDayLocks/"+companyId+"_"+before.assignedStaffId+"_"+before.dateKey;
 h.records.set(lockPath,{companyId,staffId:before.assignedStaffId,dateKey:before.dateKey,jobId:"other-active-job",active:true});
 const lock=clone(h.records.get(lockPath));
 for(let i=0;i<3;i++){await h.reimport();assert.deepEqual(h.job().cancellationSheetWrite,proof);assert.deepEqual(h.records.get(lockPath),lock);for(const k of [...protectedKeys,"cancellationReason","mailTargetReview"])assert.deepEqual(h.job()[k],before[k],k);assert.equal(h.job().mailTargetHold,undefined);}
});
await test("取消履歴: 未保存analysisHashの正規解除も互換保持",async()=>{const h=await resolvedCancellation({legacyHash:true}),proof=clone(h.job().cancellationSheetWrite);await h.reimport();assert.deepEqual(h.job().cancellationSheetWrite,proof);h.records.get(h.evidencePaths.candidate).input.makerName="tampered";await unchangedRefusal(h);});
for(const field of ["audit","candidate","receipt"])await test("取消履歴: 証跡欠落 "+field,async()=>{const h=await resolvedCancellation();h.records.delete(h.evidencePaths[field]);await unchangedRefusal(h);});
const mutations=[
 ["audit会社",h=>h.records.get(h.evidencePaths.audit).companyId="other"],
 ["audit操作",h=>h.records.get(h.evidencePaths.audit).action="other"],
 ["audit実行者",h=>h.records.get(h.evidencePaths.audit).actorUid="other"],
 ["audit時刻",h=>h.records.get(h.evidencePaths.audit).createdAt=Timestamp.fromMillis(1)],
 ["audit解除本文",h=>h.records.get(h.evidencePaths.audit).resolution.note="tampered"],
 ["候補linked",h=>h.records.get(h.evidencePaths.candidate).linkedJobId="other"],
 ["候補取消",h=>h.records.get(h.evidencePaths.candidate).status="cancelled"],
 ["受信ready",h=>h.records.get(h.evidencePaths.receipt).status="ready"],
 ["候補会社",h=>h.records.get(h.evidencePaths.candidate).companyId="other"],
 ["候補受信",h=>h.records.get(h.evidencePaths.candidate).receiptId="other"],
 ["候補版",h=>h.records.get(h.evidencePaths.candidate).revision++],
 ["候補解除",h=>h.records.get(h.evidencePaths.candidate).targetResolution.note="tampered"],
 ["候補新保留",h=>h.records.get(h.evidencePaths.candidate).heldChange={version:1}],
 ["binding案件",h=>h.records.get(h.evidencePaths.candidate).targetBinding.jobId="other"],
 ["binding版",h=>h.records.get(h.evidencePaths.candidate).targetBinding.reviewVersion="f".repeat(64)],
 ["出典指紋",h=>h.records.get(h.evidencePaths.candidate).sourceFingerprint="e".repeat(64)],
 ["出典part",h=>h.records.get(h.evidencePaths.candidate).source.partId="other"],
 ["出典hash",h=>h.records.get(h.evidencePaths.candidate).source.sha256="f".repeat(64)],
 ["受信会社",h=>h.records.get(h.evidencePaths.receipt).companyId="other"],
 ["受信版",h=>h.records.get(h.evidencePaths.receipt).revision++],
 ["受信解析hash",h=>h.records.get(h.evidencePaths.receipt).analysisHash="f".repeat(64)],
 ["受信再解析",h=>h.records.get(h.evidencePaths.receipt).heldAnalysisHash="f".repeat(64)],
 ["受信候補欠落",h=>h.records.get(h.evidencePaths.receipt).candidateIds=[]],
 ["受信候補重複",h=>h.records.get(h.evidencePaths.receipt).candidateIds.push(h.targetCandidateId)],
 ["未検証受信",h=>h.records.get(h.evidencePaths.receipt).verification="unverified"],
 ["不完全受信",h=>h.records.get(h.evidencePaths.receipt).structuralComplete=false],
 ["proof担当",h=>h.job().cancellationSheetWrite.sourceAckProof.staffId="other"],
 ["proof日時",h=>h.job().cancellationSheetWrite.sourceAckProof.confirmedAtMs=0],
 ["ACK待ち",h=>h.job().cancellationSheetWrite.sourceAckPending=true],
 ["現担当",h=>h.job().assignedStaffId="other"],
 ["物理氏名非空",h=>h.row[1]="合成スタッフ"],
 ["原本理由矛盾",h=>h.row[3]="別理由"],
 ["新hold",h=>h.job().mailTargetHold={...h.job().mailTargetReview.hold,receiptRevision:2}],
 ["未来解除",h=>{for(const item of [h.job().mailTargetReview,h.records.get(h.evidencePaths.audit).resolution,h.records.get(h.evidencePaths.candidate).targetResolution])item.confirmedAt=Timestamp.fromMillis(Date.now()+60000);h.records.get(h.evidencePaths.audit).createdAt=h.job().mailTargetReview.confirmedAt;}],
 ["解除前proof",h=>h.job().cancellationSheetWrite.sourceAckProof.confirmedAtMs=h.job().mailTargetReview.confirmedAt.toMillis()+1],
];
for(const [label,mutate]of mutations)await test("取消履歴: 改変拒否 "+label,async()=>{const h=await resolvedCancellation();mutate(h);await unchangedRefusal(h);});
for(const field of ["audit","candidate","receipt"])await test("取消履歴: 証跡CAS競合 "+field,async()=>{
 const h=await resolvedCancellation();let once=false;const original=clone(h.job().cancellationSheetWrite);
 h.beforeCommit=({writes})=>{if(once||!writes.some(w=>w.ref.path===h.path))return;once=true;const value=h.records.get(h.evidencePaths[field]);if(field==="audit")value.actorUid="other";else value.companyId="other";};
 await assert.rejects(h.reimport(),{code:"failed-precondition"});assert.equal(once,true);assert.deepEqual(h.job().cancellationSheetWrite,original);
});
await test("取消履歴: 応答喪失後の再送は元proofを維持",async()=>{const h=await resolvedCancellation(),proof=clone(h.job().cancellationSheetWrite);h.loseResponse=true;await assert.rejects(h.reimport());await h.reimport();assert.deepEqual(h.job().cancellationSheetWrite,proof);assert.equal(h.list("staffDayLocks").filter(l=>l.active).length,0);});
await test("取消履歴: 通常取消ACK一致とlegacyに証跡読取なし",async()=>{
 const h=await targetResolutionFixture({kind:"cancel"}),core=h.load("./cancellation-history-retention-core"),before=clone(h.job());
 assert.equal(core.cancellationHistoricalTargetRead(before,{...before,jobId:h.jobId}),null);
 assert.deepEqual(core.cancellationHistoricalTargetContext(before,{...before,jobId:h.jobId},undefined,Date.now()),before);
 assert.equal(core.cancellationHistoricalTargetRead(undefined,{companyId,jobId:"legacy"}),null);
 await h.reimport();assert.deepEqual(h.job().cancellationSheetWrite,before.cancellationSheetWrite);
});

for(const count of [25,26])await test("取消履歴: "+count+"案件chunkの証跡読取とproof保持",async()=>{
 const h=await resolvedCancellation(),proof=clone(h.job().cancellationSheetWrite),rows=Array.from({length:count},(_,i)=>{if(i===0)return h.row;const row=clone(h.row);row[2]="";row[3]="";row[9]=row[9].replace("（キャンセル）","");row[54]="SYNTHETIC-CASE-"+String(i).padStart(4,"0");return row;});
 let chunks=0;h.beforeCommit=({reads,writes})=>{if(!writes.some(w=>w.ref.path.startsWith("jobs/")))return;chunks++;for(const key of Object.values(h.evidencePaths)){assert.equal([...reads].filter(([path])=>path===key).length,chunks===1?1:0);}};
 await h.importRows(rows);assert.equal(chunks,count===25?1:2);assert.deepEqual(h.job().cancellationSheetWrite,proof);assert.equal(h.job().mailTargetHold,undefined);
});
await test("取消履歴: 後半chunkの証跡欠落で前半のみcommitし取消は不変",async()=>{
 const h=await resolvedCancellation(),job=clone(h.job()),rows=Array.from({length:25},(_,i)=>{const row=clone(h.row);row[2]="";row[3]="";row[9]=row[9].replace("（キャンセル）","");row[54]="SYNTHETIC-CASE-"+String(i).padStart(4,"0");return row;});rows.push(h.row);h.records.delete(h.evidencePaths.audit);const before=h.list("jobs").length;
 await assert.rejects(h.importRows(rows),{code:"failed-precondition"});assert.equal(h.list("jobs").length,before+25);assert.deepEqual(h.job(),job);
});
await test("取消履歴: 非零給与・経費の正規解除後保持",async()=>{const h=await resolvedCancellation({paid:true}),before=clone(h.job());assert.equal(before.basePay,6500);assert.equal(before.financials.staffPaymentTotal,8000);assert.equal(before.expenses.purchase8,1200);await h.reimport();for(const key of ["basePay","financials","expenses","cancellationFinancialTreatment","cancellationSheetWrite"])assert.deepEqual(h.job()[key],before[key],key);});

for(const field of ["caseId","dateKey","workDate","sheetRef","assignedStaffName"])await test("取消履歴: 比較専用投影も基礎identity変更を拒否 "+field,async()=>{
 const h=await resolvedCancellation(),core=h.load("./cancellation-history-retention-core"),old=clone(h.job()),input={...old,jobId:h.jobId};
 if(field==="assignedStaffName")old.assignedStaffName="別の履歴名";else if(field==="sheetRef")input.sheetRef={...input.sheetRef,sheetId:99};else input[field]="other";
 const evidence=Object.fromEntries(Object.entries(h.evidencePaths).map(([key,path])=>[key,h.records.get(path)])),before=JSON.stringify([...h.records]);
 assert.throws(()=>{const projection=core.cancellationHistoricalTargetContext(old,input,evidence,Date.now());core.retainedCancellationAssignment(projection,input,false);});assert.equal(JSON.stringify([...h.records]),before);
});
console.log(JSON.stringify({passed:results.filter(x=>x.passed).length,total:results.length,results,cloudAccess:false},null,2));if(results.some(x=>!x.passed))process.exitCode=1;
