import type { Dispatch, SetStateAction } from "react";
type ExpenseValues = { transportation:string;purchase8:string;purchase10:string;netPrintCost:string;postageCost:string };
type ExpenseJob = { id:string;workDate:string;storeName:string;assignedStaffName?:string|null };
type Props = {
  jobs:ExpenseJob[];expenseJobId:string;expenseValues:ExpenseValues;expenseNote:string;expenseStatus:string;expenseBusy:boolean;expenseReady:boolean;
  loadExpenseReview:(jobId:string)=>Promise<void>;saveExpenseDraft:()=>Promise<void>;completeExpense:()=>Promise<void>;openSheet:()=>void;
  setExpenseValues:Dispatch<SetStateAction<ExpenseValues>>;setExpenseNote:Dispatch<SetStateAction<string>>;
};
export default function AdminExpensePanel({jobs,expenseJobId,expenseValues,expenseNote,expenseStatus,expenseBusy,expenseReady,loadExpenseReview,saveExpenseDraft,completeExpense,openSheet,setExpenseValues,setExpenseNote}:Props){
  return (<section className="panel expense-panel">
        <div className="section-heading">
          <div>
            <h2>報告書確認・経費入力</h2>
            <p>画像を見ながら一時保存し、確認完了時だけ安全なスプシ書込キューへ送ります。</p>
          </div>
          <span className="mini-tag">{expenseStatus}</span>
        </div>
        <div className="expense-select">
          <select value={expenseJobId} onChange={(event)=>loadExpenseReview(event.target.value)}>
            {jobs.map((job)=><option value={job.id} key={job.id}>{job.workDate} {job.storeName} {job.assignedStaffName ?? "募集中"}</option>)}
          </select>
          <button className="ghost" onClick={()=>loadExpenseReview(expenseJobId)} disabled={expenseBusy}>読込</button>
        </div>
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
                inputMode="numeric"
                disabled={expenseBusy||!expenseReady}
                value={expenseValues[key as keyof ExpenseValues]}
                onChange={(event)=>setExpenseValues((current)=>({...current,[key]:event.target.value}))}
                placeholder="0"
              />
            </label>
          ))}
        </div>
        <label className="expense-note">確認メモ
          <textarea disabled={expenseBusy||!expenseReady} value={expenseNote} onChange={(event)=>setExpenseNote(event.target.value)} placeholder="途中メモや確認内容"/>
        </label>
        <div className="sync-actions">
          <button className="ghost" onClick={saveExpenseDraft} disabled={expenseBusy||!expenseReady}>一時保存</button>
          <button onClick={completeExpense} disabled={expenseBusy||!expenseReady}>確認完了・書込待ちへ</button>
          <button className="ghost" onClick={openSheet}>スプシ該当行</button>
        </div>
      </section>);
}
