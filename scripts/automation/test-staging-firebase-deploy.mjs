import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {validatePlan,safetyConfig} from "./validate-staging-scope.mjs";
const require=createRequire(import.meta.url),{installInvokerAdapter,resolveCli,VERSION}=require("./run-staging-firebase-deploy.cjs");
let cases=0,iamWrites=0;
const plan=validatePlan({mode:"functions-deploy",project:safetyConfig.projectId,region:safetyConfig.region,sourceRef:"main",functions:"getSheetWriteIssues,previewStaffImport",confirmation:safetyConfig.confirmations.functionsDeploy});
const run={setInvokerCreate:async()=>{iamWrites++;}},messages=[];
installInvokerAdapter(run,plan,line=>messages.push(line));
for(const service of ["getsheetwriteissues","previewstaffimport"]){
 await run.setInvokerCreate(plan.project,"projects/"+plan.project+"/locations/"+plan.region+"/services/"+service,["public"]);cases++;
}
for(const [project,service,invokers]of [
 ["production","projects/"+plan.project+"/locations/"+plan.region+"/services/getsheetwriteissues",["public"]],
 [plan.project,"projects/other/locations/"+plan.region+"/services/getsheetwriteissues",["public"]],
 [plan.project,"projects/"+plan.project+"/locations/us-central1/services/getsheetwriteissues",["public"]],
 [plan.project,"projects/"+plan.project+"/locations/"+plan.region+"/services/unrequested",["public"]],
 [plan.project,"projects/"+plan.project+"/locations/"+plan.region+"/services/getsheetwriteissues/extra",["public"]],
 [plan.project,"projects/"+plan.project+"/locations/"+plan.region+"/services/getsheetwriteissues",["allUsers"]],
 [plan.project,"projects/"+plan.project+"/locations/"+plan.region+"/services/getsheetwriteissues",["public","other"]],
 [plan.project,"projects/"+plan.project+"/locations/"+plan.region+"/services/getsheetwriteissues",[]],
 [plan.project,"projects/"+plan.project+"/locations/"+plan.region+"/services/getsheetwriteissues","public"],
 [plan.project,null,["public"]],
]){
 await assert.rejects(run.setInvokerCreate(project,service,invokers),/UNEXPECTED_INVOKER_CREATE_REQUEST/);cases++;
}
assert.equal(iamWrites,0);assert.equal(messages.length,2);cases++;
for(const changes of [{project:"other"},{region:"us-central1"},{functions:[]},{functions:["bad/name"]},{functions:null}]){
 assert.throws(()=>installInvokerAdapter({setInvokerCreate(){}},{...plan,...changes}),/INVALID_INVOKER_PLAN/);cases++;
}
assert.throws(()=>installInvokerAdapter({},plan),/CLI_INVOKER_CONTRACT_CHANGED/);cases++;
for(const name of ["finalizeStagedUpload","processNotificationQueue","retrySafeSheetWrites","processSafeSheetWrite"]){
 const mock={setInvokerCreate(){iamWrites++;}};installInvokerAdapter(mock,{...plan,functions:[name]});
 await assert.rejects(mock.setInvokerCreate(plan.project,"projects/"+plan.project+"/locations/"+plan.region+"/services/"+name.toLowerCase(),["public"]));cases++;
}
const base=path.resolve("synthetic-package"),root=path.join(base,"firebase-tools"),binary=path.join(root,"lib","bin","firebase.js");
function io(version=VERSION,name="firebase-tools",target=binary){return {existsSync:()=>true,realpathSync:()=>target,readFileSync:()=>JSON.stringify({name,version})};}
assert.deepEqual(resolveCli(base,io()),{root,binary});cases++;
for(const mock of [io("0.0.0"),io(VERSION,"other"),io(VERSION,"firebase-tools",path.join(base,"firebase"))]){
 assert.throws(()=>resolveCli(base,mock),/UNEXPECTED_FIREBASE/);cases++;
}
assert.throws(()=>resolveCli(base,{existsSync:()=>false}),/PINNED_FIREBASE_CLI_NOT_FOUND/);cases++;
const source=fs.readFileSync(new URL("./run-staging-firebase-deploy.cjs",import.meta.url),"utf8");
assert.ok(source.indexOf("validatePlan({")<source.indexOf("installInvokerAdapter(run, plan)"));
assert.ok(source.indexOf("installInvokerAdapter(run, plan)")<source.indexOf("require(cli.binary)"));
assert.match(source,/project: process.env.LKC_PROJECT_ID/);assert.match(source,/plan.functions.map/);cases++;
const shell=fs.readFileSync(new URL("./deploy-staging-functions.sh",import.meta.url),"utf8");
assert.match(shell,/set -euo pipefail/);assert.match(shell,/--package=firebase-tools@15\.24\.0/);
assert.ok(shell.indexOf('node "$lkc_trusted_runner"')<shell.indexOf("--no-invoker-iam-check"));
assert.ok(shell.includes("FORBIDDEN_PUBLIC_IAM_BINDING_FOUND"));assert.doesNotMatch(shell,/add-iam-policy-binding|set-iam-policy/);cases++;
assert.equal(iamWrites,0);
console.log(JSON.stringify({initialCallableDeploymentTests:cases,iamWrites,cloudOperations:false}));