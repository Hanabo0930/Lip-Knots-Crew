import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import {
  addTokyoDays,
  applyQuietHours,
  isQuietTime,
  isWithinMinuteWindow,
  submissionDeadline,
  tokyoParts,
  tokyoTimestamp,
} from "../src/notification-time";

const daytime = tokyoTimestamp("2026-07-15", 12, 0);
assert.equal(applyQuietHours(daytime).deliverAt.toMillis(), daytime.toMillis());
assert.equal(applyQuietHours(daytime).quietDeferred, false);

const night = tokyoTimestamp("2026-07-15", 23, 10);
const deferred = applyQuietHours(night);
assert.equal(deferred.quietDeferred, true);
assert.equal(deferred.deliverAt.toDate().toISOString(), "2026-07-15T22:00:00.000Z");

const early = tokyoTimestamp("2026-07-15", 6, 30);
assert.equal(
  applyQuietHours(early).deliverAt.toDate().toISOString(),
  "2026-07-14T22:00:00.000Z"
);

assert.equal(isQuietTime(new Date("2026-07-15T14:30:00.000Z")), true); // 23:30 JST
assert.equal(isQuietTime(new Date("2026-07-15T03:30:00.000Z")), false); // 12:30 JST
assert.equal(addTokyoDays("2026-07-15", 3), "2026-07-18");
assert.equal(tokyoParts(new Date("2026-07-15T23:30:00.000Z")).dateKey, "2026-07-16");
assert.equal(isWithinMinuteWindow(new Date("2026-07-14T23:02:00.000Z"), 8, 0), true);
assert.equal(isWithinMinuteWindow(new Date("2026-07-14T23:06:00.000Z"), 8, 0), false);

// 翌平日11時。海の日・振替休日・国民の休日・年越しを含める。
const deadlineCases = [
  ["2026-07-15", "2026-07-16"],
  ["2026-07-17", "2026-07-21"],
  ["2026-07-18", "2026-07-21"],
  ["2026-07-19", "2026-07-21"],
  ["2026-07-20", "2026-07-21"],
  ["2026-09-18", "2026-09-24"],
  ["2026-09-21", "2026-09-24"],
  ["2026-09-22", "2026-09-24"],
  ["2026-04-30", "2026-05-01"],
  ["2026-05-01", "2026-05-07"],
  ["2026-12-31", "2027-01-04"],
  ["2027-03-19", "2027-03-23"],
  ["2027-04-30", "2027-05-06"],
  ["2027-11-22", "2027-11-24"],
] as const;
for (const [workDate, expected] of deadlineCases) {
  const deadline = submissionDeadline(workDate);
  assert.ok(deadline, workDate);
  assert.equal(deadline.toDate().toISOString(), expected + "T02:00:00.000Z", workDate);
}
for (const dateKey of ["2028-01-01", "2099-09-20", "2027-12-31", "2025-12-31",
  "2026-02-30", "2026-13-01", "2026-1-01", "", "not-a-date"]) {
  assert.equal(submissionDeadline(dateKey), null, dateKey);
}

assert.ok(Timestamp.now().toMillis() > 0);
console.log("notification time tests passed");
