import {billingEventKey,mapBillingToTenantStatus,nextPlanChange} from "../src/billing-core";
function eq(a:unknown,b:unknown,m:string){if(a!==b)throw new Error(m);}
eq(mapBillingToTenantStatus({tenantId:"a",planCode:"standard",status:"active",failureCount:0},new Date().toISOString()).tenantStatus,"active","active");
eq(mapBillingToTenantStatus({tenantId:"a",planCode:"standard",status:"past_due",failureCount:2},new Date().toISOString()).tenantStatus,"grace","grace");
eq(nextPlanChange({currentPlan:"standard",requestedPlan:"pro",effective:"immediate",hasUnpaidInvoice:false}).allowed,true,"upgrade");
eq(nextPlanChange({currentPlan:"pro",requestedPlan:"light",effective:"immediate",hasUnpaidInvoice:false}).allowed,false,"downgrade");
eq(billingEventKey({provider:"stripe",eventId:"evt_1",tenantId:"acme"}),"stripe_evt_1_acme","key");
console.log("billing core tests passed");
