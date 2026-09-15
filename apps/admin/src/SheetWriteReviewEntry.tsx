import {lazy,Suspense,useEffect,useRef,useState} from "react";
import {httpsCallable} from "firebase/functions";
import {auth,functions,firebaseConfigured} from "./firebase";
const SheetWriteReviewPanel=lazy(()=>import("./SheetWriteReviewPanel"));
import {createSheetReviewDemo,type SheetReviewApi} from "./sheet-write-review";

type Scope={companyId:string;uid:string;version:number};
export default function SheetWriteReviewEntry() {
  const [open,setOpen]=useState(false),[scope,setScope]=useState<Scope|null>(null),[error,setError]=useState("");
  const scopeRef=useRef(scope);scopeRef.current=scope;
  const opener=useRef<HTMLButtonElement>(null),demo=useRef<SheetReviewApi|null>(null);
  if(!demo.current)demo.current=createSheetReviewDemo();
  useEffect(()=>{
    if(!open)return;
    let active=true,version=0;
    scopeRef.current=null;setScope(null);setError("");
    if(!firebaseConfigured){setScope({companyId:"demo-company",uid:"demo-sheet-review",version:0});return()=>{active=false;scopeRef.current=null;};}
    if(!auth){setError("管理者ログインの準備を確認できません。");return;}
    const unsubscribe=auth.onIdTokenChanged(async user=>{
      const ticket=++version;
      // 同じUIDの所属変更でも、古い会社の結果を表示し続けない。
      scopeRef.current=null;setScope(null);setError("");
      if(!user){setError("保存記録の確認には管理者ログインが必要です。");return;}
      try {
        const token=await user.getIdTokenResult();
        if(!active||ticket!==version||auth?.currentUser!==user)return;
        if(token.claims.role!=="admin"||typeof token.claims.companyId!=="string"||!token.claims.companyId)throw Error("scope");
        const next={companyId:token.claims.companyId,uid:user.uid,version:ticket};
        scopeRef.current=next;setScope(next);
      } catch {
        if(active&&ticket===version){scopeRef.current=null;setScope(null);setError("管理者の所属を確認できません。画面を開き直してください。");}
      }
    });
    return()=>{active=false;version++;scopeRef.current=null;unsubscribe();};
  },[open]);
  function close(){scopeRef.current=null;setScope(null);setOpen(false);requestAnimationFrame(()=>opener.current?.focus());}
  const call:SheetReviewApi["read"]=async cursor=>{
    const user=auth?.currentUser;
    if(!functions||!scope||scopeRef.current!==scope||!user||user.uid!==scope.uid)throw Error("scope changed");
    const token=await user.getIdTokenResult();
    if(scopeRef.current!==scope||auth?.currentUser!==user||token.claims.role!=="admin"||token.claims.companyId!==scope.companyId)throw Error("scope changed");
    const result=await httpsCallable(functions,"listSheetWriteReviewRecords")({
      expectedCompanyId:scope.companyId,expectedActorUid:scope.uid,limit:50,...(cursor===undefined?{}:{cursor}),
    });
    if(scopeRef.current!==scope||auth?.currentUser!==user)throw Error("scope changed");
    return result.data;
  };
  return <div className="sheet-review-entry">
    <button ref={opener} className="ghost" disabled={open} aria-expanded={open} aria-controls="sheet-write-records" onClick={()=>setOpen(true)}>日時がない旧依頼も確認</button>
    {open&&<div id="sheet-write-records">
      {error?<div role="alert"><p>{error}</p><button onClick={close}>保存記録を閉じる</button></div>:
        scope?<Suspense fallback={<p role="status">保存記録の画面を準備しています…</p>}><SheetWriteReviewPanel key={scope.companyId+":"+scope.uid+":"+scope.version} {...scope} api={firebaseConfigured?{read:call}:demo.current} demo={!firebaseConfigured} onClose={close}/></Suspense>:
        <div role="status"><p>管理者の所属を確認しています…</p><button onClick={close}>保存記録を閉じる</button></div>}
    </div>}
  </div>;
}
