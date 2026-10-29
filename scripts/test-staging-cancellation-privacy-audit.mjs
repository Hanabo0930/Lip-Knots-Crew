import assert from 'node:assert/strict';
import {auditStagingCancellationPrivacy} from './audit-staging-cancellation-privacy.mjs';
import {PROJECT,createReadTransport} from './read-staging-shift-integrity.mjs';
const prefix='projects/'+PROJECT+'/databases/(default)/documents/jobs/',time='2026-10-29T00:00:00.000Z';
const row=(id,status='assigned',cancelled)=>({readTime:time,document:{name:prefix+id,fields:{status:{stringValue:status},...(cancelled===undefined?{}:{cancelled:{booleanValue:cancelled}})}}});
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
function fixture(rows,mutate){
 const calls=[];const request=async(operation,body)=>{calls.push({operation,body});if(operation==='beginTransaction')return {transaction:'synthetic-read-only'};if(operation==='rollback')return {};assert.equal(operation,'runQuery');return mutate?mutate(rows):rows;};return {calls,request};
}
await test('All staging jobs, exactly two nonprivate fields, readonly transaction and rollback',async()=>{
 const h=fixture([row('assigned'),row('open','open',false),row('cancel','cancelled',true)]);
 const r=await auditStagingCancellationPrivacy(h);assert.equal(r.zeroConflicts,true);assert.equal(r.scannedJobs,3);assert.equal(r.cancelledJobs,1);assert.equal(r.deploymentReady,false);
 assert.deepEqual(h.calls.map(c=>c.operation),['beginTransaction','runQuery','rollback']);assert.deepEqual(h.calls[0].body,{options:{readOnly:{}}});
 const q=h.calls[1].body.structuredQuery;assert.deepEqual(q.select.fields.map(f=>f.fieldPath),['status','cancelled']);assert.equal(q.where,undefined);assert.equal(q.limit,10001);
 assert(!JSON.stringify(r).includes('documents/'));assert(!JSON.stringify(r).includes('synthetic-read-only'));
});
await test('Empty successful snapshot is distinct from missing or failed query',async()=>{
 const r=await auditStagingCancellationPrivacy(fixture([{readTime:time}]));assert.equal(r.scannedJobs,0);assert.equal(r.status,'PASS');
});
for(const [status,flag]of [['assigned',true],['open',true],['draft',true],['scheduled',true],['stopped',true],['archived',true],['cancelled',false],['cancelled',undefined]])await test('Contradictory '+status+'/'+flag+' is HOLD, never deployment clearance',async()=>{
 const r=await auditStagingCancellationPrivacy(fixture([row('private-id',status,flag)]));assert.equal(r.status,'HOLD');assert.equal(r.zeroConflicts,false);assert.equal(r.conflicts,1);assert(!JSON.stringify(r).includes('private-id'));
});
await test('Declared archived state is audited without treating it as cancelled',async()=>{
 const r=await auditStagingCancellationPrivacy(fixture([row('private-archive','archived',false)]));
 assert.equal(r.status,'PASS');assert.equal(r.scannedJobs,1);assert.equal(r.cancelledJobs,0);assert.equal(r.deploymentReady,false);
});
await test('Unsupported states scan the full snapshot, report only fixed buckets, and still fail closed',async()=>{
 const missing=row('private-missing');delete missing.document.fields.status;
 const invalid=row('private-invalid');invalid.document.fields.status={integerValue:'12345'};
 const h=fixture([row('private-normal'),row('private-unknown','PRIVATE_UNKNOWN_STATUS'),missing,invalid,row('private-archive','archived'),row('private-final','cancelled',true)]);
 await assert.rejects(auditStagingCancellationPrivacy(h),error=>{
  assert.equal(error.message,'UNKNOWN_JOB_STATUS');assert.deepEqual(error.statusAudit,{scannedJobs:6,statusCounts:{draft:0,scheduled:0,open:0,assigned:1,stopped:0,cancelled:1,archived:1},missingStatusJobs:1,invalidStatusJobs:1,unknownStatusJobs:1});
  assert(!JSON.stringify(error).includes('private-'));assert(!JSON.stringify(error).includes('PRIVATE_UNKNOWN_STATUS'));assert(!('zeroConflicts' in error.statusAudit));return true;
 });
 assert.equal(h.calls.at(-1).operation,'rollback');
});
await test('Later snapshot errors override aggregate status diagnostics',async()=>{
 const h=fixture([row('private-unknown','PRIVATE_UNKNOWN_STATUS'),{...row('private-final'),readTime:'2026-10-29T00:00:01Z'}]);
 await assert.rejects(auditStagingCancellationPrivacy(h),/INCONSISTENT_SNAPSHOT/);assert.equal(h.calls.at(-1).operation,'rollback');
});
for(const [name,mutate]of [
 ['truncated',()=>[]],['unfinished',r=>[{...r[0],done:false}]],['server error',()=>[{error:{message:'PRIVATE'}}]],['skipped',r=>[{...r[0],skippedResults:1}]],['missing read time',r=>[{document:r[0].document}]],
 ['private fields',r=>{r[0].document.fields.cancellationReason={stringValue:'PRIVATE'};return r;}],
 ['foreign project',r=>{r[0].document.name=r[0].document.name.replace(PROJECT,'production');return r;}],
 ['duplicate',r=>[r[0],r[0]]],['different read times',r=>[r[0],{...row('other'),readTime:'2026-10-29T00:00:01Z'}]],
 ['unknown status',()=>[row('one','unknown')]],['bad flag type',r=>{r[0].document.fields.cancelled={stringValue:'true'};return r;}],
 ['partial empty',r=>[{readTime:time},r[0]]],['nested document',r=>{r[0].document.name+='/nested/id';return r;}],
])await test('Incomplete '+name+' fails closed but releases transaction',async()=>{
 const h=fixture([row('one')],mutate);await assert.rejects(auditStagingCancellationPrivacy(h));assert.equal(h.calls.at(-1).operation,'rollback');
});
await test('Cap plus one detects incomplete coverage',async()=>{
 const h=fixture([row('one'),row('two')]);await assert.rejects(auditStagingCancellationPrivacy({...h,cap:1}),/AUDIT_LIMIT_EXCEEDED/);assert.equal(h.calls.at(-1).operation,'rollback');
});
await test('Missing transaction or failed rollback cannot produce a report',async()=>{
 await assert.rejects(auditStagingCancellationPrivacy({request:async()=>({})}),/READ_ONLY_TRANSACTION_REQUIRED/);
 const h=fixture([row('one')]);await assert.rejects(auditStagingCancellationPrivacy({request:async(op,body)=>op==='rollback'?Promise.reject(Error('PRIVATE')):h.request(op,body)}),/READ_TRANSACTION_RELEASE_FAILED/);
});
await test('Transport pins staging project, three readonly RPCs, no redirects, and rejects writes',async()=>{
 const observed=[];const request=createReadTransport('synthetic-token',async(url,options)=>{observed.push({url,options});return {ok:true,json:async()=>({})};});
 for(const op of ['commit','batchWrite','delete','createDocument'])await assert.rejects(request(op,{}),/OPERATION_DENIED/);
 await request('rollback',{transaction:'synthetic'});assert.equal(observed.length,1);assert(observed[0].url.startsWith('https://firestore.googleapis.com/v1/projects/lip-knots-crew-staging/'));assert.equal(observed[0].options.redirect,'error');
});
console.log(JSON.stringify({schema:'LK_STAGING_CANCELLATION_PRIVACY_AUDIT_TESTS_V1',passed,externalRequests:0,businessWrites:0,cloudAcceptance:false}));

