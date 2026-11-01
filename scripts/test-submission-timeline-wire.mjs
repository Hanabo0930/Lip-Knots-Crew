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
  let h=harness(),deleteApp,app;
  globalThis.fetch=async (url,options)=>{
    assert.equal(String(url),endpoint,'All real network access is refused');
    assert.equal(options.method,'POST');
    const body=JSON.parse(options.body);
    requests.push(body.data);
    try {
      const data=await h.views.getSubmissionTimeline({auth:h.admin,data:body.data});
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
    await assert.rejects(h.views.getSubmissionTimeline({auth:{...h.admin,token:{...h.admin.token,companyId:'foreign-company'}},data}),{code:'permission-denied'});
    await assert.rejects(h.views.getSubmissionTimeline({auth:{...h.staff,token:{...h.staff.token,staffId:'foreign-staff'}},data}),{code:'permission-denied'});
    assert.equal(h.queryReads,0,'Null compatibility must not bypass company or assignment authorization');
    console.log(JSON.stringify({submissionTimelineWire:{passed:true,transport:'Actual Firebase SDK with a fixed fake endpoint; no real network or data writes'}}));
  } finally {
    if(app)await deleteApp(app);
    globalThis.fetch=originalFetch;
  }
}
