export type ManualPayOffer={caseId:string;dailyWageJPY:number;travelExpenses:string;communicationExpenses:string};
export type ManualNameUpView={reviewId:string;displayHash:string;approvalCreated:false;cases:Array<{caseId:string;date:string;staffName:string;sourceStaffName:string;client:string;store:string;maker:string;content:string;arrival:string;execution:string;headcount:1;dateMode:string;dailyWageJPY:number;travelExpenses:string|null;communicationExpenses:string|null}>;mail:{groups:Array<{client:string;to:string[];cc:string[];subject:string;body:string}>}};
export type ManualReviewRef={jobId:string;observationHash:string;expectedJobRevision:number;expectedSourceRevision:string};
export type ManualSendRequest={reviewId:string;displayHash:string;intent:'CONFIRM_DISPLAYED_AND_SEND';payOffers:ManualPayOffer[];displayedCases:ManualNameUpView['cases'];displayedMail:ManualNameUpView['mail']};
export type ManualNameUpPorts={sessionKey:string;load:(request:{cases:ManualReviewRef[]})=>Promise<ManualNameUpView>;send:(request:ManualSendRequest)=>Promise<{status:string;code?:string;acceptedCaseIds?:string[]}>};
export function validManualNameUpView(view:ManualNameUpView|null):view is ManualNameUpView{
 return Boolean(view&&view.approvalCreated===false&&/^[a-f0-9]{48}$/.test(view.reviewId)&&/^[a-f0-9]{64}$/.test(view.displayHash)&&view.cases.length>=1&&view.cases.length<=5&&new Set(view.cases.map(c=>c.caseId)).size===view.cases.length&&view.cases.every(c=>[c.caseId,c.date,c.staffName,c.sourceStaffName,c.client,c.store,c.maker,c.content,c.arrival,c.execution,c.dateMode].every(x=>typeof x==='string'&&x.trim())&&c.headcount===1&&Number.isSafeInteger(c.dailyWageJPY)&&c.dailyWageJPY>0&&c.dailyWageJPY<=1000000)&&view.mail.groups.length);
}
export function manualNameUpRequest(view:ManualNameUpView|null,payOffers:ManualPayOffer[]):ManualSendRequest|null{
 if(!validManualNameUpView(view)||payOffers.length!==view.cases.length||new Set(payOffers.map(p=>p.caseId)).size!==view.cases.length)return null;
 if(!view.cases.every(c=>payOffers.some(p=>p.caseId===c.caseId&&p.dailyWageJPY===c.dailyWageJPY&&p.travelExpenses==='全額支給'&&p.communicationExpenses==='全額支給')))return null;
 return {reviewId:view.reviewId,displayHash:view.displayHash,intent:'CONFIRM_DISPLAYED_AND_SEND',payOffers:payOffers.map(p=>({...p})),displayedCases:view.cases.map(c=>({...c})),displayedMail:{groups:view.mail.groups.map(g=>({...g,to:[...g.to],cc:[...g.cc]}))}};
}
// The same rendered review may dispatch once, including after a lost response.
export function createManualNameUpAction(ports:ManualNameUpPorts,current:()=>{session:string;viewSession:string;view:ManualNameUpView|null}){
 const attempts=new Map<string,'DISPATCHING'|'OBSERVED'|'UNKNOWN'>();
 return async function send(view:ManualNameUpView,payOffers:ManualPayOffer[]){
  const initial=current(),request=manualNameUpRequest(view,payOffers);
  if(!request||!initial.session||initial.viewSession!==initial.session||initial.view?.reviewId!==view.reviewId||initial.view.displayHash!==view.displayHash)return {status:'HOLD',code:'DISPLAY_CHANGED'};
  if(attempts.has(view.reviewId))return {status:'HOLD',code:'RESULT_MUST_BE_OBSERVED'};
  attempts.set(view.reviewId,'DISPATCHING');
  try{const result=await ports.send(request);const after=current();if(after.session!==initial.session||after.viewSession!==initial.session||after.view?.reviewId!==view.reviewId)return {status:'HOLD',code:'SESSION_OR_VIEW_CHANGED'};attempts.set(view.reviewId,'OBSERVED');return result;}
  catch{attempts.set(view.reviewId,'UNKNOWN');return {status:'HOLD',code:'RESULT_UNKNOWN_DO_NOT_RESEND'};}
 };
}
