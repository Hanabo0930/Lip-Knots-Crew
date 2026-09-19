import type {MailApplication} from "./MailApplicationsPanel";
import {filterOpenJobs} from "./open-job-search";
import SubmissionImageViewer from "./SubmissionImageViewer";
import {type ApplicationAttempt,applicationAttemptOwner,loadSavedApplicationAttempts,observeApplicationAttempts,reserveApplicationAttempt,removeSavedApplicationAttempt} from "./application-attempt-store";
import {DeviceStorageError} from "./StartupBoundary";
import {resubmissionNotificationId,readResubmissionNotification} from "./resubmission-notification";
import {useShiftNotificationRoute} from "./useShiftNotificationRoute";
import ShiftJobCards,{shiftDateLabel,shiftTextLabel,shiftPage} from './ShiftJobCards';
import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  getIdTokenResult, isSignInWithEmailLink, onAuthStateChanged,
  signInWithEmailLink, signOut, User,
} from "firebase/auth";
import { collection, doc, getDocFromServer, getDocs, getDocsFromServer, limit, onSnapshot, orderBy, query, where, startAfter, QueryDocumentSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
const loadUploadStorage=()=>import("./upload-storage");
const loadSubmissionAttempt=()=>import("./submission-attempt-store");
import type { SubmissionAttempt } from "./submission-attempt-store";
import { auth, authPersistenceReady, db, firebaseConfigured, functions, firebaseApp } from "./firebase";
import { clearDraft, loadDraft, saveDraft, markDraftSubmitted, getSubmittedDraftReceipt } from "./draft-store";
import { submissionDraftKey } from "./submission-draft-key";
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
import SubmissionHistoryFiles from "./SubmissionHistoryFiles";
import {
  availableOpenJobs,
  hasValidDateKey,
  localDateKey,
  nextShiftJob,
  orderAssignedJobs,
  splitAssignedJobs,
} from "./job-list";
import { sleep, useAsyncAction } from "./useAsyncAction";

type View = "home" | "jobs" | "shifts" | "submit" | "contact";
type BusinessDataStatus = "idle" | "loading" | "ready" | "error";
type BusinessDataSource = "none" | "cached" | "live" | "stale";
type SubmissionHistoryStatus = "idle" | "loading" | "ready" | "error";
type SubmissionType = "report" | "sales_floor";
type PushAction = "enable" | "disable" | "test" | "status";
type NetPrintItem = { id: string; number: string; printed?: boolean };
type Job = {
  revision?: number; menuConditions?: string[];
  mailIntake?: unknown; mailIntakeReviewRequired?: boolean; pendingSourceWrite?: boolean; adminEditSheetWrite?: {pending?:boolean};
  id: string; workDate: string; dateKey: string; clientName: string; makerName: string;
  menuName: string; storeName: string; workTime: string; basePay: number|null; status: string;
  mailApplication?: {id:string;revision:number};
  cancelled?: boolean; sourceMissing?: boolean; applicationUnconfirmed?: boolean; assignmentUnresolved?: boolean;
  storeAddress?: string; storeNearestStation?: string; materialStatus?: string;
  companyId?: string; assignedStaffId?: string; preContactNeedsReview?: boolean; preContactSyncPending?: boolean; preContact?: { temperature?: string | number; arrivalTime?: string };
  netPrint?: { items?: NetPrintItem[] };
  submissionStatus?: { report?: { completed?: boolean }; salesFloor?: { completed?: boolean; clientSubmitted?: boolean; lipKnotsSubmitted?: boolean } };
};
type StaffTask = { id:string; jobId:string; kind:string; title:string; body:string; priority:"overdue"|"urgent"|"normal"; metadata?:Record<string,unknown>|null };
type DeviceSession = { id:string; deviceId?:string; uid?:string; label?:string; platform?:string; active?:boolean; lastSeenAt?:string };
type SubmissionFileView = { id:string; submissionId:string; originalName:string; driveName:string; contentType:string; sequence:number|null; purpose:string; status:string; previewUrl:string|null; completedAt:string|null; replacesFileId:string|null };
type SubmissionGroup = { id:string; purpose:string; status:string; createdAt:string|null; completedAt:string|null; files:SubmissionFileView[] };
type ResubmissionDetail = { request:{id:string;jobId:string;type:SubmissionType;scope?:"file"|"submission";reasons:string[];note:string;status:string}; source:SubmissionFileView|null; replacements:SubmissionFileView[] };

const demoDate=new Date();
demoDate.setDate(demoDate.getDate()+1);
const demoJobs: Job[] = [{
  id:"demo_job_1", workDate:demoDate.toLocaleDateString("ja-JP",{month:"numeric",day:"numeric",weekday:"short"}), dateKey:localDateKey(demoDate), clientName:"〇〇デモ",
  makerName:"〇〇乳業", menuName:"ヨーグルト試食（50代まで歓迎）", storeName:"イオン船橋店",
  workTime:"10:00〜18:00", basePay:10000, status:"assigned",
  storeAddress:"千葉県船橋市山手1丁目1-8", storeNearestStation:"新船橋駅", materialStatus:"発送準備中",
  netPrint:{items:[{id:"np1",number:"1234-5678",printed:false}]}, submissionStatus:{},
}];
const demoOpenJobs: Job[] = demoJobs.map(job=>({...job,id:`${job.id}_open`,storeName:"デモ募集店舗",status:"open",materialStatus:"資料番号待ち",netPrint:{items:[]}}));
const demoTasks: StaffTask[] = [
  {id:"t1",jobId:"demo_job_1",kind:"precontact",title:"事前連絡を送ってください",body:"イオン船橋店 / 前日15:00まで",priority:"urgent"},
  {id:"t2",jobId:"demo_job_1",kind:"netprint",title:"ネットプリントを印刷してください",body:"未印刷 1件",priority:"normal"},
  {id:"t3",jobId:"demo_job_1",kind:"resubmission",title:"報告書を再送してください",body:"手ブレで文字が読めません",priority:"urgent",metadata:{requestId:"demo_request",type:"report"}},
];

function jobPayLabel(value:unknown):string{
  return typeof value==="number"&&Number.isFinite(value)&&value>=0?value.toLocaleString("ja-JP",{maximumFractionDigits:20})+"円":"報酬は確認中";
}
function validNetPrintItem(value:unknown):value is NetPrintItem{
  if(!value||typeof value!=="object")return false;
  const item=value as Partial<NetPrintItem>;
  return typeof item.id==="string"&&Boolean(item.id.trim())&&typeof item.number==="string"&&Boolean(item.number.trim());
}
function validNetPrintTarget(items:unknown,item:unknown):boolean{
  return Array.isArray(items)&&validNetPrintItem(item)&&items.filter(value=>value&&typeof value==="object"&&value.id===item.id).length===1;
}
function preContactReadinessMessage(job:Job):string|null{
  if(caseMailPreparationHeld(job))return "受信内容・勤務条件の変更を確認中です。事前連絡はまだ送信できません。管理者の確認後に「シフトを更新」で状態を確認してください。";
  if(job.sourceMissing===true)return "取込元の案件を確認できません。事前連絡はまだ送信できません。「シフトを更新」で確認し、変わらない場合は管理者に確認してください。";
  if(job.applicationUnconfirmed===true)return "応募は受付済みです。シフト表の担当確認が済むまで、事前連絡は送信できません。「シフトを更新」で状態を確認してください。";
  if(job.assignmentUnresolved===true)return "担当者の照合待ちです。事前連絡はまだ送信できません。「シフトを更新」で確認し、変わらない場合は管理者に確認してください。";
  return null;
}
function caseMailPreparationHeld(job:Job):boolean{
  return job.mailIntakeReviewRequired===true||Boolean(job.mailIntake&&(job.pendingSourceWrite===true||job.adminEditSheetWrite?.pending===true));
}
function submissionReadinessMessage(job:Job):string|null{
  const reason=caseMailPreparationHeld(job)?"受信内容・勤務条件の変更を確認中です。":job.sourceMissing===true?"取込元の案件を確認できません。":job.applicationUnconfirmed===true?"応募は受付済みです。シフト表の担当確認を待っています。":job.assignmentUnresolved===true?"担当者の照合を待っています。":null;
  return reason?reason+"確認後に送信できます。選択した写真・PDFは保持しています。「シフトを更新」で状態を確認してください。":null;
}
function bootstrapRefreshToken(value:unknown):boolean{
  if(!value||typeof value!=="object"||Array.isArray(value)||typeof (value as {refreshToken?:unknown}).refreshToken!=="boolean")throw new Error("初期化の応答を確認できません。");
  return (value as {refreshToken:boolean}).refreshToken;
}
function staffScopeId(value:unknown):string{return typeof value==="string"&&value.trim()&&!value.includes("/")?value:"";}
function readSavedEmail(){try{return localStorage.getItem("lkcEmail")??"";}catch{return "";}}
function getOrCreateDeviceId(){try{const k="lkcDeviceId";const v=localStorage.getItem(k);if(v)return v;const n=crypto.randomUUID();localStorage.setItem(k,n);return n;}catch{throw new DeviceStorageError("端末情報を保存できません。");}}
function deviceLabel(){ return `${/iPhone|iPad|Android/i.test(navigator.userAgent)?"モバイル":"PC"} / ${navigator.platform||"端末"}`; }
const JOB_ACCENTS=["#d56f91","#5d91c9","#5aa583","#d28a46","#8a76c7","#bf6d62","#3e9ba4","#9b7a56"];
const DEVICE_HEARTBEAT_INTERVAL_MS=5*60*1000;
const PUSH_STATUS_REFRESH_INTERVAL_MS=60*1000;
const BUSINESS_DATA_REFRESH_INTERVAL_MS=30*1000;
const UPLOAD_CONCURRENCY=3;
const MAX_SUBMISSION_FILES=20;
const MAX_SUBMISSION_FILE_SIZE=50*1024*1024;
function contactShiftSummary(job:Job):string{
  const date=hasValidDateKey(job)?job.dateKey:"確認中";
  const text=(value:unknown)=>typeof value==="string"?value.trim():"";
  return [
    "勤務日："+date,
    "店舗："+(text(job.storeName)||"確認中"),
    "勤務時間："+(text(job.workTime)||"確認中"),
  ].join("\n");
}
function hasCompleteContactShift(job:Job):boolean{
  return hasValidDateKey(job)&&[job.storeName,job.workTime].every(value=>typeof value==="string"&&value.trim().length>0);
}
const CONTACT_EMAIL="info@lipknots.com";
const CONTACT_PHONE="08037906064";
const CONTACT_PHONE_LABEL="080-3790-6064";
const CONTACT_FORM_URL="https://lipknots.com/contact/";
const CONTACT_EMAIL_SUBJECT="Lip Knots Crewからのお問い合わせ";
const STAGING_ADMIN_APP_URL="https://lip-knots-crew-staging-admin.web.app";
let emailLinkSignInAttempt:{url:string;task:Promise<void>}|null=null;
let lastPushStatusRefreshAt=0;
let lastBusinessDataRefreshAt=0;
function stagingAdminLoginUrl(){const host=window.location.hostname;return host==="lip-knots-crew-staging.web.app"||host.startsWith("lip-knots-crew-staging--")?STAGING_ADMIN_APP_URL:"";}
function jobAccent(menuName:unknown){let hash=0;for(const char of typeof menuName==="string"&&menuName.trim()?menuName:"案件")hash=((hash*31)+char.codePointAt(0)!)|0;return JOB_ACCENTS[Math.abs(hash)%JOB_ACCENTS.length]??JOB_ACCENTS[0];}
function jobKind(menuName:unknown){return typeof menuName==="string"?menuName.replace(/[（(].*$/u,"").trim()||"業務確認中":"業務確認中";}
function mapDestination(job:Job){return [job.storeName,job.storeAddress].map(value=>shiftTextLabel(value,"")).filter(Boolean).join(" ");}
function mapsSearchUrl(job:Job){return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapDestination(job))}`;}
function transitRouteUrl(job:Job){return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(mapDestination(job))}&travelmode=transit`;}
function stationSearchUrl(job:Job){return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(shiftTextLabel(job.storeNearestStation,""))}`;}
function submissionSummary(job:Job){const sales=job.submissionStatus?.salesFloor;const salesCompleted=sales?.completed===true||sales?.clientSubmitted===true||sales?.lipKnotsSubmitted===true?true:sales?.completed;const label=(value:unknown)=>value===true?"完了":value===false?"未完了":"未確認";return `売場画像：${label(salesCompleted)} / 報告書：${label(job.submissionStatus?.report?.completed)}`;}
function prepSummary(job:Job){if(caseMailPreparationHeld(job))return"受信内容・勤務条件を確認中";if(job.preContactNeedsReview===true)return"事前連絡の再確認が必要";if(job.sourceMissing===true)return"取込元の案件を確認中";if(job.applicationUnconfirmed===true)return"応募受付済み・シフト表の担当確認待ち";if(job.assignmentUnresolved===true)return"担当者の照合待ち";const items=job.netPrint?.items??[];if(!Array.isArray(items))return"印刷情報を確認できません";const printed=items.filter(item=>validNetPrintTarget(items,item)&&item.printed===true).length;if(typeof job.materialStatus==="string"&&job.materialStatus.trim())return items.length?`${job.materialStatus} / 印刷済み ${printed}/${items.length}件`:job.materialStatus;if(!items.length)return"資料番号待ち";return printed===items.length?`準備完了（${printed}/${items.length}件）`:`準備中（${printed}/${items.length}件印刷済み）`;}
function messageTone(value:string){if(/自動で再確認|前回の業務データ|一時的に混み合|一時停止/u.test(value))return"warning";if(/できません|読み込めません|失敗|エラー|拒否|見つかりません|必要です/u.test(value))return"error";if(/受付済み|未確認/u.test(value))return"warning";if(/処理中|確認しています|読み込|送信中|転送中|待って/u.test(value))return"working";return"success";}
function messageClassName(value:string){return `message ${messageTone(value)}`;}
function submissionFileContentType(file:File){return file.type.startsWith("image/")||file.type==="application/pdf"?file.type:file.name.toLowerCase().endsWith(".pdf")?"application/pdf":file.type||"application/octet-stream";}
function fileStateKey(file:File){return `${file.name}_${file.lastModified}_${file.size}`;}
function formatFileSize(size:number){if(size<1024)return`${size} B`;if(size<1024*1024)return`${(size/1024).toFixed(1)} KB`;return`${(size/(1024*1024)).toFixed(1)} MB`;}
function SelectedSubmissionFile({file,position,status,disabled,onRemove}:{file:File;position:number;status:string;disabled:boolean;onRemove:()=>void}){
  const [previewUrl,setPreviewUrl]=useState("");
  const isImage=file.type.startsWith("image/");
  const isPdf=file.type==="application/pdf"||file.name.toLowerCase().endsWith(".pdf");
  useEffect(()=>{
    if(!isImage&&!isPdf){setPreviewUrl("");return;}
    const url=URL.createObjectURL(isPdf&&!isImage&&file.type!=="application/pdf"?new Blob([file],{type:"application/pdf"}):file);
    setPreviewUrl(url);
    return()=>URL.revokeObjectURL(url);
  },[file,isImage,isPdf]);
  return <div className="selected-file-row" role="group" aria-label={`${position}件目: ${file.name}`}>
    <div className="selected-file-preview">{previewUrl&&isImage?<img src={previewUrl} loading="lazy" decoding="async" alt={`${file.name}の送信前確認`}/>:<span>{isPdf?"PDF":"FILE"}</span>}</div>
    <div className="file-copy"><span>{position}. {file.name}</span><small>{formatFileSize(file.size)}</small><em>{status}</em>{previewUrl&&isImage&&<SubmissionImageViewer src={previewUrl} name={file.name} className="secondary"/>}{previewUrl&&isPdf&&!isImage&&<a className="pdf-open-link" href={previewUrl} target="_blank" rel="noopener noreferrer" aria-label={`${file.name}を送信前に別タブで開く`}>PDFを確認（別タブ）</a>}</div>
    <button className="file-remove" onClick={onRemove} disabled={disabled} aria-label={`${position}件目のファイルを外す`}>外す</button>
  </div>;
}
function EmptyAction({title,body,action,onAction,secondaryAction,onSecondaryAction}:{title:string;body:string;action:string;onAction:()=>void;secondaryAction?:string;onSecondaryAction?:()=>void}){
  return <div className="empty empty-action">
    <strong>{title}</strong>
    <p>{body}</p>
    <div className="empty-action-actions">
      <button onClick={onAction}>{action}</button>
      {secondaryAction&&onSecondaryAction&&<button className="secondary" onClick={onSecondaryAction}>{secondaryAction}</button>}
    </div>
  </div>;
}
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
  const adminLoginUrl=useMemo(stagingAdminLoginUrl,[]);
  const [user,setUser]=useState<User|null>(null); const [companyId,setCompanyId]=useState(""); const [staffId,setStaffId]=useState("");
  const loginEmailRef=useRef<HTMLInputElement|null>(null);
  const [email,setEmail]=useState(()=>readSavedEmail()); const [loginCode,setLoginCode]=useState(""); const [message,setMessage]=useState("");
  const [view,setView]=useState<View>("home"); const [openJobs,setOpenJobs]=useState<Job[]>(firebaseConfigured?[]:demoOpenJobs);
  const [showMailApplications,setShowMailApplications]=useState(false);
  const [MailPanel,setMailPanel]=useState<typeof import("./MailApplicationsPanel").default|null>(null);
  const [mailPanelError,setMailPanelError]=useState("");
  const mailButtonRef=useRef<HTMLButtonElement>(null),mailPanelVersion=useRef(0);
  const [businessDate,setBusinessDate]=useState(()=>localDateKey());
  useEffect(()=>{
    const refreshBusinessDate=()=>setBusinessDate(localDateKey());
    const refreshVisibleBusinessDate=()=>{if(document.visibilityState==="visible")refreshBusinessDate();};
    const timer=window.setInterval(refreshBusinessDate,60_000);
    window.addEventListener("focus",refreshBusinessDate);
    document.addEventListener("visibilitychange",refreshVisibleBusinessDate);
    return ()=>{
      window.clearInterval(timer);
      window.removeEventListener("focus",refreshBusinessDate);
      document.removeEventListener("visibilitychange",refreshVisibleBusinessDate);
    };
  },[]);
  const [expandedOpenJobId,setExpandedOpenJobId]=useState("");
  const [pendingApplicationJobId,setPendingApplicationJobId]=useState("");
  const [acceptedApplicationJobId,setAcceptedApplicationJobId]=useState("");
  const applicationResultButtonRef=useRef<HTMLButtonElement|null>(null);
  const applicationResultFocusRef=useRef<{authVersion:number;navigationVersion:number}|null>(null);
  const [pendingShiftAction,setPendingShiftAction]=useState("");
  const [myJobs,setMyJobs]=useState<Job[]>(firebaseConfigured?[]:demoJobs); const [tasks,setTasks]=useState<StaffTask[]>(firebaseConfigured?[]:demoTasks);
  const [selectedJob,setSelectedJob]=useState<Job|null>(firebaseConfigured?null:(demoJobs[0]??null)); const [temperature,setTemperature]=useState(""); const [arrivalTime,setArrivalTime]=useState("");
  const preContactDraftsRef=useRef(new Map<string,{temperature:string;arrivalTime:string}>());
  const preContactTemperatureRef=useRef<HTMLInputElement|null>(null);
  const preContactArrivalRef=useRef<HTMLInputElement|null>(null);
  const [preContactError,setPreContactError]=useState<""|"temperature"|"arrival">("");
  const preContactDraftKey=[user?.uid??"demo",companyId,staffId,selectedJob?.id??"",selectedJob?.dateKey??""].join("|");
  useEffect(()=>{
    setPreContactError("");
    const draft=preContactDraftsRef.current.get(preContactDraftKey);
    if(draft){setTemperature(draft.temperature);setArrivalTime(draft.arrivalTime);return;}
    setTemperature(typeof selectedJob?.preContact?.temperature==="number"&&Number.isFinite(selectedJob.preContact.temperature)?String(selectedJob.preContact.temperature):"");
    const savedTime=selectedJob?.preContact?.arrivalTime??"";
    setArrivalTime(typeof savedTime==="string"&&/^([01]?\d|2[0-3]):[0-5]\d$/.test(savedTime)?savedTime.padStart(5,"0"):"");
  },[user?.uid,companyId,staffId,selectedJob?.id,selectedJob?.dateKey,selectedJob?.preContact?.temperature,selectedJob?.preContact?.arrivalTime]);
  const [submissionType,setSubmissionType]=useState<SubmissionType>("report"); const [requestId,setRequestId]=useState("");
  const [submissionConfirmed,setSubmissionConfirmed]=useState(false);
  const [submissionMessage,setSubmissionMessage]=useState("" );
  const [draftCleanup,setDraftCleanup]=useState<{key:string;durable:boolean;attempt?:SubmissionAttempt}|null>(null);
  const [files,setFiles]=useState<File[]>([]); const [uploadState,setUploadState]=useState<Record<string,string>>({});
  const [draftHydrating,setDraftHydrating]=useState(false);
  const [deviceSessionId,setDeviceSessionId]=useState(""); const [devices,setDevices]=useState<DeviceSession[]>([]); const [showDevices,setShowDevices]=useState(false);
  const [deviceListUncertain,setDeviceListUncertain]=useState(false);
  const [pendingDeviceId,setPendingDeviceId]=useState("");
  const [showAccountMenu,setShowAccountMenu]=useState(false);
  const accountMenuToggleRef=useRef<HTMLButtonElement|null>(null),deviceHeadingRef=useRef<HTMLHeadingElement|null>(null);
  useEffect(()=>{if(showDevices)deviceHeadingRef.current?.focus();},[showDevices]);
  const currentDeviceId=useMemo(()=>getOrCreateDeviceId(),[]);
  const [pushEnabled,setPushEnabled]=useState(false);
  const [pushStatusUncertain,setPushStatusUncertain]=useState(false);
  const pushStateVersionRef=useRef(0),pushReadVersionRef=useRef(0),diagnosticsVersionRef=useRef(0);
  const [pendingPushAction,setPendingPushAction]=useState<PushAction|null>(null);
  const [showPushActions,setShowPushActions]=useState(false);
  const [showAllTasks,setShowAllTasks]=useState(false);
  const [showPastShifts,setShowPastShifts]=useState(false);
  const [upcomingPage,setUpcomingPage]=useState(0);
  const [pastPage,setPastPage]=useState(0);
  const [shiftFocusRequest,setShiftFocusRequest]=useState(0);
  const homeHeadingRef=useRef<HTMLHeadingElement>(null),jobsHeadingRef=useRef<HTMLHeadingElement>(null),contactHeadingRef=useRef<HTMLHeadingElement>(null);
  const previousHeadingViewRef=useRef(view);
  useEffect(()=>{if(previousHeadingViewRef.current===view)return;previousHeadingViewRef.current=view;const heading=view==="home"?homeHeadingRef:view==="jobs"?jobsHeadingRef:view==="contact"?contactHeadingRef:view==="submit"?submissionPanelRef:null;heading?.current?.focus({preventScroll:true});},[view]);
  const shiftHeadingRef=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{if(view==="shifts")shiftHeadingRef.current?.focus({preventScroll:true});},[view]);
  const shiftDetailRef=useRef<HTMLElement>(null);
  useEffect(()=>{if(shiftFocusRequest){shiftDetailRef.current?.focus({preventScroll:true});shiftDetailRef.current?.scrollIntoView({block:'start'});}},[shiftFocusRequest]);
  function openShiftJob(job:Job){if(splitAssignedJobs([job]).past.length)setShowPastShifts(true);setSelectedJob(job);setShiftFocusRequest(value=>value+1);}
  function togglePastShifts(){
    if(showPastShifts&&selectedJob&&upcomingShifts.length&&pastShifts.some(job=>job.id===selectedJob.id))setSelectedJob(upcomingShifts[0]);
    setShowPastShifts(!showPastShifts);
  }
  const [hasMoreUpcomingShifts,setHasMoreUpcomingShifts]=useState(false);
  const [upcomingShiftMessage,setUpcomingShiftMessage]=useState("" );
  const upcomingShiftCursorRef=useRef<QueryDocumentSnapshot|null>(null);
  const [hasMorePastShifts,setHasMorePastShifts]=useState(false);
  const [pastShiftMessage,setPastShiftMessage]=useState("");
  const pastShiftCursorRef=useRef<QueryDocumentSnapshot|null>(null);
  const pastShiftDateRef=useRef("");
  const pastShiftVersionRef=useRef(0);
  const tasksReadVersionRef=useRef(0);
  const [submissionHistory,setSubmissionHistory]=useState<SubmissionGroup[]>([]);
  const [submissionHistoryStatus,setSubmissionHistoryStatus]=useState<SubmissionHistoryStatus>("idle");
  const [resubmissionDetail,setResubmissionDetail]=useState<ResubmissionDetail|null>(null);
  const [processingSubmission,setProcessingSubmission]=useState(false);
  const [authResolved,setAuthResolved]=useState(!firebaseConfigured);
  const [businessDataStatus,setBusinessDataStatus]=useState<BusinessDataStatus>(firebaseConfigured?"idle":"ready");
  const shiftNotification=useShiftNotificationRoute<Job>({
    ready:!firebaseConfigured||!!user&&!!companyId&&!!staffId&&businessDataStatus==="ready",
    scope:[user?.uid??"",companyId,staffId].join("|"),
    load:async id=>firebaseConfigured?loadTaskJob(id):demoJobs.find(job=>job.id===id)??null,
    onOpen:job=>{openShiftJob(job);navigate("shifts");},
  });


  const [businessDataSource,setBusinessDataSource]=useState<BusinessDataSource>(firebaseConfigured?"none":"live");
  const [businessRefreshing,setBusinessRefreshing]=useState(false);
  const [openJobsStatus,setOpenJobsStatus]=useState<BusinessDataStatus>(firebaseConfigured?"idle":"ready");
  const [homeDisplayMs,setHomeDisplayMs]=useState<number|null>(firebaseConfigured?null:0);
  const [businessRefreshMs,setBusinessRefreshMs]=useState<number|null>(firebaseConfigured?null:0);
  const [homeLoadedFromCache,setHomeLoadedFromCache]=useState(false);
  const [showDiagnostics,setShowDiagnostics]=useState(false);
  const diagnosticHeadingRef=useRef<HTMLHeadingElement|null>(null);
  useEffect(()=>{if(showDiagnostics)diagnosticHeadingRef.current?.focus();},[showDiagnostics]);
  const [diagnosticReport,setDiagnosticReport]=useState<DiagnosticReport|null>(null);
  const [emailLinkPending,setEmailLinkPending]=useState(()=>Boolean(auth&&isSignInWithEmailLink(auth,window.location.href)));
  const hydratedDraftKeyRef=useRef("");
  const draftHydratingRef=useRef(false);
  const skipNextDraftSaveRef=useRef(false);
  const authLoadVersionRef=useRef(0);
  const navigationVersionRef=useRef(0);
  const submissionPanelRef=useRef<HTMLElement>(null);
  const fileRemoveFocusRef=useRef<{index:number;authVersion:number;contextVersion:number;navigationVersion:number}|null>(null);
  const businessRefreshInFlightRef=useRef(false);
  const applicationAttemptsRef=useRef(new Map<string,ApplicationAttempt>());
  const [,refreshApplicationAttempts]=useState(0);
  useEffect(()=>{
    if(!firebaseConfigured||!companyId||!staffId||!user?.uid)return;
    return observeApplicationAttempts(applicationAttemptOwner(companyId,staffId,user.uid),attempts=>{
      // 別画面の保存記録を取り込み、手元の未確認記録はシフトの確定確認まで保持する。
      for(const [jobId,attempt] of attempts)applicationAttemptsRef.current.set(jobId,attempt);
      refreshApplicationAttempts(value=>value+1);
    },()=>setMessage("保存済みの応募確認記録を読み込めません。ブラウザーの保存設定とシフトでの確定状況を確認してください。"));
  },[companyId,staffId,user?.uid]);
  useEffect(()=>{applicationAttemptsRef.current.clear();if(!firebaseConfigured||!companyId||!staffId||!user?.uid)return;try{applicationAttemptsRef.current=loadSavedApplicationAttempts(applicationAttemptOwner(companyId,staffId,user.uid));refreshApplicationAttempts(value=>value+1);}catch{setMessage("保存済みの応募確認記録を読み込めません。ブラウザーの保存設定とシフトでの確定状況を確認してください。");}},[companyId,staffId,user?.uid]);
  const openJobsLoadVersionRef=useRef(0);
  const openJobsCursorRef=useRef<QueryDocumentSnapshot|null>(null);
  const openJobsDateRef=useRef("");
  const [hasMoreOpenJobs,setHasMoreOpenJobs]=useState(false);
  const [openJobsPageMessage,setOpenJobsPageMessage]=useState("");
  const [openJobQuery,setOpenJobQuery]=useState("");
  const [openJobPage,setOpenJobPage]=useState(0);
  const openJobListRef=useRef<HTMLDivElement>(null);
  const submissionProcessingVersionRef=useRef(0);

  const visibleOpenJobs=useMemo(()=>availableOpenJobs(openJobs,businessDate),[openJobs,businessDate]);
  const matchingOpenJobs=useMemo(()=>filterOpenJobs(visibleOpenJobs,openJobQuery),[visibleOpenJobs,openJobQuery]);
  const openJobPageSlice=shiftPage(matchingOpenJobs,openJobPage);
  function moveOpenJobPage(page:number){setOpenJobPage(page);openJobListRef.current?.focus({preventScroll:true});openJobListRef.current?.scrollIntoView({block:"start"});}
  const previousVisibleOpenJobIdsRef=useRef(new Set(visibleOpenJobs.map(job=>job.id)));
  useEffect(()=>{
    const ids=new Set(visibleOpenJobs.map(job=>job.id));
    const removed=Array.from(previousVisibleOpenJobIdsRef.current).some(id=>!ids.has(id));
    previousVisibleOpenJobIdsRef.current=ids;
    if(removed&&view==="jobs"&&!isPending("apply-action")&&document.activeElement===document.body)jobsHeadingRef.current?.focus({preventScroll:true});
  },[visibleOpenJobs,view]);
  const selectedAssignedJob=selectedJob?myJobs.find(job=>job.id===selectedJob.id)??null:null;
  const previousSubmissionAvailableRef=useRef(Boolean(selectedAssignedJob));
  useEffect(()=>{const available=Boolean(selectedAssignedJob),changed=previousSubmissionAvailableRef.current!==available;previousSubmissionAvailableRef.current=available;if(changed&&view==="submit"&&document.activeElement===document.body)submissionPanelRef.current?.focus({preventScroll:true});},[view,Boolean(selectedAssignedJob)]);
  const contactShiftText=selectedAssignedJob?contactShiftSummary(selectedAssignedJob):"";
  const shiftCopyContextRef=useRef("");
  shiftCopyContextRef.current=JSON.stringify([selectedJob?.id??"",shiftTextLabel(selectedJob?.storeAddress,""),contactShiftText]);
  const {upcoming:upcomingShifts,past:pastShifts}=useMemo(()=>splitAssignedJobs(myJobs,businessDate),[myJobs,businessDate]);
  useEffect(()=>{const upcomingIndex=upcomingShifts.findIndex(job=>job.id===selectedJob?.id);const pastIndex=pastShifts.findIndex(job=>job.id===selectedJob?.id);if(upcomingIndex>=0)setUpcomingPage(Math.floor(upcomingIndex/50));if(pastIndex>=0)setPastPage(Math.floor(pastIndex/50));},[selectedJob?.id,shiftFocusRequest]);
  const draftOwner=firebaseConfigured?(user&&companyId?JSON.stringify([companyId,user.uid]):""):"demo";
  const draftKey=selectedAssignedJob?submissionDraftKey(draftOwner,selectedAssignedJob.id,submissionType,requestId):"";
  const submissionHistoryVersionRef=useRef(0);
  const resubmissionDetailVersionRef=useRef(0);
  const submissionContextVersionRef=useRef(0);
  const previewContextRef=useRef("");
  previewContextRef.current=draftKey;
  useEffect(()=>{
    setSubmissionConfirmed(false);
    hydratedDraftKeyRef.current="";
    draftHydratingRef.current=Boolean(draftKey);
    skipNextDraftSaveRef.current=false;
    setDraftHydrating(Boolean(draftKey));
    if(!draftKey)return;
    const submittedReceipt=getSubmittedDraftReceipt(draftKey);
    if(submittedReceipt)setDraftCleanup({key:draftKey,durable:submittedReceipt.durable});
    let active=true;
    void loadDraft(draftKey).then(draftFiles=>{
      if(!active)return;
      setFiles(draftFiles);
      hydratedDraftKeyRef.current=draftKey;
      skipNextDraftSaveRef.current=true;
      draftHydratingRef.current=false;
      setDraftHydrating(false);
    }).catch(()=>{
      if(!active)return;
      setFiles([]);
      hydratedDraftKeyRef.current=draftKey;
      skipNextDraftSaveRef.current=true;
      draftHydratingRef.current=false;
      setDraftHydrating(false);
      showSubmissionMessage("保存済みの下書きを読み込めませんでした。ファイルを選び直してください。");
    });
    return()=>{active=false;};
  },[draftKey]);
  const draftSavePaused=isPending("submission-context")||isPending("submission-files");
  useEffect(()=>{
    if(!draftKey||draftHydrating||hydratedDraftKeyRef.current!==draftKey||draftSavePaused)return;
    if(skipNextDraftSaveRef.current){skipNextDraftSaveRef.current=false;return;}
    let active=true,timerPending=true;
    const pendingDraftKey=draftKey,pendingFiles=files,authVersion=authLoadVersionRef.current;
    const timer=setTimeout(()=>{
      timerPending=false;
      // 再描画前に解除が始まった場合も、古い選択内容を保存しない。
      if(isPending("submission-context")||isPending("submission-files"))return;
      void saveDraft(draftKey,files).catch(()=>{
        if(active&&hydratedDraftKeyRef.current===draftKey)showSubmissionMessage("下書きを保存できませんでした。選択中のファイルはこの画面から送信できます。画面を閉じる前に送信するか、端末の空き容量・保存設定を確認してください。");
      });
    },300);
    return()=>{
      active=false;clearTimeout(timer);
      if(timerPending&&!previewContextRef.current&&authVersion===authLoadVersionRef.current&&pendingFiles.length&&!isPending("submission-context")&&!isPending("submission-files")&&!getSubmittedDraftReceipt(pendingDraftKey)){
        void saveDraft(pendingDraftKey,pendingFiles).catch(()=>{if(authVersion===authLoadVersionRef.current&&!previewContextRef.current)setMessage("提出対象が見つからず、下書きも保存できませんでした。画面を閉じず、シフトを更新して対象を確認してください。");});
      }
    };
  },[draftKey,draftHydrating,files,draftSavePaused]);
  useEffect(()=>{ if(!pushEnabled)setShowPushActions(false); },[pushEnabled]);


  const resubmissionNotification=useShiftNotificationRoute<{job:Job;type:SubmissionType;requestId:string}>({
    ready:(!firebaseConfigured||!!user&&!!companyId&&!!staffId&&businessDataStatus==="ready")&&!draftHydrating&&hydratedDraftKeyRef.current===draftKey,
    scope:[user?.uid??"",companyId,staffId].join("|"),parse:resubmissionNotificationId,
    load:async id=>{
      const version=authLoadVersionRef.current;
      if(!firebaseConfigured){const task=demoTasks.find(task=>task.metadata?.requestId===id);const job=demoJobs.find(job=>job.id===task?.jobId);return task&&job?{job,type:task.metadata?.type as SubmissionType,requestId:id}:null;}
      if(!functions)throw Error("再提出情報に接続できません。");
      const activeFunctions=functions;
      return readResubmissionNotification(id,async()=>{const response=await httpsCallable(activeFunctions,"getResubmissionComparison")({requestId:id});return response.data;},loadTaskJob,()=>version===authLoadVersionRef.current);
    },
    onOpen:(target,consume)=>startSubmission(target.type,target.job,target.requestId,consume),
  });

  function closeNotificationPanel(cancel:()=>void){
    cancel();
    const heading=view==="home"?homeHeadingRef:view==="jobs"?jobsHeadingRef:view==="shifts"?shiftHeadingRef:view==="submit"?submissionPanelRef:contactHeadingRef;
    heading.current?.focus({preventScroll:true});
  }

  function isSubmissionActionPending(){
    return draftHydratingRef.current||isPending("submission-refresh")||isPending("shift-action")||isPending("submission-context")||isPending("submission-files")||isPending("task-job")||isPending("uploadSubmission")||processingSubmission;
  }

  useEffect(()=>{
    const scope=[user?.uid??"demo",companyId,staffId].join("|")+"|";
    const preventPreContactExit=(event:BeforeUnloadEvent)=>{
      const dirty=[...preContactDraftsRef.current].some(([key,draft])=>{
        if(!key.startsWith(scope))return false;
        const saved=myJobs.find(job=>scope+job.id+"|"+(job.dateKey??"")===key)?.preContact;
        const savedTime=saved?.arrivalTime??"";
        const time=typeof savedTime==="string"&&/^([01]?\d|2[0-3]):[0-5]\d$/.test(savedTime)?savedTime.padStart(5,"0"):"";
        return draft.temperature!==(typeof saved?.temperature==="number"&&Number.isFinite(saved.temperature)?String(saved.temperature):"")||draft.arrivalTime!==time;
      });
      if(dirty){event.preventDefault();event.returnValue="";}
    };
    window.addEventListener("beforeunload",preventPreContactExit);
    return ()=>window.removeEventListener("beforeunload",preventPreContactExit);
  },[user?.uid,companyId,staffId,myJobs]);

  useEffect(()=>{
    const pendingApplicationFocus=applicationResultFocusRef.current;
    if(!pendingApplicationFocus||isPending("apply-action"))return;
    applicationResultFocusRef.current=null;
    if(view!=="jobs"||pendingApplicationFocus.authVersion!==authLoadVersionRef.current||pendingApplicationFocus.navigationVersion!==navigationVersionRef.current)return;
    if(document.activeElement!==document.body&&document.activeElement!==applicationResultButtonRef.current)return;
    applicationResultButtonRef.current?.focus();
  },[acceptedApplicationJobId,view,isPending("apply-action")]);

  useEffect(()=>{
    const pendingFileFocus=fileRemoveFocusRef.current;
    if(!pendingFileFocus||isPending("submission-files"))return;
    fileRemoveFocusRef.current=null;
    if(pendingFileFocus.authVersion!==authLoadVersionRef.current||pendingFileFocus.contextVersion!==submissionContextVersionRef.current||pendingFileFocus.navigationVersion!==navigationVersionRef.current)return;
    const panel=submissionPanelRef.current;
    const buttons=panel?.querySelectorAll<HTMLButtonElement>(".file-remove");
    const target=buttons?.[Math.min(pendingFileFocus.index,buttons.length-1)]??panel?.querySelector<HTMLInputElement>(".file-picker-button.library input");
    target?.focus();
  },[files,isPending("submission-files")]);

  function isLoginActionPending(){
    return isPending("login")||isPending("login-code");
  }

  useEffect(()=>{ if(!auth)return; return onAuthStateChanged(auth,async current=>{
    const loadStarted=performance.now();
    const authLoadVersion=++authLoadVersionRef.current;
    applicationAttemptsRef.current.clear();
    mailPanelVersion.current++;setShowMailApplications(false);setMailPanelError("");
    preContactDraftsRef.current.clear();
    setAcceptedApplicationJobId("");
    applicationResultFocusRef.current=null;
    businessRefreshInFlightRef.current=false;
    const isCurrentAuthLoad=()=>authLoadVersion===authLoadVersionRef.current;
    openJobsLoadVersionRef.current+=1;
    openJobsCursorRef.current=null;
    setHasMoreOpenJobs(false);
    setOpenJobsPageMessage("");
    pastShiftVersionRef.current+=1;
    pastShiftCursorRef.current=null;
    upcomingShiftCursorRef.current=null;
    setUpcomingPage(0);setPastPage(0);
    setHasMoreUpcomingShifts(false);
    setUpcomingShiftMessage("" );
    setHasMorePastShifts(false);
    setPastShiftMessage("");
    submissionProcessingVersionRef.current+=1;
    setProcessingSubmission(false);
    setPendingApplicationJobId("");
    setPendingShiftAction("");
    setDevices([]);
    setShowDevices(false);
    setDeviceListUncertain(false);
    setPendingDeviceId("");setPendingPushAction(null);
    setUser(current);
    setAuthResolved(true);
    if(firebaseConfigured){
      setCompanyId(""); setStaffId(""); setOpenJobs([]); setOpenJobQuery(""); setOpenJobPage(0); setMyJobs([]); setTasks([]); setSelectedJob(null);
      setDraftCleanup(null);
      setFiles([]); setUploadState({}); setSubmissionHistory([]); setSubmissionHistoryStatus("idle"); setSubmissionMessage("");
      setBusinessDataStatus(current?"loading":"idle");
      setBusinessDataSource("none");
      setBusinessRefreshing(Boolean(current));
      setOpenJobsStatus("idle");
      setHomeDisplayMs(null);
      setBusinessRefreshMs(null);
      setHomeLoadedFromCache(false);
      setPushEnabled(false);setPushStatusUncertain(false);
      setShowPastShifts(false);
      closeDiagnostics();
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
        const jobs=orderAssignedJobs(snapshot.jobs);
        setCompanyId(cid); setStaffId(sid);
        setMyJobs(jobs);
        setTasks(snapshot.tasks);
        setSelectedJob(jobs[0]??null);
        setBusinessDataStatus("ready");
        setBusinessDataSource("cached");
        setHomeDisplayMs(Math.round(performance.now()-loadStarted));
        setHomeLoadedFromCache(true);
        return true;
      };
      const bootstrap=httpsCallable(functions,"bootstrapSession");
      const bootstrapPromise=bootstrap();
      // 認証情報の待機中やアカウント切替後の早期失敗も処理済みにする。
      void bootstrapPromise.catch(()=>undefined);
      const knownScope=loadLastBusinessScope(current.uid);
      if(knownScope&&restoreCachedBusinessData(knownScope.companyId,knownScope.staffId)){
        restoredCachedData=true;
        restoredScope=knownScope;
      }else if(knownScope){
        clearBusinessSnapshot(current.uid,knownScope.companyId,knownScope.staffId);
      }
      const initialToken=await getIdTokenResult(current).catch(()=>null);
      if(!isCurrentAuthLoad())return;
      const initialCid=staffScopeId(initialToken?.claims.companyId);
      const initialSid=staffScopeId(initialToken?.claims.staffId);
      if(!restoredCachedData&&initialCid&&initialSid&&restoreCachedBusinessData(initialCid,initialSid)){
        restoredCachedData=true;
        restoredScope={companyId:initialCid,staffId:initialSid};
      }
      const result=await bootstrapPromise;
      if(!isCurrentAuthLoad())return;
      const refreshToken=bootstrapRefreshToken(result.data);
      if(refreshToken){await current.getIdToken(true);if(!isCurrentAuthLoad())return;}
      const token=refreshToken||!initialToken?await getIdTokenResult(current):initialToken;
      if(!isCurrentAuthLoad())return;
      const cid=staffScopeId(token.claims.companyId); const sid=staffScopeId(token.claims.staffId);
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
      const loaded=await loadPrimaryBusinessData(sid,cid,current.uid);
      if(!isCurrentAuthLoad()||!loaded)return;
      setBusinessDataStatus("ready");
      setBusinessDataSource("live");
      const refreshedInMs=Math.round(performance.now()-loadStarted);
      if(!restoredCachedData)setHomeDisplayMs(refreshedInMs);
      setBusinessRefreshMs(refreshedInMs);
      lastBusinessDataRefreshAt=Date.now();
      void registerCurrentDevice(authLoadVersion).catch(()=>{if(isCurrentAuthLoad())setMessage("端末情報を登録できませんでした。再読み込みしてください。");});
      void refreshOpenJobs(false,cid);
      void refreshPushStatus(true);
    }catch{
      if(!isCurrentAuthLoad())return;
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
      if(isCurrentAuthLoad())setBusinessRefreshing(false);
    }
  }); },[]);
  useEffect(()=>{
    if(!auth)return;
    const loginUrl=window.location.href;
    if(!isSignInWithEmailLink(auth,loginUrl)){setEmailLinkPending(false);return;}
    const saved=readSavedEmail()||(window.prompt("メールアドレスを入力してください")??"");
    if(!saved){setMessage("ログインに使ったメールアドレスを入力してください。");setEmailLinkPending(false);return;}
    let active=true;
    setEmailLinkPending(true);
    setMessage("ログインを確認しています…");
    void completeEmailLinkSignIn(loginUrl,saved).then(()=>{
      if(!active)return;
      window.history.replaceState({},document.title,"/");
      setMessage("ログインしました。");
    }).catch(()=>{if(active)setMessage("メールのリンクでログインできませんでした。メールに記載された確認コードを入力するか、「ログインメールを送る」から送り直してください。");}).finally(()=>{if(active)setEmailLinkPending(false);});
    return()=>{active=false;};
  },[]);
  useEffect(()=>{
    if(!user||!deviceSessionId||!functions||!db||!auth)return;
    const activeAuth=auth;
    const activeFunctions=functions;
    const authVersion=authLoadVersionRef.current;
    let stopped=false;
    let heartbeatPending=false;
    let revocationPending=false;
    let revocationCompleted=false;
    const handleRevoked=async(message:string)=>{
      if(stopped||authVersion!==authLoadVersionRef.current||revocationPending||revocationCompleted)return;
      revocationPending=true;
      setMessage(message);
      clearBusinessSnapshot(user.uid,companyId,staffId);
      try{await signOut(activeAuth);revocationCompleted=true;}
      catch{if(!stopped&&authVersion===authLoadVersionRef.current)setMessage("ログアウトに失敗しました。再読み込みしてください。");}
      finally{revocationPending=false;}
    };
    const heartbeat=async()=>{
      if(stopped||authVersion!==authLoadVersionRef.current||heartbeatPending||revocationPending||revocationCompleted)return;
      heartbeatPending=true;
      try{
        await httpsCallable(activeFunctions,"heartbeatDeviceSession")({sessionId:deviceSessionId});
      }catch(error){
        const code=String((error as {code?:unknown}|null)?.code??"");
        if(code.endsWith("permission-denied"))await handleRevoked("この端末はログアウトされています。");
      }finally{heartbeatPending=false;}
    };
    const stopWatching=watchDeviceSession(deviceSessionId,()=>handleRevoked("この端末はログアウトされました。"));
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
  useEffect(()=>{
    if(!user)return;
    let active=true;
    let unsub:(()=>void)|null=null;
    void listenForForegroundPush(payload=>{if(active)setMessage(`${payload.data?.title??"Lip Knots Crew"}：${payload.data?.body??"新しいお知らせがあります。"}`);}).then(value=>{
      if(!active){value?.();return;}
      unsub=value;
    }).catch(()=>undefined);
    return()=>{active=false;unsub?.();};
  },[user]);
  useEffect(()=>{if(tasks.length<=5)setShowAllTasks(false);},[tasks.length]);
  useEffect(()=>{
    if(!message||messageTone(message)!=="success")return;
    const timer=window.setTimeout(()=>setMessage(current=>current===message?"":current),6000);
    return()=>window.clearTimeout(timer);
  },[message]);

  async function fetchMyJobs(sid=staffId,cid=companyId,serverOnly=false,companionRead:Promise<unknown>=Promise.resolve()):Promise<Job[]>{
    if(!db||!sid||!cid)return[];
    const today=localDateKey();
    const readJobs=serverOnly?getDocsFromServer:getDocs;
    const version=++pastShiftVersionRef.current;
    const authVersion=authLoadVersionRef.current;
    // 過去の件数が増えても今後のシフトが取得上限から押し出されないようにする。
    const reads=[
      readJobs(query(collection(db,"jobs"),where("companyId","==",cid),where("assignedStaffId","==",sid),where("dateKey",">=",today),orderBy("dateKey","asc"),limit(301))),
      readJobs(query(collection(db,"jobs"),where("companyId","==",cid),where("assignedStaffId","==",sid),where("dateKey","<",today),orderBy("dateKey","asc"),limit(51))),
      companionRead,
    ] as const;
    await Promise.allSettled(reads);
    const [upcoming,history]=await Promise.all(reads);
    if(authVersion===authLoadVersionRef.current&&version===pastShiftVersionRef.current){
      upcomingShiftCursorRef.current=upcoming.docs.slice(0,300).at(-1)??null;
      setHasMoreUpcomingShifts(upcoming.docs.length>300);
      setUpcomingShiftMessage("" );
      pastShiftCursorRef.current=history.docs.slice(0,50).at(-1)??null;
      pastShiftDateRef.current=today;
      setHasMorePastShifts(history.docs.length>50);
      setPastShiftMessage("");
    }
    return orderAssignedJobs([...upcoming.docs.slice(0,300),...history.docs.slice(0,50)].map(d=>({...d.data(),id:d.id} as Job)));
  }
  async function loadMorePastShifts(){
    if(!db||!companyId||!staffId||!hasMorePastShifts||!pastShiftCursorRef.current||businessRefreshing||isPending("past-shifts"))return;
    const cursor=pastShiftCursorRef.current;
    const today=pastShiftDateRef.current;
    const version=pastShiftVersionRef.current;
    const authVersion=authLoadVersionRef.current;
    const isCurrent=()=>authVersion===authLoadVersionRef.current&&version===pastShiftVersionRef.current;
    setPastShiftMessage("");
    try{
      await run("past-shifts",async()=>{
        const page=await getDocs(query(collection(db!,"jobs"),where("companyId","==",companyId),where("assignedStaffId","==",staffId),where("dateKey","<",today),orderBy("dateKey","asc"),startAfter(cursor),limit(51)));
        if(!isCurrent())return;
        const rows=page.docs.slice(0,50);
        const additions=rows.map(d=>({...d.data(),id:d.id} as Job));
        setMyJobs(current=>orderAssignedJobs([...new Map([...current,...additions].map(job=>[job.id,job])).values()]));
        pastShiftCursorRef.current=rows.at(-1)??cursor;
        setHasMorePastShifts(page.docs.length>50);
      });
    }catch{if(isCurrent())setPastShiftMessage("過去のシフトを読み込めませんでした。続きを読み込むボタンで再試行できます。");}
  }

  async function loadMoreUpcomingShifts(){
    if(!db||!companyId||!staffId||!hasMoreUpcomingShifts||!upcomingShiftCursorRef.current||businessRefreshing||isPending("upcoming-shifts"))return;
    const cursor=upcomingShiftCursorRef.current;
    const today=pastShiftDateRef.current;
    const version=pastShiftVersionRef.current;
    const authVersion=authLoadVersionRef.current;
    const isCurrent=()=>authVersion===authLoadVersionRef.current&&version===pastShiftVersionRef.current;
    setUpcomingShiftMessage("");
    try{
      await run("upcoming-shifts",async()=>{
        const page=await getDocs(query(collection(db!,"jobs"),where("companyId","==",companyId),where("assignedStaffId","==",staffId),where("dateKey",">=",today),orderBy("dateKey","asc"),startAfter(cursor),limit(51)));
        if(!isCurrent())return;
        const rows=page.docs.slice(0,50);
        const additions=rows.map(d=>({...d.data(),id:d.id} as Job));
        setMyJobs(current=>orderAssignedJobs([...new Map([...current,...additions].map(job=>[job.id,job])).values()]));
        upcomingShiftCursorRef.current=rows.at(-1)??cursor;
        setHasMoreUpcomingShifts(page.docs.length>50);
      });
    }catch{if(isCurrent())setUpcomingShiftMessage("これからのシフトを読み込めませんでした。続きを読み込むボタンで再試行できます。");}
  }

  async function loadTaskJob(jobId:string):Promise<Job|null>{
    if(!db||!companyId||!staffId||!jobId||jobId.includes("/")||isPending("task-job"))return null;
    const authVersion=authLoadVersionRef.current;
    const version=++pastShiftVersionRef.current;
    let job:Job|null=null;
    await run("task-job",async()=>{
      const snapshot=await getDocFromServer(doc(db!,"jobs",jobId)).catch(error=>{
        if(authVersion!==authLoadVersionRef.current||version!==pastShiftVersionRef.current)return null;
        throw error;
      });
      if(!snapshot||authVersion!==authLoadVersionRef.current||version!==pastShiftVersionRef.current||!snapshot.exists())return;
      const candidate={...snapshot.data(),id:snapshot.id} as Job;
      if(candidate.companyId!==companyId||candidate.assignedStaffId!==staffId||candidate.status!=="assigned"||candidate.cancelled===true)return;
      job=candidate;
      pastShiftVersionRef.current++;
      setMyJobs(current=>orderAssignedJobs([...current.filter(item=>item.id!==candidate.id),candidate]));
    });
    return job;
  }
  async function fetchTasks():Promise<StaffTask[]>{
    if(!functions)throw new Error("やること一覧を確認できません。画面を再読み込みして、もう一度お試しください。");
    const response=await httpsCallable(functions,"getMyTasks")({});
    const tasks=(response?.data as {tasks?:unknown}|null)?.tasks;
    const ids=new Set<string>();
    if(!Array.isArray(tasks)||tasks.some(task=>{
      if(!task||typeof task!=="object"||Array.isArray(task)||
         [task.id,task.jobId,task.kind,task.title].some(value=>typeof value!=="string"||!value.trim())||
         typeof task.body!=="string"||!["normal","urgent","overdue"].includes(task.priority)||
         (task.metadata!=null&&(typeof task.metadata!=="object"||Array.isArray(task.metadata)))||ids.has(task.id))return true;
      ids.add(task.id);return false;
    }))throw new Error("やること一覧を確認できません。通信状態を確認し、もう一度更新してください。");
    return tasks as StaffTask[];
  }
  async function loadPrimaryBusinessData(sid=staffId,cid=companyId,uid=user?.uid??"",serverOnly=false):Promise<boolean>{
    const authLoadVersion=authLoadVersionRef.current;
    const tasksVersion=++tasksReadVersionRef.current;
    const pendingTasks=fetchTasks();
    const pendingJobs=fetchMyJobs(sid,cid,serverOnly,pendingTasks);
    const version=pastShiftVersionRef.current;
    await Promise.allSettled([pendingJobs,pendingTasks]);
    const values=await Promise.all([pendingJobs,pendingTasks]).catch(error=>{
      if(authLoadVersion!==authLoadVersionRef.current||version!==pastShiftVersionRef.current||tasksVersion!==tasksReadVersionRef.current)return null;
      throw error;
    });
    if(!values)return false;
    const [jobs,nextTasks]=values;
    if(authLoadVersion!==authLoadVersionRef.current)return false;
    if(version!==pastShiftVersionRef.current||tasksVersion!==tasksReadVersionRef.current)return false;
    setMyJobs(jobs);
    setTasks(nextTasks);
    setSelectedJob(current=>jobs.find(job=>job.id===current?.id)??nextShiftJob(jobs)??jobs[0]??null);
    saveBusinessSnapshot(uid,cid,sid,jobs,nextTasks);
    return true;
  }
  async function loadOpenJobs(cid=companyId):Promise<boolean>{
    const loadVersion=++openJobsLoadVersionRef.current;
    const isLatestLoad=()=>loadVersion===openJobsLoadVersionRef.current;
    if(!firebaseConfigured){setHasMoreOpenJobs(false);setOpenJobsPageMessage("");setOpenJobsStatus("ready");return true;}
    if(!db||!cid){setOpenJobsStatus("error");throw new Error("案件の接続準備を確認できません。もう一度お試しください。");}
    setOpenJobsStatus("loading");
    try{
      const today=localDateKey();
      const snap=await getDocsFromServer(query(collection(db,"jobs"),where("companyId","==",cid),where("status","==","open"),where("dateKey",">=",today),orderBy("dateKey","asc"),limit(101)));
      const rows=snap.docs.slice(0,100);
      const values=availableOpenJobs(rows.map(d=>({...d.data(),id:d.id} as Job)));
      if(!isLatestLoad())return false;
      openJobsCursorRef.current=rows.at(-1)??null;
      openJobsDateRef.current=today;
      setHasMoreOpenJobs(snap.docs.length>100);
      setOpenJobsPageMessage("");
      setOpenJobs(values);
      setExpandedOpenJobId(current=>values.some(job=>job.id===current)?current:"");
      setOpenJobsStatus("ready");
      return true;
    }catch(error){
      if(!isLatestLoad())return false;
      setOpenJobsStatus("error");
      throw error;
    }
  }
  async function loadMoreOpenJobs(){
    if(!db||!companyId||!hasMoreOpenJobs||!openJobsCursorRef.current||openJobsStatus!=="ready"||isPending("open-jobs-refresh")||isPending("apply-action"))return;
    const cursor=openJobsCursorRef.current,today=openJobsDateRef.current;
    const version=openJobsLoadVersionRef.current,authVersion=authLoadVersionRef.current;
    const isCurrent=()=>version===openJobsLoadVersionRef.current&&authVersion===authLoadVersionRef.current;
    setOpenJobsPageMessage("");
    try{
      await run("open-jobs-refresh",async()=>{
        const page=await getDocsFromServer(query(collection(db!,"jobs"),where("companyId","==",companyId),where("status","==","open"),where("dateKey",">=",today),orderBy("dateKey","asc"),startAfter(cursor),limit(101)));
        if(!isCurrent())return;
        const rows=page.docs.slice(0,100);
        const additions=rows.map(d=>({...d.data(),id:d.id} as Job));
        setOpenJobs(current=>availableOpenJobs([...new Map([...current,...additions].map(job=>[job.id,job])).values()]));
        openJobsCursorRef.current=rows.at(-1)??cursor;
        setHasMoreOpenJobs(page.docs.length>100);
        setOpenJobsPageMessage(page.docs.length>100?"募集案件の続きを読み込みました。一覧を確認してください。":"募集案件の最後まで読み込みました。一覧を確認してください。");
      });
    }catch{if(isCurrent())setOpenJobsPageMessage("募集案件の続きを読み込めませんでした。下のボタンでもう一度お試しください。");}
  }
  async function refreshOpenJobs(showConfirmation=true,cid=companyId){
    if(isPending("open-jobs-refresh"))return;
    if(isPending("apply-action"))return;
    const authVersion=authLoadVersionRef.current;
    let loadVersion=openJobsLoadVersionRef.current;
    const isCurrent=()=>authVersion===authLoadVersionRef.current&&loadVersion===openJobsLoadVersionRef.current;
    try{
      await run("open-jobs-refresh",async()=>{
        const pending=loadOpenJobs(cid);
        loadVersion=openJobsLoadVersionRef.current;
        const updated=await pending;
        if(isCurrent()&&updated&&showConfirmation)setMessage(firebaseConfigured?"募集中の案件を最新情報に更新しました。":"デモ：募集中の案件を確認しました。");
      });
    }catch{
      if(isCurrent()&&showConfirmation)setMessage("案件を読み込めませんでした。通信状態を確認して、もう一度お試しください。");
    }
  }
  async function loadTasks():Promise<boolean>{
    const authLoadVersion=authLoadVersionRef.current,version=++tasksReadVersionRef.current;
    const isCurrent=()=>authLoadVersion===authLoadVersionRef.current&&version===tasksReadVersionRef.current;
    try{
      const values=await fetchTasks();
      if(!isCurrent())return false;
      setTasks(values);return true;
    }catch(error){if(!isCurrent())return false;throw error;}
  }
  function showSubmissionMessage(value:string){setMessage(value);setSubmissionMessage(value);}

  async function refreshBusinessData(showFailure:boolean){
    if(businessRefreshInFlightRef.current||submissionEditPending||isPending("apply-action")||businessDataStatus==="loading")return;
    if(!firebaseConfigured){if(showFailure)setMessage("デモ：シフトを確認しました。実際の応募結果ではありません。");return;}
    if(!user||!staffId||!companyId||(!showFailure&&Date.now()-lastBusinessDataRefreshAt<BUSINESS_DATA_REFRESH_INTERVAL_MS))return;
    businessRefreshInFlightRef.current=true;
    const authLoadVersion=authLoadVersionRef.current;
    lastBusinessDataRefreshAt=Date.now();
    setBusinessRefreshing(true);
    const started=performance.now();
    try{
      const refreshed=await loadPrimaryBusinessData(staffId,companyId,user.uid,showFailure);
      if(!refreshed||authLoadVersion!==authLoadVersionRef.current)return;
      setBusinessDataStatus("ready");
      setBusinessDataSource("live");
      setBusinessRefreshMs(Math.round(performance.now()-started));
      if(showFailure)setMessage("シフトを更新しました。応募した日付と店舗を確認してください。");
      if(openJobsStatus!=="idle")void refreshOpenJobs(false,companyId);
    }catch{
      if(authLoadVersion!==authLoadVersionRef.current)return;
      lastBusinessDataRefreshAt=0;
      setBusinessDataSource("stale");
      if(showFailure)setMessage(businessDataStatus==="ready"?"シフトの最新情報を確認できませんでした。前の一覧を表示しています。応募結果は未確認です。通信状態を確認して、もう一度更新してください。":"シフト一覧を取得できませんでした。応募結果は未確認です。通信状態を確認して、もう一度更新してください。");
    }finally{
      if(authLoadVersion===authLoadVersionRef.current){businessRefreshInFlightRef.current=false;setBusinessRefreshing(false);}
    }
  }

  async function refreshPushStatus(showFailure:boolean){
    if(!functions||isPending("push-action:"+authLoadVersionRef.current)||Date.now()-lastPushStatusRefreshAt<PUSH_STATUS_REFRESH_INTERVAL_MS)return;
    const authLoadVersion=authLoadVersionRef.current;
    const stateVersion=pushStateVersionRef.current,readVersion=++pushReadVersionRef.current;
    lastPushStatusRefreshAt=Date.now();
    try{
      const enabled=await loadServerPushStatusWithRetry(functions);
      if(authLoadVersion!==authLoadVersionRef.current)return;
      if(stateVersion!==pushStateVersionRef.current||readVersion!==pushReadVersionRef.current)return;
      setPushEnabled(enabled);setPushStatusUncertain(false);
    }catch{
      if(authLoadVersion===authLoadVersionRef.current&&stateVersion===pushStateVersionRef.current&&readVersion===pushReadVersionRef.current){setPushStatusUncertain(true);if(showFailure)setMessage("通知状態を読み込めませんでした。通信状態を確認し、時間をおいて画面を開き直してください。");}
    }
  }

  async function openQuickDiagnostics(){
    if(isDiagnosticsPending())return;
    const version=++diagnosticsVersionRef.current,authVersion=authLoadVersionRef.current;
    const businessVersion=pastShiftVersionRef.current;
    const pushVersion=pushStateVersionRef.current,pushOperationPending=isPending("push-action:"+authVersion);
    const isCurrent=()=>version===diagnosticsVersionRef.current&&authVersion===authLoadVersionRef.current;
    setShowAccountMenu(false);
    setShowDevices(false);
    setShowDiagnostics(true);
    setDiagnosticReport(null);
    try{await run("diagnostics:"+version,async()=>{
      let report=await runStaffDiagnostics({
        signedIn:Boolean(user),
        companyScoped:Boolean(companyId&&staffId),
        businessDataStatus,
        businessDataSource,
        businessRefreshing,
        homeDisplayMs,
        businessRefreshMs,
        homeLoadedFromCache,
        deviceSessionRegistered:Boolean(deviceSessionId),
        functions,
      });
      if(!isCurrent())return;
      const pushChanged=pushOperationPending||pushVersion!==pushStateVersionRef.current;
      const businessChanged=businessRefreshing||businessVersion!==pastShiftVersionRef.current;
      let checks=[...report.checks];
      if(pushChanged){checks=checks.filter(check=>check.id!=="permission"&&check.id!=="push");checks.push({id:"push-changed",label:"通知状態の再確認",level:"warn",detail:"診断中に通知設定の確認・変更が行われました。「もう一度診断」で最新の状態を確認してください。"});report={...report,serverPushEnabled:null};}
      if(businessChanged){checks=checks.filter(check=>check.id!=="business"&&check.id!=="refresh");checks.push({id:"business-changed",label:"業務データの再確認",level:"warn",detail:"診断中にシフト情報が更新されました。更新が終わってから「もう一度診断」で最新の状態を確認してください。"});}
      if(pushChanged||businessChanged)report={...report,checks,summary:checks.some(check=>check.level==="fail")?"fail":"warn"};
      setDiagnosticReport(report);
      setMessage(report.summary==="pass"?"自動診断はすべて正常です。スクリーンショットは不要です。":report.summary==="warn"?"自動診断が完了しました。確認項目があります。":"自動診断でエラーを検出しました。結果をコピーして運営へ送ってください。");
    },{setMessage:value=>{if(isCurrent()){setDiagnosticReport({checkedAt:new Date().toISOString(),summary:"fail",serverPushEnabled:null,checks:[{id:"diagnostics",label:"診断の取得",level:"fail",detail:"診断を完了できませんでした。もう一度診断してください。"}]});setMessage(value);}}});}catch{return;}
  }

  function isDiagnosticsPending(){return isPending("diagnostics:"+diagnosticsVersionRef.current);}
  function closeDiagnostics(){diagnosticsVersionRef.current++;setShowDiagnostics(false);setDiagnosticReport(null);}

  async function copyDisplayText(label:string,value:string){
    const authVersion=authLoadVersionRef.current,navigationVersion=navigationVersionRef.current;
    const shiftContext=label==="店舗住所"||label==="シフト情報"?shiftCopyContextRef.current:null;
    const isCurrent=()=>authVersion===authLoadVersionRef.current&&navigationVersion===navigationVersionRef.current&&(shiftContext===null||shiftContext===shiftCopyContextRef.current);
    try{await run("text-copy",async()=>{
      await navigator.clipboard.writeText(value);
      if(isCurrent())setMessage(label+"をコピーしました。");
    },{setMessage:()=>{if(isCurrent())setMessage(label==="メールアドレス"||label==="電話番号"?"コピーできませんでした。「連絡先を選択してコピー」を開き、必要な連絡先を選択してコピーしてください。":"コピーできませんでした。表示されている内容を選択してコピーしてください。");}});}catch{}
  }

  async function copyDiagnosticText(text:string,isCurrent:()=>boolean){
    try{
      await navigator.clipboard.writeText(text);
      if(isCurrent())setMessage("診断結果をコピーしました。この文章だけ送れば確認できます。");
    }catch{
      if(isCurrent())setMessage("診断結果をコピーできませんでした。「共有用の文章を表示」を開き、文章を選択してコピーしてください。");
    }
  }

  async function copyDiagnostics(){
    if(!diagnosticReport)return;
    const version=diagnosticsVersionRef.current,authVersion=authLoadVersionRef.current;
    const isCurrent=()=>version===diagnosticsVersionRef.current&&authVersion===authLoadVersionRef.current;
    await run("diagnostic-export:"+authVersion,()=>copyDiagnosticText(formatDiagnosticReport(diagnosticReport),isCurrent),{setMessage:value=>{if(isCurrent())setMessage(value);}}).catch(()=>undefined);
  }

  async function shareDiagnostics(){
    if(!diagnosticReport)return;
    const version=diagnosticsVersionRef.current,authVersion=authLoadVersionRef.current;
    const isCurrent=()=>version===diagnosticsVersionRef.current&&authVersion===authLoadVersionRef.current;
    await run("diagnostic-export:"+authVersion,async()=>{
      const text=formatDiagnosticReport(diagnosticReport);
      if(navigator.share){
        try{
          await navigator.share({title:"Lip Knots Crew かんたん診断",text});
          if(isCurrent())setMessage("診断結果を共有しました。");
          return;
        }catch(error){if((error as {name?:string}|null)?.name==="AbortError")return;}
      }
      if(isCurrent())await copyDiagnosticText(text,isCurrent);
    },{setMessage:value=>{if(isCurrent())setMessage(value);}}).catch(()=>undefined);
  }

  function navigate(next:View){
    navigationVersionRef.current++;
    shiftNotification.cancel();resubmissionNotification.cancel();
    setShowAccountMenu(false);
    setShowDevices(false);
    closeDiagnostics();
    mailPanelVersion.current++;setShowMailApplications(false);
    setView(next);
    window.scrollTo({top:0,left:0,behavior:"auto"});
    if(next==="jobs"&&openJobsStatus==="idle")void refreshOpenJobs(false);
  }

  function toggleAccountMenu(){
    const opening=!showAccountMenu;
    setShowAccountMenu(opening);
    if(opening){
      setShowDevices(false);
      closeDiagnostics();
    }
  }

  async function refreshSelectedJob(jobId:string,authLoadVersion=authLoadVersionRef.current):Promise<boolean>{
    if(!db||authLoadVersion!==authLoadVersionRef.current)return false;
    const version=++pastShiftVersionRef.current;
    const snap=await getDocFromServer(doc(db,"jobs",jobId)).catch(error=>{
      if(authLoadVersion!==authLoadVersionRef.current||version!==pastShiftVersionRef.current)return null;
      throw error;
    });
    if(!snap||authLoadVersion!==authLoadVersionRef.current||version!==pastShiftVersionRef.current)return false;
    pastShiftVersionRef.current++;
    const updated=snap.exists()?{...snap.data(),id:snap.id} as Job:null;
    if(!updated||updated.companyId!==companyId||updated.assignedStaffId!==staffId||updated.status!=="assigned"||updated.cancelled===true){
      setMyJobs(jobs=>jobs.filter(job=>job.id!==jobId));
      setSelectedJob(current=>current?.id===jobId?null:current);
      return false;
    }
    setMyJobs(jobs=>jobs.map(job=>job.id===jobId?updated:job));
    setSelectedJob(current=>current?.id===jobId?updated:current);
    return true;
  }

  async function requestLogin(){
    const loginAuthVersion=authLoadVersionRef.current;
    const isCurrentLogin=()=>loginAuthVersion===authLoadVersionRef.current;
    const normalizedEmail=email.trim().toLowerCase();
    if(!normalizedEmail||isLoginActionPending()){
      if(!normalizedEmail)setMessage("スタッフのメールアドレスを入力してください。");
      return;
    }
    await run("login",async()=>{
      setMessage("");
      setEmail(normalizedEmail);
      try{localStorage.setItem("lkcEmail",normalizedEmail);}catch{ /* 保存不可でも入力したアドレスで続行する。 */ }
      if(!firebaseConfigured){setLoginCode("");setMessage("デモ：ログインメールと確認コードを送りました。");return;}
      if(!functions)throw new Error("ログインの接続準備を確認できません。画面を再読み込みして、もう一度お試しください。");
      const c=httpsCallable(functions,"requestStaffLoginLink");
      const r=await c({email:normalizedEmail,continueUrl:window.location.origin});
      if(!isCurrentLogin())return;
      const data=r.data as {accepted?:unknown;message?:unknown}|null;
      if(!data||typeof data!=="object"||Array.isArray(data)||data.accepted!==true||typeof data.message!=="string"||!data.message.trim())throw new Error("ログインメールの受付結果を確認できません。少し待ってから再送してください。");
      setLoginCode("");
      setMessage("ログインメールの送信依頼は受付済みです。メールが届いたら確認コードを入力してください。");
    },{setMessage:value=>{if(isCurrentLogin())setMessage(value);}}).catch(()=>undefined);
  }

  async function verifyLoginCode(){
    if(isLoginActionPending())return;
    if(loginEmailRef.current&&!loginEmailRef.current.reportValidity())return;
    const loginAuthVersion=authLoadVersionRef.current;
    const isCurrentLogin=()=>loginAuthVersion===authLoadVersionRef.current;
    const normalizedEmail=email.trim().toLowerCase();
    const code=loginCode.normalize("NFKC").replace(/\D/g,"");
    if(!normalizedEmail||code.length!==6||isLoginActionPending()){
      if(!normalizedEmail)setMessage("スタッフのメールアドレスを入力してください。");
      else if(code.length!==6)setMessage("メールに記載された6桁の確認コードを入力してください。");
      return;
    }
    await run("login-code",async()=>{
      setMessage("");
      setEmail(normalizedEmail);
      try{localStorage.setItem("lkcEmail",normalizedEmail);}catch{ /* 保存不可でも入力したアドレスで続行する。 */ }
      if(!firebaseConfigured){setMessage("デモ：確認コードでログインしました。");return;}
      if(!functions||!auth)throw new Error("ログインの接続準備を確認できません。画面を再読み込みして、もう一度お試しください。");
      const activeAuth=auth;
      await authPersistenceReady;
      if(!isCurrentLogin())return;
      const callable=httpsCallable<{email:string;code:string},{emailActionLink:string}>(functions,"requestStaffLoginLink");
      const result=await callable({email:normalizedEmail,code});
      if(!isCurrentLogin())return;
      const emailActionLink=(result.data as {emailActionLink?:unknown}|null)?.emailActionLink;
      if(typeof emailActionLink!=="string"||!emailActionLink.trim()||!isSignInWithEmailLink(activeAuth,emailActionLink))throw new Error("ログイン情報を確認できません。");

      await signInWithEmailLink(activeAuth,normalizedEmail,emailActionLink);
      if(!isCurrentLogin())return;
      setLoginCode("");
      setMessage("ログインしました。");
    },{setMessage:value=>{if(isCurrentLogin())setMessage(value);}}).catch(()=>undefined);
  }

  async function registerCurrentDevice(authLoadVersion=authLoadVersionRef.current){
    if(!functions||authLoadVersion!==authLoadVersionRef.current)return"";
    const c=httpsCallable(functions,"registerDeviceSession"); const r=await c({deviceId:currentDeviceId,label:deviceLabel(),platform:navigator.platform||"",userAgent:navigator.userAgent});
    if(authLoadVersion!==authLoadVersionRef.current)return"";
    const id=(r.data as {sessionId?:unknown}|null)?.sessionId;
    if(typeof id!=="string"||!id.trim()||id.includes("/"))throw Error("端末登録の応答を確認できません。再読み込みしてください。");
    setDeviceSessionId(id);return id;
  }
  async function logoutCurrentUser(){
    if(user)clearBusinessSnapshot(user.uid,companyId,staffId);
    if(auth)await signOut(auth);
  }
  async function requestLogout(){
    if(isPending("logout"))return;
    if(!confirm("この端末からログアウトしますか？"))return;
    setMessage("ログアウト処理中です…");
    const authVersion=authLoadVersionRef.current;
    await run("logout",logoutCurrentUser,{setMessage:()=>{if(authVersion===authLoadVersionRef.current)setMessage("ログアウトできませんでした。もう一度「ログアウト」を押してください。");}}).catch(()=>undefined);
  }
  function watchDeviceSession(id:string,onRevoked:()=>Promise<void>){ if(!db)return; return onSnapshot(doc(db,"deviceSessions",id),s=>{if(s.exists()&&s.data().active===false)void onRevoked().catch(()=>undefined);}); }

  function isCurrentDevice(device:DeviceSession){
    if(device.id===deviceSessionId)return true;
    return Boolean(user?.uid&&device.deviceId===currentDeviceId&&device.uid===user.uid);
  }

  async function fetchDevices(authLoadVersion=authLoadVersionRef.current){
    if(authLoadVersion!==authLoadVersionRef.current)return;
    setDeviceListUncertain(true);
    if(!firebaseConfigured){setDevices([{id:"current",label:deviceLabel(),active:true},{id:"old",label:"以前のiPhone",active:true}]);setDeviceListUncertain(false);return;}
    if(!functions)throw Error("端末管理に接続できません。再読込してください。");
    const r=await httpsCallable(functions,"listMyDevices")({});
    if(authLoadVersion!==authLoadVersionRef.current)return;
    const result=(r.data as {devices?:DeviceSession[]}|null)?.devices;
    const ids=new Set<string>();
    if(!Array.isArray(result)||result.some(device=>{
      if(!device||typeof device!=="object"||Array.isArray(device)||typeof device.id!=="string"||!device.id.trim()||ids.has(device.id)||
        [device.label,device.platform,device.deviceId,device.uid].some(value=>value!=null&&typeof value!=="string")||
        (device.active!==undefined&&typeof device.active!=="boolean"))return true;
      ids.add(device.id);return false;
    }))throw Error("端末情報を確認できません。再読込してください。");
    setDevices(result);
    setDeviceListUncertain(false);
  }

  async function loadDevices(){
    const authLoadVersion=authLoadVersionRef.current;
    setShowAccountMenu(false);
    closeDiagnostics();
    setShowDevices(true);
    try{
      await run("device-action",()=>fetchDevices(authLoadVersion),{setMessage:value=>{if(authLoadVersion===authLoadVersionRef.current)setMessage(value);}});
    }catch{return;}
  }

  async function revokeDevice(id:string){
    const authLoadVersion=authLoadVersionRef.current;
    const isCurrentAction=()=>authLoadVersion===authLoadVersionRef.current;
    const target=devices.find(device=>device.id===id);
    if(!target){setMessage("対象の端末を確認できません。端末一覧を再読込してください。");return;}
    if(target.active===false)return;
    const currentTarget=isCurrentDevice(target);
    const targetLabel=target.label?.trim()||target.platform?.trim()||"端末";
    const confirmation=`${devices.indexOf(target)+1}件目の「${targetLabel}」をログアウトしますか？${currentTarget?"現在使用中のこの端末からもログアウトします。":""}`;
    let accepted=false;
    try{await run("device-action",async()=>{
      if(!confirm(confirmation))return;
      setPendingDeviceId(id);
      try{
        if(!firebaseConfigured){setDevices(v=>v.map(x=>x.id===id?{...x,active:false}:x));return;}
        if(!functions)throw Error("端末管理に接続できません。再読込してください。");
        const response=await httpsCallable(functions,"revokeMyDevice")({sessionId:id});
        if(!isCurrentAction())return;
        const result=response?.data as {revoked?:unknown}|null;
        if(!result||Array.isArray(result)||result.revoked!==true)throw new Error("端末ログアウトの受付結果を確認できません。端末一覧を再読込して状態を確認してください。");
        accepted=true;
        if(currentTarget)await logoutCurrentUser();
        else await fetchDevices(authLoadVersion);
        if(isCurrentAction())setMessage("端末をログアウトしました。");
      }finally{if(isCurrentAction())setPendingDeviceId("");}
    },{setMessage:value=>{if(isCurrentAction())setMessage(accepted?(currentTarget?"端末のログアウトは受付済みです。アカウントメニューからこの端末をログアウトしてください。":"端末のログアウトは受付済みです。端末一覧を再読込してください。"):value);}});}catch{return;}
  }

  async function runPushAction(action:PushAction,task:(isCurrent:()=>boolean)=>Promise<void>){
    const version=authLoadVersionRef.current,isCurrent=()=>version===authLoadVersionRef.current;
    try{await run("push-action:"+version,async()=>{
      if(firebaseConfigured&&!functions)throw Error("通知設定に接続できません。再読込してください。");
      pushStateVersionRef.current++;setPendingPushAction(action);
      try{await task(isCurrent);}finally{if(isCurrent()){pushStateVersionRef.current++;setPendingPushAction(null);}}
    },{setMessage:value=>{if(isCurrent())setMessage(value);}});}catch{return;}
  }

  async function retryPushStatus(){
    await runPushAction("status",async(isCurrent)=>{
      if(!functions){setMessage("デモ：通知状態はデモ用の表示です。実際の通知登録は確認していません。");return;}
      try{
        const enabled=await loadServerPushStatusWithRetry(functions);
        if(!isCurrent())return;
        setPushEnabled(enabled);setPushStatusUncertain(false);
        lastPushStatusRefreshAt=Date.now();
        setMessage("通知状態を確認しました。");
      }catch(error){if(isCurrent())setPushStatusUncertain(true);throw error;}
    });
  }

  async function enablePush(){
    await runPushAction("enable",async(isCurrent)=>{
      if(!functions){setPushEnabled(true);setPushStatusUncertain(false);setMessage("デモ：通知を有効にしました。");return;}
      const r=await enablePushNotifications(functions,deviceSessionId,isCurrent);
      if(!isCurrent())return;
      setPushEnabled(r.enabled);setPushStatusUncertain(false);
      setMessage(r.message);
    });
  }

  async function disablePush(){
    await runPushAction("disable",async(isCurrent)=>{
      if(!functions){setPushEnabled(false);setPushStatusUncertain(false);setMessage("デモ：通知を無効にしました。");return;}
      await disablePushNotifications(functions,isCurrent);
      if(!isCurrent())return;
      setPushEnabled(false);setPushStatusUncertain(false);
      setMessage("通知を無効にしました。");
    });
  }

  async function requestPushTest(){
    await runPushAction("test",async(isCurrent)=>{
      if(!functions){setMessage("デモ：実際のテスト通知は送信されません。");return;}
      let test=await submitAndWaitForPushTest(isCurrent);
      if(!isCurrent())return;
      if(test?.finished&&(test.invalidTokenCount>0||test.failureReason==="invalid_token")){
        setMessage("古い通知登録を検出しました。端末を自動で再登録しています…");
        const refreshed=await refreshPushNotifications(functions!,deviceSessionId,isCurrent);
        if(!isCurrent())return;
        setPushEnabled(refreshed.enabled);setPushStatusUncertain(false);
        if(!refreshed.enabled){setMessage(refreshed.message);return;}
        test=await submitAndWaitForPushTest(isCurrent);
        if(!isCurrent())return;
      }
      if(!test){
        setMessage("通知の送信結果をまだ確認できません。少し待って、端末に通知が表示されたか確認してください。");
      }else if(test.status==="completed"&&test.successCount>0){
        setMessage(`通知サービスへの送信に成功しました（対象${test.successCount}台）。端末に表示されたか確認してください。`);
      }else if(test.status==="no_tokens"){
        setPushEnabled(false);setPushStatusUncertain(false);
        setMessage("有効な通知端末が見つかりません。通知をもう一度有効にしてください。");
      }else if(test.failureReason==="sender_mismatch"||test.failureReason==="service_auth"){
        setMessage("端末ではなく通知サービス側の設定エラーです。運営側で設定を確認します。");
      }else if(test.failureReason==="rate_limited"||test.failureReason==="temporary"){
        setMessage("通知サービスが一時的に混み合っています。少し待ってから再度お試しください。");
      }else{
        setMessage(`通知サービスへの送信結果：成功${test.successCount}台・失敗${test.failureCount}台。運営側で原因を確認します。`);
      }
    });
  }

  async function submitAndWaitForPushTest(isCurrent:()=>boolean):Promise<PushTestStatus|null>{
    if(!isCurrent())return null;
    const queueId=await requestTestPush(functions!);
    if(!isCurrent())return null;
    setMessage("テスト通知を処理しています…");
    const started=Date.now();
    let delay=400;
    while(isCurrent()&&Date.now()-started<15_000){
      let test:PushTestStatus|null;
      try{test=await loadTestPushStatus(functions!,queueId,Math.max(1,15_000-(Date.now()-started)));}
      catch(error){if(String((error as {code?:unknown}|null)?.code??"").endsWith("deadline-exceeded"))return null;throw error;}
      if(!isCurrent())return null;
      if(test?.finished)return test;
      await sleep(Math.min(delay,Math.max(0,15_000-(Date.now()-started))));
      delay=Math.min(Math.round(delay*1.5),2000);
    }
    return null;
  }

  async function openMailApplications(){
    const ticket=++mailPanelVersion.current,authVersion=authLoadVersionRef.current;
    setShowMailApplications(true);setMailPanelError("");
    if(MailPanel)return;
    try{const module=await import("./MailApplicationsPanel");if(ticket===mailPanelVersion.current&&authVersion===authLoadVersionRef.current)setMailPanel(()=>module.default);}
    catch{if(ticket===mailPanelVersion.current&&authVersion===authLoadVersionRef.current)setMailPanelError("メール応募画面を読み込めませんでした。通信状態を確認して再試行してください。");}
  }
  function closeMailApplications(){
    mailPanelVersion.current++;setShowMailApplications(false);
    requestAnimationFrame(()=>mailButtonRef.current?.focus());
  }
  async function loadMailApplications(cursor?:string){
    if(!firebaseConfigured){
      const sample=demoOpenJobs[0],assigned=myJobs.some(job=>job.id===sample.id);
      return {ok:true,mode:"app",nextCursor:null,items:[{id:"a".repeat(64),revision:1,state:assigned?"assigned":"ready",job:{...sample,storeAddress:sample.storeAddress??""}}]};
    }
    if(!functions)throw new Error("接続の準備ができていません。画面を開き直してください。");
    const response=await httpsCallable(functions,"listMyMailApplications")(cursor?{cursor}:{});
    return response.data;
  }
  async function applyMailApplication(item:MailApplication){
    return apply({...item.job,mailApplication:{id:item.id,revision:item.revision}});
  }
  function viewMailApplicationShift(jobId:string){
    const job=myJobs.find(item=>item.id===jobId);
    if(job)openShiftJob(job);
    navigate("shifts");if(!job)void refreshBusinessData(true);
  }

  async function apply(job:Job){
    if(isPending("open-jobs-refresh"))return false;
    let accepted=false;
    const authLoadVersion=authLoadVersionRef.current;
    const navigationVersion=navigationVersionRef.current;
    const isCurrentAction=()=>authLoadVersion===authLoadVersionRef.current;
    try{
      await run("apply-action",async()=>{
        setPendingApplicationJobId(job.id);
        try{
          if(!firebaseConfigured){accepted=true;applicationResultFocusRef.current={authVersion:authLoadVersion,navigationVersion};setAcceptedApplicationJobId(job.id);setMessage("デモ：応募を受け付けました。シフトで担当の確認状況を確認してください。");setOpenJobs(v=>v.filter(x=>x.id!==job.id));setMyJobs(v=>[...v.filter(x=>x.id!==job.id),{...job,status:"assigned",applicationUnconfirmed:true}]);setExpandedOpenJobId("");return;}
          if(!functions)throw new Error("応募の接続準備を確認できません。画面を再読み込みして、もう一度お試しください。");
          const owner=applicationAttemptOwner(companyId,staffId,user?.uid??"");
          const attempt=await reserveApplicationAttempt(owner,job.id,()=>applicationAttemptsRef.current.get(job.id)??{requestId:crypto.randomUUID(),startedAt:Date.now(),...(Number.isSafeInteger(job.revision)?{expectedJobRevision:job.revision}:{}),...(job.mailApplication?{mailApplicationId:job.mailApplication.id,mailApplicationRevision:job.mailApplication.revision}:{})},isCurrentAction);
          if(!isCurrentAction()||!attempt)return;
          applicationAttemptsRef.current.set(job.id,attempt);
          // サーバーの重複防止記録は24時間。期限を超えた再送は自動で新規応募にしない。
          const attemptAge=Date.now()-attempt.startedAt;
          if(attemptAge<0)throw new Error("端末の日時が前回の応募時点より前になっています。端末の日時設定を確認し、「シフト」で「シフトを更新」を押して確定状況を確認してください。");
          if(attemptAge>=23*60*60*1000){
            throw new Error("前回の応募から時間が経過したため、この画面からの再送を停止しています。「シフト」で「シフトを更新」を押して確定状況を確認し、見つからない場合は管理者に応募結果を確認してください。");
          }
          let response;
          try{response=await httpsCallable(functions,"applyToJob")({jobId:job.id,requestId:attempt.requestId,...(attempt.expectedJobRevision!==undefined?{expectedJobRevision:attempt.expectedJobRevision}:{}),...(attempt.mailApplicationId?{mailApplicationId:attempt.mailApplicationId,mailApplicationRevision:attempt.mailApplicationRevision}:{})});}
          catch(error){
            if(isCurrentAction()&&error&&typeof error==="object"&&"code" in error&&error.code==="functions/failed-precondition"&&"details" in error){
              const detail=error.details;
              if(detail&&typeof detail==="object"&&"reason" in detail&&detail.reason==="case_mail_job_changed"&&
                  "accepted" in detail&&detail.accepted===false&&"jobId" in detail&&detail.jobId===job.id&&
                  "requestId" in detail&&detail.requestId===attempt.requestId&&
                  "expectedJobRevision" in detail&&detail.expectedJobRevision===(attempt.expectedJobRevision??null)){
                removeSavedApplicationAttempt(owner,job.id,attempt.requestId);applicationAttemptsRef.current.delete(job.id);
                throw new Error("募集内容が更新されました。まだ確定していません。「募集案件を更新」または「メール応募を更新」で最新の内容を確認してください。");
              }
              if(detail&&typeof detail==="object"&&"reason" in detail&&detail.reason==="mail_application_changed"&&
                  "accepted" in detail&&detail.accepted===false&&"applicationId" in detail&&detail.applicationId===attempt.mailApplicationId&&
                  "revision" in detail&&detail.revision===attempt.mailApplicationRevision){
                removeSavedApplicationAttempt(owner,job.id,attempt.requestId);applicationAttemptsRef.current.delete(job.id);
                throw new Error("応募内容が更新されました。まだ確定していません。「メール応募を更新」で最新の内容を確認してください。");
              }
            }
            throw error;
          }
          if(!isCurrentAction())return;
          const result=response?.data;
          if(!result||typeof result!=="object"||!("ok" in result)||result.ok!==true||
             !("jobId" in result)||result.jobId!==job.id||!("assignedAt" in result)||
             typeof result.assignedAt!=="string"||!Number.isFinite(Date.parse(result.assignedAt))){
            throw new Error("応募結果を確認できません。もう一度応募を確認するか、「シフト」で確定状況を確認してください。");
          }
          accepted=true;
          try{removeSavedApplicationAttempt(owner,job.id,attempt.requestId);}catch{ /* 受付確認済み。保存記録の掃除失敗で再応募扱いには戻さない。 */ }
          applicationAttemptsRef.current.delete(job.id);
          applicationResultFocusRef.current={authVersion:authLoadVersion,navigationVersion};setAcceptedApplicationJobId(job.id);
          setMessage("応募を受け付けました。シフトで担当の確認状況を確認してください。");
          setOpenJobs(current=>current.filter(item=>item.id!==job.id));
          setExpandedOpenJobId("");
          let assignedShiftLoaded=false;
          try{assignedShiftLoaded=Boolean(await loadTaskJob(job.id));}catch{}
          if(!isCurrentAction())return;
          try{if(await loadOpenJobs()===false)throw new Error("募集一覧の更新を確認できません。");}
          catch{if(isCurrentAction())setMessage("応募は受付済みです。募集一覧の更新を確認できませんでした。「募集案件を更新」で最新情報を確認してください。");}
          if(isCurrentAction()&&!assignedShiftLoaded)setMessage("応募は受付済みです。シフトの現在の状態を確認できません。「シフト」で「シフトを更新」を押して担当の確認状況を確認してください。");
        }finally{if(isCurrentAction())setPendingApplicationJobId("");}
      },{setMessage:value=>{if(isCurrentAction())setMessage(value);}});
    }catch{return accepted&&isCurrentAction();}
    return accepted&&isCurrentAction();
  }

  function resetPreContactInput(){
    if(!selectedJob||isPending("shift-action")||!preContactDraftsRef.current.has(preContactDraftKey)||!confirm("このシフトの未送信入力を破棄して、登録内容に戻しますか？"))return;
    preContactDraftsRef.current.delete(preContactDraftKey);
    setPreContactError("");
    setTemperature(typeof selectedJob.preContact?.temperature==="number"&&Number.isFinite(selectedJob.preContact.temperature)?String(selectedJob.preContact.temperature):"");
    const savedTime=selectedJob.preContact?.arrivalTime??"";
    setArrivalTime(typeof savedTime==="string"&&/^([01]?\d|2[0-3]):[0-5]\d$/.test(savedTime)?savedTime.padStart(5,"0"):"");
  }

  async function submitPreContact(){
    if(!selectedJob||isPending("shift-action"))return;
    const readinessMessage=preContactReadinessMessage(selectedJob);
    if(readinessMessage){setMessage(readinessMessage);return;}
    if(!/^\d+(?:\.\d*)?$/.test(temperature.trim())||!Number.isFinite(Number(temperature))||Number(temperature)<34||Number(temperature)>42){setPreContactError("temperature");setMessage("体温は34〜42℃の数値で入力してください。");preContactTemperatureRef.current?.focus();return;}
    if(!/^([01]?\d|2[0-3]):[0-5]\d$/.test(arrivalTime)){setPreContactError("arrival");setMessage("到着予定時刻を時:分で入力してください（例：09:30）。");preContactArrivalRef.current?.focus();return;}
    setPreContactError("");
    const jobId=selectedJob.id;
    const dateKey=selectedJob.dateKey;
    const authLoadVersion=authLoadVersionRef.current;
    const isCurrentAction=()=>authLoadVersion===authLoadVersionRef.current;
    let accepted=false;
    try{
      await run("shift-action",async()=>{
        setPendingShiftAction("preContact");
        try{
          if(!firebaseConfigured){
            const preContact={temperature:Number(temperature),arrivalTime};
            preContactDraftsRef.current.delete(preContactDraftKey);
            setMyJobs(jobs=>jobs.map(job=>job.id===jobId?{...job,preContact,preContactNeedsReview:false,preContactSyncPending:false}:job));
            setSelectedJob(job=>job?.id===jobId?{...job,preContact,preContactNeedsReview:false,preContactSyncPending:false}:job);
            setTasks(current=>current.filter(task=>task.jobId!==jobId||task.kind!=="precontact"));
            setMessage("デモ：事前連絡を送信しました。");return;
          }
          if(!functions)throw Error("事前連絡に接続できません。");
          const response=await httpsCallable(functions,"submitPreContact")({jobId,dateKey,...(Number.isSafeInteger(selectedJob.revision)?{expectedRevision:selectedJob.revision}:{}),temperature:Number(temperature),arrivalTime});
          if(!isCurrentAction())return;
          const result=response.data as {ok?:unknown}|null;
          if(!result||Array.isArray(result)||result.ok!==true)throw Error("事前連絡の受付結果を確認できません。");
          accepted=true;
          pastShiftVersionRef.current++;
          setMessage("事前連絡を送信しました。");
          const refreshed=await refreshSelectedJob(jobId,authLoadVersion);
          if(isCurrentAction()&&refreshed)preContactDraftsRef.current.delete(preContactDraftKey);
          if(isCurrentAction()){const tasksRefreshed=await loadTasks();if(refreshed===false||tasksRefreshed===false)throw new Error("更新後の表示を確認できません。");}
        }finally{if(isCurrentAction())setPendingShiftAction("");}
      },{setMessage:value=>{if(isCurrentAction())setMessage(accepted?"事前連絡は受付済みです。シフト画面の「シフトを更新」を押して表示を確認してください。":value+" 再読込して状態を確認してください。");}});
    }catch{return;}
  }

  async function markPrinted(item:NetPrintItem){
    if(!selectedJob||isPending("shift-action"))return;
    if(caseMailPreparationHeld(selectedJob)){setMessage("受信内容・勤務条件を確認中です。確認後に印刷済みを登録してください。");return;}
    if(!hasValidDateKey(selectedJob)){setMessage("勤務日を確認できません。シフトを再読み込みしてから印刷済みにしてください。");return;}
    const dateKey=selectedJob.dateKey;
    const target=Array.isArray(selectedJob.netPrint?.items)?selectedJob.netPrint.items.find(value=>validNetPrintItem(value)&&value.id===item.id):undefined;
    if(!target||!validNetPrintTarget(selectedJob.netPrint?.items,target)){setMessage("印刷対象の番号を確認できません。最新情報を再読み込みしてください。");return;}
    if(target.printed===true)return;
    const jobId=selectedJob.id;
    const authLoadVersion=authLoadVersionRef.current;
    const isCurrentAction=()=>authLoadVersion===authLoadVersionRef.current;
    let accepted=false;
    try{
      await run("shift-action",async()=>{
        setPendingShiftAction(`print-${item.id}`);
        try{
          if(!firebaseConfigured){
            const currentItems=selectedJob?.netPrint?.items??[];
            if(!currentItems.some(value=>validNetPrintItem(value)&&value.id===item.id))throw Error("印刷対象を確認できません。");
            const items=currentItems.map(value=>validNetPrintItem(value)&&value.id===item.id?{...value,printed:true}:value);
            const remaining=items.filter(value=>!validNetPrintTarget(items,value)||value.printed!==true).length;
            setMyJobs(jobs=>jobs.map(job=>job.id===jobId?{...job,netPrint:{...job.netPrint,items}}:job));
            setSelectedJob(job=>job?.id===jobId?{...job,netPrint:{...job.netPrint,items}}:job);
            setTasks(current=>current.flatMap(task=>task.jobId===jobId&&task.kind==="netprint"?(remaining?[{...task,body:`未印刷 ${remaining}件`}]:[]):[task]));
            setMessage("デモ：印刷済みにしました。");return;
          }
          if(!functions)throw Error("印刷済みの更新に接続できません。");
          const response=await httpsCallable(functions,"markNetPrintPrinted")({jobId,itemId:item.id,dateKey,...(selectedJob.mailIntake?{expectedRevision:selectedJob.revision}:{})});
          if(!isCurrentAction())return;
          const result=response.data as {ok?:unknown}|null;
          if(!result||Array.isArray(result)||result.ok!==true)throw Error("印刷済み更新の受付結果を確認できません。");
          accepted=true;
          pastShiftVersionRef.current++;
          setMessage("印刷済みにしました。");
          const refreshResults=await Promise.allSettled([refreshSelectedJob(jobId,authLoadVersion),loadTasks()]);
          const refreshFailure=refreshResults.find(result=>result.status==="rejected");
          if(refreshFailure?.status==="rejected")throw refreshFailure.reason;
          if(refreshResults.some(result=>result.status==="fulfilled"&&result.value===false))throw new Error("更新後の表示を確認できません。");
        }finally{if(isCurrentAction())setPendingShiftAction("");}
      },{setMessage:value=>{if(isCurrentAction())setMessage(accepted?"印刷済みの更新は受付済みです。シフト画面の「シフトを更新」を押して表示を確認してください。":value+" 再読込して状態を確認してください。");}});
    }catch{return;}
  }

  async function setClientSubmitted(value:boolean){
    if(!selectedJob||isSubmissionActionPending())return;
    if(selectedJob.mailIntakeReviewRequired===true||(selectedJob.mailIntake&&(selectedJob.pendingSourceWrite===true||selectedJob.adminEditSheetWrite?.pending===true))||selectedJob.sourceMissing===true||selectedJob.applicationUnconfirmed===true||selectedJob.assignmentUnresolved===true){setMessage("担当や原本の確認が完了していません。「シフトを更新」で状態を確認してください。");return;}
    const previous=selectedJob;
    const optimistic:Job={
      ...selectedJob,
      submissionStatus:{
        ...selectedJob.submissionStatus,
        salesFloor:{
          ...selectedJob.submissionStatus?.salesFloor,
          clientSubmitted:value,
          completed:value||selectedJob.submissionStatus?.salesFloor?.lipKnotsSubmitted===true,
        },
      },
    };
    const jobId=selectedJob.id;
    const authLoadVersion=authLoadVersionRef.current;
    const isCurrentAction=()=>authLoadVersion===authLoadVersionRef.current;
    let accepted=false;
    try{
      await run("shift-action",async()=>{
        setPendingShiftAction("clientSubmitted");
        pastShiftVersionRef.current++;
        setSelectedJob(optimistic);
        setMyJobs(jobs=>jobs.map(job=>job.id===jobId?optimistic:job));
        try{
          if(!firebaseConfigured){setMessage(value?"デモ：クライアント提出済みにしました。":"デモ：クライアント提出を解除しました。");return;}
          if(!functions)throw Error("提出状態の更新に接続できません。");
          const response=await httpsCallable(functions,"setSalesFloorClientSubmitted")({jobId,submitted:value,...(selectedJob.mailIntake?{expectedRevision:selectedJob.revision}:{})});
          if(!isCurrentAction())return;
          const result=response.data as {ok?:unknown}|null;
          if(!result||Array.isArray(result)||result.ok!==true)throw Error("提出状態更新の受付結果を確認できません。");
          accepted=true;
          pastShiftVersionRef.current++;
          setMessage(value?"クライアント提出済みにしました。":"クライアント提出を解除しました。");
          const refreshResults=await Promise.allSettled([refreshSelectedJob(jobId,authLoadVersion),loadTasks()]);
          const refreshFailure=refreshResults.find(result=>result.status==="rejected");
          if(refreshFailure?.status==="rejected")throw refreshFailure.reason;
          if(refreshResults.some(result=>result.status==="fulfilled"&&result.value===false))throw new Error("更新後の表示を確認できません。");
        }finally{if(isCurrentAction())setPendingShiftAction("");}
      },{setMessage:value=>{if(isCurrentAction())setMessage(accepted?"提出状態の更新は受付済みです。シフト画面の「シフトを更新」を押して表示を確認してください。":value+" 再読込して提出状態を確認してください。");}});
    }catch{
      if(!isCurrentAction())return;
      if(accepted)return;
      setSelectedJob(current=>current===optimistic?previous:current);
      setMyJobs(jobs=>jobs.map(job=>job===optimistic?previous:job));
    }
  }

  async function openTask(task:StaffTask){
    if(isSubmissionActionPending()||isPending("task-job"))return;
    const authVersion=authLoadVersionRef.current,navigationVersion=navigationVersionRef.current;
    const isCurrentTask=()=>authVersion===authLoadVersionRef.current&&navigationVersion===navigationVersionRef.current;
    let job=myJobs.find(j=>j.id===task.jobId);
    if(!job){
      try{job=await loadTaskJob(task.jobId)??undefined;}
      catch{if(isCurrentTask())setMessage("対象のシフトを読み込めませんでした。タスクを押して再試行してください。");return;}
    }
    if(!isCurrentTask())return;
    if(!job){setMessage("対象の確定シフトを確認できません。シフト画面から案件を選び直してください。");navigate("shifts");return;}
    if(task.kind==="precontact"||task.kind==="netprint"){openShiftJob(job);navigate("shifts");return;}
    const requestedType=task.kind==="resubmission"?task.metadata?.type:task.kind;
    const req=task.kind==="resubmission"&&typeof task.metadata?.requestId==="string"?task.metadata.requestId.trim():"";
    if((requestedType!=="report"&&requestedType!=="sales_floor")||(task.kind==="resubmission"&&(!req||req.includes("/")))){
      setMessage("提出依頼の内容を確認できません。「シフトを更新」で最新の対応事項を確認し、改善しない場合は管理者に確認してください。");navigate("shifts");return;
    }
    await startSubmission(requestedType,job,req);
  }

  async function pollSubmissionProcessing(jobId:string,submissionId:string,type:SubmissionType,resubmissionRequestId:string){
    if(!functions){showSubmissionMessage("提出状況の接続準備を確認できません。「提出情報を再読み込み」で履歴を確認してください。");return;}
    const authLoadVersion=authLoadVersionRef.current;
    const processingVersion=++submissionProcessingVersionRef.current;
    const isCurrentProcessing=()=>authLoadVersion===authLoadVersionRef.current&&processingVersion===submissionProcessingVersionRef.current;
    setProcessingSubmission(true);
    const started=Date.now();
    let delay=500;
    try{
      while(Date.now()-started<60_000){
        const remaining=60_000-(Date.now()-started);
        if(remaining<=0)break;
        const callable=httpsCallable(functions,"getSubmissionProcessingStatus",{timeout:Math.min(15_000,remaining)});
        const response=await callable({jobId,submissionId});
        if(!isCurrentProcessing())return;
        const data=response.data as {status:string;completedFiles:number;totalFiles:number;errorMessage:string|null};
        if(!data||!["uploading","processing","paused_global","error","completed"].includes(data.status)||
          !Number.isInteger(data.totalFiles)||data.totalFiles<1||data.totalFiles>20||!Number.isInteger(data.completedFiles)||data.completedFiles<0||data.completedFiles>data.totalFiles||
          (data.errorMessage!==null&&typeof data.errorMessage!=="string")||(data.status==="completed"&&data.completedFiles!==data.totalFiles))throw new Error("提出状況の応答が不正です。");
        if(data.status==="completed"){
          showSubmissionMessage("Driveへの保存が完了しました。");
          const refreshResults=await Promise.allSettled([
            loadSubmissionHistory(jobId,type,authLoadVersion),refreshSelectedJob(jobId,authLoadVersion),loadTasks(),
            resubmissionRequestId?loadResubmissionDetail(resubmissionRequestId,authLoadVersion,jobId,type):Promise.resolve(true),
          ]);
          if(!isCurrentProcessing())return;
          if(refreshResults.some(result=>result.status==="rejected"||(result.status==="fulfilled"&&result.value===false)))showSubmissionMessage("Driveへの保存は完了していますが、画面の更新を確認できませんでした。「提出情報を再読み込み」で最新の状態を確認してください。");
          return;
        }
        if(data.status==="paused_global"){
          showSubmissionMessage("Drive転送は一時停止中です。再送せず、「提出情報を再読み込み」で状態を確認してください。停止が続く場合は管理者に確認してください。");
          return;
        }
        if(data.status==="error"){
          showSubmissionMessage("提出の転送処理でエラーが発生しました。"+(data.errorMessage?.trim()?" "+data.errorMessage.trim():"")+" 「提出情報を再読み込み」で状態を確認し、改善しない場合は管理者に確認してください。");
          return;
        }
        showSubmissionMessage(`Drive転送を処理中です（${data.completedFiles}/${data.totalFiles}件）…`);
        await sleep(Math.min(delay,Math.max(0,60_000-(Date.now()-started))));
        delay=Math.min(Math.round(delay*1.5),3000);
      }
      if(isCurrentProcessing())showSubmissionMessage("完了をまだ確認できていません。「提出情報を再読み込み」で履歴を確認してください。");
    }catch{
      if(isCurrentProcessing())showSubmissionMessage("提出状況を確認できませんでした。提出履歴を再読み込みしてください。");
    }finally{
      if(isCurrentProcessing())setProcessingSubmission(false);
    }
  }

  async function uploadSubmission(){
    if(!files.length||!submissionConfirmed||isSubmissionActionPending())return;
    if(files.some(file=>file.size<=0||file.size>MAX_SUBMISSION_FILE_SIZE)){showSubmissionMessage("空のファイルまたは50MBを超えるファイルは送信できません。選び直してください。");return;}
    const assignedJob=selectedJob?myJobs.find(job=>job.id===selectedJob.id):undefined;
    if(!assignedJob){showSubmissionMessage("提出する確定シフトを確認できません。シフト画面から案件を選び直してください。");return;}
    if(assignedJob.mailIntakeReviewRequired===true||(assignedJob.mailIntake&&(assignedJob.pendingSourceWrite===true||assignedJob.adminEditSheetWrite?.pending===true))||assignedJob.sourceMissing===true||assignedJob.applicationUnconfirmed===true||assignedJob.assignmentUnresolved===true){showSubmissionMessage("担当や原本の確認が完了していません。選択ファイルは保持しています。「シフトを更新」で状態を確認してください。");return;}
    if(Boolean(requestId&&(resubmissionDetail?.request.id!==requestId||resubmissionDetail.request.jobId!==selectedJob?.id||resubmissionDetail.request.type!==submissionType||resubmissionDetail.request.status!=="open"))){showSubmissionMessage("再提出できる依頼を確認できません。「提出情報を再読み込み」で最新の状態を確認してください。");return;}
    if(requestId&&resubmissionDetail?.request.scope!=="submission"&&files.length!==1){showSubmissionMessage("画像単位の再送は1ファイルだけ選択してください。選択内容を確認してください。");return;}
    const typeLabel=submissionType==="report"?"報告書":"売場画像";
    setSubmissionMessage("");
    if(!firebaseConfigured){
      setUploadState(Object.fromEntries(files.map(f=>[fileStateKey(f),"送信済み"])));
      showSubmissionMessage(`デモ：${typeLabel}を送信しました。`);
      setSubmissionConfirmed(false);
      return;
    }
    if(!functions||!firebaseApp){showSubmissionMessage("送信サービスの接続準備を確認できません。画面を再読み込みし、選択ファイルを確認してから再度送信してください。");return;}
    const activeFunctions=functions;

    const authLoadVersion=authLoadVersionRef.current;
    const isCurrentUpload=()=>authLoadVersion===authLoadVersionRef.current;
    const jobId=assignedJob.id;
    const currentRequestId=requestId;
    const currentType=submissionType;
    try{
      await run("uploadSubmission",async()=>{
        const {getClientStorage,ref,uploadBytesResumable}=await loadUploadStorage().catch(()=>{throw new Error("送信機能を読み込めませんでした。選択ファイルは保持しています。通信状態を確認して、もう一度送信してください。");});
        if(!isCurrentUpload())return;
        const activeStorage=getClientStorage();
        const purpose=currentRequestId?"replacement":"additional";
        const {prepareSubmissionAttempt,clearSubmissionAttempt}=await loadSubmissionAttempt().catch(()=>{throw new Error("再試行の準備機能を読み込めませんでした。選択ファイルは保持しています。通信状態を確認して、もう一度送信してください。");});
        const attempt=await prepareSubmissionAttempt(draftKey,files,files.map(submissionFileContentType),isCurrentUpload,assignedJob.mailIntake?assignedJob.revision:undefined);
        if(!isCurrentUpload())return;
        let r;
        try { r=await httpsCallable(activeFunctions,"createUploadSession")({clientRequestId:attempt.clientRequestId,...(attempt.expectedRevision!==undefined?{expectedRevision:attempt.expectedRevision}:{}),jobId,type:currentType,purpose,resubmissionRequestId:currentRequestId||undefined,files:files.map((f,index)=>({originalName:f.name,contentType:submissionFileContentType(f),size:f.size,contentSha256:attempt.contentHashes[index]}))}); }
        catch(error){
          const details=(error as {details?:{reason?:unknown;accepted?:unknown;clientRequestId?:unknown;expectedRevision?:unknown}})?.details;
          if(isCurrentUpload()&&details?.reason==="case_mail_submission_changed"&&details.accepted===false&&details.clientRequestId===attempt.clientRequestId&&details.expectedRevision===(attempt.expectedRevision??null))await clearSubmissionAttempt(attempt);
          throw error;
        }
        if(!isCurrentUpload())return;
        const data=r.data as {submissionId:string;clientRequestId:string;files:{storagePath:string;uploadRequired:boolean}[]};
        if(!data||data.clientRequestId!==attempt.clientRequestId||typeof data.submissionId!=="string"||!data.submissionId.trim()||!Array.isArray(data.files)||data.files.length!==files.length||data.files.some(target=>!target||typeof target.uploadRequired!=="boolean"||typeof target.storagePath!=="string"||!target.storagePath.trim())||new Set(data.files.map(target=>target.storagePath)).size!==files.length)throw new Error("送信先を正しく準備できませんでした。もう一度お試しください。");
        const uploads=data.files.flatMap((target,index)=>{const file=files[index];return file?[{target,file}]:[];});
        setUploadState(Object.fromEntries(uploads.map(({file})=>[fileStateKey(file),"送信待ち"])));
        try{
        await runWithConcurrency(uploads,UPLOAD_CONCURRENCY,async({target,file})=>{
          if(!isCurrentUpload())throw new Error("ログイン状態が変わったため送信を中止しました。");
          const key=fileStateKey(file);
          if(!target.uploadRequired){if(isCurrentUpload())setUploadState(current=>({...current,[key]:"送信済み"}));return;}
          if(isCurrentUpload())setUploadState(current=>({...current,[key]:"送信中 0%"}));
          await new Promise<void>((resolve,reject)=>uploadBytesResumable(ref(activeStorage,target.storagePath),file,{contentType:submissionFileContentType(file),customMetadata:{lkcContentSha256:attempt.contentHashes[files.indexOf(file)]}}).on(
            "state_changed",
            snapshot=>{if(isCurrentUpload()){const progress=`送信中 ${Math.round(snapshot.bytesTransferred/Math.max(snapshot.totalBytes,1)*100)}%`;setUploadState(current=>current[key]===progress?current:{...current,[key]:progress});}},
            reject,
            resolve,
          ));
          if(isCurrentUpload())setUploadState(current=>({...current,[key]:"送信済み"}));
        });
        }catch(error){
          if(!isCurrentUpload())throw error;
          setUploadState(current=>Object.fromEntries(Object.entries(current).map(([key,status])=>[key,status==="送信済み"?status:status==="送信待ち"?"未送信":"送信未完了"])));
          throw new Error("送信を完了できませんでした。選択ファイルは保持しています。同じ選択ファイルで再度送信すると、受付済みのファイルを確認し、未送信分から続けます。「提出情報を再読み込み」でも履歴を確認できます。");
        }
        if(!isCurrentUpload())return;
        const durable=markDraftSubmitted(draftKey);
        if(durable)await clearSubmissionAttempt(attempt);
        if(!isCurrentUpload())return;
        skipNextDraftSaveRef.current=true;
        setFiles([]);
        setSubmissionConfirmed(false);
        setDraftCleanup({key:draftKey,durable,attempt});
        showSubmissionMessage(`${typeLabel}を送信しました。Drive転送を処理中です…`);
        void pollSubmissionProcessing(jobId,data.submissionId,currentType,currentRequestId);
        try{
          await clearDraft(draftKey);
          await clearSubmissionAttempt(attempt);
          if(!isCurrentUpload())return;
          setDraftCleanup(null);
        }catch{
          // 送信済み。端末の後片付け失敗をアップロード失敗として扱わない。
        }
      },{setMessage:value=>{if(isCurrentUpload())showSubmissionMessage(value);}});
    }catch{return;}
  }

  async function retryDraftCleanup(){
    if(!draftCleanup||isPending("draft-cleanup")||isPending("uploadSubmission"))return;
    const target=draftCleanup;
    const authVersion=authLoadVersionRef.current;
    try{
      await run("draft-cleanup",async()=>{
        await clearDraft(target.key);
        if(target.attempt){const {clearSubmissionAttempt}=await loadSubmissionAttempt();await clearSubmissionAttempt(target.attempt);}
        if(authVersion===authLoadVersionRef.current)setDraftCleanup(current=>current===target?null:current);
      });
    }catch{ /* 警告を残して、後から同じ操作を再試行できるようにする。 */ }
  }
  async function loadSubmissionHistory(jobId:string,type:SubmissionType,authLoadVersion=authLoadVersionRef.current):Promise<boolean>{
    if(authLoadVersion!==authLoadVersionRef.current)return false;
    const version=++submissionHistoryVersionRef.current;
    const contextVersion=submissionContextVersionRef.current;
    const isCurrent=()=>authLoadVersion===authLoadVersionRef.current&&version===submissionHistoryVersionRef.current&&contextVersion===submissionContextVersionRef.current;
    setSubmissionHistoryStatus("loading");
    try{
      if(!firebaseConfigured){
        if(!isCurrent())return false;
        setSubmissionHistory([{id:"demo",purpose:"initial",status:"completed",createdAt:new Date().toISOString(),completedAt:new Date().toISOString(),files:[{id:"demo_file",submissionId:"demo",originalName:"report.jpg",driveName:"7.12 ベイシア成田 Aさん (1).jpg",contentType:"image/jpeg",sequence:1,purpose:"initial",status:"completed",previewUrl:null,completedAt:new Date().toISOString(),replacesFileId:null}]}]);
        setSubmissionHistoryStatus("ready");
        return true;
      }
      if(!functions){setSubmissionHistoryStatus("error");return false;}
      const r=await httpsCallable(functions,"getSubmissionTimeline")({jobId,type});
      if(!isCurrent())return false;
      const groups=(r.data as {submissions?:SubmissionGroup[]}|null)?.submissions;
      if(!Array.isArray(groups)||!groups.every(group=>group&&typeof group.id==="string"&&group.id.trim().length>0&&Array.isArray(group.files)&&group.files.every(file=>
        file&&typeof file.id==="string"&&file.id.trim().length>0&&file.submissionId===group.id&&
        typeof file.originalName==="string"&&typeof file.driveName==="string"&&typeof file.contentType==="string"&&
        typeof file.purpose==="string"&&typeof file.status==="string"&&(file.previewUrl===null||typeof file.previewUrl==="string")
      )))throw new Error("提出履歴の応答を確認できませんでした。");
      if(new Set(groups.map(group=>group.id)).size!==groups.length||groups.some(group=>new Set(group.files.map(file=>file.id)).size!==group.files.length))throw new Error("提出履歴の識別情報が重複しています。再読み込みしてください。");
      setSubmissionHistory(groups);
      setSubmissionHistoryStatus("ready");
      return true;
    }catch(error){
      if(!isCurrent())return false;
      setSubmissionHistoryStatus("error");
      throw error;
    }
  }

  async function refreshFilePreview(file:PreviewFile):Promise<string|null>{
    if(!selectedJob||!functions)return null;
    const authLoadVersion=authLoadVersionRef.current;
    const previewContext=previewContextRef.current;
    const contextVersion=submissionContextVersionRef.current;
    const source=resubmissionDetail?.source;
    if(requestId&&source?.id===file.id&&source.submissionId===file.submissionId){
      const expectedRequestId=requestId,expectedJobId=selectedJob.id,expectedType=submissionType;
      const result=await httpsCallable(functions,"getResubmissionComparison")({requestId:expectedRequestId});
      if(authLoadVersion!==authLoadVersionRef.current||previewContext!==previewContextRef.current||contextVersion!==submissionContextVersionRef.current)return null;
      const detail=result.data as ResubmissionDetail|null;
      if(detail?.request?.id!==expectedRequestId||detail.request.jobId!==expectedJobId||detail.request.type!==expectedType)return null;
      return detail.source?.id===file.id&&detail.source.submissionId===file.submissionId&&typeof detail.source.previewUrl==="string"&&detail.source.previewUrl.trim()?detail.source.previewUrl:null;
    }
    const r=await httpsCallable(functions,"getSubmissionTimeline")({jobId:selectedJob.id,type:submissionType,previewFile:{submissionId:file.submissionId,fileId:file.id}});
    if(authLoadVersion!==authLoadVersionRef.current||previewContext!==previewContextRef.current||contextVersion!==submissionContextVersionRef.current)return null;
    const groups=(r.data as {submissions?:SubmissionGroup[]}|null)?.submissions;
    if(!Array.isArray(groups))return null;
    const matchingGroups=groups.filter(group=>group?.id===file.submissionId);
    if(matchingGroups.length!==1||!Array.isArray(matchingGroups[0].files))return null;
    const matchingFiles=matchingGroups[0].files.filter(entry=>entry?.submissionId===file.submissionId&&entry.id===file.id);
    if(matchingFiles.length!==1)return null;
    const url=matchingFiles[0].previewUrl;
    return typeof url==="string"&&url.trim()?url:null;
  }

  async function loadResubmissionDetail(id:string,authLoadVersion=authLoadVersionRef.current,expectedJobId=selectedJob?.id,expectedType:SubmissionType=submissionType):Promise<boolean>{
    if(authLoadVersion!==authLoadVersionRef.current)return false;
    const version=++resubmissionDetailVersionRef.current;
    const contextVersion=submissionContextVersionRef.current;
    const isCurrent=()=>authLoadVersion===authLoadVersionRef.current&&version===resubmissionDetailVersionRef.current&&contextVersion===submissionContextVersionRef.current;
    if(!firebaseConfigured){
      setResubmissionDetail({request:{id,jobId:expectedJobId??"demo_job_1",type:expectedType,reasons:["手ブレで文字が読めません"],note:"文字が読めるよう近くから撮影してください。",status:"open"},source:{id:"demo_file",submissionId:"demo",originalName:"report.jpg",driveName:"7.12 ベイシア成田 Aさん (1).jpg",contentType:"image/jpeg",sequence:1,purpose:"initial",status:"completed",previewUrl:null,completedAt:null,replacesFileId:null},replacements:[]});
      return true;
    }
    if(!functions)return false;
    try{
      const r=await httpsCallable(functions,"getResubmissionComparison")({requestId:id});
      if(!isCurrent())return false;
      const detail=r.data as ResubmissionDetail|null;
      if(detail?.request?.id!==id||!expectedJobId||detail.request.jobId!==expectedJobId||detail.request.type!==expectedType||!Array.isArray(detail.request.reasons)||!Array.isArray(detail.replacements))throw new Error("再提出情報の応答を確認できませんでした。");
      const validFile=(file:SubmissionFileView|null|undefined)=>!!file&&typeof file.id==="string"&&file.id.trim().length>0&&typeof file.submissionId==="string"&&file.submissionId.trim().length>0&&
        typeof file.originalName==="string"&&typeof file.driveName==="string"&&typeof file.contentType==="string"&&
        typeof file.purpose==="string"&&typeof file.status==="string"&&(file.previewUrl===null||typeof file.previewUrl==="string");
      if((detail.request.scope!==undefined&&detail.request.scope!=="file"&&detail.request.scope!=="submission")||(detail.request.scope==="submission"&&detail.source!==null))throw new Error("再提出の対象範囲を確認できませんでした。");
      if(!detail.request.reasons.every(reason=>typeof reason==="string")||typeof detail.request.note!=="string"||typeof detail.request.status!=="string"||
        (detail.source!==null&&!validFile(detail.source))||!detail.replacements.every(validFile))throw new Error("再提出情報の表示項目を確認できませんでした。");
      setResubmissionDetail(detail);
      return true;
    }catch(error){
      if(!isCurrent())return false;
      throw error;
    }
  }

  async function prepareSubmission(type:SubmissionType,job:Job,req=""){
    const contextVersion=++submissionContextVersionRef.current;
    const authLoadVersion=authLoadVersionRef.current;
    const nextDraftKey=submissionDraftKey(draftOwner,job.id,type,req);
    if(hydratedDraftKeyRef.current!==nextDraftKey){draftHydratingRef.current=true;setDraftHydrating(true);}
    setSelectedJob(job);
    setSubmissionType(type);
    setRequestId(req);
    setSubmissionConfirmed(false);
    setMessage(current=>current===submissionMessage?"":current);
    setSubmissionMessage("");
    setFiles([]);
    setSubmissionHistory([]);
    setSubmissionHistoryStatus("loading");
    setResubmissionDetail(null);
    navigate("submit");
    const navigationVersion=navigationVersionRef.current;
    try{
      const results=await Promise.allSettled([
        loadSubmissionHistory(job.id,type),
        req?loadResubmissionDetail(req,authLoadVersion,job.id,type):Promise.resolve(),
      ]);
      const failed=results.find(result=>result.status==="rejected");
      if(failed?.status==="rejected")throw failed.reason;
      if(results.some(result=>result.status==="fulfilled"&&result.value===false))throw new Error("提出情報の確認が完了していません。");
    }catch{
      if(contextVersion===submissionContextVersionRef.current&&authLoadVersion===authLoadVersionRef.current&&navigationVersion===navigationVersionRef.current)showSubmissionMessage("提出情報を読み込めませんでした。「提出情報を再読み込み」で最新の状態を確認してください。");
    }
  }

  async function refreshSubmissionInformation(){
    if(!selectedAssignedJob||isSubmissionActionPending())return;
    const jobId=selectedAssignedJob.id;
    const type=submissionType;
    const req=requestId;
    const authVersion=authLoadVersionRef.current;
    const contextVersion=submissionContextVersionRef.current;
    const isCurrent=()=>authVersion===authLoadVersionRef.current&&contextVersion===submissionContextVersionRef.current;
    try{
      await run("submission-refresh",async()=>{
        showSubmissionMessage("");
        const results=await Promise.allSettled([
          loadSubmissionHistory(jobId,type,authVersion),
          req?loadResubmissionDetail(req,authVersion,jobId,type):Promise.resolve(true),
          firebaseConfigured?refreshSelectedJob(jobId,authVersion):Promise.resolve(true),
          firebaseConfigured?loadTasks():Promise.resolve(true),
        ]);
        const failed=results.find(result=>result.status==="rejected");
        if(failed?.status==="rejected")throw failed.reason;
        if(isCurrent())showSubmissionMessage(results.every(result=>result.status==="fulfilled"&&Boolean(result.value))?"提出情報を更新しました。":"提出情報の一部を確認できませんでした。通信状態を確認して「提出情報を再読み込み」を押してください。");
      },{setMessage:()=>{if(isCurrent())showSubmissionMessage("提出情報の一部を確認できませんでした。通信状態を確認して「提出情報を再読み込み」を押してください。");}});
    }catch{ /* 再読込ボタンを残し、通信復旧後に再試行できるようにする。 */ }
  }

  async function discardFilesBeforeContextChange(prompt:string){
    const authVersion=authLoadVersionRef.current,contextVersion=submissionContextVersionRef.current,navigationVersion=navigationVersionRef.current;
    const isCurrentChange=()=>authVersion===authLoadVersionRef.current&&contextVersion===submissionContextVersionRef.current&&navigationVersion===navigationVersionRef.current;

    if(!files.length)return true;
    if(!confirm(prompt))return false;
    try{if(draftKey)await clearDraft(draftKey);}catch{if(isCurrentChange())showSubmissionMessage("選択中のファイルを解除できませんでした。もう一度お試しください。");return false;}
    if(!isCurrentChange())return false;
    setFiles([]);
    setUploadState({});
    setSubmissionConfirmed(false);
    setMessage(current=>current===submissionMessage?"":current);
    setSubmissionMessage("");
    return true;
  }

  async function startSubmission(type:SubmissionType,job:Job,req="",onOpened?:()=>void):Promise<boolean>{
    if(isSubmissionActionPending())return false;
    const authVersion=authLoadVersionRef.current,contextVersion=submissionContextVersionRef.current,navigationVersion=navigationVersionRef.current;
    const isCurrentChange=()=>authVersion===authLoadVersionRef.current&&contextVersion===submissionContextVersionRef.current&&navigationVersion===navigationVersionRef.current;
    let opened=false;
    await run("submission-context",async()=>{
      const sameContext=selectedAssignedJob?.id===job.id&&submissionType===type&&requestId===req;
      if(sameContext&&files.length){onOpened?.();opened=true;navigate("submit");return;}
      if(!sameContext&&!await discardFilesBeforeContextChange("選択中のファイルを外して提出先を変更しますか？"))return;
      if(!isCurrentChange())return;
      onOpened?.();
      opened=true;
      await prepareSubmission(type,job,req);
    },{setMessage:showSubmissionMessage});
    return opened;
  }

  async function changeSubmissionJob(jobId:string){
    const job=myJobs.find(candidate=>candidate.id===jobId);
    if(!job||job.id===selectedAssignedJob?.id||isSubmissionActionPending())return;
    const authVersion=authLoadVersionRef.current,contextVersion=submissionContextVersionRef.current,navigationVersion=navigationVersionRef.current;
    const isCurrentChange=()=>authVersion===authLoadVersionRef.current&&contextVersion===submissionContextVersionRef.current&&navigationVersion===navigationVersionRef.current;
    await run("submission-context",async()=>{
      if(!await discardFilesBeforeContextChange("選択中のファイルを外して提出先を変更しますか？"))return;
      if(!isCurrentChange())return;
      await prepareSubmission(submissionType,job);
    },{setMessage:showSubmissionMessage});
  }

  async function changeSubmissionType(type:SubmissionType){
    if(!selectedAssignedJob||type===submissionType||isSubmissionActionPending())return;
    const authVersion=authLoadVersionRef.current,contextVersion=submissionContextVersionRef.current,navigationVersion=navigationVersionRef.current;
    const isCurrentChange=()=>authVersion===authLoadVersionRef.current&&contextVersion===submissionContextVersionRef.current&&navigationVersion===navigationVersionRef.current;
    await run("submission-context",async()=>{
      if(!await discardFilesBeforeContextChange("選択中のファイルを外して提出種類を変更しますか？"))return;
      if(!isCurrentChange())return;
      await prepareSubmission(type,selectedAssignedJob);
    },{setMessage:showSubmissionMessage});
  }

  function removeSubmissionFile(target:File){
    if(isSubmissionActionPending())return;
    const targetKey=fileStateKey(target);
    const index=files.findIndex(file=>fileStateKey(file)===targetKey);
    if(index<0)return;
    fileRemoveFocusRef.current={index,authVersion:authLoadVersionRef.current,contextVersion:submissionContextVersionRef.current,navigationVersion:navigationVersionRef.current};
    setFiles(current=>current.filter(file=>fileStateKey(file)!==targetKey));
    setUploadState(current=>{const next={...current};delete next[targetKey];return next;});
    setSubmissionConfirmed(false);
    setMessage(current=>current===submissionMessage?"":current);
    setSubmissionMessage("");
  }

  function addSubmissionFiles(selected:File[]){
    if(isSubmissionActionPending()||resubmissionSendBlocked)return;
    if(!selected.length)return;
    const accepted=selected.filter(file=>file.type.startsWith("image/")||file.type==="application/pdf"||file.name.toLowerCase().endsWith(".pdf"));
    const withinSize=accepted.filter(file=>file.size>0&&file.size<=MAX_SUBMISSION_FILE_SIZE);
    const single=Boolean(requestId&&resubmissionDetail?.request.scope!=="submission");
    const limit=single?1:MAX_SUBMISSION_FILES;
    const base=single?[]:files;
    const seen=new Set(base.map(fileStateKey));
    const additions=withinSize.filter(file=>{const key=fileStateKey(file);if(seen.has(key))return false;seen.add(key);return true;});
    const next=[...base,...additions].slice(0,limit);
    // 無効な追加や上限到達では、既存の選択と確認状態を保持する。
    if(additions.length&&(next.length!==files.length||next.some((file,index)=>fileStateKey(file)!==fileStateKey(files[index])))){
      setFiles(next);
      setUploadState({});
      setSubmissionConfirmed(false);
    }
    const notices:string[]=[];
    if(accepted.length<selected.length)notices.push("画像またはPDF以外のファイルは選択できませんでした。");
    if(accepted.some(file=>file.size<=0))notices.push("空のファイルは選択できませんでした。内容のある画像またはPDFを選んでください。");
    if(accepted.some(file=>file.size>MAX_SUBMISSION_FILE_SIZE))notices.push("50MBを超えるファイルは選択できませんでした。");
    if(base.length+additions.length>limit)notices.push(`最大${limit}件までしか選択できません。選択中の一覧を確認してください。`);
    if(additions.length<withinSize.length)notices.push("同じファイルは重複せず、1件だけ残しました。");
    setMessage(current=>current===submissionMessage?notices.join(" "):current);
    setSubmissionMessage(notices.join(" "));
  }

  async function clearSubmissionFiles(){
    if(isSubmissionActionPending())return;
    if(!files.length||!confirm("選択中のファイルをすべて外しますか？"))return;
    const authVersion=authLoadVersionRef.current,contextVersion=submissionContextVersionRef.current,navigationVersion=navigationVersionRef.current;
    const isCurrentClear=()=>authVersion===authLoadVersionRef.current&&contextVersion===submissionContextVersionRef.current&&navigationVersion===navigationVersionRef.current;
    await run("submission-files",async()=>{
      try{if(draftKey)await clearDraft(draftKey);}catch{if(isCurrentClear())showSubmissionMessage("選択中のファイルを解除できませんでした。もう一度お試しください。");return;}
      if(!isCurrentClear())return;
      fileRemoveFocusRef.current={index:0,authVersion,contextVersion,navigationVersion};
      setFiles([]);
      setUploadState({});
      setSubmissionConfirmed(false);
      setMessage(current=>current===submissionMessage?"":current);
      setSubmissionMessage("");
    },{setMessage:value=>{if(isCurrentClear())showSubmissionMessage(value);}}).catch(()=>undefined);
  }

  async function chooseSubmission(type:SubmissionType,job:Job,req=""){const assignedJob=myJobs.find(candidate=>candidate.id===job.id);if(!assignedJob){showSubmissionMessage("提出する確定シフトを確認できません。シフト画面から案件を選び直してください。");navigate("shifts");return;}await startSubmission(type,assignedJob,req);}

  const nextShift=nextShiftJob(myJobs,businessDate);
  const visibleTasks=showAllTasks?tasks:tasks.slice(0,5);
  const title=useMemo(()=>firebaseConfigured?"Lip Knots Crew":"Lip Knots Crew（デモ）",[]);
  const taskSummary=businessDataStatus==="ready"
    ? tasks.length
      ? showAllTasks&&tasks.length>5?`未対応${tasks.length}件をすべて表示しています。`:`重要な${Math.min(tasks.length,5)}件を表示しています。`
      : "今日の対応はすべて完了しています。"
    : businessDataStatus==="loading"?"業務データを読み込んでいます…":"業務データを確認できません。";
  const businessDataFallback=businessDataStatus==="loading"
    ? <div className="empty" role="status">業務データを読み込んでいます…</div>
    : businessDataStatus==="error"
      ? <div className="empty" role="group" aria-label="業務データの読込エラー">業務データを読み込めませんでした。再読み込みしても改善しない場合は、管理者にスタッフ登録・所属を確認してください。<button className="secondary" onClick={()=>window.location.reload()}>再読み込み</button></div>
      : null;
  const openJobsFallback=openJobsStatus==="loading"
    ? <div className="empty" role="status">募集中の案件を読み込んでいます…</div>
    : openJobsStatus==="error"
      ? <div className="empty" role="group" aria-label="募集案件の読込エラー"><p>案件を読み込めませんでした。通信状態を確認して、もう一度お試しください。</p><button className="secondary" onClick={()=>void refreshOpenJobs()} disabled={isPending("apply-action")||isPending("open-jobs-refresh")}>もう一度試す</button></div>
      : null;
  const diagnosticSummaryLabel=diagnosticReport?.summary==="pass"?"すべて正常":diagnosticReport?.summary==="warn"?"確認あり":diagnosticReport?"エラーあり":"診断中";
  const acceptedApplicationJob=myJobs.find(job=>job.id===acceptedApplicationJobId);
  const applicationPending=isPending("apply-action");
  const openJobsRefreshing=isPending("open-jobs-refresh");
  const openJobPageControls=matchingOpenJobs.length>50?<nav className="shift-page-controls" aria-label="募集案件のページ"><button className="secondary" disabled={openJobPageSlice.current===0||applicationPending||openJobsRefreshing} onClick={()=>moveOpenJobPage(openJobPageSlice.current-1)}>前の50件</button><span role="status">該当{matchingOpenJobs.length}件中 {openJobPageSlice.start+1}〜{Math.min(openJobPageSlice.start+50,matchingOpenJobs.length)}件</span><button className="secondary" disabled={openJobPageSlice.current+1>=openJobPageSlice.totalPages||applicationPending||openJobsRefreshing} onClick={()=>moveOpenJobPage(openJobPageSlice.current+1)}>次の50件</button></nav>:null;
  const shiftActionPending=isPending("shift-action");
  const submissionContextPending=isPending("submission-context");
  const deviceActionPending=isPending("device-action");
  const pushActionPending=isPending("push-action:"+authLoadVersionRef.current);
  const loginActionPending=isLoginActionPending();
  const submissionEditPending=isSubmissionActionPending();
  const submissionReadiness=selectedAssignedJob?submissionReadinessMessage(selectedAssignedJob):null;
  const singleFileResubmission=Boolean(requestId&&resubmissionDetail?.request.scope!=="submission");
  const resubmissionSendBlocked=Boolean(requestId&&(resubmissionDetail?.request.id!==requestId||resubmissionDetail.request.jobId!==selectedJob?.id||resubmissionDetail.request.type!==submissionType||resubmissionDetail.request.status!=="open"));
  const previousResubmissionBlockedRef=useRef(resubmissionSendBlocked);
  useEffect(()=>{const newlyBlocked=!previousResubmissionBlockedRef.current&&resubmissionSendBlocked;previousResubmissionBlockedRef.current=resubmissionSendBlocked;if(newlyBlocked&&view==="submit"&&document.activeElement===document.body)submissionPanelRef.current?.focus({preventScroll:true});},[view,resubmissionSendBlocked]);
  const currentMessageTone=messageTone(message);
  if(firebaseConfigured&&(!authResolved||emailLinkPending))return <main className="login-shell"><section className="login-card"><img src="/logo.png"/><h1>{title}</h1><p>ログインを確認しています。<br/>画面を閉じずに、そのままお待ちください。</p><div className="message working">処理中…</div></section></main>;
  if(firebaseConfigured&&!user)return <main className="login-shell"><section className="login-card"><img src="/logo.png"/><h1>{title}</h1><p>スタッフとして登録済みのメールへ、ログインボタンと6桁の確認コードを送ります。管理者アカウントには確認コードは届きません。{adminLoginUrl&&<><br/><a href={adminLoginUrl}>管理者はAdmin画面からGoogleでログイン</a></>}</p><form onSubmit={e=>{e.preventDefault();void requestLogin();}} aria-busy={loginActionPending}><input ref={loginEmailRef} type="email" aria-label="スタッフのメールアドレス" value={email} onChange={e=>setEmail(e.target.value)} placeholder="スタッフのメールアドレス" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} required disabled={loginActionPending}/><button type="submit" disabled={loginActionPending}>{isPending("login")?"処理中…":"ログインメールを送る"}</button></form><p id="login-code-help">ホーム画面版では、メールに記載された確認コードを入力してください。確認コードは15分間・1回限り有効です。</p><details><summary>メールが届かない・コードが使えないとき</summary><p>メールアドレスの入力と迷惑メールフォルダーを確認してください。期限が切れた場合は「ログインメールを送る」から送り直してください。短時間に繰り返すと制限されるため、少し待ってから再送してください。</p></details><form onSubmit={e=>{e.preventDefault();void verifyLoginCode();}} aria-busy={loginActionPending}><input value={loginCode} onChange={e=>setLoginCode(e.target.value.normalize("NFKC").replace(/\D/g,"").slice(0,6))} placeholder="6桁の確認コード" inputMode="numeric" autoComplete="one-time-code" aria-label="確認コード" aria-describedby="login-code-help" maxLength={6} onPaste={e=>{e.preventDefault();setLoginCode(e.clipboardData.getData("text").normalize("NFKC").replace(/\D/g,"").slice(0,6));}} disabled={loginActionPending}/><button type="submit" className="secondary" disabled={loginCode.length!==6||loginActionPending}>{isPending("login-code")?"確認中…":"確認コードでログイン"}</button></form>{message&&<div className={messageClassName(message)} role={messageTone(message)==="error"?"alert":"status"}>{message}</div>}</section></main>;

  return <main className="app-shell">
    <header><img src="/logo.png"/><div className="account-copy"><strong>{title}</strong><small>{user?.email??"サンプルスタッフ"}</small></div>{user&&<button ref={accountMenuToggleRef} className="ghost account-menu-toggle" onClick={toggleAccountMenu} aria-expanded={showAccountMenu} aria-controls="account-menu" disabled={isPending("logout")||deviceActionPending}>{showAccountMenu?"閉じる":"メニュー"}</button>}</header>
    {showAccountMenu&&<section id="account-menu" className="panel account-menu-panel"><div className="section-heading"><div><h2>アカウント</h2><p>状態確認・端末管理・ログアウトはこちらです。</p></div></div><div className="account-menu-actions"><button className="secondary" onClick={()=>{setShowAccountMenu(false);void openQuickDiagnostics();}} disabled={isDiagnosticsPending()||isPending("logout")||deviceActionPending} aria-busy={isDiagnosticsPending()}>{isDiagnosticsPending()?"診断中…":"状態確認"}</button><button className="secondary" onClick={()=>{setShowAccountMenu(false);void loadDevices();}} disabled={deviceActionPending||isPending("logout")}>{deviceActionPending?"処理中…":"端末管理"}</button><button className="ghost logout-button" onClick={()=>{if(!deviceActionPending)void requestLogout();}} aria-disabled={isPending("logout")||deviceActionPending} aria-busy={isPending("logout")}>{isPending("logout")?"ログアウト中…":"ログアウト"}</button></div></section>}
    {draftCleanup&&<section className="panel" role="status"><strong>ファイルの送信は済んでいます</strong><p>端末の下書きの後片付けを確認しています。同じファイルを送り直す必要はありません。{!draftCleanup.durable&&"端末に送信済みの記録も保存できませんでした。画面を閉じた後は、再送する前に提出履歴を確認してください。"}</p><button className="secondary" onClick={()=>void retryDraftCleanup()} disabled={isPending("draft-cleanup")||isPending("uploadSubmission")} aria-busy={isPending("draft-cleanup")}>{isPending("draft-cleanup")?"確認中…":"端末の後片付けを再試行"}</button></section>}
    {message&&<div className={messageClassName(message)} role={currentMessageTone==="error"?"alert":"status"}><span>{message}</span>{currentMessageTone!=="working"&&<button className="message-dismiss" onClick={()=>setMessage("")} aria-label="お知らせを閉じる">閉じる</button>}</div>}
    {showDevices&&<section className="panel device-panel" aria-busy={deviceActionPending}><div className="section-heading"><div><h2 ref={deviceHeadingRef} tabIndex={-1}>ログイン中の端末</h2><p>使っていない端末はログアウトできます。</p></div><button className="secondary" onClick={()=>void loadDevices()} disabled={deviceActionPending}>再読込</button><button className="ghost" onClick={()=>{setShowDevices(false);accountMenuToggleRef.current?.focus();}} disabled={deviceActionPending}>閉じる</button></div><div className="device-list">{!deviceActionPending&&deviceListUncertain&&<p className="device-list-uncertain" role="status">{devices.length?"端末一覧の更新を確認できません。表示中の情報は前回の内容です。":"端末一覧を確認できません。"}「再読込」で最新の状態を確認してください。</p>}{deviceActionPending&&!pendingDeviceId&&<div className="empty compact" role="status">端末情報を読み込んでいます…</div>}{devices.map((device,index)=><div className="device-row" key={device.id} role="group" aria-label={`端末 ${index+1}件目: ${device.label?.trim()||device.platform?.trim()||"端末"}`}><div><strong>{index+1}. {device.label?.trim()||device.platform?.trim()||"端末"}</strong><small>{isCurrentDevice(device)?"この端末 / ":""}{device.active===true?"利用中":device.active===false?"ログアウト済み":"利用状況未確認"}</small></div><button className="secondary" aria-label={`${index+1}件目の端末をログアウト`} disabled={device.active===false||deviceActionPending} onClick={()=>void revokeDevice(device.id)}>{pendingDeviceId===device.id?"ログアウト中…":"ログアウト"}</button></div>)}{!deviceActionPending&&!devices.length&&<EmptyAction title="端末情報がありません" body="通信状態を確認して、最新の端末情報をもう一度読み込んでください。" action="もう一度読み込む" onAction={()=>void loadDevices()}/>}</div></section>}
    {showDiagnostics&&<section className={`panel diagnostic-panel ${diagnosticReport?.summary??"working"}`} aria-live="polite" aria-busy={isDiagnosticsPending()}><div className="section-heading"><div><h2 ref={diagnosticHeadingRef} tabIndex={-1}>かんたん自動診断</h2><p>結果の文章だけで確認できます。通常はスクリーンショット不要です。</p></div><span className={`diagnostic-summary ${diagnosticReport?.summary??"working"}`}>{diagnosticSummaryLabel}</span></div>{!diagnosticReport?<div className="diagnostic-loading" role="status">ログイン・データ・端末・通知をまとめて確認しています…</div>:<div className="diagnostic-list">{diagnosticReport.checks.map(check=><div className={`diagnostic-row ${check.level}`} key={check.id} role="group" aria-label={`${check.label}: ${check.level==="pass"?"正常":check.level==="warn"?"要確認":"エラー"}`}><span aria-hidden="true">{check.level==="pass"?"✓":check.level==="warn"?"!":"×"}</span><div><strong>{check.label}</strong><small>{check.detail}</small></div></div>)}</div>}{diagnosticReport&&<details className="diagnostic-copy-text"><summary>共有用の文章を表示</summary><p>自動コピーが使えない場合は、下の文章を選択してコピーしてください。</p><textarea aria-label="診断結果の共有用文章" readOnly rows={8} value={formatDiagnosticReport(diagnosticReport)}/></details>}<div className="diagnostic-actions">{diagnosticReport&&<><button onClick={()=>void shareDiagnostics()} disabled={isPending("diagnostic-export:"+authLoadVersionRef.current)}>結果を共有</button><button className="secondary" onClick={()=>void copyDiagnostics()} disabled={isPending("diagnostic-export:"+authLoadVersionRef.current)}>コピー</button></>}<button className="secondary" onClick={()=>void openQuickDiagnostics()} disabled={isDiagnosticsPending()}>{isDiagnosticsPending()?"診断中…":"もう一度診断"}</button><button className="ghost" onClick={()=>{closeDiagnostics();accountMenuToggleRef.current?.focus();}}>閉じる</button></div></section>}
    {resubmissionNotification.status!=="idle"&&<section className="panel" role="status"><p>{resubmissionNotification.status==="loading"?"通知の再提出依頼を読み込んでいます…":resubmissionNotification.status==="paused"?"提出先の切替を見送りました。選択中のファイルを確認して、通知の再提出依頼を再読込してください。":resubmissionNotification.status==="unavailable"?"この再提出依頼は終了済み、または対象の確定シフトを確認できません。":"通知の再提出依頼を読み込めませんでした。"}</p><button aria-disabled={resubmissionNotification.status==="loading"} aria-busy={resubmissionNotification.status==="loading"} onClick={()=>{if(resubmissionNotification.status!=="loading")void resubmissionNotification.retry();}}>通知の再提出依頼を再読込</button><button className="secondary" onClick={()=>closeNotificationPanel(resubmissionNotification.cancel)}>閉じる</button></section>}
    {shiftNotification.status!=="idle"&&<section className="panel" role="status"><p>{shiftNotification.status==="loading"?"通知のシフトを読み込んでいます…":shiftNotification.status==="unavailable"?"通知の対象シフトを確認できません。取り消しや担当変更の可能性があります。":"通知のシフトを読み込めませんでした。"}</p><button aria-disabled={shiftNotification.status==="loading"} aria-busy={shiftNotification.status==="loading"} onClick={()=>{if(shiftNotification.status!=="loading")void shiftNotification.retry();}}>通知のシフトを再読込</button><button className="secondary" onClick={()=>closeNotificationPanel(shiftNotification.cancel)}>閉じる</button></section>}
    {view==="home"&&<>
      <section className="hero-card"><div className="section-heading compact-heading"><h2 ref={homeHeadingRef} tabIndex={-1}>今日やること</h2><span className={`refresh-status ${businessDataSource}`}>{businessRefreshing?"自動更新中…":businessDataSource==="cached"?"前回データ":businessDataSource==="stale"?"更新未確認":businessDataSource==="live"?"最新":"確認中"}</span></div>{businessDataFallback??(tasks.length?<><p>{taskSummary}</p><div className="task-list" id="home-task-list">{visibleTasks.map(task=><button key={task.id} className={`task-card ${task.priority}`} onClick={()=>void openTask(task)} disabled={submissionEditPending} aria-busy={isPending("task-job")}>{task.priority!=="normal"&&<small>{task.priority==="overdue"?"期限超過":"優先対応"}</small>}<strong>{task.title}</strong><span>{task.body}</span></button>)}{tasks.length>5&&<button className="secondary task-list-toggle" aria-controls="home-task-list" aria-expanded={showAllTasks} onClick={()=>setShowAllTasks(value=>!value)}>{showAllTasks?"重要な5件に戻す":`すべて見る（残り${tasks.length-5}件）`}</button>}</div></>:<div className="task-clear" role="status"><span aria-hidden="true">✓</span><div><strong>{businessDataSource==="live"?"今日の対応はすべて完了しています":"前回確認時点では対応事項はありません"}</strong><small>{businessDataSource==="live"?"新しい対応が届くと、ここに表示されます。":"最新の状態はシフト画面で更新して確認してください。"}</small></div></div>)}</section>
      <section><h2>次回シフト</h2>{businessDataFallback??(nextShift?<article className="job shift-job" style={{"--job-accent":jobAccent(nextShift.menuName)} as CSSProperties}><span className="date">{shiftDateLabel(nextShift)}</span><span className="job-kind">{jobKind(nextShift.menuName)}</span><h3>{shiftTextLabel(nextShift.storeName,"店舗確認中")}</h3><p>{shiftTextLabel(nextShift.makerName,"メーカー確認中")} / {shiftTextLabel(nextShift.menuName,"業務確認中")}</p><span className="prep-chip">{prepSummary(nextShift)}</span><button onClick={()=>{openShiftJob(nextShift);navigate("shifts")}}>シフトを開く</button></article>:<div className="home-shift-empty"><strong>{businessDataSource==="live"?"確定シフトはありません":"前回確認時点では確定シフトはありません"}</strong><button className="secondary" onClick={()=>navigate("jobs")}>募集案件を見る</button></div>)}</section>
      <section className={`panel push-panel ${pushEnabled&&!pushStatusUncertain&&currentPushPermission()==="granted"?"enabled":""}`} aria-busy={pushActionPending}><div className="section-heading"><div><h2>プッシュ通知</h2><p>大切な業務通知を受け取ります。</p></div><div className="push-summary-actions"><span role="status" className={pushEnabled&&!pushStatusUncertain&&currentPushPermission()==="granted"?"push-status enabled":"push-status"}>{currentPushPermission()==="denied"?"端末で拒否中":currentPushPermission()==="unsupported"?"通知非対応":pushStatusUncertain?"通知状態未確認":pushEnabled&&currentPushPermission()==="granted"?"通知ON":"通知OFF"}</span>{pushEnabled&&<button className="ghost push-settings-toggle" aria-expanded={showPushActions} aria-controls="push-enabled-actions" onClick={()=>setShowPushActions(value=>!value)} disabled={pushActionPending}>{showPushActions?"閉じる":"設定"}</button>}</div></div>{pushStatusUncertain&&<div><p className="muted">通知の登録状態を確認できません。通信状態を確認して、もう一度お試しください。</p><button className="secondary" onClick={()=>void retryPushStatus()} disabled={pushActionPending} aria-busy={pendingPushAction==="status"}>{pendingPushAction==="status"?"確認中…":"通知状態を再確認"}</button></div>}{currentPushPermission()==="denied"&&<p className="muted">端末・ブラウザーの設定で、このアプリの通知を許可してください。変更後はこの画面を開き直して状態を確認してください。</p>}{currentPushPermission()==="unsupported"&&<p className="muted">この環境ではプッシュ通知を利用できません。ホームの「今日やること」から対応事項を確認してください。</p>}{!pushEnabled?<div className="push-actions"><button onClick={()=>void enablePush()} disabled={pushActionPending}>{pendingPushAction==="enable"?"処理中…":"通知を有効にする"}</button></div>:showPushActions&&<div id="push-enabled-actions" className="push-actions"><button className="secondary" onClick={()=>void requestPushTest()} disabled={pushActionPending}>{pendingPushAction==="test"?"処理中…":"通知テスト"}</button><button className="ghost" onClick={()=>void disablePush()} disabled={pushActionPending}>{pendingPushAction==="disable"?"処理中…":"通知OFF"}</button></div>}</section>
    </>}
    {view==="jobs"&&<section aria-busy={applicationPending||openJobsRefreshing||openJobsStatus==="loading"}><div className="section-heading"><h2 ref={jobsHeadingRef} tabIndex={-1}>募集中の案件</h2><button className="secondary" onClick={()=>void refreshOpenJobs()} disabled={applicationPending||openJobsRefreshing||openJobsStatus==="loading"} aria-busy={openJobsRefreshing}>{openJobsRefreshing?"更新中…":"募集案件を更新"}</button></div><p><button ref={mailButtonRef} className="secondary" aria-expanded={showMailApplications} aria-controls="mail-applications-panel" onClick={()=>{if(showMailApplications)closeMailApplications();else void openMailApplications();}} disabled={applicationPending}>{showMailApplications?"メール応募を閉じる":"メールからの応募を確認"}</button></p>{showMailApplications&&<div id="mail-applications-panel">{MailPanel?<MailPanel key={[companyId,staffId,user?.uid??"demo"].join("|")} load={loadMailApplications} onApply={applyMailApplication} onViewShift={viewMailApplicationShift} onClose={closeMailApplications} busy={applicationPending||openJobsRefreshing} hasAttempt={jobId=>applicationAttemptsRef.current.has(jobId)} feedback={message}/>:mailPanelError?<div className="empty" role="alert"><p>{mailPanelError}</p><button onClick={()=>void openMailApplications()}>メール応募画面を再読込</button></div>:<p role="status">メール応募画面を読み込んでいます…</p>}</div>}{acceptedApplicationJobId&&<p><button ref={applicationResultButtonRef} className="secondary" disabled={applicationPending} onClick={()=>{if(acceptedApplicationJob)openShiftJob(acceptedApplicationJob);navigate("shifts");if(!acceptedApplicationJob)void refreshBusinessData(true);}}>{acceptedApplicationJob?"応募したシフトを確認":"シフトを更新して応募結果を確認"}</button></p>}{!applicationPending&&Array.from(applicationAttemptsRef.current.keys()).some(id=>!myJobs.some(job=>job.id===id))&&<div className="empty application-unconfirmed" role="status"><p>応募結果が未確認の案件があります。募集一覧から消えていても、シフトで確定状況を確認してください。</p><button className="secondary" onClick={()=>{navigate("shifts");void refreshBusinessData(true);}} disabled={businessRefreshing}>シフトを更新して応募結果を確認</button></div>}{openJobsFallback??<><div className="open-job-search"><label htmlFor="open-job-query">募集案件を探す</label><div className="open-job-search-input"><input id="open-job-query" type="search" value={openJobQuery} onChange={event=>{setOpenJobQuery(event.target.value);setOpenJobPage(0);}} placeholder="日付・店舗・メーカー・地域" disabled={applicationPending} aria-describedby="open-job-search-help"/><button className="secondary" onClick={()=>{setOpenJobQuery("");setOpenJobPage(0);document.getElementById("open-job-query")?.focus();}} disabled={!openJobQuery||applicationPending}>検索を解除</button></div><p id="open-job-search-help">読み込み済みの募集{visibleOpenJobs.length}件から検索します。{hasMoreOpenJobs&&"未読込の案件は含みません。下の「募集案件の続きを読み込む」で追加できます。"}</p><p role="status">{matchingOpenJobs.length}件が該当します。</p></div><div ref={openJobListRef} className="shift-card-list" role="region" tabIndex={-1} aria-label="募集案件の検索結果">{openJobPageControls}<div className="grid">{openJobPageSlice.rows.map(job=>{const expanded=expandedOpenJobId===job.id;return <article className="job open-job" key={job.id} aria-label={`${shiftDateLabel(job)} ${shiftTextLabel(job.storeName,"店舗確認中")}の募集案件`}><span className="date">{shiftDateLabel(job)}</span><h3>{shiftTextLabel(job.storeName,"店舗確認中")}</h3><p>{shiftTextLabel(job.makerName,"メーカー確認中")} / {shiftTextLabel(job.menuName,"業務確認中")}</p>{Boolean(job.menuConditions?.length)&&<p>勤務条件：{job.menuConditions!.join(" / ")}</p>}<p>{typeof job.workTime==="string"&&job.workTime.trim()?job.workTime:"勤務時間は確認中"}</p><strong aria-label="報酬">{jobPayLabel(job.basePay)}</strong>{expanded&&<dl className="job-details" id={`job-details-${job.id}`}><div><dt>実施日</dt><dd>{shiftDateLabel(job)}</dd></div><div><dt>勤務時間</dt><dd>{typeof job.workTime==="string"&&job.workTime.trim()?job.workTime:"確認中"}</dd></div>{job.storeAddress&&<div><dt>店舗住所</dt><dd>{shiftTextLabel(job.storeAddress,"確認中")}</dd></div>}{job.clientName&&<div><dt>依頼元</dt><dd>{shiftTextLabel(job.clientName,"確認中")}</dd></div>}</dl>}{applicationAttemptsRef.current.has(job.id)&&pendingApplicationJobId!==job.id&&<p className="application-unconfirmed" role="status" id={`application-result-${job.id}`}>この案件の応募結果は未確認です。シフトで確定状況を確認するか、下のボタンで応募結果を再確認してください。</p>}<div className="actions"><button className="secondary" aria-expanded={expanded} aria-controls={`job-details-${job.id}`} onClick={()=>setExpandedOpenJobId(current=>current===job.id?"":job.id)}>{expanded?"詳細を閉じる":"詳細を見る"}</button><button onClick={()=>void apply(job)} disabled={applicationPending||openJobsRefreshing} aria-describedby={applicationAttemptsRef.current.has(job.id)&&pendingApplicationJobId!==job.id?`application-result-${job.id}`:undefined}>{pendingApplicationJobId===job.id?"応募中…":applicationAttemptsRef.current.has(job.id)?"応募結果を再確認する":"この案件に応募する"}</button></div></article>})}{!!openJobQuery.trim()&&!matchingOpenJobs.length&&<p className="empty" role="status">読み込み済みの案件に一致するものがありません。検索語を変更するか、検索を解除してください。</p>}{!openJobQuery.trim()&&!visibleOpenJobs.length&&!hasMoreOpenJobs&&<EmptyAction title="現在募集中の案件はありません" body="新しい案件が公開されると、この画面に表示されます。ここからいつでも最新情報を確認できます。" action="最新情報を確認" onAction={()=>void refreshOpenJobs()} secondaryAction="ホームへ戻る" onSecondaryAction={()=>navigate("home")}/>}</div>{openJobPageControls}</div></>}{openJobsStatus==="ready"&&<><p role="status">{openJobsPageMessage}</p>{(hasMoreOpenJobs||openJobsPageMessage)&&<>{hasMoreOpenJobs&&<p>募集案件には続きがあります。100件ずつ追加できます。</p>}<button className="secondary" onClick={()=>{if(hasMoreOpenJobs)void loadMoreOpenJobs();}} disabled={applicationPending||openJobsRefreshing} aria-disabled={!hasMoreOpenJobs||applicationPending||openJobsRefreshing} aria-busy={openJobsRefreshing}>{openJobsRefreshing?"読み込み中…":hasMoreOpenJobs?"募集案件の続きを読み込む":"すべて読み込み済み"}</button></>}</>}</section>}
    {view==="shifts"&&<section>
      <div className="section-heading"><h2 ref={shiftHeadingRef} tabIndex={-1}>自分のシフト</h2><button className="secondary" onClick={()=>void refreshBusinessData(true)} disabled={businessRefreshing||businessDataStatus==="loading"||submissionEditPending||applicationPending} aria-busy={businessRefreshing}>{businessRefreshing?"更新中…":"シフトを更新"}</button></div>
      <p className="muted">応募結果が分からないときは、更新して日付と店舗を確認してください。表示に続きがある場合は、追加で読み込めます。</p>
      {businessDataFallback??<>
        <div className="shift-list-heading"><h3>これからのシフト</h3><span>{upcomingShifts.length}件</span></div>
        {upcomingShifts.length
          ? <ShiftJobCards jobs={upcomingShifts} page={upcomingPage} onPageChange={setUpcomingPage} selectedId={selectedJob?.id} onSelect={openShiftJob} label="これからのシフト" accent={jobAccent} kind={jobKind} summary={prepSummary} submissionSummary={submissionSummary}/>
          : <EmptyAction title="今後の確定シフトはありません" body="募集中の案件を確認すると、次の仕事へすぐ進めます。" action="募集中の案件を見る" onAction={()=>navigate("jobs")}/>}
        <div className="past-shift-pagination">
          {hasMoreUpcomingShifts&&<><p>これからのシフトには続きがあります。日付順に50件ずつ追加できます。</p><button className="secondary" onClick={()=>void loadMoreUpcomingShifts()} disabled={isPending("upcoming-shifts")||businessRefreshing} aria-busy={isPending("upcoming-shifts")}>{isPending("upcoming-shifts")?"読み込み中…":"これからのシフトを続きを読み込む"}</button></>}
          {upcomingShiftMessage&&<p role="alert">{upcomingShiftMessage}</p>}
        </div>
        {(pastShifts.length>0||hasMorePastShifts)&&<div className="past-shifts">
          {upcomingShifts.length>0?<button className="secondary past-shifts-toggle" aria-expanded={showPastShifts} aria-controls="past-shifts-list" onClick={togglePastShifts}>{showPastShifts?"過去のシフトを閉じる":`過去のシフトを見る（${pastShifts.length}件）`}</button>:<div className="shift-list-heading past"><h3>過去のシフト</h3><span>{pastShifts.length}件</span></div>}
          {(showPastShifts||!upcomingShifts.length)&&<div id="past-shifts-list" className="past-shift-grid"><ShiftJobCards jobs={pastShifts} page={pastPage} onPageChange={setPastPage} selectedId={selectedJob?.id} onSelect={openShiftJob} label="過去のシフト" accent={jobAccent} kind={jobKind} summary={prepSummary} submissionSummary={submissionSummary}/></div>}
        </div>}
        {(showPastShifts||!upcomingShifts.length)&&<div className="past-shift-pagination">
          {hasMorePastShifts&&<><p>過去のシフトは古い順に50件ずつ追加します。</p><button className="secondary" onClick={()=>void loadMorePastShifts()} disabled={isPending("past-shifts")||businessRefreshing} aria-busy={isPending("past-shifts")}>{isPending("past-shifts")?"読み込み中…":"過去のシフトを続きを読み込む"}</button></>}
          {pastShiftMessage&&<p role="alert">{pastShiftMessage}</p>}
        </div>}
        {selectedJob&&<section ref={shiftDetailRef} tabIndex={-1} aria-label="選択したシフトの詳細" className="panel shift-detail" style={{"--job-accent":jobAccent(selectedJob.menuName)} as CSSProperties} aria-busy={shiftActionPending||submissionContextPending||draftHydrating}><div className="shift-detail-heading"><div><span className="job-kind">{jobKind(selectedJob.menuName)}</span><h2>{shiftTextLabel(selectedJob.storeName,"店舗確認中")}</h2><p>{shiftTextLabel(selectedJob.storeAddress,shiftTextLabel(selectedJob.menuName,"業務確認中"))}</p></div><span className="prep-chip">{prepSummary(selectedJob)}</span></div><dl className="job-details" aria-label="勤務日時"><div><dt>勤務日</dt><dd>{shiftDateLabel(selectedJob)}</dd></div><div><dt>勤務時間</dt><dd>{typeof selectedJob.workTime==="string"&&selectedJob.workTime.trim()?selectedJob.workTime:"確認中"}</dd></div></dl>{!hasValidDateKey(selectedJob)&&<p className="missing-work-date muted" role="status">勤務日を確認できません。「シフトを更新」で確認し、改善しない場合は管理者に日付を確認してください。</p>}<div className="route-panel"><strong>店舗への行き方</strong><div className="route-actions">{typeof selectedJob.storeAddress==="string"&&selectedJob.storeAddress.trim()&&<button className="secondary" onClick={()=>void copyDisplayText("店舗住所",selectedJob.storeAddress??"")} disabled={isPending("text-copy")}>住所をコピー</button>}{mapDestination(selectedJob)?<><a href={mapsSearchUrl(selectedJob)} target="_blank" rel="noreferrer">地図で店舗を見る</a><a href={transitRouteUrl(selectedJob)} target="_blank" rel="noreferrer">公共交通の経路</a></>:<span>店舗名・住所を確認できません。「シフトを更新」を押してください。</span>}{shiftTextLabel(selectedJob.storeNearestStation,"")&&<a href={stationSearchUrl(selectedJob)} target="_blank" rel="noreferrer">最寄駅：{shiftTextLabel(selectedJob.storeNearestStation,"")}</a>}</div></div>{selectedJob.preContact!=null&&<p className="muted" role="status" aria-label="登録済みの事前連絡">{typeof selectedJob.preContact.temperature==="number"&&Number.isFinite(selectedJob.preContact.temperature)&&selectedJob.preContact.temperature>=34&&selectedJob.preContact.temperature<=42&&typeof selectedJob.preContact.arrivalTime==="string"&&/^([01]?\d|2[0-3]):[0-5]\d$/.test(selectedJob.preContact.arrivalTime)?<>登録内容：体温 {selectedJob.preContact.temperature}℃ / 到着 {selectedJob.preContact.arrivalTime}。</>:"登録済みの事前連絡を確認できません。「シフトを更新」を押し、体温と到着予定時刻を確認してください。"}</p>}{preContactReadinessMessage(selectedJob)&&<p className="precontact-readiness" id="precontact-readiness" role="status">{preContactReadinessMessage(selectedJob)}</p>}{selectedJob.preContactNeedsReview===true&&!preContactReadinessMessage(selectedJob)&&<p role="status">事前連絡を入力し、内容を確認して送信してください。</p>}{selectedJob.preContactNeedsReview!==true&&selectedJob.preContactSyncPending===true&&!preContactReadinessMessage(selectedJob)&&<p role="status">アプリには保存済みです。シフト表への反映は未確認です。</p>}<div className="form-grid"><label>体温<input ref={preContactTemperatureRef} aria-invalid={preContactError==="temperature"} aria-describedby={preContactError==="temperature"?"precontact-input-error":undefined} inputMode="decimal" placeholder="例：36.5" value={temperature} onChange={e=>{if(preContactError==="temperature")setPreContactError("");setTemperature(e.target.value);preContactDraftsRef.current.set(preContactDraftKey,{temperature:e.target.value,arrivalTime});}} disabled={shiftActionPending}/></label><label>到着予定時刻<input ref={preContactArrivalRef} aria-invalid={preContactError==="arrival"} aria-describedby={preContactError==="arrival"?"precontact-input-error":undefined} type="time" value={arrivalTime} onChange={e=>{if(preContactError==="arrival")setPreContactError("");setArrivalTime(e.target.value);preContactDraftsRef.current.set(preContactDraftKey,{temperature,arrivalTime:e.target.value});}} disabled={shiftActionPending}/></label></div>{preContactError&&<p id="precontact-input-error">{preContactError==="temperature"?"体温の入力を確認してください（34〜42℃）。":"到着予定時刻を選んでください（例：09:30）。"}</p>}<button onClick={()=>void submitPreContact()} disabled={shiftActionPending||Boolean(preContactReadinessMessage(selectedJob))} aria-describedby={preContactReadinessMessage(selectedJob)?"precontact-readiness":undefined}>{pendingShiftAction==="preContact"?"送信中…":preContactReadinessMessage(selectedJob)?"事前連絡は確認待ち":"事前連絡を送信"}</button>{preContactDraftsRef.current.has(preContactDraftKey)&&<button className="secondary" disabled={shiftActionPending} onClick={resetPreContactInput}>入力を登録内容に戻す</button>}<hr/><div className="prep-heading"><div><h3>資料準備状況</h3><p>{caseMailPreparationHeld(selectedJob)?"内容確認後に準備を再開できます。":typeof selectedJob.materialStatus==="string"&&selectedJob.materialStatus.trim()?selectedJob.materialStatus:"ネットプリントの印刷状況から自動表示"}</p></div><span className="prep-chip">{prepSummary(selectedJob)}</span></div>{(Array.isArray(selectedJob.netPrint?.items)?selectedJob.netPrint.items:[]).map((item,index)=>validNetPrintTarget(selectedJob.netPrint?.items,item)?<div className="netprint-row" key={item.id} role="group" aria-label={`ネットプリント ${item.number}`}><strong>{item.number}</strong><button className="secondary" onClick={()=>void copyDisplayText("ネットプリント番号 "+item.number,item.number)} disabled={isPending("text-copy")} aria-busy={isPending("text-copy")} aria-label={`ネットプリント番号 ${item.number} をコピー`}>番号をコピー</button><button className={item.printed===true?"secondary":""} aria-disabled={item.printed===true||shiftActionPending||caseMailPreparationHeld(selectedJob)} onClick={()=>{if(!shiftActionPending&&!caseMailPreparationHeld(selectedJob))void markPrinted(item);}}>{item.printed===true?"印刷済み":pendingShiftAction===`print-${item.id}`?"反映中…":"印刷しました"}</button></div>:<div className="netprint-row" key={`invalid-${index}`} role="group" aria-label={validNetPrintItem(item)?`更新対象を特定できない印刷情報 ${item.number}`:"番号を確認できない印刷情報"}><strong>{validNetPrintItem(item)?`${item.number}：更新対象を特定できません`:"番号を確認できません"}</strong><span>{validNetPrintItem(item)?"シフトを更新し、改善しない場合は管理者に番号の再登録を依頼してください。":"シフトを更新し、改善しない場合は管理者に確認してください。"}</span></div>)}{(!Array.isArray(selectedJob.netPrint?.items??[])||!(selectedJob.netPrint?.items??[]).length)&&<div className="empty compact">{Array.isArray(selectedJob.netPrint?.items??[])?"ネットプリント番号はまだ届いていません。":"印刷情報を確認できません。「シフトを更新」を押してください。"}</div>}<hr/><p className="muted" aria-label="このシフトの提出状況">{submissionSummary(selectedJob)}</p><div className="submission-actions"><button className="sales-floor-button" onClick={()=>void chooseSubmission("sales_floor",selectedJob)} disabled={submissionEditPending}>🖼️ 売場画像を提出</button><button className="report-button" onClick={()=>void chooseSubmission("report",selectedJob)} disabled={submissionEditPending}>📝 報告書を提出</button></div></section>}
      </>}
    </section>}
    {view==="submit"&&!selectedAssignedJob&&<section ref={submissionPanelRef} tabIndex={-1} aria-label="提出画面" className="panel">{businessDataFallback??(myJobs.length?<EmptyAction title="提出するシフトを選んでください" body="提出は、本人に割り当てられた確定シフトからだけ受け付けます。" action="シフトを選ぶ" onAction={()=>navigate("shifts")}/>:<EmptyAction title="提出できる確定シフトはありません" body="シフトが確定すると、売場画像や報告書をここから提出できます。" action="募集中の案件を見る" onAction={()=>navigate("jobs")}/>)}</section>}
    {view==="submit"&&selectedAssignedJob&&<section ref={submissionPanelRef} tabIndex={-1} aria-label="提出画面" className={`panel submission-panel ${submissionType}`} aria-busy={submissionEditPending}>
      <div className="submission-context-card" aria-label="提出先と提出種類">
        <label className="submission-destination"><span className="submission-step-label">1. 提出先のシフト</span><select value={selectedAssignedJob.id} onChange={e=>void changeSubmissionJob(e.target.value)} disabled={Boolean(requestId)||submissionEditPending}>{myJobs.map(job=><option value={job.id} key={job.id}>{[shiftDateLabel(job),shiftTextLabel(job.storeName,"店舗確認中"),shiftTextLabel(job.workTime,"勤務時間確認中")].filter(Boolean).join(" / ")}</option>)}</select></label>
        <div className="submission-type-picker"><span className="submission-step-label">2. 提出するもの</span><div role="group" aria-label="提出種類"><button className={"submission-type-button sales_floor"+(submissionType==="sales_floor"?" active":"")} aria-pressed={submissionType==="sales_floor"} onClick={()=>void changeSubmissionType("sales_floor")} disabled={Boolean(requestId)||submissionEditPending}>🖼️ 売場画像</button><button className={"submission-type-button report"+(submissionType==="report"?" active":"")} aria-pressed={submissionType==="report"} onClick={()=>void changeSubmissionType("report")} disabled={Boolean(requestId)||submissionEditPending}>📝 報告書</button></div></div>
        {requestId&&<small className="submission-context-lock">再提出依頼に合わせて提出先と種類を固定しています。</small>}
      </div>
      <div className={`submission-identity ${submissionType}`}><span>{submissionType==="report"?"📝 報告書":"🖼️ 売場画像"}</span><strong>{submissionType==="report"?"報告内容が読める画像・PDF":"売場全体や陳列が分かる写真"}</strong></div><h2>{submissionType==="report"?"報告書":"売場画像"}を提出</h2><p className="submission-target-summary">{shiftDateLabel(selectedAssignedJob)} / {shiftTextLabel(selectedAssignedJob.storeName,"店舗確認中")} / {shiftTextLabel(selectedAssignedJob.workTime,"勤務時間確認中")}{requestId&&" / 再提出依頼への対応"}</p>{!hasValidDateKey(selectedAssignedJob)&&<p className="missing-work-date muted" role="status">勤務日を確認できません。「提出情報を再読み込み」で確認し、改善しない場合は管理者に日付を確認してから送信してください。</p>}
      {requestId&&!resubmissionDetail&&<div className="resubmission-guide missing-resubmission" role="status">{isPending("submission-context")||isPending("submission-refresh")?"再提出の理由と対象画像を確認しています…":"再提出の理由と対象画像を確認できません。「提出情報を再読み込み」で確認してから、撮り直すファイルを選んでください。"}</div>}
      {resubmissionDetail&&<div className="resubmission-guide"><div><strong>再送理由</strong><p>{resubmissionDetail.request.reasons.map(reason=>reason.trim()).filter(Boolean).join(" / ")||"再送理由を確認できません。「提出情報を再読み込み」で確認し、改善しない場合は管理者に撮り直す内容を確認してください。"}</p>{resubmissionDetail.request.note.trim()&&<p>{resubmissionDetail.request.note}</p>}</div><div className="source-preview"><span>{!singleFileResubmission?"再提出の対象":resubmissionDetail.request.status==="open"?"撮り直す元画像":"依頼の対象画像"}</span>{resubmissionDetail.source?<SubmissionPreviewImage file={resubmissionDetail.source} onRefreshPreview={refreshFilePreview} className="source-preview-frame"/>:!singleFileResubmission?<div className="preview-placeholder" role="status">この案件の{submissionType==="report"?"報告書":"売場画像"}が対象です。再送理由を確認して必要なファイルを選んでください。</div>:<div className="preview-placeholder" role="status">元画像を確認できません。「提出情報を再読み込み」で確認し、改善しない場合は管理者に対象ファイルを確認してください。</div>}</div><small>{resubmissionDetail.request.status==="submitted"?"この依頼への再送は受付済みです。提出履歴で保存状況を確認してください。":resubmissionDetail.request.status==="completed"?"この再提出依頼は完了しています。提出履歴で内容を確認できます。":resubmissionDetail.request.status!=="open"?"再提出依頼の受付状態を確認できません。「提出情報を再読み込み」で確認してください。":!singleFileResubmission?"対象ファイルを最大20件、各50MBまで選んで再提出してください。":resubmissionDetail.source?"この画像だけを撮り直し、1ファイル選んで再送してください。":"再送する対象を確認してから、1ファイル選んで再送してください。"}</small></div>}
      {submissionType==="sales_floor"&&<><p id="client-submission-help" className="muted">{submissionReadiness??"クライアントへ直接提出した場合は、ここで提出済みを記録してください。"}</p><button className="secondary" onClick={()=>{if(!submissionEditPending&&!submissionReadiness)void setClientSubmitted(selectedAssignedJob.submissionStatus?.salesFloor?.clientSubmitted!==true);}} aria-describedby="client-submission-help" aria-disabled={submissionEditPending||Boolean(submissionReadiness)} aria-busy={shiftActionPending}>{pendingShiftAction==="clientSubmitted"?"更新中…":selectedAssignedJob.submissionStatus?.salesFloor?.clientSubmitted===true?"クライアント提出を解除":"クライアントへ提出済み"}</button></>}
      <div className="upload-box"><span className="submission-step-label">3. 写真・PDFを選ぶ</span><div className="file-picker-actions"><label className="file-picker-button camera">📷 カメラで撮影<input className="file-picker-input" type="file" accept="image/*" capture="environment" disabled={submissionEditPending||resubmissionSendBlocked} onChange={e=>{addSubmissionFiles(Array.from(e.target.files??[]));e.currentTarget.value="";}}/></label><label className="file-picker-button library">🖼️ 写真・PDFを選ぶ<input className="file-picker-input" type="file" multiple={!singleFileResubmission} accept="image/*,.pdf" disabled={submissionEditPending||resubmissionSendBlocked} onChange={e=>{addSubmissionFiles(Array.from(e.target.files??[]));e.currentTarget.value="";}}/></label></div><small>{singleFileResubmission?"再送対象は1ファイルだけ選択してください":`${submissionType==="report"?"報告書":"売場画像"}として最大20件、1件50MB。選択後も追加できます。`}</small></div>
      {files.length>0&&<><div className="file-list-toolbar"><div><strong>選択中：{files.length}件</strong><small>送信前に画像を確認してください</small></div><button className="ghost" onClick={()=>void clearSubmissionFiles()} disabled={submissionEditPending} aria-busy={isPending("submission-files")}>{isPending("submission-files")?"解除中…":"すべて解除"}</button></div><div className="file-list">{files.map((file,index)=><SelectedSubmissionFile key={fileStateKey(file)} file={file} position={index+1} status={uploadState[fileStateKey(file)]??"選択中・未送信"} disabled={submissionEditPending} onRemove={()=>removeSubmissionFile(file)}/>)}</div></>}
      <label className={`submission-confirmation ${submissionType}`}><input type="checkbox" checked={submissionConfirmed} disabled={submissionEditPending||resubmissionSendBlocked} onChange={e=>setSubmissionConfirmed(e.target.checked)}/><span>選択中は「{submissionType==="report"?"報告書":"売場画像"}」です。画像と種類を確認しました。</span></label><p id="submission-send-help" className="muted" role="status">{submissionReadiness?submissionReadiness:resubmissionSendBlocked?"再提出できる依頼を確認できません。「提出情報を再読み込み」で最新の状態を確認してください。":submissionEditPending?"処理が終わるまでお待ちください。":!files.length?"送信する写真・PDFを選んでください。":!submissionConfirmed?"選択したファイルと提出種類を確認し、上の確認欄にチェックしてください。":"送信する準備ができました。下のボタンで送信してください。"}</p><button aria-describedby="submission-send-help" className={submissionType==="report"?"report-button":"sales-floor-button"} onClick={()=>void uploadSubmission()} disabled={!files.length||!submissionConfirmed||submissionEditPending||resubmissionSendBlocked||Boolean(submissionReadiness)} aria-busy={submissionEditPending}>{processingSubmission?"Drive転送を確認中…":isPending("uploadSubmission")?"送信中…":requestId?(singleFileResubmission?"この画像を再送する":"ファイルを再提出する"):`${submissionType==="report"?"報告書":"売場画像"}を送信する`}</button>{submissionMessage&&<div className={`${messageClassName(submissionMessage)} submission-message`} role={messageTone(submissionMessage)==="error"?"alert":"status"}>{submissionMessage}</div>}
      <hr/><h3>提出履歴</h3><button className="secondary" onClick={()=>void refreshSubmissionInformation()} disabled={submissionEditPending} aria-busy={isPending("submission-refresh")}>{isPending("submission-refresh")?"再読み込み中…":"提出情報を再読み込み"}</button>{submissionHistoryStatus==="loading"?<div className="history-loading" role="status">提出履歴を読み込んでいます。完了するまでお待ちください。</div>:submissionHistoryStatus==="error"?<div className="empty history-error" role="alert">提出履歴を読み込めませんでした。「提出情報を再読み込み」で再試行してください。</div>:<SubmissionHistoryFiles files={submissionHistory.flatMap(group=>group.files)} hasMissingFiles={submissionHistory.some(group=>!group.files.length)} onRefreshPreview={refreshFilePreview}/>}
    </section>}
    {view==="contact"&&<section className="panel contact-panel"><h2 ref={contactHeadingRef} tabIndex={-1}>連絡先</h2><p>業務に関する連絡はこちらから行えます。</p><p role="status" aria-label="コピー状態">{isPending("text-copy")?"コピーしています。完了するまでお待ちください。":""}</p><div className="contact-actions"><a className="contact-button" href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(CONTACT_EMAIL_SUBJECT)}`}>メールを送る</a><a className="contact-button" href={`tel:${CONTACT_PHONE}`}>電話をかける</a><a className="contact-button" href={CONTACT_FORM_URL} target="_blank" rel="noreferrer">お問い合わせフォームを開く</a></div><div className="contact-details"><strong>受付：平日 9:00〜18:00</strong><span>電話：<a href={`tel:${CONTACT_PHONE}`}>{CONTACT_PHONE_LABEL}</a></span><span>メール：<a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></span></div><div className="contact-actions"><button className="secondary" disabled={isPending("text-copy")} onClick={()=>void copyDisplayText("メールアドレス",CONTACT_EMAIL)}>メールアドレスをコピー</button><button className="secondary" disabled={isPending("text-copy")} onClick={()=>void copyDisplayText("電話番号",CONTACT_PHONE_LABEL)}>電話番号をコピー</button></div><details className="contact-copy-text"><summary>連絡先を選択してコピー</summary><p>自動コピーが使えない場合は、下の連絡先を選択してコピーしてください。</p><label>メールアドレス<input aria-label="手動コピー用メールアドレス" readOnly value={CONTACT_EMAIL}/></label><label>電話番号<input aria-label="手動コピー用電話番号" readOnly value={CONTACT_PHONE_LABEL}/></label></details>{selectedAssignedJob?<><h3>連絡するシフト</h3><p>コピー前に日付と店舗を確認してください。</p><textarea aria-label="連絡するシフト" readOnly rows={3} value={contactShiftText}/>{!hasCompleteContactShift(selectedAssignedJob)&&<p className="contact-shift-incomplete" role="status">未確認の項目があります。「別のシフトを選ぶ」からシフト画面を開き、「シフトを更新」で確認してください。改善しない場合は、上の連絡先へ確認できる情報を伝えてください。</p>}<div className="contact-actions"><button className="secondary" disabled={isPending("text-copy")} onClick={()=>void copyDisplayText("シフト情報",contactShiftText)}>シフト情報をコピー</button><button className="secondary" onClick={()=>navigate("shifts")}>別のシフトを選ぶ</button></div></>:<button className="secondary" onClick={()=>navigate("shifts")}>連絡するシフトを選ぶ</button>}</section>}
    <nav className="bottom-nav">{([['home','🏠','ホーム'],['jobs','📅','案件'],['shifts','📋','シフト'],['submit','📤','提出'],['contact','☎️','連絡']] as [View,string,string][]).map(([id,icon,label])=><button key={id} className={view===id?"active":""} aria-current={view===id?"page":undefined} onClick={()=>navigate(id)}><span>{icon}</span>{label}</button>)}</nav>
  </main>;
}
