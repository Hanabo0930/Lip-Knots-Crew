import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const PROJECT='lip-knots-crew-staging',REGION='asia-northeast1',TARGET='finalizeStagedUpload',ENTRY='createUploadSession';
const fail=code=>{throw Error(code);};
export function resolveTransferMode({requested,functions,current,currentEntry,supportsControl,supportsAcceptance}){
 if(!['preserve','active','paused','acceptance'].includes(requested))fail('TRANSFER_MODE_INVALID');
 if(!Array.isArray(functions)||!functions.length||new Set(functions).size!==functions.length)fail('FUNCTION_SCOPE_INVALID');
 if(!functions.includes(TARGET)&&!functions.includes(ENTRY)){
  if(requested!=='preserve')fail('TRANSFER_MODE_REQUIRES_FINALIZE_ONLY');
  return null;
 }
 if(requested!=='preserve'&&(!functions.includes(TARGET)||functions.some(name=>![TARGET,ENTRY].includes(name))))fail('TRANSFER_MODE_REQUIRES_FINALIZE_ONLY');
 const observed=functions.filter(name=>[TARGET,ENTRY].includes(name)).map(name=>{
  const record=name===TARGET?current:currentEntry;
  if(record?.name!=='projects/'+PROJECT+'/locations/'+REGION+'/functions/'+name||record.state!=='ACTIVE'||
   typeof record.serviceConfig?.revision!=='string'||!new RegExp('^'+name.toLowerCase()+'-[0-9]+-[a-z0-9]+$').test(record.serviceConfig.revision))fail('CURRENT_FUNCTION_UNVERIFIED');
  const saved=record.serviceConfig.environmentVariables?.LKC_SUBMISSION_TRANSFER_MODE;
  if(saved!==undefined&&!['active','paused','acceptance'].includes(saved))fail('CURRENT_TRANSFER_MODE_INVALID');
  if(requested==='preserve'&&saved===undefined)fail('CURRENT_TRANSFER_MODE_UNVERIFIED');
  return {name,saved,revision:record.serviceConfig.revision};
 });
 if(requested==='preserve'&&new Set(observed.map(item=>item.saved)).size!==1)fail('CURRENT_TRANSFER_MODES_DIFFER');
 const mode=requested==='preserve'?observed[0].saved:requested;
 if((mode!=='active'||requested!=='preserve')&&!supportsControl)fail('SOURCE_TRANSFER_CONTROL_MISSING');
 if(mode==='acceptance'&&!supportsAcceptance)fail('SOURCE_ACCEPTANCE_CONTROL_MISSING');
 return {mode,previousRevision:(observed.find(item=>item.name===TARGET)??observed[0]).revision,
  previousRevisions:Object.fromEntries(observed.map(item=>[item.name,item.revision]))};
}
export function materializeTransferMode({project,region,requested,functions,sourceDirectory,describe}){
 if(project!==PROJECT||region!==REGION)fail('STAGING_SCOPE_REQUIRED');
 const names=typeof functions==='string'?functions.split(','):[];
 if(!['preserve','active','paused','acceptance'].includes(requested)||!names.length||names.some(name=>!name))fail('TRANSFER_INPUT_INVALID');
 if(!names.includes(TARGET)&&!names.includes(ENTRY))return resolveTransferMode({requested,functions:names});
 const root=path.resolve(sourceDirectory),dotenv=path.join(root,'functions','.env.'+PROJECT);
 const uploads=fs.readFileSync(path.join(root,'functions/src/uploads.ts'),'utf8'),controlFile=path.join(root,'functions/src/submission-transfer-control.ts');
 const control=fs.existsSync(controlFile)?fs.readFileSync(controlFile,'utf8'):'';
 const handler=name=>{const start=uploads.indexOf('export const '+name+' ='),next=uploads.indexOf('\nexport const ',start+1);return start<0?'':uploads.slice(start,next<0?uploads.length:next);};
 const supportsControl=control.includes('process.env.LKC_SUBMISSION_TRANSFER_MODE')
  && (!names.includes(TARGET)||(handler(TARGET).includes('submissionTransferPaused(companyId)')&&handler(TARGET).includes('pausedTransferSource')))
  && (!names.includes(ENTRY)||/if\s*\(\s*await submissionTransferPaused\(companyId\)\s*\)\s*throw/.test(handler(ENTRY)));
 const supportsAcceptance=/const acceptanceOnly = mode === "acceptance"\s*&& process\.env\.APP_ENVIRONMENT === "staging"\s*&& process\.env\.EXPECTED_FIREBASE_PROJECT_ID === "lip-knots-crew-staging"\s*&& companyId === "lkc-transfer-acceptance-20260908";\s*if \(mode !== "active" && !acceptanceOnly\) return true;/.test(control);
 const resolved=resolveTransferMode({requested,functions:names,
  current:names.includes(TARGET)?describe(TARGET):undefined,
  currentEntry:names.includes(ENTRY)?describe(ENTRY):undefined,supportsControl,supportsAcceptance});
 const contents=fs.readFileSync(dotenv,'utf8');
 if(!/^APP_ENVIRONMENT=staging\r?$/m.test(contents)||!/^EXPECTED_FIREBASE_PROJECT_ID=lip-knots-crew-staging\r?$/m.test(contents)||
  /^\s*(?:export\s+)?LKC_SUBMISSION_TRANSFER_MODE\s*=/m.test(contents))fail('STAGING_DOTENV_INVALID');
 fs.appendFileSync(dotenv,(contents.endsWith('\n')?'':'\n')+'LKC_SUBMISSION_TRANSFER_MODE='+resolved.mode+'\n',{mode:0o600});
 return resolved;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  const result=materializeTransferMode({
   project:process.env.LKC_PROJECT_ID,region:process.env.LKC_REGION,requested:process.env.LKC_TRANSFER_MODE_REQUESTED,
   functions:process.env.LKC_FUNCTIONS,sourceDirectory:process.env.LKC_SOURCE_DIRECTORY,
   describe:name=>JSON.parse(execFileSync('gcloud',['functions','describe',name,'--gen2','--project',PROJECT,'--region',REGION,
    '--format=json(name,state,serviceConfig.revision,serviceConfig.environmentVariables.LKC_SUBMISSION_TRANSFER_MODE)'],
    {encoding:'utf8',stdio:['ignore','pipe','pipe']})),
  });
  console.log(JSON.stringify({transferControl:result??'unchanged-other-functions',cloudWritten:false}));
 }catch(error){console.error(/^[A-Z_0-9]+$/.test(error.message)?error.message:'TRANSFER_MODE_PREPARATION_FAILED');process.exitCode=1;}
}
