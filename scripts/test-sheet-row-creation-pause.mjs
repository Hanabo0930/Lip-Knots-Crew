import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";
const require=createRequire(import.meta.url),ts=require("typescript");
const {Timestamp}=require("firebase-admin/firestore"),{HttpsError}=require("firebase-functions/v2/https");
let cloudCalls=0;
http.request=https.request=globalThis.fetch=()=>{cloudCalls++;throw Error("REAL_NETWORK_FORBIDDEN");};
function harness(mode,compiled){
 const state={collections:0,reads:0,writes:0,batches:0,commits:0,operationalReads:0,sheets:0,auth:0,changes:[]};
 const env={APP_ENVIRONMENT:"staging",...(mode===undefined?{}:{LKC_SHEET_WRITE_MODE:mode})};
 const reference={id:"synthetic-row-queue",set:async value=>{state.writes++;state.changes.push(value);}};
 const doc={ref:reference,data:()=>({companyId:"synthetic-company",status:"pending"}),exists:true};
 const query={where(){return this;},limit(){return this;},async get(){state.reads++;return {docs:[doc],empty:false};}};
 const db={collection(name){assert.equal(name,"sheetRowCreateQueue");state.collections++;return query;},batch(){state.batches++;return {set(ref,value){assert.equal(ref,reference);state.writes++;state.changes.push(value);},async commit(){state.commits++;}};}};
 const boundaries={"node:crypto":crypto,zod:require("zod"),"./firebase":{db},
  "firebase-admin/firestore":{Timestamp,FieldValue:{serverTimestamp:()=>Timestamp.now()}},
  "firebase-functions/v2/https":{HttpsError,onCall:(...args)=>args.at(-1)},
  "firebase-functions/v2/firestore":{onDocumentWritten:(_path,callback)=>callback},
  "firebase-functions/v2/scheduler":{onSchedule:(_options,callback)=>callback},
  "./system-safety":{getProductionOperationalState:async()=>{state.operationalReads++;return {operational:false,reason:"synthetic-global-pause"};}},
  googleapis:{google:{auth:{GoogleAuth:class{constructor(){state.auth++;throw Error("UNEXPECTED_SHEETS_AUTH");}}},sheets:()=>{state.sheets++;throw Error("UNEXPECTED_SHEETS_ACCESS");}}},
 };
 const cache=new Map();
 function load(name){
  if(Object.hasOwn(boundaries,name))return boundaries[name];
  assert.ok(["./sheet-row-creation","./sheet-row-creation-core","./sheet-write-control","./utils"].includes(name),"Unexpected import "+name);
  if(cache.has(name))return cache.get(name);
  const exports={};cache.set(name,exports);
  const file="../functions/"+(compiled?"lib/":"src/")+name.slice(2)+(compiled?".js":".ts");
  const source=fs.readFileSync(new URL(file,import.meta.url),"utf8");
  runInNewContext(compiled?source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:load,process:{env},console});
  return exports;
 }
 const worker=load("./sheet-row-creation");
 return {state,event:()=>worker.processSheetRowCreation({data:{after:doc}}),retry:()=>worker.retrySheetRowCreation()};
}
const results=[];
async function test(name,callback){try{await callback();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});}}
for(const compiled of [false,true]){
 for(const mode of [undefined,"paused","invalid","","ACTIVE"," active","active ",null])for(const entry of ["event","retry"]){
  await test(`${compiled?"compiled":"source"} ${String(mode)} ${entry} preserves queue`,async()=>{
   const h=harness(mode,compiled),before=JSON.stringify(h.state);await h[entry]();assert.equal(JSON.stringify(h.state),before);
  });
 }
 await test(`${compiled?"compiled":"source"} active event retains global guard`,async()=>{
  const h=harness("active",compiled);await h.event();assert.equal(h.state.operationalReads,1);assert.equal(h.state.writes,1);
  assert.equal(h.state.changes[0].status,"paused_global");assert.equal(h.state.sheets,0);assert.equal(h.state.auth,0);
 });
 await test(`${compiled?"compiled":"source"} active retry retains reservation`,async()=>{
  const h=harness("active",compiled);await h.retry();assert.equal(h.state.reads,1);assert.equal(h.state.commits,1);assert.equal(h.state.writes,1);
  assert.equal(h.state.changes[0].status,"pending");assert.equal(h.state.sheets,0);assert.equal(h.state.auth,0);
 });
}
assert.equal(cloudCalls,0);
const failed=results.filter(r=>!r.passed);
console.log(JSON.stringify({sheetRowPauseTests:results.length,passed:results.length-failed.length,failed,cloudCalls,realSheetWrites:0}));
if(failed.length)process.exitCode=1;
