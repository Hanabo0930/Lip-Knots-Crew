import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const dependency=createRequire(import.meta.url),ts=dependency('typescript'),{z}=dependency('zod');
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
const results=[];
for(const [api,cap] of [['getOperationsDashboard',15000],['getStaffPerformance',10000]])for(const count of [0,cap-1,cap,cap+1]){
 try{
 const reads=[];const collection=(name,filters=[],limit=Infinity)=>({doc:id=>({get:async()=>({id,exists:true,data:()=>({companyId:'company',displayName:'Synthetic'})})}),where:(key,op,value)=>collection(name,[...filters,[key,op,value]],limit),limit:value=>collection(name,filters,value),get:async()=>{reads.push({name,filters,limit});const docs=Array.from({length:Math.min(count,limit)},(_,i)=>({id:'job-'+i,data:()=>({companyId:'company',assignedStaffId:'staff',dateKey:'2026-09-01',status:'assigned'})}));return{docs,size:docs.length};}});
 const modules=new Map();const boundary={'./firebase':{db:{collection}},'firebase-functions/v2/https':{onCall:fn=>fn,HttpsError},'firebase-admin/firestore':{FieldValue:{},Timestamp:{}},zod:{z},'./notification-core':{queueDocumentData:()=>assert.fail('no notification writes')},'./utils':{requireAdmin:r=>r.auth,companyFromClaims:t=>t.companyId},'./system-safety':{assertProductionOperational:()=>assert.fail('no operational writes')}};
 const load=name=>{if(boundary[name])return boundary[name];assert.ok(['./analytics','./analytics-core','./sheet-write-core'].includes(name));if(modules.has(name))return modules.get(name);const exports={};modules.set(name,exports);runInNewContext(ts.transpileModule(fs.readFileSync('functions/src/'+name.slice(2)+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:load});return exports;};
 const handler=load('./analytics')[api],request={auth:{uid:'admin',token:{companyId:'company',role:'admin'}},data:api==='getOperationsDashboard'?{month:'2026-09'}:{staffId:'staff',from:'2026-09-01',through:'2026-09-30'}};
 if(count>cap)await assert.rejects(()=>handler(request),{code:'resource-exhausted'});else assert.ok(await handler(request));assert.equal(reads.length,1);assert.equal(reads[0].limit,cap+1);assert.ok(reads[0].filters.some(([key,op,value])=>key==='companyId'&&op==='=='&&value==='company'));results.push({api,count,passed:true});
 if(api==='getStaffPerformance'&&count===0){for(const date of ['2026-02-30','2025-02-29','2026-04-31','2026-00-01','2026-13-01','2026-01-00'])for(const field of ['from','through']){try{const previous=reads.length;await assert.rejects(()=>handler({...request,data:{staffId:'staff',from:'2020-01-01',through:'2030-12-31',[field]:date}}));assert.equal(reads.length,previous);results.push({date,field,passed:true});}catch(error){results.push({date,field,passed:false,error:error.message});}}for(const date of ['2024-02-29','2026-04-30']){await handler({...request,data:{staffId:'staff',from:date,through:date}});results.push({date,passed:true});}}

 }catch(error){results.push({api,count,passed:false,error:error.message});}
}
console.log(JSON.stringify({passed:results.every(r=>r.passed),results},null,2));if(results.some(r=>!r.passed))process.exitCode=1;
