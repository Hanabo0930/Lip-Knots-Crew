import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {localAcceptanceEnvironment,blockNonEmulatorConnections} from './local-firestore-acceptance-safety.mjs';
const environment=localAcceptanceEnvironment(process.env),network=blockNonEmulatorConnections(environment.port);
const require=createRequire(import.meta.url),{Timestamp,Query}=require('firebase-admin/firestore');
const {db}=require('../functions/lib/firebase.js');
const {cleanupExpiredLoginTokens}=require('../functions/lib/login-links.js');
const originalGet=Query.prototype.get;
let afterQuery=null,sequence=0;
Query.prototype.get=async function(...args){const result=await originalGet.apply(this,args);if(afterQuery)await afterQuery(result);return result;};
const clean=()=>cleanupExpiredLoginTokens.run({});
const results=[];
async function fixture(){
 const id='synthetic-cleanup-'+(++sequence),gateway=db.doc('loginGatewayTokens/'+id),rate=db.doc('loginLinkRateLimits/'+id);
 const expired=Timestamp.fromMillis(Date.now()-60000),future=Timestamp.fromMillis(Date.now()+3600000);
 await gateway.set({expiresAt:expired,active:true,synthetic:true});
 await rate.set({loginCodeExpiresAt:expired,loginCodeHash:'old-synthetic-code',loginCodeActive:true,count:3,lastRequestedAt:expired});
 return {gateway,rate,expired,future};
}
async function test(name,body){try{await body();results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:String(error.stack??error)});console.error('FAIL '+name+' '+error.message);}finally{afterQuery=null;}}
try{
 await test('期限切れトークンを削除しコードだけを消す',async()=>{
  const h=await fixture();await clean();assert.equal((await h.gateway.get()).exists,false);
  const rate=(await h.rate.get()).data();assert.equal(rate.loginCodeHash,undefined);assert.equal(rate.loginCodeExpiresAt,undefined);assert.equal(rate.count,3);assert.ok(rate.lastRequestedAt.isEqual(h.expired));
 });
 await test('有効期限内の情報を保持',async()=>{
  const h=await fixture();await h.gateway.update({expiresAt:h.future});await h.rate.update({loginCodeExpiresAt:h.future});await clean();
  assert.equal((await h.gateway.get()).exists,true);assert.equal((await h.rate.get()).data().loginCodeHash,'old-synthetic-code');
 });
 await test('検索後の新規コード発行を消さない',async()=>{
  const h=await fixture();let changed=false;
  afterQuery=async result=>{if(!changed&&result.docs.some(d=>d.ref.path===h.rate.path)){changed=true;await h.rate.update({loginCodeExpiresAt:h.future,loginCodeHash:'new-synthetic-code',loginCodeActive:true});}};
  await clean();assert.equal(changed,true);const rate=(await h.rate.get()).data();assert.equal(rate.loginCodeHash,'new-synthetic-code');assert.ok(rate.loginCodeExpiresAt.isEqual(h.future));assert.equal(rate.loginCodeActive,true);
 });
 await test('検索後に更新されたトークンを消さない',async()=>{
  const h=await fixture();let changed=false;
  afterQuery=async result=>{if(!changed&&result.docs.some(d=>d.ref.path===h.gateway.path)){changed=true;await h.gateway.update({expiresAt:h.future});}};
  await clean();assert.equal(changed,true);assert.equal((await h.gateway.get()).exists,true);
 });
 await test('検索後のコード文書削除で他の清掃を失敗させない',async()=>{
  const h=await fixture();let changed=false;
  afterQuery=async result=>{if(!changed&&result.docs.some(d=>d.ref.path===h.rate.path)){changed=true;await h.rate.delete();}};
  await clean();assert.equal(changed,true);assert.equal((await h.gateway.get()).exists,false);assert.equal((await h.rate.get()).exists,false);
 });
 await test('重複する清掃が両方成功する',async()=>{
  const h=await fixture();await Promise.all([clean(),clean()]);assert.equal((await h.gateway.get()).exists,false);assert.equal((await h.rate.get()).data().loginCodeHash,undefined);
 });
 await test('検索後にコードを消した文書の他の値を保持',async()=>{
  const h=await fixture();let changed=false;
  afterQuery=async result=>{if(!changed&&result.docs.some(d=>d.ref.path===h.rate.path)){changed=true;await h.rate.set({count:9});}};
  await clean();assert.equal(changed,true);assert.deepEqual((await h.rate.get()).data(),{count:9});
 });
 await test('各検索250件の上限を維持し残りは次回に清掃',async()=>{
  const expired=Timestamp.fromMillis(Date.now()-60000),gateways=[],rates=[];
  for(const [collection,refs,field] of [['loginGatewayTokens',gateways,'expiresAt'],['loginLinkRateLimits',rates,'loginCodeExpiresAt']]){
   const batch=db.batch();for(let i=0;i<251;i++){const ref=db.doc(collection+'/synthetic-limit-'+i);refs.push(ref);batch.set(ref,{[field]:expired,loginCodeHash:'synthetic',count:4});}await batch.commit();
  }
  await clean();assert.equal((await db.getAll(...gateways)).filter(d=>d.exists).length,1);assert.equal((await db.getAll(...rates)).filter(d=>d.data()?.loginCodeExpiresAt).length,1);
  await clean();assert.equal((await db.getAll(...gateways)).filter(d=>d.exists).length,0);assert.ok((await db.getAll(...rates)).every(d=>d.data().count===4&&d.data().loginCodeHash===undefined));
 });

}finally{
 Query.prototype.get=originalGet;await db.terminate();const stats=network.stats();network.restore();
 const result={project:environment.project,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length+(stats.blocked?1:0),network:stats,firestore:'real SDK / local emulator',realMessages:0,realBusinessWrites:0,results};
 fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:result.passed,failed:result.failed,network:stats}));if(result.failed)process.exitCode=1;
}
