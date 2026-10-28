import {useEffect,useState} from 'react';
type CalendarComponent=typeof import('./MonthlyShiftCalendar').default;
const MonthlyShiftCalendarEntry:CalendarComponent=props=>{
  const [Calendar,setCalendar]=useState<CalendarComponent|null>(null);
  const [error,setError]=useState(false),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true;setError(false);
    void import('./MonthlyShiftCalendar').then(module=>{if(active)setCalendar(()=>module.default);}).catch(()=>{if(active)setError(true);});
    return()=>{active=false;};
  },[attempt]);
  if(Calendar)return <Calendar {...props}/>;
  return <section aria-label="確定シフトの月間カレンダー">
    <h3>確定シフトのカレンダー</h3>
    {error?<div role="alert"><p>カレンダーを読み込めませんでした。通信状態を確認して再試行してください。</p><button className="secondary" onClick={()=>setAttempt(value=>value+1)}>カレンダーを再読込</button></div>:<p role="status">カレンダーを読み込んでいます…</p>}
  </section>;
};
export default MonthlyShiftCalendarEntry;
