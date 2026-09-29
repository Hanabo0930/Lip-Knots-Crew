export type AdminWorkspace = "overview" | "jobs" | "submissions" | "staff" | "operations";
export const adminWorkspaces: {id:AdminWorkspace;label:string;symbol:string;description:string}[] = [
  {id:"overview",label:"概要",symbol:"overview",description:"今日の確認と業務の状況"},
  {id:"jobs",label:"案件",symbol:"jobs",description:"募集・担当・原本を確認"},
  {id:"submissions",label:"報告書・再提出",symbol:"submissions",description:"提出内容と経費を確認"},
  {id:"staff",label:"スタッフ",symbol:"staff",description:"登録情報・実績・端末"},
  {id:"operations",label:"通知・運用",symbol:"operations",description:"通知と各種設定"},
];
export const workspaceViews: Record<AdminWorkspace,{id:string;label:string;description:string}[]> = {
 overview:[{id:"home",label:"業務ホーム",description:"対応が必要な業務から始めましょう。"},{id:"analytics",label:"月次集計",description:"案件数・請求・支払の概算を確認します。"},{id:"issues",label:"書戻しの確認",description:"原本への反映で確認が必要な依頼を管理します。"}],
 jobs:[{id:"list",label:"案件一覧",description:"案件を検索し、担当・募集状況を確認します。"},{id:"import",label:"原本の確認・取込",description:"月別の原本を読み取り、取込前の内容を確認します。"},{id:"receive",label:"メール受信案件",description:"受信候補を確認し、案件の作成へ進みます。"},{id:"create",label:"案件を追加",description:"新しい案件の日程と募集条件を入力します。"},{id:"edit",label:"案件の編集",description:"選択した案件の内容・担当を編集します。"},{id:"export",label:"資料・CSV出力",description:"メーカー・クライアント別の資料を出力します。"},{id:"cancel",label:"キャンセル管理",description:"取消理由と請求・支払の扱いを確認します。"}],
 submissions:[{id:"review",label:"資料・報告書・再提出",description:"案件の資料、提出ファイル、再提出依頼を確認します。"},{id:"expenses",label:"経費確認",description:"選択した案件の経費を確認・保存します。"}],
 staff:[{id:"directory",label:"スタッフ一覧",description:"氏名や地域で検索し、登録情報を確認します。"},{id:"performance",label:"稼働実績",description:"一覧で選んだスタッフの実績を確認します。"},{id:"devices",label:"ログイン端末",description:"一覧で選んだスタッフの端末を管理します。"}],
 operations:[{id:"notifications",label:"通知設定",description:"管理者のプッシュ通知を設定します。"},{id:"staff-sync",label:"名簿の同期",description:"原本のスタッフ名簿をアプリへ同期します。"},{id:"invites",label:"利用案内・試用",description:"対象者への案内と試用状況を管理します。"},{id:"readiness",label:"導入チェック",description:"利用開始前の確認事項を確認します。"},{id:"release",label:"公開・停止設定",description:"公開承認と全体停止に関する管理者向け設定です。"}],
};
export function viewKey(group:AdminWorkspace,view:string){return group+":"+view;}
function Icon({name}:{name:string}){
 const shapes:Record<string,React.ReactNode>={overview:<><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,jobs:<><rect x="3" y="6" width="18" height="15" rx="2"/><path d="M8 6V3h8v3M3 12h18M10 12v3h4v-3"/></>,submissions:<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 15l3 3 5-6"/></>,staff:<><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/></>,operations:<><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>};
 return <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{shapes[name]}</svg>;
}
export default function AdminNavigation({workspace,view,onSelect}:{workspace:AdminWorkspace;view:string;onSelect:(group:AdminWorkspace,view?:string)=>void}){
 const current=adminWorkspaces.find(item=>item.id===workspace)!;
 return <aside className="admin-sidebar" aria-label="管理メニュー">
  <div className="sidebar-caption">WORKSPACE <span>管理メニュー</span></div>
  <nav className="workspace-nav" aria-label="管理業務">{adminWorkspaces.map(item=><button type="button" key={item.id} aria-pressed={workspace===item.id} onClick={()=>onSelect(item.id)}><Icon name={item.symbol}/><span>{item.label}</span></button>)}</nav>
  <div className="sidebar-section-title">{current.label}</div>
  <nav className="workspace-subnav" aria-label={current.label+"のメニュー"}>{workspaceViews[workspace].map(item=><button key={item.id} type="button" aria-current={view===item.id?"page":undefined} onClick={()=>onSelect(workspace,item.id)}><span className="nav-dot"/>{item.label}</button>)}</nav>
  <label className="mobile-view-select">表示する画面<select aria-label="表示する画面" value={view} onChange={event=>onSelect(workspace,event.target.value)}>{workspaceViews[workspace].map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
  <p className="sidebar-hint">使う機能を選ぶと、<br/>右側に作業画面が開きます。</p>
 </aside>;
}
