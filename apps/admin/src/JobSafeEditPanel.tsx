import StoreLocationFields from "./StoreLocationFields";

type EditValues = Record<string, string> & {
  assignedStaffId: string;
  clientName: string;
  storeName: string;
  storeAddress: string;
  storeNearestStation: string;
  makerName: string;
  menuName: string;
  entryTime: string;
  workTime: string;
  subcontractorName: string;
};

type Props = {
  jobs: Array<{ id: string; workDate: string; storeName: string }>;
  staff: Array<{ id: string; displayName: string; active?: boolean }>;
  jobEditId: string;
  revision: number;
  values: EditValues;
  busy: boolean;
  invoiceLabels: Array<[string, string]>;
  staffPayLabels: Array<[string, string]>;
  onSelectJob: (jobId: string) => void;
  onUpdate: (key: string, value: string) => void;
  onSave: () => void;
};

export default function JobSafeEditPanel({
  jobs,
  staff,
  jobEditId,
  revision,
  values,
  busy,
  invoiceLabels,
  staffPayLabels,
  onSelectJob,
  onUpdate,
  onSave,
}: Props) {
  return (
    <section className="panel safe-edit-panel" id="job-safe-edit">
      <div className="section-heading">
        <div>
          <h2>案件の安全編集</h2>
          <p>スタッフ、基本情報、請求・支払の入力セルだけを変更します。合計・数式セルはロックされています。</p>
        </div>
        <strong>Revision {revision}</strong>
      </div>
      <div className="job-form-grid">
        <label>対象案件
          <select value={jobEditId} onChange={(event) => onSelectJob(event.target.value)}>
            {jobs.map((job) => <option key={job.id} value={job.id}>{job.workDate} {job.storeName}</option>)}
          </select>
        </label>
        <label>スタッフ
          <select value={values.assignedStaffId} onChange={(event) => onUpdate("assignedStaffId", event.target.value)}>
            <option value="">未手配</option>
            {staff.filter((profile) => profile.active !== false).map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.displayName}</option>
            ))}
          </select>
        </label>
        <label>クライアント<input value={values.clientName} onChange={(event) => onUpdate("clientName", event.target.value)} /></label>
        <label>店舗<input value={values.storeName} onChange={(event) => onUpdate("storeName", event.target.value)} /></label>
        <StoreLocationFields
          address={values.storeAddress}
          nearestStation={values.storeNearestStation}
          onAddressChange={(value) => onUpdate("storeAddress", value)}
          onNearestStationChange={(value) => onUpdate("storeNearestStation", value)}
        />
        <label>メーカー<input value={values.makerName} onChange={(event) => onUpdate("makerName", event.target.value)} /></label>
        <label>メニュー<input value={values.menuName} onChange={(event) => onUpdate("menuName", event.target.value)} /></label>
        <label>入店時間<input value={values.entryTime} onChange={(event) => onUpdate("entryTime", event.target.value)} /></label>
        <label>実施時間<input value={values.workTime} onChange={(event) => onUpdate("workTime", event.target.value)} /></label>
        <label>外注名<input value={values.subcontractorName} onChange={(event) => onUpdate("subcontractorName", event.target.value)} /></label>
      </div>
      <h3>請求側 S～Z</h3>
      <div className="money-grid">{invoiceLabels.map(([key, label]) => (
        <label key={key}>{label}<input inputMode="numeric" value={values[key]} onChange={(event) => onUpdate(key, event.target.value)} /></label>
      ))}</div>
      <h3>支払側 AB～AI</h3>
      <div className="money-grid">{staffPayLabels.map(([key, label]) => (
        <label key={key}>{label}<input inputMode="numeric" value={values[key]} onChange={(event) => onUpdate(key, event.target.value)} /></label>
      ))}</div>
      <div className="locked-note">🔒 AA・AJ・AR・BBなどの合計／数式セルは直接編集しません。</div>
      <div className="sync-actions"><button onClick={onSave} disabled={busy}>{busy ? "保存中…" : "入力セルだけ保存"}</button></div>
    </section>
  );
}
