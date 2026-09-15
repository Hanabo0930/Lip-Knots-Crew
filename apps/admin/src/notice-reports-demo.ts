import type {NoticeReportsApi} from "./NoticeReportsPanel";
import type {NoticeReport} from "./notice-reports";
export function createNoticeReportsDemo():NoticeReportsApi{
 return {list:async(jobId,cursor)=>{
  const reports:NoticeReport[]=Array.from({length:27},(_,index)=>({operationKey:(index+1).toString(16).padStart(64,"0"),jobId,bindingRevision:"demo-binding-"+(index<2?"old":"current"),
   workDate:"2099-09-20",fixedCaseId:"demo-fixed",kind:index%2?"notice.entry":"notice.departure",operationId:"demo-delivery-"+(index+1),sequence:index+1,
   reportedStatus:index%3===0?"unknown":index%3===1?"sent":"planned",observedAt:"2099-09-20T00:00:00.000Z",sourceRecordId:"demo-ledger-"+(index+1),
   state:index<2?"historical":index===2?"needs_review":"current",reason:index<2?"binding_changed":index===2?"person_unverified":"aligned",
   receivedAt:"2099-09-20T00:05:00.000Z",verificationMethod:"authenticated-source-report",deliveryVerified:false,automaticRetryAllowed:false}));
  const remaining=reports.filter(row=>!cursor||row.operationKey>cursor),rows=remaining.slice(0,25);
  return {ok:true,jobId,reports:rows,nextCursor:remaining.length>25?rows.at(-1)!.operationKey:null,dispatch:"disabled"};
 }};
}
