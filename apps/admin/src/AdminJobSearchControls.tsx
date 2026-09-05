import {ADMIN_JOB_PAGE_SIZE,type JobListFilter} from "./job-search";
export default function AdminJobSearchControls({queryText,jobListFilter,total,count,page,onQuery,onFilter,onClear}:{queryText:string;jobListFilter:JobListFilter;total:number;count:number;page:number;onQuery:(value:string)=>void;onFilter:(value:JobListFilter)=>void;onClear:()=>void}){return <>
        <div className="toolbar">
          <input value={queryText} aria-label="案件を検索" onChange={(event) => {onQuery(event.target.value);}} placeholder="スタッフ名・店舗・メーカー・クライアントを検索" />
          <select aria-label="案件の絞り込み" value={jobListFilter} onChange={event=>{onFilter(event.target.value as JobListFilter);}}>
            <option value="all">すべて</option><option value="precontact">事前連絡待ち</option><option value="assigned">担当確定</option><option value="cancelled">キャンセル</option><option value="report-completed">報告書：完了記録あり</option><option value="report-unconfirmed">報告書：完了未確認</option>
          </select>
          <button className="ghost" onClick={()=>{onClear();}}>条件をクリア</button>
        </div>
        <p>初回読込は最大100件です。続きは100件ずつ追加できます。絞り込みは読込済み案件が対象です。「完了未確認」には未提出・処理中・記録不足が含まれます。完了記録があっても、再提出依頼の完了とは別です。</p>
        <p className="job-search-summary" role="status">読込済み{total}件のうち{count}件。{count?`${page*ADMIN_JOB_PAGE_SIZE+1}〜${Math.min((page+1)*ADMIN_JOB_PAGE_SIZE,count)}件を表示`:"該当する案件はありません"}。スペースで区切ると複数の条件で検索できます（日付も検索可）。</p>
</>;}

