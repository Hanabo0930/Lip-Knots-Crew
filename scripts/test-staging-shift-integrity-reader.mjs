import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, collectStagingIntegrity, createReadTransport, PROJECT } from './read-staging-shift-integrity.mjs';
const root = `projects/${PROJECT}/databases/(default)/documents`;
const time = '2026-09-07T01:00:00Z';
const job = {companyId:'c',status:'assigned',cancelled:false,assignedStaffId:'s',dateKey:'2026-09-07'};
const lock = {companyId:'c',jobId:'j',staffId:'s',dateKey:'2026-09-07',active:true};
const row = (collection,id,fields) => ({readTime:time,document:{name:`${root}/${collection}/${id}`,fields:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,typeof v==='boolean'?{booleanValue:v}:{stringValue:v}]))}});
const base = () => [[row('jobs','j',job)],[row('staffDayLocks','c_s_2026-09-07',lock)]];
function fixture(pages=base(),options={}) {
  const calls=[]; let index=0;
  const request=async(op,body)=>{calls.push({op,body});if(op==='beginTransaction')return {transaction:'private-transaction'};if(op==='rollback'){if(options.closeFail)throw Error('secret');return {}; } if(options.failAt===index++)throw Error('QUERY_FAILED');return pages.shift();};
  return {calls,request};
}
let passed=0;
async function test(name,fn){try{await fn();passed++;}catch(error){throw new Error(name,{cause:error});}}
async function rejectPages(pages,pattern){const f=fixture(pages);await assert.rejects(collectStagingIntegrity({companyId:'c',request:f.request}),pattern);assert.equal(f.calls.at(-1).op,'rollback');}
await test('single readonly transaction and projections',async()=>{const f=fixture();const r=await collectStagingIntegrity({companyId:'c',request:f.request});assert.equal(r.status,'consistent');assert.deepEqual(f.calls.map(c=>c.op),['beginTransaction','runQuery','runQuery','rollback']);assert.deepEqual(f.calls[0].body,{options:{readOnly:{}}});for(const c of f.calls.slice(1,3)){assert.equal(c.body.transaction,'private-transaction');assert.equal(c.body.structuredQuery.limit,10001);assert.equal(c.body.structuredQuery.where.fieldFilter.value.stringValue,'c');assert.ok(!c.body.structuredQuery.select.fields.some(f=>/email|name|rate/i.test(f.fieldPath)));}assert.ok(!JSON.stringify(r).includes('private-transaction'));});
await test('empty scope is unverified',async()=>{const f=fixture([[{readTime:time}],[{readTime:time}]]);assert.equal((await collectStagingIntegrity({companyId:'c',request:f.request})).status,'unverified');});
await test('missing lock detected',async()=>{const f=fixture([base()[0],[{readTime:time}]]);assert.equal((await collectStagingIntegrity({companyId:'c',request:f.request})).counts.error,1);});
await test('unexpected personal fields discarded',async()=>{const p=base();p[0][0].document.fields.email={stringValue:'DO_NOT_COPY'};const f=fixture(p);assert.ok(!JSON.stringify(await collectStagingIntegrity({companyId:'c',request:f.request})).includes('DO_NOT_COPY'));});
await test('other company rejected',()=>rejectPages([[row('jobs','j',{...job,companyId:'other'})]],/COMPANY/));
await test('foreign project rejected',()=>{const p=base();p[0][0].document.name=p[0][0].document.name.replace(PROJECT,'other');return rejectPages(p,/SCOPE/);});
await test('duplicate document rejected',()=>rejectPages([[...base()[0],...base()[0]]],/DOCUMENT_ID/));
await test('no read time rejected',()=>{const p=base();delete p[0][0].readTime;return rejectPages(p,/INCOMPLETE/);});
await test('empty response rejected',()=>rejectPages([[]],/INCOMPLETE/));
await test('server error rejected',()=>rejectPages([[{error:{message:'secret'}}]],/INCOMPLETE/));
await test('skipped results rejected',()=>rejectPages([[{readTime:time,skippedResults:1}]],/INCOMPLETE/));
await test('unsupported field type rejected',()=>{const p=base();p[0][0].document.fields.cancelled={integerValue:'1'};return rejectPages(p,/UNSUPPORTED/);});
await test('limit overflow rejects partial snapshot',async()=>{const f=fixture([[...base()[0],row('jobs','j2',job)]]);await assert.rejects(collectStagingIntegrity({companyId:'c',cap:1,request:f.request}),/LIMIT/);assert.equal(f.calls.at(-1).op,'rollback');});
for(const failAt of [0,1])await test(`query ${failAt} error closes transaction`,async()=>{const f=fixture(base(),{failAt});await assert.rejects(collectStagingIntegrity({companyId:'c',request:f.request}),/QUERY_FAILED/);assert.equal(f.calls.at(-1).op,'rollback');});
await test('close failure rejects success',async()=>{const f=fixture(base(),{closeFail:true});await assert.rejects(collectStagingIntegrity({companyId:'c',request:f.request}),/CLOSE_FAILED/);});
await test('missing transaction rejected',async()=>{await assert.rejects(collectStagingIntegrity({companyId:'c',request:async()=>({})}),/TRANSACTION/);});
for(const companyId of ['',null,'../other','c\n'])await test('bad company has zero calls',async()=>{const f=fixture();await assert.rejects(collectStagingIntegrity({companyId,request:f.request}),/COMPANY/);assert.equal(f.calls.length,0);});
await test('invalid cap zero calls',async()=>{const f=fixture();await assert.rejects(collectStagingIntegrity({companyId:'c',cap:10001,request:f.request}),/LIMIT/);assert.equal(f.calls.length,0);});
await test('transport endpoint and redirect guard',async()=>{const transport=createReadTransport('private-token',async(url,opts)=>{assert.equal(url,`https://firestore.googleapis.com/v1/${root}:beginTransaction`);assert.equal(opts.redirect,'error');assert.equal(opts.method,'POST');assert.equal(opts.headers.Authorization,'Bearer private-token');return {ok:true,json:async()=>({transaction:'t'})};});await transport('beginTransaction',{options:{readOnly:{}}});await assert.rejects(transport('commit',{}),/DENIED/);});
await test('HTTP error body never exposed',async()=>{const t=createReadTransport('t',async()=>({ok:false,status:403,json:async()=>{throw Error('secret');}}));await assert.rejects(t('runQuery',{}),/^Error: HTTP_403$/);});
await test('network error redacted',async()=>{const t=createReadTransport('t',async()=>{throw Error('secret token');});await assert.rejects(t('runQuery',{}),/^Error: NETWORK_FAILED$/);});
await test('missing token rejected',()=>assert.throws(()=>createReadTransport(''),/TOKEN/));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'lkc-reader-'));
const output=path.join(temp,'report.json');
const originalLog=console.log;
try {
 await test('CLI private report and redacted stdout',async()=>{
  const f=fixture(); const logs=[];
  console.log=value=>logs.push(value);
  const code=await runCli(['--company','c','--output',output],'private-token',async(url,opts)=>({ok:true,json:async()=>f.request(url.split(':').at(-1),JSON.parse(opts.body))}));
  assert.equal(code,0);assert.equal(JSON.parse(fs.readFileSync(output)).source.projectId,PROJECT);
  assert.ok(!logs.join('').includes('private-token'));assert.ok(!logs.join('').includes('private-transaction'));
  console.log=originalLog;
 });
 await test('CLI overwrite rejected before network',async()=>{const before=fs.readFileSync(output,'utf8');let calls=0;await assert.rejects(runCli(['--company','c','--output',output],'t',async()=>{calls++;}));assert.equal(calls,0);assert.equal(fs.readFileSync(output,'utf8'),before);});
 fs.unlinkSync(output);
 await test('CLI failure leaves no valid report',async()=>{await assert.rejects(runCli(['--company','c','--output',output],'t',async()=>({ok:false,status:403})),/HTTP_403/);assert.equal(fs.readFileSync(output,'utf8'),'');});
 await test('CLI rejects extra project argument',()=>assert.rejects(runCli(['--company','c','--output',output,'--project','other'],'t'),/ARGUMENTS/));
} finally { console.log=originalLog; if(fs.existsSync(output))fs.unlinkSync(output);fs.rmdirSync(temp); }
console.log(`Staging integrity reader: ${passed} cases passed.`);
