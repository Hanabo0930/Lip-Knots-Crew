import { normalizeProductionTelemetryMappings, productionTelemetryMetricDefinitions, ProductionTelemetryMetricKey, ProductionTelemetryMetricMappings, validateProductionTelemetryProjectId } from "./production-telemetry-core";

export type ProductionMetricValues=Record<ProductionTelemetryMetricKey,number>;
export type ProductionMetricCounterSnapshot=Partial<Pick<ProductionMetricValues,"authenticationAttempts"|"authenticationFailures"|"sheetWriteAttempts"|"sheetWriteFailures"|"notificationAttempts"|"notificationFailures"|"dataMismatchCount"|"criticalOutageCount">>;
export type MonitoringWriteSeries={metric:{type:string;labels:{company_id:string}};resource:{type:"global";labels:{project_id:string}};metricKind:"GAUGE";valueType:"INT64";points:Array<{interval:{endTime:string};value:{int64Value:string}}>};

const fiveMinutesMs=5*60_000;

export function completedFiveMinuteWindow(nowMs:number){
  if(!Number.isFinite(nowMs)||nowMs<=0)throw new Error("基準時刻が不正です。");
  const endMs=Math.floor(nowMs/fiveMinutesMs)*fiveMinutesMs;return{startMs:endMs-fiveMinutesMs,endMs};
}

export function emptyProductionMetricValues():ProductionMetricValues {
  return Object.fromEntries(productionTelemetryMetricDefinitions.map(definition=>[definition.key,0])) as ProductionMetricValues;
}

export function assembleProductionMetricValues(input:{counters:ProductionMetricCounterSnapshot;callableRequests:number;callableFailures:number;p95LatencyMs:number;queueOldestAgeMinutes:number;monitoringProbeFailures:number}):ProductionMetricValues {
  const values={...emptyProductionMetricValues(),...input.counters,callableRequests:input.callableRequests,callableFailures:input.callableFailures,p95LatencyMs:input.p95LatencyMs,queueOldestAgeMinutes:input.queueOldestAgeMinutes,monitoringProbeFailures:input.monitoringProbeFailures};
  for(const definition of productionTelemetryMetricDefinitions){const value=values[definition.key];if(!Number.isFinite(value)||value<0)throw new Error(`${definition.label}は0以上の有限数で指定してください。`);values[definition.key]=Math.round(value);}
  if(values.authenticationFailures>values.authenticationAttempts||values.callableFailures>values.callableRequests||values.sheetWriteFailures>values.sheetWriteAttempts||values.notificationFailures>values.notificationAttempts)throw new Error("失敗数が試行数を超えています。");
  return values;
}

export function buildProductionMetricTimeSeries(params:{projectId:string;companyId:string;metrics:ProductionTelemetryMetricMappings;values:ProductionMetricValues;endMs:number}):MonitoringWriteSeries[]{
  const projectId=validateProductionTelemetryProjectId(params.projectId);const metrics=normalizeProductionTelemetryMappings(params.metrics);const companyId=params.companyId.trim();if(!/^[A-Za-z0-9_-]{1,100}$/u.test(companyId))throw new Error("企業IDが不正です。");
  const endTime=new Date(params.endMs).toISOString();if(!Number.isFinite(Date.parse(endTime)))throw new Error("Metric時刻が不正です。");
  return productionTelemetryMetricDefinitions.map(definition=>{const value=params.values[definition.key];if(!Number.isSafeInteger(value)||value<0)throw new Error(`${definition.label}は0以上の安全な整数で指定してください。`);return{metric:{type:metrics[definition.key],labels:{company_id:companyId}},resource:{type:"global",labels:{project_id:projectId}},metricKind:"GAUGE",valueType:"INT64",points:[{interval:{endTime},value:{int64Value:String(value)}}]};});
}

export function sumNumericTimeSeries(series:Array<{points?:Array<{value?:{int64Value?:string|null;doubleValue?:number|null}|null}>|null}>):number {
  let total=0;for(const item of series){for(const point of item.points??[]){const value=point.value?.doubleValue??Number(point.value?.int64Value??Number.NaN);if(Number.isFinite(value)&&value>=0)total+=value;}}
  return total;
}

export function requestFailureCount(series:Array<{metric?:{labels?:Record<string,string>|null}|null;points?:Array<{value?:{int64Value?:string|null;doubleValue?:number|null}|null}>|null}>):number {
  return sumNumericTimeSeries(series.filter(item=>{const labels=item.metric?.labels??{};const responseClass=String(labels.response_code_class??labels.response_code??"");return responseClass.startsWith("5");}));
}

export function maxNumericTimeSeries(series:Array<{points?:Array<{value?:{int64Value?:string|null;doubleValue?:number|null}|null}>|null}>):number {
  const values:number[]=[];for(const item of series){for(const point of item.points??[]){const value=point.value?.doubleValue??Number(point.value?.int64Value??Number.NaN);if(Number.isFinite(value)&&value>=0)values.push(value);}}
  return values.length?Math.max(...values):0;
}

export function oldestQueueAgeMinutes(nowMs:number,documents:Array<{status?:string;createdAtMs?:number|null;deliverAtMs?:number|null}>):number {
  const active=new Set(["pending","processing","retry_wait","queued","sending"]);let oldest=nowMs;let found=false;
  for(const document of documents){if(!active.has(String(document.status??"")))continue;const time=Number(document.createdAtMs??document.deliverAtMs??Number.NaN);if(Number.isFinite(time)&&time<=nowMs){oldest=Math.min(oldest,time);found=true;}}
  return found?Math.max(0,Math.ceil((nowMs-oldest)/60_000)):0;
}
