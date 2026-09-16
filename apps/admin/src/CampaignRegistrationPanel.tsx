import {useEffect,useRef,useState} from "react";
import {CAMPAIGN_FILE_LIMIT,parseCampaignText,campaignPreview,campaignRequest,campaignResult,campaignCancelResult,campaignOwner,
  loadCampaignAttempt,reserveCampaignAttempt,cancelCampaignAttempt,clearCampaignAttempt,
  type MailCampaign,type CampaignRequest,type CampaignPreview,type CampaignResult,type CampaignAttempt} from "./campaign-registration";
export type CampaignApi={preview:(campaign:MailCampaign)=>Promise<unknown>;register:(request:CampaignRequest)=>Promise<unknown>;cancel:(request:CampaignRequest)=>Promise<unknown>};
const messageOf=(error:unknown)=>error instanceof Error?error.message:"募集を確認できませんでした。もう一度お試しください。";
export default function CampaignRegistrationPanel({companyId,uid,api,demo=false,demoSample,initialCampaign,onClose}:{companyId:string;uid:string;api:CampaignApi;
  demo?:boolean;demoSample?:()=>Promise<MailCampaign>;initialCampaign?:MailCampaign;onClose:()=>void}){
  const owner=campaignOwner(companyId,uid),ownerRef=useRef(owner);ownerRef.current=owner;
  const apiRef=useRef(api);apiRef.current=api;
  const mounted=useRef(false),version=useRef(0),busyRef=useRef(false),heading=useRef<HTMLHeadingElement>(null),previewHeading=useRef<HTMLHeadingElement>(null);
  const [text,setText]=useState(initialCampaign?JSON.stringify(initialCampaign,null,2):""),[sourceName,setSourceName]=useState(initialCampaign?"取得した募集対象":""),[campaign,setCampaign]=useState<MailCampaign|null>(null),[preview,setPreview]=useState<CampaignPreview|null>(null);
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[initialized,setInitialized]=useState(false),[attempt,setAttempt]=useState<CampaignAttempt|null>(null);
  const [evidence,setEvidence]=useState(""),[confirmed,setConfirmed]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState(""),[result,setResult]=useState<CampaignResult|null>(null);
  const isCurrent=()=>mounted.current&&ownerRef.current===owner;
  function sync(){if(busyRef.current)return;try{const saved=loadCampaignAttempt(owner);setAttempt(current=>JSON.stringify(current)===JSON.stringify(saved)?current:saved);setInitialized(true);}
    catch(failure){setError(messageOf(failure));setInitialized(false);}}
  useEffect(()=>{
    mounted.current=true;heading.current?.focus();sync();
    const storage=(event:StorageEvent)=>{if(event.storageArea===localStorage&&(event.key===null||event.key==="lkc.campaignRegistrationAttempt.v1:"+owner))sync();};
    window.addEventListener("storage",storage);window.addEventListener("focus",sync);
    return()=>{mounted.current=false;version.current++;window.removeEventListener("storage",storage);window.removeEventListener("focus",sync);};
  },[owner]);
  useEffect(()=>{if(attempt){version.current++;setLoading(false);setPreview(null);setConfirmed(false);}},[attempt]);
  function resetPreview(){version.current++;setCampaign(null);setPreview(null);setConfirmed(false);setEvidence("");setLoading(false);setError("");setMessage("");setResult(null);}
  function updateText(value:string){resetPreview();setText(value);setSourceName("");}
  async function fileSelected(file?:File){
    if(!file||busyRef.current||attempt)return;resetPreview();setText("");setSourceName(file.name);
    const ticket=version.current;setLoading(true);
    try{if(file.size>CAMPAIGN_FILE_LIMIT)throw new Error("募集データが大きすぎます。256 KiB以下のファイルを選んでください。");
      const value=await file.text();if(!isCurrent()||ticket!==version.current)return;setText(value);
    }catch(failure){if(isCurrent()&&ticket===version.current)setError(messageOf(failure));}
    finally{if(isCurrent()&&ticket===version.current)setLoading(false);}
  }
  async function useSample(){
    if(!demoSample||busyRef.current||attempt)return;resetPreview();const ticket=version.current;setLoading(true);
    try{const sample=await demoSample();if(isCurrent()&&ticket===version.current){setText(JSON.stringify(sample,null,2));setSourceName("デモの募集データ");}}
    catch(failure){if(isCurrent()&&ticket===version.current)setError(messageOf(failure));}
    finally{if(isCurrent()&&ticket===version.current)setLoading(false);}
  }
  async function inspect(){
    if(busyRef.current||attempt||!initialized||loading||!text.trim())return;
    const ticket=++version.current;setLoading(true);setError("");setMessage("");setResult(null);setPreview(null);setConfirmed(false);setEvidence("");
    try{const parsed=await parseCampaignText(text,companyId);if(!isCurrent()||ticket!==version.current)return;
      const checked=campaignPreview(await apiRef.current.preview(parsed),parsed);
      if(!isCurrent()||ticket!==version.current)return;setCampaign(parsed);setPreview(checked);
      requestAnimationFrame(()=>{if(isCurrent()&&ticket===version.current)previewHeading.current?.focus();});
    }catch(failure){if(isCurrent()&&ticket===version.current)setError(messageOf(failure));}
    finally{if(isCurrent()&&ticket===version.current)setLoading(false);}
  }
  async function deliver(pending:CampaignAttempt){
    const response=pending.action==="cancel"?await apiRef.current.cancel(pending.request):await apiRef.current.register(pending.request);
    if(!isCurrent())return;
    const outcome=pending.action==="cancel"?campaignCancelResult(response,pending.request):{outcome:"committed" as const,result:campaignResult(response,pending.request.campaign)};
    setResult(outcome.result);
    setMessage((demo?"デモ：":"")+(outcome.outcome==="cancelled"?"未確定の募集登録を中止しました。原本と最新の状態を確認してから、取り込んでください。":
      "募集の原本確認記録を保存しました。メール送信の完了を示すものではありません。"));
    try{await clearCampaignAttempt(owner,pending.request.requestId,isCurrent);if(!isCurrent())return;
      const remaining=loadCampaignAttempt(owner);setAttempt(remaining);
      if(!remaining){version.current++;setPreview(null);setCampaign(null);setText("");setSourceName("");setEvidence("");setConfirmed(false);}
    }catch{if(isCurrent())setError("結果は確認済みですが、端末の確認記録を更新できません。同じ操作をもう一度確認してください。");}
  }
  async function register(){
    if(busyRef.current||attempt||!initialized||!campaign||!preview||preview.alreadyRegistered||!confirmed||loading)return;
    busyRef.current=true;setBusy(true);setError("");setMessage("");
    try{const request=campaignRequest({requestId:crypto.randomUUID(),expectedPrincipalRevision:preview.expectedPrincipalRevision,evidenceRecordId:evidence.trim(),confirmedAgainstSource:true,campaign});
      const saved=await reserveCampaignAttempt(owner,request,isCurrent);if(!saved||!isCurrent())return;setAttempt(saved.attempt);
      if(saved.created)await deliver(saved.attempt);else setMessage("前回の登録が残っています。同じ内容で結果を確認してください。");
    }catch(failure){if(isCurrent())setError(messageOf(failure));}
    finally{busyRef.current=false;if(isCurrent())setBusy(false);}
  }
  async function recover(cancel=false){
    if(busyRef.current||!attempt)return;busyRef.current=true;setBusy(true);setError("");setMessage("");
    try{const saved=cancel?await cancelCampaignAttempt(owner,attempt.request.requestId,isCurrent):loadCampaignAttempt(owner);
      if(!saved||!isCurrent())return;setAttempt(saved);await deliver(saved);
    }catch(failure){if(isCurrent())setError(messageOf(failure));}
    finally{busyRef.current=false;if(isCurrent())setBusy(false);}
  }
  const inactive=busy||Boolean(attempt)||!initialized;
  return <section className="campaign-panel" aria-label="募集データの取込確認">
    <header className="campaign-heading"><div><h2 ref={heading} tabIndex={-1}>募集データの取込確認</h2><p>案件メール側の連携用データを選び、アプリの案件と原本を確認して登録します。</p></div><button className="ghost" onClick={onClose}>募集取込を閉じる</button></header>
    {demo&&<p className="campaign-hint">デモの募集だけで操作を試せます。実際の募集やメールには反映しません。</p>}
    {message&&<p className="campaign-success" role="status">{message}</p>}
    {result&&<dl className="campaign-result"><dt>登録済み</dt><dd>{result.caseCount}枠</dd><dt>登録の確認版</dt><dd>{result.registrationRevision}</dd></dl>}
    {error&&<p className="campaign-error" role="alert">{error}</p>}
    {!initialized&&<button className="ghost" onClick={sync}>端末の確認記録を再読込</button>}
    {attempt?<div className="campaign-recovery" aria-busy={busy}>
      <h3>前回の募集登録を確認</h3><p>{attempt.action==="cancel"?"中止の確認が続いています。":"登録結果をまだ確認できていません。"}最初に保存した募集と確認資料で結果を確かめます。</p>
      <dl><dt>元の募集操作</dt><dd>{attempt.request.campaign.sourceOperationId}</dd><dt>対象</dt><dd>{attempt.request.campaign.area==="tohoku"?"東北":"通常"} · {attempt.request.campaign.cases.length}枠</dd><dt>確認資料</dt><dd>{attempt.request.evidenceRecordId}</dd></dl>
      <div className="campaign-actions"><button disabled={busy} onClick={()=>void recover()}>{busy?"結果を確認しています…":attempt.action==="cancel"?"同じ中止操作を再確認":"同じ募集登録の結果を確認"}</button>
        {attempt.action==="register"&&<button className="ghost" disabled={busy} onClick={()=>void recover(true)}>未確定なら中止する</button>}</div>
      <p className="campaign-hint">先に登録が完了していれば保存済みの結果を表示します。登録済みの募集を取り消す操作ではありません。</p>
    </div>:initialized&&<>
      <div className="campaign-input">
        <label>募集データのファイル<input type="file" accept=".json,application/json" disabled={inactive} onChange={event=>{void fileSelected(event.currentTarget.files?.[0]);event.currentTarget.value="";}}/></label>
        {sourceName&&<p className="campaign-source">{sourceName}</p>}
        <label>募集データを貼り付け<textarea aria-label="募集データを貼り付け" value={text} maxLength={CAMPAIGN_FILE_LIMIT} spellCheck={false} disabled={inactive} onChange={event=>updateText(event.target.value)} placeholder="連携用の募集データ（JSON形式）"/></label>
        <p className="campaign-hint">1回につき100枠・256 KiBまで。宛先や本文を推測して補うことはありません。まだ連携用データがない場合は、案件メール側での出力準備が必要です。</p>
        <div className="campaign-actions"><button disabled={inactive||loading||!text.trim()} onClick={()=>void inspect()}>{loading?"募集を確認しています…":"取込内容を確認"}</button>
          {demo&&demoSample&&<button className="ghost" disabled={inactive||loading} onClick={()=>void useSample()}>デモの募集データを使う</button>}</div>
      </div>
      {preview&&campaign&&<div className="campaign-preview">
        <h3 ref={previewHeading} tabIndex={-1}>{preview.alreadyRegistered?"登録済みの原本記録":"原本と照合する内容"}</h3>
        <dl><dt>元の募集操作</dt><dd>{campaign.sourceOperationId}</dd><dt>募集エリア</dt><dd>{campaign.area==="tohoku"?"東北":"通常"}</dd><dt>対象枠</dt><dd>{campaign.cases.length}枠</dd></dl>
        <p className="campaign-hint">{preview.alreadyRegistered?"同じ募集の原本確認は登録済みです。以下は保存された募集内容で、現在の募集可否を示すものではありません。":
          "アプリの現在の案件と一致しています。原本が正しいことの自動確認や、メール送信はまだ行っていません。元の募集と全枠を照合してください。"}</p>
        <ul className="campaign-cases">{preview.cases.map((row,index)=><li key={row.jobId}><strong>{index+1}. {row.workDate}{row.storeName?" · "+row.storeName:""}</strong>
          <dl><dt>固定ID</dt><dd>{row.fixedCaseId}</dd><dt>元表ID</dt><dd>{row.spreadsheetId}</dd><dt>アプリ案件ID</dt><dd>{row.appCaseId}</dd><dt>募集枠ID</dt><dd>{row.jobId}</dd></dl></li>)}</ul>
        {preview.alreadyRegistered?<p>確認資料：{preview.evidenceRecordId} · 登録の確認版：{preview.registeredResult?.registrationRevision}</p>:
          <form onSubmit={event=>{event.preventDefault();void register();}}>
            <label>確認資料の識別子<input value={evidence} maxLength={160} disabled={inactive} onChange={event=>{setEvidence(event.target.value);setConfirmed(false);}}/></label>
            <label className="campaign-confirm"><input type="checkbox" checked={confirmed} disabled={inactive} onChange={event=>setConfirmed(event.target.checked)}/>元の募集・全枠の勤務日・固定ID・対応する案件を原本で照合しました</label>
            <button type="submit" disabled={inactive||!confirmed||!evidence.trim()}>原本を照合して登録する</button>
          </form>}
      </div>}
    </>}
  </section>;
}
