import ts from 'typescript';import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('apps/staff/src/App.tsx','utf8');
const start=source.indexOf('  async function apply(job:Job){');
const end=source.indexOf('  async function submitPreContact()',start);
assert.ok(start>=0&&end>start);
const handler=source.slice(start,end).replace('job:Job','job');
assert.match(source,/const authLoadVersion=\+\+authLoadVersionRef.current;\s*applicationAttemptsRef.current.clear\(\);/);
function harness({apiFailure=false,refreshFailure=false,refreshUnconfirmed=false,staleAt='',demo=false,loseFirstResponse=false,shiftFailure=false,shiftMissing=false,missingFunctions=false,savedStorage=new Map(),locks={request:async(name,options,fn)=>fn({name})}}={}){
 const state={messages:[],jobs:[{id:'one'},{id:'two'}],pending:'',accepted:'',expanded:'one',calls:0,refreshes:0,shiftReads:0,assigned:[],writes:0,requests:[],replyOverride:undefined,now:100000};
 const version={current:1};
 const attempts={current:new Map()};
 const completed=new Map();
 let sequence=0;
 const setMessage=value=>state.messages.push(value);
 const storageListeners=new Map();const storageScope={exports:{},window:{addEventListener:(type,fn)=>storageListeners.set(type,fn),removeEventListener:(type,fn)=>{if(storageListeners.get(type)===fn)storageListeners.delete(type);}},navigator:{locks},localStorage:{get length(){return savedStorage.size;},key:index=>[...savedStorage.keys()][index]??null,getItem:key=>savedStorage.get(key)??null,setItem:(key,value)=>savedStorage.set(key,value)}};runInNewContext(ts.transpileModule(readFileSync('apps/staff/src/application-attempt-store.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,storageScope);
 const dependencies={
  ...storageScope.exports,user:{uid:'user'},companyId:'company',staffId:'staff',
  isPending:()=>false,
  authLoadVersionRef:version,applicationAttemptsRef:attempts,navigationVersionRef:{current:1},applicationResultFocusRef:{current:null},
  run:async(_key,action,options)=>{try{return await action();}catch(error){options.setMessage(error.message);throw error;}},
  setPendingApplicationJobId:value=>state.pending=value,
  setAcceptedApplicationJobId:value=>state.accepted=value,
  firebaseConfigured:!demo,functions:missingFunctions?null:{},
  httpsCallable:()=>async input=>{
   state.calls++;state.requests.push(input);
   if(staleAt==='api'){version.current++;attempts.current.clear();attempts.current.set(input.jobId,{requestId:'new-session',startedAt:state.now});}
   if(state.errorOverride)throw state.errorOverride;
   if(apiFailure)throw Error('API rejected');
   if(completed.has(input.requestId))return state.replyOverride===undefined?completed.get(input.requestId):state.replyOverride;
   const result={data:{ok:true,jobId:input.jobId,assignedAt:"2026-09-10T00:00:00Z"}};
   completed.set(input.requestId,result);state.writes++;
   if(loseFirstResponse&&state.calls===1)throw Error('Response lost');
   return state.replyOverride===undefined?result:state.replyOverride;
  },
  loadTaskJob:async id=>{state.shiftReads++;if(staleAt==='shift'){version.current++;return null;}if(shiftFailure)throw Error('Shift read failed');if(shiftMissing)return null;const job={id,status:'assigned'};state.assigned=[...state.assigned.filter(j=>j.id!==id),job];return job;},
  setMessage,
  setOpenJobs:update=>state.jobs=update(state.jobs),
  setMyJobs:update=>state.assigned=update(state.assigned),
  setExpandedOpenJobId:value=>state.expanded=value,
  loadOpenJobs:async()=>{state.refreshes++;if(staleAt==='refresh')version.current++;if(refreshFailure)throw Error('Read failed');return !refreshUnconfirmed;},
  crypto:{randomUUID:()=> 'synthetic-request-'+(++sequence)},
  Date:{now:()=>state.now,parse:Date.parse}
 };
 const apply=Function(...Object.keys(dependencies),handler+';return apply;')(...Object.values(dependencies));
 return {state,apply,attempts,version,savedStorage,store:storageScope.exports};
}
{
 const {state,apply,attempts}=harness({refreshFailure:true});await apply({id:'one'});
 assert.equal(state.calls,1);assert.equal(state.refreshes,1);
 assert.deepEqual(state.jobs,[{id:'two'}]);assert.equal(state.pending,'');
 assert.match(state.messages.at(-1),/応募は受付済みです/);
 assert.match(state.messages.at(-1),/募集案件を更新/);assert.equal(attempts.current.size,0);
}
{
 const {state,apply}=harness();await apply({id:'one'});
 assert.equal(state.messages.at(-1),'応募を受け付けました。シフトで担当の確認状況を確認してください。');assert.equal(state.calls,1);assert.equal(state.accepted,'one');
 assert.deepEqual(state.jobs,[{id:'two'}]);assert.equal(state.pending,'');
}
{
 const {state,apply}=harness({apiFailure:true});await apply({id:'one'});
 assert.equal(state.refreshes,0);assert.equal(state.jobs.length,2);
 assert.equal(state.accepted,'');assert.equal(state.messages.at(-1),'API rejected');assert.equal(state.pending,'');
}
{
 const {state,apply,attempts}=harness({staleAt:'api'});await apply({id:'one'});
 assert.equal(state.refreshes,0);assert.equal(state.jobs.length,2);assert.deepEqual(state.messages,[]);assert.equal(state.accepted,'');
 assert.equal(attempts.current.get('one').requestId,'new-session');
}
{
 const {state,apply}=harness({staleAt:'refresh',refreshFailure:true});await apply({id:'one'});
 assert.deepEqual(state.messages,['応募を受け付けました。シフトで担当の確認状況を確認してください。']);
}
{
 const {state,apply,attempts}=harness({demo:true});await apply({id:'one'});
 assert.equal(state.calls,0);assert.equal(state.refreshes,0);assert.deepEqual(state.jobs,[{id:'two'}]);
 assert.equal(state.accepted,'one');assert.deepEqual(state.assigned,[{id:'one',status:'assigned',applicationUnconfirmed:true}]);await apply({id:'one'});assert.equal(state.assigned.length,1);assert.equal(state.expanded,'');
 assert.equal(attempts.current.size,0);
}
{
 const {state,apply,attempts}=harness({loseFirstResponse:true});
 await apply({id:'one'});assert.equal(state.writes,1);assert.equal(state.jobs.length,2);
 await apply({id:'one'});
 assert.equal(state.calls,2);assert.equal(state.writes,1);
 assert.equal(state.requests[0].requestId,state.requests[1].requestId);
 assert.equal(state.messages.at(-1),'応募を受け付けました。シフトで担当の確認状況を確認してください。');assert.equal(attempts.current.size,0);
}
{
 const {state,apply}=harness({apiFailure:true});
 await apply({id:'one'});await apply({id:'two'});await apply({id:'one'});
 assert.notEqual(state.requests[0].requestId,state.requests[1].requestId);
 assert.equal(state.requests[0].requestId,state.requests[2].requestId);
}
{
 const {state,apply,attempts,version}=harness({apiFailure:true});
 await apply({id:'one'});version.current++;attempts.current.clear();await apply({id:'one'});
 assert.equal(state.requests[0].requestId,state.requests[1].requestId);
}
for(const elapsed of [-1,23*60*60*1000-1,23*60*60*1000]){
 const {state,apply,attempts}=harness({apiFailure:true});
 await apply({id:'one'});const request=attempts.current.get('one').requestId;
 state.now+=elapsed;await apply({id:'one'});
 assert.equal(state.calls,elapsed>=0&&elapsed<23*60*60*1000?2:1);
 assert.equal(attempts.current.get('one').requestId,request);
 assert.equal(state.pending,'');
}
console.log('Application confirmation/retry: 12 scenarios passed; simulated lost response commits once, session isolation and retry time boundaries. No network or real writes.');

for(const reply of [null,{}, {data:null},{data:[]},{data:{ok:false,jobId:'one',assignedAt:'2026-09-10T00:00:00Z'}},{data:{ok:true,jobId:'two',assignedAt:'2026-09-10T00:00:00Z'}},{data:{ok:true,jobId:'one'}},{data:{ok:true,jobId:'one',assignedAt:'invalid'}}]){
 const {state,apply,attempts}=harness();state.replyOverride=reply;
 await apply({id:'one'});
 assert.equal(state.jobs.length,2,'Malformed response must preserve the listing');assert.equal(state.refreshes,0);
 assert.equal(state.pending,'');assert.equal(state.expanded,'one');assert.equal(attempts.current.size,1);
 assert.match(state.messages.at(-1),/応募結果を確認できません/);
 const request=attempts.current.get('one').requestId;state.replyOverride=undefined;
 await apply({id:'one'});
 assert.equal(state.requests[1].requestId,request);assert.equal(state.writes,1);assert.equal(attempts.current.size,0);
 assert.equal(state.messages.at(-1),'応募を受け付けました。シフトで担当の確認状況を確認してください。');
}
console.log('Application response integrity: 8 malformed replies retain listing/request; corrected retry confirms exactly one synthetic write.');

for(const mode of ['success','shiftFailure','shiftMissing','stale','both-fail']){
 const {state,apply,attempts}=harness({shiftFailure:mode==='shiftFailure'||mode==='both-fail',shiftMissing:mode==='shiftMissing',staleAt:mode==='stale'?'shift':'',refreshFailure:mode==='both-fail'});
 await apply({id:'one'});assert.equal(state.shiftReads,1,'Accepted application must reload its assigned shift');
 assert.equal(state.writes,1);assert.equal(attempts.current.size,0);
 if(mode==='success'){assert.deepEqual(state.assigned,[{id:'one',status:'assigned'}]);assert.equal(state.messages.at(-1),'応募を受け付けました。シフトで担当の確認状況を確認してください。');}
 else if(mode==='stale'){assert.deepEqual(state.messages,['応募を受け付けました。シフトで担当の確認状況を確認してください。']);assert.equal(state.refreshes,0);}
 else{assert.equal(state.refreshes,1);assert.match(state.messages.at(-1),/応募は受付済みです/);assert.match(state.messages.at(-1),/シフトを更新/);}
}
console.log('Accepted application shift refresh: 5 success/missing/failure/auth/both-failure cases.');

{
 const {state,apply,attempts}=harness({missingFunctions:true});await apply({id:'one'});
 assert.equal(state.calls,0);assert.equal(state.refreshes,0);assert.equal(state.pending,'');assert.equal(state.accepted,'');assert.equal(state.jobs.length,2);assert.equal(attempts.current.size,0);assert.match(state.messages.at(-1),/応募の接続準備/);assert.match(state.messages.at(-1),/再読み込み/);
}
console.log('Application setup: missing Functions reports recovery guidance, retains listing and creates no attempt or request.');

for(const stale of [false,true])for(const shiftMissing of [false,true]){
 const {state,apply,attempts}=harness({refreshUnconfirmed:true,staleAt:stale?'refresh':'',shiftMissing});await apply({id:'one'});assert.equal(state.calls,1);assert.equal(state.writes,1);assert.equal(attempts.current.size,0);assert.deepEqual(state.jobs,[{id:'two'}]);assert.equal(state.accepted,'one');
 if(stale)assert.deepEqual(state.messages,['応募を受け付けました。シフトで担当の確認状況を確認してください。']);else{assert.equal(state.pending,'');assert.match(state.messages.at(-1),/応募は受付済みです/);assert.match(state.messages.at(-1),shiftMissing?/シフトを更新/:/募集案件を更新/);}
}
console.log('Accepted application unconfirmed listing: 4 current/stale and loaded/missing shift combinations preserve acceptance and guide the relevant refresh.');

{
 const savedStorage=new Map(),first=harness({loseFirstResponse:true,savedStorage});await first.apply({id:'one'});const requestId=first.state.requests[0].requestId;assert.equal(first.attempts.current.size,1);const reopened=harness({savedStorage});await reopened.apply({id:'one'});assert.equal(reopened.state.requests[0].requestId,requestId);assert.equal(reopened.state.messages.at(-1),'応募を受け付けました。シフトで担当の確認状況を確認してください。');assert.equal(reopened.store.loadSavedApplicationAttempts(reopened.store.applicationAttemptOwner('company','staff','user')).size,0);
}
{
 const savedStorage=new Map(),first=harness({loseFirstResponse:true,savedStorage});await first.apply({id:'one'});const reopened=harness({savedStorage});reopened.state.now+=23*60*60*1000;await reopened.apply({id:'one'});assert.equal(reopened.state.calls,0);assert.match(reopened.state.messages.at(-1),/時間が経過/);
}
console.log('Application reopen recovery: persisted request ID is reused after response loss; expired attempts never become fresh applications.');

{
 const h=harness(),a=h.store.applicationAttemptOwner('company','staff','user'),b=h.store.applicationAttemptOwner('other-company','staff','user'),c=h.store.applicationAttemptOwner('company','other-staff','user'),d=h.store.applicationAttemptOwner('company','staff','other-user');h.store.saveApplicationAttempt(a,'one',{requestId:'saved',startedAt:1});for(const owner of [b,c,d])assert.equal(h.store.loadSavedApplicationAttempts(owner).size,0);assert.equal(h.store.loadSavedApplicationAttempts(a).get('one').requestId,'saved');h.store.removeSavedApplicationAttempt(a,'one','different-request');assert.equal(h.store.loadSavedApplicationAttempts(a).size,1);
}
for(const broken of ['invalid-json',JSON.stringify({version:2,attempts:[]}),JSON.stringify({version:1,attempts:[{jobId:'one',requestId:'saved',startedAt:'1'}]})]){const h=harness();h.savedStorage.set('lkc.applicationAttempts.v1:'+h.store.applicationAttemptOwner('company','staff','user'),broken);await h.apply({id:'one'});assert.equal(h.state.calls,0);assert.match(h.state.messages.at(-1),/保存記録を確認できません/);assert.equal([...h.savedStorage.values()][0],broken);}
{
 const savedStorage=new Map();savedStorage.set=()=>{throw Error('quota');};const h=harness({savedStorage});await h.apply({id:'one'});assert.equal(h.state.calls,0);assert.equal(h.attempts.current.size,0);assert.match(h.state.messages.at(-1),/保存記録を確認できません/);
}
{
 const savedStorage=new Map();let writes=0;const set=savedStorage.set.bind(savedStorage);savedStorage.set=(key,value)=>{if(++writes>1)throw Error('cleanup failed');return set(key,value);};const h=harness({savedStorage});await h.apply({id:'one'});assert.equal(h.state.calls,1);assert.equal(h.state.messages.at(-1),'応募を受け付けました。シフトで担当の確認状況を確認してください。');assert.equal(h.state.accepted,'one');assert.equal(h.attempts.current.size,0);
}
console.log('Application storage safety: company/staff/user separation, conditional removal, malformed records and quota fail closed before API, cleanup failure preserves confirmed acceptance.');

{
 const effect=source.split(String.fromCharCode(10)).find(line=>line.includes('useEffect(()=>{applicationAttemptsRef.current.clear();'));assert.ok(effect);
 for(const mode of ['restored','different-owner','missing-owner','broken']){const h=harness();const owner=h.store.applicationAttemptOwner('company','staff','user');h.store.saveApplicationAttempt(owner,'saved-job',{requestId:'saved-id',startedAt:100});if(mode==='broken')h.savedStorage.set('lkc.applicationAttempts.v1:'+owner,'broken');const ctx={...h.store,firebaseConfigured:true,companyId:mode==='different-owner'?'other':'company',staffId:'staff',user:mode==='missing-owner'?null:{uid:'user'},applicationAttemptsRef:{current:new Map([['old-owner',{}]])},refreshApplicationAttempts:()=>{},setMessage:()=>{},useEffect:fn=>fn()};runInNewContext(effect,ctx);assert.equal(ctx.applicationAttemptsRef.current.has('old-owner'),false);assert.equal(ctx.applicationAttemptsRef.current.has('saved-job'),mode==='restored');}
}
console.log('Application hydration: restored owner records populate the retry map; different/missing owners and corrupt storage do not retain prior owner records.');

for(const operation of ['save','clear']){
 const savedStorage=new Map(),a=harness({savedStorage}),b=harness({savedStorage}),owner=a.store.applicationAttemptOwner('company','staff','user'),originalSet=savedStorage.set.bind(savedStorage);a.store.saveApplicationAttempt(owner,'one',{requestId:'one-request',startedAt:1});let interleaved=false;savedStorage.set=(key,value)=>{if(!interleaved){interleaved=true;b.store.saveApplicationAttempt(owner,'two',{requestId:'two-request',startedAt:2});}return originalSet(key,value);};if(operation==='save')a.store.saveApplicationAttempt(owner,'one',{requestId:'one-request',startedAt:1});else a.store.removeSavedApplicationAttempt(owner,'one','one-request');const restored=a.store.loadSavedApplicationAttempts(owner);assert.equal(restored.get('two').requestId,'two-request');assert.equal(restored.has('one'),operation==='save');
}
{
 const h=harness(),owner=h.store.applicationAttemptOwner('company','staff','user');const legacy=JSON.stringify({version:1,attempts:[{jobId:'one',requestId:'old-one',startedAt:1},{jobId:'two',requestId:'old-two',startedAt:2}]});const key='lkc.applicationAttempts.v1:'+owner;h.savedStorage.set(key,legacy);h.store.saveApplicationAttempt(owner,'three',{requestId:'new-three',startedAt:3});h.store.removeSavedApplicationAttempt(owner,'one','old-one');assert.deepEqual([...h.store.loadSavedApplicationAttempts(owner).keys()].sort(),['three','two']);assert.equal(h.savedStorage.get(key),legacy);assert.throws(()=>h.store.saveApplicationAttempt(owner,'two',{requestId:'different',startedAt:2}),/保存記録/);assert.equal(h.store.loadSavedApplicationAttempts(owner).get('two').requestId,'old-two');
}
console.log('Per-job storage: interleaved saves/clears retain another job; legacy records stay intact, resolved jobs stay removed, and an existing different request cannot be overwritten.');

for(const mode of ['unavailable','busy','stale']){
 let created=0,callback;const h=harness({locks:mode==='unavailable'?undefined:{request:async(name,options,fn)=>{assert.equal(options.mode,'exclusive');assert.equal(options.ifAvailable,true);callback=fn;return fn(mode==='busy'?null:{name});}}});if(mode==='unavailable'){const separate=harness({locks:null});await separate.apply({id:'one'});assert.equal(separate.state.calls,0);assert.equal(separate.savedStorage.size,0);assert.match(separate.state.messages.at(-1),/同時操作を確認できません/);continue;}
 const owner=h.store.applicationAttemptOwner('company','staff','user');const reservation=h.store.reserveApplicationAttempt(owner,'one',()=>{created++;return{requestId:'new-id',startedAt:1};},()=>mode!=='stale');if(mode==='busy')await assert.rejects(reservation,/別の画面/);else assert.equal(await reservation,null);assert.equal(created,0);assert.equal(h.savedStorage.size,0);
}
{
 const savedStorage=new Map(),active=new Set();const locks={request:async(name,options,fn)=>{if(active.has(name))return fn(null);active.add(name);try{return await fn({name});}finally{active.delete(name);}}};const a=harness({savedStorage,locks}),b=harness({savedStorage,locks}),owner=a.store.applicationAttemptOwner('company','staff','user');const first=a.store.reserveApplicationAttempt(owner,'one',()=>({requestId:'winner',startedAt:1}));await assert.rejects(b.store.reserveApplicationAttempt(owner,'one',()=>({requestId:'loser',startedAt:2})),/別の画面/);await first;const retried=await b.store.reserveApplicationAttempt(owner,'one',()=>({requestId:'unexpected-new',startedAt:3}));assert.equal(retried.requestId,'winner');
}
console.log('Application reservations: unavailable/busy/stale contexts write nothing; shared exclusive locks serialize same-job creation and retry reuses the winner.');

{
 const listeners=new Map(),saved=new Map(),storage={get length(){return saved.size;},key:i=>[...saved.keys()][i]??null,getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)};
 const scope={exports:{},localStorage:storage,window:{addEventListener:(t,f)=>listeners.set(t,f),removeEventListener:(t,f)=>{assert.equal(listeners.get(t),f);listeners.delete(t);}}};
 runInNewContext(ts.transpileModule(readFileSync('apps/staff/src/application-attempt-store.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,scope);
 const store=scope.exports,owner=store.applicationAttemptOwner('company','staff','user');let changed=0,failed=0,last;
 const stop=store.observeApplicationAttempts(owner,value=>{changed++;last=value;},()=>failed++),event=listeners.get('storage'),focus=listeners.get('focus');
 store.saveApplicationAttempt(owner,'one',{requestId:'cross-tab',startedAt:1});const key=[...saved.keys()][0];
 event({storageArea:{},key});event({storageArea:storage,key:'unrelated'});event({storageArea:storage,key:'lkc.applicationAttempts.v2:'+store.applicationAttemptOwner('company','staff','other')+':one'});assert.equal(changed,0);
 event({storageArea:storage,key});assert.equal(changed,1);assert.equal(last.get('one').requestId,'cross-tab');
 focus();assert.equal(changed,2);event({storageArea:storage,key:null});assert.equal(changed,3);
 saved.set(key,'broken');event({storageArea:storage,key});assert.equal(failed,1);assert.equal(changed,3);
 stop();assert.equal(listeners.size,0);focus();event({storageArea:storage,key});assert.equal(failed,1);assert.equal(changed,3);
}
console.log('Application storage observer: matching owner/local storage and focus refresh; unrelated storage ignored, corruption reported, cleanup suppresses queued callbacks.');

{
 const start=source.indexOf('  useEffect(()=>{'+String.fromCharCode(10)+'    if(!firebaseConfigured||!companyId||!staffId||!user?.uid)return;');assert.ok(start>=0);const end=source.indexOf('},[companyId,staffId,user?.uid]);',start)+'},[companyId,staffId,user?.uid]);'.length;const effect=source.slice(start,end);
 for(const missing of [false,true]){
  let receive,errors,cleanup,stopped=false,rendered=0;const h=harness();
  const ctx={firebaseConfigured:true,companyId:'company',staffId:'staff',user:missing?null:{uid:'user'},applicationAttemptOwner:h.store.applicationAttemptOwner,observeApplicationAttempts:(owner,onChange,onError)=>{assert.equal(owner,h.store.applicationAttemptOwner('company','staff','user'));receive=onChange;errors=onError;return()=>{stopped=true;};},applicationAttemptsRef:{current:new Map([['uncertain',{requestId:'keep',startedAt:1}]])},refreshApplicationAttempts:()=>rendered++,setMessage:message=>assert.match(message,/シフトでの確定状況/),useEffect:fn=>{cleanup=fn();}};
  runInNewContext(effect,ctx);
  if(missing){assert.equal(receive,undefined);continue;}
  receive(new Map([['other-tab',{requestId:'new',startedAt:2}]]));assert.equal(ctx.applicationAttemptsRef.current.get('uncertain').requestId,'keep');assert.equal(ctx.applicationAttemptsRef.current.get('other-tab').requestId,'new');receive(new Map());assert.equal(ctx.applicationAttemptsRef.current.size,2);assert.equal(rendered,2);errors();cleanup();assert.equal(stopped,true);
 }
}
console.log('Application observer effect: owner-bound records merge without discarding unresolved local attempts; missing identity does not subscribe and unmount cleans up.');

for(const elapsed of [-1,23*60*60*1000,7*24*60*60*1000]){
 const h=harness({loseFirstResponse:true});await h.apply({id:'one'});const request=h.attempts.current.get('one').requestId;const before=[...h.savedStorage.entries()];h.state.now+=elapsed;await h.apply({id:'one'});
 assert.equal(h.state.calls,1);assert.equal(h.attempts.current.get('one').requestId,request);assert.deepEqual([...h.savedStorage.entries()],before);assert.equal(h.state.pending,'');
 const message=h.state.messages.at(-1);assert.match(message,/シフトを更新/);
 if(elapsed<0){assert.match(message,/端末の日時設定/);assert.doesNotMatch(message,/時間が経過/);}else{assert.match(message,/再送を停止/);assert.match(message,/見つからない場合は管理者/);}
}
console.log('Expired application recovery: clock rollback and 23-hour/7-day expiry show distinct actionable guidance, never call API again and retain the exact saved request.');

// メール・通常の導線が変わっても、保存済みの最初の要求をそのまま再送する。
for(const direction of ["mail-to-mail","mail-to-normal","normal-to-mail"]){
 const storage=new Map(),first=harness({loseFirstResponse:true,savedStorage:storage});
 const mail={id:"a".repeat(64),revision:1};
 assert.equal(await first.apply({id:"one",...(direction==="normal-to-mail"?{}:{mailApplication:mail})}),false);
 const initial=first.state.requests[0],reopened=harness({savedStorage:storage});
 assert.equal(await reopened.apply({id:"one",...(direction==="mail-to-normal"?{}:{mailApplication:{id:"b".repeat(64),revision:2}})}),true);
 assert.deepEqual(reopened.state.requests[0],initial);
}
for(const invalid of [{mailApplicationId:"a".repeat(64)},{mailApplicationRevision:1},{mailApplicationId:"bad",mailApplicationRevision:1},{mailApplicationId:"a".repeat(64),mailApplicationRevision:0}]){
 const h=harness(),owner=h.store.applicationAttemptOwner("company","staff","user");
 assert.throws(()=>h.store.saveApplicationAttempt(owner,"one",{requestId:"test",startedAt:1,...invalid}),/保存記録/);
}
{
 const h=harness(),owner=h.store.applicationAttemptOwner("company","staff","user");
 const record={requestId:"test",startedAt:1,mailApplicationId:"a".repeat(64),mailApplicationRevision:1};
 h.store.saveApplicationAttempt(owner,"one",record);
 assert.throws(()=>h.store.saveApplicationAttempt(owner,"one",{...record,mailApplicationRevision:2}),/保存記録/);
 assert.equal(h.store.loadSavedApplicationAttempts(owner).get("one").mailApplicationRevision,1);
}
for(const staleAt of ["api","shift","refresh"])assert.equal(await harness({staleAt}).apply({id:"one"}),false);
console.log("メール応募復元: 導線変更3通りで元の要求を維持し、不完全な組合せ・改訂の上書き・旧認証の成功表示を拒否。");


for(const change of ["valid","wrong-code","wrong-id","wrong-revision","not-definitive","missing-details"]){
 const h=harness(),mail={id:"a".repeat(64),revision:1};
 const detail={reason:"mail_application_changed",accepted:false,applicationId:mail.id,revision:1};
 const failure=Object.assign(Error("synthetic candidate changed"),{code:"functions/failed-precondition",details:detail});
 if(change==="wrong-code")failure.code="functions/unavailable";
 if(change==="wrong-id")detail.applicationId="b".repeat(64);
 if(change==="wrong-revision")detail.revision=2;
 if(change==="not-definitive")detail.accepted=true;
 if(change==="missing-details")delete failure.details;
 h.state.errorOverride=failure;assert.equal(await h.apply({id:"one",mailApplication:mail}),false);
 const owner=h.store.applicationAttemptOwner("company","staff","user");
 assert.equal(h.store.loadSavedApplicationAttempts(owner).size,change==="valid"?0:1);
 if(change==="valid"){assert.match(h.state.messages.at(-1),/まだ確定していません/);h.state.errorOverride=null;assert.equal(await h.apply({id:"one",mailApplication:{...mail,revision:2}}),true);assert.equal(h.state.requests[1].mailApplicationRevision,2);assert.notEqual(h.state.requests[1].requestId,h.state.requests[0].requestId);}
}
console.log("改訂拒否の復旧: 確定前拒否6条件を照合し、該当する要求だけ解除。最新内容の手動確認後に新たな要求で応募。");

{
 const h=harness({loseFirstResponse:true});await h.apply({id:"one",revision:7});
 assert.equal(h.state.requests[0].expectedJobRevision,7);
 const request=h.attempts.current.get("one").requestId;h.attempts.current.clear();
 await h.apply({id:"one",revision:9});assert.equal(h.state.requests[1].expectedJobRevision,7);
 assert.equal(h.state.requests[1].requestId,request);assert.equal(h.state.writes,1);
}
for(const kind of ["valid","wrong-code","wrong-job","wrong-request","wrong-revision","not-definitive","missing-details"]){
 const h=harness(),detail={reason:"case_mail_job_changed",accepted:false,jobId:"one",requestId:"synthetic-request-1",expectedJobRevision:7};
 const error=Object.assign(Error("synthetic source changed"),{code:"functions/failed-precondition",details:detail});
 if(kind==="wrong-code")error.code="functions/unavailable";
 if(kind==="wrong-job")detail.jobId="other";
 if(kind==="wrong-request")detail.requestId="another-request";
 if(kind==="wrong-revision")detail.expectedJobRevision=8;
 if(kind==="not-definitive")detail.accepted=true;
 if(kind==="missing-details")delete error.details;
 h.state.errorOverride=error;await h.apply({id:"one",revision:7});
 const owner=h.store.applicationAttemptOwner("company","staff","user");
 assert.equal(h.store.loadSavedApplicationAttempts(owner).size,kind==="valid"?0:1);
 if(kind==="valid"){assert.match(h.state.messages.at(-1),/まだ確定していません/);h.state.errorOverride=null;assert.equal(await h.apply({id:"one",revision:8}),true);assert.equal(h.state.requests[1].expectedJobRevision,8);assert.notEqual(h.state.requests[0].requestId,h.state.requests[1].requestId);}
}
for(const revision of [-1,1.5,"7",null,Number.MAX_SAFE_INTEGER+1]){
 const h=harness(),owner=h.store.applicationAttemptOwner("company","staff","user");
 assert.throws(()=>h.store.saveApplicationAttempt(owner,"one",{requestId:"request-0001",startedAt:1,expectedJobRevision:revision}));
}
console.log("受信案件の応募画面13条件: 保存版の維持、確定前拒否7種の照合、不正保存版5種を検証。");
