'use strict';
// Unregistered private RPC domain. GAS owns Gmail/Sheets execution; this side never dispatches them.
const crypto=require('node:crypto');
const {withFreshPrincipal,hash}=require('./case-list-gas-handoff-core.cjs');
const PROTOCOL='LK_CREW_SYNC_RPC_PROPOSAL_V1',HEX=/^[a-f0-9]{64}$/,CASE=/^LKCASE_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const clone=x=>JSON.parse(JSON.stringify(x)),need=(x,code)=>{if(!x)throw Object.assign(Error(code),{code});};
const codeOf=e=>/^[A-Z][A-Z0-9_]{1,100}$/.test(e.code||'')?e.code:'RPC_ACTION_HOLD';
function createRpcService(s){
 need(s?.isolatedProposal===true,'RPC_PROPOSAL_DISABLED');
 const pilotCaseId=s.pilotCaseId;
 const scoped=pilotCaseId!==undefined;
 need(!scoped||typeof pilotCaseId==='string'&&CASE.test(pilotCaseId),'RPC_PILOT_CASE_INVALID');
 const requireScope=matches=>need(matches,'RPC_PILOT_CASE_SCOPE_MISMATCH');
 const ids=(rows,key)=>Array.isArray(rows)?rows.map(row=>row?.[key]):null;
 const groupsIds=groups=>Array.isArray(groups)&&groups.every(group=>Array.isArray(group?.cases))
  ?ids(groups.flatMap(group=>group.cases),'id'):null;
 const single=list=>Array.isArray(list)&&list.length===1&&list[0]===pilotCaseId;
 const subset=list=>Array.isArray(list)&&(list.length===0||single(list));
 function checkOperation(r){
  if(!scoped)return r;
  requireScope(single(ids(r?.items,'caseId'))&&single(ids(r.review?.selection,'id'))&&
   single(ids(r.prepared?.cases,'id'))&&single(groupsIds(r.groups)));
  const item=r.items[0];
  for(const id of [item.eligible?.caseId,item.binding?.caseId,item.receipt?.caseId,r.pending?.caseId]){
   requireScope(id==null||id===pilotCaseId);
  }
  for(const list of [r.resumeCaseIds,r.nameUpReturnedSentIds,r.proposedSentReceipts===undefined?undefined:ids(r.proposedSentReceipts,'caseId')]){
   requireScope(list===undefined||subset(list));
  }
  return r;
 }
 function checkRequest(action,payload){
  if(!scoped)return;
  if(payload.caseId!==undefined)requireScope(payload.caseId===pilotCaseId);
  if(action==='TRANSFER_DISPATCH')requireScope(payload.caseId===pilotCaseId&&single(ids(payload.reprepared?.cases,'id')));
  if(action==='TRANSFER_BOUNDARY'||action==='RECONCILE')requireScope(payload.caseId===pilotCaseId);
  if(action==='BOUNDARY'||action==='SEND_BOUNDARY')requireScope(single(payload.caseIds));
  if(action==='SENT_RETURNED'||action==='PROTECT')requireScope(subset(payload.ids));
  if(action==='SENT_RETURNED')requireScope(subset(ids(payload.receipts,'caseId')));
 }
 const hydrate=r=>{if(r){need(Array.isArray(r.groupsJson)&&r.groupsJson.length===r.groups.length,'DURABLE_GROUP_BYTES_REQUIRED');const groups=r.groupsJson.map(x=>JSON.parse(x));need(hash(groups)===hash(r.groups),'DURABLE_GROUP_CHANGED');return {...r,groups};}return r;};
 const phases=new Set(['BEFORE_DRAFT_RECEIPT','BEFORE_GMAIL_DRAFT','BEFORE_MONTHLY_WRITE','BEFORE_MONTHLY_REPAIR','BEFORE_SOURCE_ARCHIVE']);
 const deadline=r=>need(Number.isSafeInteger(r.firstPreparedAt)&&r.deadlineAt-r.firstPreparedAt===180000&&r.firstPreparedAt<=s.now()&&s.now()<r.deadlineAt,'ORIGINAL_PREPARATION_EXPIRED');
 async function handle(authorization,q){
  need(q&&Object.keys(q).sort().join('|')==='action|operationKey|payload|protocol|requestId|sequence'&&q.protocol===PROTOCOL&&typeof q.requestId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(q.requestId)&&Number.isSafeInteger(q.sequence)&&q.payload&&typeof q.payload==='object'&&!Array.isArray(q.payload),'RPC_INPUT_INVALID');
  need(['READINESS_ONLY','FORMAL_PREVIEW','FORMAL_CONFIRM','BEGIN','BOUNDARY','SEND_BOUNDARY','SENT_RETURNED','PROTECT','TRANSFER_DISPATCH','TRANSFER_BOUNDARY','RECONCILE','OBSERVE','RESUME_READY'].includes(q.action)&&q.sequence>=0&&q.sequence<=64,'RPC_INPUT_INVALID');
  need(JSON.stringify(q).length<=131072,'RPC_REQUEST_TOO_LARGE');
  return withFreshPrincipal(s.auth,authorization,async actor=>{
   need(actor.permissionMode!=='observe-only'||q.action==='OBSERVE','OWNER_OBSERVATION_ONLY');
   need(await s.operational(actor.companyId)===true,'GLOBAL_STOPPED');
   async function authAgain(r){return withFreshPrincipal(s.auth,authorization,async current=>{need(current.uid===actor.uid&&current.companyId===actor.companyId&&r.actorUid===current.uid&&r.companyId===current.companyId,'OPERATION_OWNER_CHANGED');need(await s.operational(current.companyId)===true,'GLOBAL_STOPPED');return current;});}
   function response(key,r,status='OK',details={}){return {protocol:PROTOCOL,requestId:q.requestId,sequence:q.sequence,operationKey:key,actorUid:actor.uid,companyId:actor.companyId,deadlineAt:r.deadlineAt,checkedAt:s.now(),validUntil:Math.min(actor.identityExpiresAt,actor.authorityObservedAt+30000,r.deadlineAt||Number.MAX_SAFE_INTEGER),status,...details};}
   if(q.action==='READINESS_ONLY'){const keys=Object.keys(q.payload);need(q.sequence===0&&q.operationKey===''&&(keys.length===0||keys.join('|')==='ownerApprovalRef'&&s.auth.ownerContext!==undefined),'RPC_INPUT_INVALID');return response('',{},'READINESS_ONLY',{businessEnabled:false,effects:{mail:0,sheets:0,storage:0}});}
   if(q.action==='FORMAL_PREVIEW'||q.action==='FORMAL_CONFIRM'){
    if(scoped)requireScope(false);
    need(q.sequence===0&&q.operationKey===''&&s.formal,'FORMAL_SERVICE_REQUIRED');
    const out=q.action==='FORMAL_PREVIEW'?await s.formal.preview(authorization,q.payload):await s.formal.confirm(authorization,q.payload);
    await authAgain({actorUid:actor.uid,companyId:actor.companyId});return response('',{},'FORMAL_ONLY',{...out,businessEnabled:false});
   }
   need(s.requireOwnerAuthorization!==true||s.auth.ownerContext!==undefined,'OWNER_APPROVAL_CONTEXT_REQUIRED');
   checkRequest(q.action,q.payload);
   let key=q.operationKey,initial=null;
   if(q.action==='BEGIN'){
    const {review,prepared,groups}=q.payload;
    need(q.operationKey===''&&q.sequence===1&&review?.confirmedSend===true&&Object.keys(review).sort().join('|')==='confirmedSend|selection|version'&&HEX.test(review.version||'')&&Array.isArray(review.selection)&&review.selection.length>0&&review.selection.length<=5,'REVIEW_REQUIRED');
    need(review.selection.every(x=>CASE.test(x?.id||'')&&HEX.test(x.version||''))&&new Set(review.selection.map(x=>x.id.toLowerCase())).size===review.selection.length,'REVIEW_SELECTION_INVALID');
    if(scoped)requireScope(single(ids(review.selection,'id'))&&single(ids(prepared?.cases,'id'))&&single(groupsIds(groups)));
    key=hash([PROTOCOL,actor.companyId,actor.uid,review.selection.map(x=>x.id.toLowerCase()).sort()]);
    const found=await s.journal.read(key);
    if(found){checkOperation(found.payload);}
    else{
     need(s.requireOwnerAuthorization!==true||q.payload.formalReference&&s.formal?.assertOwnerApproval,'OWNER_APPROVAL_REQUIRED');
     const eligible=await s.readEligible(review.selection,actor,q.payload.formalReference),first=Date.parse(prepared?.preparedAt);
     need(prepared?.schema==='LK_NAMEUP_TRANSFER_V1'&&prepared.book===s.book&&prepared.actor===actor.email&&Array.isArray(prepared.cases)&&prepared.cases.length===review.selection.length&&eligible.length===prepared.cases.length,'PREPARED_ORIGINAL_CHANGED');
     need(Number.isSafeInteger(first)&&first<=s.now()&&s.now()-first<30000,'PREPARATION_TIME_INVALID');
     need(new Set(eligible.map(e=>e.caseId)).size===eligible.length&&new Set(eligible.map(e=>e.queueId)).size===eligible.length&&eligible.every(e=>e.companyId===actor.companyId&&e.queueId&&(e.a1Verified===true||e.manualPrepared===true)),'ORIGINAL_OR_MANUAL_PREPARATION_REQUIRED');
     need(Array.isArray(groups)&&groups.length>0&&groups.flatMap(g=>g.cases).length===prepared.cases.length,'PREPARED_GROUP_CHANGED');
     for(const p of prepared.cases){const e=eligible.find(x=>x.caseId===p.id),g=groups.find(x=>x.cases.some(c=>c.id===p.id));need(e&&g&&HEX.test(p.expected||'')&&p.nameUpDigest===s.groupDigest(g)&&p.date===e.dateKey&&p.staff===e.staffName&&p.client===e.client&&p.store===e.store&&review.selection.some(x=>x.id===p.id&&x.date===p.date),'PREPARED_ORIGINAL_CHANGED');}
     if(q.payload.formalReference){need(s.formal,'FORMAL_SERVICE_REQUIRED');await s.formal.assertGroups(q.payload.formalReference,groups,actor,review);}
     const ownerStamp=s.requireOwnerAuthorization===true?await s.formal.assertOwnerApproval(q.payload.formalReference,groups,actor,review):{};
     initial={schema:'LK_CREW_SYNC_GATE_PROPOSAL_V1',key,actorUid:actor.uid,companyId:actor.companyId,firstPreparedAt:first,deadlineAt:first+180000,review:clone(review),formalReference:q.payload.formalReference??null,...ownerStamp,prepared:clone(prepared),groups:clone(groups),groupsJson:groups.map(x=>JSON.stringify(x)),items:eligible.map(e=>({caseId:e.caseId,queueId:e.queueId,eligible:e,state:'PREPARED',sendOrdinal:0})),sequence:0,pending:null,last:null};
     checkOperation(initial);
    }
   }else need(HEX.test(key||''),'RPC_OPERATION_REQUIRED');
   if(q.action==='OBSERVE'){
    need(q.sequence===0,'RPC_OBSERVATION_ONLY');const found=await s.journal.read(key);need(found,'RPC_OPERATION_REQUIRED');const r=hydrate(checkOperation(found.payload));await authAgain(r);const items=[];
    for(const i of r.items){let accepted=false;if(i.binding){const out=await s.observeAccepted(clone(i),clone(r),actor);await authAgain(r);accepted=out?.status==='EXTERNAL_ALREADY_ACCEPTED'&&out.queueId===i.queueId;}items.push({caseId:i.caseId,queueId:i.queueId,state:accepted?'ACKED':i.state,display:r.prepared.cases.find(x=>x.id===i.caseId)});}
    const expired=s.now()>=r.deadlineAt,unstarted=r.items.filter(i=>i.state==='PROTECTED'&&r.nameUpReturnedSentIds?.includes(i.caseId)),resumeState=items.length&&items.every(i=>i.state==='ACKED')?'COMPLETED':expired?'ORIGINAL_APPROVAL_EXPIRED':unstarted.length?'CHECK_UNSTARTED_CONTINUATION':'UNKNOWN_RESULT_HOLD';
    return response(key,r,'OBSERVED',{items,unknown:!!r.pending,nextSequence:r.sequence+1,mailRetried:false,readOnly:true,resumeState});
   }
   if(scoped&&q.action!=='BEGIN'){
    const found=await s.journal.read(key);need(found,'RPC_OPERATION_REQUIRED');checkOperation(found.payload);
   }
   const owner=crypto.randomUUID(),lease=await s.journal.acquire(key,actor,owner,initial);let r;
   async function record(){const found=await s.journal.read(key);need(found?.lease?.owner===owner&&found.lease.expiresAt>s.now(),'JOURNAL_LEASE_LOST');return hydrate(checkOperation(found.payload));}
   async function save(){await s.journal.save(key,owner,r);need(hash(await record())===hash(r),'JOURNAL_READBACK_REQUIRED');}
   async function check(stage,ids){const held=await record();deadline(held);const current=await authAgain(held);need(await s.currentBoundary(clone(held),current,stage,ids)===true,'CURRENT_BOUNDARY_HOLD');if(['BEFORE_TRANSFER','BEFORE_MONTHLY_WRITE','BEFORE_MONTHLY_REPAIR','BEFORE_SOURCE_ARCHIVE','BEFORE_ACCEPTANCE'].includes(stage))for(const id of ids){const i=held.items.find(x=>x.caseId===id);need(i?.binding,'PROTECTED_RECORD_REQUIRED');const proof=await s.checkProtected(clone(i),clone(held),current,authorization);need(proof?.status==='ORIGINAL_AND_SENT_OBSERVED'&&proof.businessEnabled===false,'PROTECTED_READBACK_REQUIRED');}await authAgain(held);const after=await record();need(hash(held)===hash(after),'JOURNAL_CHANGED_DURING_BOUNDARY');deadline(after);}
   // Existing A1/A2/ACK handlers validate Source and their own company lease in their
   // precommit callback. This outer fence must not mistake that owned lease for a rival.
   async function operationGuard(){const held=await record();deadline(held);await authAgain(held);const after=await record();need(hash(held)===hash(after),'JOURNAL_CHANGED_DURING_BOUNDARY');deadline(after);}
   try{
    r=hydrate(checkOperation(lease.payload));
    await authAgain(r);const requestHash=hash(q);
    if(r.last?.sequence===q.sequence){need(r.last.requestHash===requestHash,'RPC_REPLAY_CHANGED');return response(key,r,'HOLD',{code:'RPC_REPLAY_OBSERVATION_ONLY'});}
    if(r.pending&&q.action==='RESUME_READY'){
     const old=clone(r.pending);
     if(old.action==='RECONCILE'&&old.caseId){const i=r.items.find(x=>x.caseId===old.caseId),seen=await s.observeAccepted(clone(i),clone(r),actor);await authAgain(r);need(seen?.status==='EXTERNAL_ALREADY_ACCEPTED'&&seen.queueId===i.queueId,'RPC_PREVIOUS_OUTCOME_UNKNOWN');i.state='ACKED';r.resolvedRequests=[...(r.resolvedRequests||[]),{...old,resolution:'ACCEPTANCE_OBSERVED',acceptanceHash:seen.acceptanceHash}];}
     else if(old.action==='RESUME_READY')r.resolvedRequests=[...(r.resolvedRequests||[]),{...old,resolution:'NO_BUSINESS_EFFECT_READY_STEP'}];
     else need(false,'RPC_PREVIOUS_OUTCOME_UNKNOWN');
     need(r.resolvedRequests.length<=8,'RPC_RECOVERY_LIMIT');r.pending=null;await save();
    }
    need(!r.pending,'RPC_PREVIOUS_OUTCOME_UNKNOWN');need(q.sequence===r.sequence+1,'RPC_SEQUENCE_CHANGED');deadline(r);
    r.sequence=q.sequence;r.pending={sequence:q.sequence,requestHash,action:q.action,caseId:q.payload.caseId??null};r.last=null;await save();
    try{
     if(q.action==='BEGIN'){
      need(lease.created,'RPC_OPERATION_ALREADY_STARTED');
      // Persistent case claims share the existing private journal abstraction. Expiry never deletes them.
      for(const item of r.items){const guardKey=hash(['LK_CREW_SYNC_CASE_GUARD_V1',r.companyId,item.caseId.toLowerCase()]),guardOwner=crypto.randomUUID(),g=await s.journal.acquire(guardKey,actor,guardOwner,{schema:'LK_CREW_SYNC_CASE_GUARD_V1',actorUid:actor.uid,companyId:actor.companyId,operationKey:key,firstPreparedAt:r.firstPreparedAt,deadlineAt:r.deadlineAt});try{need(g.payload.operationKey===key,'CASE_OPERATION_ALREADY_CLAIMED');}finally{await s.journal.release(guardKey,guardOwner);}}
      await check('BEFORE_DRAFT',r.items.map(x=>x.caseId));
     }else if(q.action==='RESUME_READY'){
      need(r.nameUpReturned===true,'SENT_RETURN_RESULT_UNRESOLVED');const ready=[];
      for(const id of r.nameUpReturnedSentIds){const i=r.items.find(x=>x.caseId===id);if(i.binding){const seen=await s.observeAccepted(clone(i),clone(r),actor);await authAgain(r);if(seen?.status==='EXTERNAL_ALREADY_ACCEPTED'&&seen.queueId===i.queueId){i.state='ACKED';continue;}need(seen?.status==='EXTERNAL_ACCEPTANCE_NOT_OBSERVED'&&seen.queueId===i.queueId,'ACCEPTANCE_OBSERVATION_REQUIRED');}
       need(i.state==='PROTECTED'&&i.binding,'UNKNOWN_TRANSFER_MUST_BE_OBSERVED');const mail=await s.observeMail(clone(i),clone(r),actor);need(mail.state==='SENT_VERIFIED'&&mail.digest===i.sent.digest&&mail.messageId===i.sent.messageId,'SENT_BINDING_CHANGED');await check('BEFORE_TRANSFER',[id]);ready.push(id);
      }
      need(ready.length>0,'NO_UNSTARTED_TRANSFER');r.resumeCaseIds=ready;
     }else if(q.action==='BOUNDARY'||q.action==='SEND_BOUNDARY'){
      const {caseIds,groupDigest}=q.payload,g=r.groups.find(x=>s.groupDigest(x)===groupDigest);
      need(g&&Array.isArray(caseIds)&&hash(caseIds.slice().sort())===hash(g.cases.map(x=>x.id).sort()),'GROUP_BINDING_CHANGED');
      const items=caseIds.map(id=>r.items.find(x=>x.caseId===id));need(items.every(Boolean),'CASE_UNKNOWN');
      if(q.action==='SEND_BOUNDARY'){
       const n=q.payload.ordinal;need([1,2].includes(n)&&items.every(i=>i.sendOrdinal===n-1&&['PREPARED','SEND_INTENT'].includes(i.state)&&i.draftStages?.includes('BEFORE_GMAIL_DRAFT')),'SEND_ALREADY_DISPATCHED');
       await check('BEFORE_GMAIL_SEND',caseIds);for(const i of items){i.sendOrdinal=n;i.state=n===1?'SEND_INTENT':'SEND_UNKNOWN';}
      }else{const stage=q.payload.stage;need(['BEFORE_DRAFT_RECEIPT','BEFORE_GMAIL_DRAFT'].includes(stage)&&items.every(i=>i.sendOrdinal===0),'DRAFT_STAGE_CHANGED');need(items.every(i=>!(i.draftStages||[]).includes(stage)&&(stage==='BEFORE_DRAFT_RECEIPT'||i.draftStages?.includes('BEFORE_DRAFT_RECEIPT'))),'DRAFT_STAGE_REPLAY');await check(stage,caseIds);for(const i of items)i.draftStages=[...(i.draftStages||[]),stage];}
     }else if(q.action==='SENT_RETURNED'){
      const ids=q.payload.ids;need(r.nameUpReturned!==true&&Array.isArray(ids)&&new Set(ids).size===ids.length&&ids.every(id=>r.items.some(i=>i.caseId===id&&i.state==='SEND_UNKNOWN')),'SENT_SUBSET_INVALID');
      const receipts=q.payload.receipts;need(Array.isArray(receipts)&&receipts.length===ids.length&&new Set(receipts.map(x=>x.caseId)).size===ids.length&&receipts.every(x=>ids.includes(x.caseId)&&HEX.test(x.digest||'')&&/^[a-z0-9_-]{1,160}$/i.test(x.messageId||'')),'SENT_RECEIPTS_REQUIRED');
     // Provisional, not verified: bind the exact IDs before the readonly Gmail
     // port can access metadata/body. No A1/A2 or SENT claim exists yet.
     r.proposedSentReceipts=clone(receipts);await save();
     for(const id of ids){const i=r.items.find(x=>x.caseId===id);i.receipt=clone(receipts.find(x=>x.caseId===id));const mail=await s.observeMail(clone(i),clone(r),actor);deadline(r);await authAgain(r);need(mail.state==='SENT_VERIFIED'&&mail.digest===r.prepared.cases.find(x=>x.id===id).nameUpDigest&&mail.messageId===i.receipt.messageId&&/^[a-z0-9_-]{1,160}$/i.test(mail.messageId||''),'SENT_READBACK_REQUIRED');i.sent=mail;i.state='SENT_VERIFIED';}
      r.nameUpReturned=true;r.nameUpReturnedSentIds=ids.slice();
     }else if(q.action==='PROTECT'){
      const ids=q.payload.ids;need(Array.isArray(ids)&&hash(ids)===hash(r.nameUpReturnedSentIds),'PROTECTION_SUBSET_CHANGED');
      for(const id of ids){const i=r.items.find(x=>x.caseId===id);need(i.state==='SENT_VERIFIED','PROTECTION_STATE_INVALID');i.state='PROTECTION_UNKNOWN';await save();
       await check('BEFORE_PROTECTION',[id]);const out=await s.protectSelection(clone(i),clone(r),actor,operationGuard);await authAgain(r);deadline(r);const b=out.binding;
       need(b.caseId===id&&b.queueId===i.queueId&&b.companyId===r.companyId&&b.selectedBy===actor.uid&&b.gas.nameUpExpected===r.prepared.cases.find(x=>x.id===id).expected,'ORIGINAL_BINDING_CHANGED');i.binding=b;if(out.eligible)i.eligible=out.eligible;i.state='PROTECTED';await save();
       await s.persistContinuation(clone(i),clone(r),actor,operationGuard);const seen=await s.checkProtected(clone(i),clone(r),actor,authorization);need(seen.status==='ORIGINAL_AND_SENT_OBSERVED'&&seen.businessEnabled===false,'PROTECTED_READBACK_REQUIRED');
      }
     }else if(q.action==='TRANSFER_DISPATCH'){
      const i=r.items.find(x=>x.caseId===q.payload.caseId),p=q.payload.reprepared,old=r.prepared.cases.find(x=>x.id===q.payload.caseId);need(i&&i.state==='PROTECTED'&&p?.cases?.length===1&&r.items.every(x=>!r.nameUpReturnedSentIds.includes(x.caseId)||x.binding),'ALL_ORIGINALS_MUST_BE_PROTECTED');
      const nowCase=p.cases[0];need(['id','date','staff','client','store','expected','nameUpDigest'].every(k=>nowCase[k]===old[k])&&Date.parse(p.preparedAt)>=r.firstPreparedAt&&Date.parse(p.preparedAt)<=s.now()&&Date.parse(p.preparedAt)<r.deadlineAt,'REPREPARATION_CHANGED');
      const earlier=r.nameUpReturnedSentIds.slice(0,r.nameUpReturnedSentIds.indexOf(i.caseId));need(earlier.every(id=>r.items.find(x=>x.caseId===id).state==='ACKED'),'WAITING_FOR_PRIOR_TRANSFER');await check('BEFORE_TRANSFER',[i.caseId]);i.state='TRANSFER_UNKNOWN';i.boundaryStages=[];
     }else if(q.action==='TRANSFER_BOUNDARY'){
      const i=r.items.find(x=>x.caseId===q.payload.caseId),stage=q.payload.stage;need(i&&i.state==='TRANSFER_UNKNOWN'&&phases.has(stage)&&stage.startsWith('BEFORE_')&&!stage.includes('DRAFT'),'TRANSFER_BOUNDARY_INVALID');need(!(i.boundaryStages||[]).includes(stage)&&!(i.boundaryStages||[]).includes('BEFORE_SOURCE_ARCHIVE')&&(stage==='BEFORE_MONTHLY_WRITE'||i.boundaryStages?.includes('BEFORE_MONTHLY_WRITE')),'TRANSFER_BOUNDARY_REPLAY');await check(stage,[i.caseId]);i.boundaryStages=[...(i.boundaryStages||[]),stage];
     }else if(q.action==='RECONCILE'){
      const i=r.items.find(x=>x.caseId===q.payload.caseId);need(i&&['TRANSFER_UNKNOWN','ACCEPTANCE_UNKNOWN'].includes(i.state),'ACCEPTANCE_STATE_INVALID');
      const known=await s.observeAccepted(clone(i),clone(r),actor);need(known?.queueId===i.queueId&&['EXTERNAL_ALREADY_ACCEPTED','EXTERNAL_ACCEPTANCE_NOT_OBSERVED'].includes(known.status),'ACCEPTANCE_OBSERVATION_REQUIRED');if(known.status!=='EXTERNAL_ALREADY_ACCEPTED'){need(i.state!=='ACCEPTANCE_UNKNOWN','ACK_OUTCOME_UNKNOWN');await check('BEFORE_ACCEPTANCE',[i.caseId]);i.state='ACCEPTANCE_UNKNOWN';await save();const out=await s.reconcile(clone(i),clone(r),actor,operationGuard);need(['EXTERNAL_READBACK_VERIFIED','EXTERNAL_ALREADY_ACCEPTED'].includes(out.status)&&out.queueId===i.queueId,'ACCEPTANCE_PENDING');}i.state='ACKED';
     }else need(false,'RPC_ACTION_INVALID');
     await authAgain(r);deadline(r);const details=q.action==='RESUME_READY'?{prepared:{...clone(r.prepared),cases:r.prepared.cases.filter(x=>r.resumeCaseIds.includes(x.id))},acceptedCaseIds:r.items.filter(i=>i.state==='ACKED').map(i=>i.caseId),pendingCaseIds:r.items.filter(i=>i.state!=='ACKED').map(i=>i.caseId),resumeCaseIds:r.resumeCaseIds}:{};
     const out=response(key,r,'OK',details);r.pending=null;r.last={sequence:q.sequence,requestHash,response:out};await save();return out;
    }catch(error){
     // The stage and any existing proofs survive. No side-effecting stage is automatically replayed.
     const out=response(key,r,'HOLD',{code:codeOf(error)});r.pending={sequence:q.sequence,requestHash,action:q.action,caseId:q.payload.caseId??null,code:codeOf(error)};r.last={sequence:q.sequence,requestHash,response:out};await save();return out;
    }
   }finally{await s.journal.release(key,owner);}
  });
 }
 return Object.freeze({handle});
}
module.exports={createRpcService,PROTOCOL};
