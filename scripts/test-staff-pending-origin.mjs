import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

// Pure production functions and the real pending-section JSX, using synthetic
// records. This is not a full App mount or authenticated backend acceptance.
const root=path.resolve(process.argv[2]??'.');
const dependencyRoot=process.env.LKC_TEST_DEPENDENCY_ROOT;
const requireDependency=createRequire(dependencyRoot?path.join(dependencyRoot,'package.json'):fileURLToPath(import.meta.url));
const ts=requireDependency('typescript'),React=requireDependency('react');
const {renderToStaticMarkup}=requireDependency('react-dom/server');
const app=fs.readFileSync(path.join(root,'apps/staff/src/App.tsx'),'utf8');
const compile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;
function functions(source,names){
 const ast=ts.createSourceFile('fixture.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const found=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text));
 assert.equal(found.length,names.length,'Every probe must use the production function');
 return found.map(n=>source.slice(n.getStart(ast),n.end).replace(/^export /,'')).join('\n');
}
const scope={React,fetch:()=>assert.fail('External communication is forbidden')};
vm.runInNewContext(compile(functions(app,['caseMailPreparationHeld','preContactReadinessMessage','submissionReadinessMessage','validNetPrintItem','validNetPrintTarget','prepSummary'])),scope);
const manualSource=fs.readFileSync(path.join(root,'functions/src/case-list-manual-origin-core.ts'),'utf8');
vm.runInNewContext(compile(functions(manualSource,['manualOwnerReviewCanProceed','manualPendingAssignmentFields'])),scope);
const modules=new Map();
function module(relative){
 if(modules.has(relative))return modules.get(relative);
 const exports={},context={exports,require:name=>{
  if(name==='react')return React;
  if(name==='./job-list')return module('apps/staff/src/job-list.ts');
  assert.fail('Unexpected test dependency: '+name);
 }};
 vm.runInNewContext(compile(fs.readFileSync(path.join(root,relative),'utf8')),context,{filename:relative});
 modules.set(relative,exports);return exports;
}
const list=module('apps/staff/src/job-list.ts'),calendar=module('apps/staff/src/monthly-shift-calendar.ts');
scope.shiftDateLabel=module('apps/staff/src/ShiftJobCards.tsx').shiftDateLabel;
scope.shiftTextLabel=(v,f)=>typeof v==='string'&&v.trim()?v.trim():f;
const start=app.indexOf('{pendingApplications.length>0&&<section aria-label="確認待ちの手配"');
const end=app.indexOf('</section>}',start);
assert.ok(start>=0&&end>start,'Use the actual pending-assignment section');
const jsx=app.slice(app.indexOf('<section',start),end+'</section>'.length);
vm.runInNewContext(compile('globalThis.pendingSection=(pendingApplications)=>('+jsx+');'),scope);

const observation={holdReasons:['OWNER_APPROVAL_REQUIRED'],staffId:'synthetic-staff',canonicalStaffName:'合成担当',sourceStaffName:'合成担当',
 dateKey:'2026-11-20',observationHash:'a'.repeat(64),source:{sourceRevision:'b'.repeat(64)}};
const common={id:'synthetic-job',companyId:'synthetic-company',dateKey:'2026-11-20',workDate:'2026-11-20',menuName:'合成業務',storeName:'合成店舗',workTime:'10:00～18:00'};
const manual={...common,...scope.manualPendingAssignmentFields(observation)};
const application={...common,status:'assigned',assignedStaffId:'synthetic-staff',applicationUnconfirmed:true};
const results=[];
function test(name,action){try{action();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});}}
test('manual pending fields do not represent an application or a monthly ACK',()=>{
 assert.equal(manual.applicationUnconfirmed,true);
 assert.equal(manual.sourceReady,false);
 assert.equal(manual.caseListManualPending.observationHash,observation.observationHash);
 assert.equal(manual.assignmentSheetWrite,undefined);
});
test('manual precontact guidance never claims an application was received',()=>{
 const message=scope.preContactReadinessMessage(manual);
 assert.match(message,/シフト表の担当確認/);assert.doesNotMatch(message,/応募.*受付/);
});
test('manual submission guidance keeps files and never claims an application',()=>{
 const message=scope.submissionReadinessMessage(manual);
 assert.match(message,/写真・PDFは保持/);assert.match(message,/シフト表の担当確認/);
 assert.doesNotMatch(message,/応募.*受付/);
});
test('manual preparation summary remains pending without an application claim',()=>{
 assert.equal(scope.prepSummary(manual),'シフト表の担当確認待ち');
});
test('pending JSX distinguishes manual name input from an actual application',()=>{
 const html=renderToStaticMarkup(scope.pendingSection([manual,application]));
 assert.match(html,/手入力の手配・確認待ち/);assert.match(html,/応募受付・確認待ち/);
 assert.match(html,/ネームアップ後に対象を選び/);assert.match(html,/転記と照合が終わるまで/);
});
for(const [origin,job] of [['manual',manual],['application',application]]){
 test(origin+' stays outside confirmed list and calendar while awaiting ACK',()=>{
  assert.equal(list.pendingAssignedJobs([job],'2026-11-07').length,1);
  assert.equal(list.splitAssignedJobs([job],'2026-11-07').upcoming.length,0);
  assert.equal(list.nextShiftJob([job],'2026-11-07'),null);
  assert.equal(calendar.monthCalendar([job],'2026-11').jobs.size,0);
 });
 test(origin+' enters confirmed UI only after a synthetic server-confirmed state',()=>{
  // This models the already-verified server result. It does not create an ACK,
  // prove an actual sheet write, or turn diagnostic evidence into authority.
  const confirmed={...job,applicationUnconfirmed:false,sourceReady:true};
  assert.equal(list.pendingAssignedJobs([confirmed],'2026-11-07').length,0);
  assert.equal(list.nextShiftJob([confirmed],'2026-11-07').id,job.id);
  assert.equal(calendar.monthCalendar([confirmed],'2026-11').jobs.get(job.dateKey).length,1);
  assert.equal(scope.preContactReadinessMessage(confirmed),null);
  assert.equal(scope.submissionReadinessMessage(confirmed),null);
 });
}
test('a missing Source row is held without inferring cancellation or changing identity',()=>{
 const job={...manual,sourceMissing:true},before=JSON.stringify(job);
 assert.match(scope.preContactReadinessMessage(job),/取込元/);
 assert.match(scope.submissionReadinessMessage(job),/取込元/);
 assert.doesNotMatch(scope.prepSummary(job),/取消|完了/);
 assert.equal(JSON.stringify(job),before);
});
test('mail or owner ambiguity remains held ahead of the generic pending label',()=>{
 const held={...manual,mailIntakeReviewRequired:true};
 assert.match(scope.preContactReadinessMessage(held),/受信内容/);
 assert.match(scope.submissionReadinessMessage(held),/受信内容/);
 assert.equal(scope.prepSummary(held),'受信内容・勤務条件を確認中');
});
test('rendering and readiness leave manual and application records unchanged',()=>{
 for(const job of [manual,application]){const before=JSON.stringify(job);scope.preContactReadinessMessage(job);scope.submissionReadinessMessage(job);scope.prepSummary(job);renderToStaticMarkup(scope.pendingSection([job]));assert.equal(JSON.stringify(job),before);}
});
const report={scope:'Synthetic production manualPendingAssignmentFields, Staff helpers, pending JSX, list and calendar; no full App/auth acceptance',
 base:'487b497d9b2ed93160974a62e7204fc819f33940',tests:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,
 externalCalls:0,businessWrites:0,results};
if(process.argv[3])fs.writeFileSync(path.resolve(process.argv[3]),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
