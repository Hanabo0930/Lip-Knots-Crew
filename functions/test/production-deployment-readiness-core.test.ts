import { evaluateProductionDeploymentReadiness, ProductionDeploymentReadinessInput } from "../src/production-deployment-readiness-core";

function equal(actual:unknown,expected:unknown,message:string){if(actual!==expected)throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);}
const now=Date.UTC(2026,6,14,9,5);const base:ProductionDeploymentReadinessInput={nowMs:now,environment:"production",runtimeProjectId:"lip-knots-production",expectedProjectId:"lip-knots-production",productionEnabled:true,emergencyLock:false,activeApprovalPackageId:"approval-v36",telemetryConfigured:true,telemetryEnabled:true,telemetryVerified:true,metricCount:13,tenantIsolationEnabled:true,exporterStatus:"publishing",lastExportedAtMs:now-4*60_000,exporterError:"",collectorStatus:"collecting",lastCollectedAtMs:now-2*60_000,collectorError:""};
const evaluate=(changes:Partial<ProductionDeploymentReadinessInput>)=>evaluateProductionDeploymentReadiness({...base,...changes});
equal(evaluate({}).ready,true,"healthy deployment was blocked");
equal(evaluate({}).checks.length,12,"check count changed");
equal(evaluate({environment:"staging"}).ready,false,"staging passed");
equal(evaluate({runtimeProjectId:"other-production"}).blockers.some(item=>item.key==="project"),true,"project mismatch passed");
equal(evaluate({productionEnabled:false}).ready,false,"disabled production passed");
equal(evaluate({activeApprovalPackageId:""}).ready,false,"missing approval passed");
equal(evaluate({emergencyLock:true}).ready,false,"emergency lock passed");
equal(evaluate({telemetryConfigured:false}).ready,false,"missing telemetry passed");
equal(evaluate({telemetryEnabled:false}).ready,false,"disabled telemetry passed");
equal(evaluate({metricCount:12}).ready,false,"incomplete metrics passed");
equal(evaluate({tenantIsolationEnabled:false}).ready,false,"tenant mixing passed");
equal(evaluate({telemetryVerified:false}).ready,false,"unverified telemetry passed");
equal(evaluate({exporterStatus:"export_error"}).ready,false,"export error passed");
equal(evaluate({exporterError:"permission denied"}).ready,false,"export error message passed");
equal(evaluate({lastExportedAtMs:now-11*60_000}).ready,false,"stale export passed");
equal(evaluate({collectorStatus:"collection_error"}).ready,false,"collection error passed");
equal(evaluate({lastCollectedAtMs:null}).ready,false,"missing collection passed");
equal(evaluate({}).fingerprint,evaluate({}).fingerprint,"fingerprint is not deterministic");

console.log("production deployment runtime readiness tests passed (18 cases)");
