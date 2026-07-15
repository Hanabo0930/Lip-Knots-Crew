export type TenantStatus = "trial"|"active"|"grace"|"suspended"|"cancelled";
export type PlanCode = "free"|"light"|"standard"|"pro";
export type PlanDefinition = {
  code:PlanCode; maxActiveStaff:number; maxAdminUsers:number;
  maxMonthlyJobs:number; storageGb:number; features:string[];
};
export const PLAN_CATALOG:Record<PlanCode,PlanDefinition>={
  free:{code:"free",maxActiveStaff:10,maxAdminUsers:1,maxMonthlyJobs:30,storageGb:1,features:["jobs","applications","basic_reports"]},
  light:{code:"light",maxActiveStaff:50,maxAdminUsers:3,maxMonthlyJobs:300,storageGb:10,features:["jobs","applications","reports","notifications"]},
  standard:{code:"standard",maxActiveStaff:300,maxAdminUsers:10,maxMonthlyJobs:1500,storageGb:100,features:["jobs","applications","reports","notifications","sheet_sync","expenses","analytics","custom_branding"]},
  pro:{code:"pro",maxActiveStaff:5000,maxAdminUsers:50,maxMonthlyJobs:10000,storageGb:1000,features:["jobs","applications","reports","notifications","sheet_sync","expenses","analytics","custom_branding","custom_domain","api","audit_export","priority_support"]}
};
export type TenantSubscription={
  tenantId:string;planCode:PlanCode;status:TenantStatus;
  trialEndsAt?:string|null;graceEndsAt?:string|null;
  activeStaff:number;adminUsers:number;monthlyJobs:number;storageBytes:number;
};
export function evaluateTenantAccess(s:TenantSubscription,nowIso:string){
  const p=PLAN_CATALOG[s.planCode],reasons:string[]=[],exceeded:string[]=[];
  const now=Date.parse(nowIso);
  if(s.status==="cancelled")return{allowed:false,readOnly:true,reasons:["契約終了"],exceeded};
  if(s.status==="suspended")return{allowed:false,readOnly:true,reasons:["契約停止"],exceeded};
  if(s.status==="trial"&&s.trialEndsAt&&Date.parse(s.trialEndsAt)<now)reasons.push("体験期間終了");
  if(s.status==="grace"&&s.graceEndsAt&&Date.parse(s.graceEndsAt)<now)reasons.push("猶予期間終了");
  if(s.activeStaff>p.maxActiveStaff)exceeded.push("active_staff");
  if(s.adminUsers>p.maxAdminUsers)exceeded.push("admin_users");
  if(s.monthlyJobs>p.maxMonthlyJobs)exceeded.push("monthly_jobs");
  if(s.storageBytes>p.storageGb*1024**3)exceeded.push("storage");
  return{allowed:reasons.length===0,readOnly:reasons.length>0||exceeded.length>0,reasons,exceeded};
}
export function featureEnabled(plan:PlanCode,feature:string,overrides:Record<string,boolean>={}){
  return feature in overrides?overrides[feature]===true:PLAN_CATALOG[plan].features.includes(feature);
}
