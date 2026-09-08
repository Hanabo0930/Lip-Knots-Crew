import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import crypto from 'node:crypto';
const dependency=createRequire(process.env.LKC_TEST_DEPENDENCY_ROOT ? path.join(process.env.LKC_TEST_DEPENDENCY_ROOT,'package.json') : import.meta.url);
const ts=dependency('typescript');
const {Timestamp}=dependency('firebase-admin/firestore');
const {HttpsError}=dependency('firebase-functions/v2/https');
const companyId='synthetic-company',staffId='synthetic-staff',sheetId='synthetic-sheet-only',dateKey='2099-09-20';
const lockPath=`staffDayLocks/${companyId}_${staffId}_${dateKey}`;
const deletion=Symbol('delete');
function clone(v) {
  if(v instanceof Timestamp || v===deletion)return v;
  if(Array.isArray(v))return v.map(clone);
  if(v && typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,clone(x)]));
  assert.notEqual(v,undefined,'undefined field');return v;
}
function row(store,staff='',cancelled=false){
  const r=Array(55).fill('');Object.assign(r,{0:dateKey,1:staff,5:'F-only',9:'Synthetic client',10:store,11:'Synthetic maker',12:'Synthetic menu',14:'10:00-18:00',44:true,54:cancelled});return r;
}
// 実モジュール全体を接続する。許可したSDK境界以外のimportは即時拒否する。
function harness(rows){
  const records=new Map(),modules=new Map(),loaded=new Set();let serial=0;
  const h={rows,records,loaded,commits:[],beforeCommit:null,afterCommit:null,reads:0,failRead:false,secondTab:false};
  const snap=ref=>({id:ref.id,exists:records.has(ref.path),data:()=>records.has(ref.path)?clone(records.get(ref.path)):undefined});
  const apply=pending=>{
    const next=new Map(records);
    for(const p of pending){
      if(p.remove){next.delete(p.ref.path);continue;}
      if(p.update)assert.ok(next.has(p.ref.path),'update missing document');
      const value=p.merge?{...next.get(p.ref.path)}:{};
      for(const [key,field] of Object.entries(clone(p.data))){if(field===deletion)delete value[key];else value[key]=field;}
      next.set(p.ref.path,value);
    }
    records.clear();for(const [k,v] of next)records.set(k,v);
  };
  const ref=(name,id=`generated-${++serial}`)=>({id,path:`${name}/${id}`,get:async function(){return snap(this);},set:async function(data,options){apply([{ref:this,data,merge:options?.merge}]);}});
  const collection=(name,filters=[])=>({doc:id=>ref(name,id),where:(field,op,value)=>{assert.equal(op,'==');return collection(name,[...filters,[field,value]]);},get:async()=>({docs:[...records].filter(([k,v])=>k.startsWith(name+'/')&&filters.every(([f,x])=>v[f]===x)).map(([k])=>snap(ref(name,k.slice(name.length+1))))})});
  const db={collection,runTransaction:async callback=>{
    const pending=[];const get=async r=>{assert.equal(pending.length,0,'transaction read after write');return snap(r);};
    const result=await callback({get,getAll:(...refs)=>Promise.all(refs.map(get)),set:(ref,data,options)=>pending.push({ref,data,merge:options?.merge}),update:(ref,data)=>pending.push({ref,data,merge:true,update:true}),delete:ref=>pending.push({ref,remove:true})});
    await h.beforeCommit?.(pending);apply(pending);h.commits.push(pending);await h.afterCommit?.(pending);return result;
  }};
  const sheets={spreadsheets:{get:async input=>{assert.equal(input.spreadsheetId,sheetId);return {data:{sheets:[{properties:{sheetId:1,title:'2099.9',gridProperties:{rowCount:100,columnCount:55}}},{properties:{sheetId:2,title:'2099.10',hidden:!h.secondTab}}]}};},values:{get:async input=>{
    assert.equal(input.spreadsheetId,sheetId);assert.match(input.range,/^'2099\.(9|10)'!/);h.reads++;
    if(h.failRead || (h.secondTab && input.range.startsWith("'2099.10'")))throw new Error('synthetic sheet read failure');return {data:{values:[Array(55).fill('header'),...h.rows]}};
  }}}};
  const boundaries={'./firebase':{db},'firebase-admin/firestore':{Timestamp,FieldValue:{delete:()=>deletion,serverTimestamp:()=>Timestamp.now()}},'firebase-functions/v2/https':{HttpsError,onCall:(...args)=>args.at(-1)},'firebase-functions/v2/scheduler':{onSchedule:(options,callback)=>callback},zod:dependency('zod'),'node:crypto':crypto,googleapis:{google:{auth:{GoogleAuth:class{constructor(options){assert.deepEqual(Array.from(options.scopes),['https://www.googleapis.com/auth/spreadsheets.readonly']);}}},sheets:()=>sheets}}};
  function load(name){
    if(Object.hasOwn(boundaries,name))return boundaries[name];
    assert.match(name,/^\.\/[a-z0-9-]+$/,`External import refused: ${name}`);
    if(modules.has(name))return modules.get(name);
    const source=fs.readFileSync(new URL(`../functions/src/${name.slice(2)}.ts`,import.meta.url),'utf8');
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports={};modules.set(name,exports);loaded.add(name);
    runInNewContext(code,{exports,require:load,process:{env:{APP_ENVIRONMENT:'development'}},console:{warn:()=>{},error:()=>{}},setTimeout:callback=>{callback();return 0;}},{timeout:5000});return exports;
  }
  const importer=load('./shift-import'),jobs=load('./jobs');
  records.set(`sheetImportConfigs/${companyId}`,{companyId,enabled:true,spreadsheetId:sheetId,headerRow:1,dataStartRow:2,readRangeEndColumn:'BC',columns:{workDate:'A',staffName:'B',clientName:'J',storeName:'K',makerName:'L',menuName:'M',workTime:'O',cancelled:'BC'}});
  records.set(`staffProfiles/${staffId}`,{companyId,active:true,displayName:'Synthetic Staff'});
  const admin={uid:'synthetic-admin',token:{companyId,role:'admin'}},staff={uid:'synthetic-user',token:{companyId,role:'staff',staffId}};
  return Object.assign(h,{sync:()=>importer.syncShiftSheetsReadOnly({auth:admin,data:{}}),preview:()=>importer.previewShiftImport({auth:admin,data:{}}),apply:(jobId,requestId='request-0001',auth=staff)=>jobs.applyToJob({auth,data:{jobId,requestId}}),cancel:jobId=>jobs.adminCancelJob({auth:admin,data:{jobId,reason:'Synthetic cancellation'}}),list:name=>[...records].filter(([k])=>k.startsWith(name+'/')).map(([k,v])=>({id:k.slice(name.length+1),...v}))});
}
const results=[];
async function test(name,callback){try{await callback();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:error.message});}}
await test('B/F mapping, incomplete rows, cancellation priority, hidden tabs',async()=>{
  const h=harness([row('Open'),row('Assigned','Synthetic Staff'),row(''),row('','',true)]);h.rows[1][5]='';await h.sync();assert.equal(h.reads,1);assert.deepEqual(h.list('jobs').map(j=>j.status),['open','assigned','draft','cancelled']);assert.equal(h.list('staffDayLocks').length,1);
});
await test('import -> apply -> stale sync -> confirm -> cancel -> stale sync -> source cancel',async()=>{
  const h=harness([row('Main'),row('Other')]);await h.sync();const [job,other]=h.list('jobs');
  assert.equal((await h.apply(job.id)).ok,true);assert.equal(h.records.get(lockPath).jobId,job.id);assert.equal(h.list('sheetSyncQueue').length,1);assert.equal(h.list('notificationQueue').length,2);
  await h.apply(job.id);assert.equal(h.list('sheetSyncQueue').length,1);
  await assert.rejects(h.apply(other.id,'request-0002'),{code:'failed-precondition'});
  await assert.rejects(h.sync(),{code:'failed-precondition'});assert.equal(h.records.get(`jobs/${job.id}`).assignedStaffId,staffId);
  h.rows[0][1]='Synthetic Staff';await h.sync();assert.equal(h.records.get(`jobs/${job.id}`).applicationUnconfirmed,false);
  await h.cancel(job.id);assert.equal(h.records.get(lockPath).active,false);await h.sync();
  assert.equal(h.records.get(`jobs/${job.id}`).status,'cancelled','stale sheet must not undo app cancellation');assert.equal(h.records.get(`jobs/${job.id}`).publishable,false);assert.equal(h.records.get(lockPath).active,false);
  await h.apply(other.id,'request-0003');await h.cancel(job.id);assert.equal(h.records.get(lockPath).jobId,other.id);assert.equal(h.records.get(lockPath).active,true);
  h.rows[0][54]=true;h.rows[1][1]='Synthetic Staff';await h.sync();assert.equal(h.records.get(`jobs/${job.id}`).appOverride,undefined);assert.equal(h.records.get(lockPath).jobId,other.id);assert.equal(h.records.get(lockPath).active,true);
  for(const name of ['./shift-import','./sheet-reader','./shift-parser','./case-id','./jobs','./utils','./notification-core','./notification-time','./system-safety'])assert.ok(h.loaded.has(name));
});
await test('cancel unconfirmed application then resync blank B',async()=>{
  const h=harness([row('Pending')]);await h.sync();const job=h.list('jobs')[0];await h.apply(job.id);await h.cancel(job.id);await h.sync();assert.equal(h.records.get(`jobs/${job.id}`).status,'cancelled');assert.equal(h.records.get(lockPath).active,false);
});
await test('second chunk failure records error, keeps first 25 jobs and retries',async()=>{
  const h=harness(Array.from({length:30},(_,i)=>row(`Store ${i}`)));let chunks=0;h.beforeCommit=p=>{if(p.some(x=>x.ref.path.startsWith('jobs/'))&&++chunks===2)throw new Error('synthetic second chunk failure');};await assert.rejects(h.sync(),{code:'internal'});assert.equal(h.list('jobs').length,25);assert.equal(h.list('sheetImportRuns')[0].status,'error');assert.equal(h.list('syncLocks').length,0);h.beforeCommit=null;await h.sync();assert.equal(h.list('jobs').length,30);
});
await test('lease successor stops next chunk and survives old cleanup',async()=>{
  const h=harness(Array.from({length:30},(_,i)=>row(`Store ${i}`)));h.afterCommit=p=>{if(p.some(x=>x.ref.path.startsWith('jobs/')))h.records.get(`syncLocks/${companyId}_shift_import`).token='successor';};await assert.rejects(h.sync(),{code:'aborted'});assert.equal(h.list('jobs').length,25);assert.equal(h.list('syncLocks')[0].token,'successor');assert.equal(h.list('sheetImportRuns')[0].status,'error');
});
await test('source read failure cannot report completed import',async()=>{
  const h=harness([row('Unread')]);h.failRead=true;await assert.rejects(h.sync());assert.equal(h.list('jobs').length,0);assert.equal(h.list('sheetImportRuns')[0].status,'error');assert.equal(h.list('syncLocks').length,0);
});
await test('later tab read failure writes no jobs; preview keeps diagnostic warnings',async()=>{
  const h=harness([row('First readable tab')]);h.secondTab=true;
  await assert.rejects(h.sync(),{code:'unavailable'});assert.equal(h.list('jobs').length,0);assert.equal(h.list('sheetImportRuns')[0].status,'error');
  const preview=await h.preview();assert.equal(preview.totals.jobs,1);assert.ok(preview.warnings.some(w=>w.includes('2099.10')));assert.equal(h.list('jobs').length,0);
});
await test('real claim guards reject unauthenticated and cross-company apply',async()=>{
  const h=harness([row('Protected')]);await h.sync();const job=h.list('jobs')[0];await assert.rejects(h.apply(job.id,'request-0001',null),{code:'unauthenticated'});await assert.rejects(h.apply(job.id,'request-0001',{uid:'other',token:{companyId:'other',role:'staff',staffId}}),{code:'permission-denied'});assert.equal(h.list('sheetSyncQueue').length,0);assert.equal(h.list('staffDayLocks').length,0);
});
console.log(JSON.stringify({passed:results.filter(r=>r.ok).length,results,boundary:'Full TypeScript modules; in-memory DB and Google API; network-capable application imports refused. No emulator, token validation, SDK concurrency or actual delivery.'},null,2));
if(results.some(r=>!r.ok))process.exitCode=1;
