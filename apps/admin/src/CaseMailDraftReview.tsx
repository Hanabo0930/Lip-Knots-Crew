import { useRef, useState, useEffect } from "react";
import { mailCandidateRequirements, type MailApi, type MailCandidate } from "./case-mail-review";
const labels = [["workDate","実施日"],["clientName","クライアント"],["storeName","店舗"],["makerName","メーカー"],["menuName","メニュー"],["entryTime","入店時間"],["workTime","実施時間"]] as const;
export default function CaseMailDraftReview({receiptId,candidate,api,busy,onBusy,onReload}:{receiptId:string;candidate:MailCandidate;api:MailApi;busy:boolean;onBusy:(value:boolean)=>void;onReload:()=>void}){
  const [input,setInput]=useState({...candidate.input}),[note,setNote]=useState(""),[whole,setWhole]=useState(false),[single,setSingle]=useState(false);
  const [uncertain,setUncertain]=useState(false),[message,setMessage]=useState("");
  const mounted=useRef(true),sending=useRef(false);useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
  const review=candidate.draftReview!,missing=mailCandidateRequirements(input);
  async function confirm(){
    if(sending.current||busy||uncertain||!api.confirmDraft||!review.canConfirm||!review.reviewVersion||missing.length||!note.trim()||!whole||!single)return;
    sending.current=true;onBusy(true);setMessage("");
    try{
      const result=await api.confirmDraft({receiptId,candidateId:candidate.candidateId,reviewVersion:review.reviewVersion,input,note:note.trim(),entireSourceConfirmed:true,newSingleCaseConfirmed:true}) as {ok?:boolean;confirmed?:boolean;receiptId?:string;candidateId?:string};
      if(!mounted.current)return;
      if(result?.ok!==true||result.confirmed!==true||result.receiptId!==receiptId||result.candidateId!==candidate.candidateId)throw Error("確認結果を読み取れませんでした。");
      setUncertain(true);setWhole(false);setSingle(false);setMessage("原文との確認を記録しました。内容を再読込してから下書きを作成できます。");
    }catch(error){if(mounted.current){setUncertain(true);setWhole(false);setSingle(false);setMessage((error instanceof Error?error.message:"通信結果を確認できません。")+" 受信内容を再読込し、保存結果を確認してください。");}}
    finally{sending.current=false;onBusy(false);}
  }
  return <section className="locked-note" aria-label="原文との照合と補正"><h4>原文との照合と補正</h4>
    {review.confirmed?<p>原文との確認は記録済みです。下書き作成には、受信元・重複・登録状態をもう一度照合します。</p>:review.canConfirm&&api.confirmDraft?<>
      <p>元メールとすべての添付を確認し、不足や誤りを補正してください。1メールに新規1名の案件が1件だけある場合に使用できます。</p>
      {labels.map(([key,label])=><label key={key}>{label}（原文確認）<input aria-label={label+"（原文確認）"} type={key==="workDate"?"date":"text"}
        value={input[key]} maxLength={key==="menuName"?500:key==="workDate"?20:key==="entryTime"||key==="workTime"?100:200} disabled={busy||uncertain}
        onChange={event=>{setInput({...input,[key]:event.target.value});setWhole(false);setSingle(false);}}/></label>)}
      {missing.length>0&&<p>確認が必要：{missing.join("、")}</p>}
      <label>原文確認メモ<textarea aria-label="原文確認メモ" value={note} maxLength={1000} disabled={busy||uncertain} onChange={event=>{setNote(event.target.value);setWhole(false);setSingle(false);}}/></label>
      <label className="check-line"><input type="checkbox" checked={whole} disabled={busy||uncertain} onChange={event=>setWhole(event.target.checked)}/>元メールと添付全体を照合し、日付・店舗・勤務条件を確認しました。</label>
      <label className="check-line"><input type="checkbox" checked={single} disabled={busy||uncertain} onChange={event=>setSingle(event.target.checked)}/>変更・取消ではなく、新規1名の案件が1件だけの依頼です。</label>
      <button disabled={busy||uncertain||missing.length>0||!note.trim()||!whole||!single} onClick={()=>void confirm()}>補正内容の確認を記録</button>
    </>:<p>{review.issue||"原文との照合は準備中です。"}</p>}
    {message&&<p role="status">{message}</p>}
    {uncertain&&<button className="ghost" disabled={busy} onClick={onReload}>補正後の受信内容を再読込</button>}
  </section>;
}
