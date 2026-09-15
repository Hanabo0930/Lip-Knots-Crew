import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import {createRequire} from 'node:module';import {resolve} from 'node:path';
const dep=createRequire(resolve(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json')),ts=dep('typescript');const compile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const hook={exports:{},require:dep};runInNewContext(compile(readFileSync('apps/staff/src/useShiftNotificationRoute.ts','utf8')),hook);const scope={exports:{},require:()=>hook.exports};runInNewContext(compile(readFileSync('apps/staff/src/resubmission-notification.ts','utf8')),scope);const {resubmissionNotificationId:parse,readResubmissionNotification:read}=scope.exports;
for(const [path,id] of [['/resubmissions/req','req'],['/resubmissions/req/','req'],['/resubmissions/%E4%BE%9D%E9%A0%BC','依頼'],['/resubmissions/a%2Fb',null],['/resubmissions/%',null],['/resubmissions/..',null],['/resubmissions/a/netprint',null],['/shifts/a',null]])assert.equal(parse(path),id);
for(const mode of ['report','sales_floor','submitted','closed','missing-job','mismatch','malformed','invalid-type','invalid-job','stale-request','stale-job','request-failure','job-failure']){
 let current=true,jobs=0;const data={request:{id:'req',jobId:'job',type:mode==='sales_floor'?'sales_floor':'report',status:'open'}};
 if(['submitted','closed'].includes(mode))data.request.status=mode;if(mode==='mismatch')data.request.id='other';if(mode==='malformed')delete data.request;if(mode==='invalid-type')data.request.type='unknown';if(mode==='invalid-job')data.request.jobId='foreign/job';
 const task=read('req',async()=>{if(mode==='request-failure')throw Error('offline');if(mode==='stale-request')current=false;return data;},async id=>{jobs++;assert.equal(id,'job');if(mode==='job-failure')throw Error('offline');if(mode==='stale-job')current=false;return mode==='missing-job'?null:{id};},()=>current);
 if(['mismatch','malformed','invalid-type','invalid-job','request-failure','job-failure'].includes(mode)){await assert.rejects(task);continue;}
 const result=await task;if(['report','sales_floor'].includes(mode)){assert.equal(result.job.id,'job');assert.equal(result.type,mode);assert.equal(result.requestId,'req');}else assert.equal(result,null);if(['submitted','closed','stale-request'].includes(mode))assert.equal(jobs,0);
}
console.log('Resubmission notification passed: 8 paths and 13 type/status/identity/auth/error cases; closed requests never load jobs.');

const invalidIds=['','   ','.','..','one/two','one'+String.fromCharCode(92)+'two','one'+String.fromCharCode(0),'one'+String.fromCharCode(31),'one'+String.fromCharCode(127)];
for(const id of invalidIds){
 assert.equal(parse('/resubmissions/'+encodeURIComponent(id)),null);assert.equal(hook.exports.shiftNotificationJobId('/shifts/'+encodeURIComponent(id)+'/netprint'),null);
 let requests=0,jobs=0;await assert.rejects(read(id,async()=>{requests++;return{};},async()=>{jobs++;return{};},()=>true));assert.equal(requests,0);assert.equal(jobs,0);
 await assert.rejects(read('req',async()=>({request:{id:'req',jobId:id,type:'report',status:'open'}}),async()=>{jobs++;return{};},()=>true));assert.equal(jobs,0);
}
for(const id of ['案件','store job','a%2Fb','a-b_1']){assert.equal(parse('/resubmissions/'+encodeURIComponent(id)),id);assert.equal(hook.exports.shiftNotificationJobId('/shifts/'+encodeURIComponent(id)),id);}
{
 let requests=0;assert.equal(await read('req',async()=>{requests++;return{};},async()=>({}),()=>false),null);assert.equal(requests,0);
}
console.log('Notification identifier integrity: 9 malformed IDs rejected in both URL parsers and before request/job reads, 4 valid IDs preserved, stale owner performs no request.');
