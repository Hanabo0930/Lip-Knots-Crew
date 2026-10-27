'use strict';
// Actual exported trigger/scheduler hooks with recording boundaries. No SDK I/O.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
let dbCalls=0,workerLoads=0,narrowCalls=0,pauseCalls=0;const assignments=[];
const named={
 'node:crypto':require('node:crypto'),'firebase-admin/firestore':{},'firebase-functions/v2/firestore':{onDocumentWritten:(...args)=>args.at(-1)},'firebase-functions/v2/scheduler':{onSchedule:(...args)=>args.at(-1)},googleapis:{google:{}},
 './sheet-write-control':{sheetWriteExecutionPaused:()=>{pauseCalls++;return true;}},'./firebase':{db:{collection:()=>{dbCalls++;throw Error('paused legacy DB path reached');}}},
 './sheet-write-core':{},'./submission-integrity':{},'./case-mail-preparation-core':{},'./assignment-preparation-core':{},'./shift-parser':{},'./admin-edit-state-core':{},'./analytics-core':{},'./admin-operations-core':{},'./system-safety':{},'./production-metrics':{},
};
const file=path.resolve(__dirname,'../../functions/src/safe-sheet-writes.ts');
let code=stripTypeScriptTypes(fs.readFileSync(file,'utf8'),{mode:'transform'}).replace(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)";/g,(_,items,module)=>`const {${items.replace(/\bas\b/g,':')}}=require(${JSON.stringify(module)});`).replace(/^export /gm,'');
const box={module:{exports:{}},require:name=>{if(name==='./case-list-monthly-worker'){workerLoads++;return {processCaseListMonthlyAssignment:async ref=>{assignments.push(ref);return true;},retryCaseListMonthlyAssignments:async()=>{narrowCalls++;}};}if(!(name in named))throw Error('Unapproved module '+name);return named[name];}};
vm.runInNewContext(code+'\nmodule.exports={processSafeSheetWrite,retrySafeSheetWrites};',box,{filename:file});
const api=box.module.exports,results=[];async function test(name,fn){dbCalls=workerLoads=narrowCalls=pauseCalls=0;assignments.length=0;await fn();results.push({name,passed:true});}
const event=operation=>({data:{after:{exists:true,data:()=>({companyId:'synthetic-company',operation,status:'pending'}),ref:{path:'sheetSyncQueue/queue-1'}}}});
(async()=>{
 await test('legacy assignment remains paused before claim, metrics or new worker',async()=>{await api.processSafeSheetWrite(event('job.assign'));assert.equal(pauseCalls,1);assert.equal(dbCalls,0);assert.equal(workerLoads,0);});
 await test('only CaseList operation routes to its separately guarded worker without legacy fallthrough',async()=>{await api.processSafeSheetWrite(event('case_list.assign'));assert.equal(assignments.length,1);assert.equal(assignments[0].path,'sheetSyncQueue/queue-1');assert.equal(pauseCalls,0);assert.equal(dbCalls,0);});
 await test('deleted event leaves paused queues and CaseList untouched',async()=>{await api.processSafeSheetWrite({data:{after:{exists:false}}});assert.equal(dbCalls,0);assert.equal(workerLoads,0);});
 await test('scheduler invokes narrow opt-in recovery while preserving old global pause and backlog',async()=>{await api.retrySafeSheetWrites();assert.equal(narrowCalls,1);assert.equal(pauseCalls,1);assert.equal(dbCalls,0);});
 console.log(JSON.stringify({status:'PASS',tests:results.length,scope:'ACTUAL_TRIGGER_AND_SCHEDULER_HOOKS_WITH_MOCKED_WORKER',nativeWrites:0,results},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
