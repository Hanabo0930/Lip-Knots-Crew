import {useEffect,useRef,useState} from "react";

type Job={id:string;workDate:string;dateKey:string;clientName:string;makerName:string;menuName:string;
  storeName:string;workTime:string;storeAddress:string;basePay:number|null;status:string};
export type MailApplication={id:string;revision:number;state:"ready"|"assigned"|"needs_review";job:Job};
type Page={mode:"app"|"legacy_mail"|"not_configured";items:MailApplication[];nextCursor:string|null};
const isHash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
export function parseMailApplications(value:unknown):Page{
  const data=value as {ok?:unknown;mode?:unknown;items?:unknown;nextCursor?:unknown}|null;
  const invalid=()=>new Error("メール応募の一覧を確認できません。もう一度更新してください。");
  if(!data||data.ok!==true||!["app","legacy_mail","not_configured"].includes(String(data.mode))||
      !Array.isArray(data.items)||data.items.length>25||(data.nextCursor!==null&&!isHash(data.nextCursor)))throw invalid();
  const seen=new Set<string>();
  const items=data.items.map((raw:unknown)=>{
    const row=raw as MailApplication|null,job=row?.job;
    if(!row||!isHash(row.id)||seen.has(row.id)||!Number.isSafeInteger(row.revision)||row.revision<1||
        !["ready","assigned","needs_review"].includes(row.state)||!job)throw invalid();
    seen.add(row.id);
    for(const key of ["id","workDate","dateKey","clientName","makerName","menuName","storeName","workTime","storeAddress","status"] as const)
      if(typeof job[key]!=="string")throw invalid();
    if(!job.id||job.id.includes("/")||!/^\d{4}-\d{2}-\d{2}$/.test(job.dateKey)||
        (job.basePay!==null&&(typeof job.basePay!=="number"||!Number.isFinite(job.basePay))))throw invalid();
    return {id:row.id,revision:row.revision,state:row.state,job};
  });
  if(data.mode!=="app"&&(items.length||data.nextCursor!==null))throw invalid();
  return {mode:data.mode as Page["mode"],items,nextCursor:data.nextCursor as string|null};
}

export default function MailApplicationsPanel({load,onApply,onViewShift,onClose,busy,hasAttempt,feedback}:{
  load:(cursor?:string)=>Promise<unknown>;onApply:(item:MailApplication)=>Promise<boolean>;
  onViewShift:(jobId:string)=>void;onClose:()=>void;busy:boolean;hasAttempt:(jobId:string)=>boolean;feedback:string;
}){
  const [page,setPage]=useState<Page>({mode:"app",items:[],nextCursor:null});
  const [status,setStatus]=useState<"loading"|"ready"|"error">("loading");
  const [error,setError]=useState("");
  const [pending,setPending]=useState("");
  const [lastAttempt,setLastAttempt]=useState<string|null>(null);
  const [accepted,setAccepted]=useState(false);
  const [attemptFeedback,setAttemptFeedback]=useState("");
  useEffect(()=>{if(lastAttempt&&!pending&&feedback)setAttemptFeedback(feedback);},[lastAttempt,pending,feedback]);
  const heading=useRef<HTMLHeadingElement>(null),mounted=useRef(false),version=useRef(0),loading=useRef(false),applying=useRef(false);
  const loadRef=useRef(load);loadRef.current=load;
  async function refresh(append=false){
    if(loading.current||applying.current)return;
    const cursor=append?page.nextCursor:null;
    if(append&&!cursor)return;
    loading.current=true;const ticket=++version.current;
    setStatus("loading");setError("");
    try{
      const next=parseMailApplications(await loadRef.current(cursor??undefined));
      if(!mounted.current||ticket!==version.current)return;
      if(append&&next.nextCursor===cursor)throw new Error("一覧の続きが更新されています。先頭から更新してください。");
      setPage(next);
      heading.current?.focus();
      setStatus("ready");
    }catch(failure){if(mounted.current&&ticket===version.current){setError(failure instanceof Error?failure.message:"一覧を取得できませんでした。");setStatus("error");}}
    finally{if(ticket===version.current)loading.current=false;}
  }
  useEffect(()=>{
    mounted.current=true;heading.current?.focus();void refresh();
    return()=>{mounted.current=false;version.current++;loading.current=false;};
  },[]);
  async function apply(item:MailApplication){
    if(applying.current||busy||loading.current||status!=="ready")return;
    applying.current=true;setError("");
    setPending(item.id);setLastAttempt(item.job.id);setAccepted(false);setAttemptFeedback("");
    try{
      const ok=await onApply(item);
      if(mounted.current){setAccepted(ok);if(ok)setPage(current=>({...current,items:current.items.map(row=>row.job.id===item.job.id?{...row,state:"assigned"}:row)}));}
    }catch{if(mounted.current)setError("応募結果を確認できません。再確認するか、シフトで現在の状況を確認してください。");}
    finally{applying.current=false;if(mounted.current)setPending("");}
  }
  const disabled=busy||Boolean(pending);
  return <section className="mail-applications" aria-busy={disabled||status==="loading"} aria-label="メールからの応募">
    <div className="section-heading"><h3 ref={heading} tabIndex={-1}>メールからの応募</h3>
      <button className="secondary" onClick={onClose} disabled={disabled}>閉じる</button></div>
    <p>メールで申し込んだ案件を確認できます。内容を確認して応募を確定してください。</p>
    <div className="actions"><button className="secondary" onClick={()=>void refresh()} disabled={disabled||status==="loading"}>
      {status==="loading"?"確認中…":"メール応募を更新"}</button></div>
    {status==="loading"&&<p role="status">現在の応募状況を確認しています…</p>}
    {error&&<div className="empty" role="alert"><p>{error}</p><p>取得済みの表示だけでは確定できません。更新してから確認してください。</p></div>}
    {lastAttempt&&<div className="empty" role="status"><p>{accepted?"応募が確定しました。":pending?"応募結果を確認しています。":attemptFeedback||feedback||"応募結果を確認できません。再確認するか、シフトで現在の状況を確認してください。"}</p>
      <button className="secondary" disabled={disabled} onClick={()=>onViewShift(lastAttempt)}>シフトで応募結果を確認</button></div>}
    {status==="ready"&&page.mode==="not_configured"&&<p className="empty" role="status">メール応募の連携は準備中です。通常の募集案件から応募できます。</p>}
    {status==="ready"&&page.mode==="legacy_mail"&&<p className="empty" role="status">メールでの応募は、現在のメール窓口で受け付けています。アプリへの切替後にここから確認できます。</p>}
    {status==="ready"&&page.mode==="app"&&!page.items.length&&<p className="empty" role="status">確認待ちのメール応募はありません。</p>}
    <div className="grid">{page.items.map(item=>{
      const confirmed=accepted&&lastAttempt===item.job.id;
      return <article className="job" key={item.id} aria-label={item.job.dateKey+" "+(item.job.storeName||"店舗確認中")+"のメール応募"}>
        <span className="date">{item.job.dateKey}</span><h4>{item.job.storeName||"店舗確認中"}</h4>
        <p>{item.job.makerName||"メーカー確認中"} / {item.job.menuName||"業務確認中"}</p>
        <p>{item.job.workTime||"勤務時間は確認中"}</p>
        {item.job.storeAddress&&<p>{item.job.storeAddress}</p>}
        <strong aria-label="報酬">{item.job.basePay===null?"報酬は確認中":item.job.basePay.toLocaleString("ja-JP")+"円"}</strong>
        {item.state==="needs_review"?<p role="status">案件または本人情報が変更されています。管理者へ確認してください。</p>:
          item.state==="assigned"||confirmed?<><p role="status">アプリで手配済みです。シフトで現在の状況を確認してください。</p><button className="secondary" disabled={disabled} onClick={()=>onViewShift(item.job.id)}>シフトを確認</button></>:
          <><p>日付・店舗・勤務条件を確認してから確定してください。</p><button disabled={disabled||status!=="ready"} onClick={()=>void apply(item)}>
            {pending===item.id?"応募を確認中…":hasAttempt(item.job.id)?"前回の応募結果を再確認":"この内容で応募を確定"}</button></>}
      </article>;
    })}</div>
    {page.items.length>0&&<p className="mail-page-note">一度に25件まで表示します。「メール応募を更新」で先頭に戻れます。</p>}
    {page.nextCursor&&<button className="secondary" onClick={()=>void refresh(true)} disabled={disabled||status!=="ready"}>次の25件を確認</button>}
  </section>;
}
