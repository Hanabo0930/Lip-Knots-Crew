import assert from "node:assert/strict";
import {harness,clone,plain,companyId} from "./case-mail-test-harness.mjs";
let count=0;
async function test(name,run){const filter=process.argv.find(v=>v.startsWith("--match="))?.slice(8);if(filter&&!new RegExp(filter).test(name))return;try{await run();count++;console.log("成功: "+name);}catch(error){error.message=name+": "+error.message;throw error;}}
import {draftFixture} from "./case-mail-draft-review-harness.mjs";
const state=h=>JSON.stringify([...h.records]);
await test("原文を保持して補正確認→再読込→1名下書きを作成",async()=>{
 const h=draftFixture(),original=clone(h.records.get(h.paths.candidate).input),receipt=clone(h.records.get(h.paths.receipt)),request=await h.make();
 assert.equal((await h.read()).candidates[0].creatable,false);await h.confirm(request);
 const view=await h.read();assert.equal(view.candidates[0].creatable,true);assert.equal(view.candidates[0].input.clientName,h.input.clientName);assert.equal(view.candidates[0].targetCandidates,undefined);
 assert.deepEqual(plain(h.records.get(h.paths.candidate).input),plain(original));assert.deepEqual(plain(h.records.get(h.paths.receipt)),plain(receipt));
 const out=await h.createReviewed(),job=h.records.get("jobs/"+out.jobIds[0]);assert.equal(job.status,"draft");assert.equal(job.publishable,false);assert.equal(job.basePay,null);assert.equal(h.list("jobs").length,1);
 assert.equal((await h.read()).candidates[0].draftReview.confirmed,true);
 const publication=await h.load("./firebase").db.runTransaction(tx=>h.load("./case-mail-publication").readMailPublication(tx,out.jobIds[0],job,job.revision,new Date("2026-10-01T00:00:00Z")));
 assert.match(publication.issue,/原本/);assert.equal(h.list("auditLogs").filter(x=>x.action==="caseMail.draft.confirm").length,1);
});
await test("応答喪失・同一確認の再送で記録を増やさない",async()=>{
 const h=draftFixture(),request=await h.make();h.loseResponse=true;await assert.rejects(h.confirm(request),/lost response/);const before=state(h);
 assert.equal((await h.confirm(request)).replayed,true);assert.equal(state(h),before);await h.createReviewed();const after=state(h);assert.equal((await h.create({mailIntake:{...h.command.mailIntake,expectedRevision:2}})).replayed,true);assert.equal(state(h),after);
});
await test("同時確認は1記録に収束し、別内容の再確認を拒否",async()=>{
 const h=draftFixture(),request=await h.make();await Promise.all([h.confirm(request),h.confirm(request)]);assert.equal(h.records.get(h.paths.candidate).revision,2);
 const before=state(h);await assert.rejects(h.confirm({...request,note:"別の確認"}));await assert.rejects(h.confirm({...request,input:{...request.input,storeName:"別店舗"}}));assert.equal(state(h),before);
});
await test("保存失敗なら補正・監査・案件が残らない",async()=>{
 const h=draftFixture(),request=await h.make(),before=state(h);h.failCommit=true;await assert.rejects(h.confirm(request));assert.equal(state(h),before);
});
for(const [name,mutate]of [
 ["受信版",h=>h.records.get(h.paths.receipt).revision++],["候補版",h=>h.records.get(h.paths.candidate).revision++],
 ["解析指紋",h=>h.records.get(h.paths.receipt).analysisHash="e".repeat(64)],["本文指紋",h=>h.records.get(h.paths.receipt).sourceFingerprint="e".repeat(64)],
 ["別会社受信",h=>h.records.get(h.paths.receipt).companyId="other"],["別会社候補",h=>h.records.get(h.paths.candidate).companyId="other"],
 ["出典不一致",h=>h.records.get(h.paths.candidate).source.sha256="e".repeat(64)],
 ["複数候補",h=>h.records.get(h.paths.receipt).candidateIds.push("another")],["取消",h=>h.records.get(h.paths.receipt).status="cancelled"],
 ["再解析保留",h=>h.records.get(h.paths.receipt).heldAnalysisHash="f".repeat(64)],["既存対応",h=>h.records.get(h.paths.candidate).targetBinding={jobId:"existing"}],
 ["未検証",h=>h.records.get(h.paths.receipt).verification="preview"],["検証経路違い",h=>delete h.records.get(h.paths.receipt).verificationScope],
 ["登録停止",h=>h.records.get(h.paths.feature).caseMailJobCreationEnabled=false],["実行者停止",h=>h.records.get(h.paths.principal).active=false],
 ["実行者版",h=>h.records.get(h.paths.principal).revision="next"],["条件付き人数",h=>h.records.get(h.paths.candidate).sourceValues.headcount="販売1名 補助1名"],
 ["複数名",h=>h.records.get(h.paths.candidate).sourceValues.headcount=2],
 ["補正後の日付店舗に既存案件",h=>h.records.set("jobs/existing",{companyId,workDate:h.input.workDate,storeName:h.input.storeName})],
 ["別の補正済み候補",h=>h.records.set("caseMailIntakeCandidates/other",{companyId,receiptId:"other",status:"review",workDate:h.input.workDate,input:{storeName:""},draftReview:{input:{storeName:h.input.storeName}}})]
])await test(name+"を確認保存前に拒否",async()=>{const h=draftFixture(),request=await h.make();mutate(h);const before=state(h);await assert.rejects(h.confirm(request));assert.equal(state(h),before);});
for(const [name,patch]of [["存在しない日付",{workDate:"2026-02-30"}],["対象外日付",{workDate:"2026-09-30"}],["空欄",{clientName:" "}],["未定",{menuName:"未定"}],["逆転時刻",{workTime:"18:00-10:00"}],["不正時計",{entryTime:"25:00"}],["入店遅れ",{entryTime:"11:00"}],["追加公開指定",{publicationMode:"immediate"}]])await test(name+"の補正を保存しない",async()=>{const h=draftFixture(),request=await h.make(),before=state(h);await assert.rejects(h.confirm({...request,input:{...request.input,...patch}}));assert.equal(state(h),before);});
for(const field of ["entireSourceConfirmed","newSingleCaseConfirmed"])await test(field+"未確認なら保存不可",async()=>{const h=draftFixture(),request=await h.make();await assert.rejects(h.confirm({...request,[field]:false}));assert.equal(h.list("auditLogs").length,0);});
for(const auth of [null,{uid:"staff",token:{companyId,role:"staff"}},{uid:"admin",token:{companyId:"other",role:"admin"}}])await test("管理者本人・会社の照合を強制",async()=>{const h=draftFixture(),request=await h.make(),before=state(h);await assert.rejects(h.confirm(request,auth));assert.equal(state(h),before);});
await test("確認後の監査欠落を下書き作成で拒否",async()=>{const h=draftFixture();await h.confirm(await h.make());const command={mailIntake:{...h.command.mailIntake,expectedRevision:2}};for(const [p,row]of h.records)if(row.action==="caseMail.draft.confirm")h.records.delete(p);await assert.rejects(h.create(command));assert.equal(h.list("jobs").length,0);});
await test("確認後に現れた重複案件を下書き作成で拒否",async()=>{const h=draftFixture();await h.confirm(await h.make());h.records.set("jobs/other",{companyId,workDate:h.input.workDate,storeName:h.input.storeName});await assert.rejects(h.createReviewed());assert.equal(h.list("caseMailJobCreates").length,0);});
await test("トランザクション中の受信変更を再読して拒否",async()=>{const h=draftFixture(),request=await h.make();h.beforeCommit=async({writes})=>{if(writes.length){h.beforeCommit=null;h.records.get(h.paths.receipt).revision++;}};await assert.rejects(h.confirm(request));assert.equal(h.list("auditLogs").length,0);});
const {setup}=await import("./case-mail-publication-harness.mjs");
async function manualPublication(){return setup(true,async h=>{
 const r=h.records.get(h.paths.receipt),c=h.records.get(h.paths.candidate),corrected={...c.input};
 Object.assign(r,{status:"review",structuralComplete:false,verificationScope:"registered-server-provider",analysisHash:"d".repeat(64),issues:["SOURCE_REVIEW"]});
 Object.assign(c,{status:"review",sourceValues:{headcount:1},parserSource:{ruleId:"combined-body-review-v1"},input:{...c.input,clientName:""}});
 const scope={expectedCompanyId:companyId,expectedActorUid:h.auth.uid,receiptId:h.command.mailIntake.receiptId,candidateId:h.command.mailIntake.candidateId};
 const view=await h.load("./case-mail-review").getCaseMailReceipt({data:{expectedCompanyId:companyId,expectedActorUid:h.auth.uid,receiptId:scope.receiptId},auth:h.auth});
 await h.load("./case-mail-draft-review").confirmCaseMailDraftReview({data:{...scope,reviewVersion:view.candidates[0].draftReview.reviewVersion,input:Object.fromEntries(["workDate","clientName","storeName","makerName","menuName","entryTime","workTime"].map(k=>[k,corrected[k]])),note:"合成原文全体を照合",entireSourceConfirmed:true,newSingleCaseConfirmed:true},auth:h.auth});
 h.command.mailIntake.expectedRevision=2;
});}
await test("補正下書き→原本再取込→照合済みの版だけ募集",async()=>{const h=await manualPublication();assert.equal(h.job().status,"draft");assert.equal((await h.publishNow()).updated.length,1);assert.equal(h.job().status,"open");});
await test("補正後も原本不一致・受信再解析で募集不可",async()=>{const h=await manualPublication();h.source().values.storeName="原本変更";assert.equal((await h.publishNow()).updated.length,0);h.source().values.storeName=h.job().storeName;h.records.get(h.paths.receipt).heldAnalysisHash="f".repeat(64);assert.equal((await h.publishNow()).updated.length,0);});
await test("補正監査改ざんを募集前に拒否",async()=>{const h=await manualPublication();for(const row of h.list("auditLogs"))if(row.action==="caseMail.draft.confirm")h.records.get(row.path).review.note="変更";await assert.rejects(h.publishNow());assert.equal(h.job().status,"draft");});
console.log(`原文補正・下書き作成: ${count}条件成功`);
