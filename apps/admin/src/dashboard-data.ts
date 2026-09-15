import type {DashboardData,Job} from "./App";

export async function readDashboard(month:string,read:()=>Promise<{data:unknown}>,demoJobs?:Job[]):Promise<DashboardData>{
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new Error("集計する年月を選択してください。");
  if(demoJobs){
    const {buildMonthlyDashboard}=await import("../../../functions/src/analytics-core");
    return buildMonthlyDashboard(demoJobs,month,"2026-07-13");
  }
  const data=(await read()).data as DashboardData|null;
  const finite=(value:unknown)=>typeof value==="number"&&Number.isFinite(value);
  const count=(value:unknown)=>finite(value)&&Number.isInteger(value)&&Number(value)>=0;
  const named=(items:unknown)=>Array.isArray(items)&&items.every(item=>item&&typeof item.name==="string"&&count(item.count));
  const counts=data?.counts,finance=data?.finance;
  if(!data||data.month!==month||!counts||!finance||
    ![counts.totalRequests,counts.effectiveJobs,counts.implemented,counts.scheduled,counts.cancelled,counts.open,counts.assigned,counts.stopped,counts.draft].every(count)||
    ![counts.executionRate,counts.cancellationRate].every(value=>value===null||(finite(value)&&Number(value)>=0&&Number(value)<=1))||
    ![finance.bookedInvoice,finance.bookedPayment,finance.bookedGrossProfit,finance.implementedInvoice,finance.implementedPayment,finance.implementedGrossProfit].every(finite)||
    !(finance.bookedGrossMargin===null||finite(finance.bookedGrossMargin))||
    !named(data.cancellationReasons)||!named(data.cancellationTreatments)||!named(data.clients)||
    !data.clients.every(item=>count(item.cancelled)&&[item.invoice,item.payment,item.grossProfit].every(finite)))throw new Error("選択した月の集計結果を確認できませんでした。再集計してください。");
  return data;
}