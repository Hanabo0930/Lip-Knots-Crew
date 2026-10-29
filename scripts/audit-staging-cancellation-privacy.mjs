import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {PROJECT,createReadTransport} from './read-staging-shift-integrity.mjs';
// The existing submission acceptance kit also stores completed synthetic jobs.
const knownStatuses=['draft','scheduled','open','assigned','stopped','cancelled','archived','completed'];
class UnknownJobStatusError extends Error{
 constructor(statusAudit){super('UNKNOWN_JOB_STATUS');this.statusAudit=statusAudit;}
}
export async function auditStagingCancellationPrivacy({request,cap=10000}){
 if(typeof request!=='function'||!Number.isSafeInteger(cap)||cap<1||cap>10000)throw Error('INVALID_AUDIT_INPUT');
 const startedAt=new Date().toISOString(),begin=await request('beginTransaction',{options:{readOnly:{}}});
 if(typeof begin?.transaction!=='string'||!begin.transaction)throw Error('READ_ONLY_TRANSACTION_REQUIRED');
 let report,error;
 try{
  const response=await request('runQuery',{transaction:begin.transaction,structuredQuery:{from:[{collectionId:'jobs'}],select:{fields:[{fieldPath:'status'},{fieldPath:'cancelled'}]},orderBy:[{field:{fieldPath:'__name__'},direction:'ASCENDING'}],limit:cap+1}});
  if(!Array.isArray(response)||!response.length||response.at(-1)?.done===false)throw Error('INCOMPLETE_QUERY');
  const seen=new Set(),statusCounts=Object.fromEntries(knownStatuses.map(status=>[status,0]));
  let conflicts=0,cancelled=0,readTime,missingStatusJobs=0,invalidStatusJobs=0,unknownStatusJobs=0;
  const prefix='projects/'+PROJECT+'/databases/(default)/documents/jobs/';
  for(const item of response){
   if(!item||item.error||item.skippedResults||typeof item.readTime!=='string'||!Number.isFinite(Date.parse(item.readTime)))throw Error('INCOMPLETE_QUERY');
   if(readTime&&readTime!==item.readTime)throw Error('INCONSISTENT_SNAPSHOT');readTime=item.readTime;
   if(!item.document){if(response.length!==1||Object.keys(item).some(k=>!['readTime','transaction','done'].includes(k)))throw Error('INCOMPLETE_QUERY');continue;}
   const doc=item.document;if(typeof doc.name!=='string'||!doc.name.startsWith(prefix))throw Error('DOCUMENT_SCOPE');
   const id=doc.name.slice(prefix.length);if(!id||id.includes('/')||seen.has(id))throw Error('DUPLICATE_OR_INVALID_DOCUMENT');seen.add(id);
   if(seen.size>cap)throw Error('AUDIT_LIMIT_EXCEEDED');
   const fields=doc.fields??{};if(Object.keys(fields).some(k=>!['status','cancelled'].includes(k)))throw Error('UNEXPECTED_PRIVATE_FIELD');
   const status=fields.status?.stringValue,flag=fields.cancelled?.booleanValue;
   if(fields.cancelled!==undefined&&(Object.keys(fields.cancelled??{}).length!==1||typeof flag!=='boolean'))throw Error('INVALID_CANCELLATION_FLAG');
   if(!fields.status){missingStatusJobs++;continue;}
   if(Object.keys(fields.status).length!==1||typeof status!=='string'){invalidStatusJobs++;continue;}
   if(!knownStatuses.includes(status)){unknownStatusJobs++;continue;}
   statusCounts[status]++;
   if(status==='cancelled')cancelled++;
   if((status==='cancelled')!==(flag===true))conflicts++;
  }
  if(missingStatusJobs||invalidStatusJobs||unknownStatusJobs)throw new UnknownJobStatusError({scannedJobs:seen.size,statusCounts,missingStatusJobs,invalidStatusJobs,unknownStatusJobs});
  report={schema:'LK_STAGING_CANCELLATION_PRIVACY_AUDIT_V1',project:PROJECT,scope:'ALL_JOBS_STATUS_AND_CANCELLED_ONLY',complete:true,startedAt,readTime,scannedJobs:seen.size,cancelledJobs:cancelled,conflicts,zeroConflicts:conflicts===0,status:conflicts?'HOLD':'PASS',deploymentReady:false,cloudBusinessWrites:0,nativeRequests:0};
 }catch(e){error=e;}
 try{const done=await request('rollback',{transaction:begin.transaction});if(!done||Array.isArray(done)||typeof done!=='object'||Object.keys(done).length)throw Error('READ_TRANSACTION_RELEASE_FAILED');}catch{error=Error('READ_TRANSACTION_RELEASE_FAILED');}
 if(error)throw error;
 return {...report,transactionRolledBack:true,completedAt:new Date().toISOString()};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 if(args.length!==3||args[0]!=='--token-stdin'||args[1]!=='--evidence'||!args[2])throw Error('REQUIRED_TOKEN_STDIN_AND_EVIDENCE');
 const directory=path.resolve(args[2]);fs.mkdirSync(directory,{recursive:false});
 try{
  const token=fs.readFileSync(0,'utf8').trim();
  const report=await auditStagingCancellationPrivacy({request:createReadTransport(token)});
  fs.writeFileSync(path.join(directory,'privacy-audit.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  if(!report.zeroConflicts)process.exitCode=2;
 }catch(error){
  const raw=String(error?.message??''),code=/^[A-Z][A-Z0-9_]{1,90}$/.test(raw)?raw:'AUDIT_INCOMPLETE';
  const report={schema:'LK_STAGING_CANCELLATION_PRIVACY_AUDIT_V1',project:PROJECT,status:'INCOMPLETE',complete:false,deploymentReady:false,code,
   ...(error instanceof UnknownJobStatusError?{statusAudit:error.statusAudit}:{}),cloudBusinessWrites:0,nativeRequests:0};
  fs.writeFileSync(path.join(directory,'privacy-audit.json'),JSON.stringify(report,null,2)+'\n');console.error(JSON.stringify(report));process.exitCode=1;
 }
}

