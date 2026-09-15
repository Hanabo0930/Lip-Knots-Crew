export type RegistryKind="principal"|"routing"|"person"|"binding";
export type RegistryAssignment={staffId:string;personKey:string;proofEpoch:string};
export type RegistryWrite={
  kind:RegistryKind;requestId:string;expectedRevision:string|null;evidenceRecordId:string;confirmedAgainstSource:true;
  producerId?:string;active?:boolean;phase?:"mail_bridge"|"app";sourceMailCreationStopped?:true;oldRepliesRetained?:true;
  staffId?:string;personKey?:string;jobId?:string;jobRevision?:number;fixedCaseId?:string;assignment?:RegistryAssignment|null;
};
export type RegistryAttempt={request:RegistryWrite;action:"save"|"cancel"};
export const registryId=(value:unknown):value is string=>typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const failure=()=>new Error("連携登録の保存記録を確認できません。この画面の入力を控え、ブラウザーの保存設定を確認してください。");
const fields={principal:["producerId","active"],routing:["phase","sourceMailCreationStopped","oldRepliesRetained"],
  person:["staffId","personKey","active"],binding:["jobId","jobRevision","fixedCaseId","assignment"]};
export function registryWrite(value:unknown):RegistryWrite{
  if(!value||typeof value!=="object"||Array.isArray(value))throw failure();
  const row=value as RegistryWrite;
  if(!Object.hasOwn(fields,row.kind)||!registryId(row.requestId)||!registryId(row.evidenceRecordId)||
      (row.expectedRevision!==null&&!registryId(row.expectedRevision))||row.confirmedAgainstSource!==true)throw failure();
  const allowed=["kind","requestId","expectedRevision","evidenceRecordId","confirmedAgainstSource",...fields[row.kind]];
  if(Object.keys(row).some(key=>!allowed.includes(key)))throw failure();
  if(row.kind==="principal"&&(!registryId(row.producerId)||typeof row.active!=="boolean"))throw failure();
  if(row.kind==="routing"){
    if(!["mail_bridge","app"].includes(String(row.phase))||
        (row.sourceMailCreationStopped!==undefined&&row.sourceMailCreationStopped!==true)||
        (row.oldRepliesRetained!==undefined&&row.oldRepliesRetained!==true)||
        (row.phase==="app"&&(!row.sourceMailCreationStopped||!row.oldRepliesRetained)))throw failure();
  }
  if(row.kind==="person"&&(!registryId(row.staffId)||!hash(row.personKey)||typeof row.active!=="boolean"))throw failure();
  if(row.kind==="binding"){
    if(!registryId(row.jobId)||!registryId(row.fixedCaseId)||!Number.isSafeInteger(row.jobRevision)||row.jobRevision!<0)throw failure();
    if(row.assignment!==null){
      const assignment=row.assignment;
      if(!assignment||!registryId(assignment.staffId)||!hash(assignment.personKey)||!registryId(assignment.proofEpoch)||
          Object.keys(assignment).some(key=>!["staffId","personKey","proofEpoch"].includes(key)))throw failure();
    }
  }
  return JSON.parse(JSON.stringify(row));
}
export function registryOwner(companyId:string,uid:string){
  if(!registryId(companyId)||!registryId(uid))throw failure();
  return JSON.stringify([companyId,uid]);
}
function key(owner:string){
  try{const parts=JSON.parse(owner);if(!Array.isArray(parts)||parts.length!==2||registryOwner(parts[0],parts[1])!==owner)throw failure();}
  catch{throw failure();}
  return "lkc.registryAttempt.v1:"+owner;
}
export function loadRegistryAttempt(owner:string):RegistryAttempt|null{
  try{
    const raw=localStorage.getItem(key(owner));if(raw===null)return null;
    const value=JSON.parse(raw);
    if(!value||value.version!==1||!["save","cancel"].includes(value.action))throw failure();
    return {action:value.action,request:registryWrite(value.request)};
  }catch{throw failure();}
}
function write(owner:string,attempt:RegistryAttempt){
  localStorage.setItem(key(owner),JSON.stringify({version:1,...attempt}));
  const saved=loadRegistryAttempt(owner);
  if(saved?.action!==attempt.action||JSON.stringify(saved?.request)!==JSON.stringify(attempt.request))throw failure();
}
export async function reserveRegistryAttempt(owner:string,create:()=>RegistryWrite,isCurrent:()=>boolean){
  if(!navigator.locks)throw new Error("別画面との同時操作を確認できません。ブラウザーを更新して開き直してください。");
  return navigator.locks.request(key(owner),{mode:"exclusive",ifAvailable:true},lock=>{
    if(!isCurrent())return null;
    if(!lock)throw new Error("別の画面で連携登録を確認しています。少し待って再確認してください。");
    const pending=loadRegistryAttempt(owner);
    if(pending)return {attempt:pending,created:false};
    const attempt:RegistryAttempt={request:registryWrite(create()),action:"save"};
    try{write(owner,attempt);}catch{throw failure();}
    return {attempt,created:true};
  });
}
export async function markRegistryCancellation(owner:string,requestId:string,isCurrent:()=>boolean){
  if(!navigator.locks)throw new Error("別画面との同時操作を確認できません。ブラウザーを更新して開き直してください。");
  return navigator.locks.request(key(owner),{mode:"exclusive",ifAvailable:true},lock=>{
    if(!isCurrent())return null;
    if(!lock)throw new Error("別の画面で連携登録を確認しています。少し待って再確認してください。");
    const pending=loadRegistryAttempt(owner);
    if(!pending||pending.request.requestId!==requestId)throw new Error("前回の登録記録が変わっています。画面を開き直してください。");
    const attempt:RegistryAttempt={request:pending.request,action:"cancel"};
    try{write(owner,attempt);}catch{throw failure();}
    return attempt;
  });
}
export async function clearRegistryAttempt(owner:string,requestId:string,isCurrent:()=>boolean=()=>true){
  if(!navigator.locks)throw failure();
  return navigator.locks.request(key(owner),{mode:"exclusive",ifAvailable:true},lock=>{
    if(!isCurrent())return false;
    if(!lock)throw failure();
    const pending=loadRegistryAttempt(owner);
    if(pending?.request.requestId!==requestId)return false;
    localStorage.removeItem(key(owner));return true;
  });
}
export function registrySaveResult(value:unknown,attempt:RegistryAttempt){
  const row=value as {ok?:unknown;kind?:unknown;revision?:unknown;duplicate?:unknown}|null;
  if(!row||row.ok!==true||row.kind!==attempt.request.kind||!registryId(row.revision)||typeof row.duplicate!=="boolean")
    throw new Error("登録結果を確認できません。送信した内容を変えずに再確認してください。");
  return row.revision;
}
export function registryCancellationResult(value:unknown,attempt:RegistryAttempt){
  const row=value as {ok?:unknown;kind?:unknown;requestId?:unknown;outcome?:unknown;revision?:unknown}|null;
  if(!row||row.ok!==true||row.kind!==attempt.request.kind||row.requestId!==attempt.request.requestId||
      !["cancelled","committed"].includes(String(row.outcome))||(row.outcome==="committed"&&!registryId(row.revision)))
    throw new Error("中止の結果を確認できません。送信した内容を変えずに再確認してください。");
  return {outcome:row.outcome as "cancelled"|"committed",revision:row.outcome==="committed"?row.revision as string:null};
}
