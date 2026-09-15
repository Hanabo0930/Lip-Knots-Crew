type Props={hasMore?:boolean;onMore?:()=>void;query:string;onQuery:(value:string)=>void;total:number;busy:boolean;configured:boolean;message:string;onReload:()=>void;onSearch:()=>void};
export default function AdminStaffToolbar({hasMore,onMore,query,onQuery,total,busy,configured,message,onReload,onSearch}:Props){return <>
  <div className="toolbar"><input value={query} onChange={event=>onQuery(event.target.value)} placeholder="スタッフ名・メール・最寄り駅・エリアを検索"/><button onClick={onSearch}>スタッフ検索</button><button className="ghost" onClick={onReload} disabled={busy||!configured} aria-busy={busy}>{busy?"読込中…":"名簿を再読込"}</button></div>
  {hasMore&&<button className="ghost" onClick={onMore} disabled={busy||!configured} aria-busy={busy}>未読込のスタッフを取得（100名ずつ）</button>}
  <h2>スタッフ一覧</h2><p className="muted">スペースで区切ると、名前とエリアなど複数の条件で絞り込めます。</p>
  <p role="status">{message||("検索結果："+total+"名（読込済みの範囲）")}</p>
</>;}
