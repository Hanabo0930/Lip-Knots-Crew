import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {formatDiagnosticReport} from '../apps/staff/src/diagnostic-report-format.ts';

const app=readFileSync('apps/staff/src/App.tsx','utf8');
const start=app.indexOf('  async function openQuickDiagnostics()');
const end=app.indexOf('  function isDiagnosticsPending()',start);
assert.ok(start>=0&&end>start);
const code=app.slice(start,end);
let count=0;
for(const mode of ['success','auth','closed','superseded','load-failure']){
 let resolve,reject;
 const loaded=new Promise((yes,no)=>{resolve=yes;reject=no;});
 const reports=[],messages=[],calls=[];
 const report={checkedAt:'2026-10-30T05:00:00Z',checks:[{id:'fixture',label:'合成診断',detail:'合成境界',level:'pass'}],summary:'pass',serverPushEnabled:false};
 const ctx={isDiagnosticsPending:()=>false,diagnosticsVersionRef:{current:0},authLoadVersionRef:{current:1},pastShiftVersionRef:{current:0},pushStateVersionRef:{current:0},isPending:()=>false,
  setShowAccountMenu:()=>{},setShowDevices:()=>{},setShowDiagnostics:()=>{},setDiagnosticReport:value=>reports.push(value),setMessage:value=>messages.push(value),loadStaffDiagnostics:()=>loaded,
  user:{uid:'fixture'},companyId:'fixture',staffId:'fixture',businessDataStatus:'ready',businessDataSource:'live',businessRefreshing:false,homeDisplayMs:null,businessRefreshMs:null,homeLoadedFromCache:false,deviceSessionId:'fixture',functions:{},
  run:async(_key,action,options)=>{try{return await action();}catch(error){options.setMessage(error.message);throw error;}}};
 runInNewContext(code,ctx);
 const pending=ctx.openQuickDiagnostics();
 assert.equal(calls.length,0);assert.deepEqual(reports,[null]);
 if(mode==='auth')ctx.authLoadVersionRef.current++;
 if(mode==='closed'||mode==='superseded')ctx.diagnosticsVersionRef.current++;
 if(mode==='load-failure')reject(Error('合成の読込み失敗'));
 else resolve({runStaffDiagnostics:async input=>{calls.push(input);return report;}});
 await pending;
 if(mode==='success'){
  assert.equal(calls.length,1);assert.equal(reports.at(-1),report);assert.match(messages.at(-1),/すべて正常/);
  assert.match(formatDiagnosticReport(report),/\[OK\] 合成診断: 合成境界/);
 }else if(mode==='load-failure'){
  assert.equal(calls.length,0);assert.equal(reports.at(-1).summary,'fail');assert.match(reports.at(-1).checks[0].detail,/もう一度診断/);
 }else{assert.equal(calls.length,0);assert.deepEqual(reports,[null]);assert.deepEqual(messages,[]);}
 count++;
}
console.log('Lazy diagnostics: '+count+' success/auth/close/newer/load-failure boundaries passed; no real SDK calls.');
