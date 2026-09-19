export type JobListFilter = "all" | "precontact" | "assigned" | "cancelled" | "report-completed" | "report-unconfirmed";
type SearchableJob = {
  workDate:string; dateKey?:string; assignedStaffName?:string; storeName:string;
  makerName:string; clientName:string; status:string; cancelled?:boolean; preContact?:unknown; applicationUnconfirmed?:boolean; sourceMissing?:boolean; assignmentUnresolved?:boolean; submissionStatus?:{report?:{completed?:boolean;deadlineReviewRequired?:boolean}};
};
export function reportCompletion(job:SearchableJob):"completed"|"unconfirmed"|"excluded"{
  if(job.status!=="assigned"||job.cancelled===true)return "excluded";
  return job.submissionStatus?.report?.completed===true?"completed":"unconfirmed";
}
export function reportCompletionLabel(job:SearchableJob){
  const state=reportCompletion(job);
  if(state==="completed"&&job.submissionStatus?.report?.deadlineReviewRequired===true)return "完了記録あり・期限要確認";
  return state==="completed"?"完了記録あり":state==="unconfirmed"?"完了未確認":"対象外";
}
export function jobReadinessLabel(job:SearchableJob):string{
  if(job.cancelled===true||job.status==="cancelled")return "キャンセル";
  if(job.sourceMissing===true)return "取込元の案件を確認中";
  if(job.assignmentUnresolved===true)return "担当者の照合待ち";
  if(job.status==="assigned")return job.applicationUnconfirmed===true?"原本の担当確認待ち":job.preContact?"事前連絡あり":"事前連絡待ち";
  switch(job.status){case "draft":return "下書き";case "scheduled":return "公開予約";case "stopped":return "募集停止";case "open":return "未手配";default:return "状態要確認";}
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


type SearchableStaff={displayName:string;emails?:string[];nearestStation?:string;homePrefecture?:string;areaLabels?:string[]};
export function buildStaffSearchIndex<T extends SearchableStaff>(profiles:T[]){
  return profiles.map(profile=>({profile,text:normalize([profile.displayName,...(profile.emails??[]),profile.nearestStation??"",profile.homePrefecture??"",...(profile.areaLabels??[])].join(" "))}));
}
export function filterStaffSearchIndex<T extends SearchableStaff>(index:ReturnType<typeof buildStaffSearchIndex<T>>,query:string){
  const terms=normalize(query).trim().split(/\s+/u).filter(Boolean);
  return index.filter(({text})=>terms.every(term=>text.includes(term))).map(({profile})=>profile);
}
