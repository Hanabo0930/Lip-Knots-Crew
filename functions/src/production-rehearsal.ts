import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { enqueueNotification } from "./notification-core";
import {
  buildProductionRehearsalPlan,
  evaluateProductionRehearsal,
  ProductionRehearsalMetrics,
  ProductionRehearsalPlanInput,
} from "./production-rehearsal-core";
import { companyFromClaims, requireAdmin, requestId } from "./utils";

const CreateSchema=z.object({
  stagedRolloutId:z.string().min(1).max(160),
  sourceProjectId:z.string().min(3).max(100),
  restoreProjectId:z.string().min(3).max(100),
  backupBucket:z.string().regex(/^gs:\/\/[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/u),
  maxRtoMinutes:z.number().int().min(5).max(240).default(60),
  maxRpoMinutes:z.number().int().min(0).max(60).default(5),
});

const MetricsSchema=z.object({
  rehearsalId:z.string().min(1).max(160),
  freezeConfirmed:z.boolean(),firestoreExportComplete:z.boolean(),storageManifestComplete:z.boolean(),authExportComplete:z.boolean(),
  sourceDocumentCount:z.number().int().min(0),sourceStorageObjectCount:z.number().int().min(0),sourceAuthUserCount:z.number().int().min(0),
  sourceSnapshotSha256:z.string().max(128),restoreComplete:z.boolean(),restoredDocumentCount:z.number().int().min(0),
  restoredStorageObjectCount:z.number().int().min(0),restoredAuthUserCount:z.number().int().min(0),restoredSnapshotSha256:z.string().max(128),
  securityRulesDeployed:z.boolean(),indexesReady:z.boolean(),sampleMismatchCount:z.number().int().min(0),permissionProbeFailures:z.number().int().min(0),
  smokeFailures:z.number().int().min(0),migrationDryRunComplete:z.boolean(),plannedMigrationCount:z.number().int().min(0),dryRunAppliedCount:z.number().int().min(0),
  migrationDiffCount:z.number().int().min(0),rollbackComplete:z.boolean(),rollbackRtoMinutes:z.number().min(0).max(10000),
  rollbackDataLossMinutes:z.number().min(0).max(10000),postRollbackSmokeFailures:z.number().int().min(0),
  evidenceRefs:z.array(z.string().min(1).max(500).refine((value)=>!/[\r\n\0]/u.test(value),"証跡参照が不正です。")).min(1).max(40),
});

const IdSchema=z.object({rehearsalId:z.string().min(1).max(160).optional()});
const AbortSchema=z.object({rehearsalId:z.string().min(1).max(160),reason:z.string().min(10).max(1000)});

type RehearsalRecord={
  companyId?:string;stagedRolloutId?:string;releaseId?:string;status?:string;
  plan?:ProductionRehearsalPlanInput;planFingerprint?:string;metrics?:ProductionRehearsalMetrics;
  gate?:ReturnType<typeof evaluateProductionRehearsal>;createdBy?:string;createdAt?:Timestamp;updatedAt?:Timestamp;
  completedAt?:Timestamp;abortedAt?:Timestamp;abortedReason?:string;
};

export const getProductionRehearsalStatus=onCall(async(request)=>{
  const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const input=IdSchema.parse(request.data??{});
  const snap=await findRun(companyId,input.rehearsalId);
  return {rehearsal:snap?safeRun(snap.id,snap.data() as RehearsalRecord):null};
});

export const createProductionRehearsal=onCall(async(request)=>{
  assertStagingRuntime();
  const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const input=CreateSchema.parse(request.data??{});
  const expectedProjectId=String(process.env.EXPECTED_FIREBASE_PROJECT_ID??"").trim();
  if(!expectedProjectId||input.sourceProjectId!==expectedProjectId)throw new HttpsError("failed-precondition","sourceProjectIdは現在のstaging Project IDと一致させてください。");
  const rollout=await db.collection("stagedRollouts").doc(input.stagedRolloutId).get();
  if(!rollout.exists||rollout.data()?.companyId!==companyId||rollout.data()?.status!=="completed")throw new HttpsError("failed-precondition","完了済みの30〜50名段階配布が必要です。");
  const plan:ProductionRehearsalPlanInput={releaseId:String(rollout.data()?.releaseId??""),sourceProjectId:input.sourceProjectId,restoreProjectId:input.restoreProjectId,backupBucket:input.backupBucket,maxRtoMinutes:input.maxRtoMinutes,maxRpoMinutes:input.maxRpoMinutes};
  const built=buildProductionRehearsalPlan(plan);const ref=db.collection("productionRehearsalRuns").doc();const controlRef=db.collection("productionRehearsalControls").doc(companyId);const certRef=db.collection("productionRehearsalCertifications").doc(input.stagedRolloutId);const now=Timestamp.now();
  await db.runTransaction(async tx=>{const[control,cert]=await Promise.all([tx.get(controlRef),tx.get(certRef)]);if(control.data()?.activeRunId)throw new HttpsError("already-exists","進行中の本番移行リハーサルがあります。");if(cert.exists)throw new HttpsError("already-exists","この段階配布には完了済みの復元演習証跡があります。");tx.create(ref,{companyId,stagedRolloutId:input.stagedRolloutId,releaseId:plan.releaseId,status:"running",plan,phases:built.phases,planFingerprint:built.fingerprint,createdBy:session.uid,createdAt:now,updatedAt:now});tx.set(controlRef,{companyId,activeRunId:ref.id,updatedAt:now},{merge:true});tx.set(db.collection("auditLogs").doc(),{companyId,actorUid:session.uid,action:"production_rehearsal.created",rehearsalId:ref.id,stagedRolloutId:input.stagedRolloutId,planFingerprint:built.fingerprint,requestId:requestId("production_rehearsal"),createdAt:now});});
  return {rehearsalId:ref.id,status:"running",phases:built.phases,planFingerprint:built.fingerprint};
});

export const saveProductionRehearsalMetrics=onCall(async(request)=>{
  assertStagingRuntime();
  const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const input=MetricsSchema.parse(request.data??{});const ref=db.collection("productionRehearsalRuns").doc(input.rehearsalId);const snap=await ref.get();
  if(!snap.exists||snap.data()?.companyId!==companyId)throw new HttpsError("not-found","本番移行リハーサルが見つかりません。");
  const run=snap.data() as RehearsalRecord;if(!run.plan||!["running","blocked","ready_to_complete"].includes(String(run.status??"")))throw new HttpsError("failed-precondition","更新できるリハーサルではありません。");
  const {rehearsalId:_,...raw}=input;const metrics=raw as ProductionRehearsalMetrics;const gate=evaluateProductionRehearsal(run.plan,metrics);const now=Timestamp.now();
  await ref.set({status:gate.eligible?"ready_to_complete":"blocked",metrics:{...metrics,evidenceRefs:gate.normalizedEvidenceRefs},gate,metricsUpdatedBy:session.uid,metricsUpdatedAt:now,updatedAt:now},{merge:true});
  await db.collection("auditLogs").add({companyId,actorUid:session.uid,action:"production_rehearsal.metrics_saved",rehearsalId:input.rehearsalId,eligible:gate.eligible,blockerKeys:gate.blockers.map(item=>item.key),fingerprint:gate.fingerprint,requestId:requestId("production_rehearsal"),createdAt:now});
  return {status:gate.eligible?"ready_to_complete":"blocked",gate};
});

export const completeProductionRehearsal=onCall(async(request)=>{
  assertStagingRuntime();
  const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const input=IdSchema.extend({rehearsalId:z.string().min(1).max(160)}).parse(request.data??{});const ref=db.collection("productionRehearsalRuns").doc(input.rehearsalId);const snap=await ref.get();
  if(!snap.exists||snap.data()?.companyId!==companyId)throw new HttpsError("not-found","本番移行リハーサルが見つかりません。");const run=snap.data() as RehearsalRecord;
  if(run.status!=="ready_to_complete"||!run.plan||!run.metrics)throw new HttpsError("failed-precondition","全検算合格後だけ完了できます。");const gate=evaluateProductionRehearsal(run.plan,run.metrics);if(!gate.eligible||gate.fingerprint!==run.gate?.fingerprint)throw new HttpsError("failed-precondition","完了直前の再判定に失敗しました。");
  const certRef=db.collection("productionRehearsalCertifications").doc(String(run.stagedRolloutId));const controlRef=db.collection("productionRehearsalControls").doc(companyId);const now=Timestamp.now();
  await db.runTransaction(async tx=>{const current=await tx.get(ref);if(current.data()?.status!=="ready_to_complete"||current.data()?.gate?.fingerprint!==gate.fingerprint)throw new HttpsError("aborted","演習状態が更新されました。");tx.create(certRef,{companyId,rehearsalId:input.rehearsalId,stagedRolloutId:run.stagedRolloutId,releaseId:run.releaseId,status:"completed",plan:run.plan,gate,fingerprint:gate.fingerprint,evidenceRefs:gate.normalizedEvidenceRefs,completedBy:session.uid,completedAt:now});tx.set(ref,{status:"completed",completedBy:session.uid,completedAt:now,updatedAt:now},{merge:true});tx.set(controlRef,{activeRunId:null,updatedAt:now},{merge:true});tx.set(db.collection("auditLogs").doc(),{companyId,actorUid:session.uid,action:"production_rehearsal.completed",rehearsalId:input.rehearsalId,stagedRolloutId:run.stagedRolloutId,fingerprint:gate.fingerprint,requestId:requestId("production_rehearsal"),createdAt:now});});
  await notifyAdmins(companyId,"本番移行リハーサルと復元演習が完了しました","バックアップ・復元・移行dry-run・切戻しの検算証跡を公開ゲートへ連携しました。",input.rehearsalId);
  return {status:"completed",fingerprint:gate.fingerprint};
});

export const abortProductionRehearsal=onCall(async(request)=>{
  const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const input=AbortSchema.parse(request.data??{});const ref=db.collection("productionRehearsalRuns").doc(input.rehearsalId);const controlRef=db.collection("productionRehearsalControls").doc(companyId);const now=Timestamp.now();
  await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists||snap.data()?.companyId!==companyId)throw new HttpsError("not-found","リハーサルが見つかりません。");if(["completed","aborted"].includes(String(snap.data()?.status??"")))return;tx.set(ref,{status:"aborted",abortedBy:session.uid,abortedReason:input.reason.trim(),abortedAt:now,updatedAt:now},{merge:true});tx.set(controlRef,{activeRunId:null,updatedAt:now},{merge:true});tx.set(db.collection("auditLogs").doc(),{companyId,actorUid:session.uid,action:"production_rehearsal.aborted",rehearsalId:input.rehearsalId,reason:input.reason.trim(),requestId:requestId("production_rehearsal"),createdAt:now});});return {status:"aborted"};
});

async function findRun(companyId:string,id?:string){if(id){const snap=await db.collection("productionRehearsalRuns").doc(id).get();return snap.exists&&snap.data()?.companyId===companyId?snap:null;}const control=await db.collection("productionRehearsalControls").doc(companyId).get();const activeId=String(control.data()?.activeRunId??"");if(activeId){const active=await db.collection("productionRehearsalRuns").doc(activeId).get();if(active.exists&&active.data()?.companyId===companyId)return active;}const latest=await db.collection("productionRehearsalRuns").where("companyId","==",companyId).orderBy("createdAt","desc").limit(1).get();return latest.docs[0]??null;}
function safeRun(id:string,run:RehearsalRecord){return{rehearsalId:id,stagedRolloutId:String(run.stagedRolloutId??""),releaseId:String(run.releaseId??""),status:String(run.status??"unknown"),plan:run.plan??null,planFingerprint:String(run.planFingerprint??""),metrics:run.metrics??null,gate:run.gate??null,createdAt:iso(run.createdAt),completedAt:iso(run.completedAt),abortedAt:iso(run.abortedAt),abortedReason:String(run.abortedReason??"")};}
function assertStagingRuntime(){if((process.env.APP_ENVIRONMENT??"development")!=="staging")throw new HttpsError("failed-precondition","本番移行リハーサルはstaging環境だけで実行できます。");}
function iso(value?:Timestamp){return value instanceof Timestamp?value.toDate().toISOString():null;}
async function notifyAdmins(companyId:string,title:string,body:string,dedupeKey:string){try{await enqueueNotification({companyId,targetRole:"admin",title,body,route:"/",category:"production_rehearsal_completed",dedupeKey});}catch(error){console.error("production_rehearsal_notification_failed",error);}}
