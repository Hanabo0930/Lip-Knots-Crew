import { fixture } from "./case-mail-assignment-harness.mjs";

import assert from "node:assert/strict";
import { setup } from "./case-mail-publication-harness.mjs";
import { clone, plain, companyId } from "./case-mail-test-harness.mjs";
let count=0;
async function test(name,fn){try{await fn();count++;console.log("成功: "+name);}catch(error){error.message=name+": "+error.message;throw error;}}
await test("受信→募集→応募→担当確認→B列反映→再取込の一往復",async()=>{
 const h=await fixture();const response=await h.apply();assert.equal(response.ok,true);
 assert.equal(h.job().status,"assigned");assert.equal(h.job().applicationUnconfirmed,true);assert.equal(h.lock().active,true);
 await h.confirm();assert.equal(h.job().applicationAdminConfirmed,true);assert.equal(h.job().applicationUnconfirmed,true);
 await assert.rejects(h.importRow(),{code:"failed-precondition"});assert.equal(h.job().assignedStaffId,"staff-1");assert.equal(h.job().applicationUnconfirmed,true);
 await h.run();assert.equal(h.queue().status,"completed");assert.equal(h.row[1],"合成スタッフ");assert.equal(h.writes.length,1);
 assert.equal(h.writes[0].requestBody.valueInputOption,"RAW");assert.deepEqual(plain(h.writes[0].requestBody.data),[{range:"'2099.10'!B2",values:[["合成スタッフ"]]}]);
 assert.equal(h.row[25],"=SUM(X2:Y2)");assert.equal(h.row[26],"protected");
 await h.importRow();assert.equal(h.job().applicationUnconfirmed,false);assert.equal(h.job().applicationAdminConfirmed,true);
 assert.equal(h.job().assignedStaffId,"staff-1");await h.run();assert.equal(h.writes.length,1);
 assert.equal(h.list("notificationQueue").length,2);
});
for(const [name,change]of [
 ["古い表示版",h=>h.commandApply.expectedJobRevision--],["版なし旧画面",h=>delete h.commandApply.expectedJobRevision],
 ["募集確認なし",h=>delete h.job().mailPublication],["確認内容差替",h=>h.job().menuConditions=["変更"]],
 ["受信保留",h=>h.records.get(h.paths.receipt).status="review"],["受信他社",h=>h.records.get(h.paths.receipt).companyId="other"],
 ["候補版変更",h=>h.records.get(h.paths.candidate).revision++],["所有先変更",h=>h.records.get("caseMailJobSources/"+h.job().mailIntake.sourceKey).jobId="other"],
 ["原本他社",h=>h.source().companyId="other"],["原本条件変更",h=>h.source().values.workTime="変更"],
 ["受信保留フラグ",h=>h.job().mailIntakeReviewRequired=true],
 ["別メール保留フラグ",h=>h.job().mailTargetHold={receiptId:"held"}],
])await test("応募は"+name+"で一切確定しない",async()=>{
 const h=await fixture();change(h);const before=JSON.stringify([...h.records]);
 await assert.rejects(h.apply(),error=>{
  assert.equal(error.code,"failed-precondition");
  // 保留フラグは募集停止の入口で拒否する。版照合に到達した場合だけ再試行用の証明を返す。
  if(name==="受信保留フラグ"||name==="別メール保留フラグ"){
    assert.match(error.message,/募集を終了/);assert.equal(error.details,undefined);
  }else{
    assert.equal(error.details.reason,"case_mail_job_changed");assert.equal(error.details.accepted,false);
    assert.equal(error.details.requestId,h.commandApply.requestId);
  }
  return true;
 });
 assert.equal(JSON.stringify([...h.records]),before);
});
await test("応募と同時の受信変更はtransaction再読で拒否",async()=>{
 const h=await fixture();let once=false;h.beforeCommit=async({writes})=>{if(!once&&writes.some(w=>w.data.operation==="job.assign")){once=true;h.records.get(h.paths.receipt).status="review";}};
 await assert.rejects(h.apply(),{code:"failed-precondition"});assert.equal(h.list("idempotencyKeys").length,0);assert.equal(h.list("sheetSyncQueue").length,0);
});
await test("同じ案件への二人同時応募は一人だけ確定",async()=>{
 const h=await fixture(),other={uid:"staff-user2",token:{companyId,staffId:"staff-2",role:"staff"}};
 const results=await Promise.allSettled([h.apply(),h.apply({...h.commandApply,requestId:"request-synthetic-2"},other)]);
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(h.list("staffDayLocks").length,1);assert.equal(h.list("sheetSyncQueue").length,1);assert.equal(h.list("idempotencyKeys").length,1);assert.equal(h.list("notificationQueue").length,2);
});
await test("同じスタッフの同日別案件への同時応募は一枠だけ",async()=>{
 const h=await fixture(),native=clone(h.job());delete native.mailIntake;delete native.mailPublication;h.records.set("jobs/native-second",native);
 const results=await Promise.allSettled([h.apply(),h.apply({jobId:"native-second",requestId:"request-synthetic-2"})]);
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(h.list("sheetSyncQueue").length,1);assert.equal(h.list("staffDayLocks").length,1);
});
await test("別会社・停止スタッフは確定しない",async()=>{
 for(const patch of [{companyId:"other"},{active:false}]){const h=await fixture();Object.assign(h.records.get("staffProfiles/staff-1"),patch);await assert.rejects(h.apply(),{code:"permission-denied"});assert.equal(h.list("sheetSyncQueue").length,0);}
});
await test("保存失敗は担当・勤務枠・通知・受領記録を残さない",async()=>{
 const h=await fixture(),before=JSON.stringify([...h.records]);h.failCommit=true;await assert.rejects(h.apply());assert.equal(JSON.stringify([...h.records]),before);
});
await test("応答喪失後の同じ操作は変更受信後も受付結果だけ回収",async()=>{
 const h=await fixture();h.loseResponse=true;await assert.rejects(h.apply());await h.changeMail();const before=JSON.stringify([...h.records]);
 const result=await h.apply();assert.equal(result.ok,true);assert.equal(JSON.stringify([...h.records]),before);
 assert.equal(h.job().mailIntakeReviewRequired,true);assert.equal(h.job().assignmentSheetWrite,null);assert.equal(h.list("sheetSyncQueue").length,1);
 await assert.rejects(h.apply({...h.commandApply,expectedJobRevision:h.job().revision}),{code:"failed-precondition"});assert.equal(JSON.stringify([...h.records]),before);
});
await test("実施日当日の応募は既存ルールどおり許可し募集操作とは区別",async()=>{
 const h=await fixture(),today=h.load("./notification-time").tokyoParts(new Date()).dateKey;
 // 実時刻に依存せず、募集時確認と同日の既存応募ルールを直接検査。
 const tx={getAll:async(...refs)=>Promise.all(refs.map(ref=>ref.get()))};
 const futureDay=new Date(h.job().workDate+"T03:00:00Z");
 const out=await h.load("./case-mail-publication").readMailPublication(tx,h.jobId,h.job(),h.job().revision,futureDay,"apply");
 assert.equal(out.issue,null);assert.ok(today);
 assert.ok((await h.load("./case-mail-publication").readMailPublication(tx,h.jobId,h.job(),h.job().revision,futureDay)).issue);
});
await test("変更受信は確定済み担当と勤務枠を保持し管理者確認と原本反映を止める",async()=>{
 const h=await fixture();await h.apply();await h.confirm();await h.changeMail();
 assert.equal(h.job().assignedStaffId,"staff-1");assert.equal(h.lock().active,true);assert.equal(h.job().applicationAdminConfirmed,false);
 await assert.rejects(h.confirm(),{code:"failed-precondition"});await h.run();assert.equal(h.queue().status,"blocked");assert.equal(h.writes.length,0);assert.equal(h.reads,0);
});
await test("管理者確認と同時の受信変更は確認保存を残さない",async()=>{
 const h=await fixture();await h.apply();let once=false;h.beforeCommit=async({writes})=>{if(!once&&writes.some(w=>w.data.applicationAdminConfirmed===true)){once=true;h.job().mailIntakeReviewRequired=true;}};
 await assert.rejects(h.confirm(),{code:"failed-precondition"});assert.equal(h.job().applicationAdminConfirmed,false);
});
for(const [name,change]of [
 ["受信保留",h=>h.job().mailIntakeReviewRequired=true],["勤務条件変更",h=>h.job().menuConditions=["変更"]],
 ["未反映編集",h=>h.job().pendingSourceWrite=true],["照合記録欠落",h=>delete h.job().assignmentSheetWrite.confirmation],
 ["担当取消",h=>{h.job().status="cancelled";h.job().cancelled=true;}],
])await test("書戻し前の"+name+"は原本に触れない",async()=>{
 const h=await fixture();await h.apply();change(h);await h.run();assert.equal(h.queue().status,"blocked");assert.equal(h.writes.length,0);assert.equal(h.reads,0);
});
for(const [name,index]of [["取引先",9],["店名",10],["メーカー",11],["メニュー",12],["入店",13],["勤務時間",14],["担当空白",1]])await test("原本の"+name+"変更をB列書込前に検出",async()=>{
 const h=await fixture();await h.apply();h.row[index]=index===1?" ":"変更";await h.run();assert.equal(h.queue().status,"blocked");assert.equal(h.writes.length,0);
});
await test("最終原本読取中の変更受信は書込直前に拒否",async()=>{
 const h=await fixture();await h.apply();h.afterCellRead=async()=>{if(h.cellReads===3)await h.changeMail();};
 await h.run();assert.equal(h.queue().status,"blocked");assert.equal(h.writes.length,0);
});
await test("書込後に受信が変わった場合は結果確認待ちで自動再送しない",async()=>{
 const h=await fixture();await h.apply();h.afterWrite=()=>h.changeMail();await h.run();
 assert.equal(h.queue().errorType,"verification_required");assert.equal(h.writes.length,1);assert.equal(h.job().applicationUnconfirmed,true);
 await h.run();assert.equal(h.writes.length,1);
});
await test("原本メニュー条件変更の再取込で管理者確認と旧書戻し記録が失効",async()=>{
 const h=await fixture();await h.apply();await h.confirm();h.row[1]="合成スタッフ";h.row[12]+="（服装指定）";await h.importRow();
 assert.equal(h.job().assignedStaffId,"staff-1");assert.equal(h.job().applicationAdminConfirmed,false);assert.equal(h.job().assignmentSheetWrite,null);
 await h.run();assert.equal(h.queue().status,"blocked");assert.equal(h.writes.length,0);
});
await test("空欄入店時刻と同じ原本なら担当反映できる",async()=>{
 const h=await fixture();h.row[13]="";await h.importRow();await h.publishNow();h.commandApply.expectedJobRevision=h.job().revision;await h.apply();await h.run();assert.equal(h.queue().status,"completed");
});
console.log("受信案件の応募・担当・原本整合 "+count+"条件成功");
