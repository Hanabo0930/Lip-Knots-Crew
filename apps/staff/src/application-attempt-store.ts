export type ApplicationAttempt={requestId:string;startedAt:number;mailApplicationId?:string;mailApplicationRevision?:number};
const failure=()=>new Error("応募確認用の保存記録を確認できません。ブラウザーの保存設定を確認し、シフトで応募結果を確認してください。");
export function applicationAttemptOwner(companyId:string,staffId:string,uid:string):string{
 if([companyId,staffId,uid].some(value=>typeof value!=="string"||!value.trim()))throw failure();
 return JSON.stringify([companyId,staffId,uid]);
}
function legacyKey(owner:string){if(!owner)throw failure();return "lkc.applicationAttempts.v1:"+owner;}
function prefix(owner:string){if(!owner)throw failure();return "lkc.applicationAttempts.v2:"+owner+":";}
function recordKey(owner:string,jobId:string){if(typeof jobId!=="string"||!jobId.trim()||jobId.includes("/"))throw failure();return prefix(owner)+encodeURIComponent(jobId);}
function attemptValue(value:unknown):ApplicationAttempt{
 const row=value as Partial<ApplicationAttempt>|null;
 if(!row||typeof row.requestId!=="string"||!row.requestId.trim()||row.requestId.includes("/")||typeof row.startedAt!=="number"||!Number.isFinite(row.startedAt)||row.startedAt<0)throw failure();
 if(row.mailApplicationId!==undefined||row.mailApplicationRevision!==undefined){
  if(typeof row.mailApplicationId!=="string"||!/^[a-f0-9]{64}$/.test(row.mailApplicationId)||!Number.isSafeInteger(row.mailApplicationRevision)||row.mailApplicationRevision!<1)throw failure();
  return {requestId:row.requestId,startedAt:row.startedAt,mailApplicationId:row.mailApplicationId,mailApplicationRevision:row.mailApplicationRevision};
 }
 return {requestId:row.requestId,startedAt:row.startedAt};
}
export function loadSavedApplicationAttempts(owner:string):Map<string,ApplicationAttempt>{
 try{
  const result=new Map<string,ApplicationAttempt>(),raw=localStorage.getItem(legacyKey(owner));
  if(raw!==null){const data=JSON.parse(raw);if(!data||data.version!==1||!Array.isArray(data.attempts))throw failure();for(const row of data.attempts){recordKey(owner,row?.jobId);if(result.has(row.jobId))throw failure();result.set(row.jobId,attemptValue(row));}}
  const ownerPrefix=prefix(owner),keys:string[]=[];
  for(let index=0;index<localStorage.length;index++){const key=localStorage.key(index);if(key?.startsWith(ownerPrefix))keys.push(key);}
  for(const key of keys){const raw=localStorage.getItem(key);if(raw===null)continue;const row=JSON.parse(raw);if(!row||row.version!==2||key!==recordKey(owner,row.jobId))throw failure();if(row.attempt===null)result.delete(row.jobId);else result.set(row.jobId,attemptValue(row.attempt));}
  return result;
 }catch{throw failure();}
}
export function saveApplicationAttempt(owner:string,jobId:string,attempt:ApplicationAttempt):void{
 try{
  const key=recordKey(owner,jobId),value=attemptValue(attempt),existing=loadSavedApplicationAttempts(owner).get(jobId);
  if(existing&&JSON.stringify(existing)!==JSON.stringify(value))throw failure();
  localStorage.setItem(key,JSON.stringify({version:2,jobId,attempt:value}));
  const saved=loadSavedApplicationAttempts(owner).get(jobId);if(JSON.stringify(saved)!==JSON.stringify(value))throw failure();
 }catch{throw failure();}
}
export function removeSavedApplicationAttempt(owner:string,jobId:string,requestId:string):void{
 if(loadSavedApplicationAttempts(owner).get(jobId)?.requestId!==requestId)return;
 // 旧形式の記録を消さずに、確認済み案件が再び復元されることを防ぐ。
 localStorage.setItem(recordKey(owner,jobId),JSON.stringify({version:2,jobId,attempt:null}));
}

export async function reserveApplicationAttempt(owner:string,jobId:string,create:()=>ApplicationAttempt,isCurrent:()=>boolean=()=>true):Promise<ApplicationAttempt|null>{
 const lockName=recordKey(owner,jobId);
 if(!navigator.locks)throw new Error("応募の同時操作を確認できません。ブラウザーを更新して開き直し、シフトで応募結果を確認してください。");
 return navigator.locks.request(lockName,{mode:"exclusive",ifAvailable:true},lock=>{
  if(!isCurrent())return null;
  if(!lock)throw new Error("別の画面でこの案件の応募を確認しています。少し待ってから、もう一度応募結果を確認してください。");
  const attempt=loadSavedApplicationAttempts(owner).get(jobId)??create();
  saveApplicationAttempt(owner,jobId,attempt);
  return attempt;
 });
}

export function observeApplicationAttempts(owner:string,onChange:(attempts:Map<string,ApplicationAttempt>)=>void,onError:()=>void):()=>void{
 let active=true;
 const refresh=()=>{if(!active)return;try{onChange(loadSavedApplicationAttempts(owner));}catch{onError();}};
 const changed=(event:StorageEvent)=>{if(event.storageArea!==localStorage)return;if(event.key===null||event.key===legacyKey(owner)||event.key.startsWith(prefix(owner)))refresh();};
 window.addEventListener("storage",changed);
 window.addEventListener("focus",refresh);
 return()=>{active=false;window.removeEventListener("storage",changed);window.removeEventListener("focus",refresh);};
}
