import {hasValidDateKey} from './job-list';
import {CSSProperties,useRef} from 'react';
export type ShiftCardJob={id:string;workDate:string;dateKey:string;menuName:string;storeName:string;workTime:string};
export function shiftDateLabel(job:Pick<ShiftCardJob,'workDate'|'dateKey'>){
 if(!hasValidDateKey(job))return '勤務日確認中';
 const display=typeof job.workDate==='string'?job.workDate.trim():'';
 const parts=/^(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})日?(?:[（(]([日月火水木金土])(?:曜(?:日)?)?[）)])?$/.exec(display);
 const [year,month,day]=job.dateKey.split('-').map(Number);
 if(!parts||(parts[1]&&Number(parts[1])!==year)||Number(parts[2])!==month||Number(parts[3])!==day)return job.dateKey;
 if(parts[4]&&parts[4]!=='日月火水木金土'[new Date(job.dateKey+'T00:00:00Z').getUTCDay()])return job.dateKey;
 return display;
}
export function shiftTextLabel(value:unknown,fallback:string){return typeof value==='string'&&value.trim()?value.trim():fallback;}
export function shiftPage<T>(jobs:T[],page:number){
 const totalPages=Math.max(1,Math.ceil(jobs.length/50));
 const current=Math.max(0,Math.min(Number.isFinite(page)?Math.floor(page):0,totalPages-1));
 return {current,totalPages,start:current*50,rows:jobs.slice(current*50,current*50+50)};
}
export default function ShiftJobCards<T extends ShiftCardJob>({jobs,page,onPageChange,selectedId,onSelect,label,accent,kind,summary,submissionSummary}:{jobs:T[];page:number;onPageChange:(page:number)=>void;selectedId?:string;onSelect:(job:T)=>void;label:string;accent:(menu:string)=>string;kind:(menu:string)=>string;summary:(job:T)=>string;submissionSummary?:(job:T)=>string}){
 const region=useRef<HTMLDivElement>(null);
 const slice=shiftPage(jobs,page);

 function move(next:number){onPageChange(next);region.current?.focus({preventScroll:true});region.current?.scrollIntoView({block:'start'});}
 const controls=jobs.length>50?<nav className="shift-page-controls" aria-label={`${label}のページ`}><button className="secondary" disabled={slice.current===0} onClick={()=>move(slice.current-1)}>前の50件</button><span aria-live="polite">{slice.start+1}〜{Math.min(slice.start+50,jobs.length)}件 / 読込済み{jobs.length}件</span><button className="secondary" disabled={slice.current+1>=slice.totalPages} onClick={()=>move(slice.current+1)}>次の50件</button></nav>:null;
 return <div ref={region} className="shift-card-list" role="region" tabIndex={-1} aria-label={label}>
  {controls}
  <div className="grid">{slice.rows.map(job=><button type="button" className={`job shift-job shift-card-button ${selectedId===job.id?'selected':''}`} style={{'--job-accent':accent(job.menuName)} as CSSProperties} key={job.id} aria-pressed={selectedId===job.id} aria-label={`${shiftDateLabel(job)} ${shiftTextLabel(job.storeName,"店舗確認中")} ${shiftTextLabel(job.workTime,"勤務時間確認中")}のシフトを確認${submissionSummary?"。"+submissionSummary(job):""}`} onClick={()=>onSelect(job)}><span className="date">{shiftDateLabel(job)}</span><span className="job-kind">{kind(job.menuName)}</span><strong className="shift-card-store">{shiftTextLabel(job.storeName,"店舗確認中")}</strong><span className="shift-card-time">{shiftTextLabel(job.workTime,"勤務時間確認中")}</span><span className="prep-chip">{summary(job)}</span>{submissionSummary&&<small className="shift-card-submission">{submissionSummary(job)}</small>}</button>)}</div>
  {controls}
 </div>;
}