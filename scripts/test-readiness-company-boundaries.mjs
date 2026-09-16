import assert from "node:assert/strict";
import fs from "node:fs";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";
const require=createRequire(import.meta.url),ts=require("typescript");
const {Timestamp}=require("firebase-admin/firestore"),{HttpsError}=require("firebase-functions/v2/https");
const companyId="synthetic-company",admin={uid:"synthetic-admin",token:{companyId,role:"admin"}};
const handlers={getPilotReadiness:"sheet-row-creation",getPilotExpansionReview:"pilot-expansion",getProductionControlStatus:"production-control",getProductionSloDashboard:"production-slo"};
const compiled=new Map();
function harness(){
 const records=new Map(),reads=[],modules=new Map();
 const forbidden=()=>{throw Error("read-only handler attempted a side effect");};
 const snap=path=>({id:path.split("/").at(-1),exists:records.has(path),data:()=>records.get(path)});
 const doc=path=>({id:path.split("/").at(-1),get:async()=>{reads.push({path});return snap(path);},set:forbidden,update:forbidden,delete:forbidden});
 const query=(path,filters=[],orders=[],count=Infinity)=>({
  doc:id=>doc(path+"/"+id),where:(...args)=>query(path,[...filters,args],orders,count),orderBy:(...args)=>query(path,filters,[...orders,args],count),limit:n=>query(path,filters,orders,n),add:forbidden,
  get:async()=>{
   reads.push({path,filters,orders,count});
   let rows=[...records].filter(([key,data])=>key.startsWith(path+"/")&&key.split("/").length===path.split("/").length+1&&filters.every(([field,op,value])=>{assert.equal(op,"==");return data[field]===value;}));
   for(const[field,direction]of [...orders].reverse())rows.sort((a,b)=>{const val=x=>x[1][field]?.toMillis?.()??x[1][field]??0;return (val(a)<val(b)?-1:val(a)>val(b)?1:0)*(direction==="desc"?-1:1);});
   const docs=rows.slice(0,count).map(([path])=>snap(path));return {docs,size:docs.length,empty:docs.length===0};
  },
 });
 const boundaries={
  "./firebase":{db:{collection:path=>query(path),doc,runTransaction:forbidden,batch:forbidden}},
  "firebase-functions/v2/https":{HttpsError,onCall:(...args)=>args.at(-1)},
  "firebase-functions/v2/scheduler":{onSchedule:(...args)=>args.at(-1)},
  "firebase-functions/v2/firestore":{onDocumentWritten:(...args)=>args.at(-1)},
  "firebase-functions/params":{defineString:()=>({value:()=>""})},
  "./notification-core":{enqueueNotification:forbidden},"./production-metrics":{incrementProductionMetrics:forbidden},
  "./system-safety":{getProductionOperationalState:forbidden},"googleapis":{google:{sheets:forbidden,auth:{GoogleAuth:forbidden}}},
 };
 function load(name){
  if(Object.hasOwn(boundaries,name))return boundaries[name];
  if(!name.startsWith("./"))return require(name);
  if(modules.has(name))return modules.get(name);
  if(!compiled.has(name))compiled.set(name,ts.transpileModule(fs.readFileSync(new URL("../functions/src/"+name.slice(2)+".ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
  const exports={};modules.set(name,exports);runInNewContext(compiled.get(name),{exports,require:load,console,Date,Buffer,process:{env:{APP_ENVIRONMENT:"staging"}}},{timeout:5000});return exports;
 }
 return {records,reads,call:(name,data={},auth=admin)=>load("./"+handlers[name])[name]({data,auth})};
}
const results=[];
async function test(name,run){try{await run();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.stack});}}
function readyFixture(h){
 h.records.set("companyFeatureSettings/"+companyId,{adminJobCreationSourceReady:true,monthSheetCreationReady:true});
 h.records.set("sheetImportConfigs/"+companyId,{enabled:true});h.records.set("staffImportConfigs/"+companyId,{enabled:true});h.records.set("setupWizardDrafts/"+companyId,{allEnabled:false});
 const mapping={enabled:true,spreadsheetId:"synthetic-sheet",idColumn:"A",columns:{caseId:"A"},rowCreation:{enabled:true},monthCreation:{enabled:true,verifiedSpreadsheetId:"synthetic-sheet"}};
 h.records.set(`companies/${companyId}/sheetMappings/shift`,mapping);return mapping;
}
function expansionFixture(h){h.records.set("pilotRollouts/rollout",{companyId,status:"review_required",startedAt:Timestamp.fromMillis(1000),completedAt:Timestamp.fromMillis(901000),participantCount:3,lastHealth:{action:"continue"},inviteSummary:{failedStaff:0}});}
function controlFixture(h){h.records.set("stagedRollouts/rollout",{companyId,status:"completed",completedAt:Timestamp.fromMillis(1000)});}
for(const [name,values,expected]of [
 ["有効な一致",["synthetic-sheet","synthetic-sheet"],true],["双方欠落",[undefined,undefined],false],["双方空",["",""],false],["双方空白",[" "," "],false],["前後空白",[" x "," x "],false],["双方数値",[123,123],false],["不一致",["one","two"],false],["承認ID欠落",["one",undefined],false],
])await test("検証コピー: "+name,async()=>{const h=harness(),m=readyFixture(h);m.spreadsheetId=values[0];m.monthCreation.verifiedSpreadsheetId=values[1];const result=await h.call("getPilotReadiness");assert.equal(result.checks.find(c=>c.key==="verified_copy").ok,expected);assert.equal(result.ready,expected);});
await test("検証コピー一致でも停止キューを無視しない",async()=>{const h=harness();readyFixture(h);h.records.set("sheetRowCreateQueue/blocked",{companyId,status:"blocked"});assert.equal((await h.call("getPilotReadiness")).ready,false);});
for(const owner of [companyId,"foreign-company",undefined]){
 await test("拡大審査の会社: "+String(owner),async()=>{const h=harness();expansionFixture(h);h.records.set("pilotExpansionReviews/rollout",{companyId:owner,decisionNote:"synthetic-note",submittedBy:"another-admin"});const result=await h.call("getPilotExpansionReview",{rolloutId:"rollout"});if(owner===companyId)assert.equal(result.review.decisionNote,"synthetic-note");else assert.equal(result.review,null);});
 await test("本番審査の会社: "+String(owner),async()=>{const h=harness();controlFixture(h);h.records.set("productionReleaseReviews/rollout",{companyId:owner,note:"synthetic-note"});const result=await h.call("getProductionControlStatus");if(owner===companyId)assert.equal(result.review.note,"synthetic-note");else assert.equal(result.review,null);});
 await test("リハーサル証跡の会社: "+String(owner),async()=>{const h=harness();controlFixture(h);h.records.set("productionRehearsalCertifications/rollout",{companyId:owner,status:"completed",fingerprint:"synthetic-fingerprint"});const result=await h.call("getProductionControlStatus");assert.equal(result.rehearsalCertified,owner===companyId);assert.equal(result.rehearsalFingerprint,owner===companyId?"synthetic-fingerprint":"");});
 await test("参照先障害の会社: "+String(owner),async()=>{const h=harness();h.records.set("productionSloControls/"+companyId,{openIncidentId:"incident"});h.records.set("productionIncidents/incident",{companyId:owner,title:"synthetic-title"});const result=await h.call("getProductionSloDashboard");if(owner===companyId)assert.equal(result.openIncident.title,"synthetic-title");else assert.equal(result.openIncident,null);});
}
await test("監視件数と警告は同じ会社・同じ配布だけを集計",async()=>{
 const h=harness();expansionFixture(h);
 for(const[mark,owner,rolloutId]of [["own",companyId,"rollout"],["foreign","foreign-company","rollout"],["missing",undefined,"rollout"],["other",companyId,"other-rollout"]]){
  h.records.set("pilotHealthRuns/"+mark,{companyId:owner,rolloutId});h.records.set("pilotAlerts/"+mark,{companyId:owner,rolloutId,monitorFailure:true,action:"pause"});
 }
 const result=await h.call("getPilotExpansionReview",{rolloutId:"rollout"});assert.equal(result.automated.healthRunCount,1);assert.equal(result.automated.monitorFailureCount,1);assert.equal(result.automated.criticalAlertCount,1);
 for(const path of ["pilotHealthRuns","pilotAlerts"]){const q=h.reads.find(row=>row.path===path);assert.ok(q.filters.some(([field,op,value])=>field==="companyId"&&op==="=="&&value===companyId));}
});
await test("別会社の配布番号は審査を読み取らない",async()=>{const h=harness();h.records.set("pilotRollouts/rollout",{companyId:"foreign"});const result=await h.call("getPilotExpansionReview",{rolloutId:"rollout"});assert.equal(result.rollout,null);assert.equal(h.reads.length,1);});
for(const name of Object.keys(handlers)){
 for(const[label,auth,code]of [["未認証",null,"unauthenticated"],["スタッフ",{...admin,token:{companyId,role:"staff"}},"permission-denied"],["会社なし",{...admin,token:{role:"admin"}},"failed-precondition"]])await test(name+": "+label+"は読取前に拒否",async()=>{const h=harness();await assert.rejects(h.call(name,{},auth),error=>error.code===code);assert.equal(h.reads.length,0);});
 await test(name+": データなしを安全に返して副作用を起こさない",async()=>{const h=harness();await h.call(name);assert.equal(h.records.size,0);});
}
console.log(JSON.stringify({total:results.length,passed:results.filter(row=>row.passed).length,actualCloudAccess:false,results},null,2));
if(results.some(row=>!row.passed))process.exitCode=1;
