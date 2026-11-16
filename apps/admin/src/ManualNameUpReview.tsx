import type {ManualNameUpView,ManualPayOffer} from './manual-nameup';
import {manualNameUpRequest,validManualNameUpView} from './manual-nameup';
export default function ManualNameUpReview({view,payOffers,busy,message,onPayChange,onSend}:{view:ManualNameUpView|null;payOffers:ManualPayOffer[];busy:boolean;message:string;onPayChange:(caseId:string,field:'travelExpenses'|'communicationExpenses',value:string)=>void;onSend:(view:ManualNameUpView,payOffers:ManualPayOffer[])=>void}){
 const ready=validManualNameUpView(view)&&manualNameUpRequest(view,payOffers)!==null;
 return <form aria-label="手入力案件のネームアップ確認" onSubmit={event=>{event.preventDefault();if(busy||!ready||!view)return;onSend(view,payOffers.map(p=>({...p})));}}>
  <h3>担当・勤務条件と送信内容の確認</h3>
  {!view&&<p role="status">担当と元の勤務条件を照合しています。確認できるまで送信できません。</p>}
  {view?.cases.map(c=><fieldset key={c.caseId} disabled={busy}><legend>{c.date} {c.store}：{c.staffName}</legend>
   {c.sourceStaffName!==c.staffName&&<p>シート入力名：{c.sourceStaffName} ／ 正式氏名：{c.staffName}</p>}
   <dl><dt>取引先</dt><dd>{c.client}</dd><dt>メーカー・内容</dt><dd>{c.maker} ／ {c.content}</dd><dt>入店時刻</dt><dd>{c.arrival}</dd><dt>実施時間</dt><dd>{c.execution}</dd><dt>人数</dt><dd>{c.headcount}名</dd><dt>日程方式</dt><dd>{c.dateMode}</dd><dt>日給（元の条件）</dt><dd>{c.dailyWageJPY}円</dd></dl>
   {(['travelExpenses','communicationExpenses'] as const).map(field=><label key={field}>{field==='travelExpenses'?'交通費':'通信費'}<select aria-label={c.caseId+' '+field} required value={payOffers.find(p=>p.caseId===c.caseId)?.[field]??''} onChange={event=>onPayChange(c.caseId,field,event.target.value)}><option value="">条件を確認して選択</option><option value="全額支給">全額支給</option></select></label>)}
  </fieldset>)}
  {view?.mail.groups.map((g,index)=><section key={index} aria-label="送信するメール"><p>宛先：{g.to.join('、')} {g.cc.length?'CC：'+g.cc.join('、'):''}</p><p>件名：{g.subject}</p><pre>{g.body}</pre></section>)}
  <p>表示した入店時刻・実施時間・人数・日程方式・日給と経費条件、担当者、宛先・本文を確認して送信します。</p>
  <p>送信後に同じ案件IDでシフト表への反映を照合します。結果が不明な場合は再送せず保留します。</p>
  {message&&<p role="status">{message}</p>}
  <button type="submit" disabled={busy||!ready}>表示した条件でネームアップ送信</button>
 </form>;
}
