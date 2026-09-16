import assert from "node:assert/strict";
import fs from "node:fs";
import {harness,companyId,staffId,jobId,workDate} from "./automation-intake-test-harness.mjs";
const copy=value=>JSON.parse(JSON.stringify(value)),snapshot=h=>JSON.stringify([...h.records]);
const scope=h=>({expectedCompanyId:companyId,expectedActorUid:h.admin.uid});
const assignment={staffId,personKey:"a".repeat(64),proofEpoch:"synthetic-epoch-1"};
const results=[];
async function test(name,run){try{await run();results.push({name,passed:true});console.log("PASS "+name);}catch(error){results.push({name,passed:false,error:error.stack});console.error("FAIL "+name,error);}}
function fixture(){
 const h=harness();Object.assign(h.records.get(h.paths.binding),{assignment:copy(assignment)});
 Object.assign(h.records.get(h.paths.job),{status:"assigned",assignedStaffId:staffId,applicationUnconfirmed:false,assignmentUnresolved:false});
 const binding=h.records.get(h.paths.binding),incoming={contractVersion:1,companyId,jobId,bindingRevision:binding.revision,
  spreadsheetId:binding.spreadsheetId,fixedCaseId:binding.fixedCaseId,workDate,assignment:copy(assignment),
  kind:"notice.departure",operationId:"synthetic-delivery",sequence:1,status:"planned",observedAt:"2099-09-20T00:00:00.000Z",sourceRecordId:"synthetic-ledger"};
 return {h,input:{...scope(h),incoming}};
}
const send=(h,input,change={})=>h.receiveNotice({...input,incoming:{...input.incoming,...change}});
const list=h=>h.listNotices({...scope(h),jobId});
const stream=h=>h.list("automationNoticeReceipts")[0];
async function blocked(change){
 const {h,input}=fixture();change(h,input);const before=snapshot(h);await assert.rejects(h.receiveNotice(input));assert.equal(snapshot(h),before);
}
for(const kind of ["notice.departure","notice.entry"])await test("原文・最新状態を同時保存し実配信と区別: "+kind,async()=>{
 const {h,input}=fixture();input.incoming.kind=kind;const before=copy(h.records.get(h.paths.job));
 const out=await h.receiveNotice(input);
 assert.equal(out.disposition,"accepted");assert.equal(out.report.state,"current");assert.equal(out.report.reportedStatus,"planned");
 assert.equal(out.report.deliveryVerified,false);assert.equal(out.report.automaticRetryAllowed,false);assert.equal(out.dispatch,"disabled");assert.equal(out.assignmentPerformed,false);
 assert.equal(h.commits.at(-1).length,2);assert.deepEqual(copy(h.list("automationNoticeEvents")[0].incoming),input.incoming);assert.deepEqual(h.records.get(h.paths.job),before);
 assert.equal(h.list("notifications").length,0);assert.equal(h.list("sheetSyncQueue").length,0);assert.equal(h.list("staffDayLocks").length,0);
 const result=await list(h);assert.equal(result.reports.length,1);assert.equal(result.reports[0].kind,kind);assert.equal(h.commits.at(-1).length,0);
});
for(const [name,change] of [
 ["他社",(_h,i)=>i.incoming.companyId="other-company"],["確認会社",(_h,i)=>i.expectedCompanyId="other-company"],
 ["確認本人",(_h,i)=>i.expectedActorUid="other-admin"],["所属指定なし",(_h,i)=>delete i.expectedCompanyId],
 ["配信以外の種別",(_h,i)=>i.incoming.kind="recruitment.mail"],["余分な本文",(_h,i)=>i.incoming.body="private"],
 ["担当証跡なし",(_h,i)=>i.incoming.assignment=null],["危険な連番",(_h,i)=>i.incoming.sequence=Number.MAX_SAFE_INTEGER+1],
 ["実行者無効",(h)=>h.records.get(h.paths.sender).active=false],
 ["実行者UID不一致",(h)=>h.records.get(h.paths.sender).uid="other-admin"],
 ["台帳なし",(h)=>h.records.delete(h.paths.binding)],
 ["所有記録なし",(h)=>h.records.delete(h.paths.bindingOwner)],
 ["所有版違い",(h)=>h.records.get(h.paths.bindingOwner).revision="changed"],
 ["本人所有違い",(h)=>h.records.get(h.paths.personOwner).personKey="b".repeat(64)],
 ["本人未確認",(h)=>h.records.get(h.paths.person).verification="unverified"],
 ["本人版違い",(h)=>h.records.get(h.paths.person).revision="changed"],
 ["スタッフ無効",(h)=>h.records.get(h.paths.staff).active=false],
 ["現在担当違い",(h)=>h.records.get(h.paths.job).assignedStaffId="other-staff"],
 ["取消",(h)=>h.records.get(h.paths.job).cancelled=true],
 ["照合待ち",(h)=>h.records.get(h.paths.job).applicationUnconfirmed=true],
 ["事前連絡要再確認",(h)=>h.records.get(h.paths.job).preContactNeedsReview=true],
 ["窓口不明",(h)=>h.records.delete(h.paths.policy)],
 ["古い担当版",(_h,i)=>i.incoming.bindingRevision="older"],
 ["本人証跡世代違い",(_h,i)=>i.incoming.assignment.proofEpoch="different"],
 ["元表違い",(_h,i)=>i.incoming.spreadsheetId="different"],
])await test("初回は保存せず元の報告を保持: "+name,()=>blocked(change));
await test("認証なし・スタッフは受信と一覧を拒否",async()=>{
 const {h,input}=fixture();for(const auth of [null,h.staff]){const before=snapshot(h);await assert.rejects(h.receiveNotice(input,auth));await assert.rejects(h.listNotices({...scope(h),jobId},auth));assert.equal(snapshot(h),before);}
});
await test("同じ報告の並行受信は1回保存、応答消失も同じ結果",async()=>{
 const {h,input}=fixture();const results=await Promise.all([h.receiveNotice(input),h.receiveNotice(copy(input))]);
 assert.deepEqual(results.map(r=>r.duplicate).sort(),[false,true]);assert.equal(h.list("automationNoticeReceipts").length,1);assert.equal(h.list("automationNoticeEvents").length,1);
 h.loseResponse=true;await assert.rejects(send(h,input,{sequence:2,status:"unknown"}),/response lost/);const before=snapshot(h);
 const retry=await send(h,input,{sequence:2,status:"unknown"});assert.equal(retry.duplicate,true);assert.equal(snapshot(h),before);assert.equal(retry.report.reportedStatus,"unknown");
});
await test("保存失敗は原文と最新状態の片方だけを残さない",async()=>{
 const {h,input}=fixture(),before=snapshot(h);h.failCommit=true;await assert.rejects(h.receiveNotice(input));assert.equal(snapshot(h),before);
 h.failCommit=false;assert.equal((await h.receiveNotice(input)).duplicate,false);
});
await test("連番順で採用し、遅れた原文も保存して内容差替えを拒否",async()=>{
 const {h,input}=fixture();await send(h,input,{sequence:3,status:"sent"});const saved=copy(stream(h));
 const stale=await h.receiveNotice(input);assert.equal(stale.disposition,"stale");assert.equal(stale.report.sequence,3);assert.equal(stale.report.reportedStatus,"sent");
 assert.deepEqual(copy(stream(h)),saved);assert.equal(h.list("automationNoticeEvents").length,2);assert.equal(h.list("automationNoticeEvents").find(r=>r.incoming.sequence===1).disposition,"stale");
 const before=snapshot(h);await assert.rejects(send(h,input,{status:"failed"}),{code:"already-exists"});assert.equal(snapshot(h),before);
 const duplicate=await h.receiveNotice(input);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.report.sequence,3);assert.equal(snapshot(h),before);
});
await test("最新と同じ連番の矛盾は一方だけを保存",async()=>{
 const {h,input}=fixture();const out=await Promise.allSettled([h.receiveNotice(input),send(h,input,{status:"unknown"})]);
 assert.equal(out.filter(r=>r.status==="fulfilled").length,1);assert.equal(h.list("automationNoticeEvents").length,1);
});
await test("異なる連番の同時受信でも最新状態が戻らない",async()=>{
 const {h,input}=fixture();await h.receiveNotice(input);
 await Promise.all([send(h,input,{sequence:2,status:"sending"}),send(h,input,{sequence:3,status:"sent"})]);
 assert.equal(stream(h).current.sequence,3);assert.equal(stream(h).current.status,"sent");assert.equal(h.list("automationNoticeEvents").length,3);
});
await test("結果不明は自動再開できず、後の送信報告を別途記録",async()=>{
 const {h,input}=fixture();await send(h,input,{status:"unknown"});
 for(const status of ["planned","sending"]){const before=snapshot(h);await assert.rejects(send(h,input,{status,sequence:2}));assert.equal(snapshot(h),before);}
 const out=await send(h,input,{sequence:2,status:"sent",sourceRecordId:"resolved-ledger",observedAt:"2099-09-19T00:00:00.000Z"});
 assert.equal(out.report.reportedStatus,"sent");assert.equal(out.report.deliveryVerified,false);assert.equal(out.report.automaticRetryAllowed,false);
 for(const change of [{status:"failed"},{status:"sent",sourceRecordId:"other-ledger"}]){const before=snapshot(h);await assert.rejects(send(h,input,{sequence:3,...change}));assert.equal(snapshot(h),before);}
});
await test("送信中・停止・失敗からの再開を拒否",async()=>{
 for(const status of ["sending","stopped","failed"]){const {h,input}=fixture();await send(h,input,{status});const before=snapshot(h);await assert.rejects(send(h,input,{status:"planned",sequence:2}));assert.equal(snapshot(h),before);}
});
await test("出発・入店・別操作は別記録で再送許可を作らない",async()=>{
 const {h,input}=fixture();await h.receiveNotice(input);await send(h,input,{kind:"notice.entry"});await send(h,input,{operationId:"another-operation"});
 assert.equal(h.list("automationNoticeReceipts").length,3);assert.ok((await list(h)).reports.every(row=>row.automaticRetryAllowed===false));
});
await test("同じ配信操作が複数案件を含んでも記録を混同しない",async()=>{
 const {h,input}=fixture();await h.receiveNotice(input);const binding={...h.records.get(h.paths.binding),jobId:"second-job",appCaseId:"second-case",fixedCaseId:"second-fixed"};
 h.records.set("automationBindings/"+h.key(companyId,binding.jobId),binding);
 h.records.set("automationBindingOwners/"+h.key(companyId,binding.spreadsheetId,binding.fixedCaseId),{companyId,jobId:binding.jobId,spreadsheetId:binding.spreadsheetId,fixedCaseId:binding.fixedCaseId,revision:binding.revision});
 h.records.set("jobs/"+binding.jobId,{...h.records.get(h.paths.job),caseId:binding.appCaseId});
 await send(h,input,{jobId:binding.jobId,fixedCaseId:binding.fixedCaseId});assert.equal(h.list("automationNoticeReceipts").length,2);assert.equal((await list(h)).reports.length,1);
});
for(const [name,change,expected] of [
 ["担当版の更新",h=>{h.records.get(h.paths.binding).revision="binding-2";h.records.get(h.paths.bindingOwner).revision="binding-2";},"historical"],
 ["取消",h=>h.records.get(h.paths.job).cancelled=true,"needs_review"],
 ["本人無効",h=>h.records.get(h.paths.person).active=false,"needs_review"],
 ["案件なし",h=>h.records.delete(h.paths.job),"needs_review"],
 ["台帳なし",h=>h.records.delete(h.paths.binding),"needs_review"],
])await test("既知の操作の遅延報告を新担当へ適用しない: "+name,async()=>{
 const {h,input}=fixture();await h.receiveNotice(input);change(h);const jobBefore=JSON.stringify(h.records.get(h.paths.job));
 const out=await send(h,input,{sequence:2,status:"sent"});assert.equal(out.report.state,expected);assert.equal(out.report.deliveryVerified,false);
 assert.equal(JSON.stringify(h.records.get(h.paths.job)),jobBefore);assert.equal(h.list("automationNoticeEvents").length,2);assert.equal((await list(h)).reports[0].state,expected);
});
await test("台帳APIで同じ人を再手配しても旧証跡と新報告を分離",async()=>{
 const {h,input}=fixture();await h.receiveNotice(input);const newer={...assignment,proofEpoch:"synthetic-epoch-2"};
 const changed=await h.registry({kind:"binding",...scope(h),requestId:"reassign-proof",expectedRevision:"binding-1",
  evidenceRecordId:"checked-again",confirmedAgainstSource:true,jobId,jobRevision:0,fixedCaseId:"synthetic-fixed",assignment:newer});
 const old=await send(h,input,{sequence:2,status:"sent"});assert.equal(old.report.state,"historical");
 const fresh=await send(h,input,{bindingRevision:changed.revision,assignment:newer});assert.equal(fresh.report.state,"current");assert.notEqual(old.report.operationKey,fresh.report.operationKey);
 assert.equal((await list(h)).reports.length,2);assert.equal(h.list("sheetSyncQueue").length,0);
});
await test("古い担当版の未知操作を現在台帳から推測登録しない",async()=>{
 const {h,input}=fixture();h.records.get(h.paths.binding).revision="new";h.records.get(h.paths.bindingOwner).revision="new";const before=snapshot(h);
 await assert.rejects(h.receiveNotice(input));assert.equal(snapshot(h),before);
});
await test("元の実行者失効後は新受信を拒否し管理者一覧で要確認",async()=>{
 const {h,input}=fixture();await h.receiveNotice(input);h.records.get(h.paths.sender).active=false;const before=snapshot(h);
 await assert.rejects(send(h,input,{sequence:2,status:"sent"}),{code:"permission-denied"});assert.equal(snapshot(h),before);
 const out=await list(h);assert.equal(out.reports[0].reason,"source_unavailable");assert.equal(h.commits.at(-1).length,0);
});
await test("同名producerの別管理者による元操作の乗取りを拒否",async()=>{
 const {h,input}=fixture();await h.receiveNotice(input);const auth={uid:"another-admin",token:{companyId,role:"admin"}};
 h.records.set("automationIngestPrincipals/"+h.key(companyId,auth.uid),{...h.records.get(h.paths.sender),uid:auth.uid});
 const before=snapshot(h);await assert.rejects(h.receiveNotice({...input,expectedActorUid:auth.uid},auth),{code:"permission-denied"});assert.equal(snapshot(h),before);
});
for(const [name,path,change] of [
 ["実行者失効","sender",row=>row.active=false],["担当変更","job",row=>row.assignedStaffId="other"],
 ["本人所有の変更","personOwner",row=>row.personKey="b".repeat(64)],
])await test("取引中の条件変更を再読込して初回保存を停止: "+name,async()=>{
 const {h,input}=fixture();let changed=false;h.beforeCommit=()=>{if(!changed){changed=true;change(h.records.get(h.paths[path]));}};
 await assert.rejects(h.receiveNotice(input));assert.ok(h.attempts>1);assert.equal(h.list("automationNoticeEvents").length,0);
});
await test("既知操作の保存中に担当版が変わった場合も履歴へ分離",async()=>{
 const {h,input}=fixture();await h.receiveNotice(input);let changed=false;h.beforeCommit=()=>{if(!changed){changed=true;h.records.get(h.paths.binding).revision="new";h.records.get(h.paths.bindingOwner).revision="new";}};
 const out=await send(h,input,{sequence:2,status:"sent"});assert.equal(out.report.state,"historical");assert.equal(h.list("automationNoticeEvents").at(-1).stateAtReceipt,"historical");
});
for(const [name,change] of [
 ["最新内容の改変",h=>h.records.get("automationNoticeReceipts/"+stream(h).operationKey).current.status="sent"],
 ["最新原文の欠落",h=>h.records.delete("automationNoticeEvents/"+stream(h).currentEventKey)],
 ["原文ハッシュの不整合",h=>h.records.get("automationNoticeEvents/"+stream(h).currentEventKey).inputHash="b".repeat(64)],
 ["履歴の他社混入",h=>h.records.get("automationNoticeEvents/"+stream(h).currentEventKey).companyId="other"],
])await test("保存記録の不整合を成功へ置換しない: "+name,async()=>{
 const {h,input}=fixture();await h.receiveNotice(input);change(h);const before=snapshot(h);
 await assert.rejects(send(h,input,{sequence:2,status:"sent"}));await assert.rejects(list(h));assert.equal(snapshot(h),before);
});
await test("原文だけ残った操作の再生成を拒否",async()=>{
 const {h,input}=fixture();await h.receiveNotice(input);h.records.delete("automationNoticeReceipts/"+stream(h).operationKey);const before=snapshot(h);await assert.rejects(h.receiveNotice(input));assert.equal(snapshot(h),before);
});
await test("一覧は25件・会社/案件分離・本人情報除外・読取上限を維持",async()=>{
 const {h,input}=fixture();for(let i=0;i<26;i++)await send(h,input,{operationId:"operation-"+i});
 const first=stream(h);h.records.set("automationNoticeReceipts/"+"b".repeat(64),{...first,companyId:"other"});
 h.readCounts.clear();const page=await list(h);assert.equal(page.reports.length,25);assert.ok(page.nextCursor);
 assert.equal(h.readCounts.get(h.paths.binding),1);assert.equal(h.readCounts.get(h.paths.job),1);assert.equal(h.readCounts.get(h.paths.sender),1);
 assert.equal(h.readCounts.get(h.paths.person),1);assert.equal(h.readCounts.get("query:automationNoticeReceipts"),1);
 const text=JSON.stringify(page);for(const privateField of ["personKey","proofEpoch","receivedBy","principalRevision","Synthetic Staff"])assert.ok(!text.includes(privateField));
 const second=await h.listNotices({...scope(h),jobId,cursor:page.nextCursor});assert.equal(second.reports.length,1);assert.equal(second.nextCursor,null);
 assert.equal(new Set([...page.reports,...second.reports].map(r=>r.operationKey)).size,26);assert.ok(h.commits.at(-1).length===0);
});
await test("一覧の通信失敗・不正カーソル・所属不一致は空一覧にしない",async()=>{
 const {h,input}=fixture();await h.receiveNotice(input);h.failRead="query:automationNoticeReceipts";await assert.rejects(list(h),/read failure/);h.failRead=null;
 for(const extra of [{cursor:"invalid"},{expectedCompanyId:"other"},{expectedActorUid:"other"}])await assert.rejects(h.listNotices({...scope(h),jobId,...extra}));
 h.records.get(h.paths.job).companyId="other";await assert.rejects(list(h));
});
const failed=results.filter(row=>!row.passed);
if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify({passed:results.length-failed.length,results,cloudAccess:false,sourceDataModified:false,finishedAt:new Date().toISOString()},null,2));
console.log("出発・入店の報告受信: "+(results.length-failed.length)+"/"+results.length+"条件成功。");
if(failed.length)process.exitCode=1;
