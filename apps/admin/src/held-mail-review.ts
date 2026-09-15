import {registryId,registryOwner} from "./automation-registry-attempt";

export type HeldItem={receiptKey:string;receiptRevision:number;sourceRecordId:string;campaignKey:string;fixedCaseId:string;workDate:string;hasApplicantIdentity:boolean;reasons:string[]};
export type HeldDetail=Omit<HeldItem,"reasons">&{route:"hold"|"review";reviewRevision:string|null;current:{route:"hold"|"review";reasons:string[];intakeOwner:"app"|"legacy_mail";jobId:string}|null};
export type HeldReviewRequest={receiptKey:string;requestId:string;expectedReceiptRevision:number;expectedReviewRevision:string;evidenceRecordId:string;confirmedAgainstSource:true};
export type HeldAttempt={action:"review"|"cancel";request:HeldReviewRequest};
export type HeldResult={receiptKey:string;receiptRevision:number;route:"hold"|"review";applicationId:string|null;intakeOwner:"app"|"legacy_mail"};
const hash=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const revision=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;
const fail=()=>new Error("確認結果を読み取れません。内容を変更せず、もう一度確認してください。");
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=="object"||Array.isArray(v))throw fail();return v as Record<string,unknown>;};
const reasons=(v:unknown):string[]=>{if(!Array.isArray(v)||v.length>20||v.some(s=>typeof s!=="string"||s.length>500))throw fail();return [...v];};
const route=(v:unknown):"hold"|"review"=>{if(v!=="hold"&&v!=="review")throw fail();return v;};
const intake=(v:unknown):"app"|"legacy_mail"=>{if(v!=="app"&&v!=="legacy_mail")throw fail();return v;};
function item(v:unknown,withReasons=true):HeldItem{
  const row=object(v);
  if(!hash(row.receiptKey)||!revision(row.receiptRevision)||row.receiptRevision>=Number.MAX_SAFE_INTEGER||
    !registryId(row.sourceRecordId)||!hash(row.campaignKey)||!registryId(row.fixedCaseId)||
    typeof row.workDate!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(row.workDate)||typeof row.hasApplicantIdentity!=="boolean")throw fail();
  const day=new Date(row.workDate+"T00:00:00Z");if(!Number.isFinite(day.valueOf())||day.toISOString().slice(0,10)!==row.workDate)throw fail();
  return {receiptKey:row.receiptKey,receiptRevision:row.receiptRevision,sourceRecordId:row.sourceRecordId,
    campaignKey:row.campaignKey,fixedCaseId:row.fixedCaseId,workDate:row.workDate,hasApplicantIdentity:row.hasApplicantIdentity,
    reasons:withReasons?reasons(row.reasons):[]};
}
export function heldList(value:unknown){
  const row=object(value);if(row.ok!==true||!Array.isArray(row.items)||row.items.length>25||(row.nextCursor!==null&&!hash(row.nextCursor)))throw fail();
  const items=row.items.map(v=>item(v));
  if(new Set(items.map(v=>v.receiptKey)).size!==items.length||(row.nextCursor!==null&&(items.length!==25||items.at(-1)?.receiptKey!==row.nextCursor)))throw fail();
  return {items,nextCursor:row.nextCursor as string|null};
}
export function heldDetail(value:unknown,receiptKey:string):HeldDetail{
  const row=object(value),base=item(row,false),state=route(row.route);
  if(row.ok!==true||base.receiptKey!==receiptKey||row.assignmentPerformed!==false||row.dispatch!=="disabled")throw fail();
  if(state==="review"){if(row.current!==null||row.reviewRevision!==null)throw fail();return {...base,route:state,current:null,reviewRevision:null};}
  if(!hash(row.reviewRevision))throw fail();const current=object(row.current);
  if(!registryId(current.jobId))throw fail();
  return {...base,route:state,reviewRevision:row.reviewRevision,current:{route:route(current.route),reasons:reasons(current.reasons),intakeOwner:intake(current.intakeOwner),jobId:current.jobId}};
}
export function heldRequest(value:unknown):HeldReviewRequest{
  const row=object(value),keys=["receiptKey","requestId","expectedReceiptRevision","expectedReviewRevision","evidenceRecordId","confirmedAgainstSource"];
  if(Object.keys(row).some(k=>!keys.includes(k))||!hash(row.receiptKey)||!registryId(row.requestId)||
    !revision(row.expectedReceiptRevision)||row.expectedReceiptRevision>=Number.MAX_SAFE_INTEGER||
    !hash(row.expectedReviewRevision)||!registryId(row.evidenceRecordId)||row.confirmedAgainstSource!==true)throw fail();
  return {receiptKey:row.receiptKey,requestId:row.requestId,expectedReceiptRevision:row.expectedReceiptRevision,
    expectedReviewRevision:row.expectedReviewRevision,evidenceRecordId:row.evidenceRecordId,confirmedAgainstSource:true};
}
export function heldReviewResult(value:unknown,request:HeldReviewRequest):HeldResult{
  const row=object(value),state=route(row.route);
  if(row.ok!==true||typeof row.duplicate!=="boolean"||row.receiptKey!==request.receiptKey||
    row.receiptRevision!==request.expectedReceiptRevision+1||row.assignmentPerformed!==false||row.dispatch!=="disabled"||
    (state==="hold"?row.applicationId!==null:!hash(row.applicationId)))throw fail();
  return {receiptKey:request.receiptKey,receiptRevision:row.receiptRevision as number,route:state,
    applicationId:row.applicationId as string|null,intakeOwner:intake(row.intakeOwner)};
}
export function heldCancelResult(value:unknown,request:HeldReviewRequest){
  const row=object(value);
  if(row.ok!==true||row.requestId!==request.requestId||row.receiptKey!==request.receiptKey)throw fail();
  if(row.outcome==="cancelled")return {outcome:"cancelled" as const,result:null};
  if(row.outcome==="committed")return {outcome:"committed" as const,result:heldReviewResult(row.result,request)};
  throw fail();
}
export const heldOwner=registryOwner;
const prefix="lkc.heldReviewAttempt.v1:";
function storageKey(owner:string){
  try{const parts=JSON.parse(owner);if(!Array.isArray(parts)||parts.length!==2||registryOwner(parts[0],parts[1])!==owner)throw fail();}
  catch{throw fail();}return prefix+owner;
}
export function loadHeldAttempt(owner:string):HeldAttempt|null{
  try{const raw=localStorage.getItem(storageKey(owner));if(raw===null)return null;const value=object(JSON.parse(raw));
    if(value.version!==1||(value.action!=="review"&&value.action!=="cancel"))throw fail();
    return {action:value.action,request:heldRequest(value.request)};
  }catch{throw new Error("前回の確認記録を読めません。端末の保存設定を確認してください。");}
}
function write(owner:string,attempt:HeldAttempt){
  localStorage.setItem(storageKey(owner),JSON.stringify({version:1,...attempt}));
  const saved=loadHeldAttempt(owner);
  if(saved?.action!==attempt.action||JSON.stringify(saved?.request)!==JSON.stringify(attempt.request))throw fail();
}
async function lock<T>(owner:string,work:()=>T):Promise<T|null>{
  if(!navigator.locks)throw new Error("このブラウザーでは確認操作を保存できません。対応するブラウザーで開いてください。");
  return navigator.locks.request(storageKey(owner),{mode:"exclusive",ifAvailable:true},held=>{
    if(!held)throw new Error("別の画面で確認中です。少し待って、同じ操作を確認してください。");return work();
  });
}
export function reserveHeldAttempt(owner:string,request:HeldReviewRequest,isCurrent:()=>boolean){
  return lock(owner,()=>{if(!isCurrent())return null;const previous=loadHeldAttempt(owner);if(previous)return {created:false,attempt:previous};
    const attempt:HeldAttempt={action:"review",request:heldRequest(request)};write(owner,attempt);return {created:true,attempt};});
}
export function cancelHeldAttempt(owner:string,requestId:string,isCurrent:()=>boolean){
  return lock(owner,()=>{if(!isCurrent())return null;const previous=loadHeldAttempt(owner);
    if(!previous||previous.request.requestId!==requestId)throw fail();const next:HeldAttempt={...previous,action:"cancel"};write(owner,next);return next;});
}
export function clearHeldAttempt(owner:string,requestId:string,isCurrent:()=>boolean){
  return lock(owner,()=>{if(!isCurrent())return false;const previous=loadHeldAttempt(owner);
    if(previous?.request.requestId===requestId){localStorage.removeItem(storageKey(owner));if(loadHeldAttempt(owner))throw fail();}return true;});
}
