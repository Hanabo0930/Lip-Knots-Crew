import { useState } from "react";
import { httpsCallable, type Functions } from "firebase/functions";
import { auth } from "./firebase";

type Preview = { counts: { total: number; held: number; existingMonthlyLinks: number }; writes?: number; rows: Array<{ caseId: string; workDate: string; storeName: string; holdReasons: string[] }> };
export default function CaseListImportPanel({ functions, demo, onRefresh }: { functions: Functions | null; demo: boolean; onRefresh: (isCurrent: () => boolean) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false), [preview, setPreview] = useState<Preview | null>(null), [message, setMessage] = useState("");
  async function run(action: "preview" | "import" | "assignments") {
    if (!functions || demo) { setMessage("デモでは実際の案件リストを変更しません。"); return; }
    const activeUser = auth?.currentUser;
    if (!activeUser || busy) return;
    const current = () => auth?.currentUser === activeUser;
    if (action !== "preview" && !window.confirm(action === "assignments"
      ? "応募・月別連携を有効にします。社長が条件を確認した案件へスタッフが応募すると、案件リストの担当欄（C列）と月別シフトへ順に自動反映します。原本の読取照合が済むまで準備は確認待ちになります。"
      : "案件リストの連携を有効にし、アプリへ下書きとして取り込みます。既存の担当・シフト・手入力は保持します。")) return;
    setBusy(true); setMessage("");
    try {
      const response = await httpsCallable(functions, action === "preview" ? "previewShiftImport" : "syncShiftSheetsReadOnly")({
        source: "case-list", ...(action === "import" ? { enableCaseList: true } : {}), ...(action === "assignments" ? { enableCaseListAssignments: true } : {}),
      });
      const result = response.data as Preview;
      if (!current()) return;
      if (!result?.counts || !Array.isArray(result.rows)) throw new Error("読取結果を確認できません。もう一度確認してください。");
      setPreview(result);
      setMessage(action === "preview" ? "原本の読取を確認しました。公開時に月別へ反映できる条件も確認します。" : action === "assignments" ? "応募・月別連携を有効にしました。案件ごとの確認後に募集してください。応募後は原本へ自動反映し、照合が済むまで準備は確認待ちになります。" : "下書きとして取り込みました。募集条件を確認してから公開してください。");
      if (action !== "preview") await onRefresh(current);
    } catch (error) { if (current()) setMessage(error instanceof Error ? error.message : "案件リストを確認できません。"); }
    finally { if (current()) setBusy(false); }
  }
  return <section aria-label="案件リストの連携" aria-busy={busy}>
    <h3>案件リストから連携</h3>
    <p>案件リストを下書きとして取り込み、条件を確認した案件を募集できます。既に担当が決まっている案件は保留します。</p>
    <p>下書き取込は原本を変更しません。応募・月別連携を有効にすると、社長が募集条件を確認した案件への応募後に、案件リストの担当欄（C列）と月別シフトへ順に自動反映します。原本の読取照合が済むまで準備は確認待ちです。</p>
    <p className="locked-note">現在の対応範囲は2026年11月・12月の通常の単日1名枠です。複数日・グループ案件、研修・OJT・ラウンダー・出口調査・グレイス／グレースなどの特殊条件、対応月以外の案件は保留します。月別の日別行・集計行を確認できない場合も、原本を保持して停止します。</p>
    <div className="sync-actions"><button className="ghost" disabled={busy} onClick={() => void run("preview")}>案件リストを確認</button>
      <button disabled={busy} onClick={() => void run("import")}>連携を有効化・下書き取込</button>
      <button className="ghost" disabled={busy} onClick={() => void run("assignments")}>応募・月別連携を有効化</button></div>
    {message && <p role="status">{message}</p>}
    {preview && <><p>登録 {preview.counts.total}件／確認待ち {preview.counts.held}件／既存シフトとの対応あり {preview.counts.existingMonthlyLinks}件</p>
      <details><summary>読取結果を見る</summary><table><thead><tr><th>実施日</th><th>店舗</th><th>確認</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.caseId}><td>{row.workDate}</td><td>{row.storeName}</td><td>{row.holdReasons.length ? "条件・担当の確認待ち" : "公開前の確認が必要"}</td></tr>)}</tbody></table></details></>}
  </section>;
}
