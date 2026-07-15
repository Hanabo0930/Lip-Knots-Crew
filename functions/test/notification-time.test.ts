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

// Friday -> Saturday 11:00 JST
assert.equal(
  submissionDeadline("2026-07-17").toDate().toISOString(),
  "2026-07-18T02:00:00.000Z"
);
// Saturday -> Monday 11:00 JST
assert.equal(
  submissionDeadline("2026-07-18").toDate().toISOString(),
  "2026-07-20T02:00:00.000Z"
);
// Sunday -> Monday 11:00 JST
assert.equal(
  submissionDeadline("2026-07-19").toDate().toISOString(),
  "2026-07-20T02:00:00.000Z"
);

assert.ok(Timestamp.now().toMillis() > 0);
console.log("notification time tests passed");
