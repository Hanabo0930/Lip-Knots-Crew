import {CSSProperties,useRef} from 'react';
export type ShiftCardJob={id:string;workDate:string;dateKey:string;menuName:string;storeName:string;workTime:string};
export function shiftPage<T>(jobs:T[],page:number){
 const totalPages=Math.max(1,Math.ceil(jobs.length/50));
 const current=Math.max(0,Math.min(Number.isFinite(page)?Math.floor(page):0,totalPages-1));
 return {current,totalPages,start:current*50,rows:jobs.slice(current*50,current*50+50)};
}
export default function ShiftJobCards<T extends ShiftCardJob>({jobs,page,onPageChange,selectedId,onSelect,label,accent,kind,summary}:{jobs:T[];page:number;onPageChange:(page:number)=>void;selectedId?:string;onSelect:(job:T)=>void;label:string;accent:(menu:string)=>string;kind:(menu:string)=>string;summary:(job:T)=>string}){
 const region=useRef<HTMLDivElement>(null);
 const slice=shiftPage(jobs,page);

 function move(next:number){onPageChange(next);region.current?.focus({preventScroll:true});region.current?.scrollIntoView({block:'start'});}
 const controls=jobs.length>50?<nav className="shift-page-controls" aria-label={`${label}のページ`}><button className="secondary" disabled={slice.current===0} onClick={()=>move(slice.current-1)}>前の50件</button><span aria-live="polite">{slice.start+1}〜{Math.min(slice.start+50,jobs.length)}件 / 読込済み{jobs.length}件</span><button className="secondary" disabled={slice.current+1>=slice.totalPages} onClick={()=>move(slice.current+1)}>次の50件</button></nav>:null;
 return <div ref={region} className="shift-card-list" tabIndex={-1} aria-label={label}>
  {controls}
  <div className="grid">{slice.rows.map(job=><button type="button" className={`job shift-job shift-card-button ${selectedId===job.id?'selected':''}`} style={{'--job-accent':accent(job.menuName)} as CSSProperties} key={job.id} aria-pressed={selectedId===job.id} aria-label={`${job.storeName}のシフトを確認`} onClick={()=>onSelect(job)}><span className="date">{job.workDate||job.dateKey}</span><span className="job-kind">{kind(job.menuName)}</span><strong className="shift-card-store">{job.storeName}</strong><span className="shift-card-time">{job.workTime}</span><span className="prep-chip">{summary(job)}</span></button>)}</div>
  {controls}
 </div>;
}