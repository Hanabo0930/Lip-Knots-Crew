import type {HeldMailApi} from "./HeldMailApplicationsPanel";
import type {HeldReviewRequest} from "./held-mail-review";
export function createHeldMailDemo():HeldMailApi{
  const rows=new Map(["a","b"].map((value,index)=>[value.repeat(64),{receiptKey:value.repeat(64),receiptRevision:1,sourceRecordId:"demo-reply-"+(index+1),
    campaignKey:"c".repeat(64),fixedCaseId:"demo-fixed-"+(index+1),workDate:"2099-09-20",hasApplicantIdentity:index===0,
    reasons:[index===0?"応募者の本人対応を確認してください":"返信内の本人識別を確認してください"],route:"hold" as "hold"|"review"}]));
  const events=new Map<string,{body:string;outcome:"committed"|"cancelled";result?:unknown}>();
  const read=(receiptKey:string)=>{const row=rows.get(receiptKey);if(!row)throw new Error("デモの応募が見つかりません。");
    return {ok:true,...row,reviewRevision:row.route==="hold"?"d".repeat(64):null,current:row.route==="hold"?{
      route:row.hasApplicantIdentity?"review":"hold",reasons:row.hasApplicantIdentity?[]:row.reasons,intakeOwner:"app",jobId:"demo-link-job"}:null,
      assignmentPerformed:false,dispatch:"disabled"};};
  const perform=(input:HeldReviewRequest,cancel:boolean)=>{
    const previous=events.get(input.requestId),body=JSON.stringify(input);
    if(previous&&previous.body!==body)throw new Error("デモの操作内容が異なります。");
    if(previous){
      if(cancel)return {ok:true,requestId:input.requestId,receiptKey:input.receiptKey,outcome:previous.outcome,result:previous.result};
      if(previous.outcome==="cancelled")throw new Error("この再照合は中止されています。");
      return {...previous.result as object,duplicate:true};
    }
    if(cancel){events.set(input.requestId,{body,outcome:"cancelled"});return {ok:true,requestId:input.requestId,receiptKey:input.receiptKey,outcome:"cancelled"};}
    const current=read(input.receiptKey),row=rows.get(input.receiptKey)!;
    if(row.route!=="hold"||row.receiptRevision!==input.expectedReceiptRevision||current.reviewRevision!==input.expectedReviewRevision)throw new Error("デモの応募が更新されています。");
    row.receiptRevision++;row.route=row.hasApplicantIdentity?"review":"hold";
    const result={ok:true,duplicate:false,receiptKey:row.receiptKey,receiptRevision:row.receiptRevision,route:row.route,
      applicationId:row.route==="review"?"e".repeat(64):null,intakeOwner:"app",assignmentPerformed:false,dispatch:"disabled"};
    events.set(input.requestId,{body,outcome:"committed",result});return result;
  };
  return {list:async()=>({ok:true,items:[...rows.values()].filter(row=>row.route==="hold"),nextCursor:null}),
    read:async key=>read(key),review:async input=>perform(input,false),cancel:async input=>perform(input,true)};
}
