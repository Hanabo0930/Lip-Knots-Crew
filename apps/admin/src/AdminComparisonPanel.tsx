import PdfFilePreview from "./PdfFilePreview";
import AdminImageViewer from "./AdminImageViewer";
import {useState} from "react";
import type {ResubmissionComparison} from "./App";
function ComparisonImage({file,label}:{file:ResubmissionComparison["source"];label:string}){
  const [failed,setFailed]=useState(false);
  if(!file)return <div className="pdf-preview">{label}なし</div>;
  if(file.contentType==="application/pdf")return <PdfFilePreview url={file.previewUrl} name={file.driveName||file.originalName||label}/>;
  if(!file.contentType.startsWith("image/"))return <div className="pdf-preview">{file.contentType.includes("pdf")?"PDF":"FILE"}</div>;
  if(!file.previewUrl||failed)return <div className="admin-preview-error" role="status"><p>画像を読み込めませんでした。閉じて「旧・新を比較」を開き直してください。</p></div>;
  return <><img src={file.previewUrl} alt={label} decoding="async" onError={()=>setFailed(true)}/><AdminImageViewer src={file.previewUrl} name={file.driveName||file.originalName||label}/></>;
}
export default function AdminComparisonPanel({comparison,closeComparison}:{comparison:ResubmissionComparison;closeComparison:()=>void}){
  const [view,setView]=useState({requestId:comparison.request.id,index:0});
  const index=Math.min(view.requestId===comparison.request.id?view.index:0,Math.max(0,comparison.replacements.length-1));
  const replacement=comparison.replacements[index];
  return <div className="comparison-panel">
    <div className="comparison-head"><div><h3>再送ファイルの比較</h3><small>{comparison.request.reasons.join(" / ")}</small>{comparison.request.note?.trim()&&<p>{comparison.request.note}</p>}</div><button className="ghost compact" onClick={closeComparison}>閉じる</button></div>
    {comparison.replacements.length>1&&<nav className="sync-actions" aria-label="再送ファイルの切替">
      <button className="ghost" disabled={!index} onClick={()=>setView({requestId:comparison.request.id,index:index-1})}>前のファイル</button>
      <span role="status">再送ファイル {index+1} / {comparison.replacements.length}件</span>
      <button className="ghost" disabled={index+1>=comparison.replacements.length} onClick={()=>setView({requestId:comparison.request.id,index:index+1})}>次のファイル</button>
    </nav>}
    <div className="comparison-grid">
      <figure><figcaption>元ファイル</figcaption>{comparison.request.scope==="submission"?<div className="pdf-preview">案件全体の再提出です。過去の提出は提出履歴で確認できます。</div>:<><ComparisonImage key={JSON.stringify([comparison.source?.submissionId,comparison.source?.id,comparison.source?.previewUrl])} file={comparison.source} label="元ファイル"/><small>{comparison.source?.driveName||comparison.source?.originalName||""}</small></>}</figure>
      <figure><figcaption>再送ファイル</figcaption>{replacement?<ComparisonImage key={JSON.stringify([replacement.submissionId,replacement.id,replacement.previewUrl])} file={replacement} label="再送ファイル"/>:<div className="pdf-preview">再送ファイルなし</div>}<small>{replacement?.driveName||replacement?.originalName||""}</small></figure>
    </div>
  </div>;
}