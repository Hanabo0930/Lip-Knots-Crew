import {getAdminFirestore} from "./firestore-client";
import { collection, doc, getDoc, getDocs, limit, orderBy, query, startAfter, type Firestore, type QueryDocumentSnapshot } from "firebase/firestore";
import { where } from "firebase/firestore";
export const ADMIN_STAFF_PAGE_SIZE=100;
export async function readAdminStaffPage(database:Firestore,companyId:string,anchorId:string,cursor:QueryDocumentSnapshot|null){
  if(!companyId||(!cursor&&!anchorId))throw new Error("一覧を再読込してから追加取得してください。");
  const anchor=cursor??await getDoc(doc(database,"staffProfiles",anchorId));
  if(!anchor.exists()||anchor.data().companyId!==companyId)throw new Error("一覧の続き位置を確認できません。一覧を再読込してください。");
  const snapshot=await getDocs(query(collection(database,"staffProfiles"),where("companyId","==",companyId),orderBy("displayName","asc"),startAfter(anchor),limit(ADMIN_STAFF_PAGE_SIZE+1)));
  if(snapshot.docs.some(item=>item.data().companyId!==companyId))throw new Error("所属を確認できないスタッフがあるため取得を中止しました。");
  const page=snapshot.docs.slice(0,ADMIN_STAFF_PAGE_SIZE);
  const staff=page.map(item=>{
    const serialized=Object.fromEntries(Object.entries(item.data()).map(([key,value])=>[key,value&&typeof value.toDate==="function"?value.toDate().toISOString():value]));
    return {...serialized,id:item.id};
  });
  return {staff,cursor:page.at(-1)??cursor,hasMore:snapshot.docs.length>ADMIN_STAFF_PAGE_SIZE};
}

export function readCurrentAdminStaffPage(companyId:string,anchorId:string,cursor:QueryDocumentSnapshot|null){
  return readAdminStaffPage(getAdminFirestore(),companyId,anchorId,cursor);
}
