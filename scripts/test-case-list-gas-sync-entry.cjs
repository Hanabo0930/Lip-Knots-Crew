'use strict';
// Actual entry + runtime/core, synthetic identities and resource ports only.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const repo=path.resolve(__dirname,'..'),src=path.join(repo,'functions/src'),dep=process.env.LKC_TEST_DEPENDENCY_ROOT||repo,ts=createRequire(path.join(dep,'package.json'))('typescript');
function load(name,bindings={},env={}){const file=path.join(src,name+'.ts'),module={exports:{}};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;const req=id=>Object.hasOwn(bindings,id)?bindings[id]:id.startsWith('../src/')?require(path.resolve(src,id)):id.startsWith('./')&&fs.existsSync(path.join(src,id+'.ts'))?load(id.slice(2),bindings,env):require(id);vm.runInNewContext(code,{module,exports:module.exports,require:req,process:{env},Buffer,Date,console},{filename:file});return module.exports;}
const clone=x=>JSON.parse(JSON.stringify(x)),results=[];async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.stack});}}
function entry(env={}){return load('case-list-gas-sync-entry',{'firebase-functions/v2/https':{onRequest:(options,handler)=>({options,handler})}},env);}
function response(){const state={};const res={set:(k,v)=>{state[k]=v;return res;},status:n=>{state.status=n;return res;},json:body=>{state.body=clone(body);return res;}};return {res,state};}
const settings=()=>({LKC_GAS_SYNC_MODE:'business',EXPECTED_FIREBASE_PROJECT_ID:'lip-knots-crew-staging',GCLOUD_PROJECT:'lip-knots-crew-staging',DEFAULT_COMPANY_ID:'synthetic_company',LKC_GAS_HANDOFF_AUDIENCE:'123456789-synthetic.apps.googleusercontent.com',EXECUTIVE_APPROVER_EMAILS:'owner@example.invalid',LKC_GAS_SYNC_OWNER_UID:'synthetic_owner',LKC_GAS_SYNC_MAILBOX:'owner@example.invalid',LKC_GAS_SYNC_PRINCIPAL_REVISION:'synthetic-reader-r1'});
const SYNTHETIC_AUTHORIZATION='Bearer '+Buffer.from(JSON.stringify({alg:'RS256',kid:'synthetic_fixture_key',typ:'JWT'})).toString('base64url')+'.e30.synthetic_signature';
const rpc=(action='READINESS_ONLY')=>({method:'POST',headers:{authorization:SYNTHETIC_AUTHORIZATION,'content-type':'application/json'},rawHeaders:['Authorization',SYNTHETIC_AUTHORIZATION],body:{protocol:'LK_CREW_SYNC_RPC_PROPOSAL_V1',requestId:'synthetic_request',operationKey:'',sequence:0,action,payload:{}}});
function realRuntime(env){
 const count={factory:0,identity:0,provider:0,mail:0,sheets:0,writes:0,configReads:0},now=Date.now(),sec=Math.floor(now/1000);
 const claims={iss:'https://accounts.google.com',aud:env.LKC_GAS_HANDOFF_AUDIENCE,sub:'100000000000000001',email:'owner@example.invalid',email_verified:true,iat:sec-5,exp:sec+1800,auth_time:sec-10};
 const user={uid:'synthetic_owner',email:claims.email,emailVerified:true,disabled:false,providerData:[{providerId:'google.com',uid:claims.sub}],customClaims:{role:'admin',companyId:'synthetic_company'},tenantId:null,mfaState:'NONE',validSinceMs:(sec-30)*1000,observedAt:now};
 const config={companyId:env.DEFAULT_COMPANY_ID,projectId:env.EXPECTED_FIREBASE_PROJECT_ID,actualProjectId:env.GCLOUD_PROJECT,audience:env.LKC_GAS_HANDOFF_AUDIENCE,executiveEmails:env.EXECUTIVE_APPROVER_EMAILS.split(','),allowOriginalReadback:false};
 const forbidden=()=>{count.writes++;throw Error('UNEXPECTED_RESOURCE_MUTATION');};
 const records=new Map(),database={collection:name=>({doc:id=>({id,path:name+'/'+id,get:async()=>{count.configReads++;if(records.has(name+'/'+id))return {exists:true,data:()=>records.get(name+'/'+id)};if(name==='sheetImportConfigs')return {data:()=>({spreadsheetId:'SYNTHETIC_BOOK'})};if(name==='caseMailReceiverConfigs')return {data:()=>({companyId:'synthetic_company',mailbox:'owner@example.invalid',principalRevision:'synthetic-reader-r1'})};return {exists:false,data:()=>undefined};}})}),runTransaction:async(fn,options)=>{assert.equal(options?.readOnly,true);return fn({get:ref=>ref.get(),set:forbidden,update:forbidden,delete:forbidden});}};
 // This fixture represents an already-approved record. Actual Firebase verifier
 // issuance, record CAS and mutation negatives are tested in the owner suites.
 const Owner=require(path.join(src,'case-list-owner-authorization.cjs')),body={schema:'LK_CREW_OWNER_SEND_VIEW_V1',actorUid:user.uid,companyId:user.customClaims.companyId,cases:[],mail:{fullReview:{selection:[],version:'a'.repeat(64)},gasGroupsJson:[]}},saved={body,displayHash:Owner.hash(body),state:'RESULT_OBSERVED'};
 const reference={reviewId:'b'.repeat(48),displayHash:saved.displayHash},actor=Owner.markFirebaseOwnerVerified({uid:user.uid,companyId:user.customClaims.companyId,role:'admin',email:user.email,email_verified:true,authorityObservedAt:now,identityExpiresAt:now+100000,principalStateHash:Owner.principalStateHash(user)});
 saved.result={status:'OWNER_APPROVED_FOR_GAS',ownerAuthorization:Owner.issueOwnerAuthorization({actor,...reference,bindingHash:Owner.reviewBindingHash(saved),viewCreatedAt:now,now})};records.set('lkcSyntheticReviewViewsV1/'+reference.reviewId,saved);
 const identity={now:()=>Date.now(),verifyGoogleIdentity:async()=>{count.identity++;return claims;},readFirebaseUserByGoogleSubject:async()=>{count.provider++;return {...user,observedAt:Date.now()};}};
 const runtime=load('case-list-gas-sync-runtime',{
  './firebase':{db:database},'./case-list-gas-handoff':{gasHandoffSettings:()=>config,createGasIdentityRuntimePorts:()=>identity},
  './case-list-monthly-reader':{readCaseListMonthlySnapshot:()=>{count.sheets++;throw Error('SHEETS_FORBIDDEN');}},'./case-list-source-core':{hashCaseList:require(path.join(src,'case-list-gas-handoff-core.cjs')).hash},
  './case-id':{createJobIdFromPersistedCaseId:()=>{throw Error('NO_BUSINESS_RECORD_EXPECTED');}},'./case-list-monthly-worker':{},'./system-safety':{getProductionOperationalState:async()=>({operational:true})},
  './case-list-gas-crew-ports':{createCrewSyncPorts:()=>({})},'./case-list-gas-mail-access':{assertExistingMailReadAccess:async()=>{count.mail++;}},
 },env);
 const reads={now:()=>Date.now(),hash:require(path.join(src,'case-list-gas-handoff-core.cjs')).hash,readMonthly:()=>{count.sheets++;throw Error('SHEETS_FORBIDDEN');},readMailConfig:async()=>{count.mail++;return {companyId:'synthetic_company',mailbox:'owner@example.invalid',principalRevision:'synthetic-reader-r1'};},assertMailReaderReady:async()=>{count.mail++;},assertMailAccess:async()=>{count.mail++;},createMailAuth:()=>{throw Error('TOKEN_ACQUISITION_FORBIDDEN');},createGmailReader:()=>{throw Error('GMAIL_FORBIDDEN');}};
 return {claims,user,count,approvedRequest:()=>{const q=rpc('BEGIN');q.body.payload={formalReference:reference};return q;},factory:policy=>{count.factory++;return runtime.createSyncRuntimeHandler(policy,{identity,config,db:database,reads,operational:async()=>true});}};
}
const PILOT='LKCASE_00000000-0000-0000-0000-000000000001';
const OTHER='LKCASE_00000000-0000-0000-0000-000000000002';
function pilotRpc(){
 const env=settings(),identity=realRuntime(env),now=Date.now(),date='2026-11-30',revision='a'.repeat(64);
 const {createRpcService}=require(path.join(src,'case-list-gas-sync-rpc-core.cjs'));
 const {hash}=require(path.join(src,'case-list-gas-handoff-core.cjs'));
 const records=new Map(),calls={read:0,acquire:0,release:0,save:0,eligible:0,observe:0},port={};
 const journal={
  read:async key=>{calls.read++;return records.has(key)?clone(records.get(key)):null;},
  acquire:async(key,actor,owner,payload)=>{
   calls.acquire++;const created=!records.has(key);
   if(created)records.set(key,{payload:clone(payload)});
   const stored=records.get(key);if(port.onAcquire)port.onAcquire(stored);
   stored.lease={owner,expiresAt:now+30000};return {created,payload:clone(stored.payload)};
  },
  save:async(key,owner,payload)=>{calls.save++;assert.equal(records.get(key).lease.owner,owner);records.get(key).payload=clone(payload);},
  release:async(key,owner)=>{calls.release++;assert.equal(records.get(key).lease.owner,owner);delete records.get(key).lease;}
 };
 const config={companyId:env.DEFAULT_COMPANY_ID,projectId:env.EXPECTED_FIREBASE_PROJECT_ID,actualProjectId:env.GCLOUD_PROJECT,audience:env.LKC_GAS_HANDOFF_AUDIENCE,executiveEmails:[env.LKC_GAS_SYNC_MAILBOX]};
 const eligible=caseId=>({caseId,queueId:'queue_'+caseId,companyId:config.companyId,dateKey:date,staffName:'synthetic_staff',client:'synthetic_client',store:'synthetic_store',a1Verified:true});
 const service=createRpcService({isolatedProposal:true,pilotCaseId:PILOT,auth:{config,now:()=>now,verifyGoogleIdentity:async()=>identity.claims,readFirebaseUserByGoogleSubject:async()=>({...identity.user,observedAt:now})},now:()=>now,journal,book:'synthetic_book',operational:async()=>true,
  readEligible:async selection=>{calls.eligible++;return selection.map(item=>eligible(item.id));},groupDigest:hash,
  currentBoundary:async()=>true,observeAccepted:async item=>{calls.observe++;return {status:'EXTERNAL_ALREADY_ACCEPTED',queueId:item.queueId};}
 });
 const body=(action,payload={},key='',sequence=0)=>({...rpc(action).body,payload,operationKey:key,sequence});
 const begin=(selected=[PILOT],prepared=selected,grouped=selected)=>{
  const group={cases:grouped.map(id=>({id}))};
  return body('BEGIN',{review:{confirmedSend:true,version:revision,selection:selected.map(id=>({id,date,version:revision}))},
   prepared:{schema:'LK_NAMEUP_TRANSFER_V1',book:'synthetic_book',actor:env.LKC_GAS_SYNC_MAILBOX,preparedAt:new Date(now-1000).toISOString(),
    cases:prepared.map(id=>({id,date,staff:'synthetic_staff',client:'synthetic_client',store:'synthetic_store',expected:revision,nameUpDigest:hash(group)}))},groups:[group]},'',1);
 };
 const invoke=request=>service.handle(SYNTHETIC_AUTHORIZATION,request);
 const accept=async()=>{const result=await invoke(begin());assert.equal(result.status,'OK',JSON.stringify(result));return result.operationKey;};
 return {records,calls,port,body,begin,invoke,accept};
}
(async()=>{
 await test('configured case ID reaches the runtime in both permitted entry modes',async()=>{
  for(const mode of ['business','read-only']){const env={...settings(),LKC_GAS_SYNC_MODE:mode,LKC_GAS_SYNC_PILOT_CASE_ID:PILOT},r=response();
   await entry().createConfiguredCaseListGasSync(env,policy=>{assert.equal(policy.pilotCaseId,PILOT);return async(_req,res)=>res.status(200).json({status:'SYNTHETIC_PORT'});})(rpc(),r.res);assert.equal(r.state.status,200);}
 });
 await test('invalid configured case ID stays closed before runtime',async()=>{
  for(const id of ['','other-project',' '+PILOT,PILOT+'\n']){const env={...settings(),LKC_GAS_SYNC_PILOT_CASE_ID:id},r=response();let calls=0;
   await entry().createConfiguredCaseListGasSync(env,()=>{calls++;throw Error('UNEXPECTED_RUNTIME');})(rpc(),r.res);
   assert.equal(calls,0);assert.equal(r.state.body.code,'SYNC_ENTRY_PILOT_CASE_INVALID');}
 });
 await test('pilot refuses other and mixed cases before checking the request in the journal or business ports',async()=>{
  for(const lists of [[[OTHER]],[[PILOT,OTHER]],[[PILOT],[OTHER]],[[PILOT],[PILOT],[OTHER]],[[PILOT],[PILOT],[PILOT,OTHER]]]){
   const f=pilotRpc();await assert.rejects(()=>f.invoke(f.begin(...lists)),{code:'RPC_PILOT_CASE_SCOPE_MISMATCH'});
   assert.deepEqual(Object.values(f.calls),[0,0,0,0,0,0]);
  }
 });
 await test('fixed-case policy is enforced by the composed runtime with verified owner context',async()=>{
  const env={...settings(),LKC_GAS_SYNC_PILOT_CASE_ID:PILOT},world=realRuntime(env),r=response();
  const request=world.approvedRequest();request.body={...pilotRpc().begin([OTHER]),payload:{...pilotRpc().begin([OTHER]).payload,formalReference:request.body.payload.formalReference}};
  await entry().createConfiguredCaseListGasSync(env,world.factory)(request,r.res);
  assert.equal(r.state.body.code,'RPC_PILOT_CASE_SCOPE_MISMATCH');assert.equal(world.count.sheets+world.count.writes,0);
 });
 await test('pilot accepts the fixed case and observes it with the original operation key',async()=>{
  const f=pilotRpc(),key=await f.accept();
  const out=await f.invoke(f.body('OBSERVE',{},key));
  assert.equal(out.status,'OBSERVED');assert.equal(out.operationKey,key);assert.deepEqual(out.items.map(item=>item.caseId),[PILOT]);
 });
 await test('pilot refuses wrong or mixed follow-up requests without advancing the saved operation',async()=>{
  const f=pilotRpc(),key=await f.accept(),before=clone(f.records.get(key)),counts=clone(f.calls);
  for(const [action,payload] of [['BOUNDARY',{caseIds:[PILOT,OTHER]}],['SEND_BOUNDARY',{caseIds:[OTHER]}],
   ['SENT_RETURNED',{ids:[PILOT],receipts:[{caseId:OTHER}]}],['PROTECT',{ids:[OTHER]}],
   ['TRANSFER_DISPATCH',{caseId:PILOT,reprepared:{cases:[{id:OTHER}]}}],['TRANSFER_BOUNDARY',{caseId:OTHER}],['RECONCILE',{caseId:OTHER}]]){
   await assert.rejects(()=>f.invoke(f.body(action,payload,key,2)),{code:'RPC_PILOT_CASE_SCOPE_MISMATCH'});
  }
  assert.deepEqual(f.records.get(key),before);assert.deepEqual(f.calls,counts);
 });
 await test('pilot refuses observation and recovery of a stored operation with another case or binding',async()=>{
  for(const edit of [operation=>{operation.items[0].caseId=OTHER;},operation=>{operation.items[0].binding={caseId:OTHER};},operation=>{operation.nameUpReturnedSentIds=[PILOT,OTHER];}]){
   const f=pilotRpc(),key=await f.accept();edit(f.records.get(key).payload);const counts=clone(f.calls);
   await assert.rejects(()=>f.invoke(f.body('OBSERVE',{},key)),{code:'RPC_PILOT_CASE_SCOPE_MISMATCH'});
   await assert.rejects(()=>f.invoke(f.body('RESUME_READY',{},key,2)),{code:'RPC_PILOT_CASE_SCOPE_MISMATCH'});
   assert.equal(f.calls.acquire,counts.acquire);assert.equal(f.calls.save,counts.save);assert.equal(f.calls.observe,counts.observe);
  }
 });
 await test('pilot rejects scope replacement during lease acquisition and releases its lease',async()=>{
  const f=pilotRpc(),key=await f.accept(),counts=clone(f.calls);
  f.port.onAcquire=stored=>{stored.payload.items[0].caseId=OTHER;};
  await assert.rejects(()=>f.invoke(f.body('RESUME_READY',{},key,2)),{code:'RPC_PILOT_CASE_SCOPE_MISMATCH'});
  assert.equal(f.calls.acquire,counts.acquire+1);assert.equal(f.calls.release,counts.release+1);
  assert.equal(f.calls.save,counts.save);assert(!f.records.get(key).lease);
 });
  await test('index registers the reviewed dedicated entry and exact staging deployment guard',async()=>{assert.match(fs.readFileSync(path.join(src,'index.ts'),'utf8'),/export \{ caseListGasSync \} from "\.\/case-list-gas-sync-entry"/);const c=JSON.parse(fs.readFileSync(path.join(repo,'config/automation/staging-safety.json')));assert.equal(c.projectId,'lip-knots-crew-staging');assert.equal(c.region,'asia-northeast1');assert.equal(c.allowedFunctions.filter(x=>x==='caseListGasSync').length,1);const {pathToFileURL}=require('node:url'),{assertSyncPlan}=await import(pathToFileURL(path.join(repo,'scripts/automation/staging-gas-sync-readiness.mjs')).href);const good={mode:'functions-deploy',project:c.projectId,region:c.region,sourceRef:'main',functions:['caseListGasSync']};assertSyncPlan(good);for(const changed of [{project:'other-project'},{region:'us-central1'},{functions:['caseListGasSync','otherFunction']},{sourceRef:'other-branch'}])assert.throws(()=>assertSyncPlan({...good,...changed}),/GAS_SYNC_EXACT_MAIN_PRIVATE_SCOPE_REQUIRED/);});
 await test('default is OFF and private with no runtime/client construction',async()=>{const m=entry(),r=response();assert.equal(m.caseListGasSync.options.invoker,'private');await m.caseListGasSync.handler(rpc(),r.res);assert.equal(r.state.body.code,'SYNC_ENTRY_DISABLED');});
 for(const value of ['invalid','true','BUSINESS'])await test('unsupported mode stays closed '+value,async()=>{let calls=0;const env={LKC_GAS_SYNC_MODE:value},r=response();await entry().createConfiguredCaseListGasSync(env,()=>{calls++;throw Error('NO_RUNTIME');})(rpc(),r.res);assert.equal(calls,0);assert.equal(r.state.body.code,'SYNC_ENTRY_MODE_INVALID');});
 for(const action of ['FORMAL_PREVIEW','FORMAL_CONFIRM','BEGIN','PROTECT','TRANSFER_DISPATCH','RECONCILE','RESUME_READY'])await test('read-only rejects mutation action '+action,async()=>{let calls=0;const r=response();await entry().createConfiguredCaseListGasSync({LKC_GAS_SYNC_MODE:'read-only'},()=>{calls++;throw Error('NO_RUNTIME');})(rpc(action),r.res);assert.equal(calls,0);assert.equal(r.state.status,403);});
 await test('explicit invocation setting does not grant business authority',async()=>{const m=entry({LKC_GAS_SYNC_PUBLIC_INVOKER:'true'}),r=response();assert.equal(m.caseListGasSync.options.invoker,'public');await m.caseListGasSync.handler(rpc('BEGIN'),r.res);assert.equal(r.state.body.code,'SYNC_ENTRY_DISABLED');});
 for(const key of ['DEFAULT_COMPANY_ID','LKC_GAS_SYNC_OWNER_UID','LKC_GAS_SYNC_MAILBOX','LKC_GAS_SYNC_PRINCIPAL_REVISION'])await test('business missing setting stops before runtime '+key,async()=>{const env=settings();delete env[key];let calls=0;const r=response();await entry().createConfiguredCaseListGasSync(env,()=>{calls++;throw Error('NO_RUNTIME');})(rpc('BEGIN'),r.res);assert.equal(calls,0);assert.equal(r.state.body.code,'SYNC_ENTRY_POLICY_REQUIRED');});
 await test('exact explicit policy enters the existing handler without inventing identity',async()=>{const env=settings(),r=response();let seen;await entry().createConfiguredCaseListGasSync(env,(policy,observedEnv)=>{seen=clone(policy);assert.equal(observedEnv,env);return async(_req,res)=>res.status(200).json({status:'SYNTHETIC_PORT'});})(rpc('BEGIN'),r.res);assert.deepEqual(seen,{enabled:true,sentReadPolicy:{enabled:true,companyId:'synthetic_company',ownerUid:'synthetic_owner',mailbox:'owner@example.invalid',principalRevision:'synthetic-reader-r1'}});});
 await test('OFF after a prior request stops new entry construction',async()=>{const env=settings();let count=0;const h=entry().createConfiguredCaseListGasSync(env,()=>{count++;return async(_req,res)=>res.status(200).json({});});await h(rpc(),response().res);env.LKC_GAS_SYNC_MODE='off';const r=response();await h(rpc(),r.res);assert.equal(count,1);assert.equal(r.state.body.code,'SYNC_ENTRY_DISABLED');});
 await test('unexpected construction failures expose only a fixed HOLD',async()=>{const r=response();await entry().createConfiguredCaseListGasSync(settings(),()=>{throw Error('SYNTHETIC_PRIVATE_DETAIL');})(rpc(),r.res);assert.equal(r.state.body.code,'SYNC_ENTRY_UNAVAILABLE');assert(!JSON.stringify(r.state).includes('PRIVATE_DETAIL'));});
 await test('real runtime READINESS authenticates with zero mail/sheet/storage mutations',async()=>{const env={...settings(),LKC_GAS_SYNC_MODE:'read-only'},world=realRuntime(env),r=response();await entry().createConfiguredCaseListGasSync(env,world.factory)(rpc(),r.res);assert.equal(r.state.status,200,JSON.stringify(r.state.body));assert.equal(r.state.body.status,'READINESS_ONLY');assert.deepEqual(r.state.body.effects,{mail:0,sheets:0,storage:0});assert(world.count.identity>0&&world.count.provider>0);assert.equal(world.count.mail,0);assert.equal(world.count.sheets,0);assert.equal(world.count.writes,0);});
 for(const [name,change]of [['missing auth_time',w=>{delete w.claims.auth_time;}],['wrong audience',w=>{w.claims.aud='other-synthetic.apps.googleusercontent.com';}],['disabled',w=>{w.user.disabled=true;}],['wrong company',w=>{w.user.customClaims.companyId='other_synthetic';}],['no owner role',w=>{w.user.customClaims.role='staff';}],['MFA unknown',w=>{w.user.mfaState='UNKNOWN';}],['revoked',w=>{w.user.validSinceMs=Date.now()+10000;}],['provider changed',w=>{w.user.providerData[0].uid='100000000000000099';}]])await test('real runtime identity rejects '+name,async()=>{const env={...settings(),LKC_GAS_SYNC_MODE:'read-only'},w=realRuntime(env);change(w);const r=response();await entry().createConfiguredCaseListGasSync(env,w.factory)(rpc(),r.res);assert.equal(r.state.body.status,'HOLD');const expected={'missing auth_time':'HANDOFF_AUTH_TIME_REQUIRED','wrong audience':'HANDOFF_GOOGLE_IDENTITY_INVALID','disabled':'HANDOFF_ACCOUNT_DISABLED_OR_INVALID','wrong company':'HANDOFF_EXECUTIVE_REQUIRED','no owner role':'HANDOFF_EXECUTIVE_REQUIRED','MFA unknown':'HANDOFF_MFA_UNSUPPORTED','revoked':'HANDOFF_IDENTITY_REVOKED','provider changed':'HANDOFF_FIREBASE_LINK_REQUIRED'};assert.equal(r.state.body.code,expected[name]);assert.equal(w.count.mail+w.count.sheets+w.count.writes,0);});
 for(const [key,value,code]of [['LKC_GAS_SYNC_OWNER_UID','other_synthetic_owner','SENT_READ_POLICY_REQUIRED'],['LKC_GAS_SYNC_MAILBOX','other@example.invalid','SENT_READ_POLICY_REQUIRED'],['LKC_GAS_SYNC_PRINCIPAL_REVISION','synthetic-reader-r2','SENT_READ_PRINCIPAL_CHANGED']])await test('real runtime rejects mismatched configured policy '+key,async()=>{const env=settings();env[key]=value;const w=realRuntime(env),r=response();await entry().createConfiguredCaseListGasSync(env,w.factory)(w.approvedRequest(),r.res);assert.equal(r.state.body.code,code);assert.equal(w.count.sheets+w.count.writes,0);});
 await test('business request without Firebase approval stays closed before resource access',async()=>{const env=settings(),w=realRuntime(env),r=response();await entry().createConfiguredCaseListGasSync(env,w.factory)(rpc('BEGIN'),r.res);assert.equal(r.state.body.code,'OWNER_APPROVAL_REQUIRED');assert.equal(w.count.mail+w.count.sheets+w.count.writes,0);});
 await test('compiled entry resolves its two existing lazy runtime modules',()=>{const file=path.join(repo,'functions/lib/case-list-gas-sync-entry.js');assert(fs.existsSync(file),'build first');const req=createRequire(file);for(const name of ['./case-list-gas-sync-runtime','./case-list-gas-handoff'])assert(req.resolve(name).startsWith(path.join(repo,'functions/lib')));});
 const report={passed:results.filter(x=>x.passed).length,total:results.length,results,actualEntryAndRuntime:true,signatureVerification:'mock identity-verifier port; unchanged cryptographic verifier covered by existing handoff suite',network:false,deployed:false,settingsOrIAMChanged:false};console.log(JSON.stringify(report,null,2));if(report.passed!==report.total)process.exitCode=1;
})();
