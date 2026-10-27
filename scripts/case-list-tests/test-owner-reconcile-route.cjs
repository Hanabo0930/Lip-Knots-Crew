'use strict';
// Authenticated callable boundary only; the actual staged worker is tested
// separately. Every external service is replaced by a recording boundary.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
const chain=new Proxy(function(){},{get:(_,key)=>key==='parse'?value=>value:()=>chain});
const records=new Map(),writes=[],workerCalls=[];
let workerLoads=0,serial=0;
const snapshot=ref=>({exists:records.has(ref.path),data:()=>records.get(ref.path)});
const ref=(collection,id)=>({id:id??'audit-'+(++serial),path:collection+'/'+(id??'audit-'+serial),get:async function(){return snapshot(this);}});
const db={collection:name=>({doc:id=>ref(name,id)}),runTransaction:async fn=>fn({get:async r=>snapshot(r),update:(r,value)=>writes.push({path:r.path,value}),set:(r,value)=>writes.push({path:r.path,value})})};
const named={
 'node:crypto':require('node:crypto'),'firebase-admin/firestore':{FieldValue:{increment:n=>n,delete:()=>null,serverTimestamp:()=>1},Timestamp:class{}},
 'firebase-functions/v2/https':{HttpsError,onCall:fn=>fn},'firebase-functions/v2/firestore':{onDocumentWritten:()=>()=>{}},zod:{z:chain},'./firebase':{db},
 './utils':{requireAdmin:request=>{if(!request.auth||request.auth.token.role!=='admin')throw new HttpsError('permission-denied','admin required');return request.auth;},companyFromClaims:token=>{if(!token.companyId)throw new HttpsError('permission-denied','company required');return token.companyId;}},
 './system-safety':{assertProductionOperational:async()=>{}},'./assignment-preparation-core':{},'./admin-operations-core':{canManuallyRetrySheetWrite:()=>true},
};
const file=path.resolve(__dirname,'../../functions/src/admin-operations.ts');
let code=stripTypeScriptTypes(fs.readFileSync(file,'utf8'),{mode:'transform'}).replace(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)";/g,(_,items,module)=>`const {${items.replace(/\bas\b/g,':')}}=require(${JSON.stringify(module)});`).replace(/^export /gm,'');
const box={module:{exports:{}},require:name=>{if(name==='./case-list-monthly-worker'){workerLoads++;return {reconcileCaseListMonthlyAssignment:async(...args)=>{workerCalls.push(args);return {status:'OWNER_RESUME_REQUIRED',snapshotReads:1,nativeBatches:0};}};}if(!(name in named))throw Error('Unexpected I/O module '+name);return named[name];}};
vm.runInNewContext(code+'\nmodule.exports={acknowledgeSheetWriteIssue,retrySheetWriteIssue};',box,{filename:file});
const api=box.module.exports,company='synthetic-company',token={companyId:company,role:'admin',uid:'owner',email:'owner@example.invalid',email_verified:true};
const request=(data,auth={uid:'owner',token})=>({data,auth});
const input={queueId:'queue-1',action:'reconcile-case-list',note:''};
const results=[];async function test(name,fn){records.clear();writes.length=0;workerCalls.length=0;workerLoads=0;await fn();results.push({name,passed:true});}
(async()=>{
 await test('unauthenticated reconciliation cannot load worker or read service',async()=>{await assert.rejects(()=>api.acknowledgeSheetWriteIssue(request(input,null)),/admin required/);assert.equal(workerLoads,0);assert.equal(writes.length,0);});
 await test('staff role cannot enter owner recovery route',async()=>{await assert.rejects(()=>api.acknowledgeSheetWriteIssue(request(input,{uid:'staff',token:{companyId:company,role:'staff'}})),/admin required/);assert.equal(workerLoads,0);});
 await test('foreign company cannot enter worker or change queue metadata',async()=>{records.set('sheetSyncQueue/queue-1',{companyId:'other-company',operation:'case_list.assign'});await assert.rejects(()=>api.acknowledgeSheetWriteIssue(request(input)),e=>e.code==='not-found');assert.equal(workerLoads,0);assert.equal(writes.length,0);});
 await test('legacy operation cannot be passed to CaseList reconciliation',async()=>{records.set('sheetSyncQueue/queue-1',{companyId:company,operation:'job.assign'});await assert.rejects(()=>api.acknowledgeSheetWriteIssue(request(input)),e=>e.code==='failed-precondition');assert.equal(workerLoads,0);assert.equal(writes.length,0);});
 await test('company-scoped route forwards exact actor and verified token to fresh worker guards',async()=>{records.set('sheetSyncQueue/queue-1',{companyId:company,operation:'case_list.assign',status:'blocked'});const out=await api.acknowledgeSheetWriteIssue(request(input));assert.equal(out.status,'OWNER_RESUME_REQUIRED');assert.equal(out.nativeBatches,0);assert.equal(workerCalls.length,1);assert.equal(workerCalls[0][0].path,'sheetSyncQueue/queue-1');assert.equal(workerCalls[0][1],'owner');assert.equal(workerCalls[0][2],token);assert.equal(writes.length,0);});
 await test('CaseList queue cannot use ordinary manual pending reset',async()=>{records.set('sheetSyncQueue/queue-1',{companyId:company,operation:'case_list.assign',status:'retry_wait'});await assert.rejects(()=>api.retrySheetWriteIssue(request({queueId:'queue-1',note:''})),e=>e.code==='failed-precondition');assert.equal(writes.length,0);assert.equal(workerLoads,0);});
 await test('legacy confirmation memo remains metadata-only and never loads CaseList worker',async()=>{records.set('sheetSyncQueue/queue-1',{companyId:company,operation:'job.assign',status:'blocked'});const out=await api.acknowledgeSheetWriteIssue(request({queueId:'queue-1',action:'note',note:'checked'}));assert.equal(out.acknowledged,true);assert.equal(out.sourceWriteVerified,false);assert.equal(workerLoads,0);assert.equal(writes.find(w=>w.path==='sheetSyncQueue/queue-1').value.status,'acknowledged');});
 const panel=fs.readFileSync(path.resolve(__dirname,'../../apps/admin/src/AdminSheetIssuePanel.tsx'),'utf8'),app=fs.readFileSync(path.resolve(__dirname,'../../apps/admin/src/App.tsx'),'utf8');
 await test('UI exposes read-only reconciliation with partial and held results instead of blind retry',async()=>{assert.match(panel,/保存結果を再照合/);assert.match(panel,/再書込は行いません/);assert.match(panel,/const retry=!caseList&&/);assert.match(app,/action:"reconcile-case-list"/);assert.match(app,/OWNER_RESUME_REQUIRED/);assert.match(app,/保存結果を確定できませんでした/);});
 console.log(JSON.stringify({status:'PASS',tests:results.length,scope:'ACTUAL_AUTHENTICATED_CALLABLE_BOUNDARY_WITH_MOCKED_WORKER',nativeWrites:0,results},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
