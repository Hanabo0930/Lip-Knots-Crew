import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const app=fs.readFileSync('apps/staff/src/App.tsx','utf8');
const section=(a,b)=>{const start=app.indexOf(a),end=app.indexOf(b,start+a.length);assert.ok(start>=0&&end>start,a);return app.slice(start,end);};
const compile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS}}).outputText;
const helper=compile(section('function caseMailPreparationHeld(','function bootstrapRefreshToken('));
const upload=compile(section('  async function uploadSubmission()','  async function retryDraftCleanup()'));
const client=compile(section('  async function setClientSubmitted(','  async function openTask('));
let checked=0;
for(const flag of ['sourceMissing','applicationUnconfirmed','assignmentUnresolved','mailIntakeReviewRequired','pendingSourceWrite','adminEditSheetWrite']){
 const job={id:'job',status:'assigned',mailIntake:{receiptId:'mail'},[flag]:flag==='adminEditSheetWrite'?{pending:true}:true},files=[{name:'held.pdf',size:10}],messages=[];
 const scope={files,submissionConfirmed:true,isSubmissionActionPending:()=>false,MAX_SUBMISSION_FILE_SIZE:50*1024*1024,selectedJob:job,myJobs:[job],showSubmissionMessage:m=>messages.push(m),setMessage:m=>messages.push(m),loadUploadStorage:()=>assert.fail('waiting assignment cannot start storage'),httpsCallable:()=>assert.fail('waiting assignment cannot send')};
 vm.runInNewContext(helper+upload+client,scope);
 await scope.uploadSubmission();assert.equal(scope.files,files);assert.equal(scope.submissionConfirmed,true);assert.match(messages.at(-1),/選択ファイルは保持/);checked++;
 await scope.setClientSubmitted(true);assert.equal(scope.selectedJob,job);assert.equal(job.submissionStatus,undefined);assert.match(messages.at(-1),/シフトを更新/);checked++;
 assert.match(scope.submissionReadinessMessage(job),/写真・PDFは保持/);job[flag]=false;assert.equal(scope.submissionReadinessMessage(job),null);
}
const start=app.indexOf('<p id="submission-send-help"'),end=app.indexOf('</button>',start)+9;assert.ok(start>=0&&end>start);const sendJsx=app.slice(start,end);
const toggleStart=app.indexOf('<button className="secondary" onClick={()=>{if(!submissionEditPending&&!submissionReadiness)void setClientSubmitted('),toggleEnd=app.indexOf('</button>',toggleStart)+9;assert.ok(toggleStart>=0&&toggleEnd>toggleStart);
for(const flag of [null,'sourceMissing','applicationUnconfirmed','assignmentUnresolved','mailIntakeReviewRequired','pendingSourceWrite','adminEditSheetWrite']){
 const job={id:'job',status:'assigned',mailIntake:{receiptId:'mail'},...(flag?{[flag]:flag==='adminEditSheetWrite'?{pending:true}:true}:{})},scope={React,selectedAssignedJob:job,files:[{}],submissionConfirmed:true,submissionType:'report',resubmissionSendBlocked:false,submissionEditPending:false,processingSubmission:false,isPending:()=>false,requestId:'',uploadSubmission:()=>{},shiftActionPending:false,pendingShiftAction:'',setClientSubmitted:()=>{scope.toggled=true;}};
 vm.runInNewContext(helper,scope);scope.submissionReadiness=scope.submissionReadinessMessage(job);
 vm.runInNewContext(compile('const node=<>'+sendJsx+'</>;globalThis.node=node;const toggle='+app.slice(toggleStart,toggleEnd)+';globalThis.toggle=toggle;'),scope);
 const html=renderToStaticMarkup(scope.node);assert.equal(/<button[^>]*disabled=""/.test(html),Boolean(flag));assert.equal(scope.toggle.props['aria-disabled'],Boolean(flag));scope.toggle.props.onClick();assert.equal(scope.toggled===true,!flag);
 if(flag)assert.match(html,/確認後に送信できます/);else assert.match(html,/送信する準備ができました/);checked++;
}
console.log(JSON.stringify({staffSubmissionReadinessTests:checked,scope:'Actual client functions and JSX, synthetic state; no Firebase, Storage or external requests'}));
