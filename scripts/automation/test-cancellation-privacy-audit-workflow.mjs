import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const yaml=createRequire(import.meta.url)('js-yaml');
const workflow=fs.readFileSync('.github/workflows/staging-functions-deploy.yml','utf8');
const entry='Hanabo0930/Lip-Knots-Crew/.github/workflows/staging-functions-deploy.yml@refs/heads/main';
assert.equal(fs.existsSync('.github/workflows/staging-cancellation-privacy-audit.yml'),false,'One audit entrypoint only');
function validate(text){
 const w=yaml.load(text);
 assert.deepEqual(Object.keys(w.on),['workflow_dispatch']);
 assert.deepEqual(w.on.workflow_dispatch.inputs.operation.options,['deploy','upload-source-refresh','gmail-smoke','cancellation-privacy-audit']);
 assert.equal(w.on.workflow_dispatch.inputs.operation.default,'deploy');
 const deployOnly="inputs.operation == 'deploy' || inputs.operation == 'upload-source-refresh'";
 assert.equal(w.jobs.guard.if,deployOnly);assert.equal(w.jobs.deploy.if,deployOnly);
 assert.equal(w.jobs['smoke-guard'].if,"inputs.operation == 'gmail-smoke'");assert(w.jobs['gmail-smoke'].if.includes("inputs.operation == 'gmail-smoke'"));
 assert.equal(w.concurrency['cancel-in-progress'],false);
 assert.deepEqual(Object.keys(w.jobs).sort(),['cancellation-audit','cancellation-audit-guard','deploy','gmail-smoke','guard','smoke-guard']);
 const g=w.jobs['cancellation-audit-guard'],a=w.jobs['cancellation-audit'];
 assert.equal(g.if,"inputs.operation == 'cancellation-privacy-audit'");assert.equal(a.if,g.if);assert.equal(a.needs,'cancellation-audit-guard');
 assert.deepEqual(g.permissions,{actions:'read',contents:'read'});assert(!g.environment);
 assert.equal(a.environment,'lkc-staging-deploy');assert.deepEqual(a.permissions,{actions:'read',contents:'read','id-token':'write'});
 assert.equal(g.steps.length,1);const guard=g.steps[0].run;
 for(const marker of [
  '[[ "$GITHUB_REPOSITORY" == "Hanabo0930/Lip-Knots-Crew" ]]','[[ "$GITHUB_REF" == "refs/heads/main" ]]',
  '[[ "$GITHUB_EVENT_NAME" == "workflow_dispatch" ]]','[[ "$GITHUB_RUN_ATTEMPT" == "1" ]]',
  '[[ "$WORKFLOW_REF" == "'+entry+'" ]]','[[ "$OPERATION" == "cancellation-privacy-audit" ]]',
  '[[ "$SOURCE_REF" == "main" ]]','[[ "$FUNCTIONS" == "none" ]]','[[ "$TRANSFER_MODE" == "preserve" ]]',
  '[[ "$CONFIRMATION" == "AUDIT_LKC_STAGING_CANCELLATION_PRIVACY" ]]','[[ "$current_main" == "$GITHUB_SHA" ]]',
  'r["head_sha"]==os.environ["GITHUB_SHA"]','r["path"]==".github/workflows/release-candidate.yml"',
  'r["event"]=="push"','["conclusion"]!="success"','CURRENT_MAIN_CANONICAL_CI_REQUIRED',
 ])assert(guard.includes(marker),marker);
 assert.equal(g.steps[0].env.WORKFLOW_REF,'${{ github.workflow_ref }}');
 const auth=a.steps.find(s=>s.uses?.startsWith('google-github-actions/auth@'));
 assert.deepEqual(auth.with,{workload_identity_provider:'${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}',service_account:'${{ vars.GCP_STAGING_OBSERVER_SERVICE_ACCOUNT }}'});
 const checkout=a.steps.find(s=>s.uses?.startsWith('actions/checkout@'));assert.equal(checkout.with.ref,'${{ github.sha }}');assert.equal(checkout.with['persist-credentials'],false);
 const recheck=a.steps[0];assert.equal(recheck.name,'Recheck current main before observer auth');
 assert(recheck.run.includes('[[ "$(gh api repos/Hanabo0930/Lip-Knots-Crew/git/ref/heads/main --jq \'.object.sha\')" == "$GITHUB_SHA" ]]'));
 assert.equal(a.steps.find(s=>s.name==='Read only status and cancellation flag').run.trim(),'set -euo pipefail\nset +x\ngcloud auth print-access-token | node scripts/audit-staging-cancellation-privacy.mjs --token-stdin --evidence "$RUNNER_TEMP/cancellation-privacy-audit"');
 for(const s of a.steps.filter(s=>s.uses))assert(/@[a-f0-9]{40}$/.test(s.uses),'Pinned action');
 assert.equal(a.steps.length,8);assert(!/(firebase deploy|gcloud .*?(?:create|update|delete|deploy)|set-iam-policy|terraform|curl|secrets\.|DEPLOY_SERVICE_ACCOUNT)/.test(JSON.stringify({g,a})));
 const artifact=a.steps.find(s=>s.uses?.startsWith('actions/upload-artifact@'));assert.equal(artifact.with.path,'${{ runner.temp }}/cancellation-privacy-audit/privacy-audit.json');assert.equal(artifact.with['retention-days'],7);
 return {guard,recheck:recheck.run};
}
const {guard,recheck}=validate(workflow);let passed=1;
for(const [oldText,newText] of [
 ['[[ "$FUNCTIONS" == "none" ]]','true'],['[[ "$TRANSFER_MODE" == "preserve" ]]','true'],['[[ "$SOURCE_REF" == "main" ]]','true'],
 ['[[ "$current_main" == "$GITHUB_SHA" ]]','true'],['[[ "$GITHUB_RUN_ATTEMPT" == "1" ]]','true'],
 ['[[ "$CONFIRMATION" == "AUDIT_LKC_STAGING_CANCELLATION_PRIVACY" ]]','true'],['r["head_sha"]==os.environ["GITHUB_SHA"]','True'],
 ['["conclusion"]!="success"','["conclusion"]!="failure"'],['r["event"]=="push"','True'],
 ['Recheck current main before observer auth','Skip current main check'],['persist-credentials: false','persist-credentials: true'],
 ['gcloud auth print-access-token | node scripts/audit-staging-cancellation-privacy.mjs','firebase deploy'],
 ['retention-days: 7','retention-days: 7\n  unexpected-audit:\n    runs-on: ubuntu-latest'],
 ]){assert(workflow.includes(oldText));assert.throws(()=>validate(workflow.replace(oldText,newText)));passed++;}
for(const mutate of [
 w=>w.jobs['cancellation-audit'].permissions['id-token']='read',w=>w.jobs['cancellation-audit-guard'].permissions['id-token']='write',
 w=>w.jobs['cancellation-audit'].needs='guard',w=>w.jobs['cancellation-audit'].if="inputs.operation == 'deploy'",w=>w.jobs['cancellation-audit'].environment='production',
 w=>w.jobs['cancellation-audit'].steps.find(s=>s.uses?.startsWith('google-github-actions/auth@')).with.service_account='${{ vars.GCP_STAGING_DEPLOY_SERVICE_ACCOUNT }}',
 w=>w.jobs['cancellation-audit'].steps.find(s=>s.uses?.startsWith('google-github-actions/auth@')).with.audience='spoofed',
 w=>w.jobs['cancellation-audit'].steps.find(s=>s.uses?.startsWith('actions/upload-artifact@')).with.path='${{ runner.temp }}',
 ]){const w=yaml.load(workflow);mutate(w);assert.throws(()=>validate(yaml.dump(w)));passed++;}

// Exercise the real shell guard locally. The synthetic gh only serves two fixed
// local fixtures; no credentials, network calls, mail, or cloud writes are used.
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'lkc-privacy-guard-'));
try{
 const bin=path.join(tmp,'bin');fs.mkdirSync(bin);
 fs.writeFileSync(path.join(bin,'gh'),"#!/usr/bin/env node\nconst url=process.argv[3];\nif(process.argv[2]!=='api')process.exit(90);\nif(url==='repos/Hanabo0930/Lip-Knots-Crew/git/ref/heads/main')console.log(process.env.FAKE_MAIN);\nelse if(url==='repos/Hanabo0930/Lip-Knots-Crew/actions/runs?head_sha='+process.env.GITHUB_SHA+'&event=push&per_page=100')console.log(process.env.FAKE_RUNS);\nelse process.exit(91);\n",{mode:0o700});
 const sha='a'.repeat(40),record={id:10,head_sha:sha,path:'.github/workflows/release-candidate.yml',event:'push',conclusion:'success'};
 const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,RUNNER_TEMP:tmp,GH_TOKEN:'synthetic-not-a-token',GITHUB_SHA:sha,GITHUB_REPOSITORY:'Hanabo0930/Lip-Knots-Crew',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',WORKFLOW_REF:entry,OPERATION:'cancellation-privacy-audit',SOURCE_REF:'main',FUNCTIONS:'none',TRANSFER_MODE:'preserve',CONFIRMATION:'AUDIT_LKC_STAGING_CANCELLATION_PRIVACY',FAKE_MAIN:sha,FAKE_RUNS:JSON.stringify({workflow_runs:[record]})};
 const run=(script,changes={})=>spawnSync('bash',['-euo','pipefail','-c',script],{env:{...env,...changes},encoding:'utf8',timeout:5000});
 assert.equal(run(guard).status,0);passed++;
 for(const [key,value] of Object.entries({GITHUB_REPOSITORY:'other/repo',GITHUB_REF:'refs/heads/automation/other',GITHUB_EVENT_NAME:'push',GITHUB_RUN_ATTEMPT:'2',WORKFLOW_REF:entry.replace('staging-functions-deploy','other'),OPERATION:'deploy',SOURCE_REF:'other',FUNCTIONS:'bootstrapSession',TRANSFER_MODE:'active',CONFIRMATION:'DEPLOY',FAKE_MAIN:'b'.repeat(40)})){
  assert.notEqual(run(guard,{[key]:value}).status,0,key);passed++;
 }
 for(const records of [[],[{...record,head_sha:'b'.repeat(40)}],[{...record,path:'.github/workflows/other.yml'}],[{...record,event:'pull_request'}],[{...record,conclusion:'failure'}],[{...record,conclusion:null}],[record,{...record,id:11,conclusion:'failure'}]]){
  assert.notEqual(run(guard,{FAKE_RUNS:JSON.stringify({workflow_runs:records})}).status,0,'Canonical CI must be current and successful');passed++;
 }
 assert.equal(run(recheck).status,0);passed++;
 assert.notEqual(run(recheck,{FAKE_MAIN:'b'.repeat(40)}).status,0,'Main changed during protected review');passed++;
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
console.log(JSON.stringify({schema:'LK_STAGING_CANCELLATION_PRIVACY_WORKFLOW_GUARD_TESTS_V2',passed,cloudOperations:false,entrypoint:'staging-functions-deploy.yml',IAMChanges:false}));
