export type JobListFilter = "all" | "precontact" | "assigned" | "cancelled" | "report-completed" | "report-unconfirmed";
type SearchableJob = {
  workDate:string; dateKey?:string; assignedStaffName?:string; storeName:string;
  makerName:string; clientName:string; status:string; cancelled?:boolean; preContact?:unknown; submissionStatus?:{report?:{completed?:boolean}};
};
export function reportCompletion(job:SearchableJob):"completed"|"unconfirmed"|"excluded"{
  if(job.status!=="assigned"||job.cancelled===true)return "excluded";
  return job.submissionStatus?.report?.completed===true?"completed":"unconfirmed";
}
export function reportCompletionLabel(job:SearchableJob){
  const state=reportCompletion(job);
  return state==="completed"?"完了記録あり":state==="unconfirmed"?"完了未確認":"対象外";
}
export function submissionStatusLabel(status:string){
  const labels:Record<string,string>={completed:"処理完了",uploading:"アップロード中",waiting_upload:"アップロード待ち",processing:"保存処理中",error:"処理失敗",security_error:"安全確認で停止",paused_global:"運用停止中"};
  return Object.hasOwn(labels,status)?labels[status]:"状態未確認";
}
export const ADMIN_JOB_PAGE_SIZE=50;
const normalize=(value:string)=>value.normalize("NFKC").toLocaleLowerCase("ja-JP");
export function buildJobSearchIndex<T extends SearchableJob>(jobs:T[]){
  return jobs.map(job=>({job,text:normalize([job.workDate,job.dateKey,job.assignedStaffName,job.storeName,job.makerName,job.clientName].filter(Boolean).join(" "))}));
}
export function filterJobSearchIndex<T extends SearchableJob>(index:ReturnType<typeof buildJobSearchIndex<T>>,query:string,filter:JobListFilter){
  const terms=normalize(query).trim().split(/\s+/u).filter(Boolean);
  return index.filter(({job,text})=>{
    const cancelled=job.status==="cancelled"||job.cancelled===true;
    if(filter==="cancelled"&&!cancelled)return false;
    if((filter==="assigned"||filter==="precontact")&&(cancelled||job.status!=="assigned"))return false;
    if(filter==="precontact"&&job.preContact)return false;
    if(filter==="report-completed"&&reportCompletion(job)!=="completed")return false;
    if(filter==="report-unconfirmed"&&reportCompletion(job)!=="unconfirmed")return false;
    return terms.every(term=>text.includes(term));
  }).map(({job})=>job);
}
export function jobListPage<T>(jobs:T[],requestedPage:number){
  const pageCount=Math.max(1,Math.ceil(jobs.length/ADMIN_JOB_PAGE_SIZE));
  const page=Math.max(0,Math.min(requestedPage,pageCount-1));
  return {page,pageCount,rows:jobs.slice(page*ADMIN_JOB_PAGE_SIZE,(page+1)*ADMIN_JOB_PAGE_SIZE)};
}
