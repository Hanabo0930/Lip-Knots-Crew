'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const {UserRecord}=require('firebase-admin/auth');
const root=path.resolve(__dirname,'..'),NOW=1800000000000,SUB='1234567890123',UID='fixture-owner';
const clone=x=>JSON.parse(JSON.stringify(x)),results=[];
function compile(file,imports,clock=()=>NOW){
 const output=ts.transpileModule(fs.readFileSync(path.join(root,'functions/src',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};class Clock extends Date{static now(){return clock();}}
 vm.runInNewContext(output,{module,exports:module.exports,require:name=>{if(Object.hasOwn(imports,name))return imports[name];throw Error('Unexpected dependency '+name);},Date:Clock,Buffer,process:{env:{}},console:{log(){throw Error('unexpected log');}}});return module.exports;
}
const mfa=compile('case-list-mfa-observation.ts',{});
function raw(extra={}){return {localId:UID,email:'owner@example.invalid',emailVerified:true,
 providerUserInfo:[{providerId:'google.com',rawId:SUB}],customAttributes:JSON.stringify({role:'admin',companyId:'fixture-company'}),validSince:String(NOW/1000-1000),...extra};}
function observation(server){const out=clone(server);if(Object.hasOwn(out,'mfaInfo')&&Array.isArray(out.mfaInfo))out.mfaInfo=out.mfaInfo.map(f=>f&&typeof f==='object'&&!Array.isArray(f)?(Object.hasOwn(f,'mfaEnrollmentId')?{mfaEnrollmentId:f.mfaEnrollmentId}:{}):f);return {status:200,data:{users:[out]}};}
async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});}}
async function state(server,response=observation(server)){return mfa.readFirebaseMfaState(new UserRecord(server),SUB,async()=>response);}
function runtime(options={}){
 const server=raw(options.server),user=new UserRecord(server);let now=NOW,rawReads=0,sdkReads=0,requests=[];
 const claims={iss:'https://accounts.google.com',aud:'123-fixture.apps.googleusercontent.com',sub:SUB,email:'owner@example.invalid',email_verified:true,iat:NOW/1000-20,exp:NOW/1000+300,auth_time:NOW/1000-100,...options.claims};
 if(options.removeAuthTime)delete claims.auth_time;
 const google={auth:{OAuth2:class{async verifyIdToken(){if(options.invalidSignature)throw Error('synthetic invalid signature');return {getPayload:()=>claims};}},GoogleAuth:class{
  constructor(config){assert.equal(JSON.stringify(config),JSON.stringify({scopes:['https://www.googleapis.com/auth/cloud-platform']}));}
  async request(request){rawReads++;requests.push(request);assert.equal(request.url,'https://identitytoolkit.googleapis.com/v1/projects/lip-knots-crew-staging/accounts:lookup');assert.equal(request.method,'POST');assert.equal(JSON.stringify(request.data),JSON.stringify({localId:[UID]}));assert.equal(request.params.fields,mfa.MFA_LOOKUP_FIELDS);assert(!/password|salt|phoneNumber|phoneInfo|totpInfo/.test(request.params.fields));assert.equal(request.retry,false);assert.equal(request.timeout,5000);
   if(options.lookupFails)throw Error('private-backend-fixture-detail');if(options.delay)now+=options.delay;return options.response??observation(server);
  }
 }}};
 const core=require(path.join(root,'functions/src/case-list-gas-handoff-core.cjs'));
 const mod=compile('case-list-gas-handoff.ts',{'googleapis':{google},'./case-list-mfa-observation':mfa,
  './firebase':{auth:{async getUserByProviderUid(provider){sdkReads++;assert.equal(provider,'google.com');if(options.sdkFails)throw Error('private-sdk-detail');return user;}},db:{}},
  './system-safety':{getProductionOperationalState:async()=>({operational:true})},
  './case-list-external-transfer':{readExternalCaseListHandoffGateSnapshot(){throw Error('unexpected domain read');}},
  '../src/case-list-gas-handoff-core.cjs':core},()=>now);
 const config={projectId:'lip-knots-crew-staging',actualProjectId:'lip-knots-crew-staging',companyId:'fixture-company',audience:'123-fixture.apps.googleusercontent.com',executiveEmails:['owner@example.invalid'],allowOriginalReadback:false};
 const response={statusCode:null,body:null,set(){return this;},status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;}};
 const token=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture-key'})).toString('base64url')+'.e30.Zml4dHVyZQ';
 return {mod,user,response,counts:()=>({rawReads,sdkReads,requests}),run:()=>mod.createGasHandoffHandler(config)({method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:{protocol:'LK_GAS_CREW_HANDOFF_V1',action:'READINESS_ONLY',requestId:'fixture-request'}},response)};
}
(async()=>{
 await test('real SDK omits normal absent/empty MFA; matched official observation establishes NONE',async()=>{
  for(const server of [raw(),raw({mfaInfo:[]})]){assert.equal(new UserRecord(server).multiFactor,undefined);assert.equal(await state(server),'NONE');}
 });
 await test('SDK omission alone and unsuccessful/partial observations never establish NONE',async()=>{
  for(const response of [undefined,null,{}, {status:403,data:{users:[raw()]}},{status:200,data:{}},{status:200,data:{users:[]}},{status:200,data:{users:[raw(),raw()]}}])
   assert.equal(await mfa.readFirebaseMfaState(new UserRecord(raw()),SUB,async()=>response),'UNKNOWN');
 });
 await test('real SDK registered TOTP remains ENROLLED without extra read',async()=>{
  const user=new UserRecord(raw({mfaInfo:[{mfaEnrollmentId:'fixture-factor',totpInfo:{},enrolledAt:'2026-01-01T00:00:00Z'}]}));assert.equal(user.multiFactor.enrolledFactors.length,1);let reads=0;
  assert.equal(await mfa.readFirebaseMfaState(user,SUB,async()=>{reads++;throw Error('must not read');}),'ENROLLED');assert.equal(reads,0);
 });
 await test('unsupported enrolled factor hidden by SDK is never mistaken for NONE',async()=>{
  const server=raw({mfaInfo:[{mfaEnrollmentId:'fixture-unsupported',futureFactorInfo:{}}]});assert.equal(new UserRecord(server).multiFactor,undefined);assert.equal(await state(server),'ENROLLED');
 });
 await test('invalid factor hidden by SDK stays UNKNOWN',async()=>{
  const server=raw({mfaInfo:[{}]});assert.equal(new UserRecord(server).multiFactor,undefined);assert.equal(await state(server),'UNKNOWN');
 });
 for(const [label,value]of [['null',null],['boolean',false],['string','none'],['object',{}],['missing enrollment ID',[{}]],['invalid enrollment ID',[{mfaEnrollmentId:0}]]])
  await test('malformed raw MFA '+label+' stays UNKNOWN',async()=>{const response=observation(raw());response.data.users[0].mfaInfo=value;assert.equal(await state(raw(),response),'UNKNOWN');});
 for(const [label,change]of [['UID',u=>u.localId='other-user'],['Google subject',u=>u.providerUserInfo[0].rawId='999'],
  ['company',u=>u.customAttributes=JSON.stringify({role:'admin',companyId:'another-company'})],['role',u=>u.customAttributes=JSON.stringify({role:'staff',companyId:'fixture-company'})],
  ['claims parse',u=>u.customAttributes='{broken'],['email',u=>u.email='other@example.invalid'],['disabled',u=>u.disabled=true],
  ['verified email',u=>u.emailVerified=false],['tenant',u=>u.tenantId='different-tenant'],['revocation time',u=>u.validSince=String(NOW/1000)],
  ['invalid revocation',u=>u.validSince='Infinity'],['missing Google mapping',u=>delete u.providerUserInfo]])
  await test('mixed '+label+' observation cannot establish NONE',async()=>{const response=observation(raw());change(response.data.users[0]);assert.equal(await state(raw(),response),'UNKNOWN');});
 await test('explicit undefined MFA is not a verified omission',async()=>{const response=observation(raw());response.data.users[0].mfaInfo=undefined;assert.equal(await state(raw(),response),'UNKNOWN');});
 await test('malformed SDK MFA and read failure remain UNKNOWN',async()=>{
  const sdk=new UserRecord(raw());assert.equal(await mfa.readFirebaseMfaState(sdk,SUB,async()=>{throw Error('private detail');}),'UNKNOWN');
  for(const multiFactor of [null,{}, {enrolledFactors:'empty'},{enrolledFactors:[{}]}]){
   const user={uid:sdk.uid,email:sdk.email,emailVerified:sdk.emailVerified,disabled:sdk.disabled,providerData:sdk.providerData,customClaims:sdk.customClaims,tokensValidAfterTime:sdk.tokensValidAfterTime,multiFactor};
   assert.equal(await mfa.readFirebaseMfaState(user,SUB,async()=>observation(raw())),'UNKNOWN');
  }
 });
 await test('actual runtime adapter/handler accepts verified un-enrolled user and preserves zero business effects',async()=>{
  const f=runtime();await f.run();assert.equal(f.response.statusCode,200);assert.equal(f.response.body.status,'AUTH_LINK_CHECKED');assert.equal(f.response.body.businessEnabled,false);assert(Object.values(f.response.body.effects).every(n=>n===0));assert.equal(f.counts().rawReads,1);
 });
 await test('actual adapter keeps original observation time across asynchronous MFA read',async()=>{
  const f=runtime({delay:1000}),ports=f.mod.createGasIdentityRuntimePorts(),u=await ports.readFirebaseUserByGoogleSubject(SUB);assert.equal(u.observedAt,NOW);assert.equal(u.mfaState,'NONE');
  const stale=runtime({delay:31000});await stale.run();assert.equal(stale.response.body.code,'HANDOFF_REVOCATION_UNVERIFIED');
 });
 for(const [label,options,code]of [
  ['enrolled MFA',{server:{mfaInfo:[{mfaEnrollmentId:'fixture-factor',totpInfo:{},enrolledAt:'2026-01-01T00:00:00Z'}]}},'HANDOFF_MFA_UNSUPPORTED'],
  ['malformed MFA',{server:{mfaInfo:[{}]}},'HANDOFF_MFA_UNSUPPORTED'],
  ['MFA read failure',{lookupFails:true},'HANDOFF_MFA_UNSUPPORTED'],
  ['SDK read failure',{sdkFails:true},'HANDOFF_FIREBASE_LINK_UNAVAILABLE'],
  ['missing auth_time',{removeAuthTime:true},'HANDOFF_AUTH_TIME_REQUIRED'],
  ['invalid signature',{invalidSignature:true},'HANDOFF_TOKEN_INVALID'],
  ['wrong issuer',{claims:{iss:'https://invalid.example.invalid'}},'HANDOFF_GOOGLE_IDENTITY_INVALID'],
  ['wrong audience',{claims:{aud:'123-other.apps.googleusercontent.com'}},'HANDOFF_GOOGLE_IDENTITY_INVALID'],
  ['expired token',{claims:{exp:NOW/1000-1}},'HANDOFF_TOKEN_TIME_INVALID'],
  ['disabled user',{server:{disabled:true}},'HANDOFF_ACCOUNT_DISABLED_OR_INVALID'],
  ['non-admin',{server:{customAttributes:JSON.stringify({role:'staff',companyId:'fixture-company'})}},'HANDOFF_EXECUTIVE_REQUIRED'],
  ['other company',{server:{customAttributes:JSON.stringify({role:'admin',companyId:'another-company'})}},'HANDOFF_EXECUTIVE_REQUIRED'],
  ['changed Google mapping',{claims:{sub:'999999999'}},'HANDOFF_FIREBASE_LINK_REQUIRED'],
 ])await test('existing handler still refuses '+label,async()=>{
   const f=runtime(options);await f.run();assert.equal(f.response.body.code,code);assert.equal(f.response.body.businessEnabled,false);
   assert(!JSON.stringify(f.response.body).includes('private-'));if(label==='missing auth_time')assert.equal(f.counts().rawReads,0);
 });
 console.log(JSON.stringify({passed:results.filter(x=>x.passed).length,total:results.length,actualAuthRequests:0,actualTokens:0,
  coverage:'Actual SDK UserRecord normal/malformed fixtures and actual adapter/handler with mock Google/Auth ports; signature transport mocked',results},null,2));
 if(results.some(x=>!x.passed))process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1;});
