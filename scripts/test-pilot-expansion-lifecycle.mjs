import assert from "node:assert/strict";
import fs from "node:fs";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";
const require=createRequire(import.meta.url),ts=require("typescript");
const {Timestamp,FieldValue}=require("firebase-admin/firestore"),{HttpsError}=require("firebase-functions/v2/https");
const companyId="synthetic-company",submitter={uid:"synthetic-submitter",token:{companyId,role:"admin"}},approver={...submitter,uid:"synthetic-approver"};
const rolloutPath="pilotRollouts/rollout",reviewPath="pilotExpansionReviews/rollout";
const input={rolloutId:"rollout",totalCases:20,completedCases:20,moneyDiffYen:0,doubleBookings:0,mailTargetDiff:0,pdfDiff:0,manualQueue:0,supportCases:0,evidenceRefs:["synthetic/evidence"],notes:"synthetic verified"};
const decision={rolloutId:"rollout",decision:"approve",note:"synthetic approval"};
const compiled=new Map();
const copy=x=>x instanceof Timestamp||x instanceof FieldValue?x:Array.isArray(x)?x.map(copy):x&&typeof x==="object"?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,copy(v)])):x;
function harness(){
 const records=new Map(),versions=new Map(),reads=[],modules=new Map(),logs=[];let seq=1,auto=0,beforeTransaction=null,failQueue=false,retry=false,loseResponse=false;
 const set=(path,value)=>{records.set(path,copy(value));versions.set(path,Timestamp.fromMillis(++seq));};
 const snap=path=>{const exists=records.has(path),value=copy(records.get(path)),updateTime=versions.get(path);return {id:path.split('/').at(-1),exists,updateTime,data:()=>copy(value)};};
 const doc=path=>({path,id:path.split('/').at(-1),get:async()=>{reads.push(path);return snap(path);}});
 const query=(path,filters=[],count=Infinity)=>({queryPath:path,doc:(id='auto-'+(++auto))=>doc(path+'/'+id),where:(...args)=>query(path,[...filters,args],count),limit:n=>query(path,filters,n),get:async()=>{reads.push({path,filters});const docs=[...records].filter(([key,value])=>key.startsWith(path+'/')&&key.split('/').length===path.split('/').length+1&&filters.every(([field,op,expected])=>{assert.equal(op,'==');return value[field]===expected;})).slice(0,count).map(([key])=>snap(key));return{docs,size:docs.length,empty:docs.length===0};}});
 const db={collection:path=>query(path),runTransaction:async callback=>{
  if(beforeTransaction){const change=beforeTransaction;beforeTransaction=null;change();}
  async function attempt(commit){const writes=[];let wrote=false;const tx={get:async ref=>{assert.equal(wrote,false,'Firestore transaction must read before writing');if(ref.queryPath)return ref.get();reads.push(ref.path);return snap(ref.path);},set:(ref,data,options)=>{wrote=true;if(failQueue&&ref.path.startsWith('notificationQueue/'))throw Error('synthetic queue failure');writes.push({path:ref.path,data:copy(data),merge:options?.merge===true});},create:(ref,data)=>{wrote=true;if(records.has(ref.path))throw Error('synthetic already exists');if(failQueue&&ref.path.startsWith('notificationQueue/'))throw Error('synthetic queue failure');writes.push({path:ref.path,data:copy(data)});}};const result=await callback(tx);if(commit)for(const w of writes)set(w.path,w.merge?{...records.get(w.path),...w.data}:w.data);return result;}
  if(retry){retry=false;await attempt(false);}const result=await attempt(true);if(loseResponse){loseResponse=false;throw Error('synthetic committed response lost');}return result;
 }};
 const boundaries={"./firebase":{db},"firebase-functions/v2/https":{HttpsError,onCall:(...args)=>args.at(-1)}};
 function load(name){if(Object.hasOwn(boundaries,name))return boundaries[name];if(!name.startsWith('./'))return require(name);if(modules.has(name))return modules.get(name);if(!compiled.has(name))compiled.set(name,ts.transpileModule(fs.readFileSync(new URL('../functions/src/'+name.slice(2)+'.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);const exports={};modules.set(name,exports);runInNewContext(compiled.get(name),{exports,require:load,console:{error:(...args)=>logs.push(args)},Date,Buffer},{timeout:5000});return exports;}
 const api=load('./pilot-expansion');
 set(rolloutPath,{companyId,status:'review_required',releaseId:'synthetic-release',startedAt:Timestamp.fromMillis(1000),completedAt:Timestamp.fromMillis(1000+7*86400000),durationDays:7,participantCount:5,inviteSummary:{failedStaff:0},lastHealth:{action:'continue'}});
 for(let i=0;i<1900;i++)set('pilotHealthRuns/own-'+i,{companyId,rolloutId:'rollout'});
 return {records,reads,logs,set,change:path=>({...(records.get(path)??{})}),remove:path=>{records.delete(path);versions.delete(path);},rows:prefix=>[...records].filter(([p])=>p.startsWith(prefix+'/')).map(([id,data])=>({id,data})),race:fn=>{beforeTransaction=fn;},failQueue:()=>{failQueue=true;},retry:()=>{retry=true;},loseResponse:()=>{loseResponse=true;},submit:(data=input,auth=submitter)=>api.submitPilotOutcome({data,auth}),decide:(data=decision,auth=approver)=>api.decidePilotExpansion({data,auth}),evaluate:load('./pilot-expansion-core').evaluatePilotExpansion};
}
const results=[];async function test(name,run){try{await run();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.stack});}}
const snapshot=h=>JSON.stringify([...h.records]);
await test('正常な提出は審査・配布状態・監査・通知を保存',async()=>{const h=harness();const r=await h.submit();assert.equal(r.reviewStatus,'pending_approval');assert.equal(h.records.get(rolloutPath).status,'expansion_review_pending');assert.equal(h.rows('auditLogs').length,1);assert.equal(h.rows('notificationQueue').length,1);const q=h.rows('notificationQueue')[0].data;assert.equal(q.companyId,companyId);assert.equal(q.targetRole,'admin');assert.equal(q.category,'pilot_expansion_review');});
await test('条件未達の提出は停止状態と緊急通知になる',async()=>{const h=harness();const r=await h.submit({...input,manualQueue:1});assert.equal(r.reviewStatus,'blocked');assert.equal(h.records.get(rolloutPath).status,'expansion_blocked');assert.equal(h.rows('notificationQueue')[0].data.bypassQuietHours,true);});
for(const action of ['approve','reject'])await test('別管理者の'+action+'は状態・監査・通知が一致',async()=>{const h=harness();await h.submit();await h.decide({...decision,decision:action});assert.equal(h.records.get(reviewPath).status,action==='approve'?'approved':'rejected');assert.equal(h.rows('pilotExpansionApprovals').length,action==='approve'?1:0);assert.equal(h.rows('auditLogs').length,2);assert.equal(h.rows('notificationQueue').length,2);});
for(const [label,change]of [
 ['会社変更',h=>h.set(rolloutPath,{...h.change(rolloutPath),companyId:'foreign'})],
 ['参加者変更',h=>h.set(rolloutPath,{...h.change(rolloutPath),participantCount:50})],
 ['監視結果変更',h=>h.set(rolloutPath,{...h.change(rolloutPath),lastHealth:{action:'pause'}})],
 ['配布削除',h=>h.remove(rolloutPath)],
])await test('提出直前の'+label+'では書込まない',async()=>{const h=harness();let before;h.race(()=>{change(h);before=snapshot(h);});await assert.rejects(h.submit());assert.equal(snapshot(h),before);});
for(const owner of ['foreign',undefined])await test('提出先に別会社・会社不明の審査があれば上書きしない: '+owner,async()=>{const h=harness();h.set(reviewPath,{companyId:owner,note:'synthetic foreign evidence'});const before=snapshot(h);await assert.rejects(h.submit());assert.equal(snapshot(h),before);});
for(const [label,change]of [
 ['配布会社変更',h=>h.set(rolloutPath,{...h.change(rolloutPath),companyId:'foreign'})],
 ['審査会社変更',h=>h.set(reviewPath,{...h.change(reviewPath),companyId:'foreign'})],
 ['提出者が承認者へ変更',h=>h.set(reviewPath,{...h.change(reviewPath),submittedBy:approver.uid})],
 ['同じfingerprintで提出内容変更',h=>h.set(reviewPath,{...h.change(reviewPath),outcome:{...input,moneyDiffYen:100}})],
 ['監視結果変更',h=>h.set(rolloutPath,{...h.change(rolloutPath),lastHealth:{action:'pause'}})],
 ['状態変更',h=>h.set(reviewPath,{...h.change(reviewPath),status:'rejected'})],
 ['審査削除',h=>h.remove(reviewPath)],
])for(const action of ['approve','reject'])await test(action+'直前の'+label+'では書込まない',async()=>{const h=harness();await h.submit();let before;h.race(()=>{change(h);before=snapshot(h);});await assert.rejects(h.decide({...decision,decision:action}));assert.equal(snapshot(h),before);});
for(const operation of ['submit','decide'])await test(operation+': 通知の保存失敗は全体を保存しない',async()=>{const h=harness();if(operation==='decide')await h.submit();const before=snapshot(h);h.failQueue();await assert.rejects(h[operation](),/synthetic queue failure/);assert.equal(snapshot(h),before);});
for(const operation of ['submit','decide'])await test(operation+': transaction再試行でも通知と監査は1回分',async()=>{const h=harness();if(operation==='decide')await h.submit();const count=h.rows('auditLogs').length;h.retry();await h[operation]();assert.equal(h.rows('auditLogs').length,count+1);assert.equal(h.rows('notificationQueue').length,count+1);});
await test('提出者自身は承認・否認できない',async()=>{for(const action of ['approve','reject']){const h=harness();await h.submit();const before=snapshot(h);await assert.rejects(h.decide({...decision,decision:action},submitter),e=>e.code==='permission-denied');assert.equal(snapshot(h),before);}});
await test('同じ結果の再提出でも各審査の通知を失わない',async()=>{const h=harness();await h.submit();await h.decide({...decision,decision:'reject'});await h.submit();await h.decide({...decision,decision:'reject'});assert.equal(h.rows('auditLogs').length,4);assert.equal(h.rows('notificationQueue').length,4);});
await test('別会社の同じ配布IDの警告を混ぜない',async()=>{const h=harness();h.set('pilotAlerts/foreign',{companyId:'foreign',rolloutId:'rollout',monitorFailure:true,action:'pause'});assert.equal((await h.submit()).reviewStatus,'pending_approval');await h.decide();});
for(const operation of ['submit','decide'])for(const [label,auth,code]of [['未認証',null,'unauthenticated'],['スタッフ',{...submitter,token:{companyId,role:'staff'}},'permission-denied'],['会社なし',{...submitter,token:{role:'admin'}},'failed-precondition']])await test(operation+': '+label+'を読取前に拒否',async()=>{const h=harness();await assert.rejects(h[operation](operation==='submit'?input:decision,auth),e=>e.code===code);assert.equal(h.reads.length,0);});
for(const operation of ['submit','decide'])await test(operation+': 完了応答喪失後の再実行で重複記録を作らない',async()=>{const h=harness();if(operation==='decide')await h.submit();h.loseResponse();await assert.rejects(h[operation](),/synthetic committed response lost/);const before=snapshot(h);await assert.rejects(h[operation]());assert.equal(snapshot(h),before);});
await test('提出者の証跡がない審査は承認・否認しない',async()=>{for(const submittedBy of [undefined,'','  ',12])for(const action of ['approve','reject']){const h=harness();await h.submit();h.set(reviewPath,{...h.change(reviewPath),submittedBy});const before=snapshot(h);await assert.rejects(h.decide({...decision,decision:action}),e=>e.code==='permission-denied');assert.equal(snapshot(h),before);}});
for(const operation of ['submit','decide'])await test(operation+': 他社の配布番号を変更しない',async()=>{const h=harness();if(operation==='decide')await h.submit();h.set(rolloutPath,{...h.change(rolloutPath),companyId:'foreign'});const before=snapshot(h);await assert.rejects(h[operation](),e=>e.code==='not-found');assert.equal(snapshot(h),before);});
for(const operation of ['submit','decide'])await test(operation+': 不正入力はDB読取前に拒否',async()=>{const h=harness();await assert.rejects(h[operation]({}));assert.equal(h.reads.length,0);});
await test('保存された通知の宛先・会社・状態・重複キーと監査を対応付ける',async()=>{const h=harness();await h.submit();await h.decide();for(const row of h.rows('notificationQueue')){assert.equal(row.data.companyId,companyId);assert.equal(row.data.targetRole,'admin');assert.equal(row.data.status,'queued');assert.ok(h.rows('auditLogs').some(a=>a.data.requestId===row.data.dedupeKey));}assert.equal(h.logs.length,0);});
await test('停止判定の再提出でも通知と監査を各1件保存',async()=>{const h=harness();await h.submit({...input,manualQueue:1});await h.submit({...input,manualQueue:1});assert.equal(h.rows('notificationQueue').length,2);assert.equal(h.rows('auditLogs').length,2);});
await test('提出中に新しい重大警告が増えた場合は最新集計で停止判定',async()=>{const h=harness();h.race(()=>h.set('pilotAlerts/new',{companyId,rolloutId:'rollout',action:'pause'}));const r=await h.submit();assert.equal(r.reviewStatus,'blocked');});
await test('承認中に新しい重大警告が増えた場合は承認しない',async()=>{const h=harness();await h.submit();h.race(()=>h.set('pilotAlerts/new',{companyId,rolloutId:'rollout',action:'pause'}));await assert.rejects(h.decide(),e=>e.code==='failed-precondition');assert.equal(h.records.get(reviewPath).status,'pending_approval');assert.equal(h.rows('pilotExpansionApprovals').length,0);});
console.log(JSON.stringify({total:results.length,passed:results.filter(x=>x.passed).length,actualCloudAccess:false,results},null,2));if(results.some(x=>!x.passed))process.exitCode=1;
