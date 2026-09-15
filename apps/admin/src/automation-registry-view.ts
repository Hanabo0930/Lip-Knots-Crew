import {registryId,registryWrite,type RegistryKind,type RegistryWrite,type RegistryAssignment} from "./automation-registry-attempt";
export type RegistrySelection={kind:RegistryKind;targetId:string};
export type RegistryView={
  kind:RegistryKind;revision:string|null;record:{
    active?:boolean;producerId?:string;phase?:"mail_bridge"|"app";personKey?:string;fixedCaseId?:string;assignment?:RegistryAssignment|null;
  }|null;
  source:{id:string;name:string;active?:boolean;jobRevision?:number;caseId?:string;workDate?:string;spreadsheetId?:string;assignedStaffId?:string}|null;
};
export type RegistryForm={evidenceRecordId:string;confirmed:boolean;producerId:string;active:boolean;
  phase:"mail_bridge"|"app";sourceStopped:boolean;oldRepliesRetained:boolean;personKey:string;fixedCaseId:string;proofEpoch:string};
const invalid=()=>new Error("連携台帳の確認情報が一致しません。対象を選び直して、もう一度読み込んでください。");
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=="object"||Array.isArray(value))throw invalid();return value as Record<string,unknown>;};
const id=(value:unknown):string=>{if(!registryId(value))throw invalid();return value;};
const text=(value:unknown):string=>{if(typeof value!=="string")throw invalid();return value;};
const boolean=(value:unknown):boolean=>{if(typeof value!=="boolean")throw invalid();return value;};
const person=(value:unknown):string=>{if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))throw invalid();return value;};
const optionalId=(value:unknown)=>value===null?"":id(value);
function assignment(value:unknown):RegistryAssignment|null{
  if(value===null)return null;
  const row=object(value);return {staffId:id(row.staffId),personKey:person(row.personKey),proofEpoch:id(row.proofEpoch)};
}
export function registryReadInput(selection:RegistrySelection){
  if(selection.kind==="binding")return {kind:selection.kind,jobId:id(selection.targetId)};
  if(selection.kind==="person")return {kind:selection.kind,staffId:id(selection.targetId)};
  if(selection.kind==="principal"||selection.kind==="routing")return {kind:selection.kind};
  throw invalid();
}
export function registrySelection(request:RegistryWrite):RegistrySelection{
  return {kind:request.kind,targetId:request.kind==="binding"?request.jobId!:request.kind==="person"?request.staffId!:""};
}
export function parseRegistryView(value:unknown,selection:RegistrySelection,owner:{companyId:string;uid:string}):RegistryView{
  registryReadInput(selection);
  const data=object(value);if(data.ok!==true||data.kind!==selection.kind)throw invalid();
  const saved=data.record===null?null:object(data.record);
  const view:RegistryView={kind:selection.kind,revision:saved?id(saved.revision):null,record:saved?{}:null,source:null};
  if(selection.kind==="principal"){
    if(saved){if(saved.uid!==owner.uid)throw invalid();view.record={producerId:id(saved.producerId),active:boolean(saved.active)};}
  }else if(selection.kind==="routing"){
    if(saved){
      if(saved.companyId!==owner.companyId||saved.version!==1||saved.noticeOwner!=="notice_control"||
          !["app","mail_bridge"].includes(String(saved.phase)))throw invalid();
      view.record={phase:saved.phase as "app"|"mail_bridge"};
    }
  }else if(selection.kind==="person"){
    const raw=object(data.source);if(raw.staffId!==selection.targetId)throw invalid();
    view.source={id:id(raw.staffId),name:text(raw.displayName),active:boolean(raw.active)};
    if(saved){if(saved.staffId!==selection.targetId)throw invalid();view.record={personKey:person(saved.personKey),active:boolean(saved.active)};}
  }else{
    const raw=object(data.source);if(raw.jobId!==selection.targetId||!Number.isSafeInteger(raw.jobRevision)||Number(raw.jobRevision)<0)throw invalid();
    view.source={id:id(raw.jobId),name:text(raw.storeName),jobRevision:Number(raw.jobRevision),
      caseId:optionalId(raw.caseId),workDate:raw.workDate===null?"":text(raw.workDate),spreadsheetId:optionalId(raw.spreadsheetId),
      assignedStaffId:optionalId(raw.assignedStaffId)};
    if(saved){
      if(saved.companyId!==owner.companyId||saved.jobId!==selection.targetId||saved.version!==1)throw invalid();
      view.record={fixedCaseId:id(saved.fixedCaseId),assignment:assignment(saved.assignment)};
    }
  }
  return view;
}
export function registryForm(view:RegistryView):RegistryForm{
  return {evidenceRecordId:"",confirmed:false,producerId:view.record?.producerId??"",active:view.record?.active??true,
    phase:view.record?.phase??"mail_bridge",sourceStopped:false,oldRepliesRetained:false,personKey:view.record?.personKey??"",
    fixedCaseId:view.record?.fixedCaseId??"",proofEpoch:view.record?.assignment?.proofEpoch??""};
}
export function registryFormFromAttempt(request:RegistryWrite):RegistryForm{
  return {evidenceRecordId:request.evidenceRecordId,confirmed:true,producerId:request.producerId??"",active:request.active??true,
    phase:request.phase??"mail_bridge",sourceStopped:request.sourceMailCreationStopped===true,oldRepliesRetained:request.oldRepliesRetained===true,
    personKey:request.personKey??"",fixedCaseId:request.fixedCaseId??"",proofEpoch:request.assignment?.proofEpoch??""};
}
export function prepareRegistryWrite(view:RegistryView,form:RegistryForm,requestId:string,assignedPerson:RegistryView|null=null):RegistryWrite{
  if(!form.confirmed)throw new Error("対象と原本・確認資料の照合が終わったら、確認欄にチェックしてください。");
  if(!registryId(form.evidenceRecordId))throw new Error("確認資料の識別子を入力してください。英数字とハイフン等で160文字以内です。");
  const common={kind:view.kind,requestId,expectedRevision:view.revision,evidenceRecordId:form.evidenceRecordId,confirmedAgainstSource:true as const};
  if(view.kind==="principal"){
    if(!registryId(form.producerId))throw new Error("連携する実行元の識別子を確認してください。");
    return registryWrite({...common,producerId:form.producerId,active:form.active});
  }
  if(view.kind==="routing"){
    if(view.record?.phase==="app"&&form.phase!=="app")throw new Error("アプリ移行後のメール募集再開には、別途切替確認が必要です。");
    if(form.phase==="app"&&(!form.sourceStopped||!form.oldRepliesRetained))throw new Error("元の新規募集の停止と、過去メールの返信回収を確認してください。");
    return registryWrite({...common,phase:form.phase,...(form.phase==="app"?{sourceMailCreationStopped:true,oldRepliesRetained:true}:{})});
  }
  if(view.kind==="person"){
    if(!view.source)throw invalid();
    if(form.active&&!view.source.active)throw new Error("利用停止中のスタッフは有効な本人対応へ登録できません。");
    if(!/^[a-f0-9]{64}$/.test(form.personKey))throw new Error("外部の本人照合IDを64桁の英数字で確認してください。");
    return registryWrite({...common,staffId:view.source.id,personKey:form.personKey,active:form.active});
  }
  const source=view.source;
  if(!source?.caseId||!source.spreadsheetId||!/^\d{4}-\d{2}-\d{2}$/.test(source.workDate??""))throw new Error("案件の元表・案件番号・勤務日が不足しています。原本の取込状況を確認してください。");
  if(!registryId(form.fixedCaseId))throw new Error("外部側で確定した案件の固定IDを入力してください。");
  if(view.record?.fixedCaseId&&form.fixedCaseId!==view.record.fixedCaseId)throw new Error("登録済み固定IDの差替えには、既存履歴の移行確認が必要です。");
  let assignment:RegistryAssignment|null=null;
  if(source.assignedStaffId){
    if(!assignedPerson||assignedPerson.kind!=="person"||assignedPerson.source?.id!==source.assignedStaffId||
        !assignedPerson.source.active||!assignedPerson.record?.active||!assignedPerson.record.personKey)
      throw new Error("確定担当者の本人対応を先に確認・登録してください。");
    if(!registryId(form.proofEpoch))throw new Error("担当者の現在の本人入力証跡を確認してください。");
    assignment={staffId:source.assignedStaffId,personKey:assignedPerson.record.personKey,proofEpoch:form.proofEpoch};
  }
  return registryWrite({...common,jobId:source.id,jobRevision:source.jobRevision,fixedCaseId:form.fixedCaseId,assignment});
}
