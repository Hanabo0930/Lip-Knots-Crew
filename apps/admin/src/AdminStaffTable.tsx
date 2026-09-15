import {useEffect,useRef,useState} from "react";
import type {StaffProfile} from "./App";
type Props={query?:string;profiles:StaffProfile[];performanceBusy:boolean;operationKeys:string[];onPerformance:(profile:StaffProfile,range:{from:string;through:string})=>void;onDevices:(profile:StaffProfile)=>void;onRevoke:(profile:StaffProfile)=>void};
export function staffListPage<T>(profiles:T[],requested:number){
  const pageCount=Math.max(1,Math.ceil(profiles.length/100));
  const page=Math.max(0,Math.min(Math.trunc(requested)||0,pageCount-1));
  return {page,pageCount,rows:profiles.slice(page*100,(page+1)*100)};
}
export default function AdminStaffTable({query="",profiles,performanceBusy,operationKeys,onPerformance,onDevices,onRevoke}:Props){
  const [requestedPage,setPage]=useState(0);
  useEffect(()=>setPage(0),[query]);
  const [from,setFrom]=useState("2025-10-01"),[through,setThrough]=useState("2099-12-31");
  const validDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  const validPeriod=validDate(from)&&validDate(through)&&from<=through;
  const {page,pageCount,rows}=staffListPage(profiles,requestedPage);
  const tableRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(tableRef.current)tableRef.current.scrollLeft=0;},[page]);
  return (<div className="staff-directory">
    <div className="toolbar"><label>実績の開始日<input type="date" value={from} max={through} disabled={performanceBusy} onChange={event=>setFrom(event.target.value)}/></label><label>実績の終了日<input type="date" value={through} min={from} disabled={performanceBusy} onChange={event=>setThrough(event.target.value)}/></label><small>期間を指定して、スタッフの「実績」を開いてください。</small></div>
    {!validPeriod&&<p role="alert">開始日と終了日を正しく指定してください。</p>}
    <nav className="toolbar" aria-label="スタッフ一覧のページ">
      <button className="ghost" disabled={page===0} onClick={()=>setPage(page-1)}>前の100名</button>
      <p role="status">読込済み{profiles.length}名のうち{profiles.length?page*100+1:0}〜{Math.min((page+1)*100,profiles.length)}名（{page+1}/{pageCount}ページ）</p>
      <button className="ghost" disabled={page+1>=pageCount} onClick={()=>setPage(page+1)}>次の100名</button>
    </nav>
    {!profiles.length&&<p>表示できるスタッフがいません。検索条件とスタッフ名簿の読込状況を確認してください。</p>}
        <div className="table-wrap" ref={tableRef} role="region" aria-label="スタッフ名簿（横スクロール）" tabIndex={0}>
          <table>
            <thead>
              <tr><th>スタッフ</th><th>エリア</th><th>メール</th><th>最寄り駅</th><th>ランク</th><th>状態</th><th>管理</th></tr>
            </thead>
            <tbody>
              {rows.map((profile) => (
                <tr key={profile.id} className={profile.active === false ? "cancelled" : ""}>
                  <td>{profile.displayName}</td>
                  <td>{(profile.areaLabels ?? []).join("・")}</td>
                  <td>
                    {(profile.emails ?? []).length}件
                    {(profile.emails ?? []).length > 1 && <span className="mini-tag">複数</span>}
                    {!!profile.emailConflicts?.length && <span className="mini-tag danger-tag">競合</span>}
                  </td>
                  <td>{profile.nearestStation ?? ""}</td>
                  <td>{profile.rank ?? "A"}</td>
                  <td>{profile.active === false ? "利用停止" : "利用可能"}</td>
                  <td className="row-actions">
                    <button className="ghost compact" onClick={() => onPerformance(profile,{from,through})} disabled={performanceBusy||!validPeriod}>実績</button>
                    <button className="ghost compact" onClick={() => onDevices(profile)}>端末</button>
                    <button className="danger compact" disabled={operationKeys.includes("devices:"+profile.id)} onClick={() => onRevoke(profile)}>全ログアウト</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
</div>); }
