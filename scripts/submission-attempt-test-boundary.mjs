import {staffStoreLoader} from './submission-store-test-loader.mjs';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
// Exercise the real on-demand retry orchestration with bounded synthetic store ports.
const retryScope={exports:{},require:staffStoreLoader()};
const request=staffStoreLoader()('cooperative-submission-store').submissionRequest;
runInNewContext(ts.transpileModule(fs.readFileSync('apps/staff/src/submitted-binding-store.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,retryScope);
export const loadSubmittedBindingsBoundary=async()=>({retrySubmittedCleanup:retryScope.exports.retrySubmittedCleanup});
// 画面の既存試験では端末保存だけを境界化する。保存/ハッシュ本体は別試験で実行する。
export const syntheticSubmissionRequestId='11111111-1111-4111-8111-111111111111';
export const submissionAttemptBoundary={loadDraftStore:async()=>({withSubmissionContext:async(_key,current,fn)=>{if(current())return fn({});}}),saveDraft:async()=>{},previewContextRef:{current:'synthetic-draft'},loadSubmittedBindings:loadSubmittedBindingsBoundary,draftKey:'synthetic-draft',draftCleanup:null,hasSubmittedBindings:async()=>false,getSubmittedDraftReceipt:()=>null,saveSubmittedBinding:async()=>true,finishSubmittedBindings:async()=>true,hasStoredDraft:async()=>false,confirmDraftCleanupComplete:async()=>true,loadSubmissionAttempt:async()=>({submissionRequest:request,resetUnacceptedSubmission:async()=>false,prepareSubmissionAttempt:async(_key,files)=>({clientRequestId:syntheticSubmissionRequestId,storageKey:'synthetic-attempt',contentHashes:files.map(()=> 'a'.repeat(64))}),clearSubmissionAttempt:()=>true})};
