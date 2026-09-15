import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const dependency=createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json')),ts=dependency('typescript');
const source=fs.readFileSync('apps/staff/src/App.tsx','utf8').replace(/\r\n/g,'\n'),start=source.indexOf('  function resetPreContactInput('),end=source.indexOf('  async function openTask(',start);assert.ok(start>=0&&end>start);
const jobList={};runInNewContext(ts.transpileModule(fs.readFileSync('apps/staff/src/job-list.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:jobList});
function setup(){const original={id:'A',dateKey:'2099-09-20',netPrint:{items:[{id:'item',number:'12345678'}]},submissionStatus:{salesFloor:{clientSubmitted:false}}},state={selected:original,jobs:[original,{id:'B'}],calls:[],messages:[]};const ctx={hasValidDateKey:jobList.hasValidDateKey,setPreContactError:value=>state.fieldError=value,preContactTemperatureRef:{current:{focus:()=>state.focus="temperature"}},preContactArrivalRef:{current:{focus:()=>state.focus="arrival"}},confirm:()=>true,setTemperature:value=>state.temperature=value,setArrivalTime:value=>state.arrivalTime=value,preContactDraftKey:"draft-A",preContactDraftsRef:{current:new Map()},Error,selectedJob:original,temperature:"36.5",arrivalTime:"09:00",authLoadVersionRef:{current:1},tasksReadVersionRef:{current:0},pastShiftVersionRef:{current:0},firebaseConfigured:true,functions:{},isSubmissionActionPending:()=>false,setPendingShiftAction:v=>state.pending=v,setSelectedJob:v=>{state.selected=typeof v==='function'?v(state.selected):v;ctx.selectedJob=state.selected;},setMyJobs:f=>state.jobs=typeof f==='function'?f(state.jobs):f,setMessage:v=>state.messages.push(v),httpsCallable:()=>input=>new Promise((resolve,reject)=>state.calls.push({input,resolve,reject})),refreshSelectedJob:async()=>{if(state.jobRefreshFailure)throw Error('job refresh failed');},loadTasks:async()=>{if(state.taskRefreshFailure)throw Error('task refresh failed');}};
 const hook={exports:{},require:()=>({useCallback:f=>f,useRef:value=>({current:value}),useState:initial=>[initial(),()=>{}]})};runInNewContext(ts.transpileModule(fs.readFileSync('apps/staff/src/useAsyncAction.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,hook);Object.assign(ctx,hook.exports.useAsyncAction());runInNewContext(ts.transpileModule(source.slice(source.indexOf('function validNetPrintItem('),source.indexOf('function bootstrapRefreshToken('))+source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);return{state,ctx,original};}
const results=[];
for(const [flag,reason] of [['sourceMissing',/取込元/],['applicationUnconfirmed',/シフト表の担当確認/],['assignmentUnresolved',/担当者の照合/]])await test('precontact readiness preserves input and resumes after refreshed '+flag,async()=>{
 const h=setup();h.ctx.setSelectedJob({...h.original,[flag]:true});h.ctx.preContactDraftsRef.current.set('draft-A',{temperature:'36.5',arrivalTime:'09:00'});const before=JSON.stringify(h.state.jobs);
 const pending=h.ctx.submitPreContact();assert.equal(h.state.calls.length,0);await pending;
 assert.match(h.state.messages.at(-1),reason);assert.equal(h.ctx.preContactDraftsRef.current.has('draft-A'),true);assert.equal(h.ctx.temperature,'36.5');assert.equal(h.ctx.arrivalTime,'09:00');assert.equal(JSON.stringify(h.state.jobs),before);
 h.ctx.refreshSelectedJob=async()=>true;h.ctx.setSelectedJob({...h.state.selected,[flag]:false});const retry=h.ctx.submitPreContact();assert.equal(h.state.calls.length,1);h.state.calls[0].resolve({data:{ok:true}});await retry;
 assert.equal(h.state.messages.at(-1),'事前連絡を送信しました。');assert.equal(h.ctx.preContactDraftsRef.current.has('draft-A'),false);
});

for(const printed of ['false','true',1,{},null])await test('non-boolean printed flag '+JSON.stringify(printed),async()=>{const h=setup();h.ctx.setSelectedJob({...h.original,netPrint:{items:[{id:'item',number:'123',printed}]}});const pending=h.ctx.markPrinted({id:'item'});assert.equal(h.state.calls.length,1);h.state.calls[0].resolve({data:{ok:true}});await pending;assert.equal(h.state.messages.at(-1),'印刷済みにしました。');});

for(const other of [{id:'item',number:'999'},{id:'item',number:''}])await test('duplicate print identity '+JSON.stringify(other),async()=>{const h=setup();h.ctx.setSelectedJob({...h.original,netPrint:{items:[{id:'item',number:'123'},other]}});await h.ctx.markPrinted({id:'item'});assert.equal(h.state.calls.length,0);assert.match(h.state.messages.at(-1),/番号を確認できません/);});

for(const action of ['markPrinted','setClientSubmitted'])for(const reply of [null,{},[],{ok:false},{ok:'true'},{ok:1},'invalid'])await test(action+' malformed receipt '+JSON.stringify(reply),async()=>{
 const h=setup();let reads=0;h.ctx.refreshSelectedJob=async()=>{reads++;return true;};h.ctx.loadTasks=async()=>{reads++;};
 const pending=h.ctx[action](action==='markPrinted'?{id:'item'}:true);h.state.calls[0].resolve({data:reply});await pending;
 assert.equal(reads,0);assert.equal(h.state.pending,'');assert.equal(h.state.selected.submissionStatus.salesFloor.clientSubmitted,false);assert.equal(h.state.selected.netPrint.items[0].printed,undefined);assert.match(h.state.messages.at(-1),/受付結果を確認できません/);
 const retry=h.ctx[action](action==='markPrinted'?{id:'item'}:true);h.state.calls[1].resolve({data:{ok:true}});await retry;assert.equal(reads,2);assert.equal(h.state.messages.at(-1),action==='markPrinted'?'印刷済みにしました。':'クライアント提出済みにしました。');
});

for(const reply of [null,{},[],{ok:false},{ok:'true'},{ok:1},'invalid'])await test('precontact malformed receipt '+JSON.stringify(reply),async()=>{
 const h=setup();h.ctx.preContactDraftsRef.current.set('draft-A',{temperature:'36.5',arrivalTime:'09:00'});let reads=0;h.ctx.refreshSelectedJob=async()=>{reads++;return true;};
 const pending=h.ctx.submitPreContact();h.state.calls[0].resolve({data:reply});await pending;
 assert.equal(reads,0);assert.equal(h.ctx.pastShiftVersionRef.current,0);assert.equal(h.ctx.preContactDraftsRef.current.has('draft-A'),true);assert.equal(h.state.pending,'');assert.match(h.state.messages.at(-1),/受付結果を確認できません/);assert.equal(h.state.messages.some(v=>v==='事前連絡を送信しました。'),false);
 const retry=h.ctx.submitPreContact();h.state.calls[1].resolve({data:{ok:true}});await retry;assert.equal(reads,1);assert.equal(h.ctx.preContactDraftsRef.current.has('draft-A'),false);assert.equal(h.state.messages.at(-1),'事前連絡を送信しました。');
});

await test('demo valid print preserves malformed row as unfinished',async()=>{const h=setup();h.ctx.firebaseConfigured=false;h.ctx.setSelectedJob({...h.original,netPrint:{items:[null,{id:'item',number:'123'}]}});h.state.tasks=[{jobId:'A',kind:'netprint'}];h.ctx.setTasks=fn=>h.state.tasks=fn(h.state.tasks);await h.ctx.markPrinted({id:'item'});assert.equal(h.state.selected.netPrint.items[1].printed,true);assert.equal(h.state.tasks[0].body,'未印刷 1件');});

for(const item of [null,{id:'item'}, {id:'item',number:''},{id:'item',number:' '},{id:'item',number:123},{id:'',number:'123'}])await test('invalid print item '+JSON.stringify(item),async()=>{const h=setup();h.ctx.setSelectedJob({...h.original,netPrint:{items:[item]}});await h.ctx.markPrinted({id:'item'});assert.equal(h.state.calls.length,0);assert.match(h.state.messages.at(-1),/番号を確認できません/);});
await test('already printed target does not send another update',async()=>{const h=setup();h.ctx.setSelectedJob({...h.original,netPrint:{items:[{id:'item',number:'123',printed:true}]}});await h.ctx.markPrinted({id:'item'});assert.equal(h.state.calls.length,0);});

for(const action of ['markPrinted','setClientSubmitted'])for(const failed of ['job','tasks'])await test(action+' waits for both refreshes after '+failed+' failure',async()=>{
 const h=setup();let finishJob,finishTasks;
 h.ctx.refreshSelectedJob=()=>new Promise((resolve,reject)=>{finishJob={resolve,reject};});
 h.ctx.loadTasks=()=>new Promise((resolve,reject)=>{finishTasks={resolve,reject};});
 const pending=h.ctx[action](action==='markPrinted'?{id:'item'}:true);
 h.state.calls[0].resolve({data:{ok:true}});for(let tick=0;tick<20;tick++)await Promise.resolve();
 assert.ok(finishJob&&finishTasks);(failed==='job'?finishJob:finishTasks).reject(Error('read failed'));
 for(let tick=0;tick<20;tick++)await Promise.resolve();
 assert.equal(h.ctx.isPending('shift-action'),true,'Keep lock until the other refresh finishes');
 assert.notEqual(h.state.pending,'');
 await h.ctx.markPrinted({id:'other'});assert.equal(h.state.calls.length,1,'Do not submit another update during refresh');
 (failed==='job'?finishTasks:finishJob).resolve(true);await pending;
 assert.equal(h.ctx.isPending('shift-action'),false);assert.equal(h.state.pending,'');assert.match(h.state.messages.at(-1),/受付済み/);
});

for(const mode of ['cancel','saved','empty'])await test('reset only selected precontact '+mode,async()=>{const h=setup();h.ctx.confirm=()=>mode!=='cancel';if(mode==='saved')h.ctx.setSelectedJob({...h.original,preContact:{temperature:36.5,arrivalTime:'9:00'}});h.ctx.preContactDraftsRef.current.set('draft-A',{});h.ctx.preContactDraftsRef.current.set('draft-B',{});h.ctx.resetPreContactInput();assert.equal(h.ctx.preContactDraftsRef.current.has('draft-A'),mode==='cancel');assert.equal(h.ctx.preContactDraftsRef.current.has('draft-B'),true);if(mode!=='cancel'){assert.equal(h.state.temperature,mode==='saved'?'36.5':'');assert.equal(h.state.arrivalTime,mode==='saved'?'09:00':'');}assert.equal(h.state.calls.length,0);});

for(const mode of ['empty','reverted','current','other-job','other-account','missing-job'])await test('precontact exit '+mode,async()=>{
 const at=source.indexOf('    const preventPreContactExit='),a=source.lastIndexOf('  useEffect(()=>{',at),tail='  },[user?.uid,companyId,staffId,myJobs]);',b=source.indexOf(tail,at)+tail.length;assert.ok(a>=0&&b>a);
 let handler,cleanup;const drafts=new Map();if(mode!=='empty')drafts.set(mode==='other-account'?'other|c|s|A|':mode==='other-job'?'u|c|s|B|':mode==='missing-job'?'u|c|s|missing|':'u|c|s|A|',{temperature:mode==='reverted'?'36.5':'36.7',arrivalTime:'09:00'});
 const ctx={user:{uid:'u'},companyId:'c',staffId:'s',myJobs:[{id:'A',preContact:{temperature:36.5,arrivalTime:'9:00'}},{id:'B'}],preContactDraftsRef:{current:drafts},window:{addEventListener:(_name,fn)=>handler=fn,removeEventListener:(_name,fn)=>{assert.equal(fn,handler);handler=null;}},useEffect:fn=>cleanup=fn()};
 runInNewContext(ts.transpileModule(source.slice(a,b),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);let prevented=false;handler({preventDefault:()=>prevented=true});assert.equal(prevented,['current','other-job','missing-job'].includes(mode));cleanup();assert.equal(handler,null);
});

for(const mode of ['success','failure','unconfirmed'])await test('precontact draft cleanup '+mode,async()=>{const h=setup();h.ctx.preContactDraftsRef.current.set('draft-A',{temperature:'36.5',arrivalTime:'09:00'});h.ctx.refreshSelectedJob=async()=>{if(mode==='failure')throw Error('offline');return mode==='success';};const pending=h.ctx.submitPreContact();h.state.calls[0].resolve({data:{ok:true}});await pending;assert.equal(h.ctx.preContactDraftsRef.current.has('draft-A'),mode!=='success');});

await test('demo print retains pending tasks until all target items complete',async()=>{const h=setup();h.ctx.firebaseConfigured=false;const job={...h.original,netPrint:{items:[{id:'one',number:'111'},{id:'two',number:'222'}]}};h.ctx.setSelectedJob(job);h.state.jobs[0]=job;h.state.tasks=[{jobId:'A',kind:'netprint'},{jobId:'B',kind:'netprint'},{jobId:'A',kind:'precontact'}];h.ctx.setTasks=fn=>h.state.tasks=fn(h.state.tasks);await h.ctx.markPrinted({id:'one'});assert.equal(h.state.selected.netPrint.items[0].printed,true);assert.equal(h.state.selected.netPrint.items[1].printed,undefined);assert.equal(h.state.tasks[0].body,'未印刷 1件');await h.ctx.markPrinted({id:'two'});assert.equal(h.state.tasks.length,2);assert.equal(h.state.tasks.some(t=>t.jobId==='A'&&t.kind==='netprint'),false);assert.equal(h.state.jobs[0].netPrint.items.every(i=>i.printed),true);assert.equal(h.state.jobs[1].netPrint,undefined);assert.equal(h.state.calls.length,0);});

await test('demo precontact persists target and removes only its task',async()=>{const h=setup();h.ctx.firebaseConfigured=false;h.state.tasks=[{jobId:'A',kind:'precontact'},{jobId:'B',kind:'precontact'},{jobId:'A',kind:'netprint'}];h.ctx.setTasks=fn=>h.state.tasks=fn(h.state.tasks);await h.ctx.submitPreContact();assert.equal(h.state.calls.length,0);assert.equal(h.state.selected.preContact.temperature,36.5);assert.equal(h.state.selected.preContact.arrivalTime,'09:00');assert.equal(h.state.jobs[0].preContact.arrivalTime,'09:00');assert.equal(h.state.jobs[1].preContact,undefined);assert.equal(h.state.tasks.length,2);assert.equal(h.state.tasks.some(t=>t.jobId==='A'&&t.kind==='precontact'),false);});
async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});}}
for(const mode of ['job-refresh-failure','task-refresh-failure','different-job','newer-same-job','api-failure','auth','success','double','missing-functions','demo'])await test(mode,async()=>{
 const h=setup();if(mode==='missing-functions')h.ctx.functions=null;if(mode==='demo')h.ctx.firebaseConfigured=false;
 const p=h.ctx.setClientSubmitted(true);
 if(mode==='demo'||mode==='missing-functions'){await p;assert.equal(h.state.calls.length,0);assert.equal(h.state.selected.submissionStatus.salesFloor.clientSubmitted,mode==='demo');return;}
 if(mode==='double'){void h.ctx.setClientSubmitted(true);assert.equal(h.state.calls.length,1);}
 if(mode==='auth')h.ctx.authLoadVersionRef.current++;
 if(mode==='job-refresh-failure')h.state.jobRefreshFailure=true;
 if(mode==='task-refresh-failure')h.state.taskRefreshFailure=true;
 if(mode==='different-job')h.ctx.setSelectedJob({id:'B'});
 if(mode==='newer-same-job'){const fresh={id:'A',fresh:true};h.ctx.setSelectedJob(fresh);h.state.jobs=[fresh];}
 if(['api-failure','different-job','newer-same-job'].includes(mode))h.state.calls[0].reject(Error('offline'));else h.state.calls[0].resolve({data:{ok:true}});
 await p;
 if(mode==='different-job')assert.equal(h.state.selected.id,'B');
 else if(mode==='newer-same-job'){assert.equal(h.state.selected.fresh,true);assert.equal(h.state.jobs[0].fresh,true);}
 else if(mode==='api-failure'){assert.equal(h.state.selected,h.original);assert.match(h.state.messages.at(-1),/再読込/);}
 else {assert.equal(h.state.selected.submissionStatus.salesFloor.clientSubmitted,true);if(mode.endsWith('refresh-failure'))assert.match(h.state.messages.at(-1),/受付済み/);}
 if(mode==='auth')assert.equal(h.state.messages.length,0);
 assert.equal(h.ctx.isPending('shift-action'),false);
});

for(const action of ['submitPreContact','markPrinted'])for(const mode of ['job-refresh-failure','task-refresh-failure','api-failure','missing-functions'])await test(action+' '+mode,async()=>{const h=setup();if(mode==='job-refresh-failure')h.state.jobRefreshFailure=true;if(mode==='task-refresh-failure')h.state.taskRefreshFailure=true;if(mode==='missing-functions')h.ctx.functions=null;const p=h.ctx[action]({id:'item'});if(mode!=='missing-functions'){if(mode==='api-failure')h.state.calls[0].reject(Error('offline'));else h.state.calls[0].resolve({data:{ok:true}});}await p;assert.match(h.state.messages.at(-1),mode.endsWith('refresh-failure')?/受付済み/:/再読込/);assert.equal(h.ctx.isPending('shift-action'),false);});

for(const [temperature,arrivalTime] of [['','09:00'],[' ','09:00'],['abc','09:00'],['33.9','09:00'],['42.1','09:00'],['Infinity','09:00'],['36.5',''],['36.5','24:00'],['36.5','09:60']])await test('precontact invalid '+JSON.stringify([temperature,arrivalTime]),async()=>{const h=setup();Object.assign(h.ctx,{temperature,arrivalTime});await h.ctx.submitPreContact();assert.equal(h.state.calls.length,0);assert.match(h.state.messages.at(-1),/入力してください/);assert.equal(h.state.focus,temperature==='36.5'?'arrival':'temperature');assert.equal(h.state.fieldError,h.state.focus);assert.equal(h.ctx.isPending('shift-action'),false);});
for(const temperature of ['34','36.5','42'])await test('precontact valid '+temperature,async()=>{const h=setup();h.ctx.temperature=temperature;const p=h.ctx.submitPreContact();assert.equal(h.state.calls[0].input.temperature,Number(temperature));h.state.calls[0].resolve({data:{ok:true}});await p;assert.match(h.state.messages.at(-1),/送信しました/);});
await test('precontact fields isolate job and account but retain same-job edits',async()=>{
 const a=source.indexOf('  useEffect(()=>{\n    setPreContactError("");\n    const draft=preContactDraftsRef'),b=source.indexOf('  const [submissionType,',a);assert.ok(a>=0&&b>a);
 const code=ts.transpileModule(source.slice(a,b),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;let deps;
 const fields={};const ctx={hasValidDateKey:jobList.hasValidDateKey,setPreContactError:v=>fields.error=v,preContactDraftsRef:{current:new Map()},user:{uid:'u'},companyId:'c',staffId:'s',selectedJob:{id:'A',preContact:{temperature:36.7,arrivalTime:'9:30'}},setTemperature:v=>fields.temperature=v,setArrivalTime:v=>fields.arrivalTime=v,useEffect:(effect,next)=>{if(!deps||next.some((v,i)=>v!==deps[i]))effect();deps=next;}};
 const render=()=>{ctx.preContactDraftKey=[ctx.user?.uid??'demo',ctx.companyId,ctx.staffId,ctx.selectedJob?.id??'',ctx.selectedJob?.dateKey??''].join('|');runInNewContext(code,ctx);};render();assert.equal(fields.temperature,'36.7');assert.equal(fields.arrivalTime,'09:30');
 fields.temperature='37.1';ctx.preContactDraftsRef.current.set(ctx.preContactDraftKey,{temperature:'37.1',arrivalTime:'09:30'});ctx.selectedJob={...ctx.selectedJob,preContact:{temperature:36,arrivalTime:'10:00'}};render();assert.equal(fields.temperature,'37.1');assert.equal(fields.arrivalTime,'09:30');
 ctx.selectedJob={id:'B'};render();assert.equal(fields.temperature,'');assert.equal(fields.arrivalTime,'');
 ctx.selectedJob={id:'A',preContact:{temperature:35.9,arrivalTime:'08:15'}};render();assert.equal(fields.temperature,'37.1');
 fields.temperature='38';ctx.user={uid:'other'};render();assert.equal(fields.temperature,'35.9');
 ctx.selectedJob=null;render();assert.equal(fields.temperature,'');assert.equal(fields.arrivalTime,'');
});


await test('old primary read cannot revert pending client submission',async()=>{
 const h=setup();let finish;
 Object.assign(h.ctx,{staffId:'staff',companyId:'company',user:{uid:'u'},fetchMyJobs:()=>{h.ctx.pastShiftVersionRef.current++;return new Promise(resolve=>finish=resolve);},fetchTasks:async()=>[],setTasks:()=>{},saveBusinessSnapshot:()=>{},nextShiftJob:()=>h.original});
 const a=source.indexOf('  async function loadPrimaryBusinessData('),b=source.indexOf('  async function loadOpenJobs(',a);
 runInNewContext(ts.transpileModule(source.slice(a,b),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,h.ctx);
 const old=h.ctx.loadPrimaryBusinessData();const update=h.ctx.setClientSubmitted(true);
 finish([h.original]);const applied=await old;
 const checked=h.state.selected.submissionStatus.salesFloor.clientSubmitted;
 h.state.calls[0].resolve({data:{ok:true}});await update;
 assert.equal(applied,false);assert.equal(checked,true);
});

for(const action of ['submitPreContact','markPrinted','setClientSubmitted'])await test('accepted action invalidates pre-response reads '+action,async()=>{
 const h=setup();const pending=h.ctx[action](action==='markPrinted'?{id:'item'}:true);
 const version=h.ctx.pastShiftVersionRef.current;h.state.calls[0].resolve({data:{ok:true}});await pending;
 assert.equal(h.ctx.pastShiftVersionRef.current,version+1);
});
for(const items of [{},'invalid',42,true])await test('invalid print array '+JSON.stringify(items),async()=>{const h=setup();h.ctx.selectedJob.netPrint.items=items;await h.ctx.markPrinted({id:'item',number:'12345678'});assert.equal(h.state.calls.length,0);assert.match(h.state.messages.at(-1),/印刷対象の番号を確認できません/);});

for(const action of ['markPrinted','setClientSubmitted'])for(const stale of [false,true])await test(action+' accepted but unconfirmed refresh stale='+stale,async()=>{
 const h=setup();let finishTasks;h.ctx.refreshSelectedJob=async()=>false;h.ctx.loadTasks=()=>new Promise(resolve=>finishTasks=resolve);const pending=h.ctx[action](action==='markPrinted'?{id:'item'}:true);h.state.calls[0].resolve({data:{ok:true}});for(let i=0;i<12;i++)await Promise.resolve();assert.equal(h.ctx.isPending('shift-action'),true);const messages=h.state.messages.length;
 if(stale){h.ctx.authLoadVersionRef.current++;h.state.pending='new';}finishTasks();await pending;assert.equal(h.ctx.isPending('shift-action'),false);
 if(stale){assert.equal(h.state.messages.length,messages);assert.equal(h.state.pending,'new');}else{assert.match(h.state.messages.at(-1),/受付済み/);assert.match(h.state.messages.at(-1),/「シフトを更新」/);assert.equal(h.state.pending,'');if(action==='setClientSubmitted')assert.equal(h.state.selected.submissionStatus.salesFloor.clientSubmitted,true);}
});
for(const value of [true,false])for(const lip of [true,false,undefined,'true',1,{}])await test('client toggle completion value='+value+' lip='+JSON.stringify(lip),async()=>{
 const h=setup();const original={...h.original,submissionStatus:{salesFloor:{clientSubmitted:!value,completed:!value,lipKnotsSubmitted:lip}}};h.ctx.setSelectedJob(original);h.state.jobs=[original];const pending=h.ctx.setClientSubmitted(value);const expected=value||lip===true;assert.equal(h.state.selected.submissionStatus.salesFloor.completed,expected);assert.equal(h.state.jobs[0].submissionStatus.salesFloor.completed,expected);h.state.calls[0].reject(Error('synthetic rejection'));await pending;assert.equal(h.state.selected,original);assert.equal(h.state.jobs[0],original);
});
for(const target of ['job','tasks'])await test('precontact accepted but '+target+' refresh unconfirmed',async()=>{const h=setup();h.ctx.preContactDraftsRef.current.set('draft-A',{temperature:'36.5',arrivalTime:'09:00'});h.ctx.refreshSelectedJob=async()=>target!=='job';h.ctx.loadTasks=async()=>target!=='tasks';const pending=h.ctx.submitPreContact();h.state.calls[0].resolve({data:{ok:true}});await pending;assert.match(h.state.messages.at(-1),/受付済み/);assert.match(h.state.messages.at(-1),/「シフトを更新」/);assert.equal(h.ctx.preContactDraftsRef.current.has('draft-A'),target==='job');assert.equal(h.state.pending,'');});
for(const temperature of ['0x24','0b100100','0o44','3.6e1','+36','36,5'])await test('precontact rejects non-decimal temperature '+temperature,async()=>{const h=setup();h.ctx.temperature=temperature;const draft={temperature,arrivalTime:'09:00'};h.ctx.preContactDraftsRef.current.set('draft-A',draft);await h.ctx.submitPreContact();assert.equal(h.state.calls.length,0);assert.equal(h.state.fieldError,'temperature');assert.equal(h.state.focus,'temperature');assert.equal(h.ctx.preContactDraftsRef.current.get('draft-A'),draft);});
for(const temperature of ['34','42','36.5',' 36.5 ','36.'])await test('precontact accepts decimal temperature '+temperature,async()=>{const h=setup();h.ctx.temperature=temperature;const pending=h.ctx.submitPreContact();assert.equal(h.state.calls.length,1);h.state.calls[0].resolve({data:{ok:true}});await pending;assert.equal(h.ctx.isPending('shift-action'),false);});
await test('precontact sends the work date shown in the form',async()=>{
 const h=setup();h.ctx.selectedJob={...h.ctx.selectedJob,dateKey:'2099-09-20'};const pending=h.ctx.submitPreContact();
 assert.equal(h.state.calls[0].input.dateKey,'2099-09-20');h.state.calls[0].resolve({data:{ok:true}});await pending;
});
for(const dateKey of ['',undefined,'2099-02-30','yesterday'])await test('print refuses missing or invalid day '+String(dateKey),async()=>{const h=setup();h.ctx.selectedJob={...h.original,dateKey};await h.ctx.markPrinted({id:'item'});assert.equal(h.state.calls.length,0);assert.match(h.state.messages.at(-1),/勤務日を確認できません/);});
await test('print sends the work date shown in the form',async()=>{const h=setup();h.ctx.selectedJob={...h.original,dateKey:'2099-09-21'};const pending=h.ctx.markPrinted({id:'item'});assert.equal(h.state.calls[0].input.dateKey,'2099-09-21');h.state.calls[0].resolve({data:{ok:true}});await pending;});
console.log(JSON.stringify({cases:results.length,passed:results.every(r=>r.passed),results},null,2));if(results.some(r=>!r.passed))process.exitCode=1;
