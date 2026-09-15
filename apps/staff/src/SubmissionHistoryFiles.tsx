import {useState} from "react";
import SubmissionPreviewImage, { type PreviewFile } from "./SubmissionPreviewImage";

type HistoryFile = PreviewFile & { purpose: string; status: string };
type Props = {
  files: HistoryFile[];
  hasMissingFiles?: boolean;
  onRefreshPreview: (file: PreviewFile) => Promise<string | null>;
};

export default function SubmissionHistoryFiles({ files, hasMissingFiles = false, onRefreshPreview }: Props) {
  const context=JSON.stringify(files[0]?[files[0].submissionId,files[0].id]:[]);
  const [view,setView]=useState({context,page:0});
  const page=Math.min(view.context===context?view.page:0,Math.max(0,Math.ceil(files.length/20)-1));
  return <>{files.length>20&&<nav className="shift-page-controls" aria-label="提出履歴のページ">
    <button type="button" className="secondary" disabled={!page} onClick={()=>setView({context,page:page-1})}>前の20件</button>
    <span role="status">{files.length}件中 {page*20+1}〜{Math.min((page+1)*20,files.length)}件</span>
    <button type="button" className="secondary" disabled={(page+1)*20>=files.length} onClick={()=>setView({context,page:page+1})}>次の20件</button>
  </nav>}<div className="history-grid">{hasMissingFiles && <div className="empty history-error" role="status">提出記録はありますが、一部のファイル情報を確認できません。「提出情報を再読み込み」で確認してください。</div>}{files.slice(page*20,page*20+20).map((file, index) => {
    const name = file.driveName?.trim() || file.originalName?.trim() || "ファイル名を確認できません";
    const completed = file.status === "completed";
    const label = completed ? "Drive保存済み"
      : file.status === "waiting_upload" ? "アップロード待ち"
      : file.status === "processing" ? "Drive転送中"
      : file.status === "paused_global" ? "転送一時停止"
      : file.status === "error" ? "転送エラー"
      : "状態の確認が必要です";
    return <article key={`${file.submissionId}_${file.id}`} aria-label={`提出履歴 ${page*20+index + 1}件目: ${name}`}>
      {completed ? <SubmissionPreviewImage file={file} onRefreshPreview={onRefreshPreview}/>
        : <div className="history-preview preview-placeholder"><span>{label}</span></div>}
      <strong>{name}</strong>
      <small>{file.purpose === "replacement" ? "再送・" : ""}{label}</small>
      {!completed && <small>「提出情報を再読み込み」で確認してください。状態が変わらない場合は管理者へ連絡してください。</small>}
    </article>;
  })}{!files.length && !hasMissingFiles && <div className="empty">提出履歴はありません。</div>}</div></>;
}
