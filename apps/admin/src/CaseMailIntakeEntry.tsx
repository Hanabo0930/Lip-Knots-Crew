import { useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { auth, functions, firebaseConfigured } from "./firebase";
import CaseMailIntakePanel from "./CaseMailIntakePanel";
import type { MailApi } from "./case-mail-review";
type Scope = { companyId: string; uid: string };
export default function CaseMailIntakeEntry({ onCreated, onReviewJob }: { onCreated: () => void; onReviewJob: (jobId:string,action:"edit"|"cancel")=>void }) {
  const [open, setOpen] = useState(false), [scope, setScope] = useState<Scope | null>(null), [error, setError] = useState("");
  const current = useRef<Scope | null>(null), opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true, ticket = 0;
    if (!firebaseConfigured) { const demo = { companyId: "demo-company", uid: "demo-admin" }; current.current = demo; setScope(demo); return () => { current.current = null; }; }
    if (!auth) { setError("管理者ログインを確認できません。"); return; }
    const unsubscribe = auth.onIdTokenChanged(async user => {
      const version = ++ticket; current.current = null; setScope(null); setError("");
      if (!user) { setError("管理者としてログインしてください。"); return; }
      try {
        const token = await user.getIdTokenResult();
        if (!alive || ticket !== version) return;
        if (token.claims.role !== "admin" || typeof token.claims.companyId !== "string") throw Error("管理者の所属を確認できません。");
        const next = { companyId: token.claims.companyId, uid: user.uid }; current.current = next; setScope(next);
      } catch { if (alive && ticket === version) setError("管理者の所属を確認できません。ログインし直してください。"); }
    });
    return () => { alive = false; ticket++; current.current = null; unsubscribe(); };
  }, [open]);
  const call = async (name: string, input: object) => {
    if (!scope || current.current !== scope || auth?.currentUser?.uid !== scope.uid || !functions) throw Error("ログイン情報が変更されています。画面を開き直してください。");
    const result = (await httpsCallable(functions, name)({ ...input, expectedCompanyId: scope.companyId, expectedActorUid: scope.uid })).data;
    if (current.current !== scope || auth?.currentUser?.uid !== scope.uid) throw Error("ログイン情報が変更されています。");
    return result;
  };
  const api: MailApi = firebaseConfigured ? {
    list: cursor => call("listCaseMailReceipts", cursor ? { cursor } : {}),
    read: receiptId => call("getCaseMailReceipt", { receiptId }),
    create: command => call("createAdminJobGroup", command),
    confirm: command => call("confirmCaseMailReview", command),
    previewTarget: command => call("getCaseMailTargetPreview", command),
    confirmTarget: command => call("confirmCaseMailTarget", command),
    holdTarget: command => call("holdCaseMailTarget", command),
    resolveTarget: command => call("resolveCaseMailTargetHold", command),
  } : { list: async () => ({ ok: true, items: [], nextCursor: null }), read: async () => { throw Error("デモでは受信していません。"); },
    create: async () => { throw Error("デモでは案件作成できません。"); } };
  function close() { current.current = null; setOpen(false); setScope(null); requestAnimationFrame(() => opener.current?.focus()); }
  return <section className="panel">
    <h2>メールから届いた案件</h2><p>受信した内容を確認して、1名分ずつ下書きに登録します。</p>
    <button ref={opener} className="ghost" disabled={open} onClick={() => setOpen(true)} aria-expanded={open}>受信候補を確認</button>
    {open && (scope ? <CaseMailIntakePanel key={scope.companyId + ":" + scope.uid} {...scope} api={api} onClose={close} onCreated={onCreated} onReviewJob={onReviewJob} demo={!firebaseConfigured}/> :
      <div role={error ? "alert" : "status"}><p>{error || "ログイン情報を確認しています…"}</p><button className="ghost" onClick={close}>受信候補を閉じる</button></div>)}
  </section>;
}
