import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'fixtures/submission-boundaries-33c2b3f');
const manifest=JSON.parse(readFileSync(resolve(root,'SOURCE.json'),'utf8'));
const sources=Object.fromEntries(Object.entries(manifest.sha256).map(([name,hash])=>{
  const bytes=readFileSync(resolve(root,name));assert.equal(createHash('sha256').update(bytes).digest('hex'),hash);return [name,bytes.toString()];
}));
// Frozen helpers must still match the current production inputs; no stale helper may hide a regression.
for(const name of ['case-mail-preparation-core.ts','assignment-preparation-core.ts','submission-integrity.ts']){
 const current=readFileSync(resolve(import.meta.dirname,'../functions/src',name),'utf8').replace(/\r\n/g,'\n');
 assert.equal(current,sources[name].replace(/\r\n/g,'\n'),'Update the pinned helper fixture after reviewing production changes: '+name);
}
class HttpsError extends Error{constructor(code,message,details){super(message);this.code=code;this.details=details;}}
const modules={};
function compileModule(name,source){
  const exports={};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
    {exports,require(specifier){if(specifier==='firebase-functions/v2/https')return {HttpsError};assert.ok(modules[specifier],specifier);return modules[specifier];}});return exports;
}
modules['./case-mail-preparation-core']=compileModule('case-mail',sources['case-mail-preparation-core.ts']);
const assignment=sources['assignment-preparation-core.ts'];
// Only the real pure context helpers are needed; do not load operational imports.
modules['./assignment-preparation-core']=compileModule('assignment',assignment.slice(assignment.indexOf('function contactIdentity('),assignment.indexOf('export function nextAssignmentRevision(')));
const integrity=compileModule('integrity',sources['submission-integrity.ts']);
const uploads=readFileSync(resolve(import.meta.dirname,'../functions/src/uploads.ts'),'utf8');
const acceptance=compileModule('acceptance',readFileSync(resolve(import.meta.dirname,'../functions/src/submission-acceptance-context.ts'),'utf8'));
const start=uploads.indexOf('    const jobSnap = await tx.get('),end=uploads.indexOf('\n  });',start);
assert.ok(start>0&&end>start);
const scope={...integrity,...acceptance,HttpsError};
vm.runInNewContext(ts.transpileModule(`async function check({input,job:jobData,companyId,staffId,session,parent,fingerprint,fileRecords,replacement}){
const writes=[];
const db={collection:name=>({doc:id=>({kind:name,id})})};
const submissionRef={kind:'parent',id:parent?.id??'synthetic-parent-'+input.clientRequestId,collection:()=>({doc:id=>({kind:'file',id})})};
const tx={get:async ref=>ref.kind==='jobs'?{exists:!!jobData,data:()=>jobData}:ref.kind==='resubmissionRequests'?{exists:!!replacement,data:()=>replacement}:ref.kind==='file'?{data:()=>parent.files.find(f=>f.fileId===ref.id)}:{exists:!!parent,data:()=>parent},
create:(ref,data)=>writes.push({ref,data})};
const now='synthetic-time',createSubmissionDeadlinePolicy=()=>({synthetic:true});
const receipt=await (async()=>{
${uploads.slice(start,end)}
})();return {receipt,writes};
}
globalThis.check=check;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,scope);

export function makeBoundaryBackend(){
 const job={id:'synthetic-job',companyId:'synthetic-company',assignedStaffId:'synthetic-staff',dateKey:'2026-10-24',status:'assigned',revision:1};
 const state={job,parents:new Map(),requests:[],uploads:[],rejectUpload:false,loseNextResponse:false,unknownBeforeAccept:false,rejections:[],replacement:null};
 const uid='synthetic-owner-a',companyId=job.companyId,staffId=job.assignedStaffId;
 state.create=async input=>{
  state.requests.push(structuredClone(input));
  if(state.unknownBeforeAccept){state.unknownBeforeAccept=false;return {__fixtureError:{code:'unavailable',message:'受付結果を確認できません。'}};}
  const parent=state.parents.get(input.clientRequestId);
  const fingerprint=createHash('sha256').update(JSON.stringify([input.jobId,input.type,input.purpose,input.resubmissionRequestId??null,input.files])).digest('hex');
  const fileRecords=input.files.map((file,i)=>({fileId:'synthetic-file-'+i,storagePath:'synthetic/'+input.clientRequestId+'/'+i,...file}));
  let accepted;
  try{accepted=await scope.check({input,job:input.jobId===job.id?job:null,companyId,staffId,session:{uid},parent,fingerprint,fileRecords,replacement:state.replacement});}
  catch(error){state.rejections.push({code:error.code,message:error.message,details:error.details});return {__fixtureError:{code:error.code,message:error.message,details:error.details}};}
  if(!parent){
   const record={id:accepted.writes[0].ref.id,...accepted.writes[0].data};
   record.files=accepted.writes.slice(1).map(({ref,data})=>({id:ref.id,fileId:ref.id,...data}));
   state.parents.set(input.clientRequestId,record);
  }
  if(state.loseNextResponse){state.loseNextResponse=false;return {__fixtureError:{code:'unavailable',message:'受付結果を確認できません。'}};}
  const saved=state.parents.get(input.clientRequestId);
  return {submissionId:saved.id,clientRequestId:input.clientRequestId,files:fileRecords.map(f=>({storagePath:f.storagePath,uploadRequired:!saved.uploaded}))};
 };
 state.upload=payload=>{state.uploads.push(payload);if(state.rejectUpload){state.rejectUpload=false;throw Error('Synthetic upload interruption');}const id=payload.path.split('/')[1],p=state.parents.get(id);p.uploaded=true;p.status='completed';p.completedFiles=p.totalFiles;p.files.forEach(f=>{f.status='completed';f.completionCounted=true;});};
 state.timeline=()=>({submissions:[...state.parents.values()].map(p=>({...p,files:p.files.map(f=>({...f,driveName:'',previewUrl:null})),createdAt:'2026-10-23T00:00:00.000Z',completedAt:null}))});
 return state;
}
export const boundarySourceEvidence={legacyPureHelpers:manifest,uploadsSha256:createHash('sha256').update(uploads).digest('hex'),acceptanceSha256:createHash('sha256').update(readFileSync(resolve(import.meta.dirname,'../functions/src/submission-acceptance-context.ts'))).digest('hex')};
