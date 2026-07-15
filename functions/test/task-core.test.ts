import assert from "node:assert/strict";
import { deriveStaffTasks } from "../src/task-core";

const now = new Date("2026-07-14T03:00:00Z").getTime(); // 7/14 12:00 JST
const tasks = deriveStaffTasks({
  nowMs: now,
  jobs: [{
    id: "job1", dateKey: "2026-07-15", storeName: "イオン津田沼",
    status: "assigned", preContact: null,
    netPrint: { items: [{ id:"n1", number:"1234", printed:false }] },
    submissionStatus: {},
  }],
  resubmissions: [{ id:"r1", jobId:"job1", type:"report", reasons:["手ブレで文字が読めません"], createdAtMs:now-1000 }],
});
assert.ok(tasks.some((task) => task.kind === "resubmission"));
assert.ok(tasks.some((task) => task.kind === "precontact"));
assert.ok(tasks.some((task) => task.kind === "netprint"));
assert.ok(!tasks.some((task) => task.kind === "report")); // 実施日前

const after = deriveStaffTasks({
  nowMs: new Date("2026-07-15T04:00:00Z").getTime(),
  jobs: [{ id:"job1", dateKey:"2026-07-15", storeName:"店舗", status:"assigned", preContact:{temperature:36.2,arrivalTime:"9:30"}, submissionStatus:{} }],
  resubmissions: [],
});
assert.ok(after.some((task) => task.kind === "report"));
assert.ok(after.some((task) => task.kind === "sales_floor"));
console.log("task-core tests passed");
