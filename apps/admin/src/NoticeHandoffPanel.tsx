import {useEffect,useLayoutEffect,useRef,useState} from "react";
import {handoffStatusLabels,handoffContactLabels,handoffContactReasons,noticeHandoffResult,type NoticeHandoffResult} from "./notice-handoff";
export type NoticeHandoffApi={read:(jobId:string)=>Promise<unknown>};
export default function NoticeHandoffPanel({companyId,uid,jobId,jobLabel,api,demo=false,onClose}:{companyId:string;uid:string;jobId:string;jobLabel:string;api:NoticeHandoffApi;demo?:boolean;onClose:()=>void}){
 const owner=companyId+":"+uid+":"+jobId,ownerRef=useRef(owner);ownerRef.current=owner;
 const apiRef=useRef(api);apiRef.current=api;
 const mounted=useRef(false),version=useRef(0),busy=useRef(false),heading=useRef<HTMLHeadingElement>(null),resultHeading=useRef<HTMLHeadingElement>(null);
 const [result,setResult]=useState<NoticeHandoffResult|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
 const focusPending=useRef<{owner:string;ticket:number}|null>(null);
 const isCurrent=()=>mounted.current&&ownerRef.current===owner;
 useLayoutEffect(()=>{const pending=focusPending.current;if(result&&pending&&pending.owner===owner&&pending.ticket===version.current&&isCurrent()){focusPending.current=null;resultHeading.current?.focus();}},[result,owner]);
 async function read(focus=false){
  if(busy.current)return;busy.current=true;const ticket=++version.current;setLoading(true);setResult(null);setError("");setMessage("");
  try{const value=await noticeHandoffResult(await apiRef.current.read(jobId),companyId,jobId);
   if(!isCurrent()||ticket!==version.current)return;focusPending.current=focus?{owner,ticket}:null;setResult(value);
  }catch(failure){if(isCurrent()&&ticket===version.current)setError(failure instanceof Error?failure.message:"連携データを取得できませんでした。もう一度お試しください。");}
  finally{if(isCurrent()&&ticket===version.current){busy.current=false;setLoading(false);}}
 }
 useEffect(()=>{mounted.current=true;heading.current?.focus();void read();return()=>{mounted.current=false;version.current++;busy.current=false;};},[owner]);
 function download(){
  if(!isCurrent()||loading||!result)return;setError("");setMessage("");
  try{const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)+"\n"],{type:"application/json;charset=utf-8"})),link=document.createElement("a");
   link.href=url;link.download="notice-handoff-"+jobId.slice(0,48).replace(/[^A-Za-z0-9_.-]/g,"_")+"-"+result.handoff.operationKey.slice(0,12)+".json";
   try{link.click();setMessage("連携データの保存を開始しました。保存先でファイルを確認してください。");}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
  }catch{setError("連携データの保存を開始できませんでした。もう一度「連携データを保存」を押してください。");}
 }
 const contact=result?.handoff.preContact;
 return <section className="campaign-panel notice-handoff" aria-label="出発・入店の連携データ">
  <header className="campaign-heading"><div><h2 ref={heading} tabIndex={-1}>出発・入店の連携データ</h2><p>{jobLabel||jobId}</p></div><button className="ghost" onClick={onClose}>連携データを閉じる</button></header>
  {demo&&<p className="campaign-hint">デモの案件と本人入力です。実際の案件や連絡先には接続しません。</p>}
  <p className="campaign-hint">現在の案件と本人の事前連絡を、連携先へ渡すファイルにまとめます。メールの配信・到達や、本人の出発・入店は未確認です。</p>
  <div className="campaign-actions"><button disabled={loading} onClick={()=>void read(true)}>{loading?"連携データを確認しています…":"最新の状態を再取得"}</button></div>
  {loading&&<p role="status">選択した案件と現在の担当を確認しています。</p>}
  {error&&<div className="campaign-error" role="alert"><p>{error}</p>{!result&&<p>対象案件を保持しています。「最新の状態を再取得」で確認してください。</p>}</div>}
  {message&&<p className="campaign-success" role="status">{message}</p>}
  {result&&<div className="campaign-preview notice-handoff-result">
   <h3 ref={resultHeading} tabIndex={-1}>取得した案件と事前連絡</h3>
   <div className="handoff-facts"><div><span>案件の状態</span><strong>{handoffStatusLabels[result.handoff.status]}</strong></div><div><span>勤務日</span><strong>{result.handoff.binding.workDate}</strong></div></div>
   <div className={"handoff-contact handoff-contact-"+result.preContactState}>
    <h4>{handoffContactLabels[result.preContactState]}</h4><p>{handoffContactReasons[result.preContactState]}</p>
    {contact&&<dl><dt>体温</dt><dd>{contact.temperature}℃</dd><dt>到着予定</dt><dd>{contact.arrivalTime}</dd><dt>本人の入力日時</dt><dd>{new Date(contact.submittedAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",hour12:false})}（日本時間）</dd></dl>}
    {result.sheetSyncPending&&<p className="campaign-hint">アプリには保存済みです。シフト表への反映は未確認です。</p>}
   </div>
   <dl><dt>案件の固定ID</dt><dd>{result.handoff.binding.fixedCaseId}</dd></dl>
   <details><summary>照合用の記録番号</summary><dl><dt>アプリ案件ID</dt><dd>{result.handoff.binding.appCaseId}</dd><dt>勤務枠ID</dt><dd>{jobId}</dd><dt>担当の対応版</dt><dd>{result.handoff.binding.revision}</dd><dt>連携データの版</dt><dd>{result.handoff.revision}</dd><dt>連携操作</dt><dd>{result.handoff.operationKey}</dd></dl></details>
   <p className="campaign-hint">取得時点の状態です。担当や入力が変わった場合は再取得してください。ファイルには担当の照合に必要な非公開情報を含むため、連携先への受け渡しに使ってください。</p>
   <button onClick={download} disabled={loading}>連携データを保存</button>
  </div>}
 </section>;
}
