import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('apps/staff/src/App.tsx','utf8');
const start=source.indexOf('  async function apply(job:Job){');
const end=source.indexOf('  async function submitPreContact()',start);
assert.ok(start>=0&&end>start);
const handler=source.slice(start,end).replace('job:Job','job');
function harness({apiFailure=false,refreshFailure=false,staleAt='',demo=false}={}){
 const state={messages:[],jobs:[{id:'one'},{id:'two'}],pending:'',expanded:'one',calls:0,refreshes:0};
 const version={current:1};
 const setMessage=value=>state.messages.push(value);
 const dependencies={
  authLoadVersionRef:version,
  run:async(_key,action,options)=>{try{return await action();}catch(error){options.setMessage('操作に失敗しました');throw error;}},
  setPendingApplicationJobId:value=>state.pending=value,
  firebaseConfigured:!demo,functions:{},
  httpsCallable:()=>async()=>{state.calls++;if(staleAt==='api')version.current++;if(apiFailure)throw Error('API rejected');return {data:{ok:true}};},
  setMessage,
  setOpenJobs:update=>state.jobs=update(state.jobs),
  setExpandedOpenJobId:value=>state.expanded=value,
  loadOpenJobs:async()=>{state.refreshes++;if(staleAt==='refresh')version.current++;if(refreshFailure)throw Error('Read failed');},
  crypto:{randomUUID:()=> 'synthetic-request-id'}
 };
 const apply=Function(...Object.keys(dependencies),handler+';return apply;')(...Object.values(dependencies));
 return {state,apply};
}
{
 const {state,apply}=harness({refreshFailure:true});await apply({id:'one'});
 assert.equal(state.calls,1);assert.equal(state.refreshes,1);
 assert.deepEqual(state.jobs,[{id:'two'}]);assert.equal(state.pending,'');
 assert.match(state.messages.at(-1),/応募は確定しています/);
 assert.match(state.messages.at(-1),/もう一度試す/);
 assert.ok(!state.messages.some(x=>x==='操作に失敗しました'));
}
{
 const {state,apply}=harness();await apply({id:'one'});
 assert.equal(state.messages.at(-1),'応募が確定しました。');assert.equal(state.calls,1);
 assert.deepEqual(state.jobs,[{id:'two'}]);assert.equal(state.pending,'');
}
{
 const {state,apply}=harness({apiFailure:true});await apply({id:'one'});
 assert.equal(state.refreshes,0);assert.equal(state.jobs.length,2);
 assert.equal(state.messages.at(-1),'操作に失敗しました');assert.equal(state.pending,'');
}
{
 const {state,apply}=harness({staleAt:'api'});await apply({id:'one'});
 assert.equal(state.refreshes,0);assert.equal(state.jobs.length,2);assert.deepEqual(state.messages,[]);
}
{
 const {state,apply}=harness({staleAt:'refresh',refreshFailure:true});await apply({id:'one'});
 assert.deepEqual(state.messages,['応募が確定しました。']);
}
{
 const {state,apply}=harness({demo:true});await apply({id:'one'});
 assert.equal(state.calls,0);assert.equal(state.refreshes,0);assert.deepEqual(state.jobs,[{id:'two'}]);
}
console.log('Application confirmation: 6 handler scenarios passed (API success/failure, refresh failure, auth changes, demo). No network or real writes.');
