import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const ts=createRequire(resolve(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json'))('typescript');
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const app=readFileSync('apps/admin/src/App.tsx','utf8').replace(/\r\n/g,'\n');
const extract=(start,end)=>{const a=app.indexOf(start),b=app.indexOf(end,a);assert.ok(a>=0&&b>a);return app.slice(a,b);};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const raw=Array.from({length:1000},(_,i)=>({id:String(i).padStart(4,'0'),companyId:'company',displayName:'2026-09-05',storeName:'Fixture'}));
const snap=row=>({id:row.id,exists:()=>true,data:()=>row});
let requests=[],missing=false,foreign=false;
const sdk={doc:(_db,collection,id)=>{assert.equal(collection,"staffProfiles");return id;},collection:(_db,name)=>{assert.equal(name,"staffProfiles");return null;},where:(field,op,value)=>({field,op,value}),orderBy:(field,order)=>({sort:field,order}),startAfter:cursor=>({cursor}),limit:count=>({count}),query:(_,...filters)=>filters,
 getDoc:async id=>missing?{exists:()=>false}:snap(raw.find(row=>row.id===id)),
 getDocs:async filters=>{
  requests.push(filters);
  assert.ok(filters.some(f=>f.field==='companyId'&&f.op==='=='&&f.value==='company'));
  assert.ok(filters.some(f=>f.sort==='displayName'&&f.order==='asc'));
  assert.equal(filters.find(f=>f.count).count,101);
  const id=filters.find(f=>f.cursor).cursor.id;
  const selected=raw.slice(raw.findIndex(row=>row.id===id)+1).slice(0,101);
  return{docs:foreign?[snap({...selected[0],companyId:'other'})]:selected.map(snap)};
 }};
const scope={exports:{},require:name=>{if(name==='./firestore-client')return{getAdminFirestore:()=>({})};assert.equal(name,'firebase/firestore');return sdk;}};
runInNewContext(compile(readFileSync('apps/admin/src/staff-directory-page.ts','utf8')),scope);
const read=scope.exports.readAdminStaffPage;
const ids=raw.slice(0,500).map(row=>row.id);let cursor=null,more=true;
while(more){const page=await read({},'company','0499',cursor);assert.ok(page.staff.length<=100);ids.push(...page.staff.map(row=>row.id));cursor=page.cursor;more=page.hasMore;}
assert.deepEqual(ids,raw.map(row=>row.id));assert.equal(new Set(ids).size,1000);
missing=true;await assert.rejects(read({},'company','missing',null),/再読込/);missing=false;
await assert.rejects(read({},'other','0499',null),/続き位置/);
foreign=true;await assert.rejects(read({},'company','0499',null),/所属/);foreign=false;
assert.equal(requests.length,6);
raw[500].updatedAt={toDate:()=>new Date('2026-09-05T12:00:00Z')};raw[500].id='0500';
const dated=await read({},'company','0499',null);
assert.equal(dated.staff[0].updatedAt,'2026-09-05T12:00:00.000Z');
await assert.rejects(read({},'','0499',null),/再読込/);
await assert.rejects(read({},'company','',null),/再読込/);
const terminal=await read({},'company','0999',null);assert.equal(terminal.staff.length,0);assert.equal(terminal.hasMore,false);

const wrapped=await scope.exports.readCurrentAdminStaffPage('company','0499',null);assert.equal(wrapped.staff.length,100);
const moreCode=compile(extract('  async function loadMoreAdminStaff()','  async function refreshAdminJobs()').replace('await import("./staff-directory-page")','await loadPageModule()'));
for(const scenario of ['success','failure','auth','refresh','role','token-auth']){
 const gate=deferred(),tokenGate=deferred();let calls=0;
 const state={staff:[{id:'old'}],busy:false,message:'',hasMore:true};
 const user={getIdTokenResult:()=>tokenGate.promise};
 const ctx={Error,firebaseApp:{},auth:{currentUser:user},adminSessionReady:true,hasMoreStaff:true,jobDirectoryPendingRef:{current:false},jobDirectoryVersionRef:{current:0},staffAnchorRef:{current:'old'},staffCursorRef:{current:null},
  loadPageModule:async()=>({readCurrentAdminStaffPage:()=>{calls++;return gate.promise;}}),setJobDirectoryBusy:v=>state.busy=v,setStaffDirectoryMessage:v=>state.message=v,setStaff:fn=>state.staff=fn(state.staff),setHasMoreStaff:v=>state.hasMore=v};
 runInNewContext(moreCode,ctx);
 const task=ctx.loadMoreAdminStaff();await ctx.loadMoreAdminStaff();
 assert.equal(state.busy,true);
 if(scenario==='token-auth')ctx.auth.currentUser={};
 tokenGate.resolve({claims:{role:scenario==='role'?'staff':'admin',companyId:'company'}});
 await new Promise(resolve=>setImmediate(resolve));
 if(scenario==='role'||scenario==='token-auth'){await task;assert.equal(calls,0);continue;}
 assert.equal(calls,1);
 if(scenario==='auth')ctx.auth.currentUser={};
 if(scenario==='refresh')ctx.jobDirectoryVersionRef.current++;
 if(scenario==='failure')gate.reject(new Error('offline'));
 else gate.resolve({staff:[{id:'old',updated:true},{id:'new'}],cursor:{id:'new'},hasMore:false});
 await task;
 if(scenario==='success'){assert.equal(state.staff.length,2);assert.equal(state.staff[0].updated,true);assert.equal(state.hasMore,false);assert.equal(state.busy,false);}
 else{assert.equal(state.staff.length,1);assert.equal(ctx.staffCursorRef.current,null);assert.equal(state.hasMore,true);}
 if(scenario==='failure'){assert.equal(state.busy,false);assert.match(state.message,/offline/);assert.equal(ctx.jobDirectoryPendingRef.current,false);ctx.loadPageModule=async()=>({readCurrentAdminStaffPage:async()=>({staff:[{id:'retried'}],cursor:{id:'retried'},hasMore:false})});await ctx.loadMoreAdminStaff();assert.equal(state.staff.at(-1).id,'retried');}
}


console.log('Admin staff server paging passed: 1000 profiles, 500 bootstrap + 100/page, company/anchor rejection, terminal page, duplicate merge, retry, token/auth/refresh races.');

const resetCode=compile(extract('  function resetStaffPaging(', '  const [staffQuery,'));
for(const count of [0,499,500,1000]){const state={more:null};const ctx={staffCursorRef:{current:{id:'old'}},staffAnchorRef:{current:'old'},setHasMoreStaff:v=>state.more=v};runInNewContext(resetCode,ctx);ctx.resetStaffPaging(Array.from({length:count},(_,i)=>({id:String(i)})));assert.equal(ctx.staffCursorRef.current,null);assert.equal(ctx.staffAnchorRef.current,count?String(count-1):'');assert.equal(state.more,count>=500);}
for(const condition of ['db','auth','ready','more','pending']){const ctx={firebaseApp:condition==='db'?null:{},auth:{currentUser:condition==='auth'?null:{}},adminSessionReady:condition!=='ready',hasMoreStaff:condition!=='more',jobDirectoryPendingRef:{current:condition==='pending'}};runInNewContext(moreCode,ctx);await ctx.loadMoreAdminStaff();}
console.log('Admin staff paging reset/closed cases passed: bootstrap threshold, cursor reset, no database/session/readiness/more and pending request.');
