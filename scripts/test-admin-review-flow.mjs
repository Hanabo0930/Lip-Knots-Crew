import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const app=readFileSync('apps/admin/src/App.tsx','utf8').replace(/\r\n/g,'\n');
const extract=(start,end)=>{const a=app.indexOf(start),b=app.indexOf(end,a);assert.ok(a>=0&&b>a);return app.slice(a,b);};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const raw=Array.from({length:1000},(_,i)=>({id:String(i).padStart(4,'0'),companyId:'company',workDate:'2026-09-05',storeName:'Fixture'}));
const snap=row=>({id:row.id,exists:()=>true,data:()=>row});
let requests=[],missing=false,foreign=false;
const sdk={doc:(_db,_collection,id)=>id,collection:()=>null,where:(field,op,value)=>({field,op,value}),orderBy:(field,order)=>({sort:field,order}),startAfter:cursor=>({cursor}),limit:count=>({count}),query:(_,...filters)=>filters,
 getDoc:async id=>missing?{exists:()=>false}:snap(raw.find(row=>row.id===id)),
 getDocs:async filters=>{
  requests.push(filters);
  assert.ok(filters.some(f=>f.field==='companyId'&&f.op==='=='&&f.value==='company'));
  assert.ok(filters.some(f=>f.sort==='workDate'&&f.order==='asc'));
  assert.equal(filters.find(f=>f.count).count,101);
  const id=filters.find(f=>f.cursor).cursor.id;
  const selected=raw.slice(raw.findIndex(row=>row.id===id)+1).slice(0,101);
  return{docs:foreign?[snap({...selected[0],companyId:'other'})]:selected.map(snap)};
 }};
const scope={exports:{},require:name=>{assert.equal(name,'firebase/firestore');return sdk;}};
runInNewContext(compile(readFileSync('apps/admin/src/job-directory-page.ts','utf8')),scope);
const read=scope.exports.readAdminJobPage;
const ids=raw.slice(0,100).map(row=>row.id);let cursor=null,more=true;
while(more){const page=await read({},'company','0099',cursor);assert.ok(page.jobs.length<=100);ids.push(...page.jobs.map(row=>row.id));cursor=page.cursor;more=page.hasMore;}
assert.deepEqual(ids,raw.map(row=>row.id));assert.equal(new Set(ids).size,1000);
missing=true;await assert.rejects(read({},'company','missing',null),/再読込/);missing=false;
await assert.rejects(read({},'other','0099',null),/続き位置/);
foreign=true;await assert.rejects(read({},'company','0099',null),/所属/);foreign=false;
assert.equal(requests.length,10);
raw[100].workDate={toDate:()=>new Date('2026-09-05T12:00:00Z')};
const dated=await read({},'company','0099',null);
assert.equal(dated.jobs[0].workDate,new Date('2026-09-05T12:00:00Z').toLocaleDateString('ja-JP',{month:'numeric',day:'numeric',weekday:'short'}));

const moreCode=compile(extract('  async function loadMoreAdminJobs()','  async function refreshAdminJobs()').replace('await import("./job-directory-page")','await loadPageModule()'));
for(const scenario of ['success','failure','auth','refresh','role','token-auth']){
 const gate=deferred(),tokenGate=deferred();let calls=0;
 const state={jobs:[{id:'old'}],busy:false,message:'',hasMore:true};
 const user={getIdTokenResult:()=>tokenGate.promise};
 const ctx={Error,db:{},auth:{currentUser:user},adminSessionReady:true,hasMoreJobs:true,jobDirectoryPendingRef:{current:false},jobDirectoryVersionRef:{current:0},jobAnchorRef:{current:'old'},jobCursorRef:{current:null},
  loadPageModule:async()=>({readAdminJobPage:()=>{calls++;return gate.promise;}}),setJobDirectoryBusy:v=>state.busy=v,setJobDirectoryMessage:v=>state.message=v,setJobs:fn=>state.jobs=fn(state.jobs),setHasMoreJobs:v=>state.hasMore=v};
 runInNewContext(moreCode,ctx);
 const task=ctx.loadMoreAdminJobs();await ctx.loadMoreAdminJobs();
 assert.equal(state.busy,true);
 if(scenario==='token-auth')ctx.auth.currentUser={};
 tokenGate.resolve({claims:{role:scenario==='role'?'staff':'admin',companyId:'company'}});
 await new Promise(resolve=>setImmediate(resolve));
 if(scenario==='role'||scenario==='token-auth'){await task;assert.equal(calls,0);continue;}
 assert.equal(calls,1);
 if(scenario==='auth')ctx.auth.currentUser={};
 if(scenario==='refresh')ctx.jobDirectoryVersionRef.current++;
 if(scenario==='failure')gate.reject(new Error('offline'));
 else gate.resolve({jobs:[{id:'old',updated:true},{id:'new'}],cursor:{id:'new'},hasMore:false});
 await task;
 if(scenario==='success'){assert.equal(state.jobs.length,2);assert.equal(state.jobs[0].updated,true);assert.equal(state.hasMore,false);assert.equal(state.busy,false);}
 else{assert.equal(state.jobs.length,1);assert.equal(ctx.jobCursorRef.current,null);assert.equal(state.hasMore,true);}
 if(scenario==='failure'){assert.equal(state.busy,false);assert.match(state.message,/offline/);assert.equal(ctx.jobDirectoryPendingRef.current,false);ctx.loadPageModule=async()=>({readAdminJobPage:async()=>({jobs:[{id:'retried'}],cursor:{id:'retried'},hasMore:false})});await ctx.loadMoreAdminJobs();assert.equal(state.jobs.at(-1).id,'retried');}
}

const createCode=compile(extract('  async function createResubmission()','  async function refreshResubmissionList()'));
for(const scenario of ['success','failure','refresh-failure','context','auth','invalid-file']){
 const gate=deferred();let calls=0,refreshes=0;const state={messages:[],busy:false};
 const user={uid:'one'};
 const ctx={resubmissionPendingRef:{current:false},timelineReady:true,timelinePendingRef:{current:null},selectedAdminJobId:'job',resubmitReasons:['reason'],resubmitNote:'note',resubmitType:'report',selectedSourceFile:scenario==='invalid-file'?{id:'foreign',submissionId:'other'}:null,submissionTimeline:[],firebaseConfigured:true,functions:{},auth:{currentUser:user},timelineKey:'first',timelineKeyRef:{current:'first'},setMessage:v=>state.messages.push(v),setResubmissionBusy:v=>state.busy=v,
  httpsCallable:()=>()=>{calls++;return gate.promise;},loadResubmissions:async guard=>{assert.equal(guard(),true);refreshes++;if(scenario==='refresh-failure')throw new Error('refresh offline');}};
 runInNewContext(createCode,ctx);
 const task=ctx.createResubmission();await ctx.createResubmission();
 if(scenario==='invalid-file'){await task;assert.equal(calls,0);continue;}
 assert.equal(calls,1);assert.equal(state.busy,true);
 if(scenario==='context')ctx.timelineKeyRef.current='second';
 if(scenario==='auth')ctx.auth.currentUser={uid:'two'};
 if(scenario==='failure')gate.reject(new Error('uncertain network outcome'));else gate.resolve({});
 await task;assert.equal(state.busy,false);assert.equal(ctx.resubmissionPendingRef.current,false);
 if(scenario==='success'){assert.equal(refreshes,1);assert.match(state.messages[0],/送りました/);}
 if(scenario==='failure')assert.match(state.messages[0],/再送する前に/);
 if(scenario==='refresh-failure')assert.match(state.messages.at(-1),/受付済み/);
 if(['context','auth'].includes(scenario)){assert.equal(refreshes,0);assert.equal(state.messages.length,0);}
}
console.log('Admin review flow passed: 1000-job snapshot paging, company/anchor checks, duplicate merge, token/refresh/auth races, single request on double click, uncertain outcome and accepted-request refresh failure.');
