import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const dependency=createRequire(import.meta.url),ts=dependency('typescript'),{z}=dependency('zod');
class HttpsError extends Error {constructor(code,message){super(message);this.code=code;}}
const compile=name=>ts.transpileModule(fs.readFileSync(new URL('../functions/src/'+name+'.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const code=compile('job-management'),pure={exports:{}};
runInNewContext(compile('job-management-core'),{exports:pure.exports});
const initial={companyId:'company',status:'draft',sourceReady:true,revision:2,dateKey:'2026-09-20'};
const clone=v=>v===undefined?undefined:structuredClone(v);
function setup({job=initial,concurrent,count=0}={}) {
 const records=new Map(job?[['jobs/job',{...job}]]:[]),logs=[],reads=[],committed=[];
 let version=0,injected=false,attempts=0,serial=0;
 const ref=(name,id="generated-"+(++serial))=>({path:name+'/'+id,id});
 const snapshot=r=>({id:r.id,ref:r,exists:records.has(r.path),data:()=>clone(records.get(r.path))});
 const apply=pending=>{for(const item of pending)if(item.create)assert.ok(!records.has(item.ref.path));for(const item of pending){const old=records.get(item.ref.path)??{};const data=Object.fromEntries(Object.entries(item.data).map(([key,value])=>[key,value?.increment!==undefined?(Number(old[key]??0)+value.increment):value]));records.set(item.ref.path,{...old,...data});if(item.ref.path.startsWith("auditLogs/"))logs.push({collection:"auditLogs",data});committed.push(item);}};
 const inject=()=>{if(concurrent&&!injected){records.set('jobs/job',{...records.get('jobs/job'),...concurrent});version++;injected=true;}};
 const query=(name,filters=[],limit=Infinity)=>({
  doc:id=>ref(name,id),add:async data=>{logs.push({collection:name,data});return{id:'log'};},
  where:(key,op,value)=>query(name,[...filters,[key,op,value]],limit),orderBy:()=>query(name,filters,limit),limit:value=>query(name,filters,value),
  get:async()=>{reads.push({name,filters,limit});const docs=Array.from({length:Math.min(count,limit)},(_,i)=>({id:'row-'+i,data:()=>({companyId:'company',status:'assigned',dateKey:'2026-09-20',workDate:'2026-09-20',financials:{clientChargeTotal:100,staffPaymentTotal:60}})}));return{docs,size:docs.length};},
 });
 const db={collection:query,getAll:async(...refs)=>refs.map(r=>{const saved=clone(records.get(r.path));return {...snapshot(r),data:()=>saved};}),
  batch:()=>{const pending=[];return{set:(r,d)=>pending.push({ref:r,data:d}),commit:async()=>{inject();apply(pending);}};},
  runTransaction:async callback=>{for(let retry=0;retry<3;retry++){
   attempts++;const pending=[],seen=version;
   const result=await callback({getAll:async(...refs)=>{assert.equal(pending.length,0);return refs.map(r=>{const saved=clone(records.get(r.path));return{...snapshot(r),data:()=>saved};});},create:(r,d)=>pending.push({ref:r,data:d,create:true}),set:(r,d)=>pending.push({ref:r,data:d})});
   inject();if(seen!==version)continue;apply(pending);return result;
  }throw Error('transaction retry exhausted');},
 };
 const now={toDate:()=>new Date('2026-09-16T00:00:00Z')};
 const boundary={
  'node:crypto':{randomUUID:()=>assert.fail('no group creation')},
  'firebase-admin/firestore':{FieldValue:{delete:()=>null,increment:n=>({increment:n}),serverTimestamp:()=>now},Timestamp:{now:()=>now,fromDate:date=>({date})}},
  'firebase-functions/v2/https':{onCall:(options,handler)=>handler??options,HttpsError},'firebase-functions/v2/scheduler':{onSchedule:()=>null},zod:{z},'./firebase':{db},'./case-id':{hashText:()=>''},'./assignment-preparation-core':{},'./admin-edit-state-core':{},'./job-management-core':pure.exports,'./job-group-creation':{},'./case-mail-job-creation':{},'./case-mail-publication':{readMailPublication:()=>assert.fail('non-mail path must not use mail proof')},
  './utils':{requireAdmin:r=>{if(r.auth?.token.role!=='admin')throw new HttpsError('permission-denied','admin required');return r.auth;},companyFromClaims:t=>t.companyId,requestId:()=> 'request'},
  './system-safety':{assertProductionOperational:async()=>{},getProductionOperationalState:async()=>({operational:true})},
 };
 const exports={};runInNewContext(code,{exports,require:name=>{assert.ok(Object.hasOwn(boundary,name),name);return boundary[name];}},{timeout:3000});
 const request=data=>({auth:{uid:'admin',token:{companyId:'company',role:'admin'}},data});
 return{records,logs,reads,committed,attempts:()=>attempts,publish:(action,extra={})=>exports.updateJobPublication(request({jobIds:['job'],action,...extra})),export:extra=>exports.generateJobExport(request({from:'2026-09-01',through:'2026-09-30',groupBy:'client',...extra})),exports,request};
}
const results=[];
async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});}}
for(const action of ['publish','schedule','draft','stop'])for(const [label,concurrent]of [['assignment',{assignedStaffId:'staff',status:'assigned'}],['cancellation',{cancelled:true,status:'cancelled'}],['tenant-change',{companyId:'other'}]])await test(action+' concurrent '+label,async()=>{
 const t=setup({concurrent});const result=await t.publish(action,{publishAt:'2026-09-17T00:00:00Z'});
 const saved=t.records.get('jobs/job');assert.equal(saved.status,concurrent.status??initial.status);assert.equal(saved.companyId,concurrent.companyId??'company');
 assert.equal(t.attempts(),2,'Conflicting reads must be retried');
 const expectedWrites=label==='assignment'&&action==='stop'?1:0;assert.equal(t.committed.filter(w=>w.ref.path.startsWith("jobs/")).length,expectedWrites);
 assert.equal(result.updated.length,expectedWrites);assert.equal(t.logs.length,1,'Only final transaction result is audited');
});
for(const [action,status]of [['publish','open'],['schedule','scheduled'],['draft','draft'],['stop','stopped']])await test('normal '+action,async()=>{
 const t=setup(),r=await t.publish(action,{publishAt:'2026-09-17T00:00:00Z'});assert.equal(t.records.get('jobs/job').status,status);assert.equal(r.updated.length,1);assert.equal(t.records.get('jobs/job').revision,3);
});
for(const job of [null,{...initial,companyId:'other'},{...initial,cancelled:true,status:'cancelled'}])await test('uneditable '+JSON.stringify(job),async()=>{const t=setup({job});const r=await t.publish('publish');assert.equal(t.committed.filter(w=>w.ref.path.startsWith("jobs/")).length,0);assert.equal(r.updated.length,0);});
await test('source not ready remains draft',async()=>{const t=setup({job:{...initial,sourceReady:false}});const r=await t.publish('publish');assert.equal(t.records.get('jobs/job').status,'draft');assert.equal(r.blocked.length,1);});
await test('untrusted company ignored',async()=>{const t=setup();await t.publish('publish',{companyId:'other'});assert.equal(t.records.get('jobs/job').companyId,'company');});
for(const count of [0,4999,5000,5001])await test('export count '+count,async()=>{
 const t=setup({count});if(count>5000){await assert.rejects(()=>t.export(),{code:'resource-exhausted'});assert.equal(t.logs.length,0);}else{const r=await t.export();assert.equal(r.rows,count);assert.equal(r.summary.invoice,count*100);assert.equal(r.summary.payment,count*60);assert.equal(r.summary.grossProfit,count*40);assert.equal(t.logs.length,1);}
 assert.equal(t.reads.length,1);assert.equal(t.reads[0].limit,5001);assert.ok(t.reads[0].filters.some(([key,op,value])=>key==='companyId'&&op==='=='&&value==='company'));
});
for(const field of ['from','through'])for(const date of ['2026-02-30','2025-02-29','2026-04-31','2026-13-01'])await test('invalid export '+field+' '+date,async()=>{const t=setup();await assert.rejects(()=>t.export({[field]:date}));assert.equal(t.reads.length,0);assert.equal(t.logs.length,0);});
await test('reversed export dates',async()=>{const t=setup();await assert.rejects(()=>t.export({from:'2026-10-01'}),{code:'invalid-argument'});assert.equal(t.reads.length,0);});
for(const api of ['updateJobPublication','generateJobExport'])await test('non-admin '+api,async()=>{const t=setup(),r=t.request({});r.auth.token.role='staff';await assert.rejects(()=>t.exports[api](r),{code:'permission-denied'});assert.equal(t.reads.length+t.committed.length+t.logs.length,0);});
console.log(JSON.stringify({adminPublicationExportTests:results.length,passed:results.every(r=>r.passed),failures:results.filter(r=>!r.passed),cloudOperations:false},null,2));
if(results.some(r=>!r.passed))process.exitCode=1;