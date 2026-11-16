import {createSubmissionAcceptanceKit} from './submission-acceptance-kit.mjs';
import {preparePausedReplay,executePausedReplay,REPLAY_DRIVE_ROOT} from './replay-paused-submission.mjs';
import {verifySubmissionAcceptanceResult} from './submission-acceptance-result.mjs';
import {runSubmissionTimelineWireTests} from './test-submission-timeline-wire.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
const dependency=createRequire(process.env.LKC_TEST_DEPENDENCY_ROOT?path.join(process.env.LKC_TEST_DEPENDENCY_ROOT,'package.json'):import.meta.url);
const ts=dependency('typescript'),{Timestamp}=dependency('firebase-admin/firestore'),{HttpsError}=dependency('firebase-functions/v2/https');
const syntheticBytes=Buffer.alloc(100,0x31);
const syntheticDigest=crypto.createHash('sha256').update(syntheticBytes).digest('hex');
const defaultSubmissionIdentity={companyId:'synthetic-company',staffId:'synthetic-staff',active:true};
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
function harness(sourceFiles=null,compiledFiles=null,sharedRecords){
  const records=sharedRecords??new Map(),modules=new Map(),versions=new Map();let serial=0,allocated=0;
  const h={records,env:{APP_ENVIRONMENT:'development',LKC_SHEET_WRITE_MODE:'active'},documentReads:0,queryReads:0,returnedDocuments:0,copies:0,deletes:0,failDelete:false,failCopy:false,failWrite:null,loseCopyResponse:false,getError:null,conflictMismatch:false,beforeCopy:null,afterCopy:null,loaded:[],driveFiles:new Map()};
  const snap=ref=>{const value=copy(records.get(ref.path));return {ref,id:ref.id,exists:records.has(ref.path),data:()=>copy(value)};};
  async function readDocument(ref){
    const result=snap(ref);
    if(h.afterReadDocument)await h.afterReadDocument(ref.path);
    return result;
  }
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
  const ref=p=>({path:p,id:p.split('/').at(-1),collection:n=>collection(`${p}/${n}`),get:async()=>{h.documentReads++;return readDocument(ref(p));},set:async(data,opts)=>{if(p.startsWith("resubmissionRequests/"))await h.beforeRequestWrite?.();commit([{ref:ref(p),data,merge:opts?.merge}]);},update:async data=>commit([{ref:ref(p),data,mode:"update"}])});
  const field=(v,k)=>k.split('.').reduce((x,p)=>x?.[p],v);
  const collection=(name,filters=[],ordering=null,max=Infinity,after=null)=>({
    queryPath:name,
    doc:(id=`synthetic-${++serial}`)=>ref(`${name}/${id}`),
    add:async data=>{const r=ref(`${name}/synthetic-${++serial}`);await r.set(data);return r;},
    where:(f,op,v)=>{assert.ok(['==','in','>=','<=','<'].includes(op));return collection(name,[...filters,[f,op,v]],ordering,max,after);},
    orderBy:(f,d)=>collection(name,filters,[f,d],max,after),limit:n=>collection(name,filters,ordering,n,after),
    startAfter:cursor=>collection(name,filters,ordering,max,cursor),
    get:async()=>{
      h.queryReads++;let entries=[...records].filter(([k,v])=>k.startsWith(name+'/')&&!k.slice(name.length+1).includes('/')&&filters.every(([f,op,x])=>op==='=='?field(v,f)===x:op==='>='?field(v,f)>=x:op==='<='?field(v,f)<=x:op==='<'?field(v,f)<x:x.includes(field(v,f))));
      if(ordering){
        const [key,direction]=ordering;
        const compare=(a,b)=>{
          const value=entry=>{const data=field(entry[1],key);return data instanceof Timestamp?data.valueOf():data;};
          return (value(a)>value(b)?1:value(a)<value(b)?-1:Buffer.compare(Buffer.from(a[0]),Buffer.from(b[0])))*(direction==="desc"?-1:1);
        };
        entries=entries.filter(entry=>field(entry[1],key)!==undefined).sort(compare);
        if(after)entries=entries.filter(entry=>compare(entry,[after.ref.path,after.data()])>0);
      }
      h.returnedDocuments+=Math.min(entries.length,max);return {docs:entries.slice(0,max).map(([k])=>snap(ref(k))),size:Math.min(entries.length,max)};
    },
  });
  const writer=w=>({delete:ref=>w.push({ref,mode:'delete'}),set:(ref,data,opts)=>w.push({ref,data,merge:opts?.merge}),update:(ref,data)=>w.push({ref,data,mode:'update'}),create:(ref,data)=>w.push({ref,data,mode:'create'})});
  const db={collection,doc:ref,getAll:(...refs)=>Promise.all(refs.map(r=>r.get())),batch:()=>{const w=[];return {...writer(w),commit:async()=>{await h.beforeCommit?.();commit(w);}};},runTransaction:async (callback,options)=>{
    await h.beforeRequestWrite?.();
    for(let attempt=0;attempt<10;attempt++){
      const w=[],reads=new Map();
      const get=async r=>{
        assert.equal(w.length,0,'read after write');
        if(r.queryPath){
          const key='@collection:'+r.queryPath;
          reads.set(key,versions.get(key)??0);
          const result=await r.get();
          for(const doc of result.docs)reads.set(doc.ref.path,versions.get(doc.ref.path)??0);
          return result;
        }
        reads.set(r.path,versions.get(r.path)??0);
        if(options?.readOnly===true&&h.staleReadOnlyRecords?.has(r.path)){
          const value=copy(h.staleReadOnlyRecords.get(r.path));
          return {ref:r,id:r.id,exists:value!==undefined,data:()=>copy(value)};
        }
        return readDocument(r);
      };
      const result=await callback({...writer(w),get,getAll:(...refs)=>Promise.all(refs.map(get))});
      await h.beforeCommit?.(options);
      if(options?.readOnly===true){
        assert.equal(w.length,0,'read-only transaction wrote');
        return result;
      }
      if([...reads].some(([k,v])=>(versions.get(k)??0)!==v))continue;
      commit(w);return result;
    }
    throw new Error('synthetic transaction contention');
  }};
  const folderMime='application/vnd.google-apps.folder';
  h.driveFolders=new Map();
  h.folderCreates=0;h.folderLists=0;h.folderReads=0;h.folderCreateIds=[];
  const drive={files:{
    generateIds:async()=>({data:{ids:[`allocated-${++allocated}`]}}),
    get:async({fileId,fields})=>{
      const folderProbe=fields?.includes('appProperties')&&!fields.includes('md5Checksum');
      if(folderProbe)h.folderReads++;
      const failure=folderProbe?h.folderGetError:h.getError;
      if(failure)throw {code:failure};
      const data=h.driveFolders.get(fileId)??h.driveFiles.get(fileId);
      if(!data)throw {code:404};return {data:copy(data)};
    },
    list:async input=>{
      if(h.driveList)return h.driveList(input);
      h.folderLists++;
      const [,parentId,nameQuery]=input.q.match(/^'([^']+)' in parents and name='((?:\\.|[^'])*)'/)??[];
      assert.ok(parentId); assert.notEqual(nameQuery,undefined);
      const name=nameQuery.replace(/\\(.)/g,'$1');
      const files=[...h.driveFolders.values()].filter(file=>file.parents[0]===parentId&&file.name===name&&!file.trashed);
      if(files.length||h.emptyDriveFolders)return {data:{files:files.map(copy)}};
      const id='fixture-folder-'+crypto.createHash('sha256').update(JSON.stringify([parentId,name])).digest('hex').slice(0,20);
      const folder={id,name,parents:[parentId],mimeType:folderMime,trashed:false};
      h.driveFolders.set(id,folder);
      return {data:{files:[copy(folder)]}};
    },
    create:async input=>{
      if(!input.media){
        const data={...input.requestBody,trashed:false};
        assert.equal(data.mimeType,folderMime);assert.ok(data.id);
        h.folderCreateIds.push(data.id);
        await h.beforeFolderCreate?.(data);
        if(h.driveFolders.has(data.id))throw {code:409};
        h.folderCreates++;h.driveFolders.set(data.id,copy(data));
        await h.afterFolderCreate?.(data);
        return {data:copy(data)};
      }
      await h.beforeCopy?.();if(h.failCopy)throw new Error('synthetic transfer failure');
      const id=input.requestBody.id??`synthetic-drive-${h.copies+1}`;
      if(h.conflictMismatch){h.driveFiles.set(id,{id,name:'unrelated',size:'100'});throw {code:409};}
      if(h.driveFiles.has(id))throw {code:409};
      h.copies++;const data={...input.requestBody,id,size:'100',mimeType:'image/png',md5Checksum:'00000000000000000000000000000000',createdTime:h.driveCreatedAt??'2026-09-20T02:00:00.000Z'};
      if(h.drivePayload)Object.assign(data,h.drivePayload(input));h.driveFiles.set(id,data);await h.afterCopy?.();if(h.loseCopyResponse)throw new Error('synthetic lost response');return {data:copy(data)};
    },
  }};
  const storage={bucket:name=>{assert.equal(name??'synthetic-bucket',h.storageBucket??'synthetic-bucket');return {name:name??'synthetic-bucket',file:(p,options)=>({getMetadata:async()=>{h.metadataReads=(h.metadataReads??0)+1;if(h.metadataError)throw {code:h.metadataError};const object=h.storageObjects?.get(p);if(!object)throw {code:404};return [copy(object)];},createReadStream:readOptions=>{
    if(h.allowLegacyUnversionedRead&&options?.generation===undefined)h.unversionedReads=(h.unversionedReads??0)+1;else assert.equal(options?.generation,'1');
    h.streamReads??=[];h.streamReads.push({path:p,generation:options?.generation,decompress:readOptions?.decompress});
    return {syntheticPath:p,async *[Symbol.asyncIterator](){
      h.byteScans=(h.byteScans??0)+1;
      await h.beforeByteScan?.();
      if(h.byteScanError)throw h.byteScanError instanceof Error?h.byteScanError:new Error('synthetic source read failed');
      yield*(h.byteChunks??[syntheticBytes]);
    }};
  },delete:async()=>{h.deletedPaths??=[];h.deletedPaths.push(p);h.storageObjects?.delete(p);h.deletes++;if(h.failDelete)throw new Error('synthetic cleanup failure');}})};}};
  const boundaries={'firebase-functions/v2/firestore':{onDocumentWritten:(_path,fn)=>fn},'firebase-functions/v2/scheduler':{onSchedule:(_options,fn)=>fn},googleapis:{google:{auth:{GoogleAuth:class{}},monitoring:()=>({}),sheets:()=>{if(h.sheets)return h.sheets;throw Error('External Sheets access refused');}}},'./firebase':{db,storage},'./google-drive-client':{getWritableDriveClient:()=>drive,getReadonlyDriveClient:()=>({files:{get:async()=>{h.previewReads=(h.previewReads??0)+1;const stream={on:()=>stream,pipe:response=>response.end()};return {data:stream};}}})},'firebase-admin/firestore':{Timestamp,FieldValue:{serverTimestamp:()=>Timestamp.now(),delete:()=>deleted,increment:value=>({__increment:value}),arrayUnion:(...v)=>({__union:v})}},'firebase-functions/v2/https':{HttpsError,onCall:(...args)=>args.at(-1),onRequest:fn=>fn},'firebase-functions/v2/storage':{onObjectFinalized:fn=>fn},'firebase-functions/params':{defineString:(name,options)=>({value:()=>name==='FILE_PREVIEW_GATEWAY_URL'?(h.previewBase??options.default):options.default})},zod:dependency('zod'),'node:path':path,'node:crypto':crypto,'node:buffer':{Buffer}};
  function loadCommonJs(name){
    if(modules.has(name))return modules.get(name);
    const module={exports:{}};modules.set(name,module.exports);
    const source=fs.readFileSync(new URL('../functions/src/'+name,import.meta.url),'utf8');
    const restricted=specifier=>{
      if(specifier==='crypto'||specifier==='node:crypto')return crypto;
      assert.match(specifier,/^\.\/[a-z0-9-]+\.cjs$/,specifier);
      return loadCommonJs(path.posix.join(path.posix.dirname(name),specifier));
    };
    runInNewContext('(function(require,module,exports){\n'+source+'\n})',{Buffer},{timeout:5000})(restricted,module,module.exports);
    modules.set(name,module.exports);return module.exports;
  }
  function load(name){
    if(Object.hasOwn(boundaries,name))return boundaries[name];
    if(!sourceFiles&&!compiledFiles&&/^\.\.\/src\/(?:private-ng\/)?[a-z0-9-]+\.cjs$/.test(name))return loadCommonJs(name.slice('../src/'.length));
    assert.match(name,/^\.\/[a-z0-9-]+$/,'External import refused: '+name);if(modules.has(name))return modules.get(name);
    const filename=name.slice(2),source=compiledFiles?compiledFiles[filename+'.js']:sourceFiles?sourceFiles[filename+'.ts']:fs.readFileSync(new URL('../functions/src/'+filename+'.ts',import.meta.url),'utf8');if(typeof source!=='string')throw Error('Historical module missing: '+name);const code=compiledFiles?source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports={};modules.set(name,exports);h.loaded.push(name);runInNewContext(code,{exports,require:load,process:{env:h.env}},{timeout:5000});return exports;
  }
  h.drive=drive;
  h.loadFreshFolderWorker=()=>{modules.delete('./drive-folder-cache');return load('./drive-folder-cache');};
  h.queryDocuments=(name)=>collection(name);
  h.loadModule=load;h.snapshot=p=>snap(ref(p));h.updateRecord=(p,data)=>ref(p).update(data);
  h.status=load('./submission-status');h.uploads=load('./uploads');h.requests=load('./resubmissions');h.views=load('./submission-files');h.tasks=load('./staff-tasks');h.netprint=load('./netprint');h.precontact=load('./precontact');
  h.staff={uid:'synthetic-user',token:{companyId:'synthetic-company',staffId:'synthetic-staff',role:'staff'}};h.admin={uid:'synthetic-admin',token:{companyId:'synthetic-company',role:'admin'}};
  if(!sharedRecords){
    records.set('jobs/synthetic-job',{companyId:'synthetic-company',assignedStaffId:'synthetic-staff',status:'assigned',dateKey:'2026-09-20',storeName:'Synthetic Store',clientName:'Synthetic Client'});
    records.set('staffProfiles/synthetic-staff',{companyId:'synthetic-company',displayName:'Synthetic Staff',active:true});
    records.set('authIdentities/synthetic-user',{...defaultSubmissionIdentity});
    records.set('companies/synthetic-company/settings/drive',{rootFolderId:'synthetic-root'});
  }
  h.start=(count=1,patch={})=>h.uploads.createUploadSession({auth:h.staff,data:{jobId:'synthetic-job',type:'report',files:Array.from({length:count},(_,i)=>({originalName:`synthetic-${i}.png`,contentType:'image/png',size:100})),...patch}});
  h.finish=(file,patch={})=>h.uploads.finalizeStagedUpload({data:{name:file.storagePath,bucket:'synthetic-bucket',contentType:'image/png',size:100,generation:1,md5Hash:'AAAAAAAAAAAAAAAAAAAAAA==',...patch}});
  h.state=id=>h.views.getSubmissionProcessingStatus({auth:h.staff,data:{jobId:'synthetic-job',submissionId:id}});
  h.list=name=>[...records].filter(([k])=>k.startsWith(name+'/')&&!k.slice(name.length+1).includes('/')).map(([k,v])=>({id:k.split('/').at(-1),...v}));
  return h;
}
const runDirectly=Boolean(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href);
const deployedOnly=runDirectly&&process.argv.includes('--deployed-rollback-only');
if(deployedOnly&&!process.env.LKC_DEPLOYED_TRANSFER_BUNDLE)throw Error('Deployed rollback bundle is required.');
const results=[],deployedObservations=[];
const testPrefix=process.argv.find(arg=>arg.startsWith('--test-name-prefix='))?.slice('--test-name-prefix='.length);
async function test(name,run){if(!runDirectly||(testPrefix&&!name.startsWith(testPrefix)))return;if(deployedOnly&&!name.startsWith('deployed rollback '))return;try{await run();results.push({name,ok:true});}catch(e){results.push({name,ok:false,error:e.message});}}
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
 if(mutation.startsWith('missing')||mutation==='wrong-storage-path')await h.finish(file);else await assert.rejects(h.finish(file),{code:'failed-precondition'});
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

function afterReceiptRead(h,submissionId,change){
  const receiptPath="submissions/"+submissionId;
  let changed=false;
  h.afterReadDocument=async path=>{
    if(path!==receiptPath)return;
    h.afterReadDocument=null;
    await change(receiptPath);
    changed=true;
  };
  return ()=>assert.equal(changed,true,"change was applied after the receipt snapshot");
}

for(const [label,path,value,code] of [
  ["identity withdrawn","authIdentities/synthetic-user",{active:false},"permission-denied"],
  ["staff reassigned","jobs/synthetic-job",{assignedStaffId:"other-staff"},"permission-denied"],
  ["job moved to another company","jobs/synthetic-job",{companyId:"other-company"},"not-found"],
])await test("processing status rechecks "+label+" during receipt read",async()=>{
  const h=harness(),session=await h.start();
  await h.finish(session.files[0]);
  const assertChanged=afterReceiptRead(h,session.submissionId,()=>h.updateRecord(path,value));
  await assert.rejects(h.state(session.submissionId),{code});
  assertChanged();
});

await test("processing status returns the confirmed outcome for the same receipt after a concurrent update",async()=>{
  const h=harness(),session=await h.start();
  await h.finish(session.files[0]);
  const receiptPath="submissions/"+session.submissionId;
  await h.updateRecord(receiptPath,{jobStatusApplied:false});
  const assertChanged=afterReceiptRead(h,session.submissionId,path=>h.updateRecord(path,{jobStatusApplied:true}));
  const before=h.copies;
  assert.deepEqual({...await h.state(session.submissionId)},{status:"completed",totalFiles:1,completedFiles:1,errorMessage:null});
  assertChanged();
  assert.equal(h.copies,before);
  assert.equal(h.list("submissions").length,1);
});

for(const mode of ['valid','expired','inactive','file-missing','parent-missing','parent-company','file-company','file-submission','drive-changed','file-status'])await test('preview gateway rechecks source '+mode,async()=>{
 const h=harness(),session=await h.start();await h.finish(session.files[0]);const parent='submissions/'+session.submissionId,file=parent+'/files/'+session.files[0].fileId,raw='synthetic-preview-token-that-is-long-enough-123';
 const token={companyId:'synthetic-company',jobId:'synthetic-job',actorUid:h.admin.uid,actorRole:'admin',submissionId:session.submissionId,fileId:session.files[0].fileId,driveFileId:h.records.get(file).driveFileId,active:true,expiresAt:Timestamp.fromMillis(Date.now()+60000),contentType:'image/png',fileName:'synthetic.png'};
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
for(const withResubmission of [false,true])await test('assigned-only task query / '+(withResubmission?'outside-window replacement':'active shift behind inactive backlog'),async()=>{
 const h=harness();
 const dateKey=new Date(Date.now()+(9-24)*3600000).toISOString().slice(0,10);
 const active={...h.records.get('jobs/synthetic-job'),dateKey,preContact:{temperature:36.5,arrivalTime:'09:00'},
   submissionStatus:{report:{completed:false},salesFloor:{completed:true}}};
 h.records.delete('jobs/synthetic-job');
 for(let i=0;i<2000;i++)h.records.set('jobs/inactive-'+String(i).padStart(4,'0'),{
   ...active,status:['open','cancelled','draft'][i%3],
 });
 h.records.set('jobs/foreign-company',{...active,companyId:'another-company'});
 h.records.set('jobs/foreign-staff',{...active,assignedStaffId:'another-staff'});
 h.records.set('jobs/active-report',active);
 // Older assigned rows can carry a cancellation flag even when status is still "assigned".
 h.records.set('jobs/legacy-cancelled',{...active,cancelled:true});
 if(withResubmission){
  h.records.set('jobs/old-shift',{...active,dateKey:'2000-01-01'});
  h.records.set('resubmissionRequests/valid-old',{companyId:active.companyId,staffId:active.assignedStaffId,
    jobId:'old-shift',type:'report',status:'open',createdAt:Timestamp.now()});
  h.records.set('resubmissionRequests/invalid-cancelled',{companyId:active.companyId,staffId:active.assignedStaffId,
    jobId:'inactive-0001',type:'report',status:'open',createdAt:Timestamp.now()});
 }
 const before=JSON.stringify([...h.records]);
 const read=await h.tasks.getMyTasks({auth:h.staff,data:{}});
 const ids=Array.from(read.tasks,task=>task.id).sort();
 console.log(JSON.stringify({assignedTaskReadBudget:{withResubmission,returnedDocuments:h.returnedDocuments,queryCalls:h.queryReads,ids}}));
 assert.deepEqual(ids,withResubmission?['active-report_report','resubmission_valid-old']:['active-report_report']);
 assert.equal(h.queryReads,2);
 assert.equal(h.returnedDocuments,withResubmission?4:2);
 assert.equal(JSON.stringify([...h.records]),before);
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
 h.records.get('staffProfiles/'+kit.staffId).active=true;
 h.records.set('authIdentities/'+kit.uid,{active:true,companyId:kit.companyId,staffId:kit.staffId});
 const folders=[{id:kit.drive.rootFolderId,name:kit.companyId,parents:[kit.drive.parentId]},{id:'acceptance-client',name:kit.drive.childFolders[0],parents:[kit.drive.rootFolderId]},{id:'acceptance-month',name:kit.drive.childFolders[1],parents:['acceptance-client']}].map(f=>({...f,mimeType:'application/vnd.google-apps.folder',trashed:false}));
 for(const folder of folders)h.driveFolders.set(folder.id,folder);
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
  delete h.records.get(ordinaryFilePath).authorizedStagedKey;
  h.records.set('staffProfiles/ordinary-staff',{active:true,companyId:'ordinary-company'});
  h.records.set('authIdentities/ordinary-user',{active:true,companyId:'ordinary-company',staffId:'ordinary-staff'});
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
 const linkedPath='authIdentities/'+kit.uid,profilePath='staffProfiles/'+kit.staffId;
 assert.deepEqual(copy(h.records.get(linkedPath)),{active:true,companyId:kit.companyId,staffId:kit.staffId});
 const originalProfile=kit.seedDocuments.find(seed=>seed.path===profilePath).data;
 assert.deepEqual(copy(h.records.get(profilePath)),{...originalProfile,active:true});
 // The actual transfer runs with a synthetic active account. Project just the
 // verified test-only auth fixture back to the archived kit shape for its verifier.
 const documents=[...h.records].filter(([path,data])=>data.companyId!=='ordinary-company'&&path!==linkedPath)
  .map(([path,data])=>({path,data:normalize(path===profilePath?originalProfile:data)}));
 const result={project:kit.project,kitFingerprint:kit.fingerprint,startedAt:new Date(now-1000).toISOString(),readAt:new Date(Date.now()).toISOString(),documents,drive:{folders,files:[...h.driveFiles.values()]},storage:kit.files.map(f=>({bucket:kit.storageBucket,path:f.storagePath,generation:'1',size:String(f.size),contentType:f.contentType,md5Base64:f.md5Base64,exists:!h.deletedPaths.includes(f.storagePath)})),counts:Object.fromEntries(['notificationQueue','pushTokens'].map(c=>[c,{companyId:kit.companyId,count:h.list(c).length}])),listingsComplete:true};
 const when=Date.parse(result.readAt),settings={requireFolderBindings:true};
 const check=verifySubmissionAcceptanceResult(kit,result,when,settings);
 assert.deepEqual(check.issues,[]);assert.equal(check.passed,true);
 assert.equal(check.actualCloudAcceptanceVerified,false);assert.equal(check.cloudExecutionAuthorized,false);
 const folderRecords=result.documents.filter(record=>record.path.startsWith('driveSubmissionFolders/'));
 assert.equal(folderRecords.length,2);
 const legacy={...result,documents:result.documents.filter(record=>!folderRecords.includes(record))};
 assert.equal(verifySubmissionAcceptanceResult(kit,legacy,when).passed,true);
 assert.equal(verifySubmissionAcceptanceResult(kit,legacy,when,settings).passed,false);
 const altered={...result,documents:result.documents.map(record=>record===folderRecords[0]?{...record,data:{...record.data,folderId:'different-folder'}}:record)};
 assert.ok(verifySubmissionAcceptanceResult(kit,altered,when,settings).issues.includes('verified_folder_binding'));
 assert.equal(h.copies,2);assert.equal(h.deletes,2);
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
await test('on-demand timeline keeps every file and issues a token only for the selected file',async()=>{
 const h=harness();h.previewBase='https://preview.invalid/files';const accepted=await h.start(2);
 for(const file of accepted.files)await h.finish(file);
 const input={jobId:'synthetic-job',type:'report'};
 const legacy=await h.views.getSubmissionTimeline({auth:h.staff,data:input});
 assert.equal(h.list('filePreviewTokens').length,2);
 const list=await h.views.getSubmissionTimeline({auth:h.staff,data:{...input,previewMode:'on-demand'}});
 assert.equal(h.list('filePreviewTokens').length,2);
 const expected=copy(legacy);for(const group of expected.submissions)for(const file of group.files)file.previewUrl=null;
 assert.deepEqual(copy(list),expected);
 const selection={submissionId:accepted.submissionId,fileId:accepted.files[1].fileId};
 const requested=await h.views.getSubmissionTimeline({auth:h.staff,data:{...input,previewFile:selection}});
 assert.equal(requested.submissions.length,1);assert.equal(requested.submissions[0].files.length,1);
 assert.equal(requested.submissions[0].files[0].id,selection.fileId);
 assert.ok(requested.submissions[0].files[0].previewUrl);
 assert.equal(h.list('filePreviewTokens').length,3);
 await assert.rejects(h.views.getSubmissionTimeline({auth:h.staff,data:{...input,previewMode:'on-demand',previewFile:selection}}));
 await assert.rejects(h.views.getSubmissionTimeline({auth:h.staff,data:{...input,previewMode:'unknown'}}));
 const foreign={...h.staff,token:{...h.staff.token,companyId:'foreign-timeline'}};
 await assert.rejects(h.views.getSubmissionTimeline({auth:foreign,data:{...input,previewMode:'on-demand'}}));
 assert.equal(h.list('filePreviewTokens').length,3);
});
await test('on-demand timeline 300 simultaneous reads keep 6000 files and issue zero tokens',async()=>{
 const h=harness();h.previewBase='https://preview.invalid/files';const accepted=await h.start(20);
 for(const file of accepted.files)await h.finish(file);
 const input={jobId:'synthetic-job',type:'report'};
 const measures=[];
 for(const defer of [false,true]){
  const before=h.list('filePreviewTokens').length;
  const responses=await Promise.all(Array.from({length:300},()=>h.views.getSubmissionTimeline({auth:h.staff,data:{...input,...(defer?{previewMode:'on-demand'}:{})}})));
  assert.equal(responses.filter(response=>response.submissions.length===1&&response.submissions[0].files.length===20).length,300);
  const files=responses.flatMap(response=>response.submissions[0].files);
  measures.push({sessions:responses.length,files:files.length,withPreviewUrl:files.filter(file=>file.previewUrl!==null).length,tokenWrites:h.list('filePreviewTokens').length-before});
 }
 console.log(JSON.stringify({onDemandTimelineOperationCounts:measures,realBillingOrLatencyMeasurement:false}));
 assert.deepEqual(measures,[{sessions:300,files:6000,withPreviewUrl:6000,tokenWrites:6000},{sessions:300,files:6000,withPreviewUrl:0,tokenWrites:0}]);
});


await test('paged timeline bounds initial queries, keeps ties and follows history beyond 100',async()=>{
 const h=harness();h.previewBase='https://preview.invalid/files';
 const accepted=await h.start(2);
 for(const file of accepted.files)await h.finish(file);
 const parent='submissions/'+accepted.submissionId;
 const submitted=h.records.get(parent);
 const originals=accepted.files.map(file=>h.records.get(parent+'/files/'+file.fileId));
 function seed(id,createdAt,patch={}){
  h.records.set('submissions/'+id,{...submitted,createdAt,...patch});
  for(const [index,file] of originals.entries())h.records.set('submissions/'+id+'/files/file-'+index,{...file,submissionId:id,...patch});
 }
 h.records.delete(parent);
 const stamp=Timestamp.fromMillis(1789870000000);
 const ids=Array.from({length:105},(_,i)=>'history-'+String(i).padStart(3,'0'));
 for(const id of ids)seed(id,stamp);
 seed('precise-newer',new Timestamp(stamp.seconds,stamp.nanoseconds+1000));
 seed('foreign-staff',stamp,{staffId:'former-assignee'});
 seed('foreign-company',stamp,{companyId:'other-company'});
 seed('other-job',stamp,{jobId:'other-job'});
 seed('other-type',stamp,{type:'sales_floor'});
 const input={jobId:'synthetic-job',type:'report',previewMode:'on-demand'};
 const read=(patch={},auth=h.staff)=>h.views.getSubmissionTimeline({auth,data:{...input,...patch}});
 const measure=async count=>{
  const docs=h.returnedDocuments,queries=h.queryReads;
  const requests=Array.from({length:300},()=>read(count?{page:{}}:{}));
  const result=await Promise.all(requests);
  for(const page of result){
   assert.equal(page.submissions.length,count?10:100);
   assert.equal(page.submissions[0].id,'precise-newer');
   assert.ok(page.submissions.every(group=>group.files.length===2&&group.files.every(file=>file.previewUrl===null)));
  }
  return {queries:h.queryReads-queries,documents:h.returnedDocuments-docs,page:result[0]};
 };
 const legacy=await measure(false);
 const first=await measure(true);
 assert.deepEqual([legacy.queries,legacy.documents,first.queries,first.documents],[30300,90000,3300,9300]);
 assert.equal(first.page.nextCursor,'history-096');
 assert.equal(h.list('filePreviewTokens').length,0);
 assert.equal(Object.hasOwn(legacy.page,'nextCursor'),false);
 seed('inserted-while-paging',new Timestamp(stamp.seconds+1,0));
 const found=Array.from(first.page.submissions,group=>group.id);
 let next=first.page.nextCursor;
 while(next){
  const result=await read({page:{afterSubmissionId:next}});
  found.push(...result.submissions.map(group=>group.id));
  next=result.nextCursor;
  assert.ok(found.length<=106);
 }
 assert.deepEqual(found,['precise-newer',...ids.toReversed()]);
 assert.equal((await read({page:{}})).submissions[0].id,'inserted-while-paging');
 const preview=await h.views.getSubmissionTimeline({auth:h.staff,data:{jobId:input.jobId,type:input.type,previewFile:{submissionId:ids[0],fileId:'file-1'}}});
 assert.equal(preview.submissions[0].files.length,1);
 assert.ok(preview.submissions[0].files[0].previewUrl);
 assert.equal(h.list('filePreviewTokens').length,1);
 const ordinary=await h.views.getSubmissionTimeline({auth:h.admin,data:{jobId:input.jobId,type:input.type,previewFile:null}});
 assert.equal(ordinary.submissions.length,100);
 assert.equal(Object.hasOwn(ordinary,'nextCursor'),false);
 assert.ok(ordinary.submissions.every(group=>group.files.every(file=>file.previewUrl)));
 for(const afterSubmissionId of ['foreign-staff','foreign-company','other-job','other-type','missing']){
  const queries=h.queryReads;
  await assert.rejects(read({page:{afterSubmissionId}}),{code:'failed-precondition'});
  assert.equal(h.queryReads,queries);
 }
 for(const data of [{page:{afterSubmissionId:'bad/path'}},{page:{limit:1000}},{page:{},previewMode:undefined},{page:{},previewFile:{submissionId:ids[0],fileId:'file-1'}}]){
  await assert.rejects(read(data));
 }
 const cursor={page:{afterSubmissionId:first.page.nextCursor}};
 await assert.rejects(read(cursor,{...h.staff,token:{...h.staff.token,companyId:'other-company'}}),{code:'permission-denied'});
 h.records.get('jobs/synthetic-job').assignedStaffId='reassigned';
 await assert.rejects(read(cursor),{code:'permission-denied'});
 h.records.get('jobs/synthetic-job').assignedStaffId='synthetic-staff';
 h.records.get('authIdentities/synthetic-user').active=false;
 await assert.rejects(read(cursor),{code:'permission-denied'});
 console.log(JSON.stringify({initialSubmissionHistory:{simultaneous:300,queries:[legacy.queries,first.queries],documents:[legacy.documents,first.documents],tokensBeforeSelection:0,allHistoryRecords:found.length}}));
});

await test('paged timeline returns no cursor for empty and exactly full pages',async()=>{
 const h=harness();
 const data={jobId:'synthetic-job',type:'report',previewMode:'on-demand',page:{}};
 const read=()=>h.views.getSubmissionTimeline({auth:h.staff,data});
 assert.deepEqual(JSON.parse(JSON.stringify(await read())),{submissions:[],nextCursor:null});
 const accepted=await h.start();
 const existing=h.records.get('submissions/'+accepted.submissionId);
 for(let i=0;i<9;i++)h.records.set('submissions/exact-'+i,{...existing});
 const final=await read();
 assert.equal(final.submissions.length,10);
 assert.equal(final.nextCursor,null);
});

await test('malformed stored deadline never invents a valid historical rule',async()=>{const h=harness(),s=await h.start();h.records.get('submissions/'+s.submissionId).deadlinePolicy={ruleVersion:'jp-business-day-11-v1',calendarVersion:'cao-2026-2027-20260917',workDate:'2026-02-30',dueAtMs:Date.parse('2026-03-03T02:00:00Z'),status:'known'};await h.finish(s.files[0]);const report=h.records.get('jobs/synthetic-job').submissionStatus.report;assert.equal(report.deadlinePolicy.status,'unrecorded');assert.equal(report.lateFirstSubmission,undefined);assert.equal(report.deadlineReviewRequired,true);});
for(const [flag,reason]of [['sourceMissing','source_unavailable'],['applicationUnconfirmed','assignment_sheet_confirmation_pending'],['assignmentUnresolved','assignment_identity_unresolved']])for(const action of ['upload','client-record'])await test('pending '+flag+' prevents '+action+' without writes',async()=>{const h=harness();const job=h.records.get('jobs/synthetic-job');job[flag]=true;const before=JSON.stringify([...h.records]);const call=()=>action==='upload'?h.start():h.loadModule('./submission-status').setSalesFloorClientSubmitted({auth:h.staff,data:{jobId:'synthetic-job',submitted:true}});await assert.rejects(call(),e=>e.code==='failed-precondition'&&e.details?.reason===reason);assert.equal(JSON.stringify([...h.records]),before);job[flag]=false;await call();});
for(const flag of ['sourceMissing','applicationUnconfirmed','assignmentUnresolved'])await test('accepted file is retained when '+flag+' changes later',async()=>{const h=harness(),s=await h.start();h.records.get('jobs/synthetic-job')[flag]=true;await h.finish(s.files[0]);assert.equal((await h.state(s.submissionId)).status,'completed');assert.equal(h.driveFiles.size,1);assert.equal(h.records.get('submissions/'+s.submissionId).totalFiles,1);});
const retryRequest='11111111-1111-4111-8111-111111111111';
const retryFiles=(count=1,size=100)=>Array.from({length:count},(_,i)=>({originalName:'retry-'+i+'.png',contentType:'image/png',size,contentSha256:size===syntheticBytes.length?syntheticDigest:'a'.repeat(64)}));
const retryStart=(h,count=1,patch={})=>h.start(count,{clientRequestId:retryRequest,files:retryFiles(count),...patch});
function presentObject(h,file,patch={}){h.storageObjects??=new Map();h.storageObjects.set(file.storagePath,{name:file.storagePath,contentType:'image/png',size:'100',generation:'1',bucket:'synthetic-bucket',md5Hash:'AAAAAAAAAAAAAAAAAAAAAA==',metadata:{lkcContentSha256:syntheticDigest},...patch});}
const fileRecord=(h,s)=>h.records.get('submissions/'+s.submissionId+'/files/'+s.files[0].fileId);

const submissionStaffProfile='staffProfiles/synthetic-staff';
const submissionIdentity='authIdentities/synthetic-user';
const revokedSecond=1700000000;
const beforeRevocation=new Date(revokedSecond*1000-1000).toISOString();
const afterRevocation=new Date(revokedSecond*1000+1000).toISOString();
async function recordBeforeRevocation(h,file){
  h.env.LKC_SUBMISSION_TRANSFER_MODE='paused';
  await h.finish(file,{timeCreated:beforeRevocation});
  h.env.LKC_SUBMISSION_TRANSFER_MODE='active';
  presentObject(h,file,{timeCreated:beforeRevocation,bucket:'synthetic-bucket',md5Hash:'AAAAAAAAAAAAAAAAAAAAAA=='});
}
async function resumeSecurityFixture(observe=false){
  const h=harness();
  h.staff.token.auth_time=revokedSecond-2;
  const receipt=await retryStart(h);
  const file=receipt.files[0];
  fileRecord(h,receipt).uploadPathIssuedAt=Timestamp.fromMillis(revokedSecond*1000-1500);
  if(observe)await recordBeforeRevocation(h,file);
  const identity=h.records.get(submissionIdentity);
  Object.assign(identity,{active:false,revokedAt:Timestamp.fromMillis(revokedSecond*1000)});
  const reauthenticate=()=>{identity.active=true;h.staff.token.auth_time=revokedSecond+2;};
  return {h,receipt,file,reauthenticate};
}

for(const timeCreated of [afterRevocation,undefined])await test('upload resume security / late or unverified object is held '+String(timeCreated),async()=>{
  const {h,receipt,file}=await resumeSecurityFixture();
  const before=JSON.stringify([...h.records]);
  await h.finish(file,{timeCreated});
  assert.equal(h.copies,0);
  assert.equal(h.byteScans??0,0);
  assert.equal(h.deletes,0);
  assert.equal(JSON.stringify([...h.records]),before);
  assert.equal(fileRecord(h,receipt).status,'waiting_upload');
});
await test('upload resume security / observed generation before revocation uses the authorized source',async()=>{
  const {h,file,receipt,reauthenticate}=await resumeSecurityFixture(true);
  reauthenticate();
  const retry=await retryStart(h);
  assert.equal(retry.files[0].storagePath,file.storagePath);
  assert.equal(retry.files[0].uploadRequired,false);
  await h.finish(file,{timeCreated:beforeRevocation});
  assert.equal((await h.state(receipt.submissionId)).status,'completed');
  assert.equal(h.copies,1);
});
await test('upload resume security / an unobserved object is never revived by a second revocation',async()=>{
  const {h,file,receipt,reauthenticate}=await resumeSecurityFixture();
  const identity=h.records.get(submissionIdentity);
  identity.revokedAt=Timestamp.fromMillis((revokedSecond+1)*1000);
  reauthenticate();
  await h.finish(file,{timeCreated:afterRevocation});
  assert.equal(h.copies,0);
  const retry=await retryStart(h);
  assert.equal(retry.submissionId,receipt.submissionId);
  assert.notEqual(retry.files[0].storagePath,file.storagePath);
});
await test('upload resume security / an older receipt can rotate without changing its file ID',async()=>{
  const {h,receipt,reauthenticate}=await resumeSecurityFixture();
  const saved=fileRecord(h,receipt);
  const previous=saved.baseStoragePath;
  saved.storagePath=previous;
  delete saved.baseStoragePath;
  delete saved.uploadPathIssuedAt;
  reauthenticate();
  const resumed=await retryStart(h);
  assert.equal(resumed.submissionId,receipt.submissionId);
  assert.equal(resumed.files[0].fileId,receipt.files[0].fileId);
  assert.notEqual(resumed.files[0].storagePath,previous);
  assert.equal(resumed.files[0].uploadRequired,true);
});
for(const existing of [false,true])await test('upload resume security / concurrent resume uses one new staging path existing='+existing,async()=>{
  const {h,receipt,file,reauthenticate}=await resumeSecurityFixture();
  if(existing)presentObject(h,file,{timeCreated:afterRevocation});
  reauthenticate();
  const resumed=await Promise.all([retryStart(h),retryStart(h)]);
  const next=resumed[0].files[0];
  assert.equal(resumed[0].submissionId,receipt.submissionId);
  assert.equal(next.fileId,file.fileId);
  assert.notEqual(next.storagePath,file.storagePath);
  assert.equal(next.storagePath,resumed[1].files[0].storagePath);
  assert.equal(next.uploadRequired,true);
  assert.equal(h.list('submissions').length,1);
  const before=JSON.stringify([...h.records]);
  await h.finish(file,{timeCreated:afterRevocation});
  assert.equal(JSON.stringify([...h.records]),before);
  assert.equal(h.copies,0);
  await h.finish(next,{timeCreated:afterRevocation});
  assert.equal((await h.state(receipt.submissionId)).status,'completed');
  assert.equal(h.copies,1);
  assert.equal(h.deletes,1);
});
await test('upload resume security / a checkpoint with an uncertain Drive outcome never rotates',async()=>{
  const {h,file,receipt,reauthenticate}=await resumeSecurityFixture();
  fileRecord(h,receipt).status='processing';
  presentObject(h,file,{timeCreated:afterRevocation});
  reauthenticate();
  const before=JSON.stringify([...h.records]);
  await assert.rejects(()=>retryStart(h),{code:'failed-precondition'});
  assert.equal(JSON.stringify([...h.records]),before);
  assert.equal(h.copies,0);
});

async function submissionAccessFixture(){
  const h=harness();
  h.staff.token.auth_time=revokedSecond-1;
  h.previewBase='https://preview.invalid/files';
  const receipt=await retryStart(h);
  const file=receipt.files[0];
  await h.finish(file);
  const jobId='synthetic-job',submissionId=receipt.submissionId;
  const request=await h.requests.createResubmissionRequest({auth:h.admin,data:{
    jobId,type:'report',sourceSubmissionId:submissionId,sourceFileId:file.fileId,reasons:['その他'],
  }});
  const target={jobId,type:'report',previewFile:{submissionId,fileId:file.fileId}};
  const timeline=(auth=h.staff,data=target)=>h.views.getSubmissionTimeline({auth,data});
  const tokenFrom=async auth=>new URL((await timeline(auth)).submissions[0].files[0].previewUrl).searchParams.get('token');
  const preview=async token=>{
    const headers={};
    const response={code:200,headersSent:false,status(code){this.code=code;return this;},
      setHeader(name,value){headers[name]=value;},send(){return this;},end(){}};
    await h.views.driveFilePreview({query:{token}},response);
    return {code:response.code,headers};
  };
  return {h,jobId,submissionId,file,request,target,timeline,tokenFrom,preview};
}

for(const [label,mutate] of [
 ['disabled identity',h=>Object.assign(h.records.get(submissionIdentity),{active:false})],
 ['same UID reactivated after revocation',h=>Object.assign(h.records.get(submissionIdentity),{revokedAt:new Timestamp(revokedSecond,1)})],
 ['inactive staff profile',h=>Object.assign(h.records.get(submissionStaffProfile),{active:false})],
]) await test('submission access / refuses all staff paths with '+label,async()=>{
  const f=await submissionAccessFixture(),{h,jobId,submissionId,request,preview,tokenFrom}=f;
  const token=await tokenFrom();
  mutate(h);
  const before=JSON.stringify([...h.records]);
  const calls=[
    ()=>f.timeline(),
    ()=>f.timeline(h.staff,{jobId,type:'report'}),
    ()=>h.views.getSubmissionProcessingStatus({auth:h.staff,data:{jobId,submissionId}}),
    ()=>h.views.getResubmissionComparison({auth:h.staff,data:request}),
    ()=>h.requests.getMyResubmissionRequests({auth:h.staff,data:{}}),
    ()=>h.status.setSalesFloorClientSubmitted({auth:h.staff,data:{jobId,submitted:true}}),
  ];
  assert.deepEqual((await Promise.allSettled(calls.map(call=>call()))).map(result=>result.status==='rejected'?result.reason.code:'allowed'),
    Array(calls.length).fill('permission-denied'));
  assert.equal((await preview(token)).code,410);
  assert.equal(h.previewReads??0,0);
  assert.equal(JSON.stringify([...h.records]),before);
});
await test('submission access / a fresh login can issue a new URL without reactivating the old one',async()=>{
  const f=await submissionAccessFixture();
  const old=await f.tokenFrom();
  Object.assign(f.h.records.get(submissionIdentity),{revokedAt:new Timestamp(revokedSecond,1)});
  f.h.staff.token.auth_time=revokedSecond+1;
  assert.equal((await f.preview(old)).code,410);
  const latest=await f.tokenFrom();
  const rendered=await f.preview(latest);
  assert.equal(rendered.code,200);
  assert.equal(rendered.headers['Cache-Control'],'private, no-store');
  assert.notEqual(latest,old);
  assert.equal(f.h.previewReads,1);
});
await test('submission access / an older unbound preview URL is refused and refreshed with the admin route',async()=>{
  const f=await submissionAccessFixture();
  const token=await f.tokenFrom(f.h.admin);
  delete f.h.records.get('filePreviewTokens/'+crypto.createHash('sha256').update(token).digest('hex')).actorRole;
  assert.equal((await f.preview(token)).code,410);
  assert.equal((await f.preview(await f.tokenFrom(f.h.admin))).code,200);
  assert.equal(f.h.previewReads,1);
});
await test('submission access / authorization changes during the preview check prevent streaming',async()=>{
  const f=await submissionAccessFixture(),{h}=f;
  const old=await f.tokenFrom();
  h.beforeCommit=async()=>{
    h.beforeCommit=null;
    await h.updateRecord(submissionIdentity,{active:false,revokedAt:new Timestamp(revokedSecond,1)});
  };
  assert.equal((await f.preview(old)).code,410);
  assert.equal(h.previewReads??0,0);
});
await test('submission access / reassignment never exposes the previous staff file to the new assignee',async()=>{
  const f=await submissionAccessFixture(),{h,jobId,target}=f;
  const old=await f.tokenFrom();
  const nextStaff={uid:'new-staff-uid',token:{companyId:'synthetic-company',staffId:'new-staff-id',role:'staff',auth_time:revokedSecond+1}};
  h.records.set('staffProfiles/new-staff-id',{companyId:'synthetic-company',active:true,displayName:'New Synthetic Staff'});
  h.records.set('authIdentities/new-staff-uid',{companyId:'synthetic-company',staffId:'new-staff-id',active:true});
  h.records.get('jobs/'+jobId).assignedStaffId=nextStaff.token.staffId;
  assert.equal((await f.preview(old)).code,410);
  assert.equal((await f.timeline(nextStaff,target)).submissions.length,0);
  await assert.rejects(()=>h.requests.createResubmissionRequest({auth:h.admin,data:{
    jobId,type:'report',sourceSubmissionId:f.submissionId,sourceFileId:f.file.fileId,reasons:['その他'],
  }}),{code:'failed-precondition'});
  const legacy=h.records.get('resubmissionRequests/'+f.request.requestId);
  legacy.staffId=nextStaff.token.staffId;
  await assert.rejects(()=>h.views.getResubmissionComparison({auth:nextStaff,data:f.request}),{code:'permission-denied'});
  assert.equal((await h.views.getResubmissionComparison({auth:h.admin,data:f.request})).source.id,f.file.fileId);
  h.staff=nextStaff;
  const own=await retryStart(h);
  await h.finish(own.files[0]);
  const ownTimeline=await f.timeline(nextStaff,{jobId,type:'report'});
  assert.deepEqual(Array.from(ownTimeline.submissions,entry=>entry.id),[own.submissionId]);
});
for(const [issue,change] of [
 ['missing link',h=>h.records.delete(submissionIdentity)],
 ['revoked link',h=>Object.assign(h.records.get(submissionIdentity),{active:false,revokedAt:Timestamp.fromMillis(revokedSecond*1000)})],
 ['old token after a later valid sign-in',h=>Object.assign(h.records.get(submissionIdentity),{revokedAt:Timestamp.fromMillis((revokedSecond+1)*1000)})],
 ['fractional same-second revocation',h=>Object.assign(h.records.get(submissionIdentity),{revokedAt:new Timestamp(revokedSecond,1)})],
 ['invalid revocation time',h=>Object.assign(h.records.get(submissionIdentity),{revokedAt:'invalid'})],
 ['wrong company',h=>Object.assign(h.records.get(submissionIdentity),{companyId:'foreign-company'})],
 ['wrong staff',h=>Object.assign(h.records.get(submissionIdentity),{staffId:'another-staff'})],
 ['inactive profile',h=>Object.assign(h.records.get(submissionStaffProfile),{active:false})],
 ['admin role with staff claim',h=>{h.staff.token.role='admin';}],
]) await test('submission session / rejects '+issue+' for new and existing receipts',async()=>{
  const h=harness();
  h.staff.token.auth_time=revokedSecond;
  const receipt=await retryStart(h);
  presentObject(h,receipt.files[0]);
  change(h);
  const before=JSON.stringify([...h.records]);
  await assert.rejects(()=>h.start(),{code:'permission-denied'});
  await assert.rejects(()=>retryStart(h),{code:'permission-denied'});
  assert.equal(JSON.stringify([...h.records]),before);
  assert.equal(h.metadataReads??0,0);
  assert.equal(h.copies,0);
});
await test('submission session / revocation at commit blocks new receipt',async()=>{
  const h=harness();
  h.staff.token.auth_time=revokedSecond;
  h.beforeCommit=async()=>{
    h.beforeCommit=null;
    await h.updateRecord(submissionIdentity,{active:false,revokedAt:Timestamp.fromMillis(revokedSecond*1000)});
  };
  await assert.rejects(()=>retryStart(h),{code:'permission-denied'});
  assert.equal(h.list('submissions').length,0);
});
await test('submission session / fresh login returns the same staged receipt without reuploading',async()=>{
  const h=harness();
  h.staff.token.auth_time=revokedSecond-1;
  const receipt=await retryStart(h);
  await recordBeforeRevocation(h,receipt.files[0]);
  fileRecord(h,receipt).uploadPathIssuedAt=Timestamp.fromMillis(revokedSecond*1000-1500);
  Object.assign(h.records.get(submissionIdentity),{revokedAt:Timestamp.fromMillis(revokedSecond*1000)});
  h.staff.token.auth_time=revokedSecond;
  const same=await retryStart(h);
  assert.equal(same.submissionId,receipt.submissionId);
  assert.equal(same.files[0].storagePath,receipt.files[0].storagePath);
  assert.equal(same.files[0].uploadRequired,false);
  assert.equal(h.list('submissions').length,1);
});
await test('submission session / revoked saved marker requires a numeric auth time',async()=>{
  const h=harness();
  Object.assign(h.records.get(submissionIdentity),{revokedAt:Timestamp.fromMillis(revokedSecond*1000)});
  for(const authTime of [undefined,String(revokedSecond),-1,253402300800]){
    h.staff.token.auth_time=authTime;
    await assert.rejects(()=>retryStart(h),{code:'permission-denied'});
  }
  assert.equal(h.list('submissions').length,0);
});
await test('staged content / verify the generation and resume a lost Drive response without another copy or byte scan',async()=>{
  const h=harness(),s=await retryStart(h),file=s.files[0];
  presentObject(h,file);h.loseCopyResponse=true;
  await assert.rejects(h.finish(file),/synthetic lost response/);
  assert.equal(h.copies,1);assert.equal(h.byteScans,1);assert.equal(h.deletes,0);
  assert.match(fileRecord(h,s).verifiedUploadBytes,/^[a-f0-9]{64}$/);
  h.loseCopyResponse=false;
  const replay=await retryStart(h);
  assert.equal(replay.submissionId,s.submissionId);assert.equal(replay.files[0].uploadRequired,false);
  await h.finish(file);
  assert.equal((await h.state(s.submissionId)).status,'completed');
  assert.equal(h.copies,1);assert.equal(h.byteScans,1);
  assert.equal(h.streamReads.length,2);
  assert(h.streamReads.every(read=>read.generation==='1'&&read.decompress===false));
  assert.equal((await retryStart(h)).files[0].uploadRequired,false);
});
for(const [name,bytes] of [
  ['same size and matching client metadata but different bytes',[Buffer.alloc(100,0x32)]],
  ['truncated source',[syntheticBytes.subarray(0,99)]],
  ['oversized source',[syntheticBytes,Buffer.from([0])]],
]) await test('staged content / reject '+name,async()=>{
  const h=harness(),s=await retryStart(h),file=s.files[0];
  presentObject(h,file);h.byteChunks=bytes;
  await assert.rejects(retryStart(h),error=>error.code==='failed-precondition');
  await assert.rejects(h.finish(file),error=>error.code==='failed-precondition');
  assert.equal(h.copies,0);assert.equal(h.deletes,0);
  assert.equal(h.list('fileCounters').length,0);
  assert.equal(fileRecord(h,s).verifiedUploadBytes,undefined);
  assert.equal((await h.state(s.submissionId)).status,'error');
});
await test('staged content / a replaced generation cannot reuse the previous hash proof',async()=>{
  const h=harness(),s=await retryStart(h),file=s.files[0];
  h.driveList=()=>{throw new Error('synthetic failed folder lookup');};
  await assert.rejects(h.finish(file),/failed folder lookup/);
  const proof=fileRecord(h,s).verifiedUploadBytes;
  assert.match(proof,/^[a-f0-9]{64}$/);assert.equal(h.byteScans,1);
  delete h.driveList;
  await assert.rejects(h.finish(file,{generation:'2'}),error=>error.code==='failed-precondition');
  assert.equal(fileRecord(h,s).verifiedUploadBytes,proof);
  assert.equal(h.byteScans,1);assert.equal(h.copies,0);assert.equal(h.deletes,0);
  await h.finish(file);
  assert.equal(h.copies,1);assert.equal(h.byteScans,1);
});
await test('staged content / an interrupted byte read recoverably fails before Drive',async()=>{
  const h=harness(),s=await retryStart(h),file=s.files[0];
  h.byteScanError=true;
  await assert.rejects(h.finish(file),/synthetic source read failed/);
  assert.equal(h.copies,0);assert.equal(h.deletes,0);
  assert.equal(fileRecord(h,s).verifiedUploadBytes,undefined);
  h.byteScanError=false;await h.finish(file);
  assert.equal(h.copies,1);assert.equal(h.byteScans,2);
});
await test('staged content / a digest that changes while reading is not bound to the receipt',async()=>{
  const h=harness(),s=await retryStart(h),file=s.files[0];
  h.beforeByteScan=()=>{fileRecord(h,s).contentSha256='b'.repeat(64);};
  await assert.rejects(h.finish(file),error=>error.code==='failed-precondition');
  assert.equal(h.copies,0);assert.equal(h.deletes,0);
  assert.equal(fileRecord(h,s).verifiedUploadBytes,undefined);
});
await test('staged content / an invalid replacement does not claim the open request',async()=>{
  const h=harness();
  h.records.set('resubmissionRequests/request-a',{companyId:'synthetic-company',jobId:'synthetic-job',staffId:'synthetic-staff',type:'report',status:'open'});
  const s=await retryStart(h,1,{purpose:'replacement',resubmissionRequestId:'request-a'});
  h.byteChunks=[Buffer.alloc(100,0x33)];
  await assert.rejects(h.finish(s.files[0]),error=>error.code==='failed-precondition');
  assert.equal(h.records.get('resubmissionRequests/request-a').replacementSubmissionId,undefined);
  assert.equal(h.records.get('resubmissionRequests/request-a').status,'open');
  assert.equal(h.copies,0);assert.equal(h.deletes,0);
});
await test('staged content / check a 50 MiB file one bounded chunk at a time',async()=>{
  const h=harness(),chunk=Buffer.alloc(1024*1024,0x34),size=50*chunk.length;
  const chunks=Array(50).fill(chunk);
  const digest=chunks.reduce((hash,bytes)=>hash.update(bytes),crypto.createHash('sha256')).digest('hex');
  const s=await retryStart(h,1,{files:[{...retryFiles()[0],size,contentSha256:digest}]});
  h.byteChunks=chunks;h.drivePayload=()=>({size:String(size)});
  await h.finish(s.files[0],{size:String(size)});
  assert.equal(h.byteScans,1);assert.equal(h.copies,1);
  assert.equal((await h.state(s.submissionId)).status,'completed');
});
async function verifyAcceptedSubmissionJourney(h,jobId,handover){
  let report=await retryStart(h,1,{jobId});
  if(handover){
    const legacy={...h.staff,token:{...h.staff.token}}, original=report;
    h.staff=await handover();
    await assert.rejects(h.views.getSubmissionProcessingStatus({auth:legacy,data:{jobId,submissionId:original.submissionId}}),{code:'permission-denied'});
    report=await retryStart(h,1,{jobId});
    assert.equal(report.submissionId,original.submissionId);
    assert.equal(report.files[0].fileId,original.files[0].fileId);
    assert.notEqual(report.files[0].storagePath,original.files[0].storagePath);
    await h.finish(original.files[0]);
    assert.equal(h.copies,0);
    assert.equal(h.deletes,0);
  }
  const lostReply=await retryStart(h,1,{jobId});
  assert.equal(lostReply.submissionId,report.submissionId);
  h.loseCopyResponse=true;
  await assert.rejects(h.finish(report.files[0]),/lost response/);
  h.loseCopyResponse=false;await h.finish(report.files[0]);
  const sales=await retryStart(h,1,{jobId,type:'sales_floor',clientRequestId:'22222222-2222-4222-8222-222222222222'});
  await h.finish(sales.files[0]);
  const request=await h.requests.createResubmissionRequest({
    auth:h.admin,data:{jobId,type:'report',sourceSubmissionId:report.submissionId,sourceFileId:report.files[0].fileId,reasons:['その他']},
  });
  const replacement=await retryStart(h,1,{jobId,purpose:'replacement',resubmissionRequestId:request.requestId,clientRequestId:'33333333-3333-4333-8333-333333333333'});
  await h.finish(replacement.files[0]);
  const comparison=await h.views.getResubmissionComparison({auth:h.admin,data:request});
  assert.equal(comparison.source.id,report.files[0].fileId);
  assert.equal(comparison.replacements[0].submissionId,replacement.submissionId);
  await h.requests.completeResubmissionRequest({auth:h.admin,data:request});
  assert.equal(h.records.get('resubmissionRequests/'+request.requestId).status,'completed');
  for(const receipt of [report,sales,replacement]){
    assert.equal((await h.views.getSubmissionProcessingStatus({auth:h.staff,data:{jobId,submissionId:receipt.submissionId}})).status,'completed');
    assert.match(fileRecord(h,receipt).verifiedUploadBytes,/^[a-f0-9]{64}$/);
  }
  assert.equal(h.list('submissions').length,3);
  assert.equal(h.copies,3);assert.equal(h.byteScans,3);assert.equal(h.driveFiles.size,3);
  return {report,sales,replacement,request};
}
export function runAcceptedSubmissionJourney(records,jobId,staffAuth,adminAuth,handover){
  const h=harness(null,null,records);
  h.staff=staffAuth;
  h.admin=adminAuth;
  return verifyAcceptedSubmissionJourney(h,jobId,handover);
}
await test('external staged journey / saved assignment accepts report, sales photo and replacement with one receipt each',async()=>{
  const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/staged-content-external-case.json',import.meta.url),'utf8'));
  assert.equal(fixture.sourceSha256,'ee0c17529c827fae1e4db2339440c5c2f964913949b854729a18c75d834b6bb8');
  const {accepted,pending}=fixture;
  assert.equal(pending.id,accepted.id);assert.equal(pending.caseId,accepted.caseId);
  assert.equal(pending.applicationUnconfirmed,true);assert.equal(accepted.applicationUnconfirmed,false);
  assert.ok(accepted.assignmentSheetWrite.externalAck);
  const {companyId,assignedStaffId:staffId,assignedUid:uid,id:jobId}=accepted;
  const records=new Map([
    ['jobs/'+jobId,pending],
    ['staffProfiles/'+staffId,{companyId,active:true,displayName:'Synthetic Staff'}],
    ['authIdentities/'+uid,{companyId,staffId,active:true}],
    ['companies/'+companyId+'/settings/drive',{rootFolderId:'synthetic-root'}],
  ]);
  const staff={uid,token:{companyId,staffId,role:'staff'}};
  const admin={uid:'synthetic-admin',token:{companyId,role:'admin'}};
  const h=harness(null,null,records);
  h.staff=staff;
  await assert.rejects(retryStart(h,1,{jobId}),error=>error.code==='failed-precondition'&&error.details?.reason==='source_unavailable');
  assert.equal(h.list('submissions').length,0);
  records.set('jobs/'+jobId,accepted);
  await runAcceptedSubmissionJourney(records,jobId,staff,admin);
});
await test('receipt staged bytes / same ID reads one pinned generation before confirming recovery',async()=>{
 const h=harness(),first=await retryStart(h),target=first.files[0];presentObject(h,target);
 const before=JSON.stringify([...h.records]);
 const resumed=await retryStart(h);
 assert.equal(resumed.submissionId,first.submissionId);assert.equal(resumed.files[0].uploadRequired,false);
 assert.deepEqual(h.streamReads,[{path:target.storagePath,generation:'1',decompress:false}]);
 assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.copies,0);assert.equal(h.deletes,0);
});
for(const [name,bytes] of [['false digest label',[Buffer.alloc(100,0x32)]],['truncated bytes',[Buffer.alloc(99,0x31)]]])await test('receipt staged bytes / rejects '+name,async()=>{
 const h=harness(),s=await retryStart(h);presentObject(h,s.files[0]);h.byteChunks=bytes;
 const before=JSON.stringify([...h.records]);
 await assert.rejects(retryStart(h),{code:'failed-precondition'});
 assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.copies,0);assert.equal(h.deletes,0);
});
await test('receipt staged bytes / missing pinned generation is not treated as an unstarted upload',async()=>{
 const h=harness(),s=await retryStart(h);presentObject(h,s.files[0]);
 h.byteScanError=Object.assign(new Error('synthetic generation is gone'),{code:404});
 const before=JSON.stringify([...h.records]);
 await assert.rejects(retryStart(h),{code:404});
 assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.byteScans,1);
});
await test('receipt staged bytes / verified generation reuses the server proof',async()=>{
 const h=harness(),s=await retryStart(h);presentObject(h,s.files[0]);h.loseCopyResponse=true;
 await assert.rejects(h.finish(s.files[0]));
 assert.equal(h.byteScans,1);assert.match(fileRecord(h,s).verifiedUploadBytes,/^[a-f0-9]{64}$/);
 const resumed=await retryStart(h);
 assert.equal(resumed.submissionId,s.submissionId);assert.equal(resumed.files[0].uploadRequired,false);assert.equal(h.byteScans,1);
});
for(const [name,patch] of [['generation differs after verification',{generation:'2'}],['unexpected bucket',{bucket:'synthetic-other'}]])await test('receipt staged bytes / refuses '+name,async()=>{
 const h=harness(),s=await retryStart(h);h.loseCopyResponse=true;await assert.rejects(h.finish(s.files[0]));
 presentObject(h,s.files[0],patch);
 await assert.rejects(retryStart(h),{code:'failed-precondition'});assert.equal(h.byteScans,1);
});
for(const [name,change,code] of [
 ['account stop',h=>{h.records.get(submissionIdentity).active=false;},'permission-denied'],
 ['assignment edit',h=>{h.records.get('jobs/synthetic-job').revision=1;},'failed-precondition'],
 ['receipt replacement',(h,s)=>{const saved=fileRecord(h,s);saved.storagePath=saved.storagePath.replace(/\/[a-f0-9]{32}-/,'/'+'0'.repeat(32)+'-');},'failed-precondition'],
 ['receipt disappears',(h,s)=>{h.records.delete('submissions/'+s.submissionId);},'failed-precondition'],
])await test('receipt staged bytes / rechecks '+name+' during the read',async()=>{
 const h=harness(),s=await retryStart(h);presentObject(h,s.files[0]);h.beforeByteScan=()=>change(h,s);
 await assert.rejects(retryStart(h),{code});assert.equal(h.byteScans,1);
 assert.equal(h.list('submissions').length,name==='receipt disappears'?0:1);
 assert.equal(h.copies,0);assert.equal(h.deletes,0);
});

await test('upload retry reuses receipt after response loss without creating new files',async()=>{const h=harness(),before=h.records.size,first=await retryStart(h,2),again=await retryStart(h,2);assert.equal(first.submissionId,again.submissionId);assert.equal(again.replayed,true);assert.equal(again.clientRequestId,retryRequest);assert.deepEqual(again.files,first.files);assert.equal(h.list('submissions').length,1);assert.equal(h.records.size,before+3);assert.equal(h.metadataReads,2);});
await test('concurrent same operation converges on one receipt',async()=>{const h=harness(),responses=await Promise.all([retryStart(h),retryStart(h)]);assert.equal(responses[0].submissionId,responses[1].submissionId);assert.equal(h.list('submissions').length,1);assert.equal(h.list('submissions/'+responses[0].submissionId+'/files').length,1);});
await test('partial uploaded and finalized files are skipped while missing files resume',async()=>{const h=harness(),first=await retryStart(h,3);presentObject(h,first.files[0]);presentObject(h,first.files[1]);await h.finish(first.files[0]);const again=await retryStart(h,3);assert.deepEqual(Array.from(again.files,f=>f.uploadRequired),[false,false,true]);assert.equal(h.copies,1);assert.equal(h.metadataReads,2);assert.equal(h.list('submissions').length,1);});
await test('completed receipt survives staging cleanup without reupload',async()=>{const h=harness(),first=await retryStart(h);await h.finish(first.files[0]);const before=JSON.stringify([...h.records]);const again=await retryStart(h);assert.equal(again.files[0].uploadRequired,false);assert.equal(h.metadataReads??0,0);assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.copies,1);});
for(const field of ['name','size','contentType','hash'])await test('retry refuses mismatched existing Storage '+field,async()=>{const h=harness(),first=await retryStart(h);const changes={name:{name:'other'},size:{size:'101'},contentType:{contentType:'application/pdf'},hash:{metadata:{lkcContentSha256:'b'.repeat(64)}}};presentObject(h,first.files[0],changes[field]);await assert.rejects(retryStart(h),e=>e.code==='failed-precondition');assert.equal(h.list('submissions').length,1);assert.equal(h.copies,0);});
for(const code of [403,500,503])await test('metadata '+code+' cannot fall back to overwriting',async()=>{const h=harness();await retryStart(h);h.metadataError=code;await assert.rejects(retryStart(h),e=>e.code===code);assert.equal(h.list('submissions').length,1);});
for(const state of ['processing','paused_global','error','security_error'])await test('missing source in '+state+' requires recovery instead of recreation',async()=>{const h=harness(),first=await retryStart(h);h.records.get('submissions/'+first.submissionId+'/files/'+first.files[0].fileId).status=state;await assert.rejects(retryStart(h),e=>e.code==='failed-precondition');assert.equal(h.list('submissions').length,1);});
for(const patch of [{files:retryFiles(2)},{type:'sales_floor'},{files:[{...retryFiles()[0],originalName:'changed.png'}]},{files:[{...retryFiles()[0],contentSha256:'b'.repeat(64)}]}])await test('same request with changed content is rejected '+JSON.stringify(patch),async()=>{const h=harness();await retryStart(h);await assert.rejects(retryStart(h,1,patch),e=>e.code==='failed-precondition');assert.equal(h.list('submissions').length,1);});
for(const [name,change]of [['revision',j=>j.revision=1],['date',j=>j.dateKey='2026-09-21'],['pending',j=>j.applicationUnconfirmed=true],['cancelled',j=>j.cancelled=true],['staff',j=>j.assignedStaffId='other'],['company',j=>j.companyId='other']])await test('retry refuses changed assignment '+name,async()=>{const h=harness();await retryStart(h);change(h.records.get('jobs/synthetic-job'));await assert.rejects(retryStart(h));assert.equal(h.list('submissions').length,1);assert.equal(h.metadataReads??0,0);});
await test('retry keeps twenty 50MiB files valid without physically allocating them',async()=>{const h=harness(),a=await retryStart(h,20,{files:retryFiles(20,50*1024*1024)}),b=await retryStart(h,20,{files:retryFiles(20,50*1024*1024)});assert.equal(a.files.length,20);assert.equal(b.files.length,20);assert.equal(h.list('submissions').length,1);});
await test('request ID is scoped to authenticated UID and legacy calls remain compatible',async()=>{const h=harness(),a=await retryStart(h);h.staff={...h.staff,uid:'other-session-user'};h.records.set('authIdentities/'+h.staff.uid,{...defaultSubmissionIdentity});const b=await retryStart(h);assert.notEqual(a.submissionId,b.submissionId);const legacy=await h.start();assert.equal(legacy.clientRequestId,undefined);assert.equal(legacy.files[0].uploadRequired,undefined);});
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
 h.env.DEFAULT_COMPANY_ID=companyId;
 h.records.set('staffNgMaintenance/'+companyId,{schema:'LK_STAFF_NG_MAINTENANCE_V1',companyId,state:'OPEN',generation:0});
 const ng=h.loadModule('./staff-ng'),header=Array(11).fill('');
 header[10]='NG会社';
 Object.assign(h.records.get('staffProfiles/synthetic-staff'),{active:true,ngCompanies:ng.mergeStaffNg([
   {sourceRef:{spreadsheetId:'synthetic-staff-master',sheetName:'マスターデータ'},ngCompanyObservation:ng.observeStaffNgCell('マスターデータ',header,[],10)}
 ],companyId,'synthetic-staff')});
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
 assert.equal(h.current().applicationUnconfirmed,false);assert.equal(h.current().assignmentSheetWrite.awaitingImportConfirmation,true);
 assert.equal(h.current().applicationAdminConfirmed,true);
 // 原本反映を確認した応募は、再取込を待たず次のスタッフ操作へ進める。
 const first=await h.start(2);await h.sync();assert.equal(h.current().assignmentSheetWrite.awaitingImportConfirmation,false);
 await h.finish(first.files[0]);await h.finish(first.files[1]);
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
const taskIdentityPath='authIdentities/synthetic-user';
const taskProfilePath='staffProfiles/synthetic-staff';
const taskRevokedAt=Timestamp.fromMillis(1001);
function staffTaskFixture(){
 const h=harness();
 h.staff.token.auth_time=1;
 printedJob(h);
 const base={auth:h.staff};
 return {
  h,
  list:()=>h.tasks.getMyTasks(base),
  precontact:()=>h.precontact.submitPreContact({...base,data:{jobId:'synthetic-job',temperature:36.5,arrivalTime:'09:00'}}),
  print:()=>h.netprint.markNetPrintPrinted({...base,data:{jobId:'synthetic-job',itemId:'item'}}),
 };
}
for(const [caseName,prepare] of [
 ['missing identity',h=>h.records.delete(taskIdentityPath)],
 ['disabled identity',h=>h.updateRecord(taskIdentityPath,{active:false})],
 ['inactive profile',h=>h.updateRecord(taskProfilePath,{active:false})],
 ['foreign identity',h=>h.updateRecord(taskIdentityPath,{companyId:'other-company'})],
 ['foreign staff',h=>h.updateRecord(taskIdentityPath,{staffId:'other-staff'})],
 ['old token after reactivation',h=>h.updateRecord(taskIdentityPath,{revokedAt:taskRevokedAt})],
 ['non-staff token',h=>{h.staff.token.role='admin';}],
]){
 for(const action of ['list','precontact','print']){
  await test('staff task authorization / '+caseName+' / '+action,async()=>{
   const fixture=staffTaskFixture(),{h}=fixture;
   await prepare(h);
   const before=JSON.stringify([...h.records]);
   await assert.rejects(fixture[action],{code:'permission-denied'});
   assert.equal(JSON.stringify([...h.records]),before);
   assert.equal(h.queryReads,0);
  });
 }
}
for(const action of ['precontact','print']){
 await test('staff task authorization / revoked before commit / '+action,async()=>{
  const fixture=staffTaskFixture(),{h}=fixture;
  const businessRecords=()=>JSON.stringify([...h.records].filter(([key])=>key!==taskIdentityPath));
  const before=businessRecords();
  h.beforeCommit=async()=>{
   h.beforeCommit=null;
   await h.updateRecord(taskIdentityPath,{active:false,revokedAt:taskRevokedAt});
  };
  await assert.rejects(fixture[action],{code:'permission-denied'});
  assert.equal(h.records.get(taskIdentityPath).active,false);
  assert.equal(businessRecords(),before);
 });
}
await test('staff task authorization / stale read-only identity cannot bypass live check',async()=>{
 const {h,list}=staffTaskFixture();
 h.staleReadOnlyRecords=new Map([[taskIdentityPath,copy(h.records.get(taskIdentityPath))]]);
 await h.updateRecord(taskIdentityPath,{active:false,revokedAt:taskRevokedAt});
 await assert.rejects(list,{code:'permission-denied'});
 assert.equal(h.queryReads,0);
});
await test('staff task authorization / revocation during query blocks result',async()=>{
 const {h,list}=staffTaskFixture();
 h.beforeCommit=async options=>{
  if(options?.readOnly!==true)return;
  h.beforeCommit=null;
  await h.updateRecord(taskIdentityPath,{active:false,revokedAt:taskRevokedAt});
 };
 await assert.rejects(list,{code:'permission-denied'});
 assert.ok(h.queryReads>0);
 assert.equal(h.records.get(taskIdentityPath).active,false);
});
await test('staff task authorization / reauthenticated staff can list and retry same updates',async()=>{
 const fixture=staffTaskFixture(),{h}=fixture;
 await h.updateRecord(taskIdentityPath,{revokedAt:taskRevokedAt});
 h.staff.token.auth_time=2;
 h.records.set('resubmissionRequests/task-access',{
  companyId:'synthetic-company',staffId:'synthetic-staff',jobId:'synthetic-job',
  type:'report',status:'open',reasons:['その他'],createdAt:Timestamp.now(),
 });
 assert.ok((await fixture.list()).tasks.some(task=>task.jobId==='synthetic-job'));
 await fixture.precontact();
 await fixture.print();
 await fixture.precontact();
 await fixture.print();
 assert.deepEqual(h.list('sheetSyncQueue').map(item=>item.operation).sort(),['netprint.printed','precontact.submit']);
});

await test('submission folder concurrency / 300 accounts complete into exactly two isolated month folders',async()=>{
 const h=harness();
 h.emptyDriveFolders=true;
 const users=Array.from({length:300},(_,index)=>{
  const companyId='synthetic-burst-company-'+index%2,staffId='synthetic-burst-staff-'+index;
  const uid='synthetic-burst-uid-'+index,jobId='synthetic-burst-job-'+index;
  h.records.set('staffProfiles/'+staffId,{companyId,displayName:staffId,active:true});
  h.records.set('authIdentities/'+uid,{companyId,staffId,active:true});
  h.records.set('companies/'+companyId+'/settings/drive',{rootFolderId:companyId+'-root'});
  h.records.set('jobs/'+jobId,{companyId,assignedStaffId:staffId,status:'assigned',dateKey:'2026-09-20',
   storeName:'Synthetic Store',clientName:'Synthetic Client'});
  const auth={uid,token:{role:'staff',companyId,staffId}};
  const open=()=>h.uploads.createUploadSession({auth,data:{jobId,type:'report',clientRequestId:retryRequest,files:retryFiles()}});
  return {auth,companyId,jobId,open};
 });
 const receipts=await Promise.all(users.map(user=>user.open()));
 assert.equal(new Set(receipts.map(r=>r.submissionId)).size,300);
 const retried=await Promise.all(users.map(user=>user.open()));
 for(const [index,r] of retried.entries()){
  assert.equal(r.submissionId,receipts[index].submissionId);
  assert.equal(r.files[0].storagePath,receipts[index].files[0].storagePath);
 }
 await Promise.all(receipts.map(receipt=>h.finish(receipt.files[0])));
 assert.equal(h.folderCreates,4);
 assert.equal(h.folderLists,4);
 assert.equal(h.copies,300);
 assert.equal(h.driveFiles.size,300);
 const queues=h.list('sheetSyncQueue');
 assert.equal(queues.length,300);
 assert.equal(new Set(queues.map(queue=>queue.jobId)).size,300);
 for(const [index,receipt] of receipts.entries()){
  const user=users[index],file=h.records.get('submissions/'+receipt.submissionId+'/files/'+receipt.files[0].fileId);
  const month=h.driveFolders.get(h.driveFiles.get(file.driveFileId).parents[0]);
  const client=h.driveFolders.get(month.parents[0]);
  assert.equal(client.parents[0],user.companyId+'-root');
  assert.equal(month.name,'2026.9');
  assert.equal(file.completionCounted,true);
  const state=await h.views.getSubmissionProcessingStatus({auth:user.auth,data:{jobId:user.jobId,submissionId:receipt.submissionId}});
  assert.equal(state.status,'completed');
  assert.equal(state.completedFiles,1);
 }
 await assert.rejects(h.views.getSubmissionProcessingStatus({auth:users[1].auth,data:{jobId:users[0].jobId,submissionId:receipts[0].submissionId}}));
});
await test('submission folder concurrency / separate workers and a lost create response use one saved folder ID',async()=>{
 const h=harness();h.emptyDriveFolders=true;
 const workers=[h.loadFreshFolderWorker(),h.loadFreshFolderWorker()];
 h.afterFolderCreate=()=>{throw new Error('synthetic folder create response lost');};
 const ids=await Promise.all(workers.map(w=>w.ensureSubmissionFolder(h.drive,'synthetic-root',"Client's jobs")));
 assert.equal(ids[0],ids[1]);
 assert.equal(h.folderCreates,1);
 assert.equal(new Set(h.folderCreateIds).size,1);
 assert.equal(h.list('driveSubmissionFolders').length,1);
 const restarted=h.loadFreshFolderWorker();
 assert.equal(await restarted.ensureSubmissionFolder(h.drive,'synthetic-root',"Client's jobs"),ids[0]);
 assert.equal(h.folderCreates,1);
});
await test('submission folder concurrency / after a timeout before creation the next worker reuses the saved ID',async()=>{
 const h=harness();h.emptyDriveFolders=true;
 const resolve=()=>h.loadFreshFolderWorker().ensureSubmissionFolder(h.drive,'synthetic-root','Synthetic Client');
 h.beforeFolderCreate=()=>{throw new Error('synthetic create did not arrive');};
 await assert.rejects(resolve(),/synthetic create did not arrive/);
 assert.equal(h.folderCreates,0);
 const [selection]=h.list('driveSubmissionFolders');
 assert.equal(selection.folderId,h.folderCreateIds[0]);
 h.beforeFolderCreate=null;
 assert.equal(await resolve(),selection.folderId);
 assert.equal(h.folderCreates,1);
 assert.deepEqual(h.folderCreateIds,[selection.folderId,selection.folderId]);
});
await test('submission folder concurrency / legacy folder stays selected and a later move stops the transfer',async()=>{
 const h=harness(),s=await h.start();
 h.emptyDriveFolders=true;
 const source={id:'original-client',name:'Synthetic Client',parents:['synthetic-root'],mimeType:'application/vnd.google-apps.folder',trashed:false};
 h.driveFolders.set(source.id,source);
 await h.finish(s.files[0]);
 const original=h.list('driveSubmissionFolders').find(binding=>binding.parentId==='synthetic-root');
 assert.equal(original.folderId,source.id);
 assert.equal(original.allocated,false);
 assert.equal(h.folderCreates,1);
 const s2=await h.start();
 source.parents=['different-root'];
 await assert.rejects(h.finish(s2.files[0]),{code:'failed-precondition'});
 assert.equal(h.folderCreates,1);
 assert.equal(h.copies,1);
 assert.equal(h.deletes,1);
});
for(const condition of ['duplicate','incomplete','pagination','read-forbidden']){
 await test('submission folder concurrency / no folder or file is created on '+condition,async()=>{
  const h=harness(),s=await h.start();
  const folder={id:'original-client',name:'Synthetic Client',parents:['synthetic-root'],mimeType:'application/vnd.google-apps.folder',trashed:false};
  h.driveFolders.set(folder.id,folder);
  if(condition==='read-forbidden')h.folderGetError=403;
  else h.driveList=()=>({data:{
   files:condition==='duplicate'?[folder,{...folder,id:'duplicate-client'}]:[folder],
   incompleteSearch:condition==='incomplete',nextPageToken:condition==='pagination'?'synthetic-next':undefined,
  }});
  await assert.rejects(h.finish(s.files[0]));
  assert.equal(h.folderCreates,0);
  assert.equal(h.copies,0);
  assert.equal(h.deletes,0);
 });
}


const jobPath='jobs/synthetic-job';
const clientRequestId='629e2f2a-4d6e-4af1-9aa8-80fbe6e04377';
function boundRequest(h,patch={}) {
  const job=h.records.get(jobPath);
  return {clientRequestId,expectedDateKey:job.dateKey,expectedRevision:job.revision??0,
    files:[{originalName:'synthetic-bound.png',contentType:'image/png',size:100,contentSha256:syntheticDigest}],...patch};
}
for (const [name,change] of [
  ['different day', {expectedDateKey:'2000-01-01'}],
  ['invalid calendar day', {expectedDateKey:'2026-02-30'}],
  ['different assignment revision', {expectedRevision:999}],
  ['date without revision', {expectedRevision:undefined}],
]) await test('displayed submission context / new operation rejects '+name, async()=>{
  const h=harness(), input=boundRequest(h,change);
  const before=JSON.stringify([...h.records]);
  await assert.rejects(h.start(1,input),error=>{
    assert.equal(error.code,'failed-precondition');
    assert.deepEqual(copy(error.details),{
      reason:'submission_context_changed',accepted:false,clientRequestId,jobId:'synthetic-job',
      type:'report',purpose:'initial',resubmissionRequestId:null,
      expectedDateKey:input.expectedDateKey,expectedRevision:input.expectedRevision??null,
    });
    return true;
  });
  assert.equal(JSON.stringify([...h.records]),before);
});
await test('displayed submission context / normal submission echoes persisted context and retry keeps its receipt',async()=>{
  const h=harness(),input=boundRequest(h);
  const first=await h.start(1,input), next=await h.start(1,input);
  assert.deepEqual(copy(first.acceptedContext),{jobId:'synthetic-job',dateKey:input.expectedDateKey,revision:input.expectedRevision});
  assert.deepEqual(copy(next.acceptedContext),copy(first.acceptedContext));
  assert.equal(next.submissionId,first.submissionId);
  assert.equal(next.files[0].storagePath,first.files[0].storagePath);
  assert.equal(next.replayed,true);
  assert.equal(h.list('submissions').length,1);
});
await test('displayed submission context / legacy receipt can be recovered by ID only',async()=>{
  const h=harness(),input=boundRequest(h);
  const legacy=await h.start(1,{...input,expectedDateKey:undefined,expectedRevision:undefined});
  const before=JSON.stringify([...h.records]);
  const seen=await h.start(1,{...input,receiptOnly:true});
  assert.equal(seen.submissionId,legacy.submissionId);
  assert.equal(seen.replayed,true);
  assert.deepEqual(copy(seen.acceptedContext),{jobId:'synthetic-job',dateKey:input.expectedDateKey,revision:input.expectedRevision});
  assert.equal(JSON.stringify([...h.records]),before);
});
await test('displayed submission context / receipt-only with missing ID record cannot create or certify nonacceptance',async()=>{
  const h=harness(),input=boundRequest(h,{receiptOnly:true});
  const before=JSON.stringify([...h.records]);
  await assert.rejects(h.start(1,input),error=>error.code==='failed-precondition'&&error.details?.accepted!==false);
  assert.equal(JSON.stringify([...h.records]),before);
});
for(const key of ['expectedDateKey','expectedRevision']) await test('displayed submission context / existing operation refuses changed '+key+' without allowing replacement',async()=>{
  const h=harness(),input=boundRequest(h);
  await h.start(1,input);
  const before=JSON.stringify([...h.records]);
  const changed={...input,[key]:key==='expectedDateKey'?'2000-01-01':999};
  await assert.rejects(h.start(1,changed),error=>error.code==='failed-precondition'&&error.details?.accepted!==false);
  assert.equal(JSON.stringify([...h.records]),before);
});
await test('displayed submission context / receipt-only requires both date and assignment revision',async()=>{
  const h=harness(),input=boundRequest(h);
  await h.start(1,input);
  const before=JSON.stringify([...h.records]);
  await assert.rejects(h.start(1,{...input,receiptOnly:true,expectedRevision:undefined}),error=>
    error.code==='failed-precondition'&&error.details?.reason==='submission_context_changed'&&error.details?.accepted!==false);
  assert.equal(JSON.stringify([...h.records]),before);
});

await test('displayed submission context / existing operation cannot follow a moved job date or company',async()=>{
  const h=harness(),input=boundRequest(h);
  await h.start(1,input);
  const job=h.records.get(jobPath);
  job.dateKey='2000-01-01';
  await assert.rejects(h.start(1,{...input,receiptOnly:true}),error=>error.code==='failed-precondition'&&error.details?.accepted!==false);
  job.dateKey=input.expectedDateKey;
  job.companyId='other-synthetic-company';
  await assert.rejects(h.start(1,input),{code:'permission-denied'});
  assert.equal(h.list('submissions').length,1);
});


const mixedScenarios = [];
const boundMixedScenarios = [];
function compileStaffWorkloadUI(){
 const read=file=>fs.readFileSync(new URL('../apps/staff/src/'+file,import.meta.url),'utf8');
 const transpile=source=>ts.transpileModule(source,{compilerOptions:{
  target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,
 }}).outputText;
 const helpers={exports:{}};
 runInNewContext(transpile(read('job-list.ts')),helpers);
 const app=read('App.tsx');
 const entryPoints=[
  ['  async function fetchMyJobs(', '  async function loadMoreUpcomingShifts('],
  ['  async function loadOpenJobs(', '  async function loadMoreOpenJobs('],
  ['  async function fetchTasks(', '  async function loadPrimaryBusinessData('],
 ];
 const functions=entryPoints.map(([from,to])=>{
  const start=app.indexOf(from),end=app.indexOf(to,start);
  assert.ok(start>=0&&end>start);
  return app.slice(start,end);
 }).join('\n');
 return {helpers:helpers.exports,source:transpile(functions)};
}
function staffWorkloadView(h,user,ui,today){
 const [ready, statuses]=[[],[]];
 const noop=()=>{};
 function query(base,...parts){
  return parts.reduce((result,[method,...args])=>result[method](...args),base);
 }
 const ctx={
  ...ui.helpers, companyId:user.companyId,staffId:user.staffId,db:{},firebaseConfigured:true,functions:{},
  localDateKey:()=>today,query,collection:(_db,name)=>h.queryDocuments(name),
  where:(...args)=>['where',...args],orderBy:(...args)=>['orderBy',...args],limit:(...args)=>['limit',...args],
  getDocsFromServer:target=>target.get(),getDocs:target=>target.get(),
  authLoadVersionRef:{current:1},openJobsLoadVersionRef:{current:0},openJobsCursorRef:{},openJobsDateRef:{},
  pastShiftVersionRef:{current:0},upcomingShiftCursorRef:{},pastShiftDateRef:{},
  setHasMoreOpenJobs:noop,setOpenJobsPageMessage:noop,setOpenJobsStatus:value=>statuses.push(value),
  setOpenJobs:items=>ready.push(...items),setExpandedOpenJobId:noop,
  setHasMoreUpcomingShifts:noop,setUpcomingShiftMessage:noop,
  httpsCallable:(_functions,name)=>async data=>{
   assert.equal(name,'getMyTasks');return {data:await h.tasks.getMyTasks({auth:user.auth,data})};
  },
 };
 runInNewContext(ui.source,ctx);
 return {open:async()=>{
  assert.equal(await ctx.loadOpenJobs(),true);
  assert.deepEqual(statuses,['loading','ready']);
  return ready;
 },shifts:()=>ctx.fetchMyJobs(user.staffId,user.companyId,true),tasks:()=>ctx.fetchTasks()};
}
async function checkMixedStaffWorkload(count,deviceBound){
 const h=harness(null,null,new Map());
 const base=Date.now();
 const dateAt=days=>new Date(base+(days*24+9)*3600000).toISOString().slice(0,10);
 const today=dateAt(0),future=dateAt(2),past=dateAt(-2),applicationDate=dateAt(5);
 const ui=compileStaffWorkloadUI();
 const apply=h.loadModule('./jobs').applyToJob;
 const revoke=deviceBound?h.loadModule('./devices').revokeMyDevice:null;
 const ng=h.loadModule('./staff-ng');
 const ngHeader=Array(11).fill('');ngHeader[10]='NG会社';
 const knownBlankNg=ng.observeStaffNgCell('マスターデータ',ngHeader,[],19);
 const companies=['synthetic-workload-a','synthetic-workload-b'];
 h.env.DEFAULT_COMPANY_ID=companies[0];
 const groups=new Map();
 for(const companyId of companies){
  const hot='hot-'+companyId,open='open-'+companyId;
  h.records.set('companies/'+companyId+'/settings/drive',{rootFolderId:companyId+'-root'});
  h.records.set('staffNgMaintenance/'+companyId,{schema:'LK_STAFF_NG_MAINTENANCE_V1',companyId,state:'OPEN',generation:0});
  for(const id of [hot,open])h.records.set('jobs/'+id,{companyId,status:'open',publishable:true,dateKey:applicationDate,
   clientName:'Synthetic Client',storeName:'Synthetic Store',makerName:'Synthetic Maker',revision:1});
  groups.set(companyId,{hot,open});
 }
 const users=Array.from({length:count},(_,index)=>{
  const companyId=companies[index%companies.length],staffId='synthetic-mixed-staff-'+index,uid='synthetic-mixed-uid-'+index;
  const jobId='confirmed-'+index,oldId='past-'+index;
  const ngCompanies=ng.mergeStaffNg([{sourceRef:{spreadsheetId:'synthetic-staff-master',sheetName:'マスターデータ'},
    ngCompanyObservation:knownBlankNg}],companyId,staffId);
  h.records.set('staffProfiles/'+staffId,{companyId,active:true,displayName:'Synthetic Staff '+index,ngCompanies,
   ...(deviceBound?{deviceBoundAuthRequired:true}:{})});
  const identity={companyId,staffId,active:true};
  h.records.set('authIdentities/'+uid,identity);
  const profile={companyId,assignedStaffId:staffId,status:'assigned',revision:1,storeName:'Synthetic Store',clientName:'Synthetic Client'};
  h.records.set('jobs/'+jobId,{...profile,dateKey:future,netPrint:{items:[{number:'12345678',printed:false}]}});
  h.records.set('jobs/'+oldId,{...profile,dateKey:past,submissionStatus:{report:{completed:true},salesFloor:{completed:true}}});
  h.records.set('jobs/foreign-'+index,{...profile,companyId:companies[(index+1)%companies.length],dateKey:future});
  const user={index,companyId,staffId,uid,jobId,oldId,auth:{uid,token:{companyId,staffId,role:'staff',auth_time:Math.floor(base/1000)}}};
  if(deviceBound){
   identity.deviceCredentials={};
   const putDevice=label=>{
    const seed=crypto.createHash('sha256').update(uid+'|'+label).digest('hex');
    const sessionId='device_'+seed.slice(0,28),generation=seed.slice(0,48);
    identity.deviceCredentials[sessionId]=generation;
    h.records.set('deviceSessions/'+sessionId,{companyId,staffId,uid,active:true,credentialGeneration:generation});
    const tokenRow='pushTokens/'+sessionId;
    h.records.set(tokenRow,{companyId,staffId,uid,deviceSessionId:sessionId,active:true,token:'synthetic-token-'+seed});
    return {uid,token:{...user.auth.token,crewDeviceSession:sessionId,crewDeviceGeneration:generation}};
   };
   user.auth=putDevice('current');
   if(index%7===0)user.retiredAuth=putDevice('retired');
  }
  return user;
 });
 const timings=new Map();
 async function measure(name,fn){
  const start=performance.now();
  try{return await fn();}
  finally{
   const values=timings.get(name)??[];
   values.push(performance.now()-start);timings.set(name,values);
  }
 }
 let activeUsers=0, peakConcurrentUsers=0;
 const outcomes=await Promise.all(users.map(async(user)=>{
  activeUsers++;
  peakConcurrentUsers=Math.max(peakConcurrentUsers,activeUsers);
  const view=staffWorkloadView(h,user,ui,today),group=groups.get(user.companyId);
  const open=measure('open',view.open),shifts=measure('shifts',view.shifts),tasks=measure('tasks',view.tasks);
  const revocation=user.retiredAuth?measure('revokeAndRejectOldDevice',async()=>{
   const previous=user.retiredAuth,sessionId=previous.token.crewDeviceSession;
   const requestId='retired-application-'+user.index;
   assert.equal((await revoke({auth:user.auth,data:{sessionId}})).revoked,true);
   const checks=[
    h.tasks.getMyTasks({auth:previous}),
    apply({auth:previous,data:{jobId:group.hot,requestId}}),
    h.uploads.createUploadSession({auth:previous,data:{jobId:user.jobId,type:'report',
     clientRequestId:'55555555-5555-4555-8555-555555555555',files:retryFiles()}}),
   ];
   await Promise.all(checks.map(operation=>assert.rejects(operation,{code:'permission-denied'})));
   const identity=h.records.get('authIdentities/'+user.uid);
   assert.equal(identity.deviceCredentials[sessionId],null);
   assert.equal(identity.deviceCredentials[user.auth.token.crewDeviceSession],user.auth.token.crewDeviceGeneration);
   assert.equal(h.records.get('deviceSessions/'+sessionId).active,false);
   assert.equal(h.records.get('deviceSessions/'+user.auth.token.crewDeviceSession).active,true);
   assert.equal(h.records.get('pushTokens/'+sessionId).active,false);
   assert.equal(h.records.get('pushTokens/'+user.auth.token.crewDeviceSession).active,true);
   assert.equal(h.records.has('idempotencyKeys/'+user.uid+'_'+requestId),false);
   return checks.length;
  }):Promise.resolve(0);
  const mutation=measure(user.index%3===0?'apply':user.index%3===1?'submit':'read-only',async()=>{
   if(user.index%3===0){
    const request={auth:user.auth,data:{jobId:group.hot,requestId:'mixed-application-'+user.index}};
    try{
     const first=await apply(request);
     assert.equal(first.ok,true);
     const retry=await apply(request);
     assert.equal(retry.assignedAt,first.assignedAt);
     return {kind:'winner',jobId:group.hot,staffId:user.staffId};
    }catch(error){
     assert.equal(error.code,'already-exists',error.message);
     return {kind:'expected-contention'};
    }
   }
   if(user.index%3===2)return {kind:'read-only'};
   const request={auth:user.auth,data:{jobId:user.jobId,type:'report',clientRequestId:retryRequest,
    expectedDateKey:future,expectedRevision:1,receiptOnly:false,files:retryFiles()}};
   const first=await h.uploads.createUploadSession(request);
   const retry=await h.uploads.createUploadSession(request);
   assert.equal(first.submissionId,retry.submissionId);
   assert.equal(first.files[0].storagePath,retry.files[0].storagePath);
   await h.finish(first.files[0]);
   const state=await h.views.getSubmissionProcessingStatus({auth:user.auth,data:{jobId:user.jobId,submissionId:first.submissionId}});
   assert.equal(state.status,'completed');assert.equal(state.completedFiles,1);
   const foreign=users[(user.index+1)%count];
   await assert.rejects(h.views.getSubmissionProcessingStatus({
    auth:foreign.auth,data:{jobId:user.jobId,submissionId:first.submissionId},
   }),error=>['permission-denied','not-found'].includes(error.code));
   const file=h.records.get('submissions/'+first.submissionId+'/files/'+first.files[0].fileId);
   assert.equal(file.completionCounted,true);
   const month=h.driveFolders.get(h.driveFiles.get(file.driveFileId).parents[0]);
   const client=h.driveFolders.get(month.parents[0]);
   assert.equal(client.parents[0],user.companyId+'-root');
   return {kind:'submission',operation:retryRequest,submissionId:first.submissionId,jobId:user.jobId};
  });
  const [openRows,shiftRows,taskRows,result,denied]=await Promise.all([open,shifts,tasks,mutation,revocation]);
  assert.ok(openRows.some(row=>row.id===group.open));
  assert.ok(openRows.every(row=>row.companyId===user.companyId&&[group.hot,group.open].includes(row.id)));
  assert.ok(shiftRows.every(row=>row.companyId===user.companyId&&row.assignedStaffId===user.staffId));
  assert.deepEqual(Array.from(shiftRows.filter(ui.helpers.staffShiftVisible).map(row=>row.id)).sort(),[user.jobId,user.oldId].sort());
  assert.ok(taskRows.some(row=>row.jobId===user.jobId&&row.kind==='netprint'));
  const scopedJobs=[user.jobId,user.oldId];
  if(result.kind==='winner')scopedJobs.push(group.hot);
  assert.ok(taskRows.every(row=>scopedJobs.includes(row.jobId)));
  activeUsers--;
  return {...result,denied};
 }));
 assert.equal(activeUsers,0);
 assert.equal(peakConcurrentUsers,count);
 const winners=outcomes.filter(result=>result.kind==='winner');
 const uploads=outcomes.filter(result=>result.kind==='submission');
 assert.equal(winners.length,2);
 assert.equal(outcomes.filter(result=>result.kind==='expected-contention').length,users.filter(user=>user.index%3===0).length-2);
 assert.equal(new Set(uploads.map(result=>result.submissionId)).size,uploads.length);
 assert.equal(h.list('submissions').length,uploads.length);
 assert.equal(h.copies,uploads.length);
 assert.equal(h.driveFiles.size,uploads.length);
 assert.equal(h.list('staffDayLocks').length,winners.length);
 assert.equal(h.list('idempotencyKeys').length,winners.length);
 const assignments=h.list('sheetSyncQueue').filter(row=>row.operation==='job.assign');
 assert.equal(assignments.length,winners.length);
 for(const winner of winners){
  const stored=h.records.get('jobs/'+winner.jobId);
  assert.equal(stored.assignedStaffId,winner.staffId);
  assert.equal(stored.applicationUnconfirmed,true);
 }
 const p95=Object.fromEntries([...timings].map(([operation,values])=>{
  const ordered=values.sort((a,b)=>a-b);
  return [operation,Number(ordered[Math.ceil(ordered.length*0.95)-1].toFixed(1))];
 }));
 const revokedDevices=users.filter(user=>user.retiredAuth).length;
 const deniedOperations=outcomes.reduce((sum,row)=>sum+row.denied,0);
 assert.equal(deniedOperations,revokedDevices*3);
 assert.equal(h.list("idempotencyKeys").some(row=>row.requestId?.startsWith("retired-")),false);
 const summary=deviceBound?boundMixedScenarios:mixedScenarios;
 summary.push({sessions:count,peakConcurrentUsers,companies:companies.length,winners:winners.length,
  expectedContention:outcomes.filter(result=>result.kind==='expected-contention').length,
  completedSubmissions:uploads.length,overbooking:0,duplicateSubmissionIds:0,
  crossScopeResults:0,localP95Milliseconds:p95,queryCalls:h.queryReads,documentsReturned:h.returnedDocuments,
  actualCloud:false,...(deviceBound?{deviceBound:true,revokedDevices,deniedOperations}:{}),
 });
}
for (const count of [50,100,300]) {
 await test('staff mixed workload / '+count+' concurrent sessions',()=>checkMixedStaffWorkload(count,false));
 await test('device-bound mixed workload / '+count+' concurrent sessions',()=>checkMixedStaffWorkload(count,true));
}

function boundWork(){
 const h=harness();
 const companyId='synthetic-company',staffId='synthetic-staff',uid='synthetic-user';
 h.records.get('staffProfiles/'+staffId).deviceBoundAuthRequired=true;
 const sessionA='device_'+'a'.repeat(28),sessionB='device_'+'b'.repeat(28);
 const versionA='a'.repeat(48),versionB='b'.repeat(48);
 const identity=h.records.get('authIdentities/'+uid);
 identity.deviceCredentials={[sessionA]:versionA,[sessionB]:versionB};
 const claim=(sessionId,generation)=>({uid,token:{role:'staff',companyId,staffId,auth_time:100,
  crewDeviceSession:sessionId,crewDeviceGeneration:generation}});
 const a=claim(sessionA,versionA),b=claim(sessionB,versionB);
 const submit=(auth,type='report')=>h.uploads.createUploadSession({auth,data:{
  jobId:'synthetic-job',type,clientRequestId:retryRequest,files:retryFiles(),
 }});
 const stop=()=>{h.records.get('authIdentities/'+uid).deviceCredentials[sessionA]=null;};
 return {h,a,b,submit,stop,sessionA,sessionB,versionA,versionB};
}
await test("processing status denies a device disabled during receipt read and keeps receipt on the other device",async()=>{
  const {h,a,b,submit,sessionA}=boundWork();
  const receipt=await submit(a);
  const request={jobId:"synthetic-job",submissionId:receipt.submissionId};
  const identityPath="authIdentities/synthetic-user";
  const assertChanged=afterReceiptRead(h,receipt.submissionId,()=>h.updateRecord(identityPath,{["deviceCredentials."+sessionA]:null}));
  await assert.rejects(h.views.getSubmissionProcessingStatus({auth:a,data:request}),{code:"permission-denied"});
  assertChanged();
  assert.equal((await h.views.getSubmissionProcessingStatus({auth:b,data:request})).status,"uploading");
  assert.equal(h.list("submissions").length,1);
  assert.equal(h.copies,0);
});

for(const type of ['report','sales_floor'])await test('device-bound business / '+type+' resumes on the other device with the original receipt',async()=>{
 const {h,a,b,stop,submit,sessionA,sessionB,versionA,versionB}=boundWork();
 const first=await submit(a,type),file=first.files[0];
 assert.ok(file.storagePath.includes(sessionA+'-'+versionA+'-'));
 stop();
 const before=h.records.size;
 await assert.rejects(()=>submit(a,type),{code:'permission-denied'});
 await assert.rejects(()=>h.views.getSubmissionProcessingStatus({auth:a,data:{jobId:'synthetic-job',submissionId:first.submissionId}}),{code:'permission-denied'});
 assert.equal(h.records.size,before);
 await h.finish(file);
 assert.equal(h.copies,0);
 const next=await submit(b,type),replacement=next.files[0];
 assert.equal(next.submissionId,first.submissionId);
 assert.equal(replacement.fileId,file.fileId);
 assert.ok(replacement.storagePath.includes(sessionB+'-'+versionB+'-'));
 assert.equal(replacement.uploadRequired,true);
 await h.finish(file);
 assert.equal(h.copies,0);
 await h.finish(replacement);
 const result=await h.views.getSubmissionProcessingStatus({auth:b,data:{jobId:'synthetic-job',submissionId:next.submissionId}});
 assert.equal(result.status,'completed');assert.equal(result.completedFiles,1);assert.equal(h.copies,1);
 assert.equal((await submit(b,type)).files[0].uploadRequired,false);
});
await test('device-bound business / accepted bytes finish after the originating device is stopped',async()=>{
 const {h,a,b,stop,submit}=boundWork();
 const first=await submit(a),file=first.files[0];
 h.env.LKC_SUBMISSION_TRANSFER_MODE='paused';await h.finish(file);
 const path='submissions/'+first.submissionId+'/files/'+file.fileId;
 assert.equal(h.records.get(path).status,'paused_global');assert.ok(h.records.get(path).authorizedStagedKey);
 stop();h.env.LKC_SUBMISSION_TRANSFER_MODE='active';await h.finish(file);
 assert.equal(h.copies,1);assert.equal(h.records.get(path).status,'completed');
 assert.equal((await submit(b)).files[0].uploadRequired,false);
});
await test('device-bound business / a replaced preview authorizer cannot view the saved file',async()=>{
 const {h,a,b,stop,submit}=boundWork();
 h.previewBase='https://synthetic.invalid/preview';
 const first=await submit(a);await h.finish(first.files[0]);
 const read=auth=>h.views.getSubmissionTimeline({auth,data:{jobId:'synthetic-job',type:'report'}});
 const old=await read(a),url=old.submissions[0].files[0].previewUrl;
 assert.ok(url);
 stop();
 const response={code:null,setHeader(){},status(code){this.code=code;return this;},send(){}};
 await h.views.driveFilePreview({query:{token:new URL(url).searchParams.get('token')}},response);
 assert.equal(response.code,410);
 await assert.rejects(()=>read(a),{code:'permission-denied'});
 assert.ok((await read(b)).submissions[0].files[0].previewUrl);
});
await test('device-bound business / stopped device cannot apply again; other device can read the same receipt',async()=>{
 const {h,a,b,stop}=boundWork();
 h.env.DEFAULT_COMPANY_ID='synthetic-company';
 const ng=h.loadModule('./staff-ng');
 const header=Array(11).fill('');header[10]='NG会社';
 const blank=ng.observeStaffNgCell('マスターデータ',header,[],19);
 h.records.get('staffProfiles/synthetic-staff').ngCompanies=ng.mergeStaffNg([
  {sourceRef:{spreadsheetId:'synthetic-staff-master',sheetName:'マスターデータ'},ngCompanyObservation:blank}
 ],'synthetic-company','synthetic-staff');
 h.records.set('staffNgMaintenance/synthetic-company',{schema:'LK_STAFF_NG_MAINTENANCE_V1',companyId:'synthetic-company',state:'OPEN',generation:0});
 h.records.set('jobs/synthetic-app-open',{companyId:'synthetic-company',status:'open',publishable:true,dateKey:'2099-01-01',
  clientName:'Synthetic Client',storeName:'Synthetic Store',makerName:'Synthetic Maker',revision:1});
 const mutation=h.loadModule('./jobs').applyToJob;
 const data={jobId:'synthetic-app-open',requestId:'synthetic-device-apply'};
 const first=await mutation({auth:a,data});assert.equal(first.ok,true);
 stop();const count=h.list('sheetSyncQueue').length;
 await assert.rejects(()=>mutation({auth:a,data}),{code:'permission-denied'});
 const again=await mutation({auth:b,data});
 assert.equal(again.assignedAt,first.assignedAt);assert.equal(h.list('sheetSyncQueue').length,count);
});

if(runDirectly&&mixedScenarios.length)console.log(JSON.stringify({mixedScenarios}));
if(runDirectly&&boundMixedScenarios.length)console.log(JSON.stringify({boundMixedScenarios}));

// Exercise the real server receipt and browser validator together with synthetic SDK ports.
await test('upload receipt contract / normal and renewed device paths match ordered browser identities',async()=>{
 const source=fs.readFileSync(new URL('../apps/staff/src/submission-attempt-store.ts',import.meta.url),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const exports={};
 runInNewContext(compiled,{exports,crypto:crypto.webcrypto,Uint8Array,TextEncoder},{timeout:5000});
 const request={jobId:'synthetic-job',type:'report',purpose:'additional',clientRequestId:retryRequest,
  expectedDateKey:'2026-09-20',expectedRevision:0,receiptOnly:false};
 const files=retryFiles(2);
 const check=async(h,auth)=>{
  const actual=await h.uploads.createUploadSession({auth,data:{...request,files}});
  const scope={companyId:auth.token.companyId,staffId:auth.token.staffId,uid:auth.uid};
  assert.equal(await exports.readSubmissionUploadReceipt(actual,request,true,2,scope),actual);
  await assert.rejects(()=>exports.readSubmissionUploadReceipt({...actual,files:[...actual.files].reverse()},request,true,2,scope),/送信先/);
  return actual;
 };
 const ordinary=harness();
 await check(ordinary,ordinary.staff);
 const device=boundWork();
 const first=await check(device.h,device.a);
 device.stop();
 const resumed=await check(device.h,device.b);
 assert.equal(first.submissionId,resumed.submissionId);
 assert.deepEqual(Array.from(first.files,file=>file.fileId),Array.from(resumed.files,file=>file.fileId));
 assert.ok(first.files.every((file,index)=>file.storagePath!==resumed.files[index].storagePath));
});

for(const paused of [false,true])for(const change of ['foreign company','foreign UID','unregistered object','nested object']){
 await test('upload event scope / '+(paused?'paused':'active')+' '+change+' cannot alter the booked submission',async()=>{
  const h=harness(),saved=await retryStart(h),file=saved.files[0];
  const parts=file.storagePath.split('/');
  if(change==='foreign company')parts[1]='foreign-company';
  if(change==='foreign UID')parts[2]='foreign-user';
  if(change==='unregistered object')parts[5]='arbitrary-upload';
  if(change==='nested object')parts.push('extra');
  const spoof={...file,storagePath:parts.join('/')};
  if(paused)pauseTransfers(h);
  const before=JSON.stringify([...h.records]);
  await h.finish(spoof);
  assert.equal(JSON.stringify([...h.records]),before,'Only the exact stored path may act on the receipt');
  assert.equal(h.copies,0);assert.equal(h.deletes,0);assert.equal(h.byteScans??0,0);
  if(paused)h.records.get('productionControls/synthetic-company').emergencyLock=false;
  await h.finish(file);
  assert.equal((await h.state(saved.submissionId)).status,'completed');
  assert.equal(h.copies,1);
  assert.equal(h.deletes,1);
  assert.deepEqual(h.deletedPaths,[file.storagePath]);
 });
}
await test('upload event scope / delayed previous device completion yields to renewed path during byte verification',async()=>{
 const {h,a,b,submit,stop}=boundWork();
 const original=await submit(a),file=original.files[0];
 let reached,release;
 const started=new Promise(done=>{reached=done;});
 const wait=new Promise(done=>{release=done;});
 h.beforeByteScan=async()=>{reached();await wait;};
 const oldFinalization=h.finish(file);
 await started;
 stop();
 const renewed=await submit(b);
 const fresh=renewed.files[0];
 assert.equal(original.submissionId,renewed.submissionId);
 assert.equal(file.fileId,fresh.fileId);
 assert.notEqual(file.storagePath,fresh.storagePath);
 const before=JSON.stringify([...h.records]);
 h.beforeByteScan=null;
 release();
 await oldFinalization;
 assert.equal(JSON.stringify([...h.records]),before);
 assert.equal(h.copies,0);assert.equal(h.deletes,0);
 await h.finish(fresh);
 const done=await h.views.getSubmissionProcessingStatus({auth:b,data:{jobId:"synthetic-job",submissionId:renewed.submissionId}});
 assert.equal(done.completedFiles,1);
 assert.equal(h.copies,1);
 assert.deepEqual(h.deletedPaths,[fresh.storagePath]);
});

await test('granted staging / issuance, expiry refresh, consumption and one kept receipt',async()=>{
 const h=harness();
 const first=await retryStart(h,2),file=first.files[0],identity=()=>h.records.get(submissionIdentity);
 const grants=()=>identity().submissionUploadGrants;
 assert.equal(grants()[file.fileId].storagePath,file.storagePath);
 assert.equal(grants()[file.fileId].contentSha256,syntheticDigest);
 assert.equal(grants()[file.fileId].size,100);
 const previous=grants()[file.fileId].expiresAt;
 const stable=await retryStart(h,2);
 assert.equal(stable.submissionId,first.submissionId);
 assert.ok(grants()[file.fileId].expiresAt.isEqual(previous));
 grants()[file.fileId].expiresAt=Timestamp.fromMillis(1);
 const refreshed=await retryStart(h,2);
 assert.equal(refreshed.submissionId,first.submissionId);
 assert.equal(refreshed.files[0].storagePath,file.storagePath);
 assert.ok(grants()[file.fileId].expiresAt.toMillis()>Date.now());
 await h.finish(file);
 assert.equal(grants()[file.fileId],undefined);
 assert.ok(grants()[first.files[1].fileId]);
 const resumed=await retryStart(h,2);
 assert.equal(resumed.files[0].uploadRequired,false);
 assert.equal(grants()[file.fileId],undefined);
 assert.equal(h.copies,1);
});
await test('granted staging / legacy in-flight receipt obtains a grant without replacing its path',async()=>{
 const h=harness(),first=await retryStart(h);
 const identity=h.records.get(submissionIdentity);
 delete identity.submissionUploadGrants;
 const again=await retryStart(h);
 assert.equal(again.submissionId,first.submissionId);
 assert.equal(again.files[0].storagePath,first.files[0].storagePath);
 assert.equal(h.records.get(submissionIdentity).submissionUploadGrants[first.files[0].fileId].storagePath,first.files[0].storagePath);
});
await test('granted staging / device renewal replaces the old grant and rejects late old event',async()=>{
 const {h,a,b,submit,stop}=boundWork(),first=await submit(a);
 const file=first.files[0];
 stop();const fresh=await submit(b);
 assert.equal(fresh.submissionId,first.submissionId);
 assert.notEqual(fresh.files[0].storagePath,file.storagePath);
 await h.finish(file);
 assert.equal(h.records.get(submissionIdentity).submissionUploadGrants[file.fileId].storagePath,fresh.files[0].storagePath);
 assert.equal(h.copies,0);
 await h.finish(fresh.files[0]);
 assert.equal(h.records.get(submissionIdentity).submissionUploadGrants[file.fileId],undefined);
 assert.equal(h.copies,1);
});
await test('granted staging / failed beginning leaves the existing grant map and no new receipt',async()=>{
 const h=harness();
 h.failWrite=w=>w.ref.path.startsWith('submissions/');
 const previous=JSON.stringify([...h.records]);
 await assert.rejects(()=>retryStart(h));
 assert.equal(JSON.stringify([...h.records]),previous);
});

await test('submission Firebase SDK wire compatibility',()=>runSubmissionTimelineWireTests(harness));
if(runDirectly){
  console.log(JSON.stringify({passed:results.filter(r=>r.ok).length,results,boundary:'Complete actual modules, synthetic callable/Storage/Drive and in-memory DB. No external network, real login, emulator, concurrent SDK transactions or delivery.'},null,2));
  if(results.some(r=>!r.ok))process.exitCode=1;
}
