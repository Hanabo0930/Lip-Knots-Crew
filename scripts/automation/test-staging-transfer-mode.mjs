import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {resolveTransferMode,materializeTransferMode} from './materialize-staging-transfer-mode.mjs';
let passed=0;
const project='lip-knots-crew-staging',region='asia-northeast1',target='finalizeStagedUpload',entry='createUploadSession';
const current=(mode,name=target)=>({name:'projects/'+project+'/locations/'+region+'/functions/'+name,state:'ACTIVE',
 serviceConfig:{revision:name.toLowerCase()+'-00006-test',environmentVariables:mode===undefined?{}:{LKC_SUBMISSION_TRANSFER_MODE:mode}}});
function check(name,run){run();passed++;}
for(const [requested,saved,expected] of [
 ['preserve','active','active'],['preserve','paused','paused'],
 ['preserve','acceptance','acceptance'],['acceptance','paused','acceptance'],
 ['active','paused','active'],['paused','active','paused'],['paused',undefined,'paused'],
])check('mode '+requested+'/'+saved,()=>assert.equal(resolveTransferMode({requested,functions:[target],current:current(saved),supportsControl:true,supportsAcceptance:true}).mode,expected));
for(const values of [
 {requested:'acceptance',supportsAcceptance:false},
 {requested:'preserve',current:current('acceptance'),supportsAcceptance:false},
 {requested:'acceptance',supportsControl:false},
 {requested:'preserve',current:current('acceptance'),supportsControl:false},
 {requested:'acceptance',functions:[target,'bootstrapSession']},
 {requested:'invalid'}, {requested:'preserve',current:current('invalid')},
 {requested:'paused',functions:['bootstrapSession']},
 {requested:'active',functions:[target,'bootstrapSession']},
 {requested:'paused',functions:[target,target]},
 {requested:'paused',supportsControl:false},
 {requested:'active',supportsControl:false},
 {requested:'preserve',current:current('paused'),supportsControl:false},
 {requested:'preserve',current:{...current('active'),state:'DEPLOYING'}},
 {requested:'preserve',current:{...current('active'),name:'production'}},
])check('reject '+JSON.stringify(values),()=>assert.throws(()=>resolveTransferMode({requested:'preserve',functions:[target],current:current('active'),supportsControl:true,supportsAcceptance:true,...values})));
check('other functions unchanged',()=>assert.equal(resolveTransferMode({requested:'preserve',functions:['bootstrapSession']}),null));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'lkc-transfer-mode-test-'));
fs.mkdirSync(path.join(temp,'functions/src'),{recursive:true});
const validUploads=fs.readFileSync(new URL('../../functions/src/uploads.ts',import.meta.url),'utf8');
fs.writeFileSync(path.join(temp,'functions/src/uploads.ts'),validUploads);
fs.writeFileSync(path.join(temp,'functions/src/submission-transfer-control.ts'),'process.env.LKC_SUBMISSION_TRANSFER_MODE');
const dotenv=path.join(temp,'functions/.env.'+project),base='APP_ENVIRONMENT=staging\nEXPECTED_FIREBASE_PROJECT_ID='+project+'\nDUMMY_SECRET=synthetic-do-not-print\n';
const options={project,region,requested:'preserve',functions:target,sourceDirectory:temp,describe:name=>current('paused',name)};
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
const controlPath=path.join(temp,'functions/src/submission-transfer-control.ts');
const validControl=fs.readFileSync(new URL('../../functions/src/submission-transfer-control.ts',import.meta.url),'utf8');
check('acceptance preserves isolation mode',()=>{
 fs.writeFileSync(dotenv,base);fs.writeFileSync(controlPath,validControl);
 assert.equal(materializeTransferMode({...options,describe:()=>current('acceptance')}).mode,'acceptance');
 assert.equal(fs.readFileSync(dotenv,'utf8'),base+'LKC_SUBMISSION_TRANSFER_MODE=acceptance\n');
});
for(const condition of [
 'mode === "acceptance"',
 'process.env.APP_ENVIRONMENT === "staging"',
 'process.env.EXPECTED_FIREBASE_PROJECT_ID === "lip-knots-crew-staging"',
 'companyId === "lkc-transfer-acceptance-20260908"',
 'if (mode !== "active" && !acceptanceOnly) return true;',
 '&& companyId ===',
])check('acceptance source binding required '+condition,()=>{
 assert.ok(validControl.includes(condition));
 fs.writeFileSync(dotenv,base);fs.writeFileSync(controlPath,validControl.replace(condition,'false'));
 assert.throws(()=>materializeTransferMode({...options,requested:'acceptance'}),/SOURCE_ACCEPTANCE_CONTROL_MISSING/);
 assert.equal(fs.readFileSync(dotenv,'utf8'),base);
});
const workflow=fs.readFileSync(new URL('../../.github/workflows/staging-functions-deploy.yml',import.meta.url),'utf8');
check('workflow defaults to preserve',()=>assert.match(workflow,/transfer_mode:[\s\S]*?default: preserve/));
check('trusted helper runs before deploy',()=>{
 assert.ok(workflow.indexOf('run: node scripts/automation/materialize-staging-transfer-mode.mjs')<workflow.indexOf('run: bash scripts/automation/deploy-staging-functions.sh'));
 assert.match(workflow,/Preserve or explicitly set submission transfer mode\s+working-directory: guardrails/);
});

for(const saved of ['active','paused','acceptance'])check('entry preserves its own '+saved,()=>assert.equal(resolveTransferMode({requested:'preserve',functions:[entry],currentEntry:current(saved,entry),supportsControl:true,supportsAcceptance:true}).mode,saved));
for(const requested of ['active','paused','acceptance'])for(const functions of [[target,entry],[entry,target]])check('paired switch '+requested+'/'+functions,()=>assert.equal(resolveTransferMode({requested,functions,current:current('paused'),currentEntry:current('paused',entry),supportsControl:true,supportsAcceptance:true}).mode,requested));
for(const values of [
 {functions:[entry],requested:'active'},
 {functions:[entry],requested:'paused'},
 {functions:[entry],requested:'acceptance'},
 {functions:[target,entry,'bootstrapSession'],requested:'paused'},
 {functions:[entry,entry]},
 {functions:[entry],currentEntry:current('invalid',entry)},
 {functions:[entry],currentEntry:{...current('paused',entry),state:'DEPLOYING'}},
 {functions:[entry],supportsControl:false},
 {functions:[entry],currentEntry:current('acceptance',entry),supportsAcceptance:false},
])check('entry/pair rejection '+JSON.stringify(values),()=>assert.throws(()=>resolveTransferMode({requested:'preserve',functions:[target,entry],current:current('paused'),currentEntry:current('paused',entry),supportsControl:true,supportsAcceptance:true,...values})));
check('entry-only deployment writes the actual existing pause',()=>{
 fs.writeFileSync(dotenv,base);fs.writeFileSync(controlPath,validControl);fs.writeFileSync(path.join(temp,'functions/src/uploads.ts'),validUploads);
 assert.equal(materializeTransferMode({...options,functions:entry}).mode,'paused');
 assert.equal(fs.readFileSync(dotenv,'utf8'),base+'LKC_SUBMISSION_TRANSFER_MODE=paused\n');
});
check('entry control is checked in its own handler',()=>{
 fs.writeFileSync(dotenv,base);
 fs.writeFileSync(path.join(temp,'functions/src/uploads.ts'),validUploads.replace('if (await submissionTransferPaused(companyId)) throw','if (false) throw'));
 assert.throws(()=>materializeTransferMode({...options,functions:entry}),/SOURCE_TRANSFER_CONTROL_MISSING/);
 assert.equal(fs.readFileSync(dotenv,'utf8'),base);
});
check('paired acceptance applies exactly one shared setting',()=>{
 fs.writeFileSync(dotenv,base);fs.writeFileSync(path.join(temp,'functions/src/uploads.ts'),validUploads);
 assert.equal(materializeTransferMode({...options,functions:entry+','+target,requested:'acceptance'}).mode,'acceptance');
 assert.equal(fs.readFileSync(dotenv,'utf8'),base+'LKC_SUBMISSION_TRANSFER_MODE=acceptance\n');
});

for(const functions of [[target],[entry],[target,entry],[entry,target]])check('missing current mode stops '+functions,()=>{
 fs.writeFileSync(dotenv,base);
 assert.throws(()=>materializeTransferMode({...options,functions:functions.join(','),describe:name=>current(undefined,name)}),/CURRENT_TRANSFER_MODE_UNVERIFIED/);
 assert.equal(fs.readFileSync(dotenv,'utf8'),base);
});
for(const functions of [[target,entry],[entry,target]])for(const absent of [target,entry])check('one missing peer stops '+functions+'/'+absent,()=>{
 fs.writeFileSync(dotenv,base);
 assert.throws(()=>materializeTransferMode({...options,functions:functions.join(','),describe:name=>current(name===absent?undefined:'paused',name)}),/CURRENT_TRANSFER_MODE_UNVERIFIED/);
 assert.equal(fs.readFileSync(dotenv,'utf8'),base);
});
for(const functions of [[target,entry],[entry,target]])check('different current modes are not merged '+functions,()=>{
 fs.writeFileSync(dotenv,base);
 assert.throws(()=>materializeTransferMode({...options,functions:functions.join(','),describe:name=>current(name===entry?'paused':'active',name)}),/CURRENT_TRANSFER_MODES_DIFFER/);
 assert.equal(fs.readFileSync(dotenv,'utf8'),base);
});
for(const functions of [[target],[entry],[target,entry]])check('reads exactly the selected APIs '+functions,()=>{
 fs.writeFileSync(dotenv,base);const read=[];
 const result=materializeTransferMode({...options,functions:functions.join(','),describe:name=>{read.push(name);return current('paused',name);}});
 assert.deepEqual(read,[target,entry].filter(name=>functions.includes(name)));
 assert.deepEqual(Object.keys(result.previousRevisions).sort(),[...functions].sort());
});
check('entry cannot inherit a different API mode',()=>assert.equal(resolveTransferMode({requested:'preserve',functions:[entry],current:current('active'),currentEntry:current('paused',entry),supportsControl:true}).mode,'paused'));
check('entry cannot use a finalizer record as its own before-image',()=>assert.throws(()=>resolveTransferMode({requested:'preserve',functions:[entry],currentEntry:current('paused'),supportsControl:true}),/CURRENT_FUNCTION_UNVERIFIED/));
check('missing entry observation is not inferred from a paused finalizer',()=>assert.throws(()=>resolveTransferMode({requested:'preserve',functions:[target,entry],current:current('paused'),supportsControl:true}),/CURRENT_FUNCTION_UNVERIFIED/));

const bin=path.join(temp,'bin');fs.mkdirSync(bin);
const fakeCloud=path.join(bin,'gcloud'),script=path.resolve(new URL('./materialize-staging-transfer-mode.mjs',import.meta.url).pathname);
const runCli=()=>spawnSync(process.execPath,[script],{encoding:'utf8',env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,LKC_PROJECT_ID:project,LKC_REGION:region,LKC_TRANSFER_MODE_REQUESTED:'preserve',LKC_FUNCTIONS:entry+','+target,LKC_SOURCE_DIRECTORY:temp}});
check('real CLI stops before append when one selected API has no observed mode',()=>{
 fs.writeFileSync(dotenv,base);fs.writeFileSync(fakeCloud,'#!/bin/sh\ncase "$3" in\n'+target+') printf \'%s\\n\' \''+JSON.stringify(current('paused'))+'\';;\n'+entry+') printf \'%s\\n\' \''+JSON.stringify(current(undefined,entry))+'\';;\n*) exit 91;;\nesac\n',{mode:0o700});
 const result=runCli();assert.equal(result.status,1);assert.match(result.stderr,/CURRENT_TRANSFER_MODE_UNVERIFIED/);assert.doesNotMatch(result.stdout+result.stderr,/synthetic-do-not-print/);assert.equal(fs.readFileSync(dotenv,'utf8'),base);
});
check('real CLI redacts a failed private metadata command and leaves dotenv unchanged',()=>{
 fs.writeFileSync(dotenv,base);fs.writeFileSync(fakeCloud,'#!/bin/sh\necho synthetic-private-error-do-not-print >&2\nexit 1\n',{mode:0o700});
 const result=runCli();assert.equal(result.status,1);assert.match(result.stderr,/TRANSFER_MODE_PREPARATION_FAILED/);assert.doesNotMatch(result.stdout+result.stderr,/synthetic-private-error-do-not-print/);assert.equal(fs.readFileSync(dotenv,'utf8'),base);
});
fs.rmSync(temp,{recursive:true,force:true});

console.log(JSON.stringify({stagingTransferModeTests:passed,cloudWritten:false}));
