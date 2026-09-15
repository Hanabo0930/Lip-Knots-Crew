import {useEffect,useLayoutEffect,useRef,useState} from "react";
import {reviewPage,presenceLabels,statusLabels,type ReviewPage,type RecordedTime,type SheetReviewApi} from "./sheet-write-review";
const reasons:Record<string,string>={
  updated_at_missing:"更新日時の記録なし",updated_at_invalid:"更新日時の形式を確認",
  retry_at_missing:"次の処理日時の記録なし",retry_at_invalid:"次の処理日時の形式を確認",
  job_id_unavailable:"案件番号を確認できません",status_unavailable:"状態の記録を確認できません",
  write_verification_required:"書込結果の確認が必要",
};
function dateLabel(value:RecordedTime) {
  return value.state==="recorded"&&value.value
    ? new Date(value.value).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",hour12:false})+"（日本時間）"
    : value.state==="missing"?"記録なし":"形式を確認できません";
}
export default function SheetWriteReviewPanel({companyId,uid,api,demo=false,onClose}:{
  companyId:string;uid:string;api:SheetReviewApi;demo?:boolean;onClose:()=>void;
}) {
  const owner=JSON.stringify([companyId,uid]),ownerRef=useRef(owner);ownerRef.current=owner;
  const apiRef=useRef(api);apiRef.current=api;
  const active=useRef(false),version=useRef(0),busy=useRef(false);
  const heading=useRef<HTMLHeadingElement>(null),resultHeading=useRef<HTMLHeadingElement>(null),focus=useRef(false);
  const requested=useRef<{cursor?:string;number:number}>({number:1});
  const [state,setState]=useState<{owner:string;page:ReviewPage;number:number}|null>(null);
  const [loading,setLoading]=useState(false),[error,setError]=useState("");
  const visible=state?.owner===owner?state:null;
  const current=(ticket:number)=>active.current&&ownerRef.current===owner&&version.current===ticket;
  useLayoutEffect(()=>{if(visible&&focus.current){focus.current=false;resultHeading.current?.focus();}},[visible]);
  async function read(cursor?:string,number=1) {
    if(busy.current)return;
    busy.current=true;const ticket=++version.current;requested.current={cursor,number};
    setLoading(true);setState(null);setError("");
    try {
      const page=reviewPage(await apiRef.current.read(cursor),companyId,uid,cursor);
      if(!current(ticket))return;
      focus.current=true;setState({owner,page,number});
    } catch {
      if(current(ticket))setError("依頼を取得できませんでした。空の一覧とは判断していません。同じ範囲を再取得できます。");
    } finally {
      if(current(ticket)){busy.current=false;setLoading(false);}
    }
  }
  useEffect(()=>{
    active.current=true;setState(null);setError("");requested.current={number:1};heading.current?.focus();void read();
    return()=>{active.current=false;version.current++;busy.current=false;};
  },[owner]);
  return <section className="sheet-record-review" aria-label="旧依頼を含む保存記録">
    <div className="sync-head"><div><h3 ref={heading} tabIndex={-1}>旧依頼を含む保存記録</h3>
      <p>日時や状態がない依頼も、会社にひもづく記録から50件ずつ読み取ります。</p></div>
      <button className="ghost" onClick={onClose}>保存記録を閉じる</button></div>
    {demo&&<p className="sheet-review-help">合成データのデモです。実際の依頼には接続していません。</p>}
    <p className="sheet-review-help">保存記録の確認専用です。原本への反映結果は未確認です。ページをまたぐ間の追加・変更は反映されるため、全件が同じ時点の状態ではありません。</p>
    <div className="sync-actions"><button className="ghost" disabled={loading} onClick={()=>void read()}>先頭から再取得</button>
      {visible?.page.nextCursor&&<button disabled={loading} onClick={()=>void read(visible.page.nextCursor!,visible.number+1)}>次の50件を確認</button>}
    </div>
    {loading&&<p role="status">保存記録を取得しています…</p>}
    {error&&<div role="alert"><p>{error}</p><button onClick={()=>void read(requested.current.cursor,requested.current.number)}>同じ範囲を再取得</button></div>}
    {visible&&<div>
      <h4 ref={resultHeading} tabIndex={-1}>{visible.number}ページ目・{visible.page.records.length}件</h4>
      {!visible.page.records.length&&<p>この取得範囲に表示できる記録はありません。原本との全件照合が済んだことは示しません。</p>}
      <div className="issue-list">{visible.page.records.map(row=><article key={row.id} className="sheet-review-card">
        <div className="sheet-review-summary"><strong>{row.jobId?"案件 "+row.jobId:"案件番号の記録を確認できません"}</strong>
          <p className="sheet-review-state">{Object.hasOwn(statusLabels,row.status??"")?statusLabels[row.status!]:"状態の内容を確認"}・原本反映未確認</p>
          {row.reviewReasons.length>0&&<ul>{row.reviewReasons.map(reason=><li key={reason}>{Object.hasOwn(reasons,reason)?reasons[reason]:"記録の内容を確認"}</li>)}</ul>}
          <p className="sheet-review-help">更新日時：{dateLabel(row.updatedAt)}</p>
          <details><summary>保存された記録の詳細</summary><dl>
            <dt>依頼番号</dt><dd>{row.id}</dd><dt>保存された状態</dt><dd>{row.status??"確認できません"}</dd>
            <dt>処理の記録</dt><dd>{row.operation??"確認できません"}</dd>
            <dt>作成日時</dt><dd>{dateLabel(row.createdAt)}</dd><dt>次の処理日時</dt><dd>{dateLabel(row.retryAt)}</dd>
            <dt>実行者の記録</dt><dd>{presenceLabels[row.recordedEvidence.actor]}</dd>
            <dt>スタッフの記録</dt><dd>{presenceLabels[row.recordedEvidence.staff]}</dd>
            <dt>勤務日の記録</dt><dd>{presenceLabels[row.recordedEvidence.workDate]}</dd>
            <dt>操作番号の記録</dt><dd>{presenceLabels[row.recordedEvidence.operationKey]}</dd>
          </dl></details>
        </div>
      </article>)}</div>
      {visible.page.nextCursor&&<button disabled={loading} onClick={()=>void read(visible.page.nextCursor!,visible.number+1)}>次の50件へ進む</button>}
      <p className="sheet-review-help">{visible.page.nextCursor?"続きがあります。次の50件を取得して確認してください。":"今回の取得では続きはありません。"} 記録の有無だけで、本人・勤務日・操作の正しさを確定しません。</p>
    </div>}
  </section>;
}
