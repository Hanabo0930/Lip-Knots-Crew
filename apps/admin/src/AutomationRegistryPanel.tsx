import {useEffect,useRef,useState} from "react";
import {clearRegistryAttempt,loadRegistryAttempt,markRegistryCancellation,registryCancellationResult,registryOwner,
  registrySaveResult,reserveRegistryAttempt,type RegistryAttempt,type RegistryWrite,type RegistryKind} from "./automation-registry-attempt";
import {parseRegistryView,prepareRegistryWrite,registryForm,registryReadInput,registrySelection,
  type RegistryForm,type RegistrySelection,type RegistryView} from "./automation-registry-view";

export type RegistryApi={read:(input:ReturnType<typeof registryReadInput>)=>Promise<unknown>;
  save:(input:RegistryWrite)=>Promise<unknown>;cancel:(input:RegistryWrite)=>Promise<unknown>};
export type RegistryChoices={jobs:Array<{id:string;workDate:string;storeName:string}>;
  staff:Array<{id:string;displayName:string;active?:boolean}>};
const labels:Record<RegistryKind,string>={binding:"案件の対応",person:"スタッフの本人対応",routing:"応募の受付窓口",principal:"連携する実行者"};
const kinds:RegistryKind[]=["binding","person","routing","principal"];
const emptyForm:RegistryForm={evidenceRecordId:"",confirmed:false,producerId:"",active:true,phase:"mail_bridge",
  sourceStopped:false,oldRepliesRetained:false,personKey:"",fixedCaseId:"",proofEpoch:""};
export default function AutomationRegistryPanel({companyId,uid,jobs,staff,api,demo=false,onClose}:RegistryChoices&{
  companyId:string;uid:string;api:RegistryApi;demo?:boolean;onClose:()=>void;
}){
  const owner=registryOwner(companyId,uid);
  const [selection,setSelection]=useState<RegistrySelection>({kind:jobs.length?"binding":"principal",targetId:jobs[0]?.id??""});
  const [view,setView]=useState<RegistryView|null>(null),[assignedPerson,setAssignedPerson]=useState<RegistryView|null>(null);
  const [form,setForm]=useState<RegistryForm>(emptyForm),[attempt,setAttempt]=useState<RegistryAttempt|null>(null);
  const [hydrated,setHydrated]=useState(false),[status,setStatus]=useState<"loading"|"ready"|"error">("loading");
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
  const [reload,setReload]=useState(0);
  const mounted=useRef(false),version=useRef(0),busyRef=useRef(false),heading=useRef<HTMLHeadingElement>(null);
  const apiRef=useRef(api);apiRef.current=api;
  const ownerRef=useRef(owner);ownerRef.current=owner;
  const isCurrent=()=>mounted.current&&ownerRef.current===owner;
  function syncAttempt(){
    if(busyRef.current)return;
    try{
      const saved=loadRegistryAttempt(owner);
      setAttempt(current=>JSON.stringify(current)===JSON.stringify(saved)?current:saved);
      if(saved)setSelection(current=>{const next=registrySelection(saved.request);return current.kind===next.kind&&current.targetId===next.targetId?current:next;});
      setHydrated(true);
    }catch(failure){setError(failure instanceof Error?failure.message:"前回の登録記録を読み込めません。");setHydrated(false);setStatus("error");}
  }
  useEffect(()=>{
    mounted.current=true;heading.current?.focus();syncAttempt();
    const storage=(event:StorageEvent)=>{if(event.storageArea===localStorage&&(event.key===null||event.key==="lkc.registryAttempt.v1:"+owner))syncAttempt();};
    window.addEventListener("storage",storage);window.addEventListener("focus",syncAttempt);
    return()=>{mounted.current=false;version.current++;window.removeEventListener("storage",storage);window.removeEventListener("focus",syncAttempt);};
  },[owner]);
  async function refresh(){
    if(!hydrated||attempt)return;
    const ticket=++version.current,selected={...selection};
    setStatus("loading");setError("");setView(null);setAssignedPerson(null);
    try{
      const loaded=parseRegistryView(await apiRef.current.read(registryReadInput(selected)),selected,{companyId,uid});
      if(!isCurrent()||ticket!==version.current)return;
      let person:RegistryView|null=null;
      if(loaded.kind==="binding"&&loaded.source?.assignedStaffId){
        const target:RegistrySelection={kind:"person",targetId:loaded.source.assignedStaffId};
        person=parseRegistryView(await apiRef.current.read(registryReadInput(target)),target,{companyId,uid});
      }
      if(!isCurrent()||ticket!==version.current)return;
      setView(loaded);setAssignedPerson(person);setForm(registryForm(loaded));setStatus("ready");
    }catch(failure){if(isCurrent()&&ticket===version.current){setError(failure instanceof Error?failure.message:"現在の登録を確認できません。");setStatus("error");}}
  }
  useEffect(()=>{if(hydrated&&!attempt)void refresh();else if(attempt){version.current++;setView(null);setAssignedPerson(null);setStatus("ready");}},[hydrated,selection.kind,selection.targetId,attempt,reload]);
  function choose(kind:RegistryKind,targetId=kind==="binding"?jobs[0]?.id??"":kind==="person"?staff[0]?.id??"":""){
    if(busyRef.current||attempt)return;version.current++;setSelection({kind,targetId});setMessage("");setError("");
  }
  function edit<K extends keyof RegistryForm>(key:K,value:RegistryForm[K]){
    setForm(current=>({...current,[key]:value,...(key!=="confirmed"?{confirmed:false}:{})}));
  }
  async function deliver(pending:RegistryAttempt){
    const result=pending.action==="cancel"?await apiRef.current.cancel(pending.request):await apiRef.current.save(pending.request);
    if(!isCurrent())return;
    const outcome=pending.action==="cancel"?registryCancellationResult(result,pending).outcome:(registrySaveResult(result,pending),"committed");
    const notice=outcome==="cancelled"?"未確定の登録を中止しました。最新の情報を確認してから、必要な内容を登録してください。":
      demo?"デモ：登録結果を確認しました。実際の台帳へは送信していません。":"連携台帳への登録を確認しました。実行元やメール送信の設定は別途確認してください。";
    setMessage(notice);
    try{
      await clearRegistryAttempt(owner,pending.request.requestId,isCurrent);
      if(!isCurrent())return;
      const remaining=loadRegistryAttempt(owner);setAttempt(remaining);if(!remaining)setReload(value=>value+1);
      if(remaining)setSelection(registrySelection(remaining.request));
    }catch{
      if(isCurrent())setError("結果は確認済みですが、端末の確認記録を更新できません。もう一度同じ操作の結果を確認してください。");
    }
  }
  async function save(){
    if(busyRef.current||!hydrated||attempt||status!=="ready"||!view)return;
    busyRef.current=true;setBusy(true);setError("");setMessage("");
    try{
      const prepared=prepareRegistryWrite(view,form,crypto.randomUUID(),assignedPerson);
      const reserved=await reserveRegistryAttempt(owner,()=>prepared,isCurrent);
      if(!reserved||!isCurrent())return;
      setAttempt(reserved.attempt);
      if(!reserved.created){setSelection(registrySelection(reserved.attempt.request));setMessage("前回の登録結果が未確認です。先に結果を確認してください。");return;}
      await deliver(reserved.attempt);
    }catch(failure){if(isCurrent())setError(failure instanceof Error?failure.message:"登録結果を確認できません。");}
    finally{if(isCurrent()){busyRef.current=false;setBusy(false);}}
  }
  async function recover(cancel=false){
    if(busyRef.current||!attempt)return;
    busyRef.current=true;setBusy(true);setError("");setMessage("");
    try{
      const pending=cancel?await markRegistryCancellation(owner,attempt.request.requestId,isCurrent):loadRegistryAttempt(owner);
      if(!pending||!isCurrent()){if(isCurrent()){setAttempt(null);setMessage("登録記録が更新されています。最新の状態を確認してください。");}return;}
      setAttempt(pending);await deliver(pending);
    }catch(failure){if(isCurrent())setError(failure instanceof Error?failure.message:"前回の操作結果を確認できません。");}
    finally{if(isCurrent()){busyRef.current=false;setBusy(false);}}
  }
  const disabled=busy||Boolean(attempt)||!hydrated;
  return <section className="panel automation-registry" aria-label="自動化との連携台帳" aria-busy={busy||status==="loading"}>
    <div className="section-heading"><div><h2 ref={heading} tabIndex={-1}>自動化との連携台帳</h2><p>別の自動化ツールと、アプリの案件・スタッフを照合して登録します。</p></div><button className="ghost" onClick={onClose} disabled={busy}>連携台帳を閉じる</button></div>
    <p className="locked-note">確認資料と原本を照合した管理者の記録です。この画面の登録だけで、メール送信や出発・入店連絡は開始されません。</p>
    {message&&<p role="status" className="registry-result">{message}</p>}
    {error&&<div role="alert" className="registry-error"><p>{error}</p>{!hydrated&&<button className="ghost" onClick={syncAttempt}>端末の確認記録を再読込</button>}</div>}
    {attempt?<div className="registry-pending">
      <h3>{attempt.action==="cancel"?"中止の結果を確認":"前回の登録結果を確認"}</h3>
      <dl><dt>登録内容</dt><dd>{labels[attempt.request.kind]}</dd><dt>対象</dt><dd>{attempt.request.jobId??attempt.request.staffId??"この会社・ログイン中の管理者"}</dd><dt>確認資料</dt><dd>{attempt.request.evidenceRecordId}</dd></dl>
      <p>送信した内容を保持しています。結果を確認してから、次の登録へ進めます。</p>
      <details><summary>送信した照合内容</summary><pre>{JSON.stringify(attempt.request,null,2)}</pre></details>
      <div className="registry-actions"><button onClick={()=>void recover()} disabled={busy}>{busy?"結果を確認中…":attempt.action==="cancel"?"中止の結果を再確認":"登録結果を再確認"}</button>
        {attempt.action==="save"&&<button className="ghost" onClick={()=>void recover(true)} disabled={busy}>未確定の登録を中止して確認</button>}</div>
      <p>すでに保存されていた場合は保存結果を返します。登録済みの台帳を取り消す操作ではありません。</p>
    </div>:<>
      <div className="registry-selectors"><label>確認する内容<select aria-label="連携台帳の種類" value={selection.kind} onChange={event=>choose(event.target.value as RegistryKind)} disabled={disabled}>
        {kinds.map(kind=><option key={kind} value={kind}>{labels[kind]}</option>)}</select></label>
        {selection.kind==="binding"&&<label>対象案件<select aria-label="連携する案件" value={selection.targetId} onChange={event=>choose("binding",event.target.value)} disabled={disabled}><option value="">案件を選択</option>{jobs.map(job=><option key={job.id} value={job.id}>{job.workDate} {job.storeName}</option>)}</select></label>}
        {selection.kind==="person"&&<label>対象スタッフ<select aria-label="連携するスタッフ" value={selection.targetId} onChange={event=>choose("person",event.target.value)} disabled={disabled}><option value="">スタッフを選択</option>{staff.map(person=><option key={person.id} value={person.id}>{person.displayName}{person.active===false?"（利用停止中）":""}</option>)}</select></label>}
        <button className="ghost" onClick={()=>void refresh()} disabled={disabled||status==="loading"}>現在の登録を再読込</button></div>
      {status==="loading"&&<p role="status">現在の登録と対象情報を確認しています…</p>}
      {status==="ready"&&view&&<div className="registry-form">
        <p className="registry-current">{view.record?"登録済みの内容を表示しています。":"この対象はまだ登録されていません。"}</p>
        {view.source&&<dl><dt>アプリの対象</dt><dd>{view.source.name||"名称確認中"}</dd>
          {selection.kind==="binding"&&<><dt>勤務日</dt><dd>{view.source.workDate||"未確認"}</dd><dt>アプリの案件番号</dt><dd>{view.source.caseId||"未確認"}</dd><dt>参照元の表</dt><dd>{demo?"デモの参照元（実原本なし）":view.source.spreadsheetId?<a href={"https://docs.google.com/spreadsheets/d/"+view.source.spreadsheetId} target="_blank" rel="noreferrer">原本を開いて確認</a>:"未確認"}</dd><dt>担当者</dt><dd>{view.source.assignedStaffId?assignedPerson?.source?.name||"本人対応を確認してください":"未手配"}</dd></>}
        </dl>}
        {selection.kind==="principal"&&<><p>ログイン中の管理者を、指定した実行元の受信者として登録します。</p><label>実行元の識別子<input value={form.producerId} onChange={event=>edit("producerId",event.target.value)} disabled={disabled||Boolean(view.record)} maxLength={160}/></label></>}
        {selection.kind==="routing"&&<><label>応募の受付窓口<select aria-label="応募の受付窓口" value={form.phase} onChange={event=>edit("phase",event.target.value as RegistryForm["phase"])} disabled={disabled||view.record?.phase==="app"}><option value="mail_bridge">従来のメール窓口</option><option value="app">アプリで確認・確定</option></select></label>
          {form.phase==="app"&&<><label className="registry-check"><input type="checkbox" checked={form.sourceStopped} onChange={event=>edit("sourceStopped",event.target.checked)} disabled={disabled}/>元ツールの新規募集作成を停止したことを確認しました</label><label className="registry-check"><input type="checkbox" checked={form.oldRepliesRetained} onChange={event=>edit("oldRepliesRetained",event.target.checked)} disabled={disabled}/>過去の募集メールへの返信を引き続き回収できることを確認しました</label></>}</>}
        {selection.kind==="person"&&<label>外部の本人照合ID<input value={form.personKey} onChange={event=>edit("personKey",event.target.value)} disabled={disabled} maxLength={64}/><small>外部ツールで確認した64桁の識別子を使います。メールアドレスや氏名からこの画面で作りません。</small></label>}
        {(selection.kind==="person"||selection.kind==="principal")&&<label className="registry-check"><input type="checkbox" checked={form.active} onChange={event=>edit("active",event.target.checked)} disabled={disabled}/>この対応を有効にする</label>}
        {selection.kind==="binding"&&<><label>外部側の案件固定ID<input value={form.fixedCaseId} onChange={event=>edit("fixedCaseId",event.target.value)} disabled={disabled||Boolean(view.record)} maxLength={160}/></label>
          {view.source?.assignedStaffId&&<label>現在の本人入力証跡の識別子<input value={form.proofEpoch} onChange={event=>edit("proofEpoch",event.target.value)} disabled={disabled} maxLength={160}/><small>確定担当者の最新の入力証跡と照合してください。</small></label>}</>}
        <label>確認資料の識別子<input value={form.evidenceRecordId} onChange={event=>edit("evidenceRecordId",event.target.value)} disabled={disabled} maxLength={160}/><small>どの資料・原本で照合したかを、後から確認できる識別子で残します。</small></label>
        <label className="registry-check"><input type="checkbox" checked={form.confirmed} onChange={event=>edit("confirmed",event.target.checked)} disabled={disabled}/>表示中の対象・入力内容を原本と確認資料で照合しました</label>
        <button onClick={()=>void save()} disabled={disabled||!form.confirmed}>{busy?"登録結果を確認中…":"照合した内容を登録"}</button>
      </div>}
    </>}
  </section>;
}
