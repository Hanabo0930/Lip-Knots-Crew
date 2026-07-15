import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { z } from "zod";
import { db } from "./firebase";
import { enqueueNotification } from "./notification-core";
import {
  buildProductionCutoverTimeline,
  defaultProductionCutoverThresholds,
  evaluateProductionCutover,
  ProductionCutoverEvaluation,
  ProductionCutoverObservation,
  ProductionCutoverReadiness,
  ProductionCutoverThresholds,
} from "./production-cutover-core";
import { companyFromClaims, normalizeEmail, requireAdmin, requestId } from "./utils";
import { incrementProductionMetrics } from "./production-metrics";

const CreateSchema=z.object({
  releaseId:z.string().min(1).max(160),
  windowStartIso:z.iso.datetime({offset:true}),
});
const ReadinessSchema=z.object({
  runId:z.string().min(1).max(160),
  changeFreezeConfirmed:z.boolean(),backupReferenceReady:z.boolean(),rollbackOwnerAssigned:z.boolean(),
  monitoringDashboardsReady:z.boolean(),incidentChannelReady:z.boolean(),supportRosterReady:z.boolean(),
  smokePlanReady:z.boolean(),migrationOwnerAssigned:z.boolean(),
  evidenceRefs:z.array(z.string().min(1).max(500).refine(value=>!/[\r\n\0]/u.test(value),"証跡参照が不正です。")).min(3).max(40),
});
const ObservationSchema=z.object({
  runId:z.string().min(1).max(160),observedAtIso:z.iso.datetime({offset:true}),
  authenticationAttempts:z.number().int().min(0),authenticationFailures:z.number().int().min(0),
  callableRequests:z.number().int().min(0),callableFailures:z.number().int().min(0),p95LatencyMs:z.number().min(0).max(120_000),
  sheetWriteFailures:z.number().int().min(0),notificationFailures:z.number().int().min(0),queueBacklog:z.number().int().min(0),
  smokeFailures:z.number().int().min(0),dataMismatchCount:z.number().int().min(0),criticalIncidentCount:z.number().int().min(0),monitoringProbeFailures:z.number().int().min(0),
  evidenceRefs:z.array(z.string().min(1).max(500).refine(value=>!/[\r\n\0]/u.test(value),"証跡参照が不正です。")).min(2).max(40),
});
const IdSchema=z.object({runId:z.string().min(1).max(160).optional()});
const RequiredIdSchema=z.object({runId:z.string().min(1).max(160)});
const RollbackSchema=RequiredIdSchema.extend({reason:z.string().min(10).max(1000),confirmation:z.literal("LOCK_AND_START_ROLLBACK")});
const CancelSchema=RequiredIdSchema.extend({reason:z.string().min(10).max(1000)});

type ProductionCutoverRun={
  companyId?:string;releaseId?:string;approvalPackageId?:string|null;status?:string;windowStartMs?:number;
  readiness?:ProductionCutoverReadiness;readinessEvidenceRefs?:string[];thresholds?:ProductionCutoverThresholds;
  timeline?:ReturnType<typeof buildProductionCutoverTimeline>;lastObservation?:ProductionCutoverObservation|null;
  consecutiveHealthyObservations?:number;gate?:ProductionCutoverEvaluation;action?:string;phase?:string;
  createdBy?:string;createdAt?:Timestamp;updatedAt?:Timestamp;completedAt?:Timestamp;cancelledAt?:Timestamp;
  productionEnabledAt?:Timestamp;rollbackStartedAt?:Timestamp;rollbackReason?:string;lastAlertAt?:Timestamp;lastAlertFingerprint?:string;
};

const blankReadiness:ProductionCutoverReadiness={
  signedApprovalReady:false,changeFreezeConfirmed:false,backupReferenceReady:false,rollbackOwnerAssigned:false,
  monitoringDashboardsReady:false,incidentChannelReady:false,supportRosterReady:false,smokePlanReady:false,migrationOwnerAssigned:false,
};

export const getProductionCutoverStatus=onCall(async request=>{
  const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const input=IdSchema.parse(request.data??{});
  const snap=await findRun(companyId,input.runId);
  return {cutover:snap?safeRun(snap.id,snap.data() as ProductionCutoverRun):null};
});

export const createProductionCutover=onCall(async request=>{
  assertProductionRuntime();
  const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const input=CreateSchema.parse(request.data??{});
  const windowStartMs=Date.parse(input.windowStartIso);const nowMs=Date.now();
  if(!Number.isSafeInteger(windowStartMs)||windowStartMs<nowMs-15*60_000||windowStartMs>nowMs+24*60*60_000)throw new HttpsError("invalid-argument","切替予定は15分前〜24時間後で指定してください。");
  const controlRef=db.collection("productionCutoverControls").doc(companyId);const productionControl=await db.collection("productionControls").doc(companyId).get();
  if(productionControl.data()?.emergencyLock===true)throw new HttpsError("failed-precondition","全体停止ロック中は切替指揮盤を開始できません。");
  const approval=await resolveApproval(companyId,String(productionControl.data()?.pendingApprovalPackageId??productionControl.data()?.activeApprovalPackageId??""),input.releaseId);
  const readiness={...blankReadiness,signedApprovalReady:Boolean(approval)};const thresholds=defaultProductionCutoverThresholds();
  const gate=evaluateProductionCutover({windowStartMs,nowMs,productionActive:false,readiness,readinessEvidenceRefs:[],observation:null,consecutiveHealthyObservations:0,thresholds});
  const ref=db.collection("productionCutoverRuns").doc();const now=Timestamp.now();
  await db.runTransaction(async tx=>{const control=await tx.get(controlRef);if(control.data()?.activeRunId)throw new HttpsError("already-exists","進行中の本番切替指揮盤があります。");tx.create(ref,{companyId,releaseId:input.releaseId.trim(),approvalPackageId:approval?.id??null,status:"preparing",windowStartMs,readiness,readinessEvidenceRefs:[],thresholds,timeline:buildProductionCutoverTimeline(),lastObservation:null,consecutiveHealthyObservations:0,gate,action:gate.action,phase:gate.phase,createdBy:session.uid,createdAt:now,updatedAt:now});tx.set(controlRef,{companyId,activeRunId:ref.id,updatedAt:now},{merge:true});tx.set(db.collection("auditLogs").doc(),{companyId,actorUid:session.uid,action:"production_cutover.created",runId:ref.id,releaseId:input.releaseId.trim(),windowStartMs,requestId:requestId("production_cutover"),createdAt:now});});
  return {runId:ref.id,status:"preparing",gate,timeline:buildProductionCutoverTimeline()};
});

export const saveProductionCutoverReadiness=onCall(async request=>{
  assertProductionRuntime();
  const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const input=ReadinessSchema.parse(request.data??{});const ref=db.collection("productionCutoverRuns").doc(input.runId);const snap=await ref.get();
  if(!snap.exists||snap.data()?.companyId!==companyId)throw new HttpsError("not-found","本番切替指揮盤が見つかりません。");const run=snap.data() as ProductionCutoverRun;assertMutable(run);
  const productionControl=await db.collection("productionControls").doc(companyId).get();const approvalId=String(productionControl.data()?.pendingApprovalPackageId??productionControl.data()?.activeApprovalPackageId??run.approvalPackageId??"");const approval=await resolveApproval(companyId,approvalId,String(run.releaseId??""));
  const readiness:ProductionCutoverReadiness={signedApprovalReady:Boolean(approval),changeFreezeConfirmed:input.changeFreezeConfirmed,backupReferenceReady:input.backupReferenceReady,rollbackOwnerAssigned:input.rollbackOwnerAssigned,monitoringDashboardsReady:input.monitoringDashboardsReady,incidentChannelReady:input.incidentChannelReady,supportRosterReady:input.supportRosterReady,smokePlanReady:input.smokePlanReady,migrationOwnerAssigned:input.migrationOwnerAssigned};
  const gate=evaluateRun({...run,readiness,readinessEvidenceRefs:input.evidenceRefs,approvalPackageId:approval?.id??run.approvalPackageId},Date.now(),Number(run.consecutiveHealthyObservations??0));const status=statusFor(gate);const now=Timestamp.now();
  await ref.set({approvalPackageId:approval?.id??run.approvalPackageId??null,readiness,readinessEvidenceRefs:[...new Set(input.evidenceRefs.map(value=>value.trim()))].sort(),gate,action:gate.action,phase:gate.phase,status,readinessUpdatedBy:session.uid,readinessUpdatedAt:now,updatedAt:now},{merge:true});
  await db.collection("auditLogs").add({companyId,actorUid:session.uid,action:"production_cutover.readiness_saved",runId:input.runId,decision:gate.action,blockerKeys:gate.blockers.map(item=>item.key),fingerprint:gate.fingerprint,requestId:requestId("production_cutover"),createdAt:now});
  return {status,gate};
});

export const recordProductionCutoverObservation=onCall(async request=>{
  assertProductionRuntime();
  const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const input=ObservationSchema.parse(request.data??{});const ref=db.collection("productionCutoverRuns").doc(input.runId);const snap=await ref.get();
  if(!snap.exists||snap.data()?.companyId!==companyId)throw new HttpsError("not-found","本番切替指揮盤が見つかりません。");const run=snap.data() as ProductionCutoverRun;assertMutable(run);
  const productionControl=await db.collection("productionControls").doc(companyId).get();if(productionControl.data()?.productionEnabled!==true||productionControl.data()?.emergencyLock===true)throw new HttpsError("failed-precondition","本番有効化中だけ観測値を記録できます。");
  const approvalId=String(productionControl.data()?.activeApprovalPackageId??run.approvalPackageId??"");const approval=await resolveApproval(companyId,approvalId,String(run.releaseId??""));if(!approval)throw new HttpsError("failed-precondition","使用済み署名承認と指揮盤のReleaseが一致しません。");
  const observedAtMs=Date.parse(input.observedAtIso);if(observedAtMs>Date.now()+2*60_000||observedAtMs<Date.now()-60*60_000)throw new HttpsError("invalid-argument","観測時刻は現在の前後範囲で入力してください。");
  const {runId:_,observedAtIso:__,...values}=input;const observation:ProductionCutoverObservation={...values,observedAtMs,evidenceRefs:[...new Set(values.evidenceRefs.map(value=>value.trim()))].sort()};
  const candidateStreak=Number(run.consecutiveHealthyObservations??0)+1;let gate=evaluateRun({...run,approvalPackageId:approval.id,lastObservation:observation,readiness:{...(run.readiness??blankReadiness),signedApprovalReady:true}},Date.now(),candidateStreak);const nextStreak=gate.healthyForStreak?candidateStreak:0;if(nextStreak!==candidateStreak)gate=evaluateRun({...run,approvalPackageId:approval.id,lastObservation:observation,readiness:{...(run.readiness??blankReadiness),signedApprovalReady:true}},Date.now(),nextStreak);
  const status=statusFor(gate);const now=Timestamp.now();const observationRef=db.collection("productionCutoverObservations").doc();
  await db.runTransaction(async tx=>{const current=await tx.get(ref);if(!current.exists||!["preparing","ready","monitoring","paused","rollback_required"].includes(String(current.data()?.status??"")))throw new HttpsError("aborted","指揮盤状態が更新されました。再読込してください。");tx.create(observationRef,{companyId,runId:input.runId,releaseId:run.releaseId,approvalPackageId:approval.id,observation,gate,action:gate.action,phase:gate.phase,recordedBy:session.uid,recordedAt:now});tx.set(ref,{approvalPackageId:approval.id,readiness:{...(run.readiness??blankReadiness),signedApprovalReady:true},lastObservation:observation,consecutiveHealthyObservations:nextStreak,gate,action:gate.action,phase:gate.phase,status,updatedAt:now},{merge:true});tx.set(db.collection("auditLogs").doc(),{companyId,actorUid:session.uid,action:"production_cutover.observation_recorded",runId:input.runId,observationId:observationRef.id,decision:gate.action,fingerprint:gate.fingerprint,requestId:requestId("production_cutover"),createdAt:now});});
  await alertIfNeeded(ref,{...run,action:run.action,lastAlertAt:run.lastAlertAt,lastAlertFingerprint:run.lastAlertFingerprint},gate,companyId);
  return {status,gate,consecutiveHealthyObservations:nextStreak};
});

export const monitorProductionCutover=onSchedule({schedule:"every 5 minutes",timeZone:"Asia/Tokyo",timeoutSeconds:300,memory:"512MiB",maxInstances:1},async()=>{
  const active=await db.collection("productionCutoverRuns").where("status","in",["preparing","ready","monitoring","paused","rollback_required"]).limit(20).get();
  for(const snap of active.docs){try{await monitorOne(snap.ref,snap.data() as ProductionCutoverRun);}catch(error){console.error("production_cutover_monitor_failed",{runId:snap.id,error:error instanceof Error?error.message:String(error)});}}
});

export const activateProductionCutoverRollback=onCall(async request=>{
  assertProductionRuntime();const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const input=RollbackSchema.parse(request.data??{});const ref=db.collection("productionCutoverRuns").doc(input.runId);const controlRef=db.collection("productionControls").doc(companyId);const cutoverControlRef=db.collection("productionCutoverControls").doc(companyId);const now=Timestamp.now();
  const generation=await db.runTransaction(async tx=>{const[run,control]=await Promise.all([tx.get(ref),tx.get(controlRef)]);if(!run.exists||run.data()?.companyId!==companyId)throw new HttpsError("not-found","本番切替指揮盤が見つかりません。");if(run.data()?.action!=="rollback_required")throw new HttpsError("failed-precondition","自動判定がROLLBACK_REQUIREDの時だけ実行できます。");if(control.data()?.emergencyLock===true){tx.set(ref,{status:"rollback_started",rollbackReason:input.reason.trim(),rollbackStartedBy:session.uid,rollbackStartedAt:run.data()?.rollbackStartedAt??now,updatedAt:now},{merge:true});tx.set(cutoverControlRef,{activeRunId:null,updatedAt:now},{merge:true});return Number(control.data()?.generation??0);}const next=Number(control.data()?.generation??0)+1;tx.set(controlRef,{companyId,productionEnabled:false,emergencyLock:true,generation:next,emergencyReason:input.reason.trim(),lockedBy:session.uid,lockedAt:now,updatedAt:now},{merge:true});tx.set(ref,{status:"rollback_started",rollbackReason:input.reason.trim(),rollbackStartedBy:session.uid,rollbackStartedAt:now,updatedAt:now},{merge:true});tx.set(cutoverControlRef,{activeRunId:null,updatedAt:now},{merge:true});tx.create(db.collection("productionEmergencyEvents").doc(),{companyId,action:"cutover_rollback_started",runId:input.runId,reason:input.reason.trim(),actorUid:session.uid,generation:next,irreversibleInApp:true,createdAt:now});tx.set(db.collection("auditLogs").doc(),{companyId,actorUid:session.uid,action:"production_cutover.rollback_started",runId:input.runId,reason:input.reason.trim(),generation:next,requestId:requestId("production_cutover_rollback"),createdAt:now});return next;});
  await incrementProductionMetrics(companyId,{criticalOutageCount:1},"cutover_rollback");await notifyAdmins(companyId,"緊急：本番切戻しを開始しました",`${input.reason.trim()}／全体停止ロックを作動し、復旧手順へ移行しました。`,`${input.runId}_${generation}`,true);return {status:"rollback_started",generation};
});

export const completeProductionCutover=onCall(async request=>{
  assertProductionRuntime();const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const input=RequiredIdSchema.parse(request.data??{});const ref=db.collection("productionCutoverRuns").doc(input.runId);const snap=await ref.get();if(!snap.exists||snap.data()?.companyId!==companyId)throw new HttpsError("not-found","本番切替指揮盤が見つかりません。");const run=snap.data() as ProductionCutoverRun;const gate=evaluateRun(run,Date.now(),Number(run.consecutiveHealthyObservations??0));if(run.status!=="ready_to_complete"||gate.action!=="complete")throw new HttpsError("failed-precondition","T＋24時間と連続正常runを満たしていません。");const productionControl=await db.collection("productionControls").doc(companyId).get();if(productionControl.data()?.productionEnabled!==true||productionControl.data()?.emergencyLock===true)throw new HttpsError("failed-precondition","本番が正常稼働中ではありません。");const now=Timestamp.now();await db.runTransaction(async tx=>{const current=await tx.get(ref);if(current.data()?.status!=="ready_to_complete"||current.data()?.gate?.fingerprint!==run.gate?.fingerprint)throw new HttpsError("aborted","指揮盤状態が更新されました。");tx.set(ref,{status:"completed",action:"complete",gate,completedBy:session.uid,completedAt:now,updatedAt:now},{merge:true});tx.set(db.collection("productionCutoverControls").doc(companyId),{activeRunId:null,updatedAt:now},{merge:true});tx.set(db.collection("auditLogs").doc(),{companyId,actorUid:session.uid,action:"production_cutover.completed",runId:input.runId,fingerprint:gate.fingerprint,requestId:requestId("production_cutover"),createdAt:now});});await notifyAdmins(companyId,"本番切替を完了しました","T＋24時間と連続正常runを満たし、当日指揮盤を完了固定しました。",input.runId);return {status:"completed",fingerprint:gate.fingerprint};
});

export const cancelProductionCutover=onCall(async request=>{
  assertProductionRuntime();const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const input=CancelSchema.parse(request.data??{});const ref=db.collection("productionCutoverRuns").doc(input.runId);const controlRef=db.collection("productionCutoverControls").doc(companyId);const productionControl=await db.collection("productionControls").doc(companyId).get();if(productionControl.data()?.productionEnabled===true)throw new HttpsError("failed-precondition","本番有効化後は中止ではなく切戻し判定を使用してください。");const now=Timestamp.now();await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists||snap.data()?.companyId!==companyId)throw new HttpsError("not-found","本番切替指揮盤が見つかりません。");if(!["preparing","ready","paused"].includes(String(snap.data()?.status??"")))throw new HttpsError("failed-precondition","中止できる指揮盤ではありません。");tx.set(ref,{status:"cancelled",cancelledBy:session.uid,cancelledReason:input.reason.trim(),cancelledAt:now,updatedAt:now},{merge:true});tx.set(controlRef,{activeRunId:null,updatedAt:now},{merge:true});tx.set(db.collection("auditLogs").doc(),{companyId,actorUid:session.uid,action:"production_cutover.cancelled",runId:input.runId,reason:input.reason.trim(),requestId:requestId("production_cutover"),createdAt:now});});return {status:"cancelled"};
});

async function monitorOne(ref:FirebaseFirestore.DocumentReference,run:ProductionCutoverRun){const companyId=String(run.companyId??"");const productionControl=await db.collection("productionControls").doc(companyId).get();if(productionControl.data()?.emergencyLock===true){await ref.set({status:"rollback_started",updatedAt:Timestamp.now()},{merge:true});return;}const gate=evaluateRun(run,Date.now(),Number(run.consecutiveHealthyObservations??0));const status=statusFor(gate);if(gate.fingerprint!==run.gate?.fingerprint||status!==run.status){await ref.set({gate,action:gate.action,phase:gate.phase,status,updatedAt:Timestamp.now()},{merge:true});await alertIfNeeded(ref,run,gate,companyId);}}
function evaluateRun(run:ProductionCutoverRun,nowMs:number,streak:number){return evaluateProductionCutover({windowStartMs:Number(run.windowStartMs??0),nowMs,productionActive:Boolean(run.productionEnabledAt),readiness:run.readiness??blankReadiness,readinessEvidenceRefs:run.readinessEvidenceRefs??[],observation:run.lastObservation??null,consecutiveHealthyObservations:streak,thresholds:run.thresholds??defaultProductionCutoverThresholds()});}
function statusFor(gate:ProductionCutoverEvaluation){if(gate.action==="rollback_required")return"rollback_required";if(gate.action==="pause")return"paused";if(gate.action==="complete")return"ready_to_complete";return gate.phase==="preflight"?"ready":"monitoring";}
function assertMutable(run:ProductionCutoverRun){if(["completed","cancelled","rollback_started"].includes(String(run.status??"")))throw new HttpsError("failed-precondition","更新できる指揮盤ではありません。");}
async function resolveApproval(companyId:string,id:string,releaseId:string){if(!id)return null;const snap=await db.collection("productionApprovalPackages").doc(id).get();if(!snap.exists||snap.data()?.companyId!==companyId||snap.data()?.releaseId!==releaseId||!["ready_to_enable","used"].includes(String(snap.data()?.status??"")))return null;return snap;}
async function findRun(companyId:string,id?:string){if(id){const snap=await db.collection("productionCutoverRuns").doc(id).get();return snap.exists&&snap.data()?.companyId===companyId?snap:null;}const control=await db.collection("productionCutoverControls").doc(companyId).get();const activeId=String(control.data()?.activeRunId??"");if(activeId){const active=await db.collection("productionCutoverRuns").doc(activeId).get();if(active.exists&&active.data()?.companyId===companyId)return active;}const latest=await db.collection("productionCutoverRuns").where("companyId","==",companyId).orderBy("createdAt","desc").limit(1).get();return latest.docs[0]??null;}
function safeRun(id:string,run:ProductionCutoverRun){return{runId:id,releaseId:String(run.releaseId??""),approvalPackageId:String(run.approvalPackageId??""),status:String(run.status??"unknown"),windowStart:new Date(Number(run.windowStartMs??0)).toISOString(),readiness:run.readiness??blankReadiness,readinessEvidenceRefs:run.readinessEvidenceRefs??[],thresholds:run.thresholds??defaultProductionCutoverThresholds(),timeline:run.timeline??buildProductionCutoverTimeline(),lastObservation:run.lastObservation??null,consecutiveHealthyObservations:Number(run.consecutiveHealthyObservations??0),gate:run.gate??null,createdAt:iso(run.createdAt),completedAt:iso(run.completedAt),cancelledAt:iso(run.cancelledAt),rollbackStartedAt:iso(run.rollbackStartedAt),rollbackReason:String(run.rollbackReason??"")};}
async function alertIfNeeded(ref:FirebaseFirestore.DocumentReference,run:ProductionCutoverRun,gate:ProductionCutoverEvaluation,companyId:string){const urgent=gate.action==="rollback_required"||gate.action==="pause";const important=urgent||gate.action==="watch"||gate.action==="complete";if(!important)return;const now=Timestamp.now();const changed=run.lastAlertFingerprint!==gate.fingerprint;const expired=!run.lastAlertAt||now.toMillis()-run.lastAlertAt.toMillis()>=30*60_000;if(!changed&&!expired)return;await ref.set({lastAlertFingerprint:gate.fingerprint,lastAlertAt:now},{merge:true});const reasons=[...gate.rollbackBlockers,...gate.blockers,...gate.warnings].map(item=>item.label).join(" / ")||"全条件合格";await notifyAdmins(companyId,`本番切替 ${gate.action.toUpperCase()}判定`,reasons,`${ref.id}_${gate.fingerprint}`,urgent);}
async function notifyAdmins(companyId:string,title:string,body:string,dedupeKey:string,urgent=false){try{await enqueueNotification({companyId,targetRole:"admin",title,body:body.slice(0,500),route:"/",category:"production_cutover",dedupeKey,bypassQuietHours:urgent});}catch(error){console.error("production_cutover_notification_failed",error);}}
function assertProductionRuntime(){if((process.env.APP_ENVIRONMENT??"development")!=="production")throw new HttpsError("failed-precondition","本番切替指揮盤はproduction環境だけで実行できます。");}
function iso(value?:Timestamp){return value instanceof Timestamp?value.toDate().toISOString():null;}
