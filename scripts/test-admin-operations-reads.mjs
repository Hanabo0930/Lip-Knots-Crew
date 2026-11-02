import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../apps/admin/src/App.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const planStart=source.indexOf('function operationsReadIndexes('),planEnd=source.indexOf('\nfunction adminLoginErrorMessage(',planStart);
const effectStart=source.indexOf('  useEffect(()=>{',source.indexOf('// 運用情報'));
const effectEnd=source.indexOf('  // 提出履歴は案件・種類・認証ごとに応答を分離する。',effectStart);
assert.ok(planStart>=0&&planEnd>planStart&&effectStart>=0&&effectEnd>effectStart);
const planCode=source.slice(planStart,planEnd).replace('(view: string): number[]','(view)');
const effectCode=source.slice(effectStart,effectEnd);
const names=[...effectCode.matchAll(/\b(load\w+)\([^;\n]*isCurrentRun\)/g)].map(match=>match[1]);
assert.equal(names.length,11);assert.ok(names.includes('loadMonthHistory'),'the retained guarded reader is never requested by these views');
const panelLine=source.split('\n').find(line=>line.trim().startsWith('function operationsPanelReady('));assert.ok(panelLine);
const panelCode=panelLine.replace('(view:string)','(view)');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function harness(){
  const current={uid:'synthetic-admin'},state={calls:[],applied:[],states:[],cleanup:null,behaviors:new Map()};
  const scope={operationsRequested:true,adminSessionReady:true,adminAuthorized:true,adminAuthorizationReadyRef:{current:true},firebaseConfigured:true,user:current,auth:{currentUser:current},functions:{},operationsRetry:0,workspaceView:'notifications',operationsReadsRef:{current:{retry:0,completed:new Set(),failed:new Set()}},
    setOperationsLoadState:value=>state.states.push(value),useEffect:setup=>{state.cleanup=setup();}};
  for(const name of names)scope[name]=async(...args)=>{state.calls.push(name);await state.behaviors.get(name)?.();if(args.at(-1)())state.applied.push(name);};
  runInNewContext(planCode+'\n'+panelCode,scope);
  return{state,scope,render(view=scope.workspaceView){state.cleanup?.();scope.workspaceView=view;runInNewContext(effectCode,scope);},ready:view=>scope.operationsPanelReady(view)};
}
const expected={notifications:[],'staff-sync':[],readiness:['loadPilotReadiness'],invites:['loadPilotRolloutStatus','loadPilotExpansionReview','loadStagedRolloutStatus'],release:['loadProductionRehearsalStatus','loadProductionCutoverStatus','loadProductionSloDashboard','loadProductionTelemetryStatus','loadProductionDeploymentReadiness','loadProductionReleaseEvidenceStatus']};
const cases=[];
for(const [view,reads] of Object.entries(expected)){
  const h=harness();h.render(view);await flush();assert.deepEqual(h.state.calls,reads,view);assert.equal(h.state.states.at(-1),'ready');assert.equal(h.ready(view),true);
  h.render(view);await flush();assert.deepEqual(h.state.calls,reads,'finished view reads are reused');cases.push(view+'-only-required-reads');
}
for(const blocked of ['closed','session-pending','not-authorized','synchronous-token-rejection','missing-functions','wrong-current-user']){
  const h=harness();if(blocked==='closed')h.scope.operationsRequested=false;if(blocked==='session-pending')h.scope.adminSessionReady=false;if(blocked==='not-authorized')h.scope.adminAuthorized=false;if(blocked==='synchronous-token-rejection')h.scope.adminAuthorizationReadyRef.current=false;if(blocked==='missing-functions')h.scope.functions=null;if(blocked==='wrong-current-user')h.scope.auth.currentUser={uid:'other'};
  h.render('release');await flush();assert.deepEqual(h.state.calls,[]);assert.deepEqual(h.state.states,[]);cases.push(blocked+'-no-reads');
}
const retry=harness();let attempts=0;const retryGate=deferred();retry.state.behaviors.set('loadPilotExpansionReview',()=>{if(++attempts===1)throw new Error('synthetic unavailable');return retryGate.promise;});
retry.render('invites');await flush();assert.equal(retry.state.states.at(-1),'error');assert.deepEqual([...retry.scope.operationsReadsRef.current.failed],[2]);assert.equal(retry.ready('invites'),true,'the partial panel remains mounted');
retry.scope.operationsRetry++;retry.render('invites');assert.equal(retry.ready('invites'),true,'retry does not unmount existing inputs');assert.deepEqual(retry.state.calls,[...expected.invites,'loadPilotExpansionReview']);assert.equal(retry.state.states.at(-1),'loading');retryGate.resolve();await flush();assert.equal(retry.state.states.at(-1),'ready');assert.deepEqual([...retry.scope.operationsReadsRef.current.failed],[]);
retry.scope.operationsRetry++;retry.render('invites');await flush();assert.equal(retry.state.calls.length,4,'successful reads are not replayed');cases.push('only-failed-current-view-retried-and-cleared');
const unrelated=harness();unrelated.state.behaviors.set('loadProductionTelemetryStatus',()=>{throw new Error('synthetic telemetry unavailable');});unrelated.render('release');await flush();assert.equal(unrelated.state.states.at(-1),'error');unrelated.render('readiness');await flush();assert.equal(unrelated.state.states.at(-1),'ready');assert.equal(unrelated.ready('release'),true,'visiting another screen retains the earlier panel');assert.equal(unrelated.ready('readiness'),true);assert.deepEqual([...unrelated.scope.operationsReadsRef.current.failed],[7],'a different view does not hide the actual failed read');cases.push('failure-isolated-and-prior-panel-retained');
for(const change of ['navigate-away','change-account']){
  const h=harness(),gate=deferred();for(const name of expected.release)h.state.behaviors.set(name,()=>gate.promise);h.render('release');assert.equal(h.ready('release'),false);
  if(change==='navigate-away')h.render('notifications');else h.scope.auth.currentUser={uid:'other'};
  gate.reject(new Error('synthetic late failure'));await flush();assert.deepEqual([...h.scope.operationsReadsRef.current.completed],[]);assert.deepEqual([...h.scope.operationsReadsRef.current.failed],[]);assert.deepEqual(h.state.applied,[]);assert.equal(h.state.states.at(-1),change==='navigate-away'?'ready':'loading');cases.push(change+'-discards-old-results');
}
console.log(JSON.stringify({status:'PASS',suite:'Admin operations reads',cases,actualAppBodies:true,realNetworkCalls:0}));
