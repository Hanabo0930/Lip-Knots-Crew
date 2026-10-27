'use strict';
// Actual admin edit/export callables and CSV formatter; all service I/O mocked.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
const chain=new Proxy(function(){return chain;},{get:(_,key)=>key==='parse'?value=>value:chain});
const records=new Map(),writes=[];let hydrated=null,privateCalls=0,privateError=null;
const snapshot=ref=>({id:ref.id,exists:records.has(ref.path),data:()=>records.get(ref.path)});
let serial=0;const reference=(collection,id)=>({id:id??'generated-'+(++serial),path:collection+'/'+(id??'generated-'+serial)});
function collection(name){const q={doc:id=>reference(name,id),add:async value=>writes.push({path:name,value}),where:()=>q,orderBy:()=>q,limit:()=>q,get:async()=>{const docs=[...records].filter(([p])=>p.startsWith(name+'/')).map(([p])=>snapshot({path:p,id:p.split('/').at(-1)}));return {size:docs.length,docs};}};return q;}
const db={collection,runTransaction:async fn=>fn({get:async ref=>snapshot(ref),set:(ref,value)=>writes.push({path:ref.path,value}),update:(ref,value)=>writes.push({path:ref.path,value})})};
const src=path.resolve(__dirname,'../../functions/src');
function compiled(name,named){const file=path.join(src,name+'.ts'),text=fs.readFileSync(file,'utf8'),exports=[...text.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/gm)].map(m=>m[1]);let code=stripTypeScriptTypes(text,{mode:'transform'});code=code.replace(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)";/g,(_,items,module)=>`const {${items.replace(/\bas\b/g,':')}}=require(${JSON.stringify(module)});`).replace(/^export /gm,'');const box={module:{exports:{}},require:name=>{if(!(name in named))throw Error('Unapproved external module '+name);return named[name];}};vm.runInNewContext(code+'\nmodule.exports={'+exports.join(',')+'};',box,{filename:file});return box.module.exports;}
const core=compiled('job-management-core',{});
const api=compiled('job-management',{
 'node:crypto':require('node:crypto'),'firebase-admin/firestore':{FieldValue:{serverTimestamp:()=>1},Timestamp:class{}},'firebase-functions/v2/https':{HttpsError,onCall:(...args)=>args.at(-1)},'firebase-functions/v2/scheduler':{onSchedule:(...args)=>args.at(-1)},zod:{z:chain},'./firebase':{db},
 './case-id':{},'./job-group-creation':{},'./native-job-creation':{},'./case-mail-job-creation':{},'./case-mail-publication':{},'./assignment-preparation-core':{},'./sheet-write-core':{},'./cancellation-history-retention-core':{},'./admin-edit-state-core':{},'./job-management-core':core,
 './utils':{requireAdmin:r=>{if(r.auth?.token.role!=='admin')throw new HttpsError('permission-denied','admin required');return r.auth;},companyFromClaims:t=>t.companyId},'./system-safety':{assertProductionOperational:async()=>{}},
 './case-list-private-ref':{resolveCaseListPrivateFinancialJob:async(company,id,job)=>{privateCalls++;assert.equal(company,'synthetic-company');assert.equal(id,'job-1');assert.equal(job.companyId,company);if(privateError)throw privateError;return hydrated;}},
});
const request=data=>({auth:{uid:'owner',token:{role:'admin',companyId:'synthetic-company'}},data});
const baseJob={companyId:'synthetic-company',caseListSource:{bindingHash:'a'.repeat(64)},status:'assigned',dateKey:'2026-12-20',workDate:'2026-12-20',clientName:'Synthetic Client',storeName:'Synthetic Store',makerName:'Synthetic Maker',assignedStaffName:'Synthetic Staff',menuName:'Synthetic Menu'};
const results=[];async function test(name,fn){records.clear();records.set('jobs/job-1',{...baseJob});writes.length=0;privateCalls=0;privateError=null;hydrated={...baseJob,sheetRef:{spreadsheetId:'synthetic_private_book'},financials:{clientChargeTotal:20000,clientChargeAdditionsTotal:100,staffPaymentTotal:10000,subcontractorTotal:0},basePay:10000};await fn();results.push({name,passed:true});}
const command={from:'2026-12-01',through:'2026-12-31',includeCancelled:false,groupBy:'client',name:''};
(async()=>{
 for(const fields of [{assignedStaffId:'other-staff'},{storeName:'Changed Store'},{clientChargeInputs:{invoiceBase:20000}},{staffPaymentInputs:{staffBasePay:11000}}])await test('CaseList business or money edit remains held before old writer/public finance ('+Object.keys(fields)[0]+')',async()=>{await assert.rejects(()=>api.adminEditJobInputs(request({jobId:'job-1',fields})),e=>e.code==='failed-precondition');assert.equal(writes.length,0);assert.equal(privateCalls,0);});
 await test('CSV uses verified private finance and its fixed public columns omit private workbook reference',async()=>{const result=await api.generateJobExport(request(command));assert.equal(privateCalls,1);assert.equal(result.summary.invoice,20100);assert.equal(result.summary.payment,10000);assert.ok(result.csv.includes('20100'));assert.ok(!result.csv.includes('synthetic_private_book'));assert.equal(writes.length,1);assert.equal(writes[0].path,'exportLogs');});
 await test('unobserved private financial amount holds export rather than defaulting to zero',async()=>{hydrated.financials.staffPaymentTotal=null;await assert.rejects(()=>api.generateJobExport(request(command)),e=>e.code==='failed-precondition');assert.equal(writes.length,0);});
 await test('stale or missing private observation stops export without an export success log',async()=>{privateError=new HttpsError('failed-precondition','private observation required');await assert.rejects(()=>api.generateJobExport(request(command)),/private observation required/);assert.equal(writes.length,0);});
 await test('legacy monthly export does not load private CaseList hydration',async()=>{delete records.get('jobs/job-1').caseListSource;records.get('jobs/job-1').financials={clientChargeTotal:8000,clientChargeAdditionsTotal:0,staffPaymentTotal:5000};const result=await api.generateJobExport(request(command));assert.equal(privateCalls,0);assert.equal(result.summary.invoice,8000);assert.equal(result.summary.payment,5000);});
 console.log(JSON.stringify({status:'PASS',tests:results.length,scope:'ACTUAL_ADMIN_CONSUMERS_WITH_MOCKED_PRIVATE_HYDRATION',nativeWrites:0,results},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
