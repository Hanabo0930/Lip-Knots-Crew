import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { validatePlan, safetyConfig } from "./validate-staging-scope.mjs";
import { assertSyncSource, assertPrivateReadiness, materializePrivateReadiness,
  verifyPrivateService, SYNC_CONFIRMATION } from "./staging-gas-sync-readiness.mjs";
const require = createRequire(import.meta.url);
const { installInvokerAdapter } = require("./run-staging-firebase-deploy.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = { mode: "functions-deploy", project: "lip-knots-crew-staging", region: "asia-northeast1",
  sourceRef: "main", functions: "caseListGasSync", confirmation: SYNC_CONFIRMATION };
const plan = validatePlan(base), results = [];
async function test(name, fn) {
  try { await fn(); results.push({name, passed: true}); }
  catch (error) { results.push({name, passed: false, error: error.message}); }
}
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const sourceFiles = ["index.ts", "case-list-gas-sync-entry.ts", "case-list-gas-handoff.ts",
  "case-list-gas-handoff-core.cjs", "case-list-gas-sync-runtime.ts", "case-list-gas-sync-rpc-core.cjs"];
const original = [
  "APP_ENVIRONMENT=staging", "EXPECTED_FIREBASE_PROJECT_ID=lip-knots-crew-staging",
  "DEFAULT_COMPANY_ID=fixture-company", "EXECUTIVE_APPROVER_EMAILS=owner@example.invalid",
  "LKC_SHEET_WRITE_MODE=paused", "LKC_NOTIFICATION_DELIVERY_MODE=paused",
  "UNRELATED_SYNTHETIC_SETTING=retained", "",
].join("\n");
function fixture(extra = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lkc-private-readiness-"));
  fs.mkdirSync(path.join(dir, "functions/src"), {recursive: true});
  for (const file of sourceFiles) fs.copyFileSync(path.join(root, "functions/src", file), path.join(dir, "functions/src", file));
  const env = path.join(dir, "functions/.env.lip-knots-crew-staging");
  fs.writeFileSync(env, original + extra);
  return {dir, env};
}
function mockCloud(options = {}) {
  const calls = [];
  const execute = (command, args) => {
    calls.push({command, args});
    assert.equal(command, "gcloud");
    assert.equal(args[0], "run"); assert.equal(args[1], "services");
    assert(["list", "describe", "get-iam-policy"].includes(args[2]));
    assert(args.includes("lip-knots-crew-staging") && args.includes("asia-northeast1"));
    assert(!args.some(a => /--no-invoker|add-iam|set-iam|update/.test(a)));
    if (options.failure) throw Error("synthetic read refusal");
    if (options.invalidJson) return "not json";
    if (args[2] === "list") return JSON.stringify(options.absent ? [] : [{metadata: {name: options.name ?? "caselistgassync"}}]);
    if (args[2] === "describe") return JSON.stringify({metadata: {name: "caselistgassync",
      annotations: options.disabled ? {"run.googleapis.com/invoker-iam-disabled": "true"} : {}}});
    return JSON.stringify({etag: "synthetic-etag", bindings: [{role: "roles/run.invoker", members: options.members ?? ["serviceAccount:fixture@example.invalid"]}]});
  };
  return {calls, execute};
}
await test("exact private main scope requires its dedicated confirmation", () => assert.deepEqual(plan.functions, ["caseListGasSync"]));
for (const [name, delta] of [
  ["production", {project:"production"}], ["other project", {project:"another-staging"}],
  ["other region", {region:"us-central1"}], ["branch", {sourceRef:"automation/fixture"}],
  ["mixed target", {functions:"caseListGasSync,bootstrapSession"}],
  ["duplicate", {functions:"caseListGasSync,caseListGasSync"}],
  ["generic confirmation", {confirmation:safetyConfig.confirmations.functionsDeploy}],
  ["missing confirmation", {confirmation:""}],
]) await test("scope rejects " + name, () => assert.throws(() => validatePlan({...base,...delta})));
await test("unknown function remains refused", () => assert.throws(() => validatePlan({...base,functions:"unapprovedFunction"})));
await test("existing function still uses its original confirmation", () => {
  const legacy = {...base,functions:"bootstrapSession",confirmation:safetyConfig.confirmations.functionsDeploy};
  assert.equal(validatePlan(legacy).functions[0], "bootstrapSession");
  assert.throws(() => validatePlan({...legacy,confirmation:SYNC_CONFIRMATION}));
});
await test("default materialization is OFF private and preserves unrelated values", () => {
  const f=fixture(), out=materializePrivateReadiness(plan,f.dir);
  assert.deepEqual(out,{mode:"off",publicInvoker:false,businessEnabled:false});
  const text=fs.readFileSync(f.env,"utf8");assert(text.includes("UNRELATED_SYNTHETIC_SETTING=retained"));
  assert(text.includes("LKC_CASE_LIST_EXTERNAL_MODE=read-only"));assert(!/active=true|caseMailIntakeEnabled/.test(text));
});
await test("explicit read-only requires and carries a fixed audience without business settings", () => {
  const f=fixture();assert.equal(materializePrivateReadiness(plan,f.dir,{mode:"read-only",audience:"123-fixture.apps.googleusercontent.com"}).mode,"read-only");
  assert.equal(assertPrivateReadiness(plan,f.dir).publicInvoker,false);
  assert(!fs.readFileSync(f.env,"utf8").includes("LKC_GAS_SYNC_OWNER_UID"));
});
for(const [name, input]of [["business",{mode:"business"}],["unknown mode",{mode:"enabled"}],
  ["public invoker",{publicInvoker:"true"}],["wildcard audience",{mode:"read-only",audience:"*"}],
  ["missing audience",{mode:"read-only"}]]) await test("materializer rejects "+name+" without writing",()=>{
  const f=fixture(), before=fs.readFileSync(f.env,"utf8");assert.throws(()=>materializePrivateReadiness(plan,f.dir,input));assert.equal(fs.readFileSync(f.env,"utf8"),before);
});
for(const [name, extra]of [["existing business mode","LKC_GAS_SYNC_MODE=business\n"],
 ["existing public mode","LKC_GAS_SYNC_PUBLIC_INVOKER=true\n"],
 ["existing external writer","LKC_CASE_LIST_EXTERNAL_MODE=enabled\n"],
 ["duplicate setting","DEFAULT_COMPANY_ID=second-company\n"]])await test("source dotenv rejects "+name,()=>{
  const f=fixture(extra);assert.throws(()=>materializePrivateReadiness(plan,f.dir));
});
await test("production dotenv and disabled legacy pauses remain rejected",()=>{
  for(const [a,b]of [["APP_ENVIRONMENT=staging","APP_ENVIRONMENT=production"],["LKC_SHEET_WRITE_MODE=paused","LKC_SHEET_WRITE_MODE=active"],["LKC_NOTIFICATION_DELIVERY_MODE=paused","LKC_NOTIFICATION_DELIVERY_MODE=active"]]){
    const f=fixture();fs.writeFileSync(f.env,original.replace(a,b));assert.throws(()=>materializePrivateReadiness(plan,f.dir));
  }
});
await test("alternate dotenv cannot override private settings",()=>{const f=fixture();fs.writeFileSync(path.join(f.dir,"functions/.env"),"LKC_GAS_SYNC_PUBLIC_INVOKER=true\n");assert.throws(()=>materializePrivateReadiness(plan,f.dir));});
await test("actual auth/entry source passes in LF and CRLF",()=>{assertSyncSource(read);assertSyncSource(file=>read(file).replace(/\n/g,"\r\n"));});
for(const [name,file,from,to]of [
 ["signature verification","case-list-gas-handoff.ts","verifier.verifyIdToken({ idToken: token, audience })","readUnverified(token)"],
 ["Google provider UID","case-list-gas-handoff.ts",'auth.getUserByProviderUid("google.com", subject)','auth.getUser(subject)'],
 ["issuer","case-list-gas-handoff-core.cjs","claims.iss===ISSUER&&",""],
 ["audience","case-list-gas-handoff-core.cjs","claims.aud===c.audience&&",""],
 ["auth_time","case-list-gas-handoff-core.cjs","finite(claims.auth_time)&&",""],
 ["role","case-list-gas-handoff-core.cjs","cc.role==='admin'&&",""],
 ["company","case-list-gas-handoff-core.cjs","cc.companyId===c.companyId&&",""],
 ["disabled","case-list-gas-handoff-core.cjs","user.disabled===false&&",""],
 ["MFA","case-list-gas-handoff-core.cjs","user.mfaState==='NONE'","true"],
 ["revocation","case-list-gas-handoff-core.cjs","claims.auth_time*1000>=user.validSinceMs","true"],
 ["read-only action boundary","case-list-gas-sync-entry.ts",'if (mode === "read-only" && !["READINESS_ONLY", "OBSERVE"].includes(request.body?.action))','if (false)'],
 ["approval-authority routing", "case-list-gas-sync-runtime.ts",
   "baseAuth:createGasOwnerAuthContext(baseAuth,req.body,{db:database,now})", "baseAuth:baseAuth"],
 ["preflight operation scope", "case-list-gas-sync-rpc-core.cjs",
   "q.sequence===0&&q.operationKey===''&&(keys.length===0", "q.sequence===0&&(keys.length===0"],
 ["preflight approval context", "case-list-gas-sync-rpc-core.cjs",
   "keys.join('|')==='ownerApprovalRef'&&s.auth.ownerContext!==undefined", "keys.includes('ownerApprovalRef')"],
 ["zero write effects", "case-list-gas-sync-rpc-core.cjs",
   "businessEnabled:false,effects:{mail:0,sheets:0,storage:0}", "businessEnabled:false,effects:{mail:0,sheets:1,storage:0}"],
])await test("source guard rejects weakened "+name,()=>{
  const target="functions/src/"+file;assert(read(target).includes(from));assert.throws(()=>assertSyncSource(f=>f===target?read(f).replace(from,to):read(f)));
});
await test("commented-out identity guard does not satisfy source validation",()=>{
  const target="functions/src/case-list-gas-handoff-core.cjs";
  assert.throws(()=>assertSyncSource(f=>f===target?read(f).split("\n").map(s=>s.includes("claims.iss===ISSUER")?"//"+s:s).join("\n"):read(f)));
});
await test("private create/update adapter never calls IAM mutation implementation",async()=>{
  let mutations=0;const api={setInvokerCreate:async()=>mutations++,setInvokerUpdate:async()=>mutations++};installInvokerAdapter(api,plan,()=>{});
  const service="projects/lip-knots-crew-staging/locations/asia-northeast1/services/caselistgassync";
  await api.setInvokerCreate(plan.project,service,["private"]);await api.setInvokerUpdate(plan.project,service,["private"]);assert.equal(mutations,0);
  for(const invoker of [["public"],["allUsers"],["private","public"],[]]){
    await assert.rejects(()=>api.setInvokerCreate(plan.project,service,invoker));await assert.rejects(()=>api.setInvokerUpdate(plan.project,service,invoker));
  }
  await assert.rejects(()=>api.setInvokerCreate("other-project",service,["private"]));
  await assert.rejects(()=>api.setInvokerUpdate(plan.project,service.replace("caselistgassync","bootstrapsession"),["private"]));
  assert.equal(mutations,0);
});
await test("legacy adapter still refuses unexpected public creation scope",async()=>{
  const api={setInvokerCreate:async()=>{throw Error("real mutation must never run");}};
  installInvokerAdapter(api,{...plan,functions:["bootstrapSession"]},()=>{});
  await assert.rejects(()=>api.setInvokerCreate(plan.project,"projects/other/locations/asia-northeast1/services/bootstrapsession",["public"]));
});
await test("absent private service permits preflight only",()=>{
  const m=mockCloud({absent:true});assert.equal(verifyPrivateService(plan,"before",m.execute).exists,false);assert.equal(m.calls.length,1);
  assert.throws(()=>verifyPrivateService(plan,"after",m.execute));
});
await test("existing private service requires metadata and IAM reads",()=>{const m=mockCloud();assert.equal(verifyPrivateService(plan,"after",m.execute).privateVerified,true);assert.equal(m.calls.length,3);});
for(const [name,opts]of [["IAM check disabled",{disabled:true}],["allUsers",{members:["allUsers"]}],
 ["allAuthenticatedUsers",{members:["allAuthenticatedUsers"]}],["wrong service",{name:"bootstrapsession"}],
 ["read refusal",{failure:true}],["unparseable response",{invalidJson:true}]])await test("private readback rejects "+name,()=>{
  const m=mockCloud(opts);assert.throws(()=>verifyPrivateService(plan,"before",m.execute));
});
await test("deploy shell routes sync to private readback without the generic public update",()=>{
  const shell=read("scripts/automation/deploy-staging-functions.sh"),block=shell.split("    caseListGasSync)")[1]?.split(";;")[0];
  assert(block?.includes("--verify-after"));assert(block.includes('service_name=""'));assert(!block.includes("--no-invoker-iam-check"));
});
await test("workflow remains manual and offers only OFF/read-only private settings",()=>{
  const workflow=read(".github/workflows/staging-functions-deploy.yml");
  assert(/^on:\n  workflow_dispatch:/m.test(workflow));assert(!/^  (push|pull_request|schedule|workflow_run):/m.test(workflow));
  const block=workflow.split("      gas_sync_mode:")[1].split("      confirmation:")[0];
  assert(block.includes("default: off")&&block.includes("- read-only"));assert(!block.includes("- business"));
  assert(workflow.includes('LKC_GAS_SYNC_PUBLIC_INVOKER: "false"'));assert(workflow.includes("environment: lkc-staging-deploy"));
});
await test("source-auth CLI uses the same guard with a mocked Git reader only",()=>{
  const output=[];const scanner=read("scripts/automation/check-function-auth-guards.mjs").replace(/^import[^\n]*\n/gm,"");
  vm.runInNewContext(scanner,{process:{argv:["node","guard","--functions","caseListGasSync","--require-pass"],exit:code=>{throw Error("guard exit "+code);}},
    execFileSync:(cmd,args)=>{assert.equal(cmd,"git");assert.equal(args[0],"show");return read(args[1].slice(args[1].indexOf(":")+1));},
    assertSyncSource,assertRetryWorkerSource:()=>{throw Error("unexpected worker guard");},console:{log:s=>output.push(s),error:s=>output.push(s)}});
  assert(output.includes("APP_LEVEL_AUTH_caseListGasSync=PASS"));assert(output.includes("SOURCE_GUARD_STATUS=PASS"));
});
console.log(JSON.stringify({passed:results.filter(x=>x.passed).length,total:results.length,
  cloudCommandsExecuted:0,IAMWrites:0,deployments:0,fixtures:"synthetic local only; Cloud and Git command ports mocked",results},null,2));
if(results.some(x=>!x.passed))process.exitCode=1;
