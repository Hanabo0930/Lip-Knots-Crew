import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
const require=createRequire(resolve('package.json')),ts=require('typescript');
const source=readFileSync('apps/staff/src/App.tsx','utf8');
const from=source.indexOf('  async function refreshOpenJobs('),to=source.indexOf('  async function loadTasks(',from);assert.ok(from>=0&&to>from);
const code=ts.transpileModule(source.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const results=[];
for(const change of ['none','auth','newer'])for(const outcome of ['success','failure','unconfirmed']){
 const messages=[];let finish,fail;const ctx={firebaseConfigured:true,companyId:'synthetic',isPending:()=>false,authLoadVersionRef:{current:1},openJobsLoadVersionRef:{current:0},setMessage:value=>messages.push(value),run:async(_key,fn)=>fn(),loadOpenJobs:()=>{ctx.openJobsLoadVersionRef.current++;return new Promise((resolve,reject)=>{finish=resolve;fail=reject;});}};
 runInNewContext(code,ctx);const pending=ctx.refreshOpenJobs();
 if(change==='auth')ctx.authLoadVersionRef.current++;if(change==='newer')ctx.openJobsLoadVersionRef.current++;
 if(outcome==='failure')fail(Error('offline'));else finish(outcome==='success');await pending;
 try{assert.equal(messages.length,change==='none'&&outcome!=='unconfirmed'?1:0);results.push({change,outcome,passed:true});}catch(e){results.push({change,outcome,passed:false,error:e.message});}
}
console.log(JSON.stringify({passed:results.every(r=>r.passed),cases:results.length,results},null,2));if(results.some(r=>!r.passed))process.exitCode=1;

const loadFrom=source.indexOf('  async function loadOpenJobs(');assert.ok(loadFrom>=0);
const loadCode=ts.transpileModule(source.slice(loadFrom,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
for(const mode of ['no-db','no-company','demo']){
 const state={status:'idle',messages:[],rows:[{id:'previous'}]};const ctx={openJobsCursorRef:{current:null},openJobsDateRef:{current:''},setHasMoreOpenJobs:()=>{},setOpenJobsPageMessage:()=>{},firebaseConfigured:mode!=='demo',db:mode==='no-db'?null:{},companyId:mode==='no-company'?'':'synthetic',openJobsLoadVersionRef:{current:0},authLoadVersionRef:{current:1},isPending:()=>false,run:async(_key,fn)=>fn(),setOpenJobsStatus:v=>state.status=v,setOpenJobs:v=>state.rows=v,setMessage:v=>state.messages.push(v),getDocsFromServer:()=>{throw Error('unexpected real read');}};runInNewContext(loadCode,ctx);
 await ctx.refreshOpenJobs();assert.equal(state.rows[0].id,'previous');assert.equal(state.status,mode==='demo'?'ready':'error');assert.equal(state.messages.length,1);assert.match(state.messages[0],mode==='demo'?/デモ/:/読み込めません/);assert.doesNotMatch(state.messages[0],/最新情報に更新しました/);
 if(mode!=='demo'){
  Object.assign(ctx,{db:{},companyId:'synthetic',query:()=>({}),collection:()=>({}),where:()=>({}),orderBy:()=>({}),limit:()=>({}),localDateKey:()=> '2026-09-10',getDocsFromServer:async()=>({docs:[{id:'fresh',data:()=>({})}]}),availableOpenJobs:v=>v,setExpandedOpenJobId:()=>{}});
  await ctx.refreshOpenJobs();assert.equal(state.status,'ready');assert.equal(state.rows[0].id,'fresh');assert.match(state.messages.at(-1),/最新情報に更新しました/);
 }
}
console.log('Open jobs setup: missing connection/scope stays retryable, restored setup loads data; demo confirmation stays explicit.');
