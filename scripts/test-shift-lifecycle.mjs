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
function harness(rows,clock){
  const records=new Map(),modules=new Map(),loaded=new Set();let serial=0;
  const h={rows,records,loaded,commits:[],beforeCommit:null,afterCommit:null,reads:0,failRead:false,secondTab:false,environment:'development'};
  const snap=ref=>({id:ref.id,exists:records.has(ref.path),data:()=>records.has(ref.path)?clone(records.get(ref.path)):undefined});
  const apply=pending=>{
    const next=new Map(records);
    for(const p of pending){
      if(p.create)assert.ok(!next.has(p.ref.path),"create existing document");
      if(p.remove){next.delete(p.ref.path);continue;}
      if(p.update)assert.ok(next.has(p.ref.path),'update missing document');
      const value=p.merge?{...next.get(p.ref.path)}:{};
      for(const [key,field] of Object.entries(clone(p.data))){if(field===deletion)delete value[key];else value[key]=field;}
      next.set(p.ref.path,value);
    }
    records.clear();for(const [k,v] of next)records.set(k,v);
  };
  const ref=(name,id=`generated-${++serial}`)=>({id,path:`${name}/${id}`,get:async function(){return snap(this);},set:async function(data,options){apply([{ref:this,data,merge:options?.merge}]);}});
  const collection=(name,filters=[])=>({add:async data=>{const r=ref(name);await r.set(data);return r;},doc:id=>ref(name,id),where:(field,op,value)=>{assert.equal(op,'==');return collection(name,[...filters,[field,value]]);},limit:()=>collection(name,filters),get:async()=>({docs:[...records].filter(([k,v])=>k.startsWith(name+'/')&&filters.every(([f,x])=>v[f]===x)).map(([k])=>snap(ref(name,k.slice(name.length+1))))})});
  const db={collection,runTransaction:async callback=>{
    const pending=[];const get=async r=>{assert.equal(pending.length,0,'transaction read after write');return snap(r);};
    const result=await callback({create:(ref,data)=>pending.push({ref,data,create:true}),get,getAll:(...refs)=>Promise.all(refs.map(get)),set:(ref,data,options)=>pending.push({ref,data,merge:options?.merge}),update:(ref,data)=>pending.push({ref,data,merge:true,update:true}),delete:ref=>pending.push({ref,remove:true})});
    await h.beforeCommit?.(pending);apply(pending);h.commits.push(pending);await h.afterCommit?.(pending);return result;
  }};
  const sheets={spreadsheets:{get:async input=>{assert.equal(input.spreadsheetId,sheetId);return {data:{sheets:[{properties:{sheetId:1,title:'2099.9',gridProperties:{rowCount:100,columnCount:55}}},{properties:{sheetId:2,title:'2099.10',hidden:!h.secondTab}}]}};},values:{get:async input=>{
    assert.equal(input.spreadsheetId,sheetId);assert.match(input.range,/^'2099\.(9|10)'!/);h.reads++;
    if(h.failRead || (h.secondTab && input.range.startsWith("'2099.10'")))throw new Error('synthetic sheet read failure');const captured=clone(h.rows);await h.afterSheetRead?.();return {data:{values:[Array(55).fill('header'),...captured]}};
  }}}};
  const boundaries={'./firebase':{db},'firebase-admin/firestore':{Timestamp,FieldValue:{delete:()=>deletion,serverTimestamp:()=>Timestamp.now()}},'firebase-functions/v2/https':{HttpsError,onCall:(...args)=>args.at(-1)},'firebase-functions/v2/scheduler':{onSchedule:(options,callback)=>callback},zod:dependency('zod'),'node:crypto':crypto,googleapis:{google:{auth:{GoogleAuth:class{constructor(options){assert.deepEqual(Array.from(options.scopes),['https://www.googleapis.com/auth/spreadsheets.readonly']);}}},sheets:()=>sheets}}};
  function load(name){
    if(Object.hasOwn(boundaries,name))return boundaries[name];
    assert.match(name,/^\.\/[a-z0-9-]+$/,`External import refused: ${name}`);
    if(modules.has(name))return modules.get(name);
    const source=fs.readFileSync(new URL(`../functions/src/${name.slice(2)}.ts`,import.meta.url),'utf8');
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports={};modules.set(name,exports);loaded.add(name);
    runInNewContext(code,{exports,require:load,...(clock?{Date:class extends Date{constructor(...args){super(...(args.length?args:[clock.now]));}static now(){return new Date(clock.now).getTime();}}}:{}),process:{env:{get APP_ENVIRONMENT(){return h.environment;}}},console:{warn:()=>{},error:()=>{}},setTimeout:callback=>{callback();return 0;}},{timeout:5000});return exports;
  }
  const importer=load('./shift-import'),jobs=load('./jobs'),precontact=load('./precontact');
  records.set(`sheetImportConfigs/${companyId}`,{companyId,enabled:true,spreadsheetId:sheetId,headerRow:1,dataStartRow:2,readRangeEndColumn:'BC',columns:{workDate:'A',staffName:'B',temperature:'G',arrivalTime:'H',clientName:'J',storeName:'K',makerName:'L',menuName:'M',workTime:'O',cancelled:'BC'}});
  records.set(`staffProfiles/${staffId}`,{companyId,active:true,displayName:'Synthetic Staff'});
  const admin={uid:'synthetic-admin',token:{companyId,role:'admin'}},staff={uid:'synthetic-user',token:{companyId,role:'staff',staffId}};
  return Object.assign(h,{edit:(jobId,fields,revision=records.get("jobs/"+jobId).revision??0)=>load("./job-management").adminEditJobInputs({auth:admin,data:{jobId,fields,revision}}),tasks:()=>load("./task-core").deriveStaffTasks({jobs:[...records].filter(([key])=>key.startsWith("jobs/")).map(([key,value])=>({id:key.split("/")[1],...value})),resubmissions:[],nowMs:Date.parse("2099-09-19T00:00:00Z")}),precontact:(jobId,values={temperature:36.5,arrivalTime:'09:30'},auth=staff)=>precontact.submitPreContact({auth,data:{jobId,...values}}),scheduled:()=>importer.syncShiftSheetsScheduled(),sync:()=>importer.syncShiftSheetsReadOnly({auth:admin,data:{}}),preview:()=>importer.previewShiftImport({auth:admin,data:{}}),apply:(jobId,requestId='request-0001',auth=staff)=>jobs.applyToJob({auth,data:{jobId,requestId}}),cancel:jobId=>jobs.adminCancelJob({auth:admin,data:{jobId,reason:'Synthetic cancellation'}}),list:name=>[...records].filter(([k])=>k.startsWith(name+'/')).map(([k,v])=>({id:k.slice(name.length+1),...v}))});
}
const results=[];
async function test(name,callback){try{await callback();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:error.message});}}
await test('B/F mapping, incomplete rows, cancellation priority, hidden tabs',async()=>{
  const h=harness([row('Open'),row('Assigned','Synthetic Staff'),row(''),row('','',true)]);h.rows[1][5]='';await h.sync();assert.equal(h.reads,1);assert.deepEqual(h.list('jobs').map(j=>j.status),['open','assigned','draft','cancelled']);assert.equal(h.list('staffDayLocks').length,1);
});
await test('import -> apply -> stale sync -> confirm -> cancel -> stale sync -> source cancel',async()=>{
  const h=harness([row('Main'),row('Other')]);await h.sync();const [job,other]=h.list('jobs');
  assert.equal((await h.apply(job.id)).ok,true);assert.equal(h.records.get(lockPath).jobId,job.id);assert.equal(h.list('sheetSyncQueue').length,1);assert.equal(h.list('notificationQueue').length,2);
  assert.equal(h.records.get(`jobs/${job.id}`).applicationUnconfirmed,true);
  const receipt=h.list('notificationQueue').find(item=>item.targetStaffId===staffId);
  assert.equal(receipt.title,'応募を受け付けました');assert.match(receipt.body,/担当の確認状況/);assert.doesNotMatch(receipt.title,/確定/);
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
await test('application confirmation restores precontact through the actual source importer',async()=>{
  const h=harness([row('Pending contact')]);await h.sync();const job=h.list('jobs')[0];await h.apply(job.id);
  const before=JSON.stringify([...h.records]);
  const waitingTask=h.tasks().find(task=>task.kind==='precontact');assert.equal(waitingTask.title,'シフト表の担当確認待ちです');assert.equal(waitingTask.dueAtMs,null);
  await assert.rejects(h.precontact(job.id),error=>error.code==='failed-precondition'&&error.details?.reason==='assignment_sheet_confirmation_pending');
  assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.list('sheetSyncQueue').filter(q=>q.operation==='precontact.submit').length,0);
  await assert.rejects(h.sync(),{code:'failed-precondition'});assert.equal(h.list('jobs')[0].applicationUnconfirmed,true);
  await assert.rejects(h.precontact(job.id),error=>error.details?.reason==='assignment_sheet_confirmation_pending');
  h.rows[0][1]='Synthetic Staff';await h.sync();assert.equal(h.list('jobs')[0].applicationUnconfirmed,false);
  assert.equal(h.tasks().find(task=>task.kind==='precontact').title,'事前連絡を送ってください');
  assert.equal((await h.precontact(job.id)).ok,true);assert.equal(h.list('jobs')[0].preContact.staffId,staffId);
  assert.equal(h.list('sheetSyncQueue').filter(q=>q.operation==='precontact.submit').length,1);
  await h.precontact(job.id);assert.equal(h.list('sheetSyncQueue').filter(q=>q.operation==='precontact.submit').length,1);
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
for(const [label,now,allowed] of [
 ['today-before-midnight','2099-09-20T14:59:59Z',true],
 ['expired-at-midnight','2099-09-20T15:00:00Z',false],
 ['future','2099-09-19T14:59:59Z',true],
])await test('application date: '+label,async()=>{
 const h=harness([row('Date boundary')],{now});await h.sync();const job=h.list('jobs')[0];
 const before=JSON.stringify([...h.records]);
 if(allowed){assert.equal((await h.apply(job.id)).ok,true);}
 else{await assert.rejects(h.apply(job.id),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before,'Expired application must write no jobs, locks, notifications or sync queue');}
});
await test('accepted application retry after midnight returns prior result without side effects',async()=>{
 const clock={now:'2099-09-20T14:59:59Z'},h=harness([row('Retry boundary')],clock);await h.sync();const job=h.list('jobs')[0];
 const accepted=await h.apply(job.id);const before=JSON.stringify([...h.records]);clock.now='2099-09-20T15:00:00Z';
 assert.equal(JSON.stringify(await h.apply(job.id)),JSON.stringify(accepted));assert.equal(JSON.stringify([...h.records]),before);
});
for(const mode of ['other-job','other-company','other-staff','wrong-uid','missing-result','wrong-result-job','failed-result','missing-time','legacy-owner'])await test('application retry integrity: '+mode,async()=>{
 const h=harness([row('Original'),row('Other')]);await h.sync();const [job,other]=h.list('jobs');await h.apply(job.id);
 const record=h.list('idempotencyKeys')[0],stored=h.records.get('idempotencyKeys/'+record.id);
 const auth={uid:'synthetic-user',token:{companyId,role:'staff',staffId}};
 let target=job.id;
 if(mode==='other-job')target=other.id;
 if(mode==='other-company')auth.token.companyId='different-company';
 if(mode==='other-staff')auth.token.staffId='different-staff';
 if(mode==='wrong-uid')stored.uid='different-user';
 if(mode==='missing-result')delete stored.result;
 if(mode==='wrong-result-job')stored.result.jobId='different-job';
 if(mode==='failed-result')stored.result.ok=false;
 if(mode==='missing-time')delete stored.result.assignedAt;
 if(mode==='legacy-owner')delete stored.staffId;
 const before=JSON.stringify([...h.records]);
 await assert.rejects(h.apply(target,'request-0001',auth),error=>['failed-precondition','permission-denied'].includes(error.code));
 assert.equal(JSON.stringify([...h.records]),before,'Rejected retry must not mutate any record');
});
for(const order of ['duplicate-last','duplicate-first','third-duplicate'])await test('ambiguous staff name blocks assignment: '+order,async()=>{
 const h=harness([row('Ambiguous','Synthetic Staff')]);
 const original=h.records.get(`staffProfiles/${staffId}`);
 if(order==='duplicate-first')h.records.delete(`staffProfiles/${staffId}`);
 h.records.set('staffProfiles/another-staff',{companyId,active:true,displayName:'Ｓｙｎｔｈｅｔｉｃ　Ｓｔａｆｆ'});
 if(order==='duplicate-first')h.records.set(`staffProfiles/${staffId}`,original);
 if(order==='third-duplicate')h.records.set('staffProfiles/third-staff',{companyId,active:true,displayName:'SyntheticStaff'});
 await assert.rejects(h.sync(),{code:'failed-precondition'});
 assert.equal(h.list('jobs').length,0);assert.equal(h.list('staffDayLocks').length,0);assert.equal(h.list('sheetImportRuns')[0].status,'error');
});
await test('new name ambiguity preserves existing assignment and lock',async()=>{
 const h=harness([row('Assigned','Synthetic Staff')]);await h.sync();
 const before=JSON.stringify([h.list('jobs'),h.list('staffDayLocks')]);
 h.records.set('staffProfiles/another-staff',{companyId,active:true,displayName:'Synthetic Staff'});
 await assert.rejects(h.sync(),{code:'failed-precondition'});
 assert.equal(JSON.stringify([h.list('jobs'),h.list('staffDayLocks')]),before);
 h.records.get('staffProfiles/another-staff').displayName='Distinct Staff';
 await h.sync();assert.equal(h.list('jobs')[0].assignedStaffId,staffId);
});
await test('unused duplicate name does not block unrelated open jobs',async()=>{
 const h=harness([row('Open')]);h.records.set('staffProfiles/another-staff',{companyId,active:true,displayName:'Synthetic Staff'});
 await h.sync();assert.equal(h.list('jobs')[0].status,'open');
});
await test('inactive unique profile is unresolved rather than assigned',async()=>{
 const h=harness([row('Inactive','Synthetic Staff')]);h.records.get(`staffProfiles/${staffId}`).active=false;
 await h.sync();assert.equal(h.list('jobs')[0].assignedStaffId,undefined);assert.equal(h.list('jobs')[0].assignmentUnresolved,true);assert.equal(h.list('staffDayLocks').length,0);
});
await test('foreign names do not make same-company identity ambiguous',async()=>{
 const h=harness([row('Tenant','Synthetic Staff')]);h.records.set('staffProfiles/foreign-staff',{companyId:'foreign',active:true,displayName:'Synthetic Staff'});
 await h.sync();assert.equal(h.list('jobs')[0].assignedStaffId,staffId);
});
await test('precontact survives stale blank sheet and source confirmation',async()=>{
 const h=harness([row('Precontact','Synthetic Staff')]);await h.sync();const job=h.list('jobs')[0];
 await h.precontact(job.id);const saved=h.records.get(`jobs/${job.id}`).preContact;
 await h.sync();let current=h.records.get(`jobs/${job.id}`);assert.equal(current.preContact.temperature,36.5);assert.equal(current.preContact.submittedAt.toMillis(),saved.submittedAt.toMillis());assert.equal(current.preContactSyncPending,true);
 h.rows[0][6]='36.5';h.rows[0][7]='9:30';await h.sync();current=h.records.get(`jobs/${job.id}`);assert.equal(current.preContactSyncPending,false);assert.equal(current.preContact.submittedAt.toMillis(),saved.submittedAt.toMillis());
 h.rows[0][6]='37.0';await h.sync();current=h.records.get(`jobs/${job.id}`);assert.equal(current.preContact.temperature,36.5);assert.equal(current.preContactSyncPending,true);
});
await test('precontact from previous staff is quarantined across repeated imports',async()=>{
 const h=harness([row('Change person','Synthetic Staff')]);h.rows[0][6]='36.5';h.rows[0][7]='09:30';await h.sync();const job=h.list('jobs')[0];
 await h.precontact(job.id);h.records.set('staffProfiles/new-staff',{companyId,active:true,displayName:'New Staff'});h.rows[0][1]='New Staff';
 for(let i=0;i<2;i++){await h.sync();const current=h.records.get(`jobs/${job.id}`);assert.equal(current.preContact,null);assert.equal(current.preContactNeedsReview,true);}
 await assert.rejects(h.precontact(job.id),{code:'permission-denied'});
 const auth={uid:'new-user',token:{companyId,role:'staff',staffId:'new-staff'}};
 await h.precontact(job.id,{temperature:36.5,arrivalTime:'09:30'},auth);let current=h.records.get(`jobs/${job.id}`);assert.equal(current.preContact.staffId,'new-staff');assert.equal(current.preContactNeedsReview,false);
 await h.sync();current=h.records.get(`jobs/${job.id}`);assert.equal(current.preContact.staffId,'new-staff');assert.equal(current.preContact.temperature,36.5);
});
await test('persisted case date change requires fresh precontact',async()=>{
 const h=harness([row('Date change','Synthetic Staff')]);h.records.get(`sheetImportConfigs/${companyId}`).columns.caseId='BB';h.rows[0][53]='fixed-case-001';
 await h.sync();const job=h.list('jobs')[0];await h.precontact(job.id);h.rows[0][0]='2099-09-21';
 await h.sync();assert.equal(h.list('jobs').length,1);assert.equal(h.list('jobs')[0].preContact,null);assert.equal(h.list('jobs')[0].preContactNeedsReview,true);
 await h.precontact(job.id);assert.equal(h.list('jobs')[0].preContact.dateKey,'2099-09-21');
});
await test('sheet precontact is validated and normalized for the staff form',async()=>{
 const h=harness([row('Valid source','Synthetic Staff')]);h.rows[0][6]='36.5';h.rows[0][7]='9:30';await h.sync();const value=h.list('jobs')[0].preContact;
 assert.equal(value.temperature,36.5);assert.equal(value.arrivalTime,'09:30');assert.equal(value.source,'sheet');
});
for(const [temperature,arrivalTime]of [['bad','09:30'],['33','09:30'],['36.5','24:00'],['','09:30']])await test('invalid sheet precontact is not completed: '+temperature+'/'+arrivalTime,async()=>{
 const h=harness([row('Invalid source','Synthetic Staff')]);h.rows[0][6]=temperature;h.rows[0][7]=arrivalTime;await h.sync();assert.equal(h.list('jobs')[0].preContact,null);assert.equal(h.list('jobs')[0].preContactNeedsReview,true);
});
await test('same values from sheet still require a real app submission record',async()=>{
 const h=harness([row('Confirm values','Synthetic Staff')]);h.rows[0][6]='36.5';h.rows[0][7]='09:30';await h.sync();const job=h.list('jobs')[0];
 await h.precontact(job.id);assert.equal(h.list('sheetSyncQueue').length,1);assert.equal(h.list('jobs')[0].preContact.staffId,staffId);
 await h.precontact(job.id);assert.equal(h.list('sheetSyncQueue').length,1);
});
await test('stale form date is rejected without job or queue writes',async()=>{
 const h=harness([row('Stale form','Synthetic Staff')]);await h.sync();const job=h.list('jobs')[0];const before=JSON.stringify([...h.records]);
 await assert.rejects(h.precontact(job.id,{temperature:36.5,arrivalTime:'09:30',dateKey:'2099-09-19'}),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);
});
for(const date of [undefined,'2099-02-30'])await test('invalid stored date prevents precontact: '+date,async()=>{
 const h=harness([row('Bad date','Synthetic Staff')]);await h.sync();const job=h.list('jobs')[0];if(date===undefined)delete h.records.get(`jobs/${job.id}`).dateKey;else h.records.get(`jobs/${job.id}`).dateKey=date;const before=JSON.stringify([...h.records]);
 await assert.rejects(h.precontact(job.id),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);
});
await test('precontact queues carry distinct operation IDs and saved date',async()=>{
 const h=harness([row('Revision','Synthetic Staff')]);await h.sync();const job=h.list('jobs')[0];await h.precontact(job.id);await h.precontact(job.id,{temperature:36.6,arrivalTime:'09:35',dateKey});
 const queues=h.list('sheetSyncQueue');assert.equal(queues.length,2);assert.notEqual(queues[0].idempotencyKey,queues[1].idempotencyKey);assert.equal(queues[1].dateKey,dateKey);assert.equal(h.list('jobs')[0].preContact.operationId,queues[1].id);
});
await test('legacy saved app data retains timestamp for the same stored assignment',async()=>{
 const h=harness([row('Legacy','Synthetic Staff')]);await h.sync();const job=h.list('jobs')[0];await h.precontact(job.id);
 const saved=h.records.get(`jobs/${job.id}`).preContact;delete saved.source;delete saved.staffId;delete saved.dateKey;await h.sync();assert.equal(h.list('jobs')[0].preContact.temperature,36.5);assert.equal(h.list('jobs')[0].preContactSyncPending,true);
});
await test('inconsistent app owner metadata requires reconfirmation',async()=>{
 const h=harness([row('Wrong proof','Synthetic Staff')]);await h.sync();const job=h.list('jobs')[0];await h.precontact(job.id);h.records.get(`jobs/${job.id}`).preContact.staffId='wrong-person';await h.sync();assert.equal(h.list('jobs')[0].preContact,null);assert.equal(h.list('jobs')[0].preContactNeedsReview,true);
});
await test('active and inactive same-name profiles still require identity review',async()=>{
 const h=harness([row('Old same name','Synthetic Staff')]);h.records.set('staffProfiles/former',{companyId,active:false,displayName:'Synthetic Staff'});await assert.rejects(h.sync(),{code:'failed-precondition'});assert.equal(h.list('jobs').length,0);
});
function setPrintedFixture(h,id){const job=h.records.get(`jobs/${id}`);job.netPrint={items:[{id:"old-item",number:"12345678",position:1,version:1,printed:true,printedAt:Timestamp.fromMillis(1234),printOperationId:"old-print",printedByStaffId:staffId,printedForDate:dateKey,printedContext:"old-context"}],syncPending:true,writeOperationId:"old-update",writeIdentity:"old-owner",writeExpected:{netPrint1:{mode:"exact",value:""}}};h.records.set("sheetSyncQueue/old-print",{companyId,jobId:id,actorStaffId:staffId,dateKey,status:"pending"});}
await test('reimport with same owner retains printed state',async()=>{const h=harness([row('Printed same','Synthetic Staff')]);await h.sync();const job=h.list('jobs')[0];setPrintedFixture(h,job.id);await h.sync();assert.equal(h.list('jobs')[0].netPrint.items[0].printed,true);assert.equal(h.tasks().some(task=>task.kind==='netprint'),false);});
await test('source reassignment clears old print and restores preparation task',async()=>{const h=harness([row('Printed changed','Synthetic Staff')]);await h.sync();const job=h.list('jobs')[0];setPrintedFixture(h,job.id);h.records.set('staffProfiles/other-staff',{companyId,active:true,displayName:'Other Staff'});h.rows[0][1]='Other Staff';await h.sync();const current=h.list('jobs').find(value=>value.id===job.id);assert.equal(current.assignedStaffId,'other-staff');assert.equal(current.netPrint.items[0].printed,false);assert.equal(current.netPrint.items[0].printedAt,undefined);assert.equal(current.netPrint.items[0].printOperationId,undefined);assert.equal(current.netPrint.items[0].number,'12345678');assert.equal(current.netPrint.syncPending,true);assert.equal(current.netPrint.writeOperationId,'old-update');assert.equal(h.tasks().find(task=>task.kind==='netprint').jobId,job.id);assert.equal(h.records.get('sheetSyncQueue/old-print').actorStaffId,staffId);});
await test('corrected stored work date clears old printed flag',async()=>{const h=harness([row('Printed date','Synthetic Staff')]);await h.sync();const job=h.list('jobs')[0];setPrintedFixture(h,job.id);h.records.get(`jobs/${job.id}`).dateKey='2099-09-21';await h.sync();assert.equal(h.list('jobs')[0].netPrint.items[0].printed,false);});
await test('removed source assignment clears printed state',async()=>{const h=harness([row('Printed released','Synthetic Staff')]);await h.sync();const job=h.list('jobs')[0];setPrintedFixture(h,job.id);h.rows[0][1]='';await h.sync();assert.equal(h.list('jobs')[0].status,'open');assert.equal(h.list('jobs')[0].netPrint.items[0].printed,false);});
await test('new application does not inherit an old printed flag',async()=>{const h=harness([row('Printed application')]);await h.sync();const job=h.list('jobs')[0];setPrintedFixture(h,job.id);await h.apply(job.id);assert.equal(h.list('jobs')[0].netPrint.items[0].printed,false);assert.equal(h.tasks().filter(task=>task.kind==='netprint').length,0);h.rows[0][1]='Synthetic Staff';await h.sync();assert.equal(h.list('jobs')[0].applicationUnconfirmed,false);assert.equal(h.tasks().filter(task=>task.kind==='netprint').length,1);});
await test('source row movement preserves same-owner printed state',async()=>{const h=harness([row('Printed row','Synthetic Staff')]);await h.sync();const job=h.list('jobs')[0];setPrintedFixture(h,job.id);h.rows.unshift(row('Another'));await h.sync();const current=h.list('jobs').find(value=>value.id===job.id);assert.equal(current.sheetRef.currentRow,3);assert.equal(current.netPrint.items[0].printed,true);assert.equal(current.netPrint.items[0].printOperationId,'old-print');});
await test('new application clears old contact immediately and requires fresh input',async()=>{
 const h=harness([row('Old contact in open job')]);await h.sync();const job=h.list('jobs')[0];
 h.records.get(`jobs/${job.id}`).preContact={temperature:36.7,arrivalTime:'08:00',submittedAt:Timestamp.fromMillis(1234)};
 h.records.get(`jobs/${job.id}`).preContactSyncPending=true;
 await h.apply(job.id);let current=h.list('jobs')[0];assert.equal(current.preContact,null);assert.equal(current.preContactNeedsReview,true);assert.equal(current.preContactSyncPending,false);assert.ok(h.tasks().some(task=>task.kind==='precontact'));
 h.rows[0][1]='Synthetic Staff';h.rows[0][6]='36.7';h.rows[0][7]='08:00';await h.sync();current=h.list('jobs')[0];assert.equal(current.preContact,null);assert.equal(current.preContactNeedsReview,true);
 await h.precontact(job.id,{temperature:36.5,arrivalTime:'09:00',dateKey});current=h.list('jobs')[0];assert.equal(current.preContact.temperature,36.5);assert.equal(current.preContactNeedsReview,false);assert.equal(h.tasks().some(task=>task.kind==='precontact'),false);
});
await test('new assignment with empty local contact does not accept old source values later',async()=>{
 const h=harness([row('Fresh app assignment')]);await h.sync();const job=h.list('jobs')[0];await h.apply(job.id);assert.equal(h.list('jobs')[0].preContactNeedsReview,true);
 h.rows[0][1]='Synthetic Staff';h.rows[0][6]='37.5';h.rows[0][7]='07:00';await h.sync();assert.equal(h.list('jobs')[0].preContact,null);assert.equal(h.list('jobs')[0].preContactNeedsReview,true);
});
await test('source confirmation and row movement retain the current application intent',async()=>{const h=harness([row('Application intent')]);await h.sync();const job=h.list('jobs')[0];await h.apply(job.id);const proof=JSON.stringify(h.records.get(`jobs/${job.id}`).assignmentSheetWrite);h.rows[0][1]='Synthetic Staff';await h.sync();assert.equal(JSON.stringify(h.records.get(`jobs/${job.id}`).assignmentSheetWrite),proof);h.rows.unshift(row('Different'));await h.sync();assert.equal(JSON.stringify(h.records.get(`jobs/${job.id}`).assignmentSheetWrite),proof);});
await test('source cancellation then restoration invalidates the old application intent',async()=>{const h=harness([row('Application cancel intent')]);await h.sync();const job=h.list('jobs')[0];await h.apply(job.id);h.rows[0][1]='Synthetic Staff';h.rows[0][54]=true;await h.sync();assert.equal(h.records.get(`jobs/${job.id}`).assignmentSheetWrite,null);h.rows[0][54]=false;await h.sync();assert.equal(h.records.get(`jobs/${job.id}`).status,'assigned');assert.equal(h.records.get(`jobs/${job.id}`).assignmentSheetWrite,null);});
await test('source reassignment away and back cannot revive the previous app write',async()=>{const h=harness([row('Application owner intent')]);await h.sync();const job=h.list('jobs')[0];await h.apply(job.id);h.rows[0][1]='Synthetic Staff';await h.sync();h.records.set('staffProfiles/other-staff',{companyId,active:true,displayName:'Other Staff'});h.rows[0][1]='Other Staff';await h.sync();assert.equal(h.records.get(`jobs/${job.id}`).assignmentSheetWrite,null);h.rows[0][1]='Synthetic Staff';await h.sync();assert.equal(h.records.get(`jobs/${job.id}`).assignedStaffId,staffId);assert.equal(h.records.get(`jobs/${job.id}`).assignmentSheetWrite,null);});
await test('source edit snapshot keeps original menu conditions and omits contact columns',async()=>{const h=harness([row('Source snapshot')]);h.rows[0][2]='PRIVATE_EMAIL';h.rows[0][6]='36.5';h.rows[0][7]='09:00';h.rows[0][12]='Synthetic menu（要冷蔵）';await h.sync();const saved=h.list('adminJobEditSources')[0];assert.equal(saved.values.menuName,'Synthetic menu（要冷蔵）');assert.equal(saved.columns.menuName,'M');assert.ok(!JSON.stringify(saved).includes('PRIVATE_EMAIL'));assert.equal(Object.hasOwn(saved.values,'temperature'),false);assert.equal(h.list('jobs')[0].editSourceSnapshot,undefined);});
await test('canonical money columns are captured only within the actual read range',async()=>{const h=harness([row('Source money')]);h.records.set(`companies/${companyId}/sheetMappings/shift`,{spreadsheetId:sheetId,columns:{invoiceBase:'S',staffBasePay:'AB',staffOther:'ZZ',email:'C'}});h.rows[0][18]='￥12,345';h.rows[0][27]=0;await h.sync();const saved=h.list('adminJobEditSources')[0];assert.equal(saved.values.invoiceBase,'￥12,345');assert.equal(saved.values.staffBasePay,'0');assert.equal(Object.hasOwn(saved.values,'staffOther'),false);assert.equal(Object.hasOwn(saved.values,'email'),false);});
await test('different source book cannot supply financial column mapping',async()=>{const h=harness([row('Foreign source mapping')]);h.records.set(`companies/${companyId}/sheetMappings/shift`,{spreadsheetId:'other-book',columns:{invoiceBase:'S'}});await h.sync();assert.equal(Object.hasOwn(h.list('adminJobEditSources')[0].values,'invoiceBase'),false);});
await test('failed import commit saves neither job nor edit snapshot',async()=>{const h=harness([row('Snapshot transaction')]);h.beforeCommit=pending=>{if(pending.some(write=>write.ref.path.startsWith('jobs/')))throw Error('synthetic failed source transaction');};await assert.rejects(h.sync());assert.equal(h.list('jobs').length,0);assert.equal(h.list('adminJobEditSources').length,0);});
async function adminImportHarness(clock) {
  const h=harness([row('Edit source','Synthetic Staff')],clock);
  h.records.get("sheetImportConfigs/"+companyId).columns.caseId='R';
  h.rows[0][17]='CASE-STABLE-001';h.rows[0][18]='￥1,000';h.rows[0][27]='800';h.rows[0][12]='Synthetic menu（要冷蔵）';
  h.records.set("companies/"+companyId+"/sheetMappings/shift",{enabled:true,spreadsheetId:sheetId,columns:{workDate:'A',staffName:'B',caseId:'R',clientName:'J',storeName:'K',makerName:'L',menuName:'M',workTime:'O',invoiceBase:'S',staffBasePay:'AB'},operations:{"job.admin_edit":{values:['clientName','storeName','menuName','workTime','staffName','invoiceBase','staffBasePay']}}});
  await h.sync();h.id=h.list('jobs')[0].id;h.current=()=>h.records.get("jobs/"+h.id);return h;
}
await test('actual import -> admin edit -> stale import preserves pending fields and queue',async()=>{
 const h=await adminImportHarness();assert.equal(h.current().clientChargeInputs.invoiceBase,1000);assert.equal(h.current().staffPaymentInputs.staffBasePay,800);
 await h.edit(h.id,{storeName:'Changed store',menuName:'Synthetic menu'});await h.edit(h.id,{workTime:'11:00-19:00'});
 const saved=JSON.stringify(h.current()),queue=JSON.stringify(h.list('sheetSyncQueue')),source=JSON.stringify(h.list('adminJobEditSources'));
 await assert.rejects(h.sync(),{code:'failed-precondition'});assert.equal(JSON.stringify(h.current()),saved);assert.equal(JSON.stringify(h.list('sheetSyncQueue')),queue);assert.equal(JSON.stringify(h.list('adminJobEditSources')),source);
 h.rows[0][10]='Changed store';h.rows[0][14]='11:00-19:00';await h.sync();
 assert.equal(h.current().adminEditSheetWrite.pending,false);assert.equal(h.current().pendingSourceWrite,false);assert.equal(h.current().menuName,'Synthetic menu');assert.ok(h.current().menuConditions.length>0);
 await h.edit(h.id,{storeName:'Second store'});assert.equal(h.current().adminEditSheetWrite.expected.storeName.value,'Changed store');
});
await test('actual imported menu transformation updates confirmed projection without losing conditions',async()=>{
 const h=await adminImportHarness();await h.edit(h.id,{menuName:'New menu（要冷蔵）'});h.rows[0][12]='New menu（要冷蔵）';await h.sync();assert.equal(h.current().menuName,'New menu');assert.equal(h.current().adminEditSheetWrite.pending,false);await h.edit(h.id,{workTime:'11:00-19:00'});assert.equal(h.current().adminEditSheetWrite.updates.workTime,'11:00-19:00');
});
await test('source divergence after confirmed admin edit invalidates its intent',async()=>{
 const clock={now:'2099-09-19T00:00:00.000Z'},h=await adminImportHarness(clock);await h.edit(h.id,{storeName:'Changed store'});h.rows[0][10]='Changed store';clock.now='2099-09-19T00:00:01.000Z';await h.sync();h.rows[0][10]='External store';clock.now='2099-09-19T00:00:02.000Z';await h.sync();assert.equal(h.current().storeName,'External store');assert.equal(h.current().adminEditSheetWrite,null);
});
await test('source only partial confirmation retains every pending admin field',async()=>{
 const h=await adminImportHarness();await h.edit(h.id,{storeName:'Changed store',workTime:'11:00-19:00'});h.rows[0][10]='Changed store';await assert.rejects(h.sync(),{code:'failed-precondition'});assert.equal(h.current().workTime,'11:00-19:00');assert.equal(h.current().adminEditSheetWrite.pending,true);
});
await test('admin reassignment cannot be reverted by stale imported staff',async()=>{
 const h=await adminImportHarness();h.records.set('staffProfiles/new-staff',{companyId,active:true,displayName:'New Staff'});await h.edit(h.id,{assignedStaffId:'new-staff'});await assert.rejects(h.sync(),{code:'failed-precondition'});assert.equal(h.current().assignedStaffId,'new-staff');h.rows[0][1]='New Staff';await h.sync();assert.equal(h.current().assignedStaffId,'new-staff');assert.equal(h.current().adminEditSheetWrite.pending,false);
});
await test('snapshot read before write confirmation cannot roll back a completed edit',async()=>{
 const h=await adminImportHarness();await h.edit(h.id,{storeName:'Changed store'});h.afterSheetRead=()=>{h.current().adminEditSheetWrite.pending=false;h.current().adminEditSheetWrite.confirmedAtMs=Date.now();h.current().pendingSourceWrite=false;};
 await assert.rejects(h.sync(),{code:'failed-precondition'});assert.equal(h.current().storeName,'Changed store');h.afterSheetRead=null;h.rows[0][10]='Changed store';await h.sync();assert.equal(h.current().storeName,'Changed store');
});
await test('external import advances edit revision while unchanged import preserves it',async()=>{
 const h=await adminImportHarness();const original=h.current().revision;await h.sync();assert.equal(h.current().revision,original);h.rows[0][10]='External update';await h.sync();assert.equal(h.current().revision,original+1);await assert.rejects(h.edit(h.id,{storeName:'Old screen save'},original),{code:'aborted'});assert.equal(h.current().storeName,'External update');
const latest=h.current().revision;await h.sync();assert.equal(h.current().revision,latest);
});

for(const entry of ['preview','commit','scheduled'])for(const control of [undefined,{productionEnabled:false},{productionEnabled:true,emergencyLock:true}]){
 await test('production pause '+entry+' '+JSON.stringify(control),async()=>{
  const h=harness([row('Paused')]);h.environment='production';h.records.get('sheetImportConfigs/'+companyId).scheduleEnabled=true;
  if(control)h.records.set('productionControls/'+companyId,control);
  const before=JSON.stringify([...h.records]);
  if(entry==='preview')await h.preview();else if(entry==='commit')await assert.rejects(h.sync(),{code:'failed-precondition'});else await h.scheduled();
  assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.commits.length,0);if(entry!=='preview')assert.equal(h.reads,0);
 });
}
await test('production enabled permits guarded import',async()=>{
 const h=harness([row('Enabled')]);h.environment='production';h.records.set('productionControls/'+companyId,{productionEnabled:true,emergencyLock:false});await h.sync();assert.equal(h.list('jobs').length,1);
});

function seedAdminConfirmation(h,id){Object.assign(h.records.get('jobs/'+id),{applicationAdminConfirmed:true,applicationAdminConfirmedBy:'original-admin',applicationAdminConfirmedAt:Timestamp.fromMillis(1),applicationAdminConfirmedRevision:0});h.records.set('auditLogs/original-confirmation',{action:'application.confirm',jobId:id});}
for(const [name,change]of [['staff',h=>{h.records.set('staffProfiles/other-staff',{companyId,active:true,displayName:'Other Staff'});h.rows[0][1]='Other Staff';}],['date',h=>h.rows[0][0]='2099-09-21'],['time',h=>h.rows[0][14]='11:00-19:00'],['store',h=>h.rows[0][10]='Other store'],['client',h=>h.rows[0][9]='Other client'],['menu',h=>h.rows[0][12]='Other menu'],['cancel',h=>h.rows[0][54]=true],['release',h=>h.rows[0][1]='']])await test('source '+name+' invalidates admin confirmation and retains audit',async()=>{const h=harness([row('Review','Synthetic Staff')]);h.records.get('sheetImportConfigs/'+companyId).columns.caseId='BB';h.rows[0][53]='fixed-review-case';await h.sync();const id=h.list('jobs')[0].id;seedAdminConfirmation(h,id);change(h);await h.sync();const current=h.records.get('jobs/'+id);assert.equal(current.applicationAdminConfirmed,false);assert.equal(current.applicationAdminConfirmedBy,null);assert.equal(current.applicationAdminConfirmedAt,null);assert.equal(current.applicationAdminConfirmedRevision,null);assert.equal(h.records.get('auditLogs/original-confirmation').jobId,id);});
await test('unchanged source and row movement preserve admin confirmation',async()=>{const h=harness([row('Review unchanged','Synthetic Staff')]);await h.sync();const id=h.list('jobs')[0].id;seedAdminConfirmation(h,id);await h.sync();h.rows.unshift(row('Another'));await h.sync();const current=h.records.get('jobs/'+id);assert.equal(current.applicationAdminConfirmed,true);assert.equal(current.applicationAdminConfirmedBy,'original-admin');});
await test('source acceptance preserves independent admin receipt review',async()=>{const h=harness([row('Pending review')]);await h.sync();const id=h.list('jobs')[0].id;await h.apply(id);seedAdminConfirmation(h,id);h.rows[0][1]='Synthetic Staff';await h.sync();const current=h.records.get('jobs/'+id);assert.equal(current.applicationAdminConfirmed,true);assert.equal(current.applicationUnconfirmed,false);});

await test('application advances revision once and duplicate receipt preserves it',async()=>{const h=harness([row('Revision')]);await h.sync();const id=h.list('jobs')[0].id;assert.equal(h.records.get('jobs/'+id).revision,0);await h.apply(id);assert.equal(h.records.get('jobs/'+id).revision,1);await h.apply(id);assert.equal(h.records.get('jobs/'+id).revision,1);});
console.log(JSON.stringify({passed:results.filter(r=>r.ok).length,results,boundary:'Full TypeScript modules; in-memory DB and Google API; network-capable application imports refused. No emulator, token validation, SDK concurrency or actual delivery.'},null,2));
if(results.some(r=>!r.ok))process.exitCode=1;
