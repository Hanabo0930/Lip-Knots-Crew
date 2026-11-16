import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const ts=createRequire(resolve(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json'))('typescript');
const code=ts.transpileModule(readFileSync('apps/staff/src/useShiftNotificationRoute.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function setup(){let slots=[],index=0,effects=[];const state={opened:[],calls:[],urls:[]},props={ready:true,scope:'company|staff',load:id=>new Promise((resolve,reject)=>state.calls.push({id,resolve,reject})),onOpen:job=>state.opened.push(job)};const react={useState:initial=>{const i=index++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],value=>slots[i]=typeof value==='function'?value(slots[i]):value];},useRef:initial=>{const i=index++;return slots[i]??(slots[i]={current:initial});},useEffect:(effect,deps)=>{const i=index++;if(!slots[i]||deps.some((v,n)=>v!==slots[i].deps[n])){slots[i]?.cleanup?.();slots[i]={deps};effects.push(()=>slots[i].cleanup=effect());}}};const window={location:{pathname:'/shifts/target/netprint',search:'',hash:''},history:{replaceState:(_,__,url)=>state.urls.push(url)}};const ctx={exports:{},require:()=>react,window};runInNewContext(code,ctx);return{state,props,parse:ctx.exports.shiftNotificationJobId,render(){index=0;effects=[];const result=ctx.exports.useShiftNotificationRoute(props);for(const effect of effects)effect();return result;}};}
const parser=setup().parse;for(const [path,id] of [['/shifts/one','one'],['/shifts/one/netprint','one'],['/shifts/one/precontact','one'],['/shifts/%E6%A1%88%E4%BB%B6','案件'],['/shifts/a%2Fb',null],['/shifts/%',null],['/shifts/..',null],['/admin/jobs/a',null],['//foreign/shifts/a',null],['/shifts/a/unknown',null]])assert.equal(parser(path),id);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
for(const mode of ['success','missing','failure','auth','cancel','not-ready','double']){const h=setup();if(mode==='not-ready')h.props.ready=false;let ui=h.render();if(mode==='not-ready'){assert.equal(h.state.calls.length,0);h.props.ready=true;ui=h.render();}await flush();assert.equal(h.state.calls.length,1);if(mode==='double')void ui.retry();assert.equal(h.state.calls.length,1);if(mode==='auth'){h.props.scope='other';h.props.ready=false;ui=h.render();}if(mode==='cancel')ui.cancel();if(mode==='failure')h.state.calls[0].reject(Error('offline'));else h.state.calls[0].resolve(mode==='missing'?null:{id:'target'});await flush();ui=h.render();if(['auth','cancel','missing','failure'].includes(mode))assert.equal(h.state.opened.length,0);else{assert.equal(h.state.opened[0].id,'target');assert.equal(h.state.urls[0],'/');}if(mode==='failure'||mode==='missing'){assert.equal(ui.status,mode==='failure'?'error':'unavailable');const retry=ui.retry();h.state.calls[1].resolve({id:'target'});await retry;assert.equal(h.state.opened.length,1);}}
console.log('Shift notification passed: 10 route cases, ready/success/missing/failure/retry/double/auth/cancel boundaries.');

{const h=setup();h.render();h.props.scope='new-owner';h.render();await flush();assert.equal(h.state.calls.length,1);h.state.calls[0].resolve({id:'target'});await flush();assert.equal(h.state.opened.length,1);}

{
 const h=setup();let fail=true;h.props.onOpen=job=>{if(fail)throw Error('cannot open view');h.state.opened.push(job);};h.render();await flush();h.state.calls[0].resolve({id:'target'});await flush();let ui=h.render();assert.equal(ui.status,'error');assert.equal(h.state.urls.length,0);assert.equal(h.state.opened.length,0);
 fail=false;const retry=ui.retry();h.state.calls[1].resolve({id:'target'});await retry;ui=h.render();assert.equal(h.state.opened.length,1);assert.deepEqual(h.state.urls,['/']);assert.equal(ui.status,'idle');
}
console.log('Shift notification opening failure: synchronous view failure preserves the route and retry action; successful retry consumes the route once.');

for(const mode of ['decline','reject','accept','consume-before-ready']){
 const h=setup();let finish,consume;h.props.onOpen=(job,done)=>{consume=done;return new Promise((resolve,reject)=>finish={resolve,reject});};h.render();await flush();h.state.calls[0].resolve({id:'target'});await flush();let ui=h.render();assert.equal(ui.status,'loading');assert.equal(h.state.urls.length,0);void ui.retry();assert.equal(h.state.calls.length,1);
 if(mode==='consume-before-ready'){consume();h.props.ready=false;h.render();finish.resolve(true);await flush();h.props.ready=true;ui=h.render();await flush();assert.equal(h.state.calls.length,1);assert.deepEqual(h.state.urls,['/']);continue;}
 if(mode==='reject')finish.reject(Error('open failed'));else finish.resolve(mode==='accept');await flush();ui=h.render();
 assert.equal(ui.status,mode==='decline'?'paused':mode==='reject'?'error':'idle');assert.equal(h.state.urls.length,mode==='accept'?1:0);
 if(mode!=='accept'){h.props.onOpen=()=>true;ui=h.render();const retry=ui.retry();h.state.calls[1].resolve({id:'target'});await retry;assert.deepEqual(h.state.urls,['/']);}
}
console.log('Notification async opening: decline/rejection retain route and retry; accepted transition consumes once before readiness changes, preventing auto-retry loops.');

{
 const h=setup();let consume,finish;h.props.onOpen=(_job,done)=>{consume=done;return new Promise(resolve=>finish=resolve);};h.render();await flush();h.state.calls[0].resolve({id:'target'});await flush();h.props.scope='new-owner';h.props.ready=false;h.render();consume();finish(true);await flush();assert.equal(h.state.urls.length,0);
}
console.log('Notification opening acceptance is scope-bound: a late callback cannot consume another owner route.');

{
 const parserContext={exports:{},require:()=>({})};
 runInNewContext(code,parserContext);
 const parse=parserContext.exports.submissionNotificationRoute;
 for(const [path,id,type] of [
  ['/submissions/one/report','one','report'],['/submissions/one/sales-floor/','one','sales_floor'],
  ['/submissions/%E6%A1%88%E4%BB%B6/report','案件','report'],
 ])assert.deepEqual({...parse(path)},{jobId:id,type});
 for(const path of [
  '/submissions/a/sales_floor','/submissions/a/report/extra','/submissions/a%2Fb/report','/submissions/%2e%2e/report',
  '/submissions/%/report','/submissions/a%5Cb/report','/submissions/a%00b/report','/shifts/one','//outside/submissions/a/report',
 ])assert.equal(parse(path),null);

 const app=readFileSync('apps/staff/src/App.tsx','utf8');
 const begin=app.indexOf('  const submissionNotification=useShiftNotificationRoute<');
 const end=app.indexOf('  const resubmissionNotification=',begin);
 assert.ok(begin>=0&&end>begin);
 const calls=[],actions=[];
 const guard={useShiftNotificationRoute:options=>{guard.options=options;},submissionNotificationRoute:parse,
   firebaseConfigured:true,user:{uid:'signed-in'},companyId:'company',staffId:'staff',sessionRevoked:false,
   businessDataStatus:'ready',draftHydrating:false,hydratedDraftKeyRef:{current:'draft'},draftKey:'draft',
   selectedAssignedJob:{id:'other'},submissionType:'report',requestId:'',submissionFilesRef:{current:[]},
   loadTaskJob:async id=>{calls.push(id);return guard.row;},
   startSubmission:async(...args)=>{actions.push(args);return false;}};
 runInNewContext(ts.transpileModule(app.slice(begin,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,guard);
 const {parse:match,load,onOpen,ready,scope}=guard.options;
 assert.equal(ready,true);
 assert.equal(scope,'signed-in|company|staff');
 assert.equal(match('/submissions/one/report'),'/submissions/one/report');
 assert.equal(match('/shifts/one'),null);
 assert.equal(await load('/submissions/one/fake'),null);
 assert.equal(calls.length,0);
 assert.equal(await load('/submissions/one/report'),null);
 guard.row={id:'one',submissionStatus:{}};const report=await load('/submissions/one/report');
 assert.equal(report.job,guard.row);assert.equal(report.type,'report');
 const photo=await load('/submissions/one/sales-floor');
 assert.equal(photo.type,'sales_floor');
 const consume=()=>assert.fail('A declined draft switch must keep the notification pending');
 const files=[{name:"unfinished-synthetic-report.pdf"}];
 guard.submissionFilesRef.current=files;
 assert.equal(await onOpen(photo,consume),false);
 assert.equal(guard.submissionFilesRef.current,files);
 assert.equal(actions.length,0);
 guard.submissionFilesRef.current=[];
 assert.equal(await onOpen(photo,consume),false);
 assert.deepEqual(actions,[['sales_floor',guard.row,'',consume]]);
 guard.row={id:'one',submissionStatus:{report:{completed:true}}};
 assert.equal(await load('/submissions/one/report'),null);
 for(const flag of ['completed','clientSubmitted','lipKnotsSubmitted']){
  guard.row={id:'one',submissionStatus:{salesFloor:{[flag]:true}}};
  assert.equal(await load('/submissions/one/sales-floor'),null);
 }
 assert.ok(calls.every(id=>id==='one'));
 console.log('Submission notification opens the verified job and exact type; unsupported routes, unavailable assignments and completed submissions are held, and other-job drafts hold the notification without invoking submission, and a declined context switch stays pending.');
}
