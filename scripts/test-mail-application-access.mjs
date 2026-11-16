import assert from "node:assert/strict";
import { harness, companyId, Timestamp } from "./case-mail-test-harness.mjs";

const identityPath = "authIdentities/synthetic-mail-user";
const profilePath = "staffProfiles/synthetic-mail-staff";
const policyPath = "automationRecruitmentPolicies/" + companyId;
const staffId = "synthetic-mail-staff";
const cutoff = Timestamp.fromMillis(1001);
const results = [];

function fixture() {
  const h = harness();
  const token = { role: "staff", companyId, staffId, auth_time: 1 };
  const identity = { companyId, staffId, active: true };
  const policy = { version: 1, companyId, revision: "r1", phase: "app", noticeOwner: "notice_control" };
  h.records.set(profilePath, { companyId, active: true });
  h.records.set(identityPath, identity);
  h.records.set(policyPath, policy);
  const list = h.load("./automation-intake").listMyMailApplications;
  const run = data => list({ auth: { uid: "synthetic-mail-user", token }, data });
  function candidate(number, jobOverrides = {}, candidateOverrides = {}) {
    const candidateId = number.toString(16).padStart(64, "0");
    const jobId = "synthetic-mail-job-" + number;
    h.records.set("jobs/" + jobId, { companyId, status: "assigned", assignedStaffId: staffId, storeName: "Synthetic Store", ...jobOverrides });
    h.records.set("automationApplications/" + candidateId, {
      companyId, staffId, jobId, workDate: "2026-11-15", status: "review", revision: 1,
      receiptKey: "a".repeat(64), personRevision: "p1", ...candidateOverrides,
    });
    return candidateId;
  }
  return { h, identity, token, policy, run, candidate };
}

async function test(name, execute) {
  try {
    await execute();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
  }
}

for (const [name, change] of [
  ["missing linked identity", ({ h }) => h.records.delete(identityPath)],
  ["inactive linked identity", ({ h, identity }) => h.records.set(identityPath, { ...identity, active: false })],
  ["foreign company", ({ h, identity }) => h.records.set(identityPath, { ...identity, companyId: "foreign-company" })],
  ["foreign staff", ({ h, identity }) => h.records.set(identityPath, { ...identity, staffId: "foreign-staff" })],
  ["old token after reactivation", ({ h, identity }) => h.records.set(identityPath, { ...identity, revokedAt: cutoff })],
  ["inactive staff", ({ h }) => h.records.set(profilePath, { companyId, active: false })],
  ["non-staff token", ({ token }) => { token.role = "admin"; }],
  ["inactive identity without a routing policy", ({ h, identity }) => {
    h.records.set(identityPath, { ...identity, active: false });
    h.records.delete(policyPath);
  }],
]) {
  await test(name, async () => {
    const f = fixture();
    f.candidate(1);
    change(f);
    const before = JSON.stringify([...f.h.records]);
    await assert.rejects(() => f.run({}), { code: "permission-denied" });
    assert.equal(JSON.stringify([...f.h.records]), before);
  });
}

await test("revocation after candidate lookup prevents return", async () => {
  const f = fixture();
  f.candidate(1);
  f.h.beforeCommit = ({ reads, writes }) => {
    assert.equal(writes.length, 0);
    assert.ok(reads.has("jobs/synthetic-mail-job-1"));
    f.h.beforeCommit = null;
    f.h.records.set(identityPath, { ...f.identity, active: false, revokedAt: cutoff });
  };
  await assert.rejects(() => f.run({}), { code: "permission-denied" });
  assert.equal(f.h.attempts, 2);
});

await test("reauthenticated owner retains pagination and hides cancelled and foreign candidates", async () => {
  const f = fixture();
  f.h.records.set(identityPath, { ...f.identity, revokedAt: cutoff });
  f.token.auth_time = 2;
  const ids = Array.from({ length: 27 }, (_, i) => f.candidate(i + 1, i === 2 ? { status: "cancelled" } : {}));
  f.candidate(0, {}, { companyId: "foreign-company" });
  f.candidate(28, {}, { staffId: "foreign-staff" });
  const before = JSON.stringify([...f.h.records]);
  const first = await f.run({});
  assert.equal(first.mode, "app");
  assert.equal(first.nextCursor, ids[24]);
  assert.equal(first.items.map(item => item.id).join(","), ids.slice(0, 25).filter(id => id !== ids[2]).join(","));
  const second = await f.run({ cursor: first.nextCursor });
  assert.equal(second.nextCursor, null);
  assert.equal(second.items.map(item => item.id).join(","), ids.slice(25).join(","));
  assert.ok([...first.items, ...second.items].every(item => item.state === "assigned"));
  assert.equal(JSON.stringify([...f.h.records]), before);
});

await test("linked owner retains the legacy route and the unconfigured status", async () => {
  const f = fixture();
  f.h.records.set(policyPath, { ...f.policy, phase: "mail_bridge" });
  assert.equal((await f.run({})).mode, "legacy_mail");
  f.h.records.delete(policyPath);
  assert.equal((await f.run({})).mode, "not_configured");
});

console.log(JSON.stringify({ passed: results.filter(row => row.ok).length, results, synthetic: true }, null, 2));
if (results.some(row => !row.ok)) process.exitCode = 1;
