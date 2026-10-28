import {useId,useMemo,useState} from 'react';
import {adjacentMonth,monthCalendar,type CalendarShift} from './monthly-shift-calendar';
import {localDateKey} from './job-list';
import './monthly-shift-calendar.css';
const label=(value:unknown,fallback='確認中')=>typeof value==='string'&&value.trim()?value:fallback;
export default function MonthlyShiftCalendar<T extends CalendarShift>({jobs,onSelect,today=localDateKey()}:{jobs:T[];onSelect:(job:T)=>void;today?:string}){
  const [month,setMonth]=useState(today.slice(0,7)),[selectedDay,setSelectedDay]=useState('');
  const heading=useId();
  const state=useMemo(()=>{try{return {value:monthCalendar(jobs,month),error:''};}catch(error){return {value:null,error:error instanceof Error?error.message:'カレンダーを確認できません。'};}},[jobs,month]);
  const changeMonth=(offset:number)=>{setMonth(adjacentMonth(month,offset));setSelectedDay('');};
  const selected=state.value?.jobs.get(selectedDay)??[];
  return <section className="monthly-shift-calendar" aria-label="確定シフトの月間カレンダー">
    <h3 id={heading}>確定シフトのカレンダー</h3>
    <div className="calendar-month-navigation">
      <button className="secondary" onClick={()=>changeMonth(-1)} disabled={month==='0001-01'} aria-label="前の月を表示">前月</button>
      <strong aria-live="polite">{Number(month.slice(0,4))}年{Number(month.slice(5))}月</strong>
      <button className="secondary" onClick={()=>changeMonth(1)} disabled={month==='9999-12'} aria-label="次の月を表示">翌月</button>
      <button className="secondary" onClick={()=>{setMonth(today.slice(0,7));setSelectedDay('');}}>今月</button>
    </div>
    <p>転記と照合が終わった確定シフトを表示します。確認待ちの応募と取消案件は含みません。</p>
    <p className="muted">読み込んだシフトを表示しています。今後の続きは下の一覧から読み込めます。過去のシフトは一覧で選択した案件を表示できます。</p>
    {state.error?<p role="alert">{state.error}</p>:state.value&&<>
      <table aria-labelledby={heading}><thead><tr>{['日','月','火','水','木','金','土'].map(day=><th scope="col" key={day}>{day}</th>)}</tr></thead>
        <tbody>{Array.from({length:state.value.days.length/7},(_,week)=><tr key={week}>{state.value!.days.slice(week*7,week*7+7).map((date,index)=>{
          const shifts=date?state.value!.jobs.get(date)??[]:[];
          return <td key={date??`blank-${index}`} aria-current={date===today?'date':undefined}>
            {date&&<><span>{Number(date.slice(-2))}</span>{shifts.length>0&&<button className="calendar-day-shifts" onClick={()=>setSelectedDay(date)} aria-pressed={selectedDay===date} aria-label={`${date}の確定シフト ${shifts.length}件を表示`}>{shifts.length}件</button>}</>}
          </td>;
        })}</tr>)}</tbody>
      </table>
      {selectedDay&&<section className="calendar-day-details" aria-label={`${selectedDay}の確定シフト`} aria-live="polite">
        <h4>{selectedDay}の確定シフト</h4>
        {selected.map(job=><article key={job.id}>
          <h4>{label(job.storeName,'店舗確認中')}</h4>
          <p>{label(job.makerName,'メーカー確認中')} / {label(job.menuName,'業務確認中')}</p>
          <dl><div><dt>入店時間</dt><dd>{label(job.entryTime)}</dd></div><div><dt>勤務時間</dt><dd>{label(job.workTime)}</dd></div><div><dt>店舗住所</dt><dd>{label(job.storeAddress)}</dd></div></dl>
          <button className="secondary" onClick={()=>onSelect(job)}>このシフトの詳細を確認</button>
        </article>)}
        {!selected.length&&<p>この日の読込済み確定シフトはありません。</p>}
      </section>}
    </>}
  </section>;
}
