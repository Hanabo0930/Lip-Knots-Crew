import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';import {runInNewContext} from 'node:vm';
const app=fs.readFileSync('apps/staff/src/App.tsx','utf8');const start=app.indexOf('  async function loadOpenJobs('),end=app.indexOf('  async function loadTasks(',start);assert.ok(start>=0&&end>start);const code=ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const doc=id=>({id,data:()=>({id:'wrong-data-id',title:id})});
function setup(){const state={rows:[],messages:[],calls:[]};const ctx={firebaseConfigured:true,db:{},companyId:'company',openJobsStatus:'ready',hasMoreOpenJobs:false,openJobsCursorRef:{current:null},openJobsDateRef:{current:''},openJobsLoadVersionRef:{current:0},authLoadVersionRef:{current:1},localDateKey:()=> '2026-09-10',collection:()=>({}),where:(...v)=>v,orderBy:(...v)=>v,startAfter:v=>({after:v.id}),limit:v=>({limit:v}),query:(...v)=>v,availableOpenJobs:v=>v,setOpenJobs:v=>state.rows=typeof v==='function'?v(state.rows):v,setHasMoreOpenJobs:v=>ctx.hasMoreOpenJobs=v,setOpenJobsPageMessage:v=>state.messages.push(v),setOpenJobsStatus:v=>ctx.openJobsStatus=v,setExpandedOpenJobId:()=>{},setMessage:()=>{},getDocsFromServer:query=>new Promise((resolve,reject)=>state.calls.push({query,resolve,reject}))};
 const hook={exports:{},require:()=>({useCallback:f=>f,useRef:v=>({current:v}),useState:v=>[v(),()=>{}]})};runInNewContext(ts.transpileModule(fs.readFileSync('apps/staff/src/useAsyncAction.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,hook);Object.assign(ctx,hook.exports.useAsyncAction());runInNewContext(code,ctx);return {ctx,state};}
for(const count of [0,100,101]){const {ctx,state}=setup();const p=ctx.loadOpenJobs();state.calls[0].resolve({docs:Array.from({length:count},(_,i)=>doc('job'+i))});await p;assert.equal(state.rows.length,Math.min(100,count));assert.equal(ctx.hasMoreOpenJobs,count>100);assert.equal(ctx.openJobsCursorRef.current?.id,count?'job'+(Math.min(100,count)-1):undefined);assert.ok(state.calls[0].query.some(v=>v.limit===101));}
for(const mode of ['success','failure','auth','newer','empty','more']){const {ctx,state}=setup();state.rows=[{id:'previous'}];ctx.hasMoreOpenJobs=true;ctx.openJobsCursorRef.current=doc('cursor');ctx.openJobsDateRef.current='2026-09-10';const p=ctx.loadMoreOpenJobs();void ctx.loadMoreOpenJobs();void ctx.refreshOpenJobs();assert.equal(state.calls.length,1);assert.ok(state.calls[0].query.some(v=>v.after==='cursor'));
 if(mode==='auth')ctx.authLoadVersionRef.current++;if(mode==='newer')ctx.openJobsLoadVersionRef.current++;
 if(mode==='failure')state.calls[0].reject(Error('offline'));else state.calls[0].resolve({docs:mode==='empty'?[]:mode==='more'?Array.from({length:101},(_,i)=>doc('extra'+i)):[doc('previous'),doc('new')]});await p;assert.equal(ctx.isPending('open-jobs-refresh'),false);
 if(mode==='more'){assert.equal(state.rows.length,101);assert.equal(ctx.hasMoreOpenJobs,true);assert.match(state.messages.at(-1),/続きを読み込みました/);}
 else if(mode==='success'){assert.equal(state.rows.length,2);assert.equal(state.rows[1].id,'new');assert.equal(ctx.hasMoreOpenJobs,false);assert.equal(ctx.openJobsCursorRef.current.id,'new');}
 else if(mode==='empty'){assert.equal(state.rows.length,1);assert.equal(ctx.hasMoreOpenJobs,false);}
 else {assert.equal(state.rows.length,1);assert.equal(ctx.openJobsCursorRef.current.id,'cursor');assert.equal(ctx.hasMoreOpenJobs,true);}
 if(['success','empty'].includes(mode))assert.match(state.messages.at(-1),/最後まで読み込みました/);
 if(['auth','newer'].includes(mode))assert.equal(state.messages.at(-1),'');
 if(mode==='failure'){assert.match(state.messages.at(-1),/もう一度/);const retry=ctx.loadMoreOpenJobs();assert.equal(state.calls.length,2);state.calls[1].resolve({docs:[doc('new')]});await retry;assert.equal(state.rows.length,2);}
}
console.log('Open jobs pagination passed: first-page 0/100/101, append/dedup, duplicate lock, failure/retry, auth/new load, empty end; synthetic SDK only.');

{
 const {ctx,state}=setup();ctx.hasMoreOpenJobs=true;ctx.openJobsCursorRef.current=doc('cursor');
 const applyStart=app.indexOf('  async function apply(job:Job){'),applyEnd=app.indexOf('  function resetPreContactInput(',applyStart);assert.ok(applyEnd>applyStart);
 runInNewContext(ts.transpileModule(app.slice(applyStart,applyEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 let started=0;ctx.setPendingApplicationJobId=()=>started++;
 let release;const busy=ctx.run('open-jobs-refresh',()=>new Promise(resolve=>release=resolve));await ctx.apply({id:'one'});assert.equal(started,0);assert.equal(state.calls.length,0);release();await busy;
 const applying=ctx.run('apply-action',()=>new Promise(resolve=>release=resolve));await ctx.loadMoreOpenJobs();await ctx.refreshOpenJobs();assert.equal(state.calls.length,0);release();await applying;
 const page=ctx.loadMoreOpenJobs();assert.equal(state.calls.length,1);state.calls[0].resolve({docs:[]});await page;
}
console.log('Open job actions: refresh/additional page blocks application; application blocks refresh/additional page; controls recover after completion.');

{
 const {ctx,state}=setup();state.rows=[{id:'previous'}];ctx.getDocs=()=>{throw Error('cache fallback is forbidden');};
 const request=ctx.refreshOpenJobs();assert.equal(state.calls.length,1);state.calls[0].reject(Error('offline'));await request;
 assert.equal(ctx.openJobsStatus,'error');assert.equal(state.rows[0].id,'previous');
 const retry=ctx.refreshOpenJobs();state.calls[1].resolve({docs:[doc('fresh')]});await retry;assert.equal(ctx.openJobsStatus,'ready');assert.equal(state.rows[0].id,'fresh');
}
console.log('Open job server reads: offline first-page read keeps previous rows/error; server retry restores current list without cache fallback.');
