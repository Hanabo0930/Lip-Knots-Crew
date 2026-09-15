import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import {createRequire} from 'node:module';import {resolve} from 'node:path';
const ts=createRequire(resolve(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json'))('typescript'),compile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const app=readFileSync('apps/staff/src/App.tsx','utf8'),list={exports:{}};runInNewContext(compile(readFileSync('apps/staff/src/job-list.ts','utf8')),list);const a=app.indexOf('  function openShiftJob('),b=app.indexOf('  const [hasMoreUpcomingShifts',a);assert.ok(a>=0&&b>a);const code=compile(app.slice(a,b));const past={id:'past',dateKey:'2026-09-01',status:'assigned'},future={id:'future',dateKey:'2026-09-10',status:'assigned'};
for(const mode of ['open-past','open-future','close-past','close-future','close-only-past','expand-past']){const state={selected:past,expanded:mode.startsWith('close'),focus:0};const ctx={selectedJob:mode==='close-future'?future:past,showPastShifts:state.expanded,upcomingShifts:mode==='close-only-past'?[]:[future],pastShifts:[past],splitAssignedJobs:jobs=>list.exports.splitAssignedJobs(jobs,'2026-09-09'),setSelectedJob:v=>state.selected=v,setShowPastShifts:v=>state.expanded=v,setShiftFocusRequest:fn=>state.focus=fn(state.focus)};runInNewContext(code,ctx);if(mode.startsWith('open')){ctx.openShiftJob(mode==='open-past'?past:future);assert.equal(state.selected.id,mode==='open-past'?'past':'future');assert.equal(state.focus,1);assert.equal(state.expanded,mode==='open-past');}else{state.selected=ctx.selectedJob;ctx.togglePastShifts();assert.equal(state.selected.id,mode==='close-past'||mode==='close-future'?'future':'past');assert.equal(state.expanded,mode==='expand-past');}}
assert.doesNotMatch(app,/useEffect\(\(\)=>\{\s*if\(showPastShifts/);assert.match(app,/onClick=\{togglePastShifts\}/);
console.log('Past shift selection passed: explicit past/future open, collapse/expand with and without upcoming jobs; no cross-view selection effect.');

{
 const from=app.indexOf('  useEffect(()=>{const upcomingIndex='),end=app.indexOf(';',app.indexOf('},[',from))+1;assert.ok(from>=0&&end>from);const effect=compile(app.slice(from,end));
 for(const kind of ['upcoming','past']){
  const jobs=Array.from({length:120},(_,id)=>({id:String(id)})),state={page:0,previous:null};
  const ctx={selectedJob:jobs[75],upcomingShifts:kind==='upcoming'?jobs:[],pastShifts:kind==='past'?jobs:[],shiftFocusRequest:0,setUpcomingPage:value=>{if(kind==='upcoming')state.page=value;},setPastPage:value=>{if(kind==='past')state.page=value;},useEffect:(fn,deps)=>{if(!state.previous||deps.some((value,index)=>value!==state.previous[index]))fn();state.previous=Array.from(deps);}};
  runInNewContext(effect,ctx);assert.equal(state.page,1);state.page=0;
  runInNewContext(effect,ctx);assert.equal(state.page,0,'Manual paging must remain available');
  ctx.shiftFocusRequest++;runInNewContext(effect,ctx);assert.equal(state.page,1,'Reopening the same selected job returns to its page');
 }
}
console.log('Explicit shift reopen: same selected ID returns to its upcoming/past page, ordinary paging stays unchanged.');
