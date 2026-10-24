import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {makeBoundaryBackend,boundarySourceEvidence} from './submission-boundary-guard-fixture.mjs';
import {candidateIdentity} from './verification-candidate.mjs';
const root=resolve(import.meta.dirname,'..'),results=[];
const fresh=()=>({clientRequestId:randomUUID(),jobId:'synthetic-job',type:'report',purpose:'additional',expectedDateKey:'2026-10-24',expectedRevision:1,
  files:[{originalName:'synthetic.pdf',contentType:'application/pdf',size:12,contentSha256:'a'.repeat(64)}]});
async function scenario(name,run){try{await run();results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:error.stack});console.error('FAIL '+name,error.message);}}
try{
 for(const patch of [{expectedDateKey:'2026-10-25'},{expectedRevision:2},{expectedDateKey:undefined},{expectedRevision:undefined},{expectedDateKey:'2026-02-31'}]){
  await scenario('fresh acceptance rejects mismatched/missing/invalid context '+JSON.stringify(patch),async()=>{
   const b=makeBoundaryBackend(),input={...fresh(),...patch},r=await b.create(input);
   assert.equal(b.parents.size,0);assert.equal(r.__fixtureError.details.accepted,false);assert.equal(r.__fixtureError.details.clientRequestId,input.clientRequestId);
   for(const k of ['jobId','type','purpose'])assert.equal(r.__fixtureError.details[k],input[k]);
  });
 }
 await scenario('assigned staff mismatch creates no receipt and supplies no reset authorization',async()=>{
  const b=makeBoundaryBackend();b.job.assignedStaffId='other-staff';const r=await b.create(fresh());assert.equal(b.parents.size,0);assert.equal(r.__fixtureError.code,'permission-denied');assert.equal(r.__fixtureError.details?.accepted,undefined);
 });
 await scenario('same ID resumes once; intentional additional submission uses distinct ID',async()=>{
  const b=makeBoundaryBackend(),input=fresh();const first=await b.create(input),retry=await b.create(input);assert.equal(retry.submissionId,first.submissionId);assert.equal(b.parents.size,1);
  const next=await b.create({...input,clientRequestId:randomUUID()});assert.notEqual(next.submissionId,first.submissionId);assert.equal(b.parents.size,2);
 });
 await scenario('accepted legacy ID may resume without context; fresh legacy-shaped request cannot create',async()=>{
  const b=makeBoundaryBackend(),input=fresh();const first=await b.create(input);delete input.expectedDateKey;delete input.expectedRevision;
  const replay=await b.create(input);assert.equal(replay.submissionId,first.submissionId);assert.equal(b.parents.size,1);
  assert.ok((await b.create({...input,clientRequestId:randomUUID()})).__fixtureError);assert.equal(b.parents.size,1);
 });
 for(const change of ['date','revision','files','job'])await scenario('accepted ID conflict preserves acceptance and cannot authorize reset: '+change,async()=>{
  const b=makeBoundaryBackend(),input=fresh();await b.create(input);
  if(change==='date')b.job.dateKey='2026-10-25';if(change==='revision')b.job.revision=2;if(change==='files')input.files[0].contentSha256='b'.repeat(64);if(change==='job')[...b.parents.values()][0].jobId='other-job';
  const r=await b.create(input);assert.ok(r.__fixtureError);assert.equal(r.__fixtureError.details?.accepted,undefined);assert.equal(b.parents.size,1);
 });
 await scenario('replacement requires exact open request; accepted replacement resumes',async()=>{
  const b=makeBoundaryBackend(),input={...fresh(),purpose:'replacement',resubmissionRequestId:'synthetic-replacement'};
  b.replacement={companyId:'synthetic-company',staffId:'synthetic-staff',jobId:'synthetic-job',type:'report',status:'open'};
  const first=await b.create(input);assert.ok(first.submissionId);assert.equal((await b.create(input)).submissionId,first.submissionId);
  b.replacement.staffId='other-staff';assert.ok((await b.create({...input,clientRequestId:randomUUID()})).__fixtureError);assert.equal(b.parents.size,1);
 });
 await scenario('response loss after acceptance keeps exact parent and no duplicate on resume',async()=>{
  const b=makeBoundaryBackend(),input=fresh();b.loseNextResponse=true;assert.ok((await b.create(input)).__fixtureError);assert.equal(b.parents.size,1);assert.ok((await b.create(input)).submissionId);assert.equal(b.parents.size,1);
 });
}finally{
 const passed=results.every(r=>r.passed);writeFileSync(resolve(root,'ACCEPTANCE_TRANSACTION_RESULT.json'),JSON.stringify({passed,candidate:candidateIdentity(root),boundarySourceEvidence,
  scope:'Actual candidate uploads.ts transaction body, acceptance helper and existing integrity helpers; in-memory transaction/documents. Schema/Auth/Storage/Functions runtime mocked or outside this test.',results},null,2));process.exitCode=passed?0:1;
}
