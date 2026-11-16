'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const dependency = createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT, 'package.json'));
const ts = dependency('typescript');
const React = dependency('react');
const { renderToStaticMarkup } = dependency('react-dom/server');
const source = fs.readFileSync('apps/admin/src/App.tsx', 'utf8');
const start = source.indexOf('  async function loadExpenseReview(');
const end = source.indexOf('  async function openJobSheet(', start);
assert.ok(start >= 0 && end > start);
const functionsCode = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const version = 'a'.repeat(64);
const hold = 'この案件の経費確定は保留中です。';
const blankExpense = { transportation: '', purchase8: '', purchase10: '', netPrintCost: '', postageCost: '' };

async function exercise(data) {
  const calls = [];
  const ctx = {
    auth: { currentUser: { uid: 'synthetic-admin' } }, adminSessionReady: true,
    firebaseConfigured: true, functions: {}, jobs: [], blankExpense,
    expenseJobId: '', expenseValues: blankExpense, expenseNote: '',
    expenseReadyRef: { current: null }, expenseLoadRef: { current: null },
    expenseWriteRef: { current: null }, expenseVersionRef: { current: 0 },
    window: { confirm: () => assert.fail('Confirmation should not open') },
    openWorkspace() {}, setExpenseBusy() {}, setExpenseStatus() {}, setMessage() {},
    setExpenseReady(value) { ctx.ready = value; },
    setExpenseValues(value) { ctx.expenseValues = value; },
    setExpenseNote(value) { ctx.expenseNote = value; },
    setExpenseJobId(value) { ctx.expenseJobId = value; },
    expenseReadinessMessage: () => null,
    httpsCallable: (_functions, name) => async input => {
      calls.push({ name, input });
      return name === 'getExpenseReview' ? { data } : { data: { status: 'draft' } };
    },
  };
  vm.runInNewContext(functionsCode, ctx);
  await ctx.loadExpenseReview('synthetic-job');
  return { ctx, calls };
}

(async () => {
  const payload = {
    job: { id: 'synthetic-job' }, currentValues: { transportation: 700, purchase8: null, purchase10: 0 },
    writeBlockedReason: hold, draftAllowedWhileHeld: true, reviewVersion: version,
  };
  const { ctx, calls } = await exercise(payload);
  assert.equal(ctx.ready, true);
  assert.equal(ctx.expenseValues.purchase8, '');
  assert.equal(ctx.expenseValues.purchase10, '0');
  assert.equal(ctx.expenseReadyRef.current.completionHoldReason, hold);
  await ctx.completeExpense();
  assert.equal(calls.length, 1);
  await ctx.saveExpenseDraft();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].name, 'saveExpenseReviewDraft');
  assert.equal(calls[1].input.expectedVersion, version);

  for (const data of [{ ...payload, draftAllowedWhileHeld: false }, { ...payload, reviewVersion: undefined }]) {
    const held = await exercise(data);
    await held.ctx.saveExpenseDraft();
    assert.equal(held.ctx.ready, false);
    assert.equal(held.calls.length, 1);
  }

  const panel = fs.readFileSync('apps/admin/src/AdminExpensePanel.tsx', 'utf8');
  const module = { exports: {} };
  const js = ts.transpileModule(panel, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(js, {
    exports: module.exports,
    require(name) {
      if (name === './expense-readiness') return { expenseReadinessMessage: () => null };
      assert.ok(['react', 'react/jsx-runtime'].includes(name));
      return dependency(name);
    },
  });
  const html = renderToStaticMarkup(React.createElement(module.exports.default, {
    expenseCompletionHoldReason: hold, expenseJobId: 'synthetic-job', jobs: [],
    expenseValues: blankExpense, expenseNote: '', expenseStatus: 'draft', expenseReady: true, expenseBusy: false,
  }));
  assert.match(html, /<button class="ghost">一時保存<\/button>/);
  assert.match(html, /<button disabled="" aria-describedby="expense-completion-hold-reason">確認完了・書込待ちへ<\/button>/);
  assert.ok(html.includes('下書きは一時保存できます'));
  const pendingReason='月別表への反映結果を照合中です。最新の状態は「読込」で確認してください。';
  const pending=await exercise({...payload,writeBlockedReason:pendingReason,draftAllowedWhileHeld:false,draft:{status:'confirmation_pending'}});
  await pending.ctx.saveExpenseDraft();
  await pending.ctx.completeExpense();
  assert.equal(pending.calls.length,1);
  assert.equal(pending.ctx.ready,false);
  const pendingHtml=renderToStaticMarkup(React.createElement(module.exports.default,{
    expenseHoldReason:pendingReason,expenseJobId:'synthetic-job',jobs:[],expenseValues:blankExpense,
    expenseNote:'',expenseStatus:'confirmation_pending',expenseReady:false,expenseBusy:false,
  }));
  assert.match(pendingHtml,/aria-label="経費確認の状態">反映結果を照合中/);
  assert.match(pendingHtml,/<button class="ghost">読込<\/button>/);
  assert.match(pendingHtml,/<button class="ghost" disabled="" aria-describedby="expense-hold-reason">一時保存<\/button>/);
  console.log(JSON.stringify({ passed: true, assertions: ['ready with completion held', 'zero and blank preserved', 'draft callable only', 'no version or no permission holds', 'actual component renders completion disabled', 'pending permits read and blocks draft and completion'] }));
})().catch(error => { console.error(error); process.exitCode = 1; });
