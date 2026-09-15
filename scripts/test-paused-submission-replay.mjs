import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createSubmissionAcceptanceKit} from './submission-acceptance-kit.mjs';
import {REPLAY_DRIVE_ROOT,preparePausedReplay,executePausedReplay,createReplayTransport,runReplayCli} from './replay-paused-submission.mjs';
const kit=createSubmissionAcceptanceKit({driveRootId:REPLAY_DRIVE_ROOT});
const revision='finalizestagedupload-00006-test',stamp='2026-09-15T04:00:00.000Z',now=()=>Date.parse(stamp);
const root='projects/'+kit.project,db=root+'/databases/(default)/documents';
const results=[];
async function test(name,run){try{await run();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:error.message});}}
function fixture(index=1){
 const file=kit.files[index-1];
 const source={bucket:kit.storageBucket,path:file.storagePath,generation:'101',size:String(file.size),contentType:file.contentType,md5:Buffer.from(file.md5Base64,'base64').toString('hex')};
 const record=ref=>({data:structuredClone(kit.seedDocuments.find(doc=>doc.path===ref).data),updateTime:stamp});
 const records={parent:record('submissions/'+kit.submissionId),file:record('submissions/'+kit.submissionId+'/files/'+file.fileId),drive:record('companies/'+kit.companyId+'/settings/drive')};
 records.parent.data.status='paused_global';records.file.data.status='paused_global';records.file.data.pausedTransferSource=source;
 records.otherFile=record('submissions/'+kit.submissionId+'/files/'+kit.files[index===1?1:0].fileId);
 const fn={name:root+'/locations/asia-northeast1/functions/finalizeStagedUpload',state:'ACTIVE',environment:'GEN_2',
  serviceConfig:{revision,allTrafficOnLatestRevision:true,serviceAccountEmail:'740154137290-compute@developer.gserviceaccount.com',
   uri:'https://finalizestagedupload-example-an.a.run.app',environmentVariables:{APP_ENVIRONMENT:'staging',EXPECTED_FIREBASE_PROJECT_ID:kit.project,LKC_SUBMISSION_TRANSFER_MODE:'active'}},
  eventTrigger:{eventType:'google.cloud.storage.object.v1.finalized',eventFilters:[{attribute:'bucket',value:kit.storageBucket}]}};
 const object={bucket:kit.storageBucket,name:file.storagePath,generation:'101',size:String(file.size),contentType:file.contentType,md5Hash:file.md5Base64};
 const f={records,fn,object,reads:0,invokes:[],storageReads:0};
 f.transport={readFunction:async()=>{f.reads++;return structuredClone(f.fn);},readRecords:async()=>structuredClone(f.records),
  readObject:async(i,g)=>{assert.equal(i,index);assert.equal(g,'101');f.storageReads++;return structuredClone(f.object);},
  invoke:async plan=>{f.invokes.push(plan);if(f.failInvoke)throw Error('INVOKE_OUTCOME_UNKNOWN');return {accepted:true};}};
 f.prepare=()=>preparePausedReplay({transport:f.transport,fileIndex:index,revision,now});
 return f;
}
for(const index of [1,2])await test('専用ファイル '+index+' の照合から一回実行まで',async()=>{
 const f=fixture(index),plan=await f.prepare();assert.equal(f.invokes.length,0);
 const result=await executePausedReplay({transport:f.transport,plan,approvedFingerprint:plan.fingerprint,now});
 assert.equal(f.invokes.length,1);assert.equal(result.invocationAccepted,true);assert.equal(result.completionVerified,false);
 assert.equal(result.automaticRetry,false);assert.equal(f.invokes[0].event.generation,'101');
});
for(const [name,mutate] of [
 ['production',f=>f.fn.serviceConfig.environmentVariables.APP_ENVIRONMENT='production'],
 ['wrong project',f=>f.fn.name=f.fn.name.replace(kit.project,'other')],
 ['old revision',f=>f.fn.serviceConfig.revision='finalizestagedupload-00005-pep'],
 ['paused',f=>f.fn.serviceConfig.environmentVariables.LKC_SUBMISSION_TRANSFER_MODE='paused'],
 ['missing control',f=>delete f.fn.serviceConfig.environmentVariables.LKC_SUBMISSION_TRANSFER_MODE],
 ['traffic split',f=>f.fn.serviceConfig.allTrafficOnLatestRevision=false],
 ['wrong identity',f=>f.fn.serviceConfig.serviceAccountEmail='other'],
 ['wrong URI',f=>f.fn.serviceConfig.uri='https://example.com'],
 ['wrong event',f=>f.fn.eventTrigger.eventType='other'],
 ['wrong bucket filter',f=>f.fn.eventTrigger.eventFilters[0].value='other'],
 ['not active',f=>f.fn.state='DEPLOYING'],
 ['foreign company',f=>f.records.parent.data.companyId='other'],
 ['foreign uid',f=>f.records.file.data.uid='other'],
 ['foreign Drive root',f=>f.records.drive.data.rootFolderId=kit.drive.parentId],
 ['different path',f=>f.records.file.data.storagePath+='other'],
 ['other counter mismatch',f=>f.records.parent.data.completedFiles=1],
 ['other identity mismatch',f=>f.records.otherFile.data.companyId='other'],
 ['counted',f=>f.records.file.data.completionCounted=true],
 ['completed',f=>f.records.file.data.status='completed'],
 ['counter overflow',f=>f.records.parent.data.completedFiles=3],
 ['counter ambiguous',f=>f.records.parent.data.completedFiles=2],
 ['legacy drive checkpoint',f=>f.records.file.data.driveFileId='legacy'],
 ['missing paused source',f=>delete f.records.file.data.pausedTransferSource],
 ['wrong saved md5',f=>f.records.file.data.pausedTransferSource.md5='f'.repeat(32)],
 ['extra saved field',f=>f.records.file.data.pausedTransferSource.extra=true],
 ['wrong stored size',f=>f.records.file.data.size++],
 ['wrong live generation',f=>f.object.generation='102'],
 ['wrong live md5',f=>f.object.md5Hash='invalid'],
 ['wrong live size',f=>f.object.size='999'],
 ['wrong live path',f=>f.object.name='other'],
 ['wrong live MIME',f=>f.object.contentType='image/png'],
 ['replacement',f=>f.records.file.data.resubmissionRequestId='other'],
 ['wrong plan source',f=>f.records.file.data.driveTransferPlan={id:'id',name:'name',sequence:1,parentId:'folder',sourceKey:'f'.repeat(64)}],
])await test('再処理拒否: '+name,async()=>{const f=fixture();mutate(f);await assert.rejects(f.prepare());assert.equal(f.invokes.length,0);});
await test('応答喪失後の保存済み計画は同じ元データで再利用できる',async()=>{
 const f=fixture(),source=f.records.file.data.pausedTransferSource;
 f.records.file.data.status='error';f.records.file.data.driveTransferPlan={id:'allocated-id',name:'fixture',sequence:1,parentId:'child-folder',sourceKey:createHash('sha256').update(JSON.stringify(source)).digest('hex')};
 await f.prepare();assert.equal(f.invokes.length,0);
});
for(const field of ['parent','file','drive','otherFile'])await test('確認後の '+field+' 変更を拒否',async()=>{
 const f=fixture(),plan=await f.prepare();f.records[field].updateTime='2026-09-15T04:00:01Z';
 await assert.rejects(executePausedReplay({transport:f.transport,plan,approvedFingerprint:plan.fingerprint,now}),/REPLAY_STATE_CHANGED/);
 assert.equal(f.invokes.length,0);
});
for(const age of [300001,-1])await test('確認時刻の不正・期限切れ '+age,async()=>{
 const f=fixture(),plan=await f.prepare();await assert.rejects(executePausedReplay({transport:f.transport,plan,approvedFingerprint:plan.fingerprint,now:()=>now()+age}),/REPLAY_REVIEW_EXPIRED/);assert.equal(f.invokes.length,0);
});
await test('確認指紋のない実行を拒否',async()=>{const f=fixture(),plan=await f.prepare();await assert.rejects(executePausedReplay({transport:f.transport,plan,approvedFingerprint:'0'.repeat(64),now}),/EXACT_REPLAY_CONFIRMATION_REQUIRED/);assert.equal(f.invokes.length,0);});
await test('応答喪失は一回で止めて成否不明とする',async()=>{
 const f=fixture(),plan=await f.prepare();f.failInvoke=true;
 await assert.rejects(executePausedReplay({transport:f.transport,plan,approvedFingerprint:plan.fingerprint,now}),/INVOKE_OUTCOME_UNKNOWN/);assert.equal(f.invokes.length,1);
});
function encode(v){if(v===null)return {nullValue:null};if(typeof v==='string')return {stringValue:v};if(typeof v==='number')return {integerValue:String(v)};if(typeof v==='boolean')return {booleanValue:v};return {mapValue:{fields:Object.fromEntries(Object.entries(v).map(([k,x])=>[k,encode(x)]))}};}
function httpFixture(){
 const f=fixture();f.calls=[];
 f.fetch=async(url,init)=>{
  f.calls.push({url,init});assert.equal(init.redirect,'error');assert.ok(init.signal);
  if(url===f.fn.serviceConfig.uri){assert.equal(init.headers.Authorization,'Bearer synthetic-id');if(f.httpFail)throw Error('sensitive raw error');return {ok:true};}
  assert.equal(init.headers.Authorization,'Bearer synthetic-access');
  if(url.includes('cloudfunctions.googleapis.com'))return {ok:true,json:async()=>f.fn};
  if(url.endsWith(':beginTransaction')){assert.deepEqual(JSON.parse(init.body),{options:{readOnly:{}}});return {ok:true,json:async()=>({transaction:'synthetic-read-transaction'})};}
  if(url.endsWith(':rollback'))return {ok:true,json:async()=>({})};
  if(url.includes('storage.googleapis.com')){assert.equal(new URL(url).searchParams.get('generation'),'101');return {ok:true,json:async()=>f.object};}
  const parsed=new URL(url);assert.equal(parsed.searchParams.get('transaction'),'synthetic-read-transaction');assert.ok(parsed.searchParams.getAll('mask.fieldPaths').length);
  const key=url.includes('/settings/drive?')?'drive':url.includes('/files/'+kit.files[1].fileId+'?')?'otherFile':url.includes('/files/')?'file':'parent';
  return {ok:true,json:async()=>({name:parsed.pathname.slice(4),updateTime:f.records[key].updateTime,fields:Object.fromEntries(Object.entries(f.records[key].data).map(([k,v])=>[k,encode(v)]))})};
 };
 return f;
}
await test('実HTTP形式の読取は固定対象・世代・読取transactionへ限定',async()=>{
 const f=httpFixture(),transport=createReplayTransport('synthetic-access','synthetic-id',f.fetch);
 const plan=await preparePausedReplay({transport,fileIndex:1,revision,now});
 assert.equal(f.calls.filter(x=>x.url===f.fn.serviceConfig.uri).length,0);
 await executePausedReplay({transport,plan,approvedFingerprint:plan.fingerprint,now});
 const invocations=f.calls.filter(x=>x.url===f.fn.serviceConfig.uri);assert.equal(invocations.length,1);
 assert.equal(invocations[0].init.headers['ce-type'],'google.cloud.storage.object.v1.finalized');
 assert.deepEqual(JSON.parse(invocations[0].init.body),plan.event);
});
await test('HTTP失敗は生の秘密情報を出さず自動再試行しない',async()=>{
 const f=httpFixture(),transport=createReplayTransport('synthetic-access','synthetic-id',f.fetch);
 const plan=await preparePausedReplay({transport,fileIndex:1,revision,now});f.httpFail=true;
 await assert.rejects(executePausedReplay({transport,plan,approvedFingerprint:plan.fingerprint,now}),/^Error: INVOKE_OUTCOME_UNKNOWN$/);
 assert.equal(f.calls.filter(x=>x.url===f.fn.serviceConfig.uri).length,1);
});
await test('ID tokenなしでは呼出を一度も行わない',async()=>{
 const f=httpFixture(),transport=createReplayTransport('synthetic-access',undefined,f.fetch),plan=await preparePausedReplay({transport,fileIndex:1,revision,now});
 await assert.rejects(executePausedReplay({transport,plan,approvedFingerprint:plan.fingerprint,now}),/ID_TOKEN_REQUIRED/);
 assert.equal(f.calls.filter(x=>x.url===f.fn.serviceConfig.uri).length,0);
});
const evidence=path.resolve('release-evidence/staging-transfer-control-20260915');
fs.mkdirSync(evidence,{recursive:true});
const out=fs.mkdtempSync(path.join(evidence,'replay-tests-'));
await test('CLI既定は読取のみ、確認済みファイルで一回実行',async()=>{
 const f=httpFixture(),review=path.join(out,'review.json'),resultFile=path.join(out,'execution.json'),credentials={accessToken:'synthetic-access',idToken:'synthetic-id'};
 const args=['--file','1','--revision',revision];
 const result=await runReplayCli([...args,'--output',review],credentials,{fetchImpl:f.fetch,now});
 assert.equal(result.executionAuthorized,false);assert.equal(f.calls.filter(x=>x.url===f.fn.serviceConfig.uri).length,0);
 await runReplayCli([...args,'--output',resultFile,'--review',review,'--execute',result.plan.fingerprint],credentials,{fetchImpl:f.fetch,now});
 assert.equal(JSON.parse(fs.readFileSync(resultFile,'utf8')).invocationAccepted,true);
 const calls=f.calls.length;
 await assert.rejects(runReplayCli([...args,'--output',resultFile,'--review',review,'--execute',result.plan.fingerprint],credentials,{fetchImpl:f.fetch,now}));
 assert.equal(f.calls.length,calls);
});
await test('CLI古い確認ファイルは実行前に拒否',async()=>{
 const f=httpFixture(),review=path.join(out,'expired-review.json'),credentials={accessToken:'synthetic-access',idToken:'synthetic-id'};
 const args=['--file','1','--revision',revision],result=await runReplayCli([...args,'--output',review],credentials,{fetchImpl:f.fetch,now});
 await assert.rejects(runReplayCli([...args,'--output',path.join(out,'expired-result.json'),'--review',review,'--execute',result.plan.fingerprint],credentials,{fetchImpl:f.fetch,now:()=>now()+300001}),/REPLAY_REVIEW_EXPIRED/);
 assert.equal(f.calls.filter(x=>x.url===f.fn.serviceConfig.uri).length,0);
});
const summary={total:results.length,passed:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok),cloudOperations:false};
fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({summary,results},null,2)+'\n');
console.log(JSON.stringify(summary,null,2));if(summary.failed.length)process.exitCode=1;
