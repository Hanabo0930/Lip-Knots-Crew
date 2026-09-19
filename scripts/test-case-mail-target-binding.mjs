import assert from "node:assert/strict";
import { harness,clone,plain,companyId } from "./case-mail-test-harness.mjs";
export function setupBinding(){
 const h=harness(),api=h.load("./case-mail-review"),scope={expectedCompanyId:companyId,expectedActorUid:h.auth.uid};
 h.records.get(h.paths.receipt).status="review";h.records.get(h.paths.candidate).status="review";h.records.get(h.paths.feature).caseMailIntakeEnabled=true;
 h.records.set("jobs/target-1",{companyId,...clone(h.input),caseId:"case-1",revision:1,status:"draft"});
 h.request={...scope,receiptId:"receipt-1",candidateId:"candidate-1",jobId:"target-1"};
 h.preview=(data=h.request,auth=h.auth)=>api.getCaseMailTargetPreview({data,auth});
 h.confirm=(data,auth=h.auth)=>api.confirmCaseMailTarget({data,auth});
 h.command=async(request=h.request)=>({...request,reviewVersion:(await h.preview(request)).reviewVersion,note:"合成原文と案件を照合",confirmed:true});
 h.detail=()=>api.getCaseMailReceipt({data:{...scope,receiptId:"receipt-1"},auth:h.auth});
 return h;
}
const results=[],filter=process.argv[2];
async function test(name,run){if(filter&&!name.includes(filter))return;try{await run();results.push({name,passed:true});console.log("成功: "+name);}catch(e){results.push({name,passed:false,error:e.stack});console.error("失敗: "+name+"\n"+e.stack);}}
function second(h){const c=clone(h.records.get(h.paths.candidate));h.records.set("caseMailIntakeCandidates/candidate-2",c);h.records.get(h.paths.receipt).candidateIds.push("candidate-2");return {...h.request,candidateId:"candidate-2"};}
async function unchangedReject(h,command){const before=JSON.stringify([...h.records]);await assert.rejects(h.confirm(command));assert.equal(JSON.stringify([...h.records]),before);}
await test("正常保存は候補の対応記録と監査だけ",async()=>{
 const h=setupBinding(),command=await h.command(),before=new Map([...h.records].map(([k,v])=>[k,JSON.stringify(v)]));
 assert.equal((await h.preview()).state,"available");assert.equal((await h.confirm(command)).saved,true);
 for(const [key,value]of before)if(key!==h.paths.candidate)assert.equal(JSON.stringify(h.records.get(key)),value,key);
 const saved=clone(h.records.get(h.paths.candidate));delete saved.targetBinding;assert.equal(JSON.stringify(saved),before.get(h.paths.candidate));
 assert.equal(h.list("auditLogs").length,1);assert.equal((await h.preview()).state,"confirmed");
 const detail=await h.detail();assert.equal(detail.candidates[0].creatable,false);assert.equal(detail.candidates[0].linkedJobId,null);assert.equal(detail.candidates[0].targetBinding.jobId,"target-1");
 assert.deepEqual(h.commits.filter(w=>w.length).map(w=>w.map(x=>x.ref.path)),[[h.paths.candidate,h.list("auditLogs")[0].path]]);
});
await test("通信断後も同じ対応記録と監査は1回",async()=>{
 const h=setupBinding(),command=await h.command();h.loseResponse=true;await assert.rejects(h.confirm(command));
 assert.equal((await h.preview()).state,"confirmed");const before=JSON.stringify([...h.records]);assert.equal((await h.confirm(command)).replayed,true);assert.equal(JSON.stringify([...h.records]),before);
});
await test("保存直前失敗は監査も対応も残さない",async()=>{const h=setupBinding(),command=await h.command();h.failCommit=true;await unchangedReject(h,command);});
await test("保存後の別案件・別メモへの付替えを拒否",async()=>{
 const h=setupBinding(),command=await h.command();await h.confirm(command);h.records.set("jobs/target-2",clone(h.records.get("jobs/target-1")));
 await unchangedReject(h,{...command,jobId:"target-2"});await unchangedReject(h,{...command,note:"別のメモ"});
});
for(const [name,auth]of [["未認証",null],["スタッフ",{uid:"staff",token:{companyId,role:"staff"}}],["別会社",{uid:"foreign",token:{companyId:"foreign",role:"admin"}}]]){
 await test("認証拒否-"+name,async()=>{const h=setupBinding(),command=await h.command();const before=JSON.stringify([...h.records]);await assert.rejects(h.preview(h.request,auth));await assert.rejects(h.confirm(command,auth));assert.equal(JSON.stringify([...h.records]),before);});
}
for(const patch of [{expectedCompanyId:"other"},{expectedActorUid:"other"},{confirmed:false},{note:" "},{reviewVersion:"wrong"},{jobId:"missing"},{candidateId:"missing"},{receiptId:"missing"},{unknown:true}]){
 await test("入力拒否-"+JSON.stringify(patch),async()=>{const h=setupBinding();await unchangedReject(h,{...await h.command(),...patch});});
}
for(const [name,change]of [
 ["受信版",h=>h.records.get(h.paths.receipt).revision++],["候補版",h=>h.records.get(h.paths.candidate).revision++],
 ["案件版",h=>h.records.get("jobs/target-1").revision++],["候補条件",h=>h.records.get(h.paths.candidate).input.clientName="別依頼"],
 ["案件条件",h=>h.records.get("jobs/target-1").makerName="変更"],["担当",h=>h.records.get("jobs/target-1").assignedStaffId="staff-2"],
 ["受信再解析",h=>h.records.get(h.paths.receipt).heldAnalysisHash="c".repeat(64)],["候補出典",h=>h.records.get(h.paths.candidate).source.sha256="c".repeat(64)],
 ["受信停止",h=>h.records.get(h.paths.feature).caseMailIntakeEnabled=false],["実行者停止",h=>h.records.get(h.paths.principal).active=false],
 ["他社案件",h=>h.records.get("jobs/target-1").companyId="other"],["未検証",h=>h.records.get(h.paths.receipt).verification="preview"],
 ["不完全受信",h=>h.records.get(h.paths.receipt).structuralComplete=false],["同一受信元",h=>h.records.get("jobs/target-1").mailIntake={receiptId:"receipt-1",candidateId:"candidate-1",sourceKey:"d".repeat(64)}],
 ["監査衝突",h=>h.records.set("auditLogs/"+h.key("case-mail-target",companyId,"receipt-1","candidate-1"),{companyId,action:"other"})],
])await test("古い確認拒否-"+name,async()=>{const h=setupBinding(),command=await h.command();change(h);await unchangedReject(h,command);});
await test("別日・別店舗は対応候補にできない",async()=>{for(const patch of [{workDate:"2026-10-11"},{storeName:"別店"}]){const h=setupBinding();Object.assign(h.records.get("jobs/target-1"),patch);assert.equal((await h.preview()).state,"blocked");await unchangedReject(h,await h.command());}});
await test("同一メール内の二重対応を拒否",async()=>{const h=setupBinding(),request=second(h),one=await h.command(),two=await h.command(request);await h.confirm(one);await unchangedReject(h,two);assert.equal((await h.preview(request)).state,"blocked");});
await test("同一メール内の同時二重対応を1件に制限",async()=>{
 const h=setupBinding(),request=second(h),one=await h.command(),two=await h.command(request);
 const out=await Promise.allSettled([h.confirm(one),h.confirm(two)]);assert.equal(out.filter(x=>x.status==="fulfilled").length,1);assert.equal(h.list("auditLogs").length,1);
});
await test("同じ対応の同時再送を1件に制限",async()=>{const h=setupBinding(),command=await h.command();const out=await Promise.all([h.confirm(command),h.confirm(command)]);assert.equal(out.filter(x=>x.replayed).length,1);assert.equal(h.list("auditLogs").length,1);});
for(const name of ["案件","受信","候補"])await test("保存直前の競合-"+name,async()=>{
 const h=setupBinding(),command=await h.command();let once=false;
 h.beforeCommit=({writes})=>{if(once||!writes.length)return;once=true;if(name==="案件")h.records.get("jobs/target-1").revision++;if(name==="受信")h.records.get(h.paths.receipt).revision++;if(name==="候補")h.records.get(h.paths.candidate).revision++;};
 await assert.rejects(h.confirm(command));assert.equal(h.records.get(h.paths.candidate).targetBinding,undefined);assert.equal(h.list("auditLogs").length,0);
});
await test("保存後の変更は履歴表示へ失効",async()=>{const h=setupBinding();await h.confirm(await h.command());h.records.get("jobs/target-1").revision++;assert.equal((await h.preview()).state,"stale");await unchangedReject(h,await h.command());});
await test("対応済み候補から新規作成しない",async()=>{
 const h=setupBinding();await h.confirm(await h.command());h.records.get(h.paths.receipt).status="ready";h.records.get(h.paths.candidate).status="ready";h.records.delete("jobs/target-1");
 assert.equal((await h.detail()).candidates[0].creatable,false);
 await assert.rejects(h.create({mailIntake:{receiptId:"receipt-1",candidateId:"candidate-1",expectedReceiptRevision:1,expectedRevision:1,operationId:"second-create"}}));assert.equal(h.list("jobs").length,0);
});
async function mailOrigin(){
 const h=setupBinding();h.records.delete("jobs/target-1");h.records.get(h.paths.receipt).status="ready";h.records.get(h.paths.candidate).status="ready";
 const made=await h.create({mailIntake:{receiptId:"receipt-1",candidateId:"candidate-1",expectedReceiptRevision:1,expectedRevision:1,operationId:"origin-create"}});
 const originalReceipt=clone(h.records.get(h.paths.receipt)),originalCandidate=clone(h.records.get(h.paths.candidate));
 h.records.set("caseMailIntakeReceipts/receipt-2",{...originalReceipt,messageId:"message-2",status:"review",candidateIds:["candidate-2"]});
 const c={...originalCandidate,receiptId:"receipt-2",messageId:"message-2",status:"review",revision:1};delete c.linkedJobId;delete c.operationRecordId;
 h.records.set("caseMailIntakeCandidates/candidate-2",c);h.request={...h.request,receiptId:"receipt-2",candidateId:"candidate-2",jobId:made.jobIds[0]};return h;
}
await test("メール由来案件の元受信・所有記録を保持",async()=>{
 const h=await mailOrigin(),before=new Map([...h.records].map(([k,v])=>[k,JSON.stringify(v)]));await h.confirm(await h.command());
 for(const[k,v]of before)if(k!=="caseMailIntakeCandidates/candidate-2")assert.equal(JSON.stringify(h.records.get(k)),v,k);
 assert.equal((await h.preview()).state,"confirmed");
});
for(const target of ["owner","receipt","candidate"])await test("元受信の所有不整合拒否-"+target,async()=>{
 const h=await mailOrigin(),command=await h.command(),job=h.records.get("jobs/"+h.request.jobId);
 if(target==="owner")h.records.get("caseMailJobSources/"+job.mailIntake.sourceKey).jobId="other";
 if(target==="receipt")h.records.get("caseMailIntakeReceipts/receipt-1").candidateIds=[];
 if(target==="candidate")h.records.get("caseMailIntakeCandidates/candidate-1").companyId="other";
 await unchangedReject(h,command);
});
await test("対応記録と監査の不整合を拒否",async()=>{const h=setupBinding();await h.confirm(await h.command());h.records.get(h.paths.candidate).targetBinding.note="改変";await assert.rejects(h.preview());});

await test("同じ内容の別案件への確認値流用を拒否",async()=>{const h=setupBinding(),command=await h.command();h.records.set("jobs/target-2",clone(h.records.get("jobs/target-1")));await unchangedReject(h,{...command,jobId:"target-2"});});
await test("同じメールの別案件対応は互いを失効させない",async()=>{const h=setupBinding(),secondRequest=second(h);h.records.set("jobs/target-2",{...clone(h.records.get("jobs/target-1")),caseId:"case-2"});secondRequest.jobId="target-2";await h.confirm(await h.command());await h.confirm(await h.command(secondRequest));assert.equal((await h.preview()).state,"confirmed");assert.equal((await h.preview(secondRequest)).state,"confirmed");});

console.log(JSON.stringify({passed:results.filter(x=>x.passed).length,total:results.length,results,cloudAccess:false},null,2));if(results.some(x=>!x.passed))process.exitCode=1;
