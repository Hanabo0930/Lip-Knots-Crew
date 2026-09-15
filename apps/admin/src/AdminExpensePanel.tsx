import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
type ExpenseValues = { transportation:string;purchase8:string;purchase10:string;netPrintCost:string;postageCost:string };
type ExpenseJob = { id:string;workDate:string;storeName:string;assignedStaffName?:string|null };
type Props = {
  focusRequest?:number;active?:boolean;openReport?:(jobId:string)=>void;
  jobs:ExpenseJob[];expenseJobId:string;expenseValues:ExpenseValues;expenseNote:string;expenseStatus:string;expenseBusy:boolean;expenseReady:boolean;
  loadExpenseReview:(jobId:string)=>Promise<void>;saveExpenseDraft:()=>Promise<void>;completeExpense:()=>Promise<void>;openSheet:()=>void;
  setExpenseValues:Dispatch<SetStateAction<ExpenseValues>>;setExpenseNote:Dispatch<SetStateAction<string>>;
};
export default function AdminExpensePanel({focusRequest=0,active=true,openReport,jobs,expenseJobId,expenseValues,expenseNote,expenseStatus,expenseBusy,expenseReady,loadExpenseReview,saveExpenseDraft,completeExpense,openSheet,setExpenseValues,setExpenseNote}:Props){
  const statusLabels:Record<string,string>={draft:"一時保存",queued:"反映待ち",completed:"反映完了",error:"反映要確認"};
  const localStatuses=["未読込","読込中","デモ読込済み","未処理","一時保存","書込待ち","結果を再確認してください","読込できませんでした"];
  const statusLabel=Object.hasOwn(statusLabels,expenseStatus)?statusLabels[expenseStatus]:localStatuses.includes(expenseStatus)?expenseStatus:"状態を確認してください";
  const headingRef=useRef<HTMLHeadingElement>(null),handledFocus=useRef(0);
  useEffect(()=>{
    if(!active){handledFocus.current=focusRequest;return;}
    if(!focusRequest||handledFocus.current===focusRequest)return;
    handledFocus.current=focusRequest;
    headingRef.current?.focus({preventScroll:true});
    headingRef.current?.scrollIntoView({block:"start",behavior:"auto"});
  },[focusRequest,active]);
  const [jobQuery,setJobQuery]=useState(""),[jobPage,setJobPage]=useState(0);
  const selectedJob=useMemo(()=>jobs.find(job=>job.id===expenseJobId),[jobs,expenseJobId]);
  const selectedInList=!!selectedJob;
  const matchingJobs=useMemo(()=>{
    const terms=jobQuery.normalize("NFKC").toLocaleLowerCase("ja-JP").trim().split(/\s+/).filter(Boolean);
    return terms.length?jobs.filter(job=>{const text=[job.id,job.workDate,job.storeName,job.assignedStaffName??"募集中"].join(" ").normalize("NFKC").toLocaleLowerCase("ja-JP");return terms.every(term=>text.includes(term));}):jobs;
  },[jobs,jobQuery]);
  const page=Math.min(jobPage,Math.max(0,Math.ceil(matchingJobs.length/100)-1));
  const visibleJobs=useMemo(()=>matchingJobs.slice(page*100,page*100+100),[matchingJobs,page]);
  const jobOptions=useMemo(()=>visibleJobs.map(job=><option value={job.id} key={job.id}>{job.workDate} {job.storeName} {job.assignedStaffName??"募集中"}</option>),[visibleJobs]);
  const selectedOutside=selectedJob&&!visibleJobs.some(job=>job.id===expenseJobId);
  return (<section className="panel expense-panel">
        <div className="section-heading">
          <div>
            <h2 ref={headingRef} tabIndex={-1}>報告書確認・経費入力</h2>
            <p>報告書を確認して経費を入力し、確認完了でスプレッドシートへの反映を受け付けます。</p>
          </div>
          <span className="mini-tag" role="status" aria-label="経費確認の状態">{statusLabel}</span>
        </div>
        {(expenseStatus==="queued"||expenseStatus==="書込待ち")&&<p className="expense-sync-note" role="status">スプレッドシートへの反映はまだ確認できていません。時間をおいて「読込」で確認してください。</p>}
        {expenseStatus==="error"&&<p className="expense-sync-note" role="status">反映状況の確認が必要です。「概要」の「スプシ書込エラー・競合」を確認してください。</p>}
        {(jobs.length>100||jobQuery)&&<label className="expense-job-search">経費対象を検索
          <input type="search" value={jobQuery} onChange={event=>{setJobQuery(event.target.value);setJobPage(0);}} placeholder="日付・店舗・担当者・案件ID"/>
        </label>}
        {(jobs.length>100||jobQuery)&&<div className="sync-actions">
          <span role="status">{matchingJobs.length}件中 {matchingJobs.length?page*100+1:0}〜{Math.min((page+1)*100,matchingJobs.length)}件を表示</span>
          <button className="ghost" disabled={!page} onClick={()=>setJobPage(page-1)}>前の100件</button>
          <button className="ghost" disabled={(page+1)*100>=matchingJobs.length} onClick={()=>setJobPage(page+1)}>次の100件</button>
        </div>}
        <div className="expense-select">
          <select aria-label="経費入力する案件" value={expenseJobId} onChange={(event)=>loadExpenseReview(event.target.value)}>
            <option value="" disabled>案件を選択してください</option>
            {!!expenseJobId&&!selectedInList&&<option value={expenseJobId}>選択中の案件（一覧の読込範囲外）</option>}
            {selectedOutside&&<option value={selectedJob.id}>選択中：{selectedJob.workDate} {selectedJob.storeName} {selectedJob.assignedStaffName??"募集中"}</option>}
            {jobOptions}
          </select>
          <button className="ghost" onClick={()=>loadExpenseReview(expenseJobId)} disabled={expenseBusy||!expenseJobId}>読込</button>
        </div>
        {openReport&&<button className="ghost" disabled={!selectedInList} onClick={()=>openReport(expenseJobId)}>この案件の報告書を確認</button>}
        <div className="expense-grid">
          {[
            ["transportation","交通費"],
            ["purchase8","8％買取"],
            ["purchase10","10％買取"],
            ["netPrintCost","ネットプリント"],
            ["postageCost","切手・速達・レターパック"],
          ].map(([key,label])=>(
            <label key={key}>{label}
              <input
                inputMode="decimal"
                disabled={expenseBusy||!expenseReady}
                value={expenseValues[key as keyof ExpenseValues]}
                onChange={(event)=>setExpenseValues((current)=>({...current,[key]:event.target.value}))}
                placeholder="0"
              />
            </label>
          ))}
        </div>
        <label className="expense-note">確認メモ
          <textarea aria-label="確認メモ" disabled={expenseBusy||!expenseReady} value={expenseNote} onChange={(event)=>setExpenseNote(event.target.value)} placeholder="途中メモや確認内容"/>
        </label>
        <div className="sync-actions">
          <button className="ghost" onClick={saveExpenseDraft} disabled={expenseBusy||!expenseReady}>一時保存</button>
          <button onClick={completeExpense} disabled={expenseBusy||!expenseReady}>確認完了・書込待ちへ</button>
          <button className="ghost" onClick={openSheet} disabled={!selectedInList}>スプシ該当行</button>
        </div>
      </section>);
}
