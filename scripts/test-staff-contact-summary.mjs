import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';import {runInNewContext} from 'node:vm';
const app=fs.readFileSync('apps/staff/src/App.tsx','utf8');const start=app.indexOf('function contactShiftSummary('),end=app.indexOf('const CONTACT_EMAIL=',start);assert.ok(start>=0&&end>start);const list={exports:{}};runInNewContext(ts.transpileModule(fs.readFileSync('apps/staff/src/job-list.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,list);const cards=fs.readFileSync('apps/staff/src/ShiftJobCards.tsx','utf8');const label=cards.slice(cards.indexOf('export function shiftDateLabel'),cards.indexOf('export function shiftPage')).replaceAll('export function','function');const ctx={hasValidDateKey:list.exports.hasValidDateKey};runInNewContext(ts.transpileModule(label,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);runInNewContext(ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
for(const [job,expected] of [
 [{workDate:'2026-09-10',dateKey:'2026-09-11',storeName:'店舗A',workTime:'09:00〜17:00'},['2026-09-11','店舗A','09:00〜17:00']],
 [{workDate:'　 ',dateKey:' 2026-09-11 ',storeName:' 店舗B ',workTime:' 10:00〜18:00 '},['確認中','店舗B','10:00〜18:00']],
 [{workDate:'2月30日',dateKey:'2026-02-30'},['確認中','確認中','確認中']],
 [{},['確認中','確認中','確認中']],
 [{workDate:null,dateKey:null,storeName:null,workTime:null},['確認中','確認中','確認中']],
 [{workDate:123,dateKey:'2026-09-11',storeName:{name:'invalid'},workTime:0},['2026-09-11','確認中','確認中']],
 [{workDate:' ',dateKey:'　',storeName:'　',workTime:'　'},['確認中','確認中','確認中']],
])assert.equal(ctx.contactShiftSummary(job),['勤務日：'+expected[0],'店舗：'+expected[1],'勤務時間：'+expected[2]].join('\n'));
console.log('Contact shift summary passed: 7 date fallback/trim/missing/null/non-string cases, exact displayed/copy text; no real contact.');

for(const year of ['2026','2027'])assert.equal(ctx.contactShiftSummary({dateKey:year+'-09-11',workDate:'9月11日',storeName:'同じ店舗',workTime:'09:00'}),'勤務日：'+year+'-09-11\n店舗：同じ店舗\n勤務時間：09:00');
console.log('Contact dates: canonical business date wins over mismatched display date and distinguishes the same month/day across years.');

{
 const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 for(const target of ['selectedJob','selectedAssignedJob']){const start=app.indexOf('{!hasValidDateKey('+target+')&&<p className="missing-work-date'),end=app.indexOf('</p>}',start)+5;assert.ok(start>=0&&end>start);const code=ts.transpileModule('globalThis.node='+app.slice(start+1,end-1)+';',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
  for(const dateKey of [undefined,null,{},'', '2026-02-30','2026-13-01','2026-09-11','2024-02-29']){const job={dateKey},scope={React:{createElement},hasValidDateKey:list.exports.hasValidDateKey,[target]:job};runInNewContext(code,scope);const html=renderToStaticMarkup(scope.node);if(list.exports.hasValidDateKey(job))assert.equal(html,'');else{assert.ok(html.includes('勤務日を確認できません'));assert.ok(html.includes(target==='selectedJob'?'「シフトを更新」':'「提出情報を再読み込み」'));assert.ok(html.includes('role="status"'));}}
 }
 console.log('Missing work-date guidance: 16 detail/submission invalid, missing and valid/leap-day states guide the local refresh without changing selected files.');
}

{
 const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');const from=app.indexOf('{!hasCompleteContactShift(selectedAssignedJob)&&'),to=app.indexOf('</p>}',from)+5;assert.ok(from>=0&&to>from);const code=ts.transpileModule('globalThis.node='+app.slice(from+1,to-1)+';',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
 const valid={dateKey:'2026-09-11',storeName:' 店舗A ',workTime:' 09:00〜17:00 '};
 for(const patch of [{},{dateKey:'2026-02-30'},{dateKey:null},{storeName:'　'},{storeName:null},{storeName:123},{workTime:''},{workTime:null},{workTime:{}}]){
  const job={...valid,...patch},complete=Object.keys(patch).length===0;assert.equal(ctx.hasCompleteContactShift(job),complete);const scope={React:{createElement},selectedAssignedJob:job,hasCompleteContactShift:ctx.hasCompleteContactShift};runInNewContext(code,scope);const html=renderToStaticMarkup(scope.node);if(complete)assert.equal(html,'');else{assert.ok(html.includes('未確認の項目'));assert.ok(html.includes('シフトを更新'));assert.ok(html.includes('上の連絡先'));assert.ok(html.includes('role="status"'));}
 }
}
console.log('Contact missing-information recovery: 9 valid/invalid date/store/time cases show actionable refresh/contact guidance without altering copy text.');
