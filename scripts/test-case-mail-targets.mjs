import assert from "node:assert/strict";
import { harness, clone, plain, companyId } from "./case-mail-test-harness.mjs";
function setup() {
  const h = harness(), api = h.load("./case-mail-review");
  h.records.get(h.paths.receipt).status = "review";
  h.records.get(h.paths.candidate).status = "review";
  const input = h.records.get(h.paths.candidate).input;
  const job = { companyId, ...clone(input), status:"draft", basePay:12345, privateMemo:"PRIVATE_SYNTHETIC" };
  h.records.set("jobs/target-1", job);
  h.read = async () => {
    const before = JSON.stringify([...h.records]);
    const out = await api.getCaseMailReceipt({auth:h.auth,data:{expectedCompanyId:companyId,expectedActorUid:h.auth.uid,receiptId:"receipt-1"}});
    assert.equal(JSON.stringify([...h.records]),before,"読取で記録が変わらない");
    assert.ok(h.commits.every(c=>c.length===0));
    return plain(out);
  };
  return h;
}
let count=0;
async function test(name,run){await run();count++;console.log("成功: "+name);}
await test("別受信元・既存Crew案件を未確定候補として返し秘密を返さない",async()=>{
  const h=setup();h.records.set("jobs/target-2",{...clone(h.records.get("jobs/target-1")),mailIntake:{receiptId:"different-message"},cancelled:true});
  const out=await h.read(),targets=out.candidates[0].targetCandidates;
  assert.equal(targets.state,"complete");assert.deepEqual(targets.items.map(x=>x.jobId),["target-1","target-2"]);
  assert.equal(targets.items[1].cancelled,true);assert.equal(out.candidates[0].creatable,false);
  assert.ok(!JSON.stringify(out).includes("PRIVATE_SYNTHETIC"));assert.ok(!JSON.stringify(targets).includes("basePay"));
});
await test("別会社・別日・別店舗・同一受信元を除外",async()=>{
  const h=setup(),job=h.records.get("jobs/target-1");
  for(const [id,delta] of [["other-company",{companyId:"other"}],["other-day",{workDate:"2026-10-11"}],["other-store",{storeName:"別店"}],["same-receipt",{mailIntake:{receiptId:"receipt-1"}}]])h.records.set("jobs/"+id,{...clone(job),...delta});
  assert.deepEqual((await h.read()).candidates[0].targetCandidates.items.map(x=>x.jobId),["target-1"]);
});
await test("店舗の全半角・空白・大小文字は既存照合と同じ",async()=>{
  const h=setup();h.records.get(h.paths.candidate).input.storeName=" ＡｂＣ 店 ";h.records.get("jobs/target-1").storeName="abc店";
  assert.equal((await h.read()).candidates[0].targetCandidates.items.length,1);
});
for(const [name,delta] of [["空店舗",{storeName:" "}],["不正日",{workDate:"2026-02-30"}],["対象期間外",{workDate:"2026-09-30"}]])await test(name+"を候補なしにしない",async()=>{
  const h=setup();Object.assign(h.records.get(h.paths.candidate).input,delta);assert.equal((await h.read()).candidates[0].targetCandidates.state,"insufficient");
});
await test("同日同店がゼロなら検索範囲内だけ候補なし",async()=>{const h=setup();h.records.delete("jobs/target-1");assert.deepEqual((await h.read()).candidates[0].targetCandidates,{state:"complete",items:[]});});
await test("11件目以降は表示上限と明示",async()=>{
  const h=setup(),job=h.records.get("jobs/target-1");for(let i=0;i<10;i++)h.records.set("jobs/extra-"+i,clone(job));
  const out=(await h.read()).candidates[0].targetCandidates;assert.equal(out.state,"limited");assert.equal(out.items.length,10);
});
await test("201件の検索打切りで見つからなくても候補なしにしない",async()=>{
  const h=setup(),job=clone(h.records.get("jobs/target-1"));h.records.delete("jobs/target-1");
  for(let i=0;i<201;i++)h.records.set("jobs/extra-"+i,{...job,storeName:"別店"});
  assert.deepEqual((await h.read()).candidates[0].targetCandidates,{state:"limited",items:[]});
});
await test("同日を再利用し6日目は検索上限を明示",async()=>{
  const h=setup(),receipt=h.records.get(h.paths.receipt),candidate=h.records.get(h.paths.candidate);
  for(let i=0;i<6;i++){const id="extra-"+i;receipt.candidateIds.push(id);h.records.set("caseMailIntakeCandidates/"+id,{...clone(candidate),input:{...candidate.input,workDate:"2026-10-"+String(10+i).padStart(2,"0")}});}
  const rows=(await h.read()).candidates;assert.equal(rows[1].targetCandidates.items.length,1);assert.equal(rows[5].targetCandidates.state,"complete");assert.equal(rows[6].targetCandidates.state,"limited");
});
await test("通常新規受信には対象候補を付けない",async()=>{const h=setup();h.records.get(h.paths.receipt).status="ready";h.records.get(h.paths.candidate).status="ready";assert.equal((await h.read()).candidates[0].targetCandidates,undefined);});
console.log("別メール対象候補: "+count+"条件成功（合成DB・書込みなし）");
