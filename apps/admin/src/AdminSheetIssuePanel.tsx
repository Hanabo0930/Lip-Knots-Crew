import ManualSourceTransferReview from "./ManualSourceTransferReview";
import type {ManualSourceTransferConfirmation} from "./manual-source-transfer";
import SheetWriteReviewEntry from "./SheetWriteReviewEntry";
export type SheetWriteIssue = {
 id:string;jobId:string;operation:string;status:string;errorType:string;errorMessage:string;attempts:number;canRetry:boolean;
 canReconcile?:boolean;writeVerificationRequired?:boolean;sourceWriteVerified?:false;acknowledgedAt?:string|null;acknowledgedNote?:string;
 manualSourceStaffName?:string;manualCanonicalStaffName?:string;
 manualSourcePending?:boolean;manualObservationHash?:string|null;manualExpectedJobRevision?:number|null;manualExpectedSourceRevision?:string|null;
 suggestedPayOffer?:{dailyWageJPY:number;travelExpenses:"全額支給";communicationExpenses:"全額支給"}|null;
 manualTransferPending?:boolean;canSelectMonthlyTransfer?:boolean;manualTransferReviewKey?:string|null;
 desiredUpdates:Record<string,unknown>;beforeValues:Record<string,unknown>;
 job:null|{workDate:string;storeName:string;assignedStaffName:string;clientName:string;makerName?:string;menuName?:string;entryTime?:string;workTime?:string};
};
type Props={sheetIssues:SheetWriteIssue[];issuesBusy:boolean;operationKeys:string[];loadSheetIssues:()=>Promise<void>;retrySheetIssue:(issue:SheetWriteIssue)=>Promise<void>;acknowledgeSheetIssue:(issue:SheetWriteIssue)=>Promise<void>;selectMonthlyTransfer:(issue:SheetWriteIssue,manualConfirmation?:ManualSourceTransferConfirmation)=>Promise<void>;manualNextCursor?:string|null;loadMoreManualIssues?:()=>Promise<void>};
function recordedTime(value?:string|null){
 const date=value?new Date(value):null;
 return date&&Number.isFinite(date.valueOf())?date.toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",hour12:false})+"（日本時間）":"日時の記録なし";
}
export default function AdminSheetIssuePanel({sheetIssues,issuesBusy,operationKeys,loadSheetIssues,retrySheetIssue,acknowledgeSheetIssue,selectMonthlyTransfer,manualNextCursor,loadMoreManualIssues}:Props){return <section className="panel issue-panel" aria-label="シフト表の反映確認">
 <div className="sync-head"><div><h2>シフト表の反映確認</h2><p>確認メモを残しても、反映結果は未確認のままです。一時エラーだけ再試行できます。</p></div><strong>{sheetIssues.length}件を表示</strong></div>
 <div className="sync-actions"><button className="ghost" onClick={()=>void loadSheetIssues()} disabled={issuesBusy}>{issuesBusy?"読込中…":"再読込"}</button></div>
 <div className="issue-list">{sheetIssues.map(issue=>{
  const reviewed=issue.status==="acknowledged",busy=issuesBusy||operationKeys.includes("issue:"+issue.id);
  const manualSource=issue.operation==="case_list.manual",caseList=issue.operation==="case_list.assign"||manualSource;
  const retry=!caseList&&issue.canRetry&&!issue.writeVerificationRequired&&!reviewed&&["blocked","dead_letter","retry_wait"].includes(issue.status);
  return <article key={issue.id} className={"sheet-review-card "+(issue.errorType==="conflict"?"conflict-issue":"")+(manualSource?" manual-source-transfer-card":"")}>
   <div className="sheet-review-summary">
    <strong>{issue.job?issue.job.workDate+" "+issue.job.storeName+" "+issue.job.assignedStaffName:"案件 "+issue.jobId}</strong>
    <p className="sheet-review-state">{issue.manualTransferPending?"新規手配・ネームアップ後の移行選択待ち":reviewed?"確認メモあり・反映未確認":"反映結果の確認が必要"}</p>
    <p>{issue.errorMessage||"依頼の状態とシフト表を確認してください。"}</p>
    {caseList&&!issue.manualTransferPending&&<p className="sheet-review-help">原本を読み取って保存結果を照合します。再書込は行いません。月別への保存が未完了の場合は保留を続けます。</p>}
    {issue.manualTransferPending&&<p className="sheet-review-help">担当名の入力だけではシフト表へ移行しません。クライアントへのネームアップ後、日付・店舗・担当者を確認し、移行する案件だけ個別に選択してください。</p>}
    {issue.writeVerificationRequired&&!caseList&&<p className="sheet-review-help">手動での再試行はできません。原本と依頼の照合が必要です。</p>}
    {issue.status==="paused_global"&&<p className="sheet-review-help">運用設定によって処理が停止されています。</p>}
    {issue.status==="error"&&<p className="sheet-review-help">旧形式のエラー記録です。反映結果を推測して再試行しません。</p>}
    <details><summary>依頼の状態と確認メモ</summary><dl><dt>依頼番号</dt><dd>{issue.id}</dd><dt>処理</dt><dd>{issue.operation||"記録なし"}</dd><dt>保存された状態</dt><dd>{issue.status}</dd>
     {reviewed&&<><dt>メモの記録日時</dt><dd>{recordedTime(issue.acknowledgedAt)}</dd><dt>確認メモ</dt><dd className="sheet-review-note">{issue.acknowledgedNote||"メモの記録なし"}</dd></>}
    </dl></details>
   </div>
   <div className="row-actions">{retry&&<button className="ghost compact" disabled={busy} onClick={()=>void retrySheetIssue(issue)}>再試行</button>}
    {!manualSource&&issue.manualTransferPending&&issue.canSelectMonthlyTransfer&&<button className="compact" disabled={busy} onClick={()=>void selectMonthlyTransfer(issue)}>この案件を選択してシフト表へ移行</button>}
    {!manualSource&&!issue.manualTransferPending&&<button className="ghost compact" disabled={busy||reviewed&&!caseList} onClick={()=>void acknowledgeSheetIssue(issue)}>{caseList?"保存結果を再照合":reviewed?"メモ記録済み":"確認メモを記録"}</button>}
   </div>
   {manualSource&&<ManualSourceTransferReview key={[issue.id,issue.manualObservationHash,issue.manualExpectedJobRevision,issue.manualExpectedSourceRevision].join(":")} issue={issue} busy={busy} onSelect={confirmation=>void selectMonthlyTransfer(issue,confirmation)}/>}
  </article>;
 })}{!issuesBusy&&!sheetIssues.length&&<div className="empty-inline">表示できる確認対象はありません。</div>}</div>
 {manualNextCursor&&loadMoreManualIssues&&<button className="ghost" disabled={issuesBusy} onClick={()=>void loadMoreManualIssues()}>シート手入力の確認対象を続きを読み込む</button>}
 <p className="sheet-review-help">取得した範囲の確認対象です。記録がない旧依頼を含め、原本との全件照合が済んだことを示す一覧ではありません。</p>
 <SheetWriteReviewEntry/>
 </section>;
}

let demoSheetIssues:SheetWriteIssue[]=[
        {id:"issue_demo_manual_transfer",jobId:"demo-case-list",operation:"case_list.assign",status:"blocked",errorType:"owner_transfer_required",errorMessage:"担当名を案件リストへ反映しました。ネームアップ後、対象を選択して移行してください。",attempts:0,canRetry:false,manualTransferPending:true,canSelectMonthlyTransfer:true,manualTransferReviewKey:"a".repeat(64),desiredUpdates:{},beforeValues:{},job:{workDate:"2026/11/10",storeName:"サンプル店舗",assignedStaffName:"合成スタッフ",clientName:"デモクライアント"}},
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
 if(action==="acknowledgeSheetWriteIssue"&&payload.action==="select-case-list-monthly")demoSheetIssues=demoSheetIssues.map(row=>row.id===payload.queueId&&row.manualTransferPending&&payload.clientNameUpConfirmed===true?{...row,status:"pending",manualTransferPending:false,canSelectMonthlyTransfer:false}:row);
 else if(action==="acknowledgeSheetWriteIssue")demoSheetIssues=demoSheetIssues.map(row=>row.id===payload.queueId&&!row.manualTransferPending?{...row,status:"acknowledged",canRetry:false,sourceWriteVerified:false,acknowledgedAt:new Date().toISOString(),acknowledgedNote:String(payload.note??"")}:row);
 if(action==="retrySheetWriteIssue")demoSheetIssues=demoSheetIssues.map(row=>row.id===payload.queueId&&row.canRetry?{...row,status:"pending",canRetry:false}:row);
 return getDemoSheetIssues();
}
