'use strict';
// Reuse the real formal-confirmation/CAS core. The ticket records confirmation, never mail success.
const {createManualNameUpReview}=require('./case-list-manual-nameup-review.cjs');
const {hash,withFreshPrincipal}=require('./case-list-gas-handoff-core.cjs');
const Owner=require('./case-list-owner-authorization.cjs');
const need=(x,c)=>{if(!x)throw Object.assign(Error(c),{code:c});},clone=x=>JSON.parse(JSON.stringify(x));
function createFormalTicketService(p){
 async function current(authorization,actor){return withFreshPrincipal(p.auth,authorization,async a=>{need(a.uid===actor.uid&&a.companyId===actor.companyId,'FORMAL_OWNER_CHANGED');});}
 async function seed(authorization,gasPreview){
  need(gasPreview&&Array.isArray(gasPreview.selection)&&/^[a-f0-9]{64}$/.test(gasPreview.version||'')&&Array.isArray(gasPreview.groups),'FORMAL_MAIL_PREVIEW_REQUIRED');
  if(p.ownerAuthorization===true)need(Array.isArray(gasPreview.gasGroupsJson)&&gasPreview.gasGroupsJson.length===gasPreview.groups.length&&gasPreview.gasGroupsJson.every((x,i)=>{try{return typeof x==='string'&&x.length<=131072&&hash(JSON.parse(x))===hash(gasPreview.groups[i]);}catch(_){return false;}}),'OWNER_GROUP_BYTES_REQUIRED');
  return withFreshPrincipal(p.auth,authorization,async actor=>{const refs=await p.readManualRefs(gasPreview.selection,actor);return {actor,refs,gasPreview:clone(gasPreview)};});
 }
 function factory(authorization,context,reference){
  const fullReview={selection:context.gasPreview.selection,version:context.gasPreview.version};
  return createManualNameUpReview({isolatedProposal:true,auth:p.auth,store:p.store,viewSchema:p.ownerAuthorization===true?'LK_CREW_OWNER_SEND_VIEW_V1':undefined,viewMaxAgeMs:180000,now:p.now,operational:p.operational,
   readUnconfirmed:(actor,ref)=>p.readUnconfirmed(actor,ref,()=>current(authorization,actor)),
   prepareConfirmed:(actor,input)=>p.prepareConfirmed(actor,input,()=>current(authorization,actor)),
   previewNameUp:async views=>({review:{selection:fullReview.selection.filter(s=>views.some(v=>v.caseId===s.id)),version:fullReview.version},fullReview,gasGroups:context.gasPreview.groups,...(p.ownerAuthorization===true?{gasGroupsJson:context.gasPreview.gasGroupsJson}:{}),display:{groups:context.gasPreview.groups.map(({client,to,cc,subject,body,cases})=>({client,to,cc,subject,body,cases:cases.map(c=>c.id)}))}}),
   runBatch:async(_review,formal,actor)=>{
    need(reference&&formal.every(f=>f.actorUid===actor.uid&&f.companyId===actor.companyId),'FORMAL_REFERENCE_REQUIRED');
    if(p.ownerAuthorization!==true)return {status:'FORMAL_CONFIRMED_FOR_GAS',formalOnly:true,reference,mailSends:0,monthlyWrites:0};
    const saved=await p.store.read(reference.reviewId);need(saved?.displayHash===reference.displayHash&&hash(saved.body)===saved.displayHash,'OWNER_REVIEW_CHANGED');
    return withFreshPrincipal(p.auth,authorization,async fresh=>{need(fresh.uid===actor.uid&&fresh.companyId===actor.companyId,'FORMAL_OWNER_CHANGED');const ownerAuthorization=Owner.issueOwnerAuthorization({actor:fresh,reviewId:reference.reviewId,displayHash:reference.displayHash,bindingHash:bindingHash(saved),viewCreatedAt:saved.createdAt,now:p.now()});return {status:'OWNER_APPROVED_FOR_GAS',formalOnly:true,reference,ownerAuthorization,mailSends:0,monthlyWrites:0};});
   },
   observeBatch:async saved=>saved.result??{status:'HOLD',code:'FORMAL_RESULT_UNKNOWN',mailRetried:false}
  });
 }
 async function preview(authorization,payload){const context=await seed(authorization,payload.gasPreview);if(p.ownerAuthorization===true)need(context.refs.length===context.gasPreview.selection.length,'OWNER_ALL_CASES_REQUIRED');if(!context.refs.length)return {required:false,view:null};const view=await factory(authorization,context).preview(authorization,{cases:context.refs});return {required:true,view};}
 async function confirm(authorization,payload){
  const context=await seed(authorization,payload.gasPreview),request=payload.confirmation,reference={reviewId:request?.reviewId,displayHash:request?.displayHash};
  need(context.refs.length>0,'FORMAL_CASES_CHANGED');const out=await factory(authorization,context,reference).send(authorization,request);
  const expectedStatus=p.ownerAuthorization===true?'OWNER_APPROVED_FOR_GAS':'FORMAL_CONFIRMED_FOR_GAS';
  if(out.code==='REVIEW_ALREADY_DISPATCHED'&&out.result?.status===expectedStatus){
   const saved=await savedFor(reference,context.actor);await assertGroups(reference,context.gasPreview.groups,context.actor,{selection:context.gasPreview.selection,version:context.gasPreview.version});
   need(hash(request.payOffers)===hash(saved.formal.map(f=>({caseId:f.caseId,...f.input.manualConfirmation.payOffer}))),'FORMAL_PAY_CHANGED');
   const views=[];for(const old of saved.body.cases)views.push(await p.readUnconfirmed(context.actor,old.input,()=>current(authorization,context.actor)));
   need(hash(views)===hash(saved.body.cases),'FORMAL_SOURCE_CHANGED');await current(authorization,context.actor);
   return {...clone(saved.result),recoveredObservation:true};
  }
  need(out.status===expectedStatus&&out.formalOnly===true,'FORMAL_NOT_DISPATCHABLE');return out;
 }
 async function savedFor(reference,actor){
  need(reference&&/^[a-f0-9]{48}$/.test(reference.reviewId||'')&&/^[a-f0-9]{64}$/.test(reference.displayHash||''),'FORMAL_REFERENCE_REQUIRED');
  const status=p.ownerAuthorization===true?'OWNER_APPROVED_FOR_GAS':'FORMAL_CONFIRMED_FOR_GAS';
  const saved=await p.store.read(reference.reviewId);need(saved&&saved.body.actorUid===actor.uid&&saved.body.companyId===actor.companyId&&saved.displayHash===reference.displayHash&&hash(saved.body)===saved.displayHash&&saved.state==='RESULT_OBSERVED'&&saved.result?.status===status&&saved.result.formalOnly===true,'FORMAL_REFERENCE_CHANGED');
  if(p.ownerAuthorization===true)Owner.validateOwnerAuthorization(saved.result.ownerAuthorization,actor,p.now(),{reviewId:reference.reviewId,displayHash:reference.displayHash,bindingHash:bindingHash(saved)});
  need(Number.isSafeInteger(saved.at)&&saved.at<=p.now()&&p.now()-saved.at<180000,'FORMAL_CONFIRMATION_EXPIRED');return saved;
 }
 async function readFormal(caseId,actor,reference){if(!reference)return null;const saved=await savedFor(reference,actor),f=saved.formal?.find(x=>x.caseId===caseId);need(f&&f.confirmationIntent==='CONFIRM_DISPLAYED_AND_SEND'&&f.displayHash===reference.displayHash,'FORMAL_CASE_CHANGED');return clone(f);}
 async function assertGroups(reference,groups,actor,review){
  const saved=await savedFor(reference,actor);need(hash(saved.body.mail.gasGroups)===hash(groups)&&hash(saved.body.mail.fullReview)===hash({selection:review.selection,version:review.version}),'FORMAL_MAIL_CHANGED');
  if(p.ownerAuthorization===true)need(JSON.stringify(saved.body.mail.gasGroupsJson)===JSON.stringify(groups.map(g=>JSON.stringify(g))),'OWNER_GROUP_BYTES_CHANGED');
 }
 function bindingHash(saved){return Owner.reviewBindingHash(saved);}
 async function assertOwnerApproval(reference,groups,actor,review){need(p.ownerAuthorization===true,'OWNER_APPROVAL_SERVICE_REQUIRED');await assertGroups(reference,groups,actor,review);const saved=await savedFor(reference,actor);return {ownerApprovalRef:clone(reference),ownerAuthorizationHash:saved.result.ownerAuthorization.hash,ownerBindingHash:bindingHash(saved)};}
 return Object.freeze({preview,confirm,readFormal,assertGroups,assertOwnerApproval});
}
module.exports={createFormalTicketService};
