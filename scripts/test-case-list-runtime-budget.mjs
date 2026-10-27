import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { getHeapStatistics } from "node:v8";
const require = createRequire(import.meta.url);
// These are the actual installed runtime packages, never substitute stubs. The
// test performs no cloud request, credential discovery or business mutation.
for (const name of ["googleapis", "firebase-admin/firestore", "firebase-functions/v2/firestore", "firebase-functions/v2/https", "zod"]) require(name);
const { fixtureEnvironment, company, caseId } = require("./case-list-tests/test-monthly-compact.cjs");
const controller = require("../functions/src/case-list-monthly-controller.cjs");
const baselineRssBytes = process.memoryUsage().rss;
const start = performance.now(), fixture = fixtureEnvironment(true);
const snapshot = await fixture.reader.readCaseListMonthlySnapshot(company, caseId, { includeDependencies: true });
const sha256 = text => createHash("sha256").update(text).digest("hex");
assert.equal(controller.assertSnapshotCoverage(snapshot, caseId, { sha256 }), "LK_MONTHLY_STRUCTURAL_LAYOUT_V1");
for (const month of snapshot.months) controller.monthLayoutHash({ sha256 }, month, "LK_MONTHLY_STRUCTURAL_LAYOUT_V1");
const elapsedMs = performance.now() - start, peakRssBytes = process.resourceUsage().maxRSS * 1024;
const report = { scope: "INSTALLED_SDK_COLD_LOAD_AND_BOUNDED_SYNTHETIC_READER_CORE_ONLY", baselineRssBytes, peakRssBytes, heapLimitBytes: getHeapStatistics().heap_size_limit,
  elapsedMs, googleRequests: fixture.calls.length, sourceRows: snapshot.source.rowCount, monthlyRows: snapshot.months.reduce((total, month) => total + month.rowCount, 0),
  cloudAcceptance: false, nativeRequests: 0, businessWrites: 0 };
console.log(JSON.stringify(report));
assert.ok(peakRssBytes < 256 * 1024 * 1024, "Actual runtime SDK plus compact pipeline exceeds the unchanged worker memory budget");
assert.ok(elapsedMs < 60_000, "Bounded synthetic CPU pipeline exceeds the unchanged worker timeout");
