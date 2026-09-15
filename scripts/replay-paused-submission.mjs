import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createSubmissionAcceptanceKit, ACCEPTANCE_PROJECT} from './submission-acceptance-kit.mjs';
import {decodeInventoryFields, classifyTransferRecord, classifySubmissionRecords} from './submission-transfer-inventory-model.mjs';

const ROOT='projects/'+ACCEPTANCE_PROJECT;
const FUNCTION=ROOT+'/locations/asia-northeast1/functions/finalizeStagedUpload';
const DB=ROOT+'/databases/(default)/documents';
const fail=code=>{throw Error(code);};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tokenValid=value=>typeof value==='string'&&value.length>0&&!/[\r\n]/.test(value);
export const REPLAY_DRIVE_ROOT='1UIrK62YaXUDtK8H2rvJcZV5nkej30vk0';
const kit=createSubmissionAcceptanceKit({driveRootId:REPLAY_DRIVE_ROOT});
function selected(index){if(![1,2].includes(index))fail('FILE_SCOPE_DENIED');return kit.files[index-1];}
function revisionValid(value){return typeof value==='string'&&/^finalizestagedupload-[0-9]+-[a-z0-9]+$/.test(value)&&value!=='finalizestagedupload-00005-pep';}
function verifyFunction(fn,revision){
 if(!revisionValid(revision)||fn?.name!==FUNCTION||fn.state!=='ACTIVE'||fn.environment!=='GEN_2'||
 fn.serviceConfig?.revision!==revision||fn.serviceConfig?.allTrafficOnLatestRevision!==true||
 fn.serviceConfig?.serviceAccountEmail!=='740154137290-compute@developer.gserviceaccount.com'||
 fn.serviceConfig?.environmentVariables?.EXPECTED_FIREBASE_PROJECT_ID!==ACCEPTANCE_PROJECT||
 fn.serviceConfig?.environmentVariables?.APP_ENVIRONMENT!=='staging'||
 fn.serviceConfig?.environmentVariables?.LKC_SUBMISSION_TRANSFER_MODE!=='acceptance'||
 !/^https:\/\/finalizestagedupload-[a-z0-9-]+[.]a[.]run[.]app$/.test(fn.serviceConfig?.uri??'')||
 fn.eventTrigger?.eventType!=='google.cloud.storage.object.v1.finalized'||
 !fn.eventTrigger?.eventFilters?.some(filter=>filter.attribute==='bucket'&&filter.value===kit.storageBucket))fail('FUNCTION_REVISION_OR_CONTROL_MISMATCH');
 return fn.serviceConfig.uri;
}
// 一覧検索・コピー・データ修正はしない。受入用の既知の1ファイルだけを扱う。
export function createReplayTransport(accessToken,idToken,fetchImpl=fetch){
 if(!tokenValid(accessToken))fail('ACCESS_TOKEN_REQUIRED');
 async function request(url,{method='GET',body,invoke=false,headers={}}={}){
  if(invoke&&!tokenValid(idToken))fail('ID_TOKEN_REQUIRED');
  let response;
  try{response=await fetchImpl(url,{method,redirect:'error',signal:AbortSignal.timeout(invoke?600000:30000),
   headers:{Authorization:'Bearer '+(invoke?idToken:accessToken),'Content-Type':'application/json',...headers},
   ...(body?{body:JSON.stringify(body)}:{})});}
  catch{fail(invoke?'INVOKE_OUTCOME_UNKNOWN':'READ_NETWORK_FAILED');}
  if(!response.ok)fail(invoke?'INVOKE_OUTCOME_UNKNOWN':'READ_HTTP_'+response.status);
  if(invoke)return {accepted:true};
  try{return await response.json();}catch{fail('READ_RESPONSE_INVALID');}
 }
 return {
  readFunction:()=>request('https://cloudfunctions.googleapis.com/v2/'+FUNCTION),
  async readRecords(index){
   const file=selected(index),other=selected(index===1?2:1),refs=['submissions/'+kit.submissionId,'submissions/'+kit.submissionId+'/files/'+file.fileId,'companies/'+kit.companyId+'/settings/drive','submissions/'+kit.submissionId+'/files/'+other.fileId];
   const begin=await request('https://firestore.googleapis.com/v1/'+DB+':beginTransaction',{method:'POST',body:{options:{readOnly:{}}}});
   if(typeof begin.transaction!=='string'||!begin.transaction||begin.transaction.length>4096)fail('TRANSACTION_REQUIRED');
   try{
    const fields=[
     ['companyId','uid','jobId','staffId','type','resubmissionRequestId','status','totalFiles','completedFiles'],
     ['companyId','uid','jobId','staffId','type','submissionId','resubmissionRequestId','status','storagePath','size','contentType','pausedTransferSource','driveTransferPlan','driveFileId','driveName','sequence','transferCompletedAt','completionCounted'],
     ['rootFolderId']];
    fields.push(fields[1]);
    const documents=[];
    for(let i=0;i<refs.length;i++){
     const query=new URLSearchParams({transaction:begin.transaction});
     for(const field of fields[i])query.append('mask.fieldPaths',field);
     const doc=await request('https://firestore.googleapis.com/v1/'+DB+'/'+refs[i]+'?'+query);
     if(doc?.name!==DB+'/'+refs[i]||typeof doc.updateTime!=='string'||!Number.isFinite(Date.parse(doc.updateTime)))fail('DOCUMENT_RESPONSE_INVALID');
     documents.push({data:decodeInventoryFields(doc.fields),updateTime:doc.updateTime});
    }
    return {parent:documents[0],file:documents[1],drive:documents[2],otherFile:documents[3]};
   }finally{await request('https://firestore.googleapis.com/v1/'+DB+':rollback',{method:'POST',body:{transaction:begin.transaction}});}
  },
  readObject(index,generation){
   const file=selected(index);
   if(typeof generation!=='string'||!/^[1-9][0-9]*$/.test(generation))fail('GENERATION_REQUIRED');
   const query=new URLSearchParams({generation,fields:'bucket,name,generation,size,contentType,md5Hash'});
   return request('https://storage.googleapis.com/storage/v1/b/'+kit.storageBucket+'/o/'+encodeURIComponent(file.storagePath)+'?'+query);
  },
  invoke(plan){
   if(plan?.project!==ACCEPTANCE_PROJECT||!revisionValid(plan.revision)||
    !/^https:\/\/finalizestagedupload-[a-z0-9-]+[.]a[.]run[.]app$/.test(plan.uri??''))fail('INVOKE_SCOPE_DENIED');
   const file=selected(plan.fileIndex),event=plan.event;
   if(event?.bucket!==kit.storageBucket||event?.name!==file.storagePath||event?.contentType!==file.contentType||
    String(event?.size)!==String(file.size)||event?.md5Hash!==file.md5Base64||
    typeof event?.generation!=='string'||!/^[1-9][0-9]*$/.test(event.generation))fail('INVOKE_SOURCE_DENIED');
   return request(plan.uri,{method:'POST',invoke:true,body:event,headers:{
    'ce-specversion':'1.0','ce-id':'lkc-reviewed-replay-'+plan.fingerprint,
    'ce-type':'google.cloud.storage.object.v1.finalized','ce-source':'//storage.googleapis.com/projects/_/buckets/'+kit.storageBucket,
    'ce-subject':'objects/'+file.storagePath}});
  },
 };
}
export async function preparePausedReplay({transport,fileIndex,revision,now=()=>Date.now()}){
 const file=selected(fileIndex),fn=await transport.readFunction(),uri=verifyFunction(fn,revision);
 const records=await transport.readRecords(fileIndex),parent=records?.parent?.data,stored=records?.file?.data;
 if(!parent||!stored||records?.drive?.data?.rootFolderId!==REPLAY_DRIVE_ROOT)fail('RECORDS_OR_DRIVE_SCOPE_MISMATCH');
 for(const field of ['companyId','uid','jobId','staffId','type']){
  const expected=kit.seedDocuments.find(doc=>doc.path==='submissions/'+kit.submissionId).data[field];
  if(parent[field]!==expected||stored[field]!==expected)fail('RECORD_IDENTITY_MISMATCH');
 }
 if(parent.totalFiles!==2||!['paused_global','error','uploading'].includes(parent.status)||
 !['paused_global','error'].includes(stored.status)||stored.submissionId!==kit.submissionId||
 stored.storagePath!==file.storagePath||stored.size!==file.size||stored.contentType!==file.contentType||
 stored.completionCounted===true||parent.resubmissionRequestId!=null||stored.resubmissionRequestId!=null)fail('RECORD_NOT_REPLAYABLE');
 if(!records.otherFile?.data||classifySubmissionRecords(parent,[stored,records.otherFile.data]).length||
 classifyTransferRecord(parent,stored,kit.submissionId).issues.length||classifyTransferRecord(parent,records.otherFile.data,kit.submissionId).issues.length)fail('TRANSFER_CHECKPOINT_INVALID');
 const source=stored.pausedTransferSource;
 if(!source||typeof source.generation!=='string'||!/^[1-9][0-9]*$/.test(source.generation))fail('PAUSED_SOURCE_REQUIRED');
 const expected={bucket:kit.storageBucket,path:file.storagePath,generation:source.generation,size:String(file.size),
 contentType:file.contentType,md5:Buffer.from(file.md5Base64,'base64').toString('hex')};
 if(Object.keys(source).length!==6||Object.keys(expected).some(key=>source[key]!==expected[key]))fail('PAUSED_SOURCE_MISMATCH');
 const object=await transport.readObject(fileIndex,source.generation);
 const event={bucket:kit.storageBucket,name:file.storagePath,generation:source.generation,size:String(file.size),contentType:file.contentType,md5Hash:file.md5Base64};
 if(!object||Object.keys(event).some(key=>String(object[key])!==event[key]))fail('STORAGE_SOURCE_MISMATCH');
 if(stored.driveTransferPlan?.sourceKey&&stored.driveTransferPlan.sourceKey!==hash(expected))fail('TRANSFER_PLAN_SOURCE_MISMATCH');
 const plan={version:1,transferMode:'acceptance',project:ACCEPTANCE_PROJECT,region:'asia-northeast1',revision,uri,fileIndex,event,
 recordVersions:{parent:records.parent.updateTime,file:records.file.updateTime,drive:records.drive.updateTime,otherFile:records.otherFile.updateTime}};
 return {...plan,fingerprint:hash(plan),preparedAt:new Date(now()).toISOString()};
}
export async function executePausedReplay({transport,plan,approvedFingerprint,now=()=>Date.now()}){
 if(!plan||typeof approvedFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(approvedFingerprint)||approvedFingerprint!==plan.fingerprint)fail('EXACT_REPLAY_CONFIRMATION_REQUIRED');
 const age=now()-Date.parse(plan.preparedAt);
 if(!Number.isFinite(age)||age<0||age>300000)fail('REPLAY_REVIEW_EXPIRED');
 const fresh=await preparePausedReplay({transport,fileIndex:plan.fileIndex,revision:plan.revision,now});
 if(fresh.fingerprint!==approvedFingerprint)fail('REPLAY_STATE_CHANGED');
 verifyFunction(await transport.readFunction(),plan.revision);
 if(now()-Date.parse(plan.preparedAt)>300000)fail('REPLAY_REVIEW_EXPIRED');
 // 応答喪失時は実行済みか不明。自動再試行せず、Drive/DB/Storageを再照合する。
 const result=await transport.invoke(fresh);
 return {project:ACCEPTANCE_PROJECT,revision:plan.revision,fingerprint:approvedFingerprint,
 invocationAccepted:result?.accepted===true,completionVerified:false,automaticRetry:false};
}
export async function runReplayCli(args,credentials,{fetchImpl=fetch,now=()=>Date.now()}={}){
 const options={};
 for(let i=0;i<args.length;i+=2){
  if(!['--file','--revision','--output','--execute','--review'].includes(args[i])||!args[i+1]||options[args[i]])fail('ARGUMENTS_INVALID');
  options[args[i]]=args[i+1];
 }
 const fileIndex=Number(options['--file']),revision=options['--revision'];selected(fileIndex);
 if(!revisionValid(revision)||!options['--output'])fail('ARGUMENTS_REQUIRED');
 const output=path.resolve(options['--output']),root=path.resolve('release-evidence');
 if(!output.startsWith(root+path.sep))fail('OUTPUT_SCOPE_DENIED');
 const fd=fs.openSync(output,'wx',0o600);
 try{
  const transport=createReplayTransport(credentials?.accessToken,credentials?.idToken,fetchImpl);
  let result;
  if(options['--execute']){
   if(!tokenValid(credentials?.idToken)||!options['--review'])fail('REVIEW_AND_ID_TOKEN_REQUIRED');
   const reviewPath=path.resolve(options['--review']);
   if(!reviewPath.startsWith(root+path.sep))fail('REVIEW_SCOPE_DENIED');
   const reviewed=JSON.parse(fs.readFileSync(reviewPath,'utf8'));
   if(reviewed?.plan?.fileIndex!==fileIndex||reviewed?.plan?.revision!==revision)fail('REVIEW_SCOPE_MISMATCH');
   fs.writeFileSync(fd,JSON.stringify({invocationOutcome:'unknown',automaticRetry:false})+'\n');
   result=await executePausedReplay({transport,plan:reviewed.plan,approvedFingerprint:options['--execute'],now});
  }else{
   if(options['--review'])fail('ARGUMENTS_INVALID');
   const plan=await preparePausedReplay({transport,fileIndex,revision,now});
   result={plan,cloudWriteAttempted:false,executionAuthorized:false};
  }
  fs.ftruncateSync(fd,0);fs.writeSync(fd,JSON.stringify(result,null,2)+'\n',0,'utf8');return result;
 }finally{fs.closeSync(fd);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  const result=await runReplayCli(process.argv.slice(2),JSON.parse(fs.readFileSync(0,'utf8')));
  console.log(JSON.stringify({prepared:!!result.plan,fingerprint:result.plan?.fingerprint??result.fingerprint,
   invocationAccepted:result.invocationAccepted??false,completionVerified:false}));
 }catch(error){
  console.error(JSON.stringify({ok:false,code:/^[A-Z_0-9]+$/.test(error.message)?error.message:'REPLAY_FAILED',
   message:'自動再試行しません。応答不明の場合は実体を再照合してください。'}));process.exitCode=1;
 }
}
