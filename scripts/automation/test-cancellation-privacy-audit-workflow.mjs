import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),yaml=require('js-yaml');
const workflow=fs.readFileSync('.github/workflows/staging-cancellation-privacy-audit.yml','utf8');
function validate(text){
 const w=yaml.load(text);assert.deepEqual(Object.keys(w.on),['workflow_dispatch']);assert.deepEqual(w.permissions,{contents:'read'});
 assert.equal(w.concurrency['cancel-in-progress'],false);assert.deepEqual(Object.keys(w.jobs),['guard','audit']);const a=w.jobs.audit;
 assert.equal(a.needs,'guard');assert.equal(a.environment,'lkc-staging-deploy');assert.deepEqual(a.permissions,{contents:'read','id-token':'write'});
 const guard=w.jobs.guard.steps[0].run;for(const marker of ['refs/heads/main','Hanabo0930/Lip-Knots-Crew','workflow_dispatch','GITHUB_RUN_ATTEMPT','AUDIT_LKC_STAGING_CANCELLATION_PRIVACY','current_main','CURRENT_MAIN_CANONICAL_CI_REQUIRED'])assert(guard.includes(marker),marker);
 assert(guard.includes('[[ "$current_main" == "$GITHUB_SHA" ]]'));assert(guard.includes('[[ "$GITHUB_RUN_ATTEMPT" == "1" ]]'));assert(guard.includes('r["path"]==".github/workflows/release-candidate.yml"'));assert(guard.includes('["conclusion"]!="success"'));
 assert(!w.jobs.guard.environment);assert(!w.jobs.guard.permissions);
 const auth=a.steps.find(s=>s.uses?.startsWith('google-github-actions/auth@'));assert.equal(auth.with.service_account,'\u0024{{ vars.GCP_STAGING_OBSERVER_SERVICE_ACCOUNT }}');
 const checkout=a.steps.find(s=>s.uses?.startsWith('actions/checkout@'));assert.equal(checkout.with.ref,'\u0024{{ github.sha }}');assert.equal(checkout.with['persist-credentials'],false);
 const read=a.steps.find(s=>s.name==='Read only status and cancellation flag').run;
 assert.equal(read.trim(),'set -euo pipefail\nset +x\ngcloud auth print-access-token | node scripts/audit-staging-cancellation-privacy.mjs --token-stdin --evidence "$RUNNER_TEMP/cancellation-privacy-audit"');
 for(const s of a.steps.filter(s=>s.uses))assert(/@[a-f0-9]{40}$/.test(s.uses),'Pinned action');
 assert.equal(a.steps.length,7);assert(!/(firebase deploy|gcloud .*?(?:create|update|delete|deploy)|set-iam-policy|terraform|curl)/.test(text));
 const artifact=a.steps.find(s=>s.uses?.startsWith('actions/upload-artifact@'));assert.equal(artifact.with.path,'\u0024{{ runner.temp }}/cancellation-privacy-audit/privacy-audit.json');
}
validate(workflow);let passed=1;
for(const [oldText,newText] of [
 ['refs/heads/main','refs/heads/automation/other'],
 ['AUDIT_LKC_STAGING_CANCELLATION_PRIVACY','DEPLOY'],
 ['[[ "$current_main" == "$GITHUB_SHA" ]]','true'],
 ['[[ "$GITHUB_RUN_ATTEMPT" == "1" ]]','true'],
 ['GCP_STAGING_OBSERVER_SERVICE_ACCOUNT','GCP_STAGING_DEPLOY_SERVICE_ACCOUNT'],
 ['environment: lkc-staging-deploy','environment: production'],
 ['persist-credentials: false','persist-credentials: true'],
 ['gcloud auth print-access-token | node scripts/audit-staging-cancellation-privacy.mjs','firebase deploy'],
 ['["conclusion"]!="success"','["conclusion"]!="failure"'],
 ['.github/workflows/release-candidate.yml','.github/workflows/other.yml'],
 ['retention-days: 7','retention-days: 7\n          ignored: true\n  deploy:\n    runs-on: ubuntu-latest'],
 ]){assert(workflow.includes(oldText));assert.throws(()=>validate(workflow.replace(oldText,newText)));passed++;}
console.log(JSON.stringify({schema:'LK_STAGING_CANCELLATION_PRIVACY_WORKFLOW_GUARD_TESTS_V1',passed,cloudOperations:false}));

