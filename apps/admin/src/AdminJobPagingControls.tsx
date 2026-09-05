export default function AdminJobPagingControls({hasMoreJobs,jobDirectoryBusy,firebaseConfigured,total,jobDirectoryMessage,page,pageCount,onMore,onRefresh,onPage}:{hasMoreJobs:boolean;jobDirectoryBusy:boolean;firebaseConfigured:boolean;total:number;jobDirectoryMessage:string;page:number;pageCount:number;onMore:()=>void;onRefresh:()=>void;onPage:(value:number)=>void}){return <>
        <div className="job-directory-actions">
          {hasMoreJobs&&<button onClick={onMore} disabled={jobDirectoryBusy} aria-busy={jobDirectoryBusy}>{jobDirectoryBusy?"取得中…":"続きの案件を100件取得"}</button>}
          {firebaseConfigured&&<button className="ghost" onClick={onRefresh} disabled={jobDirectoryBusy}>一覧を再読込</button>}
          <span>{hasMoreJobs?"未読込の案件がある可能性があります":total?"現在の取得範囲の末尾です":""}</span>
        </div>
        {jobDirectoryMessage&&<p role="status">{jobDirectoryMessage}</p>}
        <nav className="job-pagination" aria-label="案件一覧のページ">
          <button className="ghost" disabled={page===0} onClick={()=>onPage(page-1)}>前の50件</button>
          <span>{page+1} / {pageCount}ページ</span>
          <button className="ghost" disabled={page+1>=pageCount} onClick={()=>onPage(page+1)}>次の50件</button>
        </nav>
</>;}

