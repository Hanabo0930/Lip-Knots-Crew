import type {NoticeHandoffApi} from "./NoticeHandoffPanel";
import {noticeHandoffDigest} from "./notice-handoff";
export function createNoticeHandoffDemo():NoticeHandoffApi{
 return {read:async jobId=>{
  const binding={version:1,companyId:"demo-company",jobId,appCaseId:"demo-notice-case",spreadsheetId:"demo-book",fixedCaseId:"demo-fixed",workDate:"2099-09-20",revision:"demo-binding-1",
   assignment:{staffId:"demo-staff",personKey:"a".repeat(64),proofEpoch:"demo-epoch-1"}};
  const revision="1".repeat(64),body={contractVersion:1,kind:"job.snapshot",binding,revision,status:"assigned",recruitmentEligible:false,noticeEligible:true,
   preContact:{temperature:36.5,arrivalTime:"09:30",submittedAt:"2099-09-20T00:00:00.000Z"}};
  return {ok:true,handoff:{...body,operationKey:await noticeHandoffDigest(["job.snapshot","demo-company",jobId,binding.revision,revision]),payloadHash:await noticeHandoffDigest(body),dispatch:"disabled"},
   policy:{version:1,companyId:"demo-company",revision:"demo-policy-1",phase:"mail_bridge",noticeOwner:"notice_control"},preContactState:"linked",sheetSyncPending:true,
   deliveryVerified:false,automaticRetryAllowed:false,dispatch:"disabled"};
 }};
}
