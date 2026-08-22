import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("apps/staff/src/App.tsx", "utf8");
const diagnostics = readFileSync("apps/staff/src/diagnostics.ts", "utf8");
const auth = readFileSync("functions/src/auth.ts", "utf8");
const push = readFileSync("apps/staff/src/push.ts", "utf8");
const asyncAction = readFileSync("apps/staff/src/useAsyncAction.ts", "utf8");
const businessCache = readFileSync("apps/staff/src/business-cache.ts", "utf8");
const concurrency = readFileSync("apps/staff/src/concurrency.ts", "utf8");
const styles = readFileSync("apps/staff/src/styles.css", "utf8");

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
  /loadBusinessSnapshot<Job,StaffTask>[\s\S]*await loadPrimaryBusinessData/u,
  "Cached business data must render before the authoritative network refresh finishes.",
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

console.log("Staff UX and performance checks passed (23 assertions).");
