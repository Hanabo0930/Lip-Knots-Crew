export type SheetWriteIssue = {
  id:string;
  jobId:string;
  operation:string;
  status:string;
  errorType:string;
  errorMessage:string;
  attempts:number;
  canRetry:boolean;
  desiredUpdates:Record<string,unknown>;
  beforeValues:Record<string,unknown>;
  job:null|{workDate:string;storeName:string;assignedStaffName:string;clientName:string};
};
type Props={sheetIssues:SheetWriteIssue[];issuesBusy:boolean;operationKeys:string[];loadSheetIssues:()=>Promise<void>;retrySheetIssue:(issue:SheetWriteIssue)=>Promise<void>;acknowledgeSheetIssue:(issue:SheetWriteIssue)=>Promise<void>};
export default function AdminSheetIssuePanel({sheetIssues,issuesBusy,operationKeys,loadSheetIssues,retrySheetIssue,acknowledgeSheetIssue}:Props){return (<section className="panel issue-panel">
        <div className="sync-head">
          <div>
            <h2>スプシ書込エラー・競合</h2>
            <p>手入力との競合は上書きせず止め、一時エラーだけ再試行できます。</p>
          </div>
          <strong>{sheetIssues.length}件</strong>
        </div>
        <div className="sync-actions">
          <button className="ghost" onClick={()=>loadSheetIssues()} disabled={issuesBusy}>
            {issuesBusy ? "読込中…" : "再読込"}
          </button>
        </div>
        <div className="issue-list">
          {sheetIssues.map((issue)=>(
            <article key={issue.id} className={issue.errorType==="conflict"?"conflict-issue":""}>
              <div>
                <strong>{issue.job?.workDate} {issue.job?.storeName} {issue.job?.assignedStaffName}</strong>
                <small>{issue.operation} / {issue.errorMessage}</small>
              </div>
              <div className="row-actions">
                {issue.canRetry && <button className="ghost compact" disabled={operationKeys.includes("issue:"+issue.id)} onClick={()=>retrySheetIssue(issue)}>再試行</button>}
                <button className="ghost compact" disabled={operationKeys.includes("issue:"+issue.id)} onClick={()=>acknowledgeSheetIssue(issue)}>確認済み</button>
              </div>
            </article>
          ))}
          {!sheetIssues.length && <div className="empty-inline">書込エラーはありません。</div>}
        </div>
      </section>);}
