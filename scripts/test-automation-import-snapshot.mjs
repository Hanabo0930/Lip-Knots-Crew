import assert from "node:assert/strict";
import {harness,companyId,jobId,workDate} from "./automation-intake-test-harness.mjs";
const clone=value=>JSON.parse(JSON.stringify(value));
function fixture(){
 const h=harness(),targets={version:1,kind:"recruitment.import-targets",companyId,sourceOperationId:"synthetic-campaign",area:"normal",cases:[{fixedCaseId:h.incoming.fixedCaseId,workDate}]};
 return {h,targets,input:{expectedCompanyId:companyId,expectedActorUid:h.admin.uid,targets}};
}
let count=0;async function test(name,fn){await fn();count++;console.log("成功: "+name);}
const unchanged=h=>JSON.stringify([...h.records]);
await test("固定IDと勤務日から現在の対応を読み、書込と不要な個人情報を含めない",async()=>{
 const {h,input}=fixture();h.records.get(h.paths.job).privateMemo="private-internal";h.records.get(h.paths.job).staffEmail="private@example.invalid";
 h.records.get(h.paths.bindingOwner).actorUid="private-actor";const before=unchanged(h),out=await h.importSnapshot(input);
 assert.equal(unchanged(h),before);assert.ok(h.commits.every(writes=>writes.length===0));assert.equal(out.dispatch,"disabled");
 assert.equal(out.snapshot.records[0].job.id,jobId);assert.equal(out.snapshot.records[0].job.revision,0);assert.equal(out.snapshot.policy.phase,"mail_bridge");
 assert.equal(out.summary[0].fixedCaseId,input.targets.cases[0].fixedCaseId);assert.equal(out.summary[0].workDate,workDate);
 assert.ok(!JSON.stringify(out).includes("private"));assert.ok(!JSON.stringify(out).includes("@"));assert.equal(out.snapshot.records[0].binding.assignment,null);
});
for(const auth of [null,{uid:"staff",token:{companyId,role:"staff",staffId:"staff"}}])await test("管理者認証が必要: "+(auth?"staff":"missing"),async()=>{
 const {h,input}=fixture(),before=unchanged(h);await assert.rejects(h.importSnapshot(input,auth));assert.equal(unchanged(h),before);
});
for(const [name,mutate]of [
 ["確認した会社の変更",(_h,x)=>x.expectedCompanyId="other"],
 ["確認した管理者の変更",(_h,x)=>x.expectedActorUid="other"],
 ["対象ファイルの会社変更",(_h,x)=>x.targets.companyId="other"],
 ["0枠",(_h,x)=>x.targets.cases=[]],
 ["101枠",(_h,x)=>x.targets.cases=Array.from({length:101},(_,i)=>({fixedCaseId:"fixed-"+i,workDate}))],
 ["固定ID重複",(_h,x)=>x.targets.cases.push({...x.targets.cases[0]})],
 ["不正な勤務日",(_h,x)=>x.targets.cases[0].workDate="2099-02-30"],
 ["原文混入",(_h,x)=>x.targets.body="private-body"],
 ["実行者無効",(h)=>h.records.get(h.paths.sender).active=false],
 ["実行者未登録",(h)=>h.records.delete(h.paths.sender)],
 ["実行者の版不正",(h)=>h.records.get(h.paths.sender).revision="bad/path"],
 ["受付のアプリ移行",(h)=>h.appMode()],
 ["受付設定の欠落",(h)=>h.records.delete(h.paths.policy)],
 ["過去日",(_h,x)=>x.targets.cases[0].workDate="2000-01-01"],
 ["固定ID未登録",(h)=>h.records.delete(h.paths.bindingOwner)],
 ["固定ID所有者の案件なし",(h)=>h.records.get(h.paths.bindingOwner).jobId="missing-job"],
 ["台帳なし",(h)=>h.records.delete(h.paths.binding)],
 ["台帳の別会社",(h)=>h.records.get(h.paths.binding).companyId="other"],
 ["所有版不一致",(h)=>h.records.get(h.paths.bindingOwner).revision="changed"],
 ["台帳の日付変更",(h)=>h.records.get(h.paths.binding).workDate="2099-09-21"],
 ["案件の勤務日変更",(h)=>h.records.get(h.paths.job).dateKey="2099-09-21"],
 ["案件の別会社",(h)=>h.records.get(h.paths.job).companyId="other"],
 ["案件の元表変更",(h)=>h.records.get(h.paths.job).sheetRef.spreadsheetId="other"],
 ["案件の版不正",(h)=>h.records.get(h.paths.job).revision="1"],
 ["案件の非公開",(h)=>h.records.get(h.paths.job).publishable=false],
 ["案件の募集停止",(h)=>h.records.get(h.paths.job).recruitmentStopped=true],
 ["案件の取消",(h)=>h.records.get(h.paths.job).cancelled=true],
 ["案件の担当確定",(h)=>{h.records.get(h.paths.job).status="assigned";h.records.get(h.paths.job).assignedStaffId="another-staff";}],
 ["案件の元データ未確認",(h)=>h.records.get(h.paths.job).sourceMissing=true],
 ["同じ固定IDが別の元表にも存在",(h)=>h.records.set("automationBindingOwners/"+h.key(companyId,"other-book",h.incoming.fixedCaseId),{...h.records.get(h.paths.bindingOwner),spreadsheetId:"other-book"})],
 ["所有記録の保存先不正",(h)=>{const owner=h.records.get(h.paths.bindingOwner);h.records.delete(h.paths.bindingOwner);h.records.set("automationBindingOwners/wrong-id",owner);}],
 ])await test("読取結果を返さず拒否: "+name,async()=>{
 const {h,input}=fixture();mutate(h,input);const before=unchanged(h);await assert.rejects(h.importSnapshot(input));assert.equal(unchanged(h),before);assert.equal(h.commits.length,0);
});
await test("旧案件の未採番版は既存の0として読める",async()=>{
 const {h,input}=fixture();delete h.records.get(h.paths.job).revision;const out=await h.importSnapshot(input);assert.equal(out.snapshot.records[0].job.revision,0);
});
for(const field of ["query:automationBindingOwners","job"])await test("読取失敗を空の成功へ置き換えない: "+field,async()=>{
 const {h,input}=fixture();h.failRead=field==="job"?h.paths.job:field;await assert.rejects(h.importSnapshot(input),/read failure/);
});
for(const [name,change]of [
 ["窓口変更",h=>h.appMode()],
 ["実行者無効",h=>h.records.get(h.paths.sender).active=false],
 ["固定IDの二重対応",h=>h.records.set("automationBindingOwners/"+h.key(companyId,"other-book",h.incoming.fixedCaseId),{...h.records.get(h.paths.bindingOwner),spreadsheetId:"other-book"})],
 ])await test("読取の取引中に変わった条件を再確認: "+name,async()=>{
 const {h,input}=fixture();let changed=false;h.beforeCommit=()=>{if(!changed){changed=true;change(h);}};await assert.rejects(h.importSnapshot(input));assert.ok(h.attempts>=2);
});
await test("取引中の案件版変更は読み直した整合版を返す",async()=>{
 const {h,input}=fixture();let changed=false;h.beforeCommit=()=>{if(!changed){changed=true;h.records.get(h.paths.job).revision=1;}};
 const out=await h.importSnapshot(input);assert.equal(out.snapshot.records[0].job.revision,1);assert.ok(h.attempts>=2);assert.ok(h.commits.every(writes=>writes.length===0));
});
await test("100枠も取得を限定し、共通設定と各案件を1回ずつ読む",async()=>{
 const {h,input}=fixture(),base=clone(h.records.get(h.paths.binding)),job=clone(h.records.get(h.paths.job));
 input.targets.cases=Array.from({length:100},(_,index)=>({fixedCaseId:"fixed-"+index,workDate}));
 for(const [index,target]of input.targets.cases.entries()){
  const binding={...base,jobId:"job-"+index,appCaseId:"case-"+index,fixedCaseId:target.fixedCaseId};
  h.records.set("automationBindings/"+h.key(companyId,binding.jobId),binding);
  h.records.set("jobs/"+binding.jobId,{...job,caseId:binding.appCaseId});
  h.records.set("automationBindingOwners/"+h.key(companyId,binding.spreadsheetId,binding.fixedCaseId),{companyId,jobId:binding.jobId,spreadsheetId:binding.spreadsheetId,fixedCaseId:binding.fixedCaseId,revision:binding.revision});
 }
 const out=await h.importSnapshot(input);assert.equal(out.snapshot.records.length,100);assert.equal(out.summary.length,100);
 assert.equal(h.readCounts.get(h.paths.policy),1);assert.equal(h.readCounts.get(h.paths.sender),1);assert.equal(h.readCounts.get("query:automationBindingOwners"),100);
 for(let i=0;i<100;i++)assert.equal(h.readCounts.get("jobs/job-"+i),1);assert.ok(Buffer.byteLength(JSON.stringify(out.snapshot))<262144);assert.ok(h.commits.every(writes=>writes.length===0));
});
console.log("アプリ照合データの読取: "+count+"条件成功。");
