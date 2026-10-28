import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const dependency=createRequire(import.meta.url),ts=dependency('typescript'),React=dependency('react'),{renderToStaticMarkup}=dependency('react-dom/server');
const rangeScope={exports:{}};runInNewContext(ts.transpileModule(fs.readFileSync('apps/admin/src/staff-performance-range.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,rangeScope);
const ranges=rangeScope.exports;
const scope={exports:{},require:name=>name==='./staff-performance-range'?ranges:dependency(name)};runInNewContext(ts.transpileModule(fs.readFileSync('apps/admin/src/AdminStaffPerformancePanel.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,scope);const Panel=scope.exports.default;
const valid={profile:{id:'staff',displayName:'Synthetic',areaLabels:[],nearestStation:'',rank:'A'},performance:{totals:{assignedJobs:1,implementedJobs:1,scheduledJobs:0,cancelledJobs:0,preContactLate:0,reportLate:0},clients:[{name:'Client',count:1}],makers:[],stores:[],recentJobs:[]}};
for(const mode of ['valid','profile-name','area','totals','count','rank-name','recent']){const data=structuredClone(valid);if(mode==='profile-name')data.profile.displayName={};if(mode==='area')data.profile.areaLabels=[{}];if(mode==='totals')data.performance.totals.assignedJobs={};if(mode==='count')data.performance.clients[0].count=-1;if(mode==='rank-name')data.performance.clients[0].name={};if(mode==='recent')data.performance.recentJobs=[null];const html=renderToStaticMarkup(React.createElement(Panel,{performance:data,onClose:()=>{}}));if(mode==='valid'){assert.match(html,/Synthetic/);assert.doesNotMatch(html,/実績を表示できません/);}else assert.match(html,/実績を表示できません/);assert.match(html,/閉じる/);}
console.log('Admin performance panel: valid data and six malformed responses render safely.');
const countPanel=(requestHistory,range={from:'2025-10-01',through:'2026-09-30'})=>{
 const data=structuredClone(valid);Object.assign(data.performance,range);if(requestHistory!==undefined)data.performance.requestHistory=requestHistory;
 return renderToStaticMarkup(React.createElement(Panel,{performance:data,onClose:()=>{}}));
};
const complete={basis:'caseId+staffId',complete:true,totalRequests:4,knownUniqueRequests:4,duplicateRows:1,issues:[]};
const confirmedHtml=countPanel(complete);
assert.ok(confirmedHtml.includes('期間内の依頼数（取消含む）'));
assert.ok(confirmedHtml.includes('<strong>4件</strong>'));
assert.ok(confirmedHtml.includes('2025-10-01〜2026-09-30'));
assert.ok(confirmedHtml.includes('取消になった依頼も含み'));
assert.ok(confirmedHtml.includes('重複検出：1行'));
assert.ok(!confirmedHtml.includes('集計未確定'));
assert.ok(confirmedHtml.includes('稼働・予定'),'existing implemented/scheduled metrics remain distinct');
const incomplete={...complete,complete:false,totalRequests:null,knownUniqueRequests:2,issues:['SYNTHETIC_PRIVATE_ID_MISSING']};
for(const history of [undefined,incomplete,{...complete,totalRequests:null},{...complete,totalRequests:3},{...complete,issues:['unresolved']},{...complete,knownUniqueRequests:-1},{...complete,duplicateRows:{}},{...complete,complete:'true'},{...complete,issues:[{}]},{...complete,totalRequests:2**54,knownUniqueRequests:2**54}]){
 const html=countPanel(history);
 assert.ok(html.includes('<strong>集計未確定</strong>'),'missing/incomplete/malformed request count must never become zero');
 assert.ok(!html.includes('<strong>0件</strong>'));
 assert.ok(html.includes('記録を確認してください'));
 assert.ok(!html.includes('SYNTHETIC_PRIVATE_ID_MISSING'),'raw diagnostic identifiers are not shown');
 assert.ok(!html.includes('実績を表示できません'),'legacy valid performance still renders when new count is unavailable');
}
const incompleteHtml=countPanel(incomplete,{from:'2026-03-01',through:'2026-03-31'});
assert.ok(incompleteHtml.includes('照合できた依頼：2件'));
assert.ok(incompleteHtml.includes('全体の依頼数は未確定'));
assert.ok(incompleteHtml.includes('2026-03-01〜2026-03-31'),'uses selected range rather than a fixed calendar year');
assert.ok(!incompleteHtml.includes('非公開履歴'),'display does not promise data access privacy');
console.log('Admin request history panel: confirmed count includes cancellation by contract; ten unavailable/invalid states stay 集計未確定, partial counts/range and private diagnostic suppression pass.');

assert.deepEqual({...ranges.currentStaffPerformanceYearRange(new Date('2026-12-31T14:59:59Z'))},{from:'2026-01-01',through:'2026-12-31'});
assert.deepEqual({...ranges.currentStaffPerformanceYearRange(new Date('2026-12-31T15:00:00Z'))},{from:'2027-01-01',through:'2027-12-31'});
for(const value of [{from:'2026-02-29',through:'2026-03-01'},{from:'2026-07-31',through:'2026-07-01'},{from:'',through:'2026-12-31'},{from:'0000-01-01',through:'0000-12-31'}])assert.equal(ranges.validStaffPerformanceRange(value),false);
assert.equal(ranges.validStaffPerformanceRange({from:'2024-02-29',through:'2024-03-01'}),true);
function panelHandler(initialRange,busy=false){
 let hook=0;const requests=[],messages=[];
 const fakeReact={...React,useRef:()=>({current:null}),useEffect:()=>{},useState:initial=>{const slot=hook++;return [slot===0?initialRange:'',value=>messages.push(value)];}};
 const ctx={exports:{},require:name=>name==='react'?fakeReact:name==='./staff-performance-range'?ranges:dependency(name)};
 runInNewContext(ts.transpileModule(fs.readFileSync('apps/admin/src/AdminStaffPerformancePanel.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,ctx);
 const element=ctx.exports.default({performance:valid,busy,onRangeChange:range=>requests.push(range),onClose:()=>{}});
 let form;function visit(node){if(!node||typeof node!=='object')return;if(node.type==='form')form=node;for(const item of React.Children.toArray(node.props?.children))visit(item);}visit(element);
 assert.ok(form);let prevented=false;form.props.onSubmit({preventDefault:()=>{prevented=true;}});assert.equal(prevented,true);return {requests,messages};
}
const selected={from:'2026-03-01',through:'2026-03-31'};
assert.deepEqual(JSON.parse(JSON.stringify(panelHandler(selected).requests)),[selected]);
for(const invalid of [{from:'2026-03-31',through:'2026-03-01'},{from:'2026-02-30',through:'2026-03-31'}]){const state=panelHandler(invalid);assert.deepEqual(state.requests,[]);assert.ok(state.messages.some(value=>/開始日と終了日/.test(value)));}
assert.deepEqual(panelHandler(selected,true).requests,[],'busy panel cannot submit another request');
assert.ok(confirmedHtml.includes('type="date"'));
assert.ok(confirmedHtml.includes('今年の年間を選ぶ'));
console.log('Admin performance range: Japan-year boundary, leap/invalid dates, actual selected-range handler and invalid/busy no-request checks PASS.');
