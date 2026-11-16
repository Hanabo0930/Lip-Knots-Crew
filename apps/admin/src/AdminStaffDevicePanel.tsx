export type StaffDeviceAuthPlan =
  | { status: "eligible"; staffId: string; email: string; operationId: string; mode: "first_login" | "existing_login" }
  | { status: "enabled"; staffId: string; operationId: string | null }
  | { status: "ineligible"; staffId: string };

type Props = {
  name: string;
  devices: {id:string;label?:string;platform?:string;active?:boolean}[];
  status: "idle" | "loading" | "ready" | "error";
  authentication: StaffDeviceAuthPlan | null;
  authenticationBusy: boolean;
  authenticationMessage: string;
  onReviewAuthentication?: (enable?: boolean) => void;
  onClose: () => void;
  onReload: () => void;
};

export default function AdminStaffDevicePanel({
  name, devices, status, authentication, authenticationBusy, authenticationMessage, onReviewAuthentication, onClose, onReload,
}: Props) {
  return <section className="panel">
    <div className="section-heading"><div><h2>{name}さんの端末</h2><p>全端末ログアウトはスタッフ一覧から実行できます。</p></div><button className="ghost" onClick={onClose}>閉じる</button></div>
    <button className="ghost" onClick={onReload} disabled={status === "loading"}>再読込</button>
    {status === "loading" && <p role="status">端末を読み込んでいます…</p>}
    {status === "error" && <p role="alert">端末を取得できませんでした。再読込してください。</p>}
    {status === "ready" && <>
      <div className="device-grid">
        {devices.map(device => <article key={device.id}><strong>{device.label || device.platform || "端末"}</strong><small>{device.active === false ? "ログアウト済み" : "登録済み"}</small></article>)}
        {!devices.length && <div>登録端末はありません。</div>}
      </div>
      {onReviewAuthentication && <>
        <h3>端末別認証</h3>
        <button className="ghost" disabled={authenticationBusy} onClick={() => onReviewAuthentication()}>切替条件を確認</button>
        {authenticationBusy && <p role="status">認証方式を確認しています…</p>}
        {authenticationMessage && <p role="alert">{authenticationMessage}</p>}
        {authentication?.status === "ineligible" && <p>会社・登録メール・アカウントの照合が揃わないため、切り替えられません。</p>}
        {authentication?.status === "enabled" && <p role="status">端末別認証を使用中です。</p>}
        {authentication?.status === "eligible" && <>
          <p>{authentication.staffId} ／ {authentication.email}</p>
          <p>{authentication.mode === "first_login" ? "本人の初回ログイン時にアカウントを作ります。" : "既存のアカウントを引き継ぎます。利用中の端末は、新しい確認コードでログインし直します。"}</p>
          <button disabled={authenticationBusy} onClick={() => onReviewAuthentication(true)}>このスタッフの端末別認証を有効にする</button>
        </>}
      </>}
    </>}
  </section>;
}
