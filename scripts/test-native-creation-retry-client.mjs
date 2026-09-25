import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url),ts=require('typescript');
function load(file,deps={}){const exports={};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;Function('exports','require',...Object.keys(deps),code)(exports,name=>{if(!(name in deps))throw Error('Unexpected import '+name);return deps[name];},...Object.values(deps));return exports;}
const engine=load('apps/admin/src/native-creation-retry.ts'),{executeNativeAttempt:execute,readNativeAttempt:read,nativeAttemptKey:key}=engine;
const owner={companyId:'synthetic-company',uid:'synthetic-admin'};
function deferred(){let resolve;return {promise:new Promise(r=>resolve=r),resolve};}
function setup(){
 const records=new Map(),held=new Set(),calls=[];let changed=0;
 const storage={getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 const locks={request:async(k,_options,fn)=>{if(held.has(k))return fn(null);held.add(k);try{return await fn({name:k});}finally{held.delete(k);}}};
 const response=(kind,payload)=>({nativeCreationReceipt:{version:1,kind,companyId:payload.nativeCreation.expectedCompanyId,actorUid:payload.nativeCreation.expectedActorUid,operationId:payload.nativeCreation.operationId,status:payload.nativeCreation.action==='cancel'?'cancelled':'committed'},groupId:'group',jobIds:['job']});
 const options={owner,storage,locks,uuid:randomUUID,current:async()=>true,changed:()=>changed++,call:async(kind,payload)=>{calls.push({kind,payload});return response(kind,payload);}};
 return {options,records,calls,response,changes:()=>changed};
}
const input={workDate:'2026-10-10',slots:2,clientName:'合成会社'};
const start=kind=>({kind,input});let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
for(const kind of ['create','duplicate']){
 await test(kind+'/応答喪失・再読込後も同じ操作IDと入力',async()=>{
  const h=setup();let lost=true;h.options.call=async(k,p)=>{h.calls.push({kind:k,payload:p});if(lost){lost=false;throw Error('lost');}return h.response(k,p);};
  await assert.rejects(execute({...h.options,start:start(kind)}),/lost/);const saved=read(h.options.storage,owner);assert.ok(saved);assert.equal(h.calls[0].payload.workDate,undefined);assert.equal(h.calls[0].payload.nativeCreation.operationId,saved.operationId);
  await assert.rejects(execute({...h.options,start:{kind,input:{slots:9}}}),/未確認/);assert.equal(h.calls.length,1);
  const reloaded=load('apps/admin/src/native-creation-retry.ts');const result=await reloaded.executeNativeAttempt(h.options);assert.equal(result.nativeCreationReceipt.status,'committed');assert.deepEqual(h.calls[0].payload,h.calls[1].payload);assert.equal(read(h.options.storage,owner),null);
 });
 await test(kind+'/エラー後の取消は同じ依頼をサーバー照合',async()=>{
  const h=setup();const normal=h.options.call;h.options.call=async()=>{throw Error('offline');};await assert.rejects(execute({...h.options,start:start(kind)}));const saved=read(h.options.storage,owner);h.options.call=normal;
  const result=await execute({...h.options,cancel:true});assert.equal(result.nativeCreationReceipt.status,'cancelled');assert.equal(h.calls[0].payload.nativeCreation.operationId,saved.operationId);assert.deepEqual(h.calls[0].payload.nativeCreation.input,saved.input);assert.equal(read(h.options.storage,owner),null);
 });
 await test(kind+'/取消時に作成済みなら作成結果を採用',async()=>{
  const h=setup();h.options.call=async()=>{throw Error('lost');};await assert.rejects(execute({...h.options,start:start(kind)}));h.options.call=async(k,p)=>h.response(k,{nativeCreation:{...p.nativeCreation,action:'create'}});const result=await execute({...h.options,cancel:true});assert.equal(result.nativeCreationReceipt.status,'committed');assert.equal(read(h.options.storage,owner),null);
 });
 await test(kind+'/複数タブの二重操作を共有ロックで止める',async()=>{
  const h=setup(),wait=deferred(),called=deferred();h.options.call=async(k,p)=>{h.calls.push(p);called.resolve();await wait.promise;return h.response(k,p);};
  const first=execute({...h.options,start:start(kind)});await called.promise;await assert.rejects(execute({...h.options,start:start(kind)}),/別の画面/);await assert.rejects(execute({...h.options,cancel:true}),/別の画面/);assert.equal(h.calls.length,1);wait.resolve();await first;
 });
 await test(kind+'/送信中の認証切替は結果と保持依頼を触らない',async()=>{
  const h=setup(),wait=deferred(),called=deferred();let active=true;h.options.current=async()=>active;h.options.call=async(k,p)=>{called.resolve();await wait.promise;return h.response(k,p);};const pending=execute({...h.options,start:start(kind)});await called.promise;active=false;wait.resolve();assert.equal(await pending,null);assert.ok(read(h.options.storage,owner));
 });
}
for(const failure of ['set','readback','locks','corrupt','read'])await test('端末保存保護/'+failure,async()=>{
 const h=setup();if(failure==='set')h.options.storage.setItem=()=>{throw Error('quota');};if(failure==='readback')h.options.storage.setItem=()=>{};if(failure==='locks')h.options.locks={};if(failure==='corrupt')h.records.set(key(owner),'broken');if(failure==='read')h.options.storage.getItem=()=>{throw Error('blocked');};await assert.rejects(execute({...h.options,start:start('create')}));assert.equal(h.calls.length,0);
});
for(const bad of ['missing','companyId','actorUid','operationId','kind','status','jobs'])await test('照合できない応答は保存依頼を残す/'+bad,async()=>{
 const h=setup();h.options.call=async(k,p)=>{const r=h.response(k,p);if(bad==='missing')delete r.nativeCreationReceipt;else if(bad==='jobs')r.jobIds=[];else r.nativeCreationReceipt[bad]='wrong';return r;};await assert.rejects(execute({...h.options,start:start('create')}),/照合/);assert.ok(read(h.options.storage,owner));
});
await test('異なる会社・管理者の依頼は読み出さない',async()=>{const h=setup();h.options.call=async()=>{throw Error('lost');};await assert.rejects(execute({...h.options,start:start('create')}));assert.equal(read(h.options.storage,{...owner,companyId:'other'}),null);assert.equal(read(h.options.storage,{...owner,uid:'other'}),null);});
await test('古い応答が新しい保存依頼を消さない',async()=>{const h=setup();let newer;h.options.call=async(k,p)=>{newer={...read(h.options.storage,owner),operationId:randomUUID()};h.options.storage.setItem(key(owner),JSON.stringify(newer));return h.response(k,p);};await execute({...h.options,start:start('create')});assert.deepEqual(read(h.options.storage,owner),newer);});
await test('画面入力が変わっても送信中の内容を保持',async()=>{const h=setup(),mutable={...input};h.options.call=async(k,p)=>{mutable.slots=7;assert.equal(p.nativeCreation.input.slots,2);throw Error('lost');};await assert.rejects(execute({...h.options,start:{kind:'create',input:mutable}}));assert.equal(read(h.options.storage,owner).input.slots,2);});
// Firebase接続境界だけを合成化し、実際の認証ブリッジも評価する。
function bridgeSetup(){
 const h=setup();let claims={companyId:owner.companyId,role:'admin'},calls=0;
 const user={uid:owner.uid,getIdTokenResult:async()=>({claims:{...claims}})},firebase={auth:{currentUser:user},functions:{}};
 const deps={'./firebase':firebase,'./native-creation-retry':engine,'firebase/functions':{httpsCallable:(_f,name)=>async payload=>{calls++;await h.wait?.();return {data:h.response(name==='createAdminJobGroup'?'create':'duplicate',payload)};}}};
 const exports={},code=ts.transpileModule(fs.readFileSync('apps/admin/src/native-creation-client.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 Function('exports','require','window','navigator','crypto','Event',code)(exports,name=>deps[name],{localStorage:h.options.storage,dispatchEvent:()=>{}},{locks:h.options.locks},{randomUUID},class{});
 return {...h,bridge:exports.submitNativeCreation,firebase,setClaims:value=>claims=value,calls:()=>calls};
}
await test('認証ブリッジの会社切替はAPIを呼ばない',async()=>{const h=bridgeSetup();h.setClaims({companyId:'other',role:'admin'});await assert.rejects(h.bridge(start('create'),()=>true,false,owner));assert.equal(h.calls(),0);});
await test('同じUserオブジェクトの会社claim切替でも古い応答を抑止',async()=>{const h=bridgeSetup();const original=h.firebase.auth.currentUser.getIdTokenResult;let count=0;h.firebase.auth.currentUser.getIdTokenResult=async()=>{if(++count===4)return {claims:{role:'admin',companyId:'other'}};return original();};const result=await h.bridge(start('create'),()=>true);assert.equal(result,null);assert.equal(h.calls(),1);assert.ok(read(h.options.storage,owner));});
console.log(`Native creation client: ${passed} cases passed (synthetic storage/locks/API; external calls 0).`);
