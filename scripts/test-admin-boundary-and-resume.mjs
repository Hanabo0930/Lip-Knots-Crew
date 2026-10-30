import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(new URL('../package.json',import.meta.url));
const ts=require('typescript'),React=require('react');
const source=readFileSync(new URL('../apps/admin/src/App.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const compile=code=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}

// Execute the production boundary's state updates and inspect its real React elements.
// This verifies the key/branch contract, not a browser or full React mount.
const boundaryStart=source.indexOf('export default function App() {');
const boundaryEnd=source.indexOf('\nfunction AdminSession(',boundaryStart);
assert.ok(boundaryStart>=0&&boundaryEnd>boundaryStart);
const boundaryJs=compile(source.slice(boundaryStart,boundaryEnd).replace('export default function','function'));
const slots=[];let cursor=0,mounted=false,listener=null;
const auth={currentUser:null},SessionStub=()=>null;
const boundaryScope={React,auth,signOut:()=>{},AdminSession:SessionStub,
  useState:init=>{const i=cursor++;if(!slots[i])slots[i]={value:typeof init==='function'?init():init};return[slots[i].value,value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value;}];},
  useRef:value=>{const i=cursor++;if(!slots[i])slots[i]={value:{current:value}};return slots[i].value;},
  useEffect:fn=>{if(!mounted)fn();},
  onAuthStateChanged:(_auth,fn)=>{listener=fn;return()=>{};},
};
runInNewContext(boundaryJs,boundaryScope);
const renderBoundary=()=>{cursor=0;const tree=boundaryScope.App();mounted=true;return tree;};
assert.equal(renderBoundary().type,'main');
function emit(user){auth.currentUser=user;listener(user);return renderBoundary();}
const a={uid:'synthetic-a'},b={uid:'synthetic-b'};
const first=emit(a),same=emit(a),second=emit(b);
assert.equal(first.type,SessionStub);assert.equal(first.key,same.key);assert.notEqual(first.key,second.key,'UID changes replace the whole state owner');
first.props.onAuthorizationRejected();assert.equal(renderBoundary().type,SessionStub,'an old session cannot reject the new account');
second.props.onAuthorizationRejected();assert.equal(renderBoundary().type,'main','confirmed rejection removes all session-owned parent inputs');
emit(null);const back=emit(a);assert.equal(back.type,SessionStub);assert.notEqual(back.key,first.key,'a later sign-in cannot inherit old form state');

const operationsStart=source.indexOf('  useEffect(()=>{',source.indexOf('// 運用情報'));
const operationsEndMarker='  },[user,adminSessionReady,adminAuthorized,operationsRequested,operationsRetry]);';
const operationsEnd=source.indexOf(operationsEndMarker,operationsStart);
assert.ok(operationsStart>=0&&operationsEnd>operationsStart);
const operations=source.slice(operationsStart,operationsEnd+operationsEndMarker.length);
const operationsJs=compile(operations);
function operationsHarness(gate=null,gateName=null){
  const current={uid:'synthetic-admin'},state={calls:[],results:[],cleanup:null};
  const scope={operationsRequested:true,adminSessionReady:true,adminAuthorized:true,adminAuthorizationReadyRef:{current:true},firebaseConfigured:true,user:current,auth:{currentUser:current},functions:{},operationsRetry:0,operationsReadsRef:{current:{retry:0,completed:new Set(),failed:new Set()}},
    useEffect:fn=>{state.cleanup=fn();},setOperationsLoadState:value=>state.results.push(value),Promise};
  for(const m of operations.matchAll(/\b(load[A-Z][A-Za-z0-9_]*)\(/g))scope[m[1]]=async()=>{state.calls.push(m[1]);if(gate&&(!gateName||gateName===m[1]))await gate.promise;};
  return{state,scope,render(authorized=true,retry=scope.operationsRetry,ready=authorized){state.cleanup?.();scope.adminAuthorized=authorized;scope.adminAuthorizationReadyRef.current=ready;scope.operationsRetry=retry;runInNewContext(operationsJs,scope);}};
}
const completed=operationsHarness();completed.render();await flush();assert.equal(completed.state.calls.length,11);
completed.render(false);completed.render(true);await flush();assert.equal(completed.state.calls.length,11,'finished operations reads do not repeat on a token check');
completed.render(true,1);await flush();assert.equal(completed.state.calls.length,22,'explicit read retry remains available');
const held=deferred(),interrupted=operationsHarness(held);interrupted.render();await flush();interrupted.render(false);interrupted.render(true);held.resolve();await flush();
assert.equal(interrupted.state.calls.length,22,'unconfirmed reads are resumed');const count=interrupted.state.calls.length;interrupted.render(false);interrupted.render(true);await flush();assert.equal(interrupted.state.calls.length,count);
const one=deferred(),partial=operationsHarness(one,'loadMonthHistory');partial.render();await flush();partial.render(false);partial.render(true);one.resolve();await flush();assert.equal(partial.state.calls.length,12,'only the one unfinished read repeats');
assert.equal(partial.state.calls.filter(name=>name==='loadPilotReadiness').length,1);assert.equal(partial.state.calls.filter(name=>name==='loadMonthHistory').length,2);
const staleRender=operationsHarness();staleRender.render(true,0,false);await flush();assert.equal(staleRender.state.calls.length,0,'a synchronous token event overrides stale render authorization');staleRender.render(true);await flush();assert.equal(staleRender.state.calls.length,11);

const timelineStart=source.indexOf('  useEffect(() => {',source.indexOf('// 提出履歴'));
const timelineEndMarker='  }, [user, selectedAdminJobId, resubmitType]);';
const timelineEnd=source.indexOf(timelineEndMarker,timelineStart);
const resumeStart=source.indexOf('  useEffect(()=>{\n    if(!adminAuthorized||!adminAuthorizationReadyRef.current||!timelineReadDeferredRef.current',timelineEnd);
const resumeEndMarker='  },[adminAuthorized,user,selectedAdminJobId,resubmitType]);';
const resumeEnd=source.indexOf(resumeEndMarker,resumeStart);
assert.ok(timelineStart>=0&&timelineEnd>timelineStart&&resumeStart>timelineEnd&&resumeEnd>resumeStart);
const timelineJs=compile(source.slice(timelineStart,timelineEnd+timelineEndMarker.length)),resumeJs=compile(source.slice(resumeStart,resumeEnd+resumeEndMarker.length));
let timelineCalls=0;
const timelineScope={user:{uid:'synthetic-admin'},selectedAdminJobId:'synthetic-job-a',resubmitType:'report',firebaseConfigured:true,adminAuthorized:false,
  adminAuthorizationReadyRef:{current:false},timelineReadDeferredRef:{current:false},timelineVersionRef:{current:0},timelinePendingRef:{current:null},
  setSubmissionTimeline:()=>{},setSelectedSourceFile:()=>{},setTimelineStatus:()=>{},setTimelineBusy:()=>{},useEffect:fn=>fn(),loadSubmissionTimeline:async()=>{timelineCalls++;},Boolean};
timelineScope.auth={currentUser:timelineScope.user};
runInNewContext(timelineJs,timelineScope);runInNewContext(resumeJs,timelineScope);assert.equal(timelineCalls,0);
timelineScope.adminAuthorized=true;runInNewContext(resumeJs,timelineScope);assert.equal(timelineCalls,0);assert.equal(timelineScope.timelineReadDeferredRef.current,true,'a stale render cannot erase a deferred read while the synchronous token guard is blocked');
timelineScope.adminAuthorized=true;timelineScope.adminAuthorizationReadyRef.current=true;runInNewContext(resumeJs,timelineScope);assert.equal(timelineCalls,1,'the skipped timeline starts after verification');
timelineScope.adminAuthorized=false;runInNewContext(resumeJs,timelineScope);timelineScope.adminAuthorized=true;runInNewContext(resumeJs,timelineScope);assert.equal(timelineCalls,1,'a completed timeline is not restarted by an unrelated token check');
console.log(JSON.stringify({status:'PASS',cases:['owner-key-switch','stale-owner-rejection','confirmed-rejection-removes-session','later-sign-in-fresh-state','operations-completed-no-repeat','operations-interrupted-resume','operations-partial-resume-only','operations-stale-render-blocked','operations-explicit-retry','timeline-skipped-resume','timeline-stale-render-retained','timeline-completed-no-repeat'],fullReactMount:false,realNetworkCalls:0}));
