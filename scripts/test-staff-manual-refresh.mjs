import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const app=readFileSync('apps/staff/src/App.tsx','utf8');
const from=app.indexOf('  async function refreshBusinessData('),to=app.indexOf('  async function refreshPushStatus(',from);
assert.ok(from>=0&&to>from);
function harness(options={}){
 const state={messages:[],calls:[],refreshing:false,status:'ready',source:'cached'};
 const scope={businessRefreshInFlightRef:{current:false},submissionEditPending:false,isPending:()=>false,businessDataStatus:'ready',firebaseConfigured:true,user:{uid:'user'},staffId:'staff',companyId:'company',lastBusinessDataRefreshAt:100000,BUSINESS_DATA_REFRESH_INTERVAL_MS:30000,authLoadVersionRef:{current:1},
 Date:{now:()=>100001},performance:{now:()=>100},openJobsStatus:'idle',refreshOpenJobs:()=>{throw Error('Unexpected open jobs call');},
 setMessage:value=>state.messages.push(value),setBusinessRefreshing:value=>state.refreshing=value,
 setBusinessDataStatus:value=>state.status=value,setBusinessDataSource:value=>state.source=value,setBusinessRefreshMs:()=>{},
 loadPrimaryBusinessData:async(...args)=>{state.calls.push(args);if(options.read)return options.read();return true;},...options.scope};
 runInNewContext(app.slice(from,to).replace('showFailure:boolean','showFailure'),scope);
 return {scope,state,refresh:scope.refreshBusinessData};
}
{
 const {refresh,state}=harness();await refresh(true);
 assert.deepEqual(state.calls[0],['staff','company','user',true]);
 assert.equal(state.source,'live');assert.match(state.messages[0],/シフトを更新/);
}
{
 const {refresh,state}=harness();await refresh(false);assert.equal(state.calls.length,0);
}
{
 let finish;const {refresh,state,scope}=harness({read:()=>new Promise(resolve=>finish=resolve)});
 const first=refresh(true);await refresh(true);await refresh(false);
 assert.equal(state.calls.length,1);assert.equal(state.refreshing,true);
 finish(true);await first;assert.equal(state.refreshing,false);assert.equal(scope.businessRefreshInFlightRef.current,false);
}
{
 const {refresh,state,scope}=harness({read:()=>{throw Error('offline');}});
 await refresh(true);assert.equal(state.status,'ready');assert.equal(state.source,'cached');
 assert.match(state.messages[0],/応募結果は未確認/);assert.equal(state.refreshing,false);
 assert.equal(scope.lastBusinessDataRefreshAt,0);await refresh(true);assert.equal(state.calls.length,2);
}
{
 let finish;const {refresh,state,scope}=harness({read:()=>new Promise(resolve=>finish=resolve)});
 const first=refresh(true);scope.authLoadVersionRef.current++;scope.businessRefreshInFlightRef.current=true;
 finish(true);await first;assert.equal(state.messages.length,0);assert.equal(state.source,'cached');
 assert.equal(scope.businessRefreshInFlightRef.current,true);
}
for(const overrides of [{submissionEditPending:true},{businessDataStatus:'loading'},{isPending:()=>true},{user:null}]){
 const {refresh,state}=harness({scope:overrides});await refresh(true);assert.equal(state.calls.length,0);
}
{
 const {refresh,state}=harness({scope:{firebaseConfigured:false}});await refresh(true);
 assert.equal(state.calls.length,0);assert.match(state.messages[0],/デモ/);
}
assert.match(app,/readJobs=serverOnly\?getDocsFromServer:getDocs/);
assert.match(app,/fetchMyJobs\(sid,cid,serverOnly\),fetchTasks\(\)/);
console.log('Manual refresh passed: server-only forwarding, auto throttle, duplicate suppression, failure/retry, stale auth, edit/loading/application/auth guards and demo.');
