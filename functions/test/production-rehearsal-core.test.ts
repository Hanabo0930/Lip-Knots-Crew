import {
  buildProductionRehearsalPlan,
  evaluateProductionRehearsal,
  ProductionRehearsalMetrics,
  ProductionRehearsalPlanInput,
} from "../src/production-rehearsal-core";

function equal(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(message);
}

const plan:ProductionRehearsalPlanInput={releaseId:"v3.4.0",sourceProjectId:"lkc-staging",restoreProjectId:"lkc-restore-drill",backupBucket:"gs://lkc-rehearsal",maxRtoMinutes:60,maxRpoMinutes:5};
const hash="a".repeat(64);
const passing:ProductionRehearsalMetrics={
  freezeConfirmed:true,firestoreExportComplete:true,storageManifestComplete:true,authExportComplete:true,
  sourceDocumentCount:1200,sourceStorageObjectCount:300,sourceAuthUserCount:50,sourceSnapshotSha256:hash,
  restoreComplete:true,restoredDocumentCount:1200,restoredStorageObjectCount:300,restoredAuthUserCount:50,restoredSnapshotSha256:hash,
  securityRulesDeployed:true,indexesReady:true,sampleMismatchCount:0,permissionProbeFailures:0,smokeFailures:0,
  migrationDryRunComplete:true,plannedMigrationCount:1200,dryRunAppliedCount:1200,migrationDiffCount:0,
  rollbackComplete:true,rollbackRtoMinutes:42,rollbackDataLossMinutes:0,postRollbackSmokeFailures:0,
  evidenceRefs:["freeze","firestore","storage","auth","restore","migration","rollback"],
};

equal(buildProductionRehearsalPlan(plan).phases.length,7,"rehearsal plan phase count is wrong");
equal(evaluateProductionRehearsal(plan,passing).eligible,true,"passing rehearsal was blocked");
equal(evaluateProductionRehearsal(plan,{...passing,freezeConfirmed:false}).eligible,false,"missing freeze passed");
equal(evaluateProductionRehearsal(plan,{...passing,firestoreExportComplete:false}).eligible,false,"missing firestore backup passed");
equal(evaluateProductionRehearsal(plan,{...passing,storageManifestComplete:false}).eligible,false,"missing storage backup passed");
equal(evaluateProductionRehearsal(plan,{...passing,authExportComplete:false}).eligible,false,"missing auth backup passed");
equal(evaluateProductionRehearsal(plan,{...passing,restoredDocumentCount:1199}).eligible,false,"document mismatch passed");
equal(evaluateProductionRehearsal(plan,{...passing,restoredStorageObjectCount:299}).eligible,false,"storage mismatch passed");
equal(evaluateProductionRehearsal(plan,{...passing,restoredAuthUserCount:49}).eligible,false,"auth mismatch passed");
equal(evaluateProductionRehearsal(plan,{...passing,restoredSnapshotSha256:"b".repeat(64)}).eligible,false,"hash mismatch passed");
equal(evaluateProductionRehearsal(plan,{...passing,permissionProbeFailures:1}).eligible,false,"permission failure passed");
equal(evaluateProductionRehearsal(plan,{...passing,smokeFailures:1}).eligible,false,"smoke failure passed");
equal(evaluateProductionRehearsal(plan,{...passing,dryRunAppliedCount:1199}).eligible,false,"migration count mismatch passed");
equal(evaluateProductionRehearsal(plan,{...passing,migrationDiffCount:1}).eligible,false,"migration diff passed");
equal(evaluateProductionRehearsal(plan,{...passing,rollbackRtoMinutes:61}).eligible,false,"RTO breach passed");
equal(evaluateProductionRehearsal(plan,{...passing,rollbackDataLossMinutes:6}).eligible,false,"RPO breach passed");
equal(evaluateProductionRehearsal(plan,{...passing,postRollbackSmokeFailures:1}).eligible,false,"rollback smoke failure passed");
equal(evaluateProductionRehearsal(plan,{...passing,evidenceRefs:passing.evidenceRefs.slice(0,6)}).eligible,false,"insufficient evidence passed");
equal(evaluateProductionRehearsal(plan,passing).fingerprint,evaluateProductionRehearsal(plan,{...passing,evidenceRefs:[...passing.evidenceRefs].reverse()}).fingerprint,"fingerprint is not deterministic");
let rejected=false;try{buildProductionRehearsalPlan({...plan,restoreProjectId:plan.sourceProjectId});}catch{rejected=true;}equal(rejected,true,"same restore project was accepted");

console.log("production rehearsal and restore drill tests passed (20 cases)");
