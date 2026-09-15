export type Presence = "recorded" | "missing" | "invalid";
export type RecordedTime = {state:Presence;value:string|null};
export type ReviewRecord = {
  id:string;jobId:string|null;status:string|null;operation:string|null;
  createdAt:RecordedTime;updatedAt:RecordedTime;retryAt:RecordedTime;
  writeVerificationRequired:boolean;sourceWriteVerified:false;reviewReasons:string[];
  recordedEvidence:{actor:Presence;staff:Presence;workDate:Presence;operationKey:Presence};
};
export type ReviewPage = {
  companyId:string;actorUid:string;reviewMode:"metadata_only";sourceWriteVerified:false;
  consistentSnapshot:false;limit:50;records:ReviewRecord[];nextCursor:string|null;
};
export type SheetReviewApi = {read:(cursor?:string)=>Promise<unknown>};
const presence = (value:unknown):value is Presence => ["recorded","missing","invalid"].includes(String(value));
const object = (value:unknown):value is Record<string,unknown> => Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
const id = (value:unknown):value is string => typeof value==="string"&&value.length>0&&value.length<=1500&&!value.includes("/")&&value!=="."&&value!=="..";
const text = (value:unknown,max:number) => value===null||typeof value==="string"&&value.length>0&&value.length<=max;
function time(value:unknown) {
  return object(value)&&presence(value.state)&&(value.state==="recorded"
    ? typeof value.value==="string"&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.value)&&Number.isFinite(Date.parse(value.value))&&new Date(value.value).toISOString()===value.value
    : value.value===null);
}
export function reviewPage(value:unknown,companyId:string,uid:string,cursor?:string):ReviewPage {
  const fail=()=>{throw new Error("取得結果を確認できません。確認画面からもう一度読み込んでください。");};
  if(!object(value)||value.companyId!==companyId||value.actorUid!==uid||value.reviewMode!=="metadata_only"||
    value.sourceWriteVerified!==false||value.consistentSnapshot!==false||value.limit!==50||
    !Array.isArray(value.records)||value.records.length>50) return fail();
  const ids=new Set<string>();
  for(const row of value.records) {
    if(!object(row)||!id(row.id)||ids.has(row.id)||row.id===cursor||!text(row.jobId,1500)||!text(row.status,80)||!text(row.operation,120)||
      !time(row.createdAt)||!time(row.updatedAt)||!time(row.retryAt)||typeof row.writeVerificationRequired!=="boolean"||
      row.sourceWriteVerified!==false||!Array.isArray(row.reviewReasons)||row.reviewReasons.length>6||
      !row.reviewReasons.every(reason=>typeof reason==="string"&&reason.length<=60)||new Set(row.reviewReasons).size!==row.reviewReasons.length||
      !object(row.recordedEvidence)||!presence(row.recordedEvidence.actor)||!presence(row.recordedEvidence.staff)||!presence(row.recordedEvidence.workDate)||!presence(row.recordedEvidence.operationKey)) return fail();
    ids.add(row.id);
  }
  if(value.nextCursor!==null&&(!id(value.nextCursor)||value.records.length!==50||
    value.nextCursor!==value.records.at(-1)?.id||value.nextCursor===cursor)) return fail();
  return value as unknown as ReviewPage;
}
export const presenceLabels:Record<Presence,string>={recorded:"記録あり（内容未照合）",missing:"記録なし",invalid:"形式を確認できません"};
export const statusLabels:Record<string,string>={
  pending:"処理待ち",processing:"処理中",retry_wait:"再試行待ち",blocked:"保留",dead_letter:"再試行上限",
  acknowledged:"確認メモあり",completed:"完了の記録あり",error:"旧形式のエラー",paused_global:"運用停止",
};
export function createSheetReviewDemo():SheetReviewApi {
  return {read:async()=>({
    companyId:"demo-company",actorUid:"demo-sheet-review",reviewMode:"metadata_only",sourceWriteVerified:false,consistentSnapshot:false,limit:50,nextCursor:null,
    records:[{
      id:"demo-old-request",jobId:"demo-job",status:"retry_wait",operation:null,
      createdAt:{state:"missing",value:null},updatedAt:{state:"missing",value:null},retryAt:{state:"missing",value:null},
      writeVerificationRequired:true,sourceWriteVerified:false,reviewReasons:["updated_at_missing","write_verification_required","retry_at_missing"],
      recordedEvidence:{actor:"missing",staff:"missing",workDate:"missing",operationKey:"missing"},
    }],
  })};
}
