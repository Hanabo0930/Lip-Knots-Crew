import { useEffect, useRef, useState } from "react";
import type { StaffPerformanceData } from "./App";
import {currentStaffPerformanceYearRange,validStaffPerformanceRange,type StaffPerformanceRange} from "./staff-performance-range";

export default function AdminStaffPerformancePanel({performance,onClose,busy=false,onRangeChange}:{performance:StaffPerformanceData;onClose:()=>void;busy?:boolean;onRangeChange?:(range:StaffPerformanceRange)=>void}) {
  const panelRef=useRef<HTMLElement>(null);
  useEffect(()=>{panelRef.current?.scrollIntoView({behavior:"smooth",block:"center"});},[performance]);
  const profile=performance?.profile,data=performance?.performance,totals=data?.totals;
  const [range,setRange]=useState<StaffPerformanceRange>(()=>({from:data?.from??currentStaffPerformanceYearRange().from,through:data?.through??currentStaffPerformanceYearRange().through}));
  const [rangeMessage,setRangeMessage]=useState("");
  useEffect(()=>{setRange({from:data?.from??currentStaffPerformanceYearRange().from,through:data?.through??currentStaffPerformanceYearRange().through});setRangeMessage("");},[profile?.id,data?.from,data?.through]);
  function submitRange(event:{preventDefault:()=>void}){
    event.preventDefault();if(busy||!onRangeChange)return;
    if(!validStaffPerformanceRange(range)){setRangeMessage("開始日と終了日を確認してください。実在する日付で、開始日を終了日以前にしてください。");return;}
    setRangeMessage("");onRangeChange({...range});
  }
  const count=(value:unknown)=>Number.isInteger(value)&&Number(value)>=0;
  const valid=profile&&typeof profile.displayName==="string"&&typeof profile.nearestStation==="string"&&typeof profile.rank==="string"&&Array.isArray(profile.areaLabels)&&profile.areaLabels.every(value=>typeof value==="string")&&totals&&
    [totals.assignedJobs,totals.implementedJobs,totals.scheduledJobs,totals.cancelledJobs,totals.preContactLate,totals.reportLate].every(count)&&
    [data.clients,data.makers,data.stores].every(items=>Array.isArray(items)&&items.every(item=>item&&typeof item.name==="string"&&count(item.count)))&&
    Array.isArray(data.recentJobs)&&data.recentJobs.every(job=>job&&[job.id,job.dateKey,job.clientName,job.storeName,job.makerName].every(value=>typeof value==="string")&&typeof job.cancelled==="boolean");
  const requestCount=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
  const requests=data?.requestHistory;
  const requestMetadataValid=requests?.basis==="caseId+staffId"&&typeof requests.complete==="boolean"&&
    requestCount(requests.knownUniqueRequests)&&requestCount(requests.duplicateRows)&&Array.isArray(requests.issues)&&requests.issues.every(issue=>typeof issue==="string");
  const requestCountConfirmed=requestMetadataValid&&requests.complete===true&&requestCount(requests.totalRequests)&&
    requests.totalRequests===requests.knownUniqueRequests&&requests.issues.length===0;
  if(!valid)return <section ref={panelRef} className="panel performance-panel" id="staff-performance"><p role="alert">実績を表示できません。閉じてから、もう一度実績を開いてください。</p><button className="ghost" onClick={onClose}>閉じる</button></section>;
  return (
        <section ref={panelRef} className="panel performance-panel" id="staff-performance">
          <div className="section-heading">
            <div>
              <h2>{performance.profile.displayName}さんの稼働実績</h2>
              {typeof data.from==="string"&&typeof data.through==="string"&&<p>集計期間：{data.from}〜{data.through}</p>}
              <p>{performance.profile.areaLabels.join("・")} / {performance.profile.nearestStation} / ランク {performance.profile.rank}</p>
            </div>
            <button className="ghost" onClick={onClose}>閉じる</button>
          </div>
          <form aria-label="実績の集計期間" onSubmit={submitRange}>
            <label>集計開始日<input type="date" value={range.from} required disabled={busy} onChange={event=>{setRange(current=>({...current,from:event.target.value}));setRangeMessage("");}}/></label>
            <label>集計終了日<input type="date" value={range.through} required disabled={busy} onChange={event=>{setRange(current=>({...current,through:event.target.value}));setRangeMessage("");}}/></label>
            <button type="button" className="secondary" disabled={busy} onClick={()=>{setRange(currentStaffPerformanceYearRange());setRangeMessage("");}}>今年の年間を選ぶ</button>
            <button type="submit" disabled={busy||!onRangeChange}>{busy?"集計中…":"この期間で集計"}</button>
            <p>変更した期間は「この期間で集計」を押すと反映されます。初回は日本時間の今年1月1日〜12月31日を集計します。</p>
            {rangeMessage&&<p role="alert">{rangeMessage}</p>}
          </form>
          <section aria-label="期間内の依頼履歴" className="performance-request-history">
            <h3>期間内の依頼数（取消含む）</h3>
            <p role="status"><strong>{requestCountConfirmed?`${requests!.totalRequests}件`:"集計未確定"}</strong></p>
            <p>表示中の集計期間について、同じ案件IDとスタッフIDの依頼を1件として数えます。取消になった依頼も含み、稼働・予定の件数とは区別します。</p>
            {!requestCountConfirmed&&<p>案件ID・スタッフID・勤務日の照合が完了していないか、依頼履歴を取得できていません。集計未確定を0件として扱わず、記録を確認してください。</p>}
            {requestMetadataValid&&<p>照合できた依頼：{requests!.knownUniqueRequests}件 / 重複検出：{requests!.duplicateRows}行{!requestCountConfirmed&&"（全体の依頼数は未確定）"}</p>}
          </section>
          <div className="performance-kpis">
            <article><small>稼働・予定</small><strong>{performance.performance.totals.assignedJobs}回</strong></article>
            <article><small>実施済み</small><strong>{performance.performance.totals.implementedJobs}回</strong></article>
            <article><small>今後予定</small><strong>{performance.performance.totals.scheduledJobs}回</strong></article>
            <article><small>キャンセル</small><strong>{performance.performance.totals.cancelledJobs}回</strong></article>
            <article><small>事前連絡遅延</small><strong>{performance.performance.totals.preContactLate}回</strong></article>
            <article><small>報告書遅延</small><strong>{performance.performance.totals.reportLate}回</strong></article>
          </div>
          <div className="performance-split">
            <div><h3>クライアント別</h3><div className="rank-list">{performance.performance.clients.slice(0,8).map((item)=><div key={item.name}><span>{item.name}</span><strong>{item.count}回</strong></div>)}</div></div>
            <div><h3>メーカー別</h3><div className="rank-list">{performance.performance.makers.slice(0,8).map((item)=><div key={item.name}><span>{item.name}</span><strong>{item.count}回</strong></div>)}</div></div>
            <div><h3>過去店舗</h3><div className="rank-list">{performance.performance.stores.slice(0,8).map((item)=><div key={item.name}><span>{item.name}</span><strong>{item.count}回</strong></div>)}</div></div>
          </div>
          <div className="mini-table-wrap">
            <table><thead><tr><th>日付</th><th>クライアント</th><th>店舗</th><th>メーカー</th><th>状態</th></tr></thead>
            <tbody>{performance.performance.recentJobs.slice(0,20).map((job)=><tr key={job.id}><td>{job.dateKey}</td><td>{job.clientName}</td><td>{job.storeName}</td><td>{job.makerName}</td><td>{job.cancelled?"キャンセル":"有効"}</td></tr>)}</tbody></table>
          </div>
        </section>
  );
}
