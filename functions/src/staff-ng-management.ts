import {Timestamp,FieldValue} from 'firebase-admin/firestore';
import {z} from 'zod';
import {createStaffNgDependencies} from './staff-ng-runtime-binding';
import {companyFromClaims,requireAdmin} from './utils';
import {assertProductionOperational} from './system-safety';
import * as maintenance from './staff-ng-maintenance';
import {ConfigSchema} from './staff-import';
import * as reader from './sheet-reader';import * as parser from './staff-parser';
type Data=Record<string,any>;
const Runtime=require('../src/private-ng/compose-runtime.cjs'),Wiring=require('../src/private-ng/crew-wiring.cjs'),Models=require('../src/private-ng/models.cjs');
const ID=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),OP=z.string().regex(/^[A-Za-z0-9_-]{8,120}$/);
const common={action:z.string(),staffIds:z.array(ID).min(1).max(10)};
const base=z.object(common).strict(),bound={...common,operationId:OP,generation:z.number().int().positive()};
const schemas:Record<string,z.ZodTypeAny>={
 'staff-ng-initialize':base,
 'staff-ng-drain':z.object({...common,operationId:OP,expiresAt:z.number().int().positive()}).strict(),
 'staff-ng-pause':z.object(bound).strict(),'staff-ng-review':z.object(bound).strict(),'staff-ng-abort':z.object(bound).strict(),
 'staff-ng-approve':z.object({...bound,expectedDraftHash:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.number().int().positive()}).strict(),
};
for(const action of ['apply','reconcile','rollback','resume'])schemas['staff-ng-'+action]=z.object({...bound,recordId:z.string().uuid()}).strict();
schemas['staff-ng-approve-rollback']=z.object({...bound,recordId:z.string().uuid(),expectedDraftHash:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.number().int().positive()}).strict();
function need(v:unknown,code:string):asserts v{if(!v)throw Object.assign(Error(code),{code});}
export async function handleStaffNgManagement(request:Data,passedSession?:Data){
 const session=requireAdmin(request);need(!passedSession||passedSession.uid===session.uid,'NG_CALLABLE_SESSION_CHANGED');
 const action=request.data?.action;need(typeof action==='string'&&Object.hasOwn(schemas,action),'NG_ACTION_UNSUPPORTED');const schema=schemas[action];need(schema,'NG_ACTION_UNSUPPORTED');const input=schema.parse(request.data) as Data;
 need(new Set(input.staffIds).size===input.staffIds.length,'NG_DUPLICATE_TARGETS');
 const deps=await createStaffNgDependencies(),{db,journalRef}=deps,scope={...deps.scope,staffIds:[...input.staffIds].sort()};
 need(db.projectId===scope.projectId&&companyFromClaims(session.token)===scope.companyId&&session.uid===scope.ownerUid&&journalRef?.firestore===db,'NG_SERVER_CALLABLE_SCOPE_CHANGED');
 return deps.withOwner(request,session,async(verified:Data,ownerRecheck:()=>Promise<void>)=>{
  const beforeCommit=async()=>{await ownerRecheck();await assertProductionOperational(scope.companyId);};
  need(verified.uid===scope.ownerUid&&verified.companyId===scope.companyId&&verified.role==='admin'&&verified.email_verified===true&&typeof verified.email==='string'&&typeof ownerRecheck==='function','NG_VERIFIED_OWNER_REQUIRED');
  const actor={uid:verified.uid,token:{role:verified.role,companyId:verified.companyId,email:verified.email,email_verified:true},beforeCommit};
  // Validate all target documents before any operation. No company inference.
  const profiles=await db.getAll(...scope.staffIds.map((id:string)=>db.collection('staffProfiles').doc(id)));
  need(profiles.every((p:any)=>p.exists&&p.data()?.companyId===scope.companyId),'NG_TARGET_COMPANY_CHANGED');
  const saved=(await journalRef.get()).data();need(saved?.schema==='LKC_NG_JOURNAL_V1','NG_EXISTING_JOURNAL_REQUIRED');
  await beforeCommit();
  if(action==='staff-ng-initialize'){await maintenance.initializeMaintenance(scope.companyId,actor);return {state:'OPEN'};}
  if(action==='staff-ng-drain'){need(input.expiresAt>deps.now()&&input.expiresAt<=verified.identityExpiresAt,'NG_DRAIN_DEADLINE_INVALID');const result=await maintenance.beginDrain(scope.companyId,actor,input);return {operationId:result.operationId,generation:result.generation};}
  const binding={operationId:input.operationId,generation:input.generation,ownerUid:verified.uid,staffIds:scope.staffIds};
  const control=(await db.collection('staffNgMaintenance').doc(scope.companyId).get()).data();
  need(control?.operationId===binding.operationId&&control.generation===binding.generation&&control.ownerUid===verified.uid&&JSON.stringify([...control.staffIds].sort())===JSON.stringify(scope.staffIds),'NG_CONTROL_SCOPE_CHANGED');
  if(action==='staff-ng-pause'){await maintenance.pauseWhenDrained(scope.companyId,actor,binding);return {state:'PAUSED'};}
  if(action==='staff-ng-abort'){await maintenance.abortUnchangedMaintenance(scope.companyId,actor,binding,journalRef);return {state:'OPEN',status:'ABORTED_UNCHANGED'};}
  if(input.recordId){const r=saved.records?.[input.recordId];need(r?.maintenanceBinding?.operationId===binding.operationId&&r.maintenanceBinding.generation===binding.generation&&r.maintenanceBinding.ownerUid===verified.uid&&JSON.stringify(r.members.map((m:any)=>m.plan.target.id).sort())===JSON.stringify(scope.staffIds),'NG_RECORD_SCOPE_CHANGED');}
  if(action==='staff-ng-resume'){await maintenance.resumeMaintenance(scope.companyId,actor,binding,journalRef,input.recordId);return {state:'OPEN'};}
  const config=(await db.collection('staffImportConfigs').doc(scope.companyId).get()).data();need(config?.companyId===scope.companyId&&typeof config.spreadsheetId==='string','NG_EXISTING_SOURCE_CONFIG_REQUIRED');
  Object.assign(scope,{spreadsheetId:config.spreadsheetId,maintenanceOperationId:binding.operationId,maintenanceGeneration:binding.generation});
  const sheets=await deps.getSheets(),crew={maintenance,staffConfig:{ConfigSchema},reader,parser,ng:Models.ng,identity:Models.identity};
  const owner=(operation:any)=>deps.withOwner(request,session,operation);
  const wiring=Wiring.createVerifiedCrewWiring({scope,crew,db,sheets,now:deps.now,owner});
  const runtime=Runtime.composeAuthorizedCore({db,journalRef,scope,crew,Timestamp,FieldValue,modelPins:Models.pins,now:deps.now,wiring,beforeCommit});
  if(action==='staff-ng-review')return runtime.review(scope.staffIds);
  const decision={action:action==='staff-ng-approve-rollback'?'ROLLBACK':'APPLY',companyId:scope.companyId,expectedDraftHash:input.expectedDraftHash,staffIds:scope.staffIds,expiresAt:input.expiresAt};
  if(action==='staff-ng-approve'){const draft=await runtime.review(scope.staffIds);return runtime.approve(draft,decision);}
  if(action==='staff-ng-approve-rollback')return runtime.approveRollback(input.recordId,decision);
  if(action==='staff-ng-apply')return runtime.apply(input.recordId);
  if(action==='staff-ng-reconcile')return runtime.reconcile(input.recordId);
  if(action==='staff-ng-rollback')return runtime.rollback(input.recordId);
  throw Error('NG_ACTION_UNSUPPORTED');
 });
}
