import {doc,getDoc,type Firestore} from "firebase/firestore";
import type {User} from "firebase/auth";
export async function readAdminNotificationJob(database:Firestore,user:User,id:string,isCurrent:()=>boolean){
  if(!id||id.includes("/"))throw Error("通知の案件を確認できません。");
  const token=await user.getIdTokenResult();if(!isCurrent())return null;
  const companyId=token.claims.companyId;
  if(token.claims.role!=="admin"||typeof companyId!=="string"||!companyId)throw Error("管理者の所属を確認できません。");
  const snap=await getDoc(doc(database,"jobs",id));if(!isCurrent())return null;
  if(!snap.exists())return null;
  const raw=snap.data();if(raw.companyId!==companyId)throw Error("所属を確認できない案件です。");
  const serialized=Object.fromEntries(Object.entries(raw).map(([key,value])=>[key,value&&typeof value.toDate==="function"?value.toDate().toISOString():value]));
  const workDate=raw.workDate&&typeof raw.workDate.toDate==="function"?raw.workDate.toDate().toLocaleDateString("ja-JP",{month:"numeric",day:"numeric",weekday:"short"}):typeof raw.workDate==="string"?raw.workDate:String(raw.dateKey??"");
  return {...serialized,id:snap.id,workDate};
}
