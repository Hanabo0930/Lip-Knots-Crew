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

// Keep the default full suite; --workflow-only omits the separate restore suite.
const arguments_ = process.argv.slice(2);
assert.ok(arguments_.every(value => !value.startsWith("-") || value === "--workflow-only"), "UNKNOWN_TEST_OPTION");
assert.ok(arguments_.filter(value => value === "--workflow-only").length <= 1, "DUPLICATE_TEST_OPTION");
const workflowOnly = arguments_.includes("--workflow-only");
const pythonArguments = arguments_.filter(value => value !== "--workflow-only");
assert.ok(pythonArguments.length <= 1 && (!workflowOnly || pythonArguments.length === 0), "TEST_ARGUMENTS_REJECTED");
const pythonExecutable = pythonArguments[0] || "python3";

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
const historyStep = promoteWorkflow.match(
  /      - name: Require resolved earlier Hosting writes before a limited promotion\n([\s\S]*?)(?=      - name:)/u,
);
assert.ok(historyStep, "Limited promotion requires resolved earlier writes");
assert.match(historyStep[1], /if: env\.LKC_EVIDENCE_POLICY == 'limited-staff-pilot' && env\.LKC_OPERATION == 'promote'/u,
  "History must not block read-only readiness or alter the strict default path");
assert.match(historyStep[1], /run: node scripts\/automation\/check-hosting-promotion-history\.mjs/u);
assert.doesNotMatch(historyStep[1], /continue-on-error/u, "Unresolved history must stop Hosting writes");
assert.ok(promoteWorkflow.indexOf(historyStep[0]) < promoteWorkflow.indexOf("- name: Back up both current live channels"),
  "History must be checked before the first Hosting channel write");
cases += 5;
assert.match(
  promoteWorkflow,
  /node scripts\/automation\/restore-staging-hosting\.mjs/u,
);
assert.match(
  promoteWorkflow,
  /- name: Verify both live staging apps after rollback[\s\S]*?if: always\(\) && env\.LKC_METADATA_ONLY != 'true' && steps\.rollback\.outputs\.attempted == 'true'/u,
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
assert.deepEqual(promoteSpec.on.workflow_dispatch.inputs.evidence_policy.options,["source-provenance","limited-staff-pilot"]);
assert.equal(promoteSpec.on.workflow_dispatch.inputs.evidence_policy.default,"source-provenance");
assert.equal(promoteSpec.jobs.promote.environment,"lkc-staging-hosting");
// Eligible runs retain the shared queue; skipped events must not compete for it.
function hostingQueueContext({id="100", event="workflow_run", upstream="push", conclusion="success",
  branch="main", ref="refs/heads/main", operation="promote", metadataOnly=false, evidencePolicy="source-provenance"}={}) {
  return {event_name:event, ref, run_id:id,
    inputs:{operation,metadata_only:metadataOnly,evidence_policy:evidencePolicy},
    event:{workflow_run:{event:upstream, conclusion, head_branch:branch}, inputs:{operation}}};
}
const hostingGroups={};
for (const [spec, kind] of [[previewSpec, "preview"], [promoteSpec, "promote"]]) {
  const compact = value => String(value).replace(/'(?:[^']|'')*'|\s+/gu,
    part => part.startsWith("'") ? part : "");
  const shared = `lkc-staging-hosting-${kind}`;
  const metadataPrefix = kind === "promote" ?
    "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && " +
    "inputs.operation == 'readiness' && inputs.metadata_only == true && " +
    "(inputs.evidence_policy == 'source-provenance' || !inputs.evidence_policy)) && 'lkc-staging-hosting-metadata-readiness' || " : "";
  const expected = "${{ " + metadataPrefix + "(" + compact(spec.jobs.guard.if) + ") && '" + shared +
    "' || format('" + shared + "-ignored-{0}', github.run_id) }}";
  assert.equal(compact(spec.concurrency.group), compact(expected),
    `${kind}: concurrency eligibility must match the unchanged job guard`);
  assert.equal(spec.concurrency["cancel-in-progress"], kind === "preview");
  cases += 1;
  // After the exact guard/group contract above, evaluate this small common
  // expression subset against canonical API event strings, without cloud access.
  const expression=String(spec.concurrency.group).trim().slice(3,-2);
  const evaluate=Function("github", "inputs", "format", "return ("+expression+");");
  const select=context=>evaluate(context,context.inputs,(pattern,id)=>pattern.replace("{0}",id));
  hostingGroups[kind]=select;
  const upstream=kind==="preview"?"push":"workflow_run";
  const samples=[
    [hostingQueueContext({upstream}),true],
    [hostingQueueContext({upstream,branch:"feature"}),false],
    [hostingQueueContext({upstream:"pull_request"}),false],
    [hostingQueueContext({upstream,conclusion:null}),false],
    ...["failure","cancelled","skipped"].map(conclusion=>[hostingQueueContext({upstream,conclusion}),false]),
    [hostingQueueContext({event:"workflow_dispatch",ref:"refs/heads/feature",upstream:""}),false],
  ];
  if(kind==="promote") {
    for(const operation of ["promote","readiness","restore"])
      samples.push([hostingQueueContext({event:"workflow_dispatch",upstream:"",operation}),true]);
    assert.equal(select(hostingQueueContext({event:"workflow_dispatch",operation:"readiness",metadataOnly:true})),
      "lkc-staging-hosting-metadata-readiness");
    assert.equal(select(hostingQueueContext({event:"workflow_dispatch",operation:"readiness",metadataOnly:true,ref:"refs/heads/feature"})),
      shared+"-ignored-100");
    assert.equal(select(hostingQueueContext({event:"workflow_dispatch",operation:"readiness",metadataOnly:true,evidencePolicy:""})),
      "lkc-staging-hosting-metadata-readiness","legacy metadata dispatch retains its existing queue");
    for(const operation of ["promote","readiness"])for(const metadataOnly of [false,true])
      assert.equal(select(hostingQueueContext({event:"workflow_dispatch",operation,metadataOnly,evidencePolicy:"limited-staff-pilot"})),
        shared,"limited requests cannot use the independent metadata queue");
    cases+=7;
  } else {
    samples.push([hostingQueueContext({upstream:"workflow_dispatch"}),false]);
  }
  for(const [context,eligible] of samples) {
    assert.equal(select(context),eligible?shared:shared+"-ignored-"+context.run_id);
    cases+=1;
  }
  assert.notEqual(select(hostingQueueContext({id:"ignored-1",conclusion:"skipped"})),
    select(hostingQueueContext({id:"ignored-2",conclusion:"skipped"})));
  cases+=1;
}
assert.equal(hostingGroups.promote(hostingQueueContext({upstream:"workflow_run"})),
  hostingGroups.promote(hostingQueueContext({event:"workflow_dispatch",upstream:"",operation:"restore"})),
  "Automatic promotion and manual restore must retain the same serialized group");
assert.equal(hostingGroups.promote(hostingQueueContext({upstream:"workflow_run"})),
  hostingGroups.promote(hostingQueueContext({event:"workflow_dispatch",upstream:"",operation:"promote",evidencePolicy:"limited-staff-pilot"})),
  "Automatic promotion and manual limited trial must retain the same serialized group");
cases+=1;
assert.equal(promoteSpec.concurrency["cancel-in-progress"],false);
assert.equal(promoteSpec.env.LKC_PROJECT_ID,projectId);
assert.equal(promoteSpec.env.LKC_REGION,"asia-northeast1");
assert.equal(promoteSpec.env.LKC_TARGETS,"staff,admin");
assert.match(previewWorkflow,/--no-authorized-domains/u);
assert.doesNotMatch(promoteWorkflow,/hosting:clone|hosting:channel:(?:create|delete)/u);
const steps=promoteSpec.jobs.promote.steps;
const reviewedControlled={pilot_review:"success",pilot_readiness:"success","pilot_review.acceptance_method":"CONTROLLED_BROWSER"};
function stepRuns(step,mode,outcomes={},priorSuccess=true,metadataOnly=false,evidencePolicy="source-provenance"){
  outcomes={...reviewedControlled,...outcomes};
  let expression=String(step.if??"true").trim().replace(/^\$\{\{|\}\}$/gu,"").trim();
  if(!expression.includes("always()")&&!priorSuccess)return false;
  expression=expression.replace(/env\.LKC_OPERATION/gu,JSON.stringify(mode))
    .replace(/env\.LKC_METADATA_ONLY/gu,JSON.stringify(String(metadataOnly)))
    .replace(/env\.LKC_EVIDENCE_POLICY/gu,JSON.stringify(evidencePolicy))
    .replace(/steps\.([a-z_]+)\.outcome/gu,(_,id)=>JSON.stringify(outcomes[id]??"skipped"))
    .replace(/steps\.([a-z_]+)\.outputs\.([a-z_]+)/gu,(_,id,key)=>JSON.stringify(outcomes[id+"."+key]??""))
    .replace(/always\(\)/gu,"true");
  assert.match(expression,/^[A-Za-z_\-\s()!&|='"]+$/u);
  return Function("return ("+expression+");")();
}
const mutatingNames=[
  "Back up both current live channels","Capture both saved live and immutable preview versions",
  "Promote the already-tested versions without rebuilding","Restore both previous live versions on any failure",
  "Persist successful promotion manifest before channel cleanup","Remove temporary channels after a successful promotion",
  "Restore the exact pair from successful promotion evidence",
  "Restore the trial if durable promotion evidence failed",
];
for(const step of steps.filter(s=>mutatingNames.includes(s.name))){
 for(const policy of ["source-provenance","limited-staff-pilot"])
 for(const priorSuccess of [true,false])for(const result of ["success","failure","skipped"]){
  assert.equal(stepRuns(step,"readiness",{
   promotion:result,live_check:result,"backup.ready":"true",manual_restore:result,
   pilot_after:result,finalize_capture:result,
  },priorSuccess,false,policy),false,policy+" readiness cannot reach "+step.name);
 }
 cases++;
}
for(const step of steps.filter(s=>mutatingNames.includes(s.name)&&s.id!=="manual_restore")){
 assert.equal(stepRuns(step,"restore",{promotion:"success",live_check:"success","backup.ready":"true"}),false);
 cases++;
}
const autoRestore=steps.find(s=>s.id==="rollback");
const evidenceRestore=steps.find(s=>s.id==="evidence_rollback");
const evidenceUpload=steps.find(s=>s.id==="promotion_evidence");
assert.equal(evidenceUpload["continue-on-error"],true);
assert.ok(steps.indexOf(evidenceUpload)<steps.indexOf(evidenceRestore));
for(const policy of ["source-provenance","limited-staff-pilot"]){
 const knownPromotion={promotion:"success",finalize_capture:"success","promotion.rollback_allowed":"true","rollback.attempted":""};
 for(const upload of ["failure","cancelled","skipped"]){
  assert.equal(stepRuns(evidenceRestore,"promote",{...knownPromotion,promotion_evidence:upload},false,false,policy),true,
   "lost durable evidence requires same-run recovery after known publication");
 }
 for(const overrides of [
  {promotion_evidence:"success"},
  {promotion:"skipped"},
  {promotion:"failure"},
  {finalize_capture:"failure"},
  {"promotion.rollback_allowed":"false"},
  {"promotion.rollback_allowed":""},
  {"rollback.attempted":"true"},
 ]){
  assert.equal(stepRuns(evidenceRestore,"promote",{...knownPromotion,promotion_evidence:"failure",...overrides},false,false,policy),false,
   "durable evidence recovery must not bypass known-outcome or prior-rollback guards");
 }
}
assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"skipped"},false),false,"pre-write failure cannot run rollback");
assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"failure","promotion.rollback_allowed":"true"},false),true);
assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"success",live_check:"failure","promotion.rollback_allowed":"true"},false),true);
assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"success",live_check:"success",finalize_capture:"success","promotion.rollback_allowed":"true"}),false);
assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"failure","promotion.rollback_allowed":"false"},false),false,"unknown outcome cannot run rollback");
assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"failure"},false),false,"absent result output cannot run rollback");
for(const after of ["failure","skipped"]){
 assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"success",live_check:"success",
  pilot_after:after,"promotion.rollback_allowed":"true"},false,false,"limited-staff-pilot"),true,
  "limited metadata "+after+" after a known write must restore the pinned pair");
}
assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"success",live_check:"success",
 pilot_after:"success",finalize_capture:"success","promotion.rollback_allowed":"true"},true,false,"limited-staff-pilot"),false);
assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"success",live_check:"success",
 pilot_after:"failure","promotion.rollback_allowed":"false"},false,false,"limited-staff-pilot"),false,
 "unknown write outcome still prohibits rollback");
for(const policy of ["source-provenance","limited-staff-pilot"])
 for(const finalization of ["failure","skipped"])
  assert.equal(stepRuns(autoRestore,"promote",{"backup.ready":"true",promotion:"success",live_check:"success",
   pilot_after:"success",finalize_capture:finalization,"promotion.rollback_allowed":"true"},true,false,policy),true,
   policy+" failed final evidence must restore the pinned pair");
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
for(const mode of ["readiness","promote"]){
 assert.equal(stepRuns(steps[feeIndex],mode,{},true,false,"limited-staff-pilot"),false);
 assert.equal(stepRuns(steps.find(s=>s.id==="readiness"),mode),true,
  "strict source verification is still required for "+mode);
 assert.equal(stepRuns(steps.find(s=>s.id==="readiness"),mode,{},true,false,"limited-staff-pilot"),false);
}
const cleanup=steps.find(s=>s.name==="Remove temporary channels after a successful promotion");
for(const mode of ["readiness","promote","restore"])
 assert.equal(stepRuns(cleanup,mode,{promotion:"success",live_check:"success",pilot_after:"success",finalize_capture:"success"},
  true,false,"limited-staff-pilot"),false,"limited trials cannot clean up backup or preview channels");
assert.equal(stepRuns(cleanup,"promote",{promotion:"success",live_check:"success",finalize_capture:"success"}),true);
assert.equal(stepRuns(cleanup,"promote",{promotion:"success",live_check:"success",finalize_capture:"failure"}),false);
const limitedReviewIndex=steps.findIndex(s=>s.name==="Validate limited review and no additional cost before cloud access");
assert.ok(limitedReviewIndex>=0&&limitedReviewIndex<steps.findIndex(s=>s.id==="hosting_auth"));
assert.equal(steps[limitedReviewIndex].id,"pilot_review","only the validated review may select the acceptance method");
assert.match(steps[limitedReviewIndex].run,/hosting-limited-pilot\.mjs --validate-review/u);
assert.equal(stepRuns(steps[limitedReviewIndex],"promote",{},true,false,"limited-staff-pilot"),true);
const finalCapture=steps.find(s=>s.id==="finalize_capture");
assert.equal(finalCapture["continue-on-error"],true,"failed final evidence must still reach rollback");
assert.ok(steps.indexOf(finalCapture)<steps.indexOf(autoRestore),"final evidence must be checked before rollback decision");
assert.equal(stepRuns(finalCapture,"promote",{promotion:"success",live_check:"success",pilot_after:"failure"},
 true,false,"limited-staff-pilot"),false);
assert.equal(stepRuns(finalCapture,"promote",{promotion:"success",live_check:"success",pilot_after:"success"},
 true,false,"limited-staff-pilot"),true);
const pilotReadiness=steps.find(s=>s.id==="pilot_readiness");
const pilotBefore=steps.find(s=>String(s.run).includes("hosting-limited-workflow.mjs --verify-capture"));
const pilotAfter=steps.find(s=>s.id==="pilot_after");
const verifySavedPair=steps.find(s=>s.name==="Recheck the saved live pair immediately before promotion");
for(const step of [pilotReadiness,pilotBefore]){
 assert.ok(step,"method-specific checks must remain present");
 assert.equal(step.env.LKC_ACCEPTANCE_METHOD,"${{ steps.pilot_review.outputs.acceptance_method }}");
 assert.doesNotMatch(step.env.LKC_ACCEPTANCE_METHOD,/inputs\./u,"raw dispatch inputs cannot select the method");
 cases++;
}
assert.match(verifySavedPair.run,/--verify-capture/u);
assert.match(pilotBefore.run,/hosting-limited-workflow\.mjs --verify-capture/u);
for(const [method,after,expected] of [
 ["OWNER_MANUAL_UI","skipped",true], ["OWNER_MANUAL_UI","success",false], ["OWNER_MANUAL_UI","failure",false],
 ["CONTROLLED_BROWSER","success",true], ["CONTROLLED_BROWSER","skipped",false], ["CONTROLLED_BROWSER","failure",false],
 ["UNKNOWN","success",false], ["","skipped",false], [undefined,"success",false],
]){
 const values={promotion:"success",live_check:"success",pilot_after:after,"pilot_review.acceptance_method":method};
 assert.equal(stepRuns(finalCapture,"promote",values,true,false,"limited-staff-pilot"),expected,
  "only a known method with its intended post-check outcome can finalize: "+String(method)+"/"+after);
 assert.equal(stepRuns(pilotAfter,"promote",values,true,false,"limited-staff-pilot"),method==="CONTROLLED_BROWSER",
  "only controlled browser acceptance may collect post-trial Function metadata");
 assert.equal(stepRuns(autoRestore,"promote",{...values,"backup.ready":"true","promotion.rollback_allowed":"true",
  finalize_capture:"success"},false,false,"limited-staff-pilot"),!expected,
  "known publication with an invalid method/outcome requires recovery");
 cases++;
}
for(const field of ["pilot_review","pilot_readiness"])
 for(const outcome of ["failure","skipped",undefined]){
  assert.equal(stepRuns(finalCapture,"promote",{promotion:"success",live_check:"success",pilot_after:"skipped",
   "pilot_review.acceptance_method":"OWNER_MANUAL_UI",[field]:outcome},true,false,"limited-staff-pilot"),false,
   "manual final evidence still requires successful "+field);
  cases++;
 }
for(const method of ["CONTROLLED_BROWSER","OWNER_MANUAL_UI"]){
 const values={"pilot_review.acceptance_method":method};
 assert.equal(stepRuns(verifySavedPair,"promote",values,true,false,"limited-staff-pilot"),true);
 assert.equal(stepRuns(pilotBefore,"promote",values,true,false,"limited-staff-pilot"),true);
 assert.equal(stepRuns(pilotBefore,"readiness",values,true,false,"limited-staff-pilot"),false);
 assert.equal(stepRuns(pilotReadiness,"readiness",values,true,false,"limited-staff-pilot"),true);
 assert.equal(stepRuns(pilotReadiness,"promote",values,false,false,"limited-staff-pilot"),false,
  "failed review cannot reach the method-specific readiness step");
 cases++;
}
assert.equal(stepRuns(finalCapture,"promote",{promotion:"success",live_check:"success",pilot_after:"failure",
 "pilot_review.acceptance_method":"UNKNOWN"}),true,"strict source-provenance finalization remains independent of limited-method metadata");
assert.match(promoteWorkflow,/format\(' from \{0\}', inputs\.restore_run_id\)/u,"restore run must be bound to target promotion before any attempt");
cases+=3;
const finalScript=steps.find(s=>s.name==="Enforce the final result").run;
assert.ok(finalScript.indexOf('HOSTING_READINESS_RESULT=SUCCESS')<finalScript.indexOf('HOSTING_PROMOTION_RESULT=SUCCESS'));
assert.match(finalScript,/HOSTING_READINESS_RESULT=SUCCESS[\s\S]*?exit 0/u);
cases+=5;

const guardScript=promoteSpec.jobs.guard.steps.find(s=>s.id==="release").run;
assert.equal(promoteSpec.jobs.guard.steps.find(s=>s.id==="release").env.LKC_EVIDENCE_POLICY,
 "${{ github.event_name == 'workflow_run' && 'source-provenance' || inputs.evidence_policy || 'source-provenance' }}",
 "automatic Preview promotions must never select the limited policy");
assert.match(guardScript,/hosting-limited-pilot\.mjs --guard-only/u);
const shellPath=process.platform==="win32"?"C:/Program Files/Git/bin/bash.exe":"/bin/bash";
const shellTemp=await mkdtemp(join(repoRoot,".hosting-guard-test-"));
try{
 const baseEnvironment={
  ...process.env,GITHUB_EVENT_NAME:"workflow_dispatch",GITHUB_REF_NAME:"main",GITHUB_REPOSITORY:"Hanabo0930/Lip-Knots-Crew",
  GITHUB_RUN_ID:"777",GITHUB_RUN_ATTEMPT:"1",LKC_PROJECT_ID:projectId,LKC_REGION:"asia-northeast1",LKC_TARGETS:"staff,admin",
  GITHUB_SHA:"ec55200aae1b7d931d60534b2bf3cb5281c9f510",
  LKC_METADATA_ONLY:"false",LKC_EVIDENCE_POLICY:"source-provenance",LKC_LIMITED_EVIDENCE:"",
  LKC_REQUESTED_SHA:"ec55200aae1b7d931d60534b2bf3cb5281c9f510",LKC_PREVIEW_RUN_ID:"",
  TEST_MAIN_SHA:"ec55200aae1b7d931d60534b2bf3cb5281c9f510",TEST_CI_RESULT:"1",TEST_PREVIEW_RESULT:"1",TEST_PREVIEW_ID:"321",
  NODE_EXE:process.execPath.replaceAll("\\","/"),
 };
 const stubs=[
  "set -euo pipefail",
  'git(){ case "$1" in fetch) return 0;; rev-parse) if [[ "$2" == "HEAD" ]]; then printf "%s\\n" "${TEST_CHECKOUT_SHA:-$TEST_MAIN_SHA}"; else printf "%s\\n" "$TEST_MAIN_SHA"; fi;; *) return 91;; esac; }',
  'gh(){ case "$*" in *"sort_by(.id)"*) printf "%s\\n" "$TEST_PREVIEW_ID";; *"[.name, .event"*) printf "Staging Hosting Preview\\tworkflow_run\\tsuccess\\tmain\\t%s\\n" "$TEST_MAIN_SHA";; *"Release Candidate Checks"*) printf "%s\\n" "$TEST_CI_RESULT";; *"promote staging Hosting"*) printf "0\\n";; *"Staging Hosting Preview"*) printf "%s\\n" "$TEST_PREVIEW_RESULT";; *) return 92;; esac; }',
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
  ["stale queued manual head",{GITHUB_SHA:"1".repeat(40),LKC_REQUESTED_SHA:"",LKC_OPERATION:"promote",LKC_CONFIRMATION:"PROMOTE_LKC_STAGING_HOSTING",LKC_RESTORE_RUN_ID:""},false],
  ["stale automatic run head",{GITHUB_EVENT_NAME:"workflow_run",GITHUB_SHA:"1".repeat(40),LKC_OPERATION:"promote",LKC_CONFIRMATION:"PROMOTE_LKC_STAGING_HOSTING",LKC_RESTORE_RUN_ID:""},false],
  ["checkout changed during fetch",{TEST_CHECKOUT_SHA:"1".repeat(40),LKC_OPERATION:"readiness",LKC_CONFIRMATION:"CHECK_LKC_STAGING_HOSTING_READINESS",LKC_RESTORE_RUN_ID:""},false],
  ["failed CI",{LKC_OPERATION:"readiness",LKC_CONFIRMATION:"CHECK_LKC_STAGING_HOSTING_READINESS",LKC_RESTORE_RUN_ID:"",TEST_CI_RESULT:"0"},false],
  ["production",{LKC_OPERATION:"readiness",LKC_CONFIRMATION:"CHECK_LKC_STAGING_HOSTING_READINESS",LKC_RESTORE_RUN_ID:"",LKC_PROJECT_ID:"production"},false],
  ["other region",{LKC_OPERATION:"readiness",LKC_CONFIRMATION:"CHECK_LKC_STAGING_HOSTING_READINESS",LKC_RESTORE_RUN_ID:"",LKC_REGION:"us-central1"},false],
  ["limited manual promote",{LKC_EVIDENCE_POLICY:"limited-staff-pilot",LKC_OPERATION:"promote",LKC_CONFIRMATION:"PROMOTE_LKC_STAGING_HOSTING",LKC_RESTORE_RUN_ID:""},true],
  ["limited manual readiness",{LKC_EVIDENCE_POLICY:"limited-staff-pilot",LKC_OPERATION:"readiness",LKC_CONFIRMATION:"CHECK_LKC_STAGING_HOSTING_READINESS",LKC_RESTORE_RUN_ID:""},true],
  ["limited automatic rejected",{LKC_EVIDENCE_POLICY:"limited-staff-pilot",GITHUB_EVENT_NAME:"workflow_run",LKC_OPERATION:"promote",LKC_CONFIRMATION:"PROMOTE_LKC_STAGING_HOSTING",LKC_RESTORE_RUN_ID:""},false],
  ["limited restore rejected",{LKC_EVIDENCE_POLICY:"limited-staff-pilot",LKC_OPERATION:"restore",LKC_CONFIRMATION:"RESTORE_LKC_STAGING_HOSTING",LKC_RESTORE_RUN_ID:"123"},false],
  ["limited metadata rejected",{LKC_EVIDENCE_POLICY:"limited-staff-pilot",LKC_METADATA_ONLY:"true",LKC_OPERATION:"readiness",LKC_CONFIRMATION:"CHECK_LKC_STAGING_HOSTING_READINESS",LKC_RESTORE_RUN_ID:""},false],
  ["limited rerun rejected",{LKC_EVIDENCE_POLICY:"limited-staff-pilot",GITHUB_RUN_ATTEMPT:"2",LKC_OPERATION:"promote",LKC_CONFIRMATION:"PROMOTE_LKC_STAGING_HOSTING",LKC_RESTORE_RUN_ID:""},false],
  ["limited preview required",{LKC_EVIDENCE_POLICY:"limited-staff-pilot",TEST_PREVIEW_RESULT:"0",LKC_OPERATION:"readiness",LKC_CONFIRMATION:"CHECK_LKC_STAGING_HOSTING_READINESS",LKC_RESTORE_RUN_ID:""},false],
  ["limited unique preview ID required",{LKC_EVIDENCE_POLICY:"limited-staff-pilot",TEST_PREVIEW_ID:"",LKC_OPERATION:"promote",LKC_CONFIRMATION:"PROMOTE_LKC_STAGING_HOSTING",LKC_RESTORE_RUN_ID:""},false],
  ["limited missing review input",{LKC_EVIDENCE_POLICY:"limited-staff-pilot",LKC_LIMITED_EVIDENCE:"",LKC_OPERATION:"promote",LKC_CONFIRMATION:"PROMOTE_LKC_STAGING_HOSTING",LKC_RESTORE_RUN_ID:""},false],
  ["strict rejects limited input",{LKC_LIMITED_EVIDENCE:"{}",LKC_OPERATION:"promote",LKC_CONFIRMATION:"PROMOTE_LKC_STAGING_HOSTING",LKC_RESTORE_RUN_ID:""},false],
  ["unknown policy rejected",{LKC_EVIDENCE_POLICY:"bypass",LKC_OPERATION:"promote",LKC_CONFIRMATION:"PROMOTE_LKC_STAGING_HOSTING",LKC_RESTORE_RUN_ID:""},false],
 ];
 for(const [label,extra,expected] of scenarios){
  const output=join(shellTemp,label.replaceAll(" ","-")+".txt");
  const result=spawnSync(shellPath,["-c",stubs+"\n"+guardScript],{
   // This guard checks JSON presence only. The protected preflight validates
   // the complete reviewed schema before any cloud access; {} never passes it.
   cwd:repoRoot,encoding:"utf8",env:{...baseEnvironment,
    LKC_LIMITED_EVIDENCE:extra.LKC_EVIDENCE_POLICY==="limited-staff-pilot"?"{}":"",
    ...extra,GITHUB_OUTPUT:output.replaceAll("\\","/")},maxBuffer:100000,
  });
  assert.equal(result.status===0,expected,"actual guard shell: "+label+" "+result.stdout+" "+result.stderr);
  if(expected){const saved=await readFile(output,"utf8");assert.match(saved,new RegExp("operation="+extra.LKC_OPERATION));assert.match(saved,/should_promote=true/u);}
  cases++;
 }
 // Exercise the workflow's existing shell cases with a recording node stub.
 // No collector, Hosting reader or credential-bearing command is invoked.
 const commandStub='node(){ printf "NODE_CALL=%s\\n" "$*"; }';
 for(const method of ["CONTROLLED_BROWSER","OWNER_MANUAL_UI","UNKNOWN",""])
  for(const [label,step,common,controlled] of [
   ["readiness",pilotReadiness,["scripts/automation/hosting-limited-pilot.mjs --validate",
    "scripts/automation/hosting-limited-workflow.mjs --verify-review-pins"],
   ["scripts/automation/collect-hosting-pilot-metadata.mjs"]],
   ["before-write",pilotBefore,["scripts/automation/hosting-limited-workflow.mjs --verify-capture"],
   ["scripts/automation/collect-hosting-pilot-metadata.mjs --before-write",
    "scripts/automation/hosting-limited-pilot.mjs --recheck-before-write"]],
  ]){
   assert.doesNotMatch(step.run,/\$\{\{/u,"method shell must use validated env, not interpolated raw inputs");
   const result=spawnSync(shellPath,["-c","set -euo pipefail\n"+commandStub+"\n"+step.run],{
    cwd:repoRoot,encoding:"utf8",env:{...baseEnvironment,LKC_ACCEPTANCE_METHOD:method},maxBuffer:10000});
   const calls=result.stdout.split("\n").filter(line=>line.startsWith("NODE_CALL=")).map(line=>line.slice(10));
   const known=["CONTROLLED_BROWSER","OWNER_MANUAL_UI"].includes(method);
   assert.equal(result.status,known?0:1,"actual "+label+" shell: "+method+" "+result.stderr);
   const expected=method==="CONTROLLED_BROWSER"
    ? label==="readiness"?[...controlled,...common]:[...common,...controlled]
    : method==="OWNER_MANUAL_UI"?common:label==="before-write"?common:[];
   assert.deepEqual(calls,expected,"exact local command sequence: "+label+"/"+method);
   if(method!=="CONTROLLED_BROWSER")assert.ok(calls.every(call=>!call.includes("collect-hosting-pilot-metadata")
    && !call.includes("--recheck-before-write")),"manual and unknown methods cannot collect internal API metadata");
   if(!known)assert.match(result.stdout,/HOSTING_LIMITED_RESULT=UNKNOWN_ACCEPTANCE_METHOD/u);
   cases++;
  }
 for(const [label,values,marker,code] of [
  ["unknown",{promotion:"failure","promotion.rollback_allowed":"false"},"UNKNOWN_STOPPED",1],
  ["missing-result",{promotion:"failure"},"UNKNOWN_STOPPED",1],
  ["known-rollback",{promotion:"failure","promotion.rollback_allowed":"true",rollback:"success",rollback_check:"success"},"ROLLED_BACK",1],
  ["known-success",{promotion:"success","promotion.rollback_allowed":"true",live_check:"success",finalize_capture:"success"},"SUCCESS",0],
  ["missing-final-manifest",{promotion:"success","promotion.rollback_allowed":"true",live_check:"success",finalize_capture:"failure",rollback:"success",rollback_check:"success"},"ROLLED_BACK",1],
 ]){
  const rendered=finalScript.replace(/\$\{\{ steps\.([a-z_]+)\.(outcome|outputs\.([a-z_]+)) \}\}/gu,
   (_,id,field,key)=>values[key?id+"."+key:id]??(id==="promotion_evidence"?"success":"skipped"));
  assert.doesNotMatch(rendered,/\$\{\{/u);
  const result=spawnSync(shellPath,["-c","set -euo pipefail\n"+rendered],{cwd:repoRoot,encoding:"utf8",
   env:{...baseEnvironment,LKC_OPERATION:"promote"},maxBuffer:10000});
  assert.equal(result.status,code,"actual final-result shell: "+label);assert.match(result.stdout,new RegExp("HOSTING_PROMOTION_RESULT="+marker));
  cases++;
 }
 for(const [label,mode,values,marker,code] of [
  ["preauth","readiness",{pilot_readiness:"success"},"HOSTING_LIMITED_RESULT=PREAUTH_READY",0],
  ["preauth-failed","readiness",{pilot_readiness:"failure"},"HOSTING_LIMITED_RESULT=STOPPED_SAFELY",1],
  ["trial","promote",{promotion:"success","promotion.rollback_allowed":"true",live_check:"success",pilot_after:"success",finalize_capture:"success"},"HOSTING_LIMITED_RESULT=STAGING_TRIAL",0],
  ["trial-api-drift","promote",{promotion:"success","promotion.rollback_allowed":"true",live_check:"success",pilot_after:"failure",rollback:"success",rollback_check:"success"},"HOSTING_PROMOTION_RESULT=ROLLED_BACK",1],
  ["trial-api-missing","promote",{promotion:"success","promotion.rollback_allowed":"true",live_check:"success",pilot_after:"skipped",rollback:"failure",rollback_check:"skipped"},"HOSTING_PROMOTION_RESULT=ROLLBACK_FAILED",1],
  ["trial-manifest-failed","promote",{promotion:"success","promotion.rollback_allowed":"true",live_check:"success",pilot_after:"success",finalize_capture:"failure",rollback:"success",rollback_check:"success"},"HOSTING_PROMOTION_RESULT=ROLLED_BACK",1],
  ["manual-preauth","readiness",{"pilot_review.acceptance_method":"OWNER_MANUAL_UI"},"HOSTING_LIMITED_RESULT=PREAUTH_READY",0],
  ["manual-trial","promote",{"pilot_review.acceptance_method":"OWNER_MANUAL_UI",promotion:"success","promotion.rollback_allowed":"true",live_check:"success",pilot_after:"skipped",finalize_capture:"success"},"HOSTING_LIMITED_RESULT=STAGING_TRIAL",0],
  ["manual-unexpected-post-check","promote",{"pilot_review.acceptance_method":"OWNER_MANUAL_UI",promotion:"success","promotion.rollback_allowed":"true",live_check:"success",pilot_after:"success",finalize_capture:"success",rollback:"success",rollback_check:"success"},"HOSTING_PROMOTION_RESULT=ROLLED_BACK",1],
  ["manual-manifest-failed","promote",{"pilot_review.acceptance_method":"OWNER_MANUAL_UI",promotion:"success","promotion.rollback_allowed":"true",live_check:"success",pilot_after:"skipped",finalize_capture:"failure",rollback:"success",rollback_check:"success"},"HOSTING_PROMOTION_RESULT=ROLLED_BACK",1],
  ["manual-review-missing","readiness",{"pilot_review.acceptance_method":"OWNER_MANUAL_UI",pilot_review:undefined},"HOSTING_LIMITED_RESULT=STOPPED_SAFELY",1],
  ["manual-readiness-failed","promote",{"pilot_review.acceptance_method":"OWNER_MANUAL_UI",pilot_readiness:"failure"},"HOSTING_LIMITED_RESULT=STOPPED_SAFELY",1],
  ["unknown-method","readiness",{"pilot_review.acceptance_method":"UNKNOWN"},"HOSTING_LIMITED_RESULT=UNKNOWN_ACCEPTANCE_METHOD",1],
  ["missing-method","readiness",{"pilot_review.acceptance_method":undefined},"HOSTING_LIMITED_RESULT=UNKNOWN_ACCEPTANCE_METHOD",1],
 ]){
  const contextualValues={...reviewedControlled,...values};
  const rendered=finalScript.replace(/\$\{\{ steps\.([a-z_]+)\.(outcome|outputs\.([a-z_]+)) \}\}/gu,
   (_,id,field,key)=>contextualValues[key?id+"."+key:id]??(id==="promotion_evidence"?"success":"skipped"));
  assert.doesNotMatch(rendered,/\$\{\{/u);
  const result=spawnSync(shellPath,["-c","set -euo pipefail\n"+rendered],{cwd:repoRoot,encoding:"utf8",
   env:{...baseEnvironment,LKC_OPERATION:mode,LKC_EVIDENCE_POLICY:"limited-staff-pilot"},maxBuffer:10000});
  assert.equal(result.status,code,"actual limited final-result shell: "+label+" "+result.stderr);
  assert.ok(result.stdout.includes(marker),"actual limited final-result shell: "+label+" "+result.stdout);
  assert.doesNotMatch(result.stdout,/STAFF_UI_ACCEPTED|HOSTING_STAFF_ACCEPTANCE=ACCEPTED|HOSTING_PROMOTION_RESULT=SUCCESS/u);
  if(code===0)assert.match(result.stdout,/HOSTING_STAFF_ACCEPTANCE=UNVERIFIED/u);
  cases++;
 }
 for(const policy of ["source-provenance","limited-staff-pilot"])
  for(const recovery of ["success","failure","skipped"]){
   const values={promotion_evidence:"failure",evidence_rollback:recovery,promotion:"success",
    "promotion.rollback_allowed":"true",live_check:"success",pilot_after:"success",finalize_capture:"success"};
   const rendered=finalScript.replace(/\$\{\{ steps\.([a-z_]+)\.(outcome|outputs\.([a-z_]+)) \}\}/gu,
    (_,id,field,key)=>values[key?id+"."+key:id]??"skipped");
   const result=spawnSync(shellPath,["-c","set -euo pipefail\n"+rendered],{cwd:repoRoot,encoding:"utf8",
    env:{...baseEnvironment,LKC_OPERATION:"promote",LKC_EVIDENCE_POLICY:policy},maxBuffer:10000});
   assert.equal(result.status,1,"evidence upload failure remains failed even after recovery");
   assert.match(result.stdout,/HOSTING_EVIDENCE_RESULT=FAILED/u);
   assert.ok(result.stdout.includes("HOSTING_EVIDENCE_RECOVERY="+recovery));
   assert.doesNotMatch(result.stdout,/HOSTING_PROMOTION_RESULT=SUCCESS|HOSTING_LIMITED_RESULT=STAGING_TRIAL/u);
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
if(!workflowOnly)cases+=await runVersionRestoreTests({repoRoot,pythonExecutable});

console.log(`staging Hosting automation tests passed (${cases} cases${workflowOnly?"; separate version-restore suite skipped":""})`);
