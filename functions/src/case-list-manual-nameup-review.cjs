'use strict';
// Private proposal factory; not an exported HTTP/callable or a live storage writer.
const crypto=require('node:crypto');
const {hash,withFreshPrincipal}=require('./case-list-gas-handoff-core.cjs');
const clone=x=>JSON.parse(JSON.stringify(x)),need=(x,c)=>{if(!x)throw Object.assign(Error(c),{code:c});};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join('|')===keys.sort().join('|');
function createManualNameUpReview(s){
 for(const name of ['readUnconfirmed','previewNameUp','prepareConfirmed','runBatch','observeBatch','now','operational'])need(typeof s[name]==='function','REVIEW_PORT_REQUIRED');
 need(s.isolatedProposal===true&&s.store&&typeof s.store.claim==='function','REVIEW_PROPOSAL_DISABLED');
 need(Number.isSafeInteger(s.viewMaxAgeMs)&&s.viewMaxAgeMs>0&&s.viewMaxAgeMs<=180000,'REVIEW_WINDOW_REQUIRED');
 const freshView=saved=>need(s.now()>=saved.createdAt&&s.now()-saved.createdAt<s.viewMaxAgeMs,'REVIEW_VIEW_EXPIRED');
 const auth=(authorization,fn)=>withFreshPrincipal(s.auth,authorization,async(actor,fresh)=>{need(await s.operational(actor.companyId)===true,'REVIEW_STOPPED');fresh();return fn(actor);});
 const sameActor=(a,b)=>need(a.uid===b.uid&&a.companyId===b.companyId,'REVIEW_PRINCIPAL_CHANGED');
 async function readAll(authorization,actor,refs){const views=[];for(const ref of refs){const v=await s.readUnconfirmed(actor,clone(ref));need(v.approvalCreated===false&&v.confirmedFields===null&&v.companyId===actor.companyId&&v.actorUid===actor.uid,'UNCONFIRMED_VIEW_REQUIRED');views.push(v);}await auth(authorization,fresh=>sameActor(actor,fresh));return views;}
 async function preview(authorization,request){
  need(exact(request,['cases'])&&Array.isArray(request.cases)&&request.cases.length>=1&&request.cases.length<=5&&new Set(request.cases.map(x=>x.jobId)).size===request.cases.length,'REVIEW_INPUT_INVALID');
  return auth(authorization,async actor=>{const views=await readAll(authorization,actor,request.cases),mail=await s.previewNameUp(views,actor);await auth(authorization,fresh=>sameActor(actor,fresh));need(exact(mail.review,['selection','version'])&&/^[a-f0-9]{64}$/.test(mail.review.version)&&mail.review.selection.length===views.length,'NAMEUP_PREVIEW_REQUIRED');
   need(s.viewSchema===undefined||s.viewSchema==='LK_CREW_OWNER_SEND_VIEW_V1','REVIEW_SCHEMA_UNSUPPORTED');
   const body={schema:s.viewSchema??'LK_CREW_MANUAL_SEND_VIEW_PROPOSAL_V1',actorUid:actor.uid,companyId:actor.companyId,cases:views,mail},id=crypto.randomBytes(24).toString('hex'),displayHash=hash(body);await s.store.create(id,{body,displayHash,createdAt:s.now(),state:'VIEW_ONLY',result:null});
   return {reviewId:id,displayHash,cases:views.map(v=>({caseId:v.caseId,...v.display})),mail:mail.display,approvalCreated:false};
  });
 }
 async function send(authorization,request){
  need(exact(request,['reviewId','displayHash','intent','payOffers','displayedCases','displayedMail'])&&/^[a-f0-9]{48}$/.test(request.reviewId??'')&&/^[a-f0-9]{64}$/.test(request.displayHash??'')&&request.intent==='CONFIRM_DISPLAYED_AND_SEND'&&Array.isArray(request.payOffers),'DISPLAYED_SEND_CONFIRMATION_REQUIRED');
  return auth(authorization,async actor=>{
   const saved=await s.store.read(request.reviewId);need(saved&&saved.body.actorUid===actor.uid&&saved.body.companyId===actor.companyId&&saved.displayHash===request.displayHash&&hash(saved.body)===saved.displayHash,'REVIEW_CHANGED');
   need(hash(request.displayedCases)===hash(saved.body.cases.map(v=>({caseId:v.caseId,...v.display})))&&hash(request.displayedMail)===hash(saved.body.mail.display),'DISPLAYED_VALUES_CHANGED');
   if(saved.state!=='VIEW_ONLY'){const result=await s.observeBatch(clone(saved),actor);await auth(authorization,fresh=>sameActor(actor,fresh));return {status:'HOLD',code:'REVIEW_ALREADY_DISPATCHED',reviewId:request.reviewId,mailRetried:false,result};}
   freshView(saved);
   const views=await readAll(authorization,actor,saved.body.cases.map(v=>v.input));freshView(saved);need(hash(views)===hash(saved.body.cases),'DISPLAYED_SOURCE_CHANGED');
   const mail=await s.previewNameUp(views,actor);freshView(saved);need(hash(mail)===hash(saved.body.mail),'DISPLAYED_MAIL_CHANGED');
   const offers=request.payOffers;need(offers.length===views.length&&new Set(offers.map(o=>o.caseId)).size===offers.length,'PAY_CONFIRMATION_REQUIRED');
   const formal=[];for(const view of views){const offer=offers.find(o=>o.caseId===view.caseId);need(exact(offer,['caseId','dailyWageJPY','travelExpenses','communicationExpenses'])&&offer.dailyWageJPY===view.display.dailyWageJPY&&Number.isSafeInteger(offer.dailyWageJPY)&&offer.travelExpenses==='全額支給'&&offer.communicationExpenses==='全額支給','DISPLAYED_PAY_CHANGED');
    const {caseId,...payOffer}=offer;const input={...view.input,clientNameUpConfirmed:false,manualConfirmation:{confirmedFields:{arrival:true,execution:true,headcount:true,dateMode:true,payOffer:true},payOffer}};
    const prepared=await s.prepareConfirmed(actor,clone(input));freshView(saved);const preparedStatus=prepared.status==='MANUAL_PREPARED_ONLY'||saved.body.schema==='LK_CREW_OWNER_SEND_VIEW_V1'&&view.origin==='CREW_APPLICATION'&&prepared.status==='OWNER_PREPARED_ONLY';need(preparedStatus&&prepared.sourceWritableHash===view.sourceWritableHash&&prepared.observedValuesHash===view.observedValuesHash&&/^[a-f0-9]{64}$/.test(view.dependencyHash??'')&&prepared.dependencyHash===view.dependencyHash,'CONFIRMED_PREPARATION_CHANGED');formal.push({caseId,actorUid:actor.uid,companyId:actor.companyId,input,displayHash:request.displayHash,confirmationIntent:request.intent});
   }
   await auth(authorization,fresh=>sameActor(actor,fresh));freshView(saved);
   const claimed=await s.store.claim(request.reviewId,{actorUid:actor.uid,companyId:actor.companyId,displayHash:request.displayHash,formal,state:'DISPATCHING',at:s.now()});
   if(!claimed)return {status:'HOLD',code:'REVIEW_ALREADY_DISPATCHED',reviewId:request.reviewId,mailRetried:false};
   let result;try{await auth(authorization,fresh=>sameActor(actor,fresh));freshView(saved);result=await s.runBatch({...clone(mail.review),confirmedSend:true},clone(formal),actor);await s.store.finish(request.reviewId,'RESULT_OBSERVED',clone(result));}
   catch(error){const current=await s.store.read(request.reviewId);if(current?.state==='DISPATCHING')await s.store.finish(request.reviewId,'RESULT_UNKNOWN',null);throw error;}
   await auth(authorization,fresh=>sameActor(actor,fresh));return {reviewId:request.reviewId,...result};
  });
 }
 return Object.freeze({preview,send});
}
module.exports={createManualNameUpReview};
