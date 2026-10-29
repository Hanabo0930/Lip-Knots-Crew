import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { httpsCallable, type Functions } from "firebase/functions";
import { auth } from "./firebase";
import type { Job } from "./App";
import { parseRecruitmentDraft, recruitmentDraftCandidate, recruitmentDraftRequest, recruitmentSubjects, type RecruitmentDraft } from "./recruitment-draft";

export default function RecruitmentDraftPanel({ jobs, functions, demo }: { jobs: Job[]; functions: Functions | null; demo: boolean }) {
  const [ids, setIds] = useState<string[]>([]), [region, setRegion] = useState(""), [subject, setSubject] = useState<string>(recruitmentSubjects[0]), [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<RecruitmentDraft | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const runRef = useRef<object | null>(null), inputRef = useRef(""), generation = useRef(0);
  const candidates = jobs.filter(recruitmentDraftCandidate);
  const regions = [...new Set(candidates.map(job => job.region!))].sort();
  const catalogKey = JSON.stringify(candidates.map(job => [job.id, job.revision, job.caseListSource!.sourceRevision, job.region]).sort());
  const inputKey = JSON.stringify([catalogKey, ids, region, subject, notice]);
  inputRef.current = inputKey;
  function invalidate() { runRef.current = null; setBusy(false); setDraft(null); setMessage(""); }
  useEffect(() => {
    invalidate();
    setIds(current => current.filter(id => candidates.some(job => job.id === id && job.region === region)));
  }, [catalogKey]);
  useEffect(() => {
    if (!auth) return;
    const unsubscribe = onAuthStateChanged(auth, () => {
      generation.current++; runRef.current = null; setBusy(false); setDraft(null); setIds([]); setRegion(""); setNotice(""); setMessage("");
    });
    return () => { generation.current++; runRef.current = null; unsubscribe(); };
  }, []);
  async function runDraft(copy?: "subject" | "body") {
    if (runRef.current) return;
    if (!functions || demo) { setMessage("募集文の作成は、ログイン後に募集開始を確認した案件で利用できます。"); return; }
    const activeUser = auth?.currentUser;
    if (!activeUser) return;
    let request: ReturnType<typeof recruitmentDraftRequest>;
    try { request = recruitmentDraftRequest(jobs, ids, region, subject, notice); }
    catch (error) { setDraft(null); setMessage(error instanceof Error ? error.message : String(error)); return; }
    const run = {}, ticket = generation.current, capturedInput = inputKey;
    runRef.current = run; setBusy(true); setDraft(null); setMessage("");
    const current = () => runRef.current === run && generation.current === ticket && inputRef.current === capturedInput && auth?.currentUser === activeUser;
    try {
      const response = await httpsCallable(functions, "generateJobExport")(request);
      if (!current()) return;
      const result = parseRecruitmentDraft(response.data, request);
      setDraft(result);
      if (copy) {
        try {
          await navigator.clipboard.writeText(result[copy]);
          if (current()) setMessage(`現在の募集条件を再照合し、${copy === "subject" ? "件名" : "本文"}をコピーしました。`);
        } catch { if (current()) setMessage("コピーを完了できませんでした。表示中の件名・本文を選択して手動コピーしてください。"); }
      } else setMessage(`${result.caseCount}件の募集文を作成しました。コピー時に原本と募集状態をもう一度照合します。`);
    } catch (error) { if (current()) { setDraft(null); setMessage(error instanceof Error ? error.message : String(error)); } }
    finally { if (runRef.current === run) { runRef.current = null; setBusy(false); } }
  }
  return <details className="recruitment-draft-panel">
    <summary>募集メールを作成</summary>
    <section aria-label="募集メールの作成" aria-busy={busy}>
      <p>募集開始を確認した案件から、地域ごとに掲載対象を選びます。この選択は募集文の作成だけに使います。送信はご自身で行ってください。</p>
      <div className="export-controls">
        <label>募集地域<select value={region} disabled={busy} onChange={event => { invalidate(); setRegion(event.target.value); setIds([]); }}><option value="">選択してください</option>{regions.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>件名<select value={subject} disabled={busy} onChange={event => { invalidate(); setSubject(event.target.value); }}>{recruitmentSubjects.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>お知らせ<textarea value={notice} maxLength={4000} disabled={busy} onChange={event => { invalidate(); setNotice(event.target.value); }} /></label>
      </div>
      {!candidates.length && <p>掲載候補はありません。案件リストの状態・地域を確認し、案件の「募集開始」を完了してください。</p>}
      {region && <div className="table-wrap"><table><thead><tr><th>募集文に掲載</th><th>日付</th><th>店舗</th><th>メーカー・内容</th></tr></thead><tbody>{candidates.filter(job => job.region === region).map(job => <tr key={job.id}>
        <td><input type="checkbox" aria-label={`${job.workDate} ${job.storeName}を募集文に掲載`} checked={ids.includes(job.id)} disabled={busy || (!ids.includes(job.id) && ids.length >= 20)} onChange={event => { invalidate(); setIds(current => event.target.checked ? [...current, job.id] : current.filter(id => id !== job.id)); }} /></td>
        <td>{job.workDate}</td><td>{job.storeName}</td><td>{job.makerName} {job.menuName}</td>
      </tr>)}</tbody></table></div>}
      <div className="sync-actions"><button disabled={busy || !ids.length || !region} onClick={() => void runDraft()}>{busy ? "照合中…" : `${ids.length}件の募集文を作成`}</button></div>
      {message && <p role="status">{message}</p>}
      {draft && <div>
        <p>{draft.region}・{draft.caseCount}件／確認日時 {new Date(draft.validatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>
        <label>作成した件名<input readOnly value={draft.subject} /></label><button className="ghost" disabled={busy} onClick={() => void runDraft("subject")}>再照合して件名をコピー</button>
        <label>作成した本文<textarea readOnly rows={16} value={draft.body} /></label><button className="ghost" disabled={busy} onClick={() => void runDraft("body")}>再照合して本文をコピー</button>
      </div>}
    </section>
  </details>;
}
