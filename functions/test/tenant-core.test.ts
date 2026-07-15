import {evaluateTenantAccess,featureEnabled} from "../src/tenant-core";
function eq(a:unknown,b:unknown,m:string){if(a!==b)throw new Error(m);}
const b={tenantId:"acme",planCode:"standard" as const,status:"active" as const,activeStaff:20,adminUsers:2,monthlyJobs:100,storageBytes:100};
eq(evaluateTenantAccess(b,new Date().toISOString()).allowed,true,"active");
eq(evaluateTenantAccess({...b,status:"suspended"},new Date().toISOString()).allowed,false,"suspend");
eq(evaluateTenantAccess({...b,activeStaff:999},new Date().toISOString()).readOnly,true,"limit");
eq(featureEnabled("pro","custom_domain"),true,"feature");
console.log("tenant core tests passed");
