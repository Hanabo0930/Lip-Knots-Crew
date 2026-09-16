import assert from "node:assert/strict";
import fs from "node:fs";
import {createRequire} from "node:module";
import {createHash} from "node:crypto";
import {harness,companyId,staffId,jobId,workDate} from "./automation-intake-test-harness.mjs";
const require=createRequire(import.meta.url),{Timestamp}=require("firebase-admin/firestore");
const copy=value=>JSON.parse(JSON.stringify(value)),snapshot=h=>JSON.stringify([...h.records]);
const results=[],digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function test(name,run){try{await run();results.push({name,passed:true});console.log("PASS "+name);}catch(error){results.push({name,passed:false,error:error.stack});console.error("FAIL "+name,error);}}
function fixture(){
 const h=harness();h.records.get(h.paths.binding).assignment={staffId,personKey:"a".repeat(64),proofEpoch:"synthetic-epoch-1"};
 Object.assign(h.records.get(h.paths.job),{status:"assigned",assignedStaffId:staffId,applicationUnconfirmed:false,assignmentUnresolved:false});
 return h;
}
const scope=h=>({expectedCompanyId:companyId,expectedActorUid:h.admin.uid,jobId});
const read=h=>h.handoff(scope(h));
const submit=(h,change={})=>h.precontact({jobId,dateKey:workDate,temperature:36.5,arrivalTime:"9:30",...change});
const contact=h=>h.records.get(h.paths.job).preContact;
function generation(h){h.records.get(h.paths.binding).revision="binding-2";h.records.get(h.paths.binding).assignment.proofEpoch="synthetic-epoch-2";h.records.get(h.paths.bindingOwner).revision="binding-2";}
function validate(out){
 const {operationKey,payloadHash,dispatch,...body}=out.handoff;
 assert.equal(payloadHash,digest(body));assert.equal(operationKey,digest(["job.snapshot",companyId,jobId,body.binding.revision,body.revision]));
 assert.equal(dispatch,"disabled");assert.equal(out.dispatch,"disabled");assert.equal(out.deliveryVerified,false);assert.equal(out.automaticRetryAllowed,false);
 assert.deepEqual(Object.keys(out.handoff).sort(),["binding","contractVersion","dispatch","kind","noticeEligible","operationKey","payloadHash","preContact","recruitmentEligible","revision","status"].sort());
}
await test("実際のメール候補から応募した直後はシフト表の担当確認待ちを返す",async()=>{
 const h=harness();h.appMode();await h.receive();const candidate=h.list("automationApplications")[0];await h.apply(candidate);
 assert.equal(h.records.get(h.paths.job).applicationUnconfirmed,true);
 const before=snapshot(h),commits=h.commits.length;h.readCounts.clear();
 await assert.rejects(submit(h),error=>error.code==="failed-precondition"&&error.details?.reason==="assignment_sheet_confirmation_pending");
 await assert.rejects(read(h),error=>error.code==="failed-precondition"&&error.details?.reason==="assignment_sheet_confirmation_pending"&&error.message.includes("シフト表"));
 assert.equal(snapshot(h),before);assert.equal(h.commits.length,commits);assert.equal(h.readCounts.has(h.paths.binding),false);
});
await test("実際の本人送信から現在の案件・本人入力を読み取り、実配信と区別する",async()=>{
 const h=fixture();await submit(h,{automationProof:{bindingRevision:"forged"},proofEpoch:"forged",source:"sheet"});
 const value=contact(h);assert.equal(value.source,"app");assert.equal(value.automationProof.bindingRevision,"binding-1");assert.equal(value.automationProof.confirmedAt instanceof Timestamp,true);
 assert.equal(h.list("sheetSyncQueue").length,1);assert.equal(h.list("auditLogs").length,1);
 const before=snapshot(h);h.readCounts.clear();const out=await read(h);validate(out);
 assert.equal(snapshot(h),before);assert.equal(out.preContactState,"linked");assert.equal(out.sheetSyncPending,true);
 assert.deepEqual(copy(out.handoff.preContact),{temperature:36.5,arrivalTime:"09:30",submittedAt:value.submittedAt.toDate().toISOString()});
 assert.deepEqual(Object.keys(out.handoff.preContact).sort(),["arrivalTime","submittedAt","temperature"]);assert.equal(h.readCounts.size,8);assert.equal(h.commits.at(-1).length,0);
 assert.equal(h.list("notifications").length,0);assert.equal(h.list("automationNoticeReceipts").length,0);
 assert.equal(JSON.stringify(out).includes("Synthetic Store"),false);assert.equal(JSON.stringify(out).includes(h.staff.uid),false);
});
await test("同じ保存状態の読み直しでは操作キーもハッシュも変わらない",async()=>{
 const h=fixture();await submit(h);const before=snapshot(h),first=await read(h),second=await read(h);assert.deepEqual(copy(second),copy(first));assert.equal(snapshot(h),before);
});
await test("案件版が同じでも入力値の変更で連携版と操作キーが変わる",async()=>{
 const h=fixture();await submit(h);const first=await read(h);await submit(h,{temperature:36.8});const second=await read(h);
 assert.equal(h.records.get(h.paths.job).revision,0);assert.notEqual(first.handoff.operationKey,second.handoff.operationKey);assert.notEqual(first.handoff.revision,second.handoff.revision);assert.equal(second.handoff.preContact.temperature,36.8);validate(second);
});
await test("現在の証跡への同一入力は0書込、再送の応答消失も二重書戻ししない",async()=>{
 const h=fixture();h.loseResponse=true;await assert.rejects(submit(h),/response lost/);const before=snapshot(h);await submit(h,{arrivalTime:"09:30"});
 assert.equal(snapshot(h),before);assert.equal(h.commits.at(-1).length,0);assert.equal(h.list("sheetSyncQueue").length,1);assert.equal((await read(h)).preContactState,"linked");
});
await test("同じ人の再手配では旧入力を外し、本人の同一値再確認で結び直す",async()=>{
 const h=fixture();await submit(h);const old=contact(h),first=await read(h);
 generation(h);const before=snapshot(h),stale=await read(h);assert.equal(snapshot(h),before);assert.equal(stale.preContactState,"unverified");assert.equal(stale.handoff.preContact,null);
 await submit(h);const linked=await read(h);assert.equal(linked.preContactState,"linked");assert.equal(contact(h).operationId,old.operationId);assert.equal(contact(h).submittedAt,old.submittedAt);
 assert.equal(contact(h).automationProof.bindingRevision,"binding-2");assert.equal(h.list("sheetSyncQueue").length,1);
 assert.equal(h.list("auditLogs").filter(row=>row.action==="precontact.confirm-automation-proof").length,1);assert.notEqual(first.handoff.revision,linked.handoff.revision);
 const final=snapshot(h);await submit(h);assert.equal(snapshot(h),final);
});
await test("台帳登録APIだけでは旧本人入力の証跡を新世代へ付け替えない",async()=>{
 const h=fixture();await submit(h);const before=copy(contact(h));
 await h.registry({kind:"binding",expectedCompanyId:companyId,expectedActorUid:h.admin.uid,requestId:"new-generation",
 expectedRevision:"binding-1",evidenceRecordId:"checked-again",confirmedAgainstSource:true,jobId,jobRevision:0,fixedCaseId:"synthetic-fixed",
 assignment:{staffId,personKey:"a".repeat(64),proofEpoch:"synthetic-epoch-2"}});
 assert.deepEqual(copy(contact(h)),before);assert.equal((await read(h)).preContactState,"unverified");
});
await test("本人台帳の再確認版も再入力前の証跡として引き継がない",async()=>{
 const h=fixture();await submit(h);h.records.get(h.paths.person).revision="person-2";h.records.get(h.paths.personOwner).revision="person-2";
 assert.equal((await read(h)).preContactState,"unverified");await submit(h);assert.equal((await read(h)).preContactState,"linked");assert.equal(h.list("sheetSyncQueue").length,1);
});
for(const [name,change] of [
 ["証跡なし",value=>delete value.automationProof],["シート入力",value=>value.source="sheet"],["別スタッフ",value=>value.staffId="other-staff"],
 ["別勤務日",value=>value.dateKey="2099-09-21"],["操作IDなし",value=>delete value.operationId],["日時が文字列",value=>value.submittedAt=value.submittedAt.toDate().toISOString()],
 ["証跡日時が文字列",value=>value.automationProof.confirmedAt=value.automationProof.confirmedAt.toDate().toISOString()],
 ["確認日時が入力より前",value=>value.automationProof.confirmedAt=Timestamp.fromMillis(0)],
 ["体温が文字列",value=>value.temperature="36.5"],["時刻不正",value=>value.arrivalTime="25:00"],
 ["証跡を残して入力差替え",value=>value.temperature=37],["証跡を残して操作差替え",value=>value.operationId="different"],
 ["証跡余剰フィールド",value=>value.automationProof.trusted=true],
])await test("推測で本人入力を付けない: "+name,async()=>{
 const h=fixture();await submit(h);change(contact(h));const before=snapshot(h),out=await read(h);
 assert.equal(out.preContactState,"unverified");assert.equal(out.handoff.preContact,null);assert.equal(snapshot(h),before);validate(out);
});
await test("事前連絡の再確認待ちは付けず、本人の新しい送信で解除する",async()=>{
 const h=fixture();await submit(h);h.records.get(h.paths.job).preContactNeedsReview=true;
 const out=await read(h);assert.equal(out.preContactState,"needs_review");assert.equal(out.handoff.noticeEligible,false);assert.equal(out.handoff.preContact,null);
 await submit(h);assert.equal((await read(h)).preContactState,"linked");assert.equal(h.records.get(h.paths.job).preContactNeedsReview,false);
});
for(const status of ["cancelled","stopped","draft"])await test("現在の停止状態を返し本人入力を付けない: "+status,async()=>{
 const h=fixture();await submit(h);h.records.get(h.paths.job).status=status;
 const before=snapshot(h),out=await read(h);assert.equal(out.handoff.status,status);assert.equal(out.handoff.preContact,null);assert.equal(out.handoff.noticeEligible,false);assert.equal(out.preContactState,"not_applicable");assert.equal(snapshot(h),before);validate(out);
});
await test("取消フラグと未割当の募集状態も誤った送信対象にしない",async()=>{
 const h=fixture();await submit(h);h.records.get(h.paths.job).cancelled=true;assert.equal((await read(h)).handoff.status,"cancelled");
 const open=harness(),out=await read(open);assert.equal(out.handoff.status,"open");assert.equal(out.handoff.recruitmentEligible,true);assert.equal(out.handoff.noticeEligible,false);assert.equal(out.preContactState,"not_applicable");assert.equal(out.handoff.preContact,null);validate(out);
});
await test("本人入力なし・両方の募集移行段階を扱いG/H確認と配信を混同しない",async()=>{
 const h=fixture();assert.equal((await read(h)).preContactState,"missing");h.appMode();await submit(h);
 let out=await read(h);assert.equal(out.policy.phase,"app");assert.equal(out.preContactState,"linked");assert.equal(out.sheetSyncPending,true);
 const key=out.handoff.operationKey;h.records.get(h.paths.job).preContactSyncPending=false;out=await read(h);assert.equal(out.sheetSyncPending,false);assert.notEqual(out.handoff.operationKey,key);assert.equal(out.deliveryVerified,false);
});
for(const [name,change,reason] of [
 ["実行者なし",h=>h.records.delete(h.paths.sender)],["実行者無効",h=>h.records.get(h.paths.sender).active=false],
 ["実行者UID違い",h=>h.records.get(h.paths.sender).uid="other-admin"],["実行者他社",h=>h.records.get(h.paths.sender).companyId="other-company"],
 ["方針なし",h=>h.records.delete(h.paths.policy)],["方針他社",h=>h.records.get(h.paths.policy).companyId="other-company"],
 ["案件なし",h=>h.records.delete(h.paths.job)],["案件他社",h=>h.records.get(h.paths.job).companyId="other-company"],
 ["不正な案件版",h=>h.records.get(h.paths.job).revision=-1],["読取元消失",h=>h.records.get(h.paths.job).sourceMissing=true,"source_unavailable"],
 ["担当未照合",h=>h.records.get(h.paths.job).assignmentUnresolved=true,"assignment_identity_unresolved"],["応募未照合",h=>h.records.get(h.paths.job).applicationUnconfirmed=true,"assignment_sheet_confirmation_pending"],
 ["フラグ型破損",h=>h.records.get(h.paths.job).cancelled="true"],["アーカイブ",h=>h.records.get(h.paths.job).status="archived","source_unavailable"],
 ["台帳なし",h=>h.records.delete(h.paths.binding)],["対応表他社",h=>h.records.get(h.paths.binding).companyId="other-company"],
 ["現在担当違い",h=>h.records.get(h.paths.job).assignedStaffId="other-staff"],["勤務日違い",h=>h.records.get(h.paths.job).dateKey="2099-09-21"],
 ["元表違い",h=>h.records.get(h.paths.job).sheetRef.spreadsheetId="other-book"],["固定ID所有なし",h=>h.records.delete(h.paths.bindingOwner)],
 ["所有版違い",h=>h.records.get(h.paths.bindingOwner).revision="other"],["固定ID所有他社",h=>h.records.get(h.paths.bindingOwner).companyId="other-company"],
 ["本人無効",h=>h.records.get(h.paths.person).active=false],["本人未確認",h=>h.records.get(h.paths.person).verification="unverified"],
 ["本人所有版違い",h=>h.records.get(h.paths.personOwner).revision="other"],["本人所有他社",h=>h.records.get(h.paths.personOwner).companyId="other-company"],
 ["スタッフ無効",h=>h.records.get(h.paths.staff).active=false],["スタッフ他社",h=>h.records.get(h.paths.staff).companyId="other-company"],
])await test("照合できない読取は副作用なく拒否: "+name,async()=>{
 const h=fixture();change(h);const before=snapshot(h);if(reason&&name!=="アーカイブ")await assert.rejects(submit(h),error=>error.code==="failed-precondition"&&error.details?.reason===reason);if(reason)await assert.rejects(read(h),error=>error.code==="failed-precondition"&&error.details?.reason===reason);else await assert.rejects(read(h));assert.equal(snapshot(h),before);assert.equal(h.list("sheetSyncQueue").length,0);
});
await test("認証なし・スタッフ・確認会社/本人変更・余分な入力を拒否",async()=>{
 const h=fixture(),before=snapshot(h);
 for(const auth of [null,h.staff])await assert.rejects(h.handoff(scope(h),auth));
 for(const change of [{expectedCompanyId:"other"},{expectedActorUid:"other"},{jobId:"../other"},{send:true}])await assert.rejects(h.handoff({...scope(h),...change}));
 assert.equal(snapshot(h),before);
});
await test("連携未登録でも通常の本人入力を保存し、同一値の書戻しは増やさない",async()=>{
 const h=fixture();h.records.delete(h.paths.binding);h.readCounts.clear();await submit(h);assert.equal(h.readCounts.size,2);assert.equal(contact(h).automationProof,null);
 const before=snapshot(h);await submit(h);assert.equal(snapshot(h),before);assert.equal(h.list("sheetSyncQueue").length,1);
});
await test("連携本人記録不明でも通常入力は保存、誤った本人証跡は付けない",async()=>{
 const h=fixture();h.records.get(h.paths.person).active=false;await submit(h);assert.equal(contact(h).automationProof,null);assert.equal(h.list("sheetSyncQueue").length,1);
});
await test("旧形式の操作IDなし入力は本人の再送信で新しく記録する",async()=>{
 const h=fixture();await submit(h);delete contact(h).operationId;delete contact(h).automationProof;
 await submit(h);assert.ok(contact(h).operationId);assert.equal(h.list("sheetSyncQueue").length,2);assert.equal((await read(h)).preContactState,"linked");
});
await test("証跡だけの再確認が失敗しても片方の記録や書戻しを残さない",async()=>{
 const h=fixture();await submit(h);generation(h);const before=snapshot(h);h.failCommit=true;await assert.rejects(submit(h));assert.equal(snapshot(h),before);
 h.failCommit=false;h.loseResponse=true;await assert.rejects(submit(h),/response lost/);await submit(h);assert.equal(h.list("sheetSyncQueue").length,1);assert.equal(h.list("auditLogs").length,2);
});
await test("並行の再確認でも本人証跡の監査と書戻しは重複しない",async()=>{
 const h=fixture();await submit(h);generation(h);await Promise.all([submit(h),submit(h)]);
 assert.equal(h.list("sheetSyncQueue").length,1);assert.equal(h.list("auditLogs").filter(row=>row.action==="precontact.confirm-automation-proof").length,1);assert.equal((await read(h)).preContactState,"linked");
});
await test("入力取引中の担当世代変更を再読取し、古い版へ結び付けない",async()=>{
 const h=fixture();let changed=false;h.beforeCommit=()=>{if(!changed){changed=true;generation(h);}};
 await submit(h);assert.equal(contact(h).automationProof.bindingRevision,"binding-2");assert.equal(h.list("sheetSyncQueue").length,1);assert.equal(h.attempts,2);
});
await test("読取中の担当世代変更を再照合し旧本人入力を返さない",async()=>{
 const h=fixture();await submit(h);let changed=false;h.beforeCommit=()=>{if(!changed){changed=true;generation(h);}};
 const out=await read(h);assert.equal(out.handoff.binding.revision,"binding-2");assert.equal(out.handoff.preContact,null);assert.equal(out.preContactState,"unverified");
});
await test("取引中の実行者失効は再読取で拒否する",async()=>{
 const h=fixture();let changed=false;h.beforeCommit=()=>{if(!changed){changed=true;h.records.get(h.paths.sender).active=false;}};
 await assert.rejects(read(h),{code:"permission-denied"});assert.equal(h.list("sheetSyncQueue").length,0);
});
await test("台帳読取失敗時は本人入力・監査・書戻しを部分保存しない",async()=>{
 const h=fixture(),before=snapshot(h);h.failRead=h.paths.binding;await assert.rejects(submit(h),/read failure/);assert.equal(snapshot(h),before);await assert.rejects(read(h));
});
await test("本人の所属・担当・勤務日を偽った再確認は拒否する",async()=>{
 for(const change of [{companyId:"other"},{staffId:"other"}]){const h=fixture(),before=snapshot(h);await assert.rejects(h.precontact({jobId,dateKey:workDate,temperature:36.5,arrivalTime:"9:30"},{...h.staff,token:{...h.staff.token,...change}}));assert.equal(snapshot(h),before);}
 const h=fixture(),before=snapshot(h);await assert.rejects(submit(h,{dateKey:"2099-09-21"}));assert.equal(snapshot(h),before);
});
if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify({scope:"local-synthetic-authenticated-notice-handoff-and-precontact",cloudAcceptanceVerified:false,results},null,2));
console.log("出発・入店用読取と本人証跡: "+results.filter(row=>row.passed).length+"/"+results.length);
process.exitCode=results.every(row=>row.passed)?0:1;
