import { Timestamp } from "firebase-admin/firestore";
import { onCall } from "firebase-functions/v2/https";
import { db } from "./firebase";
import { evaluateProductionDeploymentReadiness } from "./production-deployment-readiness-core";
import { companyFromClaims, requireAdmin } from "./utils";

export const getProductionDeploymentReadiness=onCall(async request=>{
  const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const[controlSnap,telemetrySnap]=await Promise.all([db.collection("productionControls").doc(companyId).get(),db.collection("productionTelemetryConfigs").doc(companyId).get()]);const control=controlSnap.data()??{};const telemetry=telemetrySnap.data()??{};const metrics=telemetry.metrics&&typeof telemetry.metrics==="object"?Object.keys(telemetry.metrics):[];const runtimeProjectId=String(process.env.GCLOUD_PROJECT??process.env.GOOGLE_CLOUD_PROJECT??"");const expectedProjectId=String(process.env.PRODUCTION_FIREBASE_PROJECT_ID??runtimeProjectId);
  const readiness=evaluateProductionDeploymentReadiness({nowMs:Date.now(),environment:String(process.env.APP_ENVIRONMENT??"development"),runtimeProjectId,expectedProjectId,productionEnabled:control.productionEnabled===true,emergencyLock:control.emergencyLock===true,activeApprovalPackageId:String(control.activeApprovalPackageId??""),telemetryConfigured:Boolean(telemetry.projectId&&telemetry.metrics),telemetryEnabled:telemetry.enabled===true,telemetryVerified:telemetry.verifiedAt instanceof Timestamp,metricCount:metrics.length,tenantIsolationEnabled:true,exporterStatus:String(telemetry.exporterStatus??"unconfigured"),lastExportedAtMs:millis(telemetry.lastExportedAt),exporterError:String(telemetry.lastExportError??""),collectorStatus:String(telemetry.status??"unconfigured"),lastCollectedAtMs:millis(telemetry.lastCollectedAt),collectorError:String(telemetry.lastError??"")});return{...readiness,environment:String(process.env.APP_ENVIRONMENT??"development"),runtimeProjectId,expectedProjectId,releaseApprovalPackageId:String(control.activeApprovalPackageId??"")};
});
function millis(value:unknown){return value instanceof Timestamp?value.toMillis():null;}
