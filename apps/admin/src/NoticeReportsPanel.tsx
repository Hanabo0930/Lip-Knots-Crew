import {useEffect,useLayoutEffect,useRef,useState} from "react";
import {noticePage,noticeReasons,noticeStateLabels,noticeStatusLabels,type NoticePage} from "./notice-reports";
export type NoticeReportsApi={list:(jobId:string,cursor?:string)=>Promise<unknown>};
const time=(value:string)=>new Date(value).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",hour12:false});
export default function NoticeReportsPanel({companyId,uid,jobId,jobLabel,api,demo=false,onClose}:{companyId:string;uid:string;jobId:string;jobLabel:string;api:NoticeReportsApi;demo?:boolean;onClose:()=>void}){
 const owner=companyId+":"+uid+":"+jobId,ownerRef=useRef(owner);ownerRef.current=owner;
 const apiRef=useRef(api);apiRef.current=api;
 const mounted=useRef(false),version=useRef(0),busyRef=useRef(false),heading=useRef<HTMLHeadingElement>(null),resultHeading=useRef<HTMLHeadingElement>(null);
 const [page,setPage]=useState<NoticePage|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState("");
 const [starts,setStarts]=useState<(string|undefined)[]>([undefined]);
 const isCurrent=()=>mounted.current&&ownerRef.current===owner;
 const focusPending=useRef<{owner:string;ticket:number}|null>(null);
 useLayoutEffect(()=>{const pending=focusPending.current;if(page&&pending&&pending.owner===owner&&pending.ticket===version.current&&isCurrent()){focusPending.current=null;resultHeading.current?.focus();}},[page,owner]);
 async function load(target:(string|undefined)[],focus=false){
  if(busyRef.current)return;busyRef.current=true;const ticket=++version.current;setLoading(true);setPage(null);setError("");setStarts(target);
  try{const cursor=target.at(-1),result=noticePage(await apiRef.current.list(jobId,cursor),jobId,cursor);
   if(!isCurrent()||ticket!==version.current)return;focusPending.current=focus?{owner,ticket}:null;setPage(result);

  }catch(failure){if(isCurrent()&&ticket===version.current)setError(failure instanceof Error?failure.message:"連絡結果を取得できませんでした。もう一度お試しください。");}
  finally{if(isCurrent()&&ticket===version.current){busyRef.current=false;setLoading(false);}}
 }
 useEffect(()=>{mounted.current=true;heading.current?.focus();void load([undefined]);return()=>{mounted.current=false;version.current++;busyRef.current=false;};},[owner]);
 return <section className="campaign-panel notice-reports" aria-label="出発・入店の連絡結果">
  <header className="campaign-heading"><div><h2 ref={heading} tabIndex={-1}>出発・入店の連絡結果</h2><p>{jobLabel||jobId}</p></div><button className="ghost" onClick={onClose}>連絡結果を閉じる</button></header>
  {demo&&<p className="campaign-hint">デモの報告記録です。実際の連絡先や配信結果には接続しません。</p>}
  <p className="campaign-hint">外部から届いた配信報告と、現在の担当との一致を確認できます。メールの配信・到達や、本人の出発・入店は未確認です。</p>
  <div className="campaign-actions"><button disabled={loading} onClick={()=>void load(starts,true)}>{loading?"連絡結果を取得しています…":"このページを再取得"}</button>
   {starts.length>1&&<><button className="ghost" disabled={loading} onClick={()=>void load(starts.slice(0,-1),true)}>前のページ</button><button className="ghost" disabled={loading} onClick={()=>void load([undefined],true)}>先頭に戻る</button></>}</div>
  {loading&&<p role="status">{starts.length}ページ目を確認しています。</p>}
  {error&&<div className="campaign-error" role="alert"><p>{error}</p><p>対象案件と{starts.length}ページ目の位置を保持しています。「このページを再取得」で確認できます。</p></div>}
  {page&&<div className="notice-results">
   <h3 ref={resultHeading} tabIndex={-1}>連絡結果・{starts.length}ページ目</h3>
   <p className="notice-page-note">{page.reports.length}件を表示 · 時刻は日本時間</p>
   {page.reports.length===0?<p className="campaign-hint">{starts.length===1?"この案件の外部報告はまだ届いていません。":"このページに報告はありません。先頭から現在の記録を確認できます。"}</p>:
    <ul className="campaign-cases">{page.reports.map(row=><li key={row.operationKey}>
     <div className="notice-card-heading"><h4>{row.kind==="notice.departure"?"出発連絡":"入店連絡"}</h4><span className={"notice-status notice-status-"+row.reportedStatus}>報告：{noticeStatusLabels[row.reportedStatus]}</span></div>
     <p className={"notice-alignment notice-alignment-"+row.state}>{noticeStateLabels[row.state]}</p><p className="notice-reason">{noticeReasons[row.reason]}</p>
     <dl><dt>勤務日</dt><dd>{row.workDate}</dd><dt>外部の確認時刻</dt><dd>{time(row.observedAt)}</dd></dl>
     <details><summary>記録番号と受信時刻</summary><dl><dt>元の配信記録</dt><dd>{row.sourceRecordId}</dd><dt>配信操作</dt><dd>{row.operationId}</dd><dt>報告の連番</dt><dd>{row.sequence}</dd><dt>担当の対応版</dt><dd>{row.bindingRevision}</dd><dt>固定ID</dt><dd>{row.fixedCaseId}</dd><dt>アプリ受信時刻</dt><dd>{time(row.receivedAt)}</dd></dl></details>
    </li>)}</ul>}
   {page.nextCursor&&<button className="ghost" onClick={()=>void load([...starts,page.nextCursor!],true)}>次の25件</button>}
  </div>}
 </section>;
}
