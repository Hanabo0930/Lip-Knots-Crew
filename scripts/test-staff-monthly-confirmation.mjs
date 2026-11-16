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
const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const appPath = 'apps/staff/src/App.tsx';
const app = ts.createSourceFile(appPath, readFileSync(appPath, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let panelModule;
let panel;
function visit(node) {
 if (ts.isVariableDeclaration(node) && node.name.getText(app) === 'PendingAssignmentsPanel') {
  const loader = node.initializer;
  assert.ok(loader && ts.isCallExpression(loader) && loader.expression.getText(app) === 'loadWhenShown');
  const load = loader.arguments[0];
  assert.ok(load && ts.isArrowFunction(load) && ts.isCallExpression(load.body));
  assert.equal(load.body.expression.kind, ts.SyntaxKind.ImportKeyword);
  panelModule = load.body.arguments[0]?.getText(app);
 }
 if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(app) === 'PendingAssignmentsPanel') panel = node;
 ts.forEachChild(node, visit);
}
visit(app);
assert.equal(panelModule, '"./PendingAssignmentsPanel"');
assert.ok(panel, 'The shifts screen must mount the pending assignments panel');
const props = new Map(panel.attributes.properties
 .filter(ts.isJsxAttribute)
 .map(attribute => [attribute.name.getText(app), attribute.initializer?.getText(app)]));
assert.equal(props.get('jobs'), '{pendingApplications}');
assert.match(props.get('onRefresh') ?? '', /refreshBusinessData\(true\)/u);

const panelScope = {
 React,
 exports: {},
 require(name) {
  if (name === 'react') return React;
  if (name === './job-list') return scope.exports;
  assert.fail('Unexpected pending panel dependency ' + name);
 },
};
runInNewContext(ts.transpileModule(readFileSync('apps/staff/src/PendingAssignmentsPanel.tsx', 'utf8'), {
 compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText, panelScope);
function renderPending(jobs, busy = false) {
 return renderToStaticMarkup(React.createElement(panelScope.exports.default, {
  jobs,
  busy,
  onRefresh: async () => assert.fail('Rendering must not start a refresh'),
 }));
}

assert.equal(renderPending([]), '');
const application = { id: 'one', dateKey: '2026-11-02', storeName: '<script>private</script>' };
const html = renderPending([application]);
assert.ok(html.includes('aria-label="確認待ちの手配"'));
assert.ok(html.includes('2026-11-02'));
assert.ok(html.includes('&lt;script&gt;private&lt;/script&gt;'));
assert.ok(html.includes('管理者へご連絡'));
assert.deepEqual(html.match(/<button\b[^>]*>[^<]*<\/button>/gu)?.map(button => button.replace(/<[^>]*>/gu, '')), ['未確認の手配を更新']);
assert.match(renderPending([application], true), /<button[^>]*\bdisabled=""/u);
assert.ok(html.includes('応募受付後、勤務枠の確認を待っています。'));

const manualHtml = renderPending([{
 id: 'manual', dateKey: '2026-11-03', storeName: '合成手入力', caseListManualPending: { observationHash: 'a'.repeat(64) },
}]);
assert.ok(manualHtml.includes('手入力の手配内容を確認中です。'));
assert.ok(!manualHtml.includes('応募受付後、勤務枠の確認を待っています。'));
console.log('Actual pending assignments panel: PASS (shift entry, escaped details, refresh and origin labels)');
