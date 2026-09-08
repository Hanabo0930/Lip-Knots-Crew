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
    else if(v?.__union){const a=next[k]??[];next[k]=[...a,...v.__union.filter(x=>!a.some(y=>JSON.stringify(x)===JSON.stringify(y)))].map(copy);}
    else if(v&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof Timestamp))next[k]=merge(next[k],v);
    else next[k]=copy(v);
  }
  return next;
}
function harness(){
  const records=new Map(),modules=new Map(),versions=new Map();let serial=0,allocated=0;
  const h={records,copies:0,deletes:0,failDelete:false,failCopy:false,failWrite:null,loseCopyResponse:false,getError:null,conflictMismatch:false,beforeCopy:null,afterCopy:null,loaded:[],driveFiles:new Map()};
  const snap=ref=>{const value=copy(records.get(ref.path));return {ref,id:ref.id,exists:records.has(ref.path),data:()=>copy(value)};};
  function commit(writes){
    const next=new Map(records);
    for(const w of writes){
      if(h.failWrite?.(w))throw new Error('synthetic DB write failure');
      if(w.mode==='create')assert.ok(!next.has(w.ref.path),'create exists');
      if(w.mode==='update')assert.ok(next.has(w.ref.path),'update missing');
      let data=w.data;
      if(w.mode==='update'){
        data={};for(const [key,v] of Object.entries(w.data)){const parts=key.split('.');let node=data;for(const part of parts.slice(0,-1))node=node[part]??={};node[parts.at(-1)]=v;}
      }
      next.set(w.ref.path,merge(w.merge||w.mode==='update'?next.get(w.ref.path):{},data));
    }
    records.clear();for(const [k,v]of next)records.set(k,v);for(const w of writes)versions.set(w.ref.path,(versions.get(w.ref.path)??0)+1);
  }
  const ref=p=>({path:p,id:p.split('/').at(-1),collection:n=>collection(`${p}/${n}`),get:async()=>snap(ref(p)),set:async(data,opts)=>commit([{ref:ref(p),data,merge:opts?.merge}])});
  const field=(v,k)=>k.split('.').reduce((x,p)=>x?.[p],v);
  const collection=(name,filters=[],ordering=null,max=Infinity)=>({
    doc:(id=`synthetic-${++serial}`)=>ref(`${name}/${id}`),
    where:(f,op,v)=>{assert.ok(['==','in'].includes(op));return collection(name,[...filters,[f,op,v]],ordering,max);},
    orderBy:(f,d)=>collection(name,filters,[f,d],max),limit:n=>collection(name,filters,ordering,n),
    get:async()=>{
      let entries=[...records].filter(([k,v])=>k.startsWith(name+'/')&&!k.slice(name.length+1).includes('/')&&filters.every(([f,op,x])=>op==='=='?field(v,f)===x:x.includes(field(v,f))));
      if(ordering)entries.sort((a,b)=>{const val=x=>{const v=field(x[1],ordering[0]);return v instanceof Timestamp?v.toMillis():v;};return (val(a)>val(b)?1:val(a)<val(b)?-1:0)*(ordering[1]==='desc'?-1:1);});
      return {docs:entries.slice(0,max).map(([k])=>snap(ref(k)))};
    },
  });
  const writer=w=>({set:(ref,data,opts)=>w.push({ref,data,merge:opts?.merge}),update:(ref,data)=>w.push({ref,data,mode:'update'}),create:(ref,data)=>w.push({ref,data,mode:'create'})});
  const db={collection,doc:ref,batch:()=>{const w=[];return {...writer(w),commit:async()=>commit(w)};},runTransaction:async callback=>{
    for(let attempt=0;attempt<10;attempt++){
      const w=[],reads=new Map();const get=async r=>{assert.equal(w.length,0,'read after write');reads.set(r.path,versions.get(r.path)??0);return snap(r);};
      const result=await callback({...writer(w),get,getAll:(...refs)=>Promise.all(refs.map(get))});
      if([...reads].some(([k,v])=>(versions.get(k)??0)!==v))continue;
      commit(w);return result;
    }
    throw new Error('synthetic transaction contention');
  }};
  const drive={files:{
    generateIds:async()=>({data:{ids:[`allocated-${++allocated}`]}}),
    get:async({fileId})=>{if(h.getError)throw {code:h.getError};const data=h.driveFiles.get(fileId);if(!data)throw {code:404};return {data:copy(data)};},
    list:async()=>({data:{files:[{id:'synthetic-folder'}]}}),
    create:async input=>{
      assert.ok(input.media,'test expects only file copies');await h.beforeCopy?.();if(h.failCopy)throw new Error('synthetic transfer failure');
      const id=input.requestBody.id??`synthetic-drive-${h.copies+1}`;
      if(h.conflictMismatch){h.driveFiles.set(id,{id,name:'unrelated',size:'100'});throw {code:409};}
      if(h.driveFiles.has(id))throw {code:409};
      h.copies++;const data={...input.requestBody,id,size:'100',mimeType:'image/png',md5Checksum:'00000000000000000000000000000000',createdTime:'2099-09-20T02:00:00.000Z'};
      h.driveFiles.set(id,data);await h.afterCopy?.();if(h.loseCopyResponse)throw new Error('synthetic lost response');return {data:copy(data)};
    },
  }};
  const storage={bucket:name=>{assert.equal(name,'synthetic-bucket');return {file:(p,options)=>({createReadStream:()=>{assert.equal(options?.generation,'1');return {syntheticPath:p};},delete:async()=>{h.deletes++;if(h.failDelete)throw new Error('synthetic cleanup failure');}})};}};
  const boundaries={'./firebase':{db,storage},'./google-drive-client':{getWritableDriveClient:()=>drive,getReadonlyDriveClient:()=>{throw new Error('Network refused');}},'firebase-admin/firestore':{Timestamp,FieldValue:{serverTimestamp:()=>Timestamp.now(),delete:()=>deleted,arrayUnion:(...v)=>({__union:v})}},'firebase-functions/v2/https':{HttpsError,onCall:fn=>fn,onRequest:fn=>fn},'firebase-functions/v2/storage':{onObjectFinalized:fn=>fn},'firebase-functions/params':{defineString:(name,options)=>({value:()=>options.default})},zod:dependency('zod'),'node:path':path,'node:crypto':crypto,'node:buffer':{Buffer}};
  function load(name){
    if(Object.hasOwn(boundaries,name))return boundaries[name];assert.match(name,/^\.\/[a-z0-9-]+$/,'External import refused');if(modules.has(name))return modules.get(name);
    const source=fs.readFileSync(new URL(`../functions/src/${name.slice(2)}.ts`,import.meta.url),'utf8');const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports={};modules.set(name,exports);h.loaded.push(name);runInNewContext(code,{exports,require:load,process:{env:{APP_ENVIRONMENT:'development'}}},{timeout:5000});return exports;
  }
  h.uploads=load('./uploads');h.requests=load('./resubmissions');h.views=load('./submission-files');
  h.staff={uid:'synthetic-user',token:{companyId:'synthetic-company',staffId:'synthetic-staff',role:'staff'}};h.admin={uid:'synthetic-admin',token:{companyId:'synthetic-company',role:'admin'}};
  records.set('jobs/synthetic-job',{companyId:'synthetic-company',assignedStaffId:'synthetic-staff',dateKey:'2099-09-20',storeName:'Synthetic Store',clientName:'Synthetic Client'});
  records.set('staffProfiles/synthetic-staff',{companyId:'synthetic-company',displayName:'Synthetic Staff'});
  records.set('companies/synthetic-company/settings/drive',{rootFolderId:'synthetic-root'});
  h.start=(count=1,patch={})=>h.uploads.createUploadSession({auth:h.staff,data:{jobId:'synthetic-job',type:'report',files:Array.from({length:count},(_,i)=>({originalName:`synthetic-${i}.png`,contentType:'image/png',size:100})),...patch}});
  h.finish=(file,patch={})=>h.uploads.finalizeStagedUpload({data:{name:file.storagePath,bucket:'synthetic-bucket',contentType:'image/png',size:100,generation:1,md5Hash:'AAAAAAAAAAAAAAAAAAAAAA==',...patch}});
  h.state=id=>h.views.getSubmissionProcessingStatus({auth:h.staff,data:{jobId:'synthetic-job',submissionId:id}});
  h.list=name=>[...records].filter(([k])=>k.startsWith(name+'/')&&!k.slice(name.length+1).includes('/')).map(([k,v])=>({id:k.split('/').at(-1),...v}));
  return h;
}
const results=[];
async function test(name,run){try{await run();results.push({name,ok:true});}catch(e){results.push({name,ok:false,error:e.message});}}
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
console.log(JSON.stringify({passed:results.filter(r=>r.ok).length,results,boundary:'Complete actual modules, synthetic callable/Storage/Drive and in-memory DB. No external network, real login, emulator, concurrent SDK transactions or delivery.'},null,2));if(results.some(r=>!r.ok))process.exitCode=1;
