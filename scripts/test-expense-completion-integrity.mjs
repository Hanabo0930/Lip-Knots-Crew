import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const dependency = createRequire(process.env.LKC_TEST_DEPENDENCY_ROOT ? path.join(process.env.LKC_TEST_DEPENDENCY_ROOT, 'package.json') : import.meta.url);
const ts = dependency('typescript'), { Timestamp } = dependency('firebase-admin/firestore'), { HttpsError } = dependency('firebase-functions/v2/https');
const copy = value => value instanceof Timestamp ? value : value && typeof value === 'object' ? Array.isArray(value) ? value.map(copy) : Object.fromEntries(Object.entries(value).map(([k,v])=>[k,copy(v)])) : value;
function harness() {
  const rows = new Map(), h = { rows }, modules = new Map();
  const snapshot = ref => { const value=copy(rows.get(ref.path)); return {id:ref.id,ref,exists:rows.has(ref.path),updateTime:Timestamp.fromMillis(h.snapshotVersion??0),data:()=>copy(value)}; };
  const write = (ref,data,options) => { if(options?.update)assert.ok(rows.has(ref.path)); rows.set(ref.path,{...(options?.merge||options?.update ? rows.get(ref.path) : {}),...copy(data)}); };
  const ref = p => ({path:p,id:p.split('/').at(-1),get:async()=>{const value=snapshot(ref(p));await h.afterRead?.(p);return value;},set:async(data,options)=>write(ref(p),data,options)});
  const collection = (name, filters=[]) => ({doc:(id='new')=>ref(`${name}/${id}`),where:(key,op,value)=>{assert.equal(op,'==');return collection(name,[...filters,[key,value]]);},limit:()=>collection(name,filters),get:async()=>{ const docs=[...rows].filter(([p,data])=>p.startsWith(name+'/')&&filters.every(([k,v])=>data[k]===v)).map(([p])=>snapshot(ref(p))); await h.afterQuery?.(); return {docs,empty:docs.length===0}; }});
  const db = {collection,runTransaction:async fn=>{await h.beforeTransaction?.();const writes=[];const value=await fn({get:async r=>{assert.equal(writes.length,0);return snapshot(r);},set:(r,d,o)=>writes.push([r,d,o]),update:(r,d)=>writes.push([r,d,{update:true}])}); for(const [r,d,o] of writes)write(r,d,o);return value;}};
  const boundary={'node:crypto':dependency('node:crypto'),'./firebase':{db},'firebase-admin/firestore':{Timestamp,FieldValue:{serverTimestamp:()=>Timestamp.fromMillis(1000)}},'firebase-functions/v2/https':{HttpsError,onCall:fn=>fn},'firebase-functions/v2/firestore':{onDocumentWritten:(_p,fn)=>fn},zod:dependency('zod'),'./utils':{requireAdmin:request=>request.auth,companyFromClaims:token=>token.companyId,requestId:()=> 'synthetic'},'./system-safety':{assertProductionOperational:async()=>{}}};
  function load(name){if(boundary[name])return boundary[name];assert.equal(name,'./admin-operations-core');if(modules.has(name))return modules.get(name);return compile(name);}
  function compile(name){const exports={};modules.set(name,exports);const code=ts.transpileModule(fs.readFileSync(`functions/src/${name.slice(2)}.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;runInNewContext(code,{exports,require:load},{timeout:5000});return exports;}
  h.api=compile('./admin-operations');
  rows.set('jobs/job',{companyId:'company',assignedStaffId:'staff',sheetRef:{spreadsheetId:'synthetic_spreadsheet_12345678901234567890',sheetId:1,currentRow:2},expenses:{transportation:10}});
  rows.set('expenseReviews/job',{companyId:'company',jobId:'job',staffId:'staff',queueId:'queue',revision:1,status:'queued'});
  rows.set('sheetSyncQueue/queue',{companyId:'company',jobId:'job',operation:'expense.review',status:'completed',updates:{transportation:20},resolvedRow:2});
  h.event=()=>({data:{after:snapshot(ref('sheetSyncQueue/queue'))}});
  h.run=event=>h.api.updateExpenseReviewFromQueue(event??h.event());
  return h;
}
const cases=[];
async function test(name,fn){try{await fn();cases.push({name,passed:true});}catch(error){cases.push({name,passed:false,error:error.message});}}
await test('completed queue updates review and job',async()=>{const h=harness();await h.run();assert.equal(h.rows.get('expenseReviews/job').status,'completed');assert.equal(h.rows.get('jobs/job').expenses.transportation,20);});
await test('blocked queue preserves job values',async()=>{const h=harness();Object.assign(h.rows.get('sheetSyncQueue/queue'),{status:'blocked',errorMessage:'synthetic'});await h.run();assert.equal(h.rows.get('expenseReviews/job').status,'error');assert.equal(h.rows.get('jobs/job').expenses.transportation,10);});
for(const [name,mutate] of [
 ['new review after lookup',h=>h.rows.get('expenseReviews/job').queueId='new-queue'],
 ['review deleted after lookup',h=>h.rows.delete('expenseReviews/job')],
 ['job deleted',h=>h.rows.delete('jobs/job')],
 ['job changed company',h=>h.rows.get('jobs/job').companyId='other'],
 ['review changed company',h=>h.rows.get('expenseReviews/job').companyId='other'],
 ['review changed job',h=>h.rows.get('expenseReviews/job').jobId='other'],
 ['job reassigned',h=>h.rows.get('jobs/job').assignedStaffId='other'],
 ['new draft retains old queue ID',h=>h.rows.get('expenseReviews/job').status='draft'],
 ['queue deleted',h=>h.rows.delete('sheetSyncQueue/queue')],
 ['queue back to pending',h=>h.rows.get('sheetSyncQueue/queue').status='pending'],
 ['queue changed company',h=>h.rows.get('sheetSyncQueue/queue').companyId='other'],
 ]) await test(name,async()=>{const h=harness();const event=h.event();mutate(h);const before=JSON.stringify([...h.rows]);await h.run(event);assert.equal(JSON.stringify([...h.rows]),before);});
await test('out of order blocked event uses latest completed queue',async()=>{const h=harness();h.rows.get('sheetSyncQueue/queue').status='blocked';const event=h.event();h.rows.get('sheetSyncQueue/queue').status='completed';await h.run(event);assert.equal(h.rows.get('expenseReviews/job').status,'completed');assert.equal(h.rows.get('jobs/job').expenses.transportation,20);});
await test('queue replacement during query is not overwritten',async()=>{const h=harness();h.afterQuery=async()=>{h.rows.get('expenseReviews/job').queueId='new-queue';};await h.run();assert.equal(h.rows.get('expenseReviews/job').status,'queued');assert.equal(h.rows.get('jobs/job').expenses.transportation,10);});
for(const [name,mutate] of [
 ['delete review during lookup',h=>h.rows.delete('expenseReviews/job')],
 ['delete job during lookup',h=>h.rows.delete('jobs/job')],
 ['reassign during lookup',h=>h.rows.get('jobs/job').assignedStaffId='other'],
]) await test(name,async()=>{const h=harness();let before;h.afterQuery=async()=>{mutate(h);before=JSON.stringify([...h.rows]);};await h.run();assert.equal(JSON.stringify([...h.rows]),before);});
await test('retain other expense fields',async()=>{const h=harness();h.rows.get('jobs/job').expenses.otherMetadata='retained';await h.run();assert.equal(h.rows.get('jobs/job').expenses.otherMetadata,'retained');});

const request = () => ({ auth: { uid: 'admin', token: { companyId: 'company' } }, data: { jobId: 'job', values: { transportation: 25 }, note: 'synthetic' } });
for (const action of ['saveExpenseReviewDraft', 'completeExpenseReview']) {
  await test(action + ' normal save', async () => { const h=harness(); await h.api[action](request()); const review=h.rows.get('expenseReviews/job'); assert.equal(review.values.transportation,25); assert.equal(review.status,action==='saveExpenseReviewDraft'?'draft':'queued'); });
  for (const [name,mutate] of [
    ['job deletion',h=>h.rows.delete('jobs/job')],
    ['company change',h=>h.rows.get('jobs/job').companyId='other'],
    ['staff change',h=>h.rows.get('jobs/job').assignedStaffId='other'],
    ['expense change',h=>h.rows.get('jobs/job').expenses.transportation=99],
    ['sheet target change',h=>h.rows.get('jobs/job').sheetRef={spreadsheetId:'other',sheetId:2,currentRow:3}],
  ]) await test(action + ' rejects ' + name, async()=>{ const h=harness();let before;h.afterRead=async p=>{if(p==='jobs/job'){h.afterRead=null;mutate(h);before=JSON.stringify([...h.rows]);}};await assert.rejects(h.api[action](request()));assert.equal(JSON.stringify([...h.rows]),before); });
  for(const key of ['companyId','jobId']) await test(action+' rejects foreign review '+key,async()=>{const h=harness();h.rows.get('expenseReviews/job')[key]='other';const before=JSON.stringify([...h.rows]);await assert.rejects(h.api[action](request()));assert.equal(JSON.stringify([...h.rows]),before);});
  await test(action+' retains original creation time',async()=>{const h=harness();h.rows.get('expenseReviews/job').createdAt=Timestamp.fromMillis(7);await h.api[action](request());assert.equal(h.rows.get('expenseReviews/job').createdAt.toMillis(),7);});
}
for(const revision of [-1,1.5,'bad',Number.MAX_SAFE_INTEGER]) await test('invalid revision '+revision,async()=>{const h=harness();h.rows.get('expenseReviews/job').revision=revision;const before=JSON.stringify([...h.rows]);await assert.rejects(h.api.completeExpenseReview(request()));assert.equal(JSON.stringify([...h.rows]),before);});
await test('current expected values preserved in queue',async()=>{const h=harness();await h.api.completeExpenseReview(request());assert.equal(h.rows.get('sheetSyncQueue/new').expected.transportation.value,10);assert.equal(h.rows.get('expenseReviews/job').revision,2);});
await test('explicit existing-value confirmation retained',async()=>{const h=harness();const input=request();input.data.confirmExistingValues=true;await h.api.completeExpenseReview(input);assert.equal(h.rows.get('sheetSyncQueue/new').expected.transportation.mode,'any');});


for(const target of [null,{spreadsheetId:'bad',sheetId:1,currentRow:2}]) await test('invalid sheet link rejects before queue',async()=>{const h=harness();h.rows.get('jobs/job').sheetRef=target;const before=JSON.stringify([...h.rows]);await assert.rejects(h.api.completeExpenseReview(request()));assert.equal(JSON.stringify([...h.rows]),before);});


for(const key of ['companyId','jobId']) await test('read rejects foreign review '+key,async()=>{const h=harness();h.rows.get('expenseReviews/job')[key]='other';await assert.rejects(h.api.getExpenseReview(request()));});
await test('read accepts matching review',async()=>{const h=harness();const result=await h.api.getExpenseReview(request());assert.equal(result.draft.companyId,'company');assert.equal(result.job.id,'job');});


for(const action of ['saveExpenseReviewDraft','completeExpenseReview']){
 await test(action+' accepts fresh review version',async()=>{const h=harness();const read=await h.api.getExpenseReview(request());assert.match(read.reviewVersion,/^[a-f0-9]{64}$/);const input=request();input.data.expectedVersion=read.reviewVersion;await h.api[action](input);});
 for(const [name,change] of [['review note',h=>h.rows.get('expenseReviews/job').note='other admin'],['review status',h=>h.rows.get('expenseReviews/job').status='error'],['amount',h=>h.rows.get('jobs/job').expenses.transportation=99],['staff',h=>h.rows.get('jobs/job').assignedStaffId='other']])await test(action+' rejects stale displayed '+name,async()=>{const h=harness();const read=await h.api.getExpenseReview(request());change(h);const before=JSON.stringify([...h.rows]);const input=request();input.data.expectedVersion=read.reviewVersion;await assert.rejects(h.api[action](input));assert.equal(JSON.stringify([...h.rows]),before);});
 await test(action+' rejects replay of accepted version',async()=>{const h=harness();const read=await h.api.getExpenseReview(request());const input=request();input.data.expectedVersion=read.reviewVersion;await h.api[action](input);const before=JSON.stringify([...h.rows]);await assert.rejects(h.api[action](input));assert.equal(JSON.stringify([...h.rows]),before);});
 await test(action+' rejects malformed version',async()=>{const h=harness();const input=request();input.data.expectedVersion='bad';const before=JSON.stringify([...h.rows]);await assert.rejects(h.api[action](input));assert.equal(JSON.stringify([...h.rows]),before);});
}
await test('new review creation invalidates absent-review version',async()=>{const h=harness();h.rows.delete('expenseReviews/job');const read=await h.api.getExpenseReview(request());h.rows.set('expenseReviews/job',{companyId:'company',jobId:'job',note:'created elsewhere'});const input=request();input.data.expectedVersion=read.reviewVersion;await assert.rejects(h.api.saveExpenseReviewDraft(input));});


await test('snapshot update time rejects same-value ABA',async()=>{const h=harness();const read=await h.api.getExpenseReview(request());h.snapshotVersion=1;const input=request();input.data.expectedVersion=read.reviewVersion;await assert.rejects(h.api.saveExpenseReviewDraft(input));});
await test('review field ordering does not change version',async()=>{const h=harness();const first=await h.api.getExpenseReview(request());h.rows.set('expenseReviews/job',Object.fromEntries(Object.entries(h.rows.get('expenseReviews/job')).reverse()));const second=await h.api.getExpenseReview(request());assert.equal(first.reviewVersion,second.reviewVersion);});
console.log(JSON.stringify({cases:cases.length,passed:cases.every(c=>c.passed),results:cases},null,2));if(cases.some(c=>!c.passed))process.exitCode=1;

