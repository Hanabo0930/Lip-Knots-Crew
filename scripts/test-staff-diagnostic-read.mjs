import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {runInNewContext} from 'node:vm';
const code=ts.transpileModule(fs.readFileSync('apps/staff/src/diagnostics.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const settle=()=>new Promise(resolve=>setImmediate(resolve));
for(const mode of ['ready','unsupported','getter-error','ready-error','rejected','timeout','push-error']){
 const timers=new Map();let id=0;
 const navigator={onLine:true};
 if(mode==='getter-error')Object.defineProperty(navigator,'serviceWorker',{get(){throw Error('blocked');}});
 else if(mode==='ready-error')navigator.serviceWorker=Object.defineProperty({},'ready',{get(){throw Error('blocked');}});
 else if(mode!=='unsupported')navigator.serviceWorker={ready:mode==='rejected'?Promise.reject(Error('worker')):mode==='timeout'?new Promise(()=>{}):Promise.resolve({})};
 const ctx={exports:{},navigator,window:{setTimeout(fn){timers.set(++id,fn);return id;},clearTimeout(id){timers.delete(id);}},require:()=>({currentPushPermission:()=> 'granted',loadServerPushStatusWithRetry:async()=>{if(mode==='push-error')throw Error('offline');return true;}})};
 runInNewContext(code,ctx);
 const pending=ctx.exports.runStaffDiagnostics({signedIn:true,companyScoped:true,businessDataStatus:'ready',businessDataSource:'live',businessRefreshing:false,homeDisplayMs:100,businessRefreshMs:200,homeLoadedFromCache:false,deviceSessionRegistered:true,functions:{}});
 await settle();if(mode==='timeout'){assert.equal(timers.size,1);[...timers.values()][0]();}
 const report=await pending;
 assert.equal(timers.size,0,'all completed timers cleared: '+mode);
 assert.equal(report.checks.length,10);
 assert.equal(report.checks.find(c=>c.id==='auth').level,'pass');
 assert.equal(report.checks.find(c=>c.id==='pwa').level,['ready','push-error'].includes(mode)?'pass':'warn');
 assert.equal(report.serverPushEnabled,mode==='push-error'?null:true);
 assert.equal(report.summary,mode==='push-error'?'fail':mode==='ready'?'pass':'warn');
 const text=ctx.exports.formatDiagnosticReport(report);
 for(const check of report.checks)assert.ok(text.includes(check.label+': '+check.detail));
}
console.log('Diagnostic reads passed: 7 worker readiness/error/timeout and push failure cases; complete report and timer cleanup, synthetic APIs only.');

for(const [status,source,refreshing,level,detail] of [
 ['ready','live',false,'pass','最新情報を取得済み'],
 ['ready','live',true,'warn','更新中'],
 ['ready','cached',false,'warn','前回データ'],
 ['ready','cached',true,'warn','更新中'],
 ['ready','stale',false,'warn','更新結果を確認できません'],
 ['ready','none',false,'warn','取得元'],
 ['loading','none',true,'warn','読み込み中'],
 ['idle','none',false,'warn','まだ取得'],
 ['error','none',false,'fail','取得エラー'],
]){
 const ctx={exports:{},navigator:{onLine:true,serviceWorker:{ready:Promise.resolve({})}},window:{setTimeout,clearTimeout},require:()=>({currentPushPermission:()=> 'granted',loadServerPushStatusWithRetry:async()=>true})};runInNewContext(code,ctx);
 const report=await ctx.exports.runStaffDiagnostics({signedIn:true,companyScoped:true,businessDataStatus:status,businessDataSource:source,businessRefreshing:refreshing,homeDisplayMs:null,businessRefreshMs:null,homeLoadedFromCache:false,deviceSessionRegistered:true,functions:{}});
 const check=report.checks.find(c=>c.id==='business');assert.equal(check.level,level);assert.ok(check.detail.includes(detail));assert.equal(report.summary,level);assert.ok(ctx.exports.formatDiagnosticReport(report).includes(check.detail));
}
console.log('Diagnostic business states passed: 9 live/cached/stale/loading/idle/error/refresh cases.');

{
 for(const defaultZone of ['UTC','America/Los_Angeles','Asia/Tokyo']){
  class ZonedDate extends Date{toLocaleString(locale,options){return super.toLocaleString(locale,{timeZone:defaultZone,...options});}}
  const ctx={exports:{},Date:ZonedDate,require:()=>({})};runInNewContext(code,ctx);const report={summary:'pass',checks:[{level:'pass',label:'合成確認',detail:'正常'}],checkedAt:'2026-09-10T15:01:00Z'};const text=ctx.exports.formatDiagnosticReport(report);assert.ok(text.includes('確認日時: 2026/9/11 0:01:00（日本時間）'));assert.ok(text.includes('[OK] 合成確認: 正常'));
  for(const checkedAt of [undefined,null,{},0,'','invalid']){const invalid=ctx.exports.formatDiagnosticReport({...report,checkedAt});assert.ok(invalid.includes('確認日時: 確認中'));assert.ok(!invalid.includes('Invalid Date'));assert.ok(!invalid.includes('1970'));}
 }
 console.log('Diagnostic timestamps: 3 simulated default timezones retain the same JST date; 18 missing/malformed timestamp cases show unknown without epoch or invalid-date text.');
}

for(const online of [true,false])for(const permission of ['granted','denied','unsupported','default']){
 let reads=0;const ctx={exports:{},navigator:{onLine:online,serviceWorker:{ready:Promise.resolve({})}},window:{setTimeout,clearTimeout},require:()=>({currentPushPermission:()=>permission,loadServerPushStatusWithRetry:async()=>{reads++;return false;}})};runInNewContext(code,ctx);const report=await ctx.exports.runStaffDiagnostics({signedIn:true,companyScoped:true,businessDataStatus:'ready',businessDataSource:'live',businessRefreshing:false,homeDisplayMs:null,businessRefreshMs:null,homeLoadedFromCache:false,deviceSessionRegistered:true,functions:{}});const network=report.checks.find(c=>c.id==='network'),notification=report.checks.find(c=>c.id==='permission'),push=report.checks.find(c=>c.id==='push');assert.equal(network.level,online?'pass':'fail');if(!online)assert.match(network.detail,/もう一度診断/);assert.equal(notification.label,'通知許可');assert.equal(reads,permission==='granted'?1:0);if(permission==='denied')assert.match(notification.detail,/端末・ブラウザー.*開き直し/);if(permission==='unsupported')assert.match(notification.detail,/今日やること/);if(permission==='default')assert.match(notification.detail,/通知を有効にする/);if(permission==='granted'){assert.match(push.detail,/通知OFF/);assert.match(push.detail,/受信する場合/);assert.doesNotMatch(push.detail,/再登録が必要/);}const text=ctx.exports.formatDiagnosticReport(report);assert.ok(text.includes(notification.detail));assert.ok(text.includes(network.detail));
}
console.log('Diagnostic recovery guidance: 8 network/permission combinations keep shared text actionable and distinguish notification OFF from required re-registration.');

for(const stage of ['worker','push'])for(const initialOnline of [false,true]){
 let release;const gate=new Promise(resolve=>release=resolve);let pushStarted=false;const ctx={exports:{},navigator:{onLine:initialOnline,serviceWorker:{ready:stage==='worker'?gate:Promise.resolve({})}},window:{setTimeout,clearTimeout},require:()=>({currentPushPermission:()=> 'granted',loadServerPushStatusWithRetry:async()=>{pushStarted=true;return stage==='push'?gate:true;}})};runInNewContext(code,ctx);
 const pending=ctx.exports.runStaffDiagnostics({signedIn:true,companyScoped:true,businessDataStatus:'ready',businessDataSource:'live',businessRefreshing:false,homeDisplayMs:100,businessRefreshMs:100,homeLoadedFromCache:false,deviceSessionRegistered:true,functions:{}});
 if(stage==='push'){await new Promise(resolve=>setImmediate(resolve));assert.equal(pushStarted,true);}
 ctx.navigator.onLine=!initialOnline;release(true);const report=await pending,network=report.checks.find(c=>c.id==='network');assert.equal(network.level,initialOnline?'fail':'warn');assert.equal(report.summary,network.level);assert.match(network.detail,initialOnline?/診断中にオフライン/:/診断中に接続が復旧/);assert.match(network.detail,/もう一度診断/);assert.ok(ctx.exports.formatDiagnosticReport(report).includes(network.detail));
}
console.log('Diagnostic network snapshot: worker/push waits × disconnection/recovery reflect changed connectivity, require a new diagnosis and preserve the guidance in exported text.');

for(const nextPermission of ['denied','default','unsupported'])for(const failure of [false,true]){
 let permission='granted',finish;const gate=new Promise((resolve,reject)=>finish={resolve,reject});const ctx={exports:{},navigator:{onLine:true,serviceWorker:{ready:Promise.resolve({})}},window:{setTimeout,clearTimeout},require:()=>({currentPushPermission:()=>permission,loadServerPushStatusWithRetry:()=>gate})};runInNewContext(code,ctx);
 const pending=ctx.exports.runStaffDiagnostics({signedIn:true,companyScoped:true,businessDataStatus:'ready',businessDataSource:'live',businessRefreshing:false,homeDisplayMs:null,businessRefreshMs:null,homeLoadedFromCache:false,deviceSessionRegistered:true,functions:{}});await settle();permission=nextPermission;if(failure)finish.reject(Error('old setting request failed'));else finish.resolve(true);
 const report=await pending,permissionCheck=report.checks.find(c=>c.id==='permission'),push=report.checks.find(c=>c.id==='push');assert.equal(report.serverPushEnabled,null);assert.equal(permissionCheck.level,nextPermission==='default'?'warn':'fail');assert.equal(push.level,'warn');assert.equal(report.summary,permissionCheck.level);const text=ctx.exports.formatDiagnosticReport(report);assert.match(text,/診断中に通知許可が変更/);assert.match(text,/もう一度診断/);assert.doesNotMatch(text,/この端末は通知ON|許可済み/);
}
console.log('Diagnostic permission snapshot: 3 permission changes × old request success/failure discard stale permission/ON conclusions and request a fresh diagnosis.');
