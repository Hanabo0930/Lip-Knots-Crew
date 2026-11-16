'use strict';
// Unpublished, read-only handoff domain. No writer, credential issuer or route registration.
const {createHash}=require('node:crypto');
const Owner=require('./case-list-owner-authorization.cjs');
const PROTOCOL='LK_GAS_CREW_HANDOFF_V1',ISSUER='https://accounts.google.com',PROJECT='lip-knots-crew-staging';
const ID=/^[A-Za-z0-9_-]{1,200}$/,CASE=/^LKCASE_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,HEX=/^[a-f0-9]{64}$/;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/,AUD=/^[0-9]+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/;
const EFFECTS=Object.freeze({mailSends:0,sourceWrites:0,monthlyWrites:0,firestoreWrites:0});
class Hold extends Error{constructor(code,status=409){super(code);this.code=code;this.status=status;}}
const need=(ok,code,status)=>{if(!ok)throw new Hold(code,status);};
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const email=x=>typeof x==='string'?x.trim().toLowerCase():'';
const finite=x=>typeof x==='number'&&Number.isSafeInteger(x)&&x>0;
function canonical(x){
 if(x===null||typeof x==='string'||typeof x==='boolean')return JSON.stringify(x);
 if(typeof x==='number'&&Number.isFinite(x))return JSON.stringify(x);
 if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
 need(plain(x),'HANDOFF_RECORD_INVALID');return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
}
const hash=x=>createHash('sha256').update(canonical(x)).digest('hex');
function settings(c){
 need(c?.projectId===PROJECT&&c.actualProjectId===PROJECT,'HANDOFF_PROJECT_REQUIRED',503);
 need(typeof c.audience==='string'&&AUD.test(c.audience),'HANDOFF_AUDIENCE_REQUIRED',503);
 need(typeof c.companyId==='string'&&ID.test(c.companyId),'HANDOFF_COMPANY_REQUIRED',503);
 need(Array.isArray(c.executiveEmails)&&c.executiveEmails.length>0&&c.executiveEmails.length<=20&&c.executiveEmails.every(x=>typeof x==='string'&&x===email(x)&&EMAIL.test(x)),'HANDOFF_EXECUTIVE_CONFIG_REQUIRED',503);
}
function input(x){
 need(plain(x),'HANDOFF_INPUT_INVALID',400);
 const check=x.action==='CHECK_ORIGINAL',keys=(check?['action','caseId','nameUpExpected','protocol','queueId','requestId','selectionHash']:['action','protocol','requestId']).sort();
 need(Object.keys(x).sort().join('|')===keys.join('|')&&x.protocol===PROTOCOL&&['READINESS_ONLY','CHECK_ORIGINAL'].includes(x.action)&&typeof x.requestId==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(x.requestId),'HANDOFF_INPUT_INVALID',400);
 if(check)need(ID.test(x.queueId)&&CASE.test(x.caseId)&&HEX.test(x.selectionHash)&&HEX.test(x.nameUpExpected),'HANDOFF_INPUT_INVALID',400);
 return x;
}
function bearer(value){
 need(typeof value==='string'&&value.length<=16384&&/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value),'HANDOFF_BEARER_REQUIRED',401);
 const token=value.slice(7);let header;
 try{header=JSON.parse(Buffer.from(token.split('.')[0],'base64url').toString('utf8'));}catch{throw new Hold('HANDOFF_TOKEN_INVALID',401);}
 need(plain(header)&&header.alg==='RS256'&&typeof header.kid==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(header.kid)&&Object.keys(header).every(k=>['alg','kid','typ'].includes(k))&&(!Object.hasOwn(header,'typ')||header.typ==='JWT'),'HANDOFF_TOKEN_INVALID',401);
 return token;
}
async function linkedGoogleAccount(s,c,authorization,now,requireAuthTime){
 const token=bearer(authorization);let claims;
 try{claims=await s.verifyGoogleIdentity(token,c.audience);}catch{throw new Hold('HANDOFF_TOKEN_INVALID',401);}
 const seconds=Math.floor(now/1000);
 need(plain(claims)&&claims.iss===ISSUER&&claims.aud===c.audience&&typeof claims.sub==='string'&&/^[0-9]{1,255}$/.test(claims.sub)&&claims.email_verified===true,'HANDOFF_GOOGLE_IDENTITY_INVALID',401);
 need(finite(claims.iat)&&finite(claims.exp)&&claims.iat<=seconds+30&&claims.exp>seconds&&claims.exp>claims.iat&&claims.exp-claims.iat<=3600,'HANDOFF_TOKEN_TIME_INVALID',401);
 // iat alone is not the user's authentication time. Never synthesize auth_time.
 if(requireAuthTime)need(finite(claims.auth_time)&&claims.auth_time<=claims.iat,'HANDOFF_AUTH_TIME_REQUIRED',403);
 let user;
 try{user=await s.readFirebaseUserByGoogleSubject(claims.sub);}catch{throw new Hold('HANDOFF_FIREBASE_LINK_UNAVAILABLE',403);}
 need(plain(user)&&typeof user.uid==='string'&&ID.test(user.uid)&&Array.isArray(user.providerData),'HANDOFF_FIREBASE_LINK_REQUIRED',403);
 const links=user.providerData.filter(p=>p?.providerId==='google.com');
 need(links.length===1&&links[0].uid===claims.sub,'HANDOFF_FIREBASE_LINK_REQUIRED',403);
 need(user.disabled===false&&user.emailVerified===true&&email(user.email)===email(claims.email)&&EMAIL.test(email(user.email)),'HANDOFF_ACCOUNT_DISABLED_OR_INVALID',403);
 need(user.tenantId===null,'HANDOFF_TENANT_UNSUPPORTED',403);
 need(user.mfaState==='NONE','HANDOFF_MFA_UNSUPPORTED',403);
 need(finite(user.validSinceMs)&&finite(user.observedAt)&&user.observedAt<=s.now()&&s.now()-user.observedAt<30000,'HANDOFF_REVOCATION_UNVERIFIED',403);
 if(requireAuthTime)need(claims.auth_time*1000>=user.validSinceMs,'HANDOFF_IDENTITY_REVOKED',403);
 const cc=user.customClaims;
 need(plain(cc)&&cc.role==='admin'&&cc.companyId===c.companyId&&c.executiveEmails.includes(email(user.email)),'HANDOFF_EXECUTIVE_REQUIRED',403);
 need(claims.exp>Math.floor(s.now()/1000),'HANDOFF_TOKEN_TIME_INVALID',401);
 return {uid:user.uid,companyId:cc.companyId,email:email(user.email),email_verified:true,role:'admin',identityExpiresAt:claims.exp*1000,authorityObservedAt:user.observedAt,principalStateHash:Owner.principalStateHash(user)};
}
async function principal(s,c,authorization,now){
 if(s.ownerContext!==undefined){
  const actor=await Owner.readOwnerContext(s.ownerContext,authorization);
  need(actor?.companyId===c.companyId&&c.executiveEmails.includes(email(actor.email)),'HANDOFF_EXECUTIVE_REQUIRED',403);
  Owner.freshActor(actor,s.now());return actor;
 }
 return linkedGoogleAccount(s,c,authorization,now,true);
}
function freshPrincipal(actor,now){
 need(actor.identityExpiresAt>now,'HANDOFF_TOKEN_TIME_INVALID',401);
 need(actor.authorityObservedAt<=now&&now-actor.authorityObservedAt<30000,'HANDOFF_REVOCATION_UNVERIFIED',403);
}
function continuation(record,binding,actor,now){
 need(plain(record),'HANDOFF_CONTINUATION_REQUIRED');
 const copy={...record};delete copy.hash;
 const keys=['actorUid','caseId','companyId','dateKey','deadlineAt','firstPreparedAt','groupDigest','hash','jobId','messageId','nameUpExpected','phase','queueId','schema','selectionHash','sentVerifiedAt','sourceRevision','staffId'];
 need(Object.keys(record).sort().join('|')===keys.sort().join('|')&&record.schema==='LK_GAS_CREW_HANDOFF_GATE_V1'&&HEX.test(record.hash)&&record.hash===hash(copy),'HANDOFF_CONTINUATION_INVALID');
 need(record.phase==='SENT_VERIFIED','HANDOFF_SENT_RESULT_PENDING');
 for(const field of ['queueId','companyId','jobId','caseId','staffId','dateKey','sourceRevision','selectionHash'])need(record[field]===binding[field],'HANDOFF_CONTINUATION_CHANGED');
 need(record.actorUid===actor.uid&&binding.selectedBy===actor.uid&&record.nameUpExpected===binding.gas?.nameUpExpected,'HANDOFF_CONTINUATION_CHANGED');
 need(HEX.test(record.groupDigest)&&typeof record.messageId==='string'&&/^[a-z0-9_-]{1,160}$/i.test(record.messageId),'HANDOFF_SENT_EVIDENCE_REQUIRED');
 need(finite(record.firstPreparedAt)&&finite(record.deadlineAt)&&record.deadlineAt>record.firstPreparedAt&&record.deadlineAt-record.firstPreparedAt<=180000&&record.firstPreparedAt<=binding.selectedAt&&binding.selectedAt<=now&&now<record.deadlineAt,'HANDOFF_PREPARATION_EXPIRED');
 need(finite(record.sentVerifiedAt)&&record.sentVerifiedAt>=record.firstPreparedAt&&record.sentVerifiedAt<=now&&record.sentVerifiedAt<record.deadlineAt,'HANDOFF_SENT_EVIDENCE_INVALID');
 return record;
}
function createHandoff(s){
 need(s&&typeof s.now==='function','HANDOFF_SERVICES_REQUIRED',503);
 return Object.freeze({async handle(authorization,body){
  const c=s.config;settings(c);const request=input(body);const actor=await principal(s,c,authorization,s.now());
  const base={protocol:PROTOCOL,requestId:request.requestId,projectId:PROJECT,businessEnabled:false,diagnosticOnly:true,firebaseJwtEquivalent:false,effects:{...EFFECTS}};
  if(request.action==='READINESS_ONLY')return {...base,status:'AUTH_LINK_CHECKED'};
  need(c.allowOriginalReadback===true,'HANDOFF_GATE_DISABLED',503);
  need(await s.operational(actor.companyId)===true,'HANDOFF_GLOBAL_STOPPED');
  let snap;
  try{snap=await s.readOriginalGateSnapshot(request.queueId,actor);}catch{throw new Hold('HANDOFF_ORIGINAL_UNAVAILABLE');}
  const binding=snap?.binding;
  need(plain(binding)&&binding.queueId===request.queueId&&binding.caseId===request.caseId&&binding.selectionHash===request.selectionHash&&binding.gas?.nameUpExpected===request.nameUpExpected&&binding.companyId===actor.companyId&&binding.selectedBy===actor.uid,'HANDOFF_ORIGINAL_CHANGED');
  const record=continuation(snap.continuation,binding,actor,s.now());
  need(typeof s.verifySentEvidence==='function','HANDOFF_SENT_READER_REQUIRED');
  let observed;try{observed=await s.verifySentEvidence(record,binding,actor);}catch{throw new Hold('HANDOFF_SENT_READBACK_UNVERIFIED');}
  need(observed?.verified===true&&observed.messageId===record.messageId&&observed.groupDigest===record.groupDigest,'HANDOFF_SENT_READBACK_UNVERIFIED');
  // Re-read current authority after awaited external ports. No stale first read authorizes a next action.
  const fresh=await principal(s,c,authorization,s.now());need(fresh.uid===actor.uid&&fresh.companyId===actor.companyId,'HANDOFF_PRINCIPAL_CHANGED');
  need(await s.operational(fresh.companyId)===true,'HANDOFF_GLOBAL_STOPPED');
  let again;try{again=await s.readOriginalGateSnapshot(request.queueId,fresh);}catch{throw new Hold('HANDOFF_ORIGINAL_UNAVAILABLE');}
  continuation(again?.continuation,again?.binding,fresh,s.now());
  need(hash(again)===hash(snap),'HANDOFF_ORIGINAL_CHANGED');
  freshPrincipal(fresh,s.now());
  return {...base,status:'ORIGINAL_AND_SENT_OBSERVED',queueId:binding.queueId,caseId:binding.caseId,selectionHash:binding.selectionHash,diagnosticOnly:true};
 }});
}
function safeFailure(error){
 if(error instanceof Hold)return {status:error.status,body:{protocol:PROTOCOL,status:'HOLD',code:error.code,businessEnabled:false,effects:{...EFFECTS}}};
 return {status:503,body:{protocol:PROTOCOL,status:'HOLD',code:'HANDOFF_CHECK_UNAVAILABLE',businessEnabled:false,effects:{...EFFECTS}}};
}
module.exports={createHandoff,safeFailure,hash,PROTOCOL,validateContinuation:continuation};
// Identity only: missing auth_time is not converted to a user authentication
// time. This projection can read a bound server approval but cannot issue one.
module.exports.readVerifiedGoogleAccount=async function(s,authorization){
 settings(s.config);const actor=await linkedGoogleAccount(s,s.config,authorization,s.now(),false);freshPrincipal(actor,s.now());return actor;
};

// ISOLATED PROPOSAL ONLY. Internal callbacks are never supplied in HTTP input.
// Reauthenticate each stage; a READINESS_ONLY response is not a business grant.
module.exports.withFreshPrincipal=async function(s,authorization,operation){
 settings(s.config);
 const actor=await principal(s,s.config,authorization,s.now());
 freshPrincipal(actor,s.now());
 return operation(actor,()=>freshPrincipal(actor,s.now()));
};

