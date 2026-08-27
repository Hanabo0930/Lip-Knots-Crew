import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const app = readFileSync("apps/staff/src/App.tsx", "utf8");
const diagnostics = readFileSync("apps/staff/src/diagnostics.ts", "utf8");
const auth = readFileSync("functions/src/auth.ts", "utf8");
const push = readFileSync("apps/staff/src/push.ts", "utf8");
const asyncAction = readFileSync("apps/staff/src/useAsyncAction.ts", "utf8");
const businessCache = readFileSync("apps/staff/src/business-cache.ts", "utf8");
const concurrency = readFileSync("apps/staff/src/concurrency.ts", "utf8");
const jobList = readFileSync("apps/staff/src/job-list.ts", "utf8");
const styles = readFileSync("apps/staff/src/styles.css", "utf8");

const storedBusinessCache = new Map();
const businessCacheModule = { exports: {} };
runInNewContext(
  ts.transpileModule(businessCache, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  {
    exports: businessCacheModule.exports,
    module: businessCacheModule,
    localStorage: {
      getItem: (key) => storedBusinessCache.get(key) ?? null,
      removeItem: (key) => storedBusinessCache.delete(key),
      setItem: (key, value) => storedBusinessCache.set(key, String(value)),
    },
  },
);
const businessCacheApi = businessCacheModule.exports;
businessCacheApi.saveBusinessSnapshot("uid-a", "company-a", "staff-a", [{ id: "job-a" }], [{ id: "task-a" }]);
assert.deepEqual(
  { ...businessCacheApi.loadLastBusinessScope("uid-a") },
  { companyId: "company-a", staffId: "staff-a" },
);
const cachedSnapshot = businessCacheApi.loadBusinessSnapshot("uid-a", "company-a", "staff-a");
assert.equal(JSON.stringify(cachedSnapshot.jobs), JSON.stringify([{ id: "job-a" }]));
assert.equal(JSON.stringify(cachedSnapshot.tasks), JSON.stringify([{ id: "task-a" }]));
assert.equal(businessCacheApi.loadLastBusinessScope("uid-b"), null);
businessCacheApi.clearBusinessSnapshot("uid-a", "company-a", "staff-a");
assert.equal(businessCacheApi.loadBusinessSnapshot("uid-a", "company-a", "staff-a"), null);
assert.equal(businessCacheApi.loadLastBusinessScope("uid-a"), null);

const jobListModule = { exports: {} };
runInNewContext(
  ts.transpileModule(jobList, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  { exports: jobListModule.exports, module: jobListModule },
);
const jobListApi = jobListModule.exports;
const mixedAssignedJobs = [
  { id: "past-old", dateKey: "2026-08-01", status: "assigned" },
  { id: "future-later", dateKey: "2026-08-28", status: "assigned" },
  { id: "cancelled", dateKey: "2026-08-25", status: "assigned", cancelled: true },
  { id: "past-recent", dateKey: "2026-08-23", status: "assigned" },
  { id: "future-next", dateKey: "2026-08-24", status: "assigned" },
  { id: "unassigned", dateKey: "2026-08-26", status: "open" },
];
assert.deepEqual(
  Array.from(jobListApi.orderAssignedJobs(mixedAssignedJobs, "2026-08-24"), (job) => job.id),
  ["future-next", "future-later", "past-recent", "past-old"],
);
assert.equal(jobListApi.nextShiftJob(mixedAssignedJobs, "2026-08-24").id, "future-next");
const splitAssignedJobs = jobListApi.splitAssignedJobs(mixedAssignedJobs, "2026-08-24");
assert.deepEqual(
  Array.from(splitAssignedJobs.upcoming, (job) => job.id),
  ["future-next", "future-later"],
);
assert.deepEqual(
  Array.from(splitAssignedJobs.past, (job) => job.id),
  ["past-recent", "past-old"],
);
assert.deepEqual(
  Array.from(jobListApi.availableOpenJobs([
    { id: "past", dateKey: "2026-08-23", status: "open" },
    { id: "future-later", dateKey: "2026-08-28", status: "open" },
    { id: "future-next", dateKey: "2026-08-24", status: "open" },
    { id: "cancelled", dateKey: "2026-08-25", status: "open", cancelled: true },
    { id: "assigned", dateKey: "2026-08-26", status: "assigned" },
  ], "2026-08-24"), (job) => job.id),
  ["future-next", "future-later"],
);

assert.match(
  app,
  /await loadPrimaryBusinessData\(sid,cid,current\.uid\);[\s\S]*setBusinessDataStatus\("ready"\);[\s\S]*void registerCurrentDevice\(\)/u,
  "The home screen must become ready before optional device registration.",
);
assert.match(
  app,
  /void loadOpenJobs\(cid\)\.catch/u,
  "Open jobs must load in the background after priority home data.",
);
assert.match(
  app,
  /openQuickDiagnostics/u,
  "Staff must provide one-tap diagnostics.",
);
assert.match(
  diagnostics,
  /formatDiagnosticReport/u,
  "Diagnostics must expose a copyable text report.",
);
assert.match(
  push,
  /loadServerPushStatusWithRetry/u,
  "Transient push status failures must retry automatically.",
);
assert.match(
  asyncAction,
  /pendingRef\.current = started/u,
  "Async actions must synchronously block duplicate taps.",
);
assert.match(
  styles,
  /touch-action:\s*manipulation/u,
  "Touch controls must avoid delayed tap handling.",
);
assert.match(
  styles,
  /\.message\.error/u,
  "Errors must be visually distinct from success messages.",
);
assert.match(
  app,
  /const bootstrapPromise=bootstrap\(\);[\s\S]*getIdTokenResult\(current\)[\s\S]*restoreCachedBusinessData\(initialCid,initialSid\)[\s\S]*await bootstrapPromise/u,
  "Trusted cached business data must render while session revalidation continues in parallel.",
);
assert.match(
  app,
  /const knownScope=loadLastBusinessScope\(current\.uid\);[\s\S]*restoreCachedBusinessData\(knownScope\.companyId,knownScope\.staffId\)[\s\S]*getIdTokenResult\(current\)/u,
  "A returning signed-in user must see the last verified business snapshot before token lookup finishes.",
);
assert.match(
  businessCache,
  /saveLastBusinessScope\(uid, companyId, staffId\)[\s\S]*export function clearBusinessSnapshot/u,
  "A verified live snapshot must persist a bounded per-user scope hint for instant startup.",
);
assert.match(
  app,
  /navigator\.share\(\{title:"Lip Knots Crew かんたん診断",text\}\)[\s\S]*await copyDiagnostics\(\)/u,
  "Diagnostics must support the iPhone share sheet with copy fallback.",
);
assert.match(
  app,
  /visibilityState==="visible"[\s\S]*refreshBusinessData\(false\)/u,
  "Returning to the app must refresh business data automatically.",
);
assert.match(
  app,
  /navigate\("submit"\);[\s\S]*await Promise\.all/u,
  "Submission navigation must become visible before history requests finish.",
);
assert.match(
  app,
  /runWithConcurrency\(uploads,UPLOAD_CONCURRENCY/u,
  "Multiple submission files must upload with bounded concurrency.",
);
assert.match(
  app,
  /data\.files\.length!==files\.length/u,
  "Uploads must stop if the server does not return one destination per selected file.",
);
assert.doesNotMatch(
  app,
  /window\.confirm\(`\$\{typeLabel\}/u,
  "The explicit submission checkbox must not be followed by a duplicate confirmation dialog.",
);
assert.match(
  businessCache,
  /BUSINESS_CACHE_MAX_AGE_MS = 12 \* 60 \* 60 \* 1000/u,
  "Cached business data must expire within a bounded period.",
);
assert.match(
  businessCache,
  /clearBusinessSnapshot/u,
  "Business cache must support removal during logout.",
);
assert.match(
  app,
  /setHomeDisplayMs\(Math\.round\(performance\.now\(\)-loadStarted\)\)[\s\S]*setHomeLoadedFromCache\(true\)/u,
  "Cached home content must record its actual visible-ready time.",
);
assert.match(
  app,
  /restoredScope&&\(restoredScope\.companyId!==cid\|\|restoredScope\.staffId!==sid\)[\s\S]*clearBusinessSnapshot\(current\.uid,restoredScope\.companyId,restoredScope\.staffId\)/u,
  "A changed authoritative staff scope must remove and hide the stale cached scope.",
);
assert.match(
  app,
  /if\(restoredCachedData&&sessionVerified\)[\s\S]*if\(restoredScope\)clearBusinessSnapshot/u,
  "Unverified cached data must be cleared when session revalidation fails.",
);
assert.match(
  app,
  /if\(!restoredCachedData\)setHomeDisplayMs\(refreshedInMs\);[\s\S]*setBusinessRefreshMs\(refreshedInMs\)/u,
  "Background refresh timing must not overwrite cached home display timing.",
);
assert.match(
  diagnostics,
  /label: "最新情報の更新"[\s\S]*ホーム表示を止めずに更新/u,
  "Diagnostics must distinguish visible home speed from background freshness.",
);
assert.match(
  auth,
  /const refreshToken = !customClaimsMatch\(user\.customClaims, claims\)/u,
  "Returning staff sessions must skip an unnecessary ID-token refresh when claims are unchanged.",
);
assert.match(
  auth,
  /const batch = db\.batch\(\)[\s\S]*batch\.commit\(\)/u,
  "Staff login metadata writes must share one Firestore round trip.",
);
assert.match(
  concurrency,
  /Promise\.allSettled\(workers\)/u,
  "Upload actions must stay pending until every active worker has settled.",
);
assert.match(
  styles,
  /\.history-loading/u,
  "Submission history must expose a non-blocking loading state.",
);
assert.match(
  app,
  /account-menu-toggle[\s\S]*aria-controls="account-menu"/u,
  "Mobile account actions must collapse behind one clear menu control.",
);
assert.match(
  app,
  /if\(!message\|\|messageTone\(message\)!=="success"\)return;[\s\S]*setTimeout[\s\S]*6000/u,
  "Successful notices must clear automatically without hiding errors or working states.",
);
assert.match(
  app,
  /confirm\("この端末からログアウトしますか？"\)/u,
  "The compact account menu must protect against accidental logout.",
);
assert.match(
  app,
  /async function requestLogout\(\)\{[\s\S]*isPending\("logout"\)[\s\S]*setMessage\("ログアウト処理中です…"\);[\s\S]*await run\("logout",logoutCurrentUser,\{setMessage\}\)[\s\S]*logout-button[\s\S]*disabled=\{isPending\("logout"\)\}[\s\S]*aria-busy=\{isPending\("logout"\)\}[\s\S]*ログアウト中…/u,
  "Confirmed Staff logout must show progress, block repeat actions, and keep retry context on failure.",
);
assert.match(
  app,
  /showDevices&&<section className="panel device-panel" aria-busy=\{isPending\("devices"\)\}>[\s\S]*showDiagnostics&&/u,
  "Device management must render near the top instead of below the active screen.",
);
assert.match(
  styles,
  /\.account-menu-actions \{ display:grid;/u,
  "The compact account menu must have explicit mobile-friendly styling.",
);
assert.match(
  styles,
  /\.message-dismiss \{ min-height:34px;/u,
  "Dismissible notices must keep a touch-friendly close control.",
);
assert.match(
  app,
  /自動で再確認\|前回の業務データ\|一時的に混み合/u,
  "Recoverable stale-data and retry notices must use a warning tone instead of false success.",
);
assert.match(
  styles,
  /\.message\.warning/u,
  "Recoverable warnings must be visually distinct from success and failure.",
);
assert.match(
  app,
  /submission-destination[\s\S]*value=\{selectedAssignedJob\.id\}[\s\S]*changeSubmissionJob/u,
  "Submission must keep the selected shift visible and changeable in place.",
);
assert.match(
  app,
  /submission-type-picker[\s\S]*aria-label="提出種類"[\s\S]*aria-pressed=\{submissionType==="sales_floor"\}/u,
  "Submission type must be switchable without returning to the shift screen.",
);
assert.match(
  app,
  /discardFilesBeforeContextChange\("選択中のファイルを外して提出先を変更しますか？"\)/u,
  "Changing the destination must protect selected files from accidental loss.",
);
assert.match(
  app,
  /function removeSubmissionFile[\s\S]*filter\(file=>fileStateKey\(file\)!==targetKey\)/u,
  "A mistaken file must be removable without reopening the picker.",
);
assert.match(
  app,
  /e\.currentTarget\.value=""/u,
  "The file picker must allow the same file to be selected again after removal.",
);
assert.match(
  styles,
  /\.file-remove \{ flex:0 0 auto;/u,
  "File removal must expose a dedicated touch-friendly control.",
);
assert.match(
  app,
  /function SelectedSubmissionFile[\s\S]*URL\.createObjectURL\(file\)[\s\S]*URL\.revokeObjectURL\(url\)/u,
  "Selected image previews must release temporary browser URLs after use.",
);
assert.match(
  app,
  /alt=\{`\$\{file\.name\}の送信前確認`\}/u,
  "Selected image previews must identify the file for assistive technology.",
);
assert.match(
  app,
  /isPdf\?"PDF":"FILE"/u,
  "Non-image selections must show a clear PDF or file marker.",
);
assert.match(
  app,
  /formatFileSize\(file\.size\)/u,
  "Selected files must show their size before upload.",
);
assert.match(
  styles,
  /\.selected-file-preview \{ width:72px; height:72px;/u,
  "Selected file previews must have a stable touch-screen layout.",
);
assert.match(
  app,
  /title="今後の確定シフトはありません"[\s\S]*action="募集中の案件を見る"[\s\S]*navigate\("jobs"\)/u,
  "A user without an upcoming confirmed shift must have a direct path to open jobs.",
);
assert.match(
  app,
  /title="提出できる確定シフトはありません"[\s\S]*action="募集中の案件を見る"/u,
  "Submission must not send a user without shifts into an empty shift screen.",
);
assert.match(
  app,
  /aria-expanded=\{expanded\}[\s\S]*詳細を閉じる[\s\S]*詳細を見る/u,
  "Open-job details must stay visible in the card until the user closes them.",
);
assert.doesNotMatch(
  app,
  /setMessage\(`\$\{job\.storeName\} \/ \$\{job\.makerName\} \/ \$\{job\.workTime\}`\)/u,
  "Job details must not be shown only in a temporary global notice.",
);
assert.match(
  styles,
  /\.empty-action \{ display:grid;[\s\S]*\.empty-action button \{ width:100%;/u,
  "Empty-state actions must remain prominent and touch friendly on mobile.",
);
assert.match(
  app,
  /async function refreshOpenJobs\(showConfirmation=true\)[\s\S]*await loadOpenJobs\(\)[\s\S]*募集中の案件を最新情報に更新しました/u,
  "Open jobs must support a one-tap refresh without reloading the whole app.",
);
assert.match(
  app,
  /title="現在募集中の案件はありません"[\s\S]*action="最新情報を確認"[\s\S]*secondaryAction="ホームへ戻る"/u,
  "An empty open-jobs screen must offer both refresh and a safe route home.",
);
assert.match(
  styles,
  /\.empty-action-actions \{ display:grid; width:100%; gap:8px; \}/u,
  "Multiple empty-state actions must keep a stable full-width mobile layout.",
);
assert.match(
  app,
  /capture="environment"[\s\S]*addSubmissionFiles/u,
  "Mobile staff must be able to open the rear camera directly.",
);
assert.match(
  app,
  /file-picker-button library[\s\S]*multiple=\{!requestId\}[\s\S]*accept="image\/\*,\.pdf"/u,
  "Photo-library and PDF selection must stay separate from direct camera capture.",
);
assert.match(
  app,
  /const base=requestId\?\[\]:files;[\s\S]*const next=\[\.\.\.base,\.\.\.additions\]/u,
  "Normal submission picks must append without discarding files already selected.",
);
assert.match(
  app,
  /const seen=new Set\(base\.map\(fileStateKey\)\)[\s\S]*seen\.has\(key\)/u,
  "Repeated camera or library picks must not duplicate the same file.",
);
assert.match(
  app,
  /MAX_SUBMISSION_FILE_SIZE=50\*1024\*1024[\s\S]*file\.size<=MAX_SUBMISSION_FILE_SIZE/u,
  "Oversized files must be rejected before any upload session is created.",
);
assert.match(
  styles,
  /\.file-picker-button \{ min-height:54px;[\s\S]*touch-action:manipulation/u,
  "Camera and library controls must remain large and responsive on touch screens.",
);
assert.match(
  app,
  /className=\{`panel push-panel \$\{pushEnabled\?"enabled":""\}`\}/u,
  "An enabled push panel must switch to the compact daily-use layout.",
);
assert.match(
  styles,
  /\.push-summary-actions \{ display:flex; align-items:center; gap:8px; \}[\s\S]*\.push-settings-toggle \{ min-height:38px;[\s\S]*\.push-panel\.enabled \{ padding:12px 16px; \}/u,
  "Enabled push status and its settings control must fit in one compact row.",
);
assert.match(
  app,
  /pushEnabled&&<button className="ghost push-settings-toggle" aria-expanded=\{showPushActions\} aria-controls="push-enabled-actions"[\s\S]*showPushActions&&<div id="push-enabled-actions" className="push-actions">/u,
  "Daily notification controls must stay collapsed until the user opens settings.",
);
assert.match(
  app,
  /id="push-enabled-actions"[\s\S]*通知テスト[\s\S]*通知OFF/u,
  "Collapsed notification settings must preserve both test and disable actions.",
);
assert.match(
  app,
  /useEffect\(\(\)=>\{ if\(!pushEnabled\)setShowPushActions\(false\); \},\[pushEnabled\]\)/u,
  "Notification settings must close when notifications become disabled.",
);
assert.match(
  app,
  /tasks\.length\?<><p>\{taskSummary\}<\/p>[\s\S]*className="task-clear" role="status"[\s\S]*新しい対応が届くと、ここに表示されます/u,
  "A completed day must use one compact, non-duplicated status instead of two empty messages.",
);
assert.match(
  styles,
  /\.task-clear \{ display:flex;[\s\S]*\.compact-heading \{ flex-direction:row; justify-content:space-between; align-items:center; \}/u,
  "Home status and freshness must remain compact and scannable on mobile.",
);
assert.match(
  app,
  /nextShift\?<article[\s\S]*className="home-shift-empty"[\s\S]*確定シフトはありません[\s\S]*募集案件を見る/u,
  "A home screen without an assigned shift must keep one direct route to open jobs.",
);
assert.doesNotMatch(
  app,
  /body="募集中の案件があれば、このまま確認して応募できます。"/u,
  "The home screen must not reserve a full explanatory card when no shift is assigned.",
);
assert.match(
  styles,
  /\.home-shift-empty \{ display:grid; grid-template-columns:minmax\(0,1fr\) auto; align-items:center;[\s\S]*\.home-shift-empty button \{ min-width:132px; \}/u,
  "The empty next-shift state must remain compact while preserving a clear touch target.",
);
assert.match(
  jobList,
  /function nextShiftJob[\s\S]*orderAssignedJobs\(jobs, today\)[\s\S]*isUpcomingJob\(job, today\)/u,
  "The home screen must choose the earliest assigned shift from today onward.",
);
assert.match(
  app,
  /const nextShift=nextShiftJob\(myJobs\);[\s\S]*<h2>次回シフト<\/h2>[\s\S]*nextShift\?<article[\s\S]*setSelectedJob\(nextShift\)/u,
  "The next-shift card must not follow an older shift selected elsewhere in the app.",
);
assert.match(
  jobList,
  /job\.status === "assigned" && job\.cancelled !== true/u,
  "Cancelled or unassigned jobs must not appear as confirmed staff shifts.",
);
assert.match(
  app,
  /const jobs=orderAssignedJobs\(snapshot\.jobs\);[\s\S]*setMyJobs\(jobs\)[\s\S]*const values=orderAssignedJobs\(snap\.docs\.map/u,
  "Both cached and live staff shift lists must apply the same daily-use ordering and assignment filter.",
);

assert.match(
  app,
  /where\("status","==","open"\),where\("dateKey",">=",localDateKey\(\)\),orderBy\("dateKey","asc"\)/u,
  "Open jobs must exclude dates before today at the database query boundary.",
);

assert.match(
  app,
  /const values=availableOpenJobs\(snap\.docs\.map/u,
  "Open jobs must remove cancelled or stale records before rendering.",
);

assert.match(
  app,
  /useMemo\(\(\)=>splitAssignedJobs\(myJobs\),\[myJobs\]\)/u,
  "The shift screen must derive upcoming and past lists from the same ordered assigned-job source.",
);

assert.match(
  app,
  /これからのシフト[\s\S]*upcomingShifts\.map[\s\S]*className="secondary past-shifts-toggle" aria-expanded=\{showPastShifts\} aria-controls="past-shifts-list"[\s\S]*過去のシフトを見る/u,
  "Upcoming shifts must stay first while past shifts remain behind one accessible toggle.",
);

assert.match(
  app,
  /\(showPastShifts\|\|!upcomingShifts\.length\)&&<div id="past-shifts-list"/u,
  "Past shifts must remain directly visible when no upcoming shift exists.",
);

assert.match(
  app,
  /if\(showPastShifts\|\|!selectedJob\|\|!upcomingShifts\.length\|\|!pastShifts\.some[\s\S]*setSelectedJob\(upcomingShifts\[0\]\)/u,
  "Closing past shifts must return hidden selection to the nearest upcoming shift.",
);

assert.match(
  styles,
  /\.shift-list-heading \{ display:flex;[\s\S]*\.past-shifts-toggle \{ width:100%; \}[\s\S]*\.past-shift-grid \{ margin-top:12px; \}/u,
  "Shift grouping and history controls must keep a full-width touch-friendly mobile layout.",
);

assert.match(
  app,
  /function navigate\(next:View\)\{[\s\S]*setView\(next\);[\s\S]*window\.scrollTo\(\{top:0,left:0,behavior:"auto"\}\)/u,
  "Every Staff screen change must return the mobile viewport to the new screen heading.",
);

assert.match(
  app,
  /function navigate\(next:View\)\{[\s\S]*setShowAccountMenu\(false\);[\s\S]*setShowDevices\(false\);[\s\S]*setShowDiagnostics\(false\);[\s\S]*setView\(next\)/u,
  "Staff navigation must dismiss global utility panels before showing the selected screen.",
);

assert.match(
  app,
  /async function openQuickDiagnostics\(\)\{[\s\S]*setShowAccountMenu\(false\);[\s\S]*setShowDevices\(false\);[\s\S]*setShowDiagnostics\(true\);[\s\S]*function toggleAccountMenu\(\)\{[\s\S]*setShowAccountMenu\(opening\);[\s\S]*if\(opening\)\{[\s\S]*setShowDevices\(false\);[\s\S]*setShowDiagnostics\(false\);[\s\S]*async function loadDevices\(\)\{[\s\S]*setShowAccountMenu\(false\);[\s\S]*setShowDiagnostics\(false\);[\s\S]*onClick=\{toggleAccountMenu\}/u,
  "Staff utility switches must keep the account menu, device manager, and diagnostics mutually exclusive.",
);

assert.match(
  app,
  /async function loadDevices\(\)\{[\s\S]*setShowDevices\(true\);[\s\S]*await run\("devices"[\s\S]*aria-busy=\{isPending\("devices"\)\}[\s\S]*role="status">端末情報を読み込んでいます…[\s\S]*title="端末情報がありません"[\s\S]*onAction=\{\(\)=>void loadDevices\(\)\}/u,
  "Staff device management must open immediately and keep loading and retry feedback inside the panel.",
);

assert.equal(
  app.match(/setView\(/gu)?.length,
  1,
  "All Staff view changes must use the shared navigation helper instead of bypassing scroll reset.",
);

assert.match(
  app,
  /className=\{view===id\?"active":""\} aria-current=\{view===id\?"page":undefined\} onClick=\{\(\)=>navigate\(id\)\}/u,
  "The bottom navigation must identify the current page and keep re-tap scroll-to-top behavior.",
);

console.log("Staff UX and performance checks passed (100 assertions).");
