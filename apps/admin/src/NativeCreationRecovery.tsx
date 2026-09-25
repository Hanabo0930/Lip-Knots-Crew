import { useEffect, useRef, useState } from "react";
import { auth } from "./firebase";
import { nativeAttemptEvent, readNativeAttempt, NativeAttempt, NativeOwner } from "./native-creation-retry";
import { submitNativeCreation } from "./native-creation-client";

export default function NativeCreationRecovery() {
  const [owner, setOwner] = useState<NativeOwner | null>(null);
  const [attempt, setAttempt] = useState<NativeAttempt | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0), running = useRef(false);
  useEffect(() => {
    if (!auth) return;
    let alive = true;
    const unsubscribe = auth.onIdTokenChanged(async user => {
      const ticket = ++generation.current;
      setOwner(null); setAttempt(null); setMessage(""); setBusy(false); running.current = false;
      if (!user) return;
      try {
        const token = await user.getIdTokenResult();
        if (alive && ticket === generation.current && token.claims.role === "admin" && typeof token.claims.companyId === "string" && token.claims.companyId)
          setOwner({ uid: user.uid, companyId: token.claims.companyId });
      } catch { if (alive && ticket === generation.current) setMessage("ログイン状態を確認できません。再ログインしてください。"); }
    });
    return () => { alive = false; generation.current++; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!owner) return;
    const update = () => {
      try { setAttempt(readNativeAttempt(window.localStorage, owner)); }
      catch (error) { setAttempt(null); setMessage(error instanceof Error ? error.message : String(error)); }
    };
    update(); window.addEventListener("storage", update); window.addEventListener(nativeAttemptEvent, update);
    return () => { window.removeEventListener("storage", update); window.removeEventListener(nativeAttemptEvent, update); };
  }, [owner]);
  async function recover(cancel: boolean) {
    if (!owner || !attempt || attempt.owner.companyId !== owner.companyId || attempt.owner.uid !== owner.uid || running.current) return;
    if (cancel && !window.confirm("未完了の作成依頼を取り消します。すでに作成済みの場合は、取り消さず作成結果を確認します。")) return;
    const ticket = generation.current, current = () => generation.current === ticket;
    running.current = true; setBusy(true); setMessage("");
    try {
      const result = await submitNativeCreation(undefined, current, cancel, owner);
      if (!result || !current()) return;
      setMessage(result.nativeCreationReceipt.status === "cancelled" ? "未完了の作成依頼を取り消しました。内容を直して作成できます。" : `${result.jobIds!.length}件の作成済み案件を確認しました。「一覧を再読込」で表示を更新してください。`);
    } catch (error) { if (current()) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (current()) { running.current = false; setBusy(false); } }
  }
  const visibleAttempt = owner && attempt?.owner.companyId === owner.companyId && attempt.owner.uid === owner.uid ? attempt : null;
  if (!visibleAttempt && !message) return null;
  return <section className="panel" aria-label="作成依頼の確認">
    <h3>作成依頼の確認</h3>
    {visibleAttempt && <><p>{visibleAttempt.kind === "duplicate" ? "複製" : "新規作成"}：{String(visibleAttempt.input.workDate ?? "元の実施日")}・{String(visibleAttempt.input.slots ?? 1)}名分。結果を確認するまで、次の作成はお待ちください。</p>
      <div className="sync-actions"><button disabled={busy} onClick={() => void recover(false)}>{busy ? "確認中…" : "作成結果を確認"}</button><button className="ghost" disabled={busy} onClick={() => void recover(true)}>未完了なら取り消す</button></div></>}
    {message && <p role="status">{message}</p>}
  </section>;
}
