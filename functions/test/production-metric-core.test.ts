import { assembleProductionMetricValues, buildProductionMetricTimeSeries, completedFiveMinuteWindow, emptyProductionMetricValues, maxNumericTimeSeries, oldestQueueAgeMinutes, requestFailureCount, sumNumericTimeSeries } from "../src/production-metric-core";
import { defaultProductionTelemetryMappings } from "../src/production-telemetry-core";

function equal(actual:unknown,expected:unknown,message:string){if(actual!==expected)throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);}
function rejects(fn:()=>unknown,message:string){let rejected=false;try{fn();}catch{rejected=true;}equal(rejected,true,message);}

const window=completedFiveMinuteWindow(Date.UTC(2026,6,14,9,3));
equal(window.endMs,Date.UTC(2026,6,14,9,0),"window end was not floored");
equal(window.startMs,Date.UTC(2026,6,14,8,55),"window length changed");
rejects(()=>completedFiveMinuteWindow(Number.NaN),"invalid time passed");
equal(Object.keys(emptyProductionMetricValues()).length,13,"metric set is incomplete");

const values=assembleProductionMetricValues({counters:{authenticationAttempts:10,authenticationFailures:1,sheetWriteAttempts:4,sheetWriteFailures:0,notificationAttempts:8,notificationFailures:1,dataMismatchCount:0,criticalOutageCount:0},callableRequests:100,callableFailures:2,p95LatencyMs:841.6,queueOldestAgeMinutes:2.2,monitoringProbeFailures:0});
equal(values.p95LatencyMs,842,"latency was not rounded");
equal(values.callableRequests,100,"call count was lost");
equal(values.authenticationFailures,1,"counter was lost");
rejects(()=>assembleProductionMetricValues({counters:{authenticationAttempts:1,authenticationFailures:2},callableRequests:0,callableFailures:0,p95LatencyMs:0,queueOldestAgeMinutes:0,monitoringProbeFailures:0}),"auth failures above attempts passed");
rejects(()=>assembleProductionMetricValues({counters:{},callableRequests:-1,callableFailures:0,p95LatencyMs:0,queueOldestAgeMinutes:0,monitoringProbeFailures:0}),"negative metric passed");

const series=buildProductionMetricTimeSeries({projectId:"lip-knots-production",companyId:"lipknots",metrics:defaultProductionTelemetryMappings(),values,endMs:window.endMs});
equal(series.length,13,"13 write series were not produced");
equal(series[0]?.metric.labels.company_id,"lipknots","tenant label missing");
equal(series[0]?.resource.labels.project_id,"lip-knots-production","project resource missing");
equal(series[0]?.metricKind,"GAUGE","window metric kind changed");
equal(series.find(item=>item.metric.type.endsWith("p95_latency_ms"))?.points[0]?.value.int64Value,"842","metric value changed");
rejects(()=>buildProductionMetricTimeSeries({projectId:"lip-knots-production",companyId:"bad company",metrics:defaultProductionTelemetryMappings(),values,endMs:window.endMs}),"invalid tenant label passed");

const numeric=[{points:[{value:{int64Value:"3"}},{value:{doubleValue:2}}]}];
equal(sumNumericTimeSeries(numeric),5,"numeric series sum failed");
equal(maxNumericTimeSeries(numeric),3,"numeric series max failed");
equal(requestFailureCount([{metric:{labels:{response_code_class:"2xx"}},points:[{value:{int64Value:"20"}}]},{metric:{labels:{response_code_class:"5xx"}},points:[{value:{int64Value:"2"}}]}]),2,"5xx count failed");
equal(oldestQueueAgeMinutes(Date.UTC(2026,6,14,9,0),[{status:"completed",createdAtMs:Date.UTC(2026,6,14,7,0)},{status:"queued",createdAtMs:Date.UTC(2026,6,14,8,47)}]),13,"queue age failed");
equal(oldestQueueAgeMinutes(Date.UTC(2026,6,14,9,0),[]),0,"empty queue was not zero");

console.log("production metric generation tests passed (21 cases)");
