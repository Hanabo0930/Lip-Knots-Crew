import SheetWriteReviewEntry from "./SheetWriteReviewEntry";
export type SheetWriteIssue = {
 id:string;jobId:string;operation:string;status:string;errorType:string;errorMessage:string;attempts:number;canRetry:boolean;
 writeVerificationRequired?:boolean;sourceWriteVerified?:false;acknowledgedAt?:string|null;acknowledgedNote?:string;
 desiredUpdates:Record<string,unknown>;beforeValues:Record<string,unknown>;
 job:null|{workDate:string;storeName:string;assignedStaffName:string;clientName:string};
};
type Props={sheetIssues:SheetWriteIssue[];issuesBusy:boolean;operationKeys:string[];loadSheetIssues:()=>Promise<void>;retrySheetIssue:(issue:SheetWriteIssue)=>Promise<void>;acknowledgeSheetIssue:(issue:SheetWriteIssue)=>Promise<void>};
function recordedTime(value?:string|null){
 const date=value?new Date(value):null;
 return date&&Number.isFinite(date.valueOf())?date.toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",hour12:false})+"（日本時間）":"日時の記録なし";
}
export default function AdminSheetIssuePanel({sheetIssues,issuesBusy,operationKeys,loadSheetIssues,retrySheetIssue,acknowledgeSheetIssue}:Props){return <section className="panel issue-panel" aria-label="シフト表の反映確認">
 <div className="sync-head"><div><h2>シフト表の反映確認</h2><p>確認メモを残しても、反映結果は未確認のままです。一時エラーだけ再試行できます。</p></div><strong>{sheetIssues.length}件を表示</strong></div>
 <div className="sync-actions"><button className="ghost" onClick={()=>void loadSheetIssues()} disabled={issuesBusy}>{issuesBusy?"読込中…":"再読込"}</button></div>
 <div className="issue-list">{sheetIssues.map(issue=>{
  const reviewed=issue.status==="acknowledged",busy=issuesBusy||operationKeys.includes("issue:"+issue.id);
  const retry=issue.canRetry&&!issue.writeVerificationRequired&&!reviewed&&["blocked","dead_letter","retry_wait"].includes(issue.status);
  return <article key={issue.id} className={"sheet-review-card "+(issue.errorType==="conflict"?"conflict-issue":"")}>
   <div className="sheet-review-summary">
    <strong>{issue.job?issue.job.workDate+" "+issue.job.storeName+" "+issue.job.assignedStaffName:"案件 "+issue.jobId}</strong>
    <p className="sheet-review-state">{reviewed?"確認メモあり・反映未確認":"反映結果の確認が必要"}</p>
    <p>{issue.errorMessage||"依頼の状態とシフト表を確認してください。"}</p>
    {issue.writeVerificationRequired&&<p className="sheet-review-help">手動での再試行はできません。原本と依頼の照合が必要です。</p>}
    {issue.status==="paused_global"&&<p className="sheet-review-help">運用設定によって処理が停止されています。</p>}
    {issue.status==="error"&&<p className="sheet-review-help">旧形式のエラー記録です。反映結果を推測して再試行しません。</p>}
    <details><summary>依頼の状態と確認メモ</summary><dl><dt>依頼番号</dt><dd>{issue.id}</dd><dt>処理</dt><dd>{issue.operation||"記録なし"}</dd><dt>保存された状態</dt><dd>{issue.status}</dd>
     {reviewed&&<><dt>メモの記録日時</dt><dd>{recordedTime(issue.acknowledgedAt)}</dd><dt>確認メモ</dt><dd className="sheet-review-note">{issue.acknowledgedNote||"メモの記録なし"}</dd></>}
    </dl></details>
   </div>
   <div className="row-actions">{retry&&<button className="ghost compact" disabled={busy} onClick={()=>void retrySheetIssue(issue)}>再試行</button>}
    <button className="ghost compact" disabled={busy||reviewed} onClick={()=>void acknowledgeSheetIssue(issue)}>{reviewed?"メモ記録済み":"確認メモを記録"}</button>
   </div>
  </article>;
 })}{!issuesBusy&&!sheetIssues.length&&<div className="empty-inline">表示できる確認対象はありません。</div>}</div>
 <p className="sheet-review-help">取得した範囲の確認対象です。記録がない旧依頼を含め、原本との全件照合が済んだことを示す一覧ではありません。</p>
 <SheetWriteReviewEntry/>
 </section>;
}

let demoSheetIssues:SheetWriteIssue[]=[
        {
          id:"issue_demo_conflict",
          jobId:"1",
          operation:"expense.review",
          status:"blocked",
          errorType:"conflict",
          errorMessage:"transportationはスプシ側で変更されています。現在値: 1,240",
          attempts:1,
          canRetry:false,
          desiredUpdates:{transportation:1500},
          beforeValues:{transportation:1240},
          job:{workDate:"7/15",storeName:"イオン津田沼",assignedStaffName:"Aさん",clientName:"〇〇デモ"},
        },
        {
          id:"issue_demo_system",
          jobId:"2",
          operation:"submission.report",
          status:"retry_wait",
          errorType:"system",
          errorMessage:"一時的なGoogle APIエラー",
          attempts:2,
          canRetry:true,
          desiredUpdates:{reportSubmitted:"提出済"},
          beforeValues:{reportSubmitted:""},
          job:{workDate:"7/15",storeName:"イオン船橋",assignedStaffName:"Bさん",clientName:"〇〇デモ"},
        },
      ];
export function getDemoSheetIssues(){return demoSheetIssues.filter(row=>row.status!=="pending").map(row=>({...row}));}
export function applyDemoSheetIssue(action:string,payload:Record<string,unknown>){
 if(action==="acknowledgeSheetWriteIssue")demoSheetIssues=demoSheetIssues.map(row=>row.id===payload.queueId?{...row,status:"acknowledged",canRetry:false,sourceWriteVerified:false,acknowledgedAt:new Date().toISOString(),acknowledgedNote:String(payload.note??"")}:row);
 if(action==="retrySheetWriteIssue")demoSheetIssues=demoSheetIssues.map(row=>row.id===payload.queueId&&row.canRetry?{...row,status:"pending",canRetry:false}:row);
 return getDemoSheetIssues();
}
