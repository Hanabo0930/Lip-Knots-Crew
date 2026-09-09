import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const dependency=createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json'));
const ts=dependency('typescript'), source=fs.readFileSync('apps/admin/src/App.tsx','utf8');
const start=source.indexOf('  async function loadExpenseReview('),end=source.indexOf('  async function openJobSheet(',start);
assert.ok(start>=0&&end>start);
const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const blank={transportation:'',purchase8:'',purchase10:'',netPrintCost:'',postageCost:''};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function setup(){
 const state={values:{...blank},note:'',status:'未読込',busy:false,ready:false,messages:[],calls:[],refreshes:0,confirmations:0};
 const user={uid:'synthetic-admin'};const ctx={Error,Symbol,blankExpense:blank,auth:{currentUser:user},adminSessionReady:true,firebaseConfigured:true,functions:{},jobs:[{id:'A',expenses:{transportation:1}},{id:'B',expenses:{transportation:2}}],expenseJobId:'A',expenseValues:{...blank},expenseNote:'',expenseVersionRef:{current:0},expenseReadyRef:{current:null},expenseLoadRef:{current:null},expenseWriteRef:{current:null},
 openWorkspace:()=>{},window:{confirm:()=>{state.confirmations++;return true;}},setExpenseJobId:v=>ctx.expenseJobId=v,setExpenseValues:v=>{state.values=v;ctx.expenseValues=v;},setExpenseNote:v=>{state.note=v;ctx.expenseNote=v;},setExpenseStatus:v=>state.status=v,setExpenseBusy:v=>state.busy=v,setExpenseReady:v=>state.ready=v,setMessage:v=>state.messages.push(v),
 httpsCallable:(_f,name)=>input=>{const gate=deferred();state.calls.push({name,input,gate});return gate.promise;},loadSheetIssues:async()=>{state.refreshes++;if(state.refreshFailure)throw Error('refresh offline');}};
 runInNewContext(code,ctx);const completeRead=(index,id,value)=>state.calls[index].gate.resolve({data:{job:{id},currentValues:{transportation:value}}});
 const ready=async()=>{const task=ctx.loadExpenseReview('A');completeRead(state.calls.length-1,'A',1);await task;};
 return{state,ctx,completeRead,ready};
}
const results=[];async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});}}
await test('latest load wins reverse responses',async()=>{const h=setup();const a=h.ctx.loadExpenseReview('A'),b=h.ctx.loadExpenseReview('B');h.completeRead(1,'B',2);await b;h.completeRead(0,'A',1);await a;assert.equal(h.state.values.transportation,'2');});
await test('failed switched load cannot save previous values',async()=>{const h=setup();await h.ready();const b=h.ctx.loadExpenseReview('B');h.state.calls[1].gate.reject(Error('offline'));await b;void h.ctx.saveExpenseDraft();assert.equal(h.state.calls.length,2);assert.equal(h.state.values.transportation,'');});
await test('unloaded form cannot save or confirm',async()=>{const h=setup();void h.ctx.saveExpenseDraft();void h.ctx.completeExpense();assert.equal(h.state.calls.length,0);assert.equal(h.state.confirmations,0);});
await test('load auth switch ignores response',async()=>{const h=setup();const task=h.ctx.loadExpenseReview('A');h.ctx.auth.currentUser={uid:'other'};h.completeRead(0,'A',1);await task;assert.equal(h.state.values.transportation,'');});
await test('mismatched response job rejected',async()=>{const h=setup();const task=h.ctx.loadExpenseReview('A');h.completeRead(0,'B',2);await task;void h.ctx.saveExpenseDraft();assert.equal(h.state.calls.length,1);});
for(const action of ['saveExpenseDraft','completeExpense']) {
 await test(action+' double click calls once',async()=>{const h=setup();await h.ready();const task=h.ctx[action]();void h.ctx[action]();assert.equal(h.state.calls.length,2);h.state.calls[1].gate.resolve({data:{}});await task;});
 await test(action+' auth changed before click refused',async()=>{const h=setup();await h.ready();h.ctx.auth.currentUser={uid:'other'};void h.ctx[action]();assert.equal(h.state.calls.length,1);});
 await test(action+' switched job ignores old success',async()=>{const h=setup();await h.ready();const task=h.ctx[action]();const b=h.ctx.loadExpenseReview('B');h.completeRead(2,'B',2);await b;const before=h.state.status;h.state.calls[1].gate.resolve({data:{}});await task;assert.equal(h.state.status,before);assert.equal(h.state.messages.length,0);});
 await test(action+' uncertain outcome requires reload',async()=>{const h=setup();await h.ready();const task=h.ctx[action]();h.state.calls[1].gate.reject(Error('offline'));await task;void h.ctx[action]();assert.equal(h.state.calls.length,2);assert.ok(h.state.messages.some(m=>/再読込/.test(m)));});
}
await test('accepted completion refresh failure remains accepted',async()=>{const h=setup();await h.ready();h.state.refreshFailure=true;const task=h.ctx.completeExpense();h.state.calls[1].gate.resolve({data:{}});await task;assert.equal(h.state.status,'書込待ち');assert.match(h.state.messages.at(-1),/受付済み/);});

await test('stale failed load cannot clear newer busy state',async()=>{const h=setup();const a=h.ctx.loadExpenseReview('A'),b=h.ctx.loadExpenseReview('B');h.state.calls[0].gate.reject(Error('old'));await a;assert.equal(h.state.busy,true);assert.equal(h.state.messages.length,0);h.completeRead(1,'B',2);await b;assert.equal(h.state.busy,false);});
await test('draft and completion cannot overlap',async()=>{const h=setup();await h.ready();const a=h.ctx.saveExpenseDraft();void h.ctx.completeExpense();assert.equal(h.state.calls.length,2);assert.equal(h.state.confirmations,0);h.state.calls[1].gate.resolve({data:{}});await a;});
await test('declined confirmation makes no request',async()=>{const h=setup();await h.ready();h.ctx.window.confirm=()=>false;await h.ctx.completeExpense();assert.equal(h.state.calls.length,1);});
await test('completion success requires reload before another submission',async()=>{const h=setup();await h.ready();const a=h.ctx.completeExpense();h.state.calls[1].gate.resolve({data:{}});await a;void h.ctx.completeExpense();assert.equal(h.state.calls.length,2);});
await test('load during write retains busy until both settle',async()=>{const h=setup();await h.ready();const a=h.ctx.saveExpenseDraft(),b=h.ctx.loadExpenseReview('B');h.completeRead(2,'B',2);await b;assert.equal(h.state.busy,true);h.state.calls[1].gate.resolve({data:{}});await a;assert.equal(h.state.busy,false);assert.equal(h.state.values.transportation,'2');});
await test('no authenticated session cannot load',async()=>{const h=setup();h.ctx.auth.currentUser=null;void h.ctx.loadExpenseReview('A');assert.equal(h.state.calls.length,0);});

for(const action of ['saveExpenseDraft','completeExpense'])await test(action+' sends displayed version and invalidates accepted version',async()=>{const h=setup();const read=h.ctx.loadExpenseReview('A');h.state.calls[0].gate.resolve({data:{job:{id:'A'},currentValues:{transportation:1},reviewVersion:'a'.repeat(64)}});await read;const write=h.ctx[action]();assert.equal(h.state.calls[1].input.expectedVersion,'a'.repeat(64));h.state.calls[1].gate.resolve({data:{}});await write;void h.ctx[action]();assert.equal(h.state.calls.length,2);assert.equal(h.state.ready,false);});
await test('legacy server read omits version in payload',async()=>{const h=setup();await h.ready();const task=h.ctx.saveExpenseDraft();assert.equal(Object.hasOwn(h.state.calls[1].input,'expectedVersion'),false);h.state.calls[1].gate.resolve({data:{}});await task;assert.equal(h.state.ready,true);});
await test('invalid server version cannot be downgraded to legacy',async()=>{const h=setup();const read=h.ctx.loadExpenseReview('A');h.state.calls[0].gate.resolve({data:{job:{id:'A'},reviewVersion:'invalid'}});await read;void h.ctx.saveExpenseDraft();assert.equal(h.state.calls.length,1);assert.equal(h.state.ready,false);});
console.log(JSON.stringify({cases:results.length,passed:results.every(r=>r.passed),results},null,2));if(results.some(r=>!r.passed))process.exitCode=1;
