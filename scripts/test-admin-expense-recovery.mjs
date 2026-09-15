import {dashboardModule} from './admin-dashboard-test-module.mjs';
import { setup as notificationSetup } from './notification-test-harness.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const dependency=createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json'));
const ts=dependency('typescript'), source=fs.readFileSync('apps/admin/src/App.tsx','utf8');
const start=source.indexOf('  async function retrySheetIssue('),end=source.indexOf('  async function openJobSheet(',start);
assert.ok(start>=0&&end>start);
const code=ts.transpileModule(source.slice(source.indexOf("  async function openComparison("),source.indexOf("  async function loadSheetIssues("))+source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const blank={transportation:'',purchase8:'',purchase10:'',netPrintCost:'',postageCost:''};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function setup(realIssueLoader=false){
 const state={values:{...blank},note:'',status:'未読込',busy:false,ready:false,messages:[],calls:[],refreshes:0,confirmations:0};
 const user={uid:'synthetic-admin'};const ctx={Error,Symbol,Map,comparisonVersionRef:{current:0},comparisonRequestRef:{current:null},resubmissionListVersionRef:{current:0},setResubmissions:v=>state.resubmissions=v,setComparison:v=>state.comparison=typeof v==='function'?v(state.comparison):v,issuesVersionRef:{current:0},operationEpochRef:{current:0},operationLocksRef:{current:new Map()},setOperationKeys:v=>state.operationKeys=v,loadJobs:async()=>{state.refreshes++;if(state.refreshFailure)throw Error("refresh offline");},blankExpense:blank,auth:{currentUser:user},adminSessionReady:true,firebaseConfigured:true,functions:{},jobs:[{id:'A',expenses:{transportation:1}},{id:'B',expenses:{transportation:2}}],expenseJobId:'A',expenseValues:{...blank},expenseNote:'',expenseVersionRef:{current:0},expenseReadyRef:{current:null},expenseLoadRef:{current:null},expenseWriteRef:{current:null},
 openWorkspace:()=>{},window:{confirm:()=>{state.confirmations++;return true;}},setExpenseJobId:v=>ctx.expenseJobId=v,setExpenseValues:v=>{state.values=v;ctx.expenseValues=v;},setExpenseNote:v=>{state.note=v;ctx.expenseNote=v;},setExpenseStatus:v=>state.status=v,setExpenseBusy:v=>state.busy=v,setExpenseReady:v=>state.ready=v,setMessage:v=>state.messages.push(v),
 httpsCallable:(_f,name)=>input=>{const gate=deferred();state.calls.push({name,input,gate});return gate.promise;},loadSheetIssues:async()=>{state.refreshes++;if(state.refreshFailure)throw Error('refresh offline');}};
 if(realIssueLoader){ctx.canApplyAuthResult=guard=>!guard||guard();ctx.setIssuesBusy=v=>state.issuesBusy=v;ctx.setSheetIssues=v=>state.issues=v;const issueStart=source.indexOf('  async function loadSheetIssues('),issueEnd=source.indexOf('  async function retrySheetIssue(',issueStart);assert.ok(issueStart>=0&&issueEnd>issueStart);runInNewContext(ts.transpileModule(source.slice(issueStart,issueEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);}
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

await test('real issue loader preserves accepted completion on refresh failure',async()=>{const h=setup(true);await h.ready();const task=h.ctx.completeExpense();h.state.calls[1].gate.resolve({data:{}});for(let tick=0;tick<6;tick++)await Promise.resolve();assert.equal(h.state.calls[2].name,'getSheetWriteIssues');h.state.calls[2].gate.reject(Error('refresh offline'));await task;assert.equal(h.state.status,'書込待ち');assert.match(h.state.messages.at(-1),/受付済み/);assert.equal(h.state.ready,false);});
await test('standalone issue reload reports failure and clears busy',async()=>{const h=setup(true);const task=h.ctx.loadSheetIssues();h.state.calls[0].gate.reject(Error('refresh offline'));await task;assert.equal(h.state.issuesBusy,false);assert.match(h.state.messages.at(-1),/refresh offline/);});
await test('real issue loader ignores stale completion refresh failure',async()=>{const h=setup(true);await h.ready();const task=h.ctx.completeExpense();h.state.calls[1].gate.resolve({data:{}});for(let tick=0;tick<6;tick++)await Promise.resolve();h.ctx.auth.currentUser={uid:'other'};const count=h.state.messages.length;h.state.calls[2].gate.reject(Error('old refresh'));await task;assert.equal(h.state.messages.length,count);});
for(const action of ['retrySheetIssue','acknowledgeSheetIssue']){
 await test(action+' handles rejected callable',async()=>{const h=setup();h.ctx.window.prompt=()=> 'synthetic';const task=h.ctx[action]({id:'queue',canRetry:true});h.state.calls[0].gate.reject(Error('offline'));await task;assert.match(h.state.messages.at(-1),/offline|失敗|再読込/);});
 await test(action+' ignores success after auth switch',async()=>{const h=setup();h.ctx.window.prompt=()=> 'synthetic';const task=h.ctx[action]({id:'queue',canRetry:true});h.ctx.auth.currentUser={uid:'other'};h.state.calls[0].gate.resolve({data:{}});await task;assert.equal(h.state.messages.length,0);assert.equal(h.state.refreshes,0);});
}

for(const action of ['retrySheetIssue','acknowledgeSheetIssue']){
 await test(action+' accepted action survives refresh failure',async()=>{const h=setup(true);h.ctx.window.prompt=()=> 'synthetic';const task=h.ctx[action]({id:'queue',canRetry:true});h.state.calls[0].gate.resolve({data:{}});for(let tick=0;tick<6;tick++)await Promise.resolve();h.state.calls[1].gate.reject(Error('refresh offline'));await task;assert.match(h.state.messages.at(-1),/受付済み/);});
 await test(action+' requires authenticated session',async()=>{const h=setup();h.ctx.window.prompt=()=> 'synthetic';h.ctx.auth.currentUser=null;await h.ctx[action]({id:'queue',canRetry:true});assert.equal(h.state.calls.length,0);});
}
await test('cancel acknowledgement sends nothing',async()=>{const h=setup();h.ctx.window.prompt=()=>null;await h.ctx.acknowledgeSheetIssue({id:'queue'});assert.equal(h.state.calls.length,0);});
await test('verification flag independently prevents a manual retry',async()=>{const h=setup();await h.ctx.retrySheetIssue({id:'queue',canRetry:true,writeVerificationRequired:true});assert.equal(h.state.calls.length,0);});
await test('conflict cannot be retried',async()=>{const h=setup();await h.ctx.retrySheetIssue({id:'queue',canRetry:false});assert.equal(h.state.calls.length,0);});

await test('issue reload latest response wins',async()=>{const h=setup(true);const a=h.ctx.loadSheetIssues(),b=h.ctx.loadSheetIssues();h.state.calls[1].gate.resolve({data:{issues:[{id:'new'}]}});await b;h.state.calls[0].gate.resolve({data:{issues:[{id:'old'}]}});await a;assert.equal(h.state.issues[0].id,'new');});
await test('old issue failure cannot clear newer busy',async()=>{const h=setup(true);const a=h.ctx.loadSheetIssues(),b=h.ctx.loadSheetIssues();h.state.calls[0].gate.reject(Error('old'));await a;assert.equal(h.state.issuesBusy,true);assert.equal(h.state.messages.length,0);h.state.calls[1].gate.resolve({data:{issues:[]}});await b;assert.equal(h.state.issuesBusy,false);});
await test('unguarded issue reload ignores auth switch',async()=>{const h=setup(true);const a=h.ctx.loadSheetIssues();h.ctx.auth.currentUser={uid:'other'};h.state.calls[0].gate.resolve({data:{issues:[{id:'old'}]}});await a;assert.equal(h.state.issues,undefined);});
for(const action of ['retrySheetIssue','acknowledgeSheetIssue','confirmJobApplication']){
 const value={id:'queue',canRetry:true,status:'assigned'};
 await test(action+' prevents overlapping requests',async()=>{const h=setup();h.ctx.window.prompt=()=> 'synthetic';const a=h.ctx[action](value),b=h.ctx[action](value);const count=h.state.calls.length;for(const c of h.state.calls)c.gate.resolve({data:{}});await Promise.all([a,b]);assert.equal(count,1);});
}
await test('application failure is handled',async()=>{const h=setup();const a=h.ctx.confirmJobApplication({id:'job',status:'assigned'});h.state.calls[0].gate.reject(Error('offline'));await a;assert.match(h.state.messages.at(-1),/再読込/);});
await test('application response ignores auth change',async()=>{const h=setup();const a=h.ctx.confirmJobApplication({id:'job',status:'assigned'});h.ctx.auth.currentUser={uid:'other'};h.state.calls[0].gate.resolve({data:{}});await a;assert.equal(h.state.messages.length,0);assert.equal(h.state.refreshes,0);});
await test('accepted application survives reload failure',async()=>{const h=setup();h.state.refreshFailure=true;const a=h.ctx.confirmJobApplication({id:'job',status:'assigned'});h.state.calls[0].gate.resolve({data:{}});await a;assert.match(h.state.messages.at(-1),/受付済み/);});

await test('retry and acknowledgement share a queue lock',async()=>{const h=setup();h.ctx.window.prompt=()=> 'synthetic';const a=h.ctx.retrySheetIssue({id:'queue',canRetry:true}),b=h.ctx.acknowledgeSheetIssue({id:'queue'});assert.equal(h.state.calls.length,1);h.state.calls[0].gate.resolve({data:{}});await Promise.all([a,b]);assert.equal(h.state.operationKeys.length,0);});
await test('separate queues can operate independently',async()=>{const h=setup();const a=h.ctx.retrySheetIssue({id:'A',canRetry:true}),b=h.ctx.retrySheetIssue({id:'B',canRetry:true});assert.equal(h.state.calls.length,2);for(const c of h.state.calls)c.gate.resolve({data:{}});await Promise.all([a,b]);assert.equal(h.state.operationKeys.length,0);});
await test('failed operation releases its lock',async()=>{const h=setup();const a=h.ctx.confirmJobApplication({id:'job',status:'assigned'});h.state.calls[0].gate.reject(Error('offline'));await a;assert.equal(h.state.operationKeys.length,0);});
await test('operation epoch change rejects same-user old response',async()=>{const h=setup();const a=h.ctx.confirmJobApplication({id:'job',status:'assigned'});h.ctx.operationEpochRef.current++;h.state.calls[0].gate.resolve({data:{}});await a;assert.equal(h.state.messages.length,0);});
await test('unassigned application cannot be confirmed',async()=>{const h=setup();await h.ctx.confirmJobApplication({id:'job',status:'cancelled'});assert.equal(h.state.calls.length,0);});

await test('resubmission list latest response wins',async()=>{const h=setup(true);const a=h.ctx.loadResubmissions(),b=h.ctx.loadResubmissions();h.state.calls[1].gate.resolve({data:{requests:[{id:'new'}]}});await b;h.state.calls[0].gate.resolve({data:{requests:[{id:'old'}]}});await a;assert.equal(h.state.resubmissions[0].id,'new');});
await test('resubmission list ignores auth switch',async()=>{const h=setup(true);const a=h.ctx.loadResubmissions();h.ctx.auth.currentUser={uid:'other'};h.state.calls[0].gate.resolve({data:{requests:[{id:'old'}]}});await a;assert.equal(h.state.resubmissions,undefined);});
await test('resubmission completion error handled',async()=>{const h=setup(true);const a=h.ctx.completeResubmission('r');h.state.calls[0].gate.reject(Error('offline'));await a;assert.match(h.state.messages.at(-1),/再読込/);});
await test('resubmission completion ignores switched user',async()=>{const h=setup(true);const a=h.ctx.completeResubmission('r');h.ctx.auth.currentUser={uid:'other'};h.state.calls[0].gate.resolve({data:{}});for(let n=0;n<8;n++)await Promise.resolve();for(const c of h.state.calls.slice(1))c.gate.resolve({data:{requests:[]}});await a;assert.equal(h.state.messages.length,0);assert.equal(h.state.comparison,undefined);});
await test('resubmission completion double click sends once',async()=>{const h=setup(true);const a=h.ctx.completeResubmission('r'),b=h.ctx.completeResubmission('r');const count=h.state.calls.length;for(const c of h.state.calls)c.gate.resolve({data:{}});for(let n=0;n<8;n++)await Promise.resolve();for(const c of h.state.calls.slice(count))c.gate.resolve({data:{requests:[]}});await Promise.all([a,b]);assert.equal(count,1);});
await test('accepted resubmission completion retains success on refresh failure',async()=>{const h=setup(true);const a=h.ctx.completeResubmission('r');h.state.calls[0].gate.resolve({data:{}});for(let n=0;n<8;n++)await Promise.resolve();h.state.calls[1].gate.reject(Error('refresh'));await a;assert.match(h.state.messages.at(-1),/受付済み/);});

for(const id of ['r','other'])await test('resubmission completion preserves unrelated comparison '+id,async()=>{const h=setup(true);h.state.comparison={request:{id}};const a=h.ctx.completeResubmission('r');h.state.calls[0].gate.resolve({data:{}});for(let n=0;n<8;n++)await Promise.resolve();h.state.calls[1].gate.resolve({data:{requests:[]}});await a;if(id==='r')assert.equal(h.state.comparison,null);else assert.equal(h.state.comparison.request.id,'other');});
await test('old resubmission list failure is ignored',async()=>{const h=setup(true);const a=h.ctx.loadResubmissions(),b=h.ctx.loadResubmissions();h.state.calls[0].gate.reject(Error('old'));await a;h.state.calls[1].gate.resolve({data:{requests:[]}});await b;});
await test('invalidated resubmission guard issues no request',async()=>{const h=setup(true);await h.ctx.loadResubmissions(()=>false);assert.equal(h.state.calls.length,0);});

await test('authenticated bootstrap loads issues before session ready flag',async()=>{const h=setup(true);h.ctx.adminSessionReady=false;const a=h.ctx.loadSheetIssues(()=>true);assert.equal(h.state.calls.length,1);h.state.calls[0].gate.resolve({data:{issues:[]}});await a;});

const comparisonData=id=>({data:{request:{id,reasons:[]},source:null,replacements:[]}});
await test('comparison newest request wins',async()=>{const h=setup();const a=h.ctx.openComparison('a'),b=h.ctx.openComparison('b');h.state.calls[1].gate.resolve(comparisonData('b'));await b;h.state.calls[0].gate.resolve(comparisonData('a'));await a;assert.equal(h.state.comparison.request.id,'b');});
await test('comparison ignores auth switch',async()=>{const h=setup();const a=h.ctx.openComparison('a');h.ctx.auth.currentUser={uid:'other'};h.state.calls[0].gate.resolve(comparisonData('a'));await a;assert.ok(!h.state.comparison);});
await test('comparison failure clears old image and is handled',async()=>{const h=setup();h.state.comparison={request:{id:'old'}};const a=h.ctx.openComparison('a');h.state.calls[0].gate.reject(Error('offline'));await a;assert.equal(h.state.comparison,null);assert.match(h.state.messages.at(-1),/再読込|比較/);});
await test('comparison wrong request rejected',async()=>{const h=setup();const a=h.ctx.openComparison('a');h.state.calls[0].gate.resolve(comparisonData('other'));await a;assert.ok(!h.state.comparison);});
await test('comparison malformed result rejected',async()=>{const h=setup();const a=h.ctx.openComparison('a');h.state.calls[0].gate.resolve({data:{request:{id:'a'},replacements:null}});await a;assert.ok(!h.state.comparison);});

await test('closed comparison cannot reopen from late response',async()=>{const h=setup();const a=h.ctx.openComparison('a');h.ctx.closeComparison();h.state.calls[0].gate.resolve(comparisonData('a'));await a;assert.equal(h.state.comparison,null);});
await test('same-user epoch change invalidates comparison',async()=>{const h=setup();const a=h.ctx.openComparison('a');h.ctx.operationEpochRef.current++;h.state.calls[0].gate.resolve(comparisonData('a'));await a;assert.equal(h.state.comparison,null);});
await test('accepted completion invalidates pending comparison for same request',async()=>{const h=setup(true);const compare=h.ctx.openComparison('a'),complete=h.ctx.completeResubmission('a');h.state.calls[1].gate.resolve({data:{}});for(let n=0;n<8;n++)await Promise.resolve();h.state.calls[2].gate.resolve({data:{requests:[]}});await complete;h.state.calls[0].gate.resolve(comparisonData('a'));await compare;assert.equal(h.state.comparison,null);});

function prepareRequest(){const h=setup(true);Object.assign(h.ctx,{resubmissionPendingRef:{current:false},resubmissionNeedsReviewRef:{current:false},setResubmissionNeedsReview:v=>h.state.needsReview=v,setResubmissionBusy:v=>h.state.resubmissionBusy=v,timelineReady:true,timelinePendingRef:{current:null},selectedAdminJobId:'A',resubmitReasons:['その他'],resubmitNote:'synthetic',selectedSourceFile:null,submissionTimeline:[],resubmitType:'report',timelineKey:'A:report',timelineKeyRef:{current:'A:report'}});return h;}
await test('uncertain create cannot immediately resend',async()=>{const h=prepareRequest();const a=h.ctx.createResubmission();h.state.calls[0].gate.reject(Error('offline'));await a;const b=h.ctx.createResubmission();const count=h.state.calls.length;for(const c of h.state.calls.slice(1))c.gate.reject(Error('offline'));await b;assert.equal(count,1);});
await test('accepted create with failed list cannot resend',async()=>{const h=prepareRequest();const a=h.ctx.createResubmission();h.state.calls[0].gate.resolve({data:{}});for(let n=0;n<8;n++)await Promise.resolve();h.state.calls[1].gate.reject(Error('list offline'));await a;const b=h.ctx.createResubmission();const count=h.state.calls.length;for(const c of h.state.calls.slice(2))c.gate.reject(Error('offline'));await b;assert.equal(count,2);});

for(const mode of ['success','failure','malformed','auth-change'])await test('create recovery reload '+mode,async()=>{const h=prepareRequest();h.ctx.resubmissionNeedsReviewRef.current=true;h.state.needsReview=true;const a=h.ctx.refreshResubmissionList();if(mode==='auth-change')h.ctx.auth.currentUser={uid:'other'};if(mode==='failure')h.state.calls[0].gate.reject(Error('offline'));else h.state.calls[0].gate.resolve({data:mode==='malformed'?{}:{requests:[]}});await a;assert.equal(h.ctx.resubmissionNeedsReviewRef.current,mode!=='success');assert.equal(h.state.needsReview,mode!=='success');});

function netPrintSetup(){const h=setup();Object.assign(h.ctx,{selectedAdminJobId:'A',netPrintNumbers:['12345678','','']});const from=source.indexOf('  async function saveNetPrint('),to=source.indexOf('  async function loadSubmissionTimeline(',from);runInNewContext(ts.transpileModule(source.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,h.ctx);return h;}
await test('netprint double click sends once',async()=>{const h=netPrintSetup();const first=h.ctx.saveNetPrint(),second=h.ctx.saveNetPrint();const count=h.state.calls.length;for(const call of h.state.calls)call.gate.resolve({data:{changedCount:1}});await Promise.all([first,second]);assert.equal(count,1);assert.equal(h.state.refreshes,1);});
for(const mode of ['failure','auth','refresh-failure'])await test('netprint '+mode,async()=>{const h=netPrintSetup();const pending=h.ctx.saveNetPrint();if(mode==='auth')h.ctx.auth.currentUser={uid:'other'};if(mode==='refresh-failure')h.state.refreshFailure=true;if(mode==='failure')h.state.calls[0].gate.reject(Error('offline'));else h.state.calls[0].gate.resolve({data:{changedCount:1}});await pending;assert.equal(h.ctx.operationLocksRef.current.size,0);if(mode==='auth'){assert.equal(h.state.messages.length,0);assert.equal(h.state.refreshes,0);}else assert.match(h.state.messages.at(-1),mode==='refresh-failure'?/受付済み/:/再読込/);});

function cancellationSetup(){const h=setup();Object.assign(h.ctx,{cancellationJobId:'A',cancellationReasonCategory:'other',cancellationTreatment:'neither',cancellationNote:'synthetic',setCancellationBusy:()=>{},loadDashboard:async()=>{h.state.dashboardReads=(h.state.dashboardReads??0)+1;if(h.state.dashboardFailure)throw Error('dashboard offline');}});h.ctx.window.prompt=()=>'';const from=source.indexOf('  function cancellationLocked('),to=source.indexOf('  async function loadStaffPerformance(',from);runInNewContext(ts.transpileModule(source.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,h.ctx);return h;}
for(const action of ['cancel','restore']){
 const run=h=>action==='cancel'?h.ctx.submitCancellation():h.ctx.restoreCancellation(h.ctx.jobs[0]);
 await test(action+' synchronous double click',async()=>{const h=cancellationSetup();const a=run(h),b=run(h);const count=h.state.calls.length;for(const call of h.state.calls)call.gate.resolve({data:{}});await Promise.all([a,b]);assert.equal(count,1);});
 await test(action+' obsolete auth response',async()=>{const h=cancellationSetup();const a=run(h);h.ctx.auth.currentUser={uid:'other'};h.state.calls[0].gate.resolve({data:{}});await a;assert.equal(h.state.messages.length,0);assert.equal(h.state.refreshes,0);});
 await test(action+' accepted refresh failure',async()=>{const h=cancellationSetup();h.state.refreshFailure=true;const a=run(h);h.state.calls[0].gate.resolve({data:{}});await a;assert.match(h.state.messages.at(-1),/受付済み/);});
}
await test('restore memo cancellation sends nothing',async()=>{const h=cancellationSetup();h.ctx.window.prompt=()=>null;const a=h.ctx.restoreCancellation(h.ctx.jobs[0]);for(const call of h.state.calls)call.gate.resolve({data:{}});await a;assert.equal(h.state.calls.length,0);});

await test('accepted cancellation real dashboard failure keeps receipt',async()=>{const h=cancellationSetup();Object.assign(h.ctx,{dashboardMonth:'2026-09',dashboardMonthRef:{current:'2026-09'},dashboardVersionRef:{current:0},require:name=>{assert.equal(name,'./dashboard-data');return dashboardModule;},setDashboard:()=>{},setDashboardBusy:()=>{},setDashboardError:()=>{},canApplyAuthResult:guard=>!guard||guard()});const from=source.indexOf('  async function loadDashboard('),to=source.indexOf('  function prepareCancellation(',from);runInNewContext(ts.transpileModule(source.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,h.ctx);const a=h.ctx.submitCancellation();h.state.calls[0].gate.resolve({data:{}});for(let i=0;i<40&&h.state.calls.length<2;i++)await Promise.resolve();h.state.calls[1].gate.reject(Error('dashboard offline'));await a;assert.match(h.state.messages.at(-1),/受付済み/);});
await test('demo repeated cancellation does not inflate recomputed counts',async()=>{const h=cancellationSetup();h.ctx.firebaseConfigured=false;h.ctx.jobs=[{id:'A',workDate:'2026-07-01',assignedStaffId:'staff',status:'assigned',financials:{clientChargeTotal:1000,staffPaymentTotal:500}}];h.ctx.setJobs=update=>h.ctx.jobs=update(h.ctx.jobs);await h.ctx.submitCancellation();const first=await dashboardModule.readDashboard('2026-07',()=>assert.fail('Demo must not use API'),h.ctx.jobs);await h.ctx.submitCancellation();const second=await dashboardModule.readDashboard('2026-07',()=>assert.fail('Demo must not use API'),h.ctx.jobs);assert.equal(first.counts.cancelled,1);assert.equal(second.counts.cancelled,1);assert.equal(second.finance.bookedInvoice,0);assert.equal(second.finance.bookedPayment,0);});

function deviceSetup(){const h=setup();Object.assign(h.ctx,{staffDeviceVersionRef:{current:0},staffDeviceProfileRef:{current:null},setDeviceStaffName:v=>h.state.deviceName=v,setStaffDevices:v=>h.state.devices=typeof v==='function'?v(h.state.devices):v,setStaffDeviceStatus:v=>h.state.deviceStatus=v});const from=source.indexOf('  async function openStaffDevices('),to=source.indexOf('  async function previewStaffSync(',from);runInNewContext(ts.transpileModule(source.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,h.ctx);return h;}
for(const mode of ['old-success','old-failure','auth','malformed','failure'])await test('staff devices isolation '+mode,async()=>{const h=deviceSetup();h.state.devices=[{id:'old'}];const a=h.ctx.openStaffDevices({id:'A',displayName:'A'});if(mode.startsWith('old')){const b=h.ctx.openStaffDevices({id:'B',displayName:'B'});h.state.calls[1].gate.resolve({data:{devices:[{id:'B-device'}]}});await b;}if(mode==='auth')h.ctx.auth.currentUser={uid:'other'};if(mode.includes('failure'))h.state.calls[0].gate.reject(Error('offline'));else h.state.calls[0].gate.resolve({data:mode==='malformed'?{}:{devices:[{id:'A-device'}]}});await a;if(mode.startsWith('old')){assert.equal(h.state.devices[0].id,'B-device');assert.equal(h.state.deviceName,'B');}else{assert.equal(h.state.devices.length,0);if(mode!=='auth')assert.equal(h.state.deviceStatus,'error');}});

await test('closing devices invalidates pending load',async()=>{const h=deviceSetup();const pending=h.ctx.openStaffDevices({id:'A',displayName:'A'});h.ctx.closeStaffDevices();h.state.calls[0].gate.resolve({data:{devices:[{id:'obsolete'}]}});await pending;assert.equal(h.state.devices.length,0);assert.equal(h.state.deviceName,'');assert.equal(h.state.deviceStatus,'idle');});
await test('empty device result is ready and can reload',async()=>{const h=deviceSetup();const pending=h.ctx.openStaffDevices({id:'A',displayName:'A'});h.state.calls[0].gate.resolve({data:{devices:[]}});await pending;assert.equal(h.state.deviceStatus,'ready');h.ctx.reloadStaffDevices();assert.equal(h.state.calls.length,2);h.state.calls[1].gate.resolve({data:{devices:[]}});for(let i=0;i<8;i++)await Promise.resolve();assert.equal(h.state.deviceStatus,'ready');});

for(const mode of ['double','auth','failure','same-name','closed','refresh-failure','decline','signed-out','demo'])await test('staff revoke '+mode,async()=>{
 const h=deviceSetup(),profile={id:'A',displayName:'same'};h.ctx.deviceStaffName='same';
 h.ctx.staffDeviceProfileRef.current=mode==='same-name'?{id:'B',displayName:'same'}:profile;
 h.state.devices=[{id:'device',active:true}];
 if(mode==='decline')h.ctx.window.confirm=()=>false;
 if(mode==='signed-out')h.ctx.auth.currentUser=null;
 if(mode==='demo')h.ctx.firebaseConfigured=false;
 const pending=h.ctx.revokeStaffDevices(profile);const caught=pending.catch(e=>e);
 if(mode==='double'){void h.ctx.revokeStaffDevices(profile);assert.equal(h.state.calls.length,1);assert.equal(h.state.confirmations,1);}
 if(['decline','signed-out','demo'].includes(mode)){assert.equal(h.state.calls.length,0);await pending;if(mode==='demo')assert.equal(h.state.devices[0].active,false);return;}
 if(mode==='auth')h.ctx.auth.currentUser={uid:'other'};
 if(mode==='closed')h.ctx.closeStaffDevices();
 if(mode==='failure')h.state.calls[0].gate.reject(Error('offline'));else h.state.calls[0].gate.resolve({data:{}});
 for(let i=0;i<10;i++)await Promise.resolve();
 if(['auth','same-name','closed'].includes(mode))assert.equal(h.state.calls.length,1);
 if(h.state.calls[1]){if(mode==='refresh-failure')h.state.calls[1].gate.reject(Error('refresh offline'));else h.state.calls[1].gate.resolve({data:{devices:[]}});}
 assert.equal(await caught,undefined);
 if(mode==='auth')assert.equal(h.state.messages.length,0);
 if(mode==='failure')assert.match(h.state.messages.at(-1),/再読込/);
 if(mode==='refresh-failure'){assert.match(h.state.messages.at(-1),/受付済み/);assert.equal(h.state.deviceStatus,'error');}
 assert.equal(h.ctx.operationLocksRef.current.size,0);
});

await test('staff revoke real Auth partial failure displays retry and never success', async () => {
 const h=deviceSetup(),server=notificationSetup(),devices=server.load('./devices');
 const profile={id:'staff-a',displayName:'合成スタッフ'};
 server.state.records.set('staffProfiles/staff-a',{companyId:'company-a',authUids:['uid-a'],active:true});
 server.state.records.set('deviceSessions/synthetic-device',{companyId:'company-a',staffId:'staff-a',uid:'uid-a',active:true});
 server.state.records.set('authIdentities/uid-a',{companyId:'company-a',staffId:'staff-a',active:true});
 server.state.onRevoke=()=>{throw Error('Synthetic Auth failure');};
 h.ctx.httpsCallable=(_functions,name)=>async data=>{
  assert.equal(name,'adminRevokeStaffDevices');
  return {data:await devices[name]({auth:{uid:'admin-a',token:{companyId:'company-a',role:'admin'}},data})};
 };
 await h.ctx.revokeStaffDevices(profile);
 assert.match(h.state.messages.at(-1),/一部完了していません.*再実行/);
 assert.equal(h.state.messages.some(message=>message.includes('全端末をログアウトしました')),false);
 assert.equal(h.ctx.operationLocksRef.current.size,0);
 delete server.state.onRevoke;
 await h.ctx.revokeStaffDevices(profile);
 assert.match(h.state.messages.at(-1),/全端末をログアウトしました/);
 assert.equal(server.state.records.get('authIdentities/uid-a').active,false);
 assert.equal(h.ctx.operationLocksRef.current.size,0);
});
function performanceSetup(){const h=setup();Object.assign(h.ctx,{performanceVersionRef:{current:0},setPerformance:v=>h.state.performance=v,setPerformanceBusy:v=>h.state.performanceBusy=v,document:{getElementById:()=>null},setTimeout:fn=>h.state.scroll=fn});h.ctx.require=name=>{assert.equal(name,'../../../functions/src/analytics-core');const core={exports:{}};runInNewContext(ts.transpileModule(fs.readFileSync('functions/src/analytics-core.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,core);return core.exports;};const from=source.indexOf('  async function loadStaffPerformance('),to=source.indexOf('function updateJobForm',from);runInNewContext(ts.transpileModule(source.slice(from,to),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,h.ctx);return h;}
const performanceData=(id,range={from:'2025-10-01',through:'2099-12-31'})=>({profile:{id,displayName:id,areaLabels:[]},performance:{...range,totals:{},clients:[],makers:[],stores:[],recentJobs:[]}});
for(const mode of ['older-success','older-failure','auth','closed','failure','mismatch','malformed','not-ready','success'])await test('staff performance '+mode,async()=>{
 const h=performanceSetup();h.state.performance=performanceData('old');if(mode==='not-ready')h.ctx.adminSessionReady=false;
 const a=h.ctx.loadStaffPerformance({id:'A'});
 if(mode==='not-ready'){assert.equal(h.state.calls.length,0);await a;return;}
 if(mode==='closed')h.ctx.closeStaffPerformance();
 if(mode==='auth')h.ctx.auth.currentUser={uid:'other'};
 if(mode.startsWith('older')){const b=h.ctx.loadStaffPerformance({id:'B'});h.state.calls[1].gate.resolve({data:performanceData('B')});await b;}
 if(mode.endsWith('failure'))h.state.calls[0].gate.reject(Error('offline'));else h.state.calls[0].gate.resolve({data:mode==='malformed'?{}:performanceData(mode==='mismatch'?'B':'A')});
 await a;
 if(mode.startsWith('older')){assert.equal(h.state.performance.profile.id,'B');assert.equal(h.state.messages.length,0);}
 else if(mode==='success')assert.equal(h.state.performance.profile.id,'A');
 else assert.equal(h.state.performance,null);
 if(['mismatch','malformed','failure'].includes(mode))assert.ok(h.state.messages.length);
 if(mode==='auth')assert.equal(h.state.messages.length,0);
});

await test('staff performance older finally preserves pending busy',async()=>{const h=performanceSetup();const a=h.ctx.loadStaffPerformance({id:'A'}),b=h.ctx.loadStaffPerformance({id:'B'});h.state.calls[0].gate.reject(Error('old'));await a;assert.equal(h.state.performanceBusy,true);h.state.calls[1].gate.resolve({data:performanceData('B')});await b;assert.equal(h.state.performanceBusy,false);});
await test('staff performance read does not schedule scroll after close',async()=>{const h=performanceSetup();let scrolled=0;h.ctx.document.getElementById=()=>({scrollIntoView:()=>scrolled++});const a=h.ctx.loadStaffPerformance({id:'A'});h.state.calls[0].gate.resolve({data:performanceData('A')});await a;h.ctx.closeStaffPerformance();assert.equal(h.state.scroll,undefined);assert.equal(scrolled,0);});
await test('staff performance forwards requested period',async()=>{const h=performanceSetup(),range={from:'2026-07-01',through:'2026-07-31'};const pending=h.ctx.loadStaffPerformance({id:'A'},range);assert.equal(h.state.calls[0].input.from,range.from);assert.equal(h.state.calls[0].input.through,range.through);h.state.calls[0].gate.resolve({data:performanceData('A',range)});await pending;});
for(const returned of [{from:'2026-06-01',through:'2026-07-31'},{from:'2026-07-01',through:'2026-08-31'},{},{from:42,through:'2026-07-31'},{from:'2026-07-01'}])await test('staff performance rejects wrong period '+JSON.stringify(returned),async()=>{const h=performanceSetup(),range={from:'2026-07-01',through:'2026-07-31'};let pending=h.ctx.loadStaffPerformance({id:'A'},range);h.state.calls[0].gate.resolve({data:performanceData('A',returned)});await pending;assert.equal(h.state.performance,null);assert.equal(h.state.performanceBusy,false);assert.match(h.state.messages.at(-1),/集計期間を確認できません/);pending=h.ctx.loadStaffPerformance({id:'A'},range);h.state.calls[1].gate.resolve({data:performanceData('A',range)});await pending;assert.equal(h.state.performance.performance.from,range.from);assert.equal(h.state.performance.performance.through,range.through);});
await test('demo performance excludes dates outside requested period',async()=>{const h=performanceSetup();h.ctx.firebaseConfigured=false;h.ctx.demoJobs=[{id:'in',assignedStaffId:'A',workDate:'2026-07-01',status:'assigned'},{id:'out',assignedStaffId:'A',workDate:'2026-08-01',status:'assigned'}];await h.ctx.loadStaffPerformance({id:'A',displayName:'A'},{from:'2026-07-01',through:'2026-07-31'});assert.equal(h.state.performance.performance.totals.assignedJobs,1);assert.equal(h.state.performance.performance.recentJobs[0].id,'in');});
for(const mode of ['open','draft','missing','cancelled-flag'])await test('demo performance job state '+mode,async()=>{const h=performanceSetup();h.ctx.firebaseConfigured=false;h.ctx.demoJobs=[{id:'job',assignedStaffId:'A',workDate:'2026-07-01',status:mode==='missing'?undefined:mode==='cancelled-flag'?'assigned':mode,cancelled:mode==='cancelled-flag'}];await h.ctx.loadStaffPerformance({id:'A',displayName:'A'});assert.equal(h.state.performance.performance.totals.assignedJobs,0);assert.equal(h.state.performance.performance.totals.cancelledJobs,mode==='cancelled-flag'?1:0);});
for(const [treatment,invoice,payment] of [['invoice_and_pay',100,40],['invoice_only',100,0],['pay_only',0,40],['neither',0,0]])await test('demo performance cancellation finance '+treatment,async()=>{const h=performanceSetup();h.ctx.firebaseConfigured=false;h.ctx.demoJobs=[{id:'job',assignedStaffId:'A',workDate:'2026-07-01',status:'cancelled',cancellationFinancialTreatment:treatment,clientName:'Client',makerName:'Maker',storeName:'Store',financials:{clientChargeTotal:100,staffPaymentTotal:40}}];await h.ctx.loadStaffPerformance({id:'A',displayName:'A'});const result=h.state.performance.performance;assert.equal(result.totals.invoice,invoice);assert.equal(result.totals.payment,payment);assert.equal(result.clients.length,0);});
for(const mode of ['closed','auth'])await test('demo performance lazy load ignores stale context '+mode,async()=>{const h=performanceSetup();h.ctx.firebaseConfigured=false;h.ctx.demoJobs=[];const pending=h.ctx.loadStaffPerformance({id:'A',displayName:'A'});if(mode==='closed')h.ctx.closeStaffPerformance();else h.ctx.auth.currentUser={uid:'other'};await pending;assert.equal(h.state.performance,null);});
for(const target of ['A','B'])for(const field of ['amount','note'])await test('expense dirty reload cancelled '+target+' '+field,async()=>{const h=setup();await h.ready();if(field==='amount')h.ctx.setExpenseValues({...h.state.values,transportation:'99'});else h.ctx.setExpenseNote('unsaved');h.ctx.window.confirm=()=>{h.state.confirmations++;return false;};const before=JSON.stringify(h.state.values);const next=h.ctx.loadExpenseReview(target);if(h.state.calls[1])h.completeRead(1,target,2);await next;assert.equal(h.state.calls.length,1);assert.equal(h.ctx.expenseJobId,'A');assert.equal(JSON.stringify(h.state.values),before);assert.equal(h.state.confirmations,1);});
await test('expense successful draft no discard prompt',async()=>{const h=setup();await h.ready();h.ctx.setExpenseNote('saved');const save=h.ctx.saveExpenseDraft();h.state.calls[1].gate.resolve({data:{}});await save;const next=h.ctx.loadExpenseReview('B');h.completeRead(2,'B',2);await next;assert.equal(h.state.confirmations,0);});
for(const action of ['saveExpenseDraft','completeExpense'])for(const target of ['A','B'])await test(action+' uncertain dirty reload cancelled '+target,async()=>{
 const h=setup();await h.ready();h.ctx.setExpenseValues({...h.state.values,transportation:'99'});h.ctx.setExpenseNote('unconfirmed');
 const save=h.ctx[action]();h.state.calls[1].gate.reject(Error('offline'));await save;
 assert.equal(h.state.ready,false);await h.ctx.saveExpenseDraft();await h.ctx.completeExpense();assert.equal(h.state.calls.length,2);
 h.ctx.window.confirm=()=>false;const reload=h.ctx.loadExpenseReview(target);if(h.state.calls[2])h.completeRead(2,target,2);await reload;
 assert.equal(h.state.calls.length,2);assert.equal(h.ctx.expenseJobId,'A');assert.equal(h.state.values.transportation,'99');assert.equal(h.state.note,'unconfirmed');
 h.ctx.window.confirm=()=>true;const next=h.ctx.loadExpenseReview(target);h.completeRead(2,target,2);await next;assert.equal(h.state.ready,true);assert.equal(h.state.values.transportation,'2');
 const retry=h.ctx.saveExpenseDraft();h.state.calls[3].gate.resolve({data:{}});await retry;assert.equal(h.state.status,'一時保存');
});
for(const [name,data] of [
 ['draft array',{draft:[]}],['draft text',{draft:'broken'}],['note object',{draft:{note:{x:1}}}],['status object',{draft:{status:{x:1}}}],['values array',{draft:{values:[]}}],['values text',{draft:{values:'broken'}}],
 ...['transportation','purchase8','purchase10','netPrintCost','postageCost'].map(key=>['invalid '+key,{draft:{values:{[key]:{x:1}}}}]),
 ['infinite amount',{currentValues:{transportation:Infinity}}],['string amount',{currentValues:{transportation:'100'}}]
])await test('expense malformed response '+name,async()=>{const h=setup();const load=h.ctx.loadExpenseReview('A');h.state.calls[0].gate.resolve({data:{job:{id:'A'},...data}});await load;assert.equal(h.state.ready,false);assert.equal(h.state.status,'読込できませんでした');await h.ctx.saveExpenseDraft();await h.ctx.completeExpense();assert.equal(h.state.calls.length,1);});
await test('expense valid nullable draft fields and decimal values',async()=>{const h=setup();const load=h.ctx.loadExpenseReview('A');h.state.calls[0].gate.resolve({data:{job:{id:'A'},draft:{values:{transportation:250.5,purchase8:0,purchase10:null},note:null,status:null}}});await load;assert.equal(h.state.ready,true);assert.equal(h.state.values.transportation,'250.5');assert.equal(h.state.values.purchase8,'0');assert.equal(h.state.values.purchase10,'');assert.equal(h.state.note,'');});
for(const oldFirst of [false,true])for(const oldFails of [false,true])for(const latestFails of [false,true])await test('same staff period race '+[oldFirst,oldFails,latestFails].join('/'),async()=>{
 const h=performanceSetup(),july={from:'2026-07-01',through:'2026-07-31'},august={from:'2026-08-01',through:'2026-08-31'};
 const old=h.ctx.loadStaffPerformance({id:'A'},july),latest=h.ctx.loadStaffPerformance({id:'A'},august);assert.equal(h.state.calls[0].input.from,july.from);assert.equal(h.state.calls[1].input.from,august.from);
 const finishOld=()=>oldFails?h.state.calls[0].gate.reject(Error('old July failure')):h.state.calls[0].gate.resolve({data:performanceData('A',july)});
 const finishLatest=()=>latestFails?h.state.calls[1].gate.reject(Error('latest August failure')):h.state.calls[1].gate.resolve({data:performanceData('A',august)});
 if(oldFirst){finishOld();await old;assert.equal(h.state.performanceBusy,true);assert.equal(h.state.performance,null);assert.equal(h.state.messages.length,0);finishLatest();await latest;}else{finishLatest();await latest;const current=h.state.performance,messageCount=h.state.messages.length;finishOld();await old;assert.equal(h.state.performance,current);assert.equal(h.state.messages.length,messageCount);}
 assert.equal(h.state.performanceBusy,false);if(latestFails){assert.equal(h.state.performance,null);assert.equal(h.state.messages.at(-1),'latest August failure');}else{assert.equal(h.state.performance.performance.from,august.from);assert.equal(h.state.performance.performance.through,august.through);assert.equal(h.state.messages.length,0);}
});
console.log(JSON.stringify({cases:results.length,passed:results.every(r=>r.passed),results},null,2));if(results.some(r=>!r.passed))process.exitCode=1;

await import('./test-admin-performance-panel.mjs');
