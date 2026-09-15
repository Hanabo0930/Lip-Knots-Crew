import {registryId,registryOwner} from "./automation-registry-attempt";
export type CampaignCase={jobId:string;appCaseId:string;fixedCaseId:string;spreadsheetId:string;workDate:string;bindingRevision:string;jobRevision:string};
export type MailCampaign={contractVersion:1;kind:"recruitment.campaign";companyId:string;policyRevision:string;sourceOperationId:string;
  area:"normal"|"tohoku";cases:CampaignCase[];operationKey:string;sourceHash:string;payloadHash:string;dispatch:"disabled"};
export type CampaignRequest={requestId:string;expectedPrincipalRevision:string;evidenceRecordId:string;confirmedAgainstSource:true;campaign:MailCampaign};
export type CampaignResult={campaignKey:string;registrationRevision:string;caseCount:number;duplicate:boolean};
export type CampaignPreview={expectedPrincipalRevision:string;alreadyRegistered:boolean;registeredResult:CampaignResult|null;evidenceRecordId:string|null;cases:(CampaignCase&{storeName:string|null})[]};
export type CampaignAttempt={request:CampaignRequest;action:"register"|"cancel"};
export const CAMPAIGN_FILE_LIMIT=262144;
const fail=()=>new Error("募集データの形式または確認記録が一致しません。連携用の募集データと元の記録を確認してください。");
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=="object"||Array.isArray(value))throw fail();return value as Record<string,unknown>;};
const exact=(row:Record<string,unknown>,keys:string[])=>{if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key)))throw fail();};
function target(value:unknown):CampaignCase{
  const row=object(value);exact(row,["jobId","appCaseId","fixedCaseId","spreadsheetId","workDate","bindingRevision","jobRevision"]);
  for(const key of ["jobId","appCaseId","fixedCaseId","spreadsheetId","bindingRevision","jobRevision"])if(!registryId(row[key]))throw fail();
  if(typeof row.workDate!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(row.workDate))throw fail();
  const date=new Date(row.workDate+"T00:00:00Z");if(!Number.isFinite(date.valueOf())||date.toISOString().slice(0,10)!==row.workDate)throw fail();
  return {jobId:row.jobId as string,appCaseId:row.appCaseId as string,fixedCaseId:row.fixedCaseId as string,spreadsheetId:row.spreadsheetId as string,
    workDate:row.workDate,bindingRevision:row.bindingRevision as string,jobRevision:row.jobRevision as string};
}
export function mailCampaign(value:unknown):MailCampaign{
  const row=object(value);exact(row,["contractVersion","kind","companyId","policyRevision","sourceOperationId","area","cases","operationKey","sourceHash","payloadHash","dispatch"]);
  if(row.contractVersion!==1||row.kind!=="recruitment.campaign"||!registryId(row.companyId)||!registryId(row.policyRevision)||!registryId(row.sourceOperationId)||
    (row.area!=="normal"&&row.area!=="tohoku")||!Array.isArray(row.cases)||row.cases.length<1||row.cases.length>100||
    !hash(row.operationKey)||!hash(row.sourceHash)||!hash(row.payloadHash)||row.dispatch!=="disabled")throw fail();
  const cases=row.cases.map(target);
  if(new Set(cases.map(v=>v.jobId)).size!==cases.length||new Set(cases.map(v=>v.fixedCaseId)).size!==cases.length)throw fail();
  return {contractVersion:1,kind:"recruitment.campaign",companyId:row.companyId,policyRevision:row.policyRevision,sourceOperationId:row.sourceOperationId,
    area:row.area,cases,operationKey:row.operationKey,sourceHash:row.sourceHash,payloadHash:row.payloadHash,dispatch:"disabled"};
}
const canonical=(value:unknown):string=>Array.isArray(value)?"["+value.map(canonical).join(",")+"]":value!==null&&typeof value==="object"?
  "{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+canonical((value as Record<string,unknown>)[key])).join(",")+"}":JSON.stringify(value);
export async function campaignDigest(value:unknown){
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,"0")).join("");
}
export async function verifyMailCampaign(value:unknown,companyId:string){
  const campaign=mailCampaign(value);
  if(campaign.companyId!==companyId)throw new Error("募集データの会社が、ログイン中の所属と一致しません。");
  const {operationKey,payloadHash,...body}=campaign;
  const [key,payload]=await Promise.all([campaignDigest(["recruitment.campaign",campaign.companyId,campaign.policyRevision,campaign.sourceOperationId,campaign.area]),campaignDigest(body)]);
  if(key!==operationKey||payload!==payloadHash)throw new Error("募集データが作成後に変更されています。元の連携用データを確認してください。");
  return campaign;
}
export async function parseCampaignText(text:string,companyId:string){
  if(new TextEncoder().encode(text).byteLength>CAMPAIGN_FILE_LIMIT)throw new Error("募集データが大きすぎます。256 KiB以下・100枠までの連携用データを選んでください。");
  let parsed:unknown;try{parsed=JSON.parse(text);}catch{throw new Error("募集データを読み取れません。JSON形式の連携用データを選んでください。");}
  return verifyMailCampaign(parsed,companyId);
}
export function campaignRequest(value:unknown):CampaignRequest{
  const row=object(value);exact(row,["requestId","expectedPrincipalRevision","evidenceRecordId","confirmedAgainstSource","campaign"]);
  if(!registryId(row.requestId)||!registryId(row.expectedPrincipalRevision)||!registryId(row.evidenceRecordId)||row.confirmedAgainstSource!==true)throw fail();
  return {requestId:row.requestId,expectedPrincipalRevision:row.expectedPrincipalRevision,evidenceRecordId:row.evidenceRecordId,confirmedAgainstSource:true,campaign:mailCampaign(row.campaign)};
}
export function campaignResult(value:unknown,campaign:MailCampaign):CampaignResult{
  const row=object(value);
  if(row.ok!==true||typeof row.duplicate!=="boolean"||row.campaignKey!==campaign.operationKey||!registryId(row.registrationRevision)||
    row.caseCount!==campaign.cases.length||row.verificationMethod!=="admin-source-confirmation"||row.dispatch!=="disabled")throw fail();
  return {campaignKey:row.campaignKey as string,registrationRevision:row.registrationRevision,caseCount:row.caseCount as number,duplicate:row.duplicate};
}
export function campaignPreview(value:unknown,campaign:MailCampaign):CampaignPreview{
  const row=object(value);
  if(row.ok!==true||row.campaignKey!==campaign.operationKey||row.payloadHash!==campaign.payloadHash||row.dispatch!=="disabled"||
    !registryId(row.expectedPrincipalRevision)||typeof row.alreadyRegistered!=="boolean"||!Array.isArray(row.cases)||row.cases.length!==campaign.cases.length)throw fail();
  const cases=row.cases.map((value,index)=>{
    const {storeName,...rest}=object(value),parsed=target(rest);
    if(JSON.stringify(parsed)!==JSON.stringify(campaign.cases[index])||(storeName!==null&&(typeof storeName!=="string"||storeName.length>200)))throw fail();
    return {...parsed,storeName:storeName as string|null};
  });
  if(row.alreadyRegistered){if(!registryId(row.evidenceRecordId))throw fail();}
  else if(row.registeredResult!==null||row.evidenceRecordId!==null)throw fail();
  return {expectedPrincipalRevision:row.expectedPrincipalRevision,alreadyRegistered:row.alreadyRegistered,
    registeredResult:row.alreadyRegistered?campaignResult(row.registeredResult,campaign):null,evidenceRecordId:row.evidenceRecordId as string|null,cases};
}
export function campaignCancelResult(value:unknown,request:CampaignRequest){
  const row=object(value);if(row.ok!==true||row.requestId!==request.requestId||row.campaignKey!==request.campaign.operationKey)throw fail();
  if(row.outcome==="cancelled"&&row.result===null)return {outcome:"cancelled" as const,result:null};
  if(row.outcome==="committed")return {outcome:"committed" as const,result:campaignResult(row.result,request.campaign)};throw fail();
}
export const campaignOwner=registryOwner;
const prefix="lkc.campaignRegistrationAttempt.v1:";
function storageKey(owner:string){
  try{const parts=JSON.parse(owner);if(!Array.isArray(parts)||parts.length!==2||registryOwner(parts[0],parts[1])!==owner)throw fail();}
  catch{throw fail();}return prefix+owner;
}
export function loadCampaignAttempt(owner:string):CampaignAttempt|null{
  try{const raw=localStorage.getItem(storageKey(owner));if(raw===null)return null;const row=object(JSON.parse(raw));
    exact(row,["version","action","request"]);if(row.version!==1||(row.action!=="register"&&row.action!=="cancel"))throw fail();
    const request=campaignRequest(row.request);if(request.campaign.companyId!==JSON.parse(owner)[0])throw fail();
    return {action:row.action,request};
  }catch{throw new Error("前回の募集登録を読めません。端末の保存設定を確認してください。");}
}
function write(owner:string,attempt:CampaignAttempt){
  localStorage.setItem(storageKey(owner),JSON.stringify({version:1,...attempt}));const saved=loadCampaignAttempt(owner);
  if(saved?.action!==attempt.action||JSON.stringify(saved?.request)!==JSON.stringify(attempt.request))throw fail();
}
async function lock<T>(owner:string,work:()=>T):Promise<T|null>{
  if(!navigator.locks)throw new Error("このブラウザーでは募集登録を保存できません。対応するブラウザーで開いてください。");
  return navigator.locks.request(storageKey(owner),{mode:"exclusive",ifAvailable:true},held=>{
    if(!held)throw new Error("別の画面で登録を確認中です。少し待って、同じ操作を確認してください。");return work();
  });
}
export function reserveCampaignAttempt(owner:string,request:CampaignRequest,isCurrent:()=>boolean){
  return lock(owner,()=>{if(!isCurrent())return null;const previous=loadCampaignAttempt(owner);if(previous)return {created:false,attempt:previous};
    const attempt:CampaignAttempt={action:"register",request:campaignRequest(request)};
    if(attempt.request.campaign.companyId!==JSON.parse(owner)[0])throw fail();write(owner,attempt);return {created:true,attempt};});
}
export function cancelCampaignAttempt(owner:string,requestId:string,isCurrent:()=>boolean){
  return lock(owner,()=>{if(!isCurrent())return null;const previous=loadCampaignAttempt(owner);
    if(!previous||previous.request.requestId!==requestId)throw fail();const next:CampaignAttempt={...previous,action:"cancel"};write(owner,next);return next;});
}
export function clearCampaignAttempt(owner:string,requestId:string,isCurrent:()=>boolean){
  return lock(owner,()=>{if(!isCurrent())return false;const previous=loadCampaignAttempt(owner);
    if(previous?.request.requestId===requestId){localStorage.removeItem(storageKey(owner));if(loadCampaignAttempt(owner))throw fail();}return true;});
}
