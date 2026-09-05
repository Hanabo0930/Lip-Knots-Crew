import AdminSubmissionPreview from "./AdminSubmissionPreview";
import {submissionStatusLabel} from "./job-search";
import type {SubmissionFile,SubmissionGroup} from "./App";
type Props={resubmitType:"report"|"sales_floor";timelineReady:boolean;timelineBusy:boolean;timelineStatus:"idle"|"loading"|"ready"|"error";submissionTimeline:SubmissionGroup[];selectedSourceFile:SubmissionFile|null;resubmissionBusy:boolean;setSelectedSourceFile:(file:SubmissionFile|null)=>void;loadSubmissionTimeline:()=>Promise<void>};
export default function AdminSubmissionTimeline({resubmitType,timelineReady,timelineBusy,timelineStatus,submissionTimeline,selectedSourceFile,resubmissionBusy,setSelectedSourceFile,loadSubmissionTimeline}:Props){return <>
        <div className="timeline-toolbar">
          <span>{resubmitType === "report" ? "報告書" : "売場画像"} / {timelineReady?`${submissionTimeline.reduce((sum,group)=>sum+group.files.length,0)}件`:"未確認"}</span>
          <button className="ghost compact" onClick={loadSubmissionTimeline} disabled={timelineBusy}>{timelineBusy ? "読込中…" : "再読込"}</button>
        </div>
        {timelineReady&&submissionTimeline.length>0&&<div className="timeline-status-list" aria-label="提出ごとの処理状態">{submissionTimeline.map(group=><p key={group.id}>{group.purpose==="replacement"?"再提出":"提出"}：{submissionStatusLabel(group.status)}（{group.files.length}ファイル）</p>)}</div>}
        <div className="file-gallery">
          {(timelineReady?submissionTimeline:[]).flatMap((group)=>group.files).map((file)=>(
            <article className={`file-card ${selectedSourceFile?.id===file.id ? "selected" : ""}`} key={`${file.submissionId}_${file.id}`}>
              <AdminSubmissionPreview file={file} busy={timelineBusy||resubmissionBusy} onReload={loadSubmissionTimeline}/>
              <strong>{file.driveName || file.originalName}</strong>
              <small>{file.sequence ? `(${file.sequence})` : ""} {file.purpose==="replacement"?"再提出":"提出"} / {submissionStatusLabel(file.status)}</small>
              <button type="button" className="ghost" disabled={resubmissionBusy||file.status!=="completed"} aria-pressed={selectedSourceFile?.id===file.id&&selectedSourceFile?.submissionId===file.submissionId} onClick={()=>setSelectedSourceFile(file)}>再送対象に選ぶ</button>
            </article>
          ))}
          {!timelineReady&&<div className="empty-inline" role={timelineStatus==="error"?"alert":"status"}>{timelineStatus==="error"?"提出履歴を取得できませんでした。再読込してください。":timelineBusy?"提出履歴を読み込んでいます…":"提出履歴は未確認です。再読込してください。"}</div>}
          {timelineReady&&!submissionTimeline.some(group=>group.files.length>0)&&<div className="empty-inline">この履歴で確認できるファイルは0件です。処理状態も確認してください。</div>}
        </div>
        {timelineReady&&selectedSourceFile && <div className="selected-file-note">選択中：{selectedSourceFile.driveName || selectedSourceFile.originalName} <button className="ghost compact" onClick={()=>setSelectedSourceFile(null)}>選択解除</button></div>}
</>;}

