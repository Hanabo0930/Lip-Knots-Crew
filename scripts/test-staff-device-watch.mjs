
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';

const dependency = createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT || process.cwd(), 'package.json'));
const ts = dependency('typescript');
const source = fs.readFileSync('apps/staff/src/App.tsx', 'utf8');
const compile = text => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function part(start, end, from = 0) {
  const a = source.indexOf(start, from), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const marker = source.indexOf('    if(!user||!companyId||!staffId||!functions||!db||!auth||sessionRevoked)return;');
// Extract the full effect rather than recreating its state transitions.
const watchStart = source.lastIndexOf('  useEffect(()=>{', marker);
const watchEnd = source.indexOf('  useEffect(()=>{', marker);
const sharing = source.includes('  function isDeviceAccessDenied(')
  ? part('  async function registerCurrentDevice(', '  async function logoutCurrentUser()')
  : '';
const clientCode = compile(sharing + part('  function watchDeviceSession(', '  function isCurrentDevice(') + source.slice(watchStart, watchEnd));
const flush = () => new Promise(resolve => setImmediate(resolve));
const results = [];
async function test(name, run) {
  try { await run(); results.push({name, passed:true}); }
  catch (error) { results.push({name, passed:false, error:error.message}); }
}

function browser({deviceSessionId='synthetic-device'}={}) {
  const state = { revoked:false, account:'synthetic-user', devices:'synthetic-device', calls:[], signouts:[], messages:[], cleared:[],
    visibilityReads:0, unsubscribed:0 };
  let cleanup, interval, visible, online, snapshot, listenerFailure;
  const ctx = { user:{uid:'synthetic-user'}, deviceSessionId, sessionRevoked:false, functions:{}, db:{}, auth:{},
    currentDeviceId:'synthetic-browser', deviceLabel:()=> 'synthetic browser', navigator:{platform:'test',userAgent:'synthetic'},
    companyId:'synthetic-company', staffId:'synthetic-staff', authLoadVersionRef:{current:1}, DEVICE_HEARTBEAT_INTERVAL_MS:60000,
    isShiftAccessDenied:error=>error?.code==='permission-denied'||error?.code==='functions/permission-denied',
    useEffect:fn=>{cleanup=fn();},
    run:async (key,task)=>{assert.equal(key,"logout");await task();},
    httpsCallable:(_functions,name)=>data=>new Promise((resolve,reject)=>{state.calls.push({name,data,resolve,reject});}),
    setMessage:message=>state.messages.push(message),
    clearBusinessSnapshot:(...scope)=>state.cleared.push(scope),
    forgetInaccessibleShifts:(_id,...scope)=>state.cleared.push(scope),
    setDeviceSessionId:id=>{state.devices=id;},
    setPendingDeviceId:()=>{}, setCompanyId:id=>{state.company=id;}, setStaffId:id=>{state.staff=id;},
    setSessionRevoked:value=>{state.revoked=value;},
    signOut:()=>new Promise((resolve,reject)=>{state.signouts.push({resolve,reject,revokedAtCall:state.revoked});}),
    doc:(_db,name,id)=>{assert.equal(name,'deviceSessions');assert.equal(id,'synthetic-device');return {id};},
    onSnapshot(_document,options,next,onError) {
      snapshot=typeof options==='function'?options:next;
      listenerFailure=onError;
      return ()=>{state.unsubscribed++;};
    },
    window:{setInterval:fn=>{interval=fn;return 1;},clearInterval:()=>{},addEventListener:(event,fn)=>{assert.equal(event,'online');online=fn;},removeEventListener:()=>{}},
    document:{visibilityState:'visible',addEventListener:(_event,fn)=>{visible=fn;},removeEventListener:()=>{}},
    refreshPushStatus:()=>{state.visibilityReads++;},refreshBusinessData:()=>{state.visibilityReads++;},
  };
  runInNewContext(clientCode,ctx);
  return {state,ctx,cleanup,timer:()=>interval(),visible:()=>visible(),online:()=>online(),
    snapshot({cached=false,exists=true,active=true}={}){snapshot({metadata:{fromCache:cached},exists:()=>exists,data:()=>({active})});},
    listenerFailure:error=>listenerFailure?.(error),
  };
}
for (const source of ['heartbeat','watch','permission-listener','server-deletion','unauthenticated']) {
  await test('A confirmed device denial hides business data before sign-out via '+source,async()=>{
    const h=browser();
    if(source==='heartbeat')h.state.calls[0].reject({code:'functions/permission-denied'});
    if(source==='watch')h.snapshot({active:false});
    if(source==='permission-listener')h.listenerFailure({code:'permission-denied'});
    if(source==='server-deletion')h.snapshot({exists:false});
    if(source==='unauthenticated')h.state.calls[0].reject({code:'functions/unauthenticated'});
    await flush();
    assert.equal(h.state.revoked,true);
    assert.equal(h.state.signouts.length,1);
    assert.equal(h.state.signouts[0].revokedAtCall,true);
    assert.equal(h.state.devices,'');
    assert.equal(h.ctx.authLoadVersionRef.current,2);
    h.state.signouts[0].reject(new Error('local sign-out failed'));await flush();
    assert.equal(h.state.revoked,true);
    assert.equal(h.state.cleared.length,1);
    h.visible();h.timer();h.snapshot({active:false});await flush();
    assert.equal(h.state.visibilityReads,0);
    assert.equal(h.state.signouts.length,1);
    assert.equal(h.state.calls.length,1);
    h.cleanup();assert.equal(h.state.unsubscribed,1);
  });
}
await test('Cached inactive or missing snapshots and transient network errors stay recoverable',async()=>{
  const h=browser();
  h.snapshot({cached:true,active:false});
  h.snapshot({cached:true,exists:false});
  h.listenerFailure({code:'unavailable'});
  h.timer();void h.visible();assert.equal(h.state.calls.length,1);assert.equal(h.state.visibilityReads,0);
  h.state.calls[0].reject({code:'functions/unavailable'});await flush();
  void h.visible();h.timer();assert.equal(h.state.calls.length,2);assert.equal(h.state.visibilityReads,0);
  h.state.calls[1].resolve({data:{active:true}});await flush();
  assert.equal(h.state.revoked,false);assert.equal(h.state.signouts.length,0);assert.equal(h.state.visibilityReads,2);h.cleanup();
});
await test('Concurrent rejection and watch event sign out once; an older callback cannot affect a new user',async()=>{
  const h=browser();h.snapshot({active:false});
  h.state.calls[0].reject({code:'permission-denied'});await flush();
  assert.equal(h.state.signouts.length,1);assert.equal(h.state.cleared.length,1);
  const last=h.state.messages.length;++h.ctx.authLoadVersionRef.current;
  h.state.signouts[0].reject(new Error('late failure'));await flush();
  assert.equal(h.state.messages.length,last);
  const stale=browser();++stale.ctx.authLoadVersionRef.current;
  stale.snapshot({active:false});
  stale.state.calls[0].reject({code:'permission-denied'});await flush();
  assert.equal(stale.state.signouts.length,0);
  assert.equal(stale.state.revoked,false);
  h.cleanup();stale.cleanup();
});

await test('Verified scope starts device registration even before the business data is ready',async()=>{
  const h=browser({deviceSessionId:''});
  assert.equal(h.state.calls[0].name,'registerDeviceSession');
  assert.equal(h.state.calls[0].data.deviceId,'synthetic-browser');
  h.timer();void h.visible();void h.online();
  assert.equal(h.state.calls.length,1);
  assert.equal(h.state.visibilityReads,0);
  h.state.calls[0].resolve({data:{sessionId:'new-synthetic-device'}});
  await flush();
  assert.equal(h.state.devices,'new-synthetic-device');
  assert.equal(h.state.visibilityReads,2);
  h.cleanup();
});
await test('Coming back online retries an interrupted registration before refreshing data',async()=>{
  const h=browser({deviceSessionId:''});
  h.state.calls[0].reject({code:'functions/unavailable'});
  await flush();
  assert.equal(h.state.revoked,false);
  assert.equal(h.state.visibilityReads,0);
  const recovered=h.online();
  h.timer();void h.visible();
  assert.equal(h.state.calls.length,2);
  assert.equal(h.state.calls[1].name,'registerDeviceSession');
  assert.equal(h.state.visibilityReads,0);
  h.state.calls[1].resolve({data:{sessionId:'recovered-synthetic-device'}});
  await recovered;
  assert.equal(h.state.devices,'recovered-synthetic-device');
  assert.equal(h.state.visibilityReads,2);
  h.cleanup();
});
await test('A registration denial hides the old workspace without waiting for business reads',async()=>{
  const h=browser({deviceSessionId:''});
  void h.online();
  h.state.calls[0].reject({code:'functions/permission-denied'});
  await flush();
  assert.equal(h.state.revoked,true);
  assert.equal(h.state.visibilityReads,0);
  assert.equal(h.state.signouts.length,1);
  assert.equal(h.state.cleared.length,1);
  assert.equal(h.state.signouts[0].revokedAtCall,true);
  h.state.signouts[0].resolve();
  await flush();
  h.cleanup();
});
await test('A delayed registration cannot attach to a replacement account or refresh it',async()=>{
  const h=browser({deviceSessionId:''});
  const previous=h.visible();
  h.ctx.authLoadVersionRef.current++;
  h.state.calls[0].resolve({data:{sessionId:'old-synthetic-device'}});
  await previous;
  assert.notEqual(h.state.devices,'old-synthetic-device');
  assert.equal(h.state.visibilityReads,0);
  assert.equal(h.state.signouts.length,0);
  h.cleanup();
});
await test('Malformed heartbeats do not authorize a foreground refresh',async()=>{
  const h=browser();
  const refresh=h.visible();
  h.state.calls[0].resolve({data:{unexpected:true}});
  await refresh;
  assert.equal(h.state.visibilityReads,0);
  assert.equal(h.state.revoked,false);
  h.cleanup();
});


class HttpsError extends Error {
  constructor(code,message) { super(message);this.code=code; }
}
class Timestamp {
  constructor(seconds,nanoseconds=0){this.seconds=seconds;this.nanoseconds=nanoseconds;}
  toMillis(){return this.seconds*1000+this.nanoseconds/1_000_000;}
}
function service({boundDevice=false}={}) {
  const companyId='synthetic-company',staffId='synthetic-staff',uid='synthetic-user';
  const sessionId=boundDevice?'device_'+'a'.repeat(28):'synthetic-device-id',deviceId='synthetic-device-browser';
  const profile={companyId,active:true,authUids:[uid]},identity={companyId,staffId,active:true};
  const fields={companyId,staffId,uid,deviceId,active:true,lastSeenAt:'untouched'};
  const server={profile,identity,devices:new Map([[sessionId,fields]]),writes:[],reads:[],transactions:0,authCalls:[],operational:true};
  const stamp=Symbol('serverTimestamp');
  const lookup=(table,id)=>table==='staffProfiles'&&id===staffId?server.profile
    :table==='authIdentities'&&id===uid?server.identity
    :table==='deviceSessions'?server.devices.get(id):undefined;
  function ref(table,id) {
    const txRef={table,id,async get(){return snapshot(txRef);},
      async set(fields){server.writes.push(['set',table,id,fields]);}};
    return txRef;
  }
  function snapshot(ref) {
    server.reads.push([ref.table,ref.id]);
    const record=lookup(ref.table,ref.id), data=record&&{...record};
    return {id:ref.id,exists:!!data,data:()=>data,ref};
  }

  function query(table, filters=[], max=Infinity) {
    const q={table,filters,max,where(field,operator,value){
      assert.equal(operator,'==');return query(table,[...filters,[field,value]],max);
    },orderBy(field,direction){
      assert.equal(field,'lastSeenAt');assert.equal(direction,'desc');return q;
    },limit(count){return query(table,filters,count);},
    doc:id=>ref(table,id),get:async()=>readQuery(q),add:async record=>{server.writes.push(['add',table,null,record]);}};
    return q;
  }
  function readQuery(q) {
    server.reads.push([q.table,'query']);
    if(q.table==='deviceSessions'&&server.beforeDeviceQuery) {
      const change=server.beforeDeviceQuery;delete server.beforeDeviceQuery;change();
    }
    const source=q.table==='deviceSessions'?server.devices:new Map();
    const documents=Array.from(source).filter(([,item])=>q.filters.every(([field,value])=>item[field]===value));
    const docs=documents.slice(0,q.max).map(([id])=>snapshot(ref(q.table,id)));
    return {docs,size:docs.length};
  }
  const db = {
    collection:table=>query(table),
    async runTransaction(worker,options) {
      for (let attempt=0;attempt<2;attempt++){
        server.transactions++;
        const staged=[];
        const tx={get:async ref=>ref.filters?readQuery(ref):snapshot(ref),set:(ref,fields)=>staged.push(['set',ref.table,ref.id,fields]),
          update:(ref,fields)=>staged.push(['update',ref.table,ref.id,fields])};
        const result=await worker(tx);
        if(options?.readOnly)assert.equal(staged.length,0);
        if(staged.length&&server.beforeCommit){const edit=server.beforeCommit;delete server.beforeCommit;edit();continue;}
        server.writes.push(...staged);
        for(const [,table,id,record] of staged) {
          if(table==='deviceSessions')server.devices.set(id,{...server.devices.get(id),...record});
          if(table==='authIdentities')server.identity={...server.identity,...record};
        }
        return result;
      }
      assert.fail('transaction retry budget exceeded');
    },
  };
  const loaded=new Map();
  function actual(name) {
    if(loaded.has(name))return loaded.get(name);
    const module={exports:{}};
    const imports = {
      'node:crypto':()=>dependency('node:crypto'),
      'zod':()=>dependency('zod'),
      './case-id':()=>({hashText:()=>sessionId.slice('device_'.length)}),
      './firebase':()=>({db,auth:{revokeRefreshTokens:async uid=>{server.authCalls.push(uid);}}}),
      './system-safety':()=>({assertProductionOperational:async()=>{if(!server.operational)throw new HttpsError('failed-precondition','held');}}),
      'firebase-admin/firestore':()=>({FieldValue:{serverTimestamp:()=>stamp},Timestamp}),
      'firebase-functions/v2/https':()=>({onCall:fn=>fn,HttpsError}),
      'firebase-functions/params':()=>({defineString:()=>({value:()=> 'synthetic-admin@example.invalid'})}),
    };
    runInNewContext(compile(fs.readFileSync('functions/src/'+name+'.ts','utf8')),{
      module,exports:module.exports,require:id=>imports[id]?imports[id]():actual(id.slice(2)),
    });
    loaded.set(name,module.exports);
    return module.exports;
  }
  const api=actual('devices');
  const request={auth:{uid,token:{companyId,staffId,role:'staff',auth_time:100}},data:{sessionId,deviceId}};
  return {server,api,request,stamp,sessionId};
}
for(const mode of ['profile-off','identity-off','identity-missing','foreign-identity','retained-revocation','wrong-device','stopped-device','deleted']) {
  await test('Server does not renew an invalid device session '+mode,async()=>{
    const h=service();
    if(mode==='profile-off')h.server.profile.active=false;
    if(mode==='identity-off')h.server.identity.active=false;
    if(mode==='identity-missing')h.server.identity=null;
    if(mode==='foreign-identity')h.server.identity.companyId='other-company';
    if(mode==='retained-revocation')h.server.identity.revokedAt=new Timestamp(100,1);
    if(mode==='wrong-device')h.server.devices.get(h.sessionId).uid='other-user';
    if(mode==='stopped-device')h.server.devices.get(h.sessionId).active=false;
    if(mode==='deleted')h.server.devices.delete(h.sessionId);
    await assert.rejects(()=>h.api.heartbeatDeviceSession(h.request),{code:'permission-denied'});
    assert.equal(h.server.writes.length,0);
  });
}
await test('Heartbeat writes only lastSeenAt; a concurrent stop/deletion wins over the transaction',async()=>{
  const normal=service(),reply=await normal.api.heartbeatDeviceSession(normal.request);
  assert.equal(reply.active,true);
  assert.deepEqual(normal.server.writes.map(([kind,table,id,fields])=>[kind,table,id,Object.keys(fields),fields.lastSeenAt]),
    [['update','deviceSessions',normal.sessionId,['lastSeenAt'],normal.stamp]]);
  for(const change of ['profile','identity','device']){
    const h=service();
    h.server.beforeCommit=()=>{
      if(change==='profile')h.server.profile.active=false;
      if(change==='identity')h.server.identity.active=false;
      if(change==='device')h.server.devices.delete(h.sessionId);
    };
    await assert.rejects(()=>h.api.heartbeatDeviceSession(h.request),{code:'permission-denied'});
    assert.equal(h.server.transactions,2);
    assert.equal(h.server.writes.length,0);
  }
});
await test('Device registration refuses a stopped identity and accepts a newly verified same-account login',async()=>{
  const denied=service();denied.server.identity.active=false;
  await assert.rejects(()=>denied.api.registerDeviceSession(denied.request),{code:'permission-denied'});
  assert.equal(denied.server.writes.length,0);
  const active=service();
  const response=await active.api.registerDeviceSession(active.request);
  assert.equal(response.active,true);assert.equal(active.server.writes.length,1);
});

for(const name of ['listMyDevices','revokeMyDevice','revokeAllMyDevices']) {
  for(const mode of ['stopped','missing','old-token','other-company','wrong-role']) {
    await test(name+' refuses invalid current authority '+mode,async()=>{
      const h=service();
      if(mode==='stopped')h.server.profile.active=false;
      if(mode==='missing')h.server.identity=null;
      if(mode==='old-token')h.server.identity.revokedAt=new Timestamp(100,1);
      if(mode==='other-company')h.server.identity.companyId='other-company';
      if(mode==='wrong-role')h.request.auth.token.role='admin';
      await assert.rejects(()=>h.api[name](h.request),{code:'permission-denied'});
      assert.equal(h.server.writes.length,0);
      assert.equal(h.server.authCalls.length,0);
      assert.equal(h.server.reads.some(([table])=>table==='pushTokens'),false);
      if(name==='listMyDevices')assert.equal(h.server.reads.some(([table])=>table==='deviceSessions'),false);
    });
  }
}
await test('Current staff can list only their own devices, with read-only transaction and capped results',async()=>{
  const h=service(), own=h.server.devices.get(h.sessionId);
  for(let i=0;i<31;i++)h.server.devices.set('owned-'+i,own);
  h.server.devices.set('wrong-company',{...own,companyId:'other'});
  h.server.devices.set('wrong-staff',{...own,staffId:'other'});
  const result=await h.api.listMyDevices(h.request);
  assert.equal(result.devices.length,30);
  assert.ok(result.devices.every(row=>row.companyId===own.companyId&&row.staffId===own.staffId));
  assert.deepEqual(h.server.reads.slice(0,3),[
    ['staffProfiles','synthetic-staff'],['authIdentities','synthetic-user'],['deviceSessions','query'],
  ]);
  assert.equal(h.server.transactions,1);
  assert.equal(h.server.writes.length,0);
});
await test('One-device revocation leaves the other device and global identity active',async()=>{
  const h=service(),own=h.server.devices.get(h.sessionId);
  h.server.devices.set('other-device',{...own,deviceId:'other'});
  await assert.rejects(()=>h.api.revokeMyDevice({...h.request,data:{sessionId:'absent-long-session'}}),{code:'not-found'});
  assert.equal(h.server.writes.length,0);
  assert.equal((await h.api.revokeMyDevice(h.request)).revoked,true);
  assert.equal(h.server.devices.get(h.sessionId).active,false);
  assert.equal(h.server.devices.get('other-device').active,true);
  assert.equal(h.server.identity.active,true);
  assert.equal(h.server.authCalls.length,0);
});
await test('An identity change before a device stop commits causes zero writes',async()=>{
  const h=service();
  h.server.beforeCommit=()=>{h.server.identity.active=false;};
  await assert.rejects(()=>h.api.revokeMyDevice(h.request),{code:'permission-denied'});
  assert.equal(h.server.transactions,2);
  assert.equal(h.server.devices.get(h.sessionId).active,true);
  assert.equal(h.server.writes.length,0);
});
await test('All-device revoke revalidates authority when a device or target changes before commit',async()=>{
  for(const mode of ['profile-stopped','target-list-changed']){
    const h=service();
    h.server.beforeCommit=()=>{
      if(mode==='profile-stopped')h.server.profile.active=false;
      else h.server.profile.authUids.push('new-linked-uid');
    };
    await assert.rejects(()=>h.api.revokeAllMyDevices(h.request),{code:mode==='profile-stopped'?'permission-denied':'aborted'});
    assert.equal(h.server.devices.get(h.sessionId).active,true);
    assert.equal(h.server.writes.length,0);
    assert.deepEqual(h.server.authCalls,[]);
  }
});
await test('No-device case still revalidates caller before Auth side effects',async()=>{
  const h=service();
  h.server.devices.clear();
  h.server.beforeDeviceQuery=()=>{h.server.identity.active=false;};
  await assert.rejects(()=>h.api.revokeAllMyDevices(h.request),{code:'permission-denied'});
  assert.deepEqual(h.server.authCalls,[]);
  assert.equal(h.server.writes.length,0);
});
await test('An active caller can request full revocation with zero or one device',async()=>{
  for(const deviceCount of [0,1]){
    const h=service();
    if(!deviceCount)h.server.devices.clear();
    const result=await h.api.revokeAllMyDevices(h.request);
    assert.deepEqual({...result},{revoked:true,count:deviceCount});
    assert.deepEqual(h.server.authCalls,['synthetic-user']);
    assert.equal(h.server.identity.active,false);
    assert.equal(h.server.writes.filter(([,table])=>table==='deviceSessions').length,deviceCount);
  }
});

function boundFixture(){
  const h=service({boundDevice:true});
  const tokenA={crewDeviceSession:h.sessionId,crewDeviceGeneration:'a'.repeat(48)};
  const another='device_'+'b'.repeat(28),tokenB={crewDeviceSession:another,crewDeviceGeneration:'b'.repeat(48)};
  const active=h.server.devices.get(h.sessionId);
  h.server.profile.deviceBoundAuthRequired=true;
  Object.assign(active,{credentialGeneration:tokenA.crewDeviceGeneration});
  h.server.devices.set(another,{...active,deviceId:'different-device',credentialGeneration:tokenB.crewDeviceGeneration});
  h.server.identity.deviceCredentials={[h.sessionId]:tokenA.crewDeviceGeneration,[another]:tokenB.crewDeviceGeneration};
  const request=claims=>({...h.request,auth:{...h.request.auth,token:{...h.request.auth.token,...claims}}});
  return {...h,request,tokenA,tokenB,another};
}
for(const owner of ['staff','admin']){
 await test('Individual '+owner+' revocation invalidates only the authenticating device grant',async()=>{
  const h=boundFixture();
  assert.equal((await h.api.listMyDevices(h.request(h.tokenA))).devices.length,2);
  if(owner==='staff')await h.api.revokeMyDevice(h.request(h.tokenB));
  else await h.api.adminRevokeStaffDevices({
   auth:{uid:'synthetic-admin',token:{role:'admin',companyId:'synthetic-company'}},
   data:{staffId:'synthetic-staff',sessionId:h.sessionId},
  });
  assert.equal(h.server.devices.get(h.sessionId).active,false);
  assert.equal(h.server.devices.get(h.another).active,true);
  assert.equal(h.server.identity.active,true);
  assert.equal(h.server.identity.deviceCredentials[h.sessionId],null);
  assert.equal(h.server.identity.deviceCredentials[h.another],h.tokenB.crewDeviceGeneration);
  assert.deepEqual(h.server.authCalls,[]);
  await assert.rejects(()=>h.api.listMyDevices(h.request(h.tokenA)),{code:'permission-denied'});
  await assert.rejects(()=>h.api.revokeMyDevice(h.request(h.tokenA)),{code:'permission-denied'});
  assert.equal((await h.api.listMyDevices(h.request(h.tokenB))).devices.length,2);
 });
}
await test('A stale identity binding cannot partially stop a device',async()=>{
 const h=boundFixture();
 h.server.identity.deviceCredentials[h.sessionId]='f'.repeat(48);
 await assert.rejects(()=>h.api.revokeMyDevice(h.request(h.tokenB)),{code:'aborted'});
 assert.equal(h.server.writes.length,0);
 assert.equal(h.server.devices.get(h.sessionId).active,true);
});
await test('A signed grant for an active bound device cannot register or heartbeat another',async()=>{
 const h=boundFixture(),working=h.request(h.tokenB);
 await assert.rejects(()=>h.api.heartbeatDeviceSession(working),{code:'permission-denied'});
 await assert.rejects(()=>h.api.registerDeviceSession(working),{code:'permission-denied'});
 assert.equal(h.server.writes.length,0);
 assert.equal((await h.api.heartbeatDeviceSession(h.request(h.tokenA))).active,true);
});
console.log(JSON.stringify({tests:results.length,passed:results.filter(row=>row.passed).length,results}));
if(results.some(row=>!row.passed))process.exitCode=1;
