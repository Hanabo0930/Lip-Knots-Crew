import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('apps/staff/src/App.tsx','utf8');
const start=source.indexOf('  async function apply(job:Job){');
const end=source.indexOf('  async function submitPreContact()',start);
assert.ok(start>=0&&end>start);
const handler=source.slice(start,end).replace('job:Job','job');
assert.match(source,/const authLoadVersion=\+\+authLoadVersionRef.current;\s*applicationAttemptsRef.current.clear\(\);/);
function harness({apiFailure=false,refreshFailure=false,staleAt='',demo=false,loseFirstResponse=false}={}){
 const state={messages:[],jobs:[{id:'one'},{id:'two'}],pending:'',expanded:'one',calls:0,refreshes:0,writes:0,requests:[],now:100000};
 const version={current:1};
 const attempts={current:new Map()};
 const completed=new Map();
 let sequence=0;
 const setMessage=value=>state.messages.push(value);
 const dependencies={
  authLoadVersionRef:version,applicationAttemptsRef:attempts,
  run:async(_key,action,options)=>{try{return await action();}catch(error){options.setMessage(error.message);throw error;}},
  setPendingApplicationJobId:value=>state.pending=value,
  firebaseConfigured:!demo,functions:{},
  httpsCallable:()=>async input=>{
   state.calls++;state.requests.push(input);
   if(staleAt==='api'){version.current++;attempts.current.clear();attempts.current.set(input.jobId,{requestId:'new-session',startedAt:state.now});}
   if(apiFailure)throw Error('API rejected');
   if(completed.has(input.requestId))return completed.get(input.requestId);
   const result={data:{ok:true,jobId:input.jobId}};
   completed.set(input.requestId,result);state.writes++;
   if(loseFirstResponse&&state.calls===1)throw Error('Response lost');
   return result;
  },
  setMessage,
  setOpenJobs:update=>state.jobs=update(state.jobs),
  setExpandedOpenJobId:value=>state.expanded=value,
  loadOpenJobs:async()=>{state.refreshes++;if(staleAt==='refresh')version.current++;if(refreshFailure)throw Error('Read failed');},
  crypto:{randomUUID:()=> 'synthetic-request-'+(++sequence)},
  Date:{now:()=>state.now}
 };
 const apply=Function(...Object.keys(dependencies),handler+';return apply;')(...Object.values(dependencies));
 return {state,apply,attempts,version};
}
{
 const {state,apply,attempts}=harness({refreshFailure:true});await apply({id:'one'});
 assert.equal(state.calls,1);assert.equal(state.refreshes,1);
 assert.deepEqual(state.jobs,[{id:'two'}]);assert.equal(state.pending,'');
 assert.match(state.messages.at(-1),/応募は確定しています/);
 assert.match(state.messages.at(-1),/もう一度試す/);assert.equal(attempts.current.size,0);
}
{
 const {state,apply}=harness();await apply({id:'one'});
 assert.equal(state.messages.at(-1),'応募が確定しました。');assert.equal(state.calls,1);
 assert.deepEqual(state.jobs,[{id:'two'}]);assert.equal(state.pending,'');
}
{
 const {state,apply}=harness({apiFailure:true});await apply({id:'one'});
 assert.equal(state.refreshes,0);assert.equal(state.jobs.length,2);
 assert.equal(state.messages.at(-1),'API rejected');assert.equal(state.pending,'');
}
{
 const {state,apply,attempts}=harness({staleAt:'api'});await apply({id:'one'});
 assert.equal(state.refreshes,0);assert.equal(state.jobs.length,2);assert.deepEqual(state.messages,[]);
 assert.equal(attempts.current.get('one').requestId,'new-session');
}
{
 const {state,apply}=harness({staleAt:'refresh',refreshFailure:true});await apply({id:'one'});
 assert.deepEqual(state.messages,['応募が確定しました。']);
}
{
 const {state,apply,attempts}=harness({demo:true});await apply({id:'one'});
 assert.equal(state.calls,0);assert.equal(state.refreshes,0);assert.deepEqual(state.jobs,[{id:'two'}]);
 assert.equal(attempts.current.size,0);
}
{
 const {state,apply,attempts}=harness({loseFirstResponse:true});
 await apply({id:'one'});assert.equal(state.writes,1);assert.equal(state.jobs.length,2);
 await apply({id:'one'});
 assert.equal(state.calls,2);assert.equal(state.writes,1);
 assert.equal(state.requests[0].requestId,state.requests[1].requestId);
 assert.equal(state.messages.at(-1),'応募が確定しました。');assert.equal(attempts.current.size,0);
}
{
 const {state,apply}=harness({apiFailure:true});
 await apply({id:'one'});await apply({id:'two'});await apply({id:'one'});
 assert.notEqual(state.requests[0].requestId,state.requests[1].requestId);
 assert.equal(state.requests[0].requestId,state.requests[2].requestId);
}
{
 const {state,apply,attempts,version}=harness({apiFailure:true});
 await apply({id:'one'});version.current++;attempts.current.clear();await apply({id:'one'});
 assert.notEqual(state.requests[0].requestId,state.requests[1].requestId);
}
for(const elapsed of [-1,23*60*60*1000-1,23*60*60*1000]){
 const {state,apply,attempts}=harness({apiFailure:true});
 await apply({id:'one'});const request=attempts.current.get('one').requestId;
 state.now+=elapsed;await apply({id:'one'});
 assert.equal(state.calls,elapsed>=0&&elapsed<23*60*60*1000?2:1);
 assert.equal(attempts.current.get('one').requestId,request);
 assert.equal(state.pending,'');
}
console.log('Application confirmation/retry: 12 scenarios passed; simulated lost response commits once, session isolation and retry time boundaries. No network or real writes.');
