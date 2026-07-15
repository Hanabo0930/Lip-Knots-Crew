import {
  buildProductionTelemetryObservation,
  defaultProductionTelemetryMappings,
  monitoringMetricFilter,
  normalizeProductionTelemetryMappings,
  numericMonitoringValue,
  productionTelemetryFingerprint,
  productionTelemetryMetricDefinitions,
  reduceMonitoringSeries,
  validateProductionTelemetryProjectId,
} from "../src/production-telemetry-core";

function equal(actual:unknown,expected:unknown,message:string){if(actual!==expected)throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);}
function rejects(fn:()=>unknown,message:string){let rejected=false;try{fn();}catch{rejected=true;}equal(rejected,true,message);}

const metrics=defaultProductionTelemetryMappings();
equal(productionTelemetryMetricDefinitions.length,13,"required metric count changed");
equal(Object.keys(metrics).length,13,"default mapping is incomplete");
equal(validateProductionTelemetryProjectId("lip-knots-prod"),"lip-knots-prod","valid project rejected");
rejects(()=>validateProductionTelemetryProjectId("INVALID PROJECT"),"invalid project passed");
equal(monitoringMetricFilter(metrics.callableRequests),`metric.type = "${metrics.callableRequests}"`,"filter changed");
equal(monitoringMetricFilter(metrics.callableRequests,"lipknots"),`metric.type = "${metrics.callableRequests}" AND metric.labels.company_id = "lipknots"`,"tenant filter missing");
rejects(()=>monitoringMetricFilter(metrics.callableRequests,"bad company"),"invalid tenant filter passed");
rejects(()=>normalizeProductionTelemetryMappings({...metrics,callableRequests:"bad\nmetric"}),"filter injection passed");
equal(numericMonitoringValue({int64Value:"12"}),12,"int64 conversion failed");
equal(numericMonitoringValue({doubleValue:1.5}),1.5,"double conversion failed");
equal(numericMonitoringValue({int64Value:"nope"}),null,"invalid int64 passed");
equal(reduceMonitoringSeries([{points:[{value:{int64Value:"2"}},{value:{doubleValue:3}}]}],"sum"),5,"sum reducer failed");
equal(reduceMonitoringSeries([{points:[{value:{int64Value:"2"}}]},{points:[{value:{doubleValue:8}}]}],"max"),8,"max reducer failed");
rejects(()=>reduceMonitoringSeries([],"sum"),"missing metric data passed");
rejects(()=>reduceMonitoringSeries([{points:[{value:{doubleValue:-1}}]}],"max"),"negative metric passed");

const values=Object.fromEntries(productionTelemetryMetricDefinitions.map(definition=>[definition.key,definition.reducer==="sum"?10:2])) as Record<typeof productionTelemetryMetricDefinitions[number]["key"],number>;
values.authenticationFailures=1;values.callableFailures=1;values.sheetWriteFailures=1;values.notificationFailures=1;
const observation=buildProductionTelemetryObservation({projectId:"lip-knots-prod",metrics,values,windowStartIso:"2026-07-14T08:55:00.000Z",observedAtIso:"2026-07-14T09:00:00.000Z"});
equal(observation.evidenceRefs.length,13,"metric evidence is incomplete");
equal(observation.p95LatencyMs,2,"max metric was lost");
equal(observation.authenticationAttempts,10,"count metric was lost");
equal(observation.observedAtIso,"2026-07-14T09:00:00.000Z","observation time changed");
rejects(()=>buildProductionTelemetryObservation({projectId:"lip-knots-prod",metrics,values:{...values,authenticationFailures:11},windowStartIso:"2026-07-14T08:55:00.000Z",observedAtIso:"2026-07-14T09:00:00.000Z"}),"failures above attempts passed");
rejects(()=>buildProductionTelemetryObservation({projectId:"lip-knots-prod",metrics,values:{...values,p95LatencyMs:Number.NaN},windowStartIso:"2026-07-14T08:55:00.000Z",observedAtIso:"2026-07-14T09:00:00.000Z"}),"NaN metric passed");
equal(productionTelemetryFingerprint("lip-knots-prod",metrics),productionTelemetryFingerprint("lip-knots-prod",metrics),"fingerprint is not deterministic");
equal(productionTelemetryFingerprint("lip-knots-prod",metrics)===productionTelemetryFingerprint("lip-knots-prod",{...metrics,p95LatencyMs:"custom.googleapis.com/lip_knots/p95_latency_ms_v2"}),false,"mapping change did not change fingerprint");

console.log("production telemetry ingestion tests passed (21 cases)");
