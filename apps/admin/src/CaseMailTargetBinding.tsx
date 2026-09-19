import { useEffect, useRef, useState } from "react";
import { mailTargetPreview, type MailApi, type MailCandidate, type MailTargetPreview } from "./case-mail-review";

export default function CaseMailTargetBinding({receiptId,candidate,api,onBusy,onReviewJob}:{receiptId:string;candidate:MailCandidate;api:MailApi;onBusy:(busy:boolean)=>void;onReviewJob?:(jobId:string,action:"edit"|"cancel")=>void}) {
  const [jobId,setJobId]=useState(candidate.targetBinding?.jobId??""),[preview,setPreview]=useState<MailTargetPreview|null>(null);
  const [note,setNote]=useState(""),[checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[message,setMessage]=useState("");
  const [holdKind,setHoldKind]=useState<""|"change"|"cancel">(""),[holdChecked,setHoldChecked]=useState(false);
  const alive=useRef(false),ticket=useRef(0),working=useRef(false);
  useEffect(()=>{alive.current=true;setJobId(candidate.targetBinding?.jobId??"");setPreview(null);setNote("");setChecked(false);setUncertain(false);setHoldKind("");setHoldChecked(false);setMessage("");return()=>{alive.current=false;ticket.current++;};},[receiptId,candidate]);
  const current=(version:number)=>alive.current&&ticket.current===version;
  const jobs=[...new Set([...(candidate.targetBinding?[candidate.targetBinding.jobId]:[]),...(candidate.targetCandidates?.items.map(item=>item.jobId)??[])])];
  async function read() {
    if(working.current||!jobId||!api.previewTarget)return;
    working.current=true;setBusy(true);onBusy(true);setPreview(null);setChecked(false);setHoldChecked(false);setMessage("");
    const version=++ticket.current,request={receiptId,candidateId:candidate.candidateId,jobId};
    try{const value=mailTargetPreview(await api.previewTarget(request),request);if(current(version)){setPreview(value);setUncertain(false);}}
    catch(error){if(current(version))setMessage(error instanceof Error?error.message:"対応先を確認できません。");}
    finally{working.current=false;if(current(version)){setBusy(false);onBusy(false);}}
  }
  async function confirm() {
    if(working.current||!preview||preview.state!=="available"||uncertain||!checked||!note.trim()||!api.confirmTarget)return;
    working.current=true;setBusy(true);onBusy(true);const version=++ticket.current;
    try {
      const result=await api.confirmTarget({receiptId,candidateId:candidate.candidateId,jobId:preview.jobId,reviewVersion:preview.reviewVersion,note:note.trim(),confirmed:true}) as {ok?:boolean;saved?:boolean;jobId?:string};
      if(!current(version))return;
      if(result?.ok!==true||result.saved!==true||result.jobId!==preview.jobId)throw Error("保存結果を確認できません。");
      setMessage("対応記録を保存しました。対応先を再確認して保存結果を読み直してください。案件内容・取消・募集は変更していません。");
    }catch(error){if(current(version))setMessage((error instanceof Error?error.message:"保存結果を確認できません。")+" 対応先を再確認してください。");}
    finally{working.current=false;if(current(version)){setUncertain(true);setChecked(false);setBusy(false);onBusy(false);}}
  }
  async function hold() {
    if(working.current||!preview||preview.state!=="confirmed"||!candidate.targetBinding||uncertain||!holdKind||!holdChecked||!api.holdTarget)return;
    working.current=true;setBusy(true);onBusy(true);setMessage("");const version=++ticket.current;
    try {
      const result=await api.holdTarget({receiptId,candidateId:candidate.candidateId,jobId:preview.jobId,reviewVersion:preview.reviewVersion,kind:holdKind,confirmed:true}) as {ok?:boolean;held?:boolean;jobId?:string};
      if(!current(version))return;
      if(result?.ok!==true||result.held!==true||result.jobId!==preview.jobId)throw Error("保留結果を確認できません。");
      setMessage("変更・取消依頼を保留として記録し、募集を停止しました。対応先を再確認してください。");
    }catch(error){if(current(version))setMessage((error instanceof Error?error.message:"保留結果を確認できません。")+" 対応先を再確認してください。");}
    finally{working.current=false;if(current(version)){setUncertain(true);setHoldChecked(false);setBusy(false);onBusy(false);}}
  }

  async function resolveHold() {
    if(working.current||!preview?.resolution?.canResolve||uncertain||!checked||!note.trim()||!api.resolveTarget)return;
    working.current=true;setBusy(true);onBusy(true);setMessage("");const version=++ticket.current;
    try {
      const result=await api.resolveTarget({receiptId,candidateId:candidate.candidateId,jobId:preview.jobId,
        reviewVersion:preview.resolution.reviewVersion,note:note.trim(),confirmed:true}) as {ok?:boolean;resolved?:boolean;jobId?:string};
      if(!current(version))return;
      if(result?.ok!==true||result.resolved!==true||result.jobId!==preview.jobId)throw Error("解除結果を確認できません。");
      setMessage("このメールの保留を解除しました。募集は停止したままです。対応先を再確認してください。");
    }catch(error){if(current(version))setMessage((error instanceof Error?error.message:"解除結果を確認できません。")+" 対応先を再確認してください。");}
    finally{working.current=false;if(current(version)){setUncertain(true);setChecked(false);setBusy(false);onBusy(false);}}
  }
  async function openJob(action:"edit"|"cancel") {
    if(working.current||!candidate.targetBinding||candidate.targetBinding.jobId!==jobId||!api.previewTarget||!onReviewJob)return;
    working.current=true;setBusy(true);onBusy(true);setMessage("");
    const version=++ticket.current,request={receiptId,candidateId:candidate.candidateId,jobId};
    try {
      const value=mailTargetPreview(await api.previewTarget(request),request);
      if(!current(version))return;
      setPreview(value);
      if(value.state!=="confirmed"&&value.state!=="held") {setMessage(value.issue||"対応記録が現在の案件と一致しません。");return;}
      onReviewJob(jobId,action);
    } catch(error) {if(current(version))setMessage(error instanceof Error?error.message:"現在の対応状態を確認できません。");}
    finally {working.current=false;if(current(version)){setBusy(false);onBusy(false);}}
  }
  return <section aria-label="対象案件の対応確定">
    <h4>対象案件の対応確定</h4>
    <p>受信原文と案件の内容を照合し、対応先だけを記録します。案件内容・取消・募集は変更しません。</p>
    {candidate.targetBinding&&<p>対応記録があります。現在の状態を再確認してください。</p>}
    <label>対応先の案件ID<select aria-label="対応先の案件ID" value={jobId} disabled={busy||uncertain||!!candidate.targetBinding}
      onChange={event=>{setJobId(event.target.value);setPreview(null);setChecked(false);setNote("");setMessage("");}}>
      <option value="">案件を選択してください</option>{jobs.map(id=><option key={id} value={id}>{id}</option>)}
    </select></label>
    <button className="ghost" disabled={busy||!jobId} onClick={()=>void read()}>対応先を再確認</button>
    {message&&<p role="status">{message}</p>}
    {preview&&<>
      <dl className="mail-values">{[["案件ID",preview.jobId],["実施日",preview.current.workDate],["店舗",preview.current.storeName],["クライアント",preview.current.clientName],["メーカー",preview.current.makerName],["メニュー",preview.current.menuName],["入店時間",preview.current.entryTime],["実施時間",preview.current.workTime],["取消状態",preview.current.cancelled?"取消済み":"取消なし"]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||"未記載"}</dd></div>)}</dl>
      {(preview.state==="confirmed"||preview.state==="held")&&<>
        <p role="status">{preview.state==="held"?"変更・取消依頼を確認中です。募集は停止しています。案件条件・取消の確定と保留解除は未完了です。":"対象案件との対応記録を確認しました。変更・取消処理は未実施です。"}</p>
        {candidate.targetBinding?.jobId===preview.jobId&&onReviewJob&&<div className="sync-actions">
          <button className="ghost" disabled={busy} onClick={()=>void openJob("edit")}>対応先の案件を編集</button>
          <button className="ghost" disabled={busy} onClick={()=>void openJob("cancel")}>対応先の取消を確認</button>
        </div>}
      </>}
      {preview.state==="confirmed"&&candidate.targetBinding&&api.holdTarget&&<>
        <label>受信した依頼<select aria-label="受信した依頼" value={holdKind} disabled={busy||uncertain} onChange={event=>{setHoldKind(event.target.value as ""|"change"|"cancel");setHoldChecked(false);}}>
          <option value="">依頼を選択してください</option><option value="change">変更依頼</option><option value="cancel">取消依頼</option>
        </select></label>
        <label className="check-line"><input type="checkbox" checked={holdChecked} disabled={busy||uncertain||!holdKind} onChange={event=>setHoldChecked(event.target.checked)}/>原文の変更・取消依頼を確認し、募集を停止して保留します。</label>
        <button disabled={busy||uncertain||!holdKind||!holdChecked} onClick={()=>void hold()}>依頼を保留して募集を停止</button>
      </>}

      {preview.resolution&&<div>
        {preview.resolution.resolved?<p role="status">このメールの保留解除を確認しました。解除時に募集は再開していません。</p>:<>
          <p>{preview.resolution.kind==="cancel"?"取消":"変更"}の原本照合</p>
          {preview.resolution.proposed&&<dl className="mail-values">{Object.entries(preview.resolution.proposed).map(([key,value])=><div key={key}><dt>{({workDate:"依頼の実施日",clientName:"依頼のクライアント",storeName:"依頼の店舗",makerName:"依頼のメーカー",menuName:"依頼のメニュー",entryTime:"依頼の入店時間",workTime:"依頼の実施時間"} as Record<string,string>)[key]}</dt><dd>{value||"未記載"}</dd></div>)}</dl>}
          {preview.resolution.issue&&<p role="status">{preview.resolution.issue}</p>}
          {api.resolveTarget&&<>
            <label>保留解除の確認メモ<textarea aria-label="保留解除の確認メモ" value={note} maxLength={1000} disabled={busy||uncertain||!preview.resolution.canResolve} onChange={event=>setNote(event.target.value)}/></label>
            <label className="check-line"><input type="checkbox" checked={checked} disabled={busy||uncertain||!preview.resolution.canResolve} onChange={event=>setChecked(event.target.checked)}/>原文・案件・原本の照合結果を確認しました。</label>
            <button disabled={busy||uncertain||!preview.resolution.canResolve||!checked||!note.trim()} onClick={()=>void resolveHold()}>このメールの保留を解除</button>
          </>}
        </>}
        {preview.resolution.originReviewRequired&&<p role="status">元メール側の確認待ちは残ります。元メールの受信内容も確認してください。</p>}
      </div>}
      {preview.issue&&<p role="status">{preview.issue}</p>}
      {preview.state==="available"&&<>
        <label>対応先の確認メモ<textarea aria-label="対応先の確認メモ" value={note} maxLength={1000} disabled={busy||uncertain} onChange={event=>setNote(event.target.value)}/></label>
        <label className="check-line"><input type="checkbox" checked={checked} disabled={busy||uncertain} onChange={event=>setChecked(event.target.checked)}/>受信原文と案件ID・日付・店舗・条件を照合しました。</label>
        <button disabled={busy||uncertain||!checked||!note.trim()} onClick={()=>void confirm()}>対象案件との対応を確定</button>
      </>}
    </>}
  </section>;
}
