import { Timestamp } from "firebase-admin/firestore";
import { google } from "googleapis";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { z } from "zod";
import { db } from "./firebase";
import {
  buildProductionTelemetryObservation,
  defaultProductionTelemetryMappings,
  monitoringMetricFilter,
  normalizeProductionTelemetryMappings,
  productionTelemetryFingerprint,
  productionTelemetryMetricDefinitions,
  ProductionTelemetryMetricKey,
  ProductionTelemetryMetricMappings,
  reduceMonitoringSeries,
  validateProductionTelemetryProjectId,
} from "./production-telemetry-core";
import { recordProductionSloObservationForSource } from "./production-slo";
import { companyFromClaims, requireAdmin, requestId } from "./utils";

const MetricTypeSchema=z.string().trim().min(8).max(220).refine(value=>!/[\r\n\0]/u.test(value),"Metric typeが不正です。");
const MetricsSchema=z.object({
  authenticationAttempts:MetricTypeSchema,authenticationFailures:MetricTypeSchema,callableRequests:MetricTypeSchema,callableFailures:MetricTypeSchema,
  sheetWriteAttempts:MetricTypeSchema,sheetWriteFailures:MetricTypeSchema,notificationAttempts:MetricTypeSchema,notificationFailures:MetricTypeSchema,
  p95LatencyMs:MetricTypeSchema,queueOldestAgeMinutes:MetricTypeSchema,dataMismatchCount:MetricTypeSchema,criticalOutageCount:MetricTypeSchema,monitoringProbeFailures:MetricTypeSchema,
});
const ConfigSchema=z.object({projectId:z.string().trim().min(6).max(30),enabled:z.boolean(),metrics:MetricsSchema});

type StoredConfig={companyId?:string;projectId?:string;enabled?:boolean;metrics?:ProductionTelemetryMetricMappings;fingerprint?:string;status?:string;verifiedAt?:Timestamp;lastCollectedAt?:Timestamp;lastAttemptAt?:Timestamp;lastWindowEndMs?:number;lastObservationId?:string;lastRunId?:string;lastError?:string;exporterStatus?:string;lastExportedAt?:Timestamp;lastExportWindowEndMs?:number;lastExportRunId?:string;lastExportError?:string;updatedAt?:Timestamp};
const monitoring=google.monitoring({version:"v3",auth:new google.auth.GoogleAuth({scopes:["https://www.googleapis.com/auth/monitoring.read"]})});
const fiveMinutesMs=5*60_000;

export const getProductionTelemetryStatus=onCall(async request=>{
  const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const snapshot=await db.collection("productionTelemetryConfigs").doc(companyId).get();
  return safeStatus(snapshot.data() as StoredConfig|undefined);
});

export const saveProductionTelemetryConfig=onCall(async request=>{
  assertProductionRuntime();const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const parsed=ConfigSchema.parse(request.data??{});
  const projectId=validateProductionTelemetryProjectId(parsed.projectId);const metrics=normalizeProductionTelemetryMappings(parsed.metrics);const fingerprint=productionTelemetryFingerprint(projectId,metrics);const ref=db.collection("productionTelemetryConfigs").doc(companyId);const current=await ref.get();const unchanged=current.data()?.fingerprint===fingerprint;const now=Timestamp.now();
  await db.runTransaction(async tx=>{tx.set(ref,{companyId,projectId,enabled:parsed.enabled,metrics,fingerprint,status:unchanged?String(current.data()?.status??"saved"):"saved",verifiedAt:unchanged?current.data()?.verifiedAt??null:null,lastError:"",updatedBy:session.uid,updatedAt:now},{merge:true});tx.set(db.collection("auditLogs").doc(),{companyId,actorUid:session.uid,action:"production_telemetry.config_saved",projectId,enabled:parsed.enabled,fingerprint,requestId:requestId("production_telemetry"),createdAt:now});});
  return safeStatus((await ref.get()).data() as StoredConfig);
});

export const probeProductionTelemetry=onCall(async request=>{
  assertProductionRuntime();const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const ref=db.collection("productionTelemetryConfigs").doc(companyId);const snapshot=await ref.get();const config=requireConfig(snapshot.data() as StoredConfig|undefined,false);const endMs=Date.now();const startMs=endMs-10*60_000;
  try{const values=await readAllMetricValues(companyId,config.projectId,config.metrics,startMs,endMs);const observation=buildProductionTelemetryObservation({projectId:config.projectId,metrics:config.metrics,values,windowStartIso:new Date(startMs).toISOString(),observedAtIso:new Date(endMs).toISOString()});const now=Timestamp.now();await ref.set({status:"verified",verifiedAt:now,lastAttemptAt:now,lastError:"",updatedAt:now},{merge:true});await db.collection("auditLogs").add({companyId,actorUid:session.uid,action:"production_telemetry.probe_passed",fingerprint:config.fingerprint,requestId:requestId("production_telemetry"),createdAt:now});return{ok:true,preview:stripEvidence(observation),status:safeStatus((await ref.get()).data() as StoredConfig)};}catch(error){await recordCollectionError(ref,error);throw new HttpsError("failed-precondition",`Cloud Monitoring接続テストに失敗しました：${errorMessage(error)}`);}
});

export const collectProductionTelemetryNow=onCall(async request=>{
  assertProductionRuntime();const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const result=await collectCompanyTelemetry(companyId,session.uid,Date.now());return result;
});

export const collectProductionTelemetry=onSchedule({schedule:"3,8,13,18,23,28,33,38,43,48,53,58 * * * *",timeZone:"Asia/Tokyo",timeoutSeconds:300,memory:"512MiB",maxInstances:1},async()=>{
  if((process.env.APP_ENVIRONMENT??"development")!=="production")return;
  const configs=await db.collection("productionTelemetryConfigs").where("enabled","==",true).limit(25).get();
  for(const config of configs.docs){try{await collectCompanyTelemetry(config.id,"system:cloud-monitoring",Date.now());}catch(error){console.error("production_telemetry_collection_failed",{companyId:config.id,error:errorMessage(error)});}}
});

async function collectCompanyTelemetry(companyId:string,actorUid:string,nowMs:number){
  const ref=db.collection("productionTelemetryConfigs").doc(companyId);const snapshot=await ref.get();const config=requireConfig(snapshot.data() as StoredConfig|undefined,true);
  if(!config.verifiedAt)throw new HttpsError("failed-precondition","先にCloud Monitoring接続テストを完了してください。");
  const windowEndMs=Math.floor(nowMs/fiveMinutesMs)*fiveMinutesMs;const previousEnd=Number(config.lastWindowEndMs??0);if(previousEnd>=windowEndMs)return{skipped:true,reason:"already_collected",status:safeStatus(config)};
  const windowStartMs=previousEnd>windowEndMs-30*60_000&&previousEnd<windowEndMs?previousEnd:windowEndMs-fiveMinutesMs;const runId=`${companyId}_${windowEndMs}`;const runRef=db.collection("productionTelemetryRuns").doc(runId);const now=Timestamp.now();
  try{await runRef.create({companyId,projectId:config.projectId,fingerprint:config.fingerprint,status:"collecting",windowStartMs,windowEndMs,startedAt:now,actorUid});}catch(error){if(isAlreadyExists(error))return{skipped:true,reason:"run_exists",status:safeStatus(config)};throw error;}
  await ref.set({status:"collecting",lastAttemptAt:now,lastRunId:runId,lastError:"",updatedAt:now},{merge:true});
  try{
    const values=await readAllMetricValues(companyId,config.projectId,config.metrics,windowStartMs,windowEndMs);const observation=buildProductionTelemetryObservation({projectId:config.projectId,metrics:config.metrics,values,windowStartIso:new Date(windowStartMs).toISOString(),observedAtIso:new Date(windowEndMs).toISOString()});
    const result=await recordProductionSloObservationForSource({companyId,actorUid,input:observation,source:`cloud-monitoring:${runId}`});const completedAt=Timestamp.now();
    await Promise.all([runRef.set({status:"completed",observationId:result.observationId,completedAt,values:stripEvidence(observation)},{merge:true}),ref.set({status:"collecting",lastCollectedAt:completedAt,lastWindowEndMs:windowEndMs,lastObservationId:result.observationId,lastRunId:runId,lastError:"",updatedAt:completedAt},{merge:true}),db.collection("auditLogs").add({companyId,actorUid,action:"production_telemetry.collected",runId,observationId:result.observationId,windowStartMs,windowEndMs,requestId:requestId("production_telemetry"),createdAt:completedAt})]);
    return{skipped:false,runId,observationId:result.observationId,evaluation:result.evaluation,incident:result.incident,status:safeStatus((await ref.get()).data() as StoredConfig)};
  }catch(error){const failedAt=Timestamp.now();await Promise.all([runRef.set({status:"failed",error:errorMessage(error),failedAt},{merge:true}),recordCollectionError(ref,error)]);throw error;}
}

async function readAllMetricValues(companyId:string,projectId:string,metrics:ProductionTelemetryMetricMappings,startMs:number,endMs:number):Promise<Record<ProductionTelemetryMetricKey,number>>{
  const entries=await Promise.all(productionTelemetryMetricDefinitions.map(async definition=>{
    const response=await monitoring.projects.timeSeries.list({name:`projects/${projectId}`,filter:monitoringMetricFilter(metrics[definition.key],companyId),"interval.startTime":new Date(startMs).toISOString(),"interval.endTime":new Date(endMs).toISOString(),view:"FULL",pageSize:10_000});
    if(response.data.nextPageToken)throw new Error(`${definition.label}のTimeSeriesが上限を超えました。Metric labelを絞ってください。`);
    try{return[definition.key,reduceMonitoringSeries(response.data.timeSeries??[],definition.reducer)]as const;}catch(error){throw new Error(`${definition.label}：${errorMessage(error)}`);}
  }));
  return Object.fromEntries(entries) as Record<ProductionTelemetryMetricKey,number>;
}

function requireConfig(data:StoredConfig|undefined,requireEnabled:boolean){if(!data?.projectId||!data.metrics||!data.fingerprint)throw new HttpsError("failed-precondition","Cloud Monitoring設定を保存してください。");if(requireEnabled&&!data.enabled)throw new HttpsError("failed-precondition","Cloud Monitoring自動取込がOFFです。");return{...data,projectId:validateProductionTelemetryProjectId(data.projectId),metrics:normalizeProductionTelemetryMappings(data.metrics),fingerprint:String(data.fingerprint)};}
function safeStatus(data:StoredConfig|undefined){return{configured:Boolean(data?.projectId&&data.metrics),enabled:Boolean(data?.enabled),projectId:String(data?.projectId??""),metrics:data?.metrics??defaultProductionTelemetryMappings(),fingerprint:String(data?.fingerprint??""),status:String(data?.status??"unconfigured"),verifiedAt:iso(data?.verifiedAt),lastCollectedAt:iso(data?.lastCollectedAt),lastAttemptAt:iso(data?.lastAttemptAt),lastWindowEnd:data?.lastWindowEndMs?new Date(data.lastWindowEndMs).toISOString():null,lastObservationId:String(data?.lastObservationId??""),lastRunId:String(data?.lastRunId??""),lastError:String(data?.lastError??""),exporterStatus:String(data?.exporterStatus??"unconfigured"),lastExportedAt:iso(data?.lastExportedAt),lastExportWindowEnd:data?.lastExportWindowEndMs?new Date(data.lastExportWindowEndMs).toISOString():null,lastExportRunId:String(data?.lastExportRunId??""),lastExportError:String(data?.lastExportError??"")};}
function stripEvidence(observation:{evidenceRefs:string[]}&Record<string,unknown>){const{evidenceRefs:_,...values}=observation;return values;}
function iso(value:unknown){return value instanceof Timestamp?value.toDate().toISOString():null;}
function errorMessage(error:unknown){return(error instanceof Error?error.message:String(error)).slice(0,1000);}
function isAlreadyExists(error:unknown){const code=(error as{code?:string|number}|null)?.code;return code===6||code==="6"||code==="already-exists";}
async function recordCollectionError(ref:FirebaseFirestore.DocumentReference,error:unknown){const now=Timestamp.now();await ref.set({status:"collection_error",lastAttemptAt:now,lastError:errorMessage(error),updatedAt:now},{merge:true});}
function assertProductionRuntime(){if((process.env.APP_ENVIRONMENT??"development")!=="production")throw new HttpsError("failed-precondition","本番監視自動取込はproduction環境だけで実行できます。");}
