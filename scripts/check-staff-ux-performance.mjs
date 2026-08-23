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
  /setView\("submit"\);[\s\S]*await Promise\.all/u,
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
  /showDevices&&<section className="panel device-panel">[\s\S]*showDiagnostics&&/u,
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
  /title="確定シフトはありません"[\s\S]*action="募集中の案件を見る"[\s\S]*navigate\("jobs"\)/u,
  "A user without a confirmed shift must have a direct path to open jobs.",
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

console.log("Staff UX and performance checks passed (58 assertions).");
