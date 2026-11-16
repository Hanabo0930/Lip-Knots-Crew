'use strict';
// Operation-scoped server evidence. It contains no token, raw Google subject or
// auth_time. The production caller must obtain actor from the real verifier.
const crypto=require('node:crypto');
const HEX=/^[a-f0-9]{64}$/,REVIEW=/^[a-f0-9]{48}$/,ID=/^[A-Za-z0-9_-]{1,200}$/;
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function canonical(x){if(x===null||typeof x==='string'||typeof x==='boolean')return JSON.stringify(x);if(typeof x==='number'&&Number.isFinite(x))return JSON.stringify(x);if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';need(plain(x),'OWNER_EVIDENCE_INVALID');return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';}
const hash=x=>crypto.createHash('sha256').update(canonical(x)).digest('hex');
const time=x=>Number.isSafeInteger(x)&&x>0;
const firebaseActors=new WeakSet();
// Called only at the real Firebase verifier boundary; never reconstructed from
// JSON or from the linked Google account projection.
function markFirebaseOwnerVerified(actor){need(plain(actor)&&HEX.test(actor.principalStateHash??''),'FIREBASE_OWNER_EVIDENCE_REQUIRED');firebaseActors.add(actor);return actor;}
function principalStateHash(user){
 const links=user?.providerData?.filter(x=>x?.providerId==='google.com');
 need(ID.test(user?.uid??'')&&typeof user.email==='string'&&user.emailVerified===true&&user.disabled===false&&user.tenantId===null&&user.mfaState==='NONE'&&time(user.validSinceMs)&&links?.length===1&&/^[0-9]{1,255}$/.test(links[0].uid??'')&&plain(user.customClaims)&&user.customClaims.role==='admin'&&ID.test(user.customClaims.companyId??''),'OWNER_AUTHORITY_UNVERIFIED');
 return hash([user.uid,user.email.trim().toLowerCase(),user.emailVerified,user.disabled,user.tenantId,user.mfaState,user.validSinceMs,links[0].uid,user.customClaims]);
}
function freshActor(actor,now){
 need(time(now)&&ID.test(actor?.uid??'')&&ID.test(actor.companyId??'')&&actor.role==='admin'&&actor.email_verified===true&&HEX.test(actor.principalStateHash??'')&&time(actor.identityExpiresAt)&&actor.identityExpiresAt>now&&time(actor.authorityObservedAt)&&actor.authorityObservedAt<=now&&now-actor.authorityObservedAt<30000,'OWNER_AUTHORITY_STALE');
}
function issueOwnerAuthorization({actor,reviewId,displayHash,bindingHash,viewCreatedAt,now}){
 need(actor&&firebaseActors.has(actor),'FIREBASE_OWNER_EVIDENCE_REQUIRED');
 freshActor(actor,now);need(REVIEW.test(reviewId??'')&&HEX.test(displayHash??'')&&HEX.test(bindingHash??'')&&time(viewCreatedAt)&&viewCreatedAt<=now&&now-viewCreatedAt<180000,'OWNER_REVIEW_EXPIRED_OR_CHANGED');
 const body={schema:'LK_CREW_FIREBASE_OWNER_APPROVAL_V1',reviewId,displayHash,actorUid:actor.uid,companyId:actor.companyId,verifiedAt:now,validUntil:Math.min(viewCreatedAt+180000,actor.identityExpiresAt),firebaseTokenExpiresAt:actor.identityExpiresAt,principalStateHash:actor.principalStateHash,bindingHash};
 return {...body,hash:hash(body)};
}
function approvalRecord(record){
 need(plain(record),'OWNER_APPROVAL_REQUIRED');
 const body={...record};delete body.hash;
 const keys=['schema','reviewId','displayHash','actorUid','companyId','verifiedAt','validUntil','firebaseTokenExpiresAt','principalStateHash','bindingHash','hash'].sort();
 need(Object.keys(record).sort().join('|')===keys.join('|')&&record.schema==='LK_CREW_FIREBASE_OWNER_APPROVAL_V1'&&HEX.test(record.hash??'')&&hash(body)===record.hash,'OWNER_APPROVAL_CORRUPT');
 need(REVIEW.test(record.reviewId??'')&&HEX.test(record.displayHash??'')&&HEX.test(record.bindingHash??'')&&time(record.verifiedAt)&&time(record.validUntil)&&record.verifiedAt<record.validUntil&&record.validUntil-record.verifiedAt<=180000&&time(record.firebaseTokenExpiresAt)&&record.validUntil<=record.firebaseTokenExpiresAt,'OWNER_APPROVAL_CORRUPT');return record;
}
function validateOwnerAuthorization(record,actor,now,expected){
 freshActor(actor,now);approvalRecord(record);
 need(record.actorUid===actor.uid&&record.companyId===actor.companyId&&record.principalStateHash===actor.principalStateHash,'OWNER_APPROVAL_AUTHORITY_CHANGED');
 need(time(record.verifiedAt)&&record.verifiedAt<=now&&time(record.validUntil)&&now<record.validUntil&&record.validUntil-record.verifiedAt<=180000&&time(record.firebaseTokenExpiresAt)&&record.validUntil<=record.firebaseTokenExpiresAt,'OWNER_APPROVAL_EXPIRED');
 need(REVIEW.test(record.reviewId??'')&&HEX.test(record.displayHash??'')&&HEX.test(record.bindingHash??''),'OWNER_APPROVAL_CORRUPT');
 if(expected)for(const k of ['reviewId','displayHash','bindingHash'])if(Object.hasOwn(expected,k))need(record[k]===expected[k],'OWNER_APPROVAL_BINDING_CHANGED');
 if(expected?.deadlineAt!==undefined)need(time(expected.firstPreparedAt)&&time(expected.deadlineAt)&&expected.deadlineAt-expected.firstPreparedAt===180000&&expected.firstPreparedAt<=now&&now<expected.deadlineAt,'ORIGINAL_PREPARATION_EXPIRED');
 return record;
}
function validateOwnerObservation(record,actor,now,expected){
 freshActor(actor,now);approvalRecord(record);
 need(record.actorUid===actor.uid&&record.companyId===actor.companyId,'OWNER_APPROVAL_AUTHORITY_CHANGED');
 if(expected)for(const k of ['reviewId','displayHash','bindingHash'])if(Object.hasOwn(expected,k))need(record[k]===expected[k],'OWNER_APPROVAL_BINDING_CHANGED');
 // History observation confers no business authority and never updates expiry,
 // the prior revocation fingerprint or the original preparation deadline.
 return record;
}
function reviewBindingHash(saved){need(saved?.body?.schema==='LK_CREW_OWNER_SEND_VIEW_V1'&&hash(saved.body)===saved.displayHash&&Array.isArray(saved.body.mail?.gasGroupsJson),'OWNER_REVIEW_CHANGED');return hash([saved.displayHash,saved.body.mail.fullReview,saved.body.mail.gasGroupsJson]);}
// Only server constructors can register an in-memory verifier. JSON/HTTP input
// cannot manufacture this context or turn a Google token into a Firebase token.
const contexts=new WeakMap();
function createOwnerContext(verify){need(typeof verify==='function','OWNER_CONTEXT_VERIFIER_REQUIRED');const context=Object.freeze({kind:'VERIFIED_OPERATION_OWNER_CONTEXT_V1'});contexts.set(context,verify);return context;}
async function readOwnerContext(context,authorization){const verify=context&&contexts.get(context);need(typeof verify==='function','OWNER_CONTEXT_INVALID');return verify(authorization);}
module.exports={hash,principalStateHash,freshActor,markFirebaseOwnerVerified,issueOwnerAuthorization,validateOwnerAuthorization,validateOwnerObservation,reviewBindingHash,createOwnerContext,readOwnerContext};
