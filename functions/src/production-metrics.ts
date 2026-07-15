import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { google } from "googleapis";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db } from "./firebase";
import { assembleProductionMetricValues, buildProductionMetricTimeSeries, completedFiveMinuteWindow, maxNumericTimeSeries, oldestQueueAgeMinutes, ProductionMetricCounterSnapshot, requestFailureCount, sumNumericTimeSeries } from "./production-metric-core";
import { normalizeProductionTelemetryMappings, ProductionTelemetryMetricMappings, validateProductionTelemetryProjectId } from "./production-telemetry-core";
import { companyFromClaims, requireAdmin, requestId } from "./utils";

type StoredTelemetryConfig={projectId?:string;enabled?:boolean;metrics?:ProductionTelemetryMetricMappings;fingerprint?:string;lastExportedAt?:Timestamp;lastExportWindowEndMs?:number;lastExportRunId?:string;lastExportError?:string;exporterStatus?:string};
type CounterKey=keyof ProductionMetricCounterSnapshot;
const counterKeys=new Set<CounterKey>(["authenticationAttempts","authenticationFailures","sheetWriteAttempts","sheetWriteFailures","notificationAttempts","notificationFailures","dataMismatchCount","criticalOutageCount"]);
const monitoring=google.monitoring({version:"v3",auth:new google.auth.GoogleAuth({scopes:["https://www.googleapis.com/auth/monitoring.read","https://www.googleapis.com/auth/monitoring.write"]})});
const fiveMinutesMs=5*60_000;

export async function incrementProductionMetrics(companyId:string,increments:ProductionMetricCounterSnapshot,source:string):Promise<void>{
  if((process.env.APP_ENVIRONMENT??"development")!=="production")return;
  try{const tenant=companyId.trim();if(!/^[A-Za-z0-9_-]{1,100}$/u.test(tenant))return;const normalized:Partial<Record<CounterKey,number>>={};for(const[key,value]of Object.entries(increments)as Array<[CounterKey,number|undefined]>){if(!counterKeys.has(key)||!Number.isSafeInteger(value)||Number(value)<0)continue;normalized[key]=Number(value);}if(!Object.keys(normalized).length)return;const windowStartMs=Math.floor(Date.now()/fiveMinutesMs)*fiveMinutesMs;const fields=Object.fromEntries(Object.entries(normalized).map(([key,value])=>[key,FieldValue.increment(Number(value))]));await db.collection("productionMetricBuckets").doc(`${tenant}_${windowStartMs}`).set({companyId:tenant,windowStartMs,windowEndMs:windowStartMs+fiveMinutesMs,...fields,lastSource:source,updatedAt:FieldValue.serverTimestamp()},{merge:true});}catch(error){console.error("production_metric_increment_failed",{companyId,source,error:errorMessage(error)});}
}

export const getProductionMetricPublisherStatus=onCall(async request=>{const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const config=await db.collection("productionTelemetryConfigs").doc(companyId).get();return safePublisherStatus(config.data()as StoredTelemetryConfig|undefined);});

export const publishProductionMetricsNow=onCall(async request=>{assertProductionRuntime();const session=requireAdmin(request);const companyId=companyFromClaims(session.token);return publishCompanyMetrics(companyId,session.uid,Date.now());});

export const publishProductionMetrics=onSchedule({schedule:"1,6,11,16,21,26,31,36,41,46,51,56 * * * *",timeZone:"Asia/Tokyo",timeoutSeconds:300,memory:"512MiB",maxInstances:1},async()=>{
  if((process.env.APP_ENVIRONMENT??"development")!=="production")return;const configs=await db.collection("productionTelemetryConfigs").where("enabled","==",true).limit(25).get();for(const config of configs.docs){try{await publishCompanyMetrics(config.id,"system:metric-publisher",Date.now());}catch(error){console.error("production_metric_publish_failed",{companyId:config.id,error:errorMessage(error)});}}
});

async function publishCompanyMetrics(companyId:string,actorUid:string,nowMs:number){
  const configRef=db.collection("productionTelemetryConfigs").doc(companyId);const[configSnap,control]=await Promise.all([configRef.get(),db.collection("productionControls").doc(companyId).get()]);const config=requireConfig(configSnap.data()as StoredTelemetryConfig|undefined);if(control.data()?.productionEnabled!==true||control.data()?.emergencyLock===true)throw new HttpsError("failed-precondition","本番有効化中かつ全体停止なしの場合だけMetricを生成できます。");
  const{startMs,endMs}=completedFiveMinuteWindow(nowMs);if(Number(config.lastExportWindowEndMs??0)>=endMs)return{skipped:true,reason:"already_published",status:safePublisherStatus(config)};const runId=`${companyId}_${endMs}`;const runRef=db.collection("productionMetricExports").doc(runId);const startedAt=Timestamp.now();
  try{await runRef.create({companyId,projectId:config.projectId,status:"generating",windowStartMs:startMs,windowEndMs:endMs,actorUid,startedAt});}catch(error){if(isAlreadyExists(error))return{skipped:true,reason:"run_exists",status:safePublisherStatus(config)};throw error;}
  await configRef.set({exporterStatus:"generating",lastExportRunId:runId,lastExportError:"",updatedAt:startedAt},{merge:true});
  try{
    const[bucket,infra,queue]=await Promise.all([db.collection("productionMetricBuckets").doc(`${companyId}_${startMs}`).get(),readCloudRunInfrastructure(config.projectId,startMs,endMs),readOldestQueueAge(companyId,endMs)]);const counters=(bucket.data()??{})as ProductionMetricCounterSnapshot;const values=assembleProductionMetricValues({counters,callableRequests:infra.requests,callableFailures:infra.failures,p95LatencyMs:infra.p95LatencyMs,queueOldestAgeMinutes:queue.ageMinutes,monitoringProbeFailures:infra.probeFailures+queue.probeFailures});const timeSeries=buildProductionMetricTimeSeries({projectId:config.projectId,companyId,metrics:config.metrics,values,endMs});
    await monitoring.projects.timeSeries.create({name:`projects/${config.projectId}`,requestBody:{timeSeries}});const completedAt=Timestamp.now();await Promise.all([runRef.set({status:"completed",values,source:{counterBucketId:bucket.id,cloudRunRequestSeries:infra.requestSeries,cloudRunLatencySeries:infra.latencySeries,queueDocuments:queue.documentCount},completedAt},{merge:true}),configRef.set({exporterStatus:"publishing",lastExportedAt:completedAt,lastExportWindowEndMs:endMs,lastExportRunId:runId,lastExportError:"",updatedAt:completedAt},{merge:true}),db.collection("auditLogs").add({companyId,actorUid,action:"production_metric.published",runId,windowStartMs:startMs,windowEndMs:endMs,values,requestId:requestId("production_metric"),createdAt:completedAt})]);return{skipped:false,runId,values,status:safePublisherStatus((await configRef.get()).data()as StoredTelemetryConfig)};
  }catch(error){const failedAt=Timestamp.now();await Promise.all([runRef.set({status:"failed",error:errorMessage(error),failedAt},{merge:true}),configRef.set({exporterStatus:"export_error",lastExportRunId:runId,lastExportError:errorMessage(error),updatedAt:failedAt},{merge:true})]);throw error;}
}

async function readCloudRunInfrastructure(projectId:string,startMs:number,endMs:number){
  const interval={"interval.startTime":new Date(startMs).toISOString(),"interval.endTime":new Date(endMs).toISOString()}as const;const results=await Promise.allSettled([monitoring.projects.timeSeries.list({name:`projects/${projectId}`,filter:'metric.type = "run.googleapis.com/request_count" AND resource.type = "cloud_run_revision"',...interval,view:"FULL",pageSize:10_000}),monitoring.projects.timeSeries.list({name:`projects/${projectId}`,filter:'metric.type = "run.googleapis.com/request_latencies" AND resource.type = "cloud_run_revision"',...interval,"aggregation.alignmentPeriod":"300s","aggregation.perSeriesAligner":"ALIGN_PERCENTILE_95",view:"FULL",pageSize:10_000})]);let requests=0;let failures=0;let p95LatencyMs=0;let probeFailures=0;let requestSeries=0;let latencySeries=0;
  const requestResult=results[0];if(requestResult.status==="fulfilled"){const series=requestResult.value.data.timeSeries??[];requestSeries=series.length;requests=sumNumericTimeSeries(series);failures=requestFailureCount(series);if(requestResult.value.data.nextPageToken)probeFailures++;}else{probeFailures++;}
  const latencyResult=results[1];if(latencyResult.status==="fulfilled"){const series=latencyResult.value.data.timeSeries??[];latencySeries=series.length;p95LatencyMs=maxNumericTimeSeries(series);if(latencyResult.value.data.nextPageToken)probeFailures++;}else{probeFailures++;}
  return{requests,failures,p95LatencyMs,probeFailures,requestSeries,latencySeries};
}

async function readOldestQueueAge(companyId:string,nowMs:number){const collections=["sheetSyncQueue","sheetRowCreateQueue","notificationQueue"];const results=await Promise.allSettled(collections.map(name=>db.collection(name).where("companyId","==",companyId).limit(500).get()));const rows:Array<{status?:string;createdAtMs?:number|null;deliverAtMs?:number|null}>=[];let probeFailures=0;for(const result of results){if(result.status==="rejected"){probeFailures++;continue;}for(const document of result.value.docs){const data=document.data();rows.push({status:String(data.status??""),createdAtMs:millis(data.createdAt),deliverAtMs:millis(data.deliverAt)});}}return{ageMinutes:oldestQueueAgeMinutes(nowMs,rows),probeFailures,documentCount:rows.length};}
function millis(value:unknown){return value instanceof Timestamp?value.toMillis():null;}
function requireConfig(data:StoredTelemetryConfig|undefined){if(!data?.enabled||!data.projectId||!data.metrics)throw new HttpsError("failed-precondition","Cloud Monitoring自動取込設定をONで保存してください。");return{...data,projectId:validateProductionTelemetryProjectId(data.projectId),metrics:normalizeProductionTelemetryMappings(data.metrics)};}
function safePublisherStatus(data:StoredTelemetryConfig|undefined){return{status:String(data?.exporterStatus??"unconfigured"),lastExportedAt:iso(data?.lastExportedAt),lastExportWindowEnd:data?.lastExportWindowEndMs?new Date(data.lastExportWindowEndMs).toISOString():null,lastExportRunId:String(data?.lastExportRunId??""),lastExportError:String(data?.lastExportError??"")};}
function iso(value:unknown){return value instanceof Timestamp?value.toDate().toISOString():null;}
function errorMessage(error:unknown){return(error instanceof Error?error.message:String(error)).slice(0,1000);}
function isAlreadyExists(error:unknown){const code=(error as{code?:string|number}|null)?.code;return code===6||code==="6"||code==="already-exists";}
function assertProductionRuntime(){if((process.env.APP_ENVIRONMENT??"development")!=="production")throw new HttpsError("failed-precondition","本番Metric生成はproduction環境だけで実行できます。");}
