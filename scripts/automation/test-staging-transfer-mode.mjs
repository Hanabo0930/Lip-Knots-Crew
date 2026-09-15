import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveTransferMode,materializeTransferMode} from './materialize-staging-transfer-mode.mjs';
let passed=0;
const project='lip-knots-crew-staging',region='asia-northeast1',target='finalizeStagedUpload';
const current=mode=>({name:'projects/'+project+'/locations/'+region+'/functions/'+target,state:'ACTIVE',
 serviceConfig:{revision:'finalizestagedupload-00006-test',environmentVariables:mode===undefined?{}:{LKC_SUBMISSION_TRANSFER_MODE:mode}}});
function check(name,run){run();passed++;}
for(const [requested,saved,expected] of [
 ['preserve',undefined,'active'],['preserve','active','active'],['preserve','paused','paused'],
 ['active','paused','active'],['paused','active','paused'],['paused',undefined,'paused'],
])check('mode '+requested+'/'+saved,()=>assert.equal(resolveTransferMode({requested,functions:[target],current:current(saved),supportsControl:true}).mode,expected));
for(const values of [
 {requested:'invalid'}, {requested:'preserve',current:current('invalid')},
 {requested:'paused',functions:['bootstrapSession']},
 {requested:'active',functions:[target,'bootstrapSession']},
 {requested:'paused',functions:[target,target]},
 {requested:'paused',supportsControl:false},
 {requested:'active',supportsControl:false},
 {requested:'preserve',current:current('paused'),supportsControl:false},
 {requested:'preserve',current:{...current('active'),state:'DEPLOYING'}},
 {requested:'preserve',current:{...current('active'),name:'production'}},
])check('reject '+JSON.stringify(values),()=>assert.throws(()=>resolveTransferMode({requested:'preserve',functions:[target],current:current('active'),supportsControl:true,...values})));
check('other functions unchanged',()=>assert.equal(resolveTransferMode({requested:'preserve',functions:['bootstrapSession']}),null));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'lkc-transfer-mode-test-'));
fs.mkdirSync(path.join(temp,'functions/src'),{recursive:true});
fs.writeFileSync(path.join(temp,'functions/src/uploads.ts'),'submissionTransferPaused(companyId); pausedTransferSource;');
fs.writeFileSync(path.join(temp,'functions/src/submission-transfer-control.ts'),'process.env.LKC_SUBMISSION_TRANSFER_MODE');
const dotenv=path.join(temp,'functions/.env.'+project),base='APP_ENVIRONMENT=staging\nEXPECTED_FIREBASE_PROJECT_ID='+project+'\nDUMMY_SECRET=synthetic-do-not-print\n';
const options={project,region,requested:'preserve',functions:target,sourceDirectory:temp,describe:()=>current('paused')};
check('append preserved pause without changing existing settings',()=>{
 fs.writeFileSync(dotenv,base);
 assert.equal(materializeTransferMode(options).mode,'paused');
 assert.equal(fs.readFileSync(dotenv,'utf8'),base+'LKC_SUBMISSION_TRANSFER_MODE=paused\n');
});
check('duplicate setting is rejected unchanged',()=>{
 const before=fs.readFileSync(dotenv,'utf8');assert.throws(()=>materializeTransferMode(options),/STAGING_DOTENV_INVALID/);assert.equal(fs.readFileSync(dotenv,'utf8'),before);
});
check('source without control cannot deploy paused',()=>{
 fs.writeFileSync(dotenv,base);fs.writeFileSync(path.join(temp,'functions/src/submission-transfer-control.ts'),'');
 assert.throws(()=>materializeTransferMode(options),/SOURCE_TRANSFER_CONTROL_MISSING/);assert.equal(fs.readFileSync(dotenv,'utf8'),base);
});
check('wrong project never reads current function',()=>{
 assert.throws(()=>materializeTransferMode({...options,project:'production',describe:()=>assert.fail('unexpected cloud read')}),/STAGING_SCOPE_REQUIRED/);
});
check('other functions never read or write transfer config',()=>{
 assert.equal(materializeTransferMode({...options,functions:'bootstrapSession',sourceDirectory:'unused',describe:()=>assert.fail('unexpected cloud read')}),null);
});
const workflow=fs.readFileSync(new URL('../../.github/workflows/staging-functions-deploy.yml',import.meta.url),'utf8');
check('workflow defaults to preserve',()=>assert.match(workflow,/transfer_mode:[\s\S]*?default: preserve/));
check('trusted helper runs before deploy',()=>{
 assert.ok(workflow.indexOf('run: node scripts/automation/materialize-staging-transfer-mode.mjs')<workflow.indexOf('run: bash scripts/automation/deploy-staging-functions.sh'));
 assert.match(workflow,/Preserve or explicitly set submission transfer mode\s+working-directory: guardrails/);
});
console.log(JSON.stringify({stagingTransferModeTests:passed,cloudWritten:false}));
