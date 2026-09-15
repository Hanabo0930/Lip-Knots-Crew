import {useEffect,useLayoutEffect,useRef,useState} from "react";
import {IMPORT_TARGET_LIMIT,parseImportTargetsText,appImportSnapshotResult,type ImportTargets,type ImportSnapshotResult} from "./import-snapshot";
export type ImportSnapshotApi={read:(targets:ImportTargets)=>Promise<unknown>};
const messageOf=(failure:unknown)=>failure instanceof Error?failure.message:"照合データを取得できませんでした。もう一度お試しください。";
export default function ImportSnapshotPanel({companyId,uid,api,demo=false,demoTargets,onClose}:{companyId:string;uid:string;api:ImportSnapshotApi;demo?:boolean;demoTargets?:ImportTargets;onClose:()=>void}){
 const owner=companyId+":"+uid,ownerRef=useRef(owner);ownerRef.current=owner;
 const apiRef=useRef(api);apiRef.current=api;
 const mounted=useRef(false),version=useRef(0),reading=useRef(false),heading=useRef<HTMLHeadingElement>(null),resultHeading=useRef<HTMLHeadingElement>(null);
 const [text,setText]=useState(""),[filename,setFilename]=useState(""),[loading,setLoading]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
 const [targets,setTargets]=useState<ImportTargets|null>(null),[result,setResult]=useState<ImportSnapshotResult|null>(null);
 const focusPending=useRef<{owner:string;ticket:number}|null>(null);
 const isCurrent=()=>mounted.current&&ownerRef.current===owner;
 useLayoutEffect(()=>{const pending=focusPending.current;if(result&&pending&&pending.owner===owner&&pending.ticket===version.current&&isCurrent()){focusPending.current=null;resultHeading.current?.focus();}},[result,owner]);
 useEffect(()=>{mounted.current=true;heading.current?.focus();return()=>{mounted.current=false;version.current++;};},[owner]);
 function invalidate(){version.current++;reading.current=false;setTargets(null);setResult(null);setLoading(false);setError("");setMessage("");}
 async function selectFile(file?:File){
  if(!file)return;invalidate();setText("");setFilename(file.name);const ticket=version.current;setLoading(true);
  try{if(file.size>IMPORT_TARGET_LIMIT)throw new Error("募集対象のファイルは256 KiB以下にしてください。");const input=await file.text();
   if(isCurrent()&&ticket===version.current)setText(input);
  }catch(failure){if(isCurrent()&&ticket===version.current)setError(messageOf(failure));}
  finally{if(isCurrent()&&ticket===version.current){reading.current=false;setLoading(false);}}
 }
 async function read(){
  if(reading.current||loading||!text.trim())return;reading.current=true;const ticket=++version.current;setLoading(true);setError("");setMessage("");setResult(null);setTargets(null);
  try{const selected=parseImportTargetsText(text,companyId),loaded=appImportSnapshotResult(await apiRef.current.read(selected),selected);
   if(!isCurrent()||ticket!==version.current)return;focusPending.current={owner,ticket};setTargets(selected);setResult(loaded);

  }catch(failure){if(isCurrent()&&ticket===version.current)setError(messageOf(failure));}
  finally{if(isCurrent()&&ticket===version.current){reading.current=false;setLoading(false);}}
 }
 function download(){
  if(!isCurrent()||loading||!result||!targets)return;setError("");setMessage("");
  try{const url=URL.createObjectURL(new Blob([JSON.stringify(result.snapshot,null,2)+"\n"],{type:"application/json;charset=utf-8"})),link=document.createElement("a");
   link.href=url;link.download="app-import-"+targets.sourceOperationId.slice(0,48).replace(/[^A-Za-z0-9_.-]/g,"_")+".json";
   try{link.click();setMessage("照合データの保存を開始しました。保存したファイルを募集データの生成に使ってください。");}
   finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
  }catch(failure){setError(messageOf(failure));}
 }
 return <section className="campaign-panel" aria-label="アプリの照合データ">
  <header className="campaign-heading"><div><h2 ref={heading} tabIndex={-1}>アプリの照合データ</h2><p>募集対象の固定IDから、現在のアプリ案件と受付設定を読み取ります。</p></div><button className="ghost" onClick={onClose}>照合データを閉じる</button></header>
  {demo&&<p className="campaign-hint">デモの対応記録だけを使います。実際の案件や台帳へは接続しません。</p>}
  {error&&<p className="campaign-error" role="alert">{error}</p>}{message&&<p className="campaign-success" role="status">{message}</p>}
  <div className="campaign-input">
   <label>募集対象のファイル<input type="file" accept=".json,application/json" onChange={event=>{void selectFile(event.currentTarget.files?.[0]);event.currentTarget.value="";}}/></label>
   {filename&&<p className="campaign-source">{filename}</p>}
   <label>募集対象データ<textarea aria-label="募集対象データ" value={text} maxLength={IMPORT_TARGET_LIMIT} spellCheck={false} onChange={event=>{invalidate();setText(event.target.value);setFilename("");}} placeholder="連携用のtargets.json"/></label>
   <p className="campaign-hint">先に案件メール側の募集案から作ったtargets.jsonを選びます。本文・宛先やログイン情報をここへ貼り付けないでください。</p>
   <div className="campaign-actions"><button disabled={loading||!text.trim()} onClick={()=>void read()}>{loading?"現在の対応を確認しています…":"現在の照合データを取得"}</button>
    {demo&&demoTargets&&<button className="ghost" disabled={loading} onClick={()=>{invalidate();setText(JSON.stringify(demoTargets,null,2));setFilename("デモの募集対象");}}>デモの募集対象を使う</button>}</div>
  </div>
  {result&&targets&&<div className="campaign-preview">
   <h3 ref={resultHeading} tabIndex={-1}>取得した案件対応</h3>
   <dl><dt>元の募集操作</dt><dd>{targets.sourceOperationId}</dd><dt>地域・対象</dt><dd>{targets.area==="tohoku"?"東北":"通常"} · {targets.cases.length}枠</dd>
    <dt>取得時刻（日本時間）</dt><dd>{new Date(result.snapshot.capturedAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",hour12:false})}</dd></dl>
   <ul className="campaign-cases">{result.summary.map(row=><li key={row.jobId}><strong>{row.workDate}{row.storeName?" · "+row.storeName:""}</strong><dl><dt>固定ID</dt><dd>{row.fixedCaseId}</dd><dt>アプリ案件ID</dt><dd>{row.appCaseId}</dd><dt>募集枠ID</dt><dd>{row.jobId}</dd></dl></li>)}</ul>
   <p className="campaign-hint">取得時点の照合データです。保存したファイルを元の募集案と合わせて募集データへ変換し、「募集データを取り込む」で原本を確認して登録します。</p>
   <button onClick={download} disabled={loading}>アプリの照合データを保存</button>
  </div>}
 </section>;
}
