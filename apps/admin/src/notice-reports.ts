import {registryId} from "./automation-registry-attempt";
export const noticeStatusLabels={planned:"配信予定",sending:"処理中",sent:"送信済みの報告",unknown:"結果不明",stopped:"停止",failed:"失敗"} as const;
export const noticeStateLabels={current:"現在の担当に一致",historical:"過去の担当版",needs_review:"再確認が必要"} as const;
export const noticeReasons={aligned:"現在の案件と担当証跡に一致しています。",binding_changed:"担当または案件の対応版が変わっています。現在の担当の結果には使いません。",
 binding_missing:"現在の連携台帳を確認してください。",job_missing:"現在の案件を確認できません。",fixed_id_unverified:"固定IDの対応と保存版を確認してください。",
 person_unverified:"担当者の本人対応や利用状態を確認してください。",job_unavailable:"取消・手配・事前連絡など、現在の案件状態を確認してください。",
 notice_owner_unverified:"出発・入店連絡の受付設定を確認してください。",source_unavailable:"報告元の連携実行者を確認してください。"} as const;
export type NoticeReport={operationKey:string;jobId:string;bindingRevision:string;workDate:string;fixedCaseId:string;kind:"notice.departure"|"notice.entry";operationId:string;
 sequence:number;reportedStatus:keyof typeof noticeStatusLabels;observedAt:string;sourceRecordId:string;state:keyof typeof noticeStateLabels;reason:keyof typeof noticeReasons;
 receivedAt:string;verificationMethod:"authenticated-source-report";deliveryVerified:false;automaticRetryAllowed:false};
export type NoticePage={reports:NoticeReport[];nextCursor:string|null};
const failure=()=>new Error("連絡結果の取得内容が対象案件と一致しません。もう一度取得してください。");
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=="object"||Array.isArray(value))throw failure();return value as Record<string,unknown>;};
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const instant=(value:unknown)=>typeof value==="string"&&Number.isFinite(new Date(value).valueOf())&&new Date(value).toISOString()===value;
function keys(row:Record<string,unknown>,allowed:string[]){if(Object.keys(row).length!==allowed.length||Object.keys(row).some(key=>!allowed.includes(key)))throw failure();}
export function noticePage(value:unknown,jobId:string,cursor?:string):NoticePage{
 const data=object(value);keys(data,["ok","jobId","reports","nextCursor","dispatch"]);
 if(!registryId(jobId)||(cursor!==undefined&&!hash(cursor))||data.ok!==true||data.jobId!==jobId||data.dispatch!=="disabled"||
  !Array.isArray(data.reports)||data.reports.length>25||(data.nextCursor!==null&&!hash(data.nextCursor)))throw failure();
 let previous=cursor??"";
 const reports=data.reports.map(value=>{
  const row=object(value);keys(row,["operationKey","jobId","bindingRevision","workDate","fixedCaseId","kind","operationId","sequence","reportedStatus","observedAt","sourceRecordId","state","reason","receivedAt","verificationMethod","deliveryVerified","automaticRetryAllowed"]);
  if(!hash(row.operationKey)||row.operationKey<=previous||row.jobId!==jobId)throw failure();previous=row.operationKey;
  for(const key of ["bindingRevision","fixedCaseId","operationId","sourceRecordId"])if(!registryId(row[key]))throw failure();
  if(typeof row.workDate!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(row.workDate)||!instant(row.workDate+"T00:00:00.000Z")||
   (row.kind!=="notice.departure"&&row.kind!=="notice.entry")||!Number.isSafeInteger(row.sequence)||(row.sequence as number)<1||
   typeof row.reportedStatus!=="string"||!Object.hasOwn(noticeStatusLabels,row.reportedStatus)||
   typeof row.state!=="string"||!Object.hasOwn(noticeStateLabels,row.state)||typeof row.reason!=="string"||!Object.hasOwn(noticeReasons,row.reason)||
   !instant(row.observedAt)||!instant(row.receivedAt)||row.verificationMethod!=="authenticated-source-report"||
   row.deliveryVerified!==false||row.automaticRetryAllowed!==false)throw failure();
  if((row.state==="current"&&row.reason!=="aligned")||(row.state==="historical"&&row.reason!=="binding_changed")||
   (row.state==="needs_review"&&(row.reason==="aligned"||row.reason==="binding_changed")))throw failure();
  return {...row} as NoticeReport;
 });
 if(data.nextCursor!==null&&(reports.length!==25||data.nextCursor!==reports.at(-1)?.operationKey))throw failure();
 return {reports,nextCursor:data.nextCursor as string|null};
}
