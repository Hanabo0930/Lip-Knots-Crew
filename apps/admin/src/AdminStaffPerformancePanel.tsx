import { useEffect, useRef } from "react";
import type { StaffPerformanceData } from "./App";

export default function AdminStaffPerformancePanel({performance,onClose}:{performance:StaffPerformanceData;onClose:()=>void}) {
  const panelRef=useRef<HTMLElement>(null);
  useEffect(()=>{panelRef.current?.scrollIntoView({behavior:"smooth",block:"center"});},[performance]);
  const profile=performance?.profile,data=performance?.performance,totals=data?.totals;
  const count=(value:unknown)=>Number.isInteger(value)&&Number(value)>=0;
  const valid=profile&&typeof profile.displayName==="string"&&typeof profile.nearestStation==="string"&&typeof profile.rank==="string"&&Array.isArray(profile.areaLabels)&&profile.areaLabels.every(value=>typeof value==="string")&&totals&&
    [totals.assignedJobs,totals.implementedJobs,totals.scheduledJobs,totals.cancelledJobs,totals.preContactLate,totals.reportLate].every(count)&&
    [data.clients,data.makers,data.stores].every(items=>Array.isArray(items)&&items.every(item=>item&&typeof item.name==="string"&&count(item.count)))&&
    Array.isArray(data.recentJobs)&&data.recentJobs.every(job=>job&&[job.id,job.dateKey,job.clientName,job.storeName,job.makerName].every(value=>typeof value==="string")&&typeof job.cancelled==="boolean");
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
