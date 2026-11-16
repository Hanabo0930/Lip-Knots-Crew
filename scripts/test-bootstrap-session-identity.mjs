import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(process.env.LKC_TEST_DEPENDENCY_ROOT
 ? new URL('package.json', 'file:///'+process.env.LKC_TEST_DEPENDENCY_ROOT.replace(/\\/g,'/').replace(/\/$/,'')+'/')
 : import.meta.url),ts=require('typescript');
const {Timestamp}=require('firebase-admin/firestore'),{HttpsError}=require('firebase-functions/v2/https');
const sourceIndex=process.argv.indexOf('--source');
const authSource=sourceIndex>=0?fs.readFileSync(process.argv[sourceIndex+1],'utf8'):fs.readFileSync(new URL('../functions/src/auth.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(authSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const utilCode=ts.transpileModule(fs.readFileSync(new URL('../functions/src/utils.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const staffEmail='synthetic-staff@example.invalid',adminEmail='synthetic-admin@example.invalid',companyId='synthetic-company',adminCompany='synthetic-admin-company',staffId='synthetic-staff',uid='synthetic-user';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex'),indexPath='emailIndex/'+hash(staffEmail),profilePath='staffProfiles/'+staffId;
const auth={uid,token:{}};
function harness(){
 const records=new Map([[indexPath,{companyId,staffId,active:true}],[profilePath,{companyId,active:true,displayName:'Synthetic Staff'}]]),reads=[],writes=[],claims=[],userReads=[];
 const user={uid,email:staffEmail,emailVerified:true,customClaims:undefined};const users=new Map([[uid,user]]);let failAuth=false,failDb=false;
 const copy=x=>x instanceof Timestamp?x:Array.isArray(x)?x.map(copy):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,copy(v)])):x;
 const snapshot=path=>{const exists=records.has(path),data=copy(records.get(path));return {id:path.split('/').at(-1),exists,data:()=>copy(data)};};
 const reference=path=>({path,get:async()=>{reads.push({path});if(failDb)throw Error('synthetic database unavailable');return snapshot(path);}});
 const query=(path,filters=[],orders=[],limit=Infinity)=>({doc:id=>reference(path+'/'+id),where:(...args)=>query(path,[...filters,args],orders,limit),orderBy:(...args)=>query(path,filters,[...orders,args],limit),limit:n=>query(path,filters,orders,n),add:async data=>{if(failDb)throw Error('synthetic database unavailable');writes.push({path:path+'/synthetic-audit',data});},get:async()=>{reads.push({path,filters,orders,limit});if(failDb)throw Error('synthetic database unavailable');const docs=[...records].filter(([key,value])=>key.startsWith(path+'/')&&filters.every(([field,op,expected])=>{assert.equal(op,'==');return value[field]===expected;})).slice(0,limit).map(([key])=>snapshot(key));return {docs};}});
 const metrics={transactionRetries:0,activeTransactions:0,maxActiveTransactions:0};
 let beforeCommit;
 function stage(staged,ref,data,options){
  staged.push({path:ref.path,data,merge:options?.merge});
 }
 function commit(staged){
  if(failDb)throw Error('synthetic database unavailable');
  writes.push(...staged);
  for(const w of staged)records.set(w.path,w.merge?{...records.get(w.path),...w.data}:w.data);
 }
 async function runBeforeCommit(staged){
  const callback=beforeCommit;
  beforeCommit=undefined;
  await callback?.(staged);
 }
 function addUser(account){
  assert.ok(!users.has(account.uid));
  users.set(account.uid,account);
 }
 const db={
  collection:path=>query(path),
  batch:()=>{
   const staged=[];
   return {
    set:(ref,data,options)=>stage(staged,ref,data,options),
    commit:async()=>{await runBeforeCommit(staged);commit(staged);},
   };
  },
  runTransaction:async callback=>{
   metrics.activeTransactions++;
   metrics.maxActiveTransactions=Math.max(metrics.maxActiveTransactions,metrics.activeTransactions);
   try {
    for(let attempt=0;attempt<8;attempt++){
     const staged=[],versions=new Map();
     const result=await callback({
      get:async ref=>{
       assert.equal(staged.length,0,'all reads must precede writes');
       const entry=await ref.get();
       versions.set(ref.path,JSON.stringify(entry.data()));
       return entry;
      },
      set:(ref,data,options)=>stage(staged,ref,data,options),
     });
     await runBeforeCommit(staged);
     if([...versions].some(([key,observed])=>JSON.stringify(records.get(key))!==observed)){
      metrics.transactionRetries++;continue;
     }
     commit(staged);
     return result;
    }
    throw Error('synthetic transaction retry limit');
   } finally {
    metrics.activeTransactions--;
   }
  },
 };
 const boundaries={'./firebase':{db,auth:{getUser:async id=>{userReads.push(id);assert.ok(users.has(id));return copy(users.get(id));},setCustomUserClaims:async(id,value)=>{if(failAuth)throw Error('synthetic claims unavailable');assert.ok(users.has(id));claims.push(copy(value));}}},'firebase-functions/v2/https':{HttpsError,onCall:(...args)=>args.at(-1)},'firebase-functions/params':{defineString:name=>({value:()=>name==='ADMIN_EMAILS'?adminEmail:adminCompany})},'firebase-admin/firestore':{Timestamp,FieldValue:{serverTimestamp:()=>Timestamp.fromMillis(1000),arrayUnion:(...values)=>values}}};
 const modules={};function load(name){if(Object.hasOwn(boundaries,name))return boundaries[name];if(['./utils','./staff-session'].includes(name)){if(!modules[name]){const exports={};const code=name==='./utils'?utilCode:ts.transpileModule(fs.readFileSync('functions/src/staff-session.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;runInNewContext(code,{exports,require:load,console,Date});modules[name]=exports;}return modules[name];}assert.ok(!name.startsWith('./'),'unmocked local boundary '+name);return require(name);}
 const exports={};runInNewContext(compiled,{exports,require:load,console,Date});
 return {records,reads,writes,claims,user,userReads,addUser,onCommit:value=>{beforeCommit=value;},metrics,failAuth:()=>{failAuth=true;},failDb:()=>{failDb=true;},call:(data={},session=auth)=>exports.bootstrapSession({data,auth:session})};
}
const results=[];async function test(name,run){try{await run();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.stack});}}
const plain=x=>JSON.parse(JSON.stringify(x));
await test('有効なスタッフは登録会社と本人だけの権限になる',async()=>{const h=harness();const r=await h.call({companyId:'forged-company',role:'admin',staffId:'forged-staff'});assert.deepEqual(plain(r),{role:'staff',companyId,staffId,refreshToken:true});assert.deepEqual(h.claims,[{role:'staff',companyId,staffId}]);assert.equal(h.records.get('authIdentities/'+uid).companyId,companyId);assert.equal(h.records.get('authIdentities/'+uid).staffId,staffId);assert.deepEqual(plain(h.records.get(profilePath).authUids),[uid]);});
await test('同じ権限なら不要な認証更新をせずログイン記録を保存',async()=>{const h=harness();h.user.customClaims={role:'staff',companyId,staffId};assert.equal((await h.call()).refreshToken,false);assert.equal(h.claims.length,0);assert.equal(h.writes.length,2);});
await test('古い管理者権限や余分な権限をスタッフに残さない',async()=>{const h=harness();h.user.customClaims={role:'admin',companyId:'old-company',extra:true};await h.call();assert.deepEqual(h.claims,[{role:'staff',companyId,staffId}]);});
await test('メールの前後空白・大文字は正規化して登録を照合',async()=>{const h=harness();h.user.email='  '+staffEmail.toUpperCase()+'  ';await h.call();assert.equal(h.claims[0].staffId,staffId);});
for(const [name,change]of [
 ['別会社プロフィール',h=>h.records.get(profilePath).companyId='foreign'],['会社不明プロフィール',h=>delete h.records.get(profilePath).companyId],['停止プロフィール',h=>h.records.get(profilePath).active=false],['文字列activeプロフィール',h=>h.records.get(profilePath).active='true'],['プロフィールなし',h=>h.records.delete(profilePath)],
 ['停止index',h=>h.records.get(indexPath).active=false],['文字列active index',h=>h.records.get(indexPath).active='true'],['数値active index',h=>h.records.get(indexPath).active=1],['indexなし',h=>h.records.delete(indexPath)],
 ['空会社',h=>h.records.get(indexPath).companyId=''],['空白会社',h=>h.records.get(indexPath).companyId=' '],['数値会社',h=>h.records.get(indexPath).companyId=123],['slash会社',h=>h.records.get(indexPath).companyId='a/b'],['制御文字会社',h=>h.records.get(indexPath).companyId='a\0b'],['staffId欠落',h=>delete h.records.get(indexPath).staffId],['数値staffId',h=>h.records.get(indexPath).staffId=123],['slash staffId',h=>h.records.get(indexPath).staffId='a/b'],['backslash staffId',h=>h.records.get(indexPath).staffId='a\\b'],
 ])await test(name+'は権限更新・DB書込前に拒否',async()=>{const h=harness();change(h);await assert.rejects(h.call(),e=>e.code==='permission-denied');assert.equal(h.claims.length,0);assert.equal(h.writes.length,0);});
for(const [name,email,verified]of [['未確認メール',staffEmail,false],['メールなし','',true]])await test(name+'はDB読取前に拒否',async()=>{const h=harness();h.user.email=email;h.user.emailVerified=verified;await assert.rejects(h.call(),e=>e.code==='failed-precondition');assert.equal(h.reads.length,0);assert.equal(h.claims.length,0);assert.equal(h.writes.length,0);});
await test('未認証はAuthとDBを参照しない',async()=>{const h=harness();await assert.rejects(h.call({},null),e=>e.code==='unauthenticated');assert.equal(h.userReads.length,0);assert.equal(h.reads.length,0);assert.equal(h.writes.length,0);});
await test('管理者はサーバー側の許可メールと既定会社だけを使う',async()=>{const h=harness();h.user.email=adminEmail;h.records.set('jobs/own',{companyId:adminCompany,workDate:'2026-10-01'});h.records.set('jobs/foreign',{companyId:'foreign',workDate:'2026-10-01'});h.records.set('staffProfiles/admin-company-staff',{companyId:adminCompany,displayName:'Synthetic'});const r=await h.call({companyId:'forged'});assert.equal(r.role,'admin');assert.equal(r.companyId,adminCompany);assert.deepEqual(h.claims,[{role:'admin',companyId:adminCompany}]);assert.equal(r.jobs.length,1);assert.equal(r.staff.length,1);assert.ok(h.reads.filter(q=>q.filters).every(q=>q.filters[0][2]===adminCompany));assert.equal(h.writes[0].data.companyId,adminCompany);});
await test('ディレクトリ更新は認証済み管理者の会社に限定',async()=>{const h=harness();const r=await h.call({refreshDirectory:true,companyId:'forged'},{uid,token:{role:'admin',companyId}});assert.equal(r.refreshToken,false);assert.equal(h.userReads.length,0);assert.equal(h.claims.length,0);assert.equal(h.writes.length,0);assert.equal(h.reads.length,2);assert.ok(h.reads.every(q=>q.filters[0][2]===companyId));assert.deepEqual(h.reads.map(q=>q.limit),[100,500]);});
for(const [name,session,code]of [['未認証',null,'unauthenticated'],['スタッフ',{uid,token:{role:'staff',companyId}},'permission-denied'],['会社不明',{uid,token:{role:'admin'}},'failed-precondition']])await test('ディレクトリ更新の'+name+'を読取前に拒否',async()=>{const h=harness();await assert.rejects(h.call({refreshDirectory:true},session),e=>e.code===code);assert.equal(h.reads.length,0);assert.equal(h.userReads.length,0);});
await test('認証サービスの失敗をログイン成功として返さない',async()=>{const h=harness();h.failAuth();await assert.rejects(h.call(),/synthetic claims unavailable/);assert.equal(h.claims.length,0);});
await test('DB読取失敗を未登録やログイン成功に置き換えない',async()=>{const h=harness();h.failDb();await assert.rejects(h.call(),/synthetic database unavailable/);assert.equal(h.claims.length,0);assert.equal(h.writes.length,0);});
for (const [name,account,token] of [
 ['停止中のFirebase利用者',{disabled:true},{auth_time:110}],
 ['失効より古い認証時刻',{tokensValidAfterTime:new Date(100000).toISOString()},{auth_time:99,iat:120}],
 ['認証時刻のないトークン',{tokensValidAfterTime:new Date(100000).toISOString()},{iat:120}],
 ['壊れた失効情報',{tokensValidAfterTime:'unknown'},{auth_time:110}],
]) await test(name+'は権限を再登録できない',async()=>{
 const h=harness();Object.assign(h.user,account);
 h.records.set('authIdentities/'+uid,{companyId,staffId,active:false});
 await assert.rejects(h.call({},{uid,token}),e=>e.code==='permission-denied');
 assert.equal(h.claims.length,0);assert.equal(h.writes.length,0);
 assert.equal(h.records.get('authIdentities/'+uid).active,false);
});
await test('失効後の新しい認証は元の本人の権限で復帰できる',async()=>{
 const h=harness();h.user.tokensValidAfterTime=new Date(100000).toISOString();
 const identity={companyId,staffId,active:false,revokedAt:Timestamp.fromMillis(100100)};
 h.records.set('authIdentities/'+uid,identity);
 const result=await h.call({},{uid,token:{auth_time:101}});
 assert.deepEqual(plain(result),{role:'staff',companyId,staffId,refreshToken:true});
 assert.equal(h.records.get('authIdentities/'+uid).active,true);
 assert.equal(h.records.get('authIdentities/'+uid).revokedAt,identity.revokedAt);
});
const identityPath='authIdentities/'+uid;
const sessionAt=auth_time=>({uid,token:{auth_time}});
const validIdentity={companyId,staffId,active:true};
for(const [name,identity] of [
 ['another company',{...validIdentity,companyId:'foreign'}],
 ['another staff member',{...validIdentity,staffId:'other'}],
 ['inactive without a revocation record',{...validIdentity,active:false}],
 ['malformed revocation',{...validIdentity,revokedAt:'bad'}],
 ['same second with a later revocation',{...validIdentity,active:false,revokedAt:new Timestamp(100,1)}],
]) await test('reauthorisation rejects '+name,async()=>{
 const h=harness();
 h.records.set(identityPath,identity);
 await assert.rejects(h.call({},sessionAt(100)),e=>e.code==='permission-denied');
 assert.deepEqual(h.records.get(identityPath),identity);
 assert.equal(h.writes.length,0);
 assert.equal(h.claims.length,0);
});
for(const [name,change] of [
 ['profile is disabled',h=>h.records.set(profilePath,{...h.records.get(profilePath),active:false})],
 ['email index is deactivated',h=>h.records.set(indexPath,{...h.records.get(indexPath),active:false})],
 ['identity is revoked',h=>h.records.set(identityPath,{...validIdentity,active:false,revokedAt:new Timestamp(100,1)})],
]) await test('concurrent bootstrap stops when '+name,async()=>{
 const h=harness();
 h.records.set(identityPath,validIdentity);
 h.onCommit(()=>change(h));
 await assert.rejects(h.call({},sessionAt(100)),e=>e.code==='permission-denied');
 assert.equal(h.metrics.transactionRetries,1);
 assert.equal(h.writes.length,0);
 assert.equal(h.claims.length,0);
});
await test('concurrent bootstrap resumes for the same staff after a newer authentication',async()=>{
 const h=harness(),revokedAt=new Timestamp(100,1);
 h.records.set(identityPath,validIdentity);
 h.onCommit(()=>h.records.set(identityPath,{...validIdentity,active:false,revokedAt}));
 const resumed=await h.call({},sessionAt(101));
 assert.equal(resumed.staffId,staffId);
 assert.equal(h.metrics.transactionRetries,1);
 assert.equal(h.records.get(identityPath).active,true);
 assert.equal(h.records.get(identityPath).revokedAt,revokedAt);
 assert.equal(h.writes.length,2);
 assert.equal(h.claims.length,1);
});
for(const size of [50,100,300]) await test(size+' concurrent staff bootstraps are isolated',async()=>{
 const h=harness();
 const accounts=Array.from({length:size},(_,index)=>{
  const email='staff-'+index+'@example.invalid',id='staff-'+index,account='uid-'+index,scope=index%2?'synthetic-a':'synthetic-b';
  const expected={role:'staff',companyId:scope,staffId:id};
  h.addUser({uid:account,email,emailVerified:true,customClaims:expected});
  h.records.set('emailIndex/'+hash(email),{companyId:scope,staffId:id,active:true});
  h.records.set('staffProfiles/'+id,{companyId:scope,active:true});
  return {expected,account};
 });
 const results=await Promise.all(accounts.map(({account})=>h.call({},{uid:account,token:{auth_time:101}})));
 assert.equal(h.metrics.maxActiveTransactions,size);
 assert.equal(h.metrics.transactionRetries,0);
 assert.equal(h.writes.length,2*size);
 assert.equal(h.claims.length,0);
 for(const [index,{account,expected}] of accounts.entries()){
  assert.deepEqual(plain(results[index]),{...expected,refreshToken:false});
  const identity=h.records.get('authIdentities/'+account);
  assert.equal(identity.companyId,expected.companyId);
  assert.equal(identity.staffId,expected.staffId);
  assert.deepEqual(plain(h.records.get('staffProfiles/'+expected.staffId).authUids),[account]);
 }
});


const slot='device_'+'c'.repeat(28),generation='d'.repeat(48);
for(const mode of ['matching','unbound','stopped','old-generation','wrong-index','admin-claim']){
 await test('device-bound bootstrap '+mode,async()=>{
  const h=harness(),index=h.records.get(indexPath);
  Object.assign(h.records.get(profilePath),{deviceBoundAuthRequired:true,authUids:[uid]});
  h.records.set('authIdentities/'+uid,{companyId,staffId,active:true,emailHash:hash(staffEmail),deviceCredentials:{[slot]:mode==='stopped'?null:generation}});
  if(mode==='wrong-index')index.active=false;
  const token={role:mode==='admin-claim'?'admin':'staff',companyId,staffId,auth_time:120,
   ...(mode==='unbound'?{}:{crewDeviceSession:slot,crewDeviceGeneration:mode==='old-generation'?'e'.repeat(48):generation})};
  if(mode==='matching')assert.deepEqual(plain(await h.call({},{uid,token})),{role:'staff',companyId,staffId,refreshToken:false});
  else await assert.rejects(()=>h.call({},{uid,token}),{code:'permission-denied'});
  assert.equal(h.claims.length,0);assert.equal(h.writes.length,0);
 });
}

console.log(JSON.stringify({total:results.length,passed:results.filter(x=>x.passed).length,actualCloudAccess:false,results},null,2));if(results.some(x=>!x.passed))process.exitCode=1;
