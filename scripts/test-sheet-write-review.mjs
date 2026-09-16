import assert from "node:assert/strict";
import fs from "node:fs";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";
const require=createRequire(import.meta.url),ts=require("typescript");
const {Timestamp}=require("firebase-admin/firestore"),{HttpsError}=require("firebase-functions/v2/https");
const companyId="synthetic-company",admin={uid:"synthetic-admin",token:{companyId,role:"admin"}};
const input={expectedCompanyId:companyId,expectedActorUid:admin.uid};
const normal={companyId,status:"pending",jobId:"synthetic-job",operation:"precontact.submit",updatedAt:Timestamp.fromMillis(1000)};
const compare=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
function harness(){
 const records=new Map(),queries=[],modules=new Map();let fail=false;
 const query=(filters=[],orders=[],fields=null,count=Infinity,cursor=undefined)=>({
  where:(...args)=>query([...filters,args],orders,fields,count,cursor),
  orderBy:(...args)=>query(filters,[...orders,args],fields,count,cursor),
  select:(...args)=>query(filters,orders,args,count,cursor),
  limit:n=>query(filters,orders,fields,n,cursor),
  startAfter:id=>query(filters,orders,fields,count,id),
  get:async()=>{
   queries.push({filters,orders,fields,count,cursor});
   if(fail)throw Error("synthetic read failure");
   assert.deepEqual(filters,[["companyId","==",companyId]]);
   assert.deepEqual(orders,[["__name__","asc"]]);
   assert.ok(fields.includes("companyId"));
   assert.ok(count<=101);
   return {docs:[...records].filter(([,data])=>data.companyId===companyId)
    .sort(([a],[b])=>compare(a,b)).filter(([id])=>cursor===undefined||compare(id,cursor)>0)
    .slice(0,count).map(([id,value])=>({id,data:()=>Object.fromEntries(fields.filter(field=>Object.hasOwn(value,field)).map(field=>[field,value[field]]))}))};
  },
 });
 const boundaries={"./firebase":{db:{collection:name=>{assert.equal(name,"sheetSyncQueue");return query();}}},
  "firebase-functions/v2/https":{HttpsError,onCall:(...args)=>args.at(-1)},
  "firebase-admin/firestore":{Timestamp,FieldPath:{documentId:()=>"__name__"}}};
 function load(name){
  if(Object.hasOwn(boundaries,name))return boundaries[name];
  if(!name.startsWith("./"))return require(name);
  if(modules.has(name))return modules.get(name);
  const code=ts.transpileModule(fs.readFileSync(new URL("../functions/src/"+name.slice(2)+".ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};modules.set(name,exports);runInNewContext(code,{exports,require:load,console,Date},{timeout:5000});return exports;
 }
 const handler=load("./sheet-write-review").listSheetWriteReviewRecords;
 return {records,queries,fail:()=>{fail=true;},call:(data=input,auth=admin)=>handler({data,auth})};
}
const results=[];
async function test(name,run){try{await run();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.stack});}}
const json=value=>JSON.parse(JSON.stringify(value));
await test("日時・状態欠落を含む125件を50件ずつ重複なく取得",async()=>{
 const h=harness();for(let i=0;i<125;i++)h.records.set(String(i).padStart(3,"0"),{companyId});
 h.records.set("foreign",{...normal,companyId:"another-company"});h.records.set("no-company",{status:"pending"});
 let cursor,ids=[];for(const count of [50,50,25]){const result=await h.call({...input,...(cursor?{cursor}:{})});assert.equal(result.records.length,count);ids.push(...result.records.map(row=>row.id));cursor=result.nextCursor;assert.equal(result.consistentSnapshot,false);assert.equal(result.sourceWriteVerified,false);}
 assert.equal(cursor,null);assert.equal(new Set(ids).size,125);assert.equal(h.queries.length,3);
 assert.ok(h.queries.every(q=>q.count===51));
});
await test("100件が上限で100件ちょうどでは次頁を作らない",async()=>{
 const h=harness();for(let i=0;i<100;i++)h.records.set(String(i).padStart(3,"0"),normal);
 const result=await h.call({...input,limit:100});assert.equal(result.records.length,100);assert.equal(result.nextCursor,null);assert.equal(h.queries[0].count,101);
});
await test("日本語・空白を含む旧依頼番号のページと、削除済みカーソル",async()=>{
 const h=harness();for(const id of ["A","依頼 1","依頼 2"])h.records.set(id,normal);
 const first=await h.call({...input,limit:2});assert.equal(first.nextCursor,"依頼 1");
 h.records.delete("依頼 1");const next=await h.call({...input,limit:2,cursor:first.nextCursor});assert.deepEqual(json(next.records.map(row=>row.id)),["依頼 2"]);
});
await test("空頁でも原本照合済みや一貫した全件一覧としない",async()=>{
 const result=await harness().call();assert.equal(result.records.length,0);assert.equal(result.nextCursor,null);assert.equal(result.reviewMode,"metadata_only");assert.equal(result.sourceWriteVerified,false);assert.equal(result.consistentSnapshot,false);
});
await test("記録なし・不正形式・正しいTimestampを区別",async()=>{
 const h=harness();h.records.set("old",{companyId,status:"processing",retryAt:"2099-09-20",createdAt:Timestamp.fromMillis(1000),updatedAt:null});
 const row=(await h.call()).records[0];assert.deepEqual(json(row.updatedAt),{state:"missing",value:null});assert.deepEqual(json(row.retryAt),{state:"invalid",value:null});assert.deepEqual(json(row.createdAt),{state:"recorded",value:"1970-01-01T00:00:01.000Z"});
 assert.deepEqual(json(row.reviewReasons),["updated_at_missing","job_id_unavailable","retry_at_invalid"]);
});
await test("未認識の状態も除外せず、記録文字列として保持",async()=>{
 const h=harness();for(const status of ["completed","acknowledged","legacy_custom"])h.records.set(status,{...normal,status});
 const result=await h.call();assert.equal(result.records.length,3);assert.ok(result.records.every(row=>row.sourceWriteVerified===false));
});
await test("確認フラグの不明形式と旧errorTypeを保留として表示",async()=>{
 for(const [suffix,value,errorType,expected]of [["missing",undefined,"system",false],["false",false,"system",false],["true",true,"system",true],["null",null,"system",true],["text","false","system",true],["legacy",false,"verification_required",true]]){
  const h=harness();h.records.set(suffix,{...normal,...(value===undefined?{}:{writeVerificationRequired:value}),errorType});
  assert.equal((await h.call()).records[0].writeVerificationRequired,expected,suffix);
 }
});
await test("本人・勤務日・操作の値は返さず有無だけを示す",async()=>{
 const h=harness();h.records.set("evidence",{...normal,actorUid:"synthetic-secret-uid",actorStaffId:null,dateKey:22,idempotencyKey:"synthetic-secret-operation"});
 const result=await h.call();assert.deepEqual(json(result.records[0].recordedEvidence),{actor:"recorded",staff:"missing",workDate:"invalid",operationKey:"recorded"});
 assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
});
await test("書込本文・expected・原本・メモ・エラー本文は取得対象外",async()=>{
 const h=harness();h.records.set("sensitive",{...normal,updates:{secret:"synthetic"},expected:{secret:"synthetic"},sheetRef:{secret:"synthetic"},errorMessage:"synthetic-secret",acknowledgedNote:"synthetic-secret"});
 const result=await h.call();for(const field of ["updates","expected","sheetRef","errorMessage","acknowledgedNote"])assert.ok(!h.queries[0].fields.includes(field));
 assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
});
await test("過大・不正な表示項目を返さない",async()=>{
 const h=harness();h.records.set("invalid",{...normal,jobId:"x".repeat(1501),operation:[],status:"x".repeat(81),updatedAt:{seconds:1}});
 const row=(await h.call()).records[0];assert.equal(row.jobId,null);assert.equal(row.operation,null);assert.equal(row.status,null);assert.equal(row.updatedAt.state,"invalid");
});
for(const [name,auth,body,code]of [
 ["未ログイン",null,input,"unauthenticated"],
 ["スタッフ",{...admin,token:{...admin.token,role:"staff"}},input,"permission-denied"],
 ["所属なし",{...admin,token:{role:"admin"}},input,"failed-precondition"],
 ["会社の切替",admin,{...input,expectedCompanyId:"other"},"permission-denied"],
 ["本人の切替",admin,{...input,expectedActorUid:"other"},"permission-denied"],
 ["取得条件なし",admin,{},"invalid-argument"],
]){
 await test(name+"はDB読取前に拒否",async()=>{const h=harness();await assert.rejects(h.call(body,auth),error=>error.code===code);assert.equal(h.queries.length,0);});
}
await test("上限逸脱・不正カーソル・想定外フィールドは読取前に拒否",async()=>{
 for(const values of [{limit:0},{limit:101},{limit:1.5},{cursor:""},{cursor:"a/b"},{cursor:"."},{cursor:".."},{cursor:"依".repeat(501)},{sourceWriteVerified:true}]){
  const h=harness();await assert.rejects(h.call({...input,...values}),error=>error.code==="invalid-argument");assert.equal(h.queries.length,0);
 }
});
await test("DB読取失敗を0件に変換しない",async()=>{const h=harness();h.fail();await assert.rejects(h.call(),/synthetic read failure/);assert.equal(h.queries.length,1);});
await test("読取では元の状態・不足証跡・内容を変更しない",async()=>{
 const h=harness();h.records.set("old",{companyId,status:"retry_wait",writeVerificationRequired:true,updates:{value:"synthetic"}});
 const before=JSON.stringify([...h.records]);await h.call();assert.equal(JSON.stringify([...h.records]),before);
});
console.log(JSON.stringify({total:results.length,passed:results.filter(row=>row.passed).length,actualCloudAccess:false,results},null,2));
if(results.some(row=>!row.passed))process.exitCode=1;
