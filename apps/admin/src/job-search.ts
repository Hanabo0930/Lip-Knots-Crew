export type JobListFilter = "all" | "monthly-transferred" | "unassigned" | "precontact" | "assigned" | "cancelled" | "report-completed" | "report-unconfirmed";
type SearchableJob = {
  id?:string; companyId?:string; caseId?:string; assignedStaffId?:string;
  caseListSource?:{version?:number;sheetId?:number;caseId?:string;sourceRevision?:string;bindingHash?:string};
  sheetRef?:{sheetId?:number;sheetName?:string;caseId?:string;bindingHash?:string};
  recruitmentStopped?:boolean; publishable?:boolean;
  assignmentSheetWrite?:{operation?:string;queueId?:string;assignedJobRevision?:number;pending?:boolean;nativeAck?:{
    schema?:string;status?:string;operationId?:string;queueId?:string;companyId?:string;jobId?:string;
    sourceCaseId?:string;staffId?:string;dateKey?:string;assignedJobRevision?:number;bindingHash?:string;preserveSource?:boolean;
    postCatalog?:{caseId?:string;sourceRevision?:string;bindingHash?:string};
    target?:{sheetId?:number;title?:string;fixedId?:string;bindingHash?:string};
  }};
  workDate:string; dateKey?:string; assignedStaffName?:string; storeName:string;
  makerName:string; clientName:string; status:string; cancelled?:boolean; preContact?:unknown; applicationUnconfirmed?:boolean; sourceMissing?:boolean; assignmentUnresolved?:boolean; submissionStatus?:{report?:{completed?:boolean;deadlineReviewRequired?:boolean}};
};
export function isCancelledJob(job:Pick<SearchableJob,"status"|"cancelled">):boolean{
  return job.status==="cancelled"||job.cancelled===true;
}
/** Display-only archive state derived from the server's verified monthly ACK.
 * Missing or mismatched proof remains in the normal list for review. This does
 * not authorize writes, hide the physical Source row or grant history access. */
export function isTransferredCaseListJob(job:SearchableJob):boolean{
  const source=job.caseListSource,write=job.assignmentSheetWrite,ack=write?.nativeAck,target=ack?.target,ref=job.sheetRef;
  const nonempty=(value:unknown):value is string=>typeof value==="string"&&value.trim().length>0;
  return !isCancelledJob(job)&&job.status==="assigned"&&job.applicationUnconfirmed===false&&
    job.sourceMissing!==true&&job.assignmentUnresolved!==true&&job.recruitmentStopped===true&&job.publishable===false&&
    source?.version===1&&source.sheetId===2026101601&&nonempty(job.id)&&nonempty(job.companyId)&&nonempty(job.caseId)&&
    nonempty(job.assignedStaffId)&&nonempty(job.dateKey)&&source.caseId===job.caseId&&nonempty(source.sourceRevision)&&nonempty(source.bindingHash)&&
    write?.operation==="case_list.assign"&&write.pending===false&&nonempty(write.queueId)&&
    Number.isSafeInteger(write.assignedJobRevision)&&Number(write.assignedJobRevision)>0&&
    ack?.schema==="LK_CASE_LIST_MONTHLY_ACK_V1"&&ack.status==="MONTHLY_READBACK_VERIFIED"&&ack.preserveSource===true&&
    ack.operationId===write.queueId&&ack.queueId===write.queueId&&ack.jobId===job.id&&ack.companyId===job.companyId&&
    ack.sourceCaseId===job.caseId&&ack.staffId===job.assignedStaffId&&ack.dateKey===job.dateKey&&
    ack.assignedJobRevision===write.assignedJobRevision&&ack.bindingHash===source.bindingHash&&
    ack.postCatalog?.caseId===job.caseId&&ack.postCatalog.sourceRevision===source.sourceRevision&&ack.postCatalog.bindingHash===source.bindingHash&&
    nonempty(target?.fixedId)&&target.fixedId===job.caseId&&Number.isInteger(target.sheetId)&&Number(target.sheetId)>=0&&
    nonempty(target.title)&&target.title===job.dateKey.slice(0,4)+"."+Number(job.dateKey.slice(5,7))&&nonempty(target.bindingHash)&&
    ref?.caseId===job.caseId&&ref.sheetId===target.sheetId&&ref.sheetName===target.title&&ref.bindingHash===target.bindingHash;
}
export function isUnassignedJob(job:SearchableJob):boolean{
  return job.status==="open"&&!isCancelledJob(job)&&job.sourceMissing!==true&&job.assignmentUnresolved!==true;
}
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
  if(isCancelledJob(job))return "キャンセル";
  if(isTransferredCaseListJob(job))return "月別へ転記済み";
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
    const cancelled=isCancelledJob(job),transferred=isTransferredCaseListJob(job);
    // Histories are explicit views; ordinary cases never include either state.
    if(cancelled&&filter!=="cancelled")return false;
    if(transferred&&filter!=="monthly-transferred")return false;
    if(filter==="monthly-transferred"&&!transferred)return false;
    if(filter==="unassigned"&&!isUnassignedJob(job))return false;
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
