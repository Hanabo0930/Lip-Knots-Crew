import { CSSProperties, useEffect, useMemo, useState } from "react";
import {
  getIdTokenResult, isSignInWithEmailLink, onAuthStateChanged,
  signInWithEmailLink, signOut, User,
} from "firebase/auth";
import { collection, doc, getDocs, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { ref, uploadBytesResumable } from "firebase/storage";
import { auth, db, firebaseConfigured, functions, storage } from "./firebase";
import { clearDraft, loadDraft, saveDraft } from "./draft-store";
import {
  currentPushPermission, disablePushNotifications, enablePushNotifications,
  listenForForegroundPush, loadServerPushStatus, requestTestPush,
} from "./push";

type View = "home" | "jobs" | "shifts" | "submit" | "contact";
type SubmissionType = "report" | "sales_floor";
type NetPrintItem = { id: string; number: string; printed?: boolean };
type Job = {
  id: string; workDate: string; dateKey: string; clientName: string; makerName: string;
  menuName: string; storeName: string; workTime: string; basePay: number; status: string;
  storeAddress?: string; storeNearestStation?: string; materialStatus?: string;
  assignedStaffId?: string; preContact?: { temperature?: string; arrivalTime?: string };
  netPrint?: { items?: NetPrintItem[] };
  submissionStatus?: { report?: { completed?: boolean }; salesFloor?: { completed?: boolean; clientSubmitted?: boolean; lipKnotsSubmitted?: boolean } };
};
type StaffTask = { id:string; jobId:string; kind:string; title:string; body:string; priority:"overdue"|"urgent"|"normal"; metadata?:Record<string,unknown> };
type DeviceSession = { id:string; label?:string; platform?:string; active?:boolean; lastSeenAt?:string };
type SubmissionFileView = { id:string; submissionId:string; originalName:string; driveName:string; contentType:string; sequence:number|null; purpose:string; status:string; previewUrl:string|null; completedAt:string|null; replacesFileId:string|null };
type SubmissionGroup = { id:string; purpose:string; status:string; createdAt:string|null; completedAt:string|null; files:SubmissionFileView[] };
type ResubmissionDetail = { request:{id:string;jobId:string;type:SubmissionType;reasons:string[];note:string;status:string}; source:SubmissionFileView|null; replacements:SubmissionFileView[] };

const demoJobs: Job[] = [{
  id:"demo_job_1", workDate:"7/20（日）", dateKey:"2026-07-20", clientName:"〇〇デモ",
  makerName:"〇〇乳業", menuName:"ヨーグルト試食（50代まで歓迎）", storeName:"イオン船橋店",
  workTime:"10:00〜18:00", basePay:10000, status:"assigned",
  storeAddress:"千葉県船橋市山手1丁目1-8", storeNearestStation:"新船橋駅", materialStatus:"発送準備中",
  netPrint:{items:[{id:"np1",number:"1234-5678",printed:false}]}, submissionStatus:{},
}];
const demoTasks: StaffTask[] = [
  {id:"t1",jobId:"demo_job_1",kind:"precontact",title:"事前連絡を送ってください",body:"イオン船橋店 / 前日15:00まで",priority:"urgent"},
  {id:"t2",jobId:"demo_job_1",kind:"netprint",title:"ネットプリントを印刷してください",body:"未印刷 1件",priority:"normal"},
  {id:"t3",jobId:"demo_job_1",kind:"resubmission",title:"報告書を再送してください",body:"手ブレで文字が読めません",priority:"urgent",metadata:{requestId:"demo_request",type:"report"}},
];

function getOrCreateDeviceId(){ const k="lkcDeviceId"; const v=localStorage.getItem(k); if(v)return v; const n=crypto.randomUUID(); localStorage.setItem(k,n); return n; }
function deviceLabel(){ return `${/iPhone|iPad|Android/i.test(navigator.userAgent)?"モバイル":"PC"} / ${navigator.platform||"端末"}`; }
const JOB_ACCENTS=["#d56f91","#5d91c9","#5aa583","#d28a46","#8a76c7","#bf6d62","#3e9ba4","#9b7a56"];
function jobAccent(menuName:string){let hash=0;for(const char of menuName||"案件")hash=((hash*31)+char.codePointAt(0)!)|0;return JOB_ACCENTS[Math.abs(hash)%JOB_ACCENTS.length]??JOB_ACCENTS[0];}
function jobKind(menuName:string){return menuName.replace(/[（(].*$/u,"").trim()||"案件";}
function mapDestination(job:Job){return [job.storeName,job.storeAddress].filter(Boolean).join(" ");}
function mapsSearchUrl(job:Job){return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapDestination(job))}`;}
function transitRouteUrl(job:Job){return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(mapDestination(job))}&travelmode=transit`;}
function stationSearchUrl(job:Job){return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.storeNearestStation??"")}`;}
function prepSummary(job:Job){const items=job.netPrint?.items??[];const printed=items.filter(item=>item.printed).length;if(job.materialStatus)return job.materialStatus;if(!items.length)return"資料番号待ち";return printed===items.length?`準備完了（${printed}/${items.length}件）`:`準備中（${printed}/${items.length}件印刷済み）`;}

export default function App(){
  const [user,setUser]=useState<User|null>(null); const [staffId,setStaffId]=useState("");
  const [email,setEmail]=useState(localStorage.getItem("lkcEmail")??""); const [message,setMessage]=useState("");
  const [view,setView]=useState<View>("home"); const [openJobs,setOpenJobs]=useState<Job[]>(firebaseConfigured?[]:demoJobs);
  const [myJobs,setMyJobs]=useState<Job[]>(firebaseConfigured?[]:demoJobs); const [tasks,setTasks]=useState<StaffTask[]>(firebaseConfigured?[]:demoTasks);
  const [selectedJob,setSelectedJob]=useState<Job|null>(demoJobs[0]??null); const [temperature,setTemperature]=useState("36.2"); const [arrivalTime,setArrivalTime]=useState("9:30");
  const [submissionType,setSubmissionType]=useState<SubmissionType>("report"); const [requestId,setRequestId]=useState("");
  const [submissionConfirmed,setSubmissionConfirmed]=useState(false);
  const [files,setFiles]=useState<File[]>([]); const [uploadState,setUploadState]=useState<Record<string,string>>({});
  const [deviceSessionId,setDeviceSessionId]=useState(""); const [devices,setDevices]=useState<DeviceSession[]>([]); const [showDevices,setShowDevices]=useState(false);
  const [pushEnabled,setPushEnabled]=useState(false); const [pushBusy,setPushBusy]=useState(false);
  const [submissionHistory,setSubmissionHistory]=useState<SubmissionGroup[]>([]);
  const [resubmissionDetail,setResubmissionDetail]=useState<ResubmissionDetail|null>(null);

  const draftKey=selectedJob?`${selectedJob.id}_${submissionType}_${requestId||"normal"}`:"";
  useEffect(()=>{ if(!draftKey)return; void loadDraft(draftKey).then(setFiles).catch(()=>undefined); },[draftKey]);
  useEffect(()=>{ if(!draftKey)return; const timer=setTimeout(()=>void saveDraft(draftKey,files),300); return()=>clearTimeout(timer); },[draftKey,files]);

  useEffect(()=>{ if(!auth)return; return onAuthStateChanged(auth,async current=>{
    setUser(current); if(!current||!functions)return;
    const bootstrap=httpsCallable(functions,"bootstrapSession"); const result=await bootstrap();
    if((result.data as {refreshToken?:boolean}).refreshToken)await current.getIdToken(true);
    const token=await getIdTokenResult(current); const sid=String(token.claims.staffId??""); setStaffId(sid);
    const sessionId=await registerCurrentDevice(); if(sessionId)watchDeviceSession(sessionId);
    setPushEnabled(await loadServerPushStatus(functions)); await loadAll(sid);
  }); },[]);
  useEffect(()=>{ if(!auth||!isSignInWithEmailLink(auth,window.location.href))return; const saved=localStorage.getItem("lkcEmail")??window.prompt("メールアドレスを入力してください")??""; if(!saved)return; void signInWithEmailLink(auth,saved,window.location.href).then(()=>{window.history.replaceState({},document.title,"/");setMessage("ログインしました。");}).catch((e:Error)=>setMessage(e.message)); },[]);
  useEffect(()=>{ if(!user)return; let unsub:(()=>void)|null=null; void listenForForegroundPush(payload=>setMessage(`${payload.data?.title??"Lip Knots Crew"}：${payload.data?.body??"新しいお知らせがあります。"}`)).then(v=>unsub=v); return()=>unsub?.(); },[user]);

  async function loadAll(sid=staffId){ await Promise.all([loadOpenJobs(),loadMyJobs(sid),loadTasks()]); }
  async function loadOpenJobs(){ if(!db)return; const snap=await getDocs(query(collection(db,"jobs"),where("companyId","==","lipknots"),where("status","==","open"),orderBy("dateKey","asc"),limit(100))); setOpenJobs(snap.docs.map(d=>({id:d.id,...d.data()} as Job))); }
  async function loadMyJobs(sid:string){ if(!db||!sid)return; const snap=await getDocs(query(collection(db,"jobs"),where("companyId","==","lipknots"),where("assignedStaffId","==",sid),orderBy("dateKey","asc"),limit(300))); const values=snap.docs.map(d=>({id:d.id,...d.data()} as Job)); setMyJobs(values); if(!selectedJob&&values[0])setSelectedJob(values[0]); }
  async function loadTasks(){ if(!functions)return; const c=httpsCallable(functions,"getMyTasks"); const r=await c({}); setTasks((r.data as {tasks?:StaffTask[]}).tasks??[]); }
  async function requestLogin(){ if(!email)return; localStorage.setItem("lkcEmail",email); if(!firebaseConfigured){setMessage("デモ：ログインメールを送りました。");return;} if(!functions)return; const c=httpsCallable(functions,"requestStaffLoginLink"); const r=await c({email}); setMessage((r.data as {message?:string}).message??"ログインメールを送信しました。"); }
  async function registerCurrentDevice(){ if(!functions)return""; const c=httpsCallable(functions,"registerDeviceSession"); const r=await c({deviceId:getOrCreateDeviceId(),label:deviceLabel(),platform:navigator.platform||"",userAgent:navigator.userAgent}); const id=String((r.data as {sessionId?:string}).sessionId??""); setDeviceSessionId(id); return id; }
  function watchDeviceSession(id:string){ if(!db||!auth)return; const active=auth; return onSnapshot(doc(db,"deviceSessions",id),async s=>{if(s.exists()&&s.data().active===false){setMessage("この端末はログアウトされました。");await signOut(active);}}); }
  async function loadDevices(){ if(!firebaseConfigured){setDevices([{id:"current",label:deviceLabel(),active:true},{id:"old",label:"以前のiPhone",active:true}]);setShowDevices(true);return;} if(!functions)return; const r=await httpsCallable(functions,"listMyDevices")({}); setDevices((r.data as {devices?:DeviceSession[]}).devices??[]);setShowDevices(true); }
  async function revokeDevice(id:string){ if(!confirm("この端末をログアウトしますか？"))return; if(!functions){setDevices(v=>v.map(x=>x.id===id?{...x,active:false}:x));return;} await httpsCallable(functions,"revokeMyDevice")({sessionId:id}); await loadDevices(); if(id===deviceSessionId&&auth)await signOut(auth); }
  async function enablePush(){ if(!functions){setPushEnabled(true);return;} setPushBusy(true);try{const r=await enablePushNotifications(functions,deviceSessionId);setPushEnabled(r.enabled);setMessage(r.message);}finally{setPushBusy(false);} }
  async function disablePush(){ if(!functions){setPushEnabled(false);return;} await disablePushNotifications(functions);setPushEnabled(false); }
  async function apply(job:Job){ if(!firebaseConfigured){setMessage("デモ：応募が確定しました。");setOpenJobs(v=>v.filter(x=>x.id!==job.id));return;} if(!functions)return; await httpsCallable(functions,"applyToJob")({jobId:job.id,requestId:crypto.randomUUID()});setMessage("応募が確定しました。");await loadAll(); }
  async function submitPreContact(){ if(!selectedJob)return; if(!functions){setMessage("デモ：事前連絡を送信しました。");return;} await httpsCallable(functions,"submitPreContact")({jobId:selectedJob.id,temperature:Number(temperature),arrivalTime});setMessage("事前連絡を送信しました。");await loadAll(); }
  async function markPrinted(item:NetPrintItem){ if(!selectedJob)return; if(!functions){setMessage("デモ：印刷済みにしました。");return;} await httpsCallable(functions,"markNetPrintPrinted")({jobId:selectedJob.id,itemId:item.id});setMessage("印刷済みにしました。");await loadAll(); }
  async function setClientSubmitted(value:boolean){ if(!selectedJob)return; if(!functions){setMessage("デモ：直提出を更新しました。");return;} await httpsCallable(functions,"setSalesFloorClientSubmitted")({jobId:selectedJob.id,submitted:value});setMessage(value?"クライアント提出済みにしました。":"クライアント提出を解除しました。");await loadAll(); }
  async function openTask(task:StaffTask){ const job=myJobs.find(j=>j.id===task.jobId)??selectedJob; if(job)setSelectedJob(job); if(task.kind==="precontact"){setView("shifts");return;} if(task.kind==="netprint"){setView("shifts");return;} const type=task.kind==="sales_floor"?"sales_floor":"report"; const req=String(task.metadata?.requestId??""); setSubmissionType(type);setRequestId(req);setSubmissionConfirmed(false); if(job)await loadSubmissionHistory(job.id,type); if(req)await loadResubmissionDetail(req); else setResubmissionDetail(null);setView("submit"); }
  async function uploadSubmission(){ if(!selectedJob||!files.length||!submissionConfirmed)return; const typeLabel=submissionType==="report"?"報告書":"売場画像";if(!window.confirm(`${typeLabel}として${files.length}件を送信します。種類と画像に間違いはありませんか？`))return; if(!firebaseConfigured){setUploadState(Object.fromEntries(files.map(f=>[f.name,"送信済み"])));setMessage(`デモ：${typeLabel}を送信しました。`);setSubmissionConfirmed(false);return;} if(!functions||!storage)return; const activeStorage=storage; const purpose=requestId?"replacement":"additional"; const r=await httpsCallable(functions,"createUploadSession")({jobId:selectedJob.id,type:submissionType,purpose,resubmissionRequestId:requestId||undefined,files:files.map(f=>({originalName:f.name,contentType:f.type||"application/octet-stream",size:f.size}))}); const data=r.data as {files:{storagePath:string}[]}; const state:Record<string,string>={}; for(let i=0;i<data.files.length;i++){const target=data.files[i],file=files[i];if(!target||!file)continue;state[file.name]="送信中";setUploadState({...state});await new Promise<void>((resolve,reject)=>uploadBytesResumable(ref(activeStorage,target.storagePath),file,{contentType:file.type}).on("state_changed",undefined,reject,resolve));state[file.name]="送信済み";setUploadState({...state});} await clearDraft(draftKey);setFiles([]);setSubmissionConfirmed(false);setMessage(`${typeLabel}を送信しました。Drive転送を処理中です。`);await loadAll();await loadSubmissionHistory(selectedJob.id,submissionType);if(requestId)await loadResubmissionDetail(requestId); }
  async function loadSubmissionHistory(jobId:string,type:SubmissionType){ if(!firebaseConfigured){setSubmissionHistory([{id:"demo",purpose:"initial",status:"completed",createdAt:new Date().toISOString(),completedAt:new Date().toISOString(),files:[{id:"demo_file",submissionId:"demo",originalName:"report.jpg",driveName:"7.12 ベイシア成田 Aさん (1).jpg",contentType:"image/jpeg",sequence:1,purpose:"initial",status:"completed",previewUrl:null,completedAt:new Date().toISOString(),replacesFileId:null}]}]);return;} if(!functions)return; const r=await httpsCallable(functions,"getSubmissionTimeline")({jobId,type});setSubmissionHistory((r.data as {submissions?:SubmissionGroup[]}).submissions??[]); }
  async function loadResubmissionDetail(id:string){ if(!firebaseConfigured){setResubmissionDetail({request:{id,jobId:selectedJob?.id??"demo_job_1",type:submissionType,reasons:["手ブレで文字が読めません"],note:"文字が読めるよう近くから撮影してください。",status:"open"},source:{id:"demo_file",submissionId:"demo",originalName:"report.jpg",driveName:"7.12 ベイシア成田 Aさん (1).jpg",contentType:"image/jpeg",sequence:1,purpose:"initial",status:"completed",previewUrl:null,completedAt:null,replacesFileId:null},replacements:[]});return;} if(!functions)return; const r=await httpsCallable(functions,"getResubmissionComparison")({requestId:id});setResubmissionDetail(r.data as ResubmissionDetail); }
  async function chooseSubmission(type:SubmissionType,job:Job,req=""){setSelectedJob(job);setSubmissionType(type);setRequestId(req);setSubmissionConfirmed(false);setFiles([]);setResubmissionDetail(null);await loadSubmissionHistory(job.id,type);if(req)await loadResubmissionDetail(req);setView("submit");}

  const activeJob=selectedJob??myJobs[0]??null; const title=useMemo(()=>firebaseConfigured?"Lip Knots Crew":"Lip Knots Crew（デモ）",[]);
  if(firebaseConfigured&&!user)return <main className="login-shell"><section className="login-card"><img src="/logo.png"/><h1>{title}</h1><p>登録済みメールへログインボタンを送ります。</p><input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="メールアドレス"/><button onClick={requestLogin}>ログインメールを送る</button>{message&&<div className="message">{message}</div>}</section></main>;

  return <main className="app-shell">
    <header><img src="/logo.png"/><div><strong>{title}</strong><small>{user?.email??"サンプルスタッフ"}</small></div>{user&&<div className="header-actions"><button className="ghost" onClick={loadDevices}>端末</button><button className="ghost" onClick={()=>auth&&signOut(auth)}>ログアウト</button></div>}</header>
    {message&&<div className="message">{message}</div>}
    {view==="home"&&<>
      <section className="panel push-panel"><div className="section-heading"><div><h2>プッシュ通知</h2><p>大切な業務通知を受け取ります。</p></div><span className={pushEnabled?"push-status enabled":"push-status"}>{pushEnabled?"通知ON":currentPushPermission()==="denied"?"端末で拒否中":"通知OFF"}</span></div><div className="push-actions">{!pushEnabled?<button onClick={enablePush} disabled={pushBusy}>通知を有効にする</button>:<><button className="secondary" onClick={()=>functions&&requestTestPush(functions)}>通知テスト</button><button className="ghost" onClick={disablePush}>通知OFF</button></>}</div></section>
      <section className="hero-card"><h2>今日やること</h2><p>重要な5件を表示しています。</p><div className="task-list">{tasks.slice(0,5).map(task=><button key={task.id} className={`task-card ${task.priority}`} onClick={()=>openTask(task)}><strong>{task.title}</strong><span>{task.body}</span></button>)}{!tasks.length&&<div className="empty">未対応はありません。</div>}</div></section>
      <section><h2>次回シフト</h2>{activeJob?<article className="job shift-job" style={{"--job-accent":jobAccent(activeJob.menuName)} as CSSProperties}><span className="date">{activeJob.workDate||activeJob.dateKey}</span><span className="job-kind">{jobKind(activeJob.menuName)}</span><h3>{activeJob.storeName}</h3><p>{activeJob.makerName} / {activeJob.menuName}</p><span className="prep-chip">{prepSummary(activeJob)}</span><button onClick={()=>{setSelectedJob(activeJob);setView("shifts")}}>シフトを開く</button></article>:<div className="empty">確定シフトはありません。</div>}</section>
    </>}
    {view==="jobs"&&<section><h2>募集中の案件</h2><div className="grid">{openJobs.map(job=><article className="job" key={job.id}><span className="date">{job.workDate||job.dateKey}</span><h3>{job.storeName}</h3><p>{job.makerName} / {job.menuName}</p><p>{job.workTime}</p><strong>{Number(job.basePay||0).toLocaleString()}円</strong><div className="actions"><button className="secondary" onClick={()=>setSelectedJob(job)}>詳細</button><button onClick={()=>apply(job)}>この案件に応募する</button></div></article>)}</div></section>}
    {view==="shifts"&&<section><h2>自分のシフト</h2><div className="grid">{myJobs.map(job=><article className={`job shift-job ${selectedJob?.id===job.id?"selected":""}`} style={{"--job-accent":jobAccent(job.menuName)} as CSSProperties} key={job.id} onClick={()=>setSelectedJob(job)}><span className="date">{job.workDate||job.dateKey}</span><span className="job-kind">{jobKind(job.menuName)}</span><h3>{job.storeName}</h3><p>{job.workTime}</p><span className="prep-chip">{prepSummary(job)}</span></article>)}</div>{selectedJob&&<section className="panel shift-detail" style={{"--job-accent":jobAccent(selectedJob.menuName)} as CSSProperties}><div className="shift-detail-heading"><div><span className="job-kind">{jobKind(selectedJob.menuName)}</span><h2>{selectedJob.storeName}</h2><p>{selectedJob.storeAddress||selectedJob.menuName}</p></div><span className="prep-chip">{prepSummary(selectedJob)}</span></div><div className="route-panel"><strong>店舗への行き方</strong><div className="route-actions"><a href={mapsSearchUrl(selectedJob)} target="_blank" rel="noreferrer">地図で店舗を見る</a><a href={transitRouteUrl(selectedJob)} target="_blank" rel="noreferrer">公共交通の経路</a>{selectedJob.storeNearestStation&&<a href={stationSearchUrl(selectedJob)} target="_blank" rel="noreferrer">最寄駅：{selectedJob.storeNearestStation}</a>}</div></div><div className="form-grid"><label>体温<input value={temperature} onChange={e=>setTemperature(e.target.value)}/></label><label>到着予定時刻<input value={arrivalTime} onChange={e=>setArrivalTime(e.target.value)}/></label></div><button onClick={submitPreContact}>事前連絡を送信</button><hr/><div className="prep-heading"><div><h3>資料準備状況</h3><p>{selectedJob.materialStatus||"ネットプリントの印刷状況から自動表示"}</p></div><span className="prep-chip">{prepSummary(selectedJob)}</span></div>{(selectedJob.netPrint?.items??[]).map(item=><div className="netprint-row" key={item.id}><strong>{item.number}</strong><button className={item.printed?"secondary":""} disabled={item.printed} onClick={()=>markPrinted(item)}>{item.printed?"印刷済み":"印刷しました"}</button></div>)}{!(selectedJob.netPrint?.items??[]).length&&<div className="empty compact">ネットプリント番号はまだ届いていません。</div>}<hr/><div className="submission-actions"><button className="sales-floor-button" onClick={()=>chooseSubmission("sales_floor",selectedJob)}>🖼️ 売場画像を提出</button><button className="report-button" onClick={()=>chooseSubmission("report",selectedJob)}>📝 報告書を提出</button></div></section>}</section>}
    {view==="submit"&&<section className={`panel submission-panel ${submissionType}`}><div className={`submission-identity ${submissionType}`}><span>{submissionType==="report"?"📝 報告書":"🖼️ 売場画像"}</span><strong>{submissionType==="report"?"報告内容が読める画像・PDF":"売場全体や陳列が分かる写真"}</strong></div><h2>{submissionType==="report"?"報告書":"売場画像"}を提出</h2><p>{selectedJob?.storeName}{requestId&&" / 再提出依頼への対応"}</p>
      {resubmissionDetail&&<div className="resubmission-guide"><div><strong>再送理由</strong><p>{resubmissionDetail.request.reasons.join(" / ")}</p>{resubmissionDetail.request.note&&<p>{resubmissionDetail.request.note}</p>}</div><div className="source-preview"><span>撮り直す元画像</span>{resubmissionDetail.source?.previewUrl?<img src={resubmissionDetail.source.previewUrl} alt="再送対象"/>:<div className="preview-placeholder">{resubmissionDetail.source?.driveName??"対象画像"}</div>}</div><small>この画像だけを撮り直し、1ファイル選んで再送してください。</small></div>}
      {submissionType==="sales_floor"&&<button className="secondary" onClick={()=>setClientSubmitted(!(selectedJob?.submissionStatus?.salesFloor?.clientSubmitted))}>{selectedJob?.submissionStatus?.salesFloor?.clientSubmitted?"クライアント提出を解除":"クライアントへ提出済み"}</button>}
      <div className="upload-box"><input type="file" multiple={!requestId} accept="image/*,.pdf" onChange={e=>{setFiles(Array.from(e.target.files??[]).slice(0,requestId?1:20));setSubmissionConfirmed(false);}}/><small>{requestId?"再送対象は1ファイルだけ選択してください":`${submissionType==="report"?"報告書":"売場画像"}として最大20件、1件50MB`}</small></div><div className="file-list">{files.map(file=><div key={`${file.name}_${file.lastModified}`}><span>{file.name}</span><em>{uploadState[file.name]??"下書き保存済み"}</em></div>)}</div><label className={`submission-confirmation ${submissionType}`}><input type="checkbox" checked={submissionConfirmed} onChange={e=>setSubmissionConfirmed(e.target.checked)}/><span>選択中は「{submissionType==="report"?"報告書":"売場画像"}」です。画像と種類を確認しました。</span></label><button className={submissionType==="report"?"report-button":"sales-floor-button"} onClick={uploadSubmission} disabled={!files.length||!submissionConfirmed}>{requestId?"この画像を再送する":`${submissionType==="report"?"報告書":"売場画像"}を送信する`}</button>
      <hr/><h3>提出履歴</h3><div className="history-grid">{submissionHistory.flatMap(group=>group.files).map(file=><article key={`${file.submissionId}_${file.id}`}><div className="history-preview">{file.previewUrl&&file.contentType.startsWith("image/")?<img src={file.previewUrl} alt={file.driveName}/>:<span>{file.contentType.includes("pdf")?"PDF":"FILE"}</span>}</div><strong>{file.driveName||file.originalName}</strong><small>{file.purpose==="replacement"?"再送":"提出済み"}</small></article>)}{!submissionHistory.length&&<div className="empty">提出履歴はありません。</div>}</div>
    </section>}
        {view==="contact"&&<section className="panel"><h2>連絡先</h2><button className="secondary contact-button">メールを送る</button><button className="secondary contact-button">電話をかける</button><button className="secondary contact-button">LINEを開く</button></section>}
    {showDevices&&<section className="panel"><div className="section-heading"><div><h2>ログイン中の端末</h2><p>使っていない端末はログアウトできます。</p></div><button className="ghost" onClick={()=>setShowDevices(false)}>閉じる</button></div><div className="device-list">{devices.map(device=><div className="device-row" key={device.id}><div><strong>{device.label||device.platform||"端末"}</strong><small>{device.id===deviceSessionId?"この端末 / ":""}{device.active===false?"ログアウト済み":"利用中"}</small></div><button className="secondary" disabled={device.active===false} onClick={()=>revokeDevice(device.id)}>ログアウト</button></div>)}</div></section>}
    <nav className="bottom-nav">{([['home','🏠','ホーム'],['jobs','📅','案件'],['shifts','📋','シフト'],['submit','📤','提出'],['contact','☎️','連絡']] as [View,string,string][]).map(([id,icon,label])=><button key={id} className={view===id?"active":""} onClick={()=>setView(id)}><span>{icon}</span>{label}</button>)}</nav>
  </main>;
}
