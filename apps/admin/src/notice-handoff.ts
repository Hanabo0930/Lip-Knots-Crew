import {registryId} from "./automation-registry-attempt";
export const handoffStatusLabels={open:"募集中",assigned:"担当確定",stopped:"募集停止",cancelled:"取消済み",draft:"準備中"} as const;
export const handoffContactLabels={linked:"現在の担当の入力を添付",missing:"事前連絡は未登録",unverified:"現在の担当の入力を未確認",needs_review:"事前連絡の再確認が必要",not_applicable:"事前連絡は添付対象外"} as const;
export const handoffContactReasons={linked:"現在の担当版に結び付いたアプリの本人入力です。",
 missing:"本人がシフト画面で体温と到着予定時刻を送信した後、再取得してください。",
 unverified:"旧担当版やシート由来など、現在の本人入力と照合できないため添付していません。本人がシフト画面で内容を確認して送信した後、再取得してください。",
 needs_review:"担当や勤務日などが変わったため、本人による内容の再確認が必要です。シフト画面から事前連絡を送信した後、再取得してください。",
 not_applicable:"取消・停止・未割当てなど、担当への連絡対象になっていない状態です。"} as const;
type Binding={version:1;companyId:string;jobId:string;appCaseId:string;spreadsheetId:string;fixedCaseId:string;workDate:string;revision:string;assignment:{staffId:string;personKey:string;proofEpoch:string}|null};
export type NoticeHandoffResult={ok:true;handoff:{contractVersion:1;kind:"job.snapshot";binding:Binding;revision:string;status:keyof typeof handoffStatusLabels;
 recruitmentEligible:boolean;noticeEligible:boolean;preContact:{temperature:number;arrivalTime:string;submittedAt:string}|null;operationKey:string;payloadHash:string;dispatch:"disabled"};
 policy:{version:1;companyId:string;revision:string;phase:"mail_bridge"|"app";noticeOwner:"notice_control"};preContactState:keyof typeof handoffContactLabels;sheetSyncPending:boolean;
 deliveryVerified:false;automaticRetryAllowed:false;dispatch:"disabled"};
const failure=()=>new Error("取得した連携データの案件・担当・内容を確認できません。もう一度取得してください。");
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=="object"||Array.isArray(value))throw failure();return value as Record<string,unknown>;};
function keys(row:Record<string,unknown>,allowed:string[]){if(Object.keys(row).length!==allowed.length||Object.keys(row).some(key=>!allowed.includes(key)))throw failure();}
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const instant=(value:unknown):value is string=>typeof value==="string"&&Number.isFinite(new Date(value).valueOf())&&new Date(value).toISOString()===value;
export async function noticeHandoffDigest(value:unknown){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value))))).map(byte=>byte.toString(16).padStart(2,"0")).join("");}
export async function noticeHandoffResult(value:unknown,companyId:string,jobId:string):Promise<NoticeHandoffResult>{
 const row=object(value);keys(row,["ok","handoff","policy","preContactState","sheetSyncPending","deliveryVerified","automaticRetryAllowed","dispatch"]);
 if(!registryId(companyId)||!registryId(jobId)||row.ok!==true||row.deliveryVerified!==false||row.automaticRetryAllowed!==false||row.dispatch!=="disabled"||
  typeof row.sheetSyncPending!=="boolean"||typeof row.preContactState!=="string"||!Object.hasOwn(handoffContactLabels,row.preContactState))throw failure();
 const source=object(row.handoff);keys(source,["contractVersion","kind","binding","revision","status","recruitmentEligible","noticeEligible","preContact","operationKey","payloadHash","dispatch"]);
 if(source.contractVersion!==1||source.kind!=="job.snapshot"||source.dispatch!=="disabled"||!hash(source.revision)||!hash(source.operationKey)||!hash(source.payloadHash)||
  typeof source.status!=="string"||!Object.hasOwn(handoffStatusLabels,source.status)||typeof source.recruitmentEligible!=="boolean"||typeof source.noticeEligible!=="boolean")throw failure();
 const rawBinding=object(source.binding);keys(rawBinding,["version","companyId","jobId","appCaseId","spreadsheetId","fixedCaseId","workDate","revision","assignment"]);
 if(rawBinding.version!==1||rawBinding.companyId!==companyId||rawBinding.jobId!==jobId||typeof rawBinding.workDate!=="string"||
  !/^\d{4}-\d{2}-\d{2}$/.test(rawBinding.workDate)||!instant(rawBinding.workDate+"T00:00:00.000Z"))throw failure();
 for(const key of ["appCaseId","spreadsheetId","fixedCaseId","revision"])if(!registryId(rawBinding[key]))throw failure();
 let assignment:Binding["assignment"]=null;
 if(rawBinding.assignment!==null){
  const person=object(rawBinding.assignment);keys(person,["staffId","personKey","proofEpoch"]);
  if(!registryId(person.staffId)||!hash(person.personKey)||!registryId(person.proofEpoch))throw failure();
  assignment={staffId:person.staffId,personKey:person.personKey,proofEpoch:person.proofEpoch};
 }
 const binding:Binding={version:1,companyId,jobId,appCaseId:rawBinding.appCaseId as string,spreadsheetId:rawBinding.spreadsheetId as string,fixedCaseId:rawBinding.fixedCaseId as string,workDate:rawBinding.workDate,revision:rawBinding.revision as string,assignment};
 const rawPolicy=object(row.policy);keys(rawPolicy,["version","companyId","revision","phase","noticeOwner"]);
 if(rawPolicy.version!==1||rawPolicy.companyId!==companyId||!registryId(rawPolicy.revision)||(rawPolicy.phase!=="mail_bridge"&&rawPolicy.phase!=="app")||rawPolicy.noticeOwner!=="notice_control")throw failure();
 const policy:NoticeHandoffResult["policy"]={version:1,companyId,revision:rawPolicy.revision,phase:rawPolicy.phase,noticeOwner:"notice_control"};
 let preContact:NoticeHandoffResult["handoff"]["preContact"]=null;
 if(source.preContact!==null){
  const contact=object(source.preContact);keys(contact,["temperature","arrivalTime","submittedAt"]);
  if(typeof contact.temperature!=="number"||!Number.isFinite(contact.temperature)||contact.temperature<34||contact.temperature>42||
   typeof contact.arrivalTime!=="string"||!/^([01]\d|2[0-3]):[0-5]\d$/.test(contact.arrivalTime)||!instant(contact.submittedAt))throw failure();
  preContact={temperature:contact.temperature,arrivalTime:contact.arrivalTime,submittedAt:contact.submittedAt};
 }
 const state=row.preContactState as NoticeHandoffResult["preContactState"],status=source.status as keyof typeof handoffStatusLabels;
 if((status==="assigned"&&!assignment)||(source.recruitmentEligible&&(status!=="open"||assignment!==null))||
  (status==="assigned"?(state==="not_applicable"||source.noticeEligible!==(state!=="needs_review")):(state!=="not_applicable"||source.noticeEligible!==false))||
  ((state==="linked")!==(preContact!==null))||(row.sheetSyncPending&&state!=="linked"))throw failure();
 const body={contractVersion:1 as const,kind:"job.snapshot" as const,binding,revision:source.revision,status,recruitmentEligible:source.recruitmentEligible,noticeEligible:source.noticeEligible,preContact};
 const [operationKey,payloadHash]=await Promise.all([noticeHandoffDigest(["job.snapshot",companyId,jobId,binding.revision,body.revision]),noticeHandoffDigest(body)]);
 if(operationKey!==source.operationKey||payloadHash!==source.payloadHash)throw failure();
 return {ok:true,handoff:{...body,operationKey,payloadHash,dispatch:"disabled"},policy,preContactState:state,sheetSyncPending:row.sheetSyncPending,deliveryVerified:false,automaticRetryAllowed:false,dispatch:"disabled"};
}
