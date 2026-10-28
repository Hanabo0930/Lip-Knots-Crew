import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const scope={exports:{}};
runInNewContext(ts.transpileModule(readFileSync('apps/staff/src/job-list.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,scope);
const {pendingAssignedJobs,splitAssignedJobs,nextShiftJob,orderAssignedJobs}=scope.exports;
const ids=jobs=>Array.from(jobs,job=>job.id);
const today='2026-11-01';
// Both origins follow the same visible state until the server acknowledges
// monthly readback; selecting a transfer is not itself confirmation.
for(const origin of ['application','source-manual']){
 const pending={id:origin,dateKey:'2026-11-02',status:'assigned',applicationUnconfirmed:true};
 const later={id:'verified',dateKey:'2026-11-03',status:'assigned',applicationUnconfirmed:false};
 for(const phase of ['awaiting_selection','selected','write_dispatched','readback_pending']){
  const jobs=[{...pending,caseListTransferState:phase},later];
  assert.deepEqual(ids(orderAssignedJobs(jobs,today)),[origin,'verified'],'pending must remain available for refresh');
  assert.deepEqual(ids(pendingAssignedJobs(jobs,today)),[origin]);
  assert.deepEqual(ids(splitAssignedJobs(jobs,today).upcoming),['verified']);
  assert.equal(nextShiftJob(jobs,today).id,'verified');
 }
 const confirmed={...pending,applicationUnconfirmed:false};
 assert.deepEqual(ids(pendingAssignedJobs([confirmed],today)),[]);
 assert.deepEqual(ids(splitAssignedJobs([confirmed],today).upcoming),[origin]);
 assert.equal(nextShiftJob([confirmed],today).id,origin);
 for(const job of [{...pending,cancelled:true},{...confirmed,cancelled:true},{...pending,status:'cancelled'}]){
  assert.equal(pendingAssignedJobs([job],today).length,0);
  assert.equal(splitAssignedJobs([job],today).upcoming.length,0);
  assert.equal(nextShiftJob([job],today),null);
 }
 assert.deepEqual(ids(splitAssignedJobs([{...pending,dateKey:'2026-10-31'}],today).past),[]);
}
console.log('Staff monthly confirmation lifecycle: PASS (both origins are synthetic display fixtures; manual intake is not implemented by this test)');
// Render the actual App section so the pending list cannot silently disappear
// while the pure selector tests still pass.
const React=await import('react');
const {renderToStaticMarkup}=await import('react-dom/server');
const app=readFileSync('apps/staff/src/App.tsx','utf8');
const start=app.indexOf('{pendingApplications.length>0&&<section');
const end=app.indexOf('\n        <MonthlyShiftCalendar',start);
assert.ok(start>0&&end>start);
const jsx=app.slice(start+1,end).trim().slice(0,-1);
function renderPending(pendingApplications){
 const ctx={React,pendingApplications,shiftDateLabel:job=>job.dateKey,shiftTextLabel:(value,fallback)=>value||fallback};
 runInNewContext(ts.transpileModule('globalThis.result=('+jsx+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,ctx);
 return renderToStaticMarkup(ctx.result);
}
assert.equal(renderPending([]),'');
const html=renderPending([{id:'one',dateKey:'2026-11-02',storeName:'<script>private</script>'}]);
assert.ok(html.includes('aria-label="確認待ちの応募"'));
assert.ok(html.includes('2026-11-02'));
assert.ok(html.includes('&lt;script&gt;private&lt;/script&gt;'));
assert.ok(html.includes('管理者へ直接ご連絡'));
assert.ok(!html.includes('<button'));
console.log('Actual pending application section: PASS (separate label, escaped business details, direct-contact cancellation, no confirmation action)');
