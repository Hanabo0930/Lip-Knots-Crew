import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const app=fs.readFileSync('apps/staff/src/App.tsx','utf8');
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const results=[];
async function test(name,run){await run();results.push({name,passed:true});}
function moduleFile(file,globals={}){
 const scope={exports:{},...globals};vm.runInNewContext(compile(fs.readFileSync(file,'utf8')),scope);return scope.exports;
}
const access=moduleFile('apps/staff/src/shift-access.ts');
function part(start,end){const a=app.indexOf(start),b=app.indexOf(end,a);assert(a>=0&&b>a,start);return app.slice(a,b);}
const forget=part('  function forgetInaccessibleShifts(','  async function loadTaskJob(');
const task=part('  async function loadTaskJob(','  async function fetchTasks(');
const selected=part('  async function refreshSelectedJob(','  async function requestLogin(');
const refresh=part('  async function refreshBusinessData(','  async function refreshPushStatus(');
const source=ts.createSourceFile('App.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let startupCatch;
function visit(node){if(ts.isCatchClause(node)&&node.block.getText(source).includes('restoredCachedData&&sessionVerified'))startupCatch=node.block.getText(source);ts.forEachChild(node,visit);}
visit(source);assert(startupCatch,'Actual cached bootstrap catch must be tested');
function harness(){
 const job={id:'one',dateKey:'2026-11-02',status:'assigned',menuName:'synthetic',companyId:'company',assignedStaffId:'staff'};
 const other={...job,id:'other'},tasks=[{id:'t1',jobId:'one',kind:'report',title:'Report',body:'',priority:'normal'},{id:'t2',jobId:'other',kind:'report',title:'Report',body:'',priority:'normal'}];
 const storage=new Map(),cache=moduleFile('apps/staff/src/business-cache.ts',{localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
 cache.saveBusinessSnapshot('user','company','staff',[job,other],tasks);
 const state={jobs:[job,other],tasks,selected:job,open:[job],mail:true,messages:[],status:'ready',source:'cached'};
 const s={...access,...cache,console,user:{uid:'user'},current:{uid:'user'},companyId:'company',staffId:'staff',db:{},functions:{},firebaseConfigured:true,
  authLoadVersionRef:{current:1},pastShiftVersionRef:{current:1},tasksReadVersionRef:{current:1},mailPanelVersion:{current:0},
  businessRefreshInFlightRef:{current:false},businessDataStatus:'ready',businessRefreshing:false,submissionEditPending:false,openJobsStatus:'idle',
  lastBusinessDataRefreshAt:0,BUSINESS_DATA_REFRESH_INTERVAL_MS:0,performance:{now:()=>1},
  restoredCachedData:true,sessionVerified:true,restoredScope:{companyId:'company',staffId:'staff'},
  isCurrentAuthLoad:()=>true,isPending:()=>false,run:async(_key,fn)=>fn(),doc:(_db,_collection,id)=>({id}),orderAssignedJobs:jobs=>jobs,
  setMyJobs:value=>state.jobs=typeof value==='function'?value(state.jobs):value,
  setTasks:value=>state.tasks=typeof value==='function'?value(state.tasks):value,
  setSelectedJob:value=>state.selected=typeof value==='function'?value(state.selected):value,
  setOpenJobs:value=>state.open=typeof value==='function'?value(state.open):value,
  setShowMailApplications:v=>state.mail=v,setBusinessDataStatus:v=>state.status=v,setBusinessDataSource:v=>state.source=v,setMessage:v=>state.messages.push(v),
  setBusinessRefreshing:()=>{},setBusinessRefreshMs:()=>{},setHomeLoadedFromCache:()=>{},setCompanyId:()=>{},setStaffId:()=>{},setHomeDisplayMs:()=>{},
  loadPrimaryBusinessData:async()=>true,refreshOpenJobs:async()=>{},getDocFromServer:async()=>({exists:()=>true,id:'one',data:()=>job})
 };
 vm.runInNewContext(compile(forget+task+selected+refresh+'\nasync function startupFailure(error)'+startupCatch),s);
 return {s,state,storage,cache,job,other};
}
for(const method of ['loadTaskJob','refreshSelectedJob'])for(const code of ['permission-denied','firestore/permission-denied'])await test(method+' evicts denied shift/detail/task/cache without erasing another shift '+code,async()=>{
 const h=harness();h.s.getDocFromServer=async()=>{throw {code};};const before=h.s.pastShiftVersionRef.current;assert.ok(!await h.s[method]('one'));
 assert.deepEqual(Array.from(h.state.jobs,j=>j.id),['other']);assert.deepEqual(Array.from(h.state.tasks,t=>t.jobId),['other']);
 assert.equal(h.state.selected,null);assert.equal(h.state.mail,false);assert.equal(h.storage.size,0);assert(h.s.pastShiftVersionRef.current>before);
});
for(const method of ['loadTaskJob','refreshSelectedJob'])for(const stale of ['auth','read'])await test(method+' old '+stale+' failure cannot evict the current user',async()=>{
 const h=harness();h.s.getDocFromServer=async()=>{if(stale==='auth')h.s.authLoadVersionRef.current++;else h.s.pastShiftVersionRef.current++;throw {code:'permission-denied'};};
 await h.s[method]('one');assert.equal(h.state.jobs.length,2);assert.equal(h.state.selected.id,'one');assert(h.storage.size>0);
});
for(const method of ['loadTaskJob','refreshSelectedJob'])await test(method+' offline failure keeps recoverable data rather than treating it as cancellation',async()=>{
 const h=harness();h.s.getDocFromServer=async()=>{throw {code:'unavailable'};};await assert.rejects(h.s[method]('one'));assert.equal(h.state.jobs.length,2);assert(h.storage.size>0);
});
for(const method of ['loadTaskJob','refreshSelectedJob'])await test(method+' server missing/cancelled removes old display and persistent snapshot',async()=>{
 for(const mode of ['missing','cancelled']){const h=harness();h.s.getDocFromServer=async()=>({exists:()=>mode!=='missing',id:'one',data:()=>({...h.job,status:'cancelled',cancelled:true})});await h.s[method]('one');assert.deepEqual(Array.from(h.state.jobs,j=>j.id),['other']);assert.equal(h.state.selected,null);assert.equal(h.storage.size,0);}
});
for(const code of ['permission-denied','firestore/permission-denied','functions/permission-denied'])await test('Bootstrap does not restore cached successful state after '+code,async()=>{
 const h=harness();await h.s.startupFailure({code});assert.equal(h.s.restoredCachedData,false);assert.equal(h.state.jobs.length,0);assert.equal(h.state.tasks.length,0);assert.equal(h.state.selected,null);assert.equal(h.state.status,'error');assert.equal(h.state.source,'none');assert.equal(h.storage.size,0);
});
await test('Bootstrap unavailable and old-auth failure preserve the intended recovery behavior',async()=>{
 const h=harness();await h.s.startupFailure({code:'unavailable'});assert.equal(h.state.status,'ready');assert.equal(h.state.source,'cached');assert.equal(h.state.jobs.length,2);
 const old=harness();old.s.isCurrentAuthLoad=()=>false;await old.s.startupFailure({code:'permission-denied'});assert.equal(old.state.jobs.length,2);assert(old.storage.size>0);
});
for(const code of ['permission-denied','functions/permission-denied'])await test('Refresh denial clears prior successful list and cache '+code,async()=>{
 const h=harness();h.s.loadPrimaryBusinessData=async()=>{throw {code};};await h.s.refreshBusinessData(true);assert.equal(h.state.jobs.length,0);assert.equal(h.state.tasks.length,0);assert.equal(h.state.selected,null);assert.equal(h.state.status,'error');assert.equal(h.state.source,'none');assert.equal(h.storage.size,0);
});
await test('Temporary refresh failure keeps prior data with stale status',async()=>{
 const h=harness();h.s.loadPrimaryBusinessData=async()=>{throw {code:'unavailable'};};await h.s.refreshBusinessData(true);assert.equal(h.state.jobs.length,2);assert.equal(h.state.source,'stale');assert(h.storage.size>0);
});
await test('Legacy cache and a current-version cancelled document cannot restore private data',async()=>{
 for(const version of [1,2])for(const flag of ['status','cancelled']){
  const h=harness(),key='lkcBusinessSnapshot:user:company:staff',job={...h.job,cancellationReason:'SYNTHETIC_PRIVATE_REASON',...(flag==='status'?{status:'cancelled'}:{cancelled:true})};
  h.storage.set(key,JSON.stringify({version,savedAt:1000,jobs:[job],tasks:[]}));assert.equal(h.cache.loadBusinessSnapshot('user','company','staff',1001),null);assert(!h.storage.has(key));
 }
 const h=harness(),key='lkcBusinessSnapshot:user:company:staff';h.storage.set(key,JSON.stringify({version:1,savedAt:1000,jobs:[h.job],tasks:[]}));assert.equal(h.cache.loadBusinessSnapshot('user','company','staff',1001),null);
});
await test('Saving a cancelled row invalidates the snapshot; normal and pending assignments retain stable IDs',async()=>{
 const h=harness();h.cache.saveBusinessSnapshot('user','company','staff',[h.other,{...h.job,cancelled:true,cancellationReason:'PRIVATE'}],h.state.tasks);assert.equal(h.storage.size,0);
 h.cache.saveBusinessSnapshot('user','company','staff',[h.job,{...h.other,applicationUnconfirmed:true}],h.state.tasks);
 const loaded=h.cache.loadBusinessSnapshot('user','company','staff');assert.equal(loaded.version,2);assert.equal(loaded.jobs[1].applicationUnconfirmed,true);assert.deepEqual(Array.from(loaded.jobs,j=>j.id),['one','other']);
});
await test('All five actual assigned queries include the company, staff and assigned status before reading',async()=>{
 const requests=[],s=harness().s;
 Object.assign(s,{localDateKey:()=>'2026-11-01',pastShiftDateRef:{current:'2026-11-01'},upcomingShiftCursorRef:{current:null},setHasMoreUpcomingShifts:()=>{},setUpcomingShiftMessage:()=>{},
  collection:()=>({}),where:(field,op,value)=>({field,op,value}),orderBy:(field,direction)=>({order:field,direction}),limit:n=>({limit:n}),startAfter:cursor=>({cursor}),query:(_collection,...parts)=>parts,
  getDocs:async filters=>{requests.push(filters);return {docs:[]};},getDocsFromServer:async filters=>{requests.push(filters);return {docs:[]};}});
 vm.runInNewContext(compile(part('  async function fetchMyJobs(','  function forgetInaccessibleShifts(')),s);
 await s.fetchMyJobs();s.hasMoreUpcomingShifts=true;s.upcomingShiftCursorRef.current={id:'cursor'};await s.loadMoreUpcomingShifts();
 const history=moduleFile('apps/staff/src/past-shift-reader.ts',{require:name=>name==='firebase/firestore'?s:{PAST_SHIFT_PAGE_SIZE:50}});
 const reader=history.firestorePastShiftReader({});await reader.oldest({companyId:'company',staffId:'staff',today:'2026-11-01'});await reader.page({companyId:'company',staffId:'staff',start:'2025-01-01',end:'2026-01-01'},null);
 assert.equal(requests.length,5);for(const filters of requests)for(const [field,value]of [['companyId','company'],['assignedStaffId','staff'],['status','assigned']])assert(filters.some(f=>f.field===field&&f.op==='=='&&f.value===value));
});
await test('A single exact index supports the new assigned query',async()=>{
 const indexes=JSON.parse(fs.readFileSync('firestore.indexes.json','utf8')).indexes;
 const fields=['companyId','assignedStaffId','status','dateKey'];const matches=indexes.filter(i=>i.collectionGroup==='jobs'&&i.queryScope==='COLLECTION'&&i.fields.length===4&&i.fields.every((f,n)=>f.fieldPath===fields[n]&&f.order==='ASCENDING'));assert.equal(matches.length,1);
});

await test('Past history permission denial clears visible pages and notifies the owner once; offline retry retains pages',async()=>{
 const jobList=moduleFile('apps/staff/src/job-list.ts');
 const history=moduleFile('apps/staff/src/past-shift-history.ts',{require:name=>name==='./job-list'?jobList:access});
 for(const mode of ['permission-denied','unavailable','stale']){
  const sample={id:'sample',companyId:'company',assignedStaffId:'staff',dateKey:'2025-01-01',status:'assigned'};
  let published,reads=0,denied=0,current=true;
  const reader={oldest:async()=>sample,page:async()=>{reads++;if(reads>1){if(mode==='stale')current=false;throw {code:mode==='stale'?'permission-denied':mode};}return Array.from({length:51},(_,i)=>({row:{...sample,id:'row-'+i},cursor:i}));}};
  const controller=history.createPastShiftHistory({uid:'u',companyId:'company',staffId:'staff',today:'2025-12-01'},reader,s=>published=s,()=>current,()=>denied++);
  await controller.initialize();assert.equal(published.rows.length,50);controller.loadMore();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
  assert.equal(published.rows.length,mode==='permission-denied'?0:50);assert.equal(denied,mode==='permission-denied'?1:0);controller.dispose();
 }
 let denied=0;const controller=history.createPastShiftHistory({uid:'u',companyId:'company',staffId:'staff',today:'2025-12-01'},{oldest:async()=>{throw {code:'permission-denied'};},page:()=>assert.fail('No page after denied oldest')},()=>{},()=>true,()=>denied++);
 await controller.initialize();assert.equal(denied,1);controller.dispose();
});

console.log(JSON.stringify({schema:'LK_CANCELLATION_PRIVACY_CLIENT_TESTS_V1',passed:results.length,failed:0,externalWrites:0,deployedRulesVerified:false,results},null,2));

