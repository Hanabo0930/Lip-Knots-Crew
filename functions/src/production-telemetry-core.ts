import { createHash } from "node:crypto";

export const productionTelemetryMetricDefinitions = [
  { key:"authenticationAttempts", label:"認証試行", reducer:"sum", defaultMetricType:"custom.googleapis.com/lip_knots/authentication_attempts" },
  { key:"authenticationFailures", label:"認証失敗", reducer:"sum", defaultMetricType:"custom.googleapis.com/lip_knots/authentication_failures" },
  { key:"callableRequests", label:"Functions要求", reducer:"sum", defaultMetricType:"custom.googleapis.com/lip_knots/callable_requests" },
  { key:"callableFailures", label:"Functions失敗", reducer:"sum", defaultMetricType:"custom.googleapis.com/lip_knots/callable_failures" },
  { key:"sheetWriteAttempts", label:"スプシ試行", reducer:"sum", defaultMetricType:"custom.googleapis.com/lip_knots/sheet_write_attempts" },
  { key:"sheetWriteFailures", label:"スプシ失敗", reducer:"sum", defaultMetricType:"custom.googleapis.com/lip_knots/sheet_write_failures" },
  { key:"notificationAttempts", label:"通知試行", reducer:"sum", defaultMetricType:"custom.googleapis.com/lip_knots/notification_attempts" },
  { key:"notificationFailures", label:"通知失敗", reducer:"sum", defaultMetricType:"custom.googleapis.com/lip_knots/notification_failures" },
  { key:"p95LatencyMs", label:"p95レイテンシ", reducer:"max", defaultMetricType:"custom.googleapis.com/lip_knots/p95_latency_ms" },
  { key:"queueOldestAgeMinutes", label:"最古queue", reducer:"max", defaultMetricType:"custom.googleapis.com/lip_knots/queue_oldest_age_minutes" },
  { key:"dataMismatchCount", label:"データ差異", reducer:"sum", defaultMetricType:"custom.googleapis.com/lip_knots/data_mismatch_count" },
  { key:"criticalOutageCount", label:"重大停止", reducer:"sum", defaultMetricType:"custom.googleapis.com/lip_knots/critical_outage_count" },
  { key:"monitoringProbeFailures", label:"監視probe失敗", reducer:"sum", defaultMetricType:"custom.googleapis.com/lip_knots/monitoring_probe_failures" },
] as const;

export type ProductionTelemetryMetricKey = typeof productionTelemetryMetricDefinitions[number]["key"];
export type ProductionTelemetryReducer = typeof productionTelemetryMetricDefinitions[number]["reducer"];
export type ProductionTelemetryMetricMappings = Record<ProductionTelemetryMetricKey,string>;
export type MonitoringTypedValue = { int64Value?:string|null;doubleValue?:number|null };
export type MonitoringSeries = { points?:Array<{ value?:MonitoringTypedValue|null }>|null };

export type ProductionTelemetryObservation = {
  observedAtIso:string;authenticationAttempts:number;authenticationFailures:number;callableRequests:number;callableFailures:number;
  sheetWriteAttempts:number;sheetWriteFailures:number;notificationAttempts:number;notificationFailures:number;p95LatencyMs:number;
  queueOldestAgeMinutes:number;dataMismatchCount:number;criticalOutageCount:number;monitoringProbeFailures:number;evidenceRefs:string[];
};

const metricTypePattern=/^[a-z][a-z0-9_.-]*\.googleapis\.com\/[A-Za-z0-9_.\/-]{1,180}$/u;
const projectIdPattern=/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;

export function defaultProductionTelemetryMappings():ProductionTelemetryMetricMappings {
  return Object.fromEntries(productionTelemetryMetricDefinitions.map(definition=>[definition.key,definition.defaultMetricType])) as ProductionTelemetryMetricMappings;
}

export function validateProductionTelemetryProjectId(projectId:string):string {
  const value=projectId.trim();
  if(!projectIdPattern.test(value))throw new Error("Cloud Monitoring Project IDが不正です。");
  return value;
}

export function normalizeProductionTelemetryMappings(input:Partial<Record<ProductionTelemetryMetricKey,string>>):ProductionTelemetryMetricMappings {
  const output={} as ProductionTelemetryMetricMappings;
  for(const definition of productionTelemetryMetricDefinitions){
    const value=String(input[definition.key]??"").trim();
    if(!metricTypePattern.test(value))throw new Error(`${definition.label}のMetric typeが不正です。`);
    output[definition.key]=value;
  }
  return output;
}

export function monitoringMetricFilter(metricType:string,companyId?:string):string {
  const normalized=normalizeProductionTelemetryMappings({...defaultProductionTelemetryMappings(),authenticationAttempts:metricType}).authenticationAttempts;
  const tenant=companyId?.trim();
  if(tenant&&!/^[A-Za-z0-9_-]{1,100}$/u.test(tenant))throw new Error("企業IDが不正です。");
  return `metric.type = "${normalized}"${tenant?` AND metric.labels.company_id = "${tenant}"`:""}`;
}

export function numericMonitoringValue(value:MonitoringTypedValue|undefined|null):number|null {
  const candidate=value?.doubleValue??(value?.int64Value==null?null:Number(value.int64Value));
  return candidate==null||!Number.isFinite(candidate)?null:candidate;
}

export function reduceMonitoringSeries(series:MonitoringSeries[],reducer:ProductionTelemetryReducer):number {
  const values=series.flatMap(item=>(item.points??[]).map(point=>numericMonitoringValue(point.value))).filter((value):value is number=>value!=null);
  if(!values.length)throw new Error("観測期間内に数値データがありません。");
  const result=reducer==="sum"?values.reduce((total,value)=>total+value,0):Math.max(...values);
  if(!Number.isFinite(result)||result<0)throw new Error("監視値は0以上の有限数である必要があります。");
  return result;
}

export function buildProductionTelemetryObservation(params:{projectId:string;metrics:ProductionTelemetryMetricMappings;values:Record<ProductionTelemetryMetricKey,number>;observedAtIso:string;windowStartIso:string}):ProductionTelemetryObservation {
  const projectId=validateProductionTelemetryProjectId(params.projectId);
  const metrics=normalizeProductionTelemetryMappings(params.metrics);
  if(!Number.isFinite(Date.parse(params.observedAtIso))||!Number.isFinite(Date.parse(params.windowStartIso)))throw new Error("監視期間が不正です。");
  const rounded={} as Record<ProductionTelemetryMetricKey,number>;
  for(const definition of productionTelemetryMetricDefinitions){
    const value=params.values[definition.key];
    if(!Number.isFinite(value)||value<0)throw new Error(`${definition.label}の監視値が不正です。`);
    rounded[definition.key]=Math.round(value);
  }
  if(rounded.authenticationFailures>rounded.authenticationAttempts||rounded.callableFailures>rounded.callableRequests||rounded.sheetWriteFailures>rounded.sheetWriteAttempts||rounded.notificationFailures>rounded.notificationAttempts)throw new Error("Cloud Monitoringの失敗数が試行数を超えています。");
  const evidenceRefs=productionTelemetryMetricDefinitions.map(definition=>`cloud-monitoring://projects/${projectId}/${metrics[definition.key]}?start=${encodeURIComponent(params.windowStartIso)}&end=${encodeURIComponent(params.observedAtIso)}`);
  return {observedAtIso:params.observedAtIso,...rounded,evidenceRefs};
}

export function productionTelemetryFingerprint(projectId:string,metrics:ProductionTelemetryMetricMappings):string {
  const normalizedProject=validateProductionTelemetryProjectId(projectId);
  const normalizedMetrics=normalizeProductionTelemetryMappings(metrics);
  return createHash("sha256").update(JSON.stringify({projectId:normalizedProject,metrics:normalizedMetrics})).digest("hex");
}
