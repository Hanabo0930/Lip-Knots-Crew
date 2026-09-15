import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const ts=createRequire(resolve(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json'))('typescript');
const app=readFileSync('apps/staff/src/App.tsx','utf8');
const start=app.indexOf('      const bootstrap=httpsCallable(functions,"bootstrapSession");'),marker='      const result=await bootstrapPromise;',end=app.indexOf(marker,start)+marker.length;
assert.ok(start>=0&&end>start);
const code=ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
for(const mode of ['success','failure','stale-failure']){
 const fixture=
  'const assert=require("node:assert/strict");let tokenDone=false,handled=false;const functions={},current={uid:"synthetic"};let restoredCachedData=false,restoredScope=null;'+
  'const httpsCallable=()=>()=>'+(mode==='success'?'Promise.resolve({data:{ok:true}})':'Promise.reject(Error("bootstrap failed"))')+';'+
  'const loadLastBusinessScope=()=>null,restoreCachedBusinessData=()=>false,clearBusinessSnapshot=()=>{};'+
  'const getIdTokenResult=()=>new Promise(resolve=>setImmediate(()=>{tokenDone=true;resolve({claims:{}});}));'+
  'const staffScopeId=value=>typeof value==="string"?value:"";const isCurrentAuthLoad=()=>'+(mode==='stale-failure'?'false':'true')+';'+
  'async function initialize(){'+code+'return result;}'+
  'initialize().then(result=>{assert.equal(tokenDone,true);'+(mode==='success'?'assert.equal(result.data.ok,true);':mode==='stale-failure'?'assert.equal(result,undefined);':'assert.fail("Expected bootstrap failure");')+'handled=true;},error=>{'+(mode==='failure'?'assert.match(error.message,/bootstrap failed/);handled=true;':'throw error;')+'});'+
  'setTimeout(()=>{assert.equal(handled,true);},20);';
 execFileSync(process.execPath,['--unhandled-rejections=strict','-e',fixture],{stdio:'pipe'});
}
console.log('Startup bootstrap: early rejection observed during delayed token read; current error propagates, stale early exit stays safe, success preserved (strict unhandled-rejection mode).');

{
 const {runInNewContext}=await import('node:vm');const start=app.indexOf('function bootstrapRefreshToken('),end=app.indexOf('function readSavedEmail()',start);assert.ok(start>=0&&end>start);const ctx={};runInNewContext(ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 for(const value of [null,undefined,[],{},'false',false,{refreshToken:'false'},{refreshToken:1}])assert.throws(()=>ctx.bootstrapRefreshToken(value),/初期化の応答/);
 for(const refreshToken of [false,true])assert.equal(ctx.bootstrapRefreshToken({refreshToken}),refreshToken);
 for(const value of [null,undefined,0,true,{},[],['staff'],'','   ','a/b'])assert.equal(ctx.staffScopeId(value),'');
 for(const value of ['staff-1','company_1','日本語ID'])assert.equal(ctx.staffScopeId(value),value);
 console.log('Startup contracts: invalid refresh flags and non-string/empty/path-like scope IDs rejected; boolean flags and valid IDs preserved.');
}

{
 const start=app.indexOf('      const loaded=await loadPrimaryBusinessData(sid,cid,current.uid);'),end=app.indexOf('\n    }catch{',start);assert.ok(start>=0&&end>start);const tail=ts.transpileModule(app.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const mode of ['loaded','superseded','auth-changed']){
  const changes=[],followups=[];const ctx={sid:'s',cid:'c',current:{uid:'u'},loadPrimaryBusinessData:async()=>mode!=='superseded',isCurrentAuthLoad:()=>mode!=='auth-changed',setBusinessDataStatus:v=>changes.push(['status',v]),setBusinessDataSource:v=>changes.push(['source',v]),performance:{now:()=>100},loadStarted:10,restoredCachedData:false,setHomeDisplayMs:v=>changes.push(['display',v]),setBusinessRefreshMs:v=>changes.push(['refresh',v]),lastBusinessDataRefreshAt:0,authLoadVersion:1,registerCurrentDevice:async()=>followups.push('device'),refreshOpenJobs:()=>followups.push('jobs'),refreshPushStatus:()=>followups.push('push'),setMessage:()=>assert.fail('Unexpected failure')};
  await Function(...Object.keys(ctx),'return (async()=>{'+tail+'})();')(...Object.values(ctx));
  if(mode==='loaded'){assert.deepEqual(changes,[['status','ready'],['source','live'],['display',90],['refresh',90]]);assert.deepEqual(followups,['device','jobs','push']);}else{assert.deepEqual(changes,[]);assert.deepEqual(followups,[]);}
 }
 console.log('Startup completion: superseded read never relabels newer/cached state as live or launches follow-up work; accepted and stale-auth outcomes preserved.');
}
