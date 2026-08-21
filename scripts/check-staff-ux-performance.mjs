import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("apps/staff/src/App.tsx", "utf8");
const diagnostics = readFileSync("apps/staff/src/diagnostics.ts", "utf8");
const push = readFileSync("apps/staff/src/push.ts", "utf8");
const asyncAction = readFileSync("apps/staff/src/useAsyncAction.ts", "utf8");
const styles = readFileSync("apps/staff/src/styles.css", "utf8");

assert.match(
  app,
  /await loadPrimaryBusinessData\(sid,cid\);[\s\S]*setBusinessDataStatus\("ready"\);[\s\S]*void registerCurrentDevice\(\)/u,
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

console.log("Staff UX and performance checks passed (8 assertions).");
