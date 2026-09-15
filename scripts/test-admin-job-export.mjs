import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json'));
const ts=require('typescript');
function readModule(file){const exports={};Function('exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(exports);return exports;}
const {buildDemoJobExport}=readModule('apps/admin/src/demo-job-export.ts');
const {buildJobCsv}=readModule('functions/src/job-management-core.ts');
const base={id:'a',workDate:'2026-09-02',clientName:'顧客,"A"',makerName:'メーカー',storeName:'店舗\n改行',status:'assigned',financials:{clientChargeTotal:12000,clientChargeAdditionsTotal:500,staffPaymentTotal:8000,subcontractorTotal:9000}};
const jobs=[base,{...base,id:'b',workDate:'2026-09-01',subcontractorName:'外注'},{...base,id:'c',workDate:'2026-09-03',status:'cancelled'},{...base,id:'d',workDate:'2026-08-31'},{...base,id:'e',workDate:'2026-10-01'},{...base,id:'f',clientName:'別顧客',makerName:'別メーカー'}];
const options={from:'2026-09-01',through:'2026-09-30',groupBy:'client',name:base.clientName,includeCancelled:false};
const result=buildDemoJobExport(jobs,options);
assert.equal(result.rows,2);assert.equal(Buffer.from(result.csv).subarray(0,3).toString('hex'),'efbbbf');
assert.equal(result.csv,buildJobCsv([{...jobs[1],invoice:12500,payment:9000,grossProfit:3500},{...base,invoice:12500,payment:8000,grossProfit:4500}]));
assert.equal(result.csv.split('\r\n').length,3);assert.ok(result.csv.includes('"顧客,""A"""'));assert.ok(result.csv.includes('"店舗 改行"'));
assert.equal(buildDemoJobExport(jobs,{...options,includeCancelled:true}).rows,3);
assert.equal(buildDemoJobExport(jobs,{...options,name:''}).rows,3);
assert.equal(buildDemoJobExport(jobs,{...options,groupBy:'maker',name:'別メーカー'}).rows,1);
assert.equal(buildDemoJobExport(jobs,{...options,name:'該当なし'}).csv,buildJobCsv([]));
assert.equal(buildDemoJobExport([{...base,financials:{},clientName:'a/b:c'}],{...options,name:'a/b:c'}).filename,'デモ_2026-09-01_2026-09-30_a_b_c_案件一覧.csv');
assert.equal(jobs[0].id,'a');
console.log('Admin CSV passed: UTF-8 BOM, CRLF, quoting, server column parity, date/name/cancellation filters, sorting, totals, empty output and safe filename.');

const app=fs.readFileSync('apps/admin/src/App.tsx','utf8');const start=app.indexOf('async function exportJobs()'),end=app.indexOf('function downloadCsv(',start);const exportCode=ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
for(const [from,through] of [['','2026-09-01'],['2026-09-01',''],['2026-10-01','2026-09-01']]){
 let message='';const exportJobs=Function('exportFrom','exportThrough','setMessage','exportRunRef','auth','firebaseConfigured',exportCode+';return exportJobs;')(from,through,value=>message=value,{current:null},{},false);await exportJobs();assert.match(message,/終了日は開始日以降/);
}
console.log('Admin CSV rejects missing/reversed dates before requesting or downloading data.');

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};}
function setup(){const state={calls:0,downloads:[],messages:[],busy:false};const deps={exportRunRef:{current:null},auth:{currentUser:{}},firebaseConfigured:true,functions:{},exportFrom:'2026-09-01',exportThrough:'2026-09-30',exportGroupBy:'client',exportName:'',exportIncludeCancelled:false,setMessage:m=>state.messages.push(m),setExportBusy:b=>state.busy=b,downloadCsv:(...args)=>state.downloads.push(args),httpsCallable:()=>async()=>{state.calls++;const gate=deferred();state.gates.push(gate);return gate.promise;}};state.gates=[];const handler=Function(...Object.keys(deps),exportCode+';return exportJobs;')(...Object.values(deps));return {state,deps,handler};}
const response={data:{filename:'synthetic.csv',csv:'synthetic',rows:1}};
{const test=setup();const first=test.handler();await test.handler();assert.equal(test.state.calls,1);test.state.gates[0].resolve(response);await first;assert.equal(test.state.downloads.length,1);assert.equal(test.state.busy,false);assert.equal(test.deps.exportRunRef.current,null);}
for(const fail of [false,true])for(const sameUser of [false,true]){const test=setup();const first=test.handler();if(!sameUser)test.deps.auth.currentUser={};test.deps.exportRunRef.current=null;test.deps.setExportBusy(false);fail?test.state.gates[0].reject(Error('old error')):test.state.gates[0].resolve(response);await first;assert.equal(test.state.downloads.length,0);assert.equal(test.state.messages.length,0);assert.equal(test.state.busy,false);}
{const test=setup();const old=test.handler();test.deps.exportRunRef.current=null;const next=test.handler();const token=test.deps.exportRunRef.current;test.state.gates[0].resolve(response);await old;assert.equal(test.deps.exportRunRef.current,token);assert.equal(test.state.busy,true);test.state.gates[1].resolve(response);await next;assert.equal(test.state.downloads.length,1);}
{const test=setup();const first=test.handler();test.state.gates[0].reject(Error('retry'));await first;assert.equal(test.state.messages[0],'retry');const second=test.handler();test.state.gates[1].resolve(response);await second;assert.equal(test.state.calls,2);}
{const test=setup();test.deps.auth.currentUser=null;await test.handler();assert.equal(test.state.calls,0);}
assert.match(app,/exportRunRef.current=null;setExportBusy\(false\);/);
console.log('Admin CSV concurrency passed: double click, stale auth success/error, newer request ownership, retry and missing session.');

{const start=app.indexOf('const [exportFrom,'),end=app.indexOf('const [exportGroupBy,',start);const defaults=ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;for(const [month,last] of [['2024-02','29'],['2026-02','28'],['2026-09','30'],['2026-12','31']]){const result=Function('currentTokyoMonth','useState',defaults+';return [exportFrom,exportThrough];')(()=>month,fn=>[fn()]);assert.deepEqual(result,[month+'-01',month+'-'+last]);}}
console.log('Admin CSV defaults passed: current month, leap/non-leap February and year end.');
