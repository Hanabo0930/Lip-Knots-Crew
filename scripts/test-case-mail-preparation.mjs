
import assert from "node:assert/strict";
import { fixture } from "./case-mail-assignment-harness.mjs";
import { setup as notificationSetup } from "./notification-test-harness.mjs";
import { clone, plain, companyId } from "./case-mail-test-harness.mjs";
let count=0;
async function test(name,fn){try{await fn();count++;console.log("成功: "+name);}catch(error){error.message=name+": "+error.message;throw error;}}
async function assigned(){
 const h=await fixture();await h.apply();await h.run();await h.importRow();
 Object.assign(h.records.get(h.paths.mapping).columns,{temperature:"G",arrivalTime:"H"});
 h.records.get(h.paths.mapping).operations["precontact.submit"]={values:["temperature","arrivalTime"]};
 h.contact=(values={temperature:36.5,arrivalTime:"09:30"})=>h.load("./precontact").submitPreContact({auth:h.staffAuth,data:{jobId:h.jobId,dateKey:h.job().dateKey,expectedRevision:h.job().revision,...values}});
 h.contacts=()=>h.list("sheetSyncQueue").filter(q=>q.operation==="precontact.submit");
 h.runContact=async()=>{const ref=h.load("./firebase").db.doc(h.contacts().at(-1).path);await h.load("./safe-sheet-writes").processSafeSheetWrite({data:{after:await ref.get()}});return h.records.get(ref.path);};
 return h;
}
function notices(h,category="job_assigned"){
 const n=notificationSetup("2099-10-09T08:00:00+09:00"),queue=h.list("notificationQueue").find(q=>q.category===category);
 assert.ok(queue?.reminderContext);const id=queue.path.split("/").at(-1);
 n.state.records.set(queue.path,clone(queue));n.state.records.set("jobs/"+h.jobId,clone(h.job()));
 n.state.records.set("pushTokens/target",{companyId,staffId:"staff-1",role:"admin",active:true,token:"synthetic-target"});
 return Object.assign(n,{id,job:()=>n.state.records.get("jobs/"+h.jobId),send:()=>n.trigger(id)});
}
await test("受信案件の原本確認→事前連絡→G/Hだけ反映→再取込",async()=>{
 const h=await assigned();await h.contact();const saved=clone(h.job().preContact),writes=h.writes.length;
 assert.equal(saved.caseMailContext,h.load("./assignment-preparation-core").mailPreparationContext(h.job()));
 const queue=await h.runContact();assert.equal(queue.status,"completed");assert.equal(h.writes.length,writes+1);
 assert.deepEqual(plain(h.writes.at(-1).requestBody.data),[{range:"'2099.10'!G2",values:[[36.5]]},{range:"'2099.10'!H2",values:[["09:30"]]}]);
 assert.equal(h.row[25],"=SUM(X2:Y2)");assert.equal(h.row[26],"protected");
 // 共用原本フィクスチャへG/H列を追加した取込を使う。
 await h.importRow();assert.equal(h.job().preContact.caseMailContext,saved.caseMailContext);assert.equal(h.job().preContactNeedsReview,false);assert.equal(h.job().preContactSyncPending,false);
 await h.contact();assert.equal(h.contacts().length,1);
});
for(const mode of ["受信保留","原本編集待ち","編集キュー待ち"])await test(mode+"中の保存を拒否",async()=>{
 const h=await assigned();if(mode==="受信保留")await h.changeMail();if(mode==="原本編集待ち")h.job().pendingSourceWrite=true;if(mode==="編集キュー待ち")h.job().adminEditSheetWrite={pending:true};
 const before=JSON.stringify([...h.records]);await assert.rejects(h.contact(),e=>e.code==="failed-precondition"&&e.details.reason==="case_mail_review_pending");
 assert.equal(JSON.stringify([...h.records]),before);
});
await test("保存と同時の受信保留はtransaction再読で入力を残さない",async()=>{
 const h=await assigned();let once=false;h.beforeCommit=async({writes})=>{if(!once&&writes.some(w=>w.data.operation==="precontact.submit")){once=true;h.job().mailIntakeReviewRequired=true;}};
 await assert.rejects(h.contact(),{code:"failed-precondition"});assert.equal(h.contacts().length,0);
});
for(const mode of ["開始前","原本読取中","書込後"])await test("事前連絡"+mode+"の変更受信は旧内容を完了扱いにしない",async()=>{
 const h=await assigned();await h.contact();const before=h.writes.length;
 if(mode==="開始前")await h.changeMail();
 if(mode==="原本読取中")h.afterCellRead=()=>h.changeMail();
 if(mode==="書込後")h.afterWrite=()=>h.changeMail();
 const q=await h.runContact();assert.equal(q.status,"blocked");assert.equal(h.writes.length,before+(mode==="書込後"?1:0));
 if(mode==="書込後")assert.equal(q.errorType,"verification_required");
 assert.equal(h.job().preContactNeedsReview,true);assert.equal(h.job().assignedStaffId,"staff-1");assert.equal(h.lock().active,true);
});
await test("勤務条件変更は古い連絡証跡による書戻しを拒否",async()=>{
 const h=await assigned();await h.contact();h.job().menuConditions=["変更"];const before=h.writes.length;const q=await h.runContact();assert.equal(q.status,"blocked");assert.equal(h.writes.length,before);
});
await test("再取込で同じ本人の旧入力を保持し確認済みへ戻さない",async()=>{
 const h=await assigned();await h.contact();await h.runContact();const saved=clone(h.job().preContact);
 await h.changeMail();await h.importRow();assert.deepEqual(plain(h.job().preContact),plain(saved));assert.equal(h.job().preContactNeedsReview,true);
 await h.importRow();assert.deepEqual(plain(h.job().preContact),plain(saved));assert.equal(h.job().preContactNeedsReview,true);
});
await test("合成の保留解除後に本人再確認し同じ値でも新しい証跡を保存",async()=>{
 const h=await assigned();await h.contact();await h.runContact();await h.changeMail();await h.importRow();const old=h.job().preContact.operationId;
 // 保留解除の製品導線は後続。ここでは再開後の既存本人入力だけを合成する。
 h.job().mailIntakeReviewRequired=false;await h.contact();assert.notEqual(h.job().preContact.operationId,old);assert.equal(h.job().preContactNeedsReview,false);
 const before=h.writes.length;assert.equal((await h.runContact()).status,"completed");assert.equal(h.writes.length,before);
});
await test("原本の勤務条件変更を再取込したら事前連絡を再確認へ戻す",async()=>{
 const h=await assigned();await h.contact();await h.runContact();h.row[12]+="（服装変更）";await h.importRow();
 assert.equal(h.job().preContactNeedsReview,true);assert.equal(h.job().preContactLate,false);
 const prior=h.job().preContact.operationId;await h.importRow();assert.equal(h.job().preContact.operationId,prior);assert.equal(h.job().preContactNeedsReview,true);
});
for(const category of ["job_assigned","job_application_admin"])for(const confirmed of [false,true])await test(category+"は原本確認"+confirmed+"でも現在の受付案内を配信",async()=>{
 const h=confirmed?await assigned():await fixture();if(!confirmed)await h.apply();const n=notices(h,category);await n.send();assert.equal(n.state.sent.length,1);assert.equal(n.document(n.id).status,"completed");
});
for(const category of ["job_assigned","job_application_admin"])for(const [name,mutate]of [
 ["受信保留",j=>j.mailIntakeReviewRequired=true],["取消",j=>j.cancelled=true],["別担当",j=>j.assignedStaffId="other"],
 ["勤務条件変更",j=>j.menuConditions=["変更"]],["再手配",j=>j.assignedAt={toMillis:()=>1}],["所属変更",j=>j.companyId="other"],
 ["編集待ち",j=>j.pendingSourceWrite=true],
])await test(category+"の"+name+"を送信前に停止",async()=>{
 const h=await assigned(),n=notices(h,category);mutate(n.job());await n.send();assert.equal(n.state.sent.length,0);assert.equal(n.document(n.id).status,"superseded");
});
await test("端末一覧取得中の受信保留を送信直前に停止",async()=>{
 const h=await assigned(),n=notices(h);n.state.onResolve=()=>n.job().mailIntakeReviewRequired=true;await n.send();assert.equal(n.state.sent.length,0);assert.equal(n.document(n.id).status,"superseded");
});
for(const invalid of ["宛先経路","受付証跡なし","旧担当時刻"])await test("受付案内の"+invalid+"を拒否",async()=>{
 const h=await assigned(),n=notices(h);if(invalid==="宛先経路")n.document(n.id).route="/shifts/other";
 if(invalid==="受付証跡なし")delete n.document(n.id).reminderContext.assignmentContext;
 if(invalid==="旧担当時刻")n.document(n.id).reminderContext.assignedAtMs--;
 await n.send();assert.equal(n.state.sent.length,0);assert.equal(n.document(n.id).status,"superseded");
});
for(const held of [true,false])await test("事前連絡の再確認"+(held?"保留":"再開")+"と既存タスク・催促",async()=>{
 const h=await assigned(),n=notices(h);n.state.records.delete("notificationQueue/"+n.id);
 Object.assign(n.job(),{mailIntakeReviewRequired:held,preContactNeedsReview:true,preContact:{temperature:36.5,arrivalTime:"09:30"}});
 n.state.records.set("notificationSettings/"+companyId,{enabled:true,importantAnnouncementHour:2});
 await n.load("./reminder-scheduler").scheduleOperationalReminders();
 const queued=[...n.state.records].filter(([k])=>k.startsWith("notificationQueue/"));assert.equal(queued.length,held?0:1);
 const tasks=(await n.load("./staff-tasks").getMyTasks({auth:h.staffAuth,data:{}})).tasks;
 const task=tasks.find(t=>t.kind==="precontact");assert.ok(task);assert.equal(task.title,held?"受信内容・勤務条件を確認中です":"事前連絡を送ってください");
 if(held){assert.equal(task.dueAtMs,null);assert.equal(task.priority,"normal");assert.equal(tasks.length,1);}
});
await test("催促予約の最中に受信が保留されたら遅延印も予約も残さない",async()=>{
 const h=await assigned(),n=notices(h);n.state.records.delete("notificationQueue/"+n.id);n.setTime("2099-10-09T15:00:00+09:00");
 n.state.records.set("notificationSettings/"+companyId,{enabled:true,importantAnnouncementHour:2});
 let once=false;n.state.onRead=async path=>{if(!once&&path.startsWith("notificationQueue/")){once=true;n.job().mailIntakeReviewRequired=true;}};
 await n.load("./reminder-scheduler").scheduleOperationalReminders();assert.equal(once,true);assert.equal([...n.state.records].filter(([k])=>k.startsWith("notificationQueue/")).length,0);assert.notEqual(n.job().preContactLate,true);
});
await test("通知予約後の受信保留は催促を送信しない",async()=>{
 const h=await assigned(),n=notices(h);n.state.records.delete("notificationQueue/"+n.id);n.state.records.set("notificationSettings/"+companyId,{enabled:true,importantAnnouncementHour:2});
 await n.load("./reminder-scheduler").scheduleOperationalReminders();const queued=[...n.state.records].find(([k])=>k.startsWith("notificationQueue/"));
 n.job().mailIntakeReviewRequired=true;await n.trigger(queued[0].split("/").at(-1));assert.equal(n.state.sent.length,0);
});

await test("表示版が古い事前連絡は新条件への確認とみなさない",async()=>{
 const h=await assigned(),revision=h.job().revision;h.job().revision++;
 await assert.rejects(h.contact({temperature:36.5,arrivalTime:"09:30",expectedRevision:revision}),e=>e.details?.reason==="case_mail_precontact_changed");assert.equal(h.contacts().length,0);
});
for(const [name,index]of [["勤務時間",14],["入店時間",13],["メニュー条件",12]])await test("原本だけの"+name+"変更も事前連絡書込前に拒否",async()=>{
 const h=await assigned();await h.contact();h.row[index]="変更";const before=h.writes.length,q=await h.runContact();assert.equal(q.status,"blocked");assert.equal(h.writes.length,before);
});
await test("深夜まとめ通知でも保留済み受付案内を除外",async()=>{
 const h=await assigned(),n=notices(h);n.setTime("2099-10-08T23:00:00+09:00");const q=n.document(n.id);q.deliverAt=n.Timestamp.now();
 await n.send();assert.equal(n.state.sent.length,0);assert.equal(q.status,"queued");n.job().mailIntakeReviewRequired=true;
 n.setTime("2099-10-09T07:00:00+09:00");await n.tick();assert.equal(n.state.sent.length,0);
});


await test("実取消・同担当への復帰で昔の受付通知を復活させない",async()=>{
 const h=await assigned();
 await h.load("./analytics").adminSetJobCancellation({auth:h.auth,data:{jobId:h.jobId,expectedRevision:h.job().revision,reasonCategory:"other",reasonNote:"合成取消",financialTreatment:"neither"}});
 await h.load("./analytics").adminRestoreCancelledJob({auth:h.auth,data:{jobId:h.jobId,expectedRevision:h.job().revision}});
 assert.equal(h.job().status,"assigned");assert.equal(h.job().assignedStaffId,"staff-1");
 const n=notices(h);await n.send();assert.equal(n.state.sent.length,0);assert.equal(n.document(n.id).status,"superseded");
});
console.log("受信案件の通知・事前連絡統合 "+count+"条件成功（合成のみ）");
