import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto, randomUUID } from 'node:crypto';
import { File } from 'node:buffer';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const code=ts.transpileModule(fs.readFileSync('apps/staff/src/submission-attempt-store.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const results=[];async function test(name,run){try{await run();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.stack});}}
function fixture(){const rows=new Map(),locks=new Map(),state={rows,reads:0,active:0,maxActive:0};const ctx={exports:{},crypto:{subtle:webcrypto.subtle,randomUUID},TextEncoder,Uint8Array,localStorage:{getItem:key=>{if(state.failRead)throw Error('storage blocked');return rows.get(key)??null;},setItem:(key,v)=>{if(state.failWrite)throw Error('storage full');if(!state.dropWrite)rows.set(key,v);},removeItem:key=>{if(state.failRemove)throw Error('cleanup failed');rows.delete(key);}},navigator:{locks:{request:async(key,_opts,callback)=>{const previous=locks.get(key)??Promise.resolve();let release;const gate=new Promise(r=>release=r);locks.set(key,previous.then(()=>gate));await previous;try{return await callback({name:key});}finally{release();}}}}};runInNewContext(code,ctx);return{...ctx.exports,state,ctx};}
const file=(text='abc',name='same.png')=>new File([text],name,{type:'image/png'});
await test('same actual bytes retain operation across reload and simultaneous tabs',async()=>{const f=fixture(),args=['owner/job',[file()],['image/png']];const [a,b]=await Promise.all([f.prepareSubmissionAttempt(...args),f.prepareSubmissionAttempt(...args)]);assert.equal(a.clientRequestId,b.clientRequestId);const fresh={...f.ctx,exports:{}};runInNewContext(code,fresh);assert.equal((await fresh.exports.prepareSubmissionAttempt(...args)).clientRequestId,a.clientRequestId);assert.equal(f.state.rows.size,1);assert.equal(a.contentHashes[0],'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');});
for(const kind of ['owner','job','type','content','name','order'])await test('distinct '+kind+' does not reuse another upload intent',async()=>{const f=fixture(),original=[file('aaa','a.png'),file('bbb','b.png')],a=await f.prepareSubmissionAttempt('owner/job',original,['image/png','image/png']);const files=kind==='content'?[file('ccc','a.png'),original[1]]:kind==='name'?[file('aaa','changed.png'),original[1]]:kind==='order'?[original[1],original[0]]:original;const b=await f.prepareSubmissionAttempt(kind==='owner'?'other/job':kind==='job'?'owner/other':'owner/job',files,kind==='type'?['application/pdf','image/png']:['image/png','image/png']);assert.notEqual(a.clientRequestId,b.clientRequestId);});
for(const flag of ['failRead','failWrite','dropWrite'])await test(flag+' cannot allow an unrecorded request',async()=>{const f=fixture();f.state[flag]=true;await assert.rejects(f.prepareSubmissionAttempt('owner/job',[file()],['image/png']),/再試行記録/);});
await test('malformed saved receipt fails closed',async()=>{const f=fixture(),a=await f.prepareSubmissionAttempt('owner/job',[file()],['image/png']);f.state.rows.set(a.storageKey,'{}');await assert.rejects(f.prepareSubmissionAttempt('owner/job',[file()],['image/png']),/再試行記録/);});
await test('successful cleanup starts a deliberate next submission; cleanup failure preserves old identity',async()=>{const f=fixture(),args=['owner/job',[file()],['image/png']],a=await f.prepareSubmissionAttempt(...args);f.state.failRemove=true;assert.equal(await f.clearSubmissionAttempt(a),false);assert.equal((await f.prepareSubmissionAttempt(...args)).clientRequestId,a.clientRequestId);f.state.failRemove=false;assert.equal(await f.clearSubmissionAttempt(a),true);assert.notEqual((await f.prepareSubmissionAttempt(...args)).clientRequestId,a.clientRequestId);});
for(const mode of ['read-failure','remove-noop','readback-failure','invalid-json','invalid-version','invalid-id','invalid-revision','lock-failure'])await test('unconfirmed cleanup stays pending: '+mode,async()=>{
 const f=fixture(),a=await f.prepareSubmissionAttempt('owner/job',[file()],['image/png']);
 if(mode==='read-failure')f.state.failRead=true;
 if(mode==='remove-noop')f.ctx.localStorage.removeItem=()=>{};
 if(mode==='readback-failure')f.ctx.localStorage.removeItem=()=>{f.state.failRead=true;};
 if(mode==='invalid-json')f.state.rows.set(a.storageKey,'{');
 if(mode==='invalid-version')f.state.rows.set(a.storageKey,JSON.stringify({version:2,clientRequestId:a.clientRequestId}));
 if(mode==='invalid-id')f.state.rows.set(a.storageKey,JSON.stringify({version:1,clientRequestId:'unknown'}));
 if(mode==='invalid-revision')f.state.rows.set(a.storageKey,JSON.stringify({version:1,clientRequestId:a.clientRequestId,expectedRevision:-1}));
 if(mode==='lock-failure')f.ctx.navigator.locks.request=async()=>{throw Error('synthetic unavailable lock');};
 const before=Array.from(f.state.rows);
 assert.equal(await f.clearSubmissionAttempt(a),false);
 assert.deepEqual(Array.from(f.state.rows),before);
});
await test('cleanup confirms absence and preserves a valid newer or foreign receipt',async()=>{
 const f=fixture(),a=await f.prepareSubmissionAttempt('owner/job',[file()],['image/png']);
 const foreign=await f.prepareSubmissionAttempt('other/job',[file()],['image/png']);
 const newer=JSON.stringify({version:1,clientRequestId:randomUUID(),expectedRevision:5});
 f.state.rows.set(a.storageKey,newer);const foreignValue=f.state.rows.get(foreign.storageKey);
 assert.equal(await f.clearSubmissionAttempt(a),true);assert.equal(f.state.rows.get(a.storageKey),newer);
 assert.equal(f.state.rows.get(foreign.storageKey),foreignValue);
 f.state.rows.delete(a.storageKey);assert.equal(await f.clearSubmissionAttempt(a),true);
});
await test('lost delete acknowledgement remains pending until absence can be read',async()=>{
 const f=fixture(),a=await f.prepareSubmissionAttempt('owner/job',[file()],['image/png']);
 const remove=f.ctx.localStorage.removeItem;
 f.ctx.localStorage.removeItem=key=>{remove(key);f.state.failRead=true;};
 assert.equal(await f.clearSubmissionAttempt(a),false);assert.equal(f.state.rows.size,0);
 f.state.failRead=false;assert.equal(await f.clearSubmissionAttempt(a),true);
});
await test('account change during content reading saves no request',async()=>{const f=fixture();let current=true;const original=file(),delayed={name:original.name,size:original.size,arrayBuffer:async()=>{current=false;return original.arrayBuffer();}};await assert.rejects(f.prepareSubmissionAttempt('owner/job',[delayed],['image/png'],()=>current),/ログイン状態/);assert.equal(f.state.rows.size,0);});
await test('20 file metadata at 50MiB limit hashes sequentially; not a real 1GiB load proof',async()=>{const f=fixture();let active=0,max=0;const files=Array.from({length:20},(_,i)=>({name:i+'.png',size:50*1024*1024,arrayBuffer:async()=>{max=Math.max(max,++active);await new Promise(r=>setImmediate(r));active--;return new Uint8Array([i]).buffer;}}));const attempt=await f.prepareSubmissionAttempt('owner/job',files,files.map(()=> 'image/png'));assert.equal(attempt.contentHashes.length,20);assert.equal(max,1);});
for(const [count,size]of [[21,1],[1,50*1024*1024+1],[1,0],[0,1]])await test('invalid count/size '+count+'/'+size,async()=>{const f=fixture();await assert.rejects(f.prepareSubmissionAttempt('owner/job',Array.from({length:count},()=>({name:'file',size,arrayBuffer:()=>assert.fail('invalid size cannot read bytes')})),Array(count).fill('image/png')));assert.equal(f.state.rows.size,0);});

await test('mail revision stays fixed across reload and newer displayed job',async()=>{const f=fixture(),args=['owner/mail',[file()],['image/png'],()=>true];const a=await f.prepareSubmissionAttempt(...args,5),b=await f.prepareSubmissionAttempt(...args,6);assert.equal(a.expectedRevision,5);assert.equal(b.expectedRevision,5);assert.equal(a.clientRequestId,b.clientRequestId);await f.clearSubmissionAttempt(a);const c=await f.prepareSubmissionAttempt(...args,6);assert.equal(c.expectedRevision,6);assert.notEqual(a.clientRequestId,c.clientRequestId);});
await test('legacy local attempt does not silently adopt a mail revision',async()=>{const f=fixture(),args=['owner/mail',[file()],['image/png'],()=>true],a=await f.prepareSubmissionAttempt(...args),b=await f.prepareSubmissionAttempt(...args,5);assert.equal(b.expectedRevision,undefined);assert.equal(a.clientRequestId,b.clientRequestId);});
for(const invalid of [-1,1.5,'5',null])await test('invalid mail revision '+invalid,async()=>{const f=fixture();await assert.rejects(f.prepareSubmissionAttempt('owner/mail',[file()],['image/png'],()=>true,invalid));assert.equal(f.state.rows.size,0);});
await test('recovery reads the exact existing draft receipt without reserving or rewriting it',async()=>{
 const f=fixture(),files=[file()],a=await f.prepareSubmissionAttempt('owner/job',files,['image/png'],()=>true,7);
 const before=Array.from(f.state.rows);f.ctx.localStorage.setItem=()=>assert.fail('Recovery must not reserve or rewrite');
 const found=await f.findSubmissionAttempt('owner/job',files,['image/png']);
 assert.equal(found.clientRequestId,a.clientRequestId);assert.equal(found.expectedRevision,7);assert.deepEqual(Array.from(f.state.rows),before);
 assert.equal(await f.findSubmissionAttempt('other/job',files,['image/png']),null);assert.deepEqual(Array.from(f.state.rows),before);
});
await test('an exact saved draft with no receipt is confirmed without creating a new one',async()=>{
 const f=fixture();f.ctx.localStorage.setItem=()=>assert.fail('Absent recovery must not create');
 assert.equal(await f.findSubmissionAttempt('owner/job',[file()],['image/png']),null);assert.equal(f.state.rows.size,0);
});
for(const mode of ['read','malformed','lock'])await test('recovery uncertainty cannot become confirmed absence: '+mode,async()=>{
 const f=fixture(),files=[file()],a=await f.prepareSubmissionAttempt('owner/job',files,['image/png']);
 if(mode==='read')f.state.failRead=true;
 if(mode==='malformed')f.state.rows.set(a.storageKey,'{}');
 if(mode==='lock')f.ctx.navigator.locks.request=async()=>{throw Error('synthetic lock failure');};
 await assert.rejects(f.findSubmissionAttempt('owner/job',files,['image/png']));assert.equal(f.state.rows.size,1);
});
await test('account change during recovery cannot read or reserve another receipt',async()=>{
 const f=fixture();let current=true;const original=file(),delayed={name:original.name,size:original.size,arrayBuffer:async()=>{current=false;return original.arrayBuffer();}};
 await assert.rejects(f.findSubmissionAttempt('owner/job',[delayed],['image/png'],()=>current));assert.equal(f.state.rows.size,0);
});
const passed=results.filter(r=>r.passed).length;console.log(JSON.stringify({passed,total:results.length,results,scope:'actual browser store module with Node WebCrypto, File and synthetic localStorage/Web Locks'},null,2));process.exitCode=passed===results.length?0:1;
