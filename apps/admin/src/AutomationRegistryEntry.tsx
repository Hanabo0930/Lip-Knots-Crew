import NoticeHandoffPanel,{type NoticeHandoffApi} from "./NoticeHandoffPanel";
import {createNoticeHandoffDemo} from "./notice-handoff-demo";
import NoticeReportsPanel,{type NoticeReportsApi} from "./NoticeReportsPanel";
import {createNoticeReportsDemo} from "./notice-reports-demo";
import {useEffect,useRef,useState} from "react";

import {httpsCallable} from "firebase/functions";
import {auth,functions,firebaseConfigured} from "./firebase";
import AutomationRegistryPanel,{type RegistryApi,type RegistryChoices} from "./AutomationRegistryPanel";
import type {RegistryWrite} from "./automation-registry-attempt";
import HeldMailApplicationsPanel,{type HeldMailApi} from "./HeldMailApplicationsPanel";
import {createHeldMailDemo} from "./held-mail-demo";
import CampaignRegistrationPanel,{type CampaignApi} from "./CampaignRegistrationPanel";
import {createCampaignDemo,campaignDemoSample} from "./campaign-demo";
import ImportSnapshotPanel,{type ImportSnapshotApi} from "./ImportSnapshotPanel";
import {createImportSnapshotDemo,importSnapshotDemoTargets} from "./import-snapshot-demo";

type Scope={companyId:string;uid:string};
const demoScope={companyId:"demo-company",uid:"demo-registry-admin"};
const demoChoices:RegistryChoices={jobs:[{id:"demo-link-job",workDate:"2099-09-20",storeName:"連携確認用のデモ店舗"}],staff:[{id:"demo-link-staff",displayName:"連携確認用スタッフ",active:true}]};
function demoApi():RegistryApi{
  const records=new Map<string,unknown>(),events=new Map<string,{body:string;outcome:"committed"|"cancelled";revision?:string}>();
  const key=(row:{kind:string;jobId?:string;staffId?:string})=>row.kind+":"+(row.jobId??row.staffId??"");
  const perform=(input:RegistryWrite,cancel:boolean)=>{
    const previous=events.get(input.requestId),body=JSON.stringify(input);
    if(previous&&previous.body!==body)throw new Error("同じ操作番号の確認内容が異なります。");
    if(previous){
      if(cancel)return {ok:true,kind:input.kind,requestId:input.requestId,outcome:previous.outcome,revision:previous.revision};
      if(previous.outcome==="cancelled")throw new Error("この登録操作は中止されています。");
      return {ok:true,kind:input.kind,revision:previous.revision,duplicate:true};
    }
    if(cancel){events.set(input.requestId,{body,outcome:"cancelled"});return {ok:true,kind:input.kind,requestId:input.requestId,outcome:"cancelled"};}
    const revision=crypto.randomUUID();events.set(input.requestId,{body,outcome:"committed",revision});
    records.set(key(input),{...input,version:1,...demoScope,revision,noticeOwner:"notice_control"});
    return {ok:true,kind:input.kind,revision,duplicate:false};
  };
  return {
    read:async input=>({ok:true,kind:input.kind,record:records.get(key(input))??null,
      ...(input.kind==="person"?{source:{staffId:input.staffId,displayName:"連携確認用スタッフ",active:true}}:
      input.kind==="binding"?{source:{jobId:input.jobId,jobRevision:0,caseId:"demo-case",workDate:"2099-09-20",storeName:"連携確認用のデモ店舗",spreadsheetId:"demo-source",assignedStaffId:null}}:{})}),
    save:async input=>perform(input,false),cancel:async input=>perform(input,true),
  };
}
export default function AutomationRegistryEntry({jobs,staff,disabled=false,selectedJobId=""}:RegistryChoices&{disabled?:boolean;selectedJobId?:string}){
  const [open,setOpen]=useState<"registry"|"held"|"campaign"|"snapshot"|"notice"|"handoff"|null>(null),[scope,setScope]=useState<Scope|null>(null),[error,setError]=useState("");
  const scopeRef=useRef(scope);scopeRef.current=scope;

  const handoffOpener=useRef<HTMLButtonElement>(null),handoffDemo=useRef<NoticeHandoffApi|null>(null);if(!handoffDemo.current)handoffDemo.current=createNoticeHandoffDemo();
  const noticeOpener=useRef<HTMLButtonElement>(null),noticeDemo=useRef<NoticeReportsApi|null>(null);if(!noticeDemo.current)noticeDemo.current=createNoticeReportsDemo();
  const snapshotOpener=useRef<HTMLButtonElement>(null),snapshotDemo=useRef<ImportSnapshotApi|null>(null);if(!snapshotDemo.current)snapshotDemo.current=createImportSnapshotDemo();
  const campaignOpener=useRef<HTMLButtonElement>(null),campaignDemo=useRef<CampaignApi|null>(null);if(!campaignDemo.current)campaignDemo.current=createCampaignDemo();
  const opener=useRef<HTMLButtonElement>(null),heldOpener=useRef<HTMLButtonElement>(null),heldDemo=useRef<HeldMailApi|null>(null),demo=useRef<RegistryApi|null>(null);if(!demo.current)demo.current=demoApi();if(!heldDemo.current)heldDemo.current=createHeldMailDemo();
  useEffect(()=>{
    if(!open)return;
    let active=true,version=0;
    setScope(null);setError("");

    if(!firebaseConfigured){setScope(demoScope);return()=>{active=false;};}
    if(!auth){setError("ログインの準備を確認できません。画面を開き直してください。");return()=>{active=false;};}
    const unsubscribe=auth.onIdTokenChanged(async user=>{
      const ticket=++version;if(!user||scopeRef.current?.uid!==user.uid)setScope(null);setError("");
      if(!user){setError("連携台帳を確認するには管理者ログインが必要です。");return;}
      try{
        const token=await user.getIdTokenResult();
        if(!active||ticket!==version)return;
        if(token.claims.role!=="admin"||typeof token.claims.companyId!=="string")throw new Error("管理者の所属を確認できません。");
        const next={companyId:token.claims.companyId,uid:user.uid};
        setScope(current=>current?.companyId===next.companyId&&current.uid===next.uid?current:next);
      }catch(failure){if(active&&ticket===version){setScope(null);setError(failure instanceof Error?failure.message:"ログイン情報を確認できません。");}}
    });
    return()=>{active=false;version++;unsubscribe();};
  },[open]);
  function close(){const target=open==="handoff"?handoffOpener:open==="notice"?noticeOpener:open==="snapshot"?snapshotOpener:open==="campaign"?campaignOpener:open==="held"?heldOpener:opener;setOpen(null);requestAnimationFrame(()=>target.current?.focus());}
  const call=async(name:string,input:object)=>{
    if(!functions||!scope||auth?.currentUser?.uid!==scope.uid)throw new Error("ログイン情報が変更されています。台帳画面を開き直してください。");
    return (await httpsCallable(functions,name)({...input,expectedCompanyId:scope.companyId,expectedActorUid:scope.uid})).data;
  };
  const api:RegistryApi=firebaseConfigured?{read:input=>call("getAutomationRegistry",input),save:input=>call("saveAutomationRegistry",input),cancel:input=>call("cancelAutomationRegistryAttempt",input)}:demo.current;
  const heldApi:HeldMailApi=firebaseConfigured?{list:cursor=>call("listHeldMailApplications",cursor?{cursor}:{}),read:receiptKey=>call("getHeldMailApplication",{receiptKey}),review:input=>call("recheckHeldMailApplication",input),cancel:input=>call("cancelHeldMailApplicationReview",input)}:heldDemo.current;
  const campaignApi:CampaignApi=firebaseConfigured?{preview:campaign=>call("previewCaseMailCampaignRegistration",{campaign}),register:input=>call("registerCaseMailCampaign",input),cancel:input=>call("cancelCaseMailCampaignRegistration",input)}:campaignDemo.current;
  const snapshotApi:ImportSnapshotApi=firebaseConfigured?{read:targets=>call("getCaseMailImportSnapshot",{targets})}:snapshotDemo.current;
  const noticeApi:NoticeReportsApi=firebaseConfigured?{list:(jobId,cursor)=>call("listAutomationNoticeReceipts",{jobId,...(cursor?{cursor}:{})})}:noticeDemo.current;
  const handoffApi:NoticeHandoffApi=firebaseConfigured?{read:jobId=>call("getAutomationNoticeHandoff",{jobId})}:handoffDemo.current;
  const noticeJob=jobs.find(job=>job.id===selectedJobId);
  return <div className="registry-entry">
    <button ref={opener} className="ghost" onClick={()=>setOpen("registry")} disabled={disabled||Boolean(open)} aria-expanded={open==="registry"} aria-controls="automation-registry-panel">連携台帳を確認</button>
    <button ref={heldOpener} className="ghost" onClick={()=>setOpen("held")} disabled={disabled||Boolean(open)} aria-expanded={open==="held"} aria-controls="automation-registry-panel">保留応募を確認</button>
    <button ref={campaignOpener} className="ghost" onClick={()=>setOpen("campaign")} disabled={disabled||Boolean(open)} aria-expanded={open==="campaign"} aria-controls="automation-registry-panel">募集データを取り込む</button>
    <button ref={snapshotOpener} className="ghost" onClick={()=>setOpen("snapshot")} disabled={disabled||Boolean(open)} aria-expanded={open==="snapshot"} aria-controls="automation-registry-panel">アプリの照合データを取得</button>
    <button ref={noticeOpener} className="ghost" onClick={()=>setOpen("notice")} disabled={disabled||Boolean(open)||!selectedJobId} aria-expanded={open==="notice"} aria-controls="automation-registry-panel">出発・入店の連絡結果を確認</button>
    <button ref={handoffOpener} className="ghost" onClick={()=>setOpen("handoff")} disabled={disabled||Boolean(open)||!selectedJobId} aria-expanded={open==="handoff"} aria-controls="automation-registry-panel">出発・入店の連携データを取得</button>
    {open&&<div id="automation-registry-panel">
      {error?<div role="alert"><p>{error}</p><button className="ghost" onClick={close}>{open==="handoff"?"連携データを閉じる":open==="notice"?"連絡結果を閉じる":open==="snapshot"?"照合データを閉じる":open==="campaign"?"募集取込を閉じる":open==="held"?"保留応募を閉じる":"連携台帳を閉じる"}</button></div>:
        scope?(open==="handoff"?(selectedJobId?<NoticeHandoffPanel key={scope.companyId+":"+scope.uid+":"+selectedJobId} {...scope} jobId={selectedJobId} jobLabel={noticeJob?noticeJob.workDate+" "+noticeJob.storeName:selectedJobId} api={handoffApi} demo={!firebaseConfigured} onClose={close}/>:<div role="status"><p>対象案件を選択してください。</p><button onClick={close}>連携データを閉じる</button></div>):open==="notice"?(selectedJobId?<NoticeReportsPanel key={scope.companyId+":"+scope.uid+":"+selectedJobId} {...scope} jobId={selectedJobId} jobLabel={noticeJob?noticeJob.workDate+" "+noticeJob.storeName:selectedJobId} api={noticeApi} demo={!firebaseConfigured} onClose={close}/>:<div role="status"><p>対象案件を選択してください。</p><button onClick={close}>連絡結果を閉じる</button></div>):open==="snapshot"?<ImportSnapshotPanel key={scope.companyId+":"+scope.uid} {...scope} api={snapshotApi} demo={!firebaseConfigured} demoTargets={!firebaseConfigured?importSnapshotDemoTargets:undefined} onClose={close}/>:open==="campaign"?<CampaignRegistrationPanel key={scope.companyId+":"+scope.uid} {...scope} api={campaignApi} demo={!firebaseConfigured} demoSample={!firebaseConfigured?campaignDemoSample:undefined} onClose={close}/>:open==="held"?<HeldMailApplicationsPanel key={scope.companyId+":"+scope.uid} {...scope} api={heldApi} demo={!firebaseConfigured} onClose={close}/>:<AutomationRegistryPanel key={scope.companyId+":"+scope.uid} {...(firebaseConfigured?{jobs,staff}:demoChoices)} {...scope} api={api} demo={!firebaseConfigured} onClose={close}/>):
        <div role="status"><p>確認画面の準備を確認しています…</p><button className="ghost" onClick={close}>{open==="handoff"?"連携データを閉じる":open==="notice"?"連絡結果を閉じる":open==="snapshot"?"照合データを閉じる":open==="campaign"?"募集取込を閉じる":open==="held"?"保留応募を閉じる":"連携台帳を閉じる"}</button></div>}
    </div>}
  </div>;
}
