'use strict';
// Synthetic keys/JWTs are generated in RAM, never persisted or logged. No Google/Firebase/network calls.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createRequire,stripTypeScriptTypes}=require('node:module');
const repo=path.resolve(__dirname,'..'),serverRequire=createRequire(path.join(process.env.LKC_TEST_SERVER_DEPENDENCY_ROOT||repo,'package.json'));
const {google}=serverRequire('googleapis'),OAuth2Client=google.auth.OAuth2;
const {createHandoff,hash,PROTOCOL}=require('../functions/src/case-list-gas-handoff-core.cjs');
const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),other=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const publicPem=pair.publicKey.export({type:'spki',format:'pem'}),AUD='123456789-synthetic.apps.googleusercontent.com',ISS='https://accounts.google.com';
const SUB='100000000000000001',NOW=Date.now(),SECOND=Math.floor(NOW/1000),results=[];
const copy=x=>JSON.parse(JSON.stringify(x));
function jwt(changes={},key=pair.privateKey,header={alg:'RS256',kid:'synthetic_public_key',typ:'JWT'}){
 const payload={iss:ISS,aud:AUD,sub:SUB,email:'owner@example.invalid',email_verified:true,iat:SECOND-10,exp:SECOND+1800,auth_time:SECOND-30,...changes};
 const data=Buffer.from(JSON.stringify(header)).toString('base64url')+'.'+Buffer.from(JSON.stringify(payload)).toString('base64url');
 return data+'.'+crypto.sign('RSA-SHA256',Buffer.from(data),key).toString('base64url');
}
const verifier=new OAuth2Client();
async function verified(token,audience){const ticket=await verifier.verifySignedJwtWithCertsAsync(token,{synthetic_public_key:publicPem},audience,[ISS],3600);return ticket.getPayload();}
function fixture(){
 let now=NOW,user={uid:'owner_synthetic',email:'owner@example.invalid',emailVerified:true,disabled:false,providerData:[{providerId:'google.com',uid:SUB}],customClaims:{role:'admin',companyId:'company_synthetic'},tenantId:null,mfaState:'NONE',validSinceMs:(SECOND-31)*1000,observedAt:NOW};
 const binding={queueId:'queue_synthetic',companyId:'company_synthetic',jobId:'job_synthetic',caseId:'LKCASE_00000000-0000-0000-0000-000000000001',staffId:'staff_synthetic',dateKey:'2026-11-30',sourceRevision:'a'.repeat(64),selectionHash:'b'.repeat(64),selectedBy:'owner_synthetic',selectedAt:NOW-500,gas:{nameUpExpected:'c'.repeat(64)}};
 let snap={binding,continuation:recordFor(binding)},operational=true;
 const calls={verify:0,user:0,original:0,sent:0,mailSends:0,sourceWrites:0,monthlyWrites:0,firestoreWrites:0};
 const config={projectId:'lip-knots-crew-staging',actualProjectId:'lip-knots-crew-staging',companyId:'company_synthetic',audience:AUD,executiveEmails:['owner@example.invalid'],allowOriginalReadback:true};
 const ports={now:()=>now,verifyGoogleIdentity:async(t,a)=>{calls.verify++;return verified(t,a);},readFirebaseUserByGoogleSubject:async s=>{calls.user++;assert.equal(s,SUB);return copy(user);},operational:async()=>operational,readOriginalGateSnapshot:async()=>{calls.original++;return copy(snap);},verifySentEvidence:async r=>{calls.sent++;return {verified:true,messageId:r.messageId,groupDigest:r.groupDigest};}};
 return {config,ports,calls,get user(){return user;},set user(x){user=x;},get snap(){return snap;},set snap(x){snap=x;},setNow:x=>{now=x;user.observedAt=x;},stop:()=>operational=false};
}
function recordFor(b){
 const x={schema:'LK_GAS_CREW_HANDOFF_GATE_V1',queueId:b.queueId,companyId:b.companyId,jobId:b.jobId,caseId:b.caseId,staffId:b.staffId,dateKey:b.dateKey,sourceRevision:b.sourceRevision,selectionHash:b.selectionHash,actorUid:b.selectedBy,nameUpExpected:b.gas.nameUpExpected,groupDigest:'d'.repeat(64),messageId:'synthetic_sent_1',firstPreparedAt:b.selectedAt-500,deadlineAt:b.selectedAt+179500,phase:'SENT_VERIFIED',sentVerifiedAt:b.selectedAt};
 return {...x,hash:hash(x)};
}
function rehash(record){delete record.hash;record.hash=hash(record);}
const ready=()=>({protocol:PROTOCOL,action:'READINESS_ONLY',requestId:'synthetic_readiness'});
const check=b=>({protocol:PROTOCOL,action:'CHECK_ORIGINAL',requestId:'synthetic_check',queueId:b.queueId,caseId:b.caseId,selectionHash:b.selectionHash,nameUpExpected:b.gas.nameUpExpected});
async function invoke(f,body=ready(),token=jwt()){return createHandoff({...f.ports,config:f.config}).handle('Bearer '+token,body);}
async function holds(f,code,body=ready(),token=jwt()){await assert.rejects(()=>invoke(f,body,token),error=>error.code===code);assert.equal(f.calls.mailSends+f.calls.sourceWrites+f.calls.monthlyWrites+f.calls.firestoreWrites,0);}
async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,errorCode:error.code==='ERR_ASSERTION'?'ASSERTION_FAILED':String(error.code||'TEST_FAILED')});}}
function observedMfaFor(user){
 return {status:200,data:{users:[{localId:user.uid,email:user.email,emailVerified:user.emailVerified,disabled:user.disabled,
  providerUserInfo:user.providerData.map(p=>({providerId:p.providerId,rawId:p.uid})),customAttributes:JSON.stringify(user.customClaims),
  validSince:String(Date.parse(user.tokensValidAfterTime)/1000),mfaInfo:[]}]}};
}
function loadMfaRuntime(){
 const ts=serverRequire('typescript'),source=fs.readFileSync(path.join(repo,'functions/src/case-list-mfa-observation.ts'),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};vm.runInNewContext(js,{module,exports:module.exports,Date,require:()=>assert.fail('Unexpected MFA helper dependency')});return module.exports;
}
const mfaRuntime=loadMfaRuntime();
function loadAdapter(rawUser,options={}){
 const file=path.join(repo,'functions/src/case-list-gas-handoff.ts'),source=fs.readFileSync(file,'utf8'),names=[...source.matchAll(/^export function (\w+)/gm)].map(m=>m[1]);
 let js=stripTypeScriptTypes(source,{mode:'transform'}).replace(/^import \{([^}]+)\} from "([^"]+)";$/gm,(_,keys,name)=>'const {'+keys+'}=require('+JSON.stringify(name)+');').replace(/^export /gm,'');
 js+='\nmodule.exports={'+names.join(',')+'};';
 const logs=[],module={exports:{}},testGoogle={...google,auth:{...google.auth,OAuth2:class extends OAuth2Client{async verifyIdToken({idToken,audience}){return this.verifySignedJwtWithCertsAsync(idToken,{synthetic_public_key:publicPem},audience,[ISS],3600);}},GoogleAuth:class{async request(input){assert.equal(input.url,"https://identitytoolkit.googleapis.com/v1/projects/lip-knots-crew-staging/accounts:lookup");assert.equal(input.params.fields,mfaRuntime.MFA_LOOKUP_FIELDS);if(!options.mfaObservation)throw Error("SYNTHETIC_MFA_OBSERVATION_UNAVAILABLE");return copy(options.mfaObservation);}}}};
 const context={Buffer,Date:options.Date||Date,process:{env:{}},console:{log:()=>assert.fail('Logging forbidden'),error:()=>assert.fail('Logging forbidden')},module,require:name=>{
  if(name==='googleapis')return {google:testGoogle};
  if(name==='./case-list-mfa-observation')return mfaRuntime;
  if(name==='./firebase')return {auth:{getUserByProviderUid:async(provider,subject)=>{assert.equal(provider,'google.com');assert.equal(subject,SUB);const response=copy(rawUser);options.afterLookup?.();return response;}},db:{collection:()=>assert.fail('Readiness must not read Firestore')}};
  if(name==='./system-safety')return {getProductionOperationalState:async()=>({operational:true})};
  if(name==='./case-list-external-transfer')return {readExternalCaseListHandoffGateSnapshot:()=>assert.fail('Unexpected original read')};
  if(name.endsWith('case-list-gas-handoff-core.cjs'))return require('../functions/src/case-list-gas-handoff-core.cjs');
  throw Error('UNEXPECTED_TEST_IMPORT');
 }};
 vm.runInNewContext(js,context,{filename:'actual-unregistered-handoff-handler'});
 return module.exports;
}
async function http(handler,body=ready(),options={}){
 const state={headers:{},status:0,body:null},response={set:(k,v)=>{state.headers[k]=v;},status:c=>{state.status=c;return response;},json:x=>{state.body=copy(x);}};
 const token=jwt(),request={method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},rawHeaders:['Content-Type','application/json','Authorization','Bearer '+token],body,...options};
 await handler(request,response);assert(!JSON.stringify(state).includes(token));return state;
}
function productFixture(){
 const file=path.join(repo,'scripts/test-crew-external-receipt.cjs'),req=createRequire(file);let s=fs.readFileSync(file,'utf8');s=s.slice(0,s.indexOf('(async()=>{'));
 s=s.replace('assert.deepEqual(original.position,','assert.deepEqual(JSON.parse(JSON.stringify(original.position)),');
 s+='\nmodule.exports={start,resetFixture,importer,load,owner,OWNER,CASE,COMPANY,Clock,db,literal,jobs,pendingSubmissionBackend,jobId:()=>jobId,onAfterCommit:fn=>{afterCommit=fn;},tables:()=>sheetsData,documents:()=>documents,setClock:x=>{clockOffset=x;},state:()=>({writes,nativeCalls,job:copy(documents.get("jobs/"+jobId)),queueCount:[...documents.keys()].filter(k=>k.startsWith("sheetSyncQueue/")).length})};';
 const module={exports:{}};vm.runInNewContext(s,{__dirname:path.dirname(file),require:req,module,Buffer,console,process,setTimeout,clearTimeout},{filename:'actual-existing-product-handlers'});return module.exports;
}
(async()=>{
 await test('signed Google fixture uses real SDK verifier; readiness has zero business effects',async()=>{const f=fixture(),r=await invoke(f);assert.equal(r.status,'AUTH_LINK_CHECKED');assert.equal(r.businessEnabled,false);assert.equal(r.diagnosticOnly,true);assert.equal(r.firebaseJwtEquivalent,false);assert.equal(f.calls.original,0);assert.equal(f.calls.sent,0);});
 for(const [name,mutate,code] of [
  ['missing fixed audience',f=>f.config.audience=undefined,'HANDOFF_AUDIENCE_REQUIRED'],
  ['wildcard audience',f=>f.config.audience='*.apps.googleusercontent.com','HANDOFF_AUDIENCE_REQUIRED'],
  ['wrong Cloud project',f=>f.config.actualProjectId='production_synthetic','HANDOFF_PROJECT_REQUIRED'],
  ['missing company config',f=>f.config.companyId=undefined,'HANDOFF_COMPANY_REQUIRED'],
  ['empty executive allowlist',f=>f.config.executiveEmails=[],'HANDOFF_EXECUTIVE_CONFIG_REQUIRED']
 ])await test(name+' closes before verifier/account lookup',async()=>{const f=fixture();mutate(f);await holds(f,code);assert.equal(f.calls.verify,0);assert.equal(f.calls.user,0);});
 for(const [name,changes]of [['wrong issuer',{iss:'https://issuer.example.invalid'}],['wrong audience',{aud:'123456789-other.apps.googleusercontent.com'}],['expired token',{iat:SECOND-3600,exp:SECOND-1}],['future issued token',{iat:SECOND+60,exp:SECOND+3600}],['missing user auth time',{auth_time:undefined}],['unverified Google email',{email_verified:false}],['invalid subject',{sub:'not_a_google_subject'}]]){
  await test(name+' rejected with no original/send port',async()=>{const f=fixture();await assert.rejects(()=>invoke(f,ready(),jwt(changes)));assert.equal(f.calls.original,0);assert.equal(f.calls.sent,0);});
 }
 await test('wrong RSA signature is rejected by actual verifier',async()=>{const f=fixture();await holds(f,'HANDOFF_TOKEN_INVALID',ready(),jwt({},other.privateKey));assert.equal(f.calls.user,0);});
 await test('unsigned/algorithm-confused header rejected before verifier',async()=>{const f=fixture();await holds(f,'HANDOFF_TOKEN_INVALID',ready(),jwt({},pair.privateKey,{alg:'HS256',kid:'synthetic_public_key'}));assert.equal(f.calls.verify,0);});
 for(const [name,change,code] of [
  ['missing existing Firebase user',f=>f.user=null,'HANDOFF_FIREBASE_LINK_REQUIRED'],
  ['unlinked Google provider',f=>f.user.providerData=[],'HANDOFF_FIREBASE_LINK_REQUIRED'],
  ['wrong Google provider UID',f=>f.user.providerData[0].uid='200000000000000001','HANDOFF_FIREBASE_LINK_REQUIRED'],
  ['disabled Firebase account',f=>f.user.disabled=true,'HANDOFF_ACCOUNT_DISABLED_OR_INVALID'],
  ['unverified Firebase email',f=>f.user.emailVerified=false,'HANDOFF_ACCOUNT_DISABLED_OR_INVALID'],
  ['different verified emails',f=>f.user.email='other@example.invalid','HANDOFF_ACCOUNT_DISABLED_OR_INVALID'],
  ['staff role',f=>f.user.customClaims.role='staff','HANDOFF_EXECUTIVE_REQUIRED'],
  ['other company',f=>f.user.customClaims.companyId='other_company','HANDOFF_EXECUTIVE_REQUIRED'],
  ['nonexecutive admin',f=>f.config.executiveEmails=['other@example.invalid'],'HANDOFF_EXECUTIVE_REQUIRED'],
  ['MFA enrolled',f=>f.user.mfaState='ENROLLED','HANDOFF_MFA_UNSUPPORTED'],
  ['MFA unknown',f=>delete f.user.mfaState,'HANDOFF_MFA_UNSUPPORTED'],
  ['tenant-specific user',f=>f.user.tenantId='tenant_synthetic','HANDOFF_TENANT_UNSUPPORTED'],
  ['tenant unknown',f=>delete f.user.tenantId,'HANDOFF_TENANT_UNSUPPORTED'],
  ['revocation cutoff missing',f=>delete f.user.validSinceMs,'HANDOFF_REVOCATION_UNVERIFIED'],
  ['revoked authentication',f=>f.user.validSinceMs=SECOND*1000,'HANDOFF_IDENTITY_REVOKED'],
  ['stale authority observation',f=>f.user.observedAt=NOW-30001,'HANDOFF_REVOCATION_UNVERIFIED'],
  ['future authority observation',f=>f.user.observedAt=NOW+1,'HANDOFF_REVOCATION_UNVERIFIED']
 ])await test(name+' safely holds',async()=>{const f=fixture();change(f);await holds(f,code);assert.equal(f.calls.original,0);});
 await test('user-not-found does not trigger creation/link/bootstrap fallback',async()=>{const f=fixture();f.ports.readFirebaseUserByGoogleSubject=async()=>{throw {code:'auth/user-not-found'};};await holds(f,'HANDOFF_FIREBASE_LINK_UNAVAILABLE');});
 for(const extra of [{uid:'owner_synthetic'},{role:'admin'},{companyId:'company_synthetic'},{sent:true},{audience:AUD},{action:'SEND_MAIL'}])await test('caller facts or arbitrary action rejected: '+Object.keys(extra)[0],async()=>{const f=fixture();await holds(f,'HANDOFF_INPUT_INVALID',{...ready(),...extra});assert.equal(f.calls.verify,0);});
 await test('same authenticated handler rereads current role after prior readiness success',async()=>{const f=fixture(),api=createHandoff({...f.ports,config:f.config}),token='Bearer '+jwt();await api.handle(token,ready());f.user.customClaims.role='staff';await assert.rejects(()=>api.handle(token,ready()),e=>e.code==='HANDOFF_EXECUTIVE_REQUIRED');assert.equal(f.calls.user,2);});
 await test('complete protected original+SENT check is diagnostic only',async()=>{const f=fixture(),r=await invoke(f,check(f.snap.binding));assert.equal(r.status,'ORIGINAL_AND_SENT_OBSERVED');assert.equal(r.businessEnabled,false);assert.equal(f.calls.original,2);assert.equal(f.calls.sent,1);});
 for(const [name,change,code]of [
  ['default closed gate',f=>f.config.allowOriginalReadback=false,'HANDOFF_GATE_DISABLED'],
  ['global operation stopped',f=>f.stop(),'HANDOFF_GLOBAL_STOPPED'],
  ['missing original receipt',f=>f.snap=null,'HANDOFF_ORIGINAL_CHANGED'],
  ['incomplete A2 binding',f=>f.snap.binding=null,'HANDOFF_ORIGINAL_CHANGED'],
  ['missing continuation',f=>f.snap.continuation=null,'HANDOFF_CONTINUATION_REQUIRED'],
  ['changed fixed ID',f=>f.snap.binding.caseId='LKCASE_00000000-0000-0000-0000-000000000002','HANDOFF_ORIGINAL_CHANGED'],
  ['another selected owner',f=>f.snap.binding.selectedBy='other_synthetic','HANDOFF_ORIGINAL_CHANGED'],
  ['unknown send response',f=>{f.snap.continuation.phase='SENDING';rehash(f.snap.continuation);},'HANDOFF_SENT_RESULT_PENDING'],
  ['expired original preparation',f=>{f.snap.continuation.firstPreparedAt=NOW-180001;f.snap.continuation.deadlineAt=NOW-1;rehash(f.snap.continuation);},'HANDOFF_PREPARATION_EXPIRED'],
  ['tampered continuation',f=>f.snap.continuation.groupDigest='e'.repeat(64),'HANDOFF_CONTINUATION_INVALID'],
  ['missing SENT reader',f=>delete f.ports.verifySentEvidence,'HANDOFF_SENT_READER_REQUIRED'],
  ['SENT readback mismatch',f=>f.ports.verifySentEvidence=async()=>({verified:true,messageId:'wrong_synthetic',groupDigest:'d'.repeat(64)}),'HANDOFF_SENT_READBACK_UNVERIFIED']
 ])await test(name+' cannot dispatch any business operation',async()=>{const f=fixture(),body=check(f.snap.binding);change(f);await holds(f,code,body);});
 await test('current authority changing during SENT read is rechecked',async()=>{const f=fixture();f.ports.verifySentEvidence=async r=>{f.user.disabled=true;return {verified:true,messageId:r.messageId,groupDigest:r.groupDigest};};await holds(f,'HANDOFF_ACCOUNT_DISABLED_OR_INVALID',check(f.snap.binding));});
 await test('cancellation/change between protected reads cannot pass',async()=>{const f=fixture();f.ports.readOriginalGateSnapshot=async()=>{f.calls.original++;if(f.calls.original>1)throw Error('SYNTHETIC_CANCELLED');return copy(f.snap);};await holds(f,'HANDOFF_ORIGINAL_UNAVAILABLE',check(f.snap.binding));});
 await test('expiry during SENT read keeps original deadline and does not refresh',async()=>{const f=fixture();f.ports.verifySentEvidence=async r=>{f.setNow(f.snap.continuation.deadlineAt);return {verified:true,messageId:r.messageId,groupDigest:r.groupDigest};};await holds(f,'HANDOFF_PREPARATION_EXPIRED',check(f.snap.binding));});
 await test('lost response can be read again without any new registration or resend',async()=>{const f=fixture(),body=check(f.snap.binding);await invoke(f,body);const again=await invoke(f,body);assert.equal(again.status,'ORIGINAL_AND_SENT_OBSERVED');assert.equal(f.calls.firestoreWrites+f.calls.mailSends,0);});
 const rawUser={multiFactor:{enrolledFactors:[]},uid:'owner_synthetic',email:'owner@example.invalid',emailVerified:true,disabled:false,customClaims:{role:'admin',companyId:'company_synthetic'},providerData:[{providerId:'google.com',uid:SUB}],tokensValidAfterTime:new Date((SECOND-31)*1000).toISOString()};
 const actual=loadAdapter(rawUser,{mfaObservation:observedMfaFor(rawUser)});
 await test('actual unregistered HTTP handler validates signed identity and current SDK UserRecord',async()=>{const f=fixture(),out=await http(actual.createGasHandoffHandler(f.config));assert.equal(out.status,200);assert.equal(out.body.status,'AUTH_LINK_CHECKED');assert.equal(out.headers['Cache-Control'],'no-store');assert.equal(out.body.businessEnabled,false);});
 await test('actual settings default does not enable original check',async()=>{const c=actual.gasHandoffSettings({EXPECTED_FIREBASE_PROJECT_ID:'lip-knots-crew-staging',GCLOUD_PROJECT:'lip-knots-crew-staging',DEFAULT_COMPANY_ID:'company_synthetic',EXECUTIVE_APPROVER_EMAILS:'owner@example.invalid',LKC_GAS_HANDOFF_AUDIENCE:AUD});assert.equal(c.allowOriginalReadback,false);});
 await test('actual handler missing audience returns fixed HOLD without token reflection',async()=>{const f=fixture();delete f.config.audience;const out=await http(actual.createGasHandoffHandler(f.config,f.ports));assert.equal(out.body.code,'HANDOFF_AUDIENCE_REQUIRED');assert.equal(f.calls.verify,0);});
 for(const [name,opts,status]of [['GET',{method:'GET'},405],['wrong content type',{headers:{'content-type':'text/plain'}},415],['duplicate authorization',{rawHeaders:['Authorization','a','Authorization','b']},401],['oversized body',{body:{protocol:PROTOCOL,action:'READINESS_ONLY',requestId:'x'.repeat(9000)}},400]])await test('actual HTTP '+name+' rejected before privileged ports',async()=>{const f=fixture(),out=await http(actual.createGasHandoffHandler(f.config,f.ports),ready(),opts);assert.equal(out.status,status);assert.equal(f.calls.verify,0);});
 await test('actual HTTP unexpected error is sanitized; no raw response, token or exception',async()=>{const f=fixture();f.ports.verifyGoogleIdentity=async()=>{throw Error('SYNTHETIC_SECRET_SENTINEL');};const out=await http(actual.createGasHandoffHandler(f.config,f.ports));assert.equal(out.body.code,'HANDOFF_TOKEN_INVALID');assert(!JSON.stringify(out).includes('SYNTHETIC_SECRET_SENTINEL'));});
 for(const manual of [false,true]){
  await test((manual?'manual':'application')+' real original handler snapshot is atomic read-only and missing continuation holds',async()=>{const e=productFixture(),s=await e.start(manual,true),f=fixture();f.user.uid=e.OWNER;f.config.companyId=e.COMPANY;f.user.customClaims.companyId=e.COMPANY;
   const before=e.state(),read=e.load('case-list-external-transfer').readExternalCaseListHandoffGateSnapshot;
   f.ports.readOriginalGateSnapshot=async(q,actor)=>read(e.db.collection('sheetSyncQueue').doc(q),actor.uid,actor);
   const snap=await f.ports.readOriginalGateSnapshot(s.queueId,{uid:e.OWNER,...e.owner.auth.token});assert.equal(snap.binding.queueId,s.queueId);assert.equal(snap.continuation,null);
   await holds(f,'HANDOFF_CONTINUATION_REQUIRED',check(snap.binding));assert.equal(e.state().writes,before.writes);assert.equal(e.state().queueCount,1);assert.equal(e.state().job.applicationUnconfirmed,true);
  });
 }
 await test('missing real original queue cannot be created by a read gate',async()=>{const e=productFixture(),f=fixture();f.ports.readOriginalGateSnapshot=async(q,actor)=>e.load('case-list-external-transfer').readExternalCaseListHandoffGateSnapshot(e.db.collection('sheetSyncQueue').doc(q),actor.uid,actor);await holds(f,'HANDOFF_ORIGINAL_UNAVAILABLE',check(f.snap.binding));assert.equal(e.state().queueCount,0);});

 await test('actual manual A1 commit with missing A2 cannot pass gate or submissions',async()=>{
  const e=productFixture();await assert.rejects(()=>e.start(true,true,()=>e.onAfterCommit(()=>{const op=[...e.documents().values()].find(x=>x.externalManualRequested===true);if(op&&!op.externalSelection){e.onAfterCommit(null);throw Error('SYNTHETIC_A1_RESPONSE_LOST');}})),/SYNTHETIC_A1_RESPONSE_LOST/);
  const f=fixture(),queueId=e.state().job.assignmentSheetWrite.queueId,before=e.state();
  f.ports.readOriginalGateSnapshot=async(q,actor)=>e.load('case-list-external-transfer').readExternalCaseListHandoffGateSnapshot(e.db.collection('sheetSyncQueue').doc(q),actor.uid,actor);
  await holds(f,'HANDOFF_ORIGINAL_UNAVAILABLE',{...check(f.snap.binding),queueId});await e.pendingSubmissionBackend();
  assert.equal(e.state().queueCount,1);assert.equal(e.state().writes,before.writes);assert.equal(e.state().job.applicationUnconfirmed,true);
 });
 for(const manual of [false,true]){
  await test((manual?'manual':'application')+' actual A2 response loss preserves original readback and never resends',async()=>{
   const e=productFixture();await assert.rejects(()=>e.start(manual,true,()=>e.onAfterCommit(()=>{if([...e.documents().values()].some(x=>x.externalSelection)){e.onAfterCommit(null);throw Error('SYNTHETIC_A2_RESPONSE_LOST');}})),/SYNTHETIC_A2_RESPONSE_LOST/);
   const f=fixture(),queueId=e.state().job.assignmentSheetWrite.queueId,read=e.load('case-list-external-transfer').readExternalCaseListHandoffGateSnapshot;
   f.ports.readOriginalGateSnapshot=async(q,actor)=>read(e.db.collection('sheetSyncQueue').doc(q),actor.uid,actor);
   const first=await f.ports.readOriginalGateSnapshot(queueId,{uid:e.OWNER,...e.owner.auth.token}),before=e.state();
   await holds(f,'HANDOFF_CONTINUATION_REQUIRED',check(first.binding));await holds(f,'HANDOFF_CONTINUATION_REQUIRED',check(first.binding));
   await e.pendingSubmissionBackend();assert.equal(e.state().writes,before.writes);assert.equal(e.state().queueCount,1);assert.equal(e.state().job.assignmentSheetWrite.queueId,queueId);
  });
  await test((manual?'manual':'application')+' actual owner cancellation blocks the new gate and submissions',async()=>{
   const e=productFixture(),s=await e.start(manual,true),f=fixture(),read=e.load('case-list-external-transfer').readExternalCaseListHandoffGateSnapshot;
   const prior=await read(e.db.collection('sheetSyncQueue').doc(s.queueId),e.OWNER,e.owner.auth.token);
   await e.jobs.adminCancelJob({...e.owner,data:{jobId:e.jobId(),expectedRevision:e.state().job.revision,reason:'SYNTHETIC_HANDOFF_CANCEL'}});
   const before=e.state();f.ports.readOriginalGateSnapshot=async(q,actor)=>read(e.db.collection('sheetSyncQueue').doc(q),actor.uid,actor);
   await holds(f,'HANDOFF_ORIGINAL_UNAVAILABLE',check(prior.binding));await e.pendingSubmissionBackend(true);
   assert.equal(e.state().writes,before.writes);assert.equal(e.state().queueCount,before.queueCount);assert.equal([...e.documents().values()].filter(value=>value.operation==='case_list.assign').length,1);assert.equal(e.state().job.cancelled,true);
  });
  await test((manual?'manual':'application')+' full real protected reader with synthetic continuation remains diagnostic and unconfirmed',async()=>{
   const e=productFixture(),s=await e.start(manual,true),f=fixture(),read=e.load('case-list-external-transfer').readExternalCaseListHandoffGateSnapshot;
   const before=await read(e.db.collection('sheetSyncQueue').doc(s.queueId),e.OWNER,e.owner.auth.token);
   const op='caseListMonthlyOperations/'+crypto.createHash('sha256').update(e.COMPANY+'|'+s.queueId).digest('hex');
   e.documents().get(op).gasHandoff=recordFor(before.binding);const prior=e.state();f.setNow(Math.max(Date.now(),before.binding.selectedAt+20));
   f.ports.readOriginalGateSnapshot=async(q,actor)=>read(e.db.collection('sheetSyncQueue').doc(q),actor.uid,actor);
   const result=await invoke(f,check(before.binding));assert.equal(result.status,'ORIGINAL_AND_SENT_OBSERVED');assert.equal(result.businessEnabled,false);
   await e.pendingSubmissionBackend();assert.equal(e.state().writes,prior.writes);assert.equal(e.state().job.applicationUnconfirmed,true);assert.equal(e.state().queueCount,1);
  });
 }
 await test('Source cleanup cannot manufacture a missing handoff receipt or acceptance',async()=>{
  const e=productFixture(),s=await e.start(true,true),f=fixture(),read=e.load('case-list-external-transfer').readExternalCaseListHandoffGateSnapshot;
  const prior=await read(e.db.collection('sheetSyncQueue').doc(s.queueId),e.OWNER,e.owner.auth.token);e.tables().get(2026101601).delete(2);
  f.ports.readOriginalGateSnapshot=async(q,actor)=>read(e.db.collection('sheetSyncQueue').doc(q),actor.uid,actor);
  await holds(f,'HANDOFF_CONTINUATION_REQUIRED',check(prior.binding));await e.pendingSubmissionBackend();assert.equal(e.state().job.applicationUnconfirmed,true);assert.equal(e.state().queueCount,1);
 });

 for(const changed of ['uid','company'])await test('mapped '+changed+' itself reaches real original reader and cannot inherit another owner',async()=>{
  const e=productFixture(),s=await e.start(false,true),f=fixture(),reader=e.load('case-list-external-transfer').readExternalCaseListHandoffGateSnapshot;
  const prior=await reader(e.db.collection('sheetSyncQueue').doc(s.queueId),e.OWNER,e.owner.auth.token);
  if(changed==='uid')f.user.uid='another_executive_synthetic';else {f.config.companyId='another_company_synthetic';f.user.customClaims.companyId=f.config.companyId;}
  let captured=null;f.ports.readOriginalGateSnapshot=async(q,actor)=>{captured=copy(actor);return reader(e.db.collection('sheetSyncQueue').doc(q),actor.uid,actor);};
  await holds(f,'HANDOFF_ORIGINAL_UNAVAILABLE',check(prior.binding));assert.equal(captured.uid,f.user.uid);assert.equal(captured.companyId,f.config.companyId);assert.equal(captured.role,'admin');assert.equal(captured.email_verified,true);
  assert.equal(e.state().job.applicationUnconfirmed,true);assert.equal(e.state().queueCount,1);
 });
 await test('actual adapter cannot stamp a delayed old account read as fresh',async()=>{
  let clock=NOW;class DelayedClock extends Date{static now(){return clock;}}
  const staleAdapter=loadAdapter(rawUser,{mfaObservation:observedMfaFor(rawUser),Date:DelayedClock,afterLookup:()=>{clock+=40000;}});
  const f=fixture(),out=await http(staleAdapter.createGasHandoffHandler(f.config));
  assert.equal(out.body.code,'HANDOFF_REVOCATION_UNVERIFIED');assert.equal(out.body.businessEnabled,false);assert.notEqual(out.status,200);
 });

 await test('token expiring during final protected await cannot produce success',async()=>{
  const f=fixture();f.ports.readOriginalGateSnapshot=async()=>{f.calls.original++;if(f.calls.original===2)f.setNow((SECOND+120)*1000);return copy(f.snap);};
  await holds(f,'HANDOFF_TOKEN_TIME_INVALID',check(f.snap.binding),jwt({exp:SECOND+120}));
 });
 await test('authority aging during final protected await cannot produce success',async()=>{
  const f=fixture();f.ports.readOriginalGateSnapshot=async()=>{f.calls.original++;if(f.calls.original===2)f.setNow(NOW+30001);return copy(f.snap);};
  await holds(f,'HANDOFF_REVOCATION_UNVERIFIED',check(f.snap.binding));
 });
 await test('actual adapter keeps omitted SDK MFA unknown without a successful raw observation',async()=>{const missing=copy(rawUser);delete missing.multiFactor;const instance=loadAdapter(missing),f=fixture(),out=await http(instance.createGasHandoffHandler(f.config));assert.equal(out.body.code,'HANDOFF_MFA_UNSUPPORTED');assert.equal(out.body.businessEnabled,false);});
 await test('no index, deploy allowlist, scope or public route is added',async()=>{const index=fs.readFileSync(path.join(repo,'functions/src/index.ts'),'utf8'),transport=fs.readFileSync(path.join(repo,'functions/src/case-list-gas-handoff.ts'),'utf8');assert(!index.includes('case-list-gas-handoff'));assert(!transport.includes('onRequest('));assert(!transport.includes('onCall('));assert(!transport.includes('setCustomUserClaims('));assert(!transport.includes('createUser('));assert(!transport.includes('getUserByEmail('));});
 const report={tests:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,results,actualGoogleLibrarySignatureChecks:true,actualUnregisteredHandler:true,actualOriginalDomainReader:true,syntheticTransientKeysOnly:true,realGoogleTokensIssued:0,realServiceCalls:0,businessWrites:0,publicRouteAdded:false,liveAudience:'UNCONFIGURED',realAuthenticationAcceptance:false};
 if(process.env.LKC_HANDOFF_TEST_REPORT)fs.writeFileSync(process.env.LKC_HANDOFF_TEST_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({tests:report.tests,passed:report.passed,failed:report.failed,failures:results.filter(x=>!x.passed)},null,2));if(report.failed)process.exitCode=1;
})().catch(()=>{console.error('HANDOFF_TEST_SETUP_FAILED');process.exitCode=1;});

