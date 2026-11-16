'use strict';
const {randomUUID}=require('node:crypto');
const {hash}=require('./planner.cjs');
const {need,iso,casVersion,equal}=require('./timestamp.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
const field=data=>Object.hasOwn(data,'ngCompanies')?{present:true,value:data.ngCompanies}:{present:false};
const nonNg=data=>Object.fromEntries(Object.entries(data).filter(([k])=>k!=='ngCompanies'));
const stamp=p=>hash({target:p.target,changes:p.changes,preconditions:p.preconditions,preservation:p.preservation,review:p.review,rollback:p.rollback});
// All external dependencies are explicit; no SDK initialization, network discovery or CLI.
// authorize/checkEnvironment/readInput must be wired to the existing protected owner route.
function createRuntime({planner,profiles,store,readInput,checkEnvironment,authorize,maintenanceBinding,clock=Date.now}){
  need(maintenanceBinding&&typeof maintenanceBinding.operationId==='string'&&Number.isSafeInteger(maintenanceBinding.generation)&&maintenanceBinding.generation>0&&typeof maintenanceBinding.ownerUid==='string','EXPLICIT_MAINTENANCE_BINDING_REQUIRED');
  need([readInput,checkEnvironment,authorize,clock].every(x=>typeof x==='function'),'PROTECTED_PORTS_REQUIRED');
  function time(){const t=clock();need(Number.isSafeInteger(t),'INVALID_CLOCK');return t;}
  async function environment(){const e=await checkEnvironment();need(e?.ownerEnabled===true&&e.applicationsStopped===true&&e.legacyWritersFenced===true&&typeof e.companyId==='string'&&typeof e.scopeRevision==='string'&&e.scopeRevision.length>0,'ENVIRONMENT_NOT_FENCED');return e;}
  async function snapshot(id){
    const input=await readInput(id),current=await profiles.read(id);
    current.updateTime=casVersion(current.updateTime);
    const forPlanner={...input,current:{...current,updateTime:iso(current.updateTime)}};
    const p=planner.propose(forPlanner);need(['PROPOSAL','NOOP'].includes(p.status),'CURRENT_INPUT_HELD_'+p.reason);
    const now=time();need(Date.parse(input.source.observedAt)<=now&&Date.parse(input.source.recheckedAt)<=now,'SOURCE_TIME_IN_FUTURE');
    return {plan:p,current};
  }
  async function review(ids){
    need(Array.isArray(ids)&&ids.length>0&&ids.length<=10&&new Set(ids).size===ids.length,'EXACT_BOUNDED_TARGET_SET_REQUIRED');
    const e=await environment(),members=[];
    for(const id of [...ids].sort()){
      const {plan,current}=await snapshot(id);need(plan.target.companyId===e.companyId,'ENVIRONMENT_COMPANY_MISMATCH');
      members.push({key:plan.target.companyId+'/'+id,plan,stamp:stamp(plan),version:current.updateTime,prior:field(current.data),nonNgHash:hash(nonNg(current.data)),value:plan.changes[0]?.value??current.data.ngCompanies,state:plan.status==='NOOP'?'NOOP':'UNTOUCHED'});
    }
    const stable={schema:'LKC_NG_DRAFT_V1',environment:hash(e),companyId:e.companyId,members:members.map(m=>({key:m.key,stamp:m.stamp,version:m.version}))};
    return {...stable,members,draftHash:hash(stable)};
  }
  function checkGrant(grant,draft,action){
    const now=time();need(grant&&typeof grant.approvalId==='string'&&grant.approvalId.length>0&&typeof grant.subject==='string'&&grant.subject.length>0&&grant.action===action&&grant.draftHash===draft.draftHash&&grant.companyId===draft.companyId,'EXACT_OWNER_APPROVAL_REQUIRED');
    need(Number.isSafeInteger(grant.issuedAt)&&Number.isSafeInteger(grant.expiresAt)&&now>=grant.issuedAt&&now<grant.expiresAt,'APPROVAL_EXPIRED_OR_CLOCK_REVERSED');
    need(hash(grant.staffIds)===hash(draft.members.map(m=>m.plan.target.id)),'APPROVAL_TARGETS_CHANGED');
  }
  async function gate(r,action){
    const g=action==='ROLLBACK'?r.rollbackApproval:r.approval;checkGrant(g,r,action);
    const e=await environment();need(hash(e)===r.environment,'ENVIRONMENT_CHANGED');checkGrant(g,r,action);
  }
  async function approve(draft,decision){
    const fresh=await review(draft.members.map(m=>m.plan.target.id));need(fresh.draftHash===draft.draftHash,'DRAFT_CHANGED');
    const approval=await authorize({action:'APPLY',draft:clone(fresh),decision});checkGrant(approval,fresh,'APPLY');
    const record={...fresh,id:randomUUID(),approval:clone(approval),maintenanceBinding:clone(maintenanceBinding),status:'APPROVED'};
    await gate(record,'APPLY');return store.create(record);
  }
  async function save(r,fn){return store.change(r.id,r.revision,fn);}
  async function verifyApplied(r,m,restore,authorityAction=restore?'ROLLBACK':'APPLY'){
    const current=await profiles.read(m.plan.target.id);
    need(equal(current.updateTime,restore?m.restoredVersion:m.appliedVersion),'READBACK_VERSION_MISMATCH');
    need(hash(field(current.data))===hash(restore?m.prior:{present:true,value:m.value}),'READBACK_NG_MISMATCH');
    need(hash(nonNg(current.data))===m.nonNgHash,'NON_NG_CHANGED');
    const input=await readInput(m.plan.target.id);
    const {sourceVersion}=require('./planner.cjs');
    need(sourceVersion(input.source,input.config)===m.plan.preconditions.sourceVersion&&hash(input.config)===m.plan.preconditions.configHash,'SOURCE_CHANGED_AFTER_WRITE');
    await gate(r,authorityAction);
  }
  async function run(id,restore=false){
    let r=await store.read(id);const action=restore?'ROLLBACK':'APPLY';await gate(r,action);
    need(!r.members.some(m=>['INTENT','UNKNOWN','ROLLBACK_INTENT','ROLLBACK_UNKNOWN'].includes(m.state)),'UNRESOLVED_RESULT_RECONCILE_ONLY');
    if(!restore)need(r.status==='APPROVED','OPERATION_NOT_APPLYABLE');
    else need(r.status==='ROLLBACK_APPROVED','ROLLBACK_NOT_APPROVED');
    // Atomic journal claim prevents two processes/runners from dispatching the same batch.
    r=await save(r,x=>({...x,status:restore?'ROLLING_BACK':'RUNNING'}));
    for(let i=0;i<r.members.length;i++){
      let m=r.members[i];if(restore?m.state!=='APPLIED':m.state!=='UNTOUCHED')continue;
      let dispatched=false,acked=false;
      try{
        await gate(r,action);
        if(restore)await verifyApplied(r,m,false,'ROLLBACK');
        else {const fresh=await snapshot(m.plan.target.id);need(stamp(fresh.plan)===m.stamp&&equal(fresh.current.updateTime,m.version),'CURRENT_SNAPSHOT_CHANGED');}
        await gate(r,action);
        r=await save(r,x=>{x.members[i].state=restore?'ROLLBACK_INTENT':'INTENT';return x;});
        // After any awaited journal/source/authority work the exact grant is checked again.
        await gate(r,action);
        if(!restore){const fresh=await snapshot(m.plan.target.id);need(stamp(fresh.plan)===m.stamp&&equal(fresh.current.updateTime,m.version),'CURRENT_SNAPSHOT_CHANGED');}
        else await verifyApplied(r,m,false,'ROLLBACK');
        await gate(r,action);
        dispatched=true;
        const ack=await profiles.update(m.plan.target.id,restore?m.appliedVersion:m.version,restore?m.prior:{present:true,value:m.value});
        const version=casVersion(ack.updateTime);acked=true;
        r=await save(r,x=>{x.members[i][restore?'restoredVersion':'appliedVersion']=version;x.members[i].state=restore?'ROLLBACK_ACK':'ACK';return x;});
        m=r.members[i];await verifyApplied(r,m,restore);
        r=await save(r,x=>{x.members[i].state=restore?'ROLLED_BACK':'APPLIED';return x;});
      }catch(e){
        // Any dispatched failure (including CAS error) stays unknown: no unsafe error-code inference.
        // If ACK persistence itself failed, durable INTENT remains, retaining the lock.
        try{r=await store.read(id);r=await save(r,x=>{x.status='HOLD';const durableAck=acked&&x.members[i][restore?'restoredVersion':'appliedVersion'];x.members[i].state=dispatched?(durableAck?(restore?'ROLLBACK_ACK':'ACK'):(restore?'ROLLBACK_UNKNOWN':'UNKNOWN')):(restore?'ROLLBACK_HELD':'HELD');x.members[i].reason=String(e.code??'PORT_FAILURE');return x;});}catch{}
        return store.read(id);
      }
    }
    return save(r,x=>({...x,status:restore?'ROLLED_BACK':'COMPLETE'}));
  }
  async function approveRollback(id,decision){
    let r=await store.read(id);need(r.members.some(m=>m.state==='APPLIED')&&r.members.every(m=>['APPLIED','NOOP','UNTOUCHED','HELD'].includes(m.state)),'UNRESOLVED_RESULT_RECONCILE_ONLY');
    const approval=await authorize({action:'ROLLBACK',draft:clone(r),decision});checkGrant(approval,r,'ROLLBACK');
    r=await save(r,x=>({...x,rollbackApproval:clone(approval),status:'ROLLBACK_APPROVED'}));return r;
  }
  async function reconcile(id){
    let r=await store.read(id);
    // No writes to profiles, no inference of ownership from matching values.
    for(let i=0;i<r.members.length;i++){
      const m=r.members[i];if(!['ACK','ROLLBACK_ACK'].includes(m.state))continue;
      try{await verifyApplied(r,m,m.state==='ROLLBACK_ACK');r=await save(r,x=>{x.members[i].state=m.state==='ACK'?'APPLIED':'ROLLED_BACK';return x;});}catch{/* retain held evidence */}
    }
    return r;
  }
  return {review,approve,apply:id=>run(id),approveRollback,rollback:id=>run(id,true),reconcile};
}
module.exports={createRuntime};
