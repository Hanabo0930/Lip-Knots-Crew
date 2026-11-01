import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';

// Exercise the installed client SDK, the actual UI function and the actual
// callable handler together. Only transport and service boundaries are fake.
export async function runSubmissionTimelineWireTests(harness) {
  const dependency=createRequire(new URL('../apps/admin/package.json',import.meta.url));
  const ts=dependency('typescript');
  const appSource=fs.readFileSync(new URL('../apps/admin/src/App.tsx',import.meta.url),'utf8');
  const start=appSource.indexOf('  async function loadSubmissionTimeline(');
  const end=appSource.indexOf('  async function openComparison(',start);
  assert.ok(start>=0&&end>start,'Actual timeline loader must be found');
  const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const timelineExports={exports:{}};
  runInNewContext(compile(fs.readFileSync(new URL('../apps/admin/src/submission-timeline.ts',import.meta.url),'utf8')),timelineExports);
  const loader=compile(appSource.slice(start,end));
  const endpoint='https://example.invalid/timeline';
  const originalFetch=globalThis.fetch;
  const requests=[];
  let h=harness(),deleteApp,app,operation='timeline';
  globalThis.fetch=async (url,options)=>{
    assert.equal(String(url),endpoint,'All real network access is refused');
    assert.equal(options.method,'POST');
    const body=JSON.parse(options.body);
    requests.push(body.data);
    try {
      const handler=operation==='timeline'?h.views.getSubmissionTimeline:h.requests.createResubmissionRequest;
      const data=await handler({auth:h.admin,data:body.data});
      return new Response(JSON.stringify({data}),{status:200,headers:{'Content-Type':'application/json'}});
    } catch {
      return new Response(JSON.stringify({error:{status:'INVALID_ARGUMENT',message:'Synthetic request rejected'}}),{status:400,headers:{'Content-Type':'application/json'}});
    }
  };
  try {
    // Load after replacing fetch so the SDK captures only the fake transport.
    const firebaseApp=dependency('firebase/app');
    const firebaseFunctions=dependency('firebase/functions');
    deleteApp=firebaseApp.deleteApp;
    app=firebaseApp.initializeApp({projectId:'demo-timeline-wire',apiKey:'synthetic-wire-key',appId:'1:123:web:wire'},'submission-timeline-wire');
    const functions=firebaseFunctions.getFunctions(app);
    const callable=firebaseFunctions.httpsCallableFromURL(functions,endpoint,{timeout:5000});
    async function readUI(type,previewFile) {
      const user={uid:'synthetic-admin'};
      const state={groups:[{id:'old',files:[]}],status:'ready',busy:false};
      const context={
        require:name=>{assert.equal(name,'./submission-timeline');return timelineExports.exports;},
        selectedAdminJobId:'synthetic-job',firebaseConfigured:true,user,auth:{currentUser:user},functions,
        adminAuthorizationReadyRef:{current:true},resubmitType:type,submissionTimeline:state.groups,
        timelineKey:'synthetic-job:'+type,timelineKeyRef:{current:'synthetic-job:'+type},
        timelineVersionRef:{current:0},timelinePendingRef:{current:null},
        setSubmissionTimeline:value=>state.groups=value,setSelectedSourceFile:()=>{},
        setTimelineStatus:value=>state.status=value,setTimelineBusy:value=>state.busy=value,setTimelineLoadedKey:value=>state.key=value,
        httpsCallable:(service,name)=>{assert.equal(service,functions);assert.equal(name,'getSubmissionTimeline');return callable;},
      };
      runInNewContext(loader,context);
      await context.loadSubmissionTimeline(previewFile);
      assert.equal(state.status,'ready');
      assert.equal(state.busy,false);
      assert.equal(context.timelinePendingRef.current,null);
      return state;
    }
    for(const type of ['report','sales_floor']) {
      h=harness();
      const state=await readUI(type);
      assert.equal(JSON.stringify(state.groups),'[]');
      assert.equal(Object.hasOwn(requests.at(-1),'previewFile'),false,'Ordinary UI reads must omit the optional property');
      assert.equal(h.queryReads,1,'The authorized timeline query must actually run');
      const legacy=await callable({jobId:'synthetic-job',type,previewFile:undefined});
      assert.equal(requests.at(-1).previewFile,null,'Real SDK must reproduce the legacy undefined-to-null wire value');
      assert.deepEqual(legacy.data,{submissions:[]},'Already-loaded clients must remain compatible');
    }
    h=harness();
    const target={submissionId:'synthetic-missing-submission',fileId:'synthetic-missing-file'};
    await readUI('report',target);
    assert.deepEqual(requests.at(-1).previewFile,target,'Targeted refresh identifiers must survive serialization');
    assert.equal(h.queryReads,0,'A targeted refresh must not fall back to the full timeline');
    for(const previewFile of [{},{submissionId:'',fileId:'file'},{submissionId:'  ',fileId:'file'},{submissionId:'parent/child',fileId:'file'},{submissionId:'submission',fileId:'file/child'},[],false]) {
      h=harness();
      await assert.rejects(callable({jobId:'synthetic-job',type:'report',previewFile}),{code:'functions/invalid-argument'});
      assert.equal(h.documentReads,0,'Malformed targets must be refused before any database read');
      assert.equal(h.queryReads,0);
    }
    for(const input of [{type:'report',previewFile:null},{jobId:'synthetic-job',type:'other',previewFile:null}]) {
      await assert.rejects(callable(input),{code:'functions/invalid-argument'});
    }
    h=harness();
    const data={jobId:'synthetic-job',type:'report',previewFile:null};
    await assert.rejects(h.views.getSubmissionTimeline({data}),{code:'unauthenticated'});
    await assert.rejects(h.views.getSubmissionTimeline({auth:{...h.admin,token:{...h.admin.token,companyId:'foreign-company'}},data}),{code:'not-found'});
    await assert.rejects(h.views.getSubmissionTimeline({auth:{...h.staff,token:{...h.staff.token,staffId:'foreign-staff'}},data}),{code:'permission-denied'});
    assert.equal(h.queryReads,0,'Null compatibility must not bypass company or assignment authorization');
    console.log(JSON.stringify({submissionTimelineWire:{passed:true,transport:'Actual Firebase SDK with a fixed fake endpoint; no real network or data writes'}}));
    operation='resubmission';
    const createStart=appSource.indexOf('  async function createResubmission()');
    const createEnd=appSource.indexOf('  async function refreshResubmissionList(',createStart);
    assert.ok(createStart>=0&&createEnd>createStart,'Actual resubmission action must be found');
    const createLoader=compile(appSource.slice(createStart,createEnd));
    async function createUI(type,sourceFile=null) {
      const user={uid:'synthetic-admin'},state={busy:false,review:false,messages:[],reloads:0};
      const context={
        resubmissionNeedsReviewRef:{current:false},resubmissionPendingRef:{current:false},
        jobs:[{id:'synthetic-job'}],mailSubmissionHeld:()=>false,selectedAdminJobId:'synthetic-job',
        timelineReady:true,timelinePendingRef:{current:null},resubmitReasons:['その他'],resubmitNote:'',
        selectedSourceFile:sourceFile,submissionTimeline:sourceFile?[{files:[sourceFile]}]:[],
        firebaseConfigured:true,functions,auth:{currentUser:user},timelineKey:'scope',timelineKeyRef:{current:'scope'},resubmitType:type,
        setMessage:value=>state.messages.push(value),setResubmissionBusy:value=>state.busy=value,setResubmissionNeedsReview:value=>state.review=value,
        loadResubmissions:async guard=>{assert.equal(guard(),true);state.reloads++;},
        httpsCallable:(service,name)=>{assert.equal(service,functions);assert.equal(name,'createResubmissionRequest');return callable;},
      };
      runInNewContext(createLoader,context);
      await context.createResubmission();
      assert.equal(state.busy,false);assert.equal(state.review,false);assert.equal(context.resubmissionPendingRef.current,false);
      assert.equal(state.reloads,1,'The actual UI must reach the accepted/reload path');
      assert.ok(state.messages.includes('再提出依頼を送りました。'));
    }
    for(const type of ['report','sales_floor']) {
      h=harness();await createUI(type);
      for(const key of ['sourceSubmissionId','sourceFileId'])assert.equal(Object.hasOwn(requests.at(-1),key),false,'Whole-case UI requests must omit source identifiers');
      assert.equal(h.list('resubmissionRequests').length,1);assert.equal(h.list('notificationQueue').length,1);
      assert.equal(h.list('resubmissionRequests')[0].sourceSubmissionId,null);assert.equal(h.list('resubmissionRequests')[0].sourceFileId,null);
      h=harness();
      const response=await callable({jobId:'synthetic-job',type,reasons:['その他'],sourceSubmissionId:undefined,sourceFileId:undefined});
      assert.equal(typeof response.data.requestId,'string');
      assert.equal(requests.at(-1).sourceSubmissionId,null);assert.equal(requests.at(-1).sourceFileId,null);
      assert.equal(h.list('resubmissionRequests').length,1,'Existing SDK clients must create the same whole-case request');
      h=harness();const source=await h.start(1,{type});await h.finish(source.files[0]);
      const sourceFile={id:source.files[0].fileId,submissionId:source.submissionId,status:'completed'};
      await createUI(type,sourceFile);
      assert.equal(requests.at(-1).sourceSubmissionId,sourceFile.submissionId);assert.equal(requests.at(-1).sourceFileId,sourceFile.id);
      assert.equal(h.list('resubmissionRequests')[0].sourceFileId,sourceFile.id,'Targeted requests must keep the validated completed source');
    }
    for(const invalid of [{sourceSubmissionId:null,sourceFileId:'orphan'},{sourceSubmissionId:17,sourceFileId:null},{sourceSubmissionId:null,sourceFileId:[]}]) {
      h=harness();await assert.rejects(callable({jobId:'synthetic-job',type:'report',reasons:['その他'],...invalid}),{code:'functions/invalid-argument'});
      assert.equal(h.list('resubmissionRequests').length,0);assert.equal(h.list('notificationQueue').length,0);
    }
    const wholeCase={jobId:'synthetic-job',type:'report',reasons:['その他'],sourceSubmissionId:null,sourceFileId:null};
    h=harness();
    await assert.rejects(h.requests.createResubmissionRequest({data:wholeCase}),{code:'unauthenticated'});
    await assert.rejects(h.requests.createResubmissionRequest({auth:h.staff,data:wholeCase}),{code:'permission-denied'});
    await h.updateRecord('jobs/synthetic-job',{status:'cancelled',cancelled:true});
    await assert.rejects(h.requests.createResubmissionRequest({auth:h.admin,data:wholeCase}),{code:'failed-precondition'});
    assert.equal(h.list('resubmissionRequests').length,0);assert.equal(h.list('notificationQueue').length,0);
    console.log(JSON.stringify({resubmissionWire:{passed:true,transport:'Actual SDK/UI/handler; only synthetic requests and synthetic notification records; no real delivery'}}));
  } finally {
    if(app)await deleteApp(app);
    globalThis.fetch=originalFetch;
  }
}
