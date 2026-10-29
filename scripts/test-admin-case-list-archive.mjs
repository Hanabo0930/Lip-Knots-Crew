import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
function moduleFrom(path,dependencies={}){
 const scope={React,exports:{},require:name=>{assert.ok(Object.hasOwn(dependencies,name),'Unexpected dependency '+name);return dependencies[name];}};
 runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,scope);
 return scope.exports;
}
const search=moduleFrom('apps/admin/src/job-search.ts');
const {isTransferredCaseListJob,buildJobSearchIndex,filterJobSearchIndex,jobReadinessLabel}=search;
const job={id:'job-a',companyId:'company-a',caseId:'LK_SYNTHETIC_CASE_A',dateKey:'2026-11-02',workDate:'11/2',assignedStaffId:'staff-a',assignedStaffName:'合成担当',storeName:'合成店舗',makerName:'合成メーカー',clientName:'合成クライアント',status:'assigned',applicationUnconfirmed:false,publishable:false,recruitmentStopped:true,
 caseListSource:{version:1,sheetId:2026101601,caseId:'LK_SYNTHETIC_CASE_A',sourceRevision:'a'.repeat(64),bindingHash:'b'.repeat(64)},
 sheetRef:{sheetId:1773116117,sheetName:'2026.11',caseId:'LK_SYNTHETIC_CASE_A',bindingHash:'c'.repeat(64)},
 assignmentSheetWrite:{operation:'case_list.assign',queueId:'queue-a',assignedJobRevision:2,pending:false,nativeAck:{schema:'LK_CASE_LIST_MONTHLY_ACK_V1',status:'MONTHLY_READBACK_VERIFIED',preserveSource:true,operationId:'queue-a',queueId:'queue-a',jobId:'job-a',companyId:'company-a',sourceCaseId:'LK_SYNTHETIC_CASE_A',staffId:'staff-a',dateKey:'2026-11-02',assignedJobRevision:2,bindingHash:'b'.repeat(64),postCatalog:{caseId:'LK_SYNTHETIC_CASE_A',sourceRevision:'a'.repeat(64),bindingHash:'b'.repeat(64)},target:{sheetId:1773116117,title:'2026.11',fixedId:'LK_SYNTHETIC_CASE_A',bindingHash:'c'.repeat(64)}}}};
const normalFilters=['all','unassigned','assigned','precontact','report-completed','report-unconfirmed'];
const results=(jobs,filter,query='')=>Array.from(filterJobSearchIndex(buildJobSearchIndex(jobs),query,filter),job=>job.id);
assert.equal(isTransferredCaseListJob(job),true);
assert.equal(jobReadinessLabel(job),'月別へ転記済み');
for(const filter of normalFilters)assert.deepEqual(results([job],filter),[],filter+' excludes verified transfer');
assert.deepEqual(results([job],'monthly-transferred'),['job-a']);
assert.deepEqual(results([job],'monthly-transferred','店舗 メーカー'),['job-a']);
assert.deepEqual(results([job],'monthly-transferred','該当しない'),[]);
const mutations=[
 ['applicationUnconfirmed',true],['applicationUnconfirmed',undefined],['sourceMissing',true],['assignmentUnresolved',true],['status','open'],['publishable',true],['recruitmentStopped',false],
 ['id','copied-job'],['companyId','other-company'],['caseId','copied-case'],['assignedStaffId','other-staff'],['dateKey','2026-11-03'],
 ['caseListSource',undefined],['caseListSource.version',2],['caseListSource.sheetId',123],['caseListSource.caseId','other-case'],['caseListSource.sourceRevision','d'.repeat(64)],['caseListSource.bindingHash','d'.repeat(64)],
 ['assignmentSheetWrite',undefined],['assignmentSheetWrite.operation','other-operation'],['assignmentSheetWrite.pending',true],['assignmentSheetWrite.queueId','other-queue'],['assignmentSheetWrite.assignedJobRevision',3],
 ['assignmentSheetWrite.nativeAck',undefined],['assignmentSheetWrite.nativeAck.schema','other-schema'],['assignmentSheetWrite.nativeAck.status','WRITE_STARTED'],['assignmentSheetWrite.nativeAck.preserveSource',false],['assignmentSheetWrite.nativeAck.operationId','other-operation'],['assignmentSheetWrite.nativeAck.queueId','other-queue'],['assignmentSheetWrite.nativeAck.jobId','other-job'],['assignmentSheetWrite.nativeAck.companyId','other-company'],['assignmentSheetWrite.nativeAck.sourceCaseId','other-case'],['assignmentSheetWrite.nativeAck.staffId','other-staff'],['assignmentSheetWrite.nativeAck.dateKey','2026-11-03'],['assignmentSheetWrite.nativeAck.assignedJobRevision',3],['assignmentSheetWrite.nativeAck.bindingHash','d'.repeat(64)],
 ['assignmentSheetWrite.nativeAck.postCatalog',undefined],['assignmentSheetWrite.nativeAck.postCatalog.caseId','other-case'],['assignmentSheetWrite.nativeAck.postCatalog.sourceRevision','d'.repeat(64)],['assignmentSheetWrite.nativeAck.postCatalog.bindingHash','d'.repeat(64)],
 ['assignmentSheetWrite.nativeAck.target',undefined],['assignmentSheetWrite.nativeAck.target.sheetId',-1],['assignmentSheetWrite.nativeAck.target.title','2026.12'],['assignmentSheetWrite.nativeAck.target.fixedId','other-case'],['assignmentSheetWrite.nativeAck.target.bindingHash','d'.repeat(64)],
 ['sheetRef',undefined],['sheetRef.caseId','other-case'],['sheetRef.sheetId',123],['sheetRef.sheetName','2026.12'],['sheetRef.bindingHash','d'.repeat(64)],
];
for(const [path,value]of mutations){
 const candidate=structuredClone(job),parts=path.split('.');let target=candidate;for(const key of parts.slice(0,-1))target=target[key];target[parts.at(-1)]=value;
 assert.equal(isTransferredCaseListJob(candidate),false,path+' cannot hide an incomplete/stale/copied receipt');
 assert.deepEqual(results([candidate],'all'),[candidate.id],path+' stays visible for review');
 assert.deepEqual(results([candidate],'monthly-transferred'),[],path+' is not verified history');
}
const legacy={...job,id:'legacy-monthly',caseListSource:undefined,assignmentSheetWrite:undefined};
assert.deepEqual(results([legacy],'all'),['legacy-monthly'],'ordinary monthly-imported jobs remain in normal management');
const pending={...job,id:'pending',applicationUnconfirmed:true};
assert.deepEqual(results([pending],'all'),['pending'],'owner selection or write dispatch alone does not hide new arrangements');
for(const cancelled of [{...job,cancelled:true},{...job,status:'cancelled'}]){
 for(const filter of [...normalFilters,'monthly-transferred'])assert.deepEqual(results([cancelled],filter),[],filter+' excludes cancellation');
 assert.deepEqual(results([cancelled],'cancelled'),['job-a'],'admin cancellation history remains explicit');
}
const Controls=moduleFrom('apps/admin/src/AdminJobSearchControls.tsx',{'./job-search':search}).default;
const html=renderToStaticMarkup(React.createElement(Controls,{queryText:'',jobListFilter:'all',total:3,count:1,page:0,onQuery:()=>{},onFilter:()=>{},onClear:()=>{}}));
assert.ok(html.includes('value="all" selected="">通常の案件'));
assert.ok(html.includes('value="monthly-transferred">月別へ転記済み（履歴）'));
assert.ok(html.includes('value="cancelled">取消履歴'));
assert.ok(html.includes('案件リストの原行は保持します'));
console.log(`Admin CaseList archive: PASS (${mutations.length} incomplete/mismatched receipt mutations, pending/verified/cancel transitions, ordinary-monthly retention and explicit history controls). UI only; no physical Source hide or private-history access guarantee.`);
