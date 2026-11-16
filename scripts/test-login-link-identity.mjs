import assert from 'node:assert/strict';import fs from 'node:fs';import crypto from 'node:crypto';import {runInNewContext} from 'node:vm';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript'),{Timestamp}=require('firebase-admin/firestore'),{HttpsError}=require('firebase-functions/v2/https');const hash=v=>crypto.createHash('sha256').update(v).digest('hex'),email='synthetic@example.invalid',emailKey=hash(email),remove=Symbol('delete');
function setup(){let serial=0;const records=new Map([['emailIndex/'+emailKey,{companyId:'company-a',staffId:'staff-a',active:true}],['staffProfiles/staff-a',{companyId:'company-a',active:true,displayName:'Synthetic',emails:[email]}]]),state={generated:0,sent:0,clockOffset:0,signatures:[],creations:[],user:{uid:'synthetic-device-user',email,emailVerified:true,disabled:false}};const apply=(ref,data,options)=>{const next=options?.merge?{...records.get(ref.path)}:{};for(const[k,v]of Object.entries(data)){if(v===remove)delete next[k];else if(v?.__increment!==undefined)next[k]=Number(next[k]??0)+v.__increment;else next[k]=v;}records.set(ref.path,next);};const ref=path=>({path,id:path.split('/').at(-1),get:async()=>({id:path.split('/').at(-1),ref:ref(path),exists:records.has(path),data:()=>records.get(path)}),set:async(data,options)=>apply(ref(path),data,options)});const collection=(name,filters=[],max=Infinity)=>({doc:(id='synthetic-'+ ++serial)=>ref(name+'/'+id),where:(field,op,value)=>collection(name,[...filters,[field,op,value]],max),limit:n=>collection(name,filters,n),get:async()=>({docs:await Promise.all([...records].filter(([key,data])=>key.startsWith(name+'/')&&!key.slice(name.length+1).includes('/')&&filters.every(([f,op,v])=>op==='=='?data[f]===v:op==='>='?data[f]>=v:data[f]<=v)).slice(0,max).map(([key])=>ref(key).get()))})});let txTail=Promise.resolve();const db={getAll:(...refs)=>Promise.all(refs.map(r=>r.get())),collection,runTransaction:fn=>{const run=txTail.then(async()=>{state.beforeTransaction?.();const writes=[];const result=await fn({get:r=>r.get(),set:(...args)=>writes.push(args),update:(ref,data)=>writes.push([ref,data,{merge:true}])});for(const args of writes)apply(...args);return result;});txTail=run.catch(()=>{});return run;}};const val=v=>({value:()=>v}),boundaries={'node:crypto':{...crypto,randomBytes:n=>Buffer.alloc(n,n===24?state.signatures.length+10:7),randomInt:()=>123456},zod:require('zod'),'./firebase':{db,auth:{getUser:async uid=>{assert.equal(uid,state.user?.uid);return {...state.user};},getUserByEmail:async requestEmail=>{assert.equal(requestEmail,email);if(state.failLookup)throw Object.assign(Error("lookup failed"),{code:"auth/internal-error"});if(!state.user)throw Object.assign(Error("not found"),{code:"auth/user-not-found"});return {...state.user};},createUser:async record=>{state.creations.push(record);await state.beforeCreate?.(record);if(state.user)throw Object.assign(Error("already exists"),{code:"auth/email-already-exists"});if(state.failCreate)throw Error("creation unavailable");state.user={disabled:false,providerData:[],...record};if(state.lostCreationResponse)throw Error("creation response lost");return {...state.user};},createCustomToken:async(uid,claims)=>{if(state.failSigner)throw Error('synthetic signing failed');state.signatures.push({uid,claims});state.onSigner?.(claims);return 'synthetic.grant.signature';},generateSignInWithEmailLink:async()=>{state.generated++;return 'https://synthetic.invalid/action';}}},'./mail-sender':{gmailServiceAccountJson:{},mailFrom:val('synthetic@example.invalid'),publicLoginGatewayUrl:val('https://synthetic.invalid/gateway'),staffAppUrl:val('https://synthetic.invalid'),sendWorkspaceMail:async message=>{state.mail=message;state.sent++;return {messageId:'synthetic'};}},'./system-safety':{assertProductionOperational:async()=>{if(state.stopped)throw new HttpsError("failed-precondition","stopped");},getProductionOperationalState:async()=>{state.operationalChecks=(state.operationalChecks??0)+1;state.onOperationalCheck?.();return {operational:!state.stopped};}},'firebase-functions/params':{defineString:()=>({value:()=>state.adminEmail??'synthetic-admin@example.invalid'})},'./production-metrics':{incrementProductionMetrics:async()=>{}},'firebase-functions/v2/https':{HttpsError,onCall:(...args)=>args.at(-1),onRequest:fn=>fn},'firebase-functions/v2/scheduler':{onSchedule:(_,fn)=>fn},'firebase-admin/firestore':{Timestamp:class extends Timestamp{static now(){return Timestamp.fromMillis(Date.now()+state.clockOffset);}static [Symbol.hasInstance](value){return value instanceof Timestamp;}},FieldValue:{serverTimestamp:()=>Timestamp.fromMillis(Date.now()+state.clockOffset),delete:()=>remove,increment:n=>({__increment:n})}}};const modules={};const load=name=>{if(boundaries[name])return boundaries[name];assert.ok(['./login-links','./utils','./case-id','./auth','./staff-session'].includes(name));if(modules[name])return modules[name];const exports={};modules[name]=exports;runInNewContext(ts.transpileModule(fs.readFileSync('functions/src/'+name.slice(2)+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:load,URL,Date:class extends Date{static now(){return Date.now()+state.clockOffset;}},console:{error:()=>{}}});return exports;};return {records,state,bootstrap:grant=>load("./auth").bootstrapSession({auth:{uid:grant.uid,token:{...grant.claims,auth_time:Math.floor(Date.now()/1000)}},data:{}}),candidates:()=>load("./login-links").getLoginInviteCandidates({auth:{uid:"synthetic-admin",token:{role:"admin",companyId:"company-a"}},data:{days:30}}),invite:()=>load("./login-links").sendLoginInvites({auth:{uid:"synthetic-admin",token:{role:"admin",companyId:"company-a"}},data:{staffIds:["staff-a"],subject:"Synthetic",introText:""}}),open:async()=>{const result={status:200,redirect:null,body:null};const response={status:n=>{result.status=n;return response;},send:body=>{result.body=body;},redirect:(status,url)=>{result.status=status;result.redirect=url;}};await load("./login-links").loginGateway({query:{token:Buffer.alloc(32,7).toString("base64url")}},response);return result;},run:(code,deviceId)=>load('./login-links').requestStaffLoginLink({data:{email,...(code?{code}:{}),...(deviceId?{deviceId}:{})}})};}
const mutations=[['foreign profile',h=>h.records.get('staffProfiles/staff-a').companyId='company-b'],['missing profile company',h=>delete h.records.get('staffProfiles/staff-a').companyId],['inactive profile',h=>h.records.get('staffProfiles/staff-a').active=false],['truthy active',h=>h.records.get('emailIndex/'+emailKey).active='true'],['blank company',h=>h.records.get('emailIndex/'+emailKey).companyId=' '],['invalid staff',h=>h.records.get('emailIndex/'+emailKey).staffId=123]];let cases=0;
for(const[name,mutate]of mutations){const h=setup();mutate(h);assert.equal((await h.run()).accepted,true);assert.equal(h.state.generated,0,name);assert.equal(h.state.sent,0,name);assert.equal([...h.records.keys()].some(k=>k.startsWith('loginGatewayTokens/')),false,name);cases++;}
for(const[name,mutate]of mutations){const h=setup();await h.run();assert.equal(h.state.sent,1);mutate(h);await assert.rejects(h.run('123456'),{code:'invalid-argument'},name);assert.equal(h.records.get('loginLinkRateLimits/'+emailKey).loginCodeActive,true);assert.equal([...h.records].find(([k])=>k.startsWith('loginGatewayTokens/'))[1].active,true);assert.equal(h.state.sent,1);cases++;}
{const h=setup();await h.run();assert.equal(h.state.sent,1);assert.equal((await h.run('123456')).emailActionLink,'https://synthetic.invalid/action');await assert.rejects(h.run('123456'),{code:'invalid-argument'});assert.equal(h.state.sent,1);cases++;}
for(const[name,mutate]of [...mutations,['operational stop',h=>h.state.stopped=true],['code already redeemed',async h=>{await h.run('123456');}],['token revoked before transaction',h=>{h.state.beforeTransaction=()=>{[...h.records].find(([k])=>k.startsWith('loginGatewayTokens/'))[1].active=false;};}]]){
 const h=setup();await h.run();await mutate(h);const response=await h.open();assert.equal(response.status,400,name);assert.equal(response.redirect,null,name);assert.equal([...h.records].find(([k])=>k.startsWith('loginGatewayTokens/'))[1].openCount,0,name);assert.equal(h.state.sent,1);cases++;
}
{const h=setup();await h.run();const response=await h.open();assert.equal(response.status,302);assert.equal(response.redirect,'https://synthetic.invalid/action');assert.equal([...h.records].find(([k])=>k.startsWith('loginGatewayTokens/'))[1].openCount,1);assert.equal(h.state.sent,1);cases++;}
for(const company of ['company-b',undefined]){const h=setup();h.records.get('staffProfiles/staff-a').companyId=company;const before=[...h.records.keys()];await assert.rejects(h.invite(),{code:'permission-denied'});assert.deepEqual([...h.records.keys()],before);assert.equal(h.state.generated,0);assert.equal(h.state.sent,0);cases++;}
for(const change of ['index-company','index-staff','index-inactive','index-missing','profile-stopped-after-read','profile-moved-after-read']){const h=setup(),index=h.records.get('emailIndex/'+emailKey);if(change==='index-company')index.companyId='company-b';if(change==='index-staff')index.staffId='other';if(change==='index-inactive')index.active=false;if(change==='index-missing')h.records.delete('emailIndex/'+emailKey);if(change.startsWith('profile-'))h.state.onOperationalCheck=()=>{if(h.state.operationalChecks===2){const p=h.records.get('staffProfiles/staff-a');if(change==='profile-stopped-after-read')p.active=false;else p.companyId='company-b';}};const result=await h.invite();assert.equal(result.successStaff,0,change);assert.equal(result.failedStaff,1,change);assert.equal(h.state.generated,0,change);assert.equal(h.state.sent,0,change);cases++;}
for(const forged of [false,true]){const h=setup();if(forged)h.records.get('staffProfiles/staff-a').id='forged';const result=await h.invite();assert.equal(result.successStaff,1);assert.equal(result.failedStaff,0);assert.equal(h.state.generated,1);assert.equal(h.state.sent,1);cases++;}
for(const variant of ['normal','foreign-profile','missing-company','inactive','already-logged-in','empty-email','forged-id','mixed-jobs']){
 const h=setup(),today=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'}),job={companyId:'company-a',status:'assigned',dateKey:today,assignedStaffId:'staff-a'};h.records.set('jobs/one',job);const p=h.records.get('staffProfiles/staff-a');
 if(variant==='foreign-profile')p.companyId='company-b';if(variant==='missing-company')delete p.companyId;if(variant==='inactive')p.active=false;if(variant==='already-logged-in')p.lastLoginAt=Timestamp.now();if(variant==='empty-email')p.emails=[];if(variant==='forged-id')p.id='unrelated';if(variant==='mixed-jobs'){h.records.set('jobs/two',{...job});h.records.set('jobs/foreign',{...job,companyId:'company-b'});h.records.set('jobs/cancelled',{...job,status:'cancelled'});}
 const before=JSON.stringify([...h.records]),result=await h.candidates(),expected=['normal','forged-id','mixed-jobs'].includes(variant)?1:0;assert.equal(result.count,expected,variant);assert.equal(result.candidates.length,expected,variant);if(expected){assert.equal(result.candidates[0].staffId,'staff-a');assert.equal(result.candidates[0].upcomingJobs,variant==='mixed-jobs'?2:1);}assert.equal(JSON.stringify([...h.records]),before);assert.equal(h.state.sent,0);assert.equal(h.state.generated,0);cases++;
}

const proofDeviceA='synthetic-browser-a',proofDeviceB='synthetic-browser-b',proofUid='synthetic-device-user';
function boundProfile(h){
 const profile=h.records.get('staffProfiles/staff-a');profile.deviceBoundAuthRequired=true;profile.authUids=[proofUid];
 h.records.set('authIdentities/'+proofUid,{companyId:'company-a',staffId:'staff-a',active:true,emailHash:emailKey});
}
{
 const h=setup();boundProfile(h);await h.run();
 const gateway=await h.open();
 assert.equal(gateway.redirect,null);
 assert.match(gateway.body,/6桁の確認コード/);
 const invalid=await h.run('123456',proofDeviceA);
 assert.deepEqual(Object.keys(invalid),['customToken']);const first=h.state.signatures[0];
 const identity=h.records.get('authIdentities/'+proofUid);
 const slot=first.claims.crewDeviceSession,version=first.claims.crewDeviceGeneration;
 assert.equal(first.uid,proofUid);assert.equal(first.claims.role,'staff');
 assert.equal(h.records.get('deviceSessions/'+slot).credentialGeneration,version);
 assert.equal(identity.deviceCredentials[slot],version);
 await assert.rejects(h.run('123456',proofDeviceB),{code:'invalid-argument'});
 assert.equal(h.state.signatures.length,1);
 h.state.clockOffset+=60_001;await h.run();await h.run('123456',proofDeviceB);
 const second=h.state.signatures.at(-1);
 assert.equal(second.uid,proofUid);assert.notEqual(second.claims.crewDeviceSession,slot);
 assert.equal(h.records.get('authIdentities/'+proofUid).deviceCredentials[slot],version);
 h.state.clockOffset+=60_001;await h.run();await h.run('123456',proofDeviceA);
 const third=h.state.signatures.at(-1);
 assert.notEqual(third.claims.crewDeviceGeneration,version);
 assert.equal(third.claims.crewDeviceSession,slot);
 assert.equal(h.records.get('authIdentities/'+proofUid).deviceCredentials[slot],third.claims.crewDeviceGeneration);
 assert.equal(h.records.get('authIdentities/'+proofUid).deviceCredentials[second.claims.crewDeviceSession],second.claims.crewDeviceGeneration);
 cases++;
}
for(const [name, mutate, code] of [
 ['missing device',()=>{},'permission-denied'],
 ['wrong device shape',()=>{},'invalid-argument'],
 ['disabled account',h=>{h.state.user.disabled=true;},'permission-denied'],
 ['wrong account email',h=>{h.state.user.email='wrong@example.invalid';},'permission-denied'],
 ['unbound auth UID',h=>{h.state.user.uid='other';},'permission-denied'],
 ['account auth revoked after code',h=>{h.state.user.tokensValidAfterTime=new Date(Date.now()+60_000).toISOString();},'permission-denied'],
 ['identity revoked after code',h=>{h.records.get('authIdentities/'+proofUid).revokedAt=Timestamp.fromMillis(Date.now()+60_000);},'permission-denied'],
 ['wrong identity email hash',h=>{h.records.get('authIdentities/'+proofUid).emailHash='different';},'permission-denied'],
 ['signer unavailable',h=>{h.state.failSigner=true;},'unavailable'],
 ['profile changes before commit',h=>{h.state.onSigner=()=>{h.records.get('staffProfiles/staff-a').deviceBoundAuthRequired=false;};},'invalid-argument'],
 ['device differs before commit',h=>{h.state.onSigner=claims=>{h.records.set('deviceSessions/'+claims.crewDeviceSession,{companyId:'other'});};},'permission-denied'],
]){
 const h=setup();boundProfile(h);await h.run();mutate(h);
 const requestDevice=name==='missing device'?undefined:name==='wrong device shape'?'../../not-valid':proofDeviceA;
 await assert.rejects(h.run('123456',requestDevice),{code},name);
 const current=h.records.get('authIdentities/'+proofUid);assert.equal(current.deviceCredentials,undefined);
 assert.equal(h.records.get('loginLinkRateLimits/'+emailKey).loginCodeActive,true);
 assert.equal(h.state.sent,1);
 if(name==='signer unavailable'){
  h.state.failSigner=false;
  assert.equal(typeof (await h.run('123456',proofDeviceA)).customToken,'string');
 }
 cases++;
}
{
 const h=setup();boundProfile(h);
 const oldIdentity=h.records.get('authIdentities/'+proofUid);
 oldIdentity.active=false;oldIdentity.revokedAt=Timestamp.fromMillis(Date.now()-60_000);
 const oldB='device_'+'b'.repeat(28);oldIdentity.deviceCredentials={[oldB]:'b'.repeat(48)};
 await h.run();await h.run('123456',proofDeviceA);
 const recovered=h.records.get('authIdentities/'+proofUid);
 assert.equal(recovered.active,true);assert.equal(recovered.deviceCredentials[oldB],null);
 assert.equal(recovered.revokedAt.toMillis(),oldIdentity.revokedAt.toMillis());
 cases++;
}

console.log(JSON.stringify({cases,deviceCodeCases:13,passed:true,realMail:false,realLogin:false,cloudChanges:false}));


const initialEnrollmentCases = [];
const reservationPath = 'staffLoginEnrollments/staff-a';
const profilePath = 'staffProfiles/staff-a';
const codePath = 'loginLinkRateLimits/' + emailKey;
const firstUid = 'crew_staff_' + hash(JSON.stringify(['company-a', 'staff-a', emailKey]));

function firstLoginFixture() {
  const h = setup();
  h.state.user = null;
  h.records.get(profilePath).deviceBoundAuthRequired = true;
  return h;
}
function assertBeforeGrant(h) {
  assert.equal(h.state.signatures.length, 0);
  assert.equal(h.records.get(codePath).loginCodeActive, true);
  assert.equal(h.records.get('authIdentities/' + firstUid), undefined);
  assert.equal([...h.records.keys()].filter(key => key.startsWith('deviceSessions/')).length, 0);
}
function assertFirstGrant(h, expectedUid = firstUid) {
  const last = h.state.signatures.at(-1);
  assert.equal(last.uid, expectedUid);
  assert.deepEqual(Array.from(h.records.get(profilePath).authUids), [expectedUid]);
  const identity = h.records.get('authIdentities/' + expectedUid);
  assert.equal(identity.companyId, 'company-a');
  assert.equal(identity.staffId, 'staff-a');
  assert.equal(identity.emailHash, emailKey);
  assert.equal(identity.deviceCredentials[last.claims.crewDeviceSession], last.claims.crewDeviceGeneration);
  assert.equal(h.records.get('deviceSessions/' + last.claims.crewDeviceSession).credentialGeneration, last.claims.crewDeviceGeneration);
  assert.equal(h.records.get(reservationPath).status, 'linked');
  assert.equal(h.records.get(codePath).loginCodeActive, false);
  assert.equal([...h.records].find(([key]) => key.startsWith('loginGatewayTokens/'))[1].active, false);
  return last;
}
async function initialEnrollmentCase(name, test) {
  await test();
  initialEnrollmentCases.push(name);
}

await initialEnrollmentCase('verified login code creates one account, one identity and one device, then bootstraps', async () => {
  const h = firstLoginFixture();
  await h.run();
  assert.equal(h.state.creations.length, 0);
  assert.match(h.state.mail.text, /スマートフォン、iPad、PCで同じ手順/);
  assert.match(h.state.mail.html, /確認コードを入力/);
  assert.doesNotMatch(h.state.mail.html, /gateway\?token=/);
  assert.equal(h.records.has(reservationPath), false);
  assert.equal((await h.run('123456', proofDeviceA)).customToken, 'synthetic.grant.signature');
  assert.equal(h.state.creations.length, 1);
  assert.equal(h.state.creations[0].emailVerified, true);
  assert.equal(h.state.creations[0].email, email);
  const grant = assertFirstGrant(h);
  const boot = await h.bootstrap(grant);
  assert.equal(boot.role, 'staff');
  assert.equal(boot.staffId, 'staff-a');
  assert.equal(boot.companyId, 'company-a');
  assert.equal(boot.refreshToken, false);
  await assert.rejects(h.run('123456', proofDeviceA), { code: 'invalid-argument' });
  h.state.clockOffset += 60_001;
  await h.run();
  await h.run('123456', proofDeviceB);
  const second = assertFirstGrant(h);
  assert.equal(h.state.creations.length, 1);
  assert.notEqual(second.claims.crewDeviceSession, grant.claims.crewDeviceSession);
});

for (const [name, mutate, expected] of [
  ['confirmation code does not match', () => {}, 'invalid-argument'],
  ['staff is disabled', h => { h.records.get(profilePath).active = false; }, 'invalid-argument'],
  ['directory moved company', h => { h.records.get('emailIndex/' + emailKey).companyId = 'company-b'; }, 'invalid-argument'],
  ['email removed from approved profile', h => { h.records.get(profilePath).emails = []; }, 'permission-denied'],
  ['administrator email is reserved', h => { h.state.adminEmail = email; }, 'permission-denied'],
  ['pre-existing account with another UID', h => { h.state.user = { uid: 'some-other-account', email, providerData: [], emailVerified: true }; }, 'permission-denied'],
  ['pre-existing UID has privileged claims', h => { h.state.user = { uid: firstUid, email, providerData: [], emailVerified: true, customClaims: { role: 'admin' } }; }, 'permission-denied'],
  ['pending reservation for another email', h => {
    h.records.set(reservationPath, { status: 'pending', companyId: 'company-a', staffId: 'staff-a', emailKey: 'other-email', uid: 'another-pending-uid' });
  }, 'permission-denied'],
  ['lookup error gives no authority to create an account', h => { h.state.failLookup = true; }, 'unavailable'],
  ['account write cannot be confirmed', h => { h.state.failCreate = true; }, 'unavailable'],
]) {
  await initialEnrollmentCase(name, async () => {
    const h = firstLoginFixture();
    await h.run();
    mutate(h);
    await assert.rejects(h.run(name === 'confirmation code does not match' ? '999999' : '123456', proofDeviceA), { code: expected });
    assertBeforeGrant(h);
    assert.equal(h.state.creations.length, name === 'account write cannot be confirmed' ? 1 : 0);
  });
}

await initialEnrollmentCase('lost creation reply is read back before any retry and keeps the same UID', async () => {
  const h = firstLoginFixture();
  h.state.lostCreationResponse = true;
  await h.run();
  await h.run('123456', proofDeviceA);
  assert.equal(h.state.creations.length, 1);
  assert.equal(h.state.user.uid, firstUid);
  assertFirstGrant(h);
});

await initialEnrollmentCase('signer failure retains pending registration and reruns with the same UID', async () => {
  const h = firstLoginFixture();
  h.state.failSigner = true;
  await h.run();
  await assert.rejects(h.run('123456', proofDeviceA), { code: 'unavailable' });
  assertBeforeGrant(h);
  assert.equal(h.records.get(reservationPath).status, 'pending');
  assert.equal(h.state.user.uid, firstUid);
  h.state.failSigner = false;
  await h.run('123456', proofDeviceA);
  assert.equal(h.state.creations.length, 1);
  assertFirstGrant(h);
});

await initialEnrollmentCase('identity collision during signing leaves code, profile and device unmodified', async () => {
  const h = firstLoginFixture();
  await h.run();
  const foreign = { companyId: 'company-b', staffId: 'staff-z', active: true };
  h.state.onSigner = () => h.records.set('authIdentities/' + firstUid, foreign);
  await assert.rejects(h.run('123456', proofDeviceA), { code: 'permission-denied' });
  assert.equal(h.records.get('authIdentities/' + firstUid), foreign);
  assert.equal(h.records.get(profilePath).authUids, undefined);
  assert.equal(h.records.get(codePath).loginCodeActive, true);
  assert.equal(h.records.get(reservationPath).status, 'pending');
  assert.equal([...h.records.keys()].some(key => key.startsWith('deviceSessions/')), false);
});

await initialEnrollmentCase('account moves or company stops during signing and cannot complete registration', async () => {
  for (const mutate of [
    h => { h.records.get(profilePath).companyId = 'company-b'; },
    h => { h.state.stopped = true; },
  ]) {
    const h = firstLoginFixture();
    await h.run();
    h.state.onSigner = () => mutate(h);
    await assert.rejects(h.run('123456', proofDeviceA));
    assert.equal(h.records.get('authIdentities/' + firstUid), undefined);
    assert.equal(h.records.get(profilePath).authUids, undefined);
    assert.equal(h.records.get(codePath).loginCodeActive, true);
    assert.equal(h.records.get(reservationPath).status, 'pending');
    assert.equal([...h.records.keys()].some(key => key.startsWith('deviceSessions/')), false);
  }
});

await initialEnrollmentCase('two devices race the same code and only one may link an account or open a device', async () => {
  const h = firstLoginFixture();
  await h.run();
  const results = await Promise.allSettled([h.run('123456', proofDeviceA), h.run('123456', proofDeviceB)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const winner = results.findIndex(result => result.status === 'fulfilled');
  assert.equal(h.state.user.uid, firstUid);
  assert.ok(h.state.creations.every(record => record.uid === firstUid));
  assert.equal([...h.records.keys()].filter(key => key.startsWith('deviceSessions/')).length, 1);
  const device = [...h.records.entries()].find(([key]) => key.startsWith('deviceSessions/'))[1];
  assert.equal(device.deviceId, [proofDeviceA, proofDeviceB][winner]);
  const identities = [...h.records.keys()].filter(key => key.startsWith('authIdentities/'));
  assert.deepEqual(identities, ['authIdentities/' + firstUid]);
  assert.equal(h.records.get(codePath).loginCodeActive, false);
});
console.log(JSON.stringify({ initialEnrollmentCases, passed: initialEnrollmentCases.length, liveAccounts: 0, liveMail: 0 }));


for (const linked of [false, true]) {
  const h = linked ? setup() : firstLoginFixture();
  if (linked) boundProfile(h);
  await h.run();
  const oldCode = h.records.get(codePath).loginCodeCreatedAt;
  h.records.get(profilePath).deviceBoundAuthEnabledAt = Timestamp.fromMillis(oldCode.toMillis() + 1);
  await assert.rejects(h.run('123456', proofDeviceA), { code: 'invalid-argument' });
  assert.equal(h.records.get(codePath).loginCodeActive, true);
  assert.equal(h.state.creations.length, 0);
  assert.equal([...h.records.keys()].some(key => key.startsWith('deviceSessions/')), false);
  h.state.clockOffset += 60_001;
  await h.run();
  await h.run('123456', proofDeviceA);
  assert.equal(h.state.signatures.at(-1).uid, linked ? proofUid : firstUid);
  assert.equal(h.records.get(codePath).loginCodeActive, false);
}
console.log(JSON.stringify({ activationCutoffCases: 2, realMail: false }));
