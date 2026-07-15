import {moduleEstimate,resolveModules} from "../src/module-catalog-core";
import {cloneIndustryTemplate} from "../src/industry-template-core";
import {customizationEstimate,roiEstimate} from "../src/customization-estimate-core";
import {proposalMarkdown} from "../src/proposal-core";
function ok(v:unknown,m:string){if(!v)throw new Error(m);}
ok(resolveModules(["shipping"]).missingDependencies.includes("inventory"),"dependency");
ok(moduleEstimate(["contracts","inventory"]).canDeliverWithinSevenDays,"7 days");
ok(cloneIndustryTemplate("sampling","acme").modules.includes("jobs"),"template");
ok(customizationEstimate({staffCount:300,monthlyJobs:400,adminUsers:5,selectedModules:["contracts"],customScreens:1,customReports:1,externalIntegrations:0,urgency:"one_week"}).recommendedPlan==="standard","plan");
ok(roiEstimate({currentMonthlyHours:80,afterMonthlyHours:18,hourlyCostYen:3000,monthlyFeeYen:79800,setupFeeYen:300000}).annualHoursSaved===744,"roi");
ok(proposalMarkdown({companyName:"A社",contactName:"田中様",industry:"試食",recommendedPlan:"Standard",setupFeeYen:100000,monthlyFeeYen:79800,estimatedDays:7,annualNetBenefitYen:2000000}).includes("7営業日"),"proposal");
console.log("v1.9 core tests passed");
