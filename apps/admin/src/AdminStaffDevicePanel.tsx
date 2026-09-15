type Props = {
  name: string;
  devices: {id:string;label?:string;platform?:string;active?:boolean}[];
  status: "idle"|"loading"|"ready"|"error";
  onClose: () => void;
  onReload: () => void;
};
export default function AdminStaffDevicePanel({name,devices,status,onClose,onReload}:Props){
  return <section className="panel">
    <div className="section-heading"><div><h2>{name}さんの端末</h2><p>全端末ログアウトはスタッフ一覧から実行できます。</p></div><button className="ghost" onClick={onClose}>閉じる</button></div>
    <button className="ghost" onClick={onReload} disabled={status==="loading"}>再読込</button>
    {status==="loading"?<p role="status">端末を読み込んでいます…</p>:status==="error"?<p role="alert">端末を取得できませんでした。再読込してください。</p>:status==="ready"?<div className="device-grid">{devices.map(device=><article key={device.id}><strong>{device.label||device.platform||"端末"}</strong><small>{device.active===false?"ログアウト済み":"利用中"}</small></article>)}{!devices.length&&<div>登録端末はありません。</div>}</div>:null}
  </section>;
}
