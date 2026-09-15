import {useMemo,useState} from "react";
import AdminSubmissionPreview from "./AdminSubmissionPreview";
import {submissionStatusLabel} from "./submission-status";
import type {SubmissionFile,SubmissionGroup} from "./App";
type Props={resubmitType:"report"|"sales_floor";timelineReady:boolean;timelineBusy:boolean;timelineStatus:"idle"|"loading"|"ready"|"error";submissionTimeline:SubmissionGroup[];selectedSourceFile:SubmissionFile|null;resubmissionBusy:boolean;setSelectedSourceFile:(file:SubmissionFile|null)=>void;loadSubmissionTimeline:(previewFile?:{submissionId:string;fileId:string})=>Promise<void>};
export default function AdminSubmissionTimeline({resubmitType,timelineReady,timelineBusy,timelineStatus,submissionTimeline,selectedSourceFile,resubmissionBusy,setSelectedSourceFile,loadSubmissionTimeline}:Props){
  const files=useMemo(()=>submissionTimeline.flatMap(group=>group.files),[submissionTimeline]);
  const context=JSON.stringify([resubmitType,files[0]?.submissionId,files[0]?.id]);
  const [view,setView]=useState({context,page:0});
  const page=Math.min(view.context===context?view.page:0,Math.max(0,Math.ceil(files.length/20)-1));
  return <>
        <div className="timeline-toolbar">
          <span>{resubmitType === "report" ? "報告書" : "売場画像"} / {timelineReady?`${submissionTimeline.reduce((sum,group)=>sum+group.files.length,0)}件`:"未確認"}</span>
          <button className="ghost compact" onClick={()=>void loadSubmissionTimeline()} disabled={timelineBusy}>{timelineBusy ? "読込中…" : "再読込"}</button>
        </div>
        {timelineReady&&submissionTimeline.length>0&&<div className="timeline-status-list" aria-label="提出ごとの処理状態">{submissionTimeline.map(group=><p key={group.id}>{group.purpose==="replacement"?"再提出":"提出"}：{submissionStatusLabel(group.status)}（{group.files.length}ファイル）</p>)}</div>}

        {timelineReady&&selectedSourceFile && <div className="selected-file-note">選択中：{selectedSourceFile.driveName || selectedSourceFile.originalName} <button className="ghost compact" onClick={()=>setSelectedSourceFile(null)}>選択解除</button></div>}
        {timelineReady&&selectedSourceFile&&!files.some(file=>file.id===selectedSourceFile.id&&file.submissionId===selectedSourceFile.submissionId&&file.status==="completed")&&<p className="admin-preview-error" role="alert">選択中のファイルを最新の履歴で確認できません。再送対象を選び直してください。</p>}
        {timelineReady&&files.length>20&&<nav className="sync-actions" aria-label="提出画像のページ">
          <button className="ghost" disabled={!page} onClick={()=>setView({context,page:page-1})}>前の20件</button>
          <span role="status">{files.length}件中 {page*20+1}〜{Math.min((page+1)*20,files.length)}件</span>
          <button className="ghost" disabled={(page+1)*20>=files.length} onClick={()=>setView({context,page:page+1})}>次の20件</button>
        </nav>}
        <div className="file-gallery">
          {(timelineReady?files.slice(page*20,page*20+20):[]).map((file)=>(
            <article className={`file-card ${selectedSourceFile?.id===file.id&&selectedSourceFile?.submissionId===file.submissionId ? "selected" : ""}`} key={`${file.submissionId}_${file.id}`}>
              <AdminSubmissionPreview file={file} busy={timelineBusy||resubmissionBusy} onReload={()=>loadSubmissionTimeline({submissionId:file.submissionId,fileId:file.id})}/>
              <strong>{file.driveName || file.originalName}</strong>
              <small>{file.sequence ? `(${file.sequence})` : ""} {file.purpose==="replacement"?"再提出":"提出"} / {submissionStatusLabel(file.status)}</small>
              <button type="button" className="ghost" disabled={resubmissionBusy||file.status!=="completed"} aria-pressed={selectedSourceFile?.id===file.id&&selectedSourceFile?.submissionId===file.submissionId} onClick={()=>setSelectedSourceFile(file)}>再送対象に選ぶ</button>
            </article>
          ))}
          {!timelineReady&&<div className="empty-inline" role={timelineStatus==="error"?"alert":"status"}>{timelineStatus==="error"?"提出履歴を取得できませんでした。再読込してください。":timelineBusy?"提出履歴を読み込んでいます…":"提出履歴は未確認です。再読込してください。"}</div>}
          {timelineReady&&!submissionTimeline.some(group=>group.files.length>0)&&<div className="empty-inline">この履歴で確認できるファイルは0件です。処理状態も確認してください。</div>}
        </div>
</>;}

