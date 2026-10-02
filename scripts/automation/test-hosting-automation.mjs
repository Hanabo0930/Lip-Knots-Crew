import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {spawnSync} from "node:child_process";
import {runVersionRestoreTests} from "./test-hosting-version-restore.mjs";
import { readFileSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
  resolve,
  sep as pathSep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractSiteIds,
  findVapidCandidates,
  renderClientEnv,
  resolveFirebaseConfigs,
  selectHostingSites,
  selectApplicationVapidKey,
  validateFirebaseInit,
} from "./prepare-staging-hosting-config.mjs";
import {
  extractChannels,
  resolveChannelUrl,
} from "./resolve-hosting-channel.mjs";
import {
  evaluateBrowserResult,
  shouldRetryBrowserIssues,
  validateTargetUrl,
} from "./hosting-browser-check.mjs";
import {
  restoreBothSites,
  validateRestoreOptions,
} from "./restore-staging-hosting.mjs";

let cases = 0;
const projectId = "lip-knots-crew-staging";
const staffSite = projectId;
const adminSite = "lip-knots-crew-staging-admin";
const channelId = "rc-02516b6e28e4";
const vapidKey = `B${"A".repeat(86)}`;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

for (const [workflowPath, evidenceFolder] of [
  [".github/workflows/staging-hosting-preview.yml", "hosting-preview-evidence"],
  [".github/workflows/staging-hosting-promote.yml", "hosting-promote-evidence"],
]) {
  const workflow = readFileSync(resolve(repoRoot, workflowPath), "utf8").replace(/\r\n/g, "\n");
  const jobEnvBlocks = workflow.matchAll(/^    env:\n((?:      [^\n]*\n)*)/gmu);
  for (const [, jobEnv] of jobEnvBlocks) {
    assert.doesNotMatch(
      jobEnv,
      /\$\{\{\s*runner\./u,
      `${workflowPath} cannot use the runner context in job-level env`,
    );
  }
  assert.ok(
    workflow.includes(
      [
        "      - name: Prepare evidence directory",
        "        run: |",
        `          evidence_dir="$RUNNER_TEMP/${evidenceFolder}"`,
        '          mkdir -p "$evidence_dir"',
        '          echo "LKC_EVIDENCE_DIR=$evidence_dir" >> "$GITHUB_ENV"',
      ].join("\n"),
    ),
    `${workflowPath} must initialize its evidence directory at runtime`,
  );
  assert.match(
    workflow,
    /http:\/\/azure\.archive\.ubuntu\.com\/ubuntu#https:\/\/archive\.ubuntu\.com\/ubuntu/u,
    `${workflowPath} must avoid the unreliable runner-local Azure Ubuntu mirror`,
  );
  cases += 1;
}

const promoteWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/staging-hosting-promote.yml"),
  "utf8",
).replace(/\r\n/g, "\n");
const previewWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/staging-hosting-preview.yml"),
  "utf8",
).replace(/\r\n/g, "\n");
assert.ok(
  previewWorkflow.includes(
    [
      "  preview:",
      "    needs: guard",
      "    runs-on: ubuntu-latest",
    ].join("\n"),
  ),
  "Hosting preview must start automatically after its guard succeeds",
);
assert.doesNotMatch(
  previewWorkflow,
  /^    environment: lkc-staging-hosting$/mu,
  "Hosting preview must not wait for the live-promotion approval environment",
);
assert.match(
  previewWorkflow,
  /LKC_GCP_WORKLOAD_IDENTITY_PROVIDER: projects\/740154137290\/locations\/global\/workloadIdentityPools\/lkc-github-staging\/providers\/lkc-main-workflows/u,
  "Hosting preview must pin the staging-only workload identity provider",
);
assert.match(
  previewWorkflow,
  /LKC_GCP_STAGING_DEPLOY_SERVICE_ACCOUNT: lkc-gh-staging-deploy@lip-knots-crew-staging\.iam\.gserviceaccount\.com/u,
  "Hosting preview must pin the staging-only deployment service account",
);
assert.match(
  previewWorkflow,
  /workload_identity_provider: \$\{\{ env\.LKC_GCP_WORKLOAD_IDENTITY_PROVIDER \}\}/u,
);
assert.match(
  previewWorkflow,
  /service_account: \$\{\{ env\.LKC_GCP_STAGING_DEPLOY_SERVICE_ACCOUNT \}\}/u,
);
assert.match(
  promoteWorkflow,
  /^    environment: lkc-staging-hosting$/mu,
  "Hosting promotion must keep the protected approval environment",
);
assert.match(
  promoteWorkflow,
  /workflow_run:\n    workflows: \[Staging Hosting Preview\]\n    types: \[completed\]/u,
  "A successful canonical Hosting preview must trigger promotion automatically",
);
assert.match(
  promoteWorkflow,
  /github\.event\.workflow_run\.conclusion == 'success'[\s\S]*github\.event\.workflow_run\.event == 'workflow_run'[\s\S]*github\.event\.workflow_run\.head_branch == 'main'/u,
  "Automatic promotion must accept only a successful main Preview workflow run",
);
assert.match(
  promoteWorkflow,
  /LKC_REQUESTED_SHA: \$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.head_sha \|\| inputs\.source_sha \}\}[\s\S]*LKC_CONFIRMATION: \$\{\{ github\.event_name == 'workflow_run' && 'PROMOTE_LKC_STAGING_HOSTING' \|\| inputs\.confirmation \}\}/u,
  "Automatic promotion must pin the triggering Preview SHA and preserve the required confirmation",
);
assert.match(
  promoteWorkflow,
  /CANONICAL_PREVIEW_NOT_SUCCESSFUL[\s\S]*TRIGGER_PREVIEW_MISMATCH/u,
  "Promotion must re-check both canonical and triggering Preview evidence",
);
assert.match(
  promoteWorkflow,
  /HOSTING_PROMOTION_RESULT=ALREADY_PROMOTED[\s\S]*should_promote=false[\s\S]*echo "should_promote=true"/u,
  "Promotion must skip an exact SHA that was already promoted successfully",
);
assert.match(
  promoteWorkflow,
  /promote:\n    needs: guard\n    if: needs\.guard\.outputs\.should_promote == 'true'\n    environment: lkc-staging-hosting/u,
  "Only a new validated SHA may enter the protected promotion environment",
);
assert.match(
  promoteWorkflow,
  /Checkout the exact CI-passing main source[\s\S]*Re-check source is still current main after approval[\s\S]*\/git\/ref\/heads\/main[\s\S]*current_main[\s\S]*LKC_SOURCE_SHA[\s\S]*SOURCE_SHA_CHANGED_DURING_APPROVAL[\s\S]*Set up Node/u,
  "Promotion must re-check current main after protected-environment approval and before any cloud authentication",
);
cases += 14;
assert.match(
  promoteWorkflow,
  /node scripts\/automation\/restore-staging-hosting\.mjs/u,
);
assert.match(
  promoteWorkflow,
  /- name: Verify both live staging apps after rollback[\s\S]*?if: always\(\) && steps\.rollback\.outputs\.attempted == 'true'/u,
);
const safeStopIndex = promoteWorkflow.indexOf(
  'if [[ "${{ steps.promotion.outcome }}" == "skipped" ]]',
);
const rollbackFailureIndex = promoteWorkflow.indexOf(
  "HOSTING_PROMOTION_RESULT=ROLLBACK_FAILED",
);
assert.ok(
  safeStopIndex >= 0 && rollbackFailureIndex > safeStopIndex,
  "A pre-promotion failure must be reported as safely stopped before rollback classification",
);
cases += 1;

const restoreOptions = {
  projectId,
  staffSite,
  adminSite,
  rollbackChannel: "rb-30193717024",
};
assert.equal(
  validateRestoreOptions({
    ...restoreOptions,
    evidenceDir: resolve(repoRoot, "temporary-evidence"),
  }).projectId,
  projectId,
);
assert.throws(
  () => validateRestoreOptions({
    ...restoreOptions,
    projectId: "lip-knots-production",
    evidenceDir: resolve(repoRoot, "temporary-evidence"),
  }),
  /PROJECT_NOT_ALLOWED/u,
);
cases += 2;

const temporary = await mkdtemp(join(tmpdir(), "lkc-hosting-rollback-test-"));
try {
  const calls = [];
  const result = await restoreBothSites(
    {
      ...restoreOptions,
      evidenceDir: temporary,
    },
    {
      executor: async (request) => {
        calls.push(request.label);
        return {
          code: request.label === "staff" ? 1 : 0,
          stdout: JSON.stringify({ status: request.label === "staff" ? "error" : "success" }),
        };
      },
    },
  );
  assert.equal(result.success, false);
  assert.deepEqual(calls, ["staff", "admin"]);
  assert.deepEqual(
    result.attempts.map(({ label, status }) => ({ label, status })),
    [
      { label: "staff", status: "failure" },
      { label: "admin", status: "success" },
    ],
  );
  assert.match(await readFile(join(temporary, "staff-rollback.json"), "utf8"), /error/u);
  assert.match(await readFile(join(temporary, "admin-rollback.json"), "utf8"), /success/u);
  cases += 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const sitesDocument = {
  status: "success",
  result: {
    sites: [
      { name: `projects/${projectId}/sites/${staffSite}` },
      { name: `projects/${projectId}/sites/${adminSite}` },
    ],
  },
};
assert.deepEqual(extractSiteIds(sitesDocument), [staffSite, adminSite].sort());
cases += 1;
assert.deepEqual(
  selectHostingSites(extractSiteIds(sitesDocument), { projectId }),
  { staffSite, adminSite },
);
cases += 1;
assert.throws(
  () => selectHostingSites([staffSite], { projectId }),
  /HOSTING_SITES_INSUFFICIENT/u,
);
cases += 1;

const firebaseInit = {
  apiKey: "public-web-api-key",
  authDomain: `${projectId}.firebaseapp.com`,
  projectId,
  storageBucket: `${projectId}.firebasestorage.app`,
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef",
};
assert.deepEqual(validateFirebaseInit(firebaseInit, projectId, "staff"), firebaseInit);
cases += 1;
assert.throws(
  () => validateFirebaseInit({ ...firebaseInit, projectId: "production-project" }, projectId, "staff"),
  /PROJECT_MISMATCH/u,
);
cases += 1;
const adminWithoutAppId = { ...firebaseInit };
delete adminWithoutAppId.appId;
const sharedFirebaseConfigs = resolveFirebaseConfigs(
  firebaseInit,
  adminWithoutAppId,
  projectId,
);
assert.equal(sharedFirebaseConfigs.adminConfig.appId, firebaseInit.appId);
assert.equal(sharedFirebaseConfigs.adminAppIdSource, "staff-same-project");
cases += 1;
assert.throws(
  () => resolveFirebaseConfigs(
    firebaseInit,
    { ...adminWithoutAppId, appId: "\n" },
    projectId,
  ),
  /FIREBASE_INIT_INVALID:admin.appId/u,
);
cases += 1;
assert.throws(
  () => resolveFirebaseConfigs(
    firebaseInit,
    { ...adminWithoutAppId, messagingSenderId: "9999999999" },
    projectId,
  ),
  /FIREBASE_INIT_APP_ID_FALLBACK_REJECTED:admin.messagingSenderId/u,
);
cases += 1;
const adminWithOwnAppId = {
  ...firebaseInit,
  appId: "1:1234567890:web:admin-app",
};
const distinctFirebaseConfigs = resolveFirebaseConfigs(
  firebaseInit,
  adminWithOwnAppId,
  projectId,
);
assert.equal(distinctFirebaseConfigs.adminConfig.appId, adminWithOwnAppId.appId);
assert.equal(distinctFirebaseConfigs.adminAppIdSource, "admin-public-config");
cases += 1;
assert.deepEqual(findVapidCandidates(`const key="${vapidKey}";`), [vapidKey]);
cases += 1;
const sdkVapidKey = `B${"S".repeat(86)}`;
assert.equal(
  selectApplicationVapidKey(
    [sdkVapidKey, vapidKey, sdkVapidKey],
    [sdkVapidKey],
  ),
  vapidKey,
);
cases += 1;
assert.throws(
  () => selectApplicationVapidKey([sdkVapidKey], [sdkVapidKey]),
  /VAPID_KEY_NOT_UNIQUELY_RECOVERED:0/u,
);
cases += 1;
assert.throws(
  () => selectApplicationVapidKey(
    [vapidKey, `B${"Z".repeat(86)}`, sdkVapidKey],
    [sdkVapidKey],
  ),
  /VAPID_KEY_NOT_UNIQUELY_RECOVERED:2/u,
);
cases += 1;
const env = renderClientEnv(firebaseInit, {
  projectId,
  region: "asia-northeast1",
  vapidKey,
});
assert.match(env, /VITE_APP_ENVIRONMENT=staging/u);
assert.match(env, new RegExp(`VITE_EXPECTED_FIREBASE_PROJECT_ID=${projectId}`, "u"));
assert.doesNotMatch(env, /production/u);
cases += 1;

const channelDocument = {
  status: "success",
  result: {
    channels: [{
      name: `sites/${staffSite}/channels/${channelId}`,
      url: `https://${staffSite}--${channelId}-abc123.web.app`,
    }],
  },
};
assert.equal(extractChannels(channelDocument).length, 1);
cases += 1;
assert.equal(
  resolveChannelUrl(channelDocument, { channelId, siteId: staffSite }),
  `https://${staffSite}--${channelId}-abc123.web.app`,
);
cases += 1;
assert.throws(
  () => resolveChannelUrl(channelDocument, { channelId: "rc-other", siteId: staffSite }),
  /NOT_UNIQUELY_RESOLVED/u,
);
cases += 1;

assert.equal(
  validateTargetUrl(`https://${staffSite}.web.app`, [staffSite, adminSite]),
  `https://${staffSite}.web.app`,
);
cases += 1;
assert.throws(
  () => validateTargetUrl("https://lip-knots-production.web.app", [staffSite, adminSite]),
  /PRODUCTION_URL_REJECTED/u,
);
cases += 1;
const passingBrowserResult = {
  httpStatus: 200,
  rootVisible: true,
  rootChildCount: 1,
  bodyTextLength: 100,
  demoModeVisible: false,
  navigationDurationMs: 1200,
  pageErrors: [],
  fatalConsoleErrors: [],
  failedResources: [],
};
assert.deepEqual(evaluateBrowserResult(passingBrowserResult), []);
cases += 1;
assert.equal(shouldRetryBrowserIssues([], 1), false);
cases += 1;
assert.equal(shouldRetryBrowserIssues(["ROOT_NOT_MOUNTED"], 1), true);
cases += 1;
assert.equal(shouldRetryBrowserIssues(["ROOT_NOT_MOUNTED"], 2), false);
cases += 1;
assert.ok(
  evaluateBrowserResult({
    ...passingBrowserResult,
    rootChildCount: 0,
    pageErrors: ["Cannot access x before initialization"],
  }).includes("ROOT_NOT_MOUNTED"),
);
cases += 1;


const require = createRequire(import.meta.url);
const {parse} = require("yaml");
const promoteSpec=parse(promoteWorkflow), previewSpec=parse(previewWorkflow);
assert.deepEqual(promoteSpec.on.workflow_dispatch.inputs.operation.options,["promote","readiness","restore"]);
assert.equal(promoteSpec.jobs.promote.environment,"lkc-staging-hosting");
assert.equal(promoteSpec.concurrency.group,"lkc-staging-hosting-promote");
assert.equal(promoteSpec.concurrency["cancel-in-progress"],false);
assert.equal(promoteSpec.env.LKC_PROJECT_ID,projectId);
assert.equal(promoteSpec.env.LKC_REGION,"asia-northeast1");
assert.equal(promoteSpec.env.LKC_TARGETS,"staff,admin");
assert.match(previewWorkflow,/--no-authorized-domains/u);
assert.doesNotMatch(promoteWorkflow,/hosting:clone|hosting:channel:(?:create|delete)/u);
const steps=promoteSpec.jobs.promote.steps;
function stepRuns(step,mode,outcomes={},priorSuccess=true){
  let expression=String(step.if??"true").trim().replace(/^\$\{\{|\}\}$/gu,"").trim();
  if(!expression.includes("always()")&&!priorSuccess)return false;
  expression=expression.replace(/env\.LKC_OPERATION/gu,JSON.stringify(mode))
    .replace(/steps\.([a-z_]+)\.outcome/gu,(_,id)=>JSON.stringify(outcomes[id]??"skipped"))
    .replace(/steps\.([a-z_]+)\.outputs\.([a-z_]+)/gu,(_,id,key)=>JSON.stringify(outcomes[id+"."+key]??""))
    .replace(/always\(\)/gu,"true");
  assert.match(expression,/^[a-z_\-\s()!&|='"]+$/u);
  return Function("return ("+expression+");")();
}
const mutatingNames=[
  "Back up both current live channels","Capture both saved live and immutable preview versions",
  "Promote the already-tested versions without rebuilding","Restore both previous live versions on any failure",
  "Persist successful promotion manifest before channel cleanup","Remove temporary channels after a successful promotion",
  "Restore the exact pair from successful promotion evidence",
];
for(const step of steps.filter(s=>mutatingNames.includes(s.name))){
 for(const priorSuccess of [true,false])for(const result of ["success","failure","skipped"]){
  assert.equal(stepRuns(step,"readiness",{
   promotion:result,live_check:result,"backup.ready":"true",manual_restore:result,
  },priorSuccess),false,"readiness cannot reach "+step.name);
 }
 cases++;
}
for(const step of steps.filter(s=>mutatingNames.includes(s.name)&&s.id!=="manual_restore")){
 assert.equal(stepRuns(step,"restore",{promotion:"success",live_check:"success","backup.ready":"true"}),false);
 cases++;
}
const autoRestore=steps.find(s=>s.id==="rollback");
assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"skipped"},false),false,"pre-write failure cannot run rollback");
assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"failure","promotion.rollback_allowed":"true"},false),true);
assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"success",live_check:"failure","promotion.rollback_allowed":"true"},false),true);
assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"success",live_check:"success","promotion.rollback_allowed":"true"}),false);
assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"failure","promotion.rollback_allowed":"false"},false),false,"unknown outcome cannot run rollback");
assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"failure"},false),false,"absent result output cannot run rollback");
const promotionStep=steps.find(s=>s.id==="promotion");
assert.equal(promotionStep.env.GH_TOKEN,"${{ github.token }}","per-step current-main read needs the existing scoped token");
assert.match(promotionStep.run,/--github-output "\$GITHUB_OUTPUT"/u);
cases+=8;
assert.equal(stepRuns(steps.find(s=>s.id==="readiness"),"restore"),false);
assert.ok(steps.findIndex(s=>s.name==="Re-check source is still current main after approval")<steps.findIndex(s=>s.name==="Authenticate with the short-lived staging identity"));
assert.match(promoteWorkflow,/\.display_title == \\"promote staging Hosting\\"/u,"readiness/restore success cannot count as a promotion");
assert.match(promoteWorkflow,/name: staging-hosting-\$\{\{ env\.LKC_OPERATION \}\}/u);
const feeIndex=steps.findIndex(s=>s.id==="no_fee_source");
assert.ok(feeIndex>=0&&feeIndex<steps.findIndex(s=>s.name==="Authenticate with the short-lived staging identity"));
assert.equal(stepRuns(steps[feeIndex],"readiness"),true);
assert.equal(stepRuns(steps[feeIndex],"promote"),true);
assert.equal(stepRuns(steps[feeIndex],"restore"),false);
assert.match(promoteWorkflow,/format\(' from \{0\}', inputs\.restore_run_id\)/u,"restore run must be bound to target promotion before any attempt");
cases+=3;
const finalScript=steps.find(s=>s.name==="Enforce the final result").run;
assert.ok(finalScript.indexOf('HOSTING_READINESS_RESULT=SUCCESS')<finalScript.indexOf('HOSTING_PROMOTION_RESULT=SUCCESS'));
assert.match(finalScript,/HOSTING_READINESS_RESULT=SUCCESS[\s\S]*?exit 0/u);
cases+=5;

const guardScript=promoteSpec.jobs.guard.steps.find(s=>s.id==="release").run;
const shellPath=process.platform==="win32"?"C:/Program Files/Git/bin/bash.exe":"/bin/bash";
const shellTemp=await mkdtemp(join(repoRoot,".hosting-guard-test-"));
try{
 const baseEnvironment={
  ...process.env,GITHUB_EVENT_NAME:"workflow_dispatch",GITHUB_REF_NAME:"main",GITHUB_REPOSITORY:"Hanabo0930/Lip-Knots-Crew",
  GITHUB_RUN_ID:"777",GITHUB_RUN_ATTEMPT:"1",LKC_PROJECT_ID:projectId,LKC_REGION:"asia-northeast1",LKC_TARGETS:"staff,admin",
  LKC_REQUESTED_SHA:"ec55200aae1b7d931d60534b2bf3cb5281c9f510",LKC_PREVIEW_RUN_ID:"",
  TEST_MAIN_SHA:"ec55200aae1b7d931d60534b2bf3cb5281c9f510",TEST_CI_RESULT:"1",TEST_PREVIEW_RESULT:"1",
  NODE_EXE:process.execPath.replaceAll("\\","/"),
 };
 const stubs=[
  "set -euo pipefail",
  'git(){ case "$1" in fetch) return 0;; rev-parse) printf "%s\\n" "$TEST_MAIN_SHA";; *) return 91;; esac; }',
  'gh(){ case "$*" in *"Release Candidate Checks"*) printf "%s\\n" "$TEST_CI_RESULT";; *"promote staging Hosting"*) printf "0\\n";; *"Staging Hosting Preview"*) printf "%s\\n" "$TEST_PREVIEW_RESULT";; *) return 92;; esac; }',
  'node(){ "$NODE_EXE" "$@"; }',
 ].join("\n");
 const scenarios=[
  ["readiness",{LKC_OPERATION:"readiness",LKC_CONFIRMATION:"CHECK_LKC_STAGING_HOSTING_READINESS",LKC_RESTORE_RUN_ID:""},true],
  ["restore",{LKC_OPERATION:"restore",LKC_CONFIRMATION:"RESTORE_LKC_STAGING_HOSTING",LKC_RESTORE_RUN_ID:"123"},true],
  ["promote",{LKC_OPERATION:"promote",LKC_CONFIRMATION:"PROMOTE_LKC_STAGING_HOSTING",LKC_RESTORE_RUN_ID:""},true],
  ["bad confirmation",{LKC_OPERATION:"readiness",LKC_CONFIRMATION:"PROMOTE_LKC_STAGING_HOSTING",LKC_RESTORE_RUN_ID:""},false],
  ["automatic restore",{GITHUB_EVENT_NAME:"workflow_run",LKC_OPERATION:"restore",LKC_CONFIRMATION:"RESTORE_LKC_STAGING_HOSTING",LKC_RESTORE_RUN_ID:"123"},false],
  ["missing run",{LKC_OPERATION:"restore",LKC_CONFIRMATION:"RESTORE_LKC_STAGING_HOSTING",LKC_RESTORE_RUN_ID:""},false],
  ["output injection",{LKC_OPERATION:"readiness",LKC_CONFIRMATION:"CHECK_LKC_STAGING_HOSTING_READINESS",LKC_RESTORE_RUN_ID:"123\noperation=restore"},false],
  ["changed main",{LKC_OPERATION:"readiness",LKC_CONFIRMATION:"CHECK_LKC_STAGING_HOSTING_READINESS",LKC_RESTORE_RUN_ID:"",TEST_MAIN_SHA:"1".repeat(40)},false],
  ["failed CI",{LKC_OPERATION:"readiness",LKC_CONFIRMATION:"CHECK_LKC_STAGING_HOSTING_READINESS",LKC_RESTORE_RUN_ID:"",TEST_CI_RESULT:"0"},false],
  ["production",{LKC_OPERATION:"readiness",LKC_CONFIRMATION:"CHECK_LKC_STAGING_HOSTING_READINESS",LKC_RESTORE_RUN_ID:"",LKC_PROJECT_ID:"production"},false],
  ["other region",{LKC_OPERATION:"readiness",LKC_CONFIRMATION:"CHECK_LKC_STAGING_HOSTING_READINESS",LKC_RESTORE_RUN_ID:"",LKC_REGION:"us-central1"},false],
 ];
 for(const [label,extra,expected] of scenarios){
  const output=join(shellTemp,label.replaceAll(" ","-")+".txt");
  const result=spawnSync(shellPath,["-c",stubs+"\n"+guardScript],{
   cwd:repoRoot,encoding:"utf8",env:{...baseEnvironment,...extra,GITHUB_OUTPUT:output.replaceAll("\\","/")},maxBuffer:100000,
  });
  assert.equal(result.status===0,expected,"actual guard shell: "+label+" "+result.stdout+" "+result.stderr);
  if(expected){const saved=await readFile(output,"utf8");assert.match(saved,new RegExp("operation="+extra.LKC_OPERATION));assert.match(saved,/should_promote=true/u);}
  cases++;
 }
 for(const [label,values,marker,code] of [
  ["unknown",{promotion:"failure","promotion.rollback_allowed":"false"},"UNKNOWN_STOPPED",1],
  ["missing-result",{promotion:"failure"},"UNKNOWN_STOPPED",1],
  ["known-rollback",{promotion:"failure","promotion.rollback_allowed":"true",rollback:"success",rollback_check:"success"},"ROLLED_BACK",1],
  ["known-success",{promotion:"success","promotion.rollback_allowed":"true",live_check:"success"},"SUCCESS",0],
 ]){
  const rendered=finalScript.replace(/\$\{\{ steps\.([a-z_]+)\.(outcome|outputs\.([a-z_]+)) \}\}/gu,
   (_,id,field,key)=>values[key?id+"."+key:id]??"skipped");
  assert.doesNotMatch(rendered,/\$\{\{/u);
  const result=spawnSync(shellPath,["-c","set -euo pipefail\n"+rendered],{cwd:repoRoot,encoding:"utf8",
   env:{...baseEnvironment,LKC_OPERATION:"promote"},maxBuffer:10000});
  assert.equal(result.status,code,"actual final-result shell: "+label);assert.match(result.stdout,new RegExp("HOSTING_PROMOTION_RESULT="+marker));
  cases++;
 }
 const realCli=resolve(repoRoot,"scripts/automation/restore-staging-hosting.mjs");
 const cli=spawnSync(process.execPath,[realCli,"--operation","restore","--confirmation","RESTORE_LKC_STAGING_HOSTING","--project",projectId,"--region","asia-northeast1"],{
  cwd:repoRoot,encoding:"utf8",env:{...baseEnvironment,GITHUB_ACTIONS:"false"},maxBuffer:100000,
 });
 assert.notEqual(cli.status,0);assert.match(cli.stderr,/PROTECTED_WORKFLOW_CONTEXT_REQUIRED/u);cases++;
}finally{
 const actual=await realpath(shellTemp),root=await realpath(repoRoot);
 assert.ok(actual.startsWith(root+pathSep)&&actual.includes(".hosting-guard-test-"));
 await rm(actual,{recursive:true,force:true});
}
cases+=await runVersionRestoreTests({repoRoot,pythonExecutable:process.argv[2]||"python3"});

console.log(`staging Hosting automation tests passed (${cases} cases)`);
