import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const jobList={exports:{}};runInNewContext(ts.transpileModule(readFileSync('apps/staff/src/job-list.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,jobList);const baseRequire=createRequire(import.meta.url);const scope={exports:{},require:name=>name==='./job-list'?jobList.exports:baseRequire(name)};
runInNewContext(ts.transpileModule(readFileSync('apps/staff/src/ShiftJobCards.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,scope);
const {shiftPage}=scope.exports;
for(const count of [0,1,49,50,51,1000]){
 const jobs=Array.from({length:count},(_,id)=>({id}));
 const seen=[];
 for(let page=0;page<shiftPage(jobs,0).totalPages;page++)seen.push(...shiftPage(jobs,page).rows);
 assert.deepEqual(seen,jobs);
 assert.equal(shiftPage(jobs,10000).current,Math.max(0,Math.ceil(count/50)-1));
 assert.equal(shiftPage(jobs,-1).current,0);
 assert.equal(shiftPage(jobs,NaN).current,0);
 assert.equal(shiftPage(jobs,Infinity).current,0);
}
console.log('Shift cards passed: empty, 1/49/50/51/1000 rows, all-page coverage and invalid/stale page clamp.');
{
 const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const jobs=[{id:'one',workDate:'9月10日',dateKey:'2026-09-10',storeName:'同じ店舗',workTime:'10:00〜18:00',menuName:'a'},{id:'two',workDate:'9月11日',dateKey:'2026-09-11',storeName:'同じ店舗',workTime:'09:00〜17:00',menuName:'a'}];
 const html=renderToStaticMarkup(createElement(scope.exports.default,{jobs,page:0,onPageChange:()=>{},onSelect:()=>{},label:'これからのシフト',accent:()=> '#000',kind:()=> '仕事',summary:()=> '準備中'}));
 for(const job of jobs)assert.ok(html.includes('aria-label="'+job.workDate+' '+job.storeName+' '+job.workTime+'のシフトを確認"'));
 console.log('Shift card names: same-store jobs include their individual date and work hours in accessible names.');
}

{const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');for(const [workDate,dateKey,expected] of [['2月30日','2026-02-30','勤務日確認中'],[{},'2026-09-10','2026-09-10'],['   ','2026-09-10','2026-09-10'],[null,'2026-09-10','2026-09-10'],['9月10日',{},'勤務日確認中'],['9月10日',null,'勤務日確認中'],['2月29日','2024-02-29','2月29日']]){const job={id:'one',workDate,dateKey,storeName:'確認店舗',workTime:'09:00〜17:00',menuName:'a'};assert.equal(scope.exports.shiftDateLabel(job),expected);const html=renderToStaticMarkup(createElement(scope.exports.default,{jobs:[job],page:0,onPageChange:()=>{},onSelect:()=>{},label:'シフト',accent:()=> '#000',kind:()=> '仕事',summary:()=> '準備中'}));assert.ok(html.includes('class="date">'+expected+'</span>'));assert.ok(html.includes('aria-label="'+expected+' 確認店舗'));}}
console.log('Shift card dates: seven malformed/missing/leap-day cases render matching visible and accessible date labels.');

{const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');for(const value of [undefined,null,{},42,false,'','　 ']){const job={id:'retained',workDate:'9月11日',dateKey:'2026-09-11',storeName:value,workTime:value,menuName:'a'};const html=renderToStaticMarkup(createElement(scope.exports.default,{jobs:[job],page:0,selectedId:'retained',onPageChange:()=>{},onSelect:()=>{},label:'シフト',accent:()=> '#000',kind:()=> '仕事',summary:()=> '準備中'}));assert.ok(html.includes('class="shift-card-store">店舗確認中</strong>'));assert.ok(html.includes('class="shift-card-time">勤務時間確認中</span>'));assert.ok(html.includes('aria-label="9月11日 店舗確認中 勤務時間確認中のシフトを確認"'));assert.ok(html.includes('aria-pressed="true"'));}}
console.log('Shift card text: seven missing/invalid store and time values render matching fallback labels without losing selected state.');

{
 const app=readFileSync('apps/staff/src/App.tsx','utf8'),start=app.indexOf('function submissionSummary('),end=app.indexOf('function prepSummary(',start);assert.ok(start>0&&end>start);const helper={};runInNewContext(ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,helper);
 const {createElement}=baseRequire('react'),{renderToStaticMarkup}=baseRequire('react-dom/server');
 for(const [value,expected] of [[true,'完了'],[false,'未完了'],[undefined,'未確認'],['true','未確認'],[1,'未確認'],[{},'未確認']])for(const kind of ['salesFloor','report']){
  const job={id:'job',dateKey:'2026-09-11',workDate:'9/11',storeName:'店舗',menuName:'業務',workTime:'9:00',submissionStatus:{[kind]:{completed:value}}};
  const html=renderToStaticMarkup(createElement(scope.exports.default,{jobs:[job],page:0,onPageChange:()=>{},onSelect:()=>{},label:'シフト',accent:()=> '#000',kind:()=> '業務',summary:()=> '準備完了',submissionSummary:helper.submissionSummary}));assert.ok(html.includes((kind==='salesFloor'?'売場画像：':'報告書：')+expected));assert.ok(html.includes((kind==='salesFloor'?'報告書：':'売場画像：')+'未確認'));assert.ok(html.includes('準備完了'));assert.ok(html.includes('のシフトを確認。売場画像：'));
 }
 console.log('Shift card submission status: 12 typed/missing/malformed states distinguish completion from material preparation.');
}

{
 const app=readFileSync('apps/staff/src/App.tsx','utf8'),start=app.indexOf('function submissionSummary('),end=app.indexOf('function prepSummary(',start),helper={};runInNewContext(ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,helper);
 for(const completed of [true,false,undefined])for(const field of ['clientSubmitted','lipKnotsSubmitted'])for(const value of [true,false,'true',1,{}]){
  const text=helper.submissionSummary({submissionStatus:{salesFloor:{completed,[field]:value}}});const expected=completed===true||value===true?'完了':completed===false?'未完了':'未確認';assert.equal(text,'売場画像：'+expected+' / 報告書：未確認');
 }
 console.log('Sales-floor completion: 30 direct/app-submitted flags agree with strict completion semantics.');
}

{
 const {createElement}=baseRequire('react'),{renderToStaticMarkup}=baseRequire('react-dom/server');
 for(const [workDate,dateKey,expected] of [['2026-09-10','2026-09-11','2026-09-11'],['9月10日','2026-09-11','2026-09-11'],['2025年9月11日','2026-09-11','2026-09-11'],['9/11(木)','2026-09-11','2026-09-11'],['9/11(金)','2026-09-11','9/11(金)'],['9月11日（金曜日）','2026-09-11','9月11日（金曜日）'],['2026/9/11','2026-09-11','2026/9/11'],[' 9月11日 ','2026-09-11','9月11日'],['勤務日未定','2026-09-11','2026-09-11'],['2/29(月)','2024-02-29','2024-02-29'],['2/29(木)','2024-02-29','2/29(木)']]){
  const job={id:'date',workDate,dateKey,storeName:'店舗',workTime:'09:00',menuName:'業務'};assert.equal(scope.exports.shiftDateLabel(job),expected);const html=renderToStaticMarkup(createElement(scope.exports.default,{jobs:[job],page:0,onPageChange:()=>{},onSelect:()=>{},label:'シフト',accent:()=> '#000',kind:()=> '業務',summary:()=> '準備中'}));assert.ok(html.includes('class="date">'+expected+'</span>'));assert.ok(html.includes('aria-label="'+expected+' 店舗'));
 }
 console.log('Shift display-date integrity: 11 date/year/weekday/format cases keep matching labels and fall back to the canonical business date on disagreement.');
}
