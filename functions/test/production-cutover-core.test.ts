import {
  buildProductionCutoverTimeline,
  defaultProductionCutoverThresholds,
  evaluateProductionCutover,
  evaluateProductionCutoverEnable,
  ProductionCutoverInput,
  ProductionCutoverObservation,
  ProductionCutoverReadiness,
} from "../src/production-cutover-core";

function equal(actual: unknown, expected: unknown, message: string) { if (actual !== expected) throw new Error(message); }
const start=Date.UTC(2026,6,14,7,0,0);
const readiness:ProductionCutoverReadiness={signedApprovalReady:true,changeFreezeConfirmed:true,backupReferenceReady:true,rollbackOwnerAssigned:true,monitoringDashboardsReady:true,incidentChannelReady:true,supportRosterReady:true,smokePlanReady:true,migrationOwnerAssigned:true};
const observation:ProductionCutoverObservation={observedAtMs:start+5*60_000,authenticationAttempts:100,authenticationFailures:0,callableRequests:200,callableFailures:0,p95LatencyMs:800,sheetWriteFailures:0,notificationFailures:0,queueBacklog:0,smokeFailures:0,dataMismatchCount:0,criticalIncidentCount:0,monitoringProbeFailures:0,evidenceRefs:["cloud-monitoring","smoke-result"]};
const base:ProductionCutoverInput={windowStartMs:start,nowMs:start-15*60_000,readiness,readinessEvidenceRefs:["freeze","backup","owner"],observation:null,consecutiveHealthyObservations:0,thresholds:defaultProductionCutoverThresholds()};
const live:ProductionCutoverInput={...base,nowMs:start+5*60_000,observation};

equal(buildProductionCutoverTimeline().length,7,"timeline must have 7 checkpoints");
equal(evaluateProductionCutover(base).action,"go","passing preflight was blocked");
equal(evaluateProductionCutover({...base,readiness:{...readiness,signedApprovalReady:false}}).action,"pause","missing signed approval passed");
equal(evaluateProductionCutover({...base,readiness:{...readiness,changeFreezeConfirmed:false}}).action,"pause","missing freeze passed");
equal(evaluateProductionCutover({...base,readinessEvidenceRefs:["only-one"]}).action,"pause","insufficient readiness evidence passed");
equal(evaluateProductionCutover(live).action,"go","healthy live observation was blocked");
equal(evaluateProductionCutover({...live,observation:{...observation,authenticationAttempts:500,authenticationFailures:9}}).action,"watch","auth watch band was missed");
equal(evaluateProductionCutover({...live,observation:{...observation,authenticationFailures:3}}).action,"pause","auth pause threshold passed");
equal(evaluateProductionCutover({...live,observation:{...observation,authenticationAttempts:10,authenticationFailures:1}}).action,"rollback_required","auth rollback threshold passed");
equal(evaluateProductionCutover({...live,observation:{...observation,callableFailures:2}}).action,"watch","callable watch band was missed");
equal(evaluateProductionCutover({...live,observation:{...observation,callableFailures:3}}).action,"pause","callable pause threshold passed");
equal(evaluateProductionCutover({...live,observation:{...observation,callableRequests:20,callableFailures:2}}).action,"rollback_required","callable rollback threshold passed");
equal(evaluateProductionCutover({...live,observation:{...observation,p95LatencyMs:1700}}).action,"watch","latency watch band was missed");
equal(evaluateProductionCutover({...live,observation:{...observation,p95LatencyMs:2500}}).action,"pause","latency pause threshold passed");
equal(evaluateProductionCutover({...live,observation:{...observation,p95LatencyMs:6000}}).action,"rollback_required","latency rollback threshold passed");
equal(evaluateProductionCutover({...live,observation:{...observation,sheetWriteFailures:1}}).action,"pause","sheet failure passed");
equal(evaluateProductionCutover({...live,observation:{...observation,sheetWriteFailures:3}}).action,"rollback_required","sheet rollback threshold passed");
equal(evaluateProductionCutover({...live,observation:{...observation,notificationFailures:1}}).action,"watch","notification warning was missed");
equal(evaluateProductionCutover({...live,observation:{...observation,notificationFailures:3}}).action,"pause","notification failure threshold passed");
equal(evaluateProductionCutover({...live,observation:{...observation,queueBacklog:17}}).action,"watch","queue watch band was missed");
equal(evaluateProductionCutover({...live,observation:{...observation,queueBacklog:21}}).action,"pause","queue pause threshold passed");
equal(evaluateProductionCutover({...live,observation:{...observation,queueBacklog:101}}).action,"rollback_required","queue rollback threshold passed");
equal(evaluateProductionCutover({...live,observation:{...observation,smokeFailures:1}}).action,"rollback_required","smoke failure passed");
equal(evaluateProductionCutover({...live,observation:{...observation,dataMismatchCount:1}}).action,"rollback_required","data mismatch passed");
equal(evaluateProductionCutover({...live,observation:{...observation,criticalIncidentCount:1}}).action,"rollback_required","critical incident passed");
equal(evaluateProductionCutover({...live,nowMs:start+20*60_000}).action,"pause","stale monitoring passed");
equal(evaluateProductionCutover({...live,nowMs:start+40*60_000}).action,"rollback_required","long stale monitoring passed");
equal(evaluateProductionCutover({...live,observation:{...observation,evidenceRefs:["one"]}}).action,"pause","insufficient observation evidence passed");
equal(evaluateProductionCutover({...live,nowMs:start+1440*60_000,observation:{...observation,observedAtMs:start+1440*60_000},consecutiveHealthyObservations:11}).action,"watch","completion streak was not enforced");
equal(evaluateProductionCutover({...live,nowMs:start+1440*60_000,observation:{...observation,observedAtMs:start+1440*60_000},consecutiveHealthyObservations:12}).action,"complete","healthy 24h cutover did not complete");
equal(evaluateProductionCutover(live).fingerprint,evaluateProductionCutover({...live,readinessEvidenceRefs:[...live.readinessEvidenceRefs].reverse(),observation:{...observation,evidenceRefs:[...observation.evidenceRefs].reverse()}}).fingerprint,"cutover fingerprint is not deterministic");
equal(evaluateProductionCutover(live).fingerprint,evaluateProductionCutover({...live,nowMs:live.nowMs+60_000}).fingerprint,"stable decision fingerprint changed with wall clock");
let rejected=false;try{evaluateProductionCutover({...live,observation:{...observation,authenticationFailures:101}});}catch{rejected=true;}equal(rejected,true,"invalid failure totals passed");
const enable={runStatus:"ready",action:"go",phase:"preflight",runReleaseId:"v3.4.0",packageReleaseId:"v3.4.0",runApprovalPackageId:"approval-1",approvalPackageId:"approval-1",windowStartMs:start,nowMs:start};
equal(evaluateProductionCutoverEnable(enable).allowed,true,"valid cutover enable was blocked");
equal(evaluateProductionCutover({...base,nowMs:start+4*60_000,productionActive:false}).phase,"preflight","inactive cutover left preflight before enable window closed");
equal(evaluateProductionCutoverEnable({...enable,nowMs:start+5*60_000}).allowed,true,"T plus 5 boundary was blocked");
equal(evaluateProductionCutoverEnable({...enable,runStatus:"paused"}).allowed,false,"paused cutover enabled");
equal(evaluateProductionCutoverEnable({...enable,action:"watch"}).allowed,false,"WATCH cutover enabled");
equal(evaluateProductionCutoverEnable({...enable,phase:"smoke"}).allowed,false,"post-start phase enabled");
equal(evaluateProductionCutoverEnable({...enable,runReleaseId:"other"}).allowed,false,"different release enabled");
equal(evaluateProductionCutoverEnable({...enable,runApprovalPackageId:"other"}).allowed,false,"different approval package enabled");
equal(evaluateProductionCutoverEnable({...enable,nowMs:start+6*60_000}).allowed,false,"outside T plus 5 enabled");

console.log("production cutover command center tests passed (42 cases)");
