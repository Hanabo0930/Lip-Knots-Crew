import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const dep=createRequire(process.env.LKC_TEST_DEPENDENCY_ROOT?path.join(process.env.LKC_TEST_DEPENDENCY_ROOT,'package.json'):import.meta.url);
const ts=dep('typescript');
const source=fs.readFileSync(new URL('../functions/src/shift-import.ts',import.meta.url),'utf8');
const start=source.indexOf('async function acquireSyncLock('),end=source.indexOf('function summarize(',start);
assert.ok(start>=0&&end>start);
const code=ts.transpileModule(source.slice(start,end)+'\nexports.acquire=acquireSyncLock; exports.release=releaseSyncLock;',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
function setup(existing, retry=false){
 let now=1000, record=existing, writes=0, retried=false;
 class Timestamp{constructor(value){this.value=value;}toMillis(){return this.value;}static now(){return new Timestamp(now);}static fromMillis(value){return new Timestamp(value);}}
 if(record?.expiry!==undefined)record={...record,leaseUntil:new Timestamp(record.expiry)};
 const db={collection:name=>({doc:id=>({id:id??'new-token',path:`${name}/${id??'new-token'}`})}),runTransaction:async callback=>{
  for(;;){let pending=null;await callback({get:async()=>({data:()=>record}),set:(ref,data)=>pending=data,delete:()=>pending='delete'});
   if(retry&&!retried){retried=true;now+=120000;continue;}
   if(pending){record=pending==='delete'?undefined:pending;writes++;}return;
  }
 }};
 const exports={};runInNewContext(code,{exports,Timestamp,HttpsError,db},{timeout:3000});
 return {exports,record:()=>record,writes:()=>writes,now:()=>now};
}
let passed=0;
const maxRuntime=Math.max(...[...source.matchAll(/timeoutSeconds:\s*(\d+)/g)].map(match=>Number(match[1])))*1000;
for(const retry of [false,true]){const h=setup(undefined,retry);await h.exports.acquire('company');assert.ok(h.record().leaseUntil.toMillis()-h.now()>=maxRuntime+60000);assert.equal(h.record().acquiredAt.toMillis(),h.now());assert.equal(h.writes(),1);passed++;}
{const h=setup({token:'other',expiry:1001});await assert.rejects(h.exports.acquire('company'),{code:'already-exists'});assert.equal(h.writes(),0);passed++;}
{const h=setup({token:'other',expiry:1000});await h.exports.acquire('company');assert.equal(h.record().token,'new-token');passed++;}
for(const token of ['new-token','other']){const h=setup({token,expiry:9999});await h.exports.release({ref:{path:'syncLocks/company_shift_import'},token:'new-token'});assert.equal(h.writes(),token==='new-token'?1:0);passed++;}
console.log(`Import lease lifecycle: ${passed} cases passed.`);