import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url), ts = require("typescript");
const compile = value => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exported = {};
Function("exports", compile(fs.readFileSync("apps/admin/src/recruitment-draft.ts", "utf8")))(exported);
const { recruitmentDraftCandidate, recruitmentDraftRequest, parseRecruitmentDraft, recruitmentSubjects } = exported;
const ownerHelpers = {}, searchHelpers = {};
Function("exports", compile(fs.readFileSync("apps/admin/src/owner-source-publication.ts", "utf8")))(ownerHelpers);
Function("exports", compile(fs.readFileSync("apps/admin/src/job-search.ts", "utf8")))(searchHelpers);
const base = { id: "synthetic-job", workDate: "2026-11-20", clientName: "合成依頼元", storeName: "合成店舗", makerName: "合成メーカー", menuName: "合成試食", region: "通常", revision: 2, status: "open", publishable: true, sourceReady: true, caseListSource: { sourceRevision: "a".repeat(64) } };
const request = () => recruitmentDraftRequest([base], [base.id], "通常", recruitmentSubjects[0], "案内");
let tests = 0;
function test(name, callback) { callback(); tests++; }
test("only explicit public selection coordinates leave the client", () => {
  const job = { ...base, staffPaymentInputs: { private: 4567 }, privateReceipt: "NEVER_SEND", financials: { clientChargeTotal: 90001 } };
  assert.equal(recruitmentDraftCandidate(job), true);
  assert.deepEqual(recruitmentDraftRequest([job], [job.id], "通常", recruitmentSubjects[0], "案内"), request());
  assert.deepEqual(Object.keys(request().selections[0]), ["jobId", "expectedJobRevision", "expectedSourceRevision"]);
  assert.ok(!JSON.stringify(request()).includes("NEVER_SEND"));
});
for (const patch of [{sourceReady:false}, {sourceReady:undefined}, {sheetRef:{}}, {caseListManualPending:{state:"PENDING"}}, {assignmentSheetWrite:{pending:true}}, {cancellationSheetWrite:{sourceAckPending:true}}, {status:"cancelled"}, {cancelled:true}, {status:"draft"}, {status:"assigned"}, {publishable:false}, {recruitmentStopped:true}, {assignedStaffId:"staff"}, {assignedStaffName:"担当者"}, {sourceMissing:true}, {assignmentUnresolved:true}, {applicationUnconfirmed:true}, {pendingSourceWrite:true}, {adminEditSheetWrite:{pending:true}}, {region:""}, {region:" 通常"}, {region:"通常 "}, {region:undefined}, {revision:undefined}, {revision:-1}, {caseListSource:undefined}, {caseListSource:{sourceRevision:"stale"}}]) {
  test("unsafe candidate " + JSON.stringify(patch), () => { assert.equal(recruitmentDraftCandidate({...base,...patch}),false); assert.throws(() => recruitmentDraftRequest([{...base,...patch}], [base.id], "通常", recruitmentSubjects[0], "")); });
}
for (const [jobs,ids,region,subject,notice] of [
  [[base],[],"通常",recruitmentSubjects[0],""], [[base],[base.id,base.id],"通常",recruitmentSubjects[0],""], [[base,base],[base.id],"通常",recruitmentSubjects[0],""],
  [[base],["missing"],"通常",recruitmentSubjects[0],""], [[base],[base.id],"東北",recruitmentSubjects[0],""], [[base],[base.id],"","bad", ""],
  [[base],[base.id],"通常","bad", ""], [[base],[base.id],"通常",recruitmentSubjects[0],"x".repeat(4001)],
  [Array.from({length:21},(_,i)=>({...base,id:String(i)})),Array.from({length:21},(_,i)=>String(i)),"通常",recruitmentSubjects[0],""],
]) test("invalid request", () => assert.throws(() => recruitmentDraftRequest(jobs,ids,region,subject,notice)));
const response = { purpose: "recruitment-draft", subject: recruitmentSubjects[0], body: "合成募集文", caseCount: 1, region: "通常", validatedAt: "2026-10-29T00:00:00.000Z", dispatch: "disabled" };
test("server response is explicitly whitelisted", () => assert.deepEqual(parseRecruitmentDraft({...response,privateReceipt:"NEVER_RETURN"}, request()),response));
for (const patch of [{purpose:"csv"},{subject:"other"},{body:""},{caseCount:2},{region:"東北"},{validatedAt:"bad"},{dispatch:"sent"}]) test("mismatched response", () => assert.throws(() => parseRecruitmentDraft({...response,...patch},request())));

const component = fs.readFileSync("apps/admin/src/RecruitmentDraftPanel.tsx", "utf8");
const handlerCode = compile(component.slice(component.indexOf("  async function runDraft("), component.indexOf("  return <details")));
function deferred() { let resolve,reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }
function setup() {
  const state = { calls:[], gates:[], drafts:[], messages:[], copies:[], busy:false, clipboardError:false };
  const deps = { runRef:{current:null}, functions:{}, demo:false, auth:{currentUser:{}}, recruitmentDraftRequest, jobs:[base], ids:[base.id], region:"通常", subject:recruitmentSubjects[0], notice:"案内", generation:{current:1}, inputKey:"current", inputRef:{current:"current"},
    setBusy:value=>{state.busy=value;}, setDraft:value=>state.drafts.push(value), setMessage:value=>state.messages.push(value), parseRecruitmentDraft,
    httpsCallable:(fn,name)=>{assert.equal(name,"generateJobExport");return async payload=>{state.calls.push(payload);const gate=deferred();state.gates.push(gate);return gate.promise;};},
    navigator:{clipboard:{writeText:async text=>{if(state.clipboardError)throw Error("clipboard denied");state.copies.push(text);}}},
  };
  const handler=Function(...Object.keys(deps),handlerCode+";return runDraft;")(...Object.values(deps));
  return {state,deps,handler};
}
async function asyncTest(name, callback) { await callback(); tests++; }
await asyncTest("double click sends only one source revalidation", async()=>{const t=setup(),run=t.handler();await t.handler();assert.equal(t.state.calls.length,1);t.state.gates[0].resolve({data:response});await run;assert.equal(t.state.drafts.at(-1).body,response.body);assert.equal(t.state.busy,false);});
for (const reason of ["auth", "input", "epoch"]) for (const reject of [false,true]) await asyncTest("discard stale " + reason + " " + reject, async()=>{
  const t=setup(),run=t.handler("body");
  if(reason==="auth")t.deps.auth.currentUser={}; else if(reason==="input")t.deps.inputRef.current="changed"; else t.deps.generation.current++;
  reject?t.state.gates[0].reject(Error("old error")):t.state.gates[0].resolve({data:response});await run;
  assert.equal(t.state.copies.length,0);assert.equal(t.state.drafts.filter(Boolean).length,0);assert.equal(t.state.messages.filter(Boolean).length,0);
});
await asyncTest("older completion cannot release a newer run",async()=>{const t=setup(),first=t.handler();t.deps.runRef.current=null;const second=t.handler();const owner=t.deps.runRef.current;t.state.gates[0].resolve({data:response});await first;assert.equal(t.deps.runRef.current,owner);assert.equal(t.state.busy,true);t.state.gates[1].resolve({data:response});await second;assert.equal(t.state.busy,false);assert.equal(t.state.drafts.filter(Boolean).length,1);});
for(const field of ["body","subject"])await asyncTest("copy revalidates before clipboard " + field,async()=>{const t=setup(),run=t.handler(field);assert.equal(t.state.calls.length,1);assert.equal(t.state.copies.length,0);t.state.gates[0].resolve({data:response});await run;assert.deepEqual(t.state.copies,[response[field]]);assert.match(t.state.messages.at(-1),/再照合.*コピーしました/);});
await asyncTest("source rejection prevents copy",async()=>{const t=setup(),run=t.handler("body");t.state.gates[0].reject(Error("source changed"));await run;assert.equal(t.state.copies.length,0);assert.equal(t.state.drafts.at(-1),null);assert.equal(t.state.messages.at(-1),"source changed");});
await asyncTest("clipboard denial keeps visible fresh text and does not claim copy success",async()=>{const t=setup();t.state.clipboardError=true;const run=t.handler("body");t.state.gates[0].resolve({data:response});await run;assert.equal(t.state.copies.length,0);assert.equal(t.state.drafts.at(-1).body,response.body);assert.match(t.state.messages.at(-1),/手動コピー/);});
await asyncTest("unverified result never reaches clipboard",async()=>{const t=setup(),run=t.handler("body");t.state.gates[0].resolve({data:{...response,dispatch:"sent"}});await run;assert.equal(t.state.copies.length,0);assert.equal(t.state.drafts.filter(Boolean).length,0);});
const app = fs.readFileSync("apps/admin/src/App.tsx", "utf8");
const publicationCode=compile(app.slice(app.indexOf("async function changePublicationAction("),app.indexOf("function loadJobEdit(")));
async function publish(sourceRegion,enteredRegion=sourceRegion){
  const state={payloads:[],messages:[],prompts:[]},preview={jobId:base.id,sourceRevision:base.caseListSource.sourceRevision,sourceState:"募集中",region:sourceRegion,ownerReviewRequired:false,reviewIssues:[]};
  const deps={...ownerHelpers,isCancelledJob:searchHelpers.isCancelledJob,setMessage:m=>state.messages.push(m),functions:{},firebaseConfigured:true,window:{prompt:(message,initial)=>{state.prompts.push(message);return state.prompts.length===1?"10000":enteredRegion;},confirm:()=>true},httpsCallable:(fn,name)=>async payload=>{state.payloads.push({name,payload});return {data:name==="previewShiftImport"?{rows:[preview]}:{updated:[base.id],blocked:[]}};},refreshJobsAfterAction:async()=>{},parsePublicationDateInput:()=>null};
  const handler=Function(...Object.keys(deps),publicationCode+";return changePublicationAction;")(...Object.values(deps));await handler(base,"publish",()=>true);return state;
}
for(const region of ["",undefined," 通常","通常 "])await asyncTest("unconfirmed Source BE stops publication " + region,async()=>{const state=await publish(region);assert.equal(state.payloads.filter(x=>x.name==="updateJobPublication").length,0);assert.match(state.messages.at(-1),/状態・地域|地域.*未確認/);});
await asyncTest("owner cannot replace BE with a different region",async()=>{const state=await publish("通常","東北");assert.equal(state.payloads.filter(x=>x.name==="updateJobPublication").length,0);assert.match(state.messages.at(-1),/一致しません/);});
await asyncTest("same BE is explicitly included in publisher confirmation",async()=>{const state=await publish("東北"),sent=state.payloads.find(x=>x.name==="updateJobPublication");assert.equal(sent.payload.caseListConfirmations[base.id].confirmedRegion,"東北");assert.ok(!("region" in sent.payload));});
assert.match(component,/onAuthStateChanged\(auth/);assert.match(component,/generation.current\+\+; runRef.current = null/);assert.match(component,/募集文に掲載/);assert.match(component,/送信はご自身で/);
console.log(JSON.stringify({adminRecruitmentDraftTests:tests,status:"PASS",nativeRequests:0,cloudWrites:0,realCopies:0}));
