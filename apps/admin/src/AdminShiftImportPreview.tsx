import type { ShiftImportPreview } from "./shift-import-preview";
const labels:Record<string,string>={open:"未手配",assigned:"手配済み",stopped:"募集停止",cancelled:"キャンセル",draft:"項目不足"};
export default function AdminShiftImportPreview({preview,demo}:{preview:ShiftImportPreview;demo:boolean}){
  return <section aria-label="シフト表の読取結果">
    <h3>{demo?"サンプルの表示確認（デモ）":"原本の読取プレビュー"}</h3>
    <p>{demo?"実際のシフト表を読み取った結果ではありません。":"原本の変更・アプリへの取込確定は行っていません。"} {preview.totalJobs}件中{preview.samples.length}件を表示{preview.totalJobs>preview.samples.length?"（先頭20件まで）":""}。</p>
    {!demo&&preview.spreadsheetId&&<p><a href={"https://docs.google.com/spreadsheets/d/"+preview.spreadsheetId+"/edit"} target="_blank" rel="noreferrer">参照元のシフト表を開く</a></p>}
    {preview.warnings.length>0&&<div role="status"><p>読取時の確認事項</p><ul>{preview.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></div>}
    {preview.samples.length===0?<p>表示できる案件がありません。対象月と取込設定を確認してください。</p>:<div className="table-wrap" tabIndex={0} aria-label="読取案件一覧"><table><thead><tr><th>実施日</th><th>店舗</th><th>担当</th><th>状態</th><th>参照位置</th></tr></thead><tbody>{preview.samples.map((job,index)=><tr key={job.sheetName+":"+job.row+":"+index}><td>{job.workDate}</td><td>{job.storeName||"未記入"}</td><td>{job.assignedStaffName||"未手配"}</td><td>{labels[job.status]}</td><td>{job.sheetName}・{job.row}行</td></tr>)}</tbody></table></div>}
  </section>;
}
