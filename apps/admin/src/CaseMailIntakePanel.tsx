import { useEffect, useRef, useState } from "react";
import { mailOwner, mailList, mailDetail, mailCreationResult, loadMailAttempt, reserveMailAttempt, clearMailAttempt,
  definiteMailRejection, mailStorageKey, type MailApi, type MailReceipt, type MailDetail, type MailCommand } from "./case-mail-review";
import "./case-mail-review.css";
import CaseMailTargetBinding from "./CaseMailTargetBinding";
const errorText = (value: unknown) => value instanceof Error ? value.message : "通信を確認できません。同じ操作の結果を確認してください。";
const statusText = (status: string) => ({ ready: "登録候補", review: "確認待ち", cancelled: "取消", linked: "登録済み" })[status] ?? "確認待ち";
const issueText = (issue: string) => ({ SOURCE_CHANGED: "受信後に内容が変更されています。", SOURCE_STRUCTURE_CHANGED: "候補の位置・人数枠が変わっています。追加・減枠を推測せず、原文と登録済み案件を確認してください。", SAME_DAY_STORE_REVIEW: "同日・同店の案件との確認が必要です。",
  SOURCE_REVIEW: "依頼内容または資料の確認が必要です。", CANDIDATE_REVIEW: "案件の入力内容を確認してください。",
  ATOMIC_INTAKE_LIMIT: "候補数が多いため確認が必要です。" })[issue] ?? issue;

export default function CaseMailIntakePanel({ companyId, uid, api, onClose, onCreated, onReviewJob, demo = false }:
  { companyId: string; uid: string; api: MailApi; onClose: () => void; onCreated: () => void; onReviewJob?: (jobId:string,action:"edit"|"cancel")=>void; demo?: boolean }) {
  const owner = mailOwner(companyId, uid), ownerRef = useRef(owner); ownerRef.current = owner;
  const apiRef = useRef(api); apiRef.current = api;
  const mounted = useRef(false), version = useRef(0), busyRef = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const [initialized, setInitialized] = useState(false), [attempt, setAttempt] = useState<MailCommand | null>(null);
  const [items, setItems] = useState<MailReceipt[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null), [pageCursor, setPageCursor] = useState<string>();
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [detail, setDetail] = useState<MailDetail | null>(null), [selected, setSelected] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [reviewNote,setReviewNote]=useState(""),[reviewConfirmed,setReviewConfirmed]=useState(false),[reviewUncertain,setReviewUncertain]=useState(false);
  useEffect(()=>{setReviewNote("");setReviewConfirmed(false);setReviewUncertain(false);},[detail,selected]);
  const [busy, setBusy] = useState(false), [rejected, setRejected] = useState(false);
  const isCurrent = () => mounted.current && ownerRef.current === owner;
  const candidate = detail?.candidates.find(item => item.candidateId === selected);
  function syncAttempt() {
    if (busyRef.current) return;
    try { const saved = loadMailAttempt(owner); setAttempt(current => JSON.stringify(current) === JSON.stringify(saved) ? current : saved); setInitialized(true); }
    catch (failure) { setError(errorText(failure)); setInitialized(false); }
  }
  useEffect(() => {
    mounted.current = true; heading.current?.focus(); syncAttempt();
    const storage = (event: StorageEvent) => { if (event.storageArea === localStorage && (event.key === null || event.key === mailStorageKey(owner))) syncAttempt(); };
    window.addEventListener("storage", storage); window.addEventListener("focus", syncAttempt);
    return () => { mounted.current = false; version.current++; window.removeEventListener("storage", storage); window.removeEventListener("focus", syncAttempt); };
  }, [owner]);
  async function loadList(cursor?: string) {
    const ticket = ++version.current; setLoading(true); setDetail(null); setConfirmed(false); setError(""); setSelected("");
    try {
      const value = mailList(await apiRef.current.list(cursor));
      if (!isCurrent() || ticket !== version.current) return;
      setItems(value.items); setNextCursor(value.nextCursor); setPageCursor(cursor); setLoading(false);
    } catch (failure) { if (isCurrent() && ticket === version.current) { setError(errorText(failure)); setLoading(false); setItems([]); } }
  }
  useEffect(() => {
    if (!initialized) return;
    if (attempt) { version.current++; setDetail(null); setConfirmed(false); setLoading(false); }
    else void loadList();
  }, [initialized, attempt]);
  async function read(receiptId: string) {
    if (busyRef.current || attempt) return;
    const ticket = ++version.current; setLoading(true); setDetail(null); setConfirmed(false); setError("");
    try {
      const value = mailDetail(await apiRef.current.read(receiptId), receiptId);
      if (!isCurrent() || ticket !== version.current) return;
      setDetail(value); setSelected(value.candidates[0]?.candidateId ?? ""); setLoading(false);
    } catch (failure) { if (isCurrent() && ticket === version.current) { setLoading(false); setError(errorText(failure)); } }
  }
  async function deliver(command: MailCommand) {
    const result = mailCreationResult(await apiRef.current.create(command));
    if (!isCurrent()) return;
    setMessage(result.replayed ? "保存済みの作成結果を確認しました。案件の現在の状態は案件一覧で確認できます。" :
      "下書きを作成しました。シフト表との照合後、案件一覧から募集を開始できます。");
    await clearMailAttempt(owner, command.mailIntake.operationId, isCurrent);
    if (!isCurrent()) return;
    setAttempt(loadMailAttempt(owner)); setRejected(false); onCreated();
  }
  async function submit(retry = false) {
    if (busyRef.current || !initialized || (!retry && (!detail || !candidate?.creatable || !confirmed))) return;
    busyRef.current = true; setBusy(true); setError(""); setRejected(false); setMessage("");
    try {
      if (retry) {
        const saved = loadMailAttempt(owner); if (!saved) throw Error("前回の操作記録を確認できません。画面を開き直してください。");
        setAttempt(saved); await deliver(saved);
      } else {
        const command: MailCommand = { mailIntake: { receiptId: detail!.receiptId, candidateId: candidate!.candidateId,
          expectedReceiptRevision: detail!.revision, expectedRevision: candidate!.revision, operationId: crypto.randomUUID() } };
        const saved = await reserveMailAttempt(owner, command, isCurrent);
        if (!saved || !isCurrent()) return;
        setAttempt(saved); setConfirmed(false);
        if (saved.mailIntake.operationId !== command.mailIntake.operationId) { setMessage("前回の案件作成の結果を先に確認してください。"); return; }
        await deliver(saved);
      }
    } catch (failure) {
      if (isCurrent()) { setError(errorText(failure)); setRejected(definiteMailRejection(failure)); }
    } finally { busyRef.current = false; if (isCurrent()) setBusy(false); }
  }
  async function confirmReview() {
    const review=candidate?.changeReview;
    if(busyRef.current||!detail||!candidate||!review?.canConfirm||!reviewConfirmed||!reviewNote.trim()||reviewUncertain||!apiRef.current.confirm)return;
    busyRef.current=true;setBusy(true);setError("");const receiptId=detail.receiptId;
    try {
      const result=await apiRef.current.confirm({receiptId,candidateId:candidate.candidateId,jobId:review.jobId,reviewVersion:review.reviewVersion,note:reviewNote.trim(),confirmed:true}) as {ok?:boolean;resolved?:boolean;jobId?:string};
      if(!isCurrent())return;
      if(result?.ok!==true||result.resolved!==true||result.jobId!==review.jobId)throw Error("確認結果を取得できません。受信内容を再読込してください。");
      setReviewUncertain(true);setReviewConfirmed(false);setMessage("受信内容の確認を記録しました。募集は停止したままです。必要な場合は案件一覧から募集内容を再確認してください。");onCreated();
    } catch(failure){if(isCurrent()){setReviewUncertain(true);setReviewConfirmed(false);setError(errorText(failure)+" 受信内容を再読込し、保存結果を確認してください。");}}
    finally{busyRef.current=false;if(isCurrent())setBusy(false);}
  }
  async function backToLatest() {
    if (!attempt || busyRef.current || !rejected) return;
    busyRef.current = true; setBusy(true);
    try { await clearMailAttempt(owner, attempt.mailIntake.operationId, isCurrent); if (isCurrent()) { setAttempt(loadMailAttempt(owner)); setRejected(false); } }
    catch (failure) { if (isCurrent()) setError(errorText(failure)); }
    finally { busyRef.current = false; if (isCurrent()) setBusy(false); }
  }
  return <section className="mail-intake" aria-labelledby="mail-intake-heading">
    <div className="section-heading"><h3 id="mail-intake-heading" ref={heading} tabIndex={-1}>受信した案件候補</h3>
      <button className="ghost" onClick={onClose}>受信候補を閉じる</button></div>
    {demo && <p className="locked-note">デモではメール受信・案件作成を行いません。</p>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {!initialized && <button onClick={syncAttempt}>保存記録を再確認</button>}
    {attempt ? <div className="locked-note">
      <p>前回の案件作成の結果を確認します。同じ操作として照合するため、案件は増えません。</p>
      <button disabled={busy} onClick={() => void submit(true)}>{busy ? "結果を確認しています…" : "同じ案件作成の結果を確認"}</button>
      {rejected && <button className="ghost" disabled={busy} onClick={() => void backToLatest()}>最新内容に戻る</button>}
    </div> : initialized && <>
      <div className="sync-actions">
        <button className="ghost" disabled={loading || busy} onClick={() => void loadList()}>受信一覧を更新</button>
        {pageCursor && <button className="ghost" disabled={loading} onClick={() => void loadList()}>先頭へ戻る</button>}
        {nextCursor && <button className="ghost" disabled={loading} onClick={() => void loadList(nextCursor)}>次の25件</button>}
      </div>
      {loading && <p role="status">候補を確認しています…</p>}
      {!loading && !items.length && !error && <p>受信した案件候補はありません。</p>}
      <ul className="mail-receipts">{items.map(item => <li key={item.receiptId}>
        <span>{item.receivedAt ? new Date(item.receivedAt).toLocaleString("ja-JP") : "受信日時未記録"} ／ {item.candidateCount}名分 ／ {statusText(item.status)}</span>
        <button className="ghost" disabled={loading || busy} onClick={() => void read(item.receiptId)}>内容を確認</button>
      </li>)}</ul>
      {detail && <div className="mail-detail">
        <h4>登録する内容の確認</h4>
        {detail.issues.length > 0 && <ul>{detail.issues.map((issue, index) => <li key={index}>{issueText(issue)}</li>)}</ul>}
        {!detail.creationEnabled && <p className="locked-note">受信案件の登録はまだ有効になっていません。</p>}
        {!detail.producerReady && <p className="locked-note">受信処理の登録状態を確認してください。</p>}
        {detail.candidates.length > 0 && <label>候補を選択<select value={selected} disabled={busy}
          onChange={event => { setSelected(event.target.value); setConfirmed(false); }}>
          {detail.candidates.map((item, index) => <option key={item.candidateId} value={item.candidateId}>
            {index + 1}. {item.input.workDate} {item.input.storeName}（{statusText(item.status)}）</option>)}
        </select></label>}
        {candidate && <>
          <dl className="mail-values">{[
            ["実施日", candidate.input.workDate], ["クライアント", candidate.input.clientName], ["店舗", candidate.input.storeName],
            ["メーカー", candidate.input.makerName], ["メニュー", candidate.input.menuName], ["入店時間", candidate.input.entryTime],
            ["実施時間", candidate.input.workTime], ["人数", "1名"], ["依頼元資料", candidate.source.partId.startsWith("body:") || candidate.source.partId === "body" ? "メール本文" : "添付資料"],
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "未記載"}</dd></div>)}</dl>
          {candidate.targetCandidates && <section aria-label="対応先の案件候補" className="locked-note">
            <h4>対応先の案件候補（未確定）</h4>
            <p>同じ日付・店舗の案件を表示しています。対象と一致する保証はありません。日付・店舗が変わった案件は表示されません。対象案件との対応は、原文と照合してから確定してください。</p>
            {candidate.targetCandidates.state === "insufficient" && <p>日付・店舗を確認できないか対象期間外のため、候補を検索できません。</p>}
            {candidate.targetCandidates.state === "limited" && <p>検索・表示の上限に達しました。候補をすべて確認できていません。</p>}
            {candidate.targetCandidates.state === "complete" && !candidate.targetCandidates.items.length && <p>同じ日付・店舗の候補はありません。対象案件が存在しないことを意味するものではありません。</p>}
            {candidate.targetCandidates.items.map(item => <dl className="mail-values" key={item.jobId}>{[
              ["案件ID",item.jobId],["実施日",item.workDate],["店舗",item.storeName],["クライアント",item.clientName],["メーカー",item.makerName],["メニュー",item.menuName],["入店時間",item.entryTime],["実施時間",item.workTime],["取消状態",item.cancelled ? "取消済み" : "取消なし"],
            ].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value || "未記載"}</dd></div>)}</dl>)}
          </section>}
          {(candidate.targetCandidates || candidate.targetBinding) && api.previewTarget && api.confirmTarget && <CaseMailTargetBinding key={candidate.candidateId} receiptId={detail.receiptId} candidate={candidate} api={api} onBusy={value=>{busyRef.current=value;setBusy(value);}} onReviewJob={onReviewJob}/>}
          {candidate.changeReview && <div className="locked-note">
            <h4>登録済み案件の変更・取消確認</h4>
            <p>変更後の原文を確認し、必要な編集・取消を既存画面で行ってください。原本への反映と再取込後、ここを再読込します。</p>
            <p>現在：{candidate.changeReview.current.workDate} ／ {candidate.changeReview.current.storeName} ／ {candidate.changeReview.current.assignedStaffName || "担当なし"} ／ {candidate.changeReview.current.cancelled ? "取消済み" : "取消なし"}</p>
            <dl className="mail-values">{[["現在の依頼元",candidate.changeReview.current.clientName],["メーカー",candidate.changeReview.current.makerName],["メニュー",candidate.changeReview.current.menuName],["入店時間",candidate.changeReview.current.entryTime],["実施時間",candidate.changeReview.current.workTime],["取消時の金銭扱い",({invoice_and_pay:"請求・支払あり",invoice_only:"請求のみ",pay_only:"支払のみ",neither:"請求・支払なし"} as Record<string,string>)[candidate.changeReview.current.cancellationFinancialTreatment]||"未設定"]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||"未記載"}</dd></div>)}</dl>
            {candidate.changeReview.proposed ? <dl className="mail-values">{[
              ["変更後の日付",candidate.changeReview.proposed.workDate],["依頼元",candidate.changeReview.proposed.clientName],["店舗",candidate.changeReview.proposed.storeName],
              ["メーカー",candidate.changeReview.proposed.makerName],["メニュー",candidate.changeReview.proposed.menuName],["入店時間",candidate.changeReview.proposed.entryTime],["実施時間",candidate.changeReview.proposed.workTime],
            ].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||"未記載"}</dd></div>)}</dl> : <p>変更後の内容を自動照合できません。取消・減枠を推測せず、原文を確認してください。</p>}
            <div className="sync-actions">{onReviewJob&&<><button className="ghost" disabled={busy} onClick={()=>onReviewJob(candidate.changeReview!.jobId,"edit")}>案件を編集</button><button className="ghost" disabled={busy} onClick={()=>onReviewJob(candidate.changeReview!.jobId,"cancel")}>取消を確認</button></>}
              <button className="ghost" disabled={busy||loading} onClick={()=>void read(detail.receiptId)}>受信内容を再読込</button></div>
            {candidate.changeReview.resolved ? <p role="status">この受信変更は確認済みです。募集の再開は別途確認してください。</p> : <>
              {candidate.changeReview.issue&&<p role="status">{candidate.changeReview.issue}</p>}
              <label>変更・取消の確認メモ<textarea aria-label="変更・取消の確認メモ" value={reviewNote} maxLength={1000} disabled={busy||reviewUncertain} onChange={event=>setReviewNote(event.target.value)}/></label>
              <label className="check-line"><input type="checkbox" checked={reviewConfirmed} disabled={busy||reviewUncertain||!candidate.changeReview.canConfirm} onChange={event=>setReviewConfirmed(event.target.checked)}/>原文と現在の案件内容・担当・取消の扱いを確認しました。</label>
              <button disabled={busy||reviewUncertain||!candidate.changeReview.canConfirm||!reviewConfirmed||!reviewNote.trim()||!api.confirm} onClick={()=>void confirmReview()}>受信確認を完了</button>
            </>}
          </div>}
          {candidate.creatable ? <>
            <label className="check-line"><input type="checkbox" checked={confirmed} disabled={busy}
              onChange={event => setConfirmed(event.target.checked)}/>内容を確認しました。1名分の下書きを作成します。</label>
            <button disabled={!confirmed || busy} onClick={() => void submit()}>確認した候補を下書き作成</button>
          </> : <p className="locked-note">{candidate.status === "linked" ? "この候補は登録済みです。案件一覧で確認できます。" :
            "この候補は確認待ちです。ここから案件を作成することはできません。"}</p>}
        </>}
      </div>}
    </>}
  </section>;
}
