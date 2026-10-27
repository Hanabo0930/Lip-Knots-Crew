// Synthetic tests of the actual TypeScript I/O adapter. No native Google or
// Firestore request, credentials, business data, publication, or assignment.
const assert = require('node:assert/strict');
const {stripTypeScriptTypes} = require('node:module');
const {readFileSync,writeFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname,'../../functions/src');
const fixedNow = Date.parse('2026-10-27T00:00:00.000Z');
class Clock extends Date { constructor(...args){super(...(args.length?args:[fixedNow]));} static now(){return fixedNow;} }
class TS { constructor(ms){this.ms=ms;} static now(){return new TS(fixedNow);} static fromMillis(ms){return new TS(ms);} toMillis(){return this.ms;} }
class HttpsError extends Error {constructor(code,message){super(message);this.code=code;}}
const DELETE = Object.freeze({__DELETE:true});
const clone = value => value instanceof TS ? new TS(value.ms) : Array.isArray(value) ? value.map(clone) : value&&typeof value==='object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clone(v)])) : value;
function load(file,stubs={},names=[]){
 let text=stripTypeScriptTypes(readFileSync(path.join(ROOT,file),'utf8'),{mode:'transform'});
 text=text.replace(/^import\s*\{([^}]+)\}\s*from\s*(["'][^"']+["']);/gm,(_,items,target)=>`const {${items.replace(/\bas\b/g,':')}}=require(${target});`).replaceAll(/^export /gm,'');
 const box={module:{exports:{}},console,Date:Clock,Set,Map,process:{env:{EXECUTIVE_APPROVER_EMAILS:'owner@example.invalid'}},require:name=>Object.hasOwn(stubs,name)?stubs[name]:name.startsWith('../')?require(path.resolve(ROOT,name)):require(name)};
 vm.runInNewContext(text+'\nmodule.exports={'+names.join(',')+'};',box,{filename:path.join(ROOT,file)});
 return box.module.exports;
}
const core=load('case-list-source-core.ts',{},['configuredCaseListSource','CASE_LIST_SOURCE','LEDGER_HEADERS','inspectCaseList','confirmedCaseListCandidate','hashCaseList','caseListMonthlyContentHash','canonical','assertExecutive','assertCaseListJobBinding']);
const ids=load('case-id.ts',{},['createJobIdFromPersistedCaseId']);
const projection=require('../../functions/src/case-list-projection.cjs');
const bookId='synthetic_book_20261027';
const company='synthetic-company',actor='synthetic-owner';
const caseId='LKCASE_00000000-0000-5000-8000-000000000001';
const jobId=ids.createJobIdFromPersistedCaseId(company,caseId);
const owner={role:'admin',email:'owner@example.invalid',email_verified:true};
const str=x=>({userEnteredValue:{stringValue:x},effectiveValue:{stringValue:x}});
function fixture(){
 const row=Array.from({length:65},()=>({}));
 for(const [n,v] of [[1,'2026-11-20'],[10,'合成依頼元'],[11,'合成店舗'],[12,'合成メーカー'],[13,'合成試食'],[14,'09:30'],[15,'10:00～18:00'],[55,'募集中'],[56,'東京'],[58,'単日'],[60,caseId],[62,JSON.stringify({schema:'LKCM1_CASE_META_V1',publicEligible:true,headcountConfirmed:true})]])row[n]=str(v);
 const ledger=Array.from({length:25},()=>({}));ledger[0]=str(caseId);ledger[8]=str('未手配');ledger[19]=str(JSON.stringify({schema:'LK_HISTORY_CORE_SNAPSHOT_V1',caseId,monthly:null}));
 return {rows:[projection.HEADERS.map(str),row],ledger:[Array.from({length:25},()=>({})),Array.from({length:25},()=>({})),core.LEDGER_HEADERS.map(str),ledger]};
}
function dbMock(initial={}){
 const state=new Map(Object.entries(initial).map(([k,v])=>[k,clone(v)])),writes=[],reads=[];
 let txCount=0,hook=null;
 function snapshot(ref){return {exists:state.has(ref.path),id:ref.id,ref,data:()=>clone(state.get(ref.path))};}
 function merge(base,patch){const out={...clone(base)};for(const [k,v] of Object.entries(patch)){if(v&&v.__DELETE===true)delete out[k];else out[k]=clone(v);}return out;}
 function commit(op){writes.push(clone(op));if(op.kind==='delete'){state.delete(op.path);return;}state.set(op.path,op.merge?merge(state.get(op.path)||{},op.data):clone(op.data));}
 function ref(p){return {path:p,id:p.split('/').at(-1),get:async()=>{reads.push(p);return snapshot(ref(p));},set:async(data,options)=>commit({kind:'set',path:p,data,merge:options?.merge===true}),update:async data=>commit({kind:'update',path:p,data,merge:true})};}
 const db={collection:name=>({doc:id=>ref(name+'/'+id)}),runTransaction:async fn=>{
   txCount++;if(hook)await hook(txCount,state);
   const pending=[];let writeStarted=false;
   const tx={get:async r=>{assert.equal(writeStarted,false,'Firestore read after staged write');reads.push(r.path);return snapshot(r);},
     set:(r,data,options)=>{writeStarted=true;pending.push({kind:'set',path:r.path,data,merge:options?.merge===true});},
     update:(r,data)=>{writeStarted=true;pending.push({kind:'update',path:r.path,data,merge:true});},
     delete:r=>{writeStarted=true;pending.push({kind:'delete',path:r.path});}};
   const result=await fn(tx);pending.forEach(commit);return result;
 }};
 return {db,state,writes,reads,setHook:fn=>hook=fn,resetWrites:()=>writes.splice(0),get txCount(){return txCount;}};
}
function environment(f=fixture(),extra={}){
 const config={companyId:company,spreadsheetId:bookId,caseListEnabled:true,caseListAssignmentsEnabled:true,...extra.config};
 const db=dbMock({['sheetImportConfigs/'+company]:config,...extra.docs});
 const requests=[];const state={metadataEdit:null,gridEdit:null,apiFailure:null,capabilityReject:false};
 function sheetProperties(){return [{sheetId:core.CASE_LIST_SOURCE.sheetId,title:'案件リスト',gridProperties:{rowCount:f.rows.length,columnCount:65}},{sheetId:2026102605,title:'案件_実績台帳',gridProperties:{rowCount:f.ledger.length,columnCount:25}}];}
 const sheets={spreadsheets:{get:async input=>{
   requests.push(clone(input));assert.equal(input.spreadsheetId,bookId);
   if(state.apiFailure)throw state.apiFailure;
   const result={data:{spreadsheetId:bookId,properties:{timeZone:'Asia/Tokyo'},sheets:sheetProperties().map(properties=>({properties}))}};
   if(input.includeGridData){
     assert.deepEqual(Array.from(input.ranges),[`'案件リスト'!A1:BM${f.rows.length}`,`'案件_実績台帳'!A1:Y${f.ledger.length}`]);
     result.data.sheets[0].data=[{startRow:0,startColumn:0,rowData:f.rows.map(values=>({values:clone(values)}))}];
     result.data.sheets[1].data=[{startRow:0,startColumn:0,rowData:f.ledger.map(values=>({values:clone(values)}))}];
     if(state.gridEdit)state.gridEdit(result);
   }else if(state.metadataEdit)state.metadataEdit(result);
   return result;
 }}};
 const operational=[],capabilityChecks=[];
 const adapter=load('case-list-source.ts',{'firebase-admin/firestore':{FieldValue:{delete:()=>DELETE},Timestamp:TS},'firebase-functions/v2/https':{HttpsError},'./firebase':{db:db.db},'./sheet-reader':{createReadOnlySheetsClient:async()=>sheets},'./case-id':ids,'./system-safety':{assertProductionOperational:async id=>operational.push(id)},'./case-list-source-core':core,'./case-list-transfer-capability':{verifyCaseListTransferCapability:async(checkedCompany,binding)=>{assert.equal(checkedCompany,company);assert.equal(binding.spreadsheetId,bookId);capabilityChecks.push(clone(binding));if(state.capabilityReject)throw new HttpsError('failed-precondition','Known unsupported monthly mapping');}}},['requireCaseListExecutive','readLiveCaseList','executeCaseListImport','readCaseListPublication']);
 return {f,...db,dbState:db,state,requests,adapter,operational,capabilityChecks,config};
}
function getJob(e){return e.state instanceof Map?e.state.get('jobs/'+jobId):e.dbState.state.get('jobs/'+jobId);}
function source(e){return core.inspectCaseList(e.f.rows,e.f.ledger,new Clock().toISOString(),bookId).jobs[0].source;}
function confirmation(e){return {expectedSourceRevision:source(e).sourceRevision,confirmedFields:{arrival:true,execution:true,headcount:true,dateMode:true,payOffer:true,vacancy:true},payOffer:{dailyWageJPY:10000,travelExpenses:'全額支給',communicationExpenses:'全額支給'}};}
function putJob(e,patch={}){const entry=core.inspectCaseList(e.f.rows,e.f.ledger,new Clock().toISOString(),bookId).jobs[0];e.dbState.state.set('jobs/'+jobId,{...clone(entry.fields),companyId:company,caseId,revision:1,caseListSource:clone(entry.source),status:'draft',publishable:false,basePay:10000,publicPayOffer:{dailyWageJPY:10000,travelExpenses:'全額支給',communicationExpenses:'全額支給'},...patch});return e.dbState.state.get('jobs/'+jobId);}
const results=[];async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.stack});}}
async function reject(fn,code){await assert.rejects(fn,error=>!code||error.code===code);}
async function main(){
 await test('preview reads bounded pinned Google source+ledger and writes nothing',async()=>{const e=environment();const out=await e.adapter.executeCaseListImport(company,'preview',actor,owner);assert.equal(out.writes,0);assert.equal(out.publications,0);assert.equal(out.counts.total,1);assert.equal(e.dbState.writes.length,0);assert.equal(e.operational.length,0);assert.equal(e.requests.length,2);});
 await test('disabled preview remains read-only and does not enable',async()=>{const e=environment(fixture(),{config:{caseListEnabled:false}});await e.adapter.executeCaseListImport(company,'preview',actor,owner);assert.equal(e.dbState.state.get('sheetImportConfigs/'+company).caseListEnabled,false);assert.equal(e.dbState.writes.length,0);});
 await test('unverified executive cannot enable and performs no source reads',async()=>{const e=environment(fixture(),{config:{caseListEnabled:false}});await reject(()=>e.adapter.executeCaseListImport(company,'commit',actor,{...owner,email_verified:false},true),'permission-denied');assert.equal(e.requests.length,0);assert.equal(e.dbState.writes.length,0);});
 await test('ordinary admin cannot enable',async()=>{const e=environment(fixture(),{config:{caseListEnabled:false}});await reject(()=>e.adapter.executeCaseListImport(company,'commit',actor,{...owner,email:'other@example.invalid'},true),'permission-denied');assert.equal(e.dbState.writes.length,0);});
 await test('executive enable verifies actual source then creates only draft',async()=>{const e=environment(fixture(),{config:{caseListEnabled:false,caseListAssignmentsEnabled:false}});const out=await e.adapter.executeCaseListImport(company,'commit',actor,owner,true);const job=e.dbState.state.get('jobs/'+jobId);assert.equal(out.writes,1);assert.equal(job.status,'draft');assert.equal(job.publishable,false);assert.equal(job.sourceReady,false);assert.equal(job.revision,1);assert.equal(job.basePay,null);assert.equal(e.dbState.state.get('sheetImportConfigs/'+company).caseListEnabled,true);assert.equal(e.dbState.state.get('sheetImportConfigs/'+company).caseListAssignmentsEnabled,false);assert.deepEqual(e.operational,[company]);});
 await test('invalid source header never enables or creates drafts',async()=>{const e=environment(fixture(),{config:{caseListEnabled:false}});e.f.rows[0][60]=str('wrong');await reject(()=>e.adapter.executeCaseListImport(company,'commit',actor,owner,true),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 for(const [name,change] of [['malformed configured spreadsheet',e=>e.dbState.state.get('sheetImportConfigs/'+company).spreadsheetId='invalid/book'],['missing configured spreadsheet',e=>delete e.dbState.state.get('sheetImportConfigs/'+company).spreadsheetId],['company mismatch',e=>e.dbState.state.get('sheetImportConfigs/'+company).companyId='other-company']])await test(name+' stops before Google',async()=>{const e=environment();change(e);await reject(()=>e.adapter.readLiveCaseList(company),'failed-precondition');assert.equal(e.requests.length,0);});
 for(const [name,change] of [['response book',r=>r.data.spreadsheetId='different_server_book'],['timezone',r=>r.data.properties.timeZone='UTC'],['65-column header structure',r=>r.data.sheets[0].properties.gridProperties.columnCount=64],['source title',r=>r.data.sheets[0].properties.title='different'],['ledger ID',r=>r.data.sheets[1].properties.sheetId=3],['oversized source grid',r=>r.data.sheets[0].properties.gridProperties.rowCount=5002]])await test('metadata '+name+' guard',async()=>{const e=environment();e.state.metadataEdit=change;await reject(()=>e.adapter.readLiveCaseList(company),'failed-precondition');assert.equal(e.requests.length,1);});
 await test('grid structure changed after metadata aborts before writes',async()=>{const e=environment();e.state.gridEdit=r=>r.data.sheets[0].properties.gridProperties.rowCount++;await reject(()=>e.adapter.executeCaseListImport(company,'commit',actor,owner),'aborted');assert.equal(e.dbState.writes.length,0);});
 await test('duplicate fixed IDs stop entire sync before lease/write',async()=>{const e=environment();e.f.rows.push(clone(e.f.rows[1]));await reject(()=>e.adapter.executeCaseListImport(company,'commit',actor,owner),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 await test('known monthly ledger link never creates a duplicate job',async()=>{const e=environment();e.f.ledger[3][19]=str(JSON.stringify({schema:'LK_HISTORY_CORE_SNAPSHOT_V1',caseId,monthly:{caseId:'existing-monthly-id'}}));const out=await e.adapter.executeCaseListImport(company,'commit',actor,owner);assert.equal(out.writes,0);assert.equal(out.heldLinked,1);assert.equal(e.dbState.state.has('jobs/'+jobId),false);});
 await test('same source/hash reimport has zero job writes',async()=>{const e=environment();await e.adapter.executeCaseListImport(company,'commit',actor,owner);e.dbState.resetWrites();const out=await e.adapter.executeCaseListImport(company,'commit',actor,owner);assert.equal(out.writes,0);assert.equal(e.dbState.writes.filter(w=>w.path.startsWith('jobs/')).length,0);assert.equal(e.dbState.state.get('jobs/'+jobId).revision,1);});
 await test('source changes keep assigned identity dayLock unconfirmed and manual fields',async()=>{const e=environment();putJob(e,{status:'assigned',assignedStaffId:'staff-1',assignedStaffName:'合成担当',applicationUnconfirmed:true,assignmentUnresolved:true,manualSalary:8000,storeName:'保持する店舗',caseListSource:{...source(e),sourceRevision:'a'.repeat(64)}});const lockPath='staffDayLocks/'+company+'_staff-1_2026-11-20',lock={companyId:company,staffId:'staff-1',jobId,active:true,dateKey:'2026-11-20'};e.dbState.state.set(lockPath,clone(lock));await e.adapter.executeCaseListImport(company,'commit',actor,owner);const job=e.dbState.state.get('jobs/'+jobId);assert.equal(job.status,'assigned');assert.equal(job.assignedStaffId,'staff-1');assert.equal(job.assignedStaffName,'合成担当');assert.equal(job.applicationUnconfirmed,true);assert.equal(job.assignmentUnresolved,true);assert.equal(job.manualSalary,8000);assert.equal(job.storeName,'保持する店舗');assert.equal(job.revision,2);assert.equal(job.publishable,false);assert.deepEqual(e.dbState.state.get(lockPath),lock);assert.equal(e.dbState.writes.filter(w=>w.path.startsWith('staffDayLocks/')).length,0);});
 await test('missing source retains job and assignment; reappearance clears missing under new revision',async()=>{const e=environment();putJob(e,{status:'assigned',assignedStaffId:'staff-1',applicationUnconfirmed:true});e.dbState.state.set('caseListCatalogs/'+company,{caseIds:[caseId]});const row=e.f.rows.pop();const out=await e.adapter.executeCaseListImport(company,'commit',actor,owner);assert.equal(e.dbState.state.get('jobs/'+jobId).sourceMissing,true);assert.equal(e.dbState.state.get('jobs/'+jobId).assignedStaffId,'staff-1');e.f.rows.push(row);await e.adapter.executeCaseListImport(company,'commit',actor,owner);const job=e.dbState.state.get('jobs/'+jobId);assert.equal(job.sourceMissing,false);assert.equal(job.revision,2);assert.equal(job.status,'assigned');assert.equal(job.applicationUnconfirmed,true);});
 await test('source-missing phase rejects stolen lease',async()=>{const e=environment();putJob(e);e.dbState.state.set('caseListCatalogs/'+company,{caseIds:[caseId]});e.f.rows.pop();e.dbState.setHook((n,state)=>{if(n===2)state.get('caseListSyncLocks/'+company).tokenId='different-owner';});await reject(()=>e.adapter.executeCaseListImport(company,'commit',actor,owner),'aborted');assert.notEqual(e.dbState.state.get('jobs/'+jobId).sourceMissing,true);});
 await test('source-missing phase rejects disabled config',async()=>{const e=environment();putJob(e);e.dbState.state.set('caseListCatalogs/'+company,{caseIds:[caseId]});e.f.rows.pop();e.dbState.setHook((n,state)=>{if(n===2)state.get('sheetImportConfigs/'+company).caseListEnabled=false;});await reject(()=>e.adapter.executeCaseListImport(company,'commit',actor,owner),'aborted');assert.notEqual(e.dbState.state.get('jobs/'+jobId).sourceMissing,true);});
 await test('final catalog cannot overwrite a newer owner after lease changes',async()=>{const e=environment();e.dbState.state.set('caseListCatalogs/'+company,{caseIds:[],digest:'newer-catalog'});e.dbState.setHook((n,state)=>{if(n===3)state.get('caseListSyncLocks/'+company).tokenId='newer-owner';});await reject(()=>e.adapter.executeCaseListImport(company,'commit',actor,owner),'aborted');assert.equal(e.dbState.state.get('caseListCatalogs/'+company).digest,'newer-catalog');assert.equal(e.dbState.state.get('caseListSyncLocks/'+company).tokenId,'newer-owner');});
 await test('final catalog rejects disabled configuration',async()=>{const e=environment();e.dbState.state.set('caseListCatalogs/'+company,{caseIds:[],digest:'previous-catalog'});e.dbState.setHook((n,state)=>{if(n===3)state.get('sheetImportConfigs/'+company).caseListEnabled=false;});await reject(()=>e.adapter.executeCaseListImport(company,'commit',actor,owner),'aborted');assert.equal(e.dbState.state.get('caseListCatalogs/'+company).digest,'previous-catalog');});
 await test('unexpired concurrent importer prevents draft writes',async()=>{const e=environment();e.dbState.state.set('caseListSyncLocks/'+company,{tokenId:'existing',activeUntil:TS.fromMillis(fixedNow+10000)});await reject(()=>e.adapter.executeCaseListImport(company,'commit',actor,owner),'aborted');assert.equal(e.dbState.writes.length,0);});
 await test('server-read private approval is bound to current job and source',async()=>{const e=environment(),job=putJob(e),approval=confirmation(e);e.dbState.state.set('caseListApprovals/'+jobId,{...approval,companyId:company,jobId,actorUid:actor});const out=await e.dbState.db.runTransaction(tx=>e.adapter.readCaseListPublication(tx,company,jobId,job,1,source(e).sourceRevision));assert.equal(out.candidate.store,'合成店舗');assert.equal(out.approval.actorUid,actor);assert.equal(e.dbState.writes.length,0);});
 await test('known unsupported monthly capability blocks current private approval with zero writes',async()=>{const e=environment(),job=putJob(e),approval=confirmation(e);e.dbState.state.set('caseListApprovals/'+jobId,{...approval,companyId:company,jobId,actorUid:actor});e.state.capabilityReject=true;await reject(()=>e.dbState.db.runTransaction(tx=>e.adapter.readCaseListPublication(tx,company,jobId,job,1,source(e).sourceRevision)),'failed-precondition');assert.equal(e.capabilityChecks.length,1);assert.equal(e.capabilityChecks[0].caseId,caseId);assert.equal(e.capabilityChecks[0].sourceRevision,approval.expectedSourceRevision);assert.equal(e.dbState.writes.length,0);});
 for(const [name,patch] of [['date',{dateKey:'2026-11-21'}],['menu',{menuName:'different menu'}],['salary offer',{basePay:10001}],['expense offer',{publicPayOffer:{dailyWageJPY:10000,travelExpenses:'unconfirmed',communicationExpenses:'全額支給'}}]])await test('current private approval rejects mismatched app '+name,async()=>{const e=environment(),job=putJob(e,patch),approval=confirmation(e);e.dbState.state.set('caseListApprovals/'+jobId,{...approval,companyId:company,jobId,actorUid:actor});await reject(()=>e.dbState.db.runTransaction(tx=>e.adapter.readCaseListPublication(tx,company,jobId,job,1,source(e).sourceRevision)),'failed-precondition');assert.equal(e.capabilityChecks.length,1);assert.equal(e.dbState.writes.length,0);});
 for(const [name,patch] of [['company',{companyId:'wrong'}],['jobId',{jobId:'wrong'}],['source hash',{expectedSourceRevision:'a'.repeat(64)}]])await test('private approval '+name+' mismatch rejects',async()=>{const e=environment(),job=putJob(e);e.dbState.state.set('caseListApprovals/'+jobId,{...confirmation(e),companyId:company,jobId,actorUid:actor,...patch});await reject(()=>e.dbState.db.runTransaction(tx=>e.adapter.readCaseListPublication(tx,company,jobId,job,1,source(e).sourceRevision)),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 await test('source/ledger change after approval rejects with no private/public mutation',async()=>{const e=environment(),job=putJob(e),approval=confirmation(e);e.dbState.state.set('caseListApprovals/'+jobId,{...approval,companyId:company,jobId,actorUid:actor});e.f.ledger[3][9]=str('新しい担当');await reject(()=>e.dbState.db.runTransaction(tx=>e.adapter.readCaseListPublication(tx,company,jobId,job,1,approval.expectedSourceRevision)),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 await test('application integration disabled rejects current private approval',async()=>{const e=environment(fixture(),{config:{caseListAssignmentsEnabled:false}}),job=putJob(e);e.dbState.state.set('caseListApprovals/'+jobId,{...confirmation(e),companyId:company,jobId,actorUid:actor});await reject(()=>e.dbState.db.runTransaction(tx=>e.adapter.readCaseListPublication(tx,company,jobId,job,1,source(e).sourceRevision)),'failed-precondition');assert.equal(e.dbState.writes.length,0);});
 const report={status:results.every(r=>r.passed)?'PASS':'FAIL',tests:results.length,passed:results.filter(r=>r.passed).length,scope:'ACTUAL_TYPESCRIPT_ADAPTER_WITH_MOCKED_IO_ONLY',nativeFirestore:false,nativeGoogle:false,externalWrites:0,results};
 console.log(JSON.stringify(report,null,2));if(report.status!=='PASS')process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
