export function customizationEstimate(i:{staffCount:number;monthlyJobs:number;adminUsers:number;selectedModules:string[];customScreens:number;customReports:number;externalIntegrations:number;urgency:"normal"|"one_week"|"rush"}){
 let plan:"free"|"light"|"standard"|"pro"="free";
 if(i.staffCount>10||i.monthlyJobs>30||i.adminUsers>1)plan="light";
 if(i.staffCount>50||i.monthlyJobs>300||i.adminUsers>3)plan="standard";
 if(i.staffCount>300||i.monthlyJobs>1500||i.adminUsers>10)plan="pro";
 const base={free:0,light:29800,standard:79800,pro:198000}[plan];
 const setupFeeYen=i.customScreens*80000+i.customReports*60000+i.externalIntegrations*120000+i.selectedModules.length*30000;
 let estimatedDays=Math.max(1,Math.ceil(i.customScreens*1.2+i.customReports*.8+i.externalIntegrations*1.5+i.selectedModules.length*.35));
 const notes:string[]=[];
 if(i.urgency==="one_week"&&estimatedDays>7)notes.push("第1期・第2期へ分割");
 if(i.urgency==="rush"){estimatedDays=Math.max(1,Math.ceil(estimatedDays*.7));notes.push("特急対応");}
 return{recommendedPlan:plan,setupFeeYen,monthlyFeeYen:base+i.selectedModules.length*3000,estimatedDays,deliverableWithinSevenDays:estimatedDays<=7,notes};
}
export function roiEstimate(i:{currentMonthlyHours:number;afterMonthlyHours:number;hourlyCostYen:number;monthlyFeeYen:number;setupFeeYen:number}){
 const monthlyHoursSaved=Math.max(0,i.currentMonthlyHours-i.afterMonthlyHours),annualHoursSaved=monthlyHoursSaved*12;
 const annualLaborSavingYen=annualHoursSaved*i.hourlyCostYen,annualSystemCostYen=i.monthlyFeeYen*12+i.setupFeeYen;
 const monthlyBenefit=monthlyHoursSaved*i.hourlyCostYen-i.monthlyFeeYen;
 return{monthlyHoursSaved,annualHoursSaved,annualLaborSavingYen,annualSystemCostYen,annualNetBenefitYen:annualLaborSavingYen-annualSystemCostYen,paybackMonths:monthlyBenefit>0?Math.ceil(i.setupFeeYen/monthlyBenefit):null};
}
