import {useState} from "react";

type Receipt = {id:string;purpose:string;status:string;createdAt:string|null;files:unknown[]};
type Props = {submissions:Receipt[];disabled:boolean;onCheck:(submissionId:string)=>Promise<void>};

const statuses:Record<string,string>={
  uploading:"アップロード待ち",processing:"転送中",paused_global:"転送一時停止",error:"転送エラー",completed:"保存済み",
};

function receiptLabel(receipt:Receipt,index:number){
  const date=receipt.createdAt?new Date(receipt.createdAt):null;
  const time=date&&Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",month:"numeric",day:"numeric",hour:"numeric",minute:"2-digit"}).format(date)
    : "受付日時確認中";
  return String(index+1)+". "+time+" / "+(receipt.purpose==="replacement"?"再提出":"提出")+" "+receipt.files.length+"件 / "+(Object.hasOwn(statuses,receipt.status)?statuses[receipt.status]:"状態確認中");
}

export default function SubmissionProcessingRecovery({submissions,disabled,onCheck}:Props){
  const [selectedId,setSelectedId]=useState("");
  if(!submissions.length)return null;
  const selected=submissions.find(receipt=>receipt.id===selectedId)??submissions[0];
  const canCheck=Object.hasOwn(statuses,selected.status)&&selected.files.length>0&&selected.files.length<=20;
  return <div className="submission-context-card" aria-label="受付済み提出の処理状況">
    <label className="submission-destination"><span>受付済み提出を選んで確認</span>
      <select aria-label="状況を確認する提出" value={selected.id} disabled={disabled} onChange={event=>setSelectedId(event.target.value)}>
        {submissions.map((receipt,index)=><option key={receipt.id} value={receipt.id}>{receiptLabel(receipt,index)}</option>)}
      </select>
    </label>
    <button type="button" className="secondary" disabled={disabled||!canCheck} onClick={()=>void onCheck(selected.id)}>選んだ提出の処理状況を確認</button>
    <small>再送せず、受付済み提出の保存状況を確認します。転送の停止やエラーが続く場合は管理者へ確認してください。</small>
  </div>;
}
