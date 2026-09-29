import { useEffect, useMemo, useRef, useState } from "react";
import type { ShiftImportPreview } from "./shift-import-preview";
const labels:Record<string,string>={open:"未手配",assigned:"手配済み",stopped:"募集停止",cancelled:"キャンセル",draft:"項目不足"};
const normalize=(value:string)=>value.normalize("NFKC").toLocaleLowerCase("ja-JP");
const pageSize=20;
export default function AdminShiftImportPreview({preview,demo}:{preview:ShiftImportPreview;demo:boolean}){
  const [query,setQuery]=useState(""),[status,setStatus]=useState(""),[page,setPage]=useState(0);
  const tableRef=useRef<HTMLDivElement>(null);
  const rows=preview.rows??preview.samples,complete=preview.complete??rows.length===preview.totalJobs;
  useEffect(()=>{setQuery("");setStatus("");setPage(0);},[preview]);
  const filtered=useMemo(()=>{const terms=normalize(query).trim().split(/\s+/).filter(Boolean);return rows.filter(row=>{const shortDate=row.workDate.replace(/^\d{4}-(\d{2})-(\d{2})$/,(_match,m,d)=>`${Number(m)}/${Number(d)}`);const text=normalize([row.workDate,shortDate,row.storeName,row.assignedStaffName,row.caseId,row.sheetName].join(" "));return (!status||row.status===status)&&terms.every(term=>text.includes(term));});},[rows,query,status]);
  const pages=Math.max(1,Math.ceil(filtered.length/pageSize)),current=Math.min(page,pages-1),start=current*pageSize,visible=filtered.slice(start,start+pageSize);
  useEffect(()=>{if(tableRef.current){tableRef.current.scrollTop=0;tableRef.current.scrollLeft=0;}},[current,query,status,preview]);
  return <section className="shift-preview-results" aria-label="シフト表の読取結果">
    <h3>{demo?"サンプルの表示確認（デモ）":"原本の読取プレビュー"}</h3>
    <p>{demo?"実際のシフト表を読み取った結果ではありません。":"原本の変更・アプリへの取込確定は行っていません。"}</p>
    <div className="preview-counts"><span>原本の案件 <strong>{preview.totalJobs}件</strong></span><span>{complete?"未手配":"取得範囲の未手配"} <strong>{rows.filter(row=>row.status==="open").length}件</strong></span><span>{complete?"全件読取済み":`${rows.length}件を取得`}</span></div>
    {!complete&&<p className="preview-partial" role="status">原本{preview.totalJobs}件のうち、取得できた{rows.length}件を表示しています。残りは参照元のシフト表で確認できます。</p>}
    {!demo&&preview.spreadsheetId&&<p><a href={"https://docs.google.com/spreadsheets/d/"+preview.spreadsheetId+"/edit"} target="_blank" rel="noreferrer">参照元のシフト表を開く ↗</a></p>}
    {preview.warnings.length>0&&<details className="preview-warnings" open={preview.totalJobs===0}><summary>読取時の確認事項（{preview.warnings.length}件）</summary><ul>{preview.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></details>}
    {rows.length>0&&<><div className="preview-filters"><label>日付・店舗・担当者<input aria-label="読取案件を検索" type="search" value={query} placeholder="例：10/11、店舗名、担当者名" onChange={event=>{setQuery(event.target.value);setPage(0);}}/></label><label>状態<select aria-label="読取案件の状態" value={status} onChange={event=>{setStatus(event.target.value);setPage(0);}}><option value="">すべて</option>{Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div><div className="preview-range" role="status" aria-live="polite">該当{filtered.length}件 / 原本{preview.totalJobs}件 · {filtered.length?start+1:0}〜{start+visible.length}件を表示</div></>}
    {pages>1&&<nav className="preview-pagination" aria-label="読取結果のページ切替"><button className="ghost" disabled={current===0} onClick={()=>setPage(0)}>先頭</button><button className="ghost" disabled={current===0} onClick={()=>setPage(current-1)}>前へ</button><span>{current+1} / {pages} ページ</span><button className="ghost" disabled={current===pages-1} onClick={()=>setPage(current+1)}>次へ</button><button className="ghost" disabled={current===pages-1} onClick={()=>setPage(pages-1)}>最後</button></nav>}
    {visible.length===0?<p>{rows.length?"条件に合う案件がありません。検索語や状態を変更してください。":"表示できる案件がありません。対象月と読取時の確認事項を確認してください。"}</p>:<div ref={tableRef} className="table-wrap" tabIndex={0} aria-label="読取案件一覧"><table><thead><tr><th>実施日</th><th>店舗</th><th>担当</th><th>状態</th><th>参照位置</th></tr></thead><tbody>{visible.map(job=><tr key={JSON.stringify([job.sheetName,job.row])}><td>{job.workDate}</td><td>{job.storeName||"未記入"}</td><td>{job.assignedStaffName||"未手配"}</td><td><span className={"mini-tag "+(job.status==="open"?"":"muted-tag")}>{labels[job.status]}</span></td><td>{job.sheetName}・{job.row}行</td></tr>)}</tbody></table></div>}
  </section>;
}
