'use strict';
// Existing supported pattern: TypeScript-transpiled production components and
// App JSX/functions rendered with actual ReactDOMServer. No DOM/browser/HTTP.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),req=createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT||root,'package.json'));
const React=req('react'),{renderToStaticMarkup}=req('react-dom/server'),ts=req('typescript'),cache=new Map();
function component(name){const file=path.join(root,'apps/staff/src',name);if(cache.has(file))return cache.get(file);const module={exports:{}};
 const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 vm.runInNewContext(js,{module,exports:module.exports,require:s=>{if(s.startsWith('react'))return req(s);if(s.endsWith('.css'))return {};if(s.startsWith('./'))return component(s.slice(2)+(/Calendar$|Cards$/.test(s)?'.tsx':'.ts'));throw Error('OFFLINE_IMPORT_FORBIDDEN:'+s);},fetch:()=>{throw Error('NETWORK_FORBIDDEN');},Date,Error},{filename:file});cache.set(file,module.exports);return module.exports;
}
const Calendar=component('MonthlyShiftCalendar.tsx').default,cards=component('ShiftJobCards.tsx'),Cards=cards.default,list=component('job-list.ts');
const appPath=path.join(root,'apps/staff/src/App.tsx'),app=fs.readFileSync(appPath,'utf8'),ast=ts.createSourceFile('App.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const names=['caseMailPreparationHeld','preContactReadinessMessage','submissionReadinessMessage','validNetPrintItem','validNetPrintTarget','prepSummary'];
const helpers=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast)).join('\n');assert.equal(ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).length,names.length);
const begin=app.indexOf('{pendingApplications.length>0&&<section'),end=app.indexOf('</section>}',begin);assert(begin>=0&&end>begin);
const pending=app.slice(begin+1,end+10),scope={module:{exports:{}},React,shiftDateLabel:cards.shiftDateLabel,shiftTextLabel:cards.shiftTextLabel};
const code=helpers+'\nfunction Pending({jobs}){const pendingApplications=jobs;return ('+pending+');}\nmodule.exports={Pending,submissionReadinessMessage,prepSummary};';
vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText,scope);
const {Pending,submissionReadinessMessage,prepSummary}=scope.module.exports;
const base={id:'synthetic-job',dateKey:'2026-12-06',workDate:'12/6（日）',status:'assigned',storeName:'架空店舗',makerName:'架空メーカー',menuName:'合成業務',workTime:'10:00-18:00',materialStatus:'作成中',netPrint:{items:[]},submissionStatus:{}};
const html=node=>renderToStaticMarkup(node),results=[];function test(name,fn){try{fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});}}
for(const [name,patch,present]of [
 ['confirmed',{},true],['application pending',{applicationUnconfirmed:true},false],['manual pending',{applicationUnconfirmed:true,caseListManualPending:{staffId:'synthetic-staff'}},false],
 ['unresolved',{applicationUnconfirmed:true,assignmentUnresolved:true},false],['source missing',{applicationUnconfirmed:true,sourceMissing:true},false],['cancelled',{cancelled:true},false],['wrong status',{status:'cancelled'},false],['invalid date',{dateKey:'2026-02-30'},false],
])test('real Calendar SSR '+name,()=>{const markup=html(React.createElement(Calendar,{jobs:[{...base,...patch}],today:'2026-12-01',onSelect:()=>{}}));assert.equal(markup.includes('2026-12-06の確定シフト 1件を表示'),present);});
test('real Calendar SSR year boundary displays a valid date without claiming backend support',()=>{const markup=html(React.createElement(Calendar,{jobs:[{...base,dateKey:'2027-01-01'}],today:'2027-01-01',onSelect:()=>{}}));assert(markup.includes('2027-01-01の確定シフト 1件を表示'));});
test('real Calendar SSR duplicate ID produces review message rather than duplicate confirmations',()=>{const markup=html(React.createElement(Calendar,{jobs:[base,{...base}],today:'2026-12-01',onSelect:()=>{}}));assert(markup.includes('同じ案件が重複'));assert(!markup.includes('calendar-day-shifts'));});
for(const manual of [false,true])test('actual App pending JSX '+(manual?'manual':'application')+' remains distinct from confirmed cards',()=>{
 const job={...base,applicationUnconfirmed:true,...(manual?{caseListManualPending:{staffId:'synthetic-staff'}}:{})};
 const markup=html(React.createElement(Pending,{jobs:list.pendingAssignedJobs([job],'2026-11-07')}));assert(markup.includes(manual?'手入力の手配・確認待ち':'応募受付・確認待ち'));assert(markup.includes('確定シフトには表示されません'));
 assert.equal(list.splitAssignedJobs([job],'2026-11-07').upcoming.length,0);
});
test('actual App pending JSX hides after precise confirmation',()=>{assert.equal(html(React.createElement(Pending,{jobs:list.pendingAssignedJobs([base],'2026-11-07')})),'');});
for(const patch of [{},{applicationUnconfirmed:true},{applicationUnconfirmed:true,sourceMissing:true}])test('actual preparation/submission rendering '+JSON.stringify(patch),()=>{
 const job={...base,...patch},ready=submissionReadinessMessage(job),markup=html(React.createElement(Cards,{jobs:[job],page:0,onPageChange:()=>{},onSelect:()=>{},label:'合成シフト',accent:()=> '#000',kind:()=> '合成',summary:prepSummary}));
 if(patch.applicationUnconfirmed){assert(ready.includes('選択した写真・PDFは保持'));assert(markup.includes(patch.sourceMissing?'取込元の案件を確認中':'シフト表の担当確認待ち'));}else{assert.equal(ready,null);assert(markup.includes('作成中'));}
});
test('real Shift cards escape untrusted display text and normalize stale workDate to the fixed date',()=>{const job={...base,storeName:'<script>synthetic</script>',workDate:'12/7（月）'};
 const markup=html(React.createElement(Cards,{jobs:[job],page:0,onPageChange:()=>{},onSelect:()=>{},label:'合成',accent:()=> '#000',kind:()=> '合成',summary:()=> '準備中'}));assert(!markup.includes('<script>'));assert(markup.includes('&lt;script&gt;'));assert(markup.includes('2026-12-06'));});
const report={tests:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,results,
 scope:'Actual ReactDOMServer SSR of production Calendar/Cards and exact App pending JSX/helper functions. No effects, browser interaction, layout measurement, visual QA or whole-App mount.',
 appSha256:crypto.createHash('sha256').update(app).digest('hex'),externalRequests:0,browserLaunches:0,deniedNavigationRetried:false,realDataWrites:0};
fs.mkdirSync(path.join(root,'release-evidence'),{recursive:true});fs.writeFileSync(path.join(root,'release-evidence/ci-crew-external-components.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
