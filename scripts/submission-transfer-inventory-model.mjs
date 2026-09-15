import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
const dependency=createRequire(process.env.LKC_TEST_DEPENDENCY_ROOT?process.env.LKC_TEST_DEPENDENCY_ROOT+'/package.json':import.meta.url);
const ts=dependency('typescript');
export const {Timestamp}=dependency('firebase-admin/firestore');
const {HttpsError}=dependency('firebase-functions/v2/https');
export const inventorySourceHashes={};
function load(name){
 const source=fs.readFileSync(new URL('../functions/src/'+name+'.ts',import.meta.url),'utf8');
 inventorySourceHashes[name+'.ts']=createHash('sha256').update(source).digest('hex');
 const module={exports:{}};
 const allowed={'node:crypto':{createHash},'node:buffer':{Buffer},'firebase-admin/firestore':{Timestamp},'firebase-functions/v2/https':{HttpsError},zod:dependency('zod'),'./firebase':{db:Object.freeze({})},'./google-drive-client':{getWritableDriveClient(){throw Error('NETWORK_FORBIDDEN');}}};
 runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,require:key=>{if(!Object.hasOwn(allowed,key))throw Error('MODULE_DENIED');return allowed[key];}},{timeout:3000});
 return module.exports;
}
const {assertSubmissionFile,assertSubmissionCounters}=load('submission-integrity');
const {assertTransferCheckpoint}=load('drive-transfer');
const uploadSource=fs.readFileSync(new URL('../functions/src/uploads.ts',import.meta.url));
inventorySourceHashes['uploads.ts']=createHash('sha256').update(uploadSource).digest('hex');
export const FILE_FIELDS=['companyId','uid','jobId','staffId','type','submissionId','resubmissionRequestId','status','driveFileId','driveName','sequence','driveTransferPlan','transferCompletedAt','completionCounted'];
export const PARENT_FIELDS=['companyId','uid','jobId','staffId','type','resubmissionRequestId','status','totalFiles','completedFiles','jobStatusApplied'];
const nonempty=value=>typeof value==='string'&&Boolean(value.trim());
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function decodeInventoryFields(fields={}){
 if(!record(fields))throw Error('FIELDS_INVALID');
 function decode(value){
  if(!record(value)||Object.keys(value).length!==1)throw Error('VALUE_INVALID');
  if(Object.hasOwn(value,'stringValue')&&typeof value.stringValue==='string')return value.stringValue;
  if(Object.hasOwn(value,'booleanValue')&&typeof value.booleanValue==='boolean')return value.booleanValue;
  if(Object.hasOwn(value,'nullValue')&&value.nullValue===null)return null;
  if(Object.hasOwn(value,'integerValue')&&/^-?\d+$/.test(value.integerValue)&&Number.isSafeInteger(Number(value.integerValue)))return Number(value.integerValue);
  if(Object.hasOwn(value,'doubleValue')&&typeof value.doubleValue==='number'&&Number.isFinite(value.doubleValue))return value.doubleValue;
  if(Object.hasOwn(value,'timestampValue')&&typeof value.timestampValue==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value.timestampValue)&&Number.isFinite(Date.parse(value.timestampValue)))return Timestamp.fromMillis(Date.parse(value.timestampValue));
  if(Object.hasOwn(value,'mapValue')&&record(value.mapValue)&&Object.keys(value.mapValue).every(key=>key==='fields'))return decodeInventoryFields(value.mapValue.fields??{});
  // 未対応の値型を欠落値へ変換すると危険なため、収集全体を失敗にする。
  throw Error('VALUE_INVALID');
 }
 return Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,decode(value)]));
}
/** 記録の分類のみ。Storage世代・Drive実体・所有者・通知の確認や再実行許可ではない。 */
export function classifyTransferRecord(parent,file,submissionId){
 const issues=[];
 try{assertSubmissionFile(parent,file,submissionId);}catch{issues.push('submission-integrity');}
 const hasRecord=file.driveFileId!=null||file.transferCompletedAt!=null||file.completionCounted===true||file.status==='completed';
 let stage='no-transfer-record';
 if(file.driveTransferPlan!==undefined){
  stage='plan-recorded';
  const plan=file.driveTransferPlan;
  try{assertTransferCheckpoint({driveTransferPlan:plan,driveFileId:plan?.id,driveName:plan?.name,sequence:plan?.sequence});}catch{issues.push('invalid-plan');}
 }
 if(hasRecord&&!nonempty(file.driveFileId)){stage='missing-destination';issues.push('missing-destination');}
 else if(file.driveFileId&&!(file.transferCompletedAt instanceof Timestamp)&&file.completionCounted!==true){stage='legacy-accounting-unknown';issues.push('legacy-accounting-unknown');}
 else if(hasRecord)stage=file.completionCounted===true?'counted-recorded':'checkpoint-recorded';
 if(hasRecord){try{assertTransferCheckpoint(file);}catch{issues.push('invalid-checkpoint');}}
 if(file.completionCounted!==undefined&&typeof file.completionCounted!=='boolean')issues.push('invalid-counted-marker');
 if(file.transferCompletedAt!==undefined&&!(file.transferCompletedAt instanceof Timestamp))issues.push('invalid-transfer-time');
 return {stage,issues:[...new Set(issues)],replayAuthorized:false};
}
export function classifySubmissionRecords(parent,files){
 const issues=[];
 try{assertSubmissionCounters(parent??{});}catch{issues.push('invalid-parent-counters');}
 if(!parent)issues.push('missing-parent');
 if(files.length!==parent?.totalFiles)issues.push('file-count-mismatch');
 if(files.filter(file=>file.completionCounted===true).length!==parent?.completedFiles)issues.push('counted-marker-mismatch');
 if(parent?.status==='completed'&&parent?.jobStatusApplied!==true)issues.push('job-status-not-applied');
 return issues;
}
