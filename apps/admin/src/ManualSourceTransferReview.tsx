import './manual-source-transfer.css';
import {useState} from 'react';
import type {SheetWriteIssue} from './AdminSheetIssuePanel';
import {readyManualSourceTransferIssue,validManualSourceTransferConfirmation,type ManualSourceTransferConfirmation} from './manual-source-transfer';
const checks=[['arrival','入店時間を確認した'],['execution','勤務時間を確認した'],['headcount','1名の案件であることを確認した'],['dateMode','単日の案件であることを確認した'],['payOffer','下記の日給・交通費・通信費を確認した']] as const;
export default function ManualSourceTransferReview({issue,busy,onSelect}:{issue:SheetWriteIssue;busy:boolean;onSelect:(confirmation:ManualSourceTransferConfirmation)=>void}){
 const [wage,setWage]=useState(()=>issue.suggestedPayOffer?String(issue.suggestedPayOffer.dailyWageJPY):''),[confirmed,setConfirmed]=useState<Record<string,boolean>>({});
 const confirmation={confirmedFields:confirmed,payOffer:{dailyWageJPY:Number(wage),travelExpenses:'全額支給',communicationExpenses:'全額支給'}};
 const available=readyManualSourceTransferIssue(issue),ready=available&&wage.trim()!==''&&validManualSourceTransferConfirmation(confirmation);
 return <form className="manual-source-transfer-review" aria-label="シート手入力案件の移行確認" onSubmit={event=>{event.preventDefault();if(busy||!ready||!validManualSourceTransferConfirmation(confirmation))return;onSelect(confirmation);}}>
  <h3>シートへ直接入力した担当者の確認</h3>
  {typeof issue.manualSourceStaffName==='string'&&typeof issue.manualCanonicalStaffName==='string'&&issue.manualSourceStaffName!==issue.manualCanonicalStaffName&&<p>シート入力名：{issue.manualSourceStaffName} / 名簿の正式名：{issue.manualCanonicalStaffName}</p>}
  <p>{issue.job?.makerName||'メーカー確認待ち'} / {issue.job?.menuName||'業務確認待ち'}</p>
  <p>入店時間：{issue.job?.entryTime||'確認待ち'} / 勤務時間：{issue.job?.workTime||'確認待ち'}</p>
  <label>スタッフへ提示する日給（円）<input type="number" inputMode="numeric" min="1" max="1000000" step="1" required value={wage} disabled={busy||!available} onChange={event=>setWage(event.target.value)}/></label>
  <p>交通費・通信費：全額支給</p>
  {checks.map(([key,label])=><label key={key}><input type="checkbox" checked={confirmed[key]===true} disabled={busy||!available} onChange={event=>setConfirmed(current=>({...current,[key]:event.target.checked}))}/>{label}</label>)}
  <p>確認後に、この案件だけを選択します。続く確認画面でクライアントへのネームアップ済みを確認してください。案件リストの取消チェックは移行選択に使いません。</p>
  {!available&&<p role="status">担当者・案件の照合が終わるまで保留します。確認メモや再試行で移行することはできません。</p>}
  <button className="compact" type="submit" disabled={busy||!ready}>この案件を選択してシフト表へ移行</button>
 </form>;
}
