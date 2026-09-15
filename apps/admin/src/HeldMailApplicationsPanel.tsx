import {useEffect,useRef,useState} from "react";
import {heldOwner,heldList,heldDetail,heldRequest,heldReviewResult,heldCancelResult,loadHeldAttempt,reserveHeldAttempt,cancelHeldAttempt,clearHeldAttempt,
  type HeldItem,type HeldDetail,type HeldReviewRequest,type HeldAttempt,type HeldResult} from "./held-mail-review";
export type HeldMailApi={list:(cursor?:string)=>Promise<unknown>;read:(receiptKey:string)=>Promise<unknown>;review:(input:HeldReviewRequest)=>Promise<unknown>;cancel:(input:HeldReviewRequest)=>Promise<unknown>};
const errorMessage=(error:unknown)=>error instanceof Error?error.message:"確認できませんでした。もう一度お試しください。";
export default function HeldMailApplicationsPanel({companyId,uid,api,demo=false,onClose}:{companyId:string;uid:string;api:HeldMailApi;demo?:boolean;onClose:()=>void}){
  const owner=heldOwner(companyId,uid),ownerRef=useRef(owner);ownerRef.current=owner;
  const apiRef=useRef(api);apiRef.current=api;
  const listButtons=useRef(new Map<string,HTMLButtonElement>());
  const mounted=useRef(false),listVersion=useRef(0),detailVersion=useRef(0),busyRef=useRef(false),heading=useRef<HTMLHeadingElement>(null),detailHeading=useRef<HTMLHeadingElement>(null);
  const [items,setItems]=useState<HeldItem[]>([]),[nextCursor,setNextCursor]=useState<string|null>(null),[pageCursor,setPageCursor]=useState<string|undefined>();
  const [listStatus,setListStatus]=useState<"loading"|"ready"|"error">("loading"),[detailStatus,setDetailStatus]=useState<"idle"|"loading"|"ready"|"error">("idle");
  const [selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<HeldDetail|null>(null);
  const [attempt,setAttempt]=useState<HeldAttempt|null>(null),[initialized,setInitialized]=useState(false),[reload,setReload]=useState(0);
  const [evidence,setEvidence]=useState(""),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
  const isCurrent=()=>mounted.current&&ownerRef.current===owner;
  function sync(){
    if(busyRef.current)return;
    try{const saved=loadHeldAttempt(owner);setAttempt(current=>JSON.stringify(current)===JSON.stringify(saved)?current:saved);setInitialized(true);}
    catch(failure){setError(errorMessage(failure));setInitialized(false);}
  }
  useEffect(()=>{
    mounted.current=true;heading.current?.focus();sync();
    const storage=(event:StorageEvent)=>{if(event.storageArea===localStorage&&(event.key===null||event.key==="lkc.heldReviewAttempt.v1:"+owner))sync();};
    window.addEventListener("storage",storage);window.addEventListener("focus",sync);
    return()=>{mounted.current=false;listVersion.current++;detailVersion.current++;window.removeEventListener("storage",storage);window.removeEventListener("focus",sync);};
  },[owner]);
  async function loadList(cursor?:string){
    const ticket=++listVersion.current;detailVersion.current++;setSelected(null);setDetail(null);setDetailStatus("idle");setListStatus("loading");setError("");setConfirmed(false);
    try{const loaded=heldList(await apiRef.current.list(cursor));if(!isCurrent()||ticket!==listVersion.current)return;
      setItems(loaded.items);setNextCursor(loaded.nextCursor);setPageCursor(cursor);setListStatus("ready");
    }catch(failure){if(isCurrent()&&ticket===listVersion.current){setError(errorMessage(failure));setListStatus("error");}}
  }
  useEffect(()=>{if(initialized&&!attempt)void loadList();else if(attempt){listVersion.current++;detailVersion.current++;setDetail(null);setDetailStatus("idle");}},[initialized,attempt,reload]);
  async function loadDetail(receiptKey:string){
    if(busyRef.current||attempt||listStatus!=="ready")return;
    const ticket=++detailVersion.current;setSelected(receiptKey);setDetail(null);setDetailStatus("loading");setError("");setConfirmed(false);setEvidence("");
    try{const loaded=heldDetail(await apiRef.current.read(receiptKey),receiptKey);if(!isCurrent()||ticket!==detailVersion.current)return;
      setDetail(loaded);setDetailStatus("ready");requestAnimationFrame(()=>{if(isCurrent()&&ticket===detailVersion.current)detailHeading.current?.focus();});
    }catch(failure){if(isCurrent()&&ticket===detailVersion.current){setError(errorMessage(failure));setDetailStatus("error");}}
  }
  function backToList(){detailVersion.current++;setDetail(null);setDetailStatus("idle");setConfirmed(false);const key=selected;requestAnimationFrame(()=>{if(isCurrent()&&key)listButtons.current.get(key)?.focus();});}
  function outcomeMessage(result:HeldResult){
    return result.route==="hold"?"再照合の記録を保存しました。確認事項が残るため、この応募は保留を続けます。":
      result.intakeOwner==="legacy_mail"?"確認候補へ戻しました。現在の受付はメール側です。":
      "スタッフが確認できる応募候補へ戻しました。担当の確定にはスタッフ本人の確認が必要です。";
  }
  async function deliver(pending:HeldAttempt){
    const value=pending.action==="cancel"?await apiRef.current.cancel(pending.request):await apiRef.current.review(pending.request);
    if(!isCurrent())return;
    const outcome=pending.action==="cancel"?heldCancelResult(value,pending.request):{outcome:"committed" as const,result:heldReviewResult(value,pending.request)};
    setMessage((demo?"デモ：":"")+(outcome.outcome==="cancelled"?"未確定の再照合を中止しました。最新の内容を確認してから操作してください。":outcomeMessage(outcome.result!)));
    try{await clearHeldAttempt(owner,pending.request.requestId,isCurrent);if(!isCurrent())return;
      const remaining=loadHeldAttempt(owner);setAttempt(remaining);if(!remaining)setReload(value=>value+1);
    }catch{if(isCurrent())setError("結果は確認済みですが、端末の確認記録を更新できません。同じ操作をもう一度確認してください。");}
  }
  async function review(){
    if(busyRef.current||attempt||!initialized||detailStatus!=="ready"||!detail||detail.route!=="hold"||!confirmed)return;
    busyRef.current=true;setBusy(true);setError("");setMessage("");
    try{
      const request=heldRequest({receiptKey:detail.receiptKey,requestId:crypto.randomUUID(),expectedReceiptRevision:detail.receiptRevision,
        expectedReviewRevision:detail.reviewRevision,evidenceRecordId:evidence.trim(),confirmedAgainstSource:true});
      const saved=await reserveHeldAttempt(owner,request,isCurrent);if(!saved||!isCurrent())return;
      setAttempt(saved.attempt);if(saved.created)await deliver(saved.attempt);
      else setMessage("前回の操作が残っています。最初と同じ内容で結果を確認してください。");
    }catch(failure){if(isCurrent())setError(errorMessage(failure));}
    finally{busyRef.current=false;if(isCurrent())setBusy(false);}
  }
  async function recover(cancel=false){
    if(busyRef.current||!attempt)return;busyRef.current=true;setBusy(true);setError("");setMessage("");
    try{const saved=cancel?await cancelHeldAttempt(owner,attempt.request.requestId,isCurrent):loadHeldAttempt(owner);
      if(!saved||!isCurrent())return;setAttempt(saved);await deliver(saved);
    }catch(failure){if(isCurrent())setError(errorMessage(failure));}
    finally{busyRef.current=false;if(isCurrent())setBusy(false);}
  }
  const inactive=busy||Boolean(attempt)||!initialized;
  return <section className="held-mail-panel" aria-label="保留中のメール応募">
    <header className="held-mail-heading"><div><h2 ref={heading} tabIndex={-1}>保留中のメール応募</h2><p>一覧は前回の保留理由です。応募を選ぶと、現在の状況を確認できます。</p></div><button className="ghost" onClick={onClose}>保留応募を閉じる</button></header>
    {demo&&<p className="held-mail-hint">デモの応募だけを表示しています。実際のメールや台帳へは送信しません。</p>}
    {message&&<p role="status" className="held-mail-success">{message}</p>}
    {error&&<p role="alert" className="held-mail-error">{error}</p>}
    {!initialized&&<button className="ghost" onClick={sync}>端末の確認記録を再読込</button>}
    {attempt?<div className="held-mail-recovery" aria-busy={busy}>
      <h3>前回の再照合を確認</h3><p>{attempt.action==="cancel"?"中止の確認が続いています。":"再照合の結果をまだ確認できていません。"}同じ内容で結果を確認します。</p>
      <dl><dt>受付ID</dt><dd>{attempt.request.receiptKey}</dd><dt>確認資料</dt><dd>{attempt.request.evidenceRecordId}</dd></dl>
      <div className="held-mail-actions"><button onClick={()=>void recover()} disabled={busy}>{busy?"結果を確認しています…":attempt.action==="cancel"?"同じ中止操作を再確認":"同じ再照合の結果を確認"}</button>
      {attempt.action==="review"&&<button className="ghost" disabled={busy} onClick={()=>void recover(true)}>未確定なら中止する</button>}</div>
      <p className="held-mail-hint">先に完了していた操作は、保存済みの結果を表示します。応募履歴を取り消す操作ではありません。</p>
    </div>:initialized&&<>
      <div className="held-mail-actions"><button className="ghost" disabled={inactive||listStatus==="loading"} onClick={()=>void loadList(pageCursor)}>保留一覧を更新</button>
        {pageCursor&&<button className="ghost" disabled={inactive||listStatus==="loading"} onClick={()=>void loadList()}>先頭へ戻る</button>}
        {nextCursor&&<button className="ghost" disabled={inactive||listStatus!=="ready"} onClick={()=>void loadList(nextCursor)}>次の25件</button>}</div>
      {listStatus==="loading"&&<p role="status">保留中の応募を読み込んでいます…</p>}
      {listStatus==="ready"&&items.length===0&&<p>保留中のメール応募はありません。</p>}
      <ul className="held-mail-list">{items.map(row=><li key={row.receiptKey}><div><strong>{row.workDate} · {row.sourceRecordId}</strong><p>固定ID：{row.fixedCaseId}</p>
        <ul>{row.reasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul></div>
        <button ref={node=>{if(node)listButtons.current.set(row.receiptKey,node);else listButtons.current.delete(row.receiptKey);}} className={selected===row.receiptKey?"active":"ghost"} disabled={inactive||listStatus!=="ready"} onClick={()=>void loadDetail(row.receiptKey)}>この応募を確認</button></li>)}</ul>
      {detailStatus==="loading"&&<p role="status">現在の本人対応と案件を確認しています…</p>}
      {detailStatus==="error"&&selected&&<button className="ghost" onClick={()=>void loadDetail(selected)}>この応募を再読込</button>}
      {detail&&detailStatus==="ready"&&<div className="held-mail-detail">
        <div className="held-mail-heading"><h3 ref={detailHeading} tabIndex={-1}>現在の照合内容</h3><button className="ghost" disabled={inactive} onClick={backToList}>一覧の対象へ戻る</button></div>
        <dl><dt>元の受信記録</dt><dd>{detail.sourceRecordId}</dd><dt>勤務日</dt><dd>{detail.workDate}</dd><dt>固定ID</dt><dd>{detail.fixedCaseId}</dd></dl>
        {!detail.hasApplicantIdentity&&<p className="held-mail-hint">返信に本人を識別する情報がありません。ここで氏名からスタッフを決めず、原本の確認を続けてください。</p>}
        {detail.route==="review"?<p>この応募は確認候補へ回収済みです。一覧を更新してください。</p>:<>
          <p className="held-mail-hint">{detail.current?.route==="review"?"現在の照合では、確認候補へ戻せます。":"現在も確認が必要です。再照合の記録を保存しても保留を続けます。"}</p>
          {detail.current?.intakeOwner==="legacy_mail"&&<p>現在の応募受付はメール側です。アプリでの担当確定はまだ行いません。</p>}
          <ul>{detail.current?.reasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul>
          <form onSubmit={event=>{event.preventDefault();void review();}}>
            <label>確認資料の識別子<input value={evidence} maxLength={160} onChange={event=>{setEvidence(event.target.value);setConfirmed(false);}} disabled={inactive}/></label>
            <label className="held-mail-confirm"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} disabled={inactive}/>元の返信・勤務日・固定IDと、表示中の確認内容を原本で照合しました</label>
            <button type="submit" disabled={inactive||!confirmed||!evidence.trim()}>照合した内容を記録する</button>
          </form>
        </>}
      </div>}
    </>}
  </section>;
}
