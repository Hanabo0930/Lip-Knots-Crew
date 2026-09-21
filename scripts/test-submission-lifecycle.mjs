import {createSubmissionAcceptanceKit} from './submission-acceptance-kit.mjs';
import {preparePausedReplay,executePausedReplay,REPLAY_DRIVE_ROOT} from './replay-paused-submission.mjs';
import {verifySubmissionAcceptanceResult} from './submission-acceptance-result.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const dependency=createRequire(process.env.LKC_TEST_DEPENDENCY_ROOT?path.join(process.env.LKC_TEST_DEPENDENCY_ROOT,'package.json'):import.meta.url);
const ts=dependency('typescript'),{Timestamp}=dependency('firebase-admin/firestore'),{HttpsError}=dependency('firebase-functions/v2/https');
const deleted=Symbol('delete');
const copy=v=>v instanceof Timestamp||v===deleted?v:Array.isArray(v)?v.map(copy):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,copy(x)])):v;
function merge(old,data){
  const next=copy(old??{});
  for(const [k,v] of Object.entries(data)){
    assert.notEqual(v,undefined,'undefined DB field');
    if(v===deleted)delete next[k];
    else if(v?.__increment!==undefined)next[k]=Number(next[k]??0)+v.__increment;
    else if(v?.__union){const a=next[k]??[];next[k]=[...a,...v.__union.filter(x=>!a.some(y=>JSON.stringify(x)===JSON.stringify(y)))].map(copy);}
    else if(v&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof Timestamp))next[k]=merge(next[k],v);
    else next[k]=copy(v);
  }
  return next;
}
function harness(sourceFiles=null,compiledFiles=null){
  const records=new Map(),modules=new Map(),versions=new Map();let serial=0,allocated=0;
  const h={records,env:{APP_ENVIRONMENT:'development',LKC_SHEET_WRITE_MODE:'active'},documentReads:0,queryReads:0,returnedDocuments:0,copies:0,deletes:0,failDelete:false,failCopy:false,failWrite:null,loseCopyResponse:false,getError:null,conflictMismatch:false,beforeCopy:null,afterCopy:null,loaded:[],driveFiles:new Map()};
  const snap=ref=>{const value=copy(records.get(ref.path));return {ref,id:ref.id,exists:records.has(ref.path),data:()=>copy(value)};};
  function commit(writes){
    const next=new Map(records);
    for(const w of writes){
      if(h.failWrite?.(w))throw new Error('synthetic DB write failure');
      if(w.mode==='create')assert.ok(!next.has(w.ref.path),'create exists');
      if(w.mode==='update')assert.ok(next.has(w.ref.path),'update missing');
      if(w.mode==='delete'){next.delete(w.ref.path);continue;}
      let data=w.data;
      if(w.mode==='update'){
        data={};for(const [key,v] of Object.entries(w.data)){const parts=key.split('.');let node=data;for(const part of parts.slice(0,-1))node=node[part]??={};node[parts.at(-1)]=v;}
      }
      next.set(w.ref.path,merge(w.merge||w.mode==='update'?next.get(w.ref.path):{},data));
    }
    records.clear();for(const [k,v]of next)records.set(k,v);for(const w of writes){versions.set(w.ref.path,(versions.get(w.ref.path)??0)+1);const key="@collection:"+w.ref.path.split("/").slice(0,-1).join("/");versions.set(key,(versions.get(key)??0)+1);}
  }
  const ref=p=>({path:p,id:p.split('/').at(-1),collection:n=>collection(`${p}/${n}`),get:async()=>{h.documentReads++;return snap(ref(p));},set:async(data,opts)=>{if(p.startsWith("resubmissionRequests/"))await h.beforeRequestWrite?.();commit([{ref:ref(p),data,merge:opts?.merge}]);},update:async data=>commit([{ref:ref(p),data,mode:"update"}])});
  const field=(v,k)=>k.split('.').reduce((x,p)=>x?.[p],v);
  const collection=(name,filters=[],ordering=null,max=Infinity)=>({
    queryPath:name,
    doc:(id=`synthetic-${++serial}`)=>ref(`${name}/${id}`),
    add:async data=>{const r=ref(`${name}/synthetic-${++serial}`);await r.set(data);return r;},
    where:(f,op,v)=>{assert.ok(['==','in','>=','<=','<'].includes(op));return collection(name,[...filters,[f,op,v]],ordering,max);},
    orderBy:(f,d)=>collection(name,filters,[f,d],max),limit:n=>collection(name,filters,ordering,n),
    get:async()=>{
      h.queryReads++;let entries=[...records].filter(([k,v])=>k.startsWith(name+'/')&&!k.slice(name.length+1).includes('/')&&filters.every(([f,op,x])=>op==='=='?field(v,f)===x:op==='>='?field(v,f)>=x:op==='<='?field(v,f)<=x:op==='<'?field(v,f)<x:x.includes(field(v,f))));
      if(ordering)entries.sort((a,b)=>{const val=x=>{const v=field(x[1],ordering[0]);return v instanceof Timestamp?v.toMillis():v;};return (val(a)>val(b)?1:val(a)<val(b)?-1:0)*(ordering[1]==='desc'?-1:1);});
      h.returnedDocuments+=Math.min(entries.length,max);return {docs:entries.slice(0,max).map(([k])=>snap(ref(k))),size:Math.min(entries.length,max)};
    },
  });
  const writer=w=>({delete:ref=>w.push({ref,mode:'delete'}),set:(ref,data,opts)=>w.push({ref,data,merge:opts?.merge}),update:(ref,data)=>w.push({ref,data,mode:'update'}),create:(ref,data)=>w.push({ref,data,mode:'create'})});
  const db={collection,doc:ref,getAll:(...refs)=>Promise.all(refs.map(r=>r.get())),batch:()=>{const w=[];return {...writer(w),commit:async()=>{await h.beforeCommit?.();commit(w);}};},runTransaction:async callback=>{
    await h.beforeRequestWrite?.();
    for(let attempt=0;attempt<10;attempt++){
      const w=[],reads=new Map();const get=async r=>{assert.equal(w.length,0,'read after write');if(r.queryPath){const key='@collection:'+r.queryPath;reads.set(key,versions.get(key)??0);const result=await r.get();for(const doc of result.docs)reads.set(doc.ref.path,versions.get(doc.ref.path)??0);return result;}reads.set(r.path,versions.get(r.path)??0);return snap(r);};
      const result=await callback({...writer(w),get,getAll:(...refs)=>Promise.all(refs.map(get))});
      await h.beforeCommit?.();
      if([...reads].some(([k,v])=>(versions.get(k)??0)!==v))continue;
      commit(w);return result;
    }
    throw new Error('synthetic transaction contention');
  }};
  const drive={files:{
    generateIds:async()=>({data:{ids:[`allocated-${++allocated}`]}}),
    get:async({fileId})=>{if(h.getError)throw {code:h.getError};const data=h.driveFiles.get(fileId);if(!data)throw {code:404};return {data:copy(data)};},
    list:async input=>h.driveList?h.driveList(input):({data:{files:[{id:'synthetic-folder'}]}}),
    create:async input=>{
      assert.ok(input.media,'test expects only file copies');await h.beforeCopy?.();if(h.failCopy)throw new Error('synthetic transfer failure');
      const id=input.requestBody.id??`synthetic-drive-${h.copies+1}`;
      if(h.conflictMismatch){h.driveFiles.set(id,{id,name:'unrelated',size:'100'});throw {code:409};}
      if(h.driveFiles.has(id))throw {code:409};
      h.copies++;const data={...input.requestBody,id,size:'100',mimeType:'image/png',md5Checksum:'00000000000000000000000000000000',createdTime:h.driveCreatedAt??'2026-09-20T02:00:00.000Z'};
      if(h.drivePayload)Object.assign(data,h.drivePayload(input));h.driveFiles.set(id,data);await h.afterCopy?.();if(h.loseCopyResponse)throw new Error('synthetic lost response');return {data:copy(data)};
    },
  }};
  const storage={bucket:name=>{assert.equal(name??'synthetic-bucket',h.storageBucket??'synthetic-bucket');return {file:(p,options)=>({getMetadata:async()=>{h.metadataReads=(h.metadataReads??0)+1;if(h.metadataError)throw {code:h.metadataError};const object=h.storageObjects?.get(p);if(!object)throw {code:404};return [copy(object)];},createReadStream:()=>{if(h.allowLegacyUnversionedRead&&options?.generation===undefined)h.unversionedReads=(h.unversionedReads??0)+1;else assert.equal(options?.generation,'1');return {syntheticPath:p};},delete:async()=>{h.deletedPaths??=[];h.deletedPaths.push(p);h.storageObjects?.delete(p);h.deletes++;if(h.failDelete)throw new Error('synthetic cleanup failure');}})};}};
  const boundaries={'firebase-functions/v2/firestore':{onDocumentWritten:(_path,fn)=>fn},'firebase-functions/v2/scheduler':{onSchedule:(_options,fn)=>fn},googleapis:{google:{auth:{GoogleAuth:class{}},monitoring:()=>({}),sheets:()=>{if(h.sheets)return h.sheets;throw Error('External Sheets access refused');}}},'./firebase':{db,storage},'./google-drive-client':{getWritableDriveClient:()=>drive,getReadonlyDriveClient:()=>({files:{get:async()=>{h.previewReads=(h.previewReads??0)+1;const stream={on:()=>stream,pipe:response=>response.end()};return {data:stream};}}})},'firebase-admin/firestore':{Timestamp,FieldValue:{serverTimestamp:()=>Timestamp.now(),delete:()=>deleted,increment:value=>({__increment:value}),arrayUnion:(...v)=>({__union:v})}},'firebase-functions/v2/https':{HttpsError,onCall:(...args)=>args.at(-1),onRequest:fn=>fn},'firebase-functions/v2/storage':{onObjectFinalized:fn=>fn},'firebase-functions/params':{defineString:(name,options)=>({value:()=>name==='FILE_PREVIEW_GATEWAY_URL'?(h.previewBase??options.default):options.default})},zod:dependency('zod'),'node:path':path,'node:crypto':crypto,'node:buffer':{Buffer}};
  function load(name){
    if(Object.hasOwn(boundaries,name))return boundaries[name];assert.match(name,/^\.\/[a-z0-9-]+$/,'External import refused');if(modules.has(name))return modules.get(name);
    const filename=name.slice(2),source=compiledFiles?compiledFiles[filename+'.js']:sourceFiles?sourceFiles[filename+'.ts']:fs.readFileSync(new URL('../functions/src/'+filename+'.ts',import.meta.url),'utf8');if(typeof source!=='string')throw Error('Historical module missing: '+name);const code=compiledFiles?source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports={};modules.set(name,exports);h.loaded.push(name);runInNewContext(code,{exports,require:load,process:{env:h.env}},{timeout:5000});return exports;
  }
  h.loadModule=load;h.snapshot=p=>snap(ref(p));h.updateRecord=(p,data)=>ref(p).update(data);
  h.status=load('./submission-status');h.uploads=load('./uploads');h.requests=load('./resubmissions');h.views=load('./submission-files');h.tasks=load('./staff-tasks');h.netprint=load('./netprint');h.precontact=load('./precontact');
  h.staff={uid:'synthetic-user',token:{companyId:'synthetic-company',staffId:'synthetic-staff',role:'staff'}};h.admin={uid:'synthetic-admin',token:{companyId:'synthetic-company',role:'admin'}};
  records.set('jobs/synthetic-job',{companyId:'synthetic-company',assignedStaffId:'synthetic-staff',status:'assigned',dateKey:'2026-09-20',storeName:'Synthetic Store',clientName:'Synthetic Client'});
  records.set('staffProfiles/synthetic-staff',{companyId:'synthetic-company',displayName:'Synthetic Staff'});
  records.set('companies/synthetic-company/settings/drive',{rootFolderId:'synthetic-root'});
  h.start=(count=1,patch={})=>h.uploads.createUploadSession({auth:h.staff,data:{jobId:'synthetic-job',type:'report',files:Array.from({length:count},(_,i)=>({originalName:`synthetic-${i}.png`,contentType:'image/png',size:100})),...patch}});
  h.finish=(file,patch={})=>h.uploads.finalizeStagedUpload({data:{name:file.storagePath,bucket:'synthetic-bucket',contentType:'image/png',size:100,generation:1,md5Hash:'AAAAAAAAAAAAAAAAAAAAAA==',...patch}});
  h.state=id=>h.views.getSubmissionProcessingStatus({auth:h.staff,data:{jobId:'synthetic-job',submissionId:id}});
  h.list=name=>[...records].filter(([k])=>k.startsWith(name+'/')&&!k.slice(name.length+1).includes('/')).map(([k,v])=>({id:k.split('/').at(-1),...v}));
  return h;
}
const deployedOnly=process.argv.includes('--deployed-rollback-only');
if(deployedOnly&&!process.env.LKC_DEPLOYED_TRANSFER_BUNDLE)throw Error('Deployed rollback bundle is required.');
const results=[],deployedObservations=[];
const testPrefix=process.argv.find(arg=>arg.startsWith('--test-name-prefix='))?.slice('--test-name-prefix='.length);
async function test(name,run){if(testPrefix&&!name.startsWith(testPrefix))return;if(deployedOnly&&!name.startsWith('deployed rollback '))return;try{await run();results.push({name,ok:true});}catch(e){results.push({name,ok:false,error:e.message});}}
function pauseTransfers(h){h.env.APP_ENVIRONMENT='production';h.records.set('productionControls/synthetic-company',{productionEnabled:true,emergencyLock:true});}
await test('transfer pause updates canonical records and resumes the same submission',async()=>{
 const h=harness(),s=await h.start(),file=s.files[0],parent='submissions/'+s.submissionId,key=parent+'/files/'+file.fileId;
 pauseTransfers(h);await h.finish(file);
 assert.equal(h.records.get(key).status,'paused_global');assert.equal((await h.state(s.submissionId)).status,'paused_global');
 assert.equal(h.list('submissionFiles').length,0);assert.equal(h.copies,0);assert.equal(h.deletes,0);
 assert.equal(h.list('fileCounters').length,0);assert.equal(h.list('sheetSyncQueue').length,0);
 h.records.get('productionControls/synthetic-company').emergencyLock=false;await h.finish(file);
 assert.equal((await h.state(s.submissionId)).status,'completed');assert.equal(h.copies,1);assert.equal(h.records.get(parent).completedFiles,1);
});
for(const state of ['completed','partial-counted','error'])await test('transfer pause preserves '+state+' evidence',async()=>{
 const h=harness(),s=await h.start(state==='partial-counted'?2:1),file=s.files[0],parent='submissions/'+s.submissionId,key=parent+'/files/'+file.fileId;
 if(state==='error'){h.failCopy=true;await assert.rejects(h.finish(file));h.failCopy=false;}
 else await h.finish(file);
 pauseTransfers(h);const before=copy(h.records.get(parent)),fileBefore=copy(h.records.get(key)),copies=h.copies,deletes=h.deletes;
 await h.finish(file);
 assert.equal(h.copies,copies);assert.equal(h.deletes,deletes);assert.equal(h.records.get(parent).completedFiles,before.completedFiles);
 if(state==='error'){assert.equal(h.records.get(parent).status,'error');assert.equal(h.records.get(parent).errorMessage,before.errorMessage);assert.equal(h.records.get(key).status,'paused_global');assert.deepEqual(h.records.get(key).driveTransferPlan,fileBefore.driveTransferPlan);}
 else{assert.deepEqual(h.records.get(parent),before);assert.deepEqual(h.records.get(key),fileBefore);}
 assert.equal(h.list('submissionFiles').length,0);
});
for(const mutation of ['missing-parent','missing-file','foreign-company','foreign-uid','foreign-parent','wrong-storage-path'])await test('transfer pause rejects or ignores '+mutation+' without writes',async()=>{
 const h=harness(),s=await h.start(),file=s.files[0],parent='submissions/'+s.submissionId,key=parent+'/files/'+file.fileId;
 if(mutation==='missing-parent')h.records.delete(parent);
 if(mutation==='missing-file')h.records.delete(key);
 if(mutation==='foreign-company')h.records.get(key).companyId='foreign';
 if(mutation==='foreign-uid')h.records.get(key).uid='foreign';
 if(mutation==='foreign-parent')h.records.get(parent).companyId='foreign';
 if(mutation==='wrong-storage-path')h.records.get(key).storagePath+='-other';
 pauseTransfers(h);const before=JSON.stringify([...h.records]);
 if(mutation.startsWith('missing'))await h.finish(file);else await assert.rejects(h.finish(file),{code:'failed-precondition'});
 assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.copies,0);assert.equal(h.deletes,0);
});
await test('transfer pause cannot overwrite completion committed concurrently',async()=>{
 const h=harness(),s=await h.start(),file=s.files[0],parent='submissions/'+s.submissionId,key=parent+'/files/'+file.fileId;
 pauseTransfers(h);h.beforeCommit=async()=>{h.beforeCommit=null;await h.updateRecord(key,{status:'completed',completionCounted:true,driveFileId:'preserved-id'});await h.updateRecord(parent,{status:'completed',completedFiles:1,jobStatusApplied:true});};
 await h.finish(file);
 assert.equal(h.records.get(parent).status,'completed');assert.equal(h.records.get(key).status,'completed');assert.equal(h.records.get(key).driveFileId,'preserved-id');
 assert.equal(h.copies,0);assert.equal(h.deletes,0);assert.equal(h.list('submissionFiles').length,0);
});
await test('transfer pause write failure is atomic and retains retryable source',async()=>{
 const h=harness(),s=await h.start(),file=s.files[0],parent='submissions/'+s.submissionId;
 pauseTransfers(h);const before=JSON.stringify([...h.records]);h.failWrite=w=>w.ref.path===parent;
 await assert.rejects(h.finish(file));assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.copies,0);assert.equal(h.deletes,0);
});
for(const mode of ['paused','', 'ACTIVE','invalid','acceptance'])await test('transfer configuration stops new and existing submissions: '+JSON.stringify(mode),async()=>{
 const h=harness(),s=await h.start(),file=s.files[0];
 h.env.APP_ENVIRONMENT='staging';h.env.LKC_SUBMISSION_TRANSFER_MODE=mode;
 const before=h.records.size;await assert.rejects(h.start(),{code:'failed-precondition'});assert.equal(h.records.size,before);
 await h.finish(file);const saved=h.records.get('submissions/'+s.submissionId+'/files/'+file.fileId);
 assert.equal(saved.status,'paused_global');assert.equal(saved.pausedTransferSource.generation,'1');
 assert.equal(saved.pausedTransferSource.md5,'00000000000000000000000000000000');
 assert.equal((await h.state(s.submissionId)).status,'paused_global');assert.equal(h.copies,0);assert.equal(h.deletes,0);
 h.env.LKC_SUBMISSION_TRANSFER_MODE='active';await h.finish(file);
 assert.equal((await h.state(s.submissionId)).status,'completed');assert.equal(h.copies,1);
});
for(const [environment,project,company,paused] of [
 ['staging','lip-knots-crew-staging','lkc-transfer-acceptance-20260908',false],
 ['production','lip-knots-crew-staging','lkc-transfer-acceptance-20260908',true],
 ['development','lip-knots-crew-staging','lkc-transfer-acceptance-20260908',true],
 ['','lip-knots-crew-staging','lkc-transfer-acceptance-20260908',true],
 ['staging','','lkc-transfer-acceptance-20260908',true],
 ['staging','other','lkc-transfer-acceptance-20260908',true],
 ['staging','lip-knots-crew-staging','synthetic-company',true],
 ['staging','lip-knots-crew-staging','lkc-transfer-acceptance-20260908-other',true],
])await test('acceptance isolation: '+[environment,project,company].join('/'),async()=>{
 const h=harness();Object.assign(h.env,{APP_ENVIRONMENT:environment,EXPECTED_FIREBASE_PROJECT_ID:project,LKC_SUBMISSION_TRANSFER_MODE:'acceptance'});
 assert.equal(await h.loadModule('./submission-transfer-control').submissionTransferPaused(company),paused);
});
await test('active transfer configuration cannot bypass production emergency lock',async()=>{
 const h=harness(),s=await h.start();pauseTransfers(h);h.env.LKC_SUBMISSION_TRANSFER_MODE='active';
 await assert.rejects(h.start(),{code:'failed-precondition'});await h.finish(s.files[0]);
 assert.equal((await h.state(s.submissionId)).status,'paused_global');assert.equal(h.copies,0);
});
for(const patch of [{generation:2},{size:101},{contentType:'image/jpeg'},{md5Hash:'AQEBAQEBAQEBAQEBAQEBAQ=='},{bucket:'other-bucket'}])for(const resumed of [false,true])await test('paused source cannot switch content '+JSON.stringify(patch)+' resumed='+resumed,async()=>{
 const h=harness(),s=await h.start(),file=s.files[0];h.env.LKC_SUBMISSION_TRANSFER_MODE='paused';await h.finish(file);
 const before=JSON.stringify([...h.records]);if(resumed)h.env.LKC_SUBMISSION_TRANSFER_MODE='active';
 await assert.rejects(h.finish(file,patch),{code:'failed-precondition'});
 assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.copies,0);assert.equal(h.deletes,0);
});
await test('paused source survives lost Drive response and reuses the planned ID',async()=>{
 const h=harness(),s=await h.start(),file=s.files[0],key='submissions/'+s.submissionId+'/files/'+file.fileId;
 h.env.LKC_SUBMISSION_TRANSFER_MODE='paused';await h.finish(file);const source=copy(h.records.get(key).pausedTransferSource);
 h.env.LKC_SUBMISSION_TRANSFER_MODE='active';h.loseCopyResponse=true;await assert.rejects(h.finish(file));
 const plan=copy(h.records.get(key).driveTransferPlan);h.loseCopyResponse=false;
 h.env.LKC_SUBMISSION_TRANSFER_MODE='paused';await h.finish(file);
 assert.deepEqual(h.records.get(key).pausedTransferSource,source);assert.deepEqual(h.records.get(key).driveTransferPlan,plan);
 h.env.LKC_SUBMISSION_TRANSFER_MODE='active';await h.finish(file);await h.finish(file);
 assert.equal(h.copies,1);assert.equal(h.records.get(key).driveFileId,plan.id);assert.equal((await h.state(s.submissionId)).completedFiles,1);
});
await test('initial report -> admin review -> replacement -> comparison -> completed',async()=>{
  const h=harness(),initial=await h.start();await h.finish(initial.files[0]);assert.equal((await h.state(initial.submissionId)).status,'completed');
  const created=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',sourceSubmissionId:initial.submissionId,sourceFileId:initial.files[0].fileId,reasons:['その他']}});
  await assert.rejects(h.requests.completeResubmissionRequest({auth:h.admin,data:created}),{code:'failed-precondition'});
  const replacement=await h.start(1,{purpose:'replacement',resubmissionRequestId:created.requestId});await h.finish(replacement.files[0]);
  const comparison=await h.views.getResubmissionComparison({auth:h.admin,data:created});assert.equal(comparison.request.status,'submitted');assert.equal(comparison.source.id,initial.files[0].fileId);assert.equal(comparison.replacements.length,1);assert.equal(comparison.replacements[0].replacesFileId,initial.files[0].fileId);
  await h.requests.completeResubmissionRequest({auth:h.admin,data:created});assert.equal(h.records.get(`resubmissionRequests/${created.requestId}`).status,'completed');
  const timeline=await h.views.getSubmissionTimeline({auth:h.admin,data:{jobId:'synthetic-job',type:'report'}});assert.equal(timeline.submissions.length,2);assert.equal(h.driveFiles.size,2);await h.finish(replacement.files[0]);assert.equal(h.records.get(`resubmissionRequests/${created.requestId}`).status,'completed');assert.equal(h.records.get(`resubmissionRequests/${created.requestId}`).replacementFiles.length,1);assert.equal(h.driveFiles.size,2);
  for(const name of ['./uploads','./resubmissions','./submission-status','./submission-files','./utils','./notification-core'])assert.ok(h.loaded.includes(name));
});
await test('duplicate first file must not prematurely complete a two-file submission',async()=>{
  const h=harness(),s=await h.start(2);await h.finish(s.files[0]);await h.finish(s.files[0]);const state=await h.state(s.submissionId);assert.equal(state.completedFiles,1);assert.equal(state.status,'uploading');assert.equal(h.copies,1);assert.equal(h.list('sheetSyncQueue').length,0);
  await h.finish(s.files[1]);await h.finish(s.files[1]);assert.equal((await h.state(s.submissionId)).completedFiles,2);assert.equal(h.copies,2);assert.equal(h.list('sheetSyncQueue').length,1);
});
await test('cleanup failure preserves completed status and replay reuses copied file',async()=>{
  const h=harness(),s=await h.start();h.failDelete=true;await assert.rejects(h.finish(s.files[0]));assert.equal((await h.state(s.submissionId)).status,'completed');h.failDelete=false;await h.finish(s.files[0]);assert.equal(h.copies,1);assert.equal((await h.state(s.submissionId)).completedFiles,1);assert.equal(h.list('sheetSyncQueue').length,1);
});
await test('post-copy bookkeeping failure resumes without recopy or duplicate counting',async()=>{
  const h=harness(),s=await h.start();let fail=true;h.failWrite=w=>fail&&w.ref.path.startsWith('sheetSyncQueue/');await assert.rejects(h.finish(s.files[0]));fail=false;await h.finish(s.files[0]);assert.equal(h.copies,1);assert.equal((await h.state(s.submissionId)).completedFiles,1);assert.equal((await h.state(s.submissionId)).errorMessage,null);assert.equal(h.list('sheetSyncQueue').length,1);
});
await test('sales-floor submission remains separate and foreign staff cannot submit or read',async()=>{
  const h=harness(),s=await h.start(1,{type:'sales_floor'});await h.finish(s.files[0]);const job=h.records.get('jobs/synthetic-job');assert.equal(job.submissionStatus.salesFloor.completed,true);assert.equal(job.submissionStatus.report,undefined);
  h.staff={uid:'foreign',token:{companyId:'synthetic-company',staffId:'foreign',role:'staff'}};await assert.rejects(h.start(),{code:'permission-denied'});await assert.rejects(h.state(s.submissionId),{code:'permission-denied'});
});

await test('another successful file does not erase an unresolved transfer failure',async()=>{
  const h=harness(),s=await h.start(2);h.failCopy=true;await assert.rejects(h.finish(s.files[0]));h.failCopy=false;await h.finish(s.files[1]);assert.equal((await h.state(s.submissionId)).status,'error');assert.ok((await h.state(s.submissionId)).errorMessage);await h.finish(s.files[0]);assert.equal((await h.state(s.submissionId)).status,'completed');assert.equal((await h.state(s.submissionId)).errorMessage,null);
});
await test('legacy transfer without accounting checkpoint stops before mutation',async()=>{
  const h=harness(),s=await h.start();const key=`submissions/${s.submissionId}/files/${s.files[0].fileId}`;const old=h.records.get(key);old.driveFileId='legacy-id';old.status='completed';const before=JSON.stringify([...h.records]);await assert.rejects(h.finish(s.files[0]),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.copies,0);
});


await test('lost Drive create response retries the persisted ID without duplicate data',async()=>{
  const h=harness(),s=await h.start();h.loseCopyResponse=true;await assert.rejects(h.finish(s.files[0]));h.loseCopyResponse=false;await h.finish(s.files[0]);assert.equal(h.copies,1);assert.equal(h.driveFiles.size,1);assert.equal((await h.state(s.submissionId)).completedFiles,1);
});
await test('Drive success followed by checkpoint failure reuses persisted ID and sequence',async()=>{
  const h=harness(),s=await h.start();h.failWrite=w=>!!w.data.transferCompletedAt;await assert.rejects(h.finish(s.files[0]));h.failWrite=null;await h.finish(s.files[0]);assert.equal(h.copies,1);assert.equal(h.list('fileCounters')[0].value,1);
});
await test('two overlapping events share one Drive ID and accounting result',async()=>{
  const h=harness(),s=await h.start();let arrivals=0,release;const gate=new Promise(r=>release=r);h.beforeCopy=async()=>{if(++arrivals===2)release();await gate;};
  await Promise.all([h.finish(s.files[0]),h.finish(s.files[0])]);assert.equal(h.copies,1);assert.equal(h.driveFiles.size,1);assert.equal(h.list('fileCounters')[0].value,1);assert.equal((await h.state(s.submissionId)).completedFiles,1);assert.equal(h.list('sheetSyncQueue').length,1);
});
await test('late losing worker cannot erase successful completion',async()=>{
  const h=harness(),s=await h.start();let release,reached;const gate=new Promise(r=>release=r),entered=new Promise(r=>reached=r);
  h.afterCopy=async()=>{reached();await gate;throw new Error('late lost response');};const losing=h.finish(s.files[0]);await entered;h.afterCopy=null;await h.finish(s.files[0]);release();await assert.rejects(losing);assert.equal((await h.state(s.submissionId)).status,'completed');assert.equal(h.list('sheetSyncQueue').length,1);
});
await test('conflicting Drive metadata is rejected without accounting or source deletion',async()=>{
  const h=harness(),s=await h.start();h.conflictMismatch=true;await assert.rejects(h.finish(s.files[0]));assert.equal((await h.state(s.submissionId)).completedFiles,0);assert.equal(h.deletes,0);
});
await test('Drive lookup permission failure does not fall back to create',async()=>{
  const h=harness(),s=await h.start();h.getError=403;await assert.rejects(h.finish(s.files[0]));assert.equal(h.copies,0);assert.equal(h.deletes,0);
});
await test('different object generation cannot reuse the reserved transfer',async()=>{
  const h=harness(),s=await h.start();await h.finish(s.files[0]);await assert.rejects(h.finish(s.files[0],{generation:'2'}));assert.equal(h.copies,1);assert.equal((await h.state(s.submissionId)).completedFiles,1);
});


for (const [field,value] of Object.entries({id:'other',name:'other',parents:['other'],mimeType:'application/pdf',size:'101',md5Checksum:'ffffffffffffffffffffffffffffffff',appProperties:{lkcTransfer:'other'},trashed:true,createdTime:'invalid'})) {
  await test(`recovery rejects mismatched Drive field: ${field}`,async()=>{
    const h=harness(),s=await h.start();h.loseCopyResponse=true;await assert.rejects(h.finish(s.files[0]));h.loseCopyResponse=false;
    const remote=[...h.driveFiles.values()][0];remote[field]=value;await assert.rejects(h.finish(s.files[0]));assert.equal(h.copies,1);assert.equal(h.deletes,0);assert.equal((await h.state(s.submissionId)).completedFiles,0);
  });
}
for (const patch of [{generation:''},{md5Hash:''},{size:'0'},{size:'101'},{contentType:'application/vnd.google-apps.document'}]) {
  await test(`invalid source rejected before reservation: ${JSON.stringify(patch)}`,async()=>{
    const h=harness(),s=await h.start();await assert.rejects(h.finish(s.files[0],patch));assert.equal(h.copies,0);assert.equal(h.list('fileCounters').length,0);
  });
}
await test('reservation failure cannot upload an unpersisted Drive ID',async()=>{
  const h=harness(),s=await h.start();h.failWrite=w=>!!w.data.driveTransferPlan;await assert.rejects(h.finish(s.files[0]));assert.equal(h.copies,0);assert.equal(h.list('fileCounters').length,0);h.failWrite=null;await h.finish(s.files[0]);assert.equal(h.copies,1);assert.equal(h.list('fileCounters')[0].value,1);
});


await test('completed replay does not regress the file into processing',async()=>{
  const h=harness(),s=await h.start();await h.finish(s.files[0]);h.failWrite=w=>w.data.status==='processing';await h.finish(s.files[0]);assert.equal((await h.state(s.submissionId)).status,'completed');assert.equal(h.copies,1);
});

for(const [target,field,value] of [['submission','companyId','foreign'],['submission','jobId','foreign'],['submission','uid','foreign'],['submission','staffId','foreign'],['submission','type','sales_floor'],['job','companyId','foreign'],['job','assignedStaffId','foreign'],['staff','companyId','foreign']]){
 await test('reject broken submission relation before transfer: '+target+'.'+field,async()=>{
  const h=harness(),s=await h.start();const key=target==='submission'?'submissions/'+s.submissionId:target==='job'?'jobs/synthetic-job':'staffProfiles/synthetic-staff';h.records.get(key)[field]=value;
  await assert.rejects(h.finish(s.files[0]));assert.equal(h.copies,0);assert.equal(h.deletes,0);assert.equal(h.list('sheetSyncQueue').length,0);
 });
}
await test('deleted replacement request cannot be recreated by late upload',async()=>{
 const h=harness(),initial=await h.start();await h.finish(initial.files[0]);const r=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}});const s=await h.start(1,{purpose:'replacement',resubmissionRequestId:r.requestId});h.records.delete('resubmissionRequests/'+r.requestId);
 await assert.rejects(h.finish(s.files[0]));assert.equal(h.records.has('resubmissionRequests/'+r.requestId),false);assert.equal(h.copies,1);
});
await test('two replacement sessions cannot overwrite one request',async()=>{
 const h=harness(),r=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}});const a=await h.start(1,{purpose:'replacement',resubmissionRequestId:r.requestId}),b=await h.start(1,{purpose:'replacement',resubmissionRequestId:r.requestId});await h.finish(a.files[0]);await assert.rejects(h.finish(b.files[0]));assert.equal(h.records.get('resubmissionRequests/'+r.requestId).replacementSubmissionId,a.submissionId);assert.equal(h.copies,1);
});
await test('foreign source submission cannot be attached to an admin request',async()=>{
 const h=harness(),s=await h.start();await h.finish(s.files[0]);h.records.get('submissions/'+s.submissionId).companyId='foreign';
 await assert.rejects(h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',sourceSubmissionId:s.submissionId,reasons:['その他']}}));assert.equal(h.list('resubmissionRequests').length,0);
});
await test('post-transfer reassignment cannot complete the new staff job',async()=>{
 const h=harness(),s=await h.start();h.afterCopy=async()=>{h.records.get('jobs/synthetic-job').assignedStaffId='another-staff';};await assert.rejects(h.finish(s.files[0]));assert.equal(h.records.get('jobs/synthetic-job').submissionStatus,undefined);assert.equal(h.list('sheetSyncQueue').length,0);assert.equal(h.deletes,0);
 h.afterCopy=null;h.records.get('jobs/synthetic-job').assignedStaffId='synthetic-staff';await h.finish(s.files[0]);assert.equal(h.copies,1);assert.equal(h.list('sheetSyncQueue').length,1);
});
await test('missing job does not silently finish and remove source',async()=>{
 const h=harness(),s=await h.start();h.afterCopy=async()=>{h.records.delete('jobs/synthetic-job');};await assert.rejects(h.finish(s.files[0]));assert.equal(h.deletes,0);assert.equal(h.records.get('submissions/'+s.submissionId).jobStatusApplied,undefined);
});
await test('job completion rejects incomplete parent counters',async()=>{
 const h=harness(),s=await h.start(2);await assert.rejects(h.status.markSubmissionCompleted({submissionId:s.submissionId,jobId:'synthetic-job',type:'report',submittedAt:Timestamp.now()}));assert.equal(h.list('sheetSyncQueue').length,0);
});
await test('job completion cannot target another job',async()=>{
 const h=harness(),s=await h.start();await h.finish(s.files[0]);h.records.get('submissions/'+s.submissionId).jobStatusApplied=false;h.records.set('jobs/other',{companyId:'synthetic-company',assignedStaffId:'synthetic-staff'});await assert.rejects(h.status.markSubmissionCompleted({submissionId:s.submissionId,jobId:'other',type:'report',submittedAt:Timestamp.now()}));assert.equal(h.records.get('jobs/other').submissionStatus,undefined);
});


for(const value of [0,-1,21,1.5,'1'])await test('invalid total count never transfers: '+value,async()=>{const h=harness(),s=await h.start();h.records.get('submissions/'+s.submissionId).totalFiles=value;await assert.rejects(h.finish(s.files[0]));assert.equal(h.copies,0);assert.equal(h.deletes,0);});
await test('concurrent replacement sessions reserve only one request owner',async()=>{
 const h=harness(),r=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}}),a=await h.start(1,{purpose:'replacement',resubmissionRequestId:r.requestId}),b=await h.start(1,{purpose:'replacement',resubmissionRequestId:r.requestId});
 let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);h.beforeCopy=async()=>{entered();await gate;};const running=h.finish(a.files[0]);await ready;await assert.rejects(h.finish(b.files[0]));release();await running;assert.equal(h.copies,1);assert.equal(h.records.get('resubmissionRequests/'+r.requestId).replacementSubmissionId,a.submissionId);
});
await test('replacement deleted during copy is not recreated and retains source',async()=>{
 const h=harness(),r=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}}),s=await h.start(1,{purpose:'replacement',resubmissionRequestId:r.requestId});h.afterCopy=async()=>h.records.delete('resubmissionRequests/'+r.requestId);await assert.rejects(h.finish(s.files[0]));assert.equal(h.records.has('resubmissionRequests/'+r.requestId),false);assert.equal(h.deletes,0);
});
await test('admin completion validates replacement and repeated completion is harmless',async()=>{
 const h=harness(),r=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}}),s=await h.start(1,{purpose:'replacement',resubmissionRequestId:r.requestId});await h.finish(s.files[0]);const parent=h.records.get('submissions/'+s.submissionId);parent.jobStatusApplied=false;await assert.rejects(h.requests.completeResubmissionRequest({auth:h.admin,data:r}));parent.jobStatusApplied=true;await h.requests.completeResubmissionRequest({auth:h.admin,data:r});const before=JSON.stringify(h.records.get('resubmissionRequests/'+r.requestId));await h.requests.completeResubmissionRequest({auth:h.admin,data:r});assert.equal(JSON.stringify(h.records.get('resubmissionRequests/'+r.requestId)),before);
});
await test('upload captures the accepted holiday deadline and rule version',async()=>{
 const h=harness(),s=await h.start();const policy=h.records.get('submissions/'+s.submissionId).deadlinePolicy;
 assert.equal(policy.status,'known');assert.equal(policy.workDate,'2026-09-20');
 assert.equal(policy.ruleVersion,'jp-business-day-11-v1');assert.equal(policy.dueAtMs,Date.parse('2026-09-24T02:00:00Z'));
 h.driveCreatedAt='2026-09-24T02:00:00Z';await h.finish(s.files[0]);
 const report=h.records.get('jobs/synthetic-job').submissionStatus.report;assert.equal(report.lateFirstSubmission,false);assert.equal(report.deadlineReviewRequired,false);assert.equal(report.deadlinePolicy.dueAtMs,policy.dueAtMs);
});
await test('additional submission retains the original deadline policy',async()=>{
 const h=harness(),a=await h.start();h.driveCreatedAt='2026-09-25T02:00:00Z';await h.finish(a.files[0]);
 const original=h.records.get('jobs/synthetic-job').submissionStatus.report.deadlinePolicy;
 const b=await h.start(1,{purpose:'additional'});h.records.get('submissions/'+b.submissionId).deadlinePolicy.dueAtMs=Date.parse('2026-09-28T02:00:00Z');
 h.driveCreatedAt='2026-09-26T02:00:00Z';await h.finish(b.files[0]);
 const report=h.records.get('jobs/synthetic-job').submissionStatus.report;assert.equal(report.deadlinePolicy.dueAtMs,original.dueAtMs);assert.equal(report.lateFirstSubmission,true);
});
await test('legacy first submission retains its lateness without inventing a policy',async()=>{
 const h=harness(),a=await h.start();h.driveCreatedAt='2026-09-20T02:00:00Z';await h.finish(a.files[0]);
 const original=h.records.get('jobs/synthetic-job').submissionStatus.report;delete original.deadlinePolicy;original.lateFirstSubmission=true;
 const b=await h.start(1,{purpose:'additional'});h.driveCreatedAt='2026-09-25T02:00:00Z';await h.finish(b.files[0]);
 const report=h.records.get('jobs/synthetic-job').submissionStatus.report;assert.equal(report.lateFirstSubmission,true);assert.equal(report.deadlinePolicy.status,'unrecorded');assert.equal(report.deadlineReviewRequired,true);
});
await test('unpublished calendar does not prevent storage or invent timely submission',async()=>{
 const h=harness();h.records.get('jobs/synthetic-job').dateKey='2099-09-20';h.driveCreatedAt='2099-09-20T02:00:00Z';const s=await h.start();await h.finish(s.files[0]);
 const report=h.records.get('jobs/synthetic-job').submissionStatus.report;assert.equal(report.completed,true);assert.equal(report.lateFirstSubmission,undefined);assert.equal(report.deadlinePolicy.status,'unavailable');assert.equal(report.deadlineReviewRequired,true);
});
await test('legacy pending transfer completes without guessing its original deadline',async()=>{
 const h=harness(),s=await h.start();delete h.records.get('submissions/'+s.submissionId).deadlinePolicy;await h.finish(s.files[0]);
 const report=h.records.get('jobs/synthetic-job').submissionStatus.report;assert.equal(report.completed,true);assert.equal(report.lateFirstSubmission,undefined);assert.equal(report.deadlinePolicy.status,'unrecorded');assert.equal(report.deadlineReviewRequired,true);
});
await test('changed work date preserves the recorded deadline and requests review',async()=>{
 const h=harness(),s=await h.start();h.records.get('jobs/synthetic-job').dateKey='2026-09-25';await h.finish(s.files[0]);
 const report=h.records.get('jobs/synthetic-job').submissionStatus.report;assert.equal(report.deadlinePolicy.workDate,'2026-09-20');assert.equal(report.deadlineReviewRequired,true);
});

await test('additional late report preserves late first submission in queued sheet status',async()=>{
 const h=harness();h.driveCreatedAt='2026-09-25T02:00:00.000Z';const a=await h.start();await h.finish(a.files[0]);h.driveCreatedAt='2026-09-26T02:00:00.000Z';const b=await h.start(1,{purpose:'additional'});await h.finish(b.files[0]);assert.equal(h.records.get('jobs/synthetic-job').submissionStatus.report.lateFirstSubmission,true);assert.equal(h.list('sheetSyncQueue').at(-1).updates.reportSubmitted,'遅延');
});
await test('recovery of older transfer keeps earliest and latest submission chronology',async()=>{
 const h=harness(),a=await h.start();h.failWrite=w=>w.ref.path.startsWith('sheetSyncQueue/');await assert.rejects(h.finish(a.files[0]));h.failWrite=null;h.driveCreatedAt='2026-09-25T02:00:00.000Z';const b=await h.start(1,{purpose:'additional'});await h.finish(b.files[0]);await h.finish(a.files[0]);const report=h.records.get('jobs/synthetic-job').submissionStatus.report;assert.equal(report.firstCompletedAt.toDate().toISOString(),'2026-09-20T02:00:00.000Z');assert.equal(report.latestCompletedAt.toDate().toISOString(),'2026-09-25T02:00:00.000Z');assert.equal(h.copies,2);
});


for(const target of ['parent','file'])await test('deleted '+target+' during transfer is never recreated',async()=>{const h=harness(),s=await h.start();const key='submissions/'+s.submissionId+(target==='file'?'/files/'+s.files[0].fileId:'');h.afterCopy=async()=>h.records.delete(key);await assert.rejects(h.finish(s.files[0]));assert.equal(h.records.has(key),false);assert.equal(h.deletes,0);});
await test('already full counter with uncounted file stops before transfer',async()=>{const h=harness(),s=await h.start();h.records.get('submissions/'+s.submissionId).completedFiles=1;await assert.rejects(h.finish(s.files[0]));assert.equal(h.copies,0);assert.equal(h.deletes,0);});


await test('legacy completed source remains available for admin resubmission review',async()=>{const h=harness(),s=await h.start();await h.finish(s.files[0]);delete h.records.get('submissions/'+s.submissionId+'/files/'+s.files[0].fileId).completionCounted;const r=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',sourceSubmissionId:s.submissionId,sourceFileId:s.files[0].fileId,reasons:['その他']}});assert.ok(r.requestId);assert.equal(h.copies,1);});
await test('foreign source file metadata cannot create a resubmission request',async()=>{const h=harness(),s=await h.start();await h.finish(s.files[0]);h.records.get('submissions/'+s.submissionId+'/files/'+s.files[0].fileId).companyId='foreign';await assert.rejects(h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',sourceSubmissionId:s.submissionId,sourceFileId:s.files[0].fileId,reasons:['その他']}}));assert.equal(h.list('resubmissionRequests').length,0);});


await test('parallel files of one replacement keep both files and one completion',async()=>{const h=harness(),r=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}}),s=await h.start(2,{purpose:'replacement',resubmissionRequestId:r.requestId});await Promise.all(s.files.map(f=>h.finish(f)));const request=h.records.get('resubmissionRequests/'+r.requestId);assert.equal(request.replacementFiles.length,2);assert.equal(request.status,'submitted');assert.equal((await h.state(s.submissionId)).completedFiles,2);assert.equal(h.copies,2);assert.equal(h.list('sheetSyncQueue').length,1);await h.requests.completeResubmissionRequest({auth:h.admin,data:r});});


for(const [name,change] of [['job deletion',h=>h.records.delete('jobs/synthetic-job')],['job company',h=>h.records.get('jobs/synthetic-job').companyId='other'],['job staff',h=>h.records.get('jobs/synthetic-job').assignedStaffId='other']])await test('create request rejects '+name+' before save',async()=>{const h=harness();h.beforeRequestWrite=async()=>{h.beforeRequestWrite=null;change(h);};await assert.rejects(h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}}));assert.equal(h.list('resubmissionRequests').length,0);});
await test('create request rechecks source company before save',async()=>{const h=harness(),initial=await h.start();await h.finish(initial.files[0]);h.beforeRequestWrite=async()=>{h.beforeRequestWrite=null;h.records.get('submissions/'+initial.submissionId).companyId='other';};await assert.rejects(h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',sourceSubmissionId:initial.submissionId,sourceFileId:initial.files[0].fileId,reasons:['その他']}}));assert.equal(h.list('resubmissionRequests').length,0);});

for(const mode of ['deleted','status'])await test('create request rechecks source file '+mode,async()=>{const h=harness(),initial=await h.start();await h.finish(initial.files[0]);const filePath='submissions/'+initial.submissionId+'/files/'+initial.files[0].fileId;h.beforeRequestWrite=async()=>{h.beforeRequestWrite=null;if(mode==='deleted')h.records.delete(filePath);else h.records.get(filePath).status='error';};await assert.rejects(h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',sourceSubmissionId:initial.submissionId,sourceFileId:initial.files[0].fileId,reasons:['その他']}}));assert.equal(h.list('resubmissionRequests').length,0);});

await test('request notification write failure leaves no orphan request',async()=>{const h=harness();h.failWrite=w=>w.ref.path.startsWith('notificationQueue/');await assert.rejects(h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}}));assert.equal(h.list('resubmissionRequests').length,0);assert.equal(h.list('notificationQueue').length,0);});

await test('request write failure leaves no orphan notification',async()=>{const h=harness();h.failWrite=w=>w.ref.path.startsWith('resubmissionRequests/');await assert.rejects(h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}}));assert.equal(h.list('resubmissionRequests').length,0);assert.equal(h.list('notificationQueue').length,0);});
await test('request notification preserves target route and deterministic ID',async()=>{const h=harness(),r=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他'],note:'synthetic'}});const notices=h.list('notificationQueue');assert.equal(notices.length,1);const n=notices[0];assert.equal(n.id,'nq_'+crypto.createHash('sha256').update('synthetic-company|staff:synthetic-staff|resubmission_request|'+r.requestId).digest('hex').slice(0,36));assert.equal(n.targetStaffId,'synthetic-staff');assert.equal(n.route,'/resubmissions/'+r.requestId);assert.equal(n.body,'その他 / synthetic');assert.equal(n.status,'queued');});

for(const field of ['companyId','jobId','type'])await test('comparison rejects mismatched source '+field+' without issuing preview',async()=>{
 const h=harness(),initial=await h.start();await h.finish(initial.files[0]);const request=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',sourceSubmissionId:initial.submissionId,sourceFileId:initial.files[0].fileId,reasons:['その他']}});
 h.records.get('submissions/'+initial.submissionId)[field]='foreign';const before=h.list('filePreviewTokens').length;
 await assert.rejects(h.views.getResubmissionComparison({auth:h.admin,data:request}));assert.equal(h.list('filePreviewTokens').length,before);
});
for(const field of ['companyId','submissionId','staffId'])await test('comparison rejects source file identity '+field,async()=>{
 const h=harness(),initial=await h.start();await h.finish(initial.files[0]);const request=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',sourceSubmissionId:initial.submissionId,sourceFileId:initial.files[0].fileId,reasons:['その他']}});
 h.records.get('submissions/'+initial.submissionId+'/files/'+initial.files[0].fileId)[field]='foreign';
 await assert.rejects(h.views.getResubmissionComparison({auth:h.admin,data:request}));assert.equal(h.list('filePreviewTokens').length,0);
});
await test('comparison rejects replacement linked to a different request before source preview',async()=>{
 const h=harness(),initial=await h.start();await h.finish(initial.files[0]);const request=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',sourceSubmissionId:initial.submissionId,sourceFileId:initial.files[0].fileId,reasons:['その他']}});
 const replacement=await h.start(1,{purpose:'replacement',resubmissionRequestId:request.requestId});await h.finish(replacement.files[0]);h.records.get('submissions/'+replacement.submissionId).resubmissionRequestId='foreign';
 await assert.rejects(h.views.getResubmissionComparison({auth:h.admin,data:request}));assert.equal(h.list('filePreviewTokens').length,0);
});
await test('comparison denies former staff after reassignment',async()=>{
 const h=harness(),request=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}});h.records.get('jobs/synthetic-job').assignedStaffId='new-staff';
 await assert.rejects(h.views.getResubmissionComparison({auth:h.staff,data:request}),{code:'permission-denied'});
});
await test('timeline rejects mismatched file before any previews',async()=>{
 const h=harness(),initial=await h.start(2);await h.finish(initial.files[0]);await h.finish(initial.files[1]);h.records.get('submissions/'+initial.submissionId+'/files/'+initial.files[1].fileId).companyId='foreign';
 await assert.rejects(h.views.getSubmissionTimeline({auth:h.admin,data:{jobId:'synthetic-job',type:'report'}}));assert.equal(h.list('filePreviewTokens').length,0);
});

for(const missing of ['parent','file'])await test('comparison source deletion '+missing,async()=>{
 const h=harness(),initial=await h.start();await h.finish(initial.files[0]);const request=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',sourceSubmissionId:initial.submissionId,sourceFileId:initial.files[0].fileId,reasons:['その他']}});
 h.records.delete('submissions/'+initial.submissionId+(missing==='file'?'/files/'+initial.files[0].fileId:''));
 if(missing==='parent')await assert.rejects(h.views.getResubmissionComparison({auth:h.admin,data:request}));
 else assert.equal((await h.views.getResubmissionComparison({auth:h.admin,data:request})).source,null);
 assert.equal(h.list('filePreviewTokens').length,0);
});
await test('comparison without source remains readable by assigned staff',async()=>{
 const h=harness(),request=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}});
 const result=await h.views.getResubmissionComparison({auth:h.staff,data:request});assert.equal(result.request.id,request.requestId);assert.equal(result.source,null);assert.equal(result.replacements.length,0);
});
for(const field of ['companyId','jobId','staffId','type'])await test('comparison replacement parent '+field+' mismatch issues no token',async()=>{
 const h=harness(),request=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}});
 const replacement=await h.start(1,{purpose:'replacement',resubmissionRequestId:request.requestId});await h.finish(replacement.files[0]);h.records.get('submissions/'+replacement.submissionId)[field]='foreign';
 await assert.rejects(h.views.getResubmissionComparison({auth:h.admin,data:request}));assert.equal(h.list('filePreviewTokens').length,0);
});

for(const [total,completed] of [[0,0],[2,3],[2,-1],[2,0.5],['2',1],[2,'1']])await test('processing status rejects invalid counters '+JSON.stringify([total,completed]),async()=>{
 const h=harness(),session=await h.start();Object.assign(h.records.get('submissions/'+session.submissionId),{totalFiles:total,completedFiles:completed});await assert.rejects(h.state(session.submissionId),{code:'failed-precondition'});
});
await test('processing status waits for job status application',async()=>{
 const h=harness(),session=await h.start();await h.finish(session.files[0]);h.records.get('submissions/'+session.submissionId).jobStatusApplied=false;
 assert.equal((await h.state(session.submissionId)).status,'processing');
});
await test('processing status rejects premature completed counter',async()=>{
 const h=harness(),session=await h.start(2);Object.assign(h.records.get('submissions/'+session.submissionId),{status:'completed',completedFiles:1,jobStatusApplied:true});await assert.rejects(h.state(session.submissionId),{code:'failed-precondition'});
});
for(const mode of ['open','foreign','missing'])await test('processing status checks replacement request '+mode,async()=>{
 const h=harness(),request=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}});
 const session=await h.start(1,{purpose:'replacement',resubmissionRequestId:request.requestId});await h.finish(session.files[0]);const key='resubmissionRequests/'+request.requestId;
 if(mode==='missing')h.records.delete(key);else if(mode==='foreign')h.records.get(key).companyId='foreign';else Object.assign(h.records.get(key),{status:'open',replacementSubmissionId:null});
 if(mode==='open')assert.equal((await h.state(session.submissionId)).status,'processing');else await assert.rejects(h.state(session.submissionId),{code:'failed-precondition'});
});

for(const mode of ['valid','expired','inactive','file-missing','parent-missing','parent-company','file-company','file-submission','drive-changed','file-status'])await test('preview gateway rechecks source '+mode,async()=>{
 const h=harness(),session=await h.start();await h.finish(session.files[0]);const parent='submissions/'+session.submissionId,file=parent+'/files/'+session.files[0].fileId,raw='synthetic-preview-token-that-is-long-enough-123';
 const token={companyId:'synthetic-company',submissionId:session.submissionId,fileId:session.files[0].fileId,driveFileId:h.records.get(file).driveFileId,active:true,expiresAt:Timestamp.fromMillis(Date.now()+60000),contentType:'image/png',fileName:'synthetic.png'};
 if(mode==='expired')token.expiresAt=Timestamp.fromMillis(1);if(mode==='inactive')token.active=false;
 if(mode==='file-missing')h.records.delete(file);if(mode==='parent-missing')h.records.delete(parent);
 if(mode==='parent-company')h.records.get(parent).companyId='foreign';if(mode==='file-company')h.records.get(file).companyId='foreign';if(mode==='file-submission')h.records.get(file).submissionId='foreign';if(mode==='drive-changed')h.records.get(file).driveFileId='changed';if(mode==='file-status')h.records.get(file).status='error';
 h.records.set('filePreviewTokens/'+crypto.createHash('sha256').update(raw).digest('hex'),token);
 const response={code:200,headersSent:false,status(code){this.code=code;return this;},send(){return this;},setHeader(){},end(){}};
 await h.views.driveFilePreview({query:{token:raw}},response);
 assert.equal(response.code,mode==='valid'?200:410);assert.equal(h.previewReads??0,mode==='valid'?1:0);
});

for(const count of [0,1,100,101,150])await test('timeline returns latest 100 of '+count+' submissions',async()=>{
 const h=harness();for(let i=0;i<count;i++)h.records.set('submissions/history-'+String(i).padStart(3,'0'),{companyId:'synthetic-company',jobId:'synthetic-job',type:'report',staffId:'synthetic-staff',uid:'synthetic-user',createdAt:Timestamp.fromMillis(1000+i),status:'uploading',purpose:'additional'});
 h.records.set('submissions/foreign',{companyId:'foreign',jobId:'synthetic-job',type:'report',createdAt:Timestamp.fromMillis(999999)});
 const result=await h.views.getSubmissionTimeline({auth:h.staff,data:{jobId:'synthetic-job',type:'report'}});
 assert.equal(result.submissions.length,Math.min(100,count));
 assert.deepEqual(Array.from(result.submissions,x=>x.id),Array.from({length:Math.min(100,count)},(_,index)=>'history-'+String(count-1-index).padStart(3,'0')));
});

for(const submitted of [0,99,100,150])await test('open staff task survives '+submitted+' submitted requests',async()=>{
 const h=harness();for(let i=0;i<submitted;i++)h.records.set('resubmissionRequests/old-'+i,{companyId:'synthetic-company',staffId:'synthetic-staff',jobId:'synthetic-job',type:'report',status:'submitted',createdAt:Timestamp.now()});
 h.records.set('resubmissionRequests/actionable',{companyId:'synthetic-company',staffId:'synthetic-staff',jobId:'synthetic-job',type:'report',status:'open',reasons:['その他'],createdAt:Timestamp.now()});
 h.records.set('resubmissionRequests/foreign',{companyId:'other',staffId:'synthetic-staff',jobId:'synthetic-job',type:'report',status:'open',createdAt:Timestamp.now()});
 const result=await h.tasks.getMyTasks({auth:h.staff,data:{}});const requests=result.tasks.filter(task=>task.kind==='resubmission');assert.equal(requests.length,1);assert.equal(requests[0].metadata.requestId,'actionable');
});

for(const target of ['sheetSyncQueue/','notificationQueue/'])await test('netprint update atomically saves '+target,async()=>{
 const h=harness(),before=JSON.stringify(h.records.get('jobs/synthetic-job'));h.failWrite=w=>w.ref.path.startsWith(target);
 await assert.rejects(h.netprint.updateNetPrintNumbers({auth:h.admin,data:{jobId:'synthetic-job',numbers:['12345678']}}));assert.equal(JSON.stringify(h.records.get('jobs/synthetic-job')),before);assert.equal(h.list('sheetSyncQueue').length,0);assert.equal(h.list('notificationQueue').length,0);
});
function printedJob(h,printed=false){h.records.get('jobs/synthetic-job').netPrint={items:[{id:'item',number:'12345678',position:1,version:1,printed,...(printed?{printedAt:Timestamp.fromMillis(1234)}:{})}]};}
await test('netprint printed atomic queue failure',async()=>{const h=harness();printedJob(h);const before=JSON.stringify(h.records.get('jobs/synthetic-job'));h.failWrite=w=>w.ref.path.startsWith('sheetSyncQueue/');await assert.rejects(h.netprint.markNetPrintPrinted({auth:h.staff,data:{jobId:'synthetic-job',itemId:'item'}}));assert.equal(JSON.stringify(h.records.get('jobs/synthetic-job')),before);});
await test('netprint printed replay preserves first time and queue count',async()=>{const h=harness();printedJob(h);await h.netprint.markNetPrintPrinted({auth:h.staff,data:{jobId:'synthetic-job',itemId:'item'}});const first=JSON.stringify(h.records.get('jobs/synthetic-job'));await h.netprint.markNetPrintPrinted({auth:h.staff,data:{jobId:'synthetic-job',itemId:'item'}});assert.equal(JSON.stringify(h.records.get('jobs/synthetic-job')),first);assert.equal(h.list('sheetSyncQueue').length,1);});
await test('netprint printed sync guards exact number',async()=>{const h=harness();printedJob(h);await h.netprint.markNetPrintPrinted({auth:h.staff,data:{jobId:'synthetic-job',itemId:'item'}});assert.equal(h.list('sheetSyncQueue')[0].expected?.netPrint1?.value,'12345678');});
await test('netprint unchanged current-owner printed number retains sheet highlight',async()=>{const h=harness();printedJob(h);await h.netprint.markNetPrintPrinted({auth:h.staff,data:{jobId:'synthetic-job',itemId:'item'}});const proof=h.records.get('jobs/synthetic-job').netPrint.items[0].printOperationId;await h.netprint.updateNetPrintNumbers({auth:h.admin,data:{jobId:'synthetic-job',numbers:['12345678']}});assert.equal(h.records.get('jobs/synthetic-job').netPrint.items[0].printed,true);assert.equal(h.records.get('jobs/synthetic-job').netPrint.items[0].printOperationId,proof);assert.equal(h.list('sheetSyncQueue').find(queue=>queue.operation==='netprint.update').styles.netPrint1.background,'#fff2cc');});
await test('netprint legacy printed registration requires current-owner reconfirmation',async()=>{const h=harness();printedJob(h,true);await h.netprint.updateNetPrintNumbers({auth:h.admin,data:{jobId:'synthetic-job',numbers:['12345678']}});const item=h.records.get('jobs/synthetic-job').netPrint.items[0];assert.equal(item.printed,false);assert.equal(item.printedAt,undefined);assert.equal(h.list('sheetSyncQueue')[0].styles.netPrint1.background,'#ffffff');});

for(const secondTime of ['09:00','9:00'])await test('identical precontact preserves first receipt '+secondTime,async()=>{
 const h=harness();await h.precontact.submitPreContact({auth:h.staff,data:{jobId:'synthetic-job',temperature:36.5,arrivalTime:'09:00'}});const before=JSON.stringify([...h.records]);await h.precontact.submitPreContact({auth:h.staff,data:{jobId:'synthetic-job',temperature:36.5,arrivalTime:secondTime}});assert.equal(JSON.stringify([...h.records]),before);
});
await test('changed precontact records revision and expected old values',async()=>{
 const h=harness();await h.precontact.submitPreContact({auth:h.staff,data:{jobId:'synthetic-job',temperature:36.5,arrivalTime:'09:00'}});await h.precontact.submitPreContact({auth:h.staff,data:{jobId:'synthetic-job',temperature:36.6,arrivalTime:'09:30'}});assert.equal(h.records.get('jobs/synthetic-job').preContact.revised,true);assert.equal(h.list('sheetSyncQueue').length,2);assert.equal(h.list('sheetSyncQueue')[1].expected.arrivalTime.value,'09:00');assert.equal(h.list('auditLogs').length,2);
});
for(const mode of ['cancelled','staff-changed','queue-failure'])await test('precontact '+mode+' keeps state',async()=>{
 const h=harness();if(mode==='cancelled')h.records.get('jobs/synthetic-job').cancelled=true;if(mode==='staff-changed')h.records.get('jobs/synthetic-job').assignedStaffId='other';if(mode==='queue-failure')h.failWrite=w=>w.ref.path.startsWith('sheetSyncQueue/');const before=JSON.stringify([...h.records]);await assert.rejects(h.precontact.submitPreContact({auth:h.staff,data:{jobId:'synthetic-job',temperature:36.5,arrivalTime:'09:00'}}));assert.equal(JSON.stringify([...h.records]),before);
});

await test('netprint replacing number resets only changed item',async()=>{const h=harness();printedJob(h,true);const response=await h.netprint.updateNetPrintNumbers({auth:h.admin,data:{jobId:'synthetic-job',numbers:['87654321']}});const item=h.records.get('jobs/synthetic-job').netPrint.items[0];assert.equal(response.changedCount,1);assert.equal(item.printed,false);assert.notEqual(item.id,'item');assert.equal(item.printedAt,undefined);assert.equal(h.list('notificationQueue').length,1);});
await test('netprint removal counted with accurate notice',async()=>{const h=harness();printedJob(h,true);const response=await h.netprint.updateNetPrintNumbers({auth:h.admin,data:{jobId:'synthetic-job',numbers:[]}});assert.equal(response.changedCount,1);assert.equal(h.records.get('jobs/synthetic-job').netPrint.items.length,0);assert.equal(h.list('sheetSyncQueue')[0].updates.netPrint1,'');assert.match(h.list('notificationQueue')[0].title,/取り消/);});
for(const mode of ['foreign-staff','missing-item','invalid-position'])await test('netprint print rejects '+mode,async()=>{const h=harness();printedJob(h);if(mode==='foreign-staff')h.records.get('jobs/synthetic-job').assignedStaffId='other';if(mode==='invalid-position')h.records.get('jobs/synthetic-job').netPrint.items[0].position=0;const before=JSON.stringify(h.records.get('jobs/synthetic-job'));await assert.rejects(h.netprint.markNetPrintPrinted({auth:h.staff,data:{jobId:'synthetic-job',itemId:mode==='missing-item'?'other':'item'}}));assert.equal(JSON.stringify(h.records.get('jobs/synthetic-job')),before);assert.equal(h.list('sheetSyncQueue').length,0);});

for(const submitted of [true,false])await test('client submission replay preserves receipt '+submitted,async()=>{const h=harness();await h.status.setSalesFloorClientSubmitted({auth:h.staff,data:{jobId:'synthetic-job',submitted}});const before=JSON.stringify([...h.records]);await h.status.setSalesFloorClientSubmitted({auth:h.staff,data:{jobId:'synthetic-job',submitted}});assert.equal(JSON.stringify([...h.records]),before);});
await test('cancelled job rejects client submission',async()=>{const h=harness();h.records.get('jobs/synthetic-job').cancelled=true;const before=JSON.stringify([...h.records]);await assert.rejects(h.status.setSalesFloorClientSubmitted({auth:h.staff,data:{jobId:'synthetic-job',submitted:true}}),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);});
for(const transferred of [true,false])await test('client cancellation retains transferred completion '+transferred,async()=>{const h=harness();h.records.get('jobs/synthetic-job').submissionStatus={salesFloor:{lipKnotsSubmitted:transferred}};await h.status.setSalesFloorClientSubmitted({auth:h.staff,data:{jobId:'synthetic-job',submitted:true}});await h.status.setSalesFloorClientSubmitted({auth:h.staff,data:{jobId:'synthetic-job',submitted:false}});const status=h.records.get('jobs/synthetic-job').submissionStatus.salesFloor;assert.equal(status.completed,transferred);assert.equal(status.clientSubmittedAt,undefined);assert.equal(h.list('sheetSyncQueue').at(-1).updates.salesFloorSubmitted,transferred?'リップ':'');});

for(const state of [{cancelled:true},{status:'cancelled'}])for(const action of ['printed','precontact','client'])await test('cancelled business mutation rejected '+action+' '+Object.keys(state)[0],async()=>{const h=harness();printedJob(h);Object.assign(h.records.get('jobs/synthetic-job'),state);const before=JSON.stringify([...h.records]);const run=action==='printed'?()=>h.netprint.markNetPrintPrinted({auth:h.staff,data:{jobId:'synthetic-job',itemId:'item'}}):action==='precontact'?()=>h.precontact.submitPreContact({auth:h.staff,data:{jobId:'synthetic-job',temperature:36.5,arrivalTime:'09:00'}}):()=>h.status.setSalesFloorClientSubmitted({auth:h.staff,data:{jobId:'synthetic-job',submitted:true}});await assert.rejects(run,{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);});
for(const state of [{cancelled:true},{status:'cancelled'}])await test('cancelled printed replay still refuses '+Object.keys(state)[0],async()=>{const h=harness();printedJob(h,true);Object.assign(h.records.get('jobs/synthetic-job'),state);const before=JSON.stringify([...h.records]);await assert.rejects(()=>h.netprint.markNetPrintPrinted({auth:h.staff,data:{jobId:'synthetic-job',itemId:'item'}}),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);});

for(const action of ['upload','request'])for(const field of ['cancelled','status'])for(const timing of ['before','commit'])await test('new submission rejects cancellation '+action+' '+field+' '+timing,async()=>{const h=harness(),change=field==='cancelled'?{cancelled:true}:{status:'cancelled'};if(timing==='before')Object.assign(h.records.get('jobs/synthetic-job'),change);else h.beforeCommit=async()=>{h.beforeCommit=null;await h.updateRecord('jobs/synthetic-job',change);};await assert.rejects(action==='upload'?()=>h.start():()=>h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}}),{code:'failed-precondition'});assert.equal(h.list('submissions').length,0);assert.equal(h.list('resubmissionRequests').length,0);assert.equal(h.list('notificationQueue').length,0);});
for(const field of ['companyId','assignedStaffId'])await test('upload rechecks changed '+field+' at commit',async()=>{const h=harness();h.beforeCommit=async()=>{h.beforeCommit=null;await h.updateRecord('jobs/synthetic-job',{[field]:'other'});};await assert.rejects(()=>h.start(),{code:'permission-denied'});assert.equal(h.list('submissions').length,0);});
await test('upload rechecks replacement request at commit',async()=>{const h=harness(),r=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}});h.beforeCommit=async()=>{h.beforeCommit=null;await h.updateRecord('resubmissionRequests/'+r.requestId,{status:'completed'});};await assert.rejects(()=>h.start(1,{purpose:'replacement',resubmissionRequestId:r.requestId}),{code:'failed-precondition'});assert.equal(h.list('submissions').length,0);});
await test('upload parent and files stay atomic on file write failure',async()=>{const h=harness();h.failWrite=w=>w.ref.path.includes('/files/');await assert.rejects(()=>h.start(2));assert.equal([...h.records.keys()].some(k=>k.startsWith('submissions/')),false);});

for(const mode of ['replacement-without-id','replacement-empty-id','replacement-whitespace-id','initial-with-id','additional-with-id','default-with-id','initial-empty-id'])await test('upload rejects inconsistent purpose '+mode,async()=>{const h=harness(),r=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}});let patch;if(mode==='replacement-without-id')patch={purpose:'replacement'};else if(mode==='replacement-empty-id')patch={purpose:'replacement',resubmissionRequestId:''};else if(mode==='replacement-whitespace-id')patch={purpose:'replacement',resubmissionRequestId:'   '};else if(mode==='initial-empty-id')patch={purpose:'initial',resubmissionRequestId:''};else patch={...(mode==='default-with-id'?{}:{purpose:mode.split('-')[0]}),resubmissionRequestId:r.requestId};const before=JSON.stringify([...h.records]);await assert.rejects(()=>h.start(1,patch));assert.equal(JSON.stringify([...h.records]),before);});

for(const action of ['printed','precontact','client'])for(const status of ['open','draft',null])for(const replay of [false,true])await test('staff operation requires assigned '+action+' '+status+' replay='+replay,async()=>{
 const h=harness();printedJob(h);
 const run=action==='printed'?()=>h.netprint.markNetPrintPrinted({auth:h.staff,data:{jobId:'synthetic-job',itemId:'item'}}):action==='precontact'?()=>h.precontact.submitPreContact({auth:h.staff,data:{jobId:'synthetic-job',temperature:36.5,arrivalTime:'09:00'}}):()=>h.status.setSalesFloorClientSubmitted({auth:h.staff,data:{jobId:'synthetic-job',submitted:true}});
 if(replay)await run();
 const job=h.records.get('jobs/synthetic-job');if(status===null)delete job.status;else job.status=status;
 const before=JSON.stringify([...h.records]);await assert.rejects(run,{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);
});

for(const mode of ['own-outside-window','cancelled','cancelled-status','open','missing','foreign-company','foreign-staff','bad-type','bad-job-id'])await test('actionable resubmission task validates current job '+mode,async()=>{
 const h=harness(),job=h.records.get('jobs/synthetic-job');
 h.records.set('resubmissionRequests/pending',{companyId:'synthetic-company',staffId:'synthetic-staff',jobId:mode==='bad-job-id'?'invalid/path':'synthetic-job',type:mode==='bad-type'?'unknown':'report',status:'open',reasons:['その他'],createdAt:Timestamp.now()});
 if(mode==='cancelled')job.cancelled=true;if(mode==='cancelled-status')job.status='cancelled';if(mode==='open')job.status='open';
 if(mode==='missing')h.records.delete('jobs/synthetic-job');if(mode==='foreign-company')job.companyId='other';if(mode==='foreign-staff')job.assignedStaffId='other';
 const before=JSON.stringify([...h.records]);const result=await h.tasks.getMyTasks({auth:h.staff,data:{}});
 assert.equal(result.tasks.filter(t=>t.kind==='resubmission').length,mode==='own-outside-window'?1:0);assert.equal(JSON.stringify([...h.records]),before);
});
for(const status of ['open','draft',null])for(const timing of ['before','commit'])await test('resubmission creation rejects unassigned state '+status+' '+timing,async()=>{
 const h=harness();const change={status};if(timing==='before')Object.assign(h.records.get('jobs/synthetic-job'),change);else h.beforeCommit=async()=>{h.beforeCommit=null;await h.updateRecord('jobs/synthetic-job',change);};
 await assert.rejects(()=>h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}}),{code:'failed-precondition'});
 assert.equal(h.list('resubmissionRequests').length,0);assert.equal(h.list('notificationQueue').length,0);assert.equal(h.records.get('jobs/synthetic-job').status,status);
});
for(const purpose of ['initial','additional','replacement'])for(const status of ['open','draft',null])for(const timing of ['before','commit'])await test('upload start rejects unassigned job '+purpose+' '+status+' '+timing,async()=>{
 const h=harness();const patch={purpose};if(purpose==='replacement'){const r=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}});patch.resubmissionRequestId=r.requestId;}
 const requestsBefore=JSON.stringify(h.list('resubmissionRequests')),noticesBefore=JSON.stringify(h.list('notificationQueue'));const change={status};if(timing==='before')Object.assign(h.records.get('jobs/synthetic-job'),change);else h.beforeCommit=async()=>{h.beforeCommit=null;await h.updateRecord('jobs/synthetic-job',change);};
 await assert.rejects(()=>h.start(1,patch),{code:'failed-precondition'});assert.equal(h.list('submissions').length,0);assert.equal([...h.records.keys()].filter(k=>k.startsWith('submissions/')).length,0);assert.equal(h.copies,0);assert.equal(JSON.stringify(h.list('resubmissionRequests')),requestsBefore);assert.equal(JSON.stringify(h.list('notificationQueue')),noticesBefore);assert.equal(h.records.get('jobs/synthetic-job').status,status);
});
for(const contentType of ['text/plain','application/octet-stream','application/vnd.google-apps.document','image/','image/png; charset=utf-8'])await test('upload rejects unsupported mime '+contentType,async()=>{const h=harness(),before=JSON.stringify([...h.records]);await assert.rejects(()=>h.start(1,{files:[{originalName:'synthetic.png',contentType,size:100}]}));assert.equal(JSON.stringify([...h.records]),before);});
for(const size of [0.5,100.5,0,50*1024*1024+1])await test('upload rejects invalid byte size '+size,async()=>{const h=harness(),before=JSON.stringify([...h.records]);await assert.rejects(()=>h.start(1,{files:[{originalName:'synthetic.png',contentType:'image/png',size}]}));assert.equal(JSON.stringify([...h.records]),before);});
for(const contentType of ['image/png','image/jpeg','image/heic','application/pdf'])for(const size of [1,50*1024*1024])await test('upload accepts supported mime and boundary '+contentType+' '+size,async()=>{const h=harness();const r=await h.start(1,{files:[{originalName:'synthetic.file',contentType,size}]});assert.equal(r.files.length,1);const stored=h.records.get('submissions/'+r.submissionId+'/files/'+r.files[0].fileId);assert.equal(stored.contentType,contentType);assert.equal(stored.size,size);});
for(const configured of [false,true])await test('preview token requires configured gateway '+configured,async()=>{const h=harness();if(configured)h.previewBase='https://preview.invalid/files';const session=await h.start();await h.finish(session.files[0]);if(!configured)h.failWrite=w=>w.ref.path.startsWith('filePreviewTokens/');const result=await h.views.getSubmissionTimeline({auth:h.staff,data:{jobId:'synthetic-job',type:'report'}});const file=result.submissions[0].files[0];assert.equal(h.list('filePreviewTokens').length,configured?1:0);if(configured){assert.ok(file.previewUrl.startsWith(h.previewBase+'?token='));const raw=new URL(file.previewUrl).searchParams.get('token');assert.ok(h.records.has('filePreviewTokens/'+crypto.createHash('sha256').update(raw).digest('hex')));}else assert.equal(file.previewUrl,null);});
for(const api of ['timeline','processing','comparison'])for(const identity of ['missing','empty','null','admin'])await test('submission read requires staff identity '+api+' '+identity,async()=>{
 const h=harness();h.records.get('jobs/synthetic-job').assignedStaffId='';h.records.set('submissions/pending',{companyId:'synthetic-company',jobId:'synthetic-job',staffId:'',type:'report',status:'uploading',totalFiles:1,completedFiles:0,createdAt:Timestamp.now()});h.records.set('resubmissionRequests/pending',{companyId:'synthetic-company',jobId:'synthetic-job',staffId:'',type:'report',status:'open'});
 const auth=identity==='admin'?h.admin:{uid:'synthetic-user',token:{companyId:'synthetic-company',role:'staff',...(identity==='empty'?{staffId:''}:identity==='null'?{staffId:null}:{})}};const before=JSON.stringify([...h.records]);const read=()=>api==='timeline'?h.views.getSubmissionTimeline({auth,data:{jobId:'synthetic-job',type:'report'}}):api==='processing'?h.views.getSubmissionProcessingStatus({auth,data:{jobId:'synthetic-job',submissionId:'pending'}}):h.views.getResubmissionComparison({auth,data:{requestId:'pending'}});
 if(identity==='admin')await read();else await assert.rejects(read,{code:'permission-denied'});assert.equal(JSON.stringify([...h.records]),before);
});
for(const marker of ['counted','checkpoint','completed'])for(const id of [undefined,'',' ',123])await test('incomplete recovery identity stops before mutation '+marker+' '+String(id),async()=>{
 const h=harness(),session=await h.start(),file=h.records.get('submissions/'+session.submissionId+'/files/'+session.files[0].fileId);
 if(marker==='counted')file.completionCounted=true;else if(marker==='checkpoint')file.transferCompletedAt=Timestamp.now();else file.status='completed';
 if(id!==undefined)file.driveFileId=id;const before=JSON.stringify([...h.records]);await assert.rejects(h.finish(session.files[0]),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.copies,0);assert.equal(h.deletes,0);assert.equal(h.driveFiles.size,0);
});
for(const [label,mutate] of [
 ['missing name',f=>delete f.driveName],['blank name',f=>f.driveName=' '],['numeric name',f=>f.driveName=123],
 ['missing sequence',f=>delete f.sequence],['zero sequence',f=>f.sequence=0],['fractional sequence',f=>f.sequence=1.5],['string sequence',f=>f.sequence='1'],
 ['plan id mismatch',f=>f.driveFileId='unrelated-drive-id'],['plan name mismatch',f=>f.driveName='unrelated-name'],['plan sequence mismatch',f=>f.sequence=2]
])await test('completed recovery rejects '+label+' before mutation',async()=>{
 const h=harness(),session=await h.start();await h.finish(session.files[0]);const file=h.records.get('submissions/'+session.submissionId+'/files/'+session.files[0].fileId);mutate(file);const before=JSON.stringify([...h.records]),copies=h.copies,deletes=h.deletes;
 await assert.rejects(h.finish(session.files[0]),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.copies,copies);assert.equal(h.deletes,deletes);
});
await test('legacy valid checkpoint without stable plan remains replayable',async()=>{const h=harness(),session=await h.start();await h.finish(session.files[0]);delete h.records.get('submissions/'+session.submissionId+'/files/'+session.files[0].fileId).driveTransferPlan;await h.finish(session.files[0]);assert.equal(h.copies,1);assert.equal((await h.state(session.submissionId)).completedFiles,1);assert.equal(h.list('sheetSyncQueue').length,1);});
for(const failure of ['none','response-loss','checkpoint-loss','paused-reviewed-replay','paused-reviewed-response-loss'])await test('acceptance kit -> actual transfer -> disabled worker -> result verifier '+failure,async()=>{
 const kit=createSubmissionAcceptanceKit({driveRootId:failure.startsWith('paused-')?REPLAY_DRIVE_ROOT:'synthetic-isolated-root'}),h=harness(),now=Date.now();h.records.clear();for(const seed of kit.seedDocuments)h.records.set(seed.path,copy(seed.data));h.storageBucket=kit.storageBucket;h.driveCreatedAt=new Date(now).toISOString();
 const folders=[{id:kit.drive.rootFolderId,name:kit.companyId,parents:[kit.drive.parentId]},{id:'acceptance-client',name:kit.drive.childFolders[0],parents:[kit.drive.rootFolderId]},{id:'acceptance-month',name:kit.drive.childFolders[1],parents:['acceptance-client']}].map(f=>({...f,mimeType:'application/vnd.google-apps.folder',trashed:false}));
 h.driveList=({q})=>({data:{files:folders.filter(f=>q.includes("'"+f.parents[0]+"' in parents")&&q.includes("name='"+f.name+"'"))}});
 h.drivePayload=input=>{const f=kit.files.find(f=>f.storagePath===input.media.body.syntheticPath);assert.ok(f);return {size:String(f.size),mimeType:f.contentType,md5Checksum:Buffer.from(f.md5Base64,'base64').toString('hex'),trashed:false};};
 const finish=f=>h.uploads.finalizeStagedUpload({data:{name:f.storagePath,bucket:kit.storageBucket,contentType:f.contentType,size:f.size,generation:1,md5Hash:f.md5Base64}});
 if(['response-loss','checkpoint-loss'].includes(failure)){if(failure==='response-loss')h.loseCopyResponse=true;else h.failWrite=w=>!!w.data.transferCompletedAt;await assert.rejects(finish(kit.files[0]));assert.equal(h.driveFiles.size,1);h.loseCopyResponse=false;h.failWrite=null;}
 if(failure.startsWith('paused-')){
  h.env.LKC_SUBMISSION_TRANSFER_MODE='paused';
  for(const f of kit.files)await finish(f);
  assert.equal(h.copies,0);assert.equal(h.deletes,0);
  Object.assign(h.env,{APP_ENVIRONMENT:'staging',EXPECTED_FIREBASE_PROJECT_ID:kit.project,LKC_SUBMISSION_TRANSFER_MODE:'acceptance'});
  // 同じ転送処理へ通常会社のイベントが来ても、コピーも加算も行わない。
  const ordinaryId='ordinary-isolated-submission',ordinaryFile='ordinary-isolated-file';
  const ordinaryPath='submissions/'+ordinaryId,ordinaryFilePath=ordinaryPath+'/files/'+ordinaryFile;
  const ordinaryStorage='staging/ordinary-company/ordinary-user/'+ordinaryId+'/'+ordinaryFile+'/fixture.txt';
  h.records.set(ordinaryPath,{...copy(h.records.get('submissions/'+kit.submissionId)),companyId:'ordinary-company',uid:'ordinary-user',jobId:'ordinary-job',staffId:'ordinary-staff',status:'uploading',totalFiles:1,completedFiles:0});
  h.records.set(ordinaryFilePath,{...copy(h.records.get('submissions/'+kit.submissionId+'/files/'+kit.files[0].fileId)),companyId:'ordinary-company',uid:'ordinary-user',jobId:'ordinary-job',staffId:'ordinary-staff',submissionId:ordinaryId,status:'waiting_upload',storagePath:ordinaryStorage,size:100,pausedTransferSource:undefined});
  delete h.records.get(ordinaryFilePath).pausedTransferSource;
  const finishOrdinary=()=>h.uploads.finalizeStagedUpload({data:{name:ordinaryStorage,bucket:kit.storageBucket,contentType:'text/plain',size:100,generation:1,md5Hash:'AAAAAAAAAAAAAAAAAAAAAA=='}});
  await finishOrdinary();assert.equal(h.copies,0);assert.equal(h.deletes,0);
  assert.equal(h.records.get(ordinaryFilePath).status,'paused_global');assert.equal(h.records.get(ordinaryPath).completedFiles,0);
  h.verifyOrdinary=async()=>{await finishOrdinary();assert.equal(h.records.get(ordinaryFilePath).status,'paused_global');assert.equal(h.records.get(ordinaryPath).completedFiles,0);};
  const revision='finalizestagedupload-00006-test',record=p=>({data:copy(h.records.get(p)),updateTime:new Date(now).toISOString()});
  const transport={
   readFunction:async()=>({name:'projects/'+kit.project+'/locations/asia-northeast1/functions/finalizeStagedUpload',state:'ACTIVE',environment:'GEN_2',
    serviceConfig:{revision,allTrafficOnLatestRevision:true,serviceAccountEmail:'740154137290-compute@developer.gserviceaccount.com',uri:'https://finalizestagedupload-example-an.a.run.app',
     environmentVariables:{APP_ENVIRONMENT:'staging',EXPECTED_FIREBASE_PROJECT_ID:kit.project,LKC_SUBMISSION_TRANSFER_MODE:'acceptance'}},
    eventTrigger:{eventType:'google.cloud.storage.object.v1.finalized',eventFilters:[{attribute:'bucket',value:kit.storageBucket}]}}),
   readRecords:async i=>({parent:record('submissions/'+kit.submissionId),file:record('submissions/'+kit.submissionId+'/files/'+kit.files[i-1].fileId),drive:record('companies/'+kit.companyId+'/settings/drive'),otherFile:record('submissions/'+kit.submissionId+'/files/'+kit.files[i===1?1:0].fileId)}),
   readObject:async(i,g)=>{const f=kit.files[i-1];assert.equal(g,'1');return {bucket:kit.storageBucket,name:f.storagePath,generation:g,size:String(f.size),contentType:f.contentType,md5Hash:f.md5Base64};},
   invoke:async plan=>{await h.uploads.finalizeStagedUpload({data:plan.event});return {accepted:true};},
  };
  for(const fileIndex of [1,2]){
   let plan=await preparePausedReplay({transport,fileIndex,revision});
   if(fileIndex===1&&failure==='paused-reviewed-response-loss'){
    h.loseCopyResponse=true;
    await assert.rejects(executePausedReplay({transport,plan,approvedFingerprint:plan.fingerprint}));
    assert.equal(h.copies,1);assert.equal(h.records.get('submissions/'+kit.submissionId).completedFiles,0);
    h.loseCopyResponse=false;plan=await preparePausedReplay({transport,fileIndex,revision});
   }
   await executePausedReplay({transport,plan,approvedFingerprint:plan.fingerprint});
   await assert.rejects(preparePausedReplay({transport,fileIndex,revision}),/RECORD_NOT_REPLAYABLE/);
  }
 }else for(const f of kit.files)await finish(f);
 await h.verifyOrdinary?.();
 const queue=h.list('sheetSyncQueue');assert.equal(queue.length,1);const worker=h.loadModule('./safe-sheet-writes');await worker.processSafeSheetWrite({data:{after:h.snapshot('sheetSyncQueue/'+queue[0].id)}});
 const normalize=v=>v instanceof Timestamp?v.toDate().toISOString():Array.isArray(v)?v.map(normalize):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,normalize(x)])):v;
 const result={project:kit.project,kitFingerprint:kit.fingerprint,startedAt:new Date(now-1000).toISOString(),readAt:new Date(Date.now()).toISOString(),documents:[...h.records].filter(([,data])=>data.companyId!=='ordinary-company').map(([path,data])=>({path,data:normalize(data)})),drive:{folders,files:[...h.driveFiles.values()]},storage:kit.files.map(f=>({bucket:kit.storageBucket,path:f.storagePath,generation:'1',size:String(f.size),contentType:f.contentType,md5Base64:f.md5Base64,exists:!h.deletedPaths.includes(f.storagePath)})),counts:Object.fromEntries(['notificationQueue','pushTokens'].map(c=>[c,{companyId:kit.companyId,count:h.list(c).length}])),listingsComplete:true};
 const check=verifySubmissionAcceptanceResult(kit,result,Date.parse(result.readAt));assert.deepEqual(check.issues,[]);assert.equal(check.passed,true);assert.equal(check.actualCloudAcceptanceVerified,false);assert.equal(check.cloudExecutionAuthorized,false);assert.equal(h.copies,2);assert.equal(h.deletes,2);
});
if(process.env.LKC_ROLLBACK_SOURCE_BUNDLE){
 const candidates=JSON.parse(fs.readFileSync(process.env.LKC_ROLLBACK_SOURCE_BUNDLE,'utf8'));
 for(const candidate of candidates)await test('historical rollback transfer compatibility '+candidate.sha,async()=>{
  const current=harness(),session=await current.start();current.loseCopyResponse=true;await assert.rejects(current.finish(session.files[0]));assert.equal(current.copies,1);
  const old=harness(candidate.files);old.allowLegacyUnversionedRead=true;old.records.clear();for(const [key,value]of current.records)old.records.set(key,copy(value));old.driveFiles=new Map([...current.driveFiles].map(([key,value])=>[key,copy(value)]));old.copies=current.copies;
  await old.finish(session.files[0]);const sameFile=old.copies===1&&old.driveFiles.size===1&&old.list('fileCounters')[0].value===1;
  assert.equal(sameFile,candidate.expectedStableIdCompatibility);assert.equal(old.copies,candidate.expectedStableIdCompatibility?1:2);
  console.log(JSON.stringify({historicalSourceSha:candidate.sha,stableIdRecoveryCompatible:sameFile,unversionedSourceReads:old.unversionedReads??0,realRollbackArtifactVerified:false,cloudExecutionAuthorized:false}));
 });
}
if(process.env.LKC_DEPLOYED_TRANSFER_BUNDLE){
 const candidate=JSON.parse(fs.readFileSync(process.env.LKC_DEPLOYED_TRANSFER_BUNDLE,'utf8'));
 assert.equal(candidate.function,'finalizeStagedUpload');assert.equal(candidate.project,'lip-knots-crew-staging');
 assert.match(candidate.revision,/^finalizestagedupload-[0-9]+-[a-z0-9]+$/);assert.match(candidate.archiveSha256,/^[a-f0-9]{64}$/);
 for(const format of ['source','compiled','current']){
  if(format!=='current'){
  const files=candidate[format==='source'?'files':'compiledFiles'];assert.ok(files&&Object.keys(files).length>0);
  for(const [name,source]of Object.entries(files)){
   assert.match(name,format==='source'?/^[a-z0-9-]+[.]ts$/:/^[a-z0-9-]+[.]js$/);assert.equal(typeof source,'string');
   assert.equal(crypto.createHash('sha256').update(source).digest('hex'),candidate.hashes[format][name]);
  }
  }
  for(const failure of ['response-loss','checkpoint-loss','accounting-loss','completed-replay'])await test('deployed rollback '+format+' '+failure,async()=>{
   const current=harness(),session=await current.start();
   if(failure==='response-loss')current.loseCopyResponse=true;
   if(failure==='checkpoint-loss')current.failWrite=w=>!!w.data.transferCompletedAt;
   if(failure==='accounting-loss')current.failWrite=w=>w.ref.path.startsWith('sheetSyncQueue/');
   if(failure==='completed-replay')await current.finish(session.files[0]);else await assert.rejects(current.finish(session.files[0]));
   const filePath='submissions/'+session.submissionId+'/files/'+session.files[0].fileId,original=copy(current.records.get(filePath));
   assert.equal(current.copies,1);assert.ok(original.driveTransferPlan?.id);
   const old=harness(format==='source'?candidate.files:null,format==='compiled'?candidate.compiledFiles:null);
   old.allowLegacyUnversionedRead=true;old.records.clear();
   for(const [key,value]of current.records)old.records.set(key,copy(value));
   old.driveFiles=new Map([...current.driveFiles].map(([key,value])=>[key,copy(value)]));old.copies=current.copies;
   await old.finish(session.files[0]);
   const file=old.records.get(filePath),parent=old.records.get('submissions/'+session.submissionId);
   const value={format,failure,driveCopies:old.copies,driveFiles:old.driveFiles.size,counter:old.list('fileCounters')[0]?.value??null,
    originalDriveIdPreserved:file.driveFileId===original.driveTransferPlan.id,completedFiles:parent.completedFiles,
    queueCount:old.list('sheetSyncQueue').length,unversionedSourceReads:old.unversionedReads??0};
   value.stableIdRecoveryCompatible=value.driveCopies===1&&value.driveFiles===1&&value.counter===1&&value.originalDriveIdPreserved&&value.completedFiles===1&&value.queueCount===1;
   if(format==='current')assert.equal(value.stableIdRecoveryCompatible,true,'Current control must recover without duplication');
   deployedObservations.push(value);
   console.log(JSON.stringify({deployedRollbackObservation:value,archiveSha256:candidate.archiveSha256,revision:candidate.revision,actualCloudRollbackVerified:false}));
  });
 }
 await test('deployed rollback source and compiled observations agree',async()=>{
  for(const failure of ['response-loss','checkpoint-loss','accounting-loss','completed-replay']){
   const source=deployedObservations.find(v=>v.format==='source'&&v.failure===failure),compiled=deployedObservations.find(v=>v.format==='compiled'&&v.failure===failure);
   assert.ok(source&&compiled);assert.deepEqual({...source,format:'same'},{...compiled,format:'same'});
  }
 });
 if(process.env.LKC_DEPLOYED_TRANSFER_RESULT){
  const result={project:candidate.project,function:candidate.function,revision:candidate.revision,generation:candidate.generation,archiveSha256:candidate.archiveSha256,
   observations:deployedObservations,complete:deployedObservations.length===12,allScenariosCompatible:deployedObservations.length===12&&deployedObservations.every(v=>v.stableIdRecoveryCompatible),currentControlPassed:deployedObservations.filter(v=>v.format==="current").length===4&&deployedObservations.filter(v=>v.format==="current").every(v=>v.stableIdRecoveryCompatible),
   actualCloudRollbackVerified:false,dependencyInstallReproduced:false,cloudResourcesChanged:false};
  fs.writeFileSync(process.env.LKC_DEPLOYED_TRANSFER_RESULT,JSON.stringify(result,null,2),{flag:'wx'});
 }
}
for(const mode of ['valid','expired','foreign','unsupported','unfinished'])await test('PDF preview uses existing protected gateway '+mode,async()=>{
 const h=harness();h.previewBase='https://preview.invalid/files';h.drivePayload=input=>({mimeType:input.requestBody.mimeType});
 const session=await h.start(1,{files:[{originalName:'synthetic-report.pdf',contentType:'application/pdf',size:100}]});await h.finish(session.files[0],{contentType:'application/pdf'});
 const filePath='submissions/'+session.submissionId+'/files/'+session.files[0].fileId;
 if(mode==='unsupported')h.records.get(filePath).contentType='text/html';if(mode==='unfinished')h.records.get(filePath).status='processing';
 const timeline=await h.views.getSubmissionTimeline({auth:h.admin,data:{jobId:'synthetic-job',type:'report'}}),file=timeline.submissions[0].files[0];
 if(['unsupported','unfinished'].includes(mode)){assert.equal(file.previewUrl,null);assert.equal(h.list('filePreviewTokens').length,0);return;}
 assert.ok(file.previewUrl,'Completed PDF needs a protected preview URL');const raw=new URL(file.previewUrl).searchParams.get('token'),record=h.records.get('filePreviewTokens/'+crypto.createHash('sha256').update(raw).digest('hex'));assert.equal(record.contentType,'application/pdf');assert.equal(record.actorUid,h.admin.uid);assert.ok(record.expiresAt.toMillis()<=Date.now()+900000);
 if(mode==='expired')record.expiresAt=Timestamp.fromMillis(1);if(mode==='foreign')h.records.get(filePath).companyId='foreign';
 const headers={},response={code:200,headersSent:false,status(code){this.code=code;return this;},send(){return this;},setHeader(name,value){headers[name]=value;},end(){}};await h.views.driveFilePreview({query:{token:raw}},response);
 assert.equal(response.code,mode==='valid'?200:410);assert.equal(h.previewReads??0,mode==='valid'?1:0);if(mode==='valid'){assert.equal(headers['Content-Type'],'application/pdf');assert.match(headers['Content-Disposition'],/^inline;/);assert.equal(headers['X-Content-Type-Options'],'nosniff');}
});
for(const role of ['staff','admin'])for(const mode of ['valid','parent-missing','file-missing','company','job','type','file-company','file-parent','file-owner','unassigned','unfinished','unsupported','pdf'])await test('targeted preview '+role+' '+mode,async()=>{
 const h=harness();h.previewBase='https://preview.invalid/files';const session=await h.start();await h.finish(session.files[0]);
 const parentPath='submissions/'+session.submissionId,filePath=parentPath+'/files/'+session.files[0].fileId,parent=h.records.get(parentPath),file=h.records.get(filePath);
 if(mode==='parent-missing')h.records.delete(parentPath);if(mode==='file-missing')h.records.delete(filePath);
 if(mode==='company')parent.companyId='foreign';if(mode==='job')parent.jobId='other';if(mode==='type')parent.type='sales_floor';
 if(mode==='file-company')file.companyId='foreign';if(mode==='file-parent')file.submissionId='other';if(mode==='file-owner')file.uid='other';
 if(mode==='unassigned')h.records.get('jobs/synthetic-job').assignedStaffId='other';
 if(mode==='unfinished')file.status='processing';if(mode==='unsupported')file.contentType='text/html';if(mode==='pdf')file.contentType='application/pdf';
 const read=()=>h.views.getSubmissionTimeline({auth:h[role],data:{jobId:'synthetic-job',type:'report',previewFile:{submissionId:session.submissionId,fileId:session.files[0].fileId}}});
 const allowed=['valid','unfinished','unsupported','pdf'].includes(mode)||(mode==='unassigned'&&role==='admin');
 if(['parent-missing','file-missing','company','job','type'].includes(mode)){assert.equal((await read()).submissions.length,0);assert.equal(h.list('filePreviewTokens').length,0);return;}
 if(!allowed){await assert.rejects(read);assert.equal(h.list('filePreviewTokens').length,0);return;}
 const result=await read();assert.equal(result.submissions.length,1);assert.equal(result.submissions[0].files.length,1);
 assert.equal(result.submissions[0].files[0].id,session.files[0].fileId);
 assert.equal(h.list('filePreviewTokens').length,['unfinished','unsupported'].includes(mode)?0:1);
});
for(const key of ['submissionId','fileId'])for(const value of ['', ' ', 'a/b', null])await test('targeted preview rejects invalid '+key+' '+JSON.stringify(value),async()=>{
 const h=harness();h.previewBase='https://preview.invalid/files';
 await assert.rejects(h.views.getSubmissionTimeline({auth:h.staff,data:{jobId:'synthetic-job',type:'report',previewFile:{submissionId:'parent',fileId:'file',[key]:value}}}));
 assert.equal(h.documentReads,0);assert.equal(h.list('filePreviewTokens').length,0);
});
await test('targeted preview operation count with 100 submissions and 2000 files',async()=>{
 const h=harness();h.previewBase='https://preview.invalid/files';const session=await h.start();await h.finish(session.files[0]);
 const parent=copy(h.records.get('submissions/'+session.submissionId)),file=copy(h.records.get('submissions/'+session.submissionId+'/files/'+session.files[0].fileId));
 for(const key of [...h.records.keys()])if(key.startsWith('submissions/'))h.records.delete(key);
 for(let s=0;s<100;s++){h.records.set('submissions/parent-'+s,{...parent,createdAt:Timestamp.fromMillis(s+1)});for(let f=0;f<20;f++)h.records.set('submissions/parent-'+s+'/files/file-'+f,{...file,submissionId:'parent-'+s});}
 const measurements=[];
 for(const targeted of [false,true]){
  h.documentReads=0;h.queryReads=0;h.returnedDocuments=0;const tokens=h.list('filePreviewTokens').length;
  const result=await h.views.getSubmissionTimeline({auth:h.staff,data:{jobId:'synthetic-job',type:'report',...(targeted?{previewFile:{submissionId:'parent-42',fileId:'file-7'}}:{})}});
  measurements.push({targeted,documentReads:h.documentReads,queryReads:h.queryReads,returnedDocuments:h.returnedDocuments,tokenWrites:h.list('filePreviewTokens').length-tokens,groups:result.submissions.length,files:result.submissions.reduce((n,g)=>n+g.files.length,0)});
 }
 console.log(JSON.stringify({syntheticPreviewOperationCounts:measurements,realBillingOrLatencyMeasurement:false}));
 assert.deepEqual(measurements[0],{targeted:false,documentReads:1,queryReads:101,returnedDocuments:2100,tokenWrites:2000,groups:100,files:2000});
 assert.deepEqual(measurements[1],{targeted:true,documentReads:3,queryReads:0,returnedDocuments:0,tokenWrites:1,groups:1,files:1});
});
await test('malformed stored deadline never invents a valid historical rule',async()=>{const h=harness(),s=await h.start();h.records.get('submissions/'+s.submissionId).deadlinePolicy={ruleVersion:'jp-business-day-11-v1',calendarVersion:'cao-2026-2027-20260917',workDate:'2026-02-30',dueAtMs:Date.parse('2026-03-03T02:00:00Z'),status:'known'};await h.finish(s.files[0]);const report=h.records.get('jobs/synthetic-job').submissionStatus.report;assert.equal(report.deadlinePolicy.status,'unrecorded');assert.equal(report.lateFirstSubmission,undefined);assert.equal(report.deadlineReviewRequired,true);});
for(const [flag,reason]of [['sourceMissing','source_unavailable'],['applicationUnconfirmed','assignment_sheet_confirmation_pending'],['assignmentUnresolved','assignment_identity_unresolved']])for(const action of ['upload','client-record'])await test('pending '+flag+' prevents '+action+' without writes',async()=>{const h=harness();const job=h.records.get('jobs/synthetic-job');job[flag]=true;const before=JSON.stringify([...h.records]);const call=()=>action==='upload'?h.start():h.loadModule('./submission-status').setSalesFloorClientSubmitted({auth:h.staff,data:{jobId:'synthetic-job',submitted:true}});await assert.rejects(call(),e=>e.code==='failed-precondition'&&e.details?.reason===reason);assert.equal(JSON.stringify([...h.records]),before);job[flag]=false;await call();});
for(const flag of ['sourceMissing','applicationUnconfirmed','assignmentUnresolved'])await test('accepted file is retained when '+flag+' changes later',async()=>{const h=harness(),s=await h.start();h.records.get('jobs/synthetic-job')[flag]=true;await h.finish(s.files[0]);assert.equal((await h.state(s.submissionId)).status,'completed');assert.equal(h.driveFiles.size,1);assert.equal(h.records.get('submissions/'+s.submissionId).totalFiles,1);});
const retryRequest='11111111-1111-4111-8111-111111111111';
const retryFiles=(count=1,size=100)=>Array.from({length:count},(_,i)=>({originalName:'retry-'+i+'.png',contentType:'image/png',size,contentSha256:'a'.repeat(64)}));
const retryStart=(h,count=1,patch={})=>h.start(count,{clientRequestId:retryRequest,files:retryFiles(count),...patch});
function presentObject(h,file,patch={}){h.storageObjects??=new Map();h.storageObjects.set(file.storagePath,{name:file.storagePath,contentType:'image/png',size:'100',generation:'1',metadata:{lkcContentSha256:'a'.repeat(64)},...patch});}
await test('upload retry reuses receipt after response loss without creating new files',async()=>{const h=harness(),first=await retryStart(h,2),again=await retryStart(h,2);assert.equal(first.submissionId,again.submissionId);assert.equal(again.replayed,true);assert.equal(again.clientRequestId,retryRequest);assert.deepEqual(again.files,first.files);assert.equal(h.list('submissions').length,1);assert.equal(h.records.size,6);assert.equal(h.metadataReads,2);});
await test('concurrent same operation converges on one receipt',async()=>{const h=harness(),responses=await Promise.all([retryStart(h),retryStart(h)]);assert.equal(responses[0].submissionId,responses[1].submissionId);assert.equal(h.list('submissions').length,1);assert.equal(h.list('submissions/'+responses[0].submissionId+'/files').length,1);});
await test('partial uploaded and finalized files are skipped while missing files resume',async()=>{const h=harness(),first=await retryStart(h,3);presentObject(h,first.files[0]);presentObject(h,first.files[1]);await h.finish(first.files[0]);const again=await retryStart(h,3);assert.deepEqual(Array.from(again.files,f=>f.uploadRequired),[false,false,true]);assert.equal(h.copies,1);assert.equal(h.metadataReads,2);assert.equal(h.list('submissions').length,1);});
await test('completed receipt survives staging cleanup without reupload',async()=>{const h=harness(),first=await retryStart(h);await h.finish(first.files[0]);const before=JSON.stringify([...h.records]);const again=await retryStart(h);assert.equal(again.files[0].uploadRequired,false);assert.equal(h.metadataReads??0,0);assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.copies,1);});
for(const field of ['name','size','contentType','hash'])await test('retry refuses mismatched existing Storage '+field,async()=>{const h=harness(),first=await retryStart(h);const changes={name:{name:'other'},size:{size:'101'},contentType:{contentType:'application/pdf'},hash:{metadata:{lkcContentSha256:'b'.repeat(64)}}};presentObject(h,first.files[0],changes[field]);await assert.rejects(retryStart(h),e=>e.code==='failed-precondition');assert.equal(h.list('submissions').length,1);assert.equal(h.copies,0);});
for(const code of [403,500,503])await test('metadata '+code+' cannot fall back to overwriting',async()=>{const h=harness();await retryStart(h);h.metadataError=code;await assert.rejects(retryStart(h),e=>e.code===code);assert.equal(h.list('submissions').length,1);});
for(const state of ['processing','paused_global','error','security_error'])await test('missing source in '+state+' requires recovery instead of recreation',async()=>{const h=harness(),first=await retryStart(h);h.records.get('submissions/'+first.submissionId+'/files/'+first.files[0].fileId).status=state;await assert.rejects(retryStart(h),e=>e.code==='failed-precondition');assert.equal(h.list('submissions').length,1);});
for(const patch of [{files:retryFiles(2)},{type:'sales_floor'},{files:[{...retryFiles()[0],originalName:'changed.png'}]},{files:[{...retryFiles()[0],contentSha256:'b'.repeat(64)}]}])await test('same request with changed content is rejected '+JSON.stringify(patch),async()=>{const h=harness();await retryStart(h);await assert.rejects(retryStart(h,1,patch),e=>e.code==='failed-precondition');assert.equal(h.list('submissions').length,1);});
for(const [name,change]of [['revision',j=>j.revision=1],['date',j=>j.dateKey='2026-09-21'],['pending',j=>j.applicationUnconfirmed=true],['cancelled',j=>j.cancelled=true],['staff',j=>j.assignedStaffId='other'],['company',j=>j.companyId='other']])await test('retry refuses changed assignment '+name,async()=>{const h=harness();await retryStart(h);change(h.records.get('jobs/synthetic-job'));await assert.rejects(retryStart(h));assert.equal(h.list('submissions').length,1);assert.equal(h.metadataReads??0,0);});
await test('retry keeps twenty 50MiB files valid without physically allocating them',async()=>{const h=harness(),a=await retryStart(h,20,{files:retryFiles(20,50*1024*1024)}),b=await retryStart(h,20,{files:retryFiles(20,50*1024*1024)});assert.equal(a.files.length,20);assert.equal(b.files.length,20);assert.equal(h.list('submissions').length,1);});
await test('request ID is scoped to authenticated UID and legacy calls remain compatible',async()=>{const h=harness(),a=await retryStart(h);h.staff={...h.staff,uid:'other-session-user'};const b=await retryStart(h);assert.notEqual(a.submissionId,b.submissionId);const legacy=await h.start();assert.equal(legacy.clientRequestId,undefined);assert.equal(legacy.files[0].uploadRequired,undefined);});
await test('idempotent request requires valid operation ID and each content hash',async()=>{for(const patch of [{clientRequestId:'bad'},{files:[{originalName:'a.png',contentType:'image/png',size:100}]}]){const h=harness();await assert.rejects(retryStart(h,1,patch));assert.equal(h.list('submissions').length,0);}});

for(const field of ['uid','staffId','jobId','type','purpose'])await test('tampered receipt identity refuses replay '+field,async()=>{const h=harness(),first=await retryStart(h);h.records.get('submissions/'+first.submissionId)[field]='other';await assert.rejects(retryStart(h),e=>e.code==='failed-precondition');assert.equal(h.metadataReads??0,0);});
await test('missing or changed child never recreates a partially corrupt receipt',async()=>{for(const missing of [true,false]){const h=harness(),first=await retryStart(h),key='submissions/'+first.submissionId+'/files/'+first.files[0].fileId;if(missing)h.records.delete(key);else h.records.get(key).contentSha256='b'.repeat(64);const before=JSON.stringify([...h.records]);await assert.rejects(retryStart(h),e=>e.code==='failed-precondition');assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.metadataReads??0,0);}});
for(const status of ['submitted','completed'])await test('same replacement receipt can be checked after request becomes '+status,async()=>{const h=harness(),req={companyId:'synthetic-company',jobId:'synthetic-job',staffId:'synthetic-staff',type:'report',status:'open'};h.records.set('resubmissionRequests/request-a',req);const first=await retryStart(h,1,{purpose:'replacement',resubmissionRequestId:'request-a'});presentObject(h,first.files[0]);Object.assign(h.records.get('resubmissionRequests/request-a'),{status,replacementSubmissionId:first.submissionId});const again=await retryStart(h,1,{purpose:'replacement',resubmissionRequestId:'request-a'});assert.equal(again.files[0].uploadRequired,false);assert.equal(h.records.get('resubmissionRequests/request-a').status,status);h.records.get('resubmissionRequests/request-a').replacementSubmissionId='another-receipt';await assert.rejects(retryStart(h,1,{purpose:'replacement',resubmissionRequestId:'request-a'}),e=>e.code==='failed-precondition');});
await test('paused transfer rejects replay without changing retained receipt or Storage',async()=>{const h=harness();await retryStart(h);pauseTransfers(h);const before=JSON.stringify([...h.records]);await assert.rejects(retryStart(h),e=>e.code==='failed-precondition');assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.metadataReads??0,0);});
for(const flag of ['sourceMissing','applicationUnconfirmed','assignmentUnresolved'])for(const period of ['current','outside-window'])await test('resubmission readiness '+period+' '+flag,async()=>{const h=harness(),job=h.records.get('jobs/synthetic-job');job.dateKey=period==='outside-window'?'2000-01-01':new Date(Date.now()+9*3600000).toISOString().slice(0,10);job[flag]=true;h.records.set('resubmissionRequests/pending',{companyId:'synthetic-company',staffId:'synthetic-staff',jobId:'synthetic-job',type:'report',status:'open',createdAt:Timestamp.now()});const before=JSON.stringify([...h.records]);const waiting=await h.tasks.getMyTasks({auth:h.staff,data:{}});assert.equal(waiting.tasks.filter(t=>t.kind==='resubmission').length,0);assert.equal(JSON.stringify([...h.records]),before);job[flag]=false;const ready=await h.tasks.getMyTasks({auth:h.staff,data:{}});assert.equal(ready.tasks.filter(t=>t.kind==='resubmission').length,1);});
for(const flag of ['sourceMissing','applicationUnconfirmed','assignmentUnresolved'])await test('netprint registration retains numbers without notifying an unconfirmed assignment '+flag,async()=>{const h=harness();h.records.get('jobs/synthetic-job')[flag]=true;await h.netprint.updateNetPrintNumbers({auth:h.admin,data:{jobId:'synthetic-job',numbers:['12345678']}});assert.equal(h.list('notificationQueue').length,0);assert.equal(h.records.get('jobs/synthetic-job').netPrint.items[0].number,'12345678');h.records.get('jobs/synthetic-job')[flag]=false;await h.netprint.updateNetPrintNumbers({auth:h.admin,data:{jobId:'synthetic-job',numbers:['87654321']}});const notice=h.list('notificationQueue')[0];assert.equal(notice.reminderContext.kind,'netprint-update');assert.equal(notice.reminderContext.jobId,'synthetic-job');});
await test('idempotent receipt -> interrupted replacement -> admin comparison -> completed retains original files',async()=>{
const h=harness(),initial=await retryStart(h);await h.finish(initial.files[0]);const originalDrive=h.records.get('submissions/'+initial.submissionId+'/files/'+initial.files[0].fileId).driveFileId;
const request=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',sourceSubmissionId:initial.submissionId,sourceFileId:initial.files[0].fileId,reasons:['その他']}});
const options={clientRequestId:'22222222-2222-4222-8222-222222222222',purpose:'replacement',resubmissionRequestId:request.requestId};const accepted=await retryStart(h,1,options),recovered=await retryStart(h,1,options);assert.equal(accepted.submissionId,recovered.submissionId);assert.notEqual(initial.files[0].fileId,accepted.files[0].fileId);assert.equal(h.list('submissions').length,2);assert.equal(h.records.get('resubmissionRequests/'+request.requestId).status,'open');
await h.finish(recovered.files[0]);assert.equal(h.records.get('resubmissionRequests/'+request.requestId).status,'submitted');const again=await retryStart(h,1,options);assert.equal(again.files[0].uploadRequired,false);const comparison=await h.views.getResubmissionComparison({auth:h.admin,data:request});assert.equal(comparison.source.id,initial.files[0].fileId);assert.equal(comparison.replacements.length,1);assert.equal(comparison.replacements[0].submissionId,accepted.submissionId);
await h.requests.completeResubmissionRequest({auth:h.admin,data:request});await h.requests.completeResubmissionRequest({auth:h.admin,data:request});assert.equal(h.records.get('resubmissionRequests/'+request.requestId).status,'completed');assert.equal(h.driveFiles.size,2);assert.ok(h.driveFiles.has(originalDrive));assert.equal(h.list('submissions').length,2);assert.equal((await h.state(initial.submissionId)).completedFiles,1);assert.equal((await h.state(accepted.submissionId)).completedFiles,1);
});

await test('resubmission queue records the transaction current assignment and request identity',async()=>{const h=harness();h.records.get('jobs/synthetic-job').revision=4;h.beforeCommit=async()=>{h.beforeCommit=null;await h.updateRecord('jobs/synthetic-job',{revision:5,dateKey:'2026-09-21'});};const r=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}});const notices=h.list('notificationQueue');assert.equal(notices.length,1);const c=notices[0].reminderContext;assert.equal(c.version,1);assert.equal(c.kind,'resubmission');assert.equal(c.jobId,'synthetic-job');assert.equal(c.staffId,'synthetic-staff');assert.equal(c.dateKey,'2026-09-21');assert.equal(c.revision,5);assert.equal(c.requestId,r.requestId);assert.equal(c.requestType,'report');assert.equal(h.list('resubmissionRequests').length,1);});


for(const mode of ['normal','recovery','replacement'])await test('multi-file completion uses the latest transferred file time '+mode,async()=>{
 const h=harness();const patch={};let request;
 if(mode==='replacement'){request=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',reasons:['その他']}});Object.assign(patch,{purpose:'replacement',resubmissionRequestId:request.requestId});}
 const s=await h.start(2,patch);h.driveCreatedAt='2026-09-24T02:05:00.000Z';await h.finish(s.files[0]);h.driveCreatedAt='2026-09-24T01:55:00.000Z';
 if(mode==='recovery'){h.failWrite=w=>w.ref.path.startsWith('sheetSyncQueue/');await assert.rejects(h.finish(s.files[1]));h.failWrite=null;}
 await h.finish(s.files[1]);const parent=h.records.get('submissions/'+s.submissionId),report=h.records.get('jobs/synthetic-job').submissionStatus.report;
 assert.equal(parent.completedAt.toDate().toISOString(),'2026-09-24T02:05:00.000Z');assert.equal(report.firstCompletedAt.toDate().toISOString(),'2026-09-24T02:05:00.000Z');assert.equal(report.latestCompletedAt.toDate().toISOString(),'2026-09-24T02:05:00.000Z');assert.equal(report.lateFirstSubmission,true);assert.equal(h.list('sheetSyncQueue').at(-1).updates.reportSubmitted,'遅延');
 const before=JSON.stringify(report);await h.finish(s.files[0]);assert.equal(JSON.stringify(h.records.get('jobs/synthetic-job').submissionStatus.report),before);assert.equal(h.copies,2);
 if(request){assert.equal(h.records.get('resubmissionRequests/'+request.requestId).submittedAt.toDate().toISOString(),'2026-09-24T02:05:00.000Z');await h.requests.completeResubmissionRequest({auth:h.admin,data:request});}
});


for(const mode of ['missing','extra','foreign','missing-time','uncounted','incomplete'])await test('all-file completion refuses inconsistent sibling '+mode,async()=>{
 const h=harness(),s=await h.start(2);await h.finish(s.files[0]);const p='submissions/'+s.submissionId+'/files/'+s.files[0].fileId,original={...h.records.get(p)};
 if(mode==='missing')h.records.delete(p);if(mode==='extra')h.records.set(p+'-extra',{...original});if(mode==='foreign')h.records.get(p).companyId='other';if(mode==='missing-time'){delete h.records.get(p).transferCompletedAt;delete h.records.get(p).completedAt;}if(mode==='uncounted')h.records.get(p).completionCounted=false;if(mode==='incomplete')h.records.get(p).status='processing';
 await assert.rejects(h.finish(s.files[1]),e=>e.code==='failed-precondition');assert.equal(h.records.get('jobs/synthetic-job').submissionStatus,undefined);assert.equal(h.list('sheetSyncQueue').length,0);assert.equal(h.copies,2);assert.equal(h.driveFiles.size,2);
 h.records.set(p,original);h.records.delete(p+'-extra');await h.finish(s.files[1]);assert.equal(h.records.get('jobs/synthetic-job').submissionStatus.report.completed,true);assert.equal(h.copies,2);
});
await test('known completed sibling timestamp supports a legacy transfer checkpoint',async()=>{const h=harness(),s=await h.start(2);h.driveCreatedAt='2026-09-24T02:05:00.000Z';await h.finish(s.files[0]);delete h.records.get('submissions/'+s.submissionId+'/files/'+s.files[0].fileId).transferCompletedAt;h.driveCreatedAt='2026-09-24T01:55:00.000Z';await h.finish(s.files[1]);assert.equal(h.records.get('submissions/'+s.submissionId).completedAt.toDate().toISOString(),'2026-09-24T02:05:00.000Z');});
await test('replay preserves already applied historical completion timestamp',async()=>{const h=harness(),s=await h.start(2);await h.finish(s.files[0]);await h.finish(s.files[1]);const parent=h.records.get('submissions/'+s.submissionId),old=Timestamp.fromMillis(Date.parse('2026-09-20T01:00:00Z'));parent.completedAt=old;const before=JSON.stringify(h.records.get('jobs/synthetic-job').submissionStatus),queues=h.list('sheetSyncQueue').length;await h.finish(s.files[0]);assert.equal(h.records.get('submissions/'+s.submissionId).completedAt.toMillis(),old.toMillis());assert.equal(JSON.stringify(h.records.get('jobs/synthetic-job').submissionStatus),before);assert.equal(h.list('sheetSyncQueue').length,queues);assert.equal(h.copies,2);});
await test('job completion refuses caller time different from persisted receipt',async()=>{const h=harness(),s=await h.start();await h.finish(s.files[0]);h.records.get('submissions/'+s.submissionId).jobStatusApplied=false;const before=JSON.stringify([...h.records]);await assert.rejects(h.status.markSubmissionCompleted({submissionId:s.submissionId,jobId:'synthetic-job',type:'report',submittedAt:Timestamp.fromMillis(0)}),e=>e.code==='failed-precondition');assert.equal(JSON.stringify([...h.records]),before);});


for(const scope of ['file','submission'])await test('comparison returns explicit replacement scope '+scope,async()=>{const h=harness(),s=await h.start();await h.finish(s.files[0]);const req=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type:'report',sourceSubmissionId:s.submissionId,...(scope==='file'?{sourceFileId:s.files[0].fileId}:{}),reasons:['その他']}});const detail=await h.views.getResubmissionComparison({auth:h.staff,data:req});assert.equal(detail.request.scope,scope);assert.equal(detail.source!==null,scope==='file');if(scope==='submission'){const upload=await h.start(20,{purpose:'replacement',resubmissionRequestId:req.requestId});assert.equal(upload.files.length,20);}else await assert.rejects(h.start(2,{purpose:'replacement',resubmissionRequestId:req.requestId}),e=>e.code==='invalid-argument');});


// 同じメモリDBに実API・原本照合・転送処理を接続し、スタッフと管理者の往復を検証する。
async function staffAdminJourneyHarness() {
 // 応募可能な翌日の合成案件を使い、暦日が進んでも過去案件にならないようにする。
 const dateKey=new Date(Date.now()+33*3600000).toISOString().slice(0,10),sheetName=dateKey.slice(0,4)+'.'+Number(dateKey.slice(5,7));
 const h=harness(),companyId='synthetic-company',jobId=h.loadModule('./case-id').createJobIdFromPersistedCaseId(companyId,'synthetic-case'),sheetId='synthetic-sheet';
 h.jobId=jobId;h.records.set('jobs/'+jobId,h.records.get('jobs/synthetic-job'));h.records.delete('jobs/synthetic-job');const start=h.start;h.start=(count,patch={})=>start(count,{jobId,...patch});
 h.current=()=>h.records.get('jobs/'+jobId);
 Object.assign(h.current(),{status:'open',assignedStaffId:null,assignedStaffName:null,revision:0,publishable:true,caseId:'synthetic-case',workDate:dateKey,makerName:'Synthetic maker',menuName:'Synthetic menu',workTime:'10:00-18:00',sheetRef:{spreadsheetId:sheetId,sheetId:1,sheetName,currentRow:2}});
 h.records.get('staffProfiles/synthetic-staff').active=true;
 const row=Array(55).fill('');Object.assign(row,{0:dateKey,1:'',9:'Synthetic Client',10:'Synthetic Store',11:'Synthetic maker',12:'Synthetic menu',14:'10:00-18:00',16:'synthetic-case'});h.row=row;h.sheetWrites=[];
 h.records.set('sheetImportConfigs/'+companyId,{companyId,enabled:true,spreadsheetId:sheetId,headerRow:1,dataStartRow:2,readRangeEndColumn:'BC',columns:{workDate:'A',staffName:'B',clientName:'J',storeName:'K',makerName:'L',menuName:'M',workTime:'O',caseId:'Q'}});
 h.records.set('companies/'+companyId+'/sheetMappings/shift',{enabled:true,spreadsheetId:sheetId,idColumn:'Q',columns:{staffName:'B',workDate:'A',reportSubmitted:'I'},operations:{'job.assign':{values:['staffName']},'submission.report':{values:['reportSubmitted']}}});
 const column=range=>{assert.ok(range.startsWith("'"+sheetName+"'!"));const letters=range.split('!')[1].match(/^[A-Z]+/)[0];return [...letters].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;};
 h.sheets={spreadsheets:{get:async input=>{assert.equal(input.spreadsheetId,sheetId);return {data:{sheets:[{properties:{sheetId:1,title:sheetName,gridProperties:{rowCount:100,columnCount:55}}}]}};},values:{
  get:async input=>{assert.equal(input.spreadsheetId,sheetId);return {data:{values:input.range.includes('Q:Q')?[['case'],[row[16]]]:[Array(55).fill('header'),[...row]]}};},
  batchGet:async input=>{assert.equal(input.spreadsheetId,sheetId);return {data:{valueRanges:input.ranges.map(range=>({values:[[row[column(range)]]]}))}};},
  batchUpdate:async input=>{assert.equal(input.spreadsheetId,sheetId);h.sheetWrites.push(copy(input));for(const entry of input.requestBody.data)row[column(entry.range)]=entry.values[0][0];return {data:{}};}
 }}};
 h.adminCall=(name,data)=>h.loadModule('./admin-operations')[name]({auth:h.admin,data:{jobId,...data}});
 h.runSheet=async id=>h.loadModule('./safe-sheet-writes').processSafeSheetWrite({data:{after:h.snapshot('sheetSyncQueue/'+id)}});
 h.sync=()=>h.loadModule('./shift-import').syncShiftSheetsReadOnly({auth:h.admin,data:{}});
 h.apply=()=>h.loadModule('./jobs').applyToJob({auth:h.staff,data:{jobId,requestId:'journey-application-0001'}});
 await h.sync();return h;
}
for(const scope of ['file','submission'])await test('staff-admin journey '+scope,async()=>{
 const h=await staffAdminJourneyHarness();await h.apply();const assignedRevision=h.current().revision;
 assert.equal(h.current().applicationUnconfirmed,true);
 await assert.rejects(h.adminCall('confirmApplication',{expectedRevision:assignedRevision-1}),e=>e.code==='failed-precondition');
 await h.adminCall('confirmApplication',{expectedRevision:assignedRevision});assert.equal(h.current().applicationAdminConfirmed,true);
 await assert.rejects(h.start(),e=>e.code==='failed-precondition'&&e.details.reason==='assignment_sheet_confirmation_pending');
 const assignment=h.list('sheetSyncQueue').find(q=>q.operation==='job.assign');await h.runSheet(assignment.id);
 assert.equal(h.records.get('sheetSyncQueue/'+assignment.id).status,'completed');assert.equal(h.row[1],'Synthetic Staff');
 assert.equal(h.current().applicationUnconfirmed,true);await h.sync();assert.equal(h.current().applicationUnconfirmed,false);assert.equal(h.current().applicationAdminConfirmed,true);
 const first=await h.start(2);await h.finish(first.files[0]);await h.finish(first.files[1]);
 const originalIds=first.files.map(f=>h.records.get('submissions/'+first.submissionId+'/files/'+f.fileId).driveFileId);
 const timeline=await h.views.getSubmissionTimeline({auth:h.admin,data:{jobId:h.jobId,type:'report'}});assert.equal(timeline.submissions.length,1);assert.equal(timeline.submissions[0].files.length,2);
 const report=h.list('sheetSyncQueue').find(q=>q.operation==='submission.report');await h.runSheet(report.id);assert.equal(h.records.get('sheetSyncQueue/'+report.id).status,'completed');assert.equal(h.current().submissionStatus.report.sheetWrite.pending,false);
 const request=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:h.jobId,type:'report',sourceSubmissionId:first.submissionId,...(scope==='file'?{sourceFileId:first.files[0].fileId}:{}),reasons:['その他']}});
 const before=await h.views.getResubmissionComparison({auth:h.staff,data:request});assert.equal(before.request.scope,scope);
 const count=scope==='file'?1:2,replacement=await h.start(count,{purpose:'replacement',resubmissionRequestId:request.requestId});
 await assert.rejects(h.requests.completeResubmissionRequest({auth:h.admin,data:request}),e=>e.code==='failed-precondition');
 if(count===2){await h.finish(replacement.files[0]);await assert.rejects(h.requests.completeResubmissionRequest({auth:h.admin,data:request}),e=>e.code==='failed-precondition');}
 await h.finish(replacement.files.at(-1));
 assert.equal((await h.requests.getAdminResubmissionRequests({auth:h.admin,data:{}})).requests[0].status,'submitted');
 const comparison=await h.views.getResubmissionComparison({auth:h.admin,data:request});assert.equal(comparison.request.scope,scope);assert.equal(comparison.replacements.length,count);
 await h.requests.completeResubmissionRequest({auth:h.admin,data:request});
 assert.equal((await h.requests.getAdminResubmissionRequests({auth:h.admin,data:{}})).requests.length,0);assert.equal((await h.requests.getMyResubmissionRequests({auth:h.staff,data:{}})).requests.length,0);
 assert.equal((await h.tasks.getMyTasks({auth:h.staff,data:{}})).tasks.filter(t=>t.kind==='resubmission').length,0);
 for(const id of originalIds)assert.ok(h.driveFiles.has(id));assert.equal(h.driveFiles.size,2+count);
 assert.equal(h.list('auditLogs').filter(a=>a.action==='application.confirm').length,1);
});
await test('staff-admin journey source conflict keeps submission blocked',async()=>{
 const h=await staffAdminJourneyHarness();await h.apply();await h.adminCall('confirmApplication',{expectedRevision:h.current().revision});h.row[1]='Other Staff';
 const assignment=h.list('sheetSyncQueue').find(q=>q.operation==='job.assign');await h.runSheet(assignment.id);
 assert.notEqual(h.records.get('sheetSyncQueue/'+assignment.id).status,'completed');assert.equal(h.sheetWrites.length,0);
 await assert.rejects(h.start(),e=>e.code==='failed-precondition');assert.equal(h.list('submissions').length,0);assert.equal(h.row[1],'Other Staff');
});


// 実保存→初回遅延判定→再提出→管理者の必要集計を同じ合成DBで接続する。
for(const type of ['report','sales_floor'])for(const timing of ['late-first','on-time-first'])await test('submission analytics journey '+type+' '+timing,async()=>{
 const h=harness(),job=h.records.get('jobs/synthetic-job'),field=type==='report'?'report':'salesFloor',lateKey=type==='report'?'reportLate':'salesFloorLate';
 Object.assign(job,{financials:{clientChargeTotal:10000,clientChargeAdditionsTotal:500,staffPaymentTotal:8000},expenses:{transportation:900}});
 const analytics=h.loadModule('./analytics'),read=()=>analytics.getStaffPerformance({auth:h.admin,data:{staffId:'synthetic-staff',from:'2026-09-01',through:'2026-09-30'}});
 h.records.set('jobs/foreign',{...copy(job),companyId:'other-company',submissionStatus:{report:{lateFirstSubmission:true},salesFloor:{lateFirstSubmission:true}}});
 h.records.set('jobs/outside-month',{...copy(job),dateKey:'2026-10-01',submissionStatus:{report:{lateFirstSubmission:true},salesFloor:{lateFirstSubmission:true}}});
 h.records.set('jobs/other-staff',{...copy(job),assignedStaffId:'other-staff',financials:{clientChargeTotal:2000,staffPaymentTotal:1000},submissionStatus:{report:{lateFirstSubmission:true},salesFloor:{lateFirstSubmission:true}}});
 const first=await h.start(2,{type});h.driveCreatedAt='2026-09-24T01:55:00.000Z';await h.finish(first.files[0]);assert.equal((await read()).performance.totals[lateKey],0);
 h.driveCreatedAt=timing==='late-first'?'2026-09-24T02:05:00.000Z':'2026-09-24T01:59:00.000Z';await h.finish(first.files[1]);
 const expectedLate=timing==='late-first'?1:0,firstStatus=copy(h.records.get('jobs/synthetic-job').submissionStatus[field]);assert.equal(firstStatus.lateFirstSubmission,expectedLate===1);
 const request=await h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:'synthetic-job',type,sourceSubmissionId:first.submissionId,reasons:['その他']}});
 const replacement=await h.start(2,{type,purpose:'replacement',resubmissionRequestId:request.requestId});h.driveCreatedAt='2026-09-25T02:05:00.000Z';await h.finish(replacement.files[0]);await h.finish(replacement.files[1]);await h.requests.completeResubmissionRequest({auth:h.admin,data:request});
 const after=h.records.get('jobs/synthetic-job').submissionStatus[field];assert.equal(after.firstCompletedAt.toMillis(),firstStatus.firstCompletedAt.toMillis());assert.equal(after.lateFirstSubmission,expectedLate===1);
 const stats=(await read()).performance;assert.equal(stats.totals.assignedJobs,1);assert.equal(stats.totals[lateKey],expectedLate);assert.equal(stats.totals[type==='report'?'salesFloorLate':'reportLate'],0);assert.equal(stats.totals.invoice,10500);assert.equal(stats.totals.payment,8000);assert.equal(stats.recentJobs.length,1);assert.equal(stats.recentJobs[0].id,'synthetic-job');
 const monthly=await analytics.getOperationsDashboard({auth:h.admin,data:{month:'2026-09'}});assert.equal(monthly.counts.totalRequests,2);assert.equal(monthly.finance.bookedInvoice,12500);assert.equal(monthly.finance.bookedPayment,9000);assert.equal(monthly.finance.bookedGrossProfit,3500);
 assert.equal(h.records.get('resubmissionRequests/'+request.requestId).status,'completed');assert.equal(h.driveFiles.size,4);
});


// 受信→Crew作成→募集→応募→原本再取込の合成結果を、既存の提出ハーネスへ渡す。
async function mailSubmissionHarness(){
 const {fixture}=await import('./case-mail-assignment-harness.mjs');
 const m=await fixture();await m.apply();await m.run();await m.importRow();
 const h=harness();h.records.clear();for(const [key,value] of m.records)h.records.set(key,copy(value));
 h.staff=m.staffAuth;h.admin=m.auth;h.jobId=m.jobId;h.job=()=>h.records.get('jobs/'+h.jobId);h.mail=m;
 h.records.set('companies/'+h.job().companyId+'/settings/drive',{rootFolderId:'synthetic-root'});
 h.start=(count=1,patch={})=>h.uploads.createUploadSession({auth:h.staff,data:{jobId:h.jobId,type:'report',expectedRevision:h.job().revision,files:Array.from({length:count},(_,i)=>({originalName:'synthetic-'+i+'.png',contentType:'image/png',size:100})),...patch}});
 h.state=id=>h.views.getSubmissionProcessingStatus({auth:h.staff,data:{jobId:h.jobId,submissionId:id}});
 h.createRequest=(patch={})=>h.requests.createResubmissionRequest({auth:h.admin,data:{jobId:h.jobId,type:'report',expectedRevision:h.job().revision,reasons:['その他'],...patch}});
 h.patch=data=>h.updateRecord('jobs/'+h.jobId,data);
 h.sheets=m.sheets;
 const mapping=h.records.get(m.paths.mapping);Object.assign(mapping.columns,{reportSubmitted:'P',salesFloorSubmitted:'Q',netPrint1:'R',netPrint2:'S',netPrint3:'T'});
 Object.assign(mapping.operations,{'submission.report':{values:['reportSubmitted']},'submission.sales_floor':{values:['salesFloorSubmitted']},'netprint.printed':{values:[],styles:['netPrint1','netPrint2','netPrint3']}});
 h.runSheet=async q=>h.loadModule('./safe-sheet-writes').processSafeSheetWrite({data:{after:h.snapshot('sheetSyncQueue/'+q.id)}});
 return h;
}
const mailHolds=[{mailIntakeReviewRequired:true},{pendingSourceWrite:true},{adminEditSheetWrite:{pending:true}},{applicationUnconfirmed:true}];
for(const type of ['report','sales_floor'])await test('case-mail submission complete '+type+' photo/PDF replacement and replay',async()=>{
 const h=await mailSubmissionHarness();const s=await h.start(2,{type,files:[{originalName:'photo.png',contentType:'image/png',size:100},{originalName:'document.pdf',contentType:'application/pdf',size:100}]});
 await h.finish(s.files[0]);h.drivePayload=()=>({mimeType:'application/pdf'});await h.finish(s.files[1],{contentType:'application/pdf'});
 assert.equal((await h.state(s.submissionId)).status,'completed');assert.equal(h.copies,2);
 const q=h.list('sheetSyncQueue').find(q=>q.operation===(type==='report'?'submission.report':'submission.sales_floor'));const before=h.mail.row.slice();await h.runSheet(q);
 assert.equal(h.records.get('sheetSyncQueue/'+q.id).status,'completed');assert.equal(h.mail.row[15+(type==='sales_floor'?1:0)],type==='report'?'提出済':'リップ');
 for(let n=0;n<before.length;n++)if(n!==15+(type==='sales_floor'?1:0))assert.equal(h.mail.row[n],before[n]);
 const r=await h.createRequest({type,sourceSubmissionId:s.submissionId,sourceFileId:s.files[1].fileId});
 const replacement=await h.start(1,{type,purpose:'replacement',resubmissionRequestId:r.requestId,files:[{originalName:'replacement.pdf',contentType:'application/pdf',size:100}]});
 await h.finish(replacement.files[0],{contentType:'application/pdf'});await h.requests.completeResubmissionRequest({auth:h.admin,data:r});
 const comparison=await h.views.getResubmissionComparison({auth:h.admin,data:r});assert.equal(comparison.request.status,'completed');assert.equal(comparison.replacements.length,1);
 await h.finish(replacement.files[0],{contentType:'application/pdf'});assert.equal(h.copies,3);assert.equal(h.records.get('submissions/'+replacement.submissionId).completedFiles,1);
});
for(const patch of mailHolds)await test('case-mail submission held admissions '+JSON.stringify(patch),async()=>{
 const h=await mailSubmissionHarness();await h.patch(patch);const before=JSON.stringify([...h.records]);
 await assert.rejects(h.start(),{code:'failed-precondition'});await assert.rejects(h.createRequest(),{code:'failed-precondition'});
 await assert.rejects(h.status.setSalesFloorClientSubmitted({auth:h.staff,data:{jobId:h.jobId,submitted:true,expectedRevision:h.job().revision}}),{code:'failed-precondition'});
 await assert.rejects(h.netprint.markNetPrintPrinted({auth:h.staff,data:{jobId:h.jobId,itemId:'item',expectedRevision:h.job().revision}}),{code:'failed-precondition'});
 assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.copies,0);
});
for(const revision of [undefined,-1,0,99])await test('case-mail submission stale displayed revision '+revision,async()=>{
 const h=await mailSubmissionHarness();await assert.rejects(h.start(1,{expectedRevision:revision}));assert.equal(h.list('submissions').length,0);
});
await test('case-mail submission not accepted response permits only matching local attempt reset',async()=>{
 const h=await mailSubmissionHarness(),clientRequestId=crypto.randomUUID();await assert.rejects(h.start(1,{clientRequestId,expectedRevision:0,files:[{originalName:'a.png',contentType:'image/png',size:100,contentSha256:'a'.repeat(64)}]}),e=>e.details?.accepted===false&&e.details.clientRequestId===clientRequestId&&e.details.expectedRevision===0);
 assert.equal(h.list('submissions').length,0);
});
await test('case-mail submission replay keeps one receipt and never adopts changed conditions',async()=>{
 const h=await mailSubmissionHarness(),input={clientRequestId:crypto.randomUUID(),files:[{originalName:'a.png',contentType:'image/png',size:100,contentSha256:'a'.repeat(64)}]};const s=await h.start(1,input);assert.equal((await h.start(1,input)).submissionId,s.submissionId);
 await h.patch({menuConditions:['changed']});await assert.rejects(h.start(1,input),e=>e.details?.reason==='case_mail_submission_changed'&&e.details.accepted!==false);assert.equal(h.list('submissions').length,1);assert.equal(h.copies,0);
});
const mailChanges=[...mailHolds,{menuConditions:['changed']},{revision:99},{assignedStaffId:'staff-2'},{cancelled:true},{companyId:'foreign'},{dateKey:'2099-10-11'}];
for(const patch of mailChanges)for(const phase of ['before','during'])await test('case-mail submission '+phase+' transfer rejects '+JSON.stringify(patch),async()=>{
 const h=await mailSubmissionHarness(),s=await h.start();if(phase==='before')await h.patch(patch);else h.afterCopy=()=>h.patch(patch);
 await assert.rejects(h.finish(s.files[0]),{code:'failed-precondition'});const parent=h.records.get('submissions/'+s.submissionId),file=h.records.get('submissions/'+s.submissionId+'/files/'+s.files[0].fileId);
 assert.equal(parent.completedFiles,0);assert.notEqual(parent.jobStatusApplied,true);assert.equal(parent.status,'error');assert.equal(h.copies,phase==='during'?1:0);assert.equal(h.deletes,0);if(phase==='during')assert.ok(file.driveFileId);assert.equal(h.job().submissionStatus,undefined);
});
await test('case-mail submission transfer condition conflict retains fixed Drive ID for safe retry',async()=>{
 const h=await mailSubmissionHarness(),s=await h.start(),before=copy(h.job());h.afterCopy=()=>h.patch({pendingSourceWrite:true});await assert.rejects(h.finish(s.files[0]));h.afterCopy=null;
 // 合成状態だけを戻す。実受信保留の解除機能・実ファイル再送ではない。
 await h.patch({pendingSourceWrite:before.pendingSourceWrite??false});await h.finish(s.files[0]);assert.equal(h.copies,1);assert.equal((await h.state(s.submissionId)).status,'completed');
});
await test('case-mail submission already completed history is preserved during later hold',async()=>{
 const h=await mailSubmissionHarness(),s=await h.start();await h.finish(s.files[0]);const before=copy(h.records.get('submissions/'+s.submissionId));await h.patch({mailIntakeReviewRequired:true,revision:h.job().revision+1});await assert.rejects(h.finish(s.files[0]));assert.deepEqual(h.records.get('submissions/'+s.submissionId),before);assert.equal((await h.state(s.submissionId)).status,'completed');
});
for(const phase of ['create','replacement','confirm'])await test('case-mail submission resubmission hold at '+phase,async()=>{
 const h=await mailSubmissionHarness(),s=await h.start();await h.finish(s.files[0]);if(phase==='create'){await h.patch({mailIntakeReviewRequired:true});await assert.rejects(h.createRequest({sourceSubmissionId:s.submissionId}));return;}
 const request=await h.createRequest({sourceSubmissionId:s.submissionId});if(phase==='replacement'){await h.patch({menuConditions:['changed']});await assert.rejects(h.start(1,{purpose:'replacement',resubmissionRequestId:request.requestId}));assert.equal(h.list('submissions').length,1);return;}
 const r=await h.start(1,{purpose:'replacement',resubmissionRequestId:request.requestId});await h.finish(r.files[0]);await h.patch({mailIntakeReviewRequired:true});await assert.rejects(h.requests.completeResubmissionRequest({auth:h.admin,data:request}));assert.equal(h.records.get('resubmissionRequests/'+request.requestId).status,'submitted');
});
for(const change of ['held','conditions','source-only'])await test('case-mail submission queued sheet result stops '+change,async()=>{
 const h=await mailSubmissionHarness(),s=await h.start();await h.finish(s.files[0]);const q=h.list('sheetSyncQueue').find(q=>q.operation==='submission.report'),writes=h.mail.writes.length;
 if(change==='held')await h.patch({mailIntakeReviewRequired:true});if(change==='conditions')await h.patch({menuConditions:['changed']});if(change==='source-only')h.mail.row[14]='changed time';
 await h.runSheet(q);assert.equal(h.records.get('sheetSyncQueue/'+q.id).status,'blocked');assert.equal(h.mail.writes.length,writes);assert.equal(h.job().submissionStatus.report.sheetWrite.pending,true);
});
await test('case-mail submission completion rechecks conditions after file bookkeeping',async()=>{
 const h=await mailSubmissionHarness(),s=await h.start();h.beforeCommit=async()=>{const parent=h.list('submissions')[0];if(parent?.status==='completed'&&!parent.jobStatusApplied){h.beforeCommit=null;await h.patch({menuConditions:['changed']});}};
 await assert.rejects(h.finish(s.files[0]));assert.notEqual(h.records.get('submissions/'+s.submissionId).jobStatusApplied,true);assert.equal(h.job().submissionStatus,undefined);assert.equal(h.copies,1);assert.equal(h.deletes,0);
});
await test('case-mail submission print revision and held write protection',async()=>{
 const h=await mailSubmissionHarness();await h.netprint.updateNetPrintNumbers({auth:h.admin,data:{jobId:h.jobId,numbers:['12345678'],expectedRevision:h.job().revision}});const item=h.job().netPrint.items[0];
 await assert.rejects(h.netprint.markNetPrintPrinted({auth:h.staff,data:{jobId:h.jobId,itemId:item.id,expectedRevision:0}}));
 await h.netprint.markNetPrintPrinted({auth:h.staff,data:{jobId:h.jobId,itemId:item.id,expectedRevision:h.job().revision}});assert.equal(h.job().netPrint.items[0].printed,true);
 const q=h.list('sheetSyncQueue').find(q=>q.operation==='netprint.printed');await h.patch({mailIntakeReviewRequired:true});await h.runSheet(q);assert.equal(h.records.get('sheetSyncQueue/'+q.id).status,'blocked');
});

for(const changed of [false,true])await test('case-mail material print original-row confirmation changed='+changed,async()=>{
 const h=await mailSubmissionHarness();await h.netprint.updateNetPrintNumbers({auth:h.admin,data:{jobId:h.jobId,numbers:['12345678'],expectedRevision:h.job().revision}});const item=h.job().netPrint.items[0];h.mail.row[17]=item.number;
 await h.netprint.markNetPrintPrinted({auth:h.staff,data:{jobId:h.jobId,itemId:item.id,expectedRevision:h.job().revision}});const q=h.list('sheetSyncQueue').find(q=>q.operation==='netprint.printed'),styles=[];
 h.sheets.spreadsheets.batchUpdate=async data=>{styles.push(data);return {data:{}};};if(changed)h.mail.row[14]='changed time';const before=h.mail.row.slice();await h.runSheet(q);assert.equal(h.records.get('sheetSyncQueue/'+q.id).status,changed?'blocked':'completed');assert.equal(styles.length,changed?0:1);assert.deepEqual(h.mail.row,before);if(!changed){const request=styles[0].requestBody.requests[0].repeatCell;assert.equal(request.range.startColumnIndex,17);assert.equal(request.fields,'userEnteredFormat.backgroundColor');}
});
await test('case-mail material received change resets earlier print confirmation and retains number',async()=>{
 const h=await mailSubmissionHarness(),m=h.mail;
 await h.netprint.updateNetPrintNumbers({auth:h.admin,data:{jobId:m.jobId,numbers:['12345678'],expectedRevision:m.job().revision}});const item=h.job().netPrint.items[0];await h.netprint.markNetPrintPrinted({auth:h.staff,data:{jobId:m.jobId,itemId:item.id,expectedRevision:m.job().revision}});m.records.set('jobs/'+m.jobId,copy(h.job()));
 assert.equal(m.job().netPrint.items[0].printed,true);await m.changeMail();assert.equal(m.job().netPrint.items[0].printed,false);assert.equal(m.job().netPrint.items[0].number,'12345678');assert.equal(m.job().netPrint.needsPrintReview,true);
});
await test('case-mail material unchanged import retains print; changed revision resets it',async()=>{
 const h=await mailSubmissionHarness(),m=h.mail;
 await h.netprint.updateNetPrintNumbers({auth:h.admin,data:{jobId:m.jobId,numbers:['12345678'],expectedRevision:m.job().revision}});const item=h.job().netPrint.items[0];await h.netprint.markNetPrintPrinted({auth:h.staff,data:{jobId:m.jobId,itemId:item.id,expectedRevision:m.job().revision}});m.records.set('jobs/'+m.jobId,copy(h.job()));await m.importRow();assert.equal(m.job().netPrint.items[0].printed,true);
 m.row[14]='10:00-18:00';await m.importRow();assert.equal(m.job().netPrint.items[0].printed,false);assert.equal(m.job().netPrint.needsPrintReview,true);
});
console.log(JSON.stringify({passed:results.filter(r=>r.ok).length,results,boundary:'Complete actual modules, synthetic callable/Storage/Drive and in-memory DB. No external network, real login, emulator, concurrent SDK transactions or delivery.'},null,2));if(results.some(r=>!r.ok))process.exitCode=1;
