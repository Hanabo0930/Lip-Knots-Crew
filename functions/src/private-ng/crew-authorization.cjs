'use strict';
const {randomUUID}=require('node:crypto');const {hash}=require('./planner.cjs');const {need}=require('./timestamp.cjs');
function createCrewAuthorize({scope,owner,now}){
  async function authorize({action,draft,decision}){
    need(['APPLY','ROLLBACK'].includes(action),'NG_ACTION_UNSUPPORTED');
    need(draft?.schema==='LKC_NG_DRAFT_V1'&&draft.companyId===scope.companyId&&Array.isArray(draft.members),'NG_DRAFT_SCOPE_REQUIRED');
    const ids=draft.members.map(m=>m.plan?.target?.id);
    need(hash(ids)===hash([...scope.staffIds].sort()),'NG_DRAFT_TARGETS_CHANGED');
    const stable={schema:draft.schema,environment:draft.environment,companyId:draft.companyId,members:draft.members.map(m=>({key:m.key,stamp:m.stamp,version:m.version}))};
    need(hash(stable)===draft.draftHash,'NG_DRAFT_TAMPERED');
    need(decision&&Object.keys(decision).sort().join('|')==='action|companyId|expectedDraftHash|expiresAt|staffIds'&&decision.action===action&&decision.companyId===scope.companyId&&decision.expectedDraftHash===draft.draftHash&&hash(decision.staffIds)===hash(ids),'EXACT_NG_CONFIRMATION_REQUIRED');
    need(Number.isSafeInteger(decision.expiresAt)&&decision.expiresAt>now(),'NG_CONFIRMATION_EXPIRED');
    return owner(async(actor,beforeReturn)=>{
      await beforeReturn();const issuedAt=now(),expiresAt=Math.min(decision.expiresAt,actor.identityExpiresAt);
      need(expiresAt>issuedAt&&actor.companyId===scope.companyId&&actor.uid===scope.ownerUid,'NG_OWNER_CHANGED_OR_EXPIRED');
      return {approvalId:randomUUID(),subject:actor.uid,action,companyId:scope.companyId,draftHash:draft.draftHash,staffIds:ids,issuedAt,expiresAt};
    });
  }

return authorize;}
module.exports={createCrewAuthorize};
