import {shiftNotificationJobId,isNotificationDocumentId} from "./useShiftNotificationRoute";
export function resubmissionNotificationId(path:string):string|null {
  if(!/^\/resubmissions\/[^/]+\/?$/.test(path))return null;
  return shiftNotificationJobId(path.replace(/^\/resubmissions\//,"/shifts/"));
}
export async function readResubmissionNotification<T>(id:string,readRequest:()=>Promise<unknown>,readJob:(id:string)=>Promise<T|null>,isCurrent:()=>boolean){
  if(!isCurrent())return null;
  if(!isNotificationDocumentId(id))throw Error("再提出依頼の識別情報を確認できません。");
  const data=await readRequest();if(!isCurrent())return null;
  const request=(data as {request?:{id?:string;jobId?:string;type?:string;status?:string}}|null)?.request;
  if(request?.id!==id||!isNotificationDocumentId(request.jobId)||!["report","sales_floor"].includes(request.type??""))throw Error("再提出依頼の内容を確認できません。");
  if(request.status!=="open")return null;
  const job=await readJob(request.jobId);if(!isCurrent()||!job)return null;
  return {job,requestId:id,type:request.type as "report"|"sales_floor"};
}
