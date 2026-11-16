import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const dependency = createRequire(import.meta.url);
function loadModule(path, modules = {}) {
 const scope = {
  exports: {},
  require(name) {
   return Object.hasOwn(modules, name) ? modules[name] : dependency(name);
  },
 };
 const compilerOptions = { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 };
 runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions }).outputText, scope);
 return scope.exports;
}
const panel = loadModule('apps/admin/src/AdminExpensePanel.tsx', {
 './expense-readiness': loadModule('apps/admin/src/expense-readiness.ts'),
 './AdminExpenseOperation': loadModule('apps/admin/src/AdminExpenseOperation.tsx'),
});
const statuses={draft:'一時保存',queued:'反映待ち',completed:'反映完了',error:'反映要確認','未読込':'未読込','読込中':'読込中','デモ読込済み':'デモ読込済み','未処理':'未処理','一時保存':'一時保存','書込待ち':'書込待ち','結果を再確認してください':'結果を再確認してください','読込できませんでした':'読込できませんでした',future:'状態を確認してください',constructor:'状態を確認してください'};
for(const [status,label]of Object.entries(statuses)){const html=renderToStaticMarkup(createElement(panel.default,{jobs:[],expenseJobId:'',expenseValues:{},expenseNote:'',expenseStatus:status,expenseBusy:false,expenseReady:false,loadExpenseReview:async()=>{},saveExpenseDraft:async()=>{},completeExpense:async()=>{},openSheet:()=>{},setExpenseValues:()=>{},setExpenseNote:()=>{}}));assert.ok(html.includes('aria-label="経費確認の状態">'+label+'</span>'),status);assert.equal(html.includes('反映はまだ確認できていません'),['queued','書込待ち'].includes(status));assert.equal(html.includes('「概要」の「スプシ書込エラー・競合」'),status==='error');assert.equal(html.includes('再送する前に「スプシ該当行」で原本と入力内容を照合'),status==='error');if(status!=='completed')assert.ok(!html.includes('>反映完了<'));}console.log('経費状態表示: 14状態でサーバー結果/画面待機/不明状態を区別し、未確認を反映完了と表示しない。');

const fixtureProps={jobs:[{id:'case-1',workDate:'2026-12-08',storeName:'合成店舗',caseListSource:{verified:true}}],
 expenseJobId:'case-1',expenseValues:{transportation:'0'},expenseNote:'合成',expenseStatus:'draft',expenseBusy:false,expenseReady:true,
 loadExpenseReview:async()=>{},saveExpenseDraft:async()=>{},completeExpense:async()=>{},openSheet:()=>{},setExpenseValues:()=>{},setExpenseNote:()=>{}};
const blocked=renderToStaticMarkup(createElement(panel.default,{...fixtureProps,expenseCompletionHoldReason:'原本への反映待ち'}));
assert.match(blocked,/「読込」で原本を照合します/);
assert.match(blocked,/<button[^>]+disabled=""[^>]*>経費確定は保留中<\/button>/);
assert.match(blocked,/<button class="ghost">一時保存<\/button>/);
const hold=renderToStaticMarkup(createElement(panel.default,{...fixtureProps,expenseHoldReason:'合成の全体保留'}));
assert.match(hold,/<button[^>]+disabled=""[^>]*>一時保存<\/button>/);
assert.match(hold,/<button[^>]+disabled=""[^>]*>経費確定は保留中<\/button>/);
const ordinaryProps={...fixtureProps,lookupExpenseOperation:async()=>null,jobs:[{...fixtureProps.jobs[0],caseListSource:null}]};
const ordinary=renderToStaticMarkup(createElement(panel.default,ordinaryProps));
assert.match(ordinary,/経費の反映状況を照会/);
assert.doesNotMatch(renderToStaticMarkup(createElement(panel.default,{...ordinaryProps,active:false})),/経費の反映状況を照会/);
assert.match(ordinary,/<button>確認完了・書込待ちへ<\/button>/);
const adminApp=readFileSync('apps/admin/src/App.tsx','utf8');
assert.match(adminApp,/「アプリへ取込確定」は、原本を変更しない読取同期/);
assert.match(adminApp,/請求・支払が未確認の場合は出力を保留します/);
console.log('案件リストの案内3条件成功。読込み・下書き・原本反映のボタンとCSVの保留表示。');
