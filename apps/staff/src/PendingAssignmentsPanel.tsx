import {useEffect,useRef,useState} from 'react';
import {pendingAssignmentReason,type ReservationJob} from './job-list';
type PendingJob=ReservationJob&{id:string;dateKey:string;storeName:string;caseListManualPending?:unknown};
export default function PendingAssignmentsPanel<T extends PendingJob>({jobs,busy,onRefresh}:{jobs:T[];busy:boolean;onRefresh:()=>Promise<void>}){
 const inFlight=useRef(false),active=useRef(true);const [refreshing,setRefreshing]=useState(false),[error,setError]=useState('');
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 async function refresh(){if(busy||inFlight.current)return;inFlight.current=true;setRefreshing(true);setError('');
  try{await onRefresh();}catch{if(active.current)setError('最新の状態を確認できませんでした。未確認の手配は保持しています。通信状態を確認して、もう一度更新してください。');}
  finally{inFlight.current=false;if(active.current)setRefreshing(false);}
 }
 if(!jobs.length)return null;
 return <section aria-label="確認待ちの手配" className="panel" aria-busy={busy||refreshing}>
  <h3>確認待ちの手配（{jobs.length}件）</h3>
  <p>勤務枠・原本・連携の確認が済んでいない手配です。確認できた勤務予定だけをカレンダーに表示します。</p>
  <ul aria-live="polite">{jobs.map(job=><li key={job.id}><strong>{job.dateKey} / {typeof job.storeName==='string'&&job.storeName.trim()?job.storeName:'店舗確認中'}</strong><p>{pendingAssignmentReason(job)}</p></li>)}</ul>
  <p>応募を繰り返す必要はありません。下のボタンで表示を更新して、日付と店舗を確認してください。</p>
  <button className="secondary" disabled={busy||refreshing} aria-busy={busy||refreshing} onClick={()=>void refresh()}>{refreshing?'状態を確認中…':'未確認の手配を更新'}</button>
  {error&&<p role="alert">{error}</p>}
  <p className="muted">未確認のまま変わらない場合や取消のご希望は、管理者へご連絡ください。</p>
 </section>;
}
