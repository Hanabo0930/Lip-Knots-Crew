import {useEffect} from "react";
import type {User} from "firebase/auth";
import type {Job} from "./App";
import {auth,firebaseApp,firebaseConfigured} from "./firebase";
import {getAdminFirestore} from "./firestore-client";
import {readAdminNotificationJob} from "./admin-notification-job";
import {useAdminNotificationRoute} from "./useAdminNotificationRoute";
export default function AdminJobNotification({ready,active,user,jobs,onOpen}:{ready:boolean;active:boolean;user:User|null;jobs:Job[];onOpen:(job:Job)=>void|boolean}){
  const route=useAdminNotificationRoute<Job>({ready:ready&&active,scope:user?.uid??"demo",load:async id=>{
    if(!firebaseConfigured)return jobs.find(job=>job.id===id)??null;
    if(!user||!firebaseApp)throw Error("案件に接続できません。");
    return await readAdminNotificationJob(getAdminFirestore(),user,id,()=>auth?.currentUser===user) as Job|null;
  },onOpen});
  useEffect(()=>{if(!active)route.cancel();},[active]);
  if(route.status==="idle")return null;
  return <section className="panel" role="status"><p>{route.status==="loading"?"通知の案件を読み込んでいます…":route.status==="paused"?"案件の切替を見送りました。編集中の内容を確認してから、通知の案件を再読込してください。":route.status==="unavailable"?"通知の対象案件が見つかりません。":"通知の案件を読み込めませんでした。"}</p><button aria-disabled={route.status==="loading"} onClick={()=>{if(route.status!=="loading")void route.retry();}}>通知の案件を再読込</button><button className="ghost" onClick={route.cancel}>閉じる</button></section>;
}
