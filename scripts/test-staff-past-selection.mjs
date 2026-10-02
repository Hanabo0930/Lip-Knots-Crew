import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import {createRequire} from 'node:module';import {resolve} from 'node:path';
const ts=createRequire(resolve(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json'))('typescript'),compile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const app=readFileSync('apps/staff/src/App.tsx','utf8'),list={exports:{}};runInNewContext(compile(readFileSync('apps/staff/src/job-list.ts','utf8')),list);const a=app.indexOf('  function openShiftJob('),b=app.indexOf('  const [hasMoreUpcomingShifts',a);assert.ok(a>=0&&b>a);const code=compile(app.slice(a,b));const past={id:'past',dateKey:'2026-09-01',status:'assigned'},future={id:'future',dateKey:'2026-09-10',status:'assigned'};
for(const mode of ['open-past','open-future','close-past','close-future','close-only-past','expand-past']){const state={selected:past,expanded:mode.startsWith('close'),focus:0};const ctx={selectedJob:mode==='close-future'?future:past,showPastShifts:state.expanded,upcomingShifts:mode==='close-only-past'?[]:[future],pastShifts:[past],splitAssignedJobs:jobs=>list.exports.splitAssignedJobs(jobs,'2026-09-09'),setSelectedJob:v=>state.selected=v,setShowPastShifts:v=>state.expanded=v,setShiftFocusRequest:fn=>state.focus=fn(state.focus)};runInNewContext(code,ctx);if(mode.startsWith('open')){ctx.openShiftJob(mode==='open-past'?past:future);assert.equal(state.selected.id,mode==='open-past'?'past':'future');assert.equal(state.focus,1);assert.equal(state.expanded,mode==='open-past');}else{state.selected=ctx.selectedJob;ctx.togglePastShifts();assert.equal(state.selected.id,mode==='close-past'||mode==='close-future'?'future':'past');assert.equal(state.expanded,mode==='expand-past');}}
assert.doesNotMatch(app,/useEffect\(\(\)=>\{\s*if\(showPastShifts/);assert.match(app,/onClick=\{togglePastShifts\}/);
console.log('Past shift selection passed: explicit past/future open, collapse/expand with and without upcoming jobs; no cross-view selection effect.');

{
 const from=app.indexOf('  useEffect(()=>{const upcomingIndex='),end=app.indexOf(';',app.indexOf('},[',from))+1;
 assert.ok(from>=0&&end>from);const upcomingEffect=compile(app.slice(from,end));
 const component=readFileSync('apps/staff/src/PastShiftHistory.tsx','utf8');
 const marker=component.indexOf('    const year = preferredYear.current;');
 const pastFrom=component.lastIndexOf('  useEffect(',marker),pastEnd=component.indexOf('  return <PastShiftHistoryView',marker);
 assert.ok(marker>=0&&pastFrom>=0&&pastEnd>pastFrom,'Locate the actual year-history selection effect');
 const pastEffect=compile(component.slice(pastFrom,pastEnd));
 assert.match(app,/selectionRequest=\{shiftFocusRequest\}/);
 for(const kind of ['upcoming','past']){
  const jobs=Array.from({length:120},(_,id)=>({id:String(id),dateKey:'2025-01-01'})),state={page:0,previous:null};
  const useEffect=(fn,deps)=>{if(!state.previous||deps.some((value,index)=>value!==state.previous[index]))fn();state.previous=Array.from(deps);};
  const ctx=kind==='upcoming'
   ? {selectedJob:jobs[75],upcomingShifts:jobs,shiftFocusRequest:0,setUpcomingPage:value=>{state.page=value;},useEffect}
   : {props:{selectedId:jobs[75].id,selectedDateKey:jobs[75].dateKey,selectionRequest:0},
      state:{years:[2026,2025],year:2025,rows:jobs},preferredYear:{current:2025},
      controller:{current:{selectYear:year=>assert.equal(year,2025)}},setPage:value=>{state.page=value;},useEffect};
  const effect=kind==='upcoming'?upcomingEffect:pastEffect;
  runInNewContext(effect,ctx);assert.equal(state.page,1);
  state.page=0;runInNewContext(effect,ctx);
  assert.equal(state.page,0,'Manual paging must remain available');
  if(kind==='upcoming')ctx.shiftFocusRequest++;else ctx.props.selectionRequest++;
  runInNewContext(effect,ctx);
  assert.equal(state.page,1,'Reopening the same selected job returns to its page');
  state.page=0;if(kind==='past')ctx.props.isCurrent=()=>true;
  runInNewContext(effect,ctx);
  assert.equal(state.page,0,'An unrelated rerender must preserve the manually chosen page');
 }
}
console.log('Explicit shift reopen: same selected ID returns to its upcoming/past page, ordinary paging stays unchanged.');
