import AutomationRegistryEntry from "./AutomationRegistryEntry";
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
  jobs: Array<{ id: string; workDate: string; storeName: string; pendingSourceWrite?: boolean; caseListSource?: unknown }>;
  staff: Array<{ id: string; displayName: string; active?: boolean }>;
  jobEditId: string;
  revision: number;
  values: EditValues;
  busy: boolean;
  dirty: boolean;
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
  dirty,
  invoiceLabels,
  staffPayLabels,
  onSelectJob,
  onUpdate,
  onSave,
}: Props) {
  const selectedJob = jobs.find(job => job.id === jobEditId);
  const caseListJob = Boolean(selectedJob?.caseListSource);
  return (
    <section className="panel safe-edit-panel" id="job-safe-edit">
      <div className="section-heading">
        <div>
          <h2>案件の安全編集</h2>
          <p>{caseListJob ? "案件リスト連携では、住所と最寄駅だけをアプリへ保存できます。担当・業務条件・金額はここでは変更できません。" : "変更した項目だけを保存します。原本への反映は、案件と変更前の内容を確認してから行います。"}</p>
        </div>
        <strong>保存版 {revision}</strong>
      </div>
      {caseListJob&&<p className="locked-note" id="case-list-edit-hold" role="status">担当・業務条件・金額は原本との照合が必要なため、元の値を保持しています。住所と最寄駅の変更はアプリだけに保存します。</p>}
      {selectedJob?.pendingSourceWrite===true&&(
        <p className="locked-note" role="status">アプリに保存済みです。シフト表への反映は確認待ちです。</p>
      )}
      <div className="job-form-grid">
        <label>対象案件
          <select aria-label="編集対象案件" value={jobEditId} onChange={(event) => onSelectJob(event.target.value)}>
            {jobs.map((job) => <option key={job.id} value={job.id}>{job.workDate} {job.storeName}</option>)}
          </select>
        </label>
        <label>スタッフ
          <select value={values.assignedStaffId} disabled={caseListJob} aria-describedby={caseListJob?"case-list-edit-hold":undefined} onChange={(event) => onUpdate("assignedStaffId", event.target.value)}>
            <option value="">未手配</option>
            {staff.filter((profile) => profile.active !== false).map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.displayName}</option>
            ))}
          </select>
        </label>
        <label>クライアント<input value={values.clientName} disabled={caseListJob} aria-describedby={caseListJob?"case-list-edit-hold":undefined} onChange={(event) => onUpdate("clientName", event.target.value)} /></label>
        <label>店舗<input value={values.storeName} disabled={caseListJob} aria-describedby={caseListJob?"case-list-edit-hold":undefined} onChange={(event) => onUpdate("storeName", event.target.value)} /></label>
        <StoreLocationFields
          address={values.storeAddress}
          nearestStation={values.storeNearestStation}
          onAddressChange={(value) => onUpdate("storeAddress", value)}
          onNearestStationChange={(value) => onUpdate("storeNearestStation", value)}
        />
        <label>メーカー<input value={values.makerName} disabled={caseListJob} aria-describedby={caseListJob?"case-list-edit-hold":undefined} onChange={(event) => onUpdate("makerName", event.target.value)} /></label>
        <label>メニュー<input value={values.menuName} disabled={caseListJob} aria-describedby={caseListJob?"case-list-edit-hold":undefined} onChange={(event) => onUpdate("menuName", event.target.value)} /></label>
        <label>入店時間<input value={values.entryTime} disabled={caseListJob} aria-describedby={caseListJob?"case-list-edit-hold":undefined} onChange={(event) => onUpdate("entryTime", event.target.value)} /></label>
        <label>実施時間<input value={values.workTime} disabled={caseListJob} aria-describedby={caseListJob?"case-list-edit-hold":undefined} onChange={(event) => onUpdate("workTime", event.target.value)} /></label>
        <label>外注名<input value={values.subcontractorName} disabled={caseListJob} aria-describedby={caseListJob?"case-list-edit-hold":undefined} onChange={(event) => onUpdate("subcontractorName", event.target.value)} /></label>
      </div>
      <h3>請求の入力項目</h3>
      <div className="money-grid">{invoiceLabels.map(([key, label]) => (
        <label key={key}>{label}<input inputMode="numeric" value={values[key]} disabled={caseListJob} aria-describedby={caseListJob?"case-list-edit-hold":undefined} onChange={(event) => onUpdate(key, event.target.value)} /></label>
      ))}</div>
      <h3>支払の入力項目</h3>
      <div className="money-grid">{staffPayLabels.map(([key, label]) => (
        <label key={key}>{label}<input inputMode="numeric" value={values[key]} disabled={caseListJob} aria-describedby={caseListJob?"case-list-edit-hold":undefined} onChange={(event) => onUpdate(key, event.target.value)} /></label>
      ))}</div>
      <div className="locked-note">{caseListJob ? "案件リスト連携の金額は、月別タブを読取同期して確認した値を使います。この画面では金額を変更できません。" : "合計金額は原本の内容を使います。保存中の追加入力は、そのまま続けて編集できます。"}</div>
      <div className="sync-actions"><button onClick={onSave} disabled={busy||!dirty||!jobEditId}>{busy ? "保存中…" : dirty ? "変更を保存" : "変更はありません"}</button><span role="status" aria-live="polite">{busy?"保存結果を確認しています。":dirty?"未保存の変更があります。":"表示中の内容に変更はありません。"}</span></div>
      <AutomationRegistryEntry jobs={jobs} staff={staff} disabled={busy||caseListJob} selectedJobId={jobEditId}/>
    </section>
  );
}
