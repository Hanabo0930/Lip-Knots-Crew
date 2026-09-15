import type { Job } from "./App";

type Options={from:string;through:string;groupBy:"client"|"maker";name:string;includeCancelled:boolean};
export function buildDemoJobExport(jobs:Job[],options:Options){
  const rows=jobs.filter(job=>{
    const date=job.dateKey??job.workDate;
    return date>=options.from&&date<=options.through&&(options.includeCancelled||job.status!=="cancelled")&&(!options.name||(options.groupBy==="client"?job.clientName:job.makerName)===options.name);
  }).sort((a,b)=>(a.dateKey??a.workDate).localeCompare(b.dateKey??b.workDate));
  const cell=(value:unknown)=>'"'+String(value??"").replace(/\r?\n/g," ").replace(/"/g,'""')+'"';
  const number=(value:unknown)=>Number.isFinite(Number(value))?Number(value):0;
  const lines=[["実施日","クライアント","店舗","メーカー","メニュー","実施時間","スタッフ","状態","請求概算","支払概算","粗利概算"].map(cell).join(",")];
  for(const job of rows){
    const invoice=number(job.financials?.clientChargeTotal)+number(job.financials?.clientChargeAdditionsTotal);
    const payment=number(job.subcontractorName?job.financials?.subcontractorTotal:job.financials?.staffPaymentTotal);
    lines.push([job.workDate??job.dateKey,job.clientName,job.storeName,job.makerName,job.menuName,job.workTime,job.assignedStaffName,job.status,invoice,payment,invoice-payment].map(cell).join(","));
  }
  const name=(options.name||(options.groupBy==="client"?"全クライアント":"全メーカー")).replace(/[\\/:*?"<>|]/g,"_");
  return {filename:`デモ_${options.from}_${options.through}_${name}_案件一覧.csv`,csv:"\uFEFF"+lines.join("\r\n"),rows:rows.length};
}
