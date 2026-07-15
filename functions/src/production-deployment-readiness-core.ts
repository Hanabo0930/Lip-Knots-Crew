import { createHash } from "node:crypto";

export type ProductionDeploymentReadinessInput={nowMs:number;environment:string;runtimeProjectId:string;expectedProjectId:string;productionEnabled:boolean;emergencyLock:boolean;activeApprovalPackageId:string;telemetryConfigured:boolean;telemetryEnabled:boolean;telemetryVerified:boolean;metricCount:number;tenantIsolationEnabled:boolean;exporterStatus:string;lastExportedAtMs:number|null;exporterError:string;collectorStatus:string;lastCollectedAtMs:number|null;collectorError:string};
export type ProductionDeploymentCheck={key:string;label:string;passed:boolean;actual:string|number|boolean;required:string};

export function evaluateProductionDeploymentReadiness(input:ProductionDeploymentReadinessInput){
  if(!Number.isFinite(input.nowMs)||input.nowMs<=0)throw new Error("診断時刻が不正です。");const age=(value:number|null)=>value==null?Number.POSITIVE_INFINITY:Math.max(0,Math.floor((input.nowMs-value)/60_000));const exportAge=age(input.lastExportedAtMs);const collectAge=age(input.lastCollectedAtMs);
  const checks:ProductionDeploymentCheck[]=[
    check("environment","production環境",input.environment==="production",input.environment,"production"),
    check("project","実行Project固定",Boolean(input.runtimeProjectId)&&input.runtimeProjectId===input.expectedProjectId,`${input.runtimeProjectId||"未設定"} / ${input.expectedProjectId||"未設定"}`,"一致"),
    check("production_enabled","署名承認Release有効",input.productionEnabled&&Boolean(input.activeApprovalPackageId),input.productionEnabled,"有効・承認IDあり"),
    check("emergency_lock","全体停止なし",!input.emergencyLock,input.emergencyLock,"false"),
    check("telemetry_config","監視設定",input.telemetryConfigured&&input.telemetryEnabled,input.telemetryEnabled,"保存済み・ON"),
    check("metric_count","Metric 13指標",input.metricCount===13,input.metricCount,"13"),
    check("tenant_isolation","企業ラベル分離",input.tenantIsolationEnabled,input.tenantIsolationEnabled,"company_id必須"),
    check("telemetry_verified","接続テスト",input.telemetryVerified,input.telemetryVerified,"合格"),
    check("exporter","実測生成",input.exporterStatus==="publishing"&&!input.exporterError,input.exporterStatus,input.exporterError?"エラー0":"publishing"),
    check("export_fresh","生成鮮度",exportAge<=10,Number.isFinite(exportAge)?exportAge:"未生成","10分以内"),
    check("collector","SLO取込",input.collectorStatus==="collecting"&&!input.collectorError,input.collectorStatus,input.collectorError?"エラー0":"collecting"),
    check("collect_fresh","取込鮮度",collectAge<=10,Number.isFinite(collectAge)?collectAge:"未取込","10分以内"),
  ];
  const blockers=checks.filter(item=>!item.passed);const fingerprint=createHash("sha256").update(JSON.stringify(checks.map(({key,passed,actual})=>({key,passed,actual})))).digest("hex");return{ready:blockers.length===0,checks,blockers,fingerprint,exportAgeMinutes:Number.isFinite(exportAge)?exportAge:null,collectAgeMinutes:Number.isFinite(collectAge)?collectAge:null};
}
function check(key:string,label:string,passed:boolean,actual:string|number|boolean,required:string):ProductionDeploymentCheck{return{key,label,passed,actual,required};}
