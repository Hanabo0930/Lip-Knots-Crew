'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),req=createRequire(path.join(root,'scripts/test-crew-external-receipt.cjs'));
const crypto=require('node:crypto');
const dependencyRoot=process.env.LKC_TEST_SERVER_DEPENDENCY_ROOT||root;
const ts=createRequire(path.join(dependencyRoot,'package.json'))('typescript');
const policy=path.join(root,'functions/src/case-list-external-mode.ts');
const originalPolicy=fs.readFileSync(policy,'utf8');
const normalMode='export const EXTERNAL_COMPATIBILITY_ONLY = false;';
assert.equal(originalPolicy.split(normalMode).length,2,'Expected normal policy');
const compatiblePolicy=originalPolicy.replace(normalMode,'export const EXTERNAL_COMPATIBILITY_ONLY = true;');
const configFile=path.join(root,'functions/tsconfig.json');
const config=ts.readConfigFile(configFile,ts.sys.readFile);
assert.equal(config.error,undefined);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,path.dirname(configFile));
assert.deepEqual(parsed.errors,[]);
const options={...parsed.options,noEmit:true,types:['node'],
  typeRoots:[path.join(dependencyRoot,'functions/node_modules/@types'),path.join(dependencyRoot,'node_modules/@types')]};
const host=ts.createCompilerHost(options);
const originalRead=host.readFile.bind(host);
host.readFile=file=>path.resolve(file)===policy?compatiblePolicy:originalRead(file);
host.resolveModuleNames=(names,file)=>names.map(name=>{
  const relative=path.relative(root,file);
  const owner=name.startsWith('.')||relative.startsWith('..')?file:path.join(dependencyRoot,relative);
  return ts.resolveModuleName(name,owner,options,host).resolvedModule;
});
const program=ts.createProgram(parsed.fileNames,options,host);
assert.equal(program.getSourceFile(policy)?.text,compatiblePolicy);
const diagnostics=ts.getPreEmitDiagnostics(program);
if(diagnostics.length){
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,host));
  throw Error('COMPATIBILITY_TYPECHECK_FAILED');
}
assert.equal(fs.readFileSync(policy,'utf8'),originalPolicy);
const source=fs.readFileSync(path.join(root,'scripts/test-crew-external-receipt.cjs'),'utf8'),prefix=source.slice(0,source.indexOf('(async()=>{'));
function boot(compatibility){
 let code=prefix.replace('assert.deepEqual(original.position,','assert.deepEqual(JSON.parse(JSON.stringify(original.position)),');
 const fixtureFs={...fs,readFileSync(file,...args){
  return compatibility&&path.resolve(file)===policy?compatiblePolicy:fs.readFileSync(file,...args);
 }};
 const fixtureRequire=name=>name==='node:fs'?fixtureFs:req(name);
 const module={exports:{}},context={__dirname:path.join(root,'scripts'),require:fixtureRequire,module,Buffer,console,process,setTimeout,clearTimeout};
 code+=`
 const encode=v=>v instanceof Stamp?{$fixtureStamp:v.toMillis()}:Array.isArray(v)?v.map(encode):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,encode(x)])):v;
 const decode=v=>v&&typeof v==='object'&&Object.hasOwn(v,'$fixtureStamp')?Stamp.fromMillis(v.$fixtureStamp):Array.isArray(v)?v.map(decode):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,decode(x)])):v;
 module.exports={
  start,archive:archiveFixture,reconcile,
  partialManual:async()=>{try{await start(true,true,()=>{afterCommit=()=>{const op=[...documents.values()].find(v=>v.externalManualRequested===true);if(op&&!op.externalSelection){afterCommit=null;throw Error('SYNTHETIC_PARTIAL_MANUAL_COMMIT');}};});}catch(e){if(!e.message.includes('SYNTHETIC_PARTIAL_MANUAL_COMMIT'))throw e;}return documents.get('jobs/'+jobId).assignmentSheetWrite.queueId;},
  mode:()=>load('case-list-external-mode').externalTransferMode(),setMode:v=>{if(v===undefined)delete runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE;else runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE=v;},
  privateRef:()=>priv.resolveCaseListPrivateSheetRef(COMPANY,jobId,documents.get('jobs/'+jobId)),
  legacyFinance:()=>priv.resolveCaseListPrivateFinancialJob(COMPANY,jobId,documents.get('jobs/'+jobId)),
  startExpense:()=>start(false,false,()=>{documents.get('sheetImportConfigs/'+COMPANY).columns={transportation:'AK',purchase8:'AL',purchase10:'AM',netPrintCost:'AO',postageCost:'AP'};}),
  seedExpense:()=>{
   const row=sheetsData.get(434431224).get(3);
   assert.equal(cellValue(row[55]),CASE);
   row[36]=literal(700);row[37]={};row[38]=literal(0);row[40]=literal(50);row[41]=literal(90);
  },
  readExpense:async()=>{
   const result=await admin.getExpenseReview({...owner,data:{jobId}});
   return {values:encode(result.currentValues),version:result.reviewVersion,blocked:Boolean(result.writeBlockedReason)};
  },
  confirmExpense:({values,version})=>{
   runtimeEnvironment.LKC_SHEET_WRITE_MODE='active';
   return admin.completeExpenseReview({...owner,data:{jobId,expectedVersion:version,values:{...values,transportation:850}}});
  },
  import:()=>importer.executeCaseListImport(COMPANY,'commit',OWNER,owner.auth.token),
  select:queueId=>admin.acknowledgeSheetWriteIssue({...owner,data:{action:'select-case-list-gas-monthly',queueId,reviewKey:documents.get('sheetSyncQueue/'+queueId).caseListPhase.continuationHash,clientNameUpConfirmed:true}}),
  capture:()=>encode({documents:[...documents],sheetsData:[...sheetsData].map(([id,rows])=>[id,[...rows]]),metadata,jobId,writes,nativeCalls,requests}),
  restore:s=>{const x=decode(s);documents=new Map(x.documents);sheetsData=new Map(x.sheetsData.map(([id,rows])=>[id,new Map(rows)]));metadata=x.metadata;jobId=x.jobId;writes=x.writes;nativeCalls=x.nativeCalls;requests=x.requests;googleReadHandler=googleRead;clockOffset=0;txTail=Promise.resolve();},
  state:()=>({job:encode(documents.get('jobs/'+jobId)),writes,nativeCalls,reads:requests.length,queueCount:[...documents.keys()].filter(k=>k.startsWith('sheetSyncQueue/')).length,
   operations:encode([...documents].filter(([key])=>key.startsWith('caseListMonthlyOperations/')))}),
  corrupt:()=>{const j=documents.get('jobs/'+jobId),op=documents.get('caseListMonthlyOperations/'+sha(COMPANY+'|'+j.assignmentSheetWrite.queueId));op.externalAcceptance.acceptanceHash='f'.repeat(64);}
 };
 `;
 vm.runInNewContext(code,context,{filename:compatibility?'actual-readonly-compatibility-build':'actual-normal-control-build'});return module.exports;
}
const results=[];async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.stack});}}
(async()=>{
 await test('pinned read-only build ignores enabled/paused/unset/invalid runtime requests',async()=>{
  const c=boot(true);for(const mode of ['enabled','paused','read-only','invalid',undefined]){c.setMode(mode);assert.equal(c.mode(),'read-only');}
 });
 await test('unconfirmed archived receipt survives compatibility cutover unchanged and without metadata writes',async()=>{
  const n=boot(false),f=await n.start(false,true);n.archive(f);const snapshot=n.capture(),c=boot(true);c.restore(snapshot);c.setMode('enabled');const before=c.state();
  await assert.rejects(()=>c.reconcile({queueId:f.queueId}),/EXTERNAL_TRANSFER_COMPATIBILITY_HOLD/);
  const after=c.state();assert.equal(JSON.stringify(after),JSON.stringify(before));assert.equal(after.job.applicationUnconfirmed,true);
 });
 await test('partial manual registration before selection never falls back to native lease or claim',async()=>{
  const n=boot(false),queueId=await n.partialManual(),c=boot(true);c.restore(n.capture());const before=c.state();
  await assert.rejects(()=>c.reconcile({queueId}),/EXTERNAL_TRANSFER_COMPATIBILITY_HOLD/);assert.equal(JSON.stringify(c.state()),JSON.stringify(before));
 });
 await test('completed external evidence remains readable through compatibility import with no native ACK or replay',async()=>{
  const n=boot(false),f=await n.start(true,true);n.archive(f);await n.reconcile(f);const c=boot(true);c.restore(n.capture());c.setMode('enabled');const before=c.state(),hash=before.job.assignmentSheetWrite.externalAck.acceptanceHash;
  assert.equal((await c.privateRef()).caseId,before.job.caseId);assert.equal((await c.reconcile({queueId:f.queueId})).status,'EXTERNAL_ALREADY_ACCEPTED');assert.equal(c.state().writes,before.writes);
  await assert.rejects(()=>c.select(f.queueId),/EXTERNAL_TRANSFER_INTAKE_PAUSED/);await c.import();const after=c.state();
  assert.equal(after.job.applicationUnconfirmed,false);assert.equal(after.job.assignmentSheetWrite.externalAck.acceptanceHash,hash);assert.equal(after.queueCount,before.queueCount);assert.equal(after.nativeCalls,before.nativeCalls);assert(!after.job.assignmentSheetWrite.nativeAck);
 });
 await test('quiesce -> original readback -> compatible reader -> normal reader preserves one queue and acceptance',async()=>{
  const n=boot(false),f=await n.start(false,true);n.setMode('paused');n.archive(f);await n.reconcile(f);const accepted=n.capture(),h=n.state().job.assignmentSheetWrite.externalAck.acceptanceHash;
  const c=boot(true);c.restore(accepted);await c.privateRef();const normalAgain=boot(false);normalAgain.restore(c.capture());normalAgain.setMode('enabled');
  assert.equal((await normalAgain.reconcile({queueId:f.queueId})).status,'EXTERNAL_ALREADY_ACCEPTED');const final=normalAgain.state();
  assert.equal(final.job.assignmentSheetWrite.queueId,f.queueId);assert.equal(final.job.assignmentSheetWrite.externalAck.acceptanceHash,h);assert.equal(final.queueCount,1);assert(!final.job.assignmentSheetWrite.nativeAck);
 });
 await test('corrupt existing acceptance is rejected by compatible reader without conversion or retransmission',async()=>{
  const n=boot(false),f=await n.start(false,true);n.archive(f);await n.reconcile(f);const c=boot(true);c.restore(n.capture());c.corrupt();const before=c.state();
  await assert.rejects(()=>c.privateRef());assert.equal(c.state().writes,before.writes);assert.equal(c.state().nativeCalls,before.nativeCalls);assert.equal(c.state().queueCount,1);
 });
 await test('private expense readback survives mode cutover without confirming or writing',async()=>{
  const normal=boot(false),f=await normal.startExpense();
  normal.archive(f);await normal.reconcile(f);normal.seedExpense();
  const old=JSON.parse(JSON.stringify(await normal.readExpense()));
  assert.deepEqual(old.values,{transportation:700,purchase8:null,purchase10:0,netPrintCost:50,postageCost:90});
  const compatible=boot(true);compatible.restore(normal.capture());compatible.setMode('enabled');
  const before=compatible.state(),snapshot=compatible.capture();
  const shown=JSON.parse(JSON.stringify(await compatible.readExpense()));
  assert.deepEqual(shown,old);
  assert.ok(shown.blocked);
  await assert.rejects(()=>compatible.confirmExpense(shown),error=>error.code==='failed-precondition'&&error.details?.reason==='case_list_private_expense_completion_held');
  await assert.rejects(()=>compatible.legacyFinance(),error=>error.details?.reason==='case_list_external_finance_observation_required');
  const after=compatible.state(),saved=compatible.capture();
  assert.equal(JSON.stringify(saved.sheetsData),JSON.stringify(snapshot.sheetsData));
  assert.equal(JSON.stringify(saved.metadata),JSON.stringify(snapshot.metadata));
  assert.equal(after.writes,before.writes);
  assert.equal(after.nativeCalls,before.nativeCalls);
  assert.equal(after.queueCount,before.queueCount);
  assert.equal(JSON.stringify(after.operations),JSON.stringify(before.operations));
  assert.equal(JSON.stringify(after.job),JSON.stringify(before.job));
  const restored=boot(false);restored.restore(compatible.capture());restored.setMode('enabled');
  assert.deepEqual(JSON.parse(JSON.stringify(await restored.readExpense())),old);
  assert.equal(restored.state().nativeCalls,before.nativeCalls);
 });
 const report={tests:results.length,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results,
  scope:'Actual normal/compatibility source builds share synthetic Firestore/Sheets records; only compile-time compatibility flag differs. Not a cloud revision-routing/drain or real GAS acceptance test.',
  typecheckedSources:parsed.fileNames.length,compatiblePolicySha256:crypto.createHash('sha256').update(compatiblePolicy).digest('hex'),
  realApiCalls:0,realDataWrites:0,nativeAckConversions:0,realConfigurationChanged:false};
 const evidence=process.env.LKC_TEST_SYNTHETIC_EVIDENCE_DIR||path.join(root,'release-evidence');
 fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'ci-crew-external-compatibility.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
