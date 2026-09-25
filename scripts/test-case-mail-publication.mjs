import ts from "typescript";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import fs from "node:fs";
import { clone, plain, companyId, Timestamp } from "./case-mail-test-harness.mjs";
import { setup } from "./case-mail-publication-harness.mjs";
let count=0;
async function test(name,run){try{await run();count++;console.log("成功: "+name);}catch(error){error.message=name+": "+error.message;throw error;}}
await test("受信下書き→既存パーサー/取込→版付き手動募集",async()=>{
  const h=await setup();assert.equal(h.job().status,"draft");assert.equal(h.job().publishable,false);
  const out=await h.publishNow();assert.deepEqual(plain(out.updated),[h.jobId]);assert.equal(h.job().status,"open");
  assert.equal(h.job().mailPublication.actorUid,h.auth.uid);assert.equal(h.list("sheetRowCreateQueue").length,1);
});
for(const [name,mutate]of [
 ["未取込",h=>h.records.delete("adminJobEditSources/"+h.jobId)],
 ["sourceReadyだけ",h=>{h.records.delete("adminJobEditSources/"+h.jobId);h.job().sourceReady=true;}],
 ["原本別会社",h=>h.source().companyId="other"],
 ["原本別案件",h=>h.source().jobId="other"],
 ["原本別固定ID",h=>h.job().caseId="other"],
 ["原本別タブ",h=>h.job().sheetRef.sheetName="2099.11"],
 ["原本列違い",h=>h.source().columns.storeName="L"],
 ["原本内容違い",h=>h.source().values.storeName="変更済み"],
 ["担当欄空白文字",h=>h.source().values.staffName=" "],
 ["未照合担当",h=>h.job().assignmentUnresolved=true],
 ["未反映編集",h=>h.job().pendingSourceWrite=true],
 ["編集の確認待ち",h=>h.job().adminEditSheetWrite={pending:true}],
 ["原本欠落",h=>h.job().sourceMissing=true],
 ["受信変更保留",h=>h.job().mailIntakeReviewRequired=true],
 ["取消",h=>{h.job().cancelled=true;h.job().status="cancelled";}],
 ["ラウンダー",h=>{h.job().menuName="ラウンダー";h.source().values.menuName="ラウンダー";}],
 ["受信別会社",h=>h.records.get(h.paths.receipt).companyId="other"],
 ["受信確認待ち",h=>h.records.get(h.paths.receipt).status="review"],
 ["受信取消",h=>h.records.get(h.paths.receipt).status="cancelled"],
 ["候補別会社",h=>h.records.get(h.paths.candidate).companyId="other"],
 ["候補版不一致",h=>h.records.get(h.paths.candidate).revision++],
 ["候補出典差替え",h=>h.records.get(h.paths.candidate).source.sha256="c".repeat(64)],
 ["所有記録欠落",h=>h.records.delete("caseMailJobSources/"+h.job().mailIntake.sourceKey)],
 ["所有記録別案件",h=>h.records.get("caseMailJobSources/"+h.job().mailIntake.sourceKey).jobId="other"],
])await test(name+"では募集不可",async()=>{const h=await setup();mutate(h);const result=await h.publishNow();assert.equal(result.updated.length,0);assert.equal(result.blocked.length,1);assert.notEqual(h.job().status,"open");});
await test("表示した版の欠落/変更を拒否し、再確認後だけ募集",async()=>{
 const h=await setup(),revision=h.job().revision;
 assert.equal((await h.publish({jobIds:[h.jobId],action:"publish"})).blocked.length,1);
 h.row[10]="変更後店舗";await h.importRow();
 assert.equal((await h.publish({jobIds:[h.jobId],action:"publish",expectedRevisions:{[h.jobId]:revision}})).blocked.length,1);
 assert.equal((await h.publishNow()).updated.length,1);
});
await test("原本の括弧付きメニュー条件を保持して募集、条件変更で停止",async()=>{
 const h=await setup();h.row[12]="試食（白シャツ）";await h.importRow();assert.equal((await h.publishNow()).updated.length,1);
 h.row[12]="試食（黒シャツ）";await h.importRow();assert.equal(h.job().status,"stopped");assert.equal(h.job().publishable,false);
 assert.equal((await h.publishNow()).updated.length,1);
});
await test("下書きの括弧内条件だけが変わっても古い画面の確認を拒否",async()=>{
 const h=await setup();h.row[12]="試食（白シャツ）";await h.importRow();const revision=h.job().revision;
 h.row[12]="試食（黒シャツ）";await h.importRow();assert.ok(h.job().revision>revision);
 assert.equal((await h.publish({jobIds:[h.jobId],action:"publish",expectedRevisions:{[h.jobId]:revision}})).blocked.length,1);
 assert.equal((await h.publishNow()).updated.length,1);
});
await test("当日/過去/存在しない日は募集不可、翌日なら可",async()=>{
 const h=await setup(),check=h.load("./case-mail-publication").readMailPublication,db=h.load("./firebase").db;
 for(const [now,allowed]of [["2099-10-09T14:59:59Z",true],["2099-10-09T15:00:00Z",false],["2099-10-10T15:00:00Z",false]]){
  const value=await db.runTransaction(tx=>check(tx,h.jobId,h.job(),h.job().revision,new Date(now)));assert.equal(!value.issue,allowed);
 }
 h.job().workDate=h.job().dateKey="2099-02-30";
 assert.equal((await h.publishNow()).blocked.length,1);
});
for(const [name,mutate]of [["受信版変更",h=>h.records.get(h.paths.receipt).status="review"],["原本変更",h=>h.source().values.storeName="別店舗"],["担当確定",h=>{h.job().assignedStaffId="staff-1";h.job().status="assigned";}]]){
 await test("募集保存と同時の"+name+"を再読して拒否",async()=>{
 const h=await setup();let changed=false;
 h.beforeCommit=({writes})=>{if(!changed&&writes.some(write=>write.ref.path===h.path&&write.data.status==="open")){changed=true;mutate(h);}};
 const out=await h.publishNow();assert.equal(changed,true);assert.equal(out.updated.length,0);assert.notEqual(h.job().status,"open");
 });
}
await test("同じ原本の再取込は明示済み募集を維持",async()=>{const h=await setup();await h.publishNow();await h.importRow();assert.equal(h.job().status,"open");assert.equal(h.job().publishable,true);});
for(const [name,column,value]of [["店舗",10,"変更後店舗"],["時間",14,"11:00～19:00"],["メーカー",11,"変更後メーカー"]]){
 await test(name+"の原本変更で停止し、最新版の再確認で再開",async()=>{
 const h=await setup();await h.publishNow();h.row[column]=value;await h.importRow();
 assert.equal(h.job().status,"stopped");assert.equal(h.job().publishable,false);assert.equal(h.job().mailPublication,undefined);
 assert.equal((await h.publishNow()).updated.length,1);
 });
}
await test("担当解除の取込でも自動募集しない",async()=>{
 const h=await setup();await h.publishNow();h.row[1]="合成スタッフ";await h.importRow();assert.equal(h.job().status,"assigned");
 h.row[1]="";await h.importRow();assert.equal(h.job().status,"stopped");assert.equal(h.job().publishable,false);
});
await test("原本取消の取込で募集終了、空欄へ戻しても自動復活しない",async()=>{
 const h=await setup();await h.publishNow();h.row[1]="（キャンセル）";await h.importRow();assert.equal(h.job().cancelled,true);assert.equal(h.job().publishable,false);
 h.row[1]="";await assert.rejects(h.importRow());assert.equal(h.job().cancelled,true);
});
await test("公開済みでも管理者編集後は募集停止",async()=>{
 const h=await setup();await h.publishNow();
 await h.load("./job-management").adminEditJobInputs({auth:h.auth,data:{jobId:h.jobId,revision:h.job().revision,fields:{storeAddress:"新しい住所"}}});
 assert.equal(h.job().status,"stopped");assert.equal(h.job().publishable,false);assert.equal(h.job().mailPublication,undefined);
});
for(const status of ["open","assigned","cancelled"])await test("変更受信は"+status+"の内容/担当を保ち募集のみ保留",async()=>{
 const h=await setup();await h.publishNow();if(status!=="open")Object.assign(h.job(),{status,cancelled:status==="cancelled",assignedStaffId:"staff-1"});
 h.records.get(h.paths.feature).caseMailIntakeEnabled=true;
 const candidate=h.records.get(h.paths.candidate),original=clone(h.job());
 const analysis={messageId:"message-1",sourceFingerprint:"d".repeat(64),receivedAt:"2026-09-18T01:00:00Z",state:"review",structuralComplete:true,issues:["SOURCE_CHANGED"],parts:[],candidates:[]};
 const receive=h.load("./case-mail-intake").createCaseMailReceiver({companyId,uid:"synthetic-ingester",producerId:"synthetic-producer",principalRevision:"principal-1",mailbox:"info@lipknots.com",startedAt:"2026-09-18T00:00:00Z"},{fetch:async()=>null,parse:()=>analysis});
 await receive({messageId:"message-1"});
 assert.equal(h.job().status,status==="open"?"stopped":status);assert.equal(h.job().publishable,false);assert.equal(h.job().mailIntakeReviewRequired,true);
 for(const key of ["workDate","storeName","assignedStaffId","caseId","cancelled"])assert.deepEqual(h.job()[key],original[key]);
 assert.equal(h.records.get(h.paths.receipt).status,"review");assert.equal(candidate.status,"linked");
 const before=JSON.stringify([...h.records]);await receive({messageId:"message-1"});assert.equal(JSON.stringify([...h.records]),before);
});
for(const assigned of [false,true])await test("取消復帰でも募集停止を維持（担当"+assigned+"）",async()=>{
 const h=await setup();await h.publishNow();Object.assign(h.job(),{status:"cancelled",cancelled:true,recruitmentStopped:false});
 if(assigned){h.job().assignedStaffId="staff-1";h.job().assignedStaffName="合成スタッフ";h.records.set("staffProfiles/staff-1",{companyId,active:true});}
 await h.load("./analytics").adminRestoreCancelledJob({auth:h.auth,data:{jobId:h.jobId,note:"合成復帰",expectedRevision:h.job().revision}});
 assert.equal(h.job().publishable,false);assert.equal(h.job().recruitmentStopped,true);assert.equal(h.job().cancelled,false);
 assert.equal(h.job().status,assigned?"assigned":"open");assert.equal(h.job().mailPublication,undefined);
 assert.equal((await h.publishNow()).blocked.length,1);
 if(!assigned){await h.importRow();assert.equal(h.job().status,"stopped");assert.equal((await h.publishNow()).updated.length,1);}
});
await test("複数募集の追加読取は全書込より前に行う",async()=>{
 const h=await setup();h.records.set("jobs/native",{companyId,status:"draft",sourceReady:true,revision:1});
 const out=await h.publish({jobIds:["native",h.jobId],action:"publish",expectedRevisions:{[h.jobId]:h.job().revision}});
 assert.equal(out.updated.length,2);
});
await test("行作成完了の古いスナップショットで受信案件の担当/取消/募集を戻さない",async()=>{
 const source=fs.readFileSync(new URL("../functions/src/sheet-row-creation.ts",import.meta.url),"utf8"),start=source.indexOf("function publicationUpdateForSourceReady("),end=source.indexOf("function copyRequest(",start);
 assert.ok(start>0&&end>start);
 const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const status of ["assigned","cancelled","stopped"]){
  const old={id:"mail-job",mailIntake:{receiptId:"receipt"},status:"draft",requestedPublicationMode:"immediate"};
  const current={...old,status};
  const update=runInNewContext(code+"\npublicationUpdateForSourceReady(current,old)",{Timestamp,FieldValue:{delete:()=>null},current,old});
  for(const key of ["status","publishable","recruitmentStopped"])assert.equal(Object.hasOwn(update,key),false);
  assert.equal({...current,...update}.status,status);
 }

});
console.log("受信下書き・原本照合・手動募集: "+count+"条件成功（合成DB/原本行のみ）");
