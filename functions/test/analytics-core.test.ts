import assert from "node:assert/strict";
import {
  buildMonthlyDashboard,
  buildStaffPerformance,
  buildStaffRequestHistory,
  computeJobFinance,
  inferCancellationTreatment,
} from "../src/analytics-core";

const base = {
  dateKey: "2026-07-10",
  status: "assigned",
  clientName: "A社",
  storeName: "イオン船橋",
  makerName: "〇〇食品",
  menuName: "ヨーグルト試食",
  assignedStaffId: "staff_1",
  assignedStaffName: "山田花子",
  financials: {
    clientChargeTotal: 15000,
    clientChargeAdditionsTotal: 1200,
    staffPaymentTotal: 10000,
    subcontractorTotal: 0,
  },
};

assert.deepEqual(computeJobFinance(base), {
  invoice: 16200,
  payment: 10000,
  grossProfit: 6200,
  grossMargin: 6200 / 16200,
  treatment: "invoice_and_pay",
});

assert.equal(
  inferCancellationTreatment({
    ...base,
    status: "cancelled",
    cancelled: true,
    rawStaffName: "山田花子（キャンセル）",
  }),
  "invoice_only"
);

assert.equal(
  inferCancellationTreatment({
    ...base,
    status: "cancelled",
    cancelled: true,
    rawClientName: "A社（キャンセル）",
  }),
  "pay_only"
);

assert.deepEqual(
  computeJobFinance({
    ...base,
    status: "cancelled",
    cancelled: true,
    cancellationFinancialTreatment: "neither",
  }),
  {
    invoice: 0,
    payment: 0,
    grossProfit: 0,
    grossMargin: null,
    treatment: "neither",
  }
);

const jobs = [
  { ...base, id: "1", dateKey: "2026-07-01" },
  { ...base, id: "2", dateKey: "2026-07-20", clientName: "B社" },
  {
    ...base,
    id: "3",
    dateKey: "2026-07-05",
    status: "cancelled",
    cancelled: true,
    cancellationReasonCategory: "maker",
    cancellationFinancialTreatment: "invoice_only",
  },
  {
    ...base,
    id: "4",
    dateKey: "2026-07-06",
    status: "cancelled",
    cancelled: true,
    cancellationReasonCategory: "store",
    cancellationFinancialTreatment: "neither",
  },
  { ...base, id: "5", dateKey: "2026-08-01" },
];

const dashboard = buildMonthlyDashboard(jobs, "2026-07", "2026-07-12");
assert.equal(dashboard.counts.totalRequests, 4);
assert.equal(dashboard.counts.implemented, 1);
assert.equal(dashboard.counts.scheduled, 1);
assert.equal(dashboard.counts.cancelled, 2);
assert.equal(dashboard.counts.executionRate, 1 / 3);
assert.equal(dashboard.finance.bookedInvoice, 16200 * 3);
assert.equal(dashboard.finance.bookedPayment, 10000 * 2);
assert.deepEqual(dashboard.cancellationReasons, [
  { name: "メーカー都合", count: 1 },
  { name: "店舗都合", count: 1 },
]);

const performance = buildStaffPerformance(
  [
    ...jobs,
    {
      ...base,
      id: "6",
      dateKey: "2026-06-20",
      preContactLate: true,
      submissionStatus: {
        report: { lateFirstSubmission: true },
        salesFloor: { lateFirstSubmission: true },
      },
    },
  ],
  "staff_1",
  "2026-06-01",
  "2026-07-31",
  "2026-07-12"
);
assert.equal(performance.totals.implementedJobs, 2);
assert.equal(performance.totals.scheduledJobs, 1);
assert.equal(performance.totals.cancelledJobs, 2);
assert.equal(performance.totals.preContactLate, 1);
assert.equal(performance.totals.reportLate, 1);
assert.equal(performance.totals.salesFloorLate, 1);
assert.equal(performance.recentJobs.length, 5);

console.log("analytics core tests passed");

for (const status of ["open", "draft", undefined]) {
  const invalid = { ...base, id: "unassigned", status, dateKey: "2026-07-02", preContactLate: true, submissionStatus: { report: { lateFirstSubmission: true } } };
  const expected = buildStaffPerformance(jobs, "staff_1", "2026-07-01", "2026-07-31", "2026-07-12");
  const actual = buildStaffPerformance([...jobs, invalid], "staff_1", "2026-07-01", "2026-07-31", "2026-07-12");
  assert.deepEqual(actual, expected, "Unassigned jobs must not inflate staff work, finance, lateness or recent jobs.");
}
console.log("Staff performance excludes open/draft/missing status with stale staff identity.");


// Request totals include cancellation and deduplicate the persisted case/staff
// identity, never the mutable row/document ID or a display name.
const yearFrom = "2026-01-01", yearThrough = "2026-12-31";
const requestA = { ...base, id: "source-row", caseId: "LKCASE_request_a" };
const requestB = { ...base, id: "cancelled-row", caseId: "LKCASE_request_b", status: "cancelled", cancelled: true };
const annual = buildStaffRequestHistory([
  requestA, { ...requestA, id: "monthly-row" }, requestB,
  { ...requestA, caseId: "another-person", assignedStaffId: "staff_2" },
  { ...requestA, caseId: "old-year", dateKey: "2025-12-31" },
  { ...requestA, caseId: "new-year", dateKey: "2027-01-01" },
  { ...requestA, caseId: "unaccepted", status: "open" },
], "staff_1", yearFrom, yearThrough);
assert.deepEqual(annual, { basis: "caseId+staffId", complete: true, totalRequests: 2,
  knownUniqueRequests: 2, duplicateRows: 1, issues: [] });
assert.deepEqual(buildStaffPerformance([requestA, requestB], "staff_1", yearFrom, yearThrough, "2026-12-31").requestHistory,
  { ...annual, duplicateRows: 0 });
for (const changed of [
  { ...requestA, dateKey: "2026-07-11" },
  { ...requestA, cancelled: true, status: "cancelled" },
  { ...requestA, caseId: "lkcase_request_a" },
]) {
  const result = buildStaffRequestHistory([requestA, changed], "staff_1", yearFrom, yearThrough);
  assert.equal(result.complete, false); assert.equal(result.totalRequests, null);
  assert.deepEqual(result.issues, ["conflicting_duplicate_request"]);
}
for (const changed of [ { ...base }, { ...base, caseId: "   " },
  { ...requestA, caseId: " LKCASE_request_a" }, { ...requestA, dateKey: "2026-02-30" } ]) {
  const result = buildStaffRequestHistory([changed], "staff_1", yearFrom, yearThrough);
  assert.equal(result.complete, false); assert.equal(result.totalRequests, null);
}
assert.deepEqual(buildStaffRequestHistory([], "staff_1", yearFrom, yearThrough),
  { basis: "caseId+staffId", complete: true, totalRequests: 0, knownUniqueRequests: 0, duplicateRows: 0, issues: [] });
for (const range of [["2026-02-30", yearThrough], [yearThrough, yearFrom]]) {
  assert.throws(() => buildStaffRequestHistory([], "staff_1", range[0], range[1]));
}
console.log("Staff request history: annual cancellation inclusion, stable identity deduplication and incomplete/conflicting identity fail-closed totals passed.");
