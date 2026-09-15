import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const ts=createRequire(resolve(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json'))('typescript');
const code=ts.transpileModule(readFileSync('apps/staff/src/useShiftNotificationRoute.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function setup(){let slots=[],index=0,effects=[];const state={opened:[],calls:[],urls:[]},props={ready:true,scope:'company|staff',load:id=>new Promise((resolve,reject)=>state.calls.push({id,resolve,reject})),onOpen:job=>state.opened.push(job)};const react={useState:initial=>{const i=index++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],value=>slots[i]=typeof value==='function'?value(slots[i]):value];},useRef:initial=>{const i=index++;return slots[i]??(slots[i]={current:initial});},useEffect:(effect,deps)=>{const i=index++;if(!slots[i]||deps.some((v,n)=>v!==slots[i].deps[n])){slots[i]?.cleanup?.();slots[i]={deps};effects.push(()=>slots[i].cleanup=effect());}}};const window={location:{pathname:'/shifts/target/netprint',search:'',hash:''},history:{replaceState:(_,__,url)=>state.urls.push(url)}};const ctx={exports:{},require:()=>react,window};runInNewContext(code,ctx);return{state,props,parse:ctx.exports.shiftNotificationJobId,render(){index=0;effects=[];const result=ctx.exports.useShiftNotificationRoute(props);for(const effect of effects)effect();return result;}};}
const parser=setup().parse;for(const [path,id] of [['/shifts/one','one'],['/shifts/one/netprint','one'],['/shifts/%E6%A1%88%E4%BB%B6','案件'],['/shifts/a%2Fb',null],['/shifts/%',null],['/shifts/..',null],['/admin/jobs/a',null],['//foreign/shifts/a',null],['/shifts/a/unknown',null]])assert.equal(parser(path),id);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
for(const mode of ['success','missing','failure','auth','cancel','not-ready','double']){const h=setup();if(mode==='not-ready')h.props.ready=false;let ui=h.render();if(mode==='not-ready'){assert.equal(h.state.calls.length,0);h.props.ready=true;ui=h.render();}await flush();assert.equal(h.state.calls.length,1);if(mode==='double')void ui.retry();assert.equal(h.state.calls.length,1);if(mode==='auth'){h.props.scope='other';h.props.ready=false;ui=h.render();}if(mode==='cancel')ui.cancel();if(mode==='failure')h.state.calls[0].reject(Error('offline'));else h.state.calls[0].resolve(mode==='missing'?null:{id:'target'});await flush();ui=h.render();if(['auth','cancel','missing','failure'].includes(mode))assert.equal(h.state.opened.length,0);else{assert.equal(h.state.opened[0].id,'target');assert.equal(h.state.urls[0],'/');}if(mode==='failure'||mode==='missing'){assert.equal(ui.status,mode==='failure'?'error':'unavailable');const retry=ui.retry();h.state.calls[1].resolve({id:'target'});await retry;assert.equal(h.state.opened.length,1);}}
console.log('Shift notification passed: 9 route cases, ready/success/missing/failure/retry/double/auth/cancel boundaries.');

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
