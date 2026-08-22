import { CSSProperties, useEffect, useMemo, useState } from "react";
import {
  getIdTokenResult, isSignInWithEmailLink, onAuthStateChanged,
  signInWithEmailLink, signOut, User,
} from "firebase/auth";
import { collection, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { ref, uploadBytesResumable } from "firebase/storage";
import { auth, authPersistenceReady, db, firebaseConfigured, functions, storage } from "./firebase";
import { clearDraft, loadDraft, saveDraft } from "./draft-store";
import {
  clearBusinessSnapshot,
  loadBusinessSnapshot,
  loadLastBusinessScope,
  saveBusinessSnapshot,
} from "./business-cache";
import { runWithConcurrency } from "./concurrency";
import {
  currentPushPermission, disablePushNotifications, enablePushNotifications,
  listenForForegroundPush, loadServerPushStatusWithRetry, loadTestPushStatus, refreshPushNotifications,
  requestTestPush, type PushTestStatus,
} from "./push";
import {
  formatDiagnosticReport,
  runStaffDiagnostics,
  type DiagnosticReport,
} from "./diagnostics";
import SubmissionPreviewImage, { type PreviewFile } from "./SubmissionPreviewImage";
import { sleep, useAsyncAction } from "./useAsyncAction";

type View = "home" | "jobs" | "shifts" | "submit" | "contact";
type BusinessDataStatus = "idle" | "loading" | "ready" | "error";
type BusinessDataSource = "none" | "cached" | "live";
type SubmissionHistoryStatus = "idle" | "loading" | "ready" | "error";
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
type DeviceSession = { id:string; deviceId?:string; uid?:string; label?:string; platform?:string; active?:boolean; lastSeenAt?:string };
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
const DEVICE_HEARTBEAT_INTERVAL_MS=5*60*1000;
const PUSH_STATUS_REFRESH_INTERVAL_MS=60*1000;
const BUSINESS_DATA_REFRESH_INTERVAL_MS=30*1000;
const UPLOAD_CONCURRENCY=3;
const CONTACT_EMAIL="info@lipknots.com";
const CONTACT_PHONE="08037906064";
const CONTACT_PHONE_LABEL="080-3790-6064";
const CONTACT_FORM_URL="https://lipknots.com/contact/";
const CONTACT_EMAIL_SUBJECT="Lip Knots Crewからのお問い合わせ";
let emailLinkSignInAttempt:{url:string;task:Promise<void>}|null=null;
let lastPushStatusRefreshAt=0;
let lastBusinessDataRefreshAt=0;
function jobAccent(menuName:string){let hash=0;for(const char of menuName||"案件")hash=((hash*31)+char.codePointAt(0)!)|0;return JOB_ACCENTS[Math.abs(hash)%JOB_ACCENTS.length]??JOB_ACCENTS[0];}
function jobKind(menuName:string){return menuName.replace(/[（(].*$/u,"").trim()||"案件";}
function mapDestination(job:Job){return [job.storeName,job.storeAddress].filter(Boolean).join(" ");}
function mapsSearchUrl(job:Job){return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapDestination(job))}`;}
function transitRouteUrl(job:Job){return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(mapDestination(job))}&travelmode=transit`;}
function stationSearchUrl(job:Job){return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.storeNearestStation??"")}`;}
function prepSummary(job:Job){const items=job.netPrint?.items??[];const printed=items.filter(item=>item.printed).length;if(job.materialStatus)return job.materialStatus;if(!items.length)return"資料番号待ち";return printed===items.length?`準備完了（${printed}/${items.length}件）`:`準備中（${printed}/${items.length}件印刷済み）`;}
function messageTone(value:string){if(/できません|失敗|エラー|拒否|見つかりません|必要です/u.test(value))return"error";if(/処理中|確認しています|読み込|送信中|転送中|待って/u.test(value))return"working";return"success";}
function messageClassName(value:string){return `message ${messageTone(value)}`;}
function fileStateKey(file:File){return `${file.name}_${file.lastModified}_${file.size}`;}
function completeEmailLinkSignIn(url:string,email:string):Promise<void>{
  if(!auth)return Promise.reject(new Error("ログイン設定を確認できません。"));
  const activeAuth=auth;
  if(emailLinkSignInAttempt?.url===url)return emailLinkSignInAttempt.task;
  const task=authPersistenceReady.then(()=>signInWithEmailLink(activeAuth,email,url)).then(()=>undefined);
  emailLinkSignInAttempt={url,task};
  return task;
}

export default function App(){
  const { isPending, run } = useAsyncAction();
  const [user,setUser]=useState<User|null>(null); const [companyId,setCompanyId]=useState(""); const [staffId,setStaffId]=useState("");
  const [email,setEmail]=useState(localStorage.getItem("lkcEmail")??""); const [loginCode,setLoginCode]=useState(""); const [message,setMessage]=useState("");
  const [view,setView]=useState<View>("home"); const [openJobs,setOpenJobs]=useState<Job[]>(firebaseConfigured?[]:demoJobs);
  const [myJobs,setMyJobs]=useState<Job[]>(firebaseConfigured?[]:demoJobs); const [tasks,setTasks]=useState<StaffTask[]>(firebaseConfigured?[]:demoTasks);
  const [selectedJob,setSelectedJob]=useState<Job|null>(firebaseConfigured?null:(demoJobs[0]??null)); const [temperature,setTemperature]=useState("36.2"); const [arrivalTime,setArrivalTime]=useState("9:30");
  const [submissionType,setSubmissionType]=useState<SubmissionType>("report"); const [requestId,setRequestId]=useState("");
  const [submissionConfirmed,setSubmissionConfirmed]=useState(false);
  const [submissionMessage,setSubmissionMessage]=useState("");
  const [files,setFiles]=useState<File[]>([]); const [uploadState,setUploadState]=useState<Record<string,string>>({});
  const [deviceSessionId,setDeviceSessionId]=useState(""); const [devices,setDevices]=useState<DeviceSession[]>([]); const [showDevices,setShowDevices]=useState(false);
  const currentDeviceId=useMemo(()=>getOrCreateDeviceId(),[]);
  const [pushEnabled,setPushEnabled]=useState(false);
  const [showAllTasks,setShowAllTasks]=useState(false);
  const [submissionHistory,setSubmissionHistory]=useState<SubmissionGroup[]>([]);
  const [submissionHistoryStatus,setSubmissionHistoryStatus]=useState<SubmissionHistoryStatus>("idle");
  const [resubmissionDetail,setResubmissionDetail]=useState<ResubmissionDetail|null>(null);
  const [processingSubmission,setProcessingSubmission]=useState(false);
  const [authResolved,setAuthResolved]=useState(!firebaseConfigured);
  const [businessDataStatus,setBusinessDataStatus]=useState<BusinessDataStatus>(firebaseConfigured?"idle":"ready");
  const [businessDataSource,setBusinessDataSource]=useState<BusinessDataSource>(firebaseConfigured?"none":"live");
  const [businessRefreshing,setBusinessRefreshing]=useState(false);
  const [openJobsStatus,setOpenJobsStatus]=useState<BusinessDataStatus>(firebaseConfigured?"idle":"ready");
  const [homeDisplayMs,setHomeDisplayMs]=useState<number|null>(firebaseConfigured?null:0);
  const [businessRefreshMs,setBusinessRefreshMs]=useState<number|null>(firebaseConfigured?null:0);
  const [homeLoadedFromCache,setHomeLoadedFromCache]=useState(false);
  const [showDiagnostics,setShowDiagnostics]=useState(false);
  const [diagnosticReport,setDiagnosticReport]=useState<DiagnosticReport|null>(null);
  const [emailLinkPending,setEmailLinkPending]=useState(()=>Boolean(auth&&isSignInWithEmailLink(auth,window.location.href)));

  const selectedAssignedJob=selectedJob?myJobs.find(job=>job.id===selectedJob.id)??null:null;
  const draftKey=selectedAssignedJob?`${selectedAssignedJob.id}_${submissionType}_${requestId||"normal"}`:"";
  useEffect(()=>{ if(!draftKey)return; void loadDraft(draftKey).then(setFiles).catch(()=>undefined); },[draftKey]);
  useEffect(()=>{ if(!draftKey)return; const timer=setTimeout(()=>void saveDraft(draftKey,files),300); return()=>clearTimeout(timer); },[draftKey,files]);

  useEffect(()=>{ if(!auth)return; return onAuthStateChanged(auth,async current=>{
    const loadStarted=performance.now();
    setUser(current);
    setAuthResolved(true);
    if(firebaseConfigured){
      setCompanyId(""); setStaffId(""); setOpenJobs([]); setMyJobs([]); setTasks([]); setSelectedJob(null);
      setFiles([]); setUploadState({}); setSubmissionHistory([]); setSubmissionHistoryStatus("idle"); setSubmissionMessage("");
      setBusinessDataStatus(current?"loading":"idle");
      setBusinessDataSource("none");
      setBusinessRefreshing(Boolean(current));
      setOpenJobsStatus("idle");
      setHomeDisplayMs(null);
      setBusinessRefreshMs(null);
      setHomeLoadedFromCache(false);
      setPushEnabled(false);
      setShowDiagnostics(false);
      setDiagnosticReport(null);
      lastPushStatusRefreshAt=0;
      lastBusinessDataRefreshAt=0;
    }
    if(!current||!functions){setDeviceSessionId("");setBusinessRefreshing(false);return;}
    let restoredCachedData=false;
    let sessionVerified=false;
    let restoredScope:{companyId:string;staffId:string}|null=null;
    try{
      const restoreCachedBusinessData=(cid:string,sid:string)=>{
        const snapshot=loadBusinessSnapshot<Job,StaffTask>(current.uid,cid,sid);
        if(!snapshot)return false;
        setCompanyId(cid); setStaffId(sid);
        setMyJobs(snapshot.jobs);
        setTasks(snapshot.tasks);
        setSelectedJob(snapshot.jobs[0]??null);
        setBusinessDataStatus("ready");
        setBusinessDataSource("cached");
        setHomeDisplayMs(Math.round(performance.now()-loadStarted));
        setHomeLoadedFromCache(true);
        return true;
      };
      const bootstrap=httpsCallable(functions,"bootstrapSession");
      const bootstrapPromise=bootstrap();
      const knownScope=loadLastBusinessScope(current.uid);
      if(knownScope&&restoreCachedBusinessData(knownScope.companyId,knownScope.staffId)){
        restoredCachedData=true;
        restoredScope=knownScope;
      }else if(knownScope){
        clearBusinessSnapshot(current.uid,knownScope.companyId,knownScope.staffId);
      }
      const initialToken=await getIdTokenResult(current).catch(()=>null);
      const initialCid=String(initialToken?.claims.companyId??"");
      const initialSid=String(initialToken?.claims.staffId??"");
      if(!restoredCachedData&&initialCid&&initialSid&&restoreCachedBusinessData(initialCid,initialSid)){
        restoredCachedData=true;
        restoredScope={companyId:initialCid,staffId:initialSid};
      }
      const result=await bootstrapPromise;
      const refreshToken=Boolean((result.data as {refreshToken?:boolean}).refreshToken);
      if(refreshToken)await current.getIdToken(true);
      const token=refreshToken||!initialToken?await getIdTokenResult(current):initialToken;
      const cid=String(token.claims.companyId??""); const sid=String(token.claims.staffId??"");
      if(!cid||!sid)throw new Error("スタッフの所属情報を確認できません。");
      sessionVerified=true;
      if(restoredScope&&(restoredScope.companyId!==cid||restoredScope.staffId!==sid)){
        clearBusinessSnapshot(current.uid,restoredScope.companyId,restoredScope.staffId);
        restoredCachedData=false;
        restoredScope=null;
        setMyJobs([]); setTasks([]); setSelectedJob(null);
        setBusinessDataStatus("loading");
        setBusinessDataSource("none");
        setHomeDisplayMs(null);
        setHomeLoadedFromCache(false);
      }
      setCompanyId(cid); setStaffId(sid);
      if(!restoredCachedData&&restoreCachedBusinessData(cid,sid)){
        restoredCachedData=true;
        restoredScope={companyId:cid,staffId:sid};
      }
      await loadPrimaryBusinessData(sid,cid,current.uid);
      setBusinessDataStatus("ready");
      setBusinessDataSource("live");
      const refreshedInMs=Math.round(performance.now()-loadStarted);
      if(!restoredCachedData)setHomeDisplayMs(refreshedInMs);
      setBusinessRefreshMs(refreshedInMs);
      lastBusinessDataRefreshAt=Date.now();
      void registerCurrentDevice().catch(()=>setMessage("端末情報を登録できませんでした。再読み込みしてください。"));
      void loadOpenJobs(cid).catch(()=>undefined);
      void refreshPushStatus(true);
    }catch{
      if(restoredCachedData&&sessionVerified){
        setBusinessDataStatus("ready");
        setBusinessDataSource("cached");
        setMessage("最新情報を更新できなかったため、前回の業務データを表示しています。");
      }else{
        if(restoredScope)clearBusinessSnapshot(current.uid,restoredScope.companyId,restoredScope.staffId);
        setCompanyId(""); setStaffId(""); setMyJobs([]); setTasks([]); setSelectedJob(null);
        setBusinessDataStatus("error");
        setBusinessDataSource("none");
        setHomeDisplayMs(null);
        setHomeLoadedFromCache(false);
        setMessage("業務データを読み込めませんでした。再読み込みしてください。");
      }
    }finally{
      setBusinessRefreshing(false);
    }
  }); },[]);
  useEffect(()=>{
    if(!auth)return;
    const loginUrl=window.location.href;
    if(!isSignInWithEmailLink(auth,loginUrl)){setEmailLinkPending(false);return;}
    const saved=localStorage.getItem("lkcEmail")??window.prompt("メールアドレスを入力してください")??"";
    if(!saved){setMessage("ログインに使ったメールアドレスを入力してください。");setEmailLinkPending(false);return;}
    let active=true;
    setEmailLinkPending(true);
    setMessage("ログインを確認しています…");
    void completeEmailLinkSignIn(loginUrl,saved).then(()=>{
      if(!active)return;
      window.history.replaceState({},document.title,"/");
      setMessage("ログインしました。");
    }).catch((error:Error)=>{if(active)setMessage(error.message);}).finally(()=>{if(active)setEmailLinkPending(false);});
    return()=>{active=false;};
  },[]);
  useEffect(()=>{
    if(!user||!deviceSessionId||!functions||!db||!auth)return;
    const activeAuth=auth;
    const activeFunctions=functions;
    let stopped=false;
    const heartbeat=async()=>{
      try{
        await httpsCallable(activeFunctions,"heartbeatDeviceSession")({sessionId:deviceSessionId});
      }catch(error){
        const code=String((error as {code?:unknown}).code??"");
        if(!stopped&&code.endsWith("permission-denied")){
          setMessage("この端末はログアウトされています。");
          clearBusinessSnapshot(user.uid,companyId,staffId);
          await signOut(activeAuth);
        }
      }
    };
    const stopWatching=watchDeviceSession(deviceSessionId);
    void heartbeat();
    const interval=window.setInterval(()=>void heartbeat(),DEVICE_HEARTBEAT_INTERVAL_MS);
    const handleVisibility=()=>{if(document.visibilityState==="visible"){void heartbeat();void refreshPushStatus(false);void refreshBusinessData(false);}};
    document.addEventListener("visibilitychange",handleVisibility);
    return()=>{
      stopped=true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange",handleVisibility);
      stopWatching?.();
    };
  },[user,deviceSessionId,companyId,staffId]);
  useEffect(()=>{ if(!user)return; let unsub:(()=>void)|null=null; void listenForForegroundPush(payload=>setMessage(`${payload.data?.title??"Lip Knots Crew"}：${payload.data?.body??"新しいお知らせがあります。"}`)).then(v=>unsub=v); return()=>unsub?.(); },[user]);
  useEffect(()=>{if(tasks.length<=5)setShowAllTasks(false);},[tasks.length]);

  async function loadPrimaryBusinessData(sid=staffId,cid=companyId,uid=user?.uid??""){
    const [jobs,nextTasks]=await Promise.all([loadMyJobs(sid,cid),loadTasks()]);
    saveBusinessSnapshot(uid,cid,sid,jobs,nextTasks);
  }
  async function loadOpenJobs(cid=companyId){
    if(!db||!cid){setOpenJobsStatus("ready");return;}
    setOpenJobsStatus("loading");
    try{
      const snap=await getDocs(query(collection(db,"jobs"),where("companyId","==",cid),where("status","==","open"),orderBy("dateKey","asc"),limit(100)));
      setOpenJobs(snap.docs.map(d=>({id:d.id,...d.data()} as Job)));
      setOpenJobsStatus("ready");
    }catch(error){
      setOpenJobsStatus("error");
      throw error;
    }
  }
  async function loadMyJobs(sid=staffId,cid=companyId):Promise<Job[]>{ if(!db||!sid||!cid)return[]; const snap=await getDocs(query(collection(db,"jobs"),where("companyId","==",cid),where("assignedStaffId","==",sid),orderBy("dateKey","asc"),limit(300))); const values=snap.docs.map(d=>({id:d.id,...d.data()} as Job)); setMyJobs(values); setSelectedJob(current=>values.find(job=>job.id===current?.id)??values[0]??null); return values; }
  async function loadTasks():Promise<StaffTask[]>{ if(!functions)return[]; const c=httpsCallable(functions,"getMyTasks"); const r=await c({}); const values=(r.data as {tasks?:StaffTask[]}).tasks??[]; setTasks(values); return values; }
  function showSubmissionMessage(value:string){setMessage(value);setSubmissionMessage(value);}

  async function refreshBusinessData(showFailure:boolean){
    if(!user||!staffId||!companyId||Date.now()-lastBusinessDataRefreshAt<BUSINESS_DATA_REFRESH_INTERVAL_MS)return;
    lastBusinessDataRefreshAt=Date.now();
    setBusinessRefreshing(true);
    const started=performance.now();
    try{
      await loadPrimaryBusinessData(staffId,companyId,user.uid);
      setBusinessDataStatus("ready");
      setBusinessDataSource("live");
      setBusinessRefreshMs(Math.round(performance.now()-started));
      if(openJobsStatus!=="idle")void loadOpenJobs(companyId).catch(()=>undefined);
    }catch{
      lastBusinessDataRefreshAt=0;
      if(showFailure)setMessage("最新情報を更新できませんでした。通信状態を確認してください。");
    }finally{
      setBusinessRefreshing(false);
    }
  }

  async function refreshPushStatus(showFailure:boolean){
    if(!functions||Date.now()-lastPushStatusRefreshAt<PUSH_STATUS_REFRESH_INTERVAL_MS)return;
    lastPushStatusRefreshAt=Date.now();
    try{
      setPushEnabled(await loadServerPushStatusWithRetry(functions));
    }catch{
      if(showFailure)setMessage("通知状態を読み込めませんでした。自動で再確認します。");
    }
  }

  async function openQuickDiagnostics(){
    if(isPending("diagnostics"))return;
    setShowDiagnostics(true);
    setDiagnosticReport(null);
    await run("diagnostics",async()=>{
      const report=await runStaffDiagnostics({
        signedIn:Boolean(user),
        companyScoped:Boolean(companyId&&staffId),
        businessDataStatus,
        homeDisplayMs,
        businessRefreshMs,
        homeLoadedFromCache,
        deviceSessionRegistered:Boolean(deviceSessionId),
        functions,
      });
      setDiagnosticReport(report);
      if(report.serverPushEnabled!==null)setPushEnabled(report.serverPushEnabled);
      setMessage(report.summary==="pass"?"自動診断はすべて正常です。スクリーンショットは不要です。":report.summary==="warn"?"自動診断が完了しました。確認項目があります。":"自動診断でエラーを検出しました。結果をコピーして運営へ送ってください。");
    },{setMessage});
  }

  async function copyDiagnostics(){
    if(!diagnosticReport)return;
    try{
      await navigator.clipboard.writeText(formatDiagnosticReport(diagnosticReport));
      setMessage("診断結果をコピーしました。この文章だけ送れば確認できます。");
    }catch{
      setMessage("診断結果をコピーできませんでした。端末のコピー許可を確認してください。");
    }
  }

  async function shareDiagnostics(){
    if(!diagnosticReport)return;
    const text=formatDiagnosticReport(diagnosticReport);
    if(navigator.share){
      try{
        await navigator.share({title:"Lip Knots Crew かんたん診断",text});
        setMessage("診断結果を共有しました。");
        return;
      }catch(error){
        if((error as {name?:string}).name==="AbortError")return;
      }
    }
    await copyDiagnostics();
  }

  function navigate(next:View){
    setView(next);
    if(next==="jobs"&&openJobsStatus==="idle")void loadOpenJobs().catch(()=>undefined);
  }

  async function refreshSelectedJob(jobId:string){
    if(!db)return;
    const snap=await getDoc(doc(db,"jobs",jobId));
    if(!snap.exists())return;
    const updated={id:snap.id,...snap.data()} as Job;
    setMyJobs(jobs=>jobs.map(job=>job.id===jobId?updated:job));
    setSelectedJob(current=>current?.id===jobId?updated:current);
  }

  async function requestLogin(){
    if(!email||isPending("login"))return;
    await run("login",async()=>{
      localStorage.setItem("lkcEmail",email);
      setLoginCode("");
      if(!firebaseConfigured){setMessage("デモ：ログインメールと確認コードを送りました。");return;}
      if(!functions)return;
      const c=httpsCallable(functions,"requestStaffLoginLink");
      const r=await c({email,continueUrl:window.location.origin});
      setMessage((r.data as {message?:string}).message??"ログインメールと確認コードを送信しました。");
    },{setMessage});
  }

  async function verifyLoginCode(){
    const code=loginCode.replace(/\D/g,"");
    if(!email||code.length!==6||isPending("login-code")){
      if(code.length!==6)setMessage("メールに記載された6桁の確認コードを入力してください。");
      return;
    }
    await run("login-code",async()=>{
      localStorage.setItem("lkcEmail",email);
      if(!firebaseConfigured){setMessage("デモ：確認コードでログインしました。");return;}
      if(!functions||!auth)return;
      const activeAuth=auth;
      const callable=httpsCallable<{email:string;code:string},{emailActionLink:string}>(functions,"requestStaffLoginLink");
      const result=await callable({email,code});
      const emailActionLink=result.data.emailActionLink;
      if(!emailActionLink||!isSignInWithEmailLink(activeAuth,emailActionLink))throw new Error("ログイン情報を確認できません。");
      await authPersistenceReady;
      await signInWithEmailLink(activeAuth,email,emailActionLink);
      setLoginCode("");
      setMessage("ログインしました。");
    },{setMessage});
  }

  async function registerCurrentDevice(){ if(!functions)return""; const c=httpsCallable(functions,"registerDeviceSession"); const r=await c({deviceId:currentDeviceId,label:deviceLabel(),platform:navigator.platform||"",userAgent:navigator.userAgent}); const id=String((r.data as {sessionId?:string}).sessionId??""); setDeviceSessionId(id); return id; }
  async function logoutCurrentUser(){
    if(user)clearBusinessSnapshot(user.uid,companyId,staffId);
    if(auth)await signOut(auth);
  }
  function watchDeviceSession(id:string){ if(!db||!auth)return; return onSnapshot(doc(db,"deviceSessions",id),async s=>{if(s.exists()&&s.data().active===false){setMessage("この端末はログアウトされました。");await logoutCurrentUser();}}); }

  function isCurrentDevice(device:DeviceSession){
    if(device.id===deviceSessionId)return true;
    return Boolean(user?.uid&&device.deviceId===currentDeviceId&&device.uid===user.uid);
  }

  async function loadDevices(){
    if(isPending("devices"))return;
    await run("devices",async()=>{
      if(!firebaseConfigured){setDevices([{id:"current",label:deviceLabel(),active:true},{id:"old",label:"以前のiPhone",active:true}]);setShowDevices(true);return;}
      if(!functions)return;
      const r=await httpsCallable(functions,"listMyDevices")({});
      setDevices((r.data as {devices?:DeviceSession[]}).devices??[]);
      setShowDevices(true);
    },{setMessage});
  }

  async function revokeDevice(id:string){
    const target=devices.find(device=>device.id===id);
    const currentTarget=target?isCurrentDevice(target):id===deviceSessionId;
    if(!confirm("この端末をログアウトしますか？"))return;
    const key=`revoke-${id}`;
    if(isPending(key))return;
    await run(key,async()=>{
      if(!functions){setDevices(v=>v.map(x=>x.id===id?{...x,active:false}:x));return;}
      await httpsCallable(functions,"revokeMyDevice")({sessionId:id});
      await loadDevices();
      if(currentTarget)await logoutCurrentUser();
      setMessage("端末をログアウトしました。");
    },{setMessage});
  }

  async function enablePush(){
    if(isPending("push-enable"))return;
    await run("push-enable",async()=>{
      if(!functions){setPushEnabled(true);setMessage("デモ：通知を有効にしました。");return;}
      const r=await enablePushNotifications(functions,deviceSessionId);
      setPushEnabled(r.enabled);
      setMessage(r.message);
    },{setMessage});
  }

  async function disablePush(){
    if(isPending("push-disable"))return;
    await run("push-disable",async()=>{
      if(!functions){setPushEnabled(false);setMessage("デモ：通知を無効にしました。");return;}
      await disablePushNotifications(functions);
      setPushEnabled(false);
      setMessage("通知を無効にしました。");
    },{setMessage});
  }

  async function requestPushTest(){
    if(isPending("push-test")||!functions)return;
    await run("push-test",async()=>{
      let test=await submitAndWaitForPushTest();
      if(test?.finished&&(test.invalidTokenCount>0||test.failureReason==="invalid_token")){
        setMessage("古い通知登録を検出しました。端末を自動で再登録しています…");
        const refreshed=await refreshPushNotifications(functions!,deviceSessionId);
        setPushEnabled(refreshed.enabled);
        if(!refreshed.enabled){setMessage(refreshed.message);return;}
        test=await submitAndWaitForPushTest();
      }
      if(!test){
        setMessage("通知はバックグラウンドで処理中です。少し待って端末表示を確認してください。");
      }else if(test.status==="completed"&&test.successCount>0){
        setMessage(`通知サービスへの送信に成功しました（対象${test.successCount}台）。端末に表示されたか確認してください。`);
      }else if(test.status==="no_tokens"){
        setPushEnabled(false);
        setMessage("有効な通知端末が見つかりません。通知をもう一度有効にしてください。");
      }else if(test.failureReason==="sender_mismatch"||test.failureReason==="service_auth"){
        setMessage("端末ではなく通知サービス側の設定エラーです。運営側で設定を確認します。");
      }else if(test.failureReason==="rate_limited"||test.failureReason==="temporary"){
        setMessage("通知サービスが一時的に混み合っています。少し待ってから再度お試しください。");
      }else{
        setMessage(`通知サービスへの送信結果：成功${test.successCount}台・失敗${test.failureCount}台。運営側で原因を確認します。`);
      }
    },{setMessage});
  }

  async function submitAndWaitForPushTest():Promise<PushTestStatus|null>{
    const queueId=await requestTestPush(functions!);
    setMessage("テスト通知を処理しています…");
    const started=Date.now();
    let delay=400;
    while(Date.now()-started<15_000){
      const test=await loadTestPushStatus(functions!,queueId);
      if(test?.finished)return test;
      await sleep(delay);
      delay=Math.min(Math.round(delay*1.5),2000);
    }
    return null;
  }

  async function apply(job:Job){
    const key=`apply-${job.id}`;
    if(isPending(key))return;
    await run(key,async()=>{
      if(!firebaseConfigured){setMessage("デモ：応募が確定しました。");setOpenJobs(v=>v.filter(x=>x.id!==job.id));return;}
      if(!functions)return;
      await httpsCallable(functions,"applyToJob")({jobId:job.id,requestId:crypto.randomUUID()});
      setMessage("応募が確定しました。");
      await loadOpenJobs();
    },{setMessage});
  }

  async function submitPreContact(){
    if(!selectedJob||isPending("preContact"))return;
    await run("preContact",async()=>{
      if(!firebaseConfigured){setMessage("デモ：事前連絡を送信しました。");return;}
      if(!functions)return;
      await httpsCallable(functions,"submitPreContact")({jobId:selectedJob.id,temperature:Number(temperature),arrivalTime});
      setMessage("事前連絡を送信しました。");
      await refreshSelectedJob(selectedJob.id);
      await loadTasks();
    },{setMessage});
  }

  async function markPrinted(item:NetPrintItem){
    if(!selectedJob||isPending(`print-${item.id}`))return;
    await run(`print-${item.id}`,async()=>{
      if(!firebaseConfigured){setMessage("デモ：印刷済みにしました。");return;}
      if(!functions)return;
      await httpsCallable(functions,"markNetPrintPrinted")({jobId:selectedJob.id,itemId:item.id});
      setMessage("印刷済みにしました。");
      await Promise.all([refreshSelectedJob(selectedJob.id),loadTasks()]);
    },{setMessage});
  }

  async function setClientSubmitted(value:boolean){
    if(!selectedJob||isPending("clientSubmitted"))return;
    const previous=selectedJob;
    const optimistic:Job={
      ...selectedJob,
      submissionStatus:{
        ...selectedJob.submissionStatus,
        salesFloor:{
          ...selectedJob.submissionStatus?.salesFloor,
          clientSubmitted:value,
        },
      },
    };
    setSelectedJob(optimistic);
    setMyJobs(jobs=>jobs.map(job=>job.id===selectedJob.id?optimistic:job));
    try{
      await run("clientSubmitted",async()=>{
        if(!firebaseConfigured){setMessage(value?"デモ：クライアント提出済みにしました。":"デモ：クライアント提出を解除しました。");return;}
        if(!functions)return;
        await httpsCallable(functions,"setSalesFloorClientSubmitted")({jobId:selectedJob.id,submitted:value});
        setMessage(value?"クライアント提出済みにしました。":"クライアント提出を解除しました。");
        await Promise.all([refreshSelectedJob(selectedJob.id),loadTasks()]);
      },{setMessage});
    }catch{
      setSelectedJob(previous);
      setMyJobs(jobs=>jobs.map(job=>job.id===previous.id?previous:job));
    }
  }

  async function openTask(task:StaffTask){ const job=myJobs.find(j=>j.id===task.jobId); if(!job){setMessage("対象の確定シフトを確認できません。シフト画面から案件を選び直してください。");setView("shifts");return;} setSelectedJob(job); if(task.kind==="precontact"){setView("shifts");return;} if(task.kind==="netprint"){setView("shifts");return;} const type=task.kind==="sales_floor"?"sales_floor":"report"; const req=String(task.metadata?.requestId??""); await prepareSubmission(type,job,req); }

  async function pollSubmissionProcessing(jobId:string,submissionId:string,type:SubmissionType,resubmissionRequestId:string){
    if(!functions)return;
    setProcessingSubmission(true);
    const callable=httpsCallable(functions,"getSubmissionProcessingStatus");
    const started=Date.now();
    let delay=500;
    try{
      while(Date.now()-started<60_000){
        const response=await callable({jobId,submissionId});
        const data=response.data as {status:string;completedFiles:number;totalFiles:number;errorMessage:string|null};
        if(data.status==="completed"){
          showSubmissionMessage("Driveへの保存が完了しました。");
          await Promise.all([loadSubmissionHistory(jobId,type),refreshSelectedJob(jobId),loadTasks()]);
          if(resubmissionRequestId)await loadResubmissionDetail(resubmissionRequestId);
          return;
        }
        if(data.status==="error"){
          showSubmissionMessage(data.errorMessage??"提出の処理中にエラーが発生しました。");
          return;
        }
        showSubmissionMessage(`Drive転送を処理中です（${data.completedFiles}/${data.totalFiles}件）…`);
        await sleep(delay);
        delay=Math.min(Math.round(delay*1.5),3000);
      }
      showSubmissionMessage("バックグラウンドで処理中です。完了すると提出履歴に自動で反映されます。");
    }finally{
      setProcessingSubmission(false);
    }
  }

  async function uploadSubmission(){
    if(!files.length||!submissionConfirmed||isPending("uploadSubmission")||processingSubmission)return;
    const assignedJob=selectedJob?myJobs.find(job=>job.id===selectedJob.id):undefined;
    if(!assignedJob){showSubmissionMessage("提出する確定シフトを確認できません。シフト画面から案件を選び直してください。");return;}
    const typeLabel=submissionType==="report"?"報告書":"売場画像";
    setSubmissionMessage("");
    if(!firebaseConfigured){
      setUploadState(Object.fromEntries(files.map(f=>[fileStateKey(f),"送信済み"])));
      showSubmissionMessage(`デモ：${typeLabel}を送信しました。`);
      setSubmissionConfirmed(false);
      return;
    }
    if(!functions||!storage)return;
    const activeFunctions=functions;
    const activeStorage=storage;
    const jobId=assignedJob.id;
    const currentRequestId=requestId;
    const currentType=submissionType;
    await run("uploadSubmission",async()=>{
      const purpose=currentRequestId?"replacement":"additional";
      const r=await httpsCallable(activeFunctions,"createUploadSession")({jobId,type:currentType,purpose,resubmissionRequestId:currentRequestId||undefined,files:files.map(f=>({originalName:f.name,contentType:f.type||"application/octet-stream",size:f.size}))});
      const data=r.data as {submissionId:string;files:{storagePath:string}[]};
      if(!data.submissionId||data.files.length!==files.length)throw new Error("送信先を正しく準備できませんでした。もう一度お試しください。");
      const uploads=data.files.flatMap((target,index)=>{const file=files[index];return file?[{target,file}]:[];});
      setUploadState(Object.fromEntries(uploads.map(({file})=>[fileStateKey(file),"送信待ち"])));
      await runWithConcurrency(uploads,UPLOAD_CONCURRENCY,async({target,file})=>{
        const key=fileStateKey(file);
        setUploadState(current=>({...current,[key]:"送信中 0%"}));
        await new Promise<void>((resolve,reject)=>uploadBytesResumable(ref(activeStorage,target.storagePath),file,{contentType:file.type}).on(
          "state_changed",
          snapshot=>setUploadState(current=>({...current,[key]:`送信中 ${Math.round(snapshot.bytesTransferred/Math.max(snapshot.totalBytes,1)*100)}%`})),
          reject,
          resolve,
        ));
        setUploadState(current=>({...current,[key]:"送信済み"}));
      });
      await clearDraft(draftKey);
      setFiles([]);
      setSubmissionConfirmed(false);
      showSubmissionMessage(`${typeLabel}を送信しました。Drive転送を処理中です…`);
      void pollSubmissionProcessing(jobId,data.submissionId,currentType,currentRequestId);
    },{setMessage:showSubmissionMessage});
  }

  async function loadSubmissionHistory(jobId:string,type:SubmissionType){
    setSubmissionHistoryStatus("loading");
    try{
      if(!firebaseConfigured){
        setSubmissionHistory([{id:"demo",purpose:"initial",status:"completed",createdAt:new Date().toISOString(),completedAt:new Date().toISOString(),files:[{id:"demo_file",submissionId:"demo",originalName:"report.jpg",driveName:"7.12 ベイシア成田 Aさん (1).jpg",contentType:"image/jpeg",sequence:1,purpose:"initial",status:"completed",previewUrl:null,completedAt:new Date().toISOString(),replacesFileId:null}]}]);
        setSubmissionHistoryStatus("ready");
        return;
      }
      if(!functions){setSubmissionHistoryStatus("error");return;}
      const r=await httpsCallable(functions,"getSubmissionTimeline")({jobId,type});
      setSubmissionHistory((r.data as {submissions?:SubmissionGroup[]}).submissions??[]);
      setSubmissionHistoryStatus("ready");
    }catch(error){
      setSubmissionHistoryStatus("error");
      throw error;
    }
  }

  async function refreshFilePreview(file:PreviewFile):Promise<string|null>{
    if(!selectedJob||!functions)return null;
    const r=await httpsCallable(functions,"getSubmissionTimeline")({jobId:selectedJob.id,type:submissionType});
    const groups=(r.data as {submissions?:SubmissionGroup[]}).submissions??[];
    setSubmissionHistory(groups);
    const refreshed=groups.flatMap(group=>group.files).find(entry=>entry.submissionId===file.submissionId&&entry.id===file.id);
    return refreshed?.previewUrl??null;
  }

  async function loadResubmissionDetail(id:string){
    if(!firebaseConfigured){
      setResubmissionDetail({request:{id,jobId:selectedJob?.id??"demo_job_1",type:submissionType,reasons:["手ブレで文字が読めません"],note:"文字が読めるよう近くから撮影してください。",status:"open"},source:{id:"demo_file",submissionId:"demo",originalName:"report.jpg",driveName:"7.12 ベイシア成田 Aさん (1).jpg",contentType:"image/jpeg",sequence:1,purpose:"initial",status:"completed",previewUrl:null,completedAt:null,replacesFileId:null},replacements:[]});
      return;
    }
    if(!functions)return;
    const r=await httpsCallable(functions,"getResubmissionComparison")({requestId:id});
    setResubmissionDetail(r.data as ResubmissionDetail);
  }

  async function prepareSubmission(type:SubmissionType,job:Job,req=""){
    setSelectedJob(job);
    setSubmissionType(type);
    setRequestId(req);
    setSubmissionConfirmed(false);
    setSubmissionMessage("");
    setFiles([]);
    setSubmissionHistory([]);
    setSubmissionHistoryStatus("loading");
    setResubmissionDetail(null);
    setView("submit");
    try{
      await Promise.all([
        loadSubmissionHistory(job.id,type),
        req?loadResubmissionDetail(req):Promise.resolve(),
      ]);
    }catch{
      showSubmissionMessage("提出情報を読み込めませんでした。画面内の再読み込みをお試しください。");
    }
  }

  async function chooseSubmission(type:SubmissionType,job:Job,req=""){const assignedJob=myJobs.find(candidate=>candidate.id===job.id);if(!assignedJob){showSubmissionMessage("提出する確定シフトを確認できません。シフト画面から案件を選び直してください。");setView("shifts");return;}await prepareSubmission(type,assignedJob,req);}

  const activeJob=selectedAssignedJob??myJobs[0]??null;
  const visibleTasks=showAllTasks?tasks:tasks.slice(0,5);
  const title=useMemo(()=>firebaseConfigured?"Lip Knots Crew":"Lip Knots Crew（デモ）",[]);
  const taskSummary=businessDataStatus==="ready"
    ? tasks.length
      ? showAllTasks&&tasks.length>5?`未対応${tasks.length}件をすべて表示しています。`:`重要な${Math.min(tasks.length,5)}件を表示しています。`
      : "今日の対応はすべて完了しています。"
    : businessDataStatus==="loading"?"業務データを読み込んでいます…":"業務データを確認できません。";
  const businessDataFallback=businessDataStatus==="loading"
    ? <div className="empty">業務データを読み込んでいます…</div>
    : businessDataStatus==="error"
      ? <div className="empty">業務データを読み込めませんでした。<button className="secondary" onClick={()=>window.location.reload()}>再読み込み</button></div>
      : null;
  const openJobsFallback=openJobsStatus==="loading"
    ? <div className="empty">募集中の案件を読み込んでいます…</div>
    : openJobsStatus==="error"
      ? <div className="empty">案件を読み込めませんでした。<button className="secondary" onClick={()=>void loadOpenJobs().catch(()=>undefined)}>もう一度試す</button></div>
      : null;
  const diagnosticSummaryLabel=diagnosticReport?.summary==="pass"?"すべて正常":diagnosticReport?.summary==="warn"?"確認あり":diagnosticReport?"エラーあり":"診断中";
  if(firebaseConfigured&&(!authResolved||emailLinkPending))return <main className="login-shell"><section className="login-card"><img src="/logo.png"/><h1>{title}</h1><p>ログインを確認しています。<br/>画面を閉じずに、そのままお待ちください。</p><div className="message working">処理中…</div></section></main>;
  if(firebaseConfigured&&!user)return <main className="login-shell"><section className="login-card"><img src="/logo.png"/><h1>{title}</h1><p>登録済みメールへログインボタンと6桁の確認コードを送ります。</p><input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="メールアドレス" autoComplete="email"/><button onClick={()=>void requestLogin()} disabled={isPending("login")}>{isPending("login")?"処理中…":"ログインメールを送る"}</button><p>ホーム画面版では、メールに記載された確認コードを入力してください。</p><input value={loginCode} onChange={e=>setLoginCode(e.target.value.replace(/\D/g,"").slice(0,6))} placeholder="6桁の確認コード" inputMode="numeric" autoComplete="one-time-code" maxLength={6}/><button className="secondary" onClick={()=>void verifyLoginCode()} disabled={loginCode.length!==6||isPending("login-code")}>{isPending("login-code")?"確認中…":"確認コードでログイン"}</button>{message&&<div className={messageClassName(message)} role={messageTone(message)==="error"?"alert":"status"}>{message}</div>}</section></main>;

  return <main className="app-shell">
    <header><img src="/logo.png"/><div className="account-copy"><strong>{title}</strong><small>{user?.email??"サンプルスタッフ"}</small></div>{user&&<div className="header-actions"><button className="ghost" onClick={()=>void openQuickDiagnostics()} disabled={isPending("diagnostics")} aria-busy={isPending("diagnostics")}>{isPending("diagnostics")?"診断中…":"状態確認"}</button><button className="ghost" onClick={()=>void loadDevices()} disabled={isPending("devices")}>{isPending("devices")?"処理中…":"端末"}</button><button className="ghost" onClick={()=>void logoutCurrentUser()}>ログアウト</button></div>}</header>
    {message&&<div className={messageClassName(message)} role={messageTone(message)==="error"?"alert":"status"}>{message}</div>}
    {showDiagnostics&&<section className={`panel diagnostic-panel ${diagnosticReport?.summary??"working"}`} aria-live="polite"><div className="section-heading"><div><h2>かんたん自動診断</h2><p>結果の文章だけで確認できます。通常はスクリーンショット不要です。</p></div><span className={`diagnostic-summary ${diagnosticReport?.summary??"working"}`}>{diagnosticSummaryLabel}</span></div>{!diagnosticReport?<div className="diagnostic-loading">ログイン・データ・端末・通知をまとめて確認しています…</div>:<div className="diagnostic-list">{diagnosticReport.checks.map(check=><div className={`diagnostic-row ${check.level}`} key={check.id}><span aria-hidden="true">{check.level==="pass"?"✓":check.level==="warn"?"!":"×"}</span><div><strong>{check.label}</strong><small>{check.detail}</small></div></div>)}</div>}<div className="diagnostic-actions">{diagnosticReport&&<><button onClick={()=>void shareDiagnostics()}>結果を共有</button><button className="secondary" onClick={()=>void copyDiagnostics()}>コピー</button></>}<button className="secondary" onClick={()=>void openQuickDiagnostics()} disabled={isPending("diagnostics")}>{isPending("diagnostics")?"診断中…":"もう一度診断"}</button><button className="ghost" onClick={()=>setShowDiagnostics(false)}>閉じる</button></div></section>}
    {view==="home"&&<>
      <section className="panel push-panel"><div className="section-heading"><div><h2>プッシュ通知</h2><p>大切な業務通知を受け取ります。</p></div><span className={pushEnabled?"push-status enabled":"push-status"}>{pushEnabled?"通知ON":currentPushPermission()==="denied"?"端末で拒否中":"通知OFF"}</span></div><div className="push-actions">{!pushEnabled?<button onClick={()=>void enablePush()} disabled={isPending("push-enable")}>{isPending("push-enable")?"処理中…":"通知を有効にする"}</button>:<><button className="secondary" onClick={()=>void requestPushTest()} disabled={isPending("push-test")}>{isPending("push-test")?"処理中…":"通知テスト"}</button><button className="ghost" onClick={()=>void disablePush()} disabled={isPending("push-disable")}>{isPending("push-disable")?"処理中…":"通知OFF"}</button></>}</div></section>
      <section className="hero-card"><div className="section-heading compact-heading"><h2>今日やること</h2><span className={`refresh-status ${businessDataSource}`}>{businessRefreshing?"自動更新中…":businessDataSource==="cached"?"前回データ":businessDataSource==="live"?"最新":"確認中"}</span></div><p>{taskSummary}</p><div className="task-list">{businessDataFallback??<>{visibleTasks.map(task=><button key={task.id} className={`task-card ${task.priority}`} onClick={()=>void openTask(task)}><strong>{task.title}</strong><span>{task.body}</span></button>)}{!tasks.length&&<div className="empty">未対応はありません。</div>}{tasks.length>5&&<button className="secondary task-list-toggle" aria-expanded={showAllTasks} onClick={()=>setShowAllTasks(value=>!value)}>{showAllTasks?"重要な5件に戻す":`すべて見る（残り${tasks.length-5}件）`}</button>}</>}</div></section>
      <section><h2>次回シフト</h2>{businessDataFallback??(activeJob?<article className="job shift-job" style={{"--job-accent":jobAccent(activeJob.menuName)} as CSSProperties}><span className="date">{activeJob.workDate||activeJob.dateKey}</span><span className="job-kind">{jobKind(activeJob.menuName)}</span><h3>{activeJob.storeName}</h3><p>{activeJob.makerName} / {activeJob.menuName}</p><span className="prep-chip">{prepSummary(activeJob)}</span><button onClick={()=>{setSelectedJob(activeJob);setView("shifts")}}>シフトを開く</button></article>:<div className="empty">確定シフトはありません。</div>)}</section>
    </>}
    {view==="jobs"&&<section><h2>募集中の案件</h2>{openJobsFallback??<div className="grid">{openJobs.map(job=><article className="job" key={job.id}><span className="date">{job.workDate||job.dateKey}</span><h3>{job.storeName}</h3><p>{job.makerName} / {job.menuName}</p><p>{job.workTime}</p><strong>{Number(job.basePay||0).toLocaleString()}円</strong><div className="actions"><button className="secondary" onClick={()=>setMessage(`${job.storeName} / ${job.makerName} / ${job.workTime}`)}>詳細</button><button onClick={()=>void apply(job)} disabled={isPending(`apply-${job.id}`)}>{isPending(`apply-${job.id}`)?"処理中…":"この案件に応募する"}</button></div></article>)}{!openJobs.length&&<div className="empty">現在募集中の案件はありません。</div>}</div>}</section>}
    {view==="shifts"&&<section><h2>自分のシフト</h2><div className="grid">{myJobs.map(job=><article className={`job shift-job ${selectedJob?.id===job.id?"selected":""}`} style={{"--job-accent":jobAccent(job.menuName)} as CSSProperties} key={job.id} onClick={()=>setSelectedJob(job)}><span className="date">{job.workDate||job.dateKey}</span><span className="job-kind">{jobKind(job.menuName)}</span><h3>{job.storeName}</h3><p>{job.workTime}</p><span className="prep-chip">{prepSummary(job)}</span></article>)}</div>{selectedJob&&<section className="panel shift-detail" style={{"--job-accent":jobAccent(selectedJob.menuName)} as CSSProperties}><div className="shift-detail-heading"><div><span className="job-kind">{jobKind(selectedJob.menuName)}</span><h2>{selectedJob.storeName}</h2><p>{selectedJob.storeAddress||selectedJob.menuName}</p></div><span className="prep-chip">{prepSummary(selectedJob)}</span></div><div className="route-panel"><strong>店舗への行き方</strong><div className="route-actions"><a href={mapsSearchUrl(selectedJob)} target="_blank" rel="noreferrer">地図で店舗を見る</a><a href={transitRouteUrl(selectedJob)} target="_blank" rel="noreferrer">公共交通の経路</a>{selectedJob.storeNearestStation&&<a href={stationSearchUrl(selectedJob)} target="_blank" rel="noreferrer">最寄駅：{selectedJob.storeNearestStation}</a>}</div></div><div className="form-grid"><label>体温<input value={temperature} onChange={e=>setTemperature(e.target.value)}/></label><label>到着予定時刻<input value={arrivalTime} onChange={e=>setArrivalTime(e.target.value)}/></label></div><button onClick={()=>void submitPreContact()} disabled={isPending("preContact")}>{isPending("preContact")?"処理中…":"事前連絡を送信"}</button><hr/><div className="prep-heading"><div><h3>資料準備状況</h3><p>{selectedJob.materialStatus||"ネットプリントの印刷状況から自動表示"}</p></div><span className="prep-chip">{prepSummary(selectedJob)}</span></div>{(selectedJob.netPrint?.items??[]).map(item=><div className="netprint-row" key={item.id}><strong>{item.number}</strong><button className={item.printed?"secondary":""} disabled={item.printed||isPending(`print-${item.id}`)} onClick={()=>void markPrinted(item)}>{item.printed?"印刷済み":isPending(`print-${item.id}`)?"処理中…":"印刷しました"}</button></div>)}{!(selectedJob.netPrint?.items??[]).length&&<div className="empty compact">ネットプリント番号はまだ届いていません。</div>}<hr/><div className="submission-actions"><button className="sales-floor-button" onClick={()=>void chooseSubmission("sales_floor",selectedJob)}>🖼️ 売場画像を提出</button><button className="report-button" onClick={()=>void chooseSubmission("report",selectedJob)}>📝 報告書を提出</button></div></section>}</section>}
    {view==="submit"&&!selectedAssignedJob&&<section className="panel"><h2>提出するシフトを選んでください</h2><p>提出は、本人に割り当てられた確定シフトからだけ受け付けます。</p><button onClick={()=>setView("shifts")}>シフトを選ぶ</button></section>}
    {view==="submit"&&selectedAssignedJob&&<section className={`panel submission-panel ${submissionType}`}><div className={`submission-identity ${submissionType}`}><span>{submissionType==="report"?"📝 報告書":"🖼️ 売場画像"}</span><strong>{submissionType==="report"?"報告内容が読める画像・PDF":"売場全体や陳列が分かる写真"}</strong></div><h2>{submissionType==="report"?"報告書":"売場画像"}を提出</h2><p>{selectedAssignedJob.storeName}{requestId&&" / 再提出依頼への対応"}</p>
      {resubmissionDetail&&<div className="resubmission-guide"><div><strong>再送理由</strong><p>{resubmissionDetail.request.reasons.join(" / ")}</p>{resubmissionDetail.request.note&&<p>{resubmissionDetail.request.note}</p>}</div><div className="source-preview"><span>撮り直す元画像</span>{resubmissionDetail.source?<SubmissionPreviewImage file={resubmissionDetail.source} onRefreshPreview={refreshFilePreview} className="source-preview-frame"/>:<div className="preview-placeholder">対象画像</div>}</div><small>この画像だけを撮り直し、1ファイル選んで再送してください。</small></div>}
      {submissionType==="sales_floor"&&<button className="secondary" onClick={()=>void setClientSubmitted(!selectedAssignedJob.submissionStatus?.salesFloor?.clientSubmitted)} disabled={isPending("clientSubmitted")}>{isPending("clientSubmitted")?"処理中…":selectedAssignedJob.submissionStatus?.salesFloor?.clientSubmitted?"クライアント提出を解除":"クライアントへ提出済み"}</button>}
      <div className="upload-box"><input type="file" multiple={!requestId} accept="image/*,.pdf" onChange={e=>{setFiles(Array.from(e.target.files??[]).slice(0,requestId?1:20));setSubmissionConfirmed(false);setSubmissionMessage("");}}/><small>{requestId?"再送対象は1ファイルだけ選択してください":`${submissionType==="report"?"報告書":"売場画像"}として最大20件、1件50MB`}</small></div><div className="file-list">{files.map(file=><div key={fileStateKey(file)}><span>{file.name}</span><em>{uploadState[fileStateKey(file)]??"下書き保存済み"}</em></div>)}</div><label className={`submission-confirmation ${submissionType}`}><input type="checkbox" checked={submissionConfirmed} onChange={e=>setSubmissionConfirmed(e.target.checked)}/><span>選択中は「{submissionType==="report"?"報告書":"売場画像"}」です。画像と種類を確認しました。</span></label><button className={submissionType==="report"?"report-button":"sales-floor-button"} onClick={()=>void uploadSubmission()} disabled={!files.length||!submissionConfirmed||isPending("uploadSubmission")||processingSubmission} aria-busy={isPending("uploadSubmission")||processingSubmission}>{processingSubmission?"Drive転送を確認中…":isPending("uploadSubmission")?"送信中…":requestId?"この画像を再送する":`${submissionType==="report"?"報告書":"売場画像"}を送信する`}</button>{submissionMessage&&<div className={`${messageClassName(submissionMessage)} submission-message`} role={messageTone(submissionMessage)==="error"?"alert":"status"}>{submissionMessage}</div>}
      <hr/><h3>提出履歴</h3>{submissionHistoryStatus==="loading"?<div className="history-loading" role="status">提出画面は操作できます。履歴を自動で読み込んでいます…</div>:submissionHistoryStatus==="error"?<div className="empty history-error">提出履歴を読み込めませんでした。<button className="secondary" onClick={()=>void loadSubmissionHistory(selectedAssignedJob.id,submissionType).catch(()=>undefined)}>履歴を再読み込み</button></div>:<div className="history-grid">{submissionHistory.flatMap(group=>group.files).map(file=><article key={`${file.submissionId}_${file.id}`}><SubmissionPreviewImage file={file} onRefreshPreview={refreshFilePreview}/><strong>{file.driveName||file.originalName}</strong><small>{file.purpose==="replacement"?"再送":"提出済み"}</small></article>)}{!submissionHistory.length&&<div className="empty">提出履歴はありません。</div>}</div>}
    </section>}
    {view==="contact"&&<section className="panel contact-panel"><h2>連絡先</h2><p>業務に関する連絡はこちらから行えます。</p><div className="contact-actions"><a className="contact-button" href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(CONTACT_EMAIL_SUBJECT)}`}>メールを送る</a><a className="contact-button" href={`tel:${CONTACT_PHONE}`}>電話をかける</a><a className="contact-button" href={CONTACT_FORM_URL} target="_blank" rel="noreferrer">お問い合わせフォームを開く</a></div><div className="contact-details"><strong>受付：平日 9:00〜18:00</strong><span>電話：<a href={`tel:${CONTACT_PHONE}`}>{CONTACT_PHONE_LABEL}</a></span><span>メール：<a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></span></div></section>}
    {showDevices&&<section className="panel"><div className="section-heading"><div><h2>ログイン中の端末</h2><p>使っていない端末はログアウトできます。</p></div><button className="ghost" onClick={()=>setShowDevices(false)}>閉じる</button></div><div className="device-list">{devices.map(device=><div className="device-row" key={device.id}><div><strong>{device.label||device.platform||"端末"}</strong><small>{isCurrentDevice(device)?"この端末 / ":""}{device.active===false?"ログアウト済み":"利用中"}</small></div><button className="secondary" disabled={device.active===false||isPending(`revoke-${device.id}`)} onClick={()=>void revokeDevice(device.id)}>{isPending(`revoke-${device.id}`)?"処理中…":"ログアウト"}</button></div>)}</div></section>}
    <nav className="bottom-nav">{([['home','🏠','ホーム'],['jobs','📅','案件'],['shifts','📋','シフト'],['submit','📤','提出'],['contact','☎️','連絡']] as [View,string,string][]).map(([id,icon,label])=><button key={id} className={view===id?"active":""} onClick={()=>navigate(id)}><span>{icon}</span>{label}</button>)}</nav>
  </main>;
}
