import { collection, doc, getDoc, getDocs, limit, orderBy, query, startAfter, type Firestore, type QueryDocumentSnapshot } from "firebase/firestore";
import { where } from "firebase/firestore";
export const ADMIN_DIRECTORY_PAGE_SIZE=100;
export async function readAdminJobPage(database:Firestore,companyId:string,anchorId:string,cursor:QueryDocumentSnapshot|null){
  if(!companyId||(!cursor&&!anchorId))throw new Error("一覧を再読込してから追加取得してください。");
  const anchor=cursor??await getDoc(doc(database,"jobs",anchorId));
  if(!anchor.exists()||anchor.data().companyId!==companyId)throw new Error("一覧の続き位置を確認できません。一覧を再読込してください。");
  const snapshot=await getDocs(query(collection(database,"jobs"),where("companyId","==",companyId),orderBy("workDate","asc"),startAfter(anchor),limit(ADMIN_DIRECTORY_PAGE_SIZE+1)));
  if(snapshot.docs.some(item=>item.data().companyId!==companyId))throw new Error("所属を確認できない案件があるため取得を中止しました。");
  const page=snapshot.docs.slice(0,ADMIN_DIRECTORY_PAGE_SIZE);
  const jobs=page.map(item=>{
    const raw=item.data();
    const serialized=Object.fromEntries(Object.entries(raw).map(([key,value])=>[key,value&&typeof value.toDate==="function"?value.toDate().toISOString():value]));
    const workDate=raw.workDate&&typeof raw.workDate.toDate==="function"?raw.workDate.toDate().toLocaleDateString("ja-JP",{month:"numeric",day:"numeric",weekday:"short"}):typeof raw.workDate==="string"?raw.workDate:String(raw.dateKey??"");
    return {...serialized,id:item.id,workDate};
  });
  return {jobs,cursor:page.at(-1)??cursor,hasMore:snapshot.docs.length>ADMIN_DIRECTORY_PAGE_SIZE};
}
