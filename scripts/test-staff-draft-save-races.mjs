import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync('apps/staff/src/App.tsx','utf8');
const start=source.indexOf('  const draftSavePaused=');
const end=source.indexOf('  useEffect(()=>{ if(!pushEnabled)',start);
assert.ok(start>=0&&end>start);
const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function setup(){
 const state={pending:new Set(),timers:new Map(),next:0,saves:[],messages:[],cleanup:null};
 const ctx={authLoadVersionRef:{current:1},previewContextRef:{current:'owned-key'},getSubmittedDraftReceipt:()=>null,setMessage:value=>state.messages.push(value),draftKey:'owned-key',draftHydrating:false,hydratedDraftKeyRef:{current:'owned-key'},skipNextDraftSaveRef:{current:false},files:['old-file'],isPending:key=>state.pending.has(key),useEffect:fn=>{state.cleanup=fn()},setTimeout:(fn,ms)=>{assert.equal(ms,300);const id=++state.next;state.timers.set(id,fn);return id},clearTimeout:id=>state.timers.delete(id),saveDraft:(key,files)=>{state.saves.push({key,files});return Promise.resolve()},showSubmissionMessage:value=>state.messages.push(value)};
 const render=()=>{state.cleanup?.();runInNewContext('{'+code+'}',ctx)};
 const fire=()=>{const timers=[...state.timers.values()];state.timers.clear();for(const fn of timers)fn()};
 return {state,ctx,render,fire};
}
let count=0;
for(const key of ['submission-files','submission-context']){
 for(const redraw of [false,true]){
  const {state,ctx,render,fire}=setup();render();state.pending.add(key);if(redraw)render();fire();assert.equal(state.saves.length,0);
  state.pending.clear();ctx.files=[];render();fire();assert.equal(state.saves.length,1);assert.deepEqual(state.saves[0].files,[]);count++;
 }
 const {state,ctx,render,fire}=setup();render();state.pending.add(key);render();state.pending.clear();render();fire();assert.equal(state.saves.length,1);assert.deepEqual(state.saves[0].files,['old-file']);count++;
}
for(const mode of ['current','changed-files','changed-key','unmount','paused']){
 const {state,ctx,render,fire}=setup();let reject;ctx.saveDraft=()=>new Promise((_,no)=>{reject=no});render();fire();
 if(mode==='changed-files'){ctx.files=['new-file'];render()}
 if(mode==='changed-key'){ctx.draftKey='other-key';ctx.hydratedDraftKeyRef.current='other-key';render()}
 if(mode==='unmount')state.cleanup();
 if(mode==='paused'){state.pending.add('submission-files');render()}
 reject(Error('disk'));await new Promise(resolve=>setImmediate(resolve));assert.equal(state.messages.length,mode==='current'?1:0);count++;
}
for(const mode of ['hydrating','wrong-key','initial-load']){
 const {state,ctx,render,fire}=setup();if(mode==='hydrating')ctx.draftHydrating=true;if(mode==='wrong-key')ctx.hydratedDraftKeyRef.current='other-key';if(mode==='initial-load')ctx.skipNextDraftSaveRef.current=true;render();fire();assert.equal(state.saves.length,0);count++;
}
console.log('Draft delayed save passed: '+count+' cases; pending cleanup blocks stale timers before/after render, failure resumes retained selection, stale errors stay silent.');

{
 const start=source.lastIndexOf('  useEffect(()=>{',source.indexOf('    hydratedDraftKeyRef.current="";')),end=source.indexOf('  const draftSavePaused=',start);assert.ok(start>0&&end>start);const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const mode of ['missing','restored','failed','stale-restored','stale-failed']){
  const state={confirmed:true,files:['old'],messages:[]};let resolve,reject,cleanup;const ctx={draftKey:mode==='missing'?'':'new-key',setSubmissionConfirmed:v=>state.confirmed=v,hydratedDraftKeyRef:{current:'old-key'},draftHydratingRef:{current:false},skipNextDraftSaveRef:{current:false},setDraftHydrating:()=>{},getSubmittedDraftReceipt:()=>null,setDraftCleanup:()=>{},loadDraft:()=>new Promise((yes,no)=>{resolve=yes;reject=no;}),setFiles:v=>state.files=v,showSubmissionMessage:m=>state.messages.push(m),useEffect:fn=>{cleanup=fn();}};
  runInNewContext(code,ctx);assert.equal(state.confirmed,false);assert.deepEqual(state.files,['old']);
  if(mode==='missing'){assert.equal(ctx.draftHydratingRef.current,false);continue;}
  if(mode.startsWith('stale')){cleanup();state.confirmed=true;state.files=['current'];}
  if(mode.endsWith('failed'))reject(Error('synthetic read failure'));else resolve(['restored']);for(let i=0;i<8;i++)await Promise.resolve();
  if(mode.startsWith('stale')){assert.equal(state.confirmed,true);assert.deepEqual(state.files,['current']);assert.deepEqual(state.messages,[]);}else{assert.equal(state.confirmed,false);assert.equal(state.files.length,mode==='restored'?1:0);assert.equal(ctx.draftHydratingRef.current,false);}
 }
 console.log('Draft hydration confirmation: 5 missing/restored/failed/stale cases reset old confirmation and preserve new-context state.');
}

for(const mode of ['lost','other-key','auth-change','submitted','clearing','already-saved']){
 const h=setup();h.render();if(mode==='already-saved')h.fire();
 h.ctx.previewContextRef.current=mode==='other-key'?'new-key':'';h.ctx.draftKey='';h.ctx.hydratedDraftKeyRef.current='';
 if(mode==='auth-change')h.ctx.authLoadVersionRef.current++;if(mode==='submitted')h.ctx.getSubmittedDraftReceipt=()=>({durable:true});if(mode==='clearing')h.state.pending.add('submission-context');h.render();
 assert.equal(h.state.saves.length,mode==='lost'||mode==='already-saved'?1:0);if(mode==='lost'){assert.equal(h.state.saves[0].key,'owned-key');assert.deepEqual(h.state.saves[0].files,['old-file']);}h.fire();assert.equal(h.state.saves.length,mode==='lost'||mode==='already-saved'?1:0);
}
console.log('Draft target-loss flush: 6 conditions preserve pending selection under original key without cross-account, submitted, cleared or duplicate saves.');

for(const mode of ['current','other-key','auth-change']){
 const h=setup();let reject;h.ctx.saveDraft=()=>new Promise((_,no)=>{reject=no;});h.render();h.ctx.previewContextRef.current='';h.ctx.draftKey='';h.ctx.hydratedDraftKeyRef.current='';h.render();
 if(mode==='other-key')h.ctx.previewContextRef.current='other';if(mode==='auth-change')h.ctx.authLoadVersionRef.current++;reject(Error('synthetic disk failure'));for(let i=0;i<8;i++)await Promise.resolve();assert.equal(h.state.messages.length,mode==='current'?1:0);if(mode==='current')assert.match(h.state.messages[0],/画面を閉じず/);
}
console.log('Draft target-loss errors: current failure warns; changed target/account stays untouched.');
