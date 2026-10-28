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
      ? "応募・月別連携を有効にします。名前入力や応募だけでは月別へ移しません。クライアントへのネームアップ後、概要の「書戻しの確認」で社長が対象案件を選択した場合だけ月別へ転記します。"
      : "案件リストを読み取り、未手配は下書きへ、照合できた手入力の手配は確認待ちへ取り込みます。既存の担当・シフト・手入力は保持し、この取込では原本を変更しません。")) return;
    setBusy(true); setMessage("");
    try {
      const response = await httpsCallable(functions, action === "preview" ? "previewShiftImport" : "syncShiftSheetsReadOnly")({
        source: "case-list", ...(action === "import" ? { enableCaseList: true } : {}), ...(action === "assignments" ? { enableCaseListAssignments: true } : {}),
      });
      const result = response.data as Preview;
      if (!current()) return;
      if (!result?.counts || !Array.isArray(result.rows)) throw new Error("読取結果を確認できません。もう一度確認してください。");
      setPreview(result);
      setMessage(action === "preview" ? "原本の読取を確認しました。" : action === "assignments" ? "応募・月別連携を有効にしました。月別転記はネームアップ後、概要の「書戻しの確認」で対象を選択してください。" : "案件を取り込みました。未手配は募集条件を確認し、手入力の手配はネームアップ後に対象を選択してください。");
      if (action !== "preview") await onRefresh(current);
    } catch (error) { if (current()) setMessage(error instanceof Error ? error.message : "案件リストを確認できません。"); }
    finally { if (current()) setBusy(false); }
  }
  return <section aria-label="案件リストの連携" aria-busy={busy}>
    <h3>案件リストから連携</h3>
    <p>未手配は下書きへ、スタッフ名を照合できた手入力の手配は確認待ちへ取り込みます。照合できない担当や既存シフトとの重複は保留します。</p>
    <p>名前入力・応募 → クライアントへネームアップ → 概要の「書戻しの確認」で対象を選択 → 月別へ転記・照合、の順です。取消チェックは転記選択には使いません。</p>
    <p>対応範囲は2026年11月・12月の通常の単日1名枠です。複数日・グループ、研修・OJT・ラウンダー・出口調査・グレイス／グレース、未対応の金額条件・対象月外は保留します。</p>
    <div className="sync-actions"><button className="ghost" disabled={busy} onClick={() => void run("preview")}>案件リストを確認</button>
      <button disabled={busy} onClick={() => void run("import")}>連携を有効化・案件を取込</button>
      <button className="ghost" disabled={busy} onClick={() => void run("assignments")}>応募・月別連携を有効化</button></div>
    {message && <p role="status">{message}</p>}
    {preview && <><p>登録 {preview.counts.total}件／確認待ち {preview.counts.held}件／既存シフトとの対応あり {preview.counts.existingMonthlyLinks}件</p>
      <details><summary>読取結果を見る</summary><table><thead><tr><th>実施日</th><th>店舗</th><th>確認</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.caseId}><td>{row.workDate}</td><td>{row.storeName}</td><td>{row.holdReasons.length ? "条件・担当の確認待ち" : "公開前の確認が必要"}</td></tr>)}</tbody></table></details></>}
  </section>;
}
